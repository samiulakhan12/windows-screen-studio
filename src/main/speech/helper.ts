/**
 * The speech helper as a child process (docs/design/offline-captions.md §5.3): where it is,
 * which build runs on this processor, spawning it (no shell, stdio pipes only, a minimal
 * environment, below-normal priority), reading its JSON lines with caps, cancelling it
 * ("cancel" line, end of stdin, then a kill after a grace period), a stall watchdog, and what
 * its exit means. Workstream B's own module.
 */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SpeechUnavailable } from '../../shared/api/speech'
import { VAD_MODEL } from '../../shared/speech/catalog'
import { readSidecarLine, SIDECAR, type SidecarCpu, type SidecarErrorCode, type SidecarEvent } from '../../shared/speech/protocol'
import type { ProjectProcesses } from '../projectProcesses'

/** Timings of a run, ms. */
export const SPEECH_TIMING = {
  /** After "cancel" and the end of stdin, the helper is killed if it has not exited. */
  cancelGraceMs: 2000,
  /**
   * No stdout line for this long: the helper is stuck and killed (reset when the PC resumes from
   * sleep). The helper prints a progress line at least every SIDECAR.heartbeat (15) seconds.
   */
  stallMs: 120_000,
  /**
   * A transcription part may run at most max(partMinMs, partEstimateFactor × estimateSeconds of
   * the part for this build, thread count and measured speed); over it, the run counts as stalled
   * (the heartbeat proves only that the process is alive, not that whisper.cpp moves on).
   */
  partMinMs: 600_000,
  partEstimateFactor: 4,
  /** The speech detector's limit: this, plus vadPerSecondMs per second of audio. */
  vadBaseMs: 30_000,
  vadPerSecondMs: 50,
  /** The CPU probe's limit (an antivirus may scan the new exe first). */
  probeMs: 30_000
} as const

/** Windows' STATUS_ILLEGAL_INSTRUCTION as an exit code. */
export const STATUS_ILLEGAL_INSTRUCTION = 0xc000001d
/** Last bytes of stderr kept for the log. */
const STDERR_KEEP = 4096

export type HelperBuild = 'standard' | 'compatible' | 'host'

/** Files of this build: the helpers and the bundled speech detector model. */
export interface SpeechHelperPaths {
  standard: string
  /** Absent in development (one host build). */
  compatible: string | null
  vadModel: string
}

export type HelperChoice = { exe: string; build: HelperBuild } | { error: SpeechUnavailable; detail: string }

/** How a run ended. */
export type SpeechExit =
  | { kind: 'ok' }
  | { kind: 'cancelled'; doneUntil: number }
  | { kind: 'error'; code: SidecarErrorCode; message: string }
  | { kind: 'crash'; illegalInstruction: boolean; detail: string }
  | { kind: 'stalled' }
  | { kind: 'protocol'; detail: string }

export interface RunOptions {
  /**
   * The job's temporary folder (transcribe), or os.tmpdir() (cpu, vad); never the models folder,
   * which does not exist until a model is downloaded.
   */
  cwd: string
  /** 'control' keeps stdin for "cancel"; a stream is piped in as the audio (the speech detector); 'none' closes it. */
  stdin: 'control' | 'none' | NodeJS.ReadableStream
  signal: AbortSignal
  stallMs?: number
  /** Overall limit, ms (the speech detector, a transcription part); over it the run is 'stalled'. */
  timeoutMs?: number
  /** Registered here under `owner` (a project id), so stopping the project stops it. */
  processes?: ProjectProcesses
  owner?: string
  /** The helper could not be started (ENOENT, EACCES: Windows or an antivirus refused it). */
  onSpawnError?: (err: NodeJS.ErrnoException) => void
}

export interface SpeechRun {
  /** Every valid event, in order (invalid lines are dropped; a line or total over the caps ends the run as 'protocol'). */
  events: AsyncIterable<SidecarEvent>
  /** Settles after the process has exited and closed its files. */
  done: Promise<SpeechExit>
  /** Sets the overall limit to `ms` from the start of the run (the speech detector learns the length late). */
  limit(ms: number): void
  /** The last bytes of stderr (for logs only). */
  stderr(): string
}

const unpackagedEnv = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name] || undefined)

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The helper of this build: packaged, process.resourcesPath/native/ssw-speech.exe and
 * ssw-speech-compat.exe and resources/speech/ggml-silero-v6.2.0.bin; in development,
 * native/bin/ssw-speech[.exe] and the repository's resources/speech; SSW_SPEECH_HELPER (a file)
 * replaces the helper only when the app is not packaged. Null when the helper is missing.
 */
export function speechHelperPaths(): SpeechHelperPaths | null {
  if (app.isPackaged) {
    const standard = path.join(process.resourcesPath, 'native', 'ssw-speech.exe')
    const compatible = path.join(process.resourcesPath, 'native', 'ssw-speech-compat.exe')
    const vadModel = path.join(process.resourcesPath, 'speech', VAD_MODEL.file)
    // The compatible build runs the CPU probe: without it nothing can be chosen safely.
    return isFile(standard) && isFile(compatible) ? { standard, compatible, vadModel } : null
  }
  const vadModel = path.join(app.getAppPath(), 'resources', 'speech', VAD_MODEL.file)
  const override = unpackagedEnv('SSW_SPEECH_HELPER')
  if (override) return isFile(override) ? { standard: override, compatible: null, vadModel } : null
  const standard = path.join(app.getAppPath(), 'native', 'bin', process.platform === 'win32' ? 'ssw-speech.exe' : 'ssw-speech')
  return isFile(standard) ? { standard, compatible: null, vadModel } : null
}

/** Standard when the processor has everything the standard build is compiled for (SSE4.2, AVX, AVX2, FMA, F16C, BMI2), else compatible. Pure. */
export function chooseBuild(cpu: SidecarCpu | null): 'standard' | 'compatible' {
  return cpu && cpu.sse42 && cpu.avx && cpu.avx2 && cpu.fma && cpu.f16c && cpu.bmi2 ? 'standard' : 'compatible'
}

/**
 * The environment the helper gets: what the C runtime needs, nothing else (no keys, no
 * proxies). A script override (tests, unpackaged only) also gets ELECTRON_RUN_AS_NODE and the
 * FAKE_SPEECH_* variables that steer the fake.
 */
export function minimalEnv(platform: NodeJS.Platform = process.platform, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = platform === 'win32' ? ['SystemRoot', 'TEMP', 'TMP', 'PATH'] : ['PATH', 'LANG']
  const env: Record<string, string> = {}
  for (const k of keep) {
    const v = from[k] ?? (platform === 'win32' ? from[k.toUpperCase()] : undefined)
    if (v !== undefined) env[k] = v
  }
  return env
}

/** How `exe` is started: a .js/.cjs override (unpackaged tests) runs under Node. */
export function helperCommand(exe: string): { file: string; args: string[]; env: Record<string, string> } {
  const env = minimalEnv()
  if (!app.isPackaged && /\.(c|m)?js$/i.test(exe)) {
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FAKE_SPEECH_') && v !== undefined) env[k] = v
    return { file: process.execPath, args: [exe], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { file: exe, args: [], env }
}

/** The arguments every run gets: below-normal priority and the parent watch. */
export const commonArgs = (): string[] => ['--low-priority', '--parent-pid', String(process.pid)]

let selected: Promise<HelperChoice> | null = null
let illegal = false
let probedCpu: SidecarCpu | null = null

/** The processor as the probe saw it (null before the probe or in development). */
export const probedProcessor = (): SidecarCpu | null => probedCpu

/** Why a spawn failed, as the reason Settings shows. */
function spawnFailure(err: NodeJS.ErrnoException | undefined): SpeechUnavailable {
  if (err?.code === 'ENOENT') return 'missing'
  if (err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'UNKNOWN') return 'blocked'
  return 'failed'
}

/** Runs `cpu` with `exe` in os.tmpdir(); the processor, or why it could not run. */
async function probe(exe: string): Promise<{ cpu: SidecarCpu } | { error: SpeechUnavailable; detail: string }> {
  const controller = new AbortController()
  let spawnError: NodeJS.ErrnoException | undefined
  let run: SpeechRun
  try {
    run = runHelper(exe, ['cpu', '--parent-pid', String(process.pid)], { cwd: os.tmpdir(), stdin: 'none', signal: controller.signal, timeoutMs: SPEECH_TIMING.probeMs, onSpawnError: (e) => (spawnError = e) })
  } catch (err) {
    return { error: spawnFailure(err as NodeJS.ErrnoException), detail: (err as Error).message }
  }
  let cpu: SidecarCpu | null = null
  for await (const e of run.events) if (e.type === 'cpu') cpu = e
  const exit = await run.done
  if (spawnError) return { error: spawnFailure(spawnError), detail: spawnError.message }
  if (exit.kind === 'crash' && exit.illegalInstruction) return { error: 'cpu', detail: exit.detail }
  if (exit.kind === 'ok' && cpu) return { cpu }
  const why = exit.kind === 'crash' || exit.kind === 'protocol' ? exit.detail : exit.kind === 'error' ? exit.message : exit.kind
  return { error: 'failed', detail: `The speech helper's check failed (${why}). ${run.stderr().trim().split('\n').pop() ?? ''}`.trim() }
}

async function choose(): Promise<HelperChoice> {
  const paths = speechHelperPaths()
  if (!paths) return { error: 'missing', detail: 'The speech helper is not part of this build.' }
  if (!paths.compatible) {
    // Development: the one host build (or a test override), checked by running its probe.
    const r = await probe(paths.standard)
    if ('error' in r) return r
    probedCpu = r.cpu
    return { exe: paths.standard, build: 'host' }
  }
  const r = await probe(paths.compatible)
  if ('error' in r) return r
  probedCpu = r.cpu
  return chooseBuild(r.cpu) === 'standard' && !illegal ? { exe: paths.standard, build: 'standard' } : { exe: paths.compatible, build: 'compatible' }
}

/** The helper to run (checked once per session with the compatible build's `cpu`). */
export async function selectHelper(): Promise<HelperChoice> {
  selected ??= choose()
  const choice = await selected
  if (illegal && 'build' in choice) {
    if (choice.build === 'compatible') return choice
    const paths = speechHelperPaths()
    if (choice.build === 'standard' && paths?.compatible) return { exe: paths.compatible, build: 'compatible' }
    return { error: 'cpu', detail: 'The speech helper stopped on an instruction this processor does not have.' }
  }
  return choice
}

/** The standard build hit an illegal instruction: use the compatible one for the rest of the session. */
export function markIllegalInstruction(): void {
  illegal = true
}

/** Forgets the session's choice (tests; a restart does the same). */
export function resetHelperSelection(): void {
  selected = null
  illegal = false
  probedCpu = null
}

/** Live helpers, killed at once when the app quits. */
const live = new Set<ChildProcess>()
/** Watchdogs of live runs, reset when the PC resumes from sleep. */
const watchdogs = new Set<() => void>()

/** The PC woke up: no run looks stalled because of the time it slept. */
export function resetSpeechWatchdogs(): void {
  for (const reset of watchdogs) reset()
}

/** A queue the reader pushes events into and the consumer iterates. */
class EventQueue implements AsyncIterable<SidecarEvent> {
  private items: SidecarEvent[] = []
  private ended = false
  private wake: (() => void) | null = null
  push(e: SidecarEvent): void {
    this.items.push(e)
    this.wake?.()
  }
  end(): void {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SidecarEvent> {
    for (;;) {
      if (this.items.length) yield this.items.shift()!
      else if (this.ended) return
      else await new Promise<void>((r) => (this.wake = r))
      this.wake = null
    }
  }
}

/** Splits stdout into lines with the caps of SIDECAR: a line over lineMax or a total over totalMax is an overflow. */
export class LineSplitter {
  private parts: Buffer[] = []
  private pending = 0
  private total = 0
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly lineMax: number = SIDECAR.lineMax,
    private readonly totalMax: number = SIDECAR.totalMax
  ) {}

  /** Feeds a chunk; returns a reason when a cap was passed (nothing more should be fed). */
  push(chunk: Buffer): string | null {
    this.total += chunk.length
    if (this.total > this.totalMax) return `more than ${this.totalMax} bytes of output`
    let start = 0
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, i)
      if (this.pending + piece.length > this.lineMax) return `a line longer than ${this.lineMax} bytes`
      this.parts.push(piece)
      const line = Buffer.concat(this.parts).toString('utf8').replace(/\r$/, '')
      this.parts = []
      this.pending = 0
      start = i + 1
      if (line.trim()) this.onLine(line)
    }
    const rest = chunk.subarray(start)
    if (this.pending + rest.length > this.lineMax) return `a line longer than ${this.lineMax} bytes`
    if (rest.length) {
      this.parts.push(Buffer.from(rest))
      this.pending += rest.length
    }
    return null
  }

  /** The end of output: a last line without a newline still counts. */
  end(): void {
    if (!this.pending) return
    const line = Buffer.concat(this.parts).toString('utf8').replace(/\r$/, '')
    this.parts = []
    this.pending = 0
    if (line.trim()) this.onLine(line)
  }
}

/** Starts the helper `exe` with `args` (never through a shell). */
export function runHelper(exe: string, args: readonly string[], opts: RunOptions): SpeechRun {
  const cmd = helperCommand(exe)
  const queue = new EventQueue()
  const generation = opts.processes && opts.owner !== undefined ? opts.processes.generation(opts.owner) : 0
  let stderr = ''
  let child: ChildProcess
  try {
    child = spawn(cmd.file, [...cmd.args, ...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd, env: cmd.env })
  } catch (err) {
    queue.end()
    opts.onSpawnError?.(err as NodeJS.ErrnoException)
    return { events: queue, done: Promise.resolve({ kind: 'crash', illegalInstruction: false, detail: (err as Error).message }), limit: () => undefined, stderr: () => '' }
  }
  live.add(child)
  if (opts.processes && opts.owner !== undefined) opts.processes.add(child, opts.owner)

  let aborted = false
  let stalled = false
  let overflow: string | null = null
  let lastError: { code: SidecarErrorCode; message: string } | null = null
  let cancelledLine: { doneUntil: number } | null = null
  let spawnError: Error | null = null
  let killTimer: NodeJS.Timeout | null = null
  const started = Date.now()

  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  // Stall watchdog: reset by every line and when the PC resumes.
  const stallMs = opts.stallMs ?? SPEECH_TIMING.stallMs
  let stallTimer: NodeJS.Timeout | null = null
  const resetStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      kill()
    }, stallMs)
  }
  // Overall limit, from the start (shifted by the time slept).
  let deadline = opts.timeoutMs !== undefined ? started + opts.timeoutMs : Infinity
  let limitTimer: NodeJS.Timeout | null = null
  const armLimit = (): void => {
    if (limitTimer) clearTimeout(limitTimer)
    if (!Number.isFinite(deadline)) return
    limitTimer = setTimeout(() => {
      stalled = true
      kill()
    }, Math.max(0, deadline - Date.now()))
  }
  let sleptFrom = Date.now()
  const onResume = (): void => {
    if (Number.isFinite(deadline)) deadline += Math.max(0, Date.now() - sleptFrom)
    sleptFrom = Date.now()
    resetStall()
    armLimit()
  }
  watchdogs.add(onResume)
  resetStall()
  armLimit()

  const splitter = new LineSplitter((line) => {
    const event = readSidecarLine(line)
    if (!event) return
    if (event.type === 'error') lastError = { code: event.code, message: event.message }
    if (event.type === 'cancelled') cancelledLine = { doneUntil: event.done_until }
    queue.push(event)
  })
  child.stdout!.on('data', (d: Buffer) => {
    resetStall()
    if (overflow) return
    overflow = splitter.push(d)
    if (overflow) kill()
  })
  child.stderr!.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_KEEP)
  })

  // stdin: the cancel channel, the audio, or closed.
  child.stdin!.on('error', () => undefined)
  if (opts.stdin === 'none') child.stdin!.end()
  else if (opts.stdin !== 'control') {
    const input = opts.stdin
    input.on('error', () => child.stdin!.end())
    input.pipe(child.stdin!)
  }

  const onAbort = (): void => {
    aborted = true
    if (child.stdin && !child.stdin.destroyed) {
      if (opts.stdin === 'control') child.stdin.write('cancel\n')
      else if (typeof opts.stdin === 'object') opts.stdin.unpipe?.(child.stdin)
      child.stdin.end()
    }
    killTimer = setTimeout(kill, SPEECH_TIMING.cancelGraceMs)
  }
  if (opts.signal.aborted) queueMicrotask(onAbort)
  else opts.signal.addEventListener('abort', onAbort, { once: true })

  const done = new Promise<SpeechExit>((resolve) => {
    child.on('error', (err) => {
      spawnError = err
      opts.onSpawnError?.(err as NodeJS.ErrnoException)
    })
    child.on('close', (code, signal) => {
      if (stallTimer) clearTimeout(stallTimer)
      if (limitTimer) clearTimeout(limitTimer)
      if (killTimer) clearTimeout(killTimer)
      watchdogs.delete(onResume)
      opts.signal.removeEventListener('abort', onAbort)
      live.delete(child)
      opts.processes?.delete(child)
      if (!overflow) splitter.end()
      queue.end()
      const stoppedByApp = aborted || opts.signal.aborted || (opts.processes && opts.owner !== undefined && opts.processes.generation(opts.owner) !== generation)
      // Decided before classifyExit: a run the app aborted or the watchdog killed never looks like a crash.
      if (stoppedByApp) resolve({ kind: 'cancelled', doneUntil: (cancelledLine as { doneUntil: number } | null)?.doneUntil ?? 0 })
      else if (overflow) resolve({ kind: 'protocol', detail: overflow })
      else if (stalled) resolve({ kind: 'stalled' })
      else if (spawnError && code === null && signal === null) resolve({ kind: 'crash', illegalInstruction: false, detail: (spawnError as Error).message })
      else resolve(classifyExit(code, signal, lastError, cancelledLine))
    })
  })

  return {
    events: queue,
    done,
    limit: (ms) => {
      deadline = started + ms
      armLimit()
    },
    stderr: () => stderr
  }
}

/**
 * What an exit means: 0 with a result ok; 2 with a cancelled line cancelled; 1 with an error
 * line that error; STATUS_ILLEGAL_INSTRUCTION (0xC000001D) or SIGILL a crash with
 * illegalInstruction; any other code or signal a crash. Pure. The caller decides first: a run
 * the app aborted (cancel, the editor closed, quitting: the 2 s kill or ProjectProcesses.stop's
 * kill) is 'cancelled' whatever its exit, and a run the watchdog killed is 'stalled'; neither
 * reaches this function, so a kill by the app never looks like a crash. Whether an exit 0
 * carried its result is the caller's to check (no result is a protocol violation).
 */
export function classifyExit(code: number | null, signal: NodeJS.Signals | null, lastError: { code: SidecarErrorCode; message: string } | null, cancelled: { doneUntil: number } | null): SpeechExit {
  // Windows reports NTSTATUS codes as unsigned exit codes; Node may give them signed.
  const unsigned = code === null ? null : code >>> 0
  if (signal === 'SIGILL' || unsigned === STATUS_ILLEGAL_INSTRUCTION) return { kind: 'crash', illegalInstruction: true, detail: signal ?? `exit code 0x${unsigned!.toString(16).toUpperCase()}` }
  if (signal) return { kind: 'crash', illegalInstruction: false, detail: `signal ${signal}` }
  if (code === SIDECAR.exit.ok) return { kind: 'ok' }
  if (code === SIDECAR.exit.cancelled && cancelled) return { kind: 'cancelled', doneUntil: cancelled.doneUntil }
  if (code === SIDECAR.exit.error && lastError) return { kind: 'error', code: lastError.code, message: lastError.message }
  return { kind: 'crash', illegalInstruction: false, detail: unsigned !== null && unsigned > 0xffff ? `exit code 0x${unsigned.toString(16).toUpperCase()}` : `exit code ${code}` }
}

/** Kills every helper at once (the app is quitting). */
export function stopAllSpeech(): void {
  for (const child of live) child.kill('SIGKILL')
  live.clear()
}

/** Whether a helper file exists at `exe` (for the state line). */
export const helperExists = (exe: string): boolean => existsSync(exe)
