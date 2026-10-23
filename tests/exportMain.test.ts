import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { clipboardCommand, runClipboardCommand } from '../src/main/exportClipboard'
import { moveIntoPlace, partialPath, renameError, toIpcError, validateJob } from '../src/main/exportJob'
import { FfmpegFailure, FrameEncoder, describeFfmpegError } from '../src/main/ffmpeg'
import type { ExportJob } from '../src/shared/api/export'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-export-main-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const job: ExportJob = {
  width: 1280,
  height: 720,
  fps: 30,
  frames: 90,
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264' },
  outputPath: path.join(dir, 'out.mp4')
}

describe('partialPath', () => {
  it('is a hidden sibling of the target that keeps the extension', () => {
    const p = partialPath('/videos/My clip.mp4')
    expect(path.dirname(p)).toBe('/videos')
    expect(path.basename(p)).toMatch(/^\.My clip\.partial-.+\.mp4$/)
    expect(partialPath('/videos/a.gif')).not.toBe(partialPath('/videos/a.gif'))
  })
})

describe('moveIntoPlace', () => {
  it('replaces an existing target atomically', async () => {
    const target = path.join(dir, 'target.mp4')
    const temp = path.join(dir, '.target.partial.mp4')
    writeFileSync(target, 'old')
    writeFileSync(temp, 'new')
    await moveIntoPlace(temp, target)
    expect(readFileSync(target, 'utf8')).toBe('new')
  })
  it('retries while the file is briefly locked, then gives a readable error', async () => {
    let calls = 0
    const busy = async (): Promise<void> => {
      calls++
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    await expect(moveIntoPlace('a', '/x/Clip.mp4', busy, 1)).rejects.toThrow(/Clip\.mp4.*open in another app/)
    expect(calls).toBe(5)
    let tries = 0
    const flaky = async (): Promise<void> => {
      if (tries++ < 2) throw Object.assign(new Error('perm'), { code: 'EPERM' })
    }
    await moveIntoPlace('a', 'b', flaky, 1)
    expect(tries).toBe(3)
  })
  it('maps other errors without retrying', () => {
    expect(renameError(Object.assign(new Error(''), { code: 'ENOSPC' }), '/a.mp4').message).toBe('The disk is full.')
  })
})

describe('validateJob', () => {
  it('accepts a normal job', () => {
    expect(() => validateJob(job)).not.toThrow()
    expect(() => validateJob({ ...job, video: { kind: 'h264', color: { primaries: 1, transfer: 1, matrix: null, fullRange: null } } })).not.toThrow()
  })
  it('rejects values that could alter the ffmpeg command line', () => {
    expect(() => validateJob({ ...job, video: { kind: 'raw', encoder: '-f' as never } })).toThrow()
    expect(() => validateJob({ ...job, width: 1281 })).toThrow()
    expect(() => validateJob({ ...job, quality: 'x' as never })).toThrow()
    expect(() => validateJob({ ...job, audio: { volume: 1, clips: [{ id: 'a', start: 2, end: 1, speed: 1 }] } })).toThrow()
    expect(() => validateJob({ ...job, audio: { volume: 1, clips: [{ id: 'a', start: 0, end: 1, speed: 100 }] } })).toThrow()
    expect(() => validateJob({ ...job, format: 'gif', video: { kind: 'h264', color: { primaries: 1, transfer: 1, matrix: 1, fullRange: false } } })).toThrow()
  })
})

describe('toIpcError', () => {
  it('puts the readable reason first and the ffmpeg log after a blank line', () => {
    expect(toIpcError(new FfmpegFailure('The disk is full.', 'ffmpeg exited with code 1\n...')).message).toBe('The disk is full.\n\nffmpeg exited with code 1\n...')
    expect(toIpcError(new FfmpegFailure('The export was cancelled.', 'cancelled')).message).toBe('The export was cancelled.')
  })
  it('recognises common ffmpeg failures', () => {
    expect(describeFfmpegError('av_interleaved_write_frame(): No space left on device')).toBe('The disk is full.')
    expect(describeFfmpegError('out.mp4: Permission denied')).toMatch(/permission/)
    expect(describeFfmpegError('something odd')).toMatch(/stopped unexpectedly/)
  })
})

describe('FrameEncoder with a dead ffmpeg (F08)', () => {
  const frame = new Uint8Array(1280 * 720 * 4)

  it('rejects writes with the reason from the log instead of throwing EPIPE', async () => {
    // Writing into a directory that does not exist: ffmpeg exits at once.
    const enc = new FrameEncoder(['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1280x720', '-i', 'pipe:0', '-f', 'mp4', path.join(dir, 'missing', 'x.mp4')])
    let error: unknown = null
    for (let i = 0; i < 50 && !error; i++) {
      try {
        await enc.write(frame)
      } catch (e) {
        error = e
      }
    }
    expect(error).toBeInstanceOf(FfmpegFailure)
    expect((error as Error).message).toMatch(/missing/i)
    await expect(enc.finish()).rejects.toBeInstanceOf(FfmpegFailure)
  })

  it('reports a kill as a cancellation, also while finishing', async () => {
    const enc = new FrameEncoder(['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1280x720', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryslow', '-f', 'mp4', path.join(dir, 'k.mp4')])
    await enc.write(frame)
    const finishing = enc.finish()
    enc.kill()
    await expect(finishing).rejects.toThrow(/cancelled/)
    await expect(enc.write(frame)).rejects.toBeInstanceOf(FfmpegFailure)
  })

  it('encodes normally when ffmpeg is healthy', async () => {
    const out = path.join(dir, 'ok.mp4')
    const enc = new FrameEncoder(['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1280x720', '-framerate', '30', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mp4', out])
    for (let i = 0; i < 10; i++) await enc.write(frame)
    await enc.finish()
    expect(readFileSync(out).length).toBeGreaterThan(1000)
  })
})

describe('clipboardCommand', () => {
  const file = 'C:\\Users\\me\\Videos\\a "quoted" $(name) `x`.mp4'
  it('Windows: PowerShell Set-Clipboard with the path passed as data, never inside the script', () => {
    const cmd = clipboardCommand('win32', file, { SystemRoot: 'C:\\Windows' }, () => false)!
    expect(cmd.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(cmd.args.join(' ')).toContain('Set-Clipboard -LiteralPath $env:SSW_CLIPBOARD_FILE')
    expect(cmd.args.join(' ')).not.toContain('quoted')
    expect(cmd.env).toEqual({ SSW_CLIPBOARD_FILE: file })
  })
  it('Linux: a text/uri-list file URL through xclip or wl-copy', () => {
    const x = clipboardCommand('linux', '/home/me/My clip #1.mp4', {}, (t) => t === 'xclip')!
    expect(x.command).toBe('xclip')
    expect(x.args).toEqual(['-selection', 'clipboard', '-t', 'text/uri-list', '-i'])
    expect(x.input).toBe('file:///home/me/My%20clip%20%231.mp4\r\n')
    const w = clipboardCommand('linux', '/a.mp4', { WAYLAND_DISPLAY: 'wayland-0' }, () => true)!
    expect(w.command).toBe('wl-copy')
    expect(w.args).toEqual(['--type', 'text/uri-list'])
  })
  it('Linux without a clipboard tool: unsupported', () => {
    expect(clipboardCommand('linux', '/a.mp4', {}, () => false)).toBeNull()
  })
  it('macOS: the path is an osascript argument', () => {
    const cmd = clipboardCommand('darwin', '/a b.mp4', {}, () => false)!
    expect(cmd.command).toBe('osascript')
    expect(cmd.args.at(-1)).toBe('/a b.mp4')
  })
})

describe('runClipboardCommand', () => {
  it('feeds the input and succeeds on exit code 0', async () => {
    const sink = path.join(dir, 'clip.txt')
    const script = `require('fs').writeFileSync(${JSON.stringify(sink)}, require('fs').readFileSync(0, 'utf8') + process.env.EXTRA)`
    const r = await runClipboardCommand({ command: process.execPath, args: ['-e', script], input: 'file:///a.mp4\r\n', env: { EXTRA: '!' } })
    expect(r).toEqual({ ok: true })
    expect(readFileSync(sink, 'utf8')).toBe('file:///a.mp4\r\n!')
  })
  it('reports failures with the tool output', async () => {
    const r = await runClipboardCommand({ command: process.execPath, args: ['-e', "console.error('no display'); process.exit(3)"] })
    expect(r).toEqual({ ok: false, message: 'Could not copy to the clipboard: no display' })
    const missing = await runClipboardCommand({ command: path.join(dir, 'nope'), args: [] })
    expect(missing.ok).toBe(false)
  })
})
