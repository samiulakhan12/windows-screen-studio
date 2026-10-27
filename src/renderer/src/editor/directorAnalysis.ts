/**
 * What the camera director needs from the recording's media (docs/design/camera-director.md):
 * - speech: the levels of the microphone stem (or the mixed track) through loadAudioAnalysis,
 *   which measures each source once per editor session and shares it with the preview's ducking
 *   and smart speed, turned into speech ranges (speech.ts) and refined by the transcript;
 * - face framing: camera frames at the sampled times (faceSampleTimes), seeked on a hidden muted
 *   <video> of their own (the preview's camera is never seeked), segmented by the bundled person
 *   segmenter (segmentPicture), the head found in each mask and one framing made of them
 *   (faceFraming.ts). Cached per camera file and sample times for the editor session.
 */
import type { Range } from '../../../shared/audio/activity'
import type { AudioLevels } from '../../../shared/audio/loudness'
import { refineSpeech, speechFromLevels, speechLevelSource, type DirectorSpeech } from '../../../shared/audio/speech'
import { faceBoxOfMask, framingFromFaces, type FaceBox, type FramingOutcome } from '../../../shared/render/faceFraming'
import type { CursorTrack, Project } from '../../../shared/types'
import { ensureSegmenter, segmentPicture, segmenterState } from '../render/segmentation/personSegmenter'
import { loadAudioAnalysis } from './audioAnalysis'
import { createVideo, seekedFrame, seekToFrame, WEBCAM_PROXY_FPS, whenReady } from './media'

/** The director's speech for a project. */
export interface SpeechResult {
  /**
   * Null when there is no sound to listen to (speechLevelSource: none recorded, or PC sound only)
   * and no transcript, or nothing could be measured.
   */
  speech: DirectorSpeech | null
  /** The recording has sound but it could not be measured (the panel offers Try again). */
  failed: boolean
}

/** Speech ranges of one envelope with one track's input as noise (the levels are shared for the session). */
const speechCache = new WeakMap<AudioLevels, WeakMap<CursorTrack, Range[]>>()

function speechOf(levels: AudioLevels, cursor: CursorTrack): Range[] {
  let byTrack = speechCache.get(levels)
  if (!byTrack) speechCache.set(levels, (byTrack = new WeakMap()))
  let ranges = byTrack.get(cursor)
  if (!ranges) byTrack.set(cursor, (ranges = speechFromLevels(levels, cursor)))
  return ranges
}

/**
 * Speech of `project` for the director: the levels of speechLevelSource(project) (requested by
 * name, so a muted source still counts), speechFromLevels with `cursor`'s input as noise, then
 * refineSpeech with the transcript. Never rejects; a failed measurement is retried on the next
 * call (loadAudioAnalysis drops it from its cache).
 */
export async function loadDirectorSpeech(project: Pick<Project, 'id' | 'hasAudio' | 'audioStems' | 'transcript'>, cursor: CursorTrack): Promise<SpeechResult> {
  const source = speechLevelSource(project)
  if (!source) return { speech: refineSpeech(null, project.transcript), failed: false }
  let levels: AudioLevels | undefined
  try {
    levels = (await loadAudioAnalysis(project.id, [source]))[source]
  } catch (err) {
    console.warn(`Could not measure the ${source} sound for the camera director:`, err)
  }
  // The source exists (the project says so), so missing levels mean the measurement failed:
  // the transcript, when there is one, still tells when the person talks.
  if (!levels) return { speech: refineSpeech(null, project.transcript), failed: true }
  // The detector is named for the status line: speech ranges from the bundled speech detector, or the level.
  return { speech: refineSpeech({ source, ranges: speechOf(levels, cursor), detector: levels.speech ? 'speech' : 'level' }, project.transcript), failed: false }
}

/** How far face framing has got: pictures segmented of those sampled. */
export interface FaceProgress {
  done: number
  total: number
}

/** Longest wait for one seek of the camera, ms; that picture is skipped after it. */
const SEEK_TIMEOUT = 3000
/** Longest wait for the camera video to load, ms. */
const LOAD_TIMEOUT = 10000
/** Camera files and sample times measured in this editor session, and how many are kept. */
const CACHE_SIZE = 8

interface Measured {
  faces: (FaceBox | null)[]
  camW: number
  camH: number
}

const measured = new Map<string, Measured>()

class Aborted extends Error {}

/** `promise`, or a rejection after `ms` or when `signal` aborts (Aborted). */
function bounded<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = Number.isFinite(ms) ? setTimeout(() => finish(() => reject(new Error('timed out'))), ms) : undefined
    const onAbort = (): void => finish(() => reject(new Aborted()))
    const finish = (then: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      then()
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort)
    promise.then(
      (v) => finish(() => resolve(v)),
      (err: unknown) => finish(() => reject(err))
    )
  })
}

function outcomeOf(m: Measured, maxZoom: number): FramingOutcome {
  const found = m.faces.filter((f) => f !== null).length
  const framing = framingFromFaces(m.faces, m.camW, m.camH, maxZoom)
  if (!framing) return { status: 'not-found', found, sampled: m.faces.length }
  return { status: 'framed', ...framing }
}

const unavailable = (fallback: string): FramingOutcome => {
  const state = segmenterState()
  return { status: 'unavailable', reason: state.status === 'failed' ? state.reason : fallback }
}

/**
 * Face framing from the camera video at `webcamUrl`, sampled at `cameraTimes` (camera seconds,
 * faceSampleTimes), zoom at most `maxZoom` (DirectorPlan.framingCap). Seeks a hidden muted video
 * element of its own (3 s timeout per seek, then that picture is skipped), segments each frame
 * (ensureSegmenter, segmentPicture), finds the head (faceBoxOfMask) and makes one framing
 * (framingFromFaces). Resolves 'unavailable' with segmenterState's reason when person detection
 * cannot run, 'not-found' when too few faces were found. Never rejects; stops early (resolving
 * 'skipped') when `signal` aborts; releases the element and every frame.
 */
export async function measureFraming(
  webcamUrl: string,
  cameraTimes: readonly number[],
  maxZoom: number,
  options: { onProgress?: (p: FaceProgress) => void; signal?: AbortSignal } = {}
): Promise<FramingOutcome> {
  const { onProgress, signal } = options
  if (signal?.aborted) return { status: 'skipped' }
  const times = cameraTimes.filter((t) => Number.isFinite(t))
  const key = `${webcamUrl}\u0000${times.join(',')}`
  const known = measured.get(key)
  if (known) {
    onProgress?.({ done: times.length, total: times.length })
    return outcomeOf(known, maxZoom)
  }
  let video: HTMLVideoElement | null = null
  try {
    if (!(await bounded(ensureSegmenter(), Infinity, signal))) return unavailable('person detection could not start')
    if (times.length === 0) return { status: 'not-found', found: 0, sampled: 0 }
    onProgress?.({ done: 0, total: times.length })
    video = createVideo(webcamUrl)
    video.muted = true
    const loaded = await bounded(whenReady(video), LOAD_TIMEOUT, signal).then(
      () => true,
      (err: unknown) => {
        if (err instanceof Aborted) throw err
        return false
      }
    )
    const camW = video.videoWidth
    const camH = video.videoHeight
    if (!loaded || !(camW > 0 && camH > 0)) return { status: 'unavailable', reason: 'the camera video could not be read' }
    const faces: (FaceBox | null)[] = []
    for (const t of times) {
      faces.push(await faceAt(video, t, signal))
      if (segmenterState().status === 'failed') return unavailable('person detection stopped working')
      onProgress?.({ done: faces.length, total: times.length })
    }
    const result: Measured = { faces, camW, camH }
    measured.set(key, result)
    while (measured.size > CACHE_SIZE) measured.delete(measured.keys().next().value as string)
    return outcomeOf(result, maxZoom)
  } catch (err) {
    if (err instanceof Aborted) return { status: 'skipped' }
    console.warn('Face framing failed:', err)
    return unavailable(err instanceof Error ? err.message : String(err))
  } finally {
    if (video) {
      video.removeAttribute('src')
      video.load()
    }
  }
}

/** The head in the camera picture at camera time `t`, or null (not found, the seek timed out, no mask). */
async function faceAt(video: HTMLVideoElement, t: number, signal: AbortSignal | undefined): Promise<FaceBox | null> {
  try {
    await bounded(seekToFrame(video, t, WEBCAM_PROXY_FPS), SEEK_TIMEOUT, signal)
  } catch (err) {
    if (err instanceof Aborted) throw err
    return null
  }
  const shown = await seekedFrame(video, t, WEBCAM_PROXY_FPS)
  const frame = shown?.frame ?? null
  try {
    if (signal?.aborted) throw new Aborted()
    const width = frame ? frame.displayWidth : video.videoWidth
    const height = frame ? frame.displayHeight : video.videoHeight
    if (!(width > 0 && height > 0)) return null
    const mask = await bounded(segmentPicture(frame ?? video, width, height), Infinity, signal)
    return mask ? faceBoxOfMask(mask.pixels.data, mask.pixels.width, mask.pixels.height) : null
  } finally {
    frame?.close()
  }
}
