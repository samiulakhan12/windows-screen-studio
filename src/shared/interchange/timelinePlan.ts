/**
 * A timeline for another editor (docs/design/output-and-languages.md §8.2): what goes on which track,
 * in timeline frames, built in the renderer from the project and checked by main
 * (checkTimelinePlan, planCheck.ts) before anything is written. Pure.
 *
 * The types are the contracts' (§21.0) and frozen; the builders follow §8.1 and §8.2.
 */
import type { SoundStem } from '../api/export'
import { hasSoundtrack } from '../audio/settings'
import { planOf, videoDuration, type FreezePlan } from '../engine/freeze'
import { outputChapters } from '../render/chapters'
import { cursorLook } from '../render/cursorFx'
import { capSize } from '../render/exportPlan'
import { joinPlan } from '../render/joins'
import { STEM_FILE_WORDS } from '../render/stems'
import type { Clip, Project } from '../types'
import { PLAN_LIMITS } from './planCheck'

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


/** Timeline rates (§8.6): whole numbers, 60 at most (FCPXML's frame rates and EDL timecode stop there). */
export const TIMELINE_RATES: readonly TimelinePlan['fps'][] = [24, 25, 30, 60]

/** The timeline's rate for an export at `fps`: the export's own rate up to 60, else 60 (§8.6); 120 gives 60, 24 and 25 stay exact. */
export function timelineRate(fps: number): TimelinePlan['fps'] {
  if (!(fps < 60)) return 60
  const exact = TIMELINE_RATES.find((r) => Math.abs(r - fps) < 1e-6)
  return exact ?? TIMELINE_RATES.reduce((best, r) => (Math.abs(r - fps) < Math.abs(best - fps) ? r : best))
}

/** The role each sound's track gets in the other editor (FCPXML audioRole). */
const ROLES: Readonly<Record<SoundStem, 'dialogue' | 'effects' | 'music'>> = {
  voice: 'dialogue',
  recording: 'dialogue',
  system: 'effects',
  music: 'music',
  effects: 'effects'
}

/** The recording's own sound tracks in their order (A1 Voice, A2 System sound, or A1 Recording), then Music and Effects. */
const SOUND_ORDER: readonly SoundStem[] = ['voice', 'system', 'recording', 'music', 'effects']

/** Edit or video times closer than this are the same moment (freeze.ts). */
const EPS = 1e-9

/** `text` cut to the plan's name limit, never inside a surrogate pair (checkTimelinePlan counts UTF-16 units). */
function limitName(text: string): string {
  if (text.length <= PLAN_LIMITS.name) return text
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > PLAN_LIMITS.name) break
    out += ch
  }
  return out
}

/** The video's chapters (outputChapters, found chapters included) as chapter markers in timeline frames (§8.2 rule 5). */
function chapterMarkers(project: Project, plan: FreezePlan, fps: number, frames: number): TimelinePlan['markers'] {
  return outputChapters(project.chapters ?? [], project.clips, plan)
    .slice(0, PLAN_LIMITS.markers)
    .map((c) => ({ frame: Math.min(frames, Math.max(0, Math.round(c.start * fps))), name: limitName(c.title), chapter: true }))
}

/**
 * The timeline of the finished export ("This export", §8.1): V1 the exported video, full length, one
 * event; the stems written with it as audio tracks, full length. With stems V1 is picture only
 * (`pictureOnly`), so the editor never plays the sound twice. The timeline runs at the export's rate
 * up to 60 fps (a 120 fps export gives a 60 fps timeline over exactly half its frames).
 */
export function exportTimeline(project: Project, exported: { fps: number; frames: number; width: number; height: number }, stems: readonly SoundStem[]): TimelinePlan {
  const fps = timelineRate(exported.fps)
  const frames = Math.max(1, Math.floor((exported.frames * fps) / exported.fps + 1e-6))
  const sounds = SOUND_ORDER.filter((s) => stems.includes(s))
  const media: TimelinePlan['media'] = {
    video: {
      fps: exported.fps,
      frames: exported.frames,
      width: exported.width,
      height: exported.height,
      audio: hasSoundtrack(project, cursorLook(project.cursor).clickSound),
      video: true
    }
  }
  const tracks: TimelineTrack[] = [
    {
      kind: 'video',
      name: 'Video',
      enabled: true,
      events: [{ media: 'video', recIn: 0, recOut: frames, srcIn: 0, srcOut: Math.max(1, Math.min(exported.frames, Math.round((frames * exported.fps) / fps))), speed: 1 }]
    }
  ]
  for (const stem of sounds) {
    media[stem] = { fps, frames, audio: true, video: false }
    tracks.push({ kind: 'audio', name: STEM_FILE_WORDS[stem], role: ROLES[stem], enabled: true, events: [{ media: stem, recIn: 0, recOut: frames, srcIn: 0, srcOut: frames, speed: 1 }] })
  }
  return {
    name: limitName(project.name),
    fps,
    width: exported.width,
    height: exported.height,
    frames,
    tracks,
    pictureOnly: sounds.length > 0,
    markers: chapterMarkers(project, planOf(project), fps, frames),
    media
  }
}

/**
 * A stretch of the exported video's time: a source range played at a constant speed, or one source
 * moment held (a pause freeze, or on the picture a continue freeze). Times are video seconds; each
 * span starts where the one before it ends (the same number), so rounding to frames never leaves a
 * gap or an overlap between neighbours.
 */
type Span = { v0: number; v1: number } & ({ hold: false; s0: number; s1: number; speed: number } | { hold: true; at: number; end: boolean })

/**
 * The spans of the edit in video time, clip by clip (§8.2 rule 1). Pause freezes become holds at
 * their place (a hold at a clip's start comes before it, as editToVideo has it; one at the edit's
 * end holds its last frame). With `picture`, continue freezes hold their frame over their span too:
 * the screen's picture; without it they play on: the clock the sound and the camera follow.
 */
function editSpans(clips: readonly Clip[], plan: FreezePlan, picture: boolean, total: number): Span[] {
  const out: Span[] = []
  const holds = plan.holds
  const stills = picture ? plan.stills : []
  let hi = 0
  let added = 0
  const last = (): number => (out.length ? out[out.length - 1].v1 : 0)
  const holdsAt = (o: number): void => {
    while (hi < holds.length && holds[hi].edit <= o + EPS) {
      const h = holds[hi++]
      added += h.length
      out.push({ v0: last(), v1: o + added, hold: true, at: h.at, end: h.end })
    }
  }
  let edit = 0
  for (const c of clips) {
    const end = edit + (c.end - c.start) / c.speed
    const points = new Set<number>([edit, end])
    const inside = (o: number): boolean => o > edit + EPS && o < end - EPS
    for (const h of holds) if (inside(h.edit)) points.add(h.edit)
    for (const s of stills) {
      if (inside(s.editStart)) points.add(s.editStart)
      if (inside(s.editEnd)) points.add(s.editEnd)
    }
    const sorted = [...points].sort((a, b) => a - b)
    for (let k = 0; k + 1 < sorted.length; k++) {
      const a = sorted[k]
      const b = sorted[k + 1]
      holdsAt(a)
      const still = stills.find((s) => a >= s.editStart - EPS && a < s.editEnd - EPS)
      const v0 = last()
      if (still) out.push({ v0, v1: b + added, hold: true, at: still.at, end: false })
      // A clip's own ends are taken as they are, so they round on the source's grid as written.
      else out.push({ v0, v1: b + added, hold: false, s0: a === edit ? c.start : c.start + (a - edit) * c.speed, s1: b === end ? c.end : c.start + (b - edit) * c.speed, speed: c.speed })
    }
    edit = end
  }
  holdsAt(edit)
  // The video's exact end, whatever the sums above rounded to: the last event ends on the last frame.
  if (out.length) out[out.length - 1].v1 = total
  return out
}

/** Source frame `t` seconds into a source at `fps`, within its `frames`. */
const srcFrame = (t: number, fps: number, frames: number): number => Math.min(frames, Math.max(0, Math.round(t * fps)))

/** The held frame of a hold: the frame shown at `at`; at the edit's end, the last frame before it. */
const heldFrame = (at: number, end: boolean, src: TimelineSource): number => Math.min(Math.max(0, src.frames - 1), Math.max(0, Math.round(at * src.fps) - (end ? 1 : 0)))

/** A played range as an event, its source frames on the source's own grid (§8.2 rule 2), never empty and never past the source's end. */
function playEvent(media: TimelineMedia, recIn: number, recOut: number, s0: number, s1: number, speed: number, src: TimelineSource): TimelineEvent {
  let srcIn = srcFrame(s0, src.fps, src.frames)
  let srcOut = srcFrame(s1, src.fps, src.frames)
  if (srcOut <= srcIn) {
    if (srcIn < src.frames) srcOut = srcIn + 1
    else srcIn = Math.max(0, srcOut - 1)
  }
  return { media, recIn, recOut, srcIn, srcOut, speed }
}

/**
 * The timeline over the original recordings ("The original recordings", §8.1, §8.2 rules 1-6): V1
 * `Screen.mp4` cut as Flown cuts it, with speed changes, pause freezes and continue freezes as holds
 * and crossfades as dissolves; V2 `Camera.mp4` on the camera's own clock (offset by webcamOffset),
 * turned off; the recording's sound cut like V1 with gaps at pause freezes; Music and Effects whole.
 * Record frames come from the exact cumulative video time, rounded once per edge, so a thousand
 * cuts end on the video's last frame; source frames round on each source's own grid (`media`).
 * `media` names the sources the timeline uses: `screen` always, `camera`, the recording's sounds
 * (`voice` and `system`, or `recording`), `music` and `effects` when they are there.
 */
export function recordingsTimeline(project: Project, fps: number, media: TimelinePlan['media']): TimelinePlan {
  const rate = timelineRate(fps)
  const clips = project.clips
  const plan = planOf(project)
  const total = videoDuration(clips, plan)
  const frames = Math.max(1, Math.round(total * rate))
  const screen = media.screen
  if (!screen) throw new Error('A timeline over the recordings needs the screen recording')
  const size = capSize({ width: screen.width ?? project.width, height: screen.height ?? project.height })
  const rec = (v: number): number => Math.min(frames, Math.max(0, Math.round(v * rate)))

  // V1: the screen's picture.
  const picture: TimelineEvent[] = []
  for (const s of editSpans(clips, plan, true, total)) {
    const recIn = rec(s.v0)
    const recOut = rec(s.v1)
    if (recOut <= recIn) continue
    if (s.hold) {
      const frame = heldFrame(s.at, s.end, screen)
      const prev = picture[picture.length - 1]
      // A continue freeze across a cut, or a pause freeze on a still's frame: one hold.
      if (prev && prev.speed === 0 && prev.srcIn === frame && prev.recOut === recIn) prev.recOut = recOut
      else picture.push({ media: 'screen', recIn, recOut, srcIn: frame, srcOut: frame + 1, speed: 0 })
    } else picture.push(playEvent('screen', recIn, recOut, s.s0, s.s1, s.speed, screen))
  }
  // Wave 10's crossfades become dissolves into the event after the cut; dips, slides and punch-ins are hard cuts (§8.2 rule 3).
  const starts = new Map(picture.map((e, i) => [e.recIn, i]))
  for (const w of joinPlan(project)) {
    if (w.kind !== 'crossfade') continue
    const at = rec(w.from)
    const i = starts.get(at) ?? starts.get(at - 1) ?? starts.get(at + 1)
    if (i === undefined || i === 0 || picture[i - 1].recOut !== picture[i].recIn) continue
    const e = picture[i]
    const d = Math.min(Math.round((w.to - w.from) * rate), e.recOut - e.recIn)
    if (d >= 1) e.dissolve = d
  }

  const clock = editSpans(clips, plan, false, total)
  const tracks: TimelineTrack[] = [{ kind: 'video', name: 'Screen', enabled: true, events: picture }]
  const used: TimelinePlan['media'] = { screen }

  // V2: the camera on its own clock, held where the clock holds, turned off (§8.1).
  const camera = media.camera
  if (camera) {
    const off = project.webcamOffset || 0
    const length = camera.frames / camera.fps
    const events: TimelineEvent[] = []
    for (const s of clock) {
      if (s.hold) {
        const t = s.at - off
        if (t < 0 || t >= length) continue
        const recIn = rec(s.v0)
        const recOut = rec(s.v1)
        const frame = heldFrame(t, s.end, camera)
        if (recOut > recIn) events.push({ media: 'camera', recIn, recOut, srcIn: frame, srcOut: frame + 1, speed: 0 })
        continue
      }
      let c0 = s.s0 - off
      let c1 = s.s1 - off
      if (c1 <= 0 || c0 >= length) continue
      // Where the camera starts after the screen or stops before it, the event starts or ends with it.
      const v0 = c0 < 0 ? s.v0 - c0 / s.speed : s.v0
      const v1 = c1 > length ? s.v1 - (c1 - length) / s.speed : s.v1
      c0 = Math.max(0, c0)
      c1 = Math.min(length, c1)
      const recIn = rec(v0)
      const recOut = rec(v1)
      if (recOut > recIn) events.push(playEvent('camera', recIn, recOut, c0, c1, s.speed, camera))
    }
    tracks.push({ kind: 'video', name: 'Camera', enabled: false, events })
    used.camera = camera
  }

  for (const sound of SOUND_ORDER) {
    const src = media[sound]
    if (!src) continue
    const events: TimelineEvent[] = []
    if (sound === 'music' || sound === 'effects') {
      // Rendered over the whole video like the stems: one event from 0, at 0 dB (§8.2 rule 4).
      const recOut = Math.min(frames, Math.round((src.frames * rate) / src.fps))
      if (recOut >= 1) events.push({ media: sound, recIn: 0, recOut, srcIn: 0, srcOut: Math.min(src.frames, Math.round((recOut * src.fps) / rate)), speed: 1 })
    } else {
      // The recording's sound, cut like the picture; a pause freeze is a gap.
      for (const s of clock) {
        if (s.hold) continue
        const recIn = rec(s.v0)
        const recOut = rec(s.v1)
        if (recOut > recIn) events.push(playEvent(sound, recIn, recOut, s.s0, s.s1, s.speed, src))
      }
    }
    tracks.push({ kind: 'audio', name: STEM_FILE_WORDS[sound], role: ROLES[sound], enabled: true, events })
    used[sound] = src
  }

  return {
    name: limitName(project.name),
    fps: rate,
    width: size.width,
    height: size.height,
    frames,
    tracks,
    pictureOnly: false,
    markers: chapterMarkers(project, plan, rate, frames),
    media: used
  }
}
