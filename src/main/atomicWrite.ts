import fs from 'node:fs'

/** Error codes Windows returns while antivirus, indexers or OneDrive briefly hold a file open. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface AtomicWriteOptions {
  /** Rename attempts before falling back to an in-place copy. */
  attempts?: number
  delayMs?: number
  /** Injectable for tests. */
  fsImpl?: Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'copyFileSync' | 'rmSync'>
}

/**
 * Writes `data` to `file` through a temporary file and a rename, synchronously.
 *
 * Synchronous on purpose: project files are small, and doing the whole write in
 * one main-process turn means a later save (or a projects:list) can never
 * overtake or interleave with an earlier one, including the final save sent
 * with sendSync while the window is closing.
 */
export function writeFileAtomicSync(file: string, data: string, options: AtomicWriteOptions = {}): void {
  const f = options.fsImpl ?? fs
  const attempts = options.attempts ?? 5
  const delayMs = options.delayMs ?? 40
  const tmp = `${file}.tmp`
  f.writeFileSync(tmp, data)
  for (let i = 1; ; i++) {
    try {
      f.renameSync(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!TRANSIENT.has(code)) {
        f.rmSync(tmp, { force: true })
        throw err
      }
      if (i >= attempts) break
      sleepSync(delayMs * i)
    }
  }
  // The target stays locked against replacement; overwriting its contents in place usually still works.
  try {
    f.copyFileSync(tmp, file)
  } finally {
    f.rmSync(tmp, { force: true })
  }
}
