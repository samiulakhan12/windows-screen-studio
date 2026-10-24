// "Finish later" (audit-A-1 / audit-C-1 / seams-1): stopping processing must stop it for
// good, whatever the encoder list, and must never produce a project without its camera.
// The real processRecording runs against a scripted ffmpeg runner and encoder probe.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FfmpegRun } from '../src/main/recording/proxyRunner'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => root.dir } }))

const probe = vi.hoisted(() => ({ encoders: ['h264_nvenc'] as string[] }))
vi.mock('../src/main/hwEncoders', () => ({ detectH264Encoders: async () => probe.encoders }))

type Step = (args: string[], signal: AbortSignal | undefined) => Promise<FfmpegRun>
const runner = vi.hoisted(() => ({ calls: [] as string[][], steps: [] as Step[] }))
vi.mock('../src/main/recording/proxyRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/recording/proxyRunner')>()
  return {
    ...actual,
    runFfmpegProgress: (args: string[], _onFrames?: (n: number) => void, signal?: AbortSignal) => {
      // Like the real runner: an already stopped run never starts.
      if (signal?.aborted) return Promise.reject(actual.cancelledError())
      runner.calls.push(args)
      const step = runner.steps.shift()
      if (!step) throw new Error('unexpected ffmpeg run')
      return step(args, signal)
    }
  }
})

// Matching stems with the mixed sound decodes real audio; here it reports a fixed correction.
const align = vi.hoisted(() => ({ lag: 0.004 }))
vi.mock('../src/main/recording/stemAlign', () => ({ measureStemLag: async () => align.lag }))

import * as projects from '../src/main/projects'
import { processRecording } from '../src/main/recording/finalize'
import { expectedStems, setExpectedStems, settleStems } from '../src/main/recording/stems'
import type { StemKind } from '../src/shared/audio/settings'
import { cancelledError, FfmpegError, isCancelled } from '../src/main/recording/proxyRunner'

const T0 = 1_700_000_000_000
const done = (frames = 120): FfmpegRun => ({ frames, inputSize: { width: 320, height: 240 }, inputHasAudio: false })
const output = (args: string[]): string => args[args.length - 1]

/** Encodes "successfully": writes the output file and reports `frames`. */
const succeed =
  (frames = 120): Step =>
  async (args) => {
    writeFileSync(output(args), 'proxy')
    return done(frames)
  }

/** Runs until stopped, like ffmpeg killed by "Finish later" (writes a partial file first). */
const runUntilStopped: Step = (args, signal) =>
  new Promise((_resolve, reject) => {
    writeFileSync(output(args), 'partial')
    signal?.addEventListener('abort', () => reject(cancelledError()), { once: true })
  })

async function setup(over: Partial<projects.RecordingManifest> = {}): Promise<{ m: projects.RecordingManifest; dir: string }> {
  root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-later-'))
  const { id, dir } = await projects.createProjectDir(new Date(T0))
  const m: projects.RecordingManifest = {
    version: 1,
    id,
    createdAt: new Date(T0).toISOString(),
    status: 'processing',
    error: null,
    method: 'chromium',
    sourceKind: 'screen',
    region: null,
    startedAt: T0,
    width: 320,
    height: 240,
    hasAudio: false,
    hasWebcam: false,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    duration: 2,
    ...over
  }
  writeFileSync(path.join(dir, m.method === 'native' ? 'native.mp4' : 'screen.webm'), 'raw video')
  if (m.hasWebcam) writeFileSync(path.join(dir, 'webcam.webm'), 'raw camera')
  if (m.method === 'native' && m.hasAudio) writeFileSync(path.join(dir, 'audio.webm'), 'raw audio')
  await projects.writeManifest(m)
  return { m, dir }
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(cond()).toBe(true)
}

/** The recording is left exactly as "Unfinished recordings" needs it. */
async function expectKeptForLater(m: projects.RecordingManifest, dir: string, raw: string[]): Promise<void> {
  expect(existsSync(path.join(dir, 'project.json'))).toBe(false)
  expect(existsSync(path.join(dir, 'recording.json'))).toBe(true)
  for (const f of raw) expect(existsSync(path.join(dir, f)), `${f} kept`).toBe(true)
  for (const f of ['screen.mp4', 'webcam.mp4', 'screen.video.mp4']) expect(existsSync(path.join(dir, f)), `${f} removed`).toBe(false)
  const unfinished = await projects.listUnfinished(new Set())
  expect(unfinished.map((u) => u.id)).toEqual([m.id])
}

beforeEach(() => {
  runner.calls = []
  runner.steps = []
  probe.encoders = ['h264_nvenc']
})

describe('Finish later', () => {
  it('stops a GPU encode for good instead of restarting it in software', async () => {
    const { m, dir } = await setup()
    runner.steps = [runUntilStopped, succeed()]
    const abort = new AbortController()
    const run = processRecording(m, () => undefined, abort.signal)
    await until(() => runner.calls.length === 1)
    expect(runner.calls[0]).toContain('h264_nvenc')
    abort.abort()
    const err = await run.catch((e: unknown) => e)
    expect(isCancelled(err)).toBe(true)
    // One encode only: the stop was not taken for a GPU failure.
    expect(runner.calls).toHaveLength(1)
    await expectKeptForLater(m, dir, ['screen.webm'])
  })

  it('never saves the project without its camera when stopped during "Optimising camera…"', async () => {
    const { m, dir } = await setup({ hasWebcam: true })
    runner.steps = [succeed(), runUntilStopped, succeed()]
    const abort = new AbortController()
    const run = processRecording(m, () => undefined, abort.signal)
    await until(() => runner.calls.length === 2)
    expect(output(runner.calls[1])).toMatch(/webcam\.mp4$/)
    abort.abort()
    expect(isCancelled(await run.catch((e: unknown) => e))).toBe(true)
    expect(runner.calls).toHaveLength(2)
    await expectKeptForLater(m, dir, ['screen.webm', 'webcam.webm'])
  })

  it('stops between steps (a stop that lands after one encode finished)', async () => {
    const { m, dir } = await setup({ hasWebcam: true })
    const abort = new AbortController()
    runner.steps = [
      async (args) => {
        writeFileSync(output(args), 'proxy')
        abort.abort() // pressed just as the screen proxy completed
        return done()
      }
    ]
    expect(isCancelled(await processRecording(m, () => undefined, abort.signal).catch((e: unknown) => e))).toBe(true)
    expect(runner.calls).toHaveLength(1)
    await expectKeptForLater(m, dir, ['screen.webm', 'webcam.webm'])
  })

  it('stops while the native audio is being added', async () => {
    const { m, dir } = await setup({ method: 'native', hasAudio: true, audioOffset: 0.1 })
    runner.steps = [succeed(), runUntilStopped]
    const abort = new AbortController()
    const run = processRecording(m, () => undefined, abort.signal)
    await until(() => runner.calls.length === 2)
    expect(runner.calls[1]).toContain('copy')
    abort.abort()
    expect(isCancelled(await run.catch((e: unknown) => e))).toBe(true)
    await expectKeptForLater(m, dir, ['native.mp4', 'audio.webm'])
  })

  it('treats any run that ends after the stop as stopped, even with a plain signal error', async () => {
    const { m } = await setup()
    const abort = new AbortController()
    runner.steps = [
      (args) =>
        new Promise((_resolve, reject) => {
          writeFileSync(output(args), 'partial')
          abort.signal.addEventListener('abort', () => reject(new FfmpegError('stopped (SIGKILL)', null)))
        }),
      succeed()
    ]
    const run = processRecording(m, () => undefined, abort.signal)
    await until(() => runner.calls.length === 1)
    abort.abort()
    expect(isCancelled(await run.catch((e: unknown) => e))).toBe(true)
    expect(runner.calls).toHaveLength(1)
  })
})

describe('encoder fallback still works for real failures', () => {
  it('retries a failing GPU encode in software and builds the project', async () => {
    const { m, dir } = await setup()
    runner.steps = [async () => Promise.reject(new FfmpegError('Error while opening encoder', null)), succeed(150)]
    const project = await processRecording(m, () => undefined)
    expect(runner.calls.map((a) => a[a.indexOf('-c:v') + 1])).toEqual(['h264_nvenc', 'libx264'])
    expect(project.duration).toBeCloseTo(2.5)
    expect(existsSync(path.join(dir, 'project.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'recording.json'))).toBe(false)
  })

  it('adds native audio in a second step, cut to the video frame count', async () => {
    const { m } = await setup({ method: 'native', hasAudio: true, audioOffset: 0.25 })
    runner.steps = [succeed(150), succeed(150)]
    const project = await processRecording(m, () => undefined)
    const [video, mux] = runner.calls
    expect(output(video)).toMatch(/screen\.video\.mp4$/)
    expect(video).toContain('-an')
    expect(mux[mux.indexOf('-af') + 1]).toBe('adelay=250:all=1,apad,atrim=end=2.500000')
    expect(output(mux)).toMatch(/screen\.mp4$/)
    expect(project.duration).toBeCloseTo(2.5)
    expect(project.hasAudio).toBe(true)
  })
})

describe('microphone and system sound kept on their own (stems)', () => {
  /** A recording whose recorder started `expected` stems, with raw files for `files`. */
  const withStems = async (
    over: Partial<projects.RecordingManifest> = {},
    expected: StemKind[] = ['mic', 'system'],
    files: StemKind[] = expected
  ): Promise<{ m: projects.RecordingManifest; dir: string }> => {
    const r = await setup({ hasAudio: true, ...over })
    setExpectedStems(r.m, expected)
    for (const kind of files) writeFileSync(path.join(r.dir, `${kind}.webm`), `raw ${kind}`)
    return r
  }
  const noStemFiles = (dir: string): void => {
    for (const f of ['mic.webm', 'system.webm', 'mic.m4a', 'system.m4a']) expect(existsSync(path.join(dir, f)), `${f} removed`).toBe(false)
  }
  const audioDone = (frames = 150): Step => async (args) => {
    writeFileSync(output(args), 'proxy')
    return { ...done(frames), inputHasAudio: true }
  }

  it('turns each into an m4a on the video timeline, lined up with the mixed sound, cut to its frame count, and lists them in the project', async () => {
    const { m, dir } = await withStems({ audioOffset: 0.02 })
    runner.steps = [audioDone(150), succeed(), succeed()]
    const project = await processRecording(m, () => undefined)
    const [, mic, system] = runner.calls
    expect(mic[mic.indexOf('-i') + 1]).toMatch(/mic\.webm$/)
    // The timestamps' 20 ms plus the 4 ms the sound itself showed.
    expect(mic[mic.indexOf('-af') + 1]).toBe('adelay=24:all=1,apad,atrim=end=2.500000')
    expect(output(mic)).toMatch(/mic\.m4a$/)
    expect(output(system)).toMatch(/system\.m4a$/)
    expect(project.audioStems).toEqual({ mic: true, system: true })
    for (const f of ['mic.webm', 'system.webm']) expect(existsSync(path.join(dir, f)), `${f} removed`).toBe(false)
    expect(existsSync(path.join(dir, 'mic.m4a'))).toBe(true)
  })

  it('lists a source that was not captured as missing (only a microphone)', async () => {
    const { m, dir } = await withStems({}, ['mic'])
    runner.steps = [audioDone(), succeed()]
    const project = await processRecording(m, () => undefined)
    expect(project.audioStems).toEqual({ mic: true, system: false })
    expect(existsSync(path.join(dir, 'mic.m4a'))).toBe(true)
  })

  it('keeps no stem when one cannot be converted: the recording keeps its mixed sound, every source in it', async () => {
    // The first one fails.
    const first = await withStems()
    runner.steps = [audioDone(), async () => Promise.reject(new FfmpegError('Invalid data found when processing input', null))]
    let project = await processRecording(first.m, () => undefined)
    expect(project.hasAudio).toBe(true)
    expect(project.audioStems).toBeUndefined()
    expect(runner.calls).toHaveLength(2)
    noStemFiles(first.dir)
    // The second one fails after the first was converted.
    runner.calls = []
    const second = await withStems()
    runner.steps = [audioDone(), succeed(), async () => Promise.reject(new FfmpegError('Invalid data found when processing input', null))]
    project = await processRecording(second.m, () => undefined)
    expect(project.audioStems).toBeUndefined()
    noStemFiles(second.dir)
  })

  it('keeps no stem when one was not recorded (it could not start, or stopped early and was discarded)', async () => {
    const { m, dir } = await withStems({}, ['mic', 'system'], ['mic'])
    runner.steps = [audioDone()]
    const project = await processRecording(m, () => undefined)
    expect(project.audioStems).toBeUndefined()
    expect(runner.calls).toHaveLength(1)
    noStemFiles(dir)
  })

  it('keeps no stem the manifest does not expect (none started, or one was dropped while recording)', async () => {
    const { m, dir } = await withStems({}, [], ['mic', 'system'])
    runner.steps = [audioDone()]
    expect((await processRecording(m, () => undefined)).audioStems).toBeUndefined()
    expect(runner.calls).toHaveLength(1)
    noStemFiles(dir)
  })

  it('no stems for a recording whose sound is gone, and none in older recordings', async () => {
    const silent = await withStems()
    runner.steps = [succeed()]
    expect((await processRecording(silent.m, () => undefined)).audioStems).toBeUndefined()
    const older = await setup({ hasAudio: true })
    runner.steps = [audioDone()]
    expect((await processRecording(older.m, () => undefined)).audioStems).toBeUndefined()
  })

  it('"Finish later" while the stems are converted keeps everything for later', async () => {
    const { m, dir } = await withStems()
    runner.steps = [audioDone(), runUntilStopped, succeed()]
    const abort = new AbortController()
    const run = processRecording(m, () => undefined, abort.signal)
    await until(() => runner.calls.length === 2)
    abort.abort()
    expect(isCancelled(await run.catch((e: unknown) => e))).toBe(true)
    expect(runner.calls).toHaveLength(2)
    await expectKeptForLater(m, dir, ['screen.webm', 'mic.webm', 'system.webm'])
    expect(existsSync(path.join(dir, 'mic.m4a'))).toBe(false)
  })
})

describe('stems settled on stop', () => {
  it('keeps every expected stem only when all were recorded to the end', async () => {
    const write = async (expected: unknown): Promise<{ m: projects.RecordingManifest; dir: string }> => {
      const r = await setup({ hasAudio: true })
      setExpectedStems(r.m, expected)
      for (const f of ['mic.webm', 'system.webm']) writeFileSync(path.join(r.dir, f), 'raw')
      return r
    }
    const all = await write(['mic', 'system'])
    expect(await settleStems(all.m, all.dir, ['system', 'mic'])).toEqual(['mic', 'system'])
    expect(expectedStems(all.m)).toEqual(['mic', 'system'])
    expect(existsSync(path.join(all.dir, 'mic.webm')) && existsSync(path.join(all.dir, 'system.webm'))).toBe(true)

    const one = await write(['mic', 'system'])
    expect(await settleStems(one.m, one.dir, ['mic'])).toEqual([])
    expect(expectedStems(one.m)).toEqual([])
    for (const f of ['mic.webm', 'system.webm']) expect(existsSync(path.join(one.dir, f)), `${f} removed`).toBe(false)

    // Only the microphone was captured; unknown or repeated kinds are ignored.
    const mic = await write(['mic', 'mic', 'camera'])
    expect(expectedStems(mic.m)).toEqual(['mic'])
    expect(await settleStems(mic.m, mic.dir, ['mic', 'bogus'])).toEqual(['mic'])
    expect(existsSync(path.join(mic.dir, 'system.webm'))).toBe(false)

    // Older recorders and manifests say nothing: nothing is kept.
    const older = await write(undefined)
    expect(await settleStems(older.m, older.dir, undefined)).toEqual([])
    expect(expectedStems({ ...older.m, stems: 'mic' } as projects.RecordingManifest)).toEqual([])
  })
})
