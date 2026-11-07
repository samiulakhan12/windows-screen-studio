/**
 * The downloaded beds (docs/design/editing-polish.md §10.3, §14 rule 3): pinned downloads from the
 * chosen source only, SHA-256 checked, size capped, and copies into a project.
 *
 * Four beds ship in the installer; eight more download on request from SOUND_LIBRARY_SOURCE (§0
 * decision 1), which stays null until the release exists: until then nothing downloads (an
 * unpackaged app's test server, SSW_SOUND_BASE_URL, is the only exception, for the e2e test).
 * Every download goes through downloadPinned: never more than the pinned bytes, SHA-256 checked,
 * resumed and retried, a `.part` renamed only after the check, the first URL under the source's
 * exact prefix and a redirect only back under it or to the source's CDN host (allowSoundUrl). The
 * files are stored in userData/sound-library/ under their catalogue names and recorded in
 * library.json once verified; a bed is copied into a project only after its file is hashed again.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, promises as fs, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { SoundLibraryState } from '../../shared/api/soundLibrary'
import { nextMusicFile } from '../../shared/audio/settings'
import { MUSIC_BEDS, SOUND_LIBRARY_SOURCE, type MusicBed, type SoundLibrarySource } from '../../shared/audio/soundLibrary'
import { writeFileAtomicSync } from '../atomicWrite'
import { DownloadFailure, downloadPinned, electronGet, type HttpGet } from '../speech/download'
import { bundledSoundDir, downloadedSoundDir } from './paths'

/** The record of verified downloads. */
const RECORDS = 'library.json'
/** Largest library.json read. */
const RECORDS_MAX = 64 * 1024
/** Most bytes the downloaded beds may take together (§10.3: 7.1 MB today). */
export const LIBRARY_DOWNLOAD_CAP = 12_000_000

export const LIBRARY_COPY = {
  notOffered: 'This music is not one Flown offers.',
  notYet: 'This music cannot be downloaded yet.',
  mismatch: 'The download did not match the expected file, so it was deleted.',
  cancelled: 'The download was cancelled.',
  changed: 'The music file in the library has changed, so it was deleted. Download it again.',
  missing: 'The music file is missing from the library. Download it again.',
  bundledMissing: 'The music file is missing from this installation. Reinstall Flown to bring it back.',
  cap: 'The music library is larger than expected, so this download was stopped.'
}

/* ---------- which addresses ---------- */

/** Whether `url` may be requested from `source`: under its prefix (no query), or on its CDN hosts (a signed query); https, 443, no credentials or fragment. */
export function allowSourceUrl(url: URL, source: SoundLibrarySource | null): boolean {
  if (!source) return false
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  // An empty fragment or query still shows in href ("…#", "…?").
  if (url.hash || url.href.includes('#')) return false
  const href = url.href
  if (href.startsWith(source.prefix)) {
    if (url.search || href.includes('?')) return false
    const rest = href.slice(source.prefix.length)
    return rest.length > 0 && !rest.split('/').some((p) => p === '..' || p === '.' || /%2e%2e|%2f|%5c/i.test(p))
  }
  return source.cdnHosts.includes(url.hostname.toLowerCase())
}

/**
 * Whether a download may request `url` (the first request and every redirect): the chosen
 * source's rules (allowSourceUrl), nothing while SOUND_LIBRARY_SOURCE is null; and an unpackaged
 * app's test server (`testBase`, its origin only).
 */
export function allowSoundUrl(url: URL, testBase?: string | null): boolean {
  if (testBase) {
    try {
      if (url.origin === new URL(testBase).origin) return true
    } catch {
      // A malformed hook allows nothing extra.
    }
  }
  return allowSourceUrl(url, deps.source())
}

/* ---------- the store ---------- */

export interface SoundStoreDeps {
  /** userData/sound-library. */
  dir: () => string
  /** The bundled folder. */
  bundled: () => string
  get: HttpGet
  /** The release downloads come from (SOUND_LIBRARY_SOURCE). */
  source: () => SoundLibrarySource | null
  /** SSW_SOUND_BASE_URL in an unpackaged app (e2e): downloads come from there. */
  testBase: () => string | null
  freeBytes: (dir: string) => Promise<number | null>
  /** The catalogue's beds (tests pass beds with pins of their own). */
  beds: () => readonly MusicBed[]
  retryDelaysMs?: readonly number[]
}

const realDeps: SoundStoreDeps = {
  dir: downloadedSoundDir,
  bundled: bundledSoundDir,
  get: electronGet(),
  source: () => SOUND_LIBRARY_SOURCE,
  testBase: () => (!app.isPackaged && process.env.SSW_SOUND_BASE_URL ? process.env.SSW_SOUND_BASE_URL : null),
  freeBytes: async (dir) => {
    const s = await fs.statfs(dir).catch(() => null)
    return s ? Number(s.bavail) * Number(s.bsize) : null
  },
  beds: () => MUSIC_BEDS
}
let deps: SoundStoreDeps = realDeps

/** Replaces the store's dependencies (tests); `null` restores the real ones. */
export function configureSoundStore(next: Partial<SoundStoreDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps
}

const bedOf = (id: unknown): MusicBed | null => (typeof id === 'string' ? (deps.beds().find((b) => b.id === id) ?? null) : null)
/** Beds that download on request. */
const downloads = (): MusicBed[] => deps.beds().filter((b) => !b.bundled)
/** Whether downloads are offered: a source exists (or the test server). */
export const downloadsOffered = (): boolean => !!deps.source() || !!deps.testBase()

interface Records {
  [file: string]: { bytes: number; mtimeMs: number }
}

/** library.json through a sanitiser: only downloadable beds' names with numbers. */
function readRecords(): Records {
  const file = path.join(deps.dir(), RECORDS)
  try {
    if (statSync(file).size > RECORDS_MAX) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const files = raw && typeof raw === 'object' ? (raw as { files?: unknown }).files : null
    const names = new Set(downloads().map((b) => b.prepared.file))
    const out: Records = {}
    if (files && typeof files === 'object')
      for (const [name, r] of Object.entries(files as Record<string, unknown>)) {
        const rec = r as { bytes?: unknown; mtimeMs?: unknown }
        if (names.has(name) && typeof rec?.bytes === 'number' && typeof rec.mtimeMs === 'number' && Number.isFinite(rec.bytes) && Number.isFinite(rec.mtimeMs)) out[name] = { bytes: rec.bytes, mtimeMs: rec.mtimeMs }
      }
    return out
  } catch {
    return {}
  }
}

/** Changes library.json in one main-process turn (read, change, atomic write), as the caption assets' store does. */
function updateRecords(change: (records: Records) => boolean): void {
  const dir = deps.dir()
  mkdirSync(dir, { recursive: true })
  const records = readRecords()
  if (!change(records)) return
  writeFileAtomicSync(path.join(dir, RECORDS), JSON.stringify({ version: 1, files: records }))
}

/** Whether bed `bed`'s download is on disk as it was verified: its pinned size, unchanged since. */
async function verified(bed: MusicBed, records: Records): Promise<boolean> {
  const name = bed.prepared.file
  const stat = await fs.stat(path.join(deps.dir(), name)).catch(() => null)
  const rec = records[name]
  return !!stat && !!rec && stat.size === bed.prepared.bytes && rec.bytes === bed.prepared.bytes && Math.abs(rec.mtimeMs - stat.mtimeMs) <= 1
}

/** Downloads under way, by id. */
const active = new Map<string, { controller: AbortController; done: Promise<SoundLibraryState>; progress: number }>()

/** Every bed of the catalogue as it stands on this PC. */
export async function listLibrary(): Promise<SoundLibraryState[]> {
  const records = readRecords()
  const out: SoundLibraryState[] = []
  for (const bed of deps.beds()) {
    const bytes = bed.prepared.bytes
    const running = active.get(bed.id)
    if (bed.bundled) out.push({ id: bed.id, state: 'bundled', bytes })
    else if (running) out.push({ id: bed.id, state: 'downloading', bytes, progress: running.progress })
    else out.push({ id: bed.id, state: (await verified(bed, records)) ? 'downloaded' : 'missing', bytes })
  }
  return out
}

/** The message a failed download shows. */
function failureMessage(err: unknown): string {
  if (err instanceof DownloadFailure) {
    if (err.kind === 'mismatch') return LIBRARY_COPY.mismatch
    if (err.kind === 'cancelled') return LIBRARY_COPY.cancelled
    if (err.kind === 'disk') return err.message
    if (err.kind === 'network') return `The download stopped: ${err.message} Try again.`
    if (err.kind === 'refused') return 'GitHub or your network refused the download (HTTP 403). A proxy or firewall may be blocking it.'
    if (err.kind === 'missing') return `The music is no longer at its address (HTTP ${err.status ?? 404}).`
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Downloads bed `id` (a downloadable catalogue id; nothing else) from the chosen source; resolves
 * once the file is verified and recorded, rejects with the message to show (a mismatch deletes
 * the file). One download per id at a time; progress 0..1.
 */
export async function downloadBed(id: string, opts: { signal: AbortSignal; onProgress(p: number): void }): Promise<SoundLibraryState> {
  const bed = bedOf(id)
  if (!bed || bed.bundled) throw new Error(LIBRARY_COPY.notOffered)
  const running = active.get(bed.id)
  if (running) return running.done
  const source = deps.source()
  const testBase = deps.testBase()
  if (!source && !testBase) throw new Error(LIBRARY_COPY.notYet)
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const entry = { controller, done: null as unknown as Promise<SoundLibraryState>, progress: 0 }
  entry.done = (async (): Promise<SoundLibraryState> => {
    const dir = deps.dir()
    await fs.mkdir(dir, { recursive: true })
    const name = bed.prepared.file
    const dest = path.join(dir, name)
    // The whole library stays under its cap: the other verified beds and this one.
    const records = readRecords()
    let others = 0
    for (const b of downloads()) if (b.id !== bed.id && (await verified(b, records))) others += b.prepared.bytes
    if (others + bed.prepared.bytes > LIBRARY_DOWNLOAD_CAP) throw new Error(LIBRARY_COPY.cap)
    const url = testBase ? `${testBase.replace(/\/+$/, '')}/${encodeURIComponent(name)}` : `${source!.prefix}${name}`
    try {
      await downloadPinned({ url, bytes: bed.prepared.bytes, sha256: bed.prepared.sha256 }, dest, {
        get: deps.get,
        signal: controller.signal,
        allow: (u) => allowSoundUrl(u, testBase),
        freeBytes: deps.freeBytes,
        maxRetryAfterMs: 60_000,
        ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
        onProgress: (p) => {
          entry.progress = p.total > 0 ? Math.min(1, p.received / p.total) : 0
          opts.onProgress(entry.progress)
        }
      })
    } catch (err) {
      throw new Error(failureMessage(err))
    }
    try {
      const stat = await fs.stat(dest)
      updateRecords((r) => {
        r[name] = { bytes: stat.size, mtimeMs: stat.mtimeMs }
        return true
      })
      return { id: bed.id, state: 'downloaded', bytes: stat.size }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      throw new Error(`The music downloaded, but Flown could not save it${code ? ` (${code})` : ''}. Try again.`)
    }
  })()
  active.set(bed.id, entry)
  try {
    return await entry.done
  } finally {
    active.delete(bed.id)
    opts.signal.removeEventListener('abort', onAbort)
  }
}

/** Stops the download of `id`; its partial file is deleted. */
export async function cancelBedDownload(id: string): Promise<void> {
  const bed = bedOf(id)
  if (!bed || bed.bundled) return
  const running = active.get(bed.id)
  if (!running) return
  running.controller.abort()
  await running.done.catch(() => undefined)
  const file = path.join(deps.dir(), bed.prepared.file)
  for (const f of [`${file}.part`, `${file}.part.json`]) await fs.rm(f, { force: true })
}

/** Deletes every downloaded bed, its partial download and its record (Settings › Downloads › More music › Remove). */
export async function removeDownloadedBeds(): Promise<void> {
  for (const { controller } of active.values()) controller.abort()
  await Promise.all([...active.values()].map((a) => a.done.catch(() => undefined)))
  const dir = deps.dir()
  for (const bed of downloads()) {
    const file = path.join(dir, bed.prepared.file)
    for (const f of [file, `${file}.part`, `${file}.part.json`]) await fs.rm(f, { force: true })
  }
  updateRecords((r) => {
    if (Object.keys(r).length === 0) return false
    for (const k of Object.keys(r)) delete r[k]
    return true
  })
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** A bed's file in the library, read and checked against its pin; a downloaded one that changed is deleted. */
async function checkedBedFile(bed: MusicBed): Promise<string> {
  const dir = bed.bundled ? deps.bundled() : deps.dir()
  const file = path.join(dir, bed.prepared.file)
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(bed.bundled ? LIBRARY_COPY.bundledMissing : LIBRARY_COPY.missing)
  const data = stat.size === bed.prepared.bytes ? await fs.readFile(file) : null
  if (!data || data.length !== bed.prepared.bytes || sha256(data) !== bed.prepared.sha256) {
    if (bed.bundled) throw new Error(LIBRARY_COPY.bundledMissing)
    await fs.rm(file, { force: true })
    updateRecords((r) => {
      if (!r[bed.prepared.file]) return false
      delete r[bed.prepared.file]
      return true
    })
    throw new Error(LIBRARY_COPY.changed)
  }
  return file
}

/** Copies `src` into `projectDir` as the next music pick (temporary name, then rename); its name. */
async function copyAsPick(projectDir: string, src: string): Promise<string> {
  const name = nextMusicFile(await fs.readdir(projectDir).catch(() => [] as string[]), 'ogg')
  const tmp = path.join(projectDir, `.${name}.part`)
  try {
    await fs.copyFile(src, tmp)
    await fs.rename(tmp, path.join(projectDir, name))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  return name
}

/**
 * Copies bed `id` into the project as music-<n>.ogg (its hash checked again, before and after the
 * copy). `put` stores the file as the project's next music pick (the IPC passes the asset store's
 * import, which also prunes old picks); absent, a plain copy.
 */
export async function useBed(projectDir: string, id: string, put?: (src: string) => Promise<string>): Promise<{ file: string }> {
  const bed = bedOf(id)
  if (!bed) throw new Error(LIBRARY_COPY.notOffered)
  const src = await checkedBedFile(bed)
  const file = await (put ?? ((s: string) => copyAsPick(projectDir, s)))(src)
  // The copy is the pinned file, or it is not kept.
  const copy = path.join(projectDir, file)
  const data = await fs.readFile(copy).catch(() => null)
  if (!data || sha256(data) !== bed.prepared.sha256) {
    await fs.rm(copy, { force: true }).catch(() => undefined)
    throw new Error(bed.bundled ? LIBRARY_COPY.bundledMissing : LIBRARY_COPY.changed)
  }
  return { file }
}
