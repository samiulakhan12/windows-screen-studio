import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { CANCELLED, isCancelled, killAllFfmpeg, runFfmpegProgress } from '../src/main/recording/proxyRunner'

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

  it('a real ffmpeg failure is not a cancel', async () => {
    const err = await runFfmpegProgress(['-hide_banner', '-i', '/nonexistent/input.webm', '-progress', 'pipe:1', '-f', 'null', '-']).catch((e: unknown) => e)
    expect(isCancelled(err)).toBe(false)
  })
})
