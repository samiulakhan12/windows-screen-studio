import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomicSync } from './atomicWrite'

/**
 * Deleting an export's temporary files on Windows. A file ffmpeg has open cannot be
 * deleted there (it opens its output without FILE_SHARE_DELETE), and TerminateProcess
 * returns before the process has closed its handles, so the files are deleted only
 * after the encoder has exited, with retries for the moments an antivirus scanner or
 * the indexer holds them. Paths are logged while an export runs, and whatever a
 * crash or a failed delete leaves behind is removed at the next start.
 */

/** Error codes Windows returns while a file is still open somewhere. */
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface RemoveOptions {
  attempts?: number
  /** Wait before retry n is n x delayMs. */
  delayMs?: number
  /** Injectable for tests. */
  rm?: (file: string) => Promise<void>
}

/** Deletes `file`, retrying while it is locked. Resolves true once it is gone (or never existed). */
export async function removeWithRetries(file: string, options: RemoveOptions = {}): Promise<boolean> {
  const { attempts = 8, delayMs = 100, rm = (f: string) => fs.promises.rm(f, { force: true }) } = options
  for (let i = 1; ; i++) {
    try {
      await rm(file)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT') return true
      if (i >= attempts || !LOCKED.has(code)) return false
      await sleep(delayMs * i)
    }
  }
}

/** The same, blocking (only for quitting, when nothing asynchronous runs any more). */
export function removeSyncWithRetries(file: string, options: { attempts?: number; delayMs?: number; rmSync?: (file: string) => void } = {}): boolean {
  const { attempts = 6, delayMs = 50, rmSync = (f: string) => fs.rmSync(f, { force: true }) } = options
  for (let i = 1; ; i++) {
    try {
      rmSync(file)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT') return true
      if (i >= attempts || !LOCKED.has(code)) return false
      sleepSync(delayMs * i)
    }
  }
}

/** Resolves once every promise has settled, or after `ms`, whichever comes first. */
export function settledWithin(promises: (Promise<unknown> | null | undefined)[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((r) => (timer = setTimeout(r, ms)))
  return Promise.race([Promise.allSettled(promises.filter(Boolean)).then(() => undefined), timeout]).finally(() => clearTimeout(timer))
}

/** `.Name.partial-<pid>-<id>.mp4` next to the target (exportJob.partialPath). */
const PARTIAL = /^\..*\.partial-\d+-[0-9a-z]+(\.[A-Za-z0-9]+)?$/
/** `screen-studio-gif-<pid>-<id>.mkv|png` in the temp folder (exportJob.tempStem). */
const GIF_TEMP = /^screen-studio-gif-(\d+)-[0-9a-z]+\.(mkv|png)$/

/** Whether `file` is named like a temporary file of an export (nothing else is ever deleted by a sweep). */
export function isExportTempFile(file: string): boolean {
  const name = path.basename(file)
  return path.isAbsolute(file) && (PARTIAL.test(name) || GIF_TEMP.test(name))
}

export interface LogIo {
  read(file: string): string
  write(file: string, data: string): void
}

const defaultIo: LogIo = {
  read: (f) => fs.readFileSync(f, 'utf8'),
  write: (f, data) => writeFileAtomicSync(f, data)
}

/**
 * Temporary files of running exports, kept in a small JSON file so the next start
 * can delete what a crash, a forced quit or a lasting lock left behind.
 */
export class LeftoverLog {
  private readonly files = new Set<string>()

  constructor(
    private readonly logFile: string,
    private readonly io: LogIo = defaultIo
  ) {}

  add(files: string[]): void {
    for (const f of files) this.files.add(f)
    this.save()
  }

  remove(files: string[]): void {
    let changed = false
    for (const f of files) changed = this.files.delete(f) || changed
    if (changed) this.save()
  }

  /** At startup (no export has started yet): deletes the files an earlier run logged. Returns the ones deleted. */
  async sweep(remove: (file: string) => Promise<boolean> = (f) => removeWithRetries(f, { attempts: 3 })): Promise<string[]> {
    let listed: unknown = []
    try {
      listed = JSON.parse(this.io.read(this.logFile))
    } catch {
      return []
    }
    if (!Array.isArray(listed)) return []
    const deleted: string[] = []
    for (const f of listed) {
      if (typeof f !== 'string' || !isExportTempFile(f) || this.files.has(f)) continue
      if (await remove(f)) deleted.push(f)
      // Still locked: try again next time.
      else this.files.add(f)
    }
    this.save()
    return deleted
  }

  private save(): void {
    try {
      this.io.write(this.logFile, JSON.stringify([...this.files]))
    } catch (e) {
      // Only the next start's clean-up depends on it.
      console.warn('Could not update the export clean-up log:', e)
    }
  }
}

export interface TempSweepOptions {
  now?: number
  /** Only files untouched for this long are considered. */
  minAgeMs?: number
  isAlive?: (pid: number) => boolean
  remove?: (file: string) => Promise<boolean>
}

/** Whether a process with this id exists (EPERM: it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * At startup: GIF intermediates in the temp folder from runs that ended without
 * cleaning up (also from versions without the log). Another copy of the app may be
 * exporting right now, so only files of processes that no longer exist, untouched
 * for a while, are deleted.
 */
export async function sweepTempDir(dir: string, options: TempSweepOptions = {}): Promise<string[]> {
  const { now = Date.now(), minAgeMs = 10 * 60_000, isAlive = processAlive, remove = (f: string) => removeWithRetries(f, { attempts: 2 }) } = options
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const deleted: string[] = []
  for (const name of names) {
    const m = GIF_TEMP.exec(name)
    if (!m || Number(m[1]) === process.pid || isAlive(Number(m[1]))) continue
    const file = path.join(dir, name)
    try {
      if (now - (await fs.promises.stat(file)).mtimeMs < minAgeMs) continue
    } catch {
      continue
    }
    if (await remove(file)) deleted.push(file)
  }
  return deleted
}
