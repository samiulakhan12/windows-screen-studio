/**
 * Flown's own updates (NW-15, docs/design/auto-update.md §1.5, §2): the state, the schedule (30 s
 * after start, then every 4 h, while "Update Flown automatically" is on), the automatic download,
 * and Restart now, refused while a job runs. The updater itself sits behind a port, so the tests
 * drive this with a fake.
 */
import { CHECK_EVERY_MS, FIRST_CHECK_MS, UPDATE_COPY, disabledState, reduceUpdate, type UpdateState, type UpdaterEvent } from '../../shared/updates/updates'
import type { UpdateInstallResult } from '../../shared/api/updates'
import type { UpdatePrefs } from './updatePrefs'
import type { UpdaterPort } from './updaterPort'

/** A check with no answer after this long counts as failed (the next one is still scheduled). */
export const CHECK_TIMEOUT_MS = 2 * 60 * 1000

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // A pending check never keeps Flown running.
    t.unref?.()
    return t
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export interface UpdateServiceDeps {
  /** null: this build cannot update itself (development without the fake, other systems). */
  port: UpdaterPort | null
  current: string
  prefs: { get(): UpdatePrefs; set(patch: Partial<UpdatePrefs>): UpdatePrefs }
  /** Why Restart now cannot run now (a recording or a job), or null. */
  busy: () => string | null
  onChange: (state: UpdateState) => void
  /** After every check that ended (the model list refresh rides along). */
  afterCheck?: () => void
  now?: () => Date
  timers?: Timers
  firstCheckMs?: number
}

export class UpdateService {
  private state: UpdateState
  private timer: unknown = null
  private watchdog: unknown = null
  private checking = false
  private readonly off: (() => void) | null = null
  private readonly timers: Timers
  private readonly now: () => Date

  constructor(private readonly deps: UpdateServiceDeps) {
    this.timers = deps.timers ?? realTimers
    this.now = deps.now ?? (() => new Date())
    const prefs = deps.prefs.get()
    this.state = deps.port ? { phase: 'idle', current: deps.current, lastCheck: prefs.lastCheck, auto: prefs.auto } : disabledState(deps.current)
    if (deps.port) this.off = deps.port.on((e) => this.onEvent(e))
  }

  get(): UpdateState {
    return { ...this.state }
  }

  /** Schedules the first automatic check (when automatic updates are on). */
  start(): void {
    this.schedule(this.deps.firstCheckMs ?? FIRST_CHECK_MS)
  }

  /** Looks for a newer release now (also when automatic updates are off). */
  async check(): Promise<UpdateState> {
    const port = this.deps.port
    if (!port || this.checking || this.state.phase === 'downloading') return this.get()
    this.checking = true
    this.watchdog = this.timers.set(() => {
      this.watchdog = null
      if (this.checking) this.onEvent({ type: 'error', stage: 'check', message: 'no answer' })
    }, CHECK_TIMEOUT_MS)
    await port.check()
    return this.get()
  }

  /** Downloads the release found (or tries a failed download again). */
  async download(): Promise<UpdateState> {
    const port = this.deps.port
    const retry = this.state.phase === 'error' && !!this.state.version
    if (!port || (this.state.phase !== 'available' && !retry)) return this.get()
    this.state = { ...this.state, phase: 'downloading', percent: 0, error: undefined }
    this.deps.onChange(this.get())
    await port.download()
    return this.get()
  }

  /** Restart now: quits and installs the downloaded release, unless something is running. */
  install(): UpdateInstallResult {
    if (!this.deps.port || this.state.phase !== 'ready') return { ok: false, reason: UPDATE_COPY.notReady }
    const busy = this.deps.busy()
    if (busy) return { ok: false, reason: busy }
    this.deps.port.install()
    return { ok: true }
  }

  /** "Update Flown automatically": on schedules a check (and downloads a release already found). */
  setAuto(on: boolean): UpdateState {
    if (!this.deps.port || on === this.state.auto) return this.get()
    this.deps.prefs.set({ auto: on })
    this.state = { ...this.state, auto: on }
    if (on) {
      this.schedule(this.deps.firstCheckMs ?? FIRST_CHECK_MS)
      if (this.state.phase === 'available') void this.download()
    } else this.clearTimer()
    this.deps.onChange(this.get())
    return this.get()
  }

  dispose(): void {
    this.clearTimer()
    if (this.watchdog !== null) this.timers.clear(this.watchdog)
    this.watchdog = null
    this.off?.()
  }

  private schedule(ms: number): void {
    this.clearTimer()
    if (!this.deps.port || !this.state.auto) return
    this.timer = this.timers.set(() => {
      this.timer = null
      void this.check().then(() => {
        // Skipped (a download runs): look again a period later.
        if (!this.checking && this.timer === null) this.schedule(CHECK_EVERY_MS)
      })
    }, ms)
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private onEvent(e: UpdaterEvent): void {
    const was = this.state
    this.state = reduceUpdate(this.state, e, this.now().toISOString())
    const ended = e.type === 'available' || e.type === 'none' || (e.type === 'error' && e.stage === 'check')
    if (ended && this.checking) {
      this.checking = false
      if (this.watchdog !== null) this.timers.clear(this.watchdog)
      this.watchdog = null
      if (this.state.lastCheck !== was.lastCheck) this.deps.prefs.set({ lastCheck: this.state.lastCheck })
      this.schedule(CHECK_EVERY_MS)
      this.deps.afterCheck?.()
    }
    // A release pulled after it was downloaded must not install at quit (§1.4); a new download re-arms.
    if (e.type === 'none' && was.phase === 'ready') this.deps.port?.setInstallOnQuit(false)
    if (e.type === 'downloaded' && this.state.phase === 'ready') this.deps.port?.setInstallOnQuit(true)
    this.deps.onChange(this.get())
    if (e.type === 'available' && this.state.phase === 'available' && this.state.auto) void this.download()
  }
}
