/**
 * A timeline for another editor (docs/design/output-and-languages.md §8.2): what goes on which track,
 * in timeline frames, built in the renderer from the project and checked by main
 * (checkTimelinePlan, planCheck.ts) before anything is written. Pure.
 *
 * The types are the contracts' (§21.0) and frozen; part P4 writes the two builders.
 */
import type { SoundStem } from '../api/export'
import type { Project } from '../types'
import { t } from '../i18n/t'

export type TimelineMedia = 'video' | 'screen' | 'camera' | SoundStem

export interface TimelineEvent {
  media: TimelineMedia
  /** Timeline frames, [recIn, recOut). */
  recIn: number
  recOut: number
  /** Source frames at the source's own rate, [srcIn, srcOut). For a hold, srcOut = srcIn + 1. */
  srcIn: number
  srcOut: number
  /** Constant speed (1 = normal); 0 for a hold. */
  speed: number
  /** A dissolve into this event from the one before it, in timeline frames. */
  dissolve?: number
  /** Level in dB and fades in timeline frames (music only). */
  gainDb?: number
  fadeIn?: number
  fadeOut?: number
}

export interface TimelineTrack {
  kind: 'video' | 'audio'
  name: string
  role?: 'dialogue' | 'effects' | 'music'
  enabled: boolean
  events: TimelineEvent[]
}

/** Facts about one source from the project's record of its files; main checks them against ffprobe and fills in the paths. */
export interface TimelineSource {
  fps: number
  frames: number
  width?: number
  height?: number
  audio: boolean
  video: boolean
}

export interface TimelinePlan {
  name: string
  /** The timeline's rate: the export's rate up to 60, else 60. Whole numbers only. */
  fps: 24 | 25 | 30 | 60
  width: number
  height: number
  /** Length in timeline frames. */
  frames: number
  tracks: TimelineTrack[]
  /** V1's own sound is left out (stems written alongside it). */
  pictureOnly: boolean
  /** Chapter markers (outputChapters) and the user's own markers, in timeline frames. */
  markers: { frame: number; name: string; chapter: boolean }[]
  media: Partial<Record<TimelineMedia, TimelineSource>>
}

/** The timeline of the finished export ("This export"): V1 the video, the stems under it (§8.1). Part P4. */
export function exportTimeline(project: Project, exported: { fps: number; frames: number; width: number; height: number }, stems: readonly SoundStem[]): TimelinePlan {
  void project
  void stems
  void exported
  throw new Error(t('errors.feature.notReady'))
}

/** The timeline over the original recordings: Flown's cuts, speeds and holds (§8.2 rules 1-6). Part P4. */
export function recordingsTimeline(project: Project, fps: number, media: TimelinePlan['media']): TimelinePlan {
  void project
  void media
  void fps
  throw new Error(t('errors.feature.notReady'))
}
