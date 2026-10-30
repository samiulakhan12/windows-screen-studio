/**
 * Duplicate, Make a vertical version and Make a square version in the main process (X-04,
 * docs/design/vertical-video.md §4.7): a new project folder with the renderer's copy of the
 * project, written last, and the source's recording files, hard-linked where that is safe and
 * copied otherwise. The source folder is never written. A `.copying` marker keeps a half-made
 * copy out of the library until it is finished or cleaned up.
 *
 * CONTRACT: media files may be hard-linked between projects; code outside src/main/recording/
 * must never open LINKED_MEDIA for writing: write a temporary file and rename it.
 */
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import type { DuplicateProgress, DuplicateResult } from '../shared/api/projects'
import { APP_NAME } from '../shared/brand'
import { migrateProject } from '../shared/engine/project'
import { writeFileAtomicSync } from './atomicWrite'
import { MEDIA_FILE_RE } from './mediaProtocol'
import * as projects from './projects'

/** The recording's media, never rewritten once the project exists: linked when allowed. */
export const LINKED_MEDIA = ['screen.mp4', 'webcam.mp4', 'mic.m4a', 'system.m4a'] as const
/**
 * Folders a copy never takes (docs/design/versions.md §2.6): `versions` holds the source's own
 * history, and a copy starts its own (a vertical version's earlier versions would undo its framing).
 */
export const NOT_COPIED_DIRS: readonly string[] = ['versions']
/** Written first into a copy being made, removed when it is finished. */
export const COPYING_MARK = '.copying'

/** The speech detector's results (speech/vad.ts SPEECH_CACHE_FILE), keyed by the media's size and time: saves running it again. */
const SPEECH_CACHE = '.cache/speech.json'
/** Small files kept with a recording besides its assets: the cursor track, the speaker notes, the speech cache. */
const COPIED = new Set(['cursor.json', projects.SCRIPT_FILE, SPEECH_CACHE])
/** Room left on the drive besides the copied bytes. */
const SPARE_BYTES = 64 * 1024 * 1024
/** A copy whose marker is older than this was left by a crash. */
const STALE_MS = 60 * 60 * 1000
/** Largest project.json written (the renderer's copy). */
const PROJECT_MAX = 64 * 1024 * 1024
/** Progress events at most this often. */
const PROGRESS_MS = 100
/** Files larger than this are copied piece by piece, so Cancel stops them midway. */
const PIECE_BYTES = 4 * 1024 * 1024
/** Longest name of a copy (shared/editor/duplicate.ts copyName makes one this long at most). */
const NAME_MAX = 120

/** How a file of the source folder goes into the copy: linked (LINKED_MEDIA), copied, or left out (null). */
export function copiedFile(name: string): 'link' | 'copy' | null {
  if ((LINKED_MEDIA as readonly string[]).includes(name)) return 'link'
  // Backgrounds, cursor images, logos, music, image overlays and fonts: small, and some keep their name when replaced.
  if (COPIED.has(name) || MEDIA_FILE_RE.test(name)) return 'copy'
  return null
}

/** Whether `child` is `parent` or inside it (resolved; without regard to case on Windows). */
function within(child: string, parent: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  const rel = path.relative(norm(parent), norm(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Whether media may be hard-linked under the projects root `root`: not inside a OneDrive folder (env OneDrive, OneDriveConsumer, OneDriveCommercial). */
export function linkAllowed(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // The sync client and Files On-Demand placeholders do not handle files that share their data reliably.
  const synced = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  return !synced.some((dir) => within(root, dir))
}

/** Why a copy failed, as the editor shows it after "Could not make the copy: " (§2.3). */
const REASONS = {
  busy: 'a copy is already being made.',
  read: "some of the recording's files could not be read.",
  folder: `${APP_NAME} could not create a folder in Videos\\${APP_NAME}.`
}
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`
const spaceReason = (needs: number, free: number): string => `there is not enough free space on this drive (it needs ${gb(needs)}, ${gb(free)} is free).`

/** A failure whose message is already the reason to show. */
class CopyError extends Error {}

function abortError(): Error {
  const err = new Error('The copy was cancelled.')
  err.name = 'AbortError'
  return err
}

/** One file of the source folder that goes into the copy. */
interface Planned {
  /** Path in both folders ('.cache/speech.json' for the speech cache). */
  name: string
  how: 'link' | 'copy'
  stat: Stats
}

/** The files to link or copy: regular files with allow-listed names only (no symlinks, no other folders, no unknown names). */
async function planFiles(src: string): Promise<Planned[]> {
  const out: Planned[] = []
  const add = async (name: string): Promise<void> => {
    const how = copiedFile(name)
    if (!how) return
    const stat = await fs.lstat(path.join(src, name))
    if (stat.isFile()) out.push({ name, how, stat })
  }
  for (const entry of await fs.readdir(src)) {
    if (NOT_COPIED_DIRS.includes(entry)) continue
    if (entry !== '.cache') await add(entry)
    else if ((await fs.lstat(path.join(src, entry))).isDirectory()) {
      await add(SPEECH_CACHE).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
    }
  }
  return out
}

/** Whether any of `names` exists in `dir`. */
async function holdsAny(dir: string, names: readonly string[]): Promise<boolean> {
  for (const n of names) {
    if (await fs.lstat(path.join(dir, n)).then(() => true, () => false)) return true
  }
  return false
}

/** A copy is being made: a second one is refused meanwhile. */
let running = false

/**
 * Makes the copy: a new folder holding `raw` (the renderer's projectCopy, still carrying
 * `sourceId`, checked with migrateProject) and the source's files. Rejects with a readable
 * message (or an AbortError when `signal` aborts), leaving no folder behind.
 */
export async function duplicateProject(
  sourceId: string,
  raw: unknown,
  opts: { signal?: AbortSignal; onProgress?: (p: DuplicateProgress) => void; now?: Date } = {}
): Promise<DuplicateResult> {
  if (running) throw new Error(REASONS.busy)
  running = true
  try {
    return await makeCopy(sourceId, raw, opts)
  } finally {
    running = false
  }
}

async function makeCopy(sourceId: string, raw: unknown, opts: { signal?: AbortSignal; onProgress?: (p: DuplicateProgress) => void; now?: Date }): Promise<DuplicateResult> {
  const { signal, onProgress } = opts
  const now = opts.now ?? new Date()
  if (typeof sourceId !== 'string') throw new Error('Invalid project id')
  // Throws for an id that could leave the projects root.
  const src = projects.projectDir(sourceId)
  const copy = migrateProject(raw)
  // The editor may only copy the project it has open.
  if (copy.id !== sourceId) throw new Error('Not allowed')
  if (JSON.stringify(copy).length > PROJECT_MAX) throw new Error('This project is too large to copy.')
  let sourceName: string
  let files: Planned[]
  try {
    sourceName = (await projects.readProject(sourceId)).name
    files = await planFiles(src)
  } catch {
    throw new Error(REASONS.read)
  }
  if (signal?.aborted) throw abortError()

  await removeStaleCopies(now.getTime()).catch((err: unknown) => console.warn('Could not remove copies left half made:', err))
  let made: { id: string; dir: string }
  try {
    made = await projects.createProjectDir(now)
  } catch {
    throw new Error(REASONS.folder)
  }
  const { id, dir } = made
  const bytesOf = (list: Planned[]): number => list.reduce((n, f) => n + f.stat.size, 0)
  try {
    await fs.writeFile(path.join(dir, COPYING_MARK), JSON.stringify({ source: sourceId, startedAt: now.toISOString() }))
    const linked = await linkMedia(src, dir, files)
    const toCopy = files.filter((f) => !linked.has(f.name))
    // Links count as done at once.
    const total = bytesOf(files)
    let done = total - bytesOf(toCopy)
    let sent = 0
    const report = (force = false): void => {
      const at = Date.now()
      if (!onProgress || (!force && at - sent < PROGRESS_MS)) return
      sent = at
      onProgress({ done: Math.min(done, total), total })
    }
    report(true)
    await checkSpace(dir, bytesOf(toCopy))
    for (const f of toCopy) {
      if (signal?.aborted) throw abortError()
      const before = done
      await copyOne(src, dir, f, signal, (bytes) => {
        done = before + Math.min(bytes, f.stat.size)
        report()
      })
      done = before + f.stat.size
      report()
    }
    if (signal?.aborted) throw abortError()
    report(true)

    // Last: until project.json exists the folder is not a project, so a crash leaves nothing in the library.
    const name = (typeof copy.name === 'string' ? copy.name.trim().slice(0, NAME_MAX) : '') || 'Untitled recording'
    const project = { ...copy, id, createdAt: now.toISOString(), name, copyOf: { id: sourceId, name: sourceName } }
    writeFileAtomicSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
    await fs.rm(path.join(dir, COPYING_MARK), { force: true, maxRetries: 3 })
    return { id, name, linked: files.every((f) => f.how !== 'link' || linked.has(f.name)) }
  } catch (err) {
    await removeCopyDir(dir).catch((e: unknown) => console.warn('Could not remove the unfinished copy:', e))
    if (err instanceof CopyError || (err as Error).name === 'AbortError') throw err
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOSPC') throw new Error(spaceReason(bytesOf(files) + SPARE_BYTES, await freeBytes(path.dirname(dir)).catch(() => 0)))
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EIO' || code === 'EBUSY') throw new Error(REASONS.read)
    throw err
  }
}

/**
 * Removes a half-made copy, its marker last: a file another program holds (an antivirus scan,
 * the indexer, OneDrive) makes fs.rm fail after removing what it could, and a folder without its
 * marker would never be cleaned up. With the marker kept, the next copy or the next start does.
 * Every other entry is still tried, so only the held file stays on disk meanwhile.
 */
async function removeCopyDir(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const failed: unknown[] = []
  for (const name of names) {
    if (name !== COPYING_MARK) await fs.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) => failed.push(err))
  }
  if (failed.length > 0) throw failed[0]
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
}

/** Hard-links the media (LINKED_MEDIA) where that is safe; the names linked. Any that cannot be linked are copied. */
async function linkMedia(src: string, dir: string, files: Planned[]): Promise<Set<string>> {
  const linked = new Set<string>()
  if (!linkAllowed(projects.projectsRoot()) || !linkAllowed(src)) return linked
  for (const f of files) {
    if (f.how !== 'link') continue
    try {
      await fs.link(path.join(src, f.name), path.join(dir, f.name))
      linked.add(f.name)
    } catch {
      // EXDEV (a legacy root on another drive), EPERM, ENOTSUP, FAT drives, placeholders: copied instead.
    }
  }
  return linked
}

async function freeBytes(dir: string): Promise<number> {
  const st = await fs.statfs(dir)
  return st.bavail * st.bsize
}

/** Rejects, before the first byte is copied, when the drive cannot take `bytes` and some room to spare. */
async function checkSpace(dir: string, bytes: number): Promise<void> {
  if (bytes === 0) return
  const free = await freeBytes(dir)
  if (free < bytes + SPARE_BYTES) throw new CopyError(spaceReason(bytes + SPARE_BYTES, free))
}

/**
 * Copies one file and keeps its times so the speech cache still matches. A small file in one go,
 * copy-on-write where the file system offers it (COPYFILE_FICLONE falls back to a plain copy); a
 * larger one piece by piece, because one copyFile cannot be stopped and a medium that could not be
 * linked can take minutes. `progress` gets the bytes written so far.
 */
async function copyOne(src: string, dir: string, f: Planned, signal: AbortSignal | undefined, progress: (bytes: number) => void): Promise<void> {
  const from = path.join(src, f.name)
  const to = path.join(dir, f.name)
  await fs.mkdir(path.dirname(to), { recursive: true })
  if (f.stat.size <= PIECE_BYTES) await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE)
  else await copyInPieces(from, to, signal, progress)
  await fs.utimes(to, f.stat.atimeMs / 1000, f.stat.mtimeMs / 1000)
}

/** Copies `from` into the new file `to`, stopping before the next piece once `signal` aborts; both files are closed before it settles, so the folder can be removed. */
async function copyInPieces(from: string, to: string, signal: AbortSignal | undefined, progress: (bytes: number) => void): Promise<void> {
  const input = await fs.open(from, 'r')
  try {
    // 'wx': a new file only, as COPYFILE_EXCL.
    const output = await fs.open(to, 'wx')
    try {
      const piece = Buffer.allocUnsafe(PIECE_BYTES)
      for (let at = 0; ; ) {
        if (signal?.aborted) throw abortError()
        const { bytesRead } = await input.read(piece, 0, PIECE_BYTES, at)
        if (bytesRead === 0) return
        for (let put = 0; put < bytesRead; ) put += (await output.write(piece, put, bytesRead - put, at + put)).bytesWritten
        at += bytesRead
        progress(at)
      }
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}

/**
 * Removes every copy left half made, however recent (at start-up); how many. One instance runs at
 * a time and no copy has started yet, so a marked folder is one that quitting, closing the window
 * or a crash cut short. A folder that became a project, or holds a recording, is kept.
 */
export function removeAbandonedCopies(): Promise<number> {
  return removeStaleCopies(Number.POSITIVE_INFINITY)
}

/**
 * Removes copies a crash left half made (marked, more than an hour old, without project.json or raw files); how many.
 * Only in the current projects root. The marker's start time decides, or the folder's time when the marker cannot be read.
 */
export async function removeStaleCopies(now: number = Date.now()): Promise<number> {
  const root = projects.projectsRoot()
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue
    const dir = path.join(root, name)
    try {
      const st = await fs.lstat(dir)
      if (!st.isDirectory()) continue
      const mark = await fs.lstat(path.join(dir, COPYING_MARK)).catch(() => null)
      if (!mark?.isFile()) continue
      let started = Number.NaN
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, COPYING_MARK), 'utf8')) as { startedAt?: unknown }
        if (typeof raw?.startedAt === 'string') started = Date.parse(raw.startedAt)
      } catch {
        // Unreadable: the folder's own time decides.
      }
      if (!Number.isFinite(started)) started = st.mtimeMs
      if (now - started <= STALE_MS) continue
      // A folder that became a project, or holds a recording, is never removed.
      if (await holdsAny(dir, ['project.json', ...Object.values(projects.RAW)])) continue
      await removeCopyDir(dir)
      removed++
    } catch (err) {
      console.warn(`Could not remove the half-made copy ${name}:`, err)
    }
  }
  return removed
}
