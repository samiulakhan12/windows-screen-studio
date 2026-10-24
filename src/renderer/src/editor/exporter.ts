import type { ExportCapabilities, ExportJob } from '../../../shared/api/export'
import { exportFrameTimes } from '../../../shared/engine/timeline'
import { exportDimensions, exportRoutes, routeLabel, type ExportRoute } from '../../../shared/render/exportPlan'
import type { ExportSettings, Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'
import { avcConfigs, cleanIpcError, RawFrameSink, supportedAvcConfig, WebCodecsSink, type FrameSink } from '../render/encoders'
import { DecoderFrameSource, ElementFrameSource, openTrack, ResilientFrameSource, type FrameSource, type MediaTrack } from '../render/frameSource'
import { createVideo, SCREEN_PROXY_FPS, WEBCAM_PROXY_FPS, whenReady } from './media'

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
  bytes: number
}

/** Failures another encoder cannot fix (the disk, the folder, the target file, the recording). */
const NOT_ENCODER_RELATED = /disk is full|permission|in use|another app|read-only|missing|could not be read|could not load|could not read|could not save|could not write|not chosen|invalid export|export size/i

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
      const bytes = await renderAll(input, caps, route, sink, notice)
      return { encoder: routeLabel(route, input.settings.format), seconds: (performance.now() - t0) / 1000, bytes }
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
    return (canvas, ctx, startJob, base) =>
      new RawFrameSink(canvas, ctx, (pixelFormat) => startJob({ ...base, video: { kind: 'raw', encoder: route.encoder, pixelFormat } }))
  }
  const { width, height, fps } = exportDimensions(input.project, input.settings)
  const config = await supportedAvcConfig(avcConfigs(width, height, fps, input.settings.quality, route.hardware))
  if (!config) return null
  return (canvas, _ctx, startJob, base) => new WebCodecsSink(canvas, config, fps, (color) => startJob({ ...base, video: { kind: 'h264', color } }))
}

async function openElementSource(url: string, times: number[], fps: number): Promise<{ source: FrameSource; video: HTMLVideoElement }> {
  const video = createVideo(url)
  video.muted = true
  try {
    await whenReady(video)
  } catch (e) {
    disposeVideo(video)
    throw e
  }
  return { source: new ElementFrameSource(video, times, fps), video }
}

/**
 * Frames come from WebCodecs decoding when possible; otherwise, or if decoding
 * fails part-way, from seeking a <video> element. `videos` collects the elements
 * created so they can be released. `fallbackFps` is the proxy's usual frame rate,
 * used by the seeking path when the file's own rate cannot be read.
 */
async function openSource(url: string, times: number[], caps: ExportCapabilities, videos: HTMLVideoElement[], fallbackFps: number): Promise<FrameSource> {
  let media: MediaTrack | null = null
  try {
    media = await openTrack(url)
  } catch (e) {
    console.warn('Could not index the video for WebCodecs decoding, seeking the video element instead:', e)
  }
  const fps = media?.fps ?? fallbackFps
  const element = async (): Promise<FrameSource> => {
    const { source, video } = await openElementSource(url, times, fps)
    videos.push(video)
    return source
  }
  if (media && caps.overrides.decoder !== 'element') {
    try {
      const decoder = await DecoderFrameSource.open(media, times)
      if (decoder) return new ResilientFrameSource(decoder, element)
    } catch (e) {
      console.warn('WebCodecs decoding unavailable, seeking the video element instead:', e)
    }
  }
  return element()
}

function disposeVideo(v: HTMLVideoElement): void {
  v.removeAttribute('src')
  v.load()
}

async function renderAll(input: ExportInput, caps: ExportCapabilities, route: ExportRoute, makeSink: SinkFactory, notice: string | undefined): Promise<number> {
  const { project, settings, signal } = input
  const { width, height, fps } = exportDimensions(project, settings)
  const times = exportFrameTimes(project.clips, fps)
  const encoder = routeLabel(route, settings.format)
  const report = (p: Omit<ExportProgress, 'encoder' | 'frames' | 'notice'>): void => input.onProgress({ ...p, frames: times.length, encoder, notice })
  report({ phase: 'preparing', frame: 0, fps: 0, eta: null })

  const useWebcam = !!input.webcamUrl && project.webcam.show && project.hasWebcam
  const videos: HTMLVideoElement[] = []
  const screen = await openSource(input.screenUrl, times, caps, videos, SCREEN_PROXY_FPS)
  let camera: FrameSource | null = null
  // drawFrame wants an element even when it draws decoded frames; this one is never shown.
  const placeholder = document.createElement('video')
  let sink: FrameSink | null = null
  const onAbort = (): void => void window.api.exportCancel()
  signal.addEventListener('abort', onAbort)
  try {
    if (useWebcam) camera = await openSource(input.webcamUrl!, times.map((t) => t - project.webcamOffset), caps, videos, WEBCAM_PROXY_FPS)
    if (signal.aborted) throw abortError()

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    // A GPU canvas whenever Chromium has one: the decoded frames are GPU textures and
    // the compositor (scaling, motion-blur sub-frames, shadows) runs on the GPU;
    // raw-frame routes read each finished frame back once (RawFrameSink).
    // willReadFrequently would make the canvas CPU-rasterised, reading back every
    // source frame and blur sub-frame drawn onto it. Without a GPU canvas (blocklisted
    // or missing GPU) the canvas is on the CPU anyway, and the hint saves a copy per readback.
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: route.video === 'ffmpeg' && !caps.gpuCanvas })
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
    const sources = { screen: placeholder, webcam: null, background: input.background }
    // Speed over the last ~1 s of frames, for the fps readout and the ETA.
    const stamps: number[] = []
    let lastReport = 0
    const spent = { decode: 0, draw: 0, encode: 0 }
    for (let i = 0; i < times.length; i++) {
      if (signal.aborted) throw abortError()
      const a = performance.now()
      const [screenFrame, webcamFrame] = await Promise.all([screen.get(i), camera ? camera.get(i) : null])
      const b = performance.now()
      drawFrame(ctx, width, height, times[i], input.scene, { ...sources, screenFrame, webcamFrame }, options)
      // The canvas holds the pixels now: let the sources start on the next frame.
      screen.next()
      camera?.next()
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
      `export: ${times.length} frames ${width}x${height} via ${encoder}, ${screen.kind} decoding${camera ? ` (webcam: ${camera.kind})` : ''}; per frame ms: wait decode ${ms(spent.decode)}, draw ${ms(spent.draw)}, encode/IPC ${ms(spent.encode)}`
    )
    report({ phase: 'finalizing', frame: times.length, fps: 0, eta: null })
    const bytes = await sink.finish()
    if (signal.aborted) throw abortError()
    return bytes
  } catch (err) {
    // Stops ffmpeg (also while it is finishing) and deletes the partial file.
    await window.api.exportCancel().catch(() => undefined)
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
    sink?.close()
    screen.close()
    camera?.close()
    videos.forEach(disposeVideo)
  }
}
