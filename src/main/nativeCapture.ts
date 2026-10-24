/**
 * Client for the native Windows capture helper (native/: ssw-capture.exe — Windows.Graphics.Capture
 * with the cursor excluded, H.264 via Media Foundation, on the GPU when available).
 *
 * CONTRACT (implemented by the helper integration; consumed by recordingIpc.ts):
 * - isNativeCaptureAvailable() resolves false on non-Windows, when the helper exe is
 *   missing, or when WGC is unsupported. Callers must then fall back to Chromium capture.
 * - startNativeCapture() spawns the helper for one display; `started` resolves when the
 *   first frame has been captured (startedAt = epoch ms of that frame).
 * - pause()/resume() exclude paused time from the output timeline.
 * - stop() finalises the MP4 and resolves with cursor-shape changes seen while recording.
 * - onEnded() reports the helper ending on its own after it started (monitor unplugged,
 *   encoder/device failure, crash), so the app can stop the recording and say why.
 * - Quitting the app stops running helpers gracefully (bounded by nativeCaptureTimeouts.quit)
 *   before anything kills them, so the MP4 is finalised; see guardQuit().
 * - Single windows: startNativeCapture({ windowId }) records one window ("record --window",
 *   available when isNativeWindowCaptureAvailable()); its rectangle over time comes back in
 *   NativeStopInfo.windowRects. watchWindow() only follows a window's rectangle
 *   ("watch-window"), for windows that Chromium records.
 *
 * The helper writes a fragmented MP4, so even a helper that is killed or crashes leaves a
 * file that plays up to its last complete (~1 s) fragment.
 *
 * The helper is found at resources/native/ssw-capture.exe when packaged and at
 * native/bin/ssw-capture.exe in development (npm run build:native). SSW_CAPTURE_HELPER
 * overrides it with an executable, or a .js/.cjs script run by Electron as Node (tests).
 * Protocol: native/README.md.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, screen, type Display } from 'electron'
import type { CursorShape } from '../shared/types'

export interface NativeCaptureOptions {
  /** Electron display id (screen.getAllDisplays()[n].id) of the monitor to record. */
  displayId?: string
  /**
   * Electron desktopCapturer window source id ("window:<HWND>:<n>") of a single window to
   * record instead of a monitor. Exactly one of displayId / windowId must be set.
   * Window recordings report the window's position over time (NativeStopInfo.windowRects);
   * the output keeps the window's initial size and later sizes are fitted into it
   * (src/shared/recording/windowGeometry.ts fitContent — the helper uses the same rule).
   */
  windowId?: string
  /** Output .mp4 path. */
  output: string
  fps: 30 | 60
  /** Average bitrate in bits/s; by default the helper derives it from the size and frame rate. */
  bitrate?: number
}

export interface NativeStartInfo {
  /** Epoch ms of the first captured frame. */
  startedAt: number
  /** Physical pixel size of the encoded video. */
  width: number
  height: number
  fps?: number
  /** Encoder the helper uses, e.g. "NVIDIA H.264 Encoder MFT". */
  encoder?: string
  hardware?: boolean
  /** Fragmented MP4: readable up to the last ~1 s fragment even if the helper dies. */
  fragmented?: boolean
}

/** Screen rectangle of a captured/watched window at a moment (physical pixels, DWM visible bounds). */
export interface WindowRectEvent {
  /** Epoch ms. */
  at: number
  x: number
  y: number
  width: number
  height: number
  minimized?: boolean
}

export interface NativeStopInfo {
  frames: number
  /** Cursor shape changes as epoch ms (not yet pause-adjusted). */
  shapes: { at: number; shape: CursorShape }[]
  /** Window recordings only: the window's rectangle at start and after every change. */
  windowRects?: WindowRectEvent[]
  /** Frames skipped because the encoder fell behind. */
  dropped?: number
  /** Seconds of video written (paused time excluded). */
  duration?: number
}

export interface NativeCaptureSession {
  readonly started: Promise<NativeStartInfo>
  /**
   * `at` (epoch ms, default now) is the instant the app paused at; the helper cuts the
   * video there even though the command reaches it a few milliseconds later.
   */
  pause(at?: number): void
  resume(at?: number): void
  stop(at?: number): Promise<NativeStopInfo>
  /** Aborts immediately; the output file may be incomplete. */
  kill(): void
  /**
   * Registers a callback for the helper ending on its own after it started (monitor
   * unplugged, capture item closed, crash) — i.e. NOT because stop()/kill() was called.
   * Optional so simple fakes need not implement it.
   */
  onEnded?(cb: (info: NativeEndedInfo) => void): void
}

export interface NativeEndedInfo {
  /**
   * Helper-reported reason: 'closed' (the monitor went away; the MP4 is finalised), 'eof'
   * (its stdin/stdout closed), 'interrupt' (Ctrl+C or its console closed), 'shutdown' (sign-out
   * or shutdown); 'error' (it reported a fatal error, e.g. the encoder or GPU failed; `error`
   * has its message) or 'crashed' (it exited without saying why).
   */
  reason: string
  error?: Error
}

/**
 * Errors from a helper that had started carry the cursor shapes (and, recording a window, the
 * window rectangles) it reported until then.
 */
export type NativeCaptureError = Error & { shapes?: NativeStopInfo['shapes']; windowRects?: WindowRectEvent[] }

export interface ProbeResult {
  supported: boolean
  /** Single-window capture (WGC CreateForWindow) with the cursor excluded is available. */
  windowCapture?: boolean
  cursorToggle: boolean
  borderToggle: boolean
  hardwareEncoders: string[]
  /** Why native capture is unavailable, when it is. */
  reason: string | null
}

/** A monitor as listed by the helper (physical pixels). */
export interface HelperMonitor {
  index: number
  device: string
  name: string
  x: number
  y: number
  width: number
  height: number
  primary: boolean
}

/** An Electron display in physical pixels. */
export interface PhysicalDisplay {
  id: string
  x: number
  y: number
  width: number
  height: number
  primary: boolean
}

interface HelperCommand {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** Milliseconds; tests shorten them. */
export const nativeCaptureTimeouts = {
  probe: 10_000,
  list: 10_000,
  /** Covers monitor lookup, device/encoder setup and the helper's own 5 s first-frame limit. */
  start: 20_000,
  /** Finalising the MP4 is quick; this only guards against a wedged encoder. */
  stop: 30_000,
  /** How long quitting the app waits for running helpers to finalise before killing them. */
  quit: 5_000,
  /** watch-window: until the window's first rectangle. */
  watchReady: 10_000,
  /** watch-window: until the helper exits after stop() (it holds no file). */
  watchStop: 5_000
}

const OUTPUT_LIMIT = 256 * 1024

const SHAPES: ReadonlySet<string> = new Set<CursorShape>([
  'arrow',
  'text',
  'pointer',
  'crosshair',
  'move',
  'resize-ew',
  'resize-ns',
  'wait'
])

function helperCommand(): HelperCommand | null {
  const override = process.env.SSW_CAPTURE_HELPER
  if (override) {
    if (!existsSync(override)) return null
    if (/\.(c|m)?js$/i.test(override)) {
      return { file: process.execPath, args: [override], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    }
    return { file: override, args: [], env: process.env }
  }
  if (process.platform !== 'win32') return null
  const exe = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'ssw-capture.exe')
    : path.join(app.getAppPath(), 'native', 'bin', 'ssw-capture.exe')
  return existsSync(exe) ? { file: exe, args: [], env: process.env } : null
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs a one-shot helper command (probe, list); never rejects. */
function runHelper(cmd: HelperCommand, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd.file, [...cmd.args, ...args], { env: cmd.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err)
      resolve({ code: null, stdout, stderr, timedOut })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-OUTPUT_LIMIT)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-OUTPUT_LIMIT)
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/** The last line of `text` that parses as JSON, or undefined. */
function lastJson(text: string): unknown {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i])
    } catch {
      // Not JSON (a log line); keep looking.
    }
  }
  return undefined
}

function failureMessage(r: RunResult, what: string): string {
  if (r.timedOut) return `${what} timed out`
  const json = lastJson(r.stdout) as { message?: unknown; reason?: unknown } | undefined
  const detail = typeof json?.message === 'string' ? json.message : typeof json?.reason === 'string' ? json.reason : r.stderr.trim()
  return `${what} failed${r.code !== null ? ` (exit code ${r.code})` : ''}${detail ? `: ${detail.slice(-500)}` : ''}`
}

/** Runs the helper's `probe`; never rejects. */
export async function probeNativeCapture(): Promise<ProbeResult> {
  const unsupported = (reason: string): ProbeResult => ({
    supported: false,
    windowCapture: false,
    cursorToggle: false,
    borderToggle: false,
    hardwareEncoders: [],
    reason
  })
  const cmd = helperCommand()
  if (!cmd) {
    return unsupported(
      process.platform === 'win32' ? 'The capture helper (ssw-capture.exe) is missing' : 'Native capture is only available on Windows'
    )
  }
  const r = await runHelper(cmd, ['probe'], nativeCaptureTimeouts.probe)
  const json = lastJson(r.stdout) as Partial<Record<keyof ProbeResult, unknown>> | undefined
  if (!json || typeof json !== 'object') return unsupported(failureMessage(r, 'The capture helper probe'))
  const supported = json.supported === true && json.cursorToggle === true && r.code === 0
  const result: ProbeResult = {
    supported,
    // Older helpers do not report it: no window capture then.
    windowCapture: supported && json.windowCapture === true,
    cursorToggle: json.cursorToggle === true,
    borderToggle: json.borderToggle === true,
    hardwareEncoders: Array.isArray(json.hardwareEncoders) ? json.hardwareEncoders.filter((e): e is string => typeof e === 'string') : [],
    reason: typeof json.reason === 'string' ? json.reason : null
  }
  if (!result.supported && !result.reason) result.reason = failureMessage(r, 'The capture helper probe')
  return result
}

let probed: Promise<ProbeResult> | null = null

/** The helper's probe, run once per app session. */
function cachedProbe(): Promise<ProbeResult> {
  if (!probed) {
    probed = probeNativeCapture().then((r) => {
      if (!r.supported) console.info(`Native capture unavailable, using Chromium capture: ${r.reason}`)
      else if (!r.windowCapture) console.info('Native window capture unavailable; windows are recorded with Chromium')
      return r
    })
  }
  return probed
}

export async function isNativeCaptureAvailable(): Promise<boolean> {
  return (await cachedProbe()).supported
}

/**
 * True when single-window capture with the cursor excluded is available (probe.windowCapture):
 * startNativeCapture({ windowId }) can record a window. Shares the cached probe with
 * isNativeCaptureAvailable(); false wherever that is false.
 */
export async function isNativeWindowCaptureAvailable(): Promise<boolean> {
  const r = await cachedProbe()
  return r.supported && r.windowCapture === true
}

/** Forgets the cached probe result (tests; or after the helper was installed). */
export function resetNativeCaptureCache(): void {
  probed = null
}

const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

/**
 * The window handle in an Electron desktopCapturer window source id "window:<id>:<n>", as the
 * helper's --window wants it (decimal; the HWND on Windows, the X window id on Linux/X11), or
 * null when `windowId` is not a window source id (e.g. "screen:0:0", "window:abc:0", "window:0:0").
 */
export function windowHandleOf(windowId: string): string | null {
  const m = /^window:(-?\d{1,20}):(-?\d{1,20})$/.exec(windowId)
  if (!m) return null
  const handle = BigInt(m[1])
  if (handle === 0n || handle < I64_MIN || handle > I64_MAX) return null
  return handle.toString()
}

function isMonitor(m: unknown): m is HelperMonitor {
  const o = m as Record<string, unknown>
  return (
    !!o &&
    typeof o.device === 'string' &&
    ['index', 'x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k] as number))
  )
}

async function listMonitors(cmd: HelperCommand): Promise<HelperMonitor[]> {
  const r = await runHelper(cmd, ['list'], nativeCaptureTimeouts.list)
  const json = r.code === 0 ? lastJson(r.stdout) : undefined
  if (!Array.isArray(json)) throw new Error(failureMessage(r, 'Listing monitors'))
  return json.filter(isMonitor).map((m) => ({ ...m, name: typeof m.name === 'string' ? m.name : m.device, primary: m.primary === true }))
}

function physicalRect(d: Display): { x: number; y: number; width: number; height: number } {
  if (process.platform === 'win32') return screen.dipToScreenRect(null, d.bounds)
  // X11 positions displays in pixels; Windows needs the DPI-aware conversion above.
  const origin = d.nativeOrigin ?? d.bounds
  return {
    x: origin.x,
    y: origin.y,
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor)
  }
}

function physicalDisplays(): PhysicalDisplay[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => ({ id: String(d.id), primary: d.id === primary, ...physicalRect(d) }))
}

/**
 * Finds the helper monitor showing Electron display `displayId`, by physical rectangle
 * (rounding may differ by a pixel or two), then by unique size, then by being primary.
 */
export function matchMonitor(displayId: string, displays: PhysicalDisplay[], monitors: HelperMonitor[]): HelperMonitor | null {
  const target = displays.find((d) => d.id === displayId)
  if (!target || monitors.length === 0) return null
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2
  const sameSize = monitors.filter((m) => near(m.width, target.width) && near(m.height, target.height))
  const exact = sameSize.filter((m) => near(m.x, target.x) && near(m.y, target.y))
  if (exact.length === 1) return exact[0]
  if (displays.length === 1 && monitors.length === 1) return monitors[0]
  if (sameSize.length === 1) return sameSize[0]
  const samePrimary = sameSize.filter((m) => m.primary === target.primary)
  if (samePrimary.length === 1 && target.primary) return samePrimary[0]
  return null
}

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

interface HelperEvent {
  event?: unknown
  [key: string]: unknown
}

/** A `window` event's rectangle, or null when it is malformed. */
function windowRectOf(e: HelperEvent): WindowRectEvent | null {
  const fields = ['at', 'x', 'y', 'width', 'height'] as const
  if (!fields.every((k) => typeof e[k] === 'number' && Number.isFinite(e[k]))) return null
  const width = e.width as number
  const height = e.height as number
  if (width < 0 || height < 0) return null
  return { at: e.at as number, x: e.x as number, y: e.y as number, width, height, minimized: e.minimized === true }
}

/** Splits a helper's stdout into JSON events. */
function eventReader(onEvent: (e: HelperEvent) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let event: HelperEvent
      try {
        event = JSON.parse(line) as HelperEvent
      } catch {
        console.warn('capture helper:', line)
        continue
      }
      onEvent(event)
    }
    if (buffer.length > OUTPUT_LIMIT) buffer = ''
  }
}

/**
 * Spawn options for `record`. On Windows the helper is detached: libuv puts every other child
 * in a kill-on-close job object, so it would die the instant the app does (crash, End task)
 * without finalising. Detached, it sees its stdin close when the app dies and finishes the MP4.
 */
export function recordSpawnOptions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): SpawnOptionsWithoutStdio {
  return { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: platform === 'win32' }
}

/** Record helpers that have not ended yet (for quitting). */
const live = new Set<HelperSession>()

type Outcome = { ok: true; info: NativeStopInfo } | { ok: false; error: Error }

/** One `ssw-capture record` process and its protocol state. */
class HelperSession implements NativeCaptureSession {
  readonly started: Promise<NativeStartInfo>
  private resolveStarted!: (info: NativeStartInfo) => void
  private rejectStarted!: (err: Error) => void
  private startSettled = false
  private startTimer: NodeJS.Timeout | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  /** Commands issued while the monitor was still being resolved. */
  private queued: string[] = []
  private stderr = ''
  private lastError: string | null = null
  private stats: { frames: number; dropped: number; duration: number } | null = null
  private readonly shapes: { at: number; shape: CursorShape }[] = []
  private readonly windowRects: WindowRectEvent[] = []
  private stopRequested = false
  private killed = false
  /** The first frame was reported: from now on an end not asked for is reported via onEnded. */
  private startedOk = false
  private stopReason: string | null = null
  private ended: NativeEndedInfo | null = null
  private readonly endedListeners: ((info: NativeEndedInfo) => void)[] = []
  private outcome: Outcome | null = null
  private stopPromise: Promise<NativeStopInfo> | null = null
  private settleStop: ((o: Outcome) => void) | null = null
  private stopTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: NativeCaptureOptions) {
    this.started = new Promise<NativeStartInfo>((resolve, reject) => {
      this.resolveStarted = resolve
      this.rejectStarted = reject
    })
    // Callers may never await `started` (e.g. stop right away); keep rejections handled.
    this.started.catch(() => undefined)
    live.add(this)
    guardQuit()
    const startTimeout = nativeCaptureTimeouts.start
    this.startTimer = setTimeout(() => {
      // Ends the session for good: a helper still being looked up is never spawned.
      this.terminate()
      this.finish({ ok: false, error: new Error(`The capture helper did not start within ${startTimeout / 1000} s`) })
    }, startTimeout)
    void this.launch()
  }

  /** What this session reports when it ends: window recordings include the window's rectangles. */
  private stopInfo(info: Omit<NativeStopInfo, 'shapes' | 'windowRects'>): NativeStopInfo {
    const result: NativeStopInfo = { ...info, shapes: [...this.shapes] }
    if (this.options.windowId !== undefined) result.windowRects = [...this.windowRects]
    return result
  }

  /** The helper's --monitor/--window arguments. */
  private async target(cmd: HelperCommand): Promise<string[]> {
    const { displayId, windowId } = this.options
    if (displayId && windowId !== undefined) throw new Error('Record either a display or a window, not both')
    if (windowId !== undefined) {
      const handle = windowHandleOf(windowId)
      if (!handle) throw new Error(`Not a window source id: ${JSON.stringify(windowId)} (expected "window:<handle>:<n>")`)
      return ['--window', handle]
    }
    if (!displayId) throw new Error('No display or window to record')
    const monitors = await listMonitors(cmd)
    const monitor = matchMonitor(displayId, physicalDisplays(), monitors)
    if (!monitor) {
      const listed = monitors.map((m) => `${m.device} ${m.width}x${m.height}@${m.x},${m.y}`).join('; ')
      throw new Error(`No capture monitor matches display ${displayId} (helper lists: ${listed || 'none'})`)
    }
    return ['--monitor', monitor.device]
  }

  private async launch(): Promise<void> {
    try {
      const cmd = helperCommand()
      if (!cmd) throw new Error('The native capture helper is not available')
      const target = await this.target(cmd)
      // Killed or timed out meanwhile.
      if (this.outcome) return
      if (this.stopRequested) {
        this.finish({ ok: true, info: this.stopInfo({ frames: 0 }) }, 'Recording was stopped before it started')
        return
      }
      const args = ['record', ...target, '--out', this.options.output, '--fps', String(this.options.fps)]
      if (this.options.bitrate) args.push('--bitrate', String(Math.round(this.options.bitrate)))
      const child = spawn(cmd.file, [...cmd.args, ...args], recordSpawnOptions(cmd.env))
      this.child = child
      // EPIPE when the helper has already exited; the exit handler reports what happened.
      child.stdin.on('error', () => undefined)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', eventReader((e) => this.onEvent(e)))
      child.stderr.on('data', (d: Buffer) => {
        this.stderr = (this.stderr + d.toString()).slice(-4000)
      })
      child.on('error', (err) => this.onExit(null, null, err))
      child.on('close', (code, signal) => this.onExit(code, signal))
      for (const line of this.queued) this.send(line)
      this.queued = []
    } catch (err) {
      this.finish({ ok: false, error: errorOf(err) })
    }
  }

  private onEvent(e: HelperEvent): void {
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    switch (e.event) {
      case 'started': {
        const at = num(e.at)
        const width = num(e.width)
        const height = num(e.height)
        if (at === null || !width || !height || width <= 0 || height <= 0) {
          this.terminate()
          this.finish({ ok: false, error: new Error('The capture helper reported an invalid start') })
          return
        }
        const info: NativeStartInfo = { startedAt: at, width, height }
        if (num(e.fps)) info.fps = num(e.fps) as number
        if (typeof e.encoder === 'string') info.encoder = e.encoder
        if (typeof e.hardware === 'boolean') info.hardware = e.hardware
        if (typeof e.fragmented === 'boolean') info.fragmented = e.fragmented
        if (!this.startSettled) {
          this.startSettled = true
          this.startedOk = true
          this.clearStartTimer()
          this.resolveStarted(info)
        }
        return
      }
      case 'cursor': {
        const at = num(e.at)
        if (at !== null && typeof e.shape === 'string' && SHAPES.has(e.shape)) {
          this.shapes.push({ at, shape: e.shape as CursorShape })
        }
        return
      }
      case 'window': {
        const rect = windowRectOf(e)
        if (rect && this.options.windowId !== undefined) this.windowRects.push(rect)
        return
      }
      case 'stopped':
        this.stats = { frames: num(e.frames) ?? 0, dropped: num(e.dropped) ?? 0, duration: num(e.duration) ?? 0 }
        this.stopReason = typeof e.reason === 'string' && e.reason ? e.reason : 'eof'
        // The MP4 is finalised by now; the process exits right after.
        this.reportEnded({ reason: this.stopReason })
        return
      case 'error':
        if (typeof e.message === 'string') this.lastError = e.message
        this.reportEnded({ reason: 'error', error: new Error(`The capture helper failed: ${this.lastError ?? 'unknown error'}`) })
        return
      case 'warning':
        if (typeof e.message === 'string') console.warn('capture helper:', e.message)
        return
      default:
        // ready, paused, resumed: informational.
        return
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void {
    if (this.outcome) return
    if (code === 0 && this.stats) {
      const { frames, dropped, duration } = this.stats
      this.finish({ ok: true, info: this.stopInfo({ frames, dropped, duration }) }, 'Recording was stopped before the first frame')
      return
    }
    const detail = spawnError?.message ?? this.lastError ?? this.stderr.trim().split(/\r?\n/).slice(-3).join(' ')
    const how = this.killed
      ? 'was stopped'
      : spawnError
        ? 'could not run'
        : code === null
          ? `was terminated${signal ? ` (${signal})` : ''}`
          : `exited with code ${code}`
    this.finish({ ok: false, error: new Error(`The capture helper ${how}${detail ? `: ${detail}` : ''}`) })
  }

  /** Records the final outcome: settles `started` (if still pending) and stop(). */
  private finish(outcome: Outcome, notStartedMessage?: string): void {
    if (this.outcome) return
    if (!outcome.ok && this.startedOk) {
      const error = outcome.error as NativeCaptureError
      error.shapes = [...this.shapes]
      if (this.options.windowId !== undefined) error.windowRects = [...this.windowRects]
    }
    this.outcome = outcome
    this.child = null
    live.delete(this)
    this.failStart(outcome.ok ? new Error(notStartedMessage ?? 'The capture helper ended') : outcome.error)
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.settleStop?.(outcome)
    this.settleStop = null
    this.reportEnded(
      outcome.ok
        ? { reason: this.stopReason ?? 'eof' }
        : { reason: this.lastError ? 'error' : 'crashed', error: outcome.error }
    )
  }

  /** Tells onEnded listeners, once, that the helper ended although nobody asked it to. */
  private reportEnded(info: NativeEndedInfo): void {
    if (this.ended || !this.startedOk || this.stopRequested || this.killed) return
    this.ended = info
    for (const cb of this.endedListeners.splice(0)) this.notify(cb, info)
  }

  private notify(cb: (info: NativeEndedInfo) => void, info: NativeEndedInfo): void {
    try {
      cb(info)
    } catch (err) {
      console.error('Native capture ended listener failed:', err)
    }
  }

  onEnded(cb: (info: NativeEndedInfo) => void): void {
    const ended = this.ended
    // Subscribed late (the helper ended while the app was still attaching): report it anyway.
    if (ended) queueMicrotask(() => this.notify(cb, ended))
    else this.endedListeners.push(cb)
  }

  private failStart(err: Error): void {
    this.clearStartTimer()
    if (this.startSettled) return
    this.startSettled = true
    this.rejectStarted(err)
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private send(line: string): void {
    const stdin = this.child?.stdin
    if (stdin && stdin.writable) stdin.write(`${line}\n`)
  }

  private command(name: 'pause' | 'resume', at: number | undefined): void {
    if (this.outcome || this.stopRequested || this.killed) return
    const line = `${name} ${Number.isFinite(at) ? at : Date.now()}`
    if (this.child) this.send(line)
    else this.queued.push(line)
  }

  pause(at?: number): void {
    this.command('pause', at)
  }

  resume(at?: number): void {
    this.command('resume', at)
  }

  stop(at?: number): Promise<NativeStopInfo> {
    if (this.stopPromise) return this.stopPromise
    this.stopRequested = true
    this.stopPromise = new Promise<NativeStopInfo>((resolve, reject) => {
      const settle = (o: Outcome): void => (o.ok ? resolve(o.info) : reject(o.error))
      if (this.outcome) {
        settle(this.outcome)
        return
      }
      this.settleStop = settle
      const stopTimeout = nativeCaptureTimeouts.stop
      this.stopTimer = setTimeout(() => {
        this.terminate()
        this.finish({ ok: false, error: new Error(`The capture helper did not finish within ${stopTimeout / 1000} s`) })
      }, stopTimeout)
      if (this.child) {
        this.send(`stop ${Number.isFinite(at) ? at : Date.now()}`)
        // Closing stdin also stops the helper, should the line get lost.
        this.child.stdin.end()
      }
      // Otherwise launch() sees stopRequested once the monitor lookup returns.
    })
    return this.stopPromise
  }

  private terminate(): void {
    this.child?.kill('SIGKILL')
  }

  kill(): void {
    if (this.outcome) return
    this.killed = true
    if (this.child) {
      this.terminate()
    } else {
      this.finish({ ok: false, error: new Error('The capture helper was stopped') })
    }
  }
}

export function startNativeCapture(options: NativeCaptureOptions): NativeCaptureSession {
  return new HelperSession(options)
}

/**
 * Stops every running record helper the way stop() does (so it finalises its MP4) and waits
 * up to `timeoutMs`; helpers still running then are killed. Never rejects.
 */
export async function stopAllNativeCaptures(timeoutMs = nativeCaptureTimeouts.quit): Promise<void> {
  const sessions = [...live]
  if (sessions.length === 0) return
  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    Promise.all(sessions.map((s) => s.stop().catch(() => undefined))).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs)
    })
  ])
  clearTimeout(timer)
  if (timedOut) for (const s of sessions) s.kill()
}

let quitGuarded = false

/**
 * Makes quitting the app finalise running helpers instead of killing them mid-file: the
 * first 'will-quit' with helpers running is postponed until stopAllNativeCaptures() is done.
 * Prepended so it runs before the app's own will-quit cleanup (which kills what is left).
 */
function guardQuit(): void {
  if (quitGuarded || typeof app?.prependListener !== 'function') return
  quitGuarded = true
  let state: 'idle' | 'stopping' | 'done' = 'idle'
  app.prependListener('will-quit', (event: { preventDefault(): void }) => {
    if (state === 'done') return
    if (state === 'stopping') {
      // Quit again once the helpers are done.
      event.preventDefault()
      return
    }
    if (live.size === 0) return
    event.preventDefault()
    state = 'stopping'
    void stopAllNativeCaptures().finally(() => {
      state = 'done'
      app.quit()
    })
  })
}

/**
 * Watches a window's screen rectangle without capturing it ("watch-window" helper mode):
 * used when the window itself is recorded by Chromium, so clicks and the cursor can still
 * be mapped into the window. `ready` resolves once the helper has reported the first rect.
 */
export interface WindowWatchSession {
  readonly ready: Promise<WindowRectEvent>
  /** Stops watching and resolves with every rect reported (first one included). */
  stop(): Promise<WindowRectEvent[]>
  kill(): void
}

/** Window watchers still running (killed when the app exits). */
const watchers = new Set<WindowWatcher>()
let exitGuarded = false

/** One `ssw-capture watch-window` process. */
class WindowWatcher implements WindowWatchSession {
  readonly ready: Promise<WindowRectEvent>
  private resolveReady!: (rect: WindowRectEvent) => void
  private rejectReady!: (err: Error) => void
  private readySettled = false
  private readyTimer: NodeJS.Timeout | null = null
  private readonly child: ChildProcessWithoutNullStreams
  private readonly rects: WindowRectEvent[] = []
  private readonly exited: Promise<void>
  private hasExited = false
  private stderr = ''
  private lastError: string | null = null
  private stopPromise: Promise<WindowRectEvent[]> | null = null

  constructor(cmd: HelperCommand, handle: string) {
    this.ready = new Promise<WindowRectEvent>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // Callers may stop without awaiting `ready`.
    this.ready.catch(() => undefined)
    // Not detached: there is no file to finalise, and its stdin closing with the app stops it.
    this.child = spawn(cmd.file, [...cmd.args, 'watch-window', '--window', handle], {
      env: cmd.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    watchers.add(this)
    guardExit()
    this.exited = new Promise<void>((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
        if (this.hasExited) return
        this.hasExited = true
        watchers.delete(this)
        const detail = spawnError?.message ?? this.lastError ?? this.stderr.trim().split(/\r?\n/).slice(-3).join(' ')
        const how = spawnError
          ? 'could not run'
          : code === null
            ? `was terminated${signal ? ` (${signal})` : ''}`
            : `exited with code ${code}`
        this.failReady(new Error(`The window watcher ${how} before reporting the window${detail ? `: ${detail}` : ''}`))
        resolve()
      }
      this.child.on('error', (err) => done(null, null, err))
      this.child.on('close', (code, signal) => done(code, signal))
    })
    this.child.stdin.on('error', () => undefined)
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', eventReader((e) => this.onEvent(e)))
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000)
    })
    const timeout = nativeCaptureTimeouts.watchReady
    this.readyTimer = setTimeout(() => {
      this.failReady(new Error(`The window watcher reported no window within ${timeout / 1000} s`))
      this.kill()
    }, timeout)
  }

  private onEvent(e: HelperEvent): void {
    switch (e.event) {
      case 'window': {
        const rect = windowRectOf(e)
        if (!rect) return
        this.rects.push(rect)
        if (!this.readySettled) {
          this.readySettled = true
          this.clearReadyTimer()
          this.resolveReady(rect)
        }
        return
      }
      case 'error':
        if (typeof e.message === 'string') this.lastError = e.message
        return
      case 'warning':
        if (typeof e.message === 'string') console.warn('window watcher:', e.message)
        return
      default:
        // ready; stopped ("stop", or "closed" when the window closed: the rects stay valid).
        return
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
  }

  private failReady(err: Error): void {
    this.clearReadyTimer()
    if (this.readySettled) return
    this.readySettled = true
    this.rejectReady(err)
  }

  stop(): Promise<WindowRectEvent[]> {
    if (this.stopPromise) return this.stopPromise
    this.failReady(new Error('Window watching was stopped before the window was reported'))
    this.stopPromise = (async () => {
      if (!this.hasExited) {
        if (this.child.stdin.writable) this.child.stdin.write('stop\n')
        // Closing stdin stops it too, should the line get lost.
        this.child.stdin.end()
        let timer: NodeJS.Timeout | undefined
        const timedOut = await Promise.race([
          this.exited.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), nativeCaptureTimeouts.watchStop)
          })
        ])
        clearTimeout(timer)
        if (timedOut) {
          this.kill()
          await this.exited
        }
      }
      return [...this.rects]
    })()
    return this.stopPromise
  }

  kill(): void {
    this.failReady(new Error('Window watching was stopped before the window was reported'))
    if (!this.hasExited) this.child.kill('SIGKILL')
  }
}

/** Watchers have no file to finalise: when the app exits, end any still running. */
function guardExit(): void {
  if (exitGuarded) return
  exitGuarded = true
  process.once('exit', () => {
    for (const w of watchers) w.kill()
  })
}

/**
 * Starts "watch-window" for an Electron window source id ("window:<HWND>:<n>"; on Linux/X11 the
 * number is the X window id, for tests with SSW_CAPTURE_HELPER). Throws when the id is not a
 * window source id or there is no helper (on Windows: the exe is missing; elsewhere only an
 * SSW_CAPTURE_HELPER override provides one). `ready` rejects when the window does not exist
 * (the helper exits 4), the helper fails or reports nothing within nativeCaptureTimeouts.watchReady.
 * stop() never rejects: it resolves with every rectangle reported, also after a failure or after
 * the window closed. Needs neither Windows.Graphics.Capture nor an encoder, so it works where
 * isNativeCaptureAvailable() is false.
 */
export function watchWindow(windowId: string): WindowWatchSession {
  const handle = windowHandleOf(windowId)
  if (!handle) throw new Error(`Not a window source id: ${JSON.stringify(windowId)} (expected "window:<handle>:<n>")`)
  const cmd = helperCommand()
  if (!cmd) {
    throw new Error(
      process.platform === 'win32' ? 'The capture helper (ssw-capture.exe) is missing' : 'Window watching is only available on Windows'
    )
  }
  return new WindowWatcher(cmd, handle)
}
