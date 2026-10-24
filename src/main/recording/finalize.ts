import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProcessingProgress } from '../../shared/api/recording'
import { SOURCE_FILES, STEM_KINDS, type StemKind } from '../../shared/audio/settings'
import { createProject } from '../../shared/engine/project'
import { autoZoomsForTrack, zoomSettingsOf } from '../../shared/engine/zoom'
import type { Project } from '../../shared/types'
import { detectH264Encoders, type H264Encoder } from '../hwEncoders'
import * as projects from '../projects'
import { muxAudioArgs, proxyArgs, regionPixels, stemArgs, type ExternalAudio, type ProxyOptions } from '../proxyArgs'
import { applyStyleDefaults, loadStyleDefaults } from '../styleDefaults'
import { EmptyRecordingError, RecordingError } from './errors'
import { cancelledError, FfmpegError, isCancelled, runFfmpegProgress, type FfmpegRun } from './proxyRunner'
import { STEM_RAW } from './stems'
import { clampTrack } from './trackMath'

export { EmptyRecordingError, RecordingError }

/** Frame rate of the screen proxy: the recording's own (30 or 60; older manifests: 60). */
export const screenFps = (manifest: Pick<projects.RecordingManifest, 'fps'>): 30 | 60 => (manifest.fps === 30 ? 30 : 60)
/** The native video proxy before its separately recorded audio is added. */
const VIDEO_ONLY = 'screen.video.mp4'

export function friendlyFfmpegError(err: unknown, what: string): RecordingError {
  if (err instanceof RecordingError) return err
  const e = err as NodeJS.ErrnoException & { code?: string | null }
  if (e?.code === 'ENOENT') return new RecordingError('The video converter (ffmpeg) is missing. Please reinstall Screen Studio for Windows.')
  if (e?.code === 'ENOSPC' || /No space left/i.test(e?.message ?? '')) return new RecordingError('Your disk is full. Free some space and try again.')
  const detail = err instanceof FfmpegError ? err.message : e?.message
  return new RecordingError(`Couldn't convert the ${what}${detail ? ` (${detail})` : ''}.`)
}

/**
 * Encodes with each encoder in turn until one succeeds. A stop on purpose (`signal`,
 * "Finish later") is never mistaken for an encoder failure: it ends the loop at once.
 */
export async function encodeWithFallback(
  encoders: H264Encoder[],
  build: (encoder: H264Encoder) => string[],
  output: string,
  onFrames: (frames: number) => void,
  signal?: AbortSignal
): Promise<FfmpegRun> {
  let lastError: unknown = null
  for (const encoder of encoders) {
    if (signal?.aborted) throw cancelledError()
    try {
      return await runFfmpegProgress(build(encoder), onFrames, signal)
    } catch (err) {
      await fs.rm(output, { force: true, maxRetries: 3 }).catch(() => undefined)
      if (isCancelled(err) || signal?.aborted) throw cancelledError()
      lastError = err
      // A GPU encoder can still fail on real content (driver, size limits): retry in software.
      console.warn(`Proxy encode with ${encoder} failed:`, err)
      if (err instanceof FfmpegError && err.code === 'ENOENT') break
    }
  }
  throw lastError
}

const removeQuietly = (file: string): Promise<void> =>
  fs.rm(file, { force: true, maxRetries: 3 }).catch((err) => console.warn('Could not remove', file, err))

/**
 * Keeps the microphone and system sound recorded on their own as mic.m4a / system.m4a, on the
 * proxy's timeline (same offset as the separately recorded mixed sound). Optional extras: a
 * stem that cannot be converted is left out (the mixed sound has it) and never fails the
 * recording; only a stop on purpose ("Finish later") ends processing.
 */
async function keepStems(
  dir: string,
  offset: number,
  duration: number | null,
  progress: (message: string) => void,
  signal?: AbortSignal
): Promise<StemKind[]> {
  const kept: StemKind[] = []
  for (const kind of STEM_KINDS) {
    const raw = path.join(dir, STEM_RAW[kind])
    if ((await projects.fileSize(raw)) === 0) continue
    if (signal?.aborted) throw cancelledError()
    progress('Keeping the microphone and system sound…')
    const out = path.join(dir, SOURCE_FILES[kind])
    try {
      await runFfmpegProgress(stemArgs(raw, out, offset, duration), undefined, signal)
      kept.push(kind)
    } catch (err) {
      await removeQuietly(out)
      if (isCancelled(err) || signal?.aborted) throw cancelledError()
      console.error(`The ${kind} sound could not be kept on its own (it stays in the mixed sound):`, err)
    }
  }
  return kept
}

/** The user's saved default look; a missing or unreadable file never stops a recording from being saved. */
async function withStyleDefaults(project: Project): Promise<Project> {
  try {
    return applyStyleDefaults(project, await loadStyleDefaults())
  } catch (err) {
    console.warn('Could not apply the saved default style:', err)
    return project
  }
}

/**
 * Turns the raw files of a stopped (or interrupted) recording into a project:
 * seekable proxies, the final duration, cursor track and auto zooms. Raw files are
 * removed only after everything succeeded, so a failure can always be retried.
 *
 * Aborting `signal` ("Finish later") stops at once with a CANCELLED FfmpegError and
 * writes no project: the recording stays unfinished with every raw file kept.
 */
export async function processRecording(
  manifest: projects.RecordingManifest,
  progress: (p: ProcessingProgress) => void,
  signal?: AbortSignal
): Promise<Project> {
  const { id } = manifest
  const dir = projects.projectDir(id)
  const stopIfCancelled = (): void => {
    if (signal?.aborted) throw cancelledError()
  }
  const native = manifest.method === 'native'
  const screenIn = path.join(dir, native ? projects.RAW.native : projects.RAW.screen)
  if ((await projects.fileSize(screenIn)) === 0) {
    throw new EmptyRecordingError('Nothing was captured: the recording contains no video.')
  }
  const audioIn = path.join(dir, projects.RAW.audio)
  const audio: ExternalAudio | null =
    native && manifest.hasAudio && (await projects.fileSize(audioIn)) > 0 ? { input: audioIn, offset: manifest.audioOffset } : null
  const webcamIn = path.join(dir, projects.RAW.webcam)
  const hasWebcam = manifest.hasWebcam && (await projects.fileSize(webcamIn)) > 0

  const screenRate = screenFps(manifest)
  const known = manifest.width > 0 && manifest.height > 0
  const region = manifest.sourceKind === 'screen' ? manifest.region : null
  const size = !known
    ? null
    : region
      ? regionPixels(region, manifest.width, manifest.height)
      : { width: 2 * Math.floor(manifest.width / 2), height: 2 * Math.floor(manifest.height / 2) }

  const encoders = [...new Set<H264Encoder>([(await detectH264Encoders())[0], 'libx264'])]
  const expected = manifest.duration && manifest.duration > 0 ? manifest.duration : null
  const webcamShare = hasWebcam ? 0.2 : 0
  const audioShare = audio ? 0.05 : 0
  const videoShare = 1 - webcamShare - audioShare
  const report = (message: string, base: number, share: number, fps: number) => (frames: number) =>
    progress({ message, progress: expected ? Math.min(1, base + share * Math.min(1, frames / fps / expected)) : null })

  const screenOut = path.join(dir, 'screen.mp4')
  const webcamOut = path.join(dir, 'webcam.mp4')
  // Native capture: the video is encoded on its own first, then the audio is added, cut to its exact length.
  const videoOut = audio ? path.join(dir, VIDEO_ONLY) : screenOut
  try {
    stopIfCancelled()
    progress({ message: 'Optimising video for editing…', progress: expected ? 0 : null })
    const options: ProxyOptions = { fps: screenRate, size, crop: region, progress: true, faststart: !audio }
    let screenRun: FfmpegRun
    try {
      screenRun = await encodeWithFallback(
        encoders,
        (encoder) => proxyArgs(screenIn, videoOut, !native && manifest.hasAudio, { ...options, encoder }),
        videoOut,
        report('Optimising video for editing…', 0, videoShare, screenRate),
        signal
      )
    } catch (err) {
      if (isCancelled(err)) throw err
      throw friendlyFfmpegError(err, 'recording')
    }
    // The proxy is constant-rate, so its frame count is the real video length, even
    // when the recorder's own clock was wrong (e.g. the captured window closed).
    const videoSeconds = screenRun.frames ? screenRun.frames / screenRate : null

    if (audio) {
      try {
        await runFfmpegProgress(muxAudioArgs(videoOut, screenOut, audio, videoSeconds), report('Adding audio…', videoShare, audioShare, screenRate), signal)
      } catch (err) {
        if (isCancelled(err)) throw err
        throw friendlyFfmpegError(err, 'audio')
      } finally {
        await removeQuietly(videoOut)
      }
    }

    // The video's exact length (from its frame count), or the recorder's measure.
    const length = videoSeconds && videoSeconds > 0.1 ? videoSeconds : (manifest.duration ?? null)
    const hasAudio = native ? !!audio : manifest.hasAudio && screenRun.inputHasAudio
    const stems = hasAudio
      ? await keepStems(dir, manifest.audioOffset, length, (message) => progress({ message, progress: expected ? videoShare + audioShare : null }), signal)
      : []

    let webcamOk = false
    if (hasWebcam) {
      stopIfCancelled()
      const fps = manifest.webcamFps || 30
      try {
        await encodeWithFallback(
          encoders,
          (encoder) => proxyArgs(webcamIn, webcamOut, false, { fps, progress: true, encoder }),
          webcamOut,
          report('Optimising camera…', videoShare + audioShare, webcamShare, fps),
          signal
        )
        webcamOk = true
      } catch (err) {
        // Stopped on purpose: never save the project without its camera.
        if (isCancelled(err)) throw err
        // The screen recording is what matters; keep the raw camera file for later.
        console.error('Camera proxy failed; the project opens without the camera:', err)
      }
    }

    stopIfCancelled()
    progress({ message: 'Finishing…', progress: 1 })
    const duration = videoSeconds && videoSeconds > 0.1 ? videoSeconds : (manifest.duration ?? 0.1)
    const outSize =
      size ??
      (screenRun.inputSize
        ? { width: 2 * Math.floor(screenRun.inputSize.width / 2), height: 2 * Math.floor(screenRun.inputSize.height / 2) }
        : { width: 1920, height: 1080 })
    const cursor = clampTrack(await projects.readCursor(id), duration)
    await projects.writeCursor(id, cursor)

    let project = createProject({
      id,
      name: new Date(manifest.createdAt).toLocaleString(),
      duration,
      width: outSize.width,
      height: outSize.height,
      hasWebcam: webcamOk,
      hasAudio,
      webcamOffset: webcamOk ? manifest.webcamOffset : 0,
      zooms: [],
      cursorValid: cursor.valid,
      capture: {
        method: manifest.method,
        cursorInVideo: !native,
        region,
        target: manifest.sourceKind === 'window' ? 'window' : region ? 'area' : 'screen',
        fps: screenRate
      }
    })
    project.createdAt = manifest.createdAt
    if (stems.length > 0) project.audioStems = { mic: stems.includes('mic'), system: stems.includes('system') }
    project = await withStyleDefaults(project)
    // After the saved defaults, which may include how auto zoom works (clicks, typing, marks).
    project.zooms = autoZoomsForTrack(cursor, duration, zoomSettingsOf(project).auto)
    // A stop that landed between two steps must not leave a project behind.
    stopIfCancelled()
    await projects.writeProject(project)

    // The proxies are now the source of truth; drop the large intermediates.
    await removeQuietly(screenIn)
    if (audio) await removeQuietly(audioIn)
    for (const kind of STEM_KINDS) await removeQuietly(path.join(dir, STEM_RAW[kind]))
    if (webcamOk) await removeQuietly(webcamIn)
    await projects.removeManifest(id)
    return project
  } catch (err) {
    // Stopped: the raw files stay for later; half-built proxies would only take up space.
    if (isCancelled(err)) {
      const stemOuts = STEM_KINDS.map((k) => path.join(dir, SOURCE_FILES[k]))
      await Promise.all([screenOut, videoOut, webcamOut, ...stemOuts].map((f) => fs.rm(f, { force: true, maxRetries: 3 }).catch(() => undefined)))
    }
    throw err
  }
}
