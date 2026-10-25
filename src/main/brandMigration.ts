/**
 * Moves the data of the app's previous name ("Screen Studio for Windows") to Flown's folders on
 * the first start as Flown. Electron-free (paths in, plain fs), so it is unit-tested with temp
 * folders (tests/brandMigration.test.ts); index.ts runs it.
 *
 * Every step is one rename on the same volume, which is atomic: a crash leaves each folder
 * either moved or not, and the next start finishes the job. Nothing is ever deleted except an
 * empty folder, or the new userData folder while it holds only what Chromium creates on its own
 * at start (no settings yet). When a move fails (a file held open by the old app, antivirus),
 * the old folder stays in use: userData through app.setPath, recordings as a second library root.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * What Chromium/Electron put in userData by themselves before the app wrote anything: Electron
 * creates the folder empty before the main script runs, then the single-instance lock, crash
 * reports and GPU caches. A new userData folder holding only these has no settings to keep.
 */
const BOOTSTRAP_ENTRIES: ReadonlySet<string> = new Set([
  'Crashpad',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
  'GPUPersistentCache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache'
])

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** True when `dir` does not exist or holds only Chromium's bootstrap files. */
export function isFreshUserData(dir: string): boolean {
  if (!isDir(dir)) return !fs.existsSync(dir)
  try {
    return fs.readdirSync(dir).every((name) => BOOTSTRAP_ENTRIES.has(name))
  } catch {
    return false
  }
}

export type UserDataPlan =
  /** No old folder: nothing to do. */
  | 'none'
  /** Move the old folder to the new path (removing the fresh new one first, if any). */
  | 'move'
  /** Both hold data: the new one is Flown's own; the old one stays on disk untouched. */
  | 'keep-new'

export function planUserData(oldDir: string, newDir: string): UserDataPlan {
  if (path.resolve(oldDir) === path.resolve(newDir) || !isDir(oldDir)) return 'none'
  return isFreshUserData(newDir) ? 'move' : 'keep-new'
}

export interface UserDataResult {
  plan: UserDataPlan
  /** The folder the app must use as userData now. */
  dir: string
  /** Why the move failed (the old folder is used in place then). */
  error?: string
}

/**
 * Renames the old userData folder to the new one. The whole folder moves, so Chromium's
 * "Local State" (holding the safeStorage key that encrypts saved AI keys) moves with the files
 * it decrypts. Run before anything reads userData and before the single-instance lock.
 */
export function migrateUserData(oldDir: string, newDir: string): UserDataResult {
  const plan = planUserData(oldDir, newDir)
  if (plan !== 'move') return { plan, dir: newDir }
  try {
    // Windows refuses to rename onto an existing folder, even an empty one.
    if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true, maxRetries: 2 })
    fs.mkdirSync(path.dirname(newDir), { recursive: true })
    fs.renameSync(oldDir, newDir)
    return { plan, dir: newDir }
  } catch (err) {
    // Keep using the old folder (all settings intact); the next start tries again.
    return { plan, dir: isDir(newDir) && !isDir(oldDir) ? newDir : oldDir, error: (err as Error).message }
  }
}

export interface RecordingsResult {
  /** Folders the library must also list, besides the new root (the old one when it could not be emptied). */
  legacyRoots: string[]
  /** Entries moved into the new root (the whole folder counts as one). */
  moved: number
  /** Entries renamed on the way because the new root already had that name: old name -> new name. */
  renamed: Record<string, string>
  errors: string[]
}

/** First `name`, `name-2`, `name-3`… not taken in `dir`. */
function freeName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
}

/**
 * Moves Videos\Screen Studio for Windows to Videos\Flown: in one rename when Flown has no folder
 * yet, else entry by entry (a name Flown already uses gets a -2 suffix, as a new recording would).
 * Whatever cannot be moved stays where it was and its folder is returned as a legacy root, so no
 * recording ever disappears from the library. Idempotent: run it on every start.
 */
export function migrateRecordings(oldRoot: string, newRoot: string): RecordingsResult {
  const result: RecordingsResult = { legacyRoots: [], moved: 0, renamed: {}, errors: [] }
  if (path.resolve(oldRoot) === path.resolve(newRoot) || !isDir(oldRoot)) return result
  if (!fs.existsSync(newRoot)) {
    try {
      fs.mkdirSync(path.dirname(newRoot), { recursive: true })
      fs.renameSync(oldRoot, newRoot)
      result.moved = 1
      return result
    } catch (err) {
      result.errors.push(`${oldRoot}: ${(err as Error).message}`)
      // Fall through: merge what can be merged, keep the rest listed.
    }
  }
  let names: string[] = []
  try {
    names = fs.readdirSync(oldRoot)
  } catch (err) {
    result.errors.push(`${oldRoot}: ${(err as Error).message}`)
  }
  if (isDir(newRoot)) {
    for (const name of names) {
      const target = freeName(newRoot, name)
      try {
        fs.renameSync(path.join(oldRoot, name), path.join(newRoot, target))
        result.moved++
        if (target !== name) result.renamed[name] = target
      } catch (err) {
        result.errors.push(`${name}: ${(err as Error).message}`)
      }
    }
  }
  try {
    fs.rmdirSync(oldRoot) // only when empty
  } catch {
    if (isDir(oldRoot)) result.legacyRoots.push(oldRoot)
  }
  return result
}
