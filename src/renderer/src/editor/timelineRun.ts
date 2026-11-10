/**
 * The timeline step of an export (docs/design/output-and-languages.md §8.7): builds the plan from the
 * project (exportTimeline or recordingsTimeline) and asks main to write the files, after the video,
 * the stems and the sidecars. A failure never undoes the video: it comes back as `problem`.
 *
 * For "The original recordings" the plan describes the project's files as they are: the screen
 * recording's and the camera's rate, frame count and size from their own sample tables, and the
 * recording's sounds at the timeline's rate. Main checks every fact against the files before it
 * writes anything.
 */
import type { SoundStem, TimelineRequest, TimelineResult } from '../../../shared/api/export'
import { audioLook, stemsOf } from '../../../shared/audio/settings'
import { t } from '../../../shared/i18n/t'
import { exportTimeline, recordingsTimeline, timelineRate, type TimelinePlan, type TimelineSource } from '../../../shared/interchange/timelinePlan'
import { mediaUrl } from '../../../shared/mediaUrl'
import { cursorLook } from '../../../shared/render/cursorFx'
import { frameRate } from '../../../shared/render/frameTiming'
import { demuxVideoTrack } from '../../../shared/render/mp4'
import { RangeReader } from '../../../shared/render/rangeReader'
import { hasLibrarySounds } from '../../../shared/render/sfxJob'
import type { Project } from '../../../shared/types'

/** A video file's facts: its rate, its frame count and its size. */
export interface TrackFacts {
  fps: number
  frames: number
  width: number
  height: number
}

/** What the step reads and calls (tests replace them). */
export interface TimelineStepDeps {
  /** The facts of a project's video file, or null when it cannot be read. */
  track?: (url: string) => Promise<TrackFacts | null>
  write?: (request: TimelineRequest) => Promise<TimelineResult>
}

/** A rate read from sample durations, whole when it is within a hundredth of a whole number. */
const cleanRate = (fps: number): number => (Math.abs(fps - Math.round(fps)) < 0.01 ? Math.round(fps) : fps)

async function readTrack(url: string): Promise<TrackFacts | null> {
  try {
    const reader = await RangeReader.open(url)
    const track = await demuxVideoTrack((offset, length) => reader.read(offset, length), reader.size)
    const fps = frameRate(track.samples)
    if (!fps || track.samples.length === 0) return null
    return { fps: cleanRate(fps), frames: track.samples.length, width: track.codedWidth, height: track.codedHeight }
  } catch {
    return null
  }
}

/** Whether the export may have effects that sound (main leaves a silent Effects track out). */
function mayHaveEffects(project: Project): boolean {
  const cursor = cursorLook(project.cursor)
  return (cursor.clickSound && cursor.clickSoundVolume > 0) || hasLibrarySounds(project) || !!project.graphics?.some((g) => !!g.sound) || (project.bleeps?.length ?? 0) > 0
}

/**
 * The sources of a timeline over the recordings (§8.1): the screen recording, the camera when the
 * project has one, the microphone and the system sound (or the one mixed recording) at the timeline's
 * rate over the recording's length, and Music and Effects over the video when the export has them or
 * its stems carry them. Pure.
 */
export function recordingMedia(project: Project, fps: number, screen: TrackFacts, camera: TrackFacts | null, stems: readonly SoundStem[], videoFrames: number): TimelinePlan['media'] {
  const rate = timelineRate(fps)
  const sound = (frames: number): TimelineSource => ({ fps: rate, frames, audio: true, video: false })
  const media: TimelinePlan['media'] = { screen: { ...screen, audio: false, video: true } }
  if (camera && project.hasWebcam) media.camera = { ...camera, audio: false, video: true }
  if (project.hasAudio) {
    const length = Math.max(1, Math.round(project.duration * rate))
    const recorded = stemsOf(project)
    if (recorded.length === 0) media.recording = sound(length)
    if (recorded.includes('mic')) media.voice = sound(length)
    if (recorded.includes('system')) media.system = sound(length)
  }
  const look = audioLook(project.audio)
  if (stems.includes('music') || (look.music && look.music.volume > 0)) media.music = sound(videoFrames)
  if (stems.includes('effects') || mayHaveEffects(project)) media.effects = sound(videoFrames)
  return media
}

/** A failure of this step as the done view shows it: main's own sentences as they are, anything else after "The timeline could not be saved:". */
function problemText(reason: string): string {
  return reason === t('errors.timeline.invalid') || reason === t('errors.timeline.media') ? reason : t('timelines.done.failed', { reason })
}

/** Writes the timeline files of an export that just finished (§8.7). Resolves with every file written and what it is for. */
export async function writeTimelineStep(
  project: Project,
  request: Omit<TimelineRequest, 'plan'>,
  exported: { fps: number; frames: number; width: number; height: number },
  deps: TimelineStepDeps = {}
): Promise<TimelineResult> {
  const track = deps.track ?? readTrack
  const write = deps.write ?? ((r: TimelineRequest) => window.api.writeTimeline(r))
  try {
    let plan: TimelinePlan
    if (request.media === 'export') plan = exportTimeline(project, exported, request.stems.map((s) => s.stem))
    else {
      const screen = await track(mediaUrl(project.id, 'screen.mp4'))
      if (!screen) return { files: [], problem: t('errors.timeline.media') }
      const camera = project.hasWebcam ? await track(mediaUrl(project.id, 'webcam.mp4')) : null
      const rate = timelineRate(exported.fps)
      const videoFrames = Math.max(1, Math.floor((exported.frames * rate) / exported.fps + 1e-6))
      plan = recordingsTimeline(project, exported.fps, recordingMedia(project, exported.fps, screen, camera, request.stems.map((s) => s.stem), videoFrames))
    }
    const result = await write({ ...request, plan })
    return result.problem ? { ...result, problem: problemText(result.problem) } : result
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split(/\n/)[0]
    return { files: [], problem: problemText(reason) }
  }
}
