/**
 * Running Auto colour on the camera's frames (docs/design/editing-polish.md §9.6): about 12
 * frames spread over the kept clips, read from a muted video element of its own at the person
 * segmenter's size (256 px on the long side), each with its person mask and head when segmentation
 * can run (the whole frame otherwise), then autoCameraGrade. Offline: nothing leaves the PC.
 *
 * startAutoColour is the editor's command (and the Camera tab's button): one run at a time, one
 * store update when it finds something (one undo step), and the notices of §2.5.
 */
import { autoCameraGrade, withAutoColour, type ColourSample } from '../../../shared/editor/autoColour'
import type { EditStore } from '../../../shared/editor/editStore'
import { segmentationSize } from '../../../shared/render/cameraLook'
import { faceBoxOfMask } from '../../../shared/render/faceFraming'
import type { ColorGrade, Project } from '../../../shared/types'
import { ensureSegmenter, segmentPicture } from '../render/segmentation/personSegmenter'
import { createVideo, seekedFrame, seekToFrame, WEBCAM_PROXY_FPS, whenReady } from './media'

/** Frames sampled. */
export const AUTO_COLOUR_FRAMES = 12
const LOAD_TIMEOUT = 10000
const SEEK_TIMEOUT = 3000

class Aborted extends Error {}

/** `promise`, or a rejection after `ms` (timed out) or when `signal` aborts. */
function bounded<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error('timed out'))), ms)
    const onAbort = (): void => finish(() => reject(new Aborted()))
    const finish = (then: () => void): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      then()
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
    promise.then(
      (v) => finish(() => resolve(v)),
      (err: unknown) => finish(() => reject(err))
    )
  })
}

/** Camera times of the frames: the middles of 12 equal slices of the kept clips, inside the camera file. */
export function autoColourTimes(project: Pick<Project, 'clips' | 'webcamOffset'>, cameraDuration: number): number[] {
  const clips = project.clips.filter((c) => c.end > c.start)
  const total = clips.reduce((sum, c) => sum + (c.end - c.start), 0)
  if (!(total > 0) || !(cameraDuration > 0)) return []
  const last = Math.max(0, cameraDuration - 0.05)
  const times = new Set<number>()
  for (let k = 0; k < AUTO_COLOUR_FRAMES; k++) {
    let at = ((k + 0.5) / AUTO_COLOUR_FRAMES) * total
    for (const c of clips) {
      const len = c.end - c.start
      if (at <= len) {
        const cam = c.start + at - project.webcamOffset
        if (cam >= 0 && cam <= last) times.add(Math.round(cam * 1000) / 1000)
        break
      }
      at -= len
    }
  }
  return [...times].sort((a, b) => a - b)
}

/** One frame of the camera at camera time `t`: its pixels at the segmenter's size, its mask and its head. */
async function sampleAt(video: HTMLVideoElement, t: number, segment: boolean, signal: AbortSignal, ctx: CanvasRenderingContext2D): Promise<ColourSample | null> {
  try {
    await bounded(seekToFrame(video, t, WEBCAM_PROXY_FPS), SEEK_TIMEOUT, signal)
  } catch (err) {
    if (err instanceof Aborted) throw err
    return null
  }
  const shown = await seekedFrame(video, t, WEBCAM_PROXY_FPS)
  const frame = shown?.frame ?? null
  try {
    if (signal.aborted) throw new Aborted()
    const camW = frame ? frame.displayWidth : video.videoWidth
    const camH = frame ? frame.displayHeight : video.videoHeight
    if (!(camW > 0 && camH > 0)) return null
    const size = segmentationSize(camW, camH)
    const c = ctx.canvas
    if (c.width !== size.width || c.height !== size.height) {
      c.width = size.width
      c.height = size.height
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(frame ?? video, 0, 0, camW, camH, 0, 0, size.width, size.height)
    const pixels = ctx.getImageData(0, 0, size.width, size.height).data
    const mask = segment ? await bounded(segmentPicture(frame ?? video, camW, camH), 30000, signal).catch((err: unknown) => {
      if (err instanceof Aborted) throw err
      return null
    }) : null
    // The mask is at the segmenter's size, as the pixels are.
    const usable = mask && mask.pixels.width === size.width && mask.pixels.height === size.height ? mask.pixels.data : null
    const face = usable ? faceBoxOfMask(usable, size.width, size.height) : null
    return {
      pixels,
      mask: usable,
      w: size.width,
      h: size.height,
      face: face ? { x: face.cx - face.w / 2, y: face.cy - face.h / 2, w: face.w, h: face.h } : null
    }
  } finally {
    frame?.close()
  }
}

/** The camera grade Auto colour finds for `project` (null: nothing to change, or nothing could be read). Rejects with an AbortError when `signal` aborts. */
export async function runAutoColour(deps: { project: Project; webcamUrl: string; signal: AbortSignal }): Promise<ColorGrade | null> {
  const { project, webcamUrl, signal } = deps
  const video = createVideo(webcamUrl)
  video.muted = true
  try {
    await bounded(whenReady(video), LOAD_TIMEOUT, signal)
    const times = autoColourTimes(project, video.duration)
    if (!times.length) return null
    const segment = await bounded(ensureSegmenter(), LOAD_TIMEOUT * 3, signal).catch((err: unknown) => {
      if (err instanceof Aborted) throw err
      return false
    })
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const samples: ColourSample[] = []
    for (const t of times) {
      const s = await sampleAt(video, t, segment, signal, ctx)
      if (s) samples.push(s)
    }
    return autoCameraGrade(samples)
  } catch (err) {
    if (err instanceof Aborted) throw new DOMException('Auto colour stopped', 'AbortError')
    throw err
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

/* ---------- the command ---------- */

export const AUTO_COLOUR_COPY = {
  noCamera: 'This recording has no camera',
  running: 'Balancing the camera’s colour…',
  done: 'Camera colour balanced · Ctrl + Z to undo',
  nothing: 'The camera’s colour already looks balanced',
  failed: 'The camera’s colour could not be balanced'
} as const

let running: AbortController | null = null
const listeners = new Set<() => void>()
const notify = (): void => {
  for (const cb of [...listeners]) cb()
}

/** Whether Auto colour is running. */
export const autoColourBusy = (): boolean => running !== null

/** Calls `cb` when Auto colour starts or ends; returns the function that stops it. */
export function onAutoColour(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Stops a running Auto colour (the editor closing); nothing is changed. */
export function stopAutoColour(): void {
  running?.abort()
}

/**
 * Auto colour for the camera, as the command and the Camera tab's button run it: one run at a
 * time; one store update when it finds a grade (with Auto colour's record, for Review mode).
 */
export async function startAutoColour(deps: {
  store: Pick<EditStore<Project>, 'state' | 'update'>
  webcamUrl: string | null
  notice: (message: string) => void
  run?: typeof runAutoColour
}): Promise<void> {
  const project = deps.store.state
  if (!deps.webcamUrl || !project.hasWebcam) return deps.notice(AUTO_COLOUR_COPY.noCamera)
  if (running) return
  const controller = new AbortController()
  running = controller
  notify()
  deps.notice(AUTO_COLOUR_COPY.running)
  try {
    const grade = await (deps.run ?? runAutoColour)({ project, webcamUrl: deps.webcamUrl, signal: controller.signal })
    if (controller.signal.aborted) return
    if (!grade) return deps.notice(AUTO_COLOUR_COPY.nothing)
    deps.store.update((p) => withAutoColour(p, grade))
    deps.notice(AUTO_COLOUR_COPY.done)
  } catch (err) {
    if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
    console.warn('Auto colour failed:', err)
    deps.notice(AUTO_COLOUR_COPY.failed)
  } finally {
    if (running === controller) running = null
    notify()
  }
}
