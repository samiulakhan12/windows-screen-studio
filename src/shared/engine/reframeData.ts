/**
 * Following the action in frames narrower than the recording (Project.reframe, NW-05,
 * docs/design/vertical-video.md §4.2): the defaults, sanitising of stored values (a hand-edited or
 * damaged project.json still opens, and never turns following on or moves captions by itself),
 * when a frame follows, and the copy's origin (Project.copyOf). Pure and small; the planner is
 * shared/engine/reframe.ts.
 */
import type { AspectRatio, Project, ProjectCopyOf, ReframeCamera, ReframePace, ReframeSettings } from '../types'
import { outputSize } from './layout'
import { clamp } from './math'

export const REFRAME_LIMITS = { level: { min: 1, max: 2, step: 0.05 }, band: { min: 0.2, max: 0.5, step: 0.01 } } as const
/** A frame follows when outW/outH < FOLLOW_NARROWER × vw/vh. */
export const FOLLOW_NARROWER = 0.9
/** A tall frame: h >= TALL × w (9:16 is 1.78). Bands, safe zones and the text area need one. */
export const TALL = 1.25
export const DEFAULT_REFRAME: Readonly<ReframeSettings> = Object.freeze({ mode: 'follow', level: 1, camera: 'top', band: 0.32, pace: 'balanced', appSafe: true })

const CAMERAS: readonly ReframeCamera[] = ['top', 'bottom', 'bubble']
const PACES: readonly ReframePace[] = ['calm', 'balanced', 'lively']
/** Ids of project folders (projects.ts projectDir accepts no other characters). */
const PROJECT_ID = /^[a-zA-Z0-9_-]+$/
/** Longest name kept for the original of a copy. */
const COPY_NAME_MAX = 200

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Stored settings, sanitised; undefined when absent or not a plain object. An unknown mode reads
 * as 'fit' and a broken appSafe as false, so damage never turns following on or moves captions;
 * numbers are clamped, other fields fall back to their defaults, and `rest` is kept only with
 * finite x and y (clamped to 0..1). Idempotent.
 */
export function readReframe(raw: unknown): ReframeSettings | undefined {
  if (!plainObject(raw)) return undefined
  const out: ReframeSettings = {
    mode: raw.mode === 'follow' || raw.mode === 'fit' ? raw.mode : 'fit',
    level: finite(raw.level) ? clamp(raw.level, REFRAME_LIMITS.level.min, REFRAME_LIMITS.level.max) : DEFAULT_REFRAME.level,
    camera: CAMERAS.includes(raw.camera as ReframeCamera) ? (raw.camera as ReframeCamera) : DEFAULT_REFRAME.camera,
    band: finite(raw.band) ? clamp(raw.band, REFRAME_LIMITS.band.min, REFRAME_LIMITS.band.max) : DEFAULT_REFRAME.band,
    pace: PACES.includes(raw.pace as ReframePace) ? (raw.pace as ReframePace) : DEFAULT_REFRAME.pace,
    appSafe: typeof raw.appSafe === 'boolean' ? raw.appSafe : false
  }
  const rest = raw.rest
  if (plainObject(rest) && finite(rest.x) && finite(rest.y)) out.rest = { x: clamp(rest.x, 0, 1), y: clamp(rest.y, 0, 1) }
  return out
}

/** A stored copyOf, sanitised; undefined unless id matches /^[a-zA-Z0-9_-]+$/ and name is a string (cut to 200). */
export function readCopyOf(raw: unknown): ProjectCopyOf | undefined {
  if (!plainObject(raw)) return undefined
  if (typeof raw.id !== 'string' || !PROJECT_ID.test(raw.id) || typeof raw.name !== 'string') return undefined
  return { id: raw.id, name: raw.name.slice(0, COPY_NAME_MAX) }
}

export const isTall = (w: number, h: number): boolean => h >= TALL * w

/** Settings when following is turned on in a w × h frame: existing ones with mode 'follow', else DEFAULT_REFRAME (camera 'bubble' and appSafe false when the frame is not tall). */
export function reframeOn(project: Pick<Project, 'reframe'>, outW: number, outH: number): ReframeSettings {
  if (project.reframe) return { ...project.reframe, mode: 'follow' }
  return isTall(outW, outH) ? { ...DEFAULT_REFRAME } : { ...DEFAULT_REFRAME, camera: 'bubble', appSafe: false }
}

const usable = (...sizes: number[]): boolean => sizes.every((s) => finite(s) && s > 0)

/**
 * Whether a frame of outW x outH is at least 10% narrower than a vw x vh recording: compared as
 * outW·vh < FOLLOW_NARROWER·vw·outH (the ratios multiplied out, so a frame exactly at the limit
 * never follows through a rounding of the division). Unknown sizes never follow.
 */
const narrower = (outW: number, outH: number, vw: number, vh: number): boolean => usable(outW, outH, vw, vh) && outW * vh < FOLLOW_NARROWER * vw * outH

/** Whether a w × h frame of the drawn recording (vw × vh, after the crop) follows the action. */
export function followApplies(project: Pick<Project, 'reframe'>, outW: number, outH: number, vw: number, vh: number): boolean {
  return project.reframe?.mode === 'follow' && narrower(outW, outH, vw, vh)
}

/** Whether `aspect` could follow a vw × vh recording (the Style panel shows the toggle; Duplicate's menu enables its items). */
export function canFollow(aspect: AspectRatio, vw: number, vh: number): boolean {
  if (!usable(vw, vh)) return false
  const frame = outputSize(aspect, vw, vh, 1080)
  return narrower(frame.width, frame.height, vw, vh)
}

/** `p` with `patch` merged into its reframe settings (DEFAULT_REFRAME for missing ones). */
export function withReframe(p: Project, patch: Partial<ReframeSettings>): Project {
  const reframe: ReframeSettings = { ...DEFAULT_REFRAME, ...p.reframe, ...patch }
  // A patch that clears the rest point leaves no `rest: undefined` in the saved file.
  if (reframe.rest === undefined) delete reframe.rest
  return { ...p, reframe }
}

/** `p` without following (pick modes, the crop tool): `reframe` dropped; the same object when absent. */
export function withoutFollow<P extends { reframe?: ReframeSettings }>(p: P): P {
  if (p.reframe === undefined) return p
  const { reframe: _reframe, ...rest } = p
  return rest as P
}
