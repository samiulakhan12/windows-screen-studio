/**
 * Adding files to the brand kit's folder (checked like project assets: type by content, size)
 * and copying the kit's files into a project before "Apply brand kit" (docs/design/brand-kit.md
 * §2 decision 21), so the project never points at a missing file.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BrandKitFiles } from '../shared/api/brandKit'
import { MAX_BRAND_FONTS, type BrandFiles } from '../shared/editor/brandKit'
import { nextPickFile } from '../shared/engine/picks'
import { FONT_FILE_RE, fontNameFromFile, newFontId } from '../shared/render/fonts'
import type { ProjectFont } from '../shared/types'
import { checkAssetFile, importAsset } from './assetIpc'
import { brandKitDir, brandKitFile, FONT_PICKS, isBrandFile, loadBrandKit, LOGO_PICKS } from './brandKit'
import { projectDir } from './projects'

/**
 * Copies `src` into the kit's folder as a new logo or font file, checked as a logo (PNG, JPG,
 * WebP, SVG; 20 MB) or a font (TTF, OTF, WOFF2; 15 MB). The kit file is not changed: the caller
 * saves a kit naming it (until then the file is unused, and the next save removes it).
 */
export async function addBrandFile(kind: 'logo' | 'font', src: string, file = brandKitFile()): Promise<{ file: string; font?: ProjectFont }> {
  const ext = (await checkAssetFile(kind === 'logo' ? 'watermark' : 'font', src)).replace('jpeg', 'jpg')
  const dir = brandKitDir(file)
  await fs.mkdir(dir, { recursive: true })
  const existing = await fs.readdir(dir).catch(() => [] as string[])
  if (kind === 'font' && existing.filter((n) => FONT_FILE_RE.test(n)).length >= MAX_BRAND_FONTS * 4) throw new Error('Remove a font from the brand kit first.')
  const name = nextPickFile(kind === 'logo' ? LOGO_PICKS : FONT_PICKS, existing, ext)
  if (!isBrandFile(name)) throw new Error('This file cannot be added.')
  const tmp = path.join(dir, `.${name}.part`)
  try {
    await fs.copyFile(src, tmp)
    await fs.rename(tmp, path.join(dir, name))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  return kind === 'font' ? { file: name, font: { id: newFontId(), name: fontNameFromFile(path.basename(src)), file: name } } : { file: name }
}

/**
 * Copies the kit's logo and fonts into project `id` (as watermark-<n> and font-<n>, an identical
 * font reused) and returns the saved kit with where each file went. A file that cannot be copied
 * is left out of `files` (that part of the kit is then not applied).
 */
export async function copyKitIntoProject(id: string, file = brandKitFile()): Promise<BrandKitFiles> {
  projectDir(id)
  const kit = await loadBrandKit(file)
  const dir = brandKitDir(file)
  const files: BrandFiles = { fonts: {} }
  if (kit.logo) {
    try {
      files.logo = (await importAsset(id, 'watermark', path.join(dir, kit.logo.file))).path
    } catch (err) {
      console.warn('The brand kit logo could not be copied into the project:', err)
    }
  }
  for (const f of kit.fonts) {
    try {
      files.fonts[f.id] = (await importAsset(id, 'font', path.join(dir, f.file))).path
    } catch (err) {
      console.warn(`The brand kit font ${f.name} could not be copied into the project:`, err)
    }
  }
  return { kit, files }
}
