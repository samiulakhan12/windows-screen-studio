import { describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'
import { createProject } from '../src/shared/engine/project'
import { stemJobOf } from '../src/shared/render/stems'
import type { Project } from '../src/shared/types'

/*
 * The export job a project with stems asked for (docs/design/output-and-languages.md §7, §21.0 seam
 * 4): the exporter adds `stems: stemJobOf(project, options, analysis)` only when Also save asks for
 * them, and a job without them is the job of before, key for key. The job is caught where the
 * exporter hands it to the main process.
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

const SETTINGS = { format: 'm4a', resolution: 720, fps: 30, quality: 'high', encoder: 'software' } as const

async function jobOf(p: Project, stems?: true, settings: Record<string, unknown> = SETTINGS): Promise<ExportJob> {
  jobs.length = 0
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  const scene = { project: p, cursor: { samples: [], clicks: [], valid: false }, cursorPath: path, focusPath: path }
  await exportVideo({
    project: p,
    scene,
    screenUrl: 'media://p/screen.mp4',
    background: null,
    settings,
    outputPath: '/tmp/out.m4a',
    onProgress: () => undefined,
    signal: new AbortController().signal,
    ...(stems ? { stems } : {})
  })
  expect(jobs).toHaveLength(1)
  return jobs[0]
}

describe('the stems in the export job', () => {
  it('asked for: the stems stemJobOf gives for the project, with the fixed gain while it evens out loudness', async () => {
    const p = project({ audioStems: { mic: true, system: true }, audio: { volume: 1, muted: false, normalize: true, system: { volume: 0.5, muted: false } } })
    const job = await jobOf(p, true)
    expect(job.stems).toEqual(stemJobOf(p, SETTINGS, {}))
    expect(job.stems).toEqual({ stems: ['voice', 'system'], gainDb: 0, gains: { system: 0.5 } })
  })

  it('not asked for: the job of before, with no stems key and nothing else changed', async () => {
    const p = project({ audio: { volume: 1, muted: false, normalize: true } })
    const plain = await jobOf(p)
    expect('stems' in plain).toBe(false)
    const { stems, ...rest } = await jobOf(p, true)
    expect(stems).toEqual({ stems: ['recording'], gainDb: 0 })
    expect(rest).toEqual(plain)
  })
})
