/**
 * Tests 42 and 44 (docs/design/output-and-languages.md §23.1, §8.1, §8.7, §18.3), with test 39's file
 * names: main copies the recordings for "The original recordings" (copies, never links; remuxes
 * without sound; WAV through ffmpeg; Clean voice's file; Music and Effects only when stems are off;
 * free space first; project files only read) and writes the timeline files only for a request it
 * can trust and a plan that agrees with the files. Media are made by the bundled ffmpeg.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportJob, TimelineRequest } from '../src/shared/api/export'
import { t } from '../src/shared/i18n/t'
import { PLAN_LIMITS } from '../src/shared/interchange/planCheck'
import { exportTimeline, recordingsTimeline, type TimelinePlan } from '../src/shared/interchange/timelinePlan'
import { parseProbe } from '../src/shared/import/probe'
import { parseXml } from './strictXml'
import { timelineProject } from './timelineFixtures'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => tmpdir(), on: vi.fn() } }))
vi.mock('../src/main/exportIpc', () => ({ isExportedFile: () => false }))
vi.mock('../src/main/voice/voiceIpc', () => ({ voiceCleaner: { ensure: vi.fn() } }))

const { copyRecordings, RECORDING_FILES, timelinePaths, writeTimeline } = await import('../src/main/timelineIpc')
const { ffmpegPath } = await import('../src/main/ffmpeg')

const ff = ffmpegPath()
const root = mkdtempSync(path.join(tmpdir(), 'ssw-timeline-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function make(file: string, args: string[]): string {
  mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(ff, ['-v', 'error', '-y', ...args, file])
  return file
}
const video = (file: string, size = '320x240', rate = 30, seconds = 2, tone = 440): string =>
  make(file, ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
const sound = (file: string, tone: number, seconds = 2): string => make(file, ['-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`, '-c:a', 'aac'])
const probe = (file: string) => {
  let log = ''
  try {
    execFileSync(ff, ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    log = String((e as { stderr?: Buffer }).stderr ?? '')
  }
  return parseProbe(log)
}
const runFfmpeg = async (args: string[]): Promise<void> => {
  execFileSync(ff, args, { stdio: 'ignore' })
}
const digest = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile()).map((f) => [f, `${createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex')} ${statSync(path.join(dir, f)).mtimeMs}`]))

/** A project folder: a screen recording with sound, a camera, and the microphone and system files. */
function projectFolder(name: string, opts: { stems: boolean } = { stems: true }): string {
  const dir = path.join(root, 'projects', name)
  video(path.join(dir, 'screen.mp4'))
  video(path.join(dir, 'webcam.mp4'), '160x120', 30, 2, 660)
  if (opts.stems) {
    sound(path.join(dir, 'mic.m4a'), 300)
    sound(path.join(dir, 'system.m4a'), 500)
  }
  make(path.join(dir, 'voice-clean.wav'), ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', '-c:a', 'pcm_s16le'])
  return dir
}

interface Calls {
  ffmpeg: string[][]
  clean: unknown[][]
  render: unknown[][]
}
function depsFor(dir: string, calls: Calls, over: Record<string, unknown> = {}) {
  return {
    projectDir: () => dir,
    probe: async (file: string) => probe(file),
    ffmpeg: async (args: string[]) => {
      calls.ffmpeg.push(args)
      await runFfmpeg(args)
    },
    cleanVoice: async (...args: unknown[]) => {
      calls.clean.push(args)
      return path.join(dir, 'voice-clean.wav')
    },
    renderStems: (async (_job: ExportJob, folder: string, only: readonly string[], names: Record<string, string>, ...rest: unknown[]) => {
      calls.render.push([folder, only, names, ...rest])
      const out: Record<string, string> = {}
      for (const s of only) {
        out[s] = path.join(folder, names[s])
        make(out[s], ['-f', 'lavfi', '-i', 'sine=frequency=200:duration=2', '-c:a', 'pcm_f32le'])
      }
      return out
    }) as never,
    ...over
  }
}
const newCalls = (): Calls => ({ ffmpeg: [], clean: [], render: [] })
const JOB = { fps: 30, frames: 60 } as ExportJob

describe('test 42: copyRecordings', () => {
  it('copies (never links), remuxes the screen and the camera without sound and converts the microphone and system sound to WAV', async () => {
    const dir = projectFolder('p42a')
    const before = digest(dir)
    const calls = newCalls()
    const folder = path.join(root, 'out42a', 'Demo media')
    mkdirSync(path.dirname(folder), { recursive: true })
    const made = await copyRecordings('p42a', folder, null, depsFor(dir, calls))
    expect(Object.keys(made).sort()).toEqual(['camera', 'screen', 'system', 'voice'])
    expect(made.screen).toBe(path.join(folder, 'Screen.mp4'))
    expect(made.voice).toBe(path.join(folder, 'Voice.wav'))
    expect(made.system).toBe(path.join(folder, 'System sound.wav'))

    for (const m of ['screen', 'camera'] as const) {
      const p = probe(made[m]!)
      expect(p.streams.map((s) => s.type)).toEqual(['video'])
      expect(p.streams[0].codec).toBe('h264')
      const args = calls.ffmpeg.find((a) => a[a.length - 1] === made[m])!
      expect(args).toEqual(expect.arrayContaining(['-map', '0:v', '-c:v', 'copy', '-an', '-n']))
      // A copy, not a link: its own file, and the project's file still has one name.
      expect(statSync(made[m]!).ino).not.toBe(statSync(path.join(dir, m === 'screen' ? 'screen.mp4' : 'webcam.mp4')).ino)
      expect(statSync(path.join(dir, m === 'screen' ? 'screen.mp4' : 'webcam.mp4')).nlink).toBe(1)
    }
    for (const m of ['voice', 'system'] as const) {
      const p = probe(made[m]!)
      expect(p.streams.map((s) => [s.type, s.codec])).toEqual([['audio', 'pcm_s24le']])
      expect(readFileSync(made[m]!).subarray(24, 28).readUInt32LE(0)).toBe(48000)
      expect(calls.ffmpeg.find((a) => a[a.length - 1] === made[m])).toEqual(expect.arrayContaining(['-c:a', 'pcm_s24le', '-ar', '48000']))
    }
    expect(calls.ffmpeg.find((a) => a[a.length - 1] === made.voice)).toContain(path.join(dir, 'mic.m4a'))
    expect(calls.ffmpeg.find((a) => a[a.length - 1] === made.system)).toContain(path.join(dir, 'system.m4a'))
    // Never opens a project file for writing: every output is in the new folder, the project's files are as they were.
    for (const a of calls.ffmpeg) expect(path.dirname(a[a.length - 1])).toBe(folder)
    expect(digest(dir)).toEqual(before)
    expect(calls.render).toEqual([])
    expect(calls.clean).toEqual([])
  })

  it('uses the cleaned voice with Clean voice on: the microphone when it was kept, else the mixed track', async () => {
    const dir = projectFolder('p42b')
    const calls = newCalls()
    const folder = path.join(root, 'out42b', 'Demo media')
    mkdirSync(path.dirname(folder), { recursive: true })
    const made = await copyRecordings('p42b', folder, 'normal', depsFor(dir, calls), { media: ['screen', 'voice', 'system'] })
    expect(calls.clean).toEqual([['p42b', 'mic', 'normal']])
    expect(calls.ffmpeg.find((a) => a[a.length - 1] === made.voice)).toContain(path.join(dir, 'voice-clean.wav'))
    expect(calls.ffmpeg.find((a) => a[a.length - 1] === made.system)).toContain(path.join(dir, 'system.m4a'))

    const mixed = projectFolder('p42c', { stems: false })
    const calls2 = newCalls()
    const folder2 = path.join(root, 'out42c', 'Demo media')
    mkdirSync(path.dirname(folder2), { recursive: true })
    const made2 = await copyRecordings('p42c', folder2, 'strong', depsFor(mixed, calls2))
    expect(Object.keys(made2).sort()).toEqual(['camera', 'recording', 'screen'])
    expect(made2.recording).toBe(path.join(folder2, 'Recording.wav'))
    expect(calls2.clean).toEqual([['p42c', 'mix', 'strong']])
    expect(probe(made2.recording!).streams.map((s) => s.codec)).toEqual(['pcm_s24le'])
  })

  it('renders Music and Effects only when stems are off', async () => {
    const dir = projectFolder('p42d')
    const calls = newCalls()
    const folder = path.join(root, 'out42d', 'Demo media')
    mkdirSync(path.dirname(folder), { recursive: true })
    const made = await copyRecordings('p42d', folder, null, depsFor(dir, calls), { media: ['screen', 'voice', 'music', 'effects'], job: JOB })
    expect(calls.render.map((r) => [r[0], r[1], r[2]])).toEqual([[folder, ['music', 'effects'], { music: 'Music.wav', effects: 'Effects.wav' }]])
    expect(made.music).toBe(path.join(folder, RECORDING_FILES.music))
    expect(made.effects).toBe(path.join(folder, RECORDING_FILES.effects))
    // With stems on, the timeline uses them and nothing is rendered.
    const calls2 = newCalls()
    const folder2 = path.join(root, 'out42d', 'Demo media (2)')
    await copyRecordings('p42d', folder2, null, depsFor(dir, calls2), { media: ['screen', 'voice'], job: JOB })
    expect(calls2.render).toEqual([])
  })

  it('checks free space for everything plus 20% before it makes anything', async () => {
    const dir = projectFolder('p42e')
    const calls = newCalls()
    const folder = path.join(root, 'out42e', 'Demo media')
    mkdirSync(path.dirname(folder), { recursive: true })
    const need = statSync(path.join(dir, 'screen.mp4')).size + statSync(path.join(dir, 'webcam.mp4')).size + 2 * 2 * 48000 * 3 * 2
    await expect(copyRecordings('p42e', folder, null, depsFor(dir, calls, { freeBytes: async () => need * 1.1 }))).rejects.toThrow(/needs about .* free/)
    expect(calls.ffmpeg).toEqual([])
    expect(existsSync(folder)).toBe(false)
    await expect(copyRecordings('p42e', folder, null, depsFor(dir, calls, { freeBytes: async () => need * 1.3 }))).resolves.toBeTruthy()
  })

  it('removes its folder when a step fails', async () => {
    const dir = projectFolder('p42f')
    const folder = path.join(root, 'out42f', 'Demo media')
    mkdirSync(path.dirname(folder), { recursive: true })
    const calls = newCalls()
    const deps = depsFor(dir, calls, {
      ffmpeg: async (args: string[]) => {
        calls.ffmpeg.push(args)
        if (args[args.length - 1].endsWith('.wav')) throw new Error('ffmpeg failed')
        await runFfmpeg(args)
      }
    })
    await expect(copyRecordings('p42f', folder, null, deps)).rejects.toThrow('ffmpeg failed')
    expect(existsSync(folder)).toBe(false)
  })
})

describe('test 39: timelinePaths', () => {
  it('names the files after the video, shares the FCPXML, adds " (2)" and writes the marker EDL only for Resolve', () => {
    const v = path.join(root, 'names', 'Demo.mp4')
    const taken = new Set([path.join(root, 'names', 'Demo.fcpxml')])
    expect(timelinePaths(v, ['resolve', 'premiere', 'finalcut', 'edl'], true, (p) => taken.has(p))).toEqual([
      { path: path.join(root, 'names', 'Demo (2).fcpxml'), for: 'resolve' },
      { path: path.join(root, 'names', 'Demo (2).fcpxml'), for: 'finalcut' },
      { path: path.join(root, 'names', 'Demo.xml'), for: 'premiere' },
      { path: path.join(root, 'names', 'Demo.edl'), for: 'edl' },
      { path: path.join(root, 'names', 'Demo - Resolve markers.edl'), for: 'resolve-markers' }
    ])
    expect(timelinePaths(v, ['premiere', 'finalcut', 'edl'], true, () => false).map((f) => f.for)).toEqual(['finalcut', 'premiere', 'edl'])
    expect(timelinePaths(v, ['resolve'], false, () => false).map((f) => f.for)).toEqual(['resolve'])
  })
})

describe('test 44: writeTimeline', () => {
  const dir = path.join(root, 'export44')
  const videoPath = path.join(dir, 'Demo.mp4')
  const voicePath = path.join(dir, 'Demo - Voice.wav')
  const project = timelineProject({ id: 'p44', duration: 2, clips: [{ id: 'a', start: 0, end: 2, speed: 1 }], chapters: [{ id: 'c', t: 0, title: 'Intro' }] })
  video(videoPath)
  make(voicePath, ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'pcm_f32le'])
  const exported = { fps: 30, frames: 60, width: 320, height: 240 }
  const request = (over: Partial<TimelineRequest> = {}, plan?: TimelinePlan): TimelineRequest => ({
    projectId: 'p44',
    videoPath,
    editors: ['resolve', 'premiere', 'edl'],
    media: 'export',
    plan: plan ?? exportTimeline(project, exported, ['voice']),
    stems: [{ stem: 'voice', path: voicePath }],
    ...over
  })
  const deps = (over: Record<string, unknown> = {}) => ({ isExported: (f: string) => f === videoPath, probe: async (f: string) => probe(f), jobOf: () => undefined, ...over })
  const listing = (): string[] => readdirSync(dir).sort()
  let start: string[] = []
  beforeEach(() => {
    for (const f of readdirSync(dir)) if (f !== 'Demo.mp4' && f !== 'Demo - Voice.wav') rmSync(path.join(dir, f), { recursive: true, force: true })
    start = listing()
  })

  it('writes the FCPXML, Premiere XML, EDL and Resolve markers next to the video', async () => {
    const result = await writeTimeline(request(), deps())
    expect(result.problem).toBeUndefined()
    expect(result.files).toEqual([
      { path: path.join(dir, 'Demo.fcpxml'), for: 'resolve' },
      { path: path.join(dir, 'Demo.xml'), for: 'premiere' },
      { path: path.join(dir, 'Demo.edl'), for: 'edl' },
      { path: path.join(dir, 'Demo - Resolve markers.edl'), for: 'resolve-markers' }
    ])
    const fcp = parseXml(readFileSync(path.join(dir, 'Demo.fcpxml'), 'utf8'))
    expect(fcp.name).toBe('fcpxml')
    expect(readFileSync(path.join(dir, 'Demo.fcpxml'), 'utf8')).toContain('srcEnable="video"')
    parseXml(readFileSync(path.join(dir, 'Demo.xml'), 'utf8'))
    expect(readFileSync(path.join(dir, 'Demo.edl'), 'utf8')).toContain(`* SOURCE FILE: ${videoPath}\r\n`)
    // No temporary file is left behind.
    expect(listing().filter((f) => f.includes('.partial-'))).toEqual([])
  })

  it('never replaces a file: a taken name gets " (2)"', async () => {
    writeFileSync(path.join(dir, 'Demo.xml'), 'mine')
    const result = await writeTimeline(request({ editors: ['premiere'] }), deps())
    expect(result.files).toEqual([{ path: path.join(dir, 'Demo (2).xml'), for: 'premiere' }])
    expect(readFileSync(path.join(dir, 'Demo.xml'), 'utf8')).toBe('mine')
  })

  const refused = async (req: TimelineRequest, why: 'invalid' | 'media', over: Record<string, unknown> = {}): Promise<void> => {
    const result = await writeTimeline(req, deps(over))
    expect(result).toEqual({ files: [], problem: t(why === 'invalid' ? 'errors.timeline.invalid' : 'errors.timeline.media') })
    expect(listing()).toEqual(start)
  }

  it('refuses a video this session did not export', async () => {
    await refused(request(), 'invalid', { isExported: () => false })
    await refused(request({ videoPath: 'Demo.mp4' }), 'invalid', { isExported: () => true })
  })

  it('refuses a stem that is not next to the video', async () => {
    const elsewhere = path.join(root, 'elsewhere', 'Demo - Voice.wav')
    make(elsewhere, ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'pcm_f32le'])
    await refused(request({ stems: [{ stem: 'voice', path: elsewhere }] }), 'invalid')
    await refused(request({ stems: [{ stem: 'voice', path: path.join(dir, 'sub', '..', 'x', 'Demo - Voice.wav') }] }), 'invalid')
    await refused(request({ stems: [{ stem: 'voice', path: videoPath }] }), 'invalid')
    await refused(request({ stems: [{ stem: 'voice', path: path.join(dir, 'Demo - Music.wav') }] }), 'invalid')
  })

  it('refuses a plan checkTimelinePlan refuses', async () => {
    const plan = (): TimelinePlan => exportTimeline(project, exported, ['voice'])
    const p1 = plan()
    p1.tracks[0].events[0].recOut = 59.5
    await refused(request({}, p1), 'invalid')
    const p2 = plan()
    p2.tracks[0].events[0].recIn = 60
    await refused(request({}, p2), 'invalid')
    const p3 = plan()
    p3.tracks[1].events.push({ ...p3.tracks[1].events[0], recIn: 30 })
    await refused(request({}, p3), 'invalid')
    const p4 = plan()
    p4.frames = 30000
    p4.tracks[1].events = Array.from({ length: PLAN_LIMITS.events }, (_, i) => ({ media: 'voice' as const, recIn: i, recOut: i + 1, srcIn: 0, srcOut: 1, speed: 1 }))
    await refused(request({}, p4), 'invalid')
    const p5 = plan()
    p5.name = 'x'.repeat(501)
    await refused(request({}, p5), 'invalid')
  })

  it('refuses a plan that does not fit its mode', async () => {
    await refused(request({ stems: [] }), 'invalid')
    await refused(request({ media: 'recordings' }), 'invalid')
    await refused(request({ editors: ['edl'], media: 'recordings', plan: recordingsTimeline(project, 30, { screen: { fps: 30, frames: 60, width: 320, height: 240, audio: false, video: true } }) }), 'invalid')
  })

  it('refuses a plan whose rates or sizes disagree with the files', async () => {
    const rate = exportTimeline(project, { ...exported, fps: 60, frames: 120 }, ['voice'])
    await refused(request({}, rate), 'media')
    const size = exportTimeline(project, { ...exported, width: 1920, height: 1080 }, ['voice'])
    await refused(request({}, size), 'media')
    const longer = exportTimeline(project, { ...exported, frames: 300 }, ['voice'])
    await refused(request({}, longer), 'media')
  })

  it('writes a timeline over the recordings into its media folder', async () => {
    const projectDir = projectFolder('p44r')
    const calls = newCalls()
    const plan = recordingsTimeline(project, 30, {
      screen: { fps: 30, frames: 60, width: 320, height: 240, audio: false, video: true },
      camera: { fps: 30, frames: 60, width: 160, height: 120, audio: false, video: true },
      voice: { fps: 30, frames: 60, audio: true, video: false },
      system: { fps: 30, frames: 60, audio: true, video: false },
      music: { fps: 30, frames: 60, audio: true, video: false }
    })
    const job = { ...JOB, audio: { voice: 'light' } } as unknown as ExportJob
    const result = await writeTimeline(request({ media: 'recordings', editors: ['premiere'], stems: [] }, plan), { ...depsFor(projectDir, calls), ...deps({ jobOf: () => job }) })
    expect(result.problem).toBeUndefined()
    const folder = path.join(dir, 'Demo media')
    expect(result.files).toEqual([
      { path: folder, for: 'media' },
      { path: path.join(dir, 'Demo.xml'), for: 'premiere' }
    ])
    expect(readdirSync(folder).sort()).toEqual(['Camera.mp4', 'Music.wav', 'Screen.mp4', 'System sound.wav', 'Voice.wav'])
    expect(calls.clean).toEqual([['p44', 'mic', 'light']])
    expect(calls.render.map((r) => r[1])).toEqual([['music']])
    const xml = readFileSync(path.join(dir, 'Demo.xml'), 'utf8')
    expect(xml).toContain('Demo%20media/Screen.mp4')
    expect(xml).toContain('<enabled>FALSE</enabled>')
  })
})
