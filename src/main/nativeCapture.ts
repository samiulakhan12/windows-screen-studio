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
 *
 * The helper is found at resources/native/ssw-capture.exe when packaged and at
 * native/bin/ssw-capture.exe in development (npm run build:native). SSW_CAPTURE_HELPER
 * overrides it with an executable, or a .js/.cjs script run by Electron as Node (tests).
 * Protocol: native/README.md.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, screen, type Display } from 'electron'
import type { CursorShape } from '../shared/types'

export interface NativeCaptureOptions {
  /** Electron display id (screen.getAllDisplays()[n].id) of the monitor to record. */
  displayId: string
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
}

export interface NativeStopInfo {
  frames: number
  /** Cursor shape changes as epoch ms (not yet pause-adjusted). */
  shapes: { at: number; shape: CursorShape }[]
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
  /** Helper-reported reason (e.g. 'closed', 'eof', 'interrupt') or 'crashed'. */
  reason: string
  error?: Error
}

export interface ProbeResult {
  supported: boolean
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
  stop: 30_000
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
  const result: ProbeResult = {
    supported: json.supported === true && json.cursorToggle === true && r.code === 0,
    cursorToggle: json.cursorToggle === true,
    borderToggle: json.borderToggle === true,
    hardwareEncoders: Array.isArray(json.hardwareEncoders) ? json.hardwareEncoders.filter((e): e is string => typeof e === 'string') : [],
    reason: typeof json.reason === 'string' ? json.reason : null
  }
  if (!result.supported && !result.reason) result.reason = failureMessage(r, 'The capture helper probe')
  return result
}

let availability: Promise<boolean> | null = null

export function isNativeCaptureAvailable(): Promise<boolean> {
  if (!availability) {
    availability = probeNativeCapture().then((r) => {
      if (!r.supported) console.info(`Native capture unavailable, using Chromium capture: ${r.reason}`)
      return r.supported
    })
  }
  return availability
}

/** Forgets the cached probe result (tests; or after the helper was installed). */
export function resetNativeCaptureCache(): void {
  availability = null
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
  private stdoutBuffer = ''
  private stderr = ''
  private lastError: string | null = null
  private stats: { frames: number; dropped: number; duration: number } | null = null
  private readonly shapes: { at: number; shape: CursorShape }[] = []
  private stopRequested = false
  private killed = false
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
    const startTimeout = nativeCaptureTimeouts.start
    this.startTimer = setTimeout(() => {
      // Ends the session for good: a helper still being looked up is never spawned.
      this.terminate()
      this.finish({ ok: false, error: new Error(`The capture helper did not start within ${startTimeout / 1000} s`) })
    }, startTimeout)
    void this.launch()
  }

  private async launch(): Promise<void> {
    try {
      const cmd = helperCommand()
      if (!cmd) throw new Error('The native capture helper is not available')
      const monitors = await listMonitors(cmd)
      // Killed or timed out meanwhile.
      if (this.outcome) return
      if (this.stopRequested) {
        this.finish({ ok: true, info: { frames: 0, shapes: [] } }, 'Recording was stopped before it started')
        return
      }
      const monitor = matchMonitor(this.options.displayId, physicalDisplays(), monitors)
      if (!monitor) {
        const listed = monitors.map((m) => `${m.device} ${m.width}x${m.height}@${m.x},${m.y}`).join('; ')
        throw new Error(`No capture monitor matches display ${this.options.displayId} (helper lists: ${listed || 'none'})`)
      }
      const args = ['record', '--monitor', monitor.device, '--out', this.options.output, '--fps', String(this.options.fps)]
      if (this.options.bitrate) args.push('--bitrate', String(Math.round(this.options.bitrate)))
      const child = spawn(cmd.file, [...cmd.args, ...args], { env: cmd.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      // EPIPE when the helper has already exited; the exit handler reports what happened.
      child.stdin.on('error', () => undefined)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
      child.stderr.on('data', (d: Buffer) => {
        this.stderr = (this.stderr + d.toString()).slice(-4000)
      })
      child.on('error', (err) => this.onExit(null, err))
      child.on('close', (code) => this.onExit(code))
      for (const line of this.queued) this.send(line)
      this.queued = []
    } catch (err) {
      this.finish({ ok: false, error: errorOf(err) })
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline: number
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      let event: HelperEvent
      try {
        event = JSON.parse(line) as HelperEvent
      } catch {
        console.warn('capture helper:', line)
        continue
      }
      this.onEvent(event)
    }
    if (this.stdoutBuffer.length > OUTPUT_LIMIT) this.stdoutBuffer = ''
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
        if (!this.startSettled) {
          this.startSettled = true
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
      case 'stopped':
        this.stats = { frames: num(e.frames) ?? 0, dropped: num(e.dropped) ?? 0, duration: num(e.duration) ?? 0 }
        return
      case 'error':
        if (typeof e.message === 'string') this.lastError = e.message
        return
      case 'warning':
        if (typeof e.message === 'string') console.warn('capture helper:', e.message)
        return
      default:
        // ready, paused, resumed: informational.
        return
    }
  }

  private onExit(code: number | null, spawnError?: Error): void {
    if (this.outcome) return
    if (code === 0 && this.stats) {
      const { frames, dropped, duration } = this.stats
      this.finish({ ok: true, info: { frames, shapes: [...this.shapes], dropped, duration } }, 'Recording was stopped before the first frame')
      return
    }
    const detail = spawnError?.message ?? this.lastError ?? this.stderr.trim().split(/\r?\n/).slice(-3).join(' ')
    const how = this.killed ? 'was stopped' : code === null ? 'could not run' : `exited with code ${code}`
    this.finish({ ok: false, error: new Error(`The capture helper ${how}${detail ? `: ${detail}` : ''}`) })
  }

  /** Records the final outcome: settles `started` (if still pending) and stop(). */
  private finish(outcome: Outcome, notStartedMessage?: string): void {
    if (this.outcome) return
    this.outcome = outcome
    this.child = null
    this.failStart(outcome.ok ? new Error(notStartedMessage ?? 'The capture helper ended') : outcome.error)
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.settleStop?.(outcome)
    this.settleStop = null
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
