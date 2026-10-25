/**
 * What the camera director needs from the recording's media (docs/design/camera-director.md):
 * - speech: the levels of the microphone stem (or the mixed track) through loadAudioAnalysis,
 *   which measures each source once per editor session and shares it with the preview's ducking
 *   and smart speed, turned into speech ranges (speech.ts) and refined by the transcript;
 * - face framing: camera frames at the sampled times (faceSampleTimes), seeked on a hidden muted
 *   <video> of their own (the preview's camera is never seeked), segmented by the bundled person
 *   segmenter (segmentPicture), the head found in each mask and one framing made of them
 *   (faceFraming.ts). Cached per camera file and sample times for the editor session.
 *
 * CONTRACT (workstream B): signatures are frozen; bodies are to be written. The stubs resolve to
 * "nothing known" so the Camera panel can be built against them.
 */
import type { DirectorSpeech } from '../../../shared/audio/speech'
import type { FramingOutcome } from '../../../shared/render/faceFraming'
import type { CursorTrack, Project } from '../../../shared/types'

/** The director's speech for a project. */
export interface SpeechResult {
  /** Null when the recording has no sound and no transcript, or nothing could be measured. */
  speech: DirectorSpeech | null
  /** The recording has sound but it could not be measured (the panel offers Try again). */
  failed: boolean
}

/**
 * Speech of `project` for the director: the levels of speechLevelSource(project) (requested by
 * name, so a muted source still counts), speechFromLevels with `cursor`'s input as noise, then
 * refineSpeech with the transcript. Never rejects; a failed measurement is retried on the next
 * call (loadAudioAnalysis drops it from its cache).
 */
export async function loadDirectorSpeech(project: Pick<Project, 'id' | 'hasAudio' | 'audioStems' | 'transcript'>, cursor: CursorTrack): Promise<SpeechResult> {
  void project
  void cursor
  return { speech: null, failed: false }
}

/** How far face framing has got: pictures segmented of those sampled. */
export interface FaceProgress {
  done: number
  total: number
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
  void webcamUrl
  void cameraTimes
  void maxZoom
  void options
  return { status: 'unavailable', reason: 'face framing is not built yet' }
}
