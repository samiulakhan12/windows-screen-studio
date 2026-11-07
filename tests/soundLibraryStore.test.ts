import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpGet, HttpResponse } from '../src/main/speech/download'
import type { MusicBed } from '../src/shared/audio/soundLibrary'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §10.3, §14 rules 2, 3, 5; §19.1 tests 67
 * and 68): the downloaded beds come only from the chosen source's exact prefix (or its CDN after a
 * redirect), are checked against their pins, recorded once checked, and copied into a project only
 * after a second hash; the IPC accepts the app's own page only; the media protocol's sounds host
 * serves catalogue names only. The download source does not exist yet (§0 decision 1), so a test
 * source with the release's own rules stands in for it, and a small bed of the test's own.
 */

const h = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: unknown[]) => unknown>(), protocol: null as null | ((req: Request) => Promise<Response>) }))
h.root = mkdtempSync(path.join(os.tmpdir(), 'ssw-sound-library-'))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(h.root, name), isPackaged: false, getAppPath: () => path.join(h.root, 'app'), getVersion: () => '0.0.0' },
  net: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  protocol: { handle: (_scheme: string, fn: (req: Request) => Promise<Response>) => (h.protocol = fn), registerSchemesAsPrivileged: () => undefined },
  dialog: {},
  clipboard: {},
  BrowserWindow: class {},
  shell: {}
}))

const store = await import('../src/main/soundLibrary/store')
const paths = await import('../src/main/soundLibrary/paths')
const { registerSoundLibraryIpc } = await import('../src/main/soundLibrary/ipc')
const { handleMediaProtocol } = await import('../src/main/mediaProtocol')
const { projectDir } = await import('../src/main/projects')
const lib = await import('../src/shared/audio/soundLibrary')
const { SOUND_LIBRARY_CHANNELS } = await import('../src/shared/api/soundLibrary')

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const RELEASE = lib.SOUND_LIBRARY_RELEASE
const PREFIX = RELEASE.prefix
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sv=2018-11-09&sig=xyz&se=2026-11-07'

/** A small downloadable bed with a pin of its own (the real ones are 0.66 to 1.16 MB). */
const FILE = Buffer.concat([Buffer.from('OggS'), Buffer.from('a small test bed, pinned by its SHA-256 '.repeat(200))])
const SHA = createHash('sha256').update(FILE).digest('hex')
const real = lib.soundBed('calm-old-key')!
const TEST_BED: MusicBed = { ...real, id: 'test-bed', prepared: { ...real.prepared, file: 'bed-calm-old-key.ogg', bytes: FILE.length, sha256: SHA } }
const BUNDLED = lib.soundBed('upbeat-sweet-sun')!
const LIBRARY = path.join(__dirname, '..', 'resources', 'sound-library')

/** A fake server: `answer` per request, and the requests it saw. */
function server(answer: (url: string, headers: Record<string, string>) => { status: number; headers?: Record<string, string>; body?: Buffer }): { get: HttpGet; urls: string[] } {
  const urls: string[] = []
  const get: HttpGet = async (url, headers) => {
    urls.push(url)
    const a = answer(url, headers)
    const body = a.body
    const res: HttpResponse = {
      status: a.status,
      headers: a.headers ?? {},
      body: (async function* () {
        if (body) yield body
      })()
    }
    return res
  }
  return { get, urls }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(h.root, 'dl-'))
})
afterEach(() => {
  store.configureSoundStore(null)
  paths.configureSoundPaths(null)
})

function use(get: HttpGet, source: typeof RELEASE | null = RELEASE): void {
  paths.configureSoundPaths({ bundled: LIBRARY, downloaded: dir })
  store.configureSoundStore({ dir: () => dir, bundled: () => LIBRARY, get, source: () => source, testBase: () => null, freeBytes: async () => null, beds: () => [BUNDLED, TEST_BED], retryDelaysMs: [0, 0, 0] })
}
const quiet = (): { signal: AbortSignal; onProgress: (p: number) => void } => ({ signal: new AbortController().signal, onProgress: () => undefined })

describe('which addresses a download may use (test 67)', () => {
  const ok = (u: string): boolean => store.allowSourceUrl(new URL(u), RELEASE)

  it('the prefix only with https, port 443, no credentials, no query, no fragment and no ..', () => {
    expect(ok(`${PREFIX}bed-calm-old-key.ogg`)).toBe(true)
    expect(ok(`${PREFIX.replace('https://github.com/', 'https://github.com:443/')}bed-calm-old-key.ogg`)).toBe(true)
    expect(ok(`${PREFIX.replace('https:', 'http:')}bed-calm-old-key.ogg`)).toBe(false)
    expect(ok(`${PREFIX.replace('https://github.com/', 'https://github.com:8443/')}bed-calm-old-key.ogg`)).toBe(false)
    expect(ok(`${PREFIX.replace('https://', 'https://me:pw@')}bed-calm-old-key.ogg`)).toBe(false)
    expect(ok(`${PREFIX}bed-calm-old-key.ogg?x=1`)).toBe(false)
    expect(ok(`${PREFIX}bed-calm-old-key.ogg?`)).toBe(false)
    expect(ok(`${PREFIX}bed-calm-old-key.ogg#a`)).toBe(false)
    expect(ok(`${PREFIX}bed-calm-old-key.ogg#`)).toBe(false)
    // A .. part is resolved before the check (WHATWG URL): one that leaves the prefix is refused.
    expect(ok(`${PREFIX}../sound-library-2/x.ogg`)).toBe(false)
    expect(ok(`${PREFIX}%2e%2e/%2e%2e/windows-screen-studio/x.ogg`)).toBe(false)
    expect(ok(`${PREFIX}a%2f..%2fx.ogg`)).toBe(false)
    expect(ok(PREFIX)).toBe(false)
    // Another tag, another repository, the app's own releases: no.
    expect(ok(`${PREFIX.replace('sound-library-1', 'sound-library-2')}bed-calm-old-key.ogg`)).toBe(false)
    expect(ok('https://github.com/samiulakhan12/windows-screen-studio/releases/download/sound-library-1/bed-calm-old-key.ogg')).toBe(false)
    expect(ok('https://evil.example/samiulakhan12/flown-sound-library/releases/download/sound-library-1/x.ogg')).toBe(false)
  })

  it("the CDN of GitHub's release assets with its signed query, after a redirect; never another host, http, credentials or a fragment", () => {
    expect(ok(CDN)).toBe(true)
    expect(ok('https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2?X-Amz-Signature=abc&response-content-disposition=attachment')).toBe(true)
    expect(ok(CDN.replace('https:', 'http:'))).toBe(false)
    expect(ok(CDN.replace('https://', 'https://u:p@'))).toBe(false)
    expect(ok(`${CDN}#frag`)).toBe(false)
    expect(ok(CDN.replace('release-assets.githubusercontent.com', 'release-assets.githubusercontent.com.evil.example'))).toBe(false)
    expect(ok('https://raw.githubusercontent.com/samiulakhan12/flown-sound-library/main/x.ogg')).toBe(false)
  })

  it('nothing while the source is null (owner decision 1), except the unpackaged test server', () => {
    expect(lib.SOUND_LIBRARY_SOURCE).toBeNull()
    expect(store.allowSoundUrl(new URL(`${PREFIX}bed-calm-old-key.ogg`))).toBe(false)
    expect(store.allowSoundUrl(new URL(CDN))).toBe(false)
    expect(store.allowSoundUrl(new URL('http://127.0.0.1:4321/bed-calm-old-key.ogg'), 'http://127.0.0.1:4321')).toBe(true)
    expect(store.allowSoundUrl(new URL('http://127.0.0.1:4322/bed-calm-old-key.ogg'), 'http://127.0.0.1:4321')).toBe(false)
  })
})

describe('downloads (test 67)', () => {
  it('follows a 302 from the prefix to the CDN with its query, checks the pin, records it', async () => {
    const s = server((url) => (url.startsWith(PREFIX) ? { status: 302, headers: { location: CDN } } : { status: 200, headers: { 'content-length': String(FILE.length) }, body: FILE }))
    use(s.get)
    const seen: number[] = []
    const state = await store.downloadBed('test-bed', { signal: new AbortController().signal, onProgress: (p) => seen.push(p) })
    expect(state).toEqual({ id: 'test-bed', state: 'downloaded', bytes: FILE.length })
    expect(s.urls).toEqual([`${PREFIX}bed-calm-old-key.ogg`, CDN])
    expect(seen[seen.length - 1]).toBe(1)
    expect(readFileSync(path.join(dir, 'bed-calm-old-key.ogg')).equals(FILE)).toBe(true)
    expect(JSON.parse(readFileSync(path.join(dir, 'library.json'), 'utf8')).files).toEqual({ 'bed-calm-old-key.ogg': { bytes: FILE.length, mtimeMs: expect.any(Number) } })
    expect(await store.listLibrary()).toEqual([
      { id: BUNDLED.id, state: 'bundled', bytes: BUNDLED.prepared.bytes },
      { id: 'test-bed', state: 'downloaded', bytes: FILE.length }
    ])
  })

  it('refuses a redirect to another host, to http, or with credentials or a fragment', async () => {
    for (const location of ['https://evil.example/x.ogg', CDN.replace('https:', 'http:'), CDN.replace('https://', 'https://u:p@'), `${CDN}#x`]) {
      use(server(() => ({ status: 302, headers: { location } })).get)
      await expect(store.downloadBed('test-bed', quiet()), location).rejects.toThrow(/redirected/)
      expect(existsSync(path.join(dir, 'bed-calm-old-key.ogg'))).toBe(false)
    }
  })

  it('stops at the pinned bytes; a wrong hash deletes the .part; library.json lists checked files only', async () => {
    use(server(() => ({ status: 200, body: Buffer.concat([FILE, Buffer.from('more')]) })).get)
    await expect(store.downloadBed('test-bed', quiet())).rejects.toThrow()
    expect(existsSync(path.join(dir, 'bed-calm-old-key.ogg'))).toBe(false)
    const wrong = Buffer.from(FILE)
    wrong[100] ^= 1
    use(server(() => ({ status: 200, body: wrong })).get)
    await expect(store.downloadBed('test-bed', quiet())).rejects.toThrow(store.LIBRARY_COPY.mismatch)
    expect(readdirSync(dir).filter((f) => f.startsWith('bed-'))).toEqual([])
    expect(existsSync(path.join(dir, 'library.json'))).toBe(false)
    expect((await store.listLibrary())[1]).toEqual({ id: 'test-bed', state: 'missing', bytes: FILE.length })
    // A file put there by hand, or changed after its check, is not listed as downloaded.
    writeFileSync(path.join(dir, 'bed-calm-old-key.ogg'), FILE)
    expect((await store.listLibrary())[1].state).toBe('missing')
  })

  it('offers nothing while the source is null; ids only from the catalogue, never a bundled one', async () => {
    use(server(() => ({ status: 200, body: FILE })).get, null)
    await expect(store.downloadBed('test-bed', quiet())).rejects.toThrow(store.LIBRARY_COPY.notYet)
    await expect(store.downloadBed('../x', quiet())).rejects.toThrow(store.LIBRARY_COPY.notOffered)
    await expect(store.downloadBed(BUNDLED.id, quiet())).rejects.toThrow(store.LIBRARY_COPY.notOffered)
    expect(store.downloadsOffered()).toBe(false)
  })

  it('Remove deletes every downloaded bed and its record', async () => {
    use(server(() => ({ status: 200, body: FILE })).get)
    await store.downloadBed('test-bed', quiet())
    await store.removeDownloadedBeds()
    expect(readdirSync(dir).filter((f) => f.startsWith('bed-'))).toEqual([])
    expect(JSON.parse(readFileSync(path.join(dir, 'library.json'), 'utf8')).files).toEqual({})
  })
})

describe('using a bed in a project (test 67)', () => {
  it('re-hashes the source and copies it as music-<n>.ogg', async () => {
    use(server(() => ({ status: 200, body: FILE })).get)
    const project = mkdtempSync(path.join(h.root, 'proj-'))
    writeFileSync(path.join(project, 'music-1.mp3'), 'ID3')
    expect(await store.useBed(project, BUNDLED.id)).toEqual({ file: 'music-2.ogg' })
    expect(createHash('sha256').update(readFileSync(path.join(project, 'music-2.ogg'))).digest('hex')).toBe(BUNDLED.prepared.sha256)
    await store.downloadBed('test-bed', quiet())
    expect(await store.useBed(project, 'test-bed')).toEqual({ file: 'music-3.ogg' })
    // A downloaded file changed afterwards: deleted, offered for download again, nothing copied.
    writeFileSync(path.join(dir, 'bed-calm-old-key.ogg'), Buffer.concat([FILE.subarray(0, FILE.length - 1), Buffer.from('x')]))
    await expect(store.useBed(project, 'test-bed')).rejects.toThrow(store.LIBRARY_COPY.changed)
    expect(existsSync(path.join(dir, 'bed-calm-old-key.ogg'))).toBe(false)
    expect((await store.listLibrary())[1].state).toBe('missing')
    expect(readdirSync(project).sort()).toEqual(['music-1.mp3', 'music-2.ogg', 'music-3.ogg'])
    await expect(store.useBed(project, 'test-bed')).rejects.toThrow(store.LIBRARY_COPY.missing)
    await expect(store.useBed(project, 'nope')).rejects.toThrow(store.LIBRARY_COPY.notOffered)
  })

  it('a copy that does not hash as the pin is not kept', async () => {
    use(server(() => ({ status: 200, body: FILE })).get)
    const project = mkdtempSync(path.join(h.root, 'proj-'))
    const put = async (): Promise<string> => {
      writeFileSync(path.join(project, 'music-1.ogg'), 'not the bed')
      return 'music-1.ogg'
    }
    await expect(store.useBed(project, BUNDLED.id, put)).rejects.toThrow()
    expect(existsSync(path.join(project, 'music-1.ogg'))).toBe(false)
  })
})

describe('the IPC (test 67)', () => {
  // The app's own page (security.ts appPage: out/renderer/index.html next to the main bundle).
  const page = pathToFileURL(path.join(__dirname, '..', 'src', 'main', '..', 'renderer', 'index.html')).href
  const app = { senderFrame: { url: page }, sender: { send: vi.fn(), isDestroyed: () => false } }
  const evil = { senderFrame: { url: 'https://evil.example/' }, sender: app.sender }

  it('fromApp rejects another frame on every channel; ids are checked against the catalogue', async () => {
    registerSoundLibraryIpc()
    use(server(() => ({ status: 200, body: FILE })).get)
    for (const channel of [SOUND_LIBRARY_CHANNELS.list, SOUND_LIBRARY_CHANNELS.download, SOUND_LIBRARY_CHANNELS.cancel, SOUND_LIBRARY_CHANNELS.remove, SOUND_LIBRARY_CHANNELS.useBed]) {
      const fn = h.handlers.get(channel)!
      expect(fn, channel).toBeDefined()
      await expect(Promise.resolve().then(() => fn(evil, 'p1', BUNDLED.id)), channel).rejects.toThrow('Not allowed')
    }
    const list = (await h.handlers.get(SOUND_LIBRARY_CHANNELS.list)!(app)) as { id: string }[]
    expect(list.map((s) => s.id)).toEqual([BUNDLED.id, 'test-bed'])
    await expect(Promise.resolve().then(() => h.handlers.get(SOUND_LIBRARY_CHANNELS.download)!(app, '../../x'))).rejects.toThrow(store.LIBRARY_COPY.notOffered)
    await expect(Promise.resolve().then(() => h.handlers.get(SOUND_LIBRARY_CHANNELS.useBed)!(app, '../p', BUNDLED.id))).rejects.toThrow(/Invalid project id/)
  })

  it('useBed stores the bed as the project next music pick through the asset store', async () => {
    registerSoundLibraryIpc()
    use(server(() => ({ status: 200, body: FILE })).get)
    const id = 'rec-sound-1'
    mkdirSync(projectDir(id), { recursive: true })
    const r = (await h.handlers.get(SOUND_LIBRARY_CHANNELS.useBed)!(app, id, BUNDLED.id)) as { file: string }
    expect(r).toEqual({ file: 'music-1.ogg' })
    expect(readFileSync(path.join(projectDir(id), 'music-1.ogg')).length).toBe(BUNDLED.prepared.bytes)
  })
})

describe('the sounds host of the media protocol (test 68)', () => {
  it('serves catalogue names only; ../, other names and project files get 404', async () => {
    use(server(() => ({ status: 404 })).get)
    handleMediaProtocol()
    const get = (u: string): Promise<Response> => h.protocol!(new Request(u))
    const pop = await get('studio-media://sounds/sfx-pop.ogg')
    expect(pop.status).toBe(200)
    expect(pop.headers.get('content-type')).toBe('audio/ogg')
    expect(Buffer.from(await pop.arrayBuffer()).length).toBe(lib.soundEffect('pop')!.prepared.bytes)
    expect((await get(`studio-media://sounds/${BUNDLED.prepared.file}`)).status).toBe(200)
    const id = 'rec-sound-2'
    mkdirSync(projectDir(id), { recursive: true })
    writeFileSync(path.join(projectDir(id), 'music-1.ogg'), 'OggS')
    for (const bad of [
      'studio-media://sounds/..%2Fsfx-pop.ogg',
      'studio-media://sounds/%2E%2E%2Fresources%2Fsound-library%2Fsfx-pop.ogg',
      'studio-media://sounds/SOUNDS.md',
      'studio-media://sounds/music-1.ogg',
      `studio-media://sounds/${id}/music-1.ogg`,
      'studio-media://sounds/screen.mp4',
      'studio-media://sounds/sfx-pop.ogg/x',
      'studio-media://sounds/sfx-nope.ogg',
      // A downloadable bed that is not downloaded.
      'studio-media://sounds/bed-calm-old-key.ogg'
    ])
      expect((await get(bad)).status, bad).toBe(404)
    // Downloaded, it is served from the downloads folder.
    writeFileSync(path.join(dir, 'bed-calm-old-key.ogg'), FILE)
    expect((await get('studio-media://sounds/bed-calm-old-key.ogg')).status).toBe(200)
    expect(paths.soundPath('bed-calm-old-key.ogg')).toBe(path.join(dir, 'bed-calm-old-key.ogg'))
    expect(paths.soundPath('sfx-pop.ogg')).toBe(path.join(LIBRARY, 'sfx-pop.ogg'))
    expect(paths.soundPath('../sfx-pop.ogg')).toBeNull()
  })
})
