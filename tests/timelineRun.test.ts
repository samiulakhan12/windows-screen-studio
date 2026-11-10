/**
 * The timeline step in the renderer (docs/design/output-and-languages.md §8.7, §2.4): it builds the
 * plan of each mode from the project, describes the recordings as their files are, asks main to write
 * the files, and turns a failure into the done view's line without undoing the video.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SoundStem, TimelineRequest, TimelineResult } from '../src/shared/api/export'
import { t } from '../src/shared/i18n/t'
import { checkTimelinePlan } from '../src/shared/interchange/planCheck'
import { exportTimeline, type TimelinePlan } from '../src/shared/interchange/timelinePlan'
import type { Project } from '../src/shared/types'
import { timelineProject } from './timelineFixtures'

interface TrackFacts {
  fps: number
  frames: number
  width: number
  height: number
}
interface Step {
  recordingMedia(project: Project, fps: number, screen: TrackFacts, camera: TrackFacts | null, stems: readonly SoundStem[], videoFrames: number): TimelinePlan['media']
  writeTimelineStep(
    project: Project,
    request: Omit<TimelineRequest, 'plan'>,
    exported: { fps: number; frames: number; width: number; height: number },
    deps?: { track?: (url: string) => Promise<TrackFacts | null>; write?: (request: TimelineRequest) => Promise<TimelineResult> }
  ): Promise<TimelineResult>
}
interface Bundle {
  writeBundle(anchor: string, req: Record<string, unknown>): Promise<{ saved: string[]; failed: string[] } | undefined>
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const STEP = '../src/renderer/src/editor/timelineRun'
const BUNDLE = '../src/renderer/src/editor/exportBundleRun'
const { recordingMedia, writeTimelineStep } = (await import(/* @vite-ignore */ STEP)) as Step

const SCREEN: TrackFacts = { fps: 60, frames: 1200, width: 1920, height: 1080 }
const CAMERA: TrackFacts = { fps: 30, frames: 600, width: 1280, height: 720 }
const exported = { fps: 30, frames: 600, width: 1920, height: 1080 }
const base: Omit<TimelineRequest, 'plan'> = { projectId: 'p6f1c', videoPath: 'C:\\v\\Demo.mp4', editors: ['resolve'], media: 'export', stems: [] }

function step(project = timelineProject(), request = base, result: TimelineResult = { files: [{ path: 'C:\\v\\Demo.fcpxml', for: 'resolve' }] }) {
  const sent: TimelineRequest[] = []
  const urls: string[] = []
  const run = writeTimelineStep(project, request, exported, {
    track: async (url: string) => {
      urls.push(url)
      return url.includes('webcam') ? CAMERA : url.includes('screen') ? SCREEN : null
    },
    write: async (r: TimelineRequest) => {
      sent.push(r)
      return result
    }
  })
  return { run, sent, urls }
}

describe('writeTimelineStep', () => {
  it('sends the plan of This export with the stems the export wrote', async () => {
    const request = { ...base, stems: [{ stem: 'voice' as const, path: 'C:\\v\\Demo - Voice.wav' }] }
    const { run, sent, urls } = step(timelineProject(), request)
    expect(await run).toEqual({ files: [{ path: 'C:\\v\\Demo.fcpxml', for: 'resolve' }] })
    expect(urls).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject(request)
    expect(sent[0].plan).toEqual(exportTimeline(timelineProject(), exported, ['voice']))
    expect(sent[0].plan.pictureOnly).toBe(true)
  })

  it('describes the recordings from their files for The original recordings', async () => {
    const project = timelineProject({ hasWebcam: true, audioStems: { mic: true, system: true } })
    const { run, sent, urls } = step(project, { ...base, media: 'recordings', editors: ['premiere'] })
    await run
    expect(urls.map((u) => decodeURIComponent(u.split('?')[0]))).toEqual(['studio-media://project/p6f1c/screen.mp4', 'studio-media://project/p6f1c/webcam.mp4'])
    const plan = sent[0].plan
    expect(checkTimelinePlan(plan)).toBeNull()
    expect(plan.media.screen).toEqual({ ...SCREEN, audio: false, video: true })
    expect(plan.media.camera).toEqual({ ...CAMERA, audio: false, video: true })
    expect(plan.media.voice).toEqual({ fps: 30, frames: 600, audio: true, video: false })
    expect(Object.keys(plan.media).sort()).toEqual(['camera', 'screen', 'system', 'voice'])
  })

  it('passes main\'s own refusal through and words any other failure as the done view\'s line', async () => {
    const invalid = t('errors.timeline.invalid')
    expect((await step(undefined, base, { files: [], problem: invalid }).run).problem).toBe(invalid)
    expect((await step(undefined, base, { files: [], problem: 'The disk is full.' }).run).problem).toBe('The timeline could not be saved: The disk is full.')
    const thrown = await writeTimelineStep(timelineProject(), base, exported, {
      write: async () => {
        throw new Error("Error invoking remote method 'export:writeTimeline': Error: Not allowed\nstack")
      }
    })
    expect(thrown).toEqual({ files: [], problem: 'The timeline could not be saved: Not allowed' })
  })

  it('says a recording that cannot be read changed, and writes nothing', async () => {
    const write = vi.fn()
    const result = await writeTimelineStep(timelineProject(), { ...base, media: 'recordings', editors: ['resolve'] }, exported, { track: async () => null, write })
    expect(result).toEqual({ files: [], problem: t('errors.timeline.media') })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('recordingMedia', () => {
  it('names the recording\'s sounds as the project kept them, and Music and Effects when the export has them', () => {
    const mixed = recordingMedia(timelineProject(), 30, SCREEN, null, [], 600)
    expect(Object.keys(mixed).sort()).toEqual(['recording', 'screen'])
    const silent = recordingMedia(timelineProject({ hasAudio: false }), 30, SCREEN, CAMERA, [], 600)
    expect(Object.keys(silent)).toEqual(['screen'])
    const withMusic = timelineProject()
    withMusic.audio = { ...withMusic.audio, music: { path: 'music.mp3', volume: 0.4, ducking: 0.7, loop: true, fadeIn: 1, fadeOut: 2 } }
    expect(recordingMedia(withMusic, 30, SCREEN, null, [], 600).music).toEqual({ fps: 30, frames: 600, audio: true, video: false })
    expect(Object.keys(recordingMedia(timelineProject(), 120, SCREEN, null, ['music', 'effects'], 1200)).sort()).toEqual(['effects', 'music', 'recording', 'screen'])
    expect(recordingMedia(timelineProject(), 120, SCREEN, null, ['music'], 1200).music!.fps).toBe(60)
  })
})

describe('the bundle lists a shared FCPXML once', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })
  it('saves each timeline file once and keeps the step\'s problem', async () => {
    vi.stubGlobal('window', {
      api: {
        writeTimeline: async () => ({
          files: [
            { path: '/v/Demo.fcpxml', for: 'resolve' },
            { path: '/v/Demo.fcpxml', for: 'finalcut' },
            { path: '/v/Demo media', for: 'media' }
          ]
        })
      }
    })
    const { writeBundle } = (await import(/* @vite-ignore */ BUNDLE)) as Bundle
    const project = timelineProject()
    const out = await writeBundle('/v/Demo.mp4', {
      project,
      kinds: [],
      title: 'Demo',
      thumbnail: async () => new Uint8Array(),
      timeline: { request: { ...base, videoPath: '/v/Demo.mp4', editors: ['resolve', 'finalcut'] }, exported }
    })
    expect(out).toEqual({ saved: ['/v/Demo.fcpxml', '/v/Demo media'], failed: [] })
  })
})
