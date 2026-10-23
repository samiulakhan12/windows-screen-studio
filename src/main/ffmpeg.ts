import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'

/** Path to the bundled ffmpeg (unpacked from the asar archive in packaged builds). */
export function ffmpegPath(): string {
  const bundled = ffmpegStatic as unknown as string | null
  if (bundled) return bundled.replace('app.asar', 'app.asar.unpacked')
  return 'ffmpeg'
}

/** An ffmpeg failure: `message` is short and readable, `detail` holds the end of ffmpeg's log. */
export class FfmpegFailure extends Error {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message)
    this.name = 'FfmpegFailure'
  }
}

const KNOWN_ERRORS: [RegExp, string][] = [
  [/No space left on device|ENOSPC/i, 'The disk is full.'],
  [/Permission denied|EACCES|EPERM/i, 'Could not write to that folder (permission denied).'],
  [/Device or resource busy|EBUSY|being used by another process/i, 'The file is in use by another app.'],
  [/No such file or directory/i, 'A file the export needs is missing.'],
  [/Cannot allocate memory|out of memory/i, 'The computer ran out of memory.'],
  [/Invalid data found when processing input/i, 'The recording could not be read (it may be damaged).']
]

/** Short, user-facing reason for an ffmpeg failure, from its log. */
export function describeFfmpegError(stderr: string, fallback = 'The video encoder stopped unexpectedly.'): string {
  for (const [re, text] of KNOWN_ERRORS) if (re.test(stderr)) return text
  return fallback
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`))
    })
  })
}

export interface FfmpegRun {
  done: Promise<void>
  kill(): void
}

/** Runs ffmpeg to completion; `kill()` stops it (the promise then rejects). */
export function startFfmpeg(args: string[]): FfmpegRun {
  let proc: ChildProcess | null = null
  let stderr = ''
  const done = new Promise<void>((resolve, reject) => {
    proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    proc.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    proc.on('error', (e) => reject(new FfmpegFailure('Could not start the video encoder.', e.message)))
    proc.on('close', (code, signal) => {
      if (code === 0) resolve()
      else if (signal) reject(new FfmpegFailure('The video encoder was stopped.', `ffmpeg stopped (${signal})\n${stderr}`))
      else reject(new FfmpegFailure(describeFfmpegError(stderr), `ffmpeg exited with code ${code}\n${stderr}`))
    })
  })
  done.catch(() => undefined)
  return { done, kill: () => proc?.kill('SIGKILL') }
}

/**
 * A running encoder that accepts data (raw frames or an encoded stream) on stdin.
 * A dead encoder never throws into the main process: writes reject with the reason
 * ffmpeg gave, taken from its log.
 */
export class FrameEncoder {
  private readonly proc: ChildProcessWithoutNullStreams
  private stderr = ''
  private stdinError: Error | null = null
  private killed = false
  readonly done: Promise<void>

  constructor(args: string[]) {
    this.proc = spawn(ffmpegPath(), args, { windowsHide: true })
    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000)
    })
    // Without a listener, EPIPE after ffmpeg exits would be an uncaught exception.
    this.proc.stdin.on('error', (e) => {
      this.stdinError = e
    })
    this.done = new Promise((resolve, reject) => {
      this.proc.on('error', (e) => reject(new FfmpegFailure('Could not start the video encoder.', e.message)))
      this.proc.on('close', (code, signal) => {
        if (code === 0) resolve()
        else if (this.killed) reject(new FfmpegFailure('The export was cancelled.', 'cancelled'))
        else if (signal) reject(new FfmpegFailure('The video encoder stopped unexpectedly.', `ffmpeg was stopped (${signal})\n${this.stderr}`))
        else reject(new FfmpegFailure(describeFfmpegError(this.stderr), `ffmpeg exited with code ${code}\n${this.stderr}`))
      })
    })
    // Failures surface through write()/finish(); avoid unhandled rejections meanwhile.
    this.done.catch(() => undefined)
  }

  private get dead(): boolean {
    const p = this.proc
    return !!this.stdinError || p.exitCode !== null || p.signalCode !== null || p.stdin.destroyed || !p.stdin.writable
  }

  /** The encoder's own failure, or `fallback` if it somehow exited cleanly. */
  private failure(fallback: Error): Promise<never> {
    return this.done.then(
      () => {
        throw new FfmpegFailure('The video encoder finished early.', fallback.message)
      },
      (e: unknown) => {
        throw e
      }
    )
  }

  write(data: Uint8Array): Promise<void> {
    if (this.dead) return this.failure(this.stdinError ?? new Error('ffmpeg is not running'))
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }
      const ok = this.proc.stdin.write(data, (err) => {
        if (err) settle(() => this.failure(err).catch(reject))
      })
      if (ok) {
        settle(resolve)
        return
      }
      // Wait for the pipe to drain, but never past the process exiting.
      const onDrain = (): void => {
        cleanup()
        settle(resolve)
      }
      const onClose = (): void => {
        cleanup()
        settle(() => this.failure(new Error('ffmpeg exited')).catch(reject))
      }
      const cleanup = (): void => {
        this.proc.stdin.off('drain', onDrain)
        this.proc.off('close', onClose)
      }
      this.proc.stdin.once('drain', onDrain)
      this.proc.once('close', onClose)
    })
  }

  finish(): Promise<void> {
    if (!this.proc.stdin.destroyed) this.proc.stdin.end()
    return this.done
  }

  kill(): void {
    this.killed = true
    this.proc.stdin.destroy()
    this.proc.kill('SIGKILL')
  }
}
