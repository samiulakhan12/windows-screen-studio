/**
 * The brand kit on disk (docs/design/brand-kit.md §3): userData/brand-kit.json and its files in
 * userData/brand-kit/ (logo-<n>.<ext>, font-<n>.<ext>). The rules of the kit itself are in
 * src/shared/editor/brandKit.ts.
 *
 * The kit file only ever names files that exist, and saving it removes the files it no longer
 * names; files are added and copied into projects by brandKitFiles.ts. New recordings get the kit
 * through applyBrandKitToNew, which styleDefaults.ts calls from applyStyleDefaults (the recording
 * side is unchanged). This module does not load the asset IPC, so styleDefaults.ts stays light.
 */
import { app } from 'electron'
import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyBrandKit, BRAND_LOGO_FILE_RE, brandKitIsEmpty, sanitizeBrandKit, type BrandFiles, type BrandKit } from '../shared/editor/brandKit'
import { nextPickFile, type PickedFiles } from '../shared/engine/picks'
import { nextWatermarkFile } from '../shared/engine/watermark'
import { FONT_FILE_RE } from '../shared/render/fonts'
import type { Project } from '../shared/types'
import { writeFileAtomicSync } from './atomicWrite'
import { projectDir } from './projects'

const FILE_VERSION = 1

export const brandKitFile = (): string => path.join(app.getPath('userData'), 'brand-kit.json')
/** The kit's files live in a folder named after the kit file. */
export const brandKitDir = (file = brandKitFile()): string => path.join(path.dirname(file), 'brand-kit')

export const LOGO_PICKS: PickedFiles = { base: 'logo', re: /^logo(-[1-9][0-9]{0,8})\.(png|jpg|webp|svg)$/i, keep: Infinity }
export const FONT_PICKS: PickedFiles = { base: 'font', re: /^font(-[1-9][0-9]{0,8})\.(ttf|otf|woff2)$/i, keep: Infinity }

/** A file the kit's folder may hold. */
export const isBrandFile = (name: string): boolean => BRAND_LOGO_FILE_RE.test(name) || FONT_FILE_RE.test(name)

/** The kit's files that exist: a kit naming a missing file reads without it. */
function withExistingFiles(kit: BrandKit, dir: string): BrandKit {
  const exists = (name: string): boolean => {
    try {
      return fsSync.statSync(path.join(dir, name)).isFile()
    } catch {
      return false
    }
  }
  const out: BrandKit = { ...kit, fonts: kit.fonts.filter((f) => exists(f.file)) }
  if (out.logo && !exists(out.logo.file)) delete out.logo
  if (out.headingFont && !out.fonts.some((f) => f.id === out.headingFont)) delete out.headingFont
  if (out.bodyFont && !out.fonts.some((f) => f.id === out.bodyFont)) delete out.bodyFont
  return out
}

/** The saved kit (sanitised, naming only files that exist), or an empty one. Never throws. */
export function loadBrandKitSync(file = brandKitFile()): BrandKit {
  let raw: unknown = null
  try {
    raw = JSON.parse(fsSync.readFileSync(file, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring an unreadable brand kit:', err)
  }
  return withExistingFiles(sanitizeBrandKit(raw), brandKitDir(file))
}

export const loadBrandKit = async (file = brandKitFile()): Promise<BrandKit> => loadBrandKitSync(file)

/**
 * Saves `raw` (sanitised; files that do not exist are left out) and returns what was stored.
 * Files of the folder the kit no longer names are removed afterwards.
 */
export async function saveBrandKit(raw: unknown, file = brandKitFile()): Promise<BrandKit> {
  const dir = brandKitDir(file)
  const kit = withExistingFiles(sanitizeBrandKit(raw), dir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  writeFileAtomicSync(file, JSON.stringify({ version: FILE_VERSION, ...kit }, null, 2))
  const keep = new Set([kit.logo?.file, ...kit.fonts.map((f) => f.file)])
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (isBrandFile(name) && !keep.has(name)) await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)
  }
  return kit
}

/** The bytes of a file of the kit's folder (the Settings previews), or null when it is not one. */
export async function readBrandFile(name: unknown, file = brandKitFile()): Promise<Uint8Array | null> {
  if (typeof name !== 'string' || !isBrandFile(name)) return null
  try {
    return new Uint8Array(await fs.readFile(path.join(brandKitDir(file), name)))
  } catch {
    return null
  }
}

/** The next free font-<n> name in `existing`. */
const nextFont = (existing: readonly string[], ext: string): string => nextPickFile(FONT_PICKS, existing, ext)

/**
 * A new recording's project with the brand kit applied, when the kit's "Apply to new recordings"
 * is on (synchronous: called from applyStyleDefaults). The kit's files are copied into the
 * project folder first; anything that fails is logged and the project returned as it was.
 */
export function applyBrandKitToNew(project: Project, file = brandKitFile()): Project {
  try {
    const kit = loadBrandKitSync(file)
    if (!kit.autoApply || brandKitIsEmpty(kit)) return project
    const from = brandKitDir(file)
    const to = projectDir(project.id)
    fsSync.mkdirSync(to, { recursive: true })
    const files: BrandFiles = { fonts: {} }
    const copy = (name: string, next: (existing: string[]) => string): string | undefined => {
      try {
        const target = next(fsSync.readdirSync(to))
        fsSync.copyFileSync(path.join(from, name), path.join(to, target))
        return target
      } catch (err) {
        console.warn(`The brand kit file ${name} could not be copied into the new recording:`, err)
        return undefined
      }
    }
    const ext = (name: string): string => path.extname(name).slice(1).toLowerCase()
    if (kit.logo) files.logo = copy(kit.logo.file, (existing) => nextWatermarkFile(existing, ext(kit.logo!.file)))
    for (const f of kit.fonts) {
      const copied = copy(f.file, (existing) => nextFont(existing, ext(f.file)))
      if (copied) files.fonts[f.id] = copied
    }
    return applyBrandKit(project, kit, files)
  } catch (err) {
    console.warn('The brand kit could not be applied to the new recording:', err)
    return project
  }
}
