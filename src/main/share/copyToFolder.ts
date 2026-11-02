/**
 * Copies an exported file into a share folder's Flown subfolder (F-22, docs/design/share.md
 * §2.3): a hidden partial file renamed into place when complete, never replacing a file (" (2)"),
 * never leaving the folder through a link named Flown, with progress, Cancel and a free-space check.
 * The caller makes sure `file` was exported in this session and `root` is a folder found or picked.
 */
import { createReadStream, createWriteStream, existsSync, promises as fs, realpath as realpathWalk, rmSync } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { normalizeFolderPath, SHARE_SUBFOLDER } from '../../shared/share/cloudFolders'
import { removeWithRetries } from '../exportCleanup'
import { batchFileOk, freeBatchPath } from '../exportJob'

/** Room kept free on the target's drive beyond the file itself. */
export const SPARE_BYTES = 64 * 1024 * 1024
/** Progress is reported at most this often. */
export const PROGRESS_MS = 200

export interface CopyOptions {
  signal: AbortSignal
  onProgress?: (fraction: number) => void
  /** Free bytes on the drive of `dir` (fs.statfs), or null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>
  now?: () => number
}

export interface CopyResult {
  dest: string
  bytes: number
  /** The file was already in the folder (exported straight into it). */
  already: boolean
}

const realFree = async (dir: string): Promise<number | null> => {
  try {
    const s = await fs.statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

const sameDir = (a: string, b: string): boolean => normalizeFolderPath(a) === normalizeFolderPath(b)

const walk = promisify(realpathWalk)
/**
 * The real path. The system call fails on drives Windows' mount manager does not know (RAM disks,
 * WinFsp and other virtual drives answer EISDIR); Node's own walk, which still follows links and
 * junctions, is used then.
 */
const realPath = (p: string): Promise<string> => fs.realpath(p).catch(() => walk(p))

export const CANCELLED = 'The share was cancelled.'

let counter = 0
/**
 * The partial file's name: ".~Demo.partial-<id>.tmp". Cloud apps skip names of this shape (Dropbox
 * ignores ".~*" and "~*.tmp" files, as Office's temporary files), so they do not upload half a video.
 */
export function partialName(dest: string): string {
  const ext = path.extname(dest)
  return path.join(path.dirname(dest), `.~${path.basename(dest, ext)}.partial-${process.pid}-${Date.now().toString(36)}${(counter++).toString(36)}.tmp`)
}
const PARTIAL_RE = /^\.~.+\.partial-[0-9]+-[0-9a-z]+\.tmp$/
/** Partial files older than this in a Flown folder were left by a crash: removed on the next copy there. */
export const STALE_PARTIAL_MS = 60 * 60 * 1000

async function sweepStale(dir: string, now: number): Promise<void> {
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!PARTIAL_RE.test(name)) continue
    const full = path.join(dir, name)
    if (writing.has(full)) continue
    const st = await fs.stat(full).catch(() => null)
    if (st?.isFile() && now - st.mtimeMs > STALE_PARTIAL_MS) await removeWithRetries(full)
  }
}

/**
 * Puts `temp` in place as `name` (or "name (2)", …) in `dir` without ever replacing a file: a hard
 * link fails when the name is taken (then the next name is tried); where the link fails otherwise
 * (FAT and exFAT drives, some network shares and virtual drives) the name is checked and the file
 * renamed. Real failures (no access, a full drive) come out of the rename.
 */
export async function claimName(temp: string, dir: string, name: string, exists: (file: string) => boolean = existsSync, backoffMs = 150): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const dest = freeBatchPath(dir, name, exists)
    try {
      await fs.link(temp, dest)
    } catch (e) {
      // A drive without links answers in many ways on Windows (EISDIR on FAT and exFAT, UNKNOWN, EPERM…).
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      if (await renameIfFree(temp, dest, exists, backoffMs)) return dest
      continue
    }
    await removeWithRetries(temp)
    return dest
  }
  throw new Error('No free file name was found.')
}

/**
 * Renames `temp` to `dest` unless a file is there (false then). Tried again for a moment while an
 * antivirus scan, the indexer or the cloud app holds the fresh file, as the export's own rename is;
 * the name is checked before each try, since a rename on Windows replaces a file.
 */
async function renameIfFree(temp: string, dest: string, exists: (file: string) => boolean, backoffMs: number): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (exists(dest)) return false
    try {
      await fs.rename(temp, dest)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)))
    }
  }
}

/** Partial files being written now: deleted at once when the app quits, so a cloud app never keeps one. */
const writing = new Set<string>()
export function removePartialCopies(): void {
  for (const temp of writing) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Locked by the cloud app: left with its .partial name, never taken for a finished video.
    }
  }
  writing.clear()
}

/**
 * Bytes that copies running now still have to write, per drive (stat's `dev`): each free-space check
 * counts them, so copies started together cannot fill a drive between them.
 */
const pending = new Map<number, number>()
function reserve(drive: number, bytes: number): void {
  const left = (pending.get(drive) ?? 0) + bytes
  if (left > 0) pending.set(drive, left)
  else pending.delete(drive)
}

/** "1.2 GB" */
const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)

/** Copies `file` into `<root>/Flown`; throws a message to show (`CANCELLED` when stopped). */
export async function copyIntoFolder(file: string, root: string, label: string, opts: CopyOptions): Promise<CopyResult> {
  const { signal } = opts
  const name = path.basename(file)
  if (!path.isAbsolute(file) || !batchFileOk(name)) throw new Error('This file cannot be shared: its name is not one Flown exports.')
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile()) throw new Error('The exported file is not there any more.')
  const rootSt = await fs.stat(root).catch(() => null)
  if (!path.isAbsolute(root) || !rootSt?.isDirectory()) throw new Error(`The ${label} folder is not there any more.`)

  const sub = path.join(root, SHARE_SUBFOLDER)
  try {
    await fs.mkdir(sub, { recursive: true })
  } catch {
    throw new Error(`Could not make the ${SHARE_SUBFOLDER} folder in ${label}.`)
  }
  // A link or junction named Flown must not lead out of the folder.
  const reals = await Promise.all([realPath(root), realPath(sub)]).catch(() => null)
  if (!reals) throw new Error(`The ${label} folder could not be opened.`)
  const [realRoot, realSub] = reals
  if (!sameDir(realSub, path.join(realRoot, SHARE_SUBFOLDER))) throw new Error(`The ${SHARE_SUBFOLDER} folder in ${label} leads somewhere else, so nothing was copied.`)
  const subSt = await fs.stat(realSub).catch(() => null)
  if (!subSt?.isDirectory()) throw new Error(`Could not make the ${SHARE_SUBFOLDER} folder in ${label}.`)

  const realFile = await realPath(file).catch(() => null)
  if (!realFile) throw new Error('The exported file is not there any more.')
  if (sameDir(path.dirname(realFile), realSub)) return { dest: realFile, bytes: st.size, already: true }

  signal.throwIfAborted()
  await sweepStale(realSub, Date.now())
  const drive = subSt.dev
  const free = await (opts.freeBytes ?? realFree)(realSub)
  if (free !== null && free - (pending.get(drive) ?? 0) < st.size + SPARE_BYTES) throw new Error(`There is not enough space on the drive of ${label} (needs ${gb(st.size + SPARE_BYTES)}).`)
  // Counted before anything else is awaited, so a copy that checks meanwhile sees these bytes.
  let left = st.size
  reserve(drive, left)
  const temp = partialName(path.join(realSub, name))
  const now = opts.now ?? Date.now
  let dest = ''
  let done = 0
  let last = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length
      // Written bytes show in the drive's free space from now on.
      const n = Math.min(chunk.length, left)
      left -= n
      reserve(drive, -n)
      const t = now()
      if (t - last >= PROGRESS_MS) {
        last = t
        opts.onProgress?.(st.size > 0 ? Math.min(1, done / st.size) : 1)
      }
      cb(null, chunk)
    }
  })
  writing.add(temp)
  try {
    opts.onProgress?.(0)
    await pipeline(createReadStream(file, { highWaterMark: 1024 * 1024 }), count, createWriteStream(temp, { flags: 'wx' }), { signal })
    dest = await claimName(temp, realSub, name)
    opts.onProgress?.(1)
    writing.delete(temp)
  } catch (e) {
    // A partial file the cloud app holds open stays listed, so quitting tries again.
    if (await removeWithRetries(temp)) writing.delete(temp)
    if (signal.aborted) throw new Error(CANCELLED)
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOSPC') throw new Error(`The drive of ${label} is full.`)
    // The done view and the notification name the destination themselves ("Could not copy to OneDrive: …").
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new Error('the folder is read-only or a file there is in use.')
    throw new Error((e as Error).message.split('\n')[0].replace(/'[^']*'/g, '').trim() || 'something went wrong.')
  } finally {
    reserve(drive, -left)
  }
  return { dest, bytes: st.size, already: false }
}
