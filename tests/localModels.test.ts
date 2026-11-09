/**
 * The text models on disk (src/main/localAi/models.ts, docs/design/smart-tools.md §9.4, §22 tests
 * 71 and 75) against a local HTTP server: a .part resumed, a wrong hash refused and deleted, free
 * space checked first, a host outside the list refused, a file of the wrong size or without `GGUF`
 * damaged, Remove while loaded unloading first; the speeds blended 0.7 / 0.3 per model and kept
 * across a restart; Use; the test catalogue read only unpackaged and only on this PC (test 104).
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ packaged: false }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    },
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => require('node:path').join(require('node:os').tmpdir(), name)
  },
  net: { request: () => undefined }
}))

import { LocalModelStore, MODELS_FILE, readTestCatalog, sanitizeModelsFile, SPEED_BLEND, testCatalog, type LocalModelDeps, type TestModelSpec } from '../src/main/localAi/models'
import type { HttpGet } from '../src/main/speech/download'
import { LOCAL_MODELS } from '../src/shared/localAi/catalog'
import { diskMessage } from '../src/shared/localAi/messages'

const BODY = Buffer.concat([Buffer.from('GGUF'), randomBytes(200_000)])
const SHA = createHash('sha256').update(BODY).digest('hex')
const requests: { path: string; range?: string }[] = []
let server: http.Server
let base: string
let root: string
let dir: string

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ssw-text-models-'))
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    requests.push({ path: url.pathname, range: req.headers.range })
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    const from = m ? Number(m[1]) : 0
    const body = url.pathname === '/flip' ? Buffer.from(BODY).fill(7, 5000, 5001) : BODY
    if (from > 0) res.writeHead(206, { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}`, 'content-length': body.length - from })
    else res.writeHead(200, { 'content-length': body.length })
    res.end(body.subarray(from))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

let n = 0
beforeEach(() => {
  requests.length = 0
  dir = path.join(root, `models-${++n}`)
  h.packaged = false
})
afterEach(() => {
  delete process.env.SSW_TEXT_MODEL_TEST_CATALOG
})

const nodeGet: HttpGet = (url, headers, signal) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { headers, signal }, (res) => {
      const lower: Record<string, string> = {}
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) lower[k] = Array.isArray(v) ? v.join(', ') : v
      resolve({ status: res.statusCode ?? 0, headers: lower, body: res as AsyncIterable<Buffer> })
    })
    req.on('error', reject)
  })

const small = (over: Partial<TestModelSpec> = {}): TestModelSpec => ({ ...LOCAL_MODELS[1], file: 'test-small.gguf', bytes: BODY.length, sha256: SHA, url: `${base}/ok`, ...over })
const big = (over: Partial<TestModelSpec> = {}): TestModelSpec => ({ ...LOCAL_MODELS[0], file: 'test-big.gguf', bytes: BODY.length, sha256: SHA, url: `${base}/ok`, ...over })

const GIB = 2 ** 30
const store = (specs: TestModelSpec[] = [big(), small()], over: Partial<LocalModelDeps> = {}): LocalModelStore =>
  new LocalModelStore(dir, {
    catalog: () => specs,
    pc: () => ({ totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB, helper: true }),
    processor: async () => true,
    get: nodeGet,
    freeBytes: async () => 100 * GIB,
    download: { stallMs: 2000, retryDelaysMs: [10, 10, 10] },
    ...over
  })

const message = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected a failure')
}

describe('downloadLocalModel against a local server (test 71)', () => {
  it('downloads, checks the SHA-256 and the GGUF header, and the model is ready', async () => {
    const s = store()
    const seen: string[] = []
    const state = await s.download('qwen3.5-2b', { onProgress: (st) => seen.push(st.models[1].state) })
    expect(state.models.find((m) => m.id === 'qwen3.5-2b')?.state).toBe('ready')
    expect(readFileSync(path.join(dir, 'test-small.gguf')).equals(BODY)).toBe(true)
    expect(seen).toContain('downloading')
    expect(existsSync(path.join(dir, 'test-small.gguf.part'))).toBe(false)
    expect(state.active).toBe('qwen3.5-2b')
  })

  it('resumes a .part where it stopped', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'test-small.gguf.part'), BODY.subarray(0, 70_000))
    const s = store()
    expect((await s.state()).models[1].state).toBe('missing')
    await s.download('qwen3.5-2b')
    expect(requests).toEqual([{ path: '/ok', range: 'bytes=70000-' }])
    expect(readFileSync(path.join(dir, 'test-small.gguf')).equals(BODY)).toBe(true)
  })

  it('refuses a wrong hash and deletes what came', async () => {
    const s = store([big(), small({ url: `${base}/flip` })])
    expect(await message(s.download('qwen3.5-2b'))).toMatch(/not the expected one/)
    expect(existsSync(path.join(dir, 'test-small.gguf'))).toBe(false)
    expect(existsSync(path.join(dir, 'test-small.gguf.part'))).toBe(false)
    expect((await s.state()).models[1].state).toBe('missing')
  })

  it('checks the free space first: nothing is asked for when the model would not fit', async () => {
    const s = store(undefined, { freeBytes: async () => BODY.length })
    expect(await message(s.download('qwen3.5-2b'))).toBe(diskMessage(small()))
    expect(requests).toEqual([])
    // The catalogue's own words: the file and 64 MB to spare, rounded up.
    expect(diskMessage(LOCAL_MODELS[0])).toBe('Not enough disk space: the model needs 3.2 GB.')
  })

  it('refuses a host outside the list, even when the pinned address sends it there', async () => {
    const asked: string[] = []
    const redirecting: HttpGet = async (url) => {
      asked.push(url)
      return { status: 302, headers: { location: 'https://models.example.com/qwen.gguf' }, body: (async function* () {})() }
    }
    // The real catalogue's sources (Hugging Face at the pinned commit), with a stand-in for the network.
    const s = store([big(), { ...LOCAL_MODELS[1] }], { get: redirecting })
    expect(await message(s.download('qwen3.5-2b'))).toMatch(/not allowed \(models\.example\.com\)/)
    expect(asked).toEqual([`https://huggingface.co/${LOCAL_MODELS[1].repo}/resolve/${LOCAL_MODELS[1].commit}/${LOCAL_MODELS[1].file}`])
  })

  it('takes only catalogue ids', async () => {
    const s = store()
    for (const bad of ['../../etc/passwd', 'https://huggingface.co/x', 'qwen3.5-4b', 3, null]) {
      expect(await message(s.download(bad))).toBe('Unknown model.')
      expect(await message(s.remove(bad))).toBe('Unknown model.')
    }
    expect(requests).toEqual([])
  })

  it('a model the PC cannot use is not downloaded, and says why', async () => {
    const s = store(undefined, { pc: () => ({ totalMemBytes: 8 * GIB, freeMemBytes: 4 * GIB, helper: true }) })
    expect(await message(s.download('gemma4-e2b'))).toBe('Needs 12 GB of memory; this PC has 8 GB.')
    const old = store(undefined, { processor: async () => false })
    expect(await message(old.download('qwen3.5-2b'))).toBe("This PC's processor is too old for AI on this PC (it needs AVX2).")
    expect(requests).toEqual([])
  })

  it('Cancel stops the download and keeps the .part for later', async () => {
    let release: () => void = () => undefined
    const slow: HttpGet = async (_url, _h, signal) => ({
      status: 200,
      headers: { 'content-length': String(BODY.length) },
      body: (async function* () {
        yield BODY.subarray(0, 50_000)
        await new Promise<void>((r) => {
          release = r
          signal.addEventListener('abort', () => r())
        })
        if (signal.aborted) throw new Error('aborted')
      })()
    })
    const s = store(undefined, { get: slow })
    const p = s.download('qwen3.5-2b')
    await vi.waitFor(() => expect(existsSync(path.join(dir, 'test-small.gguf.part'))).toBe(true))
    await vi.waitFor(async () => expect((await s.state()).models[1]).toMatchObject({ state: 'downloading', done: 50_000 }))
    await s.cancel('qwen3.5-2b')
    release()
    expect(await message(p)).toBe('Cancelled.')
    expect(statSync(path.join(dir, 'test-small.gguf.part')).size).toBe(50_000)
    expect((await s.state()).models[1].state).toBe('missing')
  })
})

describe('the files on disk (test 71)', () => {
  const put = (name: string, bytes: Buffer): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, name), bytes)
  }

  it('a file of the wrong size, or without GGUF at its start, is damaged and never handed to the helper', async () => {
    const s = store()
    put('test-small.gguf', BODY.subarray(0, 1000))
    expect((await s.state()).models[1].state).toBe('damaged')
    await expect(s.modelFile('qwen3.5-2b')).rejects.toThrow('The model file is missing or damaged. Download it again in Settings › AI on this PC.')
    const notGguf = Buffer.from(BODY)
    notGguf.write('GGML', 0)
    put('test-small.gguf', notGguf)
    expect((await s.state()).models[1].state).toBe('damaged')
    put('test-small.gguf', BODY)
    expect((await s.state()).models[1].state).toBe('ready')
    expect(await s.modelFile('qwen3.5-2b')).toBe(path.join(dir, 'test-small.gguf'))
  })

  it('Download replaces a damaged file', async () => {
    put('test-small.gguf', BODY.subarray(0, 1000))
    const s = store()
    await s.download('qwen3.5-2b')
    expect(readFileSync(path.join(dir, 'test-small.gguf')).equals(BODY)).toBe(true)
  })

  it('Remove while the helper has the model loaded unloads it first, then deletes the file and any part', async () => {
    put('test-small.gguf', BODY)
    put('test-small.gguf.part', BODY.subarray(0, 10))
    const order: string[] = []
    const s = store(undefined, {
      unload: async (file) => {
        order.push(`unload ${path.basename(file)} ${existsSync(file) ? 'present' : 'gone'}`)
      }
    })
    const state = await s.remove('qwen3.5-2b')
    expect(order).toEqual(['unload test-small.gguf present'])
    expect(existsSync(path.join(dir, 'test-small.gguf'))).toBe(false)
    expect(existsSync(path.join(dir, 'test-small.gguf.part'))).toBe(false)
    expect(state.models[1].state).toBe('missing')
  })

  it('Use: Automatic by default; only a downloaded model can be pinned; removing the pinned one goes back to Automatic', async () => {
    const s = store()
    expect((await s.state()).use).toBe('auto')
    expect(await message(s.setUse('qwen3.5-2b'))).toBe('Only a downloaded model can be chosen.')
    expect(await message(s.setUse('everything'))).toBe('Unknown choice.')
    put('test-small.gguf', BODY)
    expect((await s.setUse('qwen3.5-2b')).use).toBe('qwen3.5-2b')
    expect(JSON.parse(readFileSync(path.join(dir, MODELS_FILE), 'utf8')).use).toBe('qwen3.5-2b')
    expect((await s.remove('qwen3.5-2b')).use).toBe('auto')
  })

  it('stale .part files go after 30 days', async () => {
    put('test-small.gguf.part', BODY.subarray(0, 10))
    put('test-big.gguf.part', BODY.subarray(0, 10))
    const old = (Date.now() - 31 * 24 * 3600 * 1000) / 1000
    utimesSync(path.join(dir, 'test-big.gguf.part'), old, old)
    const removed = await store().sweepStaleParts()
    expect(removed.map((f) => path.basename(f))).toEqual(['test-big.gguf.part'])
    expect(existsSync(path.join(dir, 'test-small.gguf.part'))).toBe(true)
  })
})

describe('speeds measured on this PC (test 75)', () => {
  it('blend 0.7 / 0.3 per model and survive a restart', async () => {
    expect(SPEED_BLEND).toBe(0.3)
    const s = store()
    s.blendSpeed('qwen3.5-2b', 220, 12)
    // Small starts at 120 and 8 (§9.8): 0.7 × 120 + 0.3 × 220 = 150; 0.7 × 8 + 0.3 × 12 = 9.2.
    expect((await s.state()).speeds).toEqual({ 'qwen3.5-2b': { read: 150, write: 9.2 } })
    s.blendSpeed('qwen3.5-2b', 150, 9.2)
    s.blendSpeed('gemma4-e2b', 450, 10)
    const again = store()
    expect((await again.state()).speeds).toEqual({ 'qwen3.5-2b': { read: 150, write: 9.2 }, 'gemma4-e2b': { read: 310, write: 7.9 } })
    expect(again.specWithSpeeds('gemma4-e2b')).toMatchObject({ read: 310, write: 7.9 })
    // A measurement out of range changes nothing.
    again.blendSpeed('gemma4-e2b', Number.NaN, -1)
    expect((await again.state()).speeds['gemma4-e2b']).toEqual({ read: 310, write: 7.9 })
  })

  it('models.json is read strictly: an unknown Use is Automatic, odd speeds and other models go', () => {
    expect(sanitizeModelsFile({ version: 1, use: 'qwen3.5-4b', speeds: { 'qwen3.5-2b': { read: 'fast', write: 3 }, 'gemma4-e2b': { read: 300, write: 9 }, other: { read: 1, write: 1 } } })).toEqual({
      version: 1,
      use: 'auto',
      speeds: { 'gemma4-e2b': { read: 300, write: 9 } }
    })
    expect(sanitizeModelsFile(null)).toEqual({ version: 1, use: 'auto', speeds: {} })
  })
})

describe('the test catalogue (test 104)', () => {
  const entry = { id: 'qwen3.5-2b', file: 'tiny.gguf', bytes: 1000, sha256: 'a'.repeat(64), url: 'http://127.0.0.1:9/tiny.gguf' }

  it('is read only when the app is not packaged', () => {
    const file = path.join(root, 'catalog.json')
    writeFileSync(file, JSON.stringify([entry]))
    process.env.SSW_TEXT_MODEL_TEST_CATALOG = file
    expect(testCatalog()?.map((m) => [m.id, m.file])).toEqual([['qwen3.5-2b', 'tiny.gguf']])
    h.packaged = true
    expect(testCatalog()).toBeNull()
  })

  it('takes catalogue ids, plain file names, pins, and an address on this PC only', () => {
    expect(readTestCatalog([entry])).not.toBeNull()
    expect(readTestCatalog([{ ...entry, url: 'https://huggingface.co/x/tiny.gguf' }])).toBeNull()
    expect(readTestCatalog([{ ...entry, url: 'http://user:pw@127.0.0.1:9/x' }])).toBeNull()
    expect(readTestCatalog([{ ...entry, file: '../tiny.gguf' }])).toBeNull()
    expect(readTestCatalog([{ ...entry, id: 'llama' }])).toBeNull()
    expect(readTestCatalog([{ ...entry, sha256: 'xyz' }])).toBeNull()
    expect(readTestCatalog([{ ...entry, bytes: 4e9 }])).toBeNull()
    expect(readTestCatalog([entry, entry])).toBeNull()
  })
})
