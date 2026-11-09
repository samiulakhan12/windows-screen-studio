/**
 * Main's check of a timeline plan before anything is written (docs/design/output-and-languages.md
 * §18.3). The plan comes from the renderer, so every number, name and list is checked: a plan that
 * fails gives a problem and no file. Pure; frozen by the contracts (§21.0).
 */
import { MAX_EXPORT_SIDE } from '../render/exportPlan'
import type { TimelineMedia } from './timelinePlan'

/** Most events over all tracks, and most markers, of one plan. */
export const PLAN_LIMITS = { events: 20_000, markers: 1_000, tracks: 16, name: 500 } as const
/** Timeline rates: whole numbers up to 60 (§8.6). */
const RATES = [24, 25, 30, 60]
const MEDIA: readonly TimelineMedia[] = ['video', 'screen', 'camera', 'voice', 'system', 'recording', 'music', 'effects']
const ROLES = ['dialogue', 'effects', 'music']
/** Largest side of a source file the plan may describe (the recordings themselves; the sequence keeps to MAX_EXPORT_SIDE). */
const MAX_SOURCE_SIDE = 16384

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isFrame = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isName = (v: unknown): v is string => typeof v === 'string' && v.length <= PLAN_LIMITS.name
const isSide = (v: unknown, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= max

/** Why `plan` cannot be written, or null when it is well formed. */
export function checkTimelinePlan(plan: unknown): string | null {
  if (!isRecord(plan)) return 'not a plan'
  if (!isName(plan.name)) return 'name'
  if (!RATES.includes(plan.fps as number)) return 'rate'
  if (!isSide(plan.width, MAX_EXPORT_SIDE) || !isSide(plan.height, MAX_EXPORT_SIDE)) return 'size'
  if (!isFrame(plan.frames) || plan.frames < 1) return 'length'
  if (typeof plan.pictureOnly !== 'boolean') return 'picture only'
  const frames = plan.frames

  if (!isRecord(plan.media)) return 'media'
  for (const [key, m] of Object.entries(plan.media)) {
    if (!MEDIA.includes(key as TimelineMedia) || !isRecord(m)) return `media ${key}`
    if (typeof m.fps !== 'number' || !Number.isFinite(m.fps) || m.fps <= 0 || m.fps > 1000) return `media ${key} rate`
    if (!isFrame(m.frames)) return `media ${key} length`
    if ((m.width !== undefined && !isSide(m.width, MAX_SOURCE_SIDE)) || (m.height !== undefined && !isSide(m.height, MAX_SOURCE_SIDE))) return `media ${key} size`
    if (typeof m.audio !== 'boolean' || typeof m.video !== 'boolean') return `media ${key} streams`
  }
  const media = plan.media

  if (!Array.isArray(plan.tracks) || plan.tracks.length > PLAN_LIMITS.tracks) return 'tracks'
  let events = 0
  for (const [t, track] of plan.tracks.entries()) {
    if (!isRecord(track)) return `track ${t}`
    if (track.kind !== 'video' && track.kind !== 'audio') return `track ${t} kind`
    if (!isName(track.name)) return `track ${t} name`
    if (track.role !== undefined && !ROLES.includes(track.role as string)) return `track ${t} role`
    if (typeof track.enabled !== 'boolean') return `track ${t} enabled`
    if (!Array.isArray(track.events)) return `track ${t} events`
    events += track.events.length
    if (events > PLAN_LIMITS.events) return 'too many events'
    let end = 0
    for (const [i, e] of track.events.entries()) {
      const at = `track ${t} event ${i}`
      if (!isRecord(e)) return at
      if (!MEDIA.includes(e.media as TimelineMedia) || !isRecord(media[e.media as string])) return `${at} media`
      if (!isFrame(e.recIn) || !isFrame(e.recOut) || !isFrame(e.srcIn) || !isFrame(e.srcOut)) return `${at} frames`
      if (!(e.recIn < e.recOut) || !(e.srcIn <= e.srcOut)) return `${at} order`
      if (e.recOut > frames) return `${at} past the end`
      // In order without overlap on each track.
      if (e.recIn < end) return `${at} overlaps`
      end = e.recOut
      if (typeof e.speed !== 'number' || !Number.isFinite(e.speed) || e.speed < 0 || e.speed > 100) return `${at} speed`
      if (e.dissolve !== undefined && !isFrame(e.dissolve)) return `${at} dissolve`
      if (e.fadeIn !== undefined && !isFrame(e.fadeIn)) return `${at} fade`
      if (e.fadeOut !== undefined && !isFrame(e.fadeOut)) return `${at} fade`
      if (e.gainDb !== undefined && (typeof e.gainDb !== 'number' || !Number.isFinite(e.gainDb) || Math.abs(e.gainDb) > 96)) return `${at} level`
    }
  }

  if (!Array.isArray(plan.markers) || plan.markers.length > PLAN_LIMITS.markers) return 'markers'
  for (const [i, m] of plan.markers.entries()) {
    if (!isRecord(m) || !isFrame(m.frame) || m.frame > frames || !isName(m.name) || typeof m.chapter !== 'boolean') return `marker ${i}`
  }
  return null
}
