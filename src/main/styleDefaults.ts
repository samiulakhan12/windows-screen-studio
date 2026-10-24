/**
 * User's saved default look ("Save as default for new recordings" in the editor),
 * applied to every new recording. Stored as JSON in userData/style-defaults.json; a watermark
 * image is kept beside it (style-defaults-watermark.<ext>) and copied into each new recording.
 *
 * CONTRACT: the recording area calls `applyStyleDefaults(project, await loadStyleDefaults())`
 * when it creates a project (the project folder already exists then). The validation and merge
 * rules are in src/shared/editor/styleDefaults.ts.
 */
import { app } from 'electron'
import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyStyleDefaults as applyLook, sanitizeStyleDefaults, type StyleDefaults } from '../shared/editor/styleDefaults'
import { plainWatermarkFile, WATERMARK_FILE_RE, WATERMARK_MAX_BYTES } from '../shared/engine/watermark'
import type { Project } from '../shared/types'
import { writeFileAtomicSync } from './atomicWrite'
import { projectDir } from './projects'

export type { StyleDefaults } from '../shared/editor/styleDefaults'

const FILE_VERSION = 1
const WATERMARK_COPY_PREFIX = 'style-defaults-'

export function styleDefaultsFile(): string {
  return path.join(app.getPath('userData'), 'style-defaults.json')
}

/**
 * Where the saved look's copy of watermark image `name` lives, next to `file`. A look keeps
 * its logo as watermark.<ext> (a project's watermark-<n>.<ext> pick is stored under that name).
 */
const watermarkCopy = (file: string, name: string): string => path.join(path.dirname(file), `${WATERMARK_COPY_PREFIX}${plainWatermarkFile(name)}`)

/** Removes every saved watermark copy except `keep`. */
async function removeWatermarkCopies(file: string, keep?: string): Promise<void> {
  for (const ext of ['png', 'jpg', 'webp', 'svg']) {
    const name = `watermark.${ext}`
    if (name !== keep) await fs.rm(watermarkCopy(file, name), { force: true }).catch(() => undefined)
  }
}

/**
 * The saved look, or null when none is saved. Never throws: a missing, unreadable or
 * malformed file means "no defaults", so a new recording always gets created.
 */
export async function loadStyleDefaults(file?: string): Promise<StyleDefaults | null> {
  let text: string
  try {
    text = await fs.readFile(file ?? styleDefaultsFile(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not read the saved style defaults:', err)
    return null
  }
  try {
    const d = sanitizeStyleDefaults(JSON.parse(text))
    if (d) delete d.source
    return d
  } catch (err) {
    console.warn('Ignoring malformed style defaults file:', err)
    return null
  }
}

/** Copies the watermark image of project `source` beside the saved look; throws when it cannot. */
async function keepWatermarkImage(file: string, source: string | undefined, name: string): Promise<void> {
  if (!source || !WATERMARK_FILE_RE.test(name)) throw new Error('No watermark image to keep')
  const from = path.join(projectDir(source), name)
  const st = await fs.stat(from)
  if (!st.isFile() || st.size === 0 || st.size > WATERMARK_MAX_BYTES) throw new Error('The watermark image cannot be kept')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${watermarkCopy(file, name)}.tmp`
  await fs.copyFile(from, tmp)
  await fs.rename(tmp, watermarkCopy(file, name))
}

/**
 * Saves `defaults` (validated: out-of-range values are clamped; image backgrounds and the
 * cursor/camera visibility are left out) and returns what was stored. An image watermark is
 * copied from the project the look came from (`defaults.source`); when that fails the look is
 * saved without the watermark. `null` removes the saved defaults, so new recordings use the
 * built-in look again.
 */
export async function saveStyleDefaults(defaults: StyleDefaults | null, file = styleDefaultsFile()): Promise<StyleDefaults | null> {
  if (defaults === null) {
    await fs.rm(file, { force: true })
    await removeWatermarkCopies(file)
    return null
  }
  const clean = sanitizeStyleDefaults(defaults)
  if (!clean) throw new Error('These settings cannot be saved as defaults.')
  const { source, ...look } = clean
  const image = look.watermark?.kind === 'image' ? look.watermark.path : undefined
  if (image && look.watermark) {
    try {
      await keepWatermarkImage(file, source, image)
      look.watermark = { ...look.watermark, path: plainWatermarkFile(image) }
    } catch (err) {
      console.warn('Saving the default look without its watermark image:', err)
      delete look.watermark
    }
  }
  await removeWatermarkCopies(file, look.watermark?.kind === 'image' ? look.watermark.path : undefined)
  await fs.mkdir(path.dirname(file), { recursive: true })
  writeFileAtomicSync(file, JSON.stringify({ version: FILE_VERSION, ...look }, null, 2))
  return look
}

/**
 * Returns `project` with the saved look applied (see the shared applyStyleDefaults), and
 * copies the saved watermark image into the project's folder. A watermark whose image cannot
 * be copied is left out, so the new recording never points at a missing file.
 */
export function applyStyleDefaults(project: Project, defaults: StyleDefaults | null | undefined, file?: string): Project {
  const out = applyLook(project, defaults)
  const wm = out.watermark
  if (out === project || !wm || wm === project.watermark || wm.kind !== 'image' || !wm.path) return out
  try {
    const dir = projectDir(project.id)
    const name = plainWatermarkFile(wm.path)
    fsSync.mkdirSync(dir, { recursive: true })
    fsSync.copyFileSync(watermarkCopy(file ?? styleDefaultsFile(), name), path.join(dir, name))
    return name === wm.path ? out : { ...out, watermark: { ...wm, path: name } }
  } catch (err) {
    console.warn('The default watermark image could not be copied into the new recording:', err)
    const { watermark: _dropped, ...rest } = out
    void _dropped
    return project.watermark ? { ...rest, watermark: project.watermark } : rest
  }
}
