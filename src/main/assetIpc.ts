/**
 * Picking a user file into a project folder ("assets"): the watermark image and background
 * music. The file is copied as `<kind>.<ext>` (replacing an earlier pick of the same kind) so
 * the project folder stays self-contained, and served to the renderer by studio-media://.
 */
import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetKind } from '../shared/api/projects'
import { WATERMARK_MAX_BYTES } from '../shared/engine/watermark'
import { mediaUrl } from './mediaProtocol'
import * as projects from './projects'
import { getMainWindow } from './windows'

interface AssetSpec {
  title: string
  filterName: string
  extensions: string[]
  maxBytes: number
  /** Readable name of the accepted formats, for error messages. */
  formats: string
  /** Whether the first bytes of a file look like one of the accepted formats. */
  sniff: (head: Buffer) => boolean
}

const starts = (head: Buffer, ...bytes: number[]): boolean => bytes.every((b, i) => head[i] === b)
const ascii = (head: Buffer, from: number, to: number): string => head.subarray(from, to).toString('latin1')

/** PNG, JPEG, WebP or SVG. */
export function looksLikeImage(head: Buffer): boolean {
  if (starts(head, 0x89, 0x50, 0x4e, 0x47)) return true
  if (starts(head, 0xff, 0xd8, 0xff)) return true
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return true
  return /<svg[\s>]/i.test(head.toString('utf8'))
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

export const ASSET_SPECS: Record<AssetKind, AssetSpec> = {
  watermark: {
    title: 'Choose watermark or logo',
    filterName: 'Images',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'],
    maxBytes: WATERMARK_MAX_BYTES,
    formats: 'a PNG, JPG, WebP or SVG image',
    sniff: looksLikeImage
  },
  music: {
    title: 'Choose background music',
    filterName: 'Audio',
    extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'],
    maxBytes: 500 * 1024 * 1024,
    formats: 'an MP3, M4A, AAC, WAV, Ogg, Opus or FLAC file',
    sniff: looksLikeAudio
  }
}

const isKind = (kind: unknown): kind is AssetKind => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ASSET_SPECS, kind)

/** File name an asset of `kind` with extension `ext` is stored under. */
export function assetFileName(kind: AssetKind, ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg')
  return `${kind}.${e}`
}

/**
 * Copies `src` into project `id` as its `kind` asset, then removes earlier picks of that kind.
 * The file is checked first (type by extension and content, size), and copied under a temporary
 * name: a failure leaves the earlier pick in place.
 */
export async function importAsset(id: string, kind: AssetKind, src: string): Promise<{ url: string; path: string }> {
  if (!isKind(kind)) throw new Error('Unknown asset kind')
  const spec = ASSET_SPECS[kind]
  const dir = projects.projectDir(id)
  const ext = path.extname(src).slice(1).toLowerCase()
  if (!spec.extensions.includes(ext)) throw new Error(`Choose ${spec.formats}.`)
  const st = await fs.stat(src)
  if (!st.isFile()) throw new Error(`Choose ${spec.formats}.`)
  if (st.size === 0) throw new Error('This file is empty.')
  if (st.size > spec.maxBytes) throw new Error(`The file is too large (${Math.round(st.size / 1e6)} MB; ${Math.round(spec.maxBytes / 1e6)} MB at most).`)
  const handle = await fs.open(src, 'r')
  try {
    const head = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (!spec.sniff(head.subarray(0, bytesRead))) throw new Error(`This file could not be read as ${spec.formats}.`)
  } finally {
    await handle.close()
  }
  const name = assetFileName(kind, ext)
  if (!ASSET_FILE_RE.test(name)) throw new Error(`Choose ${spec.formats}.`)
  const tmp = path.join(dir, `.${name}.part`)
  try {
    await fs.copyFile(src, tmp)
    for (const e of spec.extensions) {
      const other = assetFileName(kind, e)
      if (other !== name) await fs.rm(path.join(dir, other), { force: true })
    }
    await fs.rename(tmp, path.join(dir, name))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  return { url: mediaUrl(id, name), path: name }
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

  ipcMain.handle('projects:assetUrl', async (_e, id: unknown, file: unknown): Promise<string | null> => {
    if (typeof id !== 'string' || typeof file !== 'string' || !ASSET_FILE_RE.test(file)) return null
    let dir: string
    try {
      dir = projects.projectDir(id)
    } catch {
      return null
    }
    return (await projects.exists(path.join(dir, file))) ? mediaUrl(id, file) : null
  })
}

/** Asset files the media protocol may serve. */
export const ASSET_FILE_RE = /^(watermark\.(png|jpg|webp|svg)|music\.(mp3|m4a|aac|wav|ogg|opus|flac))$/i
