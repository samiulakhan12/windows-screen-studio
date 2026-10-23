import { spawn, type ChildProcess } from 'node:child_process'
import { ffmpegPath } from '../ffmpeg'

export interface FfmpegRun {
  /** Video frames written (from -progress); with a constant rate this is the exact video length. */
  frames: number | null
  /** Size of the first input video stream, from ffmpeg's log. */
  inputSize: { width: number; height: number } | null
  /** Whether the first input has an audio stream. */
  inputHasAudio: boolean
}

/** An ffmpeg failure with a one-line summary; the full log goes to the console. */
export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message)
  }
}

const running = new Set<ChildProcess>()

/** Stops every proxy encode (used when the user quits during processing). */
export function killAllFfmpeg(): void {
  for (const proc of running) proc.kill('SIGKILL')
  running.clear()
}

/**
 * Media time from one `-progress` line. ffmpeg's out_time_ms is (despite its name)
 * in microseconds too. With several streams it can follow the audio, so the video
 * frame count is what measures the video.
 */
export function parseProgressTime(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)\s*$/.exec(line.trim())
  return m ? Number(m[1]) / 1e6 : null
}

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

/** Last meaningful log line, e.g. "Invalid data found when processing input". */
export function summarizeFfmpegLog(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame=|size=|video:|\s*Press \[q\])/.test(l) && !l.startsWith('Conversion failed'))
  const last = lines[lines.length - 1] ?? ''
  return last.replace(/^\[[^\]]+\]\s*/, '').slice(0, 200)
}

/** Runs ffmpeg with `-progress pipe:1` in `args`, reporting the number of video frames written. */
export function runFfmpegProgress(args: string[], onFrames?: (frames: number) => void): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new FfmpegError(String(err), 'ENOENT'))
      return
    }
    running.add(proc)
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
      reject(new FfmpegError(err.message, err.code ?? null))
    })
    proc.on('close', (code, signal) => {
      running.delete(proc)
      if (code === 0) {
        resolve({ frames, inputSize: parseInputSize(log), inputHasAudio: parseInputHasAudio(log) })
        return
      }
      console.error(`ffmpeg ${args.join(' ')}\nexited with ${signal ?? code}\n${log}`)
      reject(new FfmpegError(signal ? `stopped (${signal})` : summarizeFfmpegLog(log) || `exit code ${code}`, null))
    })
  })
}
