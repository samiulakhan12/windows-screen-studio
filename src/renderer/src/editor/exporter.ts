import type { ExportCapabilities, ExportJob } from '../../../shared/api/export'
import { exportFrameTimes } from '../../../shared/engine/timeline'
import { exportDimensions, exportRoutes, routeLabel, type ExportRoute } from '../../../shared/render/exportPlan'
import type { ExportSettings, Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'
import { avcConfigs, cleanIpcError, RawFrameSink, supportedAvcConfig, WebCodecsSink, type FrameSink } from '../render/encoders'
import { DecoderFrameSource, ElementFrameSource, type FrameSource } from '../render/frameSource'
import { createVideo, whenReady } from './media'

export { exportDimensions, GIF_FPS, GIF_MAX_HEIGHT } from '../../../shared/render/exportPlan'

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finalizing'
  /** Frames rendered so far, of `frames`. */
  frame: number
  frames: number
  /** Recent rendering speed in frames per second. */
  fps: number
  /** Estimated seconds left while rendering, once the speed is known. */
  eta: number | null
  /** Human-readable encoder in use ("GPU (WebCodecs)", "NVIDIA NVENC", "Software (x264)"). */
  encoder: string
  /** Set when the export restarted on a fallback encoder. */
  notice?: string
}

export interface ExportInput {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
  settings: ExportSettings
  outputPath: string
  onProgress: (p: ExportProgress) => void
  signal: AbortSignal
}

export interface ExportResult {
  encoder: string
  seconds: number
}

/** Failures another encoder cannot fix (the disk, the folder, the target file, the recording). */
const NOT_ENCODER_RELATED = /disk is full|permission|in use|another app|read-only|missing|could not be read|could not save|not chosen/i

/** Most motion-blur sub-frames per exported frame (the preview uses fewer). */
const EXPORT_BLUR_SAMPLES = 10

const abortError = (): DOMException => new DOMException('Export cancelled', 'AbortError')

/**
 * Renders every frame through the same compositor as the preview and encodes it,
 * trying the fastest encoder first and falling back when one fails. Decoding the
 * next source frame, drawing, and encoding/IPC of the previous frame overlap.
 */
export async function exportVideo(input: ExportInput): Promise<ExportResult> {
  const { signal } = input
  const caps = await window.api.exportCapabilities()
  const routes = exportRoutes(input.settings, caps)
  let notice: string | undefined
  for (let r = 0; r < routes.length; r++) {
    const route = routes[r]
    if (signal.aborted) throw abortError()
    try {
      const sink = await prepareRoute(route, input)
      if (!sink) continue
      const t0 = performance.now()
      await renderAll(input, caps, route, sink, notice)
      return { encoder: routeLabel(route, input.settings.format), seconds: (performance.now() - t0) / 1000 }
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw abortError()
      const e = cleanIpcError(err)
      const last = r === routes.length - 1
      if (last || NOT_ENCODER_RELATED.test(e.message)) throw e
      console.warn(`Export with ${routeLabel(route, input.settings.format)} failed, trying the next encoder:`, e)
      notice = `${routeLabel(route, input.settings.format)} failed, so the export restarted with ${routeLabel(routes[r + 1], input.settings.format)}.`
    }
  }
  throw new Error('No video encoder is available')
}

type SinkFactory = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, startJob: (job: ExportJob) => Promise<void>, base: Omit<ExportJob, 'video'>) => FrameSink

/** Checks that a route can run here; returns a factory for its sink, or null to skip it. */
async function prepareRoute(route: ExportRoute, input: ExportInput): Promise<SinkFactory | null> {
  if (route.video === 'ffmpeg') {
    return (_canvas, ctx, startJob, base) => {
      const sink = new RawFrameSink(ctx, base.width, base.height)
      const started = startJob({ ...base, video: { kind: 'raw', encoder: route.encoder } })
      // Awaited by push/finish; this only keeps an early failure from being reported as unhandled.
      started.catch(() => undefined)
      return {
        push: async () => {
          await started
          return sink.push()
        },
        finish: async () => {
          await started
          return sink.finish()
        },
        close: () => sink.close()
      }
    }
  }
  const { width, height, fps } = exportDimensions(input.project, input.settings)
  const config = await supportedAvcConfig(avcConfigs(width, height, fps, input.settings.quality, route.hardware))
  if (!config) return null
  return (canvas, _ctx, startJob, base) => new WebCodecsSink(canvas, config, fps, (color) => startJob({ ...base, video: { kind: 'h264', color } }))
}

async function openSource(url: string, times: number[], caps: ExportCapabilities): Promise<{ source: FrameSource; video: HTMLVideoElement | null }> {
  if (caps.overrides.decoder !== 'element') {
    try {
      const source = await DecoderFrameSource.open(url, times)
      if (source) return { source, video: null }
    } catch (e) {
      console.warn('WebCodecs decoding unavailable, seeking the video element instead:', e)
    }
  }
  const video = createVideo(url)
  video.muted = true
  await whenReady(video)
  return { source: new ElementFrameSource(video, times), video }
}

function disposeVideo(v: HTMLVideoElement | null): void {
  if (!v) return
  v.removeAttribute('src')
  v.load()
}

async function renderAll(input: ExportInput, caps: ExportCapabilities, route: ExportRoute, makeSink: SinkFactory, notice: string | undefined): Promise<void> {
  const { project, settings, signal } = input
  const { width, height, fps } = exportDimensions(project, settings)
  const times = exportFrameTimes(project.clips, fps)
  const encoder = routeLabel(route, settings.format)
  const report = (p: Omit<ExportProgress, 'encoder' | 'frames' | 'notice'>): void => input.onProgress({ ...p, frames: times.length, encoder, notice })
  report({ phase: 'preparing', frame: 0, fps: 0, eta: null })

  const useWebcam = !!input.webcamUrl && project.webcam.show && project.hasWebcam
  const screen = await openSource(input.screenUrl, times, caps)
  let camera: Awaited<ReturnType<typeof openSource>> | null = null
  const placeholder = document.createElement('video')
  let sink: FrameSink | null = null
  const onAbort = (): void => void window.api.exportCancel()
  signal.addEventListener('abort', onAbort)
  try {
    if (useWebcam) camera = await openSource(input.webcamUrl!, times.map((t) => t - project.webcamOffset), caps)
    if (signal.aborted) throw abortError()

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const raw = route.video === 'ffmpeg'
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: raw })
    if (!ctx) throw new Error('Could not create a drawing surface')

    const mute = project.audio.muted || project.audio.volume <= 0
    const base: Omit<ExportJob, 'video'> = {
      width,
      height,
      fps,
      frames: times.length,
      format: settings.format,
      quality: settings.quality,
      audio: project.hasAudio && settings.format === 'mp4' && !mute ? { clips: project.clips, volume: project.audio.volume } : undefined,
      outputPath: input.outputPath
    }
    const startJob = (job: ExportJob): Promise<void> => window.api.exportStart(project.id, job)
    sink = makeSink(canvas, ctx, startJob, base)

    const options = { frameInterval: 1 / fps, blurSamples: EXPORT_BLUR_SAMPLES }
    const sources = { screen: screen.video ?? placeholder, webcam: camera?.video ?? null, background: input.background }
    // Speed over the last ~1 s of frames, for the fps readout and the ETA.
    const stamps: number[] = []
    let lastReport = 0
    const spent = { decode: 0, draw: 0, encode: 0 }
    for (let i = 0; i < times.length; i++) {
      if (signal.aborted) throw abortError()
      const a = performance.now()
      const [screenFrame, webcamFrame] = await Promise.all([screen.source.get(i), camera ? camera.source.get(i) : null])
      const b = performance.now()
      drawFrame(ctx, width, height, times[i], input.scene, { ...sources, screenFrame, webcamFrame }, options)
      // The canvas holds the pixels now: let the sources start on the next frame.
      screen.source.next()
      camera?.source.next()
      const c = performance.now()
      await sink.push(i)
      spent.decode += b - a
      spent.draw += c - b
      spent.encode += performance.now() - c

      const now = performance.now()
      stamps.push(now)
      if (stamps.length > 90) stamps.shift()
      if (now - lastReport > 200 || i === times.length - 1) {
        lastReport = now
        const span = (stamps[stamps.length - 1] - stamps[0]) / 1000
        const speed = stamps.length > 5 && span > 0 ? (stamps.length - 1) / span : 0
        report({ phase: 'rendering', frame: i + 1, fps: speed, eta: speed > 0 ? (times.length - i - 1) / speed : null })
      }
    }
    if (signal.aborted) throw abortError()
    const ms = (v: number): string => (v / times.length).toFixed(1)
    console.info(
      `export: ${times.length} frames ${width}x${height} via ${encoder}, ${screen.source.kind} decoding; per frame ms: wait decode ${ms(spent.decode)}, draw ${ms(spent.draw)}, encode/IPC ${ms(spent.encode)}`
    )
    report({ phase: 'finalizing', frame: times.length, fps: 0, eta: null })
    await sink.finish()
    if (signal.aborted) throw abortError()
  } catch (err) {
    // Stops ffmpeg (also while it is finishing) and deletes the partial file.
    await window.api.exportCancel().catch(() => undefined)
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
    sink?.close()
    screen.source.close()
    camera?.source.close()
    disposeVideo(screen.video)
    disposeVideo(camera?.video ?? null)
  }
}
