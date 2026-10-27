/**
 * The speech helper as a child process (docs/design/offline-captions.md §5.3): where it is,
 * which build runs on this processor, spawning it (no shell, stdio pipes only, a minimal
 * environment, below-normal priority), reading its JSON lines with caps, cancelling it
 * ("cancel" line, end of stdin, then a kill after a grace period), a stall watchdog, and what
 * its exit means. Workstream B's own module (it may change): the stubs below find no helper,
 * so nothing runs it yet.
 */
import type { SpeechUnavailable } from '../../shared/api/speech'
import type { SidecarCpu, SidecarErrorCode, SidecarEvent } from '../../shared/speech/protocol'
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
  vadPerSecondMs: 50
} as const

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
  /** 'control' keeps stdin for "cancel"; a stream is piped in as the audio (the speech detector). */
  stdin: 'control' | NodeJS.ReadableStream
  signal: AbortSignal
  stallMs?: number
  /** Overall limit, ms (the speech detector). */
  timeoutMs?: number
  /** Registered here under `owner` (a project id), so stopping the project stops it. */
  processes?: ProjectProcesses
  owner?: string
}

export interface SpeechRun {
  /** Every valid event, in order (invalid lines are dropped; a line or total over the caps ends the run as 'protocol'). */
  events: AsyncIterable<SidecarEvent>
  /** Settles after the process has exited and closed its files. */
  done: Promise<SpeechExit>
}

/**
 * The helper of this build: packaged, process.resourcesPath/native/ssw-speech.exe and
 * ssw-speech-compat.exe and resources/speech/ggml-silero-v6.2.0.bin; in development,
 * native/bin/ssw-speech[.exe] and the repository's resources/speech; SSW_SPEECH_HELPER (a file)
 * replaces the helper only when the app is not packaged. Null when the helper is missing.
 */
export function speechHelperPaths(): SpeechHelperPaths | null {
  return null
}

/** Standard when the processor has everything the standard build is compiled for (SSE4.2, AVX, AVX2, FMA, F16C, BMI2), else compatible. Pure. */
export function chooseBuild(cpu: SidecarCpu | null): 'standard' | 'compatible' {
  return cpu && cpu.sse42 && cpu.avx && cpu.avx2 && cpu.fma && cpu.f16c && cpu.bmi2 ? 'standard' : 'compatible'
}

/** The helper to run (checked once per session with the compatible build's `cpu`). */
export async function selectHelper(): Promise<HelperChoice> {
  return { error: 'missing', detail: 'The speech helper is not part of this build yet.' }
}

/** The standard build hit an illegal instruction: use the compatible one for the rest of the session. */
export function markIllegalInstruction(): void {}

/** Starts the helper `exe` with `args` (never through a shell). */
export function runHelper(exe: string, args: readonly string[], opts: RunOptions): SpeechRun {
  void exe
  void args
  void opts
  throw new Error('runHelper: not implemented yet (workstream B)')
}

/**
 * What an exit means: 0 with a result ok; 2 with a cancelled line cancelled; 1 with an error
 * line that error; STATUS_ILLEGAL_INSTRUCTION (0xC000001D) or SIGILL a crash with
 * illegalInstruction; any other code or signal a crash. Pure. The caller decides first: a run
 * the app aborted (cancel, the editor closed, quitting: the 2 s kill or ProjectProcesses.stop's
 * kill) is 'cancelled' whatever its exit, and a run the watchdog killed is 'stalled'; neither
 * reaches this function, so a kill by the app never looks like a crash.
 */
export function classifyExit(code: number | null, signal: NodeJS.Signals | null, lastError: { code: SidecarErrorCode; message: string } | null, cancelled: { doneUntil: number } | null): SpeechExit {
  void code
  void signal
  void lastError
  void cancelled
  throw new Error('classifyExit: not implemented yet (workstream B)')
}

/** Kills every helper at once (the app is quitting). */
export function stopAllSpeech(): void {}
