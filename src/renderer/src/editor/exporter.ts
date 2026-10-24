import type { ExportCapabilities, ExportJob } from '../../../shared/api/export'
import { exportFrameTimes } from '../../../shared/engine/timeline'
import { clickSoundJob } from '../../../shared/render/clickSound'
import { exportDimensions, exportProject, exportRoutes, isAudioOnly, MB, routeLabel, targetBitrates, type ExportRoute } from '../../../shared/render/exportPlan'
import type { ExportOptions } from '../../../shared/render/exportPresets'
import type { Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'
import { prepareCursorAssets } from '../render/cursorLayer'
import { prepareStyleAssets } from '../render/watermarkLayer'
import { avcConfigs, cleanIpcError, RawFrameSink, supportedAvcConfig, vp9Configs, WebCodecsSink, type FrameSink } from '../render/encoders'
import { DecoderFrameSource, ElementFrameSource, openTrack, ResilientFrameSource, type FrameSource, type MediaTrack } from '../render/frameSource'
import { projectMediaUrl } from '../../../shared/mediaUrl'
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
  /** What finalizing does when it takes a while ("second pass for the size target"). */
  detail?: string
}

/** What an export draws and where its media comes from (one editor session). */
export interface ExportSource {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
}

export interface ExportInput extends ExportSource {
  settings: ExportOptions
  outputPath: string
  onProgress: (p: ExportProgress) => void
  signal: AbortSignal
}

export interface ExportResult {
  encoder: string
  seconds: number
  bytes: number
  /** How a GIF was made smaller to fit its size limit. */
  reduced?: string
  /** A GIF that could not be made small enough. */
  overLimit?: boolean
}

/** Failures another encoder cannot fix (the disk, the folder, the target file, the recording). */
const NOT_ENCODER_RELATED = /disk is full|permission|in use|another app|read-only|missing|could not be read|could not load|could not read|could not save|could not write|not chosen|invalid export|export size|no sound/i

/** Most motion-blur sub-frames per exported frame (the preview uses fewer). */
export const EXPORT_BLUR_SAMPLES = 10
/** Audio-only exports end on the same frame boundary a 60 fps video would. */
const AUDIO_ONLY_FPS = 60

const abortError = (): DOMException => new DOMException('Export cancelled', 'AbortError')

/**
 * The input as this export draws it: a copy of the project with the export's aspect
 * ratio (the saved project is never touched), and the cursor's images loaded.
 */
async function prepare<T extends ExportSource & { settings: Pick<ExportOptions, 'aspect'> }>(input: T): Promise<T> {
  const project = exportProject(input.project, input.settings)
  const scene = project === input.project ? input.scene : { ...input.scene, project }
  await prepareCursorAssets(project, projectMediaUrl(project.id))
  await prepareStyleAssets(project, projectMediaUrl(project.id))
  return { ...input, project, scene }
}

/** The soundtrack parts of a job: the edited recording audio and the click sounds. */
function soundOf(input: ExportSource, format: ExportOptions['format']): Pick<ExportJob, 'audio' | 'clicks'> {
  const { project } = input
  if (format === 'gif') return {}
  const mute = project.audio.muted || project.audio.volume <= 0
  const audio = project.hasAudio && !mute ? { clips: project.clips, volume: project.audio.volume } : undefined
  const job = clickSoundJob(project, input.scene.cursor, project.clips)
  const clicks = job && job.times.length > 0 && job.volume > 0 ? { times: job.times, volume: job.volume } : undefined
  return { audio, clicks }
}

/** Bit rates for a size target (video formats other than GIF; GIFs are fitted by the main process). */
function rateOf(settings: ExportOptions, frames: number, size: { width: number; height: number; fps: number }, sound: boolean): Pick<ExportJob, 'bitrate' | 'maxBytes'> {
  const target = settings.targetSizeMB
  if (!target) return {}
  if (settings.format === 'gif') return { maxBytes: Math.round(target * MB) }
  const r = targetBitrates({ targetMB: target, seconds: frames / size.fps, hasAudio: sound, format: settings.format, ...size })
  return { bitrate: { video: r.video, audio: r.audio } }
}

/** What every route of one export shares: size, frame times, soundtrack and size-target rates. */
interface JobPlan {
  width: number
  height: number
  fps: number
  times: number[]
  sound: Pick<ExportJob, 'audio' | 'clicks'>
  rate: Pick<ExportJob, 'bitrate' | 'maxBytes'>
}

function planJob(input: ExportInput): JobPlan {
  const { width, height, fps } = exportDimensions(input.project, input.settings)
  const times = exportFrameTimes(input.project.clips, fps)
  const sound = soundOf(input, input.settings.format)
  const rate = rateOf(input.settings, times.length, { width, height, fps }, !!(sound.audio || sound.clicks))
  return { width, height, fps, times, sound, rate }
}

/**
 * Renders every frame through the same compositor as the preview and encodes it,
 * trying the fastest encoder first and falling back when one fails. Decoding the
 * next source frame, drawing, and encoding/IPC of the previous frame overlap.
 * Audio-only formats render nothing.
 */
export async function exportVideo(raw: ExportInput): Promise<ExportResult> {
  const input = await prepare(raw)
  const { signal } = input
  if (isAudioOnly(input.settings.format)) return exportAudio(input)
  const caps = await window.api.exportCapabilities()
  const routes = exportRoutes(input.settings, caps)
  const plan = planJob(input)
  let notice: string | undefined
  for (let r = 0; r < routes.length; r++) {
    const route = routes[r]
    if (signal.aborted) throw abortError()
    try {
      const sink = await prepareRoute(route, input, plan)
      if (!sink) continue
      const t0 = performance.now()
      const done = await renderAll(input, plan, caps, route, sink, notice)
      return { encoder: routeLabel(route, input.settings.format), seconds: (performance.now() - t0) / 1000, ...done }
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

/** M4A: the edited soundtrack (and click sounds) only; ffmpeg does all the work. */
async function exportAudio(input: ExportInput): Promise<ExportResult> {
  const { project, settings, signal } = input
  const frames = exportFrameTimes(project.clips, AUDIO_ONLY_FPS).length
  const encoder = routeLabel({ video: 'none' }, settings.format)
  const report = (phase: ExportProgress['phase']): void => input.onProgress({ phase, frame: 0, frames, fps: 0, eta: null, encoder, detail: phase === 'finalizing' ? 'Encoding the audio…' : undefined })
  report('preparing')
  const sound = soundOf(input, settings.format)
  if (!sound.audio && !sound.clicks) throw new Error('This recording has no sound to export. Turn the audio on in the Audio panel, or choose a video format.')
  const t0 = performance.now()
  const onAbort = (): void => void window.api.exportCancel()
  signal.addEventListener('abort', onAbort)
  try {
    const job: ExportJob = {
      width: 0,
      height: 0,
      fps: AUDIO_ONLY_FPS,
      frames,
      format: settings.format,
      quality: settings.quality,
      video: { kind: 'none' },
      ...sound,
      ...rateOf(settings, frames, { width: 0, height: 0, fps: AUDIO_ONLY_FPS }, true),
      outputPath: input.outputPath
    }
    await window.api.exportStart(project.id, job)
    if (signal.aborted) throw abortError()
    report('finalizing')
    const done = await window.api.exportFinish()
    if (signal.aborted) throw abortError()
    return { encoder, seconds: (performance.now() - t0) / 1000, ...done }
  } catch (err) {
    await window.api.exportCancel().catch(() => undefined)
    if (signal.aborted) throw abortError()
    throw cleanIpcError(err)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

type SinkFactory = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, startJob: (job: ExportJob) => Promise<void>, base: Omit<ExportJob, 'video'>) => FrameSink

/** Checks that a route can run here; returns a factory for its sink, or null to skip it. */
async function prepareRoute(route: ExportRoute, input: ExportInput, plan: JobPlan): Promise<SinkFactory | null> {
  if (route.video === 'none') return null
  if (route.video === 'ffmpeg') {
    return (canvas, ctx, startJob, base) =>
      new RawFrameSink(canvas, ctx, (pixelFormat) => startJob({ ...base, video: { kind: 'raw', encoder: route.encoder, pixelFormat } }))
  }
  const { width, height, fps } = plan
  const configs = route.codec === 'vp9' ? vp9Configs : avcConfigs
  const config = await supportedAvcConfig(configs(width, height, fps, input.settings.quality, route.hardware, plan.rate.bitrate?.video))
  if (!config) return null
  const codec = route.codec
  return (canvas, _ctx, startJob, base) =>
    new WebCodecsSink(canvas, config, fps, (color) => startJob({ ...base, video: { kind: codec, color } }), codec === 'vp9' ? 'ivf' : 'annexb')
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

/** Short description of what finalizing does, for the progress line. */
function finalizingDetail(route: ExportRoute, job: Pick<ExportJob, 'bitrate' | 'maxBytes' | 'format'>): string | undefined {
  if (job.format === 'gif') return job.maxBytes ? 'Building the GIF and fitting it to its size limit…' : 'Building the GIF…'
  if (job.bitrate && route.video === 'ffmpeg' && (route.encoder === 'libx264' || route.encoder === 'libvpx-vp9')) return 'Encoding to the size target (two passes)…'
  return undefined
}

async function renderAll(
  input: ExportInput,
  plan: JobPlan,
  caps: ExportCapabilities,
  route: ExportRoute,
  makeSink: SinkFactory,
  notice: string | undefined
): Promise<Omit<ExportResult, 'encoder' | 'seconds'>> {
  const { project, settings, signal } = input
  const { width, height, fps, times } = plan
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

    const base: Omit<ExportJob, 'video'> = {
      width,
      height,
      fps,
      frames: times.length,
      format: settings.format,
      quality: settings.quality,
      ...plan.sound,
      ...plan.rate,
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
    report({ phase: 'finalizing', frame: times.length, fps: 0, eta: null, detail: finalizingDetail(route, base) })
    const done = await sink.finish()
    if (signal.aborted) throw abortError()
    return done
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

/* ---------- Thumbnail ---------- */

export interface ThumbnailInput extends ExportSource {
  settings: ExportOptions
  /** Source (recording) time of the frame. */
  time: number
}

/**
 * The frame at `time` exactly as the export draws it (same size, aspect, decoder and
 * motion blur), as PNG bytes.
 */
export async function renderThumbnail(raw: ThumbnailInput): Promise<{ png: Uint8Array; width: number; height: number }> {
  const input = await prepare(raw)
  const { project } = input
  // An audio-only choice still gets a video-sized picture.
  const settings: ExportOptions = isAudioOnly(input.settings.format) ? { ...input.settings, format: 'mp4' } : input.settings
  const { width, height, fps } = exportDimensions(project, settings)
  const caps = await window.api.exportCapabilities()
  const videos: HTMLVideoElement[] = []
  const t = raw.time
  const screen = await openSource(input.screenUrl, [t], caps, videos, SCREEN_PROXY_FPS)
  let camera: FrameSource | null = null
  try {
    if (input.webcamUrl && project.webcam.show && project.hasWebcam) camera = await openSource(input.webcamUrl, [t - project.webcamOffset], caps, videos, WEBCAM_PROXY_FPS)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not create a drawing surface')
    const [screenFrame, webcamFrame] = await Promise.all([screen.get(0), camera ? camera.get(0) : null])
    const sources = { screen: document.createElement('video'), webcam: null, background: input.background, screenFrame, webcamFrame }
    drawFrame(ctx, width, height, t, input.scene, sources, { frameInterval: 1 / fps, blurSamples: EXPORT_BLUR_SAMPLES })
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not encode the thumbnail')
    return { png: new Uint8Array(await blob.arrayBuffer()), width, height }
  } finally {
    screen.close()
    camera?.close()
    videos.forEach(disposeVideo)
  }
}

/* ---------- Batch ---------- */

export interface BatchJob {
  key: string
  label: string
  fileName: string
  options: ExportOptions
}

export type BatchStatus =
  | { state: 'waiting' }
  | { state: 'running'; progress: ExportProgress | null }
  | ({ state: 'done'; path: string } & ExportResult)
  | { state: 'failed'; message: string }
  | { state: 'cancelled' }

/**
 * Exports `jobs` one after another into `folder` (chosen with chooseExportFolder). A
 * failed file does not stop the others; cancelling stops the current one (its partial
 * file is deleted) and skips the rest. Files already finished stay.
 */
export async function exportBatch(
  source: ExportSource,
  folder: string,
  jobs: readonly BatchJob[],
  onStatus: (index: number, status: BatchStatus) => void,
  signal: AbortSignal
): Promise<void> {
  for (let i = 0; i < jobs.length; i++) {
    if (signal.aborted) {
      for (let j = i; j < jobs.length; j++) onStatus(j, { state: 'cancelled' })
      return
    }
    const job = jobs[i]
    onStatus(i, { state: 'running', progress: null })
    try {
      const outputPath = await window.api.exportBatchPath(folder, job.fileName)
      const result = await exportVideo({
        ...source,
        settings: job.options,
        outputPath,
        signal,
        onProgress: (progress) => {
          if (!signal.aborted) onStatus(i, { state: 'running', progress })
        }
      })
      onStatus(i, { state: 'done', path: outputPath, ...result })
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        for (let j = i; j < jobs.length; j++) onStatus(j, { state: 'cancelled' })
        return
      }
      onStatus(i, { state: 'failed', message: cleanIpcError(err).message.split(/\n\s*\n/)[0] })
    }
  }
}
