/**
 * The store of downloaded caption assets (docs/design/captions-studio.md §6.4, §12): the Chinese,
 * Japanese and Korean caption fonts of the catalogue, pinned by bytes and SHA-256, downloaded only
 * when the user asks (Look › Text, Settings › Downloads for captions) from their sources in order
 * (a Qbexel mirror once it exists, then google/fonts at its pinned commit on
 * raw.githubusercontent.com), with Retry-After honoured on a busy server. They are stored in
 * userData/caption-assets/ under names built from the catalogue (`<id>.ttf`), recorded in
 * assets.json once verified, and served through studio-media://assets/<file> by name only.
 * Nothing downloaded runs: fonts become FontFace bytes, checked again by Chromium's sanitiser.
 *
 * Translation models (offline translation, §11.9) join this store in phase B. TODO(phase B): their
 * catalogue, the bucket's prefix in allowAssetUrl, and unpacking (streamed, stopped past the
 * pinned unpacked size, hashed against the registry).
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assetFontFile, type AssetProgress, type AssetState } from '../../shared/api/assets'
import { CAPTION_MIRROR, CATALOG_FONTS, fontSources, GOOGLE_FONTS_COMMIT, NOTO_EMOJI_COMMIT, type CatalogFile, type CatalogFont } from '../../shared/captions/fontCatalog'
import { DownloadFailure, downloadPinned, electronGet, type HttpGet } from '../speech/download'

/** The folder under userData that holds the assets. */
export const ASSET_DIR = 'caption-assets'

/** The record of verified files. */
const RECORDS = 'assets.json'
/** Largest assets.json read. */
const RECORDS_MAX = 64 * 1024
/** A .part file untouched this long is deleted (as the speech store's, models.ts STALE_PART_MS). */
export const STALE_PART_MS = 30 * 24 * 3600_000

/** What a download that did not match its pin says (§12). */
export const MISMATCH_MESSAGE = 'The download did not match the expected file, so it was deleted.'

/** The downloadable fonts: every catalogue font that is not bundled (§6.4). */
const DOWNLOADS: readonly CatalogFont[] = CATALOG_FONTS.filter((f) => !f.bundled && f.files.length === 1)

/** The downloadable font `id` and its file, or null (ids only: nothing else can be asked for). */
function downloadable(id: unknown): { font: CatalogFont; file: CatalogFile } | null {
  if (typeof id !== 'string') return null
  const font = DOWNLOADS.find((f) => f.id === id)
  return font ? { font, file: font.files[0] } : null
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The file names the store serves: only names built from the catalogues (§12 ASSET_FILE_RE). */
export function assetFileRe(): RegExp {
  return new RegExp(`^(${DOWNLOADS.map((f) => escapeRe(assetFontFile(f.id))).join('|')})$`)
}

/** The pinned prefixes downloads may come from (§0.3 decision 1, §12), each https on port 443. */
function allowedPrefixes(): string[] {
  const out = [`https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/`, `https://raw.githubusercontent.com/googlefonts/noto-emoji/${NOTO_EMOJI_COMMIT}/`]
  if (CAPTION_MIRROR) out.push(`https://huggingface.co/${CAPTION_MIRROR.repository}/resolve/${CAPTION_MIRROR.commit}/`)
  return out
}

/** Hugging Face's CDN hosts a mirror's files redirect to (only with a mirror). */
const isHfCdn = (host: string): boolean => host === 'cdn-lfs.huggingface.co' || host.endsWith('.hf.co') || /^cdn-lfs(-[a-z0-9-]+)?\.huggingface\.co$/.test(host)

/**
 * Whether a download (or redirect) may go to `url`: https on port 443, no credentials, and one of
 * the pinned prefixes exactly (google/fonts and googlefonts/noto-emoji at their commits; the
 * mirror and its CDN once it exists). An unpackaged app's test server (SSW_ASSET_BASE_URL) is
 * allowed too.
 */
export function allowAssetUrl(url: URL, testBase?: string | null): boolean {
  if (testBase) {
    try {
      if (url.origin === new URL(testBase).origin) return true
    } catch {
      // A malformed hook allows nothing extra.
    }
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  if (url.search || url.hash) return false
  const href = url.href
  if (allowedPrefixes().some((p) => href.startsWith(p) && !href.slice(p.length).split('/').includes('..'))) return true
  return !!CAPTION_MIRROR && isHfCdn(url.hostname.toLowerCase())
}

/* ---------- the store ---------- */

export interface AssetStoreDeps {
  /** userData/caption-assets. */
  dir: () => string
  get: HttpGet
  /** SSW_ASSET_BASE_URL in an unpackaged app (e2e): downloads come from there. */
  testBase: () => string | null
  freeBytes: (dir: string) => Promise<number | null>
  /** Download retry and stall settings (tests make them short). */
  retryDelaysMs?: readonly number[]
  now?: () => number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

const realDeps: AssetStoreDeps = {
  dir: () => path.join(app.getPath('userData'), ASSET_DIR),
  get: electronGet(),
  testBase: () => (!app.isPackaged && process.env.SSW_ASSET_BASE_URL ? process.env.SSW_ASSET_BASE_URL : null),
  freeBytes: async (dir) => {
    const s = await fs.statfs(dir).catch(() => null)
    return s ? s.bavail * s.bsize : null
  }
}
let deps: AssetStoreDeps = realDeps

/** Replaces the store's dependencies (tests); `null` restores the real ones. */
export function configureAssetStore(next: Partial<AssetStoreDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps
}

interface Records {
  [file: string]: { bytes: number; mtimeMs: number }
}

/** assets.json through a sanitiser: only catalogue names with numbers. */
async function readRecords(): Promise<Records> {
  const file = path.join(deps.dir(), RECORDS)
  try {
    const stat = await fs.stat(file)
    if (stat.size > RECORDS_MAX) return {}
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    const files = raw && typeof raw === 'object' ? (raw as { files?: unknown }).files : null
    const out: Records = {}
    const re = assetFileRe()
    if (files && typeof files === 'object')
      for (const [name, r] of Object.entries(files as Record<string, unknown>)) {
        const rec = r as { bytes?: unknown; mtimeMs?: unknown }
        if (re.test(name) && typeof rec?.bytes === 'number' && typeof rec.mtimeMs === 'number' && Number.isFinite(rec.bytes) && Number.isFinite(rec.mtimeMs)) out[name] = { bytes: rec.bytes, mtimeMs: rec.mtimeMs }
      }
    return out
  } catch {
    return {}
  }
}

async function writeRecords(records: Records): Promise<void> {
  const dir = deps.dir()
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, RECORDS)
  const temp = `${file}.tmp`
  await fs.writeFile(temp, JSON.stringify({ version: 1, files: records }))
  await fs.rename(temp, file)
}

/** Whether `id`'s file is on disk as it was verified (the size of its pin, unchanged since). */
async function verified(id: string, records: Records): Promise<number | null> {
  const d = downloadable(id)
  if (!d) return null
  const name = assetFontFile(id)
  const stat = await fs.stat(path.join(deps.dir(), name)).catch(() => null)
  const rec = records[name]
  if (!stat || !rec || stat.size !== d.file.bytes || rec.bytes !== d.file.bytes || Math.abs(rec.mtimeMs - stat.mtimeMs) > 1) return null
  return stat.size
}

/** Downloads under way, by id. */
const active = new Map<string, { controller: AbortController; done: Promise<AssetState> }>()

/** .part files untouched for STALE_PART_MS are deleted (when the list is first read). */
async function sweepStaleParts(now: number): Promise<void> {
  for (const f of DOWNLOADS) {
    if (active.has(f.id)) continue
    const part = path.join(deps.dir(), `${assetFontFile(f.id)}.part`)
    const stat = await fs.stat(part).catch(() => null)
    if (stat && now - stat.mtimeMs >= STALE_PART_MS) {
      await fs.rm(part, { force: true })
      await fs.rm(`${part}.json`, { force: true })
    }
  }
}

/** Every downloadable asset as it stands on this PC (Settings › Downloads for captions). */
export async function listAssets(): Promise<AssetState[]> {
  await sweepStaleParts((deps.now ?? Date.now)())
  const records = await readRecords()
  const out: AssetState[] = []
  for (const f of DOWNLOADS) {
    if (active.has(f.id)) {
      out.push({ id: f.id, kind: 'font', state: 'downloading' })
      continue
    }
    const bytes = await verified(f.id, records)
    out.push(bytes !== null ? { id: f.id, kind: 'font', state: 'ready', bytes } : { id: f.id, kind: 'font', state: 'missing' })
  }
  return out
}

/** The message a failed download shows (§12). */
function failureMessage(err: unknown): string {
  if (err instanceof DownloadFailure) {
    if (err.kind === 'mismatch') return MISMATCH_MESSAGE
    if (err.kind === 'cancelled') return 'The download was cancelled.'
    if (err.kind === 'disk') return err.message
    if (err.kind === 'network') return `The download stopped: ${err.message} Try again.`
    // The speech store's words name a model and Hugging Face; fonts come from GitHub (the last source).
    if (err.kind === 'refused') return 'GitHub or your network refused the download (HTTP 403). A proxy or firewall may be blocking it.'
    if (err.kind === 'missing') return `The font is no longer at its address (HTTP ${err.status ?? 404}).`
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Downloads asset `id` (a catalogue id; nothing else) from its pinned sources in order, the busy
 * server's Retry-After honoured up to 10 minutes; resolves once the file is verified and recorded,
 * rejects with the message to show (a mismatch deletes the file). One download per id at a time.
 */
export async function downloadAsset(id: string, opts: { signal: AbortSignal; onProgress(p: AssetProgress): void }): Promise<AssetState> {
  const d = downloadable(id)
  if (!d) throw new Error('This download is not one Flown offers.')
  const running = active.get(id)
  if (running) return running.done
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const done = (async (): Promise<AssetState> => {
    const dir = deps.dir()
    await fs.mkdir(dir, { recursive: true })
    const name = assetFontFile(id)
    const dest = path.join(dir, name)
    const testBase = deps.testBase()
    const sources = testBase ? [`${testBase.replace(/\/+$/, '')}/${encodeURIComponent(path.posix.basename(d.file.path))}`] : fontSources(d.font, d.file)
    let received = 0
    try {
      await downloadPinned({ url: sources[0], bytes: d.file.bytes, sha256: d.file.sha256 }, dest, {
        get: deps.get,
        signal: controller.signal,
        sources,
        allow: (u) => allowAssetUrl(u, testBase),
        freeBytes: deps.freeBytes,
        ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.wait ? { wait: deps.wait } : {}),
        onProgress: (p) => {
          received = p.received
          opts.onProgress({ id, received: p.received, total: p.total })
        },
        onBusy: (retryAt) => opts.onProgress({ id, received, total: d.file.bytes, ...(retryAt !== null ? { retryAt } : {}) })
      })
    } catch (err) {
      throw new Error(failureMessage(err))
    }
    const stat = await fs.stat(dest)
    const records = await readRecords()
    records[name] = { bytes: stat.size, mtimeMs: stat.mtimeMs }
    await writeRecords(records)
    return { id, kind: 'font', state: 'ready', bytes: stat.size }
  })()
  active.set(id, { controller, done })
  try {
    return await done
  } finally {
    active.delete(id)
    opts.signal.removeEventListener('abort', onAbort)
  }
}

/** Stops the download of `id` (its .part is kept, to continue later). */
export function cancelAssetDownload(id: string): void {
  active.get(id)?.controller.abort()
}

/** Deletes asset `id`'s file, its partial download and its record. */
export async function removeAsset(id: string): Promise<void> {
  if (!downloadable(id)) throw new Error('This download is not one Flown offers.')
  active.get(id)?.controller.abort()
  const name = assetFontFile(id)
  const dir = deps.dir()
  for (const f of [name, `${name}.part`, `${name}.part.json`]) await fs.rm(path.join(dir, f), { force: true })
  const records = await readRecords()
  if (records[name]) {
    delete records[name]
    await writeRecords(records)
  }
}

/** The path of a served asset file, or null when the name is not one of the catalogue's (mediaProtocol's assets host). */
export function assetPath(file: string): string | null {
  return assetFileRe().test(file) ? path.join(deps.dir(), file) : null
}
