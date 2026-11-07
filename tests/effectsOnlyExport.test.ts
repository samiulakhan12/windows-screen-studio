import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveSoundInputs, validateJob } from '../src/main/exportJob'
import { ffmpegPlan } from '../src/main/exportArgs'
import type { ExportJob } from '../src/shared/api/export'
import { hasSoundtrack, needsAudioGraph } from '../src/shared/audio/settings'
import { soundEffect } from '../src/shared/audio/soundLibrary'
import { createProject } from '../src/shared/engine/project'
import { planSoundtrack } from '../src/shared/render/audioPlan'
import type { Project } from '../src/shared/types'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §10.8, §19.1 test 83): a recording with no
 * sound whose only sound is a zoom whoosh exports with a soundtrack. The job is caught where the
 * exporter hands it to the main process, then checked and planned as main does.
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
const { exportVideo, hasSound } = (await import(/* @vite-ignore */ EXPORTER)) as { exportVideo(input: unknown): Promise<unknown>; hasSound(s: Partial<ExportJob>): boolean }

const LIBRARY = path.join(__dirname, '..', 'resources', 'sound-library')

function silentWithWhoosh(): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 6,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return {
    ...p,
    clips: [{ id: 'c', start: 0, end: 6, speed: 1 }],
    zooms: [{ id: 'z', start: 2, end: 4, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }],
    soundFx: { zoomIn: 'sfx:whoosh-soft' }
  }
}

async function audioJob(p: Project, targetSizeMB?: number): Promise<ExportJob> {
  jobs.length = 0
  const track = { at: () => ({ x: 0.5, y: 0.5 }) }
  const scene = { project: p, cursor: { samples: [], clicks: [], valid: false }, cursorPath: track, focusPath: track }
  await exportVideo({
    project: p,
    scene,
    screenUrl: 'media://p/screen.mp4',
    background: null,
    settings: { format: 'm4a', resolution: 720, fps: 30, quality: 'high', encoder: 'software', ...(targetSizeMB ? { targetSizeMB } : {}) },
    outputPath: '/tmp/out.m4a',
    onProgress: () => undefined,
    signal: new AbortController().signal
  })
  expect(jobs).toHaveLength(1)
  return jobs[0]
}

describe('a silent recording with one zoom whoosh (test 83)', () => {
  it('has a soundtrack: the export dialog offers M4A and the preview plays through its graph', () => {
    const p = silentWithWhoosh()
    expect(hasSoundtrack(p, false)).toBe(true)
    expect(needsAudioGraph(p)).toBe(true)
    // Without the rule it is silent, as before.
    const { soundFx: _rule, ...plain } = p
    void _rule
    expect(hasSoundtrack(plain as Project, false)).toBe(false)
    expect(needsAudioGraph(plain as Project)).toBe(false)
  })

  it('the audio-only export carries the effect, passes main, and is sized with audio', async () => {
    const p = silentWithWhoosh()
    const job = await audioJob(p, 2)
    expect(job.audio).toBeUndefined()
    expect(job.music).toBeUndefined()
    expect(job.effects).toEqual([{ id: 'whoosh-soft', times: [2 + 0.35 - soundEffect('whoosh-soft')!.prepared.peakAt], gain: 0.35 }])
    expect(hasSound(job)).toBe(true)
    // rateOf sized it with audio: the size target gives the audio its share.
    expect(job.bitrate?.audio).toBeGreaterThan(0)
    expect(() => validateJob(job)).not.toThrow()
    // Without the effect, main refuses an audio-only export with no sound.
    expect(() => validateJob({ ...job, effects: undefined })).toThrow('This recording has no sound to export.')
    const sound = await resolveSoundInputs(job, '/p', async () => true, [], { soundDir: LIBRARY })
    const plan = planSoundtrack(sound.job, { mix: sound.audioInput, effects: sound.effects }, 0)
    expect(plan.args).toEqual(['-vn', '-i', path.join(LIBRARY, 'sfx-whoosh-soft.ogg')])
    expect(plan.graph).toMatch(/\[aout\]$/)
  })

  it('a video export of it has an audio track', async () => {
    const p = silentWithWhoosh()
    const job = await audioJob(p)
    const video: ExportJob = { ...job, format: 'mp4', width: 640, height: 360, fps: 30, video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' }, outputPath: '/o.mp4' }
    expect(() => validateJob(video)).not.toThrow()
    const sound = await resolveSoundInputs(video, '/p', async () => true, [], { soundDir: LIBRARY })
    const plan = ffmpegPlan(video, { audioInput: sound.audioInput, effects: sound.effects, output: '/tmp/o.mp4', tempStem: '/tmp/x' })
    expect(plan.capture).toContain('[aout]')
    expect(plan.capture).toContain(path.join(LIBRARY, 'sfx-whoosh-soft.ogg'))
    expect(plan.capture.join(' ')).toMatch(/-c:a aac/)
  })
})
