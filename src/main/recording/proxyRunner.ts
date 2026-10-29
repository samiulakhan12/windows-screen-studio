import { spawn, type ChildProcess } from 'node:child_process'
import { ffmpegPath } from '../ffmpeg'

export interface FfmpegRun {
  /** Video frames written (from -progress); with a constant rate this is the exact video length. */
  frames: number | null
  /** Size of the first input video stream, from ffmpeg's log. */
  inputSize: { width: number; height: number } | null
  /** Whether the first input has an audio stream. */
  inputHasAudio: boolean
  /** Reading an input failed part-way (READ_ERROR_RE): the output holds only what was read before. */
  readError: boolean
}

/** An ffmpeg failure with a one-line summary; the log, without the input's metadata, goes to the console. */
export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message)
  }
}

/** Error code of an encode stopped on purpose ("Finish later", quitting): never an encoder failure. */
export const CANCELLED = 'CANCELLED'

export const cancelledError = (): FfmpegError => new FfmpegError('Processing was stopped', CANCELLED)

/** True for an encode that was stopped on purpose (see CANCELLED). */
export const isCancelled = (err: unknown): boolean => err instanceof FfmpegError && err.code === CANCELLED

const running = new Set<ChildProcess>()
/** Processes killed on purpose: their exit is reported as CANCELLED, not as a failure. */
const stopped = new WeakSet<ChildProcess>()

function stopProcess(proc: ChildProcess): void {
  stopped.add(proc)
  proc.kill('SIGKILL')
}

/** Stops every proxy encode (used when the app quits during processing). */
export function killAllFfmpeg(): void {
  for (const proc of running) stopProcess(proc)
  running.clear()
}

/**
 * Video frames written, from one `-progress` line. The frame count (not out_time,
 * which can follow the audio stream) is what measures a constant-rate video.
 */
export function parseProgressFrame(line: string): number | null {
  const m = /^frame=\s*(\d+)\s*$/.exec(line.trim())
  return m ? Number(m[1]) : null
}

export function parseInputSize(log: string): { width: number; height: number } | null {
  const input = log.indexOf('Input #0')
  if (input < 0) return null
  const m = /Stream #0:\d+[^\n]*?: Video: [^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(log.slice(input))
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

export function parseInputHasAudio(log: string): boolean {
  const input = log.indexOf('Input #0')
  if (input < 0) return false
  const end = log.indexOf('Input #1', input)
  const section = log.slice(input, end < 0 ? log.indexOf('Output #0', input) : end)
  return /Stream #0:\d+[^\n]*?: Audio: /.test(section)
}

/**
 * ffmpeg's own report of a full disk ("[out#0/mp4 @ …] Error writing trailer: No space left on
 * device"): a message of one of its components, never the input's name or its metadata.
 */
export const DISK_FULL_RE = /^\[[^\]]+\][^\n]*No space left on device/m

/**
 * ffmpeg's report that reading an input failed part-way ("[in#0/mov,mp4,… @ …] Error during
 * demuxing: Input/output error"; 6.1 also logs "Error retrieving a packet from demuxer"): a drive
 * or share that went away, a cloud file whose download failed. ffmpeg then ends that input as if
 * it ended there and exits 0. A damaged file ("Invalid data found…") is not a read error.
 */
export const READ_ERROR_RE = /^\[in#\d+[^\]]*\] Error (?:during demuxing|retrieving a packet from demuxer): (?!Invalid data found)/m

/**
 * The log without its Metadata blocks: the input's tags (a phone video's GPS location, make and
 * model, an author, comments, chapter titles), which an imported file brings along. This is
 * what may be logged or shown: a file's contents are never logged.
 */
export function withoutMetadata(log: string): string {
  // A whole line, up to CR or LF: a tag's U+2028 or U+2029 is not where its line ends.
  return log.replace(/^([ \t]*)Metadata:\r?\n(?:\1[ \t]+[^\r\n]*(?:\r?\n|$))*/gm, '')
}

/** Last meaningful log line, e.g. "Invalid data found when processing input". */
export function summarizeFfmpegLog(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame=|size=|video:|\s*Press \[q\])/.test(l) && !l.startsWith('Conversion failed'))
  const last = lines[lines.length - 1] ?? ''
  return last.replace(/^\[[^\]]+\]\s*/, '').slice(0, 200)
}

/**
 * Runs ffmpeg with `-progress pipe:1` in `args`, reporting the number of video frames written.
 * Aborting `signal` (or killAllFfmpeg) kills the process and rejects with CANCELLED; an
 * already aborted signal rejects at once without starting ffmpeg.
 */
export function runFfmpegProgress(args: string[], onFrames?: (frames: number) => void, signal?: AbortSignal): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError())
      return
    }
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new FfmpegError(String(err), 'ENOENT'))
      return
    }
    running.add(proc)
    const onAbort = (): void => stopProcess(proc)
    signal?.addEventListener('abort', onAbort, { once: true })
    let log = ''
    let pending = ''
    let frames: number | null = null
    proc.stdout?.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const n = parseProgressFrame(line)
        if (n !== null) {
          frames = n
          onFrames?.(n)
        }
      }
    })
    proc.stderr?.on('data', (d: Buffer) => {
      // Keep the head (stream info) and a bounded tail (the error).
      log = log.length < 16000 ? log + d.toString() : log.slice(0, 8000) + log.slice(-7000) + d.toString()
    })
    proc.on('error', (err: NodeJS.ErrnoException) => {
      running.delete(proc)
      signal?.removeEventListener('abort', onAbort)
      reject(stopped.has(proc) ? cancelledError() : new FfmpegError(err.message, err.code ?? null))
    })
    proc.on('close', (code, exitSignal) => {
      running.delete(proc)
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) {
        resolve({ frames, inputSize: parseInputSize(log), inputHasAudio: parseInputHasAudio(log), readError: READ_ERROR_RE.test(log) })
        return
      }
      if (stopped.has(proc)) {
        reject(cancelledError())
        return
      }
      const shown = withoutMetadata(log)
      console.error(`ffmpeg ${args.join(' ')}\nexited with ${exitSignal ?? code}\n${shown}`)
      // The log's last line is then an encoder's statistics ("Qavg: 435.6"), not the reason.
      if (DISK_FULL_RE.test(log)) {
        reject(new FfmpegError('No space left on device', 'ENOSPC'))
        return
      }
      reject(new FfmpegError(exitSignal ? `stopped (${exitSignal})` : summarizeFfmpegLog(shown) || `exit code ${code}`, null))
    })
  })
}
