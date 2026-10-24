/**
 * Picking a user file into a project folder ("assets"): the watermark image and background
 * music, copied in so the project folder stays self-contained and served to the renderer by
 * studio-media://. Each pick gets a new name (watermark-<n>.<ext>, music-<n>.<ext>) and the
 * latest few are kept: a pick never overwrites or deletes the file in use, so undo can go back
 * to it and a file the renderer cannot decode changes nothing.
 */
import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetKind } from '../shared/api/projects'
import { MUSIC_FILE_RE, nextMusicFile, staleMusicFiles } from '../shared/audio/settings'
import { nextWatermarkFile, staleWatermarkFiles, WATERMARK_FILE_RE, WATERMARK_MAX_BYTES } from '../shared/engine/watermark'
import type { Project } from '../shared/types'
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
  /** Why a file with these first bytes and extension is refused, or null when it looks right. */
  check: (head: Buffer, ext: string) => string | null
}

const starts = (head: Buffer, ...bytes: number[]): boolean => bytes.every((b, i) => head[i] === b)
const ascii = (head: Buffer, from: number, to: number): string => head.subarray(from, to).toString('latin1')

type ImageType = 'png' | 'jpg' | 'webp' | 'svg'
const IMAGE_NAMES: Record<ImageType, string> = { png: 'a PNG', jpg: 'a JPG', webp: 'a WebP', svg: 'an SVG' }

/** The image format the first bytes of a file show: PNG, JPEG, WebP or SVG, else null. */
export function imageType(head: Buffer): ImageType | null {
  if (starts(head, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (starts(head, 0xff, 0xd8, 0xff)) return 'jpg'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp'
  return /<svg[\s>]/i.test(head.toString('utf8')) ? 'svg' : null
}

export const looksLikeImage = (head: Buffer): boolean => imageType(head) !== null

/**
 * An image is decoded as the type its extension is served as (an SVG strictly, with nosniff),
 * so its content must be that type: a PNG named logo.svg would never show.
 */
function checkImage(head: Buffer, ext: string): string | null {
  const type = imageType(head)
  if (!type) return `This file could not be read as ${ASSET_SPECS.watermark.formats}.`
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

export const ASSET_SPECS: Record<AssetKind, AssetSpec> = {
  watermark: {
    title: 'Choose watermark or logo',
    filterName: 'Images',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'],
    maxBytes: WATERMARK_MAX_BYTES,
    formats: 'a PNG, JPG, WebP or SVG image',
    check: checkImage
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

/** Asset files the media protocol may serve. */
export const isAssetFile = (file: string): boolean => WATERMARK_FILE_RE.test(file) || MUSIC_FILE_RE.test(file)

const isKind = (kind: unknown): kind is AssetKind => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ASSET_SPECS, kind)

interface Picks {
  /** The new pick's file name, after the files already in the folder. */
  next: (existing: readonly string[], ext: string) => string
  /** Earlier picks a new one makes unneeded: all but the latest few and the ones in `keep`. */
  stale: (existing: readonly string[], keep: ReadonlySet<string>) => string[]
  /** The pick a saved project uses. */
  saved: (p: Project) => string | undefined
}
const PICKS: Record<AssetKind, Picks> = {
  watermark: { next: nextWatermarkFile, stale: staleWatermarkFiles, saved: (p) => p.watermark?.path },
  music: { next: nextMusicFile, stale: staleMusicFiles, saved: (p) => p.audio?.music?.path }
}

/**
 * Copies `src` into project `id` as its `kind` asset. The file is checked first (type by
 * extension and content, size) and copied under a temporary name, so a failure leaves the
 * earlier pick in place. Every pick gets a new name.
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
    const problem = spec.check(head.subarray(0, bytesRead), ext)
    if (problem) throw new Error(problem)
  } finally {
    await handle.close()
  }
  const name = PICKS[kind].next(await fs.readdir(dir).catch(() => []), ext)
  if (!isAssetFile(name)) throw new Error(`Choose ${spec.formats}.`)
  const tmp = path.join(dir, `.${name}.part`)
  try {
    await fs.copyFile(src, tmp)
    await fs.rename(tmp, path.join(dir, name))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  await prunePicks(id, kind, dir, name)
  return { url: mediaUrl(id, name), path: name }
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
    console.warn(`Could not remove earlier ${kind === 'music' ? 'music' : 'logo'} picks:`, err)
  }
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
