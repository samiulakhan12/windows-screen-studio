import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProcessingProgress } from '../../shared/api/recording'
import { createProject } from '../../shared/engine/project'
import { generateAutoZooms } from '../../shared/engine/zoom'
import type { Project } from '../../shared/types'
import { detectH264Encoders, type H264Encoder } from '../hwEncoders'
import * as projects from '../projects'
import { muxAudioArgs, proxyArgs, regionPixels, type ExternalAudio, type ProxyOptions } from '../proxyArgs'
import { applyStyleDefaults, loadStyleDefaults } from '../styleDefaults'
import { EmptyRecordingError, RecordingError } from './errors'
import { cancelledError, FfmpegError, isCancelled, runFfmpegProgress, type FfmpegRun } from './proxyRunner'
import { clampTrack } from './trackMath'

export { EmptyRecordingError, RecordingError }

const SCREEN_FPS = 60
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
    const options: ProxyOptions = { fps: SCREEN_FPS, size, crop: region, progress: true, faststart: !audio }
    let screenRun: FfmpegRun
    try {
      screenRun = await encodeWithFallback(
        encoders,
        (encoder) => proxyArgs(screenIn, videoOut, !native && manifest.hasAudio, { ...options, encoder }),
        videoOut,
        report('Optimising video for editing…', 0, videoShare, SCREEN_FPS),
        signal
      )
    } catch (err) {
      if (isCancelled(err)) throw err
      throw friendlyFfmpegError(err, 'recording')
    }
    // The proxy is constant-rate, so its frame count is the real video length, even
    // when the recorder's own clock was wrong (e.g. the captured window closed).
    const videoSeconds = screenRun.frames ? screenRun.frames / SCREEN_FPS : null

    if (audio) {
      try {
        await runFfmpegProgress(muxAudioArgs(videoOut, screenOut, audio, videoSeconds), report('Adding audio…', videoShare, audioShare, SCREEN_FPS), signal)
      } catch (err) {
        if (isCancelled(err)) throw err
        throw friendlyFfmpegError(err, 'audio')
      } finally {
        await removeQuietly(videoOut)
      }
    }

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
      hasAudio: native ? !!audio : manifest.hasAudio && screenRun.inputHasAudio,
      webcamOffset: webcamOk ? manifest.webcamOffset : 0,
      zooms: generateAutoZooms(cursor.clicks, duration),
      cursorValid: cursor.valid,
      capture: { method: manifest.method, cursorInVideo: !native, region }
    })
    project.createdAt = manifest.createdAt
    project = await withStyleDefaults(project)
    // A stop that landed between two steps must not leave a project behind.
    stopIfCancelled()
    await projects.writeProject(project)

    // The proxies are now the source of truth; drop the large intermediates.
    await removeQuietly(screenIn)
    if (audio) await removeQuietly(audioIn)
    if (webcamOk) await removeQuietly(webcamIn)
    await projects.removeManifest(id)
    return project
  } catch (err) {
    // Stopped: the raw files stay for later; half-built proxies would only take up space.
    if (isCancelled(err)) {
      await Promise.all([screenOut, videoOut, webcamOut].map((f) => fs.rm(f, { force: true, maxRetries: 3 }).catch(() => undefined)))
    }
    throw err
  }
}
