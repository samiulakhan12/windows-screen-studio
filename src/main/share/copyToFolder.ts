/**
 * Copies an exported file into a share folder's Flown subfolder (F-22, docs/design/share.md
 * §2.3): a hidden partial file renamed into place when complete, never replacing a file (" (2)"),
 * never leaving the folder through a link named Flown, with progress, Cancel and a free-space check.
 * The caller makes sure `file` was exported in this session and `root` is a folder found or picked.
 */
import { createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { normalizeFolderPath, SHARE_SUBFOLDER } from '../../shared/share/cloudFolders'
import { removeWithRetries } from '../exportCleanup'
import { batchFileOk, freeBatchPath, moveIntoPlace, partialPath } from '../exportJob'

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

export const CANCELLED = 'The share was cancelled.'

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
  const realRoot = await fs.realpath(root)
  const realSub = await fs.realpath(sub)
  if (!sameDir(realSub, path.join(realRoot, SHARE_SUBFOLDER))) throw new Error(`The ${SHARE_SUBFOLDER} folder in ${label} leads somewhere else, so nothing was copied.`)
  if (!(await fs.stat(realSub)).isDirectory()) throw new Error(`Could not make the ${SHARE_SUBFOLDER} folder in ${label}.`)

  const realFile = await fs.realpath(file)
  if (sameDir(path.dirname(realFile), realSub)) return { dest: realFile, bytes: st.size, already: true }

  const free = await (opts.freeBytes ?? realFree)(realSub)
  if (free !== null && free < st.size + SPARE_BYTES) throw new Error(`There is not enough space on the drive of ${label} (needs ${gb(st.size + SPARE_BYTES)}).`)

  signal.throwIfAborted()
  let dest = freeBatchPath(realSub, name, existsSync)
  const temp = partialPath(dest)
  const now = opts.now ?? Date.now
  let done = 0
  let last = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length
      const t = now()
      if (t - last >= PROGRESS_MS) {
        last = t
        opts.onProgress?.(st.size > 0 ? Math.min(1, done / st.size) : 1)
      }
      cb(null, chunk)
    }
  })
  try {
    opts.onProgress?.(0)
    await pipeline(createReadStream(file, { highWaterMark: 1024 * 1024 }), count, createWriteStream(temp, { flags: 'wx' }), { signal })
    // Taken meanwhile (another share, the user): pick the next free name, never replace.
    if (existsSync(dest)) dest = freeBatchPath(realSub, name, existsSync)
    await moveIntoPlace(temp, dest)
    opts.onProgress?.(1)
  } catch (e) {
    await removeWithRetries(temp)
    if (signal.aborted) throw new Error(CANCELLED)
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new Error(`The drive of ${label} is full.`)
    throw new Error(`Could not copy to ${label}: ${(e as Error).message.split('\n')[0].replace(/'[^']*'/g, '').trim()}`)
  }
  return { dest, bytes: st.size, already: false }
}
