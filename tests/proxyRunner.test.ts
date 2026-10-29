import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { CANCELLED, DISK_FULL_RE, FfmpegError, isCancelled, killAllFfmpeg, READ_ERROR_RE, runFfmpegProgress } from '../src/main/recording/proxyRunner'

const ffmpeg = ffmpegPath()
const haveFfmpeg = ffmpeg !== 'ffmpeg' && existsSync(ffmpeg)

/** A real-time encode that would run for half a minute. */
const slowArgs = ['-hide_banner', '-re', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=30', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-']

describe.skipIf(!haveFfmpeg)('runFfmpegProgress stopping (real ffmpeg)', () => {
  it('reports a stop on purpose as CANCELLED, not as a failure', async () => {
    const abort = new AbortController()
    let frames = 0
    const run = runFfmpegProgress(slowArgs, (n) => {
      frames = n
      if (n > 0) abort.abort()
    }, abort.signal)
    const t0 = Date.now()
    const err = await run.catch((e: unknown) => e)
    expect(isCancelled(err)).toBe(true)
    expect((err as { code: string }).code).toBe(CANCELLED)
    expect(frames).toBeGreaterThan(0)
    expect(Date.now() - t0).toBeLessThan(10000)
  }, 20000)

  it('never starts once stopped', async () => {
    const abort = new AbortController()
    abort.abort()
    let progressed = false
    const err = await runFfmpegProgress(slowArgs, () => void (progressed = true), abort.signal).catch((e: unknown) => e)
    expect(isCancelled(err)).toBe(true)
    expect(progressed).toBe(false)
  })

  it('killAllFfmpeg (quitting) also counts as a stop', async () => {
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    const run = runFfmpegProgress(slowArgs, () => started())
    await running
    killAllFfmpeg()
    expect(isCancelled(await run.catch((e: unknown) => e))).toBe(true)
  }, 20000)

  it.skipIf(!existsSync('/dev/full'))('names a full disk, whatever the last line of the log', async () => {
    // With sound, the log ends with the AAC encoder's statistics ("Qavg: …").
    const args = ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', '/dev/full']
    const err = await runFfmpegProgress(args).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FfmpegError)
    expect(err).toMatchObject({ code: 'ENOSPC', message: 'No space left on device' })
  })

  // Reading /proc/self/mem at offset 0 fails with EIO: a drive that fails half-way through a file.
  it.skipIf(!existsSync('/proc/self/mem'))('reports an input that could not be read to the end, though ffmpeg exits cleanly', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-readerr-'))
    try {
      const whole = path.join(dir, 'whole.mkv')
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=4', '-c:v', 'libx264', whole])
      const half = path.join(dir, 'half.mkv')
      const bytes = readFileSync(whole)
      writeFileSync(half, bytes.subarray(0, bytes.length >> 1))
      const run = (input: string): Promise<{ readError: boolean; frames: number | null }> =>
        runFfmpegProgress(['-hide_banner', '-i', input, '-c:v', 'libx264', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'])
      // A file that simply ends there (cut short, damaged) is not a read error.
      expect(await run(half)).toMatchObject({ readError: false })
      expect(await run(whole)).toMatchObject({ readError: false })
      const failed = await run(`concat:${half}|/proc/self/mem`)
      expect(failed.readError).toBe(true)
      expect(failed.frames).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  it('a real ffmpeg failure is not a cancel', async () => {
    const err = await runFfmpegProgress(['-hide_banner', '-i', '/nonexistent/input.webm', '-progress', 'pipe:1', '-f', 'null', '-']).catch((e: unknown) => e)
    expect(isCancelled(err)).toBe(false)
  })
})

describe('a full disk in the log', () => {
  it('is found in the messages of the ffmpeg components only', () => {
    expect(DISK_FULL_RE.test('[out#0/mp4 @ 0x3eaf8c80] Error writing trailer: No space left on device\n[aac @ 0x3eafe600] Qavg: 104.259')).toBe(true)
    expect(DISK_FULL_RE.test('[vost#0:0/libx264 @ 0x55ea27533e40] Error submitting a packet to the muxer: No space left on device')).toBe(true)
    // The input's name or its metadata.
    expect(DISK_FULL_RE.test("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:\\No space left on device.mp4':")).toBe(false)
    expect(DISK_FULL_RE.test('    title           : No space left on device')).toBe(false)
  })
})

describe('a read error in the log', () => {
  it('is an input that failed part-way, never a damaged file or a name', () => {
    // The bundled 7.0 build, and 6.1, which logs a second line.
    expect(READ_ERROR_RE.test('[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0x24be2840] Error during demuxing: Input/output error\n[out#0/mp4 @ 0x24c4] video:1kB')).toBe(true)
    expect(READ_ERROR_RE.test('[h264 @ 0x558d] Error splitting the input into NAL units.\n[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0x558db70fd7c0] Error retrieving a packet from demuxer: Input/output error')).toBe(true)
    // Windows maps a dropped network share to EINVAL.
    expect(READ_ERROR_RE.test('[in#0/matroska,webm @ 0000020c5e3f4a40] Error during demuxing: Invalid argument')).toBe(true)
    // A damaged file keeps importing what can be read.
    expect(READ_ERROR_RE.test('[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0x24be2840] Error during demuxing: Invalid data found when processing input')).toBe(false)
    expect(READ_ERROR_RE.test('[vist#0:0/h264 @ 0x24c1c5c0] [dec:h264 @ 0x24c69040] Decoding error: Input/output error')).toBe(false)
    expect(READ_ERROR_RE.test("Input #0, matroska,webm, from 'C:\\[in#0] Error during demuxing: x.mkv':")).toBe(false)
    expect(READ_ERROR_RE.test('    title           : [in#0/mov @ 1] Error during demuxing: Input/output error')).toBe(false)
  })
})
