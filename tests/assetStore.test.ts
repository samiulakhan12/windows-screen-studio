import { createHash } from 'node:crypto'
import fs, { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpGet, HttpResponse } from '../src/main/speech/download'

/*
 * Caption downloads (docs/design/captions-studio.md §6.4, §12, test 29): only catalogue ids, only
 * the pinned prefixes, sources tried in order, a busy server's Retry-After waited for up to ten
 * minutes, a file that does not match its pin deleted, the verified files recorded and served by
 * name only. A small font joins the catalogue here so a whole download can be checked against its
 * pin (the real CJK files are 9.6-17.8 MB).
 */

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: true, getVersion: () => '0.0.0' }, net: {}, ipcMain: { handle: vi.fn() } }))

const FILE = Buffer.from('a small test font, pinned by its SHA-256 '.repeat(40))
const SHA = createHash('sha256').update(FILE).digest('hex')
vi.mock('../src/shared/captions/fontCatalog', async (original) => {
  const real = await original<typeof import('../src/shared/captions/fontCatalog')>()
  const test = { ...real.CATALOG_FONTS.find((f) => f.id === 'noto-sans-jp')!, id: 'test-cjk', files: [{ path: 'ofl/testcjk/TestCJK[wght].ttf', bytes: FILE.length, sha256: SHA }] }
  // A second one, downloaded beside the first (two Font menus).
  const second = { ...test, id: 'test-kr', files: [{ path: 'ofl/testkr/TestKR[wght].ttf', bytes: FILE.length, sha256: SHA }] }
  return { ...real, CATALOG_FONTS: [...real.CATALOG_FONTS, test, second] }
})

const store = await import('../src/main/assets/assetStore')
const { downloadPinned, DownloadFailure } = await import('../src/main/speech/download')
const { assetId, fromApp } = await import('../src/main/assetsIpc')
const { GOOGLE_FONTS_COMMIT, NOTO_EMOJI_COMMIT } = await import('../src/shared/captions/fontCatalog')

const RAW = `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/`
const URL_JP = `${RAW}ofl/testcjk/TestCJK%5Bwght%5D.ttf`

/** A fake server: `answer` per request, and the requests it saw. */
function server(answer: (url: string, headers: Record<string, string>, n: number) => { status: number; headers?: Record<string, string>; body?: Buffer }): { get: HttpGet; urls: string[] } {
  const urls: string[] = []
  const get: HttpGet = async (url, headers) => {
    urls.push(url)
    const a = answer(url, headers, urls.length)
    const body = a.body
    const res: HttpResponse = { status: a.status, headers: a.headers ?? {}, body: (async function* () {
      if (body) yield body
    })() }
    return res
  }
  return { get, urls }
}

let dir = ''
const waits: number[] = []
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flown-assets-'))
  waits.length = 0
})
afterEach(() => {
  store.configureAssetStore(null)
  rmSync(dir, { recursive: true, force: true })
})

function use(get: HttpGet, now = 1_800_000_000_000): void {
  store.configureAssetStore({ dir: () => dir, get, testBase: () => null, freeBytes: async () => null, retryDelaysMs: [0, 0, 0], now: () => now, wait: async (ms) => void waits.push(ms) })
}

const progress = { signal: new AbortController().signal, onProgress: vi.fn() }

describe('the allow list (§12)', () => {
  it('allows the pinned commits of google/fonts and googlefonts/noto-emoji only, over https on 443', () => {
    const ok = (u: string): boolean => store.allowAssetUrl(new URL(u))
    expect(ok(URL_JP)).toBe(true)
    expect(ok(`https://raw.githubusercontent.com/googlefonts/noto-emoji/${NOTO_EMOJI_COMMIT}/fonts/x.ttf`)).toBe(true)
    expect(ok(`http://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/a.ttf`)).toBe(false)
    expect(ok('https://raw.githubusercontent.com/google/fonts/main/ofl/a.ttf')).toBe(false)
    expect(ok(`https://raw.githubusercontent.com/someone/fonts/${GOOGLE_FONTS_COMMIT}/ofl/a.ttf`)).toBe(false)
    expect(ok(`https://raw.githubusercontent.com:8443/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/a.ttf`)).toBe(false)
    expect(ok(`https://me:pw@raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/a.ttf`)).toBe(false)
    expect(ok(`${RAW}ofl/a.ttf?x=1`)).toBe(false)
    expect(ok('https://evil.example/google/fonts/')).toBe(false)
    expect(ok('https://huggingface.co/someone/fonts/resolve/abc/a.ttf')).toBe(false)
    // The e2e test server, only when the app is not packaged (testBase is passed then).
    expect(store.allowAssetUrl(new URL('http://127.0.0.1:4321/NotoSansJP.ttf'), 'http://127.0.0.1:4321')).toBe(true)
    expect(store.allowAssetUrl(new URL('http://127.0.0.1:4321/NotoSansJP.ttf'))).toBe(false)
  })

  it('refuses a redirect to a host that is not allowed', async () => {
    const s = server(() => ({ status: 302, headers: { location: 'https://evil.example/font.ttf' } }))
    use(s.get)
    await expect(store.downloadAsset('test-cjk', progress)).rejects.toThrow('redirected to a host that is not allowed')
  })
})

describe('downloading an asset (§12)', () => {
  it('downloads, verifies and records a font; it is then listed ready and served by its name', async () => {
    const s = server(() => ({ status: 200, body: FILE }))
    use(s.get)
    const state = await store.downloadAsset('test-cjk', progress)
    expect(state).toEqual({ id: 'test-cjk', kind: 'font', state: 'ready', bytes: FILE.length })
    expect(s.urls).toEqual([URL_JP])
    expect((await store.listAssets()).find((a) => a.id === 'test-cjk')).toEqual(state)
    expect(store.assetPath('test-cjk.ttf')).toBe(path.join(dir, 'test-cjk.ttf'))
    await store.removeAsset('test-cjk')
    expect((await store.listAssets()).find((a) => a.id === 'test-cjk')?.state).toBe('missing')
    expect(readdirSync(dir).filter((f) => f.startsWith('test-cjk'))).toEqual([])
  })

  it('deletes a file that does not match its pin, with the message to show', async () => {
    const wrong = Buffer.from(FILE)
    wrong[10] ^= 1
    use(server(() => ({ status: 200, body: wrong })).get)
    await expect(store.downloadAsset('test-cjk', progress)).rejects.toThrow('The download did not match the expected file, so it was deleted.')
    expect(readdirSync(dir).filter((f) => f.startsWith('test-cjk'))).toEqual([])
    expect((await store.listAssets()).find((a) => a.id === 'test-cjk')?.state).toBe('missing')
  })

  it('waits for Retry-After on a busy server (429: 120 s), says when it tries again, then retries', async () => {
    const now = 1_800_000_000_000
    const s = server((_u, _h, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '120' } } : { status: 200, body: FILE }))
    use(s.get, now)
    const onProgress = vi.fn()
    await expect(store.downloadAsset('test-cjk', { signal: new AbortController().signal, onProgress })).resolves.toMatchObject({ state: 'ready' })
    expect(waits).toEqual([120_000])
    expect(onProgress).toHaveBeenCalledWith({ id: 'test-cjk', received: 0, total: FILE.length, retryAt: now + 120_000 })
    expect(s.urls.length).toBe(2)
  })

  it('reads a Retry-After date, and stops with the busy message beyond ten minutes', async () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    use(server(() => ({ status: 503, headers: { 'retry-after': 'Sat, 31 Oct 2026 12:02:00 GMT' } })).get, now)
    // 503 again after the wait: waits again, at most three times, then the busy message.
    await expect(store.downloadAsset('test-cjk', progress)).rejects.toThrow('The download server is busy. Try again in 10 minutes.')
    expect(waits).toEqual([120_000, 120_000, 120_000])
    waits.length = 0
    use(server(() => ({ status: 429, headers: { 'retry-after': '601' } })).get)
    await expect(store.downloadAsset('test-cjk', progress)).rejects.toThrow('The download server is busy. Try again in 10 minutes.')
    expect(waits).toEqual([])
  })

  it('says what stopped a font download in font words: GitHub refused it, or the font is gone (no model, no Hugging Face)', async () => {
    use(server(() => ({ status: 403 })).get)
    const refused = store.downloadAsset('test-cjk', progress)
    await expect(refused).rejects.toThrow('GitHub or your network refused the download (HTTP 403). A proxy or firewall may be blocking it.')
    await expect(refused).rejects.not.toThrow(/model|Hugging Face/)
    for (const status of [404, 410]) {
      use(server(() => ({ status })).get)
      const gone = store.downloadAsset('test-cjk', progress)
      await expect(gone).rejects.toThrow(`The font is no longer at its address (HTTP ${status}).`)
      await expect(gone).rejects.not.toThrow(/model/)
    }
  })

  it('tries the sources in order: a missing or busy one gives way to the next', async () => {
    const pin = { url: 'https://a.example/f', bytes: FILE.length, sha256: SHA }
    const allow = (): boolean => true
    const s = server((url) => (url.startsWith('https://a.') ? { status: 404 } : url.startsWith('https://b.') ? { status: 429, headers: { 'retry-after': '900' } } : { status: 200, body: FILE }))
    const dest = path.join(dir, 'x.ttf')
    await downloadPinned(pin, dest, { get: s.get, signal: new AbortController().signal, allow, sources: ['https://a.example/f', 'https://b.example/f', 'https://c.example/f'], retryDelaysMs: [0, 0, 0] })
    expect(s.urls).toEqual(['https://a.example/f', 'https://b.example/f', 'https://c.example/f'])
    expect(existsSync(dest)).toBe(true)
    // A mismatch stops at once: no other source is tried.
    const bad = server(() => ({ status: 200, body: Buffer.alloc(FILE.length) }))
    await expect(downloadPinned(pin, path.join(dir, 'y.ttf'), { get: bad.get, signal: new AbortController().signal, allow, sources: ['https://a.example/f', 'https://b.example/f'] })).rejects.toBeInstanceOf(DownloadFailure)
    expect(bad.urls).toEqual(['https://a.example/f'])
  })

  it('refuses every source before any request when one is not allowed', async () => {
    const s = server(() => ({ status: 200, body: FILE }))
    await expect(downloadPinned({ url: 'https://a.example/f', bytes: 1, sha256: SHA }, path.join(dir, 'z'), { get: s.get, signal: new AbortController().signal, allow: (u) => u.hostname === 'a.example', sources: ['https://a.example/f', 'https://b.example/f'] })).rejects.toThrow('not allowed')
    expect(s.urls).toEqual([])
  })
})

describe('assets.json (§12)', () => {
  it('keeps both records when two downloads end together', async () => {
    // Both answers start streaming at once, so the two downloads end within the same moment.
    let open: () => void = () => undefined
    let asked = 0
    const both = new Promise<void>((r) => (open = r))
    const get: HttpGet = async () => {
      if (++asked % 2 === 0) open()
      await both
      return { status: 200, headers: {}, body: (async function* () {
        yield FILE
      })() }
    }
    use(get)
    for (let round = 0; round < 8; round++) {
      await store.removeAsset('test-cjk')
      await store.removeAsset('test-kr')
      const states = await Promise.allSettled([store.downloadAsset('test-cjk', progress), store.downloadAsset('test-kr', progress)])
      expect(states.map((s) => s.status), `round ${round}`).toEqual(['fulfilled', 'fulfilled'])
      const listed = await store.listAssets()
      expect(['test-cjk', 'test-kr'].map((id) => listed.find((a) => a.id === id)?.state), `round ${round}`).toEqual(['ready', 'ready'])
    }
  })

  it('records a download while Windows briefly locks assets.json: the rename is tried again', async () => {
    use(server(() => ({ status: 200, body: FILE })).get)
    // The first rename onto assets.json meets the lock; the next goes through.
    let tries = 0
    const locked = (to: fs.PathLike): boolean => String(to).endsWith('assets.json') && ++tries === 1
    const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const renameSync = fs.renameSync
    const rename = fs.promises.rename
    const spies = [
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (locked(to)) throw eperm()
        renameSync(from, to)
      }),
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (locked(to)) throw eperm()
        return rename(from, to)
      })
    ]
    try {
      await expect(store.downloadAsset('test-cjk', progress)).resolves.toMatchObject({ state: 'ready' })
      expect(tries).toBe(2)
      expect((await store.listAssets()).find((a) => a.id === 'test-cjk')?.state).toBe('ready')
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('ids only (§12)', () => {
  it('downloads and removes catalogue ids only: not bundled fonts, paths or URLs', async () => {
    use(server(() => ({ status: 200, body: FILE })).get)
    for (const bad of ['montserrat', '../test-cjk', 'https://evil.example/x.ttf', 'test-cjk.ttf']) {
      await expect(store.downloadAsset(bad, progress)).rejects.toThrow('This download is not one Flown offers.')
      await expect(store.removeAsset(bad)).rejects.toThrow()
    }
    expect(() => assetId('../x')).toThrow()
    expect(() => assetId(7)).toThrow()
    expect(assetId('noto-sans-jp')).toBe('noto-sans-jp')
  })

  it('serves only names built from the catalogue', () => {
    const re = store.assetFileRe()
    expect(['noto-sans-jp.ttf', 'noto-sans-sc.ttf', 'noto-sans-kr.ttf', 'noto-sans-tc.ttf'].every((f) => re.test(f))).toBe(true)
    for (const f of ['montserrat.ttf', '../noto-sans-jp.ttf', 'noto-sans-jp.ttf.part', 'assets.json', 'noto-sans-jpXttf']) {
      expect(re.test(f), f).toBe(false)
      expect(store.assetPath(f)).toBeNull()
    }
  })

  it('reads assets.json through a sanitiser: a file without a verified record is not ready', async () => {
    use(server(() => ({ status: 200, body: FILE })).get)
    writeFileSync(path.join(dir, 'test-cjk.ttf'), FILE)
    writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ version: 1, files: { 'test-cjk.ttf': { bytes: 'x' }, '../evil': { bytes: 1, mtimeMs: 1 } } }))
    expect((await store.listAssets()).find((a) => a.id === 'test-cjk')?.state).toBe('missing')
  })

  it('answers the app’s own page only', () => {
    expect(() => fromApp({ senderFrame: { url: 'https://evil.example/' } } as never)).toThrow('Not allowed')
    expect(() => fromApp({ senderFrame: null } as never)).toThrow('Not allowed')
  })
})
