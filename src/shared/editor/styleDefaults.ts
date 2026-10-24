import { GRADIENTS } from '../engine/backgrounds'
import { clamp } from '../engine/math'
import { DEFAULT_CURSOR_EXTRAS } from '../engine/project'
import type { AspectRatio, Background, ClickStyle, Corner, CursorSettings, CursorStyle, KeystrokeSettings, Project, StyleSettings, WebcamSettings } from '../types'

/**
 * The user's saved look ("Save as default for new recordings"), applied to every new
 * recording. Pure: the file and IPC live in src/main/styleDefaults.ts.
 */

/** Ranges of the editor's look controls. Saved values outside them are clamped. */
export const LOOK_LIMITS = {
  padding: { min: 0, max: 0.25 },
  cornerRadius: { min: 0, max: 60 },
  shadow: { min: 0, max: 1 },
  cursorSize: { min: 0.6, max: 3 },
  smoothing: { min: 0, max: 1 },
  highlightSize: { min: 0.5, max: 2.5 },
  highlightOpacity: { min: 0.1, max: 1 },
  clickSoundVolume: { min: 0, max: 1 },
  webcamSize: { min: 0.12, max: 0.45 },
  motionBlur: { min: 0, max: 1 },
  keystrokeSize: { min: 0.02, max: 0.07 }
} as const

export const ASPECT_RATIOS: AspectRatio[] = ['auto', '16:9', '9:16', '1:1', '4:3']
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
/** Cursor styles a saved look may carry: 'custom' needs an image file of one project, so it is never saved. */
const SAVED_CURSOR_STYLES: CursorStyle[] = ['auto', 'mac', 'windows', 'white', 'black']
const CLICK_STYLES: ClickStyle[] = ['ripple', 'ring', 'pulse']

/**
 * A saved look. Every field is optional: one that is missing or invalid leaves the new
 * project's built-in value. A project's own look (Pick<Project, ...>) is a valid value.
 *
 * Never applied from the saved look, because they belong to one recording:
 * - cursor.show: the recording decides it (never on when the OS cursor is in the video);
 * - a custom cursor image (cursor.style 'custom', cursor.customImage): the file lives in one project's folder;
 * - webcam.show: follows whether the recording has a camera;
 * - image backgrounds: the image file lives in one project's folder.
 */
export interface StyleDefaults {
  style: Partial<StyleSettings>
  cursor: Partial<CursorSettings>
  webcam: Partial<WebcamSettings>
  effects: { motionBlur?: number; keystrokes?: Partial<KeystrokeSettings> }
}

/** The parts of a project that "Save as default" stores. */
export function lookOf(project: Project): StyleDefaults {
  return { style: project.style, cursor: project.cursor, webcam: project.webcam, effects: project.effects }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const num = (v: unknown, limits: { min: number; max: number }): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, limits.min, limits.max) : undefined

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined)

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** A gradient preset or solid colour; image backgrounds and anything unknown are dropped. */
function background(v: unknown): Background | undefined {
  if (!isObject(v)) return undefined
  if (v.type === 'gradient' && typeof v.preset === 'string' && GRADIENTS.some((g) => g.id === v.preset)) return { type: 'gradient', preset: v.preset }
  if (v.type === 'color' && typeof v.color === 'string' && HEX_COLOR.test(v.color)) return { type: 'color', color: v.color.toLowerCase() }
  return undefined
}

const color = (v: unknown): string | undefined => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : undefined)

/** A highlight with every field valid; missing or invalid fields take the built-in values. */
function highlight(v: unknown): CursorSettings['highlight'] {
  if (!isObject(v)) return undefined
  const d = DEFAULT_CURSOR_EXTRAS.highlight
  const L = LOOK_LIMITS
  const out = {
    enabled: bool(v.enabled),
    color: color(v.color),
    size: num(v.size, L.highlightSize),
    opacity: num(v.opacity, L.highlightOpacity)
  }
  if (Object.values(out).every((x) => x === undefined)) return undefined
  return { enabled: out.enabled ?? d.enabled, color: out.color ?? d.color, size: out.size ?? d.size, opacity: out.opacity ?? d.opacity }
}

/** Drops undefined values, so spreading the result never overwrites a project value with undefined. */
function defined<T extends object>(o: Partial<T>): Partial<T> {
  const out: Partial<T> = {}
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k]
  return out
}

const empty = (o: object): boolean => Object.keys(o).length === 0

/**
 * Validates a saved look field by field (a hand-edited or partly corrupt file still
 * applies what is valid). Returns null when nothing usable is left. The result never
 * contains cursor.show, webcam.show, an image background or a custom cursor image.
 */
export function sanitizeStyleDefaults(raw: unknown): StyleDefaults | null {
  if (!isObject(raw)) return null
  const s = isObject(raw.style) ? raw.style : {}
  const c = isObject(raw.cursor) ? raw.cursor : {}
  const w = isObject(raw.webcam) ? raw.webcam : {}
  const e = isObject(raw.effects) ? raw.effects : {}
  const k = isObject(e.keystrokes) ? e.keystrokes : {}
  const L = LOOK_LIMITS
  const keystrokes = defined<KeystrokeSettings>({
    show: bool(k.show),
    position: oneOf(k.position, ['bottom', 'top'] as const),
    size: num(k.size, L.keystrokeSize)
  })
  const out: StyleDefaults = {
    style: defined<StyleSettings>({
      background: background(s.background),
      padding: num(s.padding, L.padding),
      cornerRadius: num(s.cornerRadius, L.cornerRadius),
      shadow: num(s.shadow, L.shadow),
      aspectRatio: oneOf(s.aspectRatio, ASPECT_RATIOS)
    }),
    cursor: defined<CursorSettings>({
      size: num(c.size, L.cursorSize),
      smoothing: num(c.smoothing, L.smoothing),
      clickEffect: bool(c.clickEffect),
      hideWhenIdle: bool(c.hideWhenIdle),
      style: oneOf(c.style, SAVED_CURSOR_STYLES),
      highlight: highlight(c.highlight),
      clickStyle: oneOf(c.clickStyle, CLICK_STYLES),
      clickColor: color(c.clickColor),
      clickSound: bool(c.clickSound),
      clickSoundVolume: num(c.clickSoundVolume, L.clickSoundVolume),
      loopHome: bool(c.loopHome),
      tilt: bool(c.tilt),
      trail: bool(c.trail)
    }),
    webcam: defined<WebcamSettings>({
      corner: oneOf(w.corner, CORNERS),
      size: num(w.size, L.webcamSize),
      shape: oneOf(w.shape, ['circle', 'rounded'] as const)
    }),
    effects: defined<StyleDefaults['effects']>({
      motionBlur: num(e.motionBlur, L.motionBlur),
      keystrokes: empty(keystrokes) ? undefined : keystrokes
    })
  }
  return [out.style, out.cursor, out.webcam, out.effects].every(empty) ? null : out
}

/**
 * Returns `project` with the saved look applied. Recording-specific facts win over the
 * saved look: the smooth cursor is never shown when the OS cursor is in the video (and
 * otherwise stays as the recording decided), the camera is shown exactly when the
 * recording has one, and an image background is never applied.
 */
export function applyStyleDefaults(project: Project, defaults: StyleDefaults | null | undefined): Project {
  const d = sanitizeStyleDefaults(defaults)
  if (!d) return project
  return {
    ...project,
    style: { ...project.style, ...d.style },
    cursor: { ...project.cursor, ...d.cursor, show: project.cursor.show && !project.capture.cursorInVideo },
    webcam: { ...project.webcam, ...d.webcam, show: project.hasWebcam },
    effects: { ...project.effects, ...d.effects, keystrokes: { ...project.effects.keystrokes, ...d.effects.keystrokes } }
  }
}
