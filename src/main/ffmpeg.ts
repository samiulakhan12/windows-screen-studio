import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'

/** Path to the bundled ffmpeg (unpacked from the asar archive in packaged builds). */
export function ffmpegPath(): string {
  const bundled = ffmpegStatic as unknown as string | null
  if (bundled) return bundled.replace('app.asar', 'app.asar.unpacked')
  return 'ffmpeg'
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

/** A running encoder that accepts raw frames on stdin. */
export class FrameEncoder {
  private proc: ChildProcessWithoutNullStreams
  private stderr = ''
  private done: Promise<void>

  constructor(args: string[]) {
    this.proc = spawn(ffmpegPath(), args, { windowsHide: true })
    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000)
    })
    this.done = new Promise((resolve, reject) => {
      this.proc.on('error', reject)
      this.proc.on('close', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(signal ? `ffmpeg was stopped (${signal})` : `ffmpeg exited with code ${code}\n${this.stderr}`))
      })
    })
    // Surface failures through finish(); avoid unhandled rejections meanwhile.
    this.done.catch(() => undefined)
  }

  write(frame: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.proc.exitCode !== null) {
        reject(new Error(`ffmpeg is not running\n${this.stderr}`))
        return
      }
      const ok = this.proc.stdin.write(frame, (err) => {
        if (err) reject(err)
      })
      if (ok) resolve()
      else this.proc.stdin.once('drain', () => resolve())
    })
  }

  finish(): Promise<void> {
    this.proc.stdin.end()
    return this.done
  }

  kill(): void {
    this.proc.stdin.destroy()
    this.proc.kill('SIGKILL')
  }
}
