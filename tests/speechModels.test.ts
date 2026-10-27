/**
 * The model store (src/main/speech/models.ts): status from disk, trust on every use (a changed
 * file is hashed again, a link is refused), downloads through a fake HttpGet, the default-model
 * rules, remove while in use, stale .part files, speech.json sanitising and blocked models. The
 * catalog's pins are swapped for small files here (real models are 44-574 MB).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpGet } from '../src/main/speech/download'

const h = vi.hoisted(() => {
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const body = (id: string): Buffer => Buffer.from(`model bytes of ${id} `.repeat(200))
  return { body, sha: (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex') }
})

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' }, net: {} }))
vi.mock('../src/shared/speech/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/speech/catalog')>()
  const models = real.SPEECH_MODELS.map((m) => ({ ...m, bytes: h.body(m.id).length, sha256: h.sha(h.body(m.id)) }))
  const speechModel = (id: unknown) => models.find((m) => m.id === id) ?? null
  return { ...real, SPEECH_MODELS: models, speechModel }
})

import { sanitizeSpeechSettings, SpeechModelStore, STALE_PART_MS } from '../src/main/speech/models'
import { speechModel, type SpeechModelId } from '../src/shared/speech/catalog'
import { localErrorCode } from '../src/shared/speech/errors'

let dir: string
let status = 200
let requests: string[] = []
/** Serves each model's test bytes by file name (Range ignored: always 200). */
const get: HttpGet = async (url) => {
  requests.push(url)
  const id = (['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-turbo'] as const).find((i) => url.endsWith(speechModel(i)!.file))!
  const b = h.body(id)
  return { status, headers: {}, body: (async function* () {
    if (status === 200) yield b
  })() }
}
const store = (pc = { totalMemBytes: 16 * 2 ** 30, build: 'standard' as const }) => new SpeechModelStore(dir, { get, pc: () => pc, baseUrl: 'http://127.0.0.1:1/hf/', freeBytes: async () => null, download: { retryDelaysMs: [1, 1, 1] } })
const file = (id: SpeechModelId): string => path.join(dir, speechModel(id)!.file)
const install = (id: SpeechModelId): void => writeFileSync(file(id), h.body(id))
const stateOf = async (s: SpeechModelStore, id: SpeechModelId): Promise<string> => (await s.views()).find((v) => v.id === id)!.status.state
const settingsFile = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(dir, 'speech.json'), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-models-'))
  status = 200
  requests = []
})
describe('sanitizeSpeechSettings', () => {
  it('falls back to defaults and drops odd entries', () => {
    const empty = { version: 1, defaultModel: 'whisper-base', verified: {}, measured: {} }
    expect(sanitizeSpeechSettings(null)).toEqual(empty)
    expect(sanitizeSpeechSettings({ version: 2, defaultModel: 'whisper-tiny' })).toEqual(empty)
    expect(sanitizeSpeechSettings({ version: 1, defaultModel: '../evil' }).defaultModel).toBe('whisper-base')
    const bytes = speechModel('whisper-tiny')!.bytes
    const s = sanitizeSpeechSettings({
      version: 1,
      defaultModel: 'whisper-tiny',
      verified: { 'whisper-tiny': { bytes, mtimeMs: 5 }, 'whisper-base': { bytes: 1, mtimeMs: 5 }, nope: { bytes, mtimeMs: 1 } },
      measured: {
        'whisper-tiny': { rtf: 0.1, threads: 3, build: 'standard' },
        'whisper-base': { rtf: 50, threads: 3, build: 'standard' },
        'whisper-small': { rtf: 0.2, threads: 3 },
        'whisper-turbo': { rtf: Number.NaN, threads: 3, build: 'standard' }
      }
    })
    expect(s).toEqual({ version: 1, defaultModel: 'whisper-tiny', verified: { 'whisper-tiny': { bytes, mtimeMs: 5 } }, measured: { 'whisper-tiny': { rtf: 0.1, threads: 3, build: 'standard' } } })
    // A speed without the build that measured it is dropped.
    expect(sanitizeSpeechSettings({ version: 1, measured: { 'whisper-tiny': { rtf: 0.1, threads: 3, build: 'avx512' } } }).measured).toEqual({})
  })
})

describe('SpeechModelStore', () => {
  it('reads status from disk: missing, stopped (.part), installed (hashed once, then trusted by size and time), damaged', async () => {
    const s = store()
    expect(await stateOf(s, 'whisper-tiny')).toBe('missing')
    writeFileSync(`${file('whisper-tiny')}.part`, 'abc')
    expect((await s.views()).find((v) => v.id === 'whisper-tiny')!.status).toEqual({ state: 'stopped', received: 3, total: speechModel('whisper-tiny')!.bytes })
    rmSync(`${file('whisper-tiny')}.part`)
    install('whisper-tiny')
    expect(await stateOf(s, 'whisper-tiny')).toBe('installed')
    expect((settingsFile().verified as Record<string, unknown>)['whisper-tiny']).toBeTruthy()
    // Same size, other bytes, a new time: hashed again, damaged, never handed out.
    const bad = h.body('whisper-tiny')
    bad[0] ^= 1
    writeFileSync(file('whisper-tiny'), bad)
    utimesSync(file('whisper-tiny'), new Date(), new Date(Date.now() + 5000))
    expect(await stateOf(s, 'whisper-tiny')).toBe('damaged')
    expect(localErrorCode(await s.installedFile('whisper-tiny').catch((e: Error) => e.message))).toBe('damaged')
    expect(localErrorCode(await s.installedFile('whisper-base').catch((e: Error) => e.message))).toBe('no-model')
  })

  it('refuses a model file that is a link', async () => {
    const real = path.join(dir, 'elsewhere.bin')
    writeFileSync(real, h.body('whisper-base'))
    symlinkSync(real, file('whisper-base'))
    const s = store()
    expect(await stateOf(s, 'whisper-base')).toBe('damaged')
    await expect(s.installedFile('whisper-base')).rejects.toThrow(/damaged/)
  })

  it('a finished download becomes the default when the default is missing; not otherwise', async () => {
    const s = store()
    await s.download('whisper-tiny')
    expect(readFileSync(file('whisper-tiny')).equals(h.body('whisper-tiny'))).toBe(true)
    expect(s.defaultModel()).toBe('whisper-tiny')
    expect(requests[0]).toBe('http://127.0.0.1:1/hf/ggml-tiny-q8_0.bin')
    await s.download('whisper-small')
    expect(s.defaultModel()).toBe('whisper-tiny')
    expect(await s.installedFile('whisper-small')).toBe(file('whisper-small'))
    // Already installed: nothing is fetched.
    requests = []
    await s.download('whisper-small')
    expect(requests).toEqual([])
  })

  it('setDefault only for an installed model; removing the default picks the first remaining installed, else base', async () => {
    const s = store()
    await expect(s.setDefault('whisper-small')).rejects.toThrow(/downloaded/)
    install('whisper-small')
    install('whisper-turbo')
    await s.setDefault('whisper-turbo')
    expect(s.defaultModel()).toBe('whisper-turbo')
    await s.remove('whisper-turbo')
    expect(existsSync(file('whisper-turbo'))).toBe(false)
    expect(s.defaultModel()).toBe('whisper-small')
    await s.remove('whisper-small')
    expect(s.defaultModel()).toBe('whisper-base')
    expect(settingsFile().defaultModel).toBe('whisper-base')
  })

  it('refuses to remove a model in use until it is released', async () => {
    install('whisper-base')
    const s = store()
    const release = s.hold('whisper-base')
    expect((await s.views()).find((v) => v.id === 'whisper-base')!.inUse).toBe(true)
    await expect(s.remove('whisper-base')).rejects.toThrow('Captions are being made with this model. Cancel them first.')
    release()
    release() // twice is harmless
    await s.remove('whisper-base')
    expect(existsSync(file('whisper-base'))).toBe(false)
  })

  it('a failed download shows its reason; 403 is refused', async () => {
    const s = store()
    status = 403
    await expect(s.download('whisper-base')).rejects.toThrow(/403/)
    expect((await s.views()).find((v) => v.id === 'whisper-base')!.status).toMatchObject({ state: 'failed', error: 'refused', status: 403 })
  })

  it('one download at a time; cancel keeps the part (stopped), cancel with discard deletes it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow: HttpGet = async (_url, _h, signal) => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from('partial')
        await Promise.race([gate, new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))])
      })()
    })
    const s = new SpeechModelStore(dir, { get: slow, freeBytes: async () => null, baseUrl: 'http://127.0.0.1:1/hf/' })
    const p = s.download('whisper-base')
    await new Promise((r) => setTimeout(r, 50))
    expect(await stateOf(s, 'whisper-base')).toBe('downloading')
    await expect(s.download('whisper-tiny')).rejects.toThrow('Another speech model is downloading.')
    await s.cancelDownload('whisper-base', false)
    await expect(p).rejects.toThrow('Cancelled.')
    expect(await stateOf(s, 'whisper-base')).toBe('stopped')
    await s.cancelDownload('whisper-base', true)
    expect(existsSync(`${file('whisper-base')}.part`)).toBe(false)
    expect(await stateOf(s, 'whisper-base')).toBe('missing')
    release()
  })

  it('sweeps .part files untouched for 30 days', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file('whisper-small')}.part`, 'old')
    writeFileSync(`${file('whisper-small')}.part.json`, '{}')
    writeFileSync(`${file('whisper-tiny')}.part`, 'new')
    const old = new Date(Date.now() - STALE_PART_MS - 1000)
    utimesSync(`${file('whisper-small')}.part`, old, old)
    expect(await store().sweepStaleParts()).toEqual([`${file('whisper-small')}.part`])
    expect(existsSync(`${file('whisper-small')}.part.json`)).toBe(false)
    expect(existsSync(`${file('whisper-tiny')}.part`)).toBe(true)
  })

  it('allowed and reason from speechModelBlock: turbo on the compatible build or a 4 GB PC', async () => {
    const compat = (await store({ totalMemBytes: 16 * 2 ** 30, build: 'compatible' as never }).views()).find((v) => v.id === 'whisper-turbo')!
    expect(compat).toMatchObject({ allowed: false, reason: "Too slow for this PC's processor: it needs one with AVX2 (most PCs from 2013 on)." })
    const small = (await store({ totalMemBytes: 4 * 2 ** 30, build: 'standard' }).views()).find((v) => v.id === 'whisper-turbo')!
    expect(small.allowed).toBe(false)
    expect(small.reason).toMatch(/^Needs about 1\.1 GB of memory and a PC with 8 GB in all; this one has 4 GB\.$/)
    await expect(store({ totalMemBytes: 4 * 2 ** 30, build: 'standard' }).download('whisper-turbo')).rejects.toThrow(/Needs about/)
    expect((await store().views()).every((v) => v.allowed)).toBe(true)
  })

  it('learns the measured speed, blended 0.5 / 0.5, ignoring nonsense', () => {
    const s = store()
    s.recordMeasured('whisper-base', 0.2, 3, 'standard')
    s.recordMeasured('whisper-base', 0.1, 3, 'standard')
    expect(s.measured('whisper-base')).toEqual({ rtf: 0.15, threads: 3 })
    s.recordMeasured('whisper-base', 99, 3, 'standard')
    s.recordMeasured('whisper-base', Number.NaN, 3, 'standard')
    expect(s.measured('whisper-base')).toEqual({ rtf: 0.15, threads: 3 })
    // Kept across store instances (speech.json).
    expect(store().measured('whisper-base')).toEqual({ rtf: 0.15, threads: 3 })
  })

  it('keeps a measured speed for the build that measured it (speech.json roams with the profile)', async () => {
    const standard = store()
    standard.recordMeasured('whisper-base', 0.2, 3, 'standard')
    const compatible = store({ totalMemBytes: 16 * 2 ** 30, build: 'compatible' as never })
    // Another build's speed is not this one's: the catalog estimate applies, and the view shows none.
    expect(compatible.measured('whisper-base')).toBeNull()
    expect((await compatible.views()).find((v) => v.id === 'whisper-base')!.measured).toBeUndefined()
    expect((await standard.views()).find((v) => v.id === 'whisper-base')!.measured).toEqual({ rtf: 0.2, threads: 3 })
    // A speed of the new build replaces it instead of being blended with it.
    compatible.recordMeasured('whisper-base', 0.8, 3, 'compatible')
    expect(compatible.measured('whisper-base')).toEqual({ rtf: 0.8, threads: 3 })
    expect(store().measured('whisper-base')).toBeNull()
    expect(store().measured('whisper-base', 'compatible')).toEqual({ rtf: 0.8, threads: 3 })
  })

  it('a model the engine could not load is hashed again on the next use', async () => {
    install('whisper-tiny')
    const s = store()
    await s.installedFile('whisper-tiny')
    s.clearVerified('whisper-tiny')
    expect((settingsFile().verified as Record<string, unknown>)['whisper-tiny']).toBeUndefined()
    expect(await s.installedFile('whisper-tiny')).toBe(file('whisper-tiny'))
  })
})
