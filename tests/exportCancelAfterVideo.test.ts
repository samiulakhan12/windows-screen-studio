import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * A cancel that reaches main after the video is in place, while it writes the sound stems
 * (docs/design/output-and-languages.md §7.6, §2.4): main keeps the video and deletes the stems, and
 * the exporter reports the video as saved, marked `cancelledAfterVideo`, instead of a cancelled
 * export. A batch file cancelled that way is done, without its sidecars, and the rest are skipped.
 * Decoding, drawing and encoding are stand-ins; `whileFinishing` runs inside the finish.
 */

let whileFinishing: () => void = () => undefined
const finish = async (): Promise<{ bytes: number }> => {
  whileFinishing()
  await Promise.resolve()
  return { bytes: 1 }
}

class FakeSource {
  readonly kind = 'decoder'
  async get(i: number) {
    await Promise.resolve()
    return { image: { i }, width: 1920, height: 1080 }
  }
  next(): void {}
  close(): void {}
}

vi.mock('../src/renderer/src/render/frameSource', () => ({
  openTrack: async (url: string) => ({ url, fps: 30 }),
  DecoderFrameSource: { open: async () => new FakeSource() },
  ResilientFrameSource: class {
    constructor(private readonly source: FakeSource) {}
    get kind() {
      return this.source.kind
    }
    get(i: number) {
      return this.source.get(i)
    }
    next() {}
    close() {}
  },
  ElementFrameSource: class {}
}))
vi.mock('../src/renderer/src/render/compositor', () => ({ drawFrame: () => undefined }))
vi.mock('../src/renderer/src/render/encoders', () => ({
  RawFrameSink: class {
    async push() {}
    finish() {
      return finish()
    }
    close() {}
  },
  WebCodecsSink: class {},
  avcConfigs: () => [],
  vp9Configs: () => [],
  supportedAvcConfig: async () => null,
  cleanIpcError: (e: unknown) => e
}))
vi.mock('../src/renderer/src/render/tiltLayer', () => ({ releaseTilt: () => undefined }))
vi.mock('../src/renderer/src/render/gradeLayer', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseGrade: () => undefined
}))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ prepareCursorAssets: async () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ prepareStyleAssets: async () => undefined }))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))
vi.mock('../src/renderer/src/editor/media', () => ({
  SCREEN_PROXY_FPS: 60,
  WEBCAM_PROXY_FPS: 30,
  createVideo: () => ({}),
  mediaDuration: async () => null,
  whenReady: async () => undefined
}))

const canvas = () => {
  const ctx = { name: 'export target', drawImage: () => undefined }
  return { width: 0, height: 0, getContext: () => ctx, toBlob: (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new ArrayBuffer(4) }) }
}
vi.stubGlobal('document', { createElement: () => canvas() })
const exportCancel = vi.fn(async () => undefined)
vi.stubGlobal('window', {
  api: {
    exportCapabilities: async () => ({ hardwareEncoders: [], gpuCanvas: false, overrides: { videoEncoder: 'ffmpeg' } }),
    exportStart: async () => undefined,
    exportCancel,
    exportFinish: finish,
    exportBatchPath: async (folder: string, name: string) => `${folder}/${name}`
  }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const EXPORTER = '../src/renderer/src/editor/exporter'
type Status = { state: string; extras?: unknown; cancelledAfterVideo?: true }
type Exporter = {
  exportVideo(input: unknown): Promise<Record<string, unknown>>
  exportBatch(source: unknown, folder: string, jobs: unknown[], onStatus: (i: number, s: Status) => void, signal: AbortSignal, hooks?: unknown): Promise<void>
}
const { exportVideo, exportBatch } = (await import(/* @vite-ignore */ EXPORTER)) as Exporter

function project(): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 1,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return { ...p, clips: [{ id: 'c', start: 0, end: 1, speed: 1 }] }
}

function source(p: Project) {
  const path = { at: () => ({ x: 0.5, y: 0.5 }) }
  const cursor = { samples: [], clicks: [], valid: false }
  return { project: p, scene: { project: p, cursor, cursorPath: path, focusPath: path }, screenUrl: 'media://p/screen.mp4', webcamUrl: null, background: null }
}

const MP4 = { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'software' }
const WAV = { format: 'wav', resolution: 720, fps: 30, quality: 'high', encoder: 'software' }

const run = (settings: Record<string, unknown>, controller: AbortController) =>
  exportVideo({ ...source(project()), settings, outputPath: '/tmp/Demo.out', onProgress: () => undefined, signal: controller.signal, stems: true })

beforeEach(() => {
  whileFinishing = () => undefined
  exportCancel.mockClear()
})

describe('a cancel while main writes the stems, after the video is in place', () => {
  for (const [name, settings] of [
    ['a video', MP4],
    ['a WAV', WAV]
  ] as const) {
    it(`reports ${name} as saved, marked cancelled after the video, and stops main`, async () => {
      const controller = new AbortController()
      whileFinishing = () => controller.abort()
      const result = await run(settings, controller)
      expect(result).toMatchObject({ bytes: 1, cancelledAfterVideo: true })
      expect(exportCancel).toHaveBeenCalled()
    })

    it(`leaves ${name} that was not cancelled as before, with no mark`, async () => {
      const result = await run(settings, new AbortController())
      expect(result.bytes).toBe(1)
      expect('cancelledAfterVideo' in result).toBe(false)
    })
  }

  it('still cancels an export stopped before its finish', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(run(MP4, controller)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a batch file cancelled that way is done without its sidecars, and the rest are skipped', async () => {
    const controller = new AbortController()
    whileFinishing = () => controller.abort()
    const statuses = new Map<number, Status>()
    const after = vi.fn(async () => ({ saved: ['x.srt'], failed: [] }))
    const jobs = [
      { fileName: 'A.mp4', options: MP4 },
      { fileName: 'B.mp4', options: MP4 }
    ]
    await exportBatch(source(project()), '/tmp', jobs, (i, s) => statuses.set(i, s), controller.signal, { after })
    expect(statuses.get(0)).toMatchObject({ state: 'done', path: '/tmp/A.mp4', cancelledAfterVideo: true })
    expect(statuses.get(0)?.extras).toBeUndefined()
    expect(after).not.toHaveBeenCalled()
    expect(statuses.get(1)).toEqual({ state: 'cancelled' })
  })
})
