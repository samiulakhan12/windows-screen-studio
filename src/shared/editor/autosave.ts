export type SaveStatus =
  | { state: 'saved' }
  | { state: 'pending' }
  | { state: 'saving' }
  | { state: 'error'; message: string; retryInMs: number }

/** Identifies a save so the writer can drop one that arrives after a newer save of the same session. */
export interface SaveMeta {
  session: string
  seq: number
}

export type SyncSaveResult = { ok: true } | { ok: false; error: string }

export interface AutosaveTarget<T> {
  readonly state: T
  readonly revision: number
  subscribe(listener: () => void): () => void
}

export interface AutosaveDeps<T> {
  save(doc: T, meta: SaveMeta): Promise<void>
  saveSync(doc: T, meta: SaveMeta): SyncSaveResult
}

export interface AutosaveOptions {
  /** Quiet time after the last edit before saving. */
  debounceMs?: number
  /** Upper bound on how long continuous editing can postpone a save. */
  maxWaitMs?: number
  /** Retry delays after failures grow from 1 s up to this. */
  maxRetryMs?: number
}

const FRIENDLY: [RegExp, string][] = [
  [/\bENOSPC\b/, 'The disk is full.'],
  [/\b(EPERM|EACCES|EBUSY)\b/, 'The project file is locked by another program or is read-only.'],
  [/\bEROFS\b/, 'The drive is read-only.']
]

/** User-facing reason for a failed save, keeping the system error code for support. */
export function saveErrorMessage(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err))
    // Electron prefixes errors thrown in the main process; the user only needs the cause.
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  for (const [re, text] of FRIENDLY) {
    const m = re.exec(raw)
    if (m) return `${text} (${m[1] ?? m[0]})`
  }
  return raw
}

/**
 * Debounced autosave with visible status, retry with backoff after failures, an
 * awaitable flush (leaving the editor) and a synchronous flush (window closing).
 */
export class Autosaver<T> {
  status: SaveStatus = { state: 'saved' }
  private savedRevision: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private dirtySince = 0
  private failures = 0
  private seq = 0
  private readonly session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  private readonly statusListeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly maxRetryMs: number

  constructor(
    private readonly target: AutosaveTarget<T>,
    private readonly deps: AutosaveDeps<T>,
    options: AutosaveOptions = {}
  ) {
    this.savedRevision = target.revision
    this.debounceMs = options.debounceMs ?? 400
    this.maxWaitMs = options.maxWaitMs ?? 2000
    this.maxRetryMs = options.maxRetryMs ?? 15000
    this.unsubscribe = target.subscribe(this.onChange)
  }

  get dirty(): boolean {
    return this.target.revision !== this.savedRevision
  }

  /** Marks the current state as not yet on disk (e.g. after an automatic correction on load). */
  markDirty(): void {
    this.savedRevision = -1
    this.onChange()
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Saves now and resolves true once everything edited so far is on disk. */
  async flush(): Promise<boolean> {
    this.clearTimer()
    if (this.inFlight) await this.inFlight
    if (this.dirty) await this.run()
    return !this.dirty
  }

  /** Blocking save for page unload, where async IPC may never complete. */
  flushSync(): boolean {
    this.clearTimer()
    if (!this.dirty) return true
    const revision = this.target.revision
    const result = this.deps.saveSync(this.target.state, this.nextMeta())
    if (result.ok) {
      this.savedRevision = Math.max(this.savedRevision, revision)
      this.failures = 0
      this.setStatus({ state: 'saved' })
      return true
    }
    this.setStatus({ state: 'error', message: saveErrorMessage(result.error), retryInMs: 0 })
    return false
  }

  /** Retries a failed save immediately (the "Retry" button). */
  retryNow(): void {
    this.clearTimer()
    void this.run()
  }

  dispose(): void {
    this.clearTimer()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.statusListeners.clear()
  }

  private onChange = (): void => {
    if (!this.dirty) return
    const now = Date.now()
    if (!this.timer) this.dirtySince = now
    if (this.status.state === 'saved') this.setStatus({ state: 'pending' })
    const wait = Math.min(this.debounceMs, Math.max(0, this.maxWaitMs - (now - this.dirtySince)))
    this.schedule(wait)
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, ms)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private run(): Promise<void> {
    if (this.inFlight) {
      // A save is already running; it reschedules itself if more edits arrived.
      return this.inFlight
    }
    if (!this.dirty) return Promise.resolve()
    const revision = this.target.revision
    if (this.status.state !== 'error') this.setStatus({ state: 'saving' })
    const done = this.deps
      .save(this.target.state, this.nextMeta())
      .then(
        () => {
          this.savedRevision = Math.max(this.savedRevision, revision)
          this.failures = 0
          this.setStatus(this.dirty ? { state: 'pending' } : { state: 'saved' })
          if (this.dirty && !this.timer) this.schedule(this.debounceMs)
        },
        (err: unknown) => {
          this.failures++
          const retryInMs = Math.min(this.maxRetryMs, 1000 * 2 ** (this.failures - 1))
          this.setStatus({ state: 'error', message: saveErrorMessage(err), retryInMs })
          this.schedule(retryInMs)
        }
      )
      .finally(() => {
        this.inFlight = null
      })
    this.inFlight = done
    return done
  }

  private nextMeta(): SaveMeta {
    return { session: this.session, seq: ++this.seq }
  }

  private setStatus(status: SaveStatus): void {
    this.status = status
    for (const l of [...this.statusListeners]) l()
  }
}
