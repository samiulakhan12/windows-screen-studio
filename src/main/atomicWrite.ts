import fs from 'node:fs'

/** Error codes Windows returns while antivirus, indexers or OneDrive briefly hold a file open. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface AtomicWriteOptions {
  /** Rename attempts while the target is transiently locked. */
  attempts?: number
  delayMs?: number
  /** Injectable for tests. */
  fsImpl?: Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'rmSync'>
}

/**
 * Writes `data` to `file` through a temporary file and a rename, synchronously.
 *
 * Synchronous on purpose: project files are small, and doing the whole write in
 * one main-process turn means a later save (or a projects:list) can never
 * overtake or interleave with an earlier one, including the final save sent
 * with sendSync while the window is closing.
 *
 * A rename blocked by a short-lived lock is retried briefly (at most ~75 ms of
 * blocking). If the lock persists the error is thrown rather than overwriting
 * the file in place, which could leave a truncated project.json after a crash;
 * the editor shows the failure and keeps retrying.
 */
export function writeFileAtomicSync(file: string, data: string, options: AtomicWriteOptions = {}): void {
  const f = options.fsImpl ?? fs
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 25
  const tmp = `${file}.tmp`
  f.writeFileSync(tmp, data)
  for (let i = 1; ; i++) {
    try {
      f.renameSync(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!TRANSIENT.has(code) || i >= attempts) {
        f.rmSync(tmp, { force: true })
        throw err
      }
      sleepSync(delayMs * i)
    }
  }
}
