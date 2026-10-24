/**
 * Picking a user file into a project folder ("assets"): the watermark image and background
 * music. The file is copied as `<kind>.<ext>` (replacing an earlier pick of the same kind) so
 * the project folder stays self-contained, and served to the renderer by studio-media://.
 */
import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetKind } from '../shared/api/projects'
import { mediaUrl } from './mediaProtocol'
import * as projects from './projects'
import { getMainWindow } from './windows'

interface AssetSpec {
  title: string
  filterName: string
  extensions: string[]
  maxBytes: number
}

export const ASSET_SPECS: Record<AssetKind, AssetSpec> = {
  watermark: { title: 'Choose watermark or logo', filterName: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'], maxBytes: 20 * 1024 * 1024 },
  music: { title: 'Choose background music', filterName: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'], maxBytes: 500 * 1024 * 1024 }
}

/** File name an asset of `kind` with extension `ext` is stored under. */
export function assetFileName(kind: AssetKind, ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg')
  return `${kind}.${e}`
}

/** Copies `src` into project `id` as its `kind` asset; removes earlier picks of that kind. */
export async function importAsset(id: string, kind: AssetKind, src: string): Promise<{ url: string; path: string }> {
  const spec = ASSET_SPECS[kind]
  const ext = path.extname(src).slice(1).toLowerCase()
  if (!spec.extensions.includes(ext)) throw new Error(`Unsupported file type .${ext}`)
  const { size } = await fs.stat(src)
  if (size > spec.maxBytes) throw new Error(`The file is too large (${Math.round(size / 1e6)} MB)`)
  const dir = projects.projectDir(id)
  for (const e of spec.extensions) await fs.rm(path.join(dir, assetFileName(kind, e)), { force: true })
  const name = assetFileName(kind, ext)
  await fs.copyFile(src, path.join(dir, name))
  return { url: mediaUrl(id, name), path: name }
}

export function registerAssetIpc(): void {
  ipcMain.handle('projects:pickAsset', async (_e, id: string, kind: AssetKind) => {
    const spec = ASSET_SPECS[kind]
    const main = getMainWindow()
    if (!spec || !main) return null
    const result = await dialog.showOpenDialog(main, {
      title: spec.title,
      properties: ['openFile'],
      filters: [{ name: spec.filterName, extensions: spec.extensions }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importAsset(id, kind, result.filePaths[0])
  })

  ipcMain.handle('projects:assetUrl', async (_e, id: string, file: string): Promise<string | null> => {
    if (typeof file !== 'string' || !ASSET_FILE_RE.test(file)) return null
    return (await projects.exists(path.join(projects.projectDir(id), file))) ? mediaUrl(id, file) : null
  })
}

/** Asset files the media protocol may serve. */
export const ASSET_FILE_RE = /^(watermark\.(png|jpg|webp|svg)|music\.(mp3|m4a|aac|wav|ogg|opus|flac))$/i
