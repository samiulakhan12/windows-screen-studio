import { describe, expect, it, vi } from 'vitest'
import { jobSoundGains, MAX_SOUND_GAINS, MAX_SOUND_SPANS, soundGainFilters, soundGains, validSoundGains } from '../src/shared/audio/soundsEdit'
import { MAX_BLEEPS } from '../src/shared/captions/studioData'
import { createProject } from '../src/shared/engine/project'
import type { ExportJob } from '../src/shared/api/export'
import type { Bleep, Project } from '../src/shared/types'

/*
 * Test 27 (docs/design/captions-studio.md §11.7 rule 5, §16): the export job the exporter makes
 * carries the bleeps in `RecordingSound.sounds`, joined with the unwanted-sound finder's stretches
 * (soundGains), and a project with neither gets the job of before (no `sounds`). The job is caught
 * where the exporter hands it to the main process.
 */

const jobs: ExportJob[] = []
vi.mock('../src/renderer/src/render/tiltLayer', () => ({ releaseTilt: () => undefined }))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ prepareCursorAssets: async () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ prepareStyleAssets: async () => undefined }))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))
vi.stubGlobal('window', {
  api: {
    exportCapabilities: async () => ({ hardwareEncoders: [], gpuCanvas: false, overrides: { videoEncoder: 'ffmpeg' } }),
    exportStart: async (_id: string, job: ExportJob) => void jobs.push(job),
    exportCancel: async () => undefined,
    exportFinish: async () => ({ bytes: 1 })
  }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const EXPORTER = '../src/renderer/src/editor/exporter'
const { exportVideo } = (await import(/* @vite-ignore */ EXPORTER)) as { exportVideo(input: unknown): Promise<unknown> }

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 6,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  p.clips = [{ id: 'c', start: 0, end: 6, speed: 1 }]
  return { ...p, ...extra }
}

async function jobOf(p: Project): Promise<ExportJob> {
  jobs.length = 0
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  const scene = { project: p, cursor: { samples: [], clicks: [], valid: false }, cursorPath: path, focusPath: path }
  await exportVideo({
    project: p,
    scene,
    screenUrl: 'media://p/screen.mp4',
    background: null,
    settings: { format: 'm4a', resolution: 720, fps: 30, quality: 'high', encoder: 'software' },
    outputPath: '/tmp/out.m4a',
    onProgress: () => undefined,
    signal: new AbortController().signal
  })
  expect(jobs).toHaveLength(1)
  return jobs[0]
}

const BLEEP: Bleep = { id: 'b1', start: 2, end: 2.4, word: 'damn', sound: 'silence' }

describe('the export job of a project with bleeps', () => {
  it('mutes each bleep through the sound finder gains, joined with its stretches', async () => {
    const bleeped = await jobOf(project({ bleeps: [BLEEP] }))
    expect(bleeped.audio?.sounds).toEqual([{ start: 2, end: 2.4, gain: 0 }])
    // A Silence bleep has no tone; a Tone bleep adds it, and mutes the same.
    expect(bleeped.tones).toBeUndefined()
    const toned = await jobOf(project({ bleeps: [{ ...BLEEP, sound: 'tone' }] }))
    expect(toned.audio?.sounds).toEqual([{ start: 2, end: 2.4, gain: 0 }])
    expect(toned.tones).toEqual([{ start: 2, end: 2.4 }])
    // Inside a lowered stretch: the bleep is muted, the rest of the stretch lowered, one curve.
    const both = project({ bleeps: [BLEEP], sounds: { spans: [{ start: 1, end: 3, action: 'duck', key: 'typing-100' }], ignored: [] } })
    const joined = (await jobOf(both)).audio?.sounds
    expect(joined).toEqual(soundGains(both))
    expect(joined).toEqual([
      { start: 1, end: 2, gain: 0.2 },
      { start: 2, end: 2.4, gain: 0 },
      { start: 2.4, end: 3, gain: 0.2 }
    ])
  })

  it('never carries more pieces than the main process accepts, and plays the same curve', () => {
    // A lowered stretch around each of the most bleeps a project keeps: joined, three pieces each.
    const spans = Array.from({ length: MAX_SOUND_SPANS }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5, action: 'duck' as const, key: `typing-${i}` }))
    const bleeps: Bleep[] = Array.from({ length: MAX_BLEEPS }, (_, i) => ({ id: `b${i}`, start: i * 2 + 0.6, end: i * 2 + 0.9, word: 'damn', sound: 'silence' }))
    // One clip keeps everything: every bleep's word is heard.
    const clips = [{ id: 'all', start: 0, end: MAX_BLEEPS * 2, speed: 1 }]
    const p = { sounds: { spans, ignored: [] }, bleeps, clips }
    expect(soundGains(p).length).toBeGreaterThan(MAX_SOUND_GAINS)
    const job = jobSoundGains(p)!
    expect(job.length).toBeLessThanOrEqual(MAX_SOUND_GAINS)
    expect(validSoundGains(job)).toBe(true)
    expect(soundGainFilters(job)).toBe(soundGainFilters(soundGains(p)))
    // Within the limit the job carries the joined curve, as before.
    const few = { sounds: { spans: spans.slice(0, 3), ignored: [] }, bleeps: bleeps.slice(0, 3), clips }
    expect(jobSoundGains(few)).toEqual(soundGains(few))
  })

  it('a project without bleeps or stretches gets the job of before', async () => {
    const job = await jobOf(project())
    expect(job.audio).toBeDefined()
    expect('sounds' in job.audio!).toBe(false)
    expect(job.tones).toBeUndefined()
  })
})
