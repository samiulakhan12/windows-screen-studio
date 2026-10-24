/**
 * User's saved default look ("Save as default for new recordings" in the editor),
 * applied to every new recording. Stored as JSON in userData/style-defaults.json.
 *
 * CONTRACT: the recording area calls `applyStyleDefaults(project, await loadStyleDefaults())`
 * when it creates a project. The validation and merge rules are in src/shared/editor/styleDefaults.ts.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sanitizeStyleDefaults, type StyleDefaults } from '../shared/editor/styleDefaults'
import { writeFileAtomicSync } from './atomicWrite'

export { applyStyleDefaults, type StyleDefaults } from '../shared/editor/styleDefaults'

const FILE_VERSION = 1

export function styleDefaultsFile(): string {
  return path.join(app.getPath('userData'), 'style-defaults.json')
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
    return sanitizeStyleDefaults(JSON.parse(text))
  } catch (err) {
    console.warn('Ignoring malformed style defaults file:', err)
    return null
  }
}

/**
 * Saves `defaults` (validated: out-of-range values are clamped; image backgrounds and the
 * cursor/camera visibility are left out) and returns what was stored. `null` removes the
 * saved defaults, so new recordings use the built-in look again.
 */
export async function saveStyleDefaults(defaults: StyleDefaults | null, file = styleDefaultsFile()): Promise<StyleDefaults | null> {
  if (defaults === null) {
    await fs.rm(file, { force: true })
    return null
  }
  const clean = sanitizeStyleDefaults(defaults)
  if (!clean) throw new Error('These settings cannot be saved as defaults.')
  await fs.mkdir(path.dirname(file), { recursive: true })
  writeFileAtomicSync(file, JSON.stringify({ version: FILE_VERSION, ...clean }, null, 2))
  return clean
}
