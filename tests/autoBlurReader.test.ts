import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpGet } from '../src/main/speech/download'

/*
 * The text reader's files and state in main (docs/design/auto-blur.md §5.12, §10.2, §10.7; §17.1
 * tests 76-80, 90-92, 95, 220 and 221): the pinned download from Hugging Face, the checks before
 * use, one state for the whole app, the helper's path, and the Windows reader kept closed. The
 * catalogue's five files are swapped for small ones here (the real ones are 27.6 MB).
 */

const h = vi.hoisted(() => {
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const p = require('node:path') as typeof import('node:path')
  const root = fs.mkdtempSync(p.join(os.tmpdir(), 'flown-reader-'))
  const names = ['PP-OCRv6_tiny_det_onnx/inference.onnx', 'PP-OCRv6_tiny_rec_onnx/inference.onnx', 'PP-OCRv6_tiny_rec_onnx/inference.yml', 'PP-OCRv6_small_rec_onnx/inference.onnx', 'PP-OCRv6_small_rec_onnx/inference.yml']
  const body = (file: string): Buffer => Buffer.from(`pinned bytes of ${file} `.repeat(300))
  const files = names.map((file) => ({ file, bytes: body(file).length, sha256: crypto.createHash('sha256').update(body(file)).digest('hex'), repo: `PaddlePaddle/${file.split('/')[0]}`, commit: 'c0ffee' }))
  return { root, body, files, packaged: false, windows: [] as { url: string; sent: unknown[]; destroyed?: boolean }[], handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>() }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    },
    getPath: () => require('node:path').join(h.root, 'userData'),
    getAppPath: () => require('node:path').join(h.root, 'app'),
    getVersion: () => '0.0.0-test'
  },
  net: {},
  ipcMain: { handle: (c: string, fn: (e: unknown, ...a: unknown[]) => unknown) => h.handlers.set(c, fn) },
  BrowserWindow: {
    getAllWindows: () =>
      h.windows.map((w) => ({ isDestroyed: () => !!w.destroyed, webContents: { getURL: () => w.url, send: (_c: string, s: unknown) => w.sent.push(s) } }))
  }
}))
vi.mock('../src/main/security', () => ({ isAppUrl: (url: string) => url === 'file:///flown/index.html' }))
vi.mock('../src/shared/privacy/readerCatalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/privacy/readerCatalog')>()
  return { ...real, READER_FILES: h.files, READER_BYTES: h.files.reduce((s, f) => s + f.bytes, 0) }
})

const { READER_FILES, readerUrls, READER_MIRROR, WINDOWS_READER_ALLOWED } = await import('../src/shared/privacy/readerCatalog')
const models = await import('../src/main/privacy/readerModels')
const { helperPath, HelperError, OcrHelper } = await import('../src/main/privacy/readerHelper')
const { registerReaderIpc, sendReaderState } = await import('../src/main/privacy/readerIpc')
const { PRIVACY_CHANNELS } = await import('../src/shared/api/privacy')
const { checkReader, decodeSpeed, downloadReader, onReaderState, readerDamaged, readerDir, readerState, recordDecodeSpeed, removeReader, resetReaderModels, startReader, cancelReaderDownload, ILLEGAL_INSTRUCTION } = models
const { allowDownloadUrl } = await import('../src/main/speech/download')

const FAKE = path.resolve(__dirname, 'fixtures/fake-ocr-helper.cjs')
const total = h.files.reduce((s, f) => s + f.bytes, 0)

let requests: { url: string; range?: string }[] = []
/** A fake Hugging Face: each file by its name, a 302 first for the tiny detector, Range honoured. */
let serve: (url: string, headers: Record<string, string>, signal: AbortSignal) => ReturnType<HttpGet>
const get: HttpGet = (url, headers, signal) => {
  requests.push({ url, range: headers.Range })
  return serve(url, headers, signal)
}
const bodyOf = (url: string): Buffer | null => {
  const f = h.files.find((x) => url.endsWith(x.file))
  return f ? h.body(f.file) : null
}
const answer = (b: Buffer, from = 0): Awaited<ReturnType<HttpGet>> => ({
  status: from > 0 ? 206 : 200,
  headers: from > 0 ? { 'content-range': `bytes ${from}-${b.length - 1}/${b.length}` } : {},
  body: (async function* () {
    yield b.subarray(from)
  })()
})
const plain: typeof serve = async (url, headers) => {
  if (url.includes('tiny_det') && url.startsWith('https://huggingface.co/')) return { status: 302, headers: { location: url.replace('https://huggingface.co/', 'https://cas-bridge.xethub.hf.co/') }, body: (async function* () {})() }
  const b = bodyOf(url)
  if (!b) return { status: 404, headers: {}, body: (async function* () {})() }
  const m = /^bytes=(\d+)-$/.exec(headers.Range ?? '')
  return answer(b, m ? Number(m[1]) : 0)
}
const deps = { get, sources: (f: (typeof READER_FILES)[number]) => [`https://huggingface.co/PaddlePaddle/resolve/${f.commit}/${f.file}`], retryDelaysMs: [1, 1, 1] }

/** The helper this build has (development: native/bin/ssw-ocr). */
const placeHelper = (): void => {
  const bin = path.join(h.root, 'app', 'native', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, process.platform === 'win32' ? 'ssw-ocr.exe' : 'ssw-ocr'), 'helper')
}
const install = (): void => {
  for (const f of h.files) {
    const p = path.join(readerDir(), ...f.file.split('/'))
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, h.body(f.file))
  }
}
const fileOf = (i: number): string => path.join(readerDir(), ...h.files[i].file.split('/'))

beforeEach(() => {
  rmSync(path.join(h.root, 'userData'), { recursive: true, force: true })
  rmSync(path.join(h.root, 'app'), { recursive: true, force: true })
  placeHelper()
  resetReaderModels()
  requests = []
  serve = plain
  h.packaged = false
  h.windows = []
  delete process.env.SSW_OCR_HELPER
})
afterEach(() => {
  delete process.env.SSW_OCR_SCRIPT
  delete process.env.SSW_OCR_LOG
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('auto-blur P2: the reader in main', () => {
  it('76. readerUrls puts the mirror first when set and the upstream at its pinned commit after it; with READER_MIRROR null only the upstream', async () => {
    const real = await vi.importActual<typeof import('../src/shared/privacy/readerCatalog')>('../src/shared/privacy/readerCatalog')
    const f = real.READER_FILES[0]
    expect(READER_MIRROR).toBeNull()
    const upstream = `https://huggingface.co/${f.repo}/resolve/${f.commit}/inference.onnx`
    expect(readerUrls(f)).toEqual([upstream])
    expect(readerUrls(f, null)).toEqual([upstream])
    const mirror = { repo: 'Qbexel/flown-reader', commit: 'abc123' }
    expect(readerUrls(f, mirror)).toEqual([`https://huggingface.co/Qbexel/flown-reader/resolve/abc123/${f.file}`, upstream])
    for (const u of readerUrls(f, mirror)) expect(allowDownloadUrl(new URL(u))).toBe(true)
  })

  it('77. downloadReader against a fake Hugging Face: a 302 to *.hf.co is followed and one to another host refused; a .part resumes with Range after its prefix hash; a size or SHA-256 mismatch deletes the file and fails; one download at a time; Cancel keeps the .part', async () => {
    // The redirect to *.hf.co is followed; every file lands verified, and models.json records them.
    const state = await downloadReader(() => undefined, new AbortController().signal, deps)
    expect(state).toEqual({ status: 'ready', bytes: total, decodeMs: null })
    expect(requests.some((r) => r.url.startsWith('https://cas-bridge.xethub.hf.co/'))).toBe(true)
    for (let i = 0; i < 5; i++) expect(readFileSync(fileOf(i))).toEqual(h.body(h.files[i].file))
    expect(Object.keys(JSON.parse(readFileSync(path.join(readerDir(), 'models.json'), 'utf8')).files)).toHaveLength(5)

    // A redirect to another host is refused.
    await removeReader()
    // (The other host would serve the right bytes: only the refusal stops it.)
    serve = async (url, headers) => {
      if (url.startsWith('https://evil.example.com/')) return answer(h.body(h.files[0].file))
      if (url.includes('tiny_det')) return { status: 302, headers: { location: `https://evil.example.com/${h.files[0].file}` }, body: (async function* () {})() }
      return plain(url, headers, new AbortController().signal)
    }
    requests = []
    const refused = await downloadReader(() => undefined, new AbortController().signal, deps)
    expect(refused.status).toBe('failed')
    expect(existsSync(fileOf(0))).toBe(false)
    expect(requests.some((r) => r.url.startsWith('https://evil.example.com/'))).toBe(false)

    // A .part resumes with Range once its prefix is hashed.
    await removeReader()
    serve = plain
    const half = Math.floor(h.files[1].bytes / 2)
    mkdirSync(path.dirname(fileOf(1)), { recursive: true })
    writeFileSync(`${fileOf(1)}.part`, h.body(h.files[1].file).subarray(0, half))
    requests = []
    expect((await downloadReader(() => undefined, new AbortController().signal, deps)).status).toBe('ready')
    expect(requests.find((r) => r.url.endsWith(h.files[1].file))?.range).toBe(`bytes=${half}-`)

    // Wrong bytes: the file is deleted and the download fails with its reason.
    await removeReader()
    serve = async (url, headers) => (url.endsWith(h.files[2].file) ? answer(Buffer.alloc(h.files[2].bytes, 7)) : plain(url, headers, new AbortController().signal))
    const bad = await downloadReader(() => undefined, new AbortController().signal, deps)
    expect(bad.status).toBe('failed')
    expect(existsSync(fileOf(2))).toBe(false)
    expect(existsSync(`${fileOf(2)}.part`)).toBe(false)

    // One at a time: a second call gets the running download; Cancel keeps the .part.
    await removeReader()
    let release: () => void = () => undefined
    serve = async (url, headers, signal) => {
      if (!url.endsWith(h.files[3].file)) return plain(url, headers, signal)
      const b = h.body(h.files[3].file)
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield b.subarray(0, 100)
          await new Promise<void>((r) => {
            release = r
            signal.addEventListener('abort', () => r(), { once: true })
          })
          if (signal.aborted) throw new Error('aborted')
          yield b.subarray(100)
        })()
      }
    }
    const first = downloadReader(() => undefined, new AbortController().signal, deps)
    await vi.waitFor(() => expect(existsSync(`${fileOf(3)}.part`)).toBe(true))
    const second = downloadReader(() => undefined, new AbortController().signal, deps)
    expect(second).toBe(first)
    expect(readerState().status).toBe('downloading')
    await cancelReaderDownload()
    expect(await first).toEqual({ status: 'none' })
    expect(existsSync(`${fileOf(3)}.part`)).toBe(true)
    void release
  })

  it('78. checkReader: a changed byte gives damaged and deletes the file; intact files give the pins', async () => {
    install()
    const pins = await checkReader()
    expect(pins).toEqual(h.files.map((f) => ({ file: f.file, path: path.join(readerDir(), ...f.file.split('/')), bytes: f.bytes, sha256: f.sha256 })))
    const b = readFileSync(fileOf(3))
    b[10] ^= 1
    writeFileSync(fileOf(3), b)
    expect(await checkReader()).toBeNull()
    expect(existsSync(fileOf(3))).toBe(false)
    expect(readerState()).toEqual({ status: 'damaged' })
  })

  it('79. ReaderState moves through its states with events; a failure carries its reason to every listener, the dialog and Settings alike (finding 26)', async () => {
    expect(readerState()).toEqual({ status: 'none' })
    const dialog: string[] = []
    const settings: { status: string; reason?: string; done?: number }[] = []
    onReaderState((s) => dialog.push(s.status))
    onReaderState((s) => settings.push(s as never))
    const own: string[] = []
    expect((await downloadReader((s) => own.push(s.status), new AbortController().signal, deps)).status).toBe('ready')
    expect(dialog[0]).toBe('downloading')
    expect(dialog.at(-1)).toBe('ready')
    expect(own.at(-1)).toBe('ready')
    const progress = settings.filter((s) => s.status === 'downloading').map((s) => s.done!)
    expect(progress.at(-1)).toBe(total)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
    await removeReader()
    serve = async () => ({ status: 403, headers: {}, body: (async function* () {})() })
    const failed = await downloadReader(() => undefined, new AbortController().signal, deps)
    expect(failed.status).toBe('failed')
    const reason = (failed as { reason: string }).reason
    expect(reason.length).toBeGreaterThan(0)
    expect(settings.at(-1)).toEqual({ status: 'failed', reason })
    expect(readerState()).toEqual({ status: 'failed', reason })
  })

  it('80. removeReader deletes the folder and gives none', async () => {
    install()
    recordDecodeSpeed(2)
    expect(readerState().status).toBe('ready')
    expect(await removeReader()).toEqual({ status: 'none' })
    expect(existsSync(readerDir())).toBe(false)
  })

  it('90. helperPath: the packaged path, native/bin in development, and SSW_OCR_HELPER honoured only unpackaged', () => {
    const dev = path.join(h.root, 'app', 'native', 'bin', process.platform === 'win32' ? 'ssw-ocr.exe' : 'ssw-ocr')
    expect(helperPath()).toBe(dev)
    process.env.SSW_OCR_HELPER = FAKE
    expect(helperPath()).toBe(FAKE)
    process.env.SSW_OCR_HELPER = path.join(h.root, 'nothing.cjs')
    expect(helperPath()).toBeNull()
    h.packaged = true
    const resources = path.join(h.root, 'resources')
    const saved = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    try {
      process.env.SSW_OCR_HELPER = FAKE
      expect(helperPath()).toBeNull()
      mkdirSync(path.join(resources, 'native'), { recursive: true })
      writeFileSync(path.join(resources, 'native', 'ssw-ocr.exe'), 'helper')
      expect(helperPath()).toBe(path.join(resources, 'native', 'ssw-ocr.exe'))
    } finally {
      Object.defineProperty(process, 'resourcesPath', { value: saved, configurable: true })
    }
    // Without a helper the reader is unavailable, and nothing is downloaded.
    h.packaged = false
    delete process.env.SSW_OCR_HELPER
    rmSync(dev)
    expect(readerState()).toEqual({ status: 'unavailable', reason: 'helper' })
  })

  it('91. readerIpc: requests validated, the sender first; one state shared by every window (finding 29)', async () => {
    h.windows = [{ url: 'file:///flown/index.html', sent: [] }, { url: 'file:///flown/index.html', sent: [] }, { url: 'https://example.com/', sent: [] }]
    registerReaderIpc()
    const app = { senderFrame: { url: 'file:///flown/index.html' } }
    const other = { senderFrame: { url: 'https://example.com/' } }
    for (const c of [PRIVACY_CHANNELS.readerState, PRIVACY_CHANNELS.downloadReader, PRIVACY_CHANNELS.cancelReaderDownload, PRIVACY_CHANNELS.removeReader]) {
      const fn = h.handlers.get(c)!
      await expect(Promise.resolve().then(() => fn(other))).rejects.toThrow('Not allowed')
      await expect(Promise.resolve().then(() => fn(app, { file: '../../evil' }))).rejects.toThrow('Not allowed')
    }
    expect(await h.handlers.get(PRIVACY_CHANNELS.readerState)!(app)).toEqual({ status: 'none' })
    install()
    await readerDamaged()
    // Every app window got the same state; the foreign one nothing.
    expect(h.windows[0].sent.at(-1)).toEqual({ status: 'damaged' })
    expect(h.windows[1].sent).toEqual(h.windows[0].sent)
    expect(h.windows[2].sent).toEqual([])
    sendReaderState({ status: 'none' }, () => [])
  })

  it('92. The decode speed recorded after a Find is kept in models.json and read back for the estimates', () => {
    install()
    expect(decodeSpeed()).toBeNull()
    recordDecodeSpeed(2.4)
    expect(decodeSpeed()).toBe(2.4)
    expect(JSON.parse(readFileSync(path.join(readerDir(), 'models.json'), 'utf8')).decodeMs).toBe(2.4)
    // Later Finds blend into it; nonsense is ignored.
    recordDecodeSpeed(1.4)
    expect(decodeSpeed()).toBe(2.1)
    for (const bad of [NaN, -1, 0, 5000, Infinity]) recordDecodeSpeed(bad)
    expect(decodeSpeed()).toBe(2.1)
  })

  it("95. A model pin mismatch reported by the helper (error: 'model') sets the state to damaged", async () => {
    install()
    const dir = mkdtempSync(path.join(tmpdir(), 'flown-fake-ocr-'))
    writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ open: 'model' }))
    process.env.SSW_OCR_SCRIPT = path.join(dir, 'script.json')
    process.env.SSW_OCR_LOG = path.join(dir, 'log.jsonl')
    await expect(startReader('ffmpeg', { path: FAKE })).rejects.toThrow(HelperError)
    expect(readerState()).toEqual({ status: 'damaged' })
    expect(existsSync(fileOf(0))).toBe(false)
    // The pins main checked went with open.
    const open = readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.line?.op === 'open')
    expect(open.line.models.map((m: { sha256: string }) => m.sha256)).toEqual(h.files.map((f) => f.sha256))
    rmSync(dir, { recursive: true, force: true })
  })

  it('220. ReaderState ready carries this PC\'s decode speed once a Find recorded it', () => {
    install()
    expect(readerState()).toEqual({ status: 'ready', bytes: total, decodeMs: null })
    recordDecodeSpeed(1.9)
    expect(readerState()).toEqual({ status: 'ready', bytes: total, decodeMs: 1.9 })
    // A processor the helper cannot run on (it ends at once on an illegal instruction) is said so.
    expect(ILLEGAL_INSTRUCTION).toBe(0xc000001d)
  })

  it("221. With WINDOWS_READER_ALLOWED false, main never sends reader: 'windows' and no message of §2 mentions the Windows reader", async () => {
    expect(WINDOWS_READER_ALLOWED).toBe(false)
    const dir = mkdtempSync(path.join(tmpdir(), 'flown-fake-ocr-'))
    process.env.SSW_OCR_LOG = path.join(dir, 'log.jsonl')
    const helper = await OcrHelper.start({ path: FAKE })
    await expect(helper.open([], 'ffmpeg', 'windows')).rejects.toThrow(HelperError)
    await helper.stop()
    const sent = readFileSync(path.join(dir, 'log.jsonl'), 'utf8')
    expect(sent).not.toContain('windows')
    // Nowhere in main is the Windows reader asked for.
    const main = (dirPath: string): string[] =>
      require('node:fs')
        .readdirSync(dirPath, { withFileTypes: true })
        .flatMap((e: { name: string; isDirectory(): boolean }) => (e.isDirectory() ? main(path.join(dirPath, e.name)) : e.name.endsWith('.ts') ? [path.join(dirPath, e.name)] : []))
    for (const file of main(path.resolve(__dirname, '../src/main'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/reader:\s*'windows'|'windows'\s*\)/)
    const english = Object.values(JSON.parse(readFileSync(path.resolve(__dirname, '../src/shared/i18n/messages/en/privacy.json'), 'utf8')) as Record<string, string>).join('\n')
    expect(english).not.toMatch(/windows ocr|windows reader|windows\.media|reader of windows/i)
    rmSync(dir, { recursive: true, force: true })
  })
})

