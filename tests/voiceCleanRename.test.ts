// Clean voice's renames on Windows (src/main/voice/voiceClean.ts, docs/design/clean-voice.md §4.3):
// an antivirus scan, the search indexer or OneDrive can hold a file ffmpeg or the app has just
// written, and renaming it then fails for a moment (EPERM, EBUSY, EACCES). The finished stem and
// the model are moved into place a few times before giving up, with a plain reason, and Cancel
// still stops it. The renames fail on purpose here; ffmpeg is the real one.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** Renames of files matching `match` that fail with `code` from now on. */
  locks: [] as { match: RegExp; left: number; code: string }[],
  /** Called on each failed rename. */
  onLock: null as (() => void) | null,
  /** Every file renamed (or tried). */
  renamed: [] as string[]
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const rename = async (from: string, to: string): Promise<void> => {
    h.renamed.push(from)
    const lock = h.locks.find((l) => l.left > 0 && l.match.test(from))
    if (lock) {
      lock.left--
      h.onLock?.()
      const err = new Error(`${lock.code}: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException
      err.code = lock.code
      throw err
    }
    return actual.promises.rename(from, to)
  }
  const promises = { ...actual.promises, rename }
  return { ...actual, promises, default: { ...actual, promises } }
})

import { ffmpegPath } from '../src/main/ffmpeg'
import { VoiceCleaner } from '../src/main/voice/voiceClean'
import generalModel from '../src/main/voice/model/cb.rnnn?raw'
import speechModel from '../src/main/voice/model/sh.rnnn?raw'
import { VOICE_CANCELLED } from '../src/shared/api/voice'
import { VOICE_COPY } from '../src/shared/audio/voiceCopy'

const root = mkdtempSync(path.join(os.tmpdir(), 'ssw-voice-rename-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ff = ffmpegPath()
const PART = /voice-[0-9a-f]{16}\.part\.m4a$/
const MODEL_TMP = /\.tmp$/

/** A project whose mic.m4a is two seconds of noise, and a cleaner for it with its own model folder. */
function setup(id: string): { c: VoiceCleaner; dir: string; modelDir: string } {
  const dir = path.join(root, 'projects', id)
  mkdirSync(dir, { recursive: true })
  execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=2:sample_rate=48000:amplitude=0.1', '-c:a', 'aac', path.join(dir, 'mic.m4a')])
  const modelDir = path.join(root, 'models', id)
  const c = new VoiceCleaner({
    projectDir: (p) => path.join(root, 'projects', p),
    modelDir: () => modelDir,
    modelTexts: { speech: speechModel, general: generalModel },
    ffmpeg: () => ff
  })
  return { c, dir, modelDir }
}

const voiceFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.startsWith('voice-'))

describe('renames held by another app', () => {
  it('a finished stem held for a moment is still moved into place', async () => {
    const { c, dir } = setup('part')
    h.locks = [{ match: PART, left: 2, code: 'EPERM' }]
    const file = await c.ensure('part', 'mic', 'normal')
    expect(voiceFiles(dir)).toEqual([file])
  }, 60_000)

  it('a model held for a moment is still installed', async () => {
    const { c, dir, modelDir } = setup('model')
    h.locks = [{ match: MODEL_TMP, left: 1, code: 'EBUSY' }]
    const file = await c.ensure('model', 'mic', 'normal')
    expect(voiceFiles(dir)).toEqual([file])
    expect(readdirSync(modelDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  }, 60_000)

  it('a file held for good fails with a plain reason and leaves nothing behind', async () => {
    const { c, dir } = setup('held')
    h.locks = [{ match: PART, left: Infinity, code: 'EACCES' }]
    h.renamed = []
    const err = await c.ensure('held', 'mic', 'normal').then(
      () => null,
      (e: Error) => e
    )
    h.locks = []
    expect(err?.message).toBe(VOICE_COPY.locked)
    expect(h.renamed.filter((f) => PART.test(f)).length).toBeGreaterThan(1)
    expect(voiceFiles(dir)).toEqual([])
  }, 60_000)

  it('other rename errors are not tried again', async () => {
    const { c, dir } = setup('gone')
    h.locks = [{ match: PART, left: Infinity, code: 'ENOENT' }]
    h.renamed = []
    await expect(c.ensure('gone', 'mic', 'normal')).rejects.toThrow('ENOENT')
    h.locks = []
    expect(h.renamed.filter((f) => PART.test(f))).toHaveLength(1)
    expect(voiceFiles(dir)).toEqual([])
  }, 60_000)

  it('Cancel while it waits for the file stops it', async () => {
    const { c, dir } = setup('cancel')
    h.locks = [{ match: PART, left: Infinity, code: 'EPERM' }]
    h.onLock = () => void c.cancel('cancel')
    const err = await c.ensure('cancel', 'mic', 'normal').then(
      () => null,
      (e: Error) => e
    )
    h.locks = []
    h.onLock = null
    expect(err?.message).toBe(VOICE_CANCELLED)
    expect(voiceFiles(dir)).toEqual([])
  }, 60_000)
})
