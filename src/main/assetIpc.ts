/**
 * Picking a user file into a project folder ("assets"): the watermark image, background music,
 * image overlays and fonts, copied in so the project folder stays self-contained and served to
 * the renderer by studio-media://. Each pick gets a new name (watermark-<n>.<ext>,
 * music-<n>.<ext>, overlay-<n>.<ext>, font-<n>.<ext>): a pick never overwrites or deletes the file
 * in use, so undo can go back to it and a file the renderer cannot decode changes nothing. The
 * latest few logo and music picks are kept; overlays and fonts are never removed (several are in
 * use at once) and an identical file is stored once (docs/design/brand-kit.md §2).
 */
import { createHash } from 'node:crypto'
import { clipboard, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetKind, PickedAsset } from '../shared/api/projects'
import { MUSIC_FILE_RE, nextMusicFile, staleMusicFiles } from '../shared/audio/settings'
import { OVERLAY_FILE_RE, OVERLAY_MAX_BYTES, OVERLAY_SVG_MAX_BYTES } from '../shared/engine/overlayData'
import { nextPickFile, type PickedFiles } from '../shared/engine/picks'
import { nextWatermarkFile, staleWatermarkFiles, WATERMARK_FILE_RE, WATERMARK_MAX_BYTES } from '../shared/engine/watermark'
import { checkFont, FONT_FILE_RE, FONT_MAX_BYTES } from '../shared/render/fonts'
import type { Project } from '../shared/types'
import { mediaUrl } from './mediaProtocol'
import * as projects from './projects'
import { isAppUrl } from './security'
import { getMainWindow } from './windows'

interface AssetSpec {
  title: string
  filterName: string
  extensions: string[]
  maxBytes: number
  /** Readable name of the accepted formats, for error messages. */
  formats: string
  /** Why a file with these first bytes and extension is refused, or null when it looks right. */
  check: (head: Buffer, ext: string) => string | null
}

const starts = (head: Buffer, ...bytes: number[]): boolean => bytes.every((b, i) => head[i] === b)
const ascii = (head: Buffer, from: number, to: number): string => head.subarray(from, to).toString('latin1')

type ImageType = 'png' | 'jpg' | 'webp' | 'svg' | 'gif'
const IMAGE_NAMES: Record<ImageType, string> = { png: 'a PNG', jpg: 'a JPG', webp: 'a WebP', svg: 'an SVG', gif: 'a GIF' }

/** The image format the first bytes of a file show: PNG, JPEG, WebP, GIF or SVG, else null. */
export function imageType(head: Buffer): ImageType | null {
  if (starts(head, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (starts(head, 0xff, 0xd8, 0xff)) return 'jpg'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp'
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'gif'
  return /<svg[\s>]/i.test(head.toString('utf8')) ? 'svg' : null
}

/** A PNG, JPEG, WebP or SVG image (the formats a logo can be). */
export const looksLikeImage = (head: Buffer): boolean => {
  const type = imageType(head)
  return type !== null && type !== 'gif'
}

/**
 * An image is decoded as the type its extension is served as (an SVG strictly, with nosniff),
 * so its content must be that type: a PNG named logo.svg would never show. `allowed` are the
 * types the asset may be; anything else reads as "not one of `formats`".
 */
const checkImageOf =
  (allowed: readonly ImageType[], formats: string) =>
  (head: Buffer, ext: string): string | null => {
    const type = imageType(head)
    if (!type || !allowed.includes(type)) return `This file could not be read as ${formats}.`
    const named = ext === 'jpeg' ? 'jpg' : ext
    return type === named ? null : `This file is named .${ext} but holds ${IMAGE_NAMES[type]} image: rename it to .${type} and choose it again.`
  }

/** MP3, M4A/AAC, WAV, Ogg/Opus or FLAC. */
export function looksLikeAudio(head: Buffer): boolean {
  if (ascii(head, 0, 3) === 'ID3') return true // MP3 with tags
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true // MPEG / ADTS frame
  if (ascii(head, 4, 8) === 'ftyp') return true // M4A
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return true
  if (ascii(head, 0, 4) === 'OggS') return true
  return ascii(head, 0, 4) === 'fLaC'
}

const LOGO_FORMATS = 'a PNG, JPG, WebP or SVG image'
const OVERLAY_FORMATS = 'a PNG, JPG, WebP, SVG or GIF image'

export const ASSET_SPECS: Record<AssetKind, AssetSpec> = {
  watermark: {
    title: 'Choose watermark or logo',
    filterName: 'Images',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'],
    maxBytes: WATERMARK_MAX_BYTES,
    formats: LOGO_FORMATS,
    check: checkImageOf(['png', 'jpg', 'webp', 'svg'], LOGO_FORMATS)
  },
  overlay: {
    title: 'Add an image',
    filterName: 'Images',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'],
    maxBytes: OVERLAY_MAX_BYTES,
    formats: OVERLAY_FORMATS,
    check: checkImageOf(['png', 'jpg', 'webp', 'svg', 'gif'], OVERLAY_FORMATS)
  },
  font: {
    title: 'Add a font',
    filterName: 'Fonts',
    extensions: ['ttf', 'otf', 'woff2'],
    maxBytes: FONT_MAX_BYTES,
    formats: 'a TTF, OTF or WOFF2 font',
    check: checkFont
  },
  music: {
    title: 'Choose background music',
    filterName: 'Audio',
    extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'],
    maxBytes: 500 * 1024 * 1024,
    formats: 'an MP3, M4A, AAC, WAV, Ogg, Opus or FLAC file',
    // Audio decoders read the container from the content, whatever the extension says.
    check: (head) => (looksLikeAudio(head) ? null : `This file could not be read as ${ASSET_SPECS.music.formats}.`)
  }
}

/** SVGs are text and drawn by rasterising them: a bigger one is not a logo or sticker. */
const SVG_MAX_BYTES: Partial<Record<AssetKind, number>> = { overlay: OVERLAY_SVG_MAX_BYTES }

/** Asset files the media protocol may serve. */
export const isAssetFile = (file: string): boolean => WATERMARK_FILE_RE.test(file) || MUSIC_FILE_RE.test(file) || OVERLAY_FILE_RE.test(file) || FONT_FILE_RE.test(file)

const isKind = (kind: unknown): kind is AssetKind => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ASSET_SPECS, kind)

interface Picks {
  /** The new pick's file name, after the files already in the folder. */
  next: (existing: readonly string[], ext: string) => string
  /** Earlier picks a new one makes unneeded: all but the latest few and the ones in `keep`. */
  stale: (existing: readonly string[], keep: ReadonlySet<string>) => string[]
  /** The pick a saved project uses. */
  saved: (p: Project) => string | undefined
}
// pickNumber reads the number from the first group, "-<n>".
const OVERLAY_PICKS: PickedFiles = { base: 'overlay', re: /^overlay(-[1-9][0-9]{0,8})\.(png|jpg|webp|svg|gif)$/i, keep: Infinity }
const FONT_PICKS: PickedFiles = { base: 'font', re: /^font(-[1-9][0-9]{0,8})\.(ttf|otf|woff2)$/i, keep: Infinity }
const PICKS: Record<AssetKind, Picks> = {
  watermark: { next: nextWatermarkFile, stale: staleWatermarkFiles, saved: (p) => p.watermark?.path },
  music: { next: nextMusicFile, stale: staleMusicFiles, saved: (p) => p.audio?.music?.path },
  // Never removed: several are in use at once, and undo can bring any of them back.
  overlay: { next: (existing, ext) => nextPickFile(OVERLAY_PICKS, existing, ext), stale: () => [], saved: () => undefined },
  font: { next: (existing, ext) => nextPickFile(FONT_PICKS, existing, ext), stale: () => [], saved: () => undefined }
}

/** Kinds stored once per content: an identical file already in the folder is used again. */
const DEDUPED: ReadonlySet<AssetKind> = new Set(['overlay', 'font'])

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** The files of each deduplicated kind. */
const DEDUPED_RE: Partial<Record<AssetKind, RegExp>> = { overlay: OVERLAY_FILE_RE, font: FONT_FILE_RE }

/** A file of `kind` in `dir` with exactly these bytes and extension, or null. */
async function sameFile(dir: string, kind: AssetKind, ext: string, data: Buffer): Promise<string | null> {
  const re = DEDUPED_RE[kind]
  if (!re) return null
  const want = sha256(data)
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!re.test(name) || path.extname(name).slice(1).toLowerCase() !== ext) continue
    const file = path.join(dir, name)
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile() || st.size !== data.length) continue
    if (sha256(await fs.readFile(file)) === want) return name
  }
  return null
}

/** Why `size` bytes of `kind` with extension `ext` are refused, or null. */
function sizeProblem(kind: AssetKind, ext: string, size: number): string | null {
  const spec = ASSET_SPECS[kind]
  if (size === 0) return 'This file is empty.'
  const max = ext === 'svg' ? (SVG_MAX_BYTES[kind] ?? spec.maxBytes) : spec.maxBytes
  if (size > max) return `The file is too large (${Math.max(1, Math.round(size / 1e6))} MB; ${Math.round(max / 1e6)} MB at most).`
  return null
}

/** The extension a file name gives, lower case, as stored (jpeg -> jpg). */
const extOf = (name: string): string => path.extname(name).slice(1).toLowerCase()
const storedExt = (ext: string): string => (ext === 'jpeg' ? 'jpg' : ext)

/** Checks the first bytes of `kind` with extension `ext`; throws the reason when refused. */
function checkHead(kind: AssetKind, head: Buffer, ext: string): void {
  const problem = ASSET_SPECS[kind].check(head.subarray(0, 4096), ext)
  if (problem) throw new Error(problem)
}

/** The last import queued for each project folder (it never rejects). */
const folderQueue = new Map<string, Promise<unknown>>()

/**
 * Runs `job` once the earlier ones for folder `dir` are done: an import picks its file name from
 * what the folder holds, so two at once (a drop, then Ctrl+V) would write the same file.
 */
function inFolder<T>(dir: string, job: () => Promise<T>): Promise<T> {
  const run = (folderQueue.get(dir) ?? Promise.resolve()).then(job)
  const done = run.catch(() => undefined)
  folderQueue.set(dir, done)
  void done.then(() => {
    if (folderQueue.get(dir) === done) folderQueue.delete(dir)
  })
  return run
}

/**
 * Stores checked content as a new `kind` file of project `id` (or the identical one already
 * there, for overlays and fonts): written under a temporary name, then renamed, so a failure
 * leaves the folder as it was. `data` is the content, or a file to copy (large music). Imports
 * into one project run one at a time.
 */
async function store(id: string, kind: AssetKind, ext: string, data: Buffer | { file: string }): Promise<PickedAsset> {
  const spec = ASSET_SPECS[kind]
  const dir = projects.projectDir(id)
  const stored = storedExt(ext)
  return inFolder(dir, async () => {
    if (DEDUPED.has(kind) && Buffer.isBuffer(data)) {
      const same = await sameFile(dir, kind, stored, data)
      if (same) return { url: mediaUrl(id, same), path: same }
    }
    const name = PICKS[kind].next(await fs.readdir(dir).catch(() => []), stored)
    if (!isAssetFile(name)) throw new Error(`Choose ${spec.formats}.`)
    const tmp = path.join(dir, `.${name}.part`)
    try {
      if (Buffer.isBuffer(data)) await fs.writeFile(tmp, data)
      else await fs.copyFile(data.file, tmp)
      await fs.rename(tmp, path.join(dir, name))
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    await prunePicks(id, kind, dir, name)
    return { url: mediaUrl(id, name), path: name }
  })
}

/**
 * Copies `src` into project `id` as its `kind` asset. The file is checked first (type by
 * extension and content, size) and copied under a temporary name, so a failure leaves the
 * earlier pick in place. Every pick gets a new name (an identical overlay or font is reused).
 */
export async function importAsset(id: string, kind: AssetKind, src: string): Promise<PickedAsset> {
  if (!isKind(kind)) throw new Error('Unknown asset kind')
  projects.projectDir(id)
  const ext = await checkAssetFile(kind, src)
  const name = path.basename(src)
  // Overlays and fonts are small enough to read whole (25 MB at most): hashed from memory.
  return { ...(await store(id, kind, ext, DEDUPED.has(kind) ? await fs.readFile(src) : { file: src })), name }
}

/**
 * Checks file `src` as a `kind` asset (extension, size, then content) without copying it, and
 * returns its extension (lower case). Throws the reason it is refused.
 */
export async function checkAssetFile(kind: AssetKind, src: string): Promise<string> {
  if (!isKind(kind)) throw new Error('Unknown asset kind')
  const spec = ASSET_SPECS[kind]
  const ext = extOf(src)
  if (!spec.extensions.includes(ext)) throw new Error(`Choose ${spec.formats}.`)
  const st = await fs.stat(src)
  if (!st.isFile()) throw new Error(`Choose ${spec.formats}.`)
  const tooBig = sizeProblem(kind, ext, st.size)
  if (tooBig) throw new Error(tooBig)
  const handle = await fs.open(src, 'r')
  try {
    const head = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    checkHead(kind, head.subarray(0, bytesRead), ext)
  } finally {
    await handle.close()
  }
  return ext
}

/** Kinds that can arrive as bytes (a dropped or pasted image, a dropped font). */
const DATA_KINDS: ReadonlySet<AssetKind> = new Set(['overlay', 'font'])

/**
 * Stores `bytes` (a file dropped on or pasted into the editor) as a `kind` asset of project
 * `id`. `name` only gives the extension and the name shown; it is never used as a path. The
 * same checks as a picked file, the size first.
 */
export async function importAssetData(id: string, kind: AssetKind, name: string, bytes: Uint8Array): Promise<PickedAsset> {
  if (!isKind(kind) || !DATA_KINDS.has(kind)) throw new Error('Unknown asset kind')
  const spec = ASSET_SPECS[kind]
  if (!(bytes instanceof Uint8Array)) throw new Error(`Choose ${spec.formats}.`)
  projects.projectDir(id)
  const shown = path.basename(String(name).replace(/\\/g, '/')).slice(0, 200)
  const ext = extOf(shown)
  if (!spec.extensions.includes(ext)) throw new Error(kind === 'overlay' ? 'Only PNG, JPG, WebP, SVG and GIF images can be added.' : `Choose ${spec.formats}.`)
  const tooBig = sizeProblem(kind, ext, bytes.byteLength)
  if (tooBig) throw new Error(tooBig)
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  checkHead(kind, data, ext)
  return { ...(await store(id, kind, ext, data)), name: shown }
}

/**
 * Removes picks nothing returns to any more: all but the latest few, keeping the new pick and
 * the file the saved project uses. Never fails the pick (a leftover file is harmless).
 */
async function prunePicks(id: string, kind: AssetKind, dir: string, picked: string): Promise<void> {
  try {
    const keep = new Set([picked])
    const saved = await projects.readProject(id).then(PICKS[kind].saved, () => undefined)
    if (typeof saved === 'string') keep.add(saved)
    for (const name of PICKS[kind].stale(await fs.readdir(dir), keep)) await fs.rm(path.join(dir, name), { force: true })
  } catch (err) {
    console.warn(`Could not remove earlier ${kind} picks:`, err)
  }
}

/** SHA-256 of `blob`, read a piece at a time. */
async function blobSha256(blob: Blob): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of blob.stream()) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * The system clipboard's image (Chromium offers a copied picture as image/png): its fingerprint
 * (SHA-256 of its PNG), its size and, with `withBytes`, its PNG bytes; null without one. An image
 * over 25 MB is never read whole and its bytes are never sent: the renderer says it is too large.
 */
async function clipboardImage(withBytes: boolean): Promise<{ hash: string; size: number; png?: Uint8Array } | null> {
  try {
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue
      const blob = await item.getType('image/png')
      if (!(blob instanceof Blob) || blob.size === 0) return null
      if (blob.size > OVERLAY_MAX_BYTES) return { hash: await blobSha256(blob), size: blob.size }
      const png = new Uint8Array(await blob.arrayBuffer())
      return withBytes ? { hash: sha256(png), size: png.byteLength, png } : { hash: sha256(png), size: png.byteLength }
    }
  } catch (err) {
    console.warn('The clipboard could not be read:', err)
  }
  return null
}

export function registerAssetIpc(): void {
  ipcMain.handle('projects:pickAsset', async (_e, id: unknown, kind: unknown) => {
    if (typeof id !== 'string' || !isKind(kind)) return null
    // An invalid project id is refused before any dialog is shown.
    projects.projectDir(id)
    const spec = ASSET_SPECS[kind]
    const main = getMainWindow()
    if (!main) return null
    const result = await dialog.showOpenDialog(main, {
      title: spec.title,
      properties: ['openFile'],
      filters: [{ name: spec.filterName, extensions: spec.extensions }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importAsset(id, kind, result.filePaths[0])
  })

  // Ctrl+V in the editor (docs/design/brand-kit.md §4.5): the image on the system clipboard, by its
  // fingerprint (SHA-256 of its PNG) and size and, when asked, its PNG bytes. Only the app's page may ask.
  ipcMain.handle('projects:clipboardImage', async (e, withBytes: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return clipboardImage(withBytes === true)
  })

  ipcMain.handle('projects:importAssetData', (e, id: unknown, kind: unknown, name: unknown, bytes: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    if (typeof id !== 'string' || !isKind(kind) || typeof name !== 'string' || !(bytes instanceof Uint8Array)) throw new Error('Choose an image.')
    return importAssetData(id, kind, name, bytes)
  })

  ipcMain.handle('projects:assetUrl', async (_e, id: unknown, file: unknown): Promise<string | null> => {
    if (typeof id !== 'string' || typeof file !== 'string' || !isAssetFile(file)) return null
    let dir: string
    try {
      dir = projects.projectDir(id)
    } catch {
      return null
    }
    return (await projects.exists(path.join(dir, file))) ? mediaUrl(id, file) : null
  })
}
