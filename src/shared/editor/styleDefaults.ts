import { ANIMATED_SPEED, isKnownBackground } from '../engine/backgrounds'
import { BORDER_WIDTH, SHADOW_STYLES } from '../engine/cardStyle'
import { FRAME_KINDS } from '../engine/deviceFrames'
import { ZOOM_EASINGS } from '../engine/easing'
import { clamp } from '../engine/math'
import { DEFAULT_CURSOR_EXTRAS } from '../engine/project'
import { readWebcamLook, WEBCAM_SHAPES } from '../engine/webcamData'
import { WATERMARK_FILE_RE, WATERMARK_LIMITS, WATERMARK_POSITIONS, WATERMARK_TEXT_MAX } from '../engine/watermark'
import { MAX_TRANSITION, MIN_TRANSITION, ZOOM_MAX_SCALE, ZOOM_MIN_SCALE, zoomSettingsOf } from '../engine/zoom'
import type {
  AspectRatio,
  Background,
  CardBorder,
  ClickStyle,
  Corner,
  CursorSettings,
  CursorStyle,
  DeviceFrame,
  KeystrokeSettings,
  Project,
  StyleSettings,
  WatermarkSettings,
  WebcamSettings,
  ZoomEasing,
  ZoomSettings
} from '../types'

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
  keystrokeSize: { min: 0.02, max: 0.07 },
  backgroundBlur: { min: 0, max: 1 },
  animatedSpeed: ANIMATED_SPEED,
  borderWidth: BORDER_WIDTH,
  zoomScale: { min: ZOOM_MIN_SCALE, max: ZOOM_MAX_SCALE },
  zoomTransition: { min: MIN_TRANSITION, max: MAX_TRANSITION }
} as const

/** Longest address bar text a browser frame keeps. */
export const FRAME_TITLE_MAX = 120

export const ASPECT_RATIOS: AspectRatio[] = ['auto', '16:9', '9:16', '1:1', '4:3']
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
/** Cursor styles a saved look may carry: 'custom' needs an image file of one project, so it is never saved. */
const SAVED_CURSOR_STYLES: CursorStyle[] = ['auto', 'mac', 'windows', 'white', 'black']
const CLICK_STYLES: ClickStyle[] = ['ripple', 'ring', 'pulse']
const EASINGS: ZoomEasing[] = ZOOM_EASINGS.map((e) => e.value)

/** The zoom style a look carries: what new zooms start with and how zooms move. */
export type ZoomStyleLook = Partial<Pick<ZoomSettings, 'defaultScale' | 'easing' | 'transition'>>

/**
 * A saved look. Every field is optional: one that is missing or invalid leaves the new
 * project's built-in value. A project's own look (Pick<Project, ...>) is a valid value.
 *
 * Never applied from the saved look, because they belong to one recording:
 * - cursor.show: the recording decides it (never on when the OS cursor is in the video);
 * - a custom cursor image (cursor.style 'custom', cursor.customImage): the file lives in one project's folder;
 * - webcam.show: follows whether the recording has a camera;
 * - image backgrounds: the image file lives in one project's folder.
 * A watermark image is different: the main process keeps a copy of it next to the saved look
 * and copies it into every new recording (src/main/styleDefaults.ts).
 */
export interface StyleDefaults {
  style: Partial<StyleSettings>
  cursor: Partial<CursorSettings>
  webcam: Partial<WebcamSettings>
  effects: { motionBlur?: number; keystrokes?: Partial<KeystrokeSettings> }
  /** Zoom style: level of new zooms, easing and transition. */
  zoom?: ZoomStyleLook
  watermark?: WatermarkSettings
  /** Id of the project the look was saved from (where its watermark image is); never stored. */
  source?: string
}

/** The parts of a project that "Save as default" stores. */
export function lookOf(project: Project): StyleDefaults {
  const z = zoomSettingsOf(project)
  return {
    style: project.style,
    cursor: project.cursor,
    webcam: project.webcam,
    effects: project.effects,
    zoom: { defaultScale: z.defaultScale, easing: z.easing, transition: z.transition },
    watermark: project.watermark,
    source: project.id
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const num = (v: unknown, limits: { min: number; max: number }): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, limits.min, limits.max) : undefined

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined)

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

/**
 * A built-in background (gradient, wallpaper, animated gradient) or a solid colour, with its
 * options clamped; image backgrounds and anything unknown are dropped.
 */
export function sanitizeBackground(v: unknown): Background | undefined {
  if (!isObject(v)) return undefined
  const L = LOOK_LIMITS
  let bg: Background | undefined
  if (v.type === 'gradient' && typeof v.preset === 'string') bg = { type: 'gradient', preset: v.preset }
  else if (v.type === 'color' && typeof v.color === 'string' && HEX_COLOR.test(v.color)) bg = { type: 'color', color: v.color.toLowerCase() }
  else if (v.type === 'wallpaper' && typeof v.id === 'string') {
    const blur = num(v.blur, L.backgroundBlur)
    bg = blur ? { type: 'wallpaper', id: v.id, blur } : { type: 'wallpaper', id: v.id }
  } else if (v.type === 'animated' && typeof v.preset === 'string') {
    const speed = num(v.speed, L.animatedSpeed)
    bg = speed !== undefined ? { type: 'animated', preset: v.preset, speed } : { type: 'animated', preset: v.preset }
  }
  return bg && isKnownBackground(bg) ? bg : undefined
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

function frame(v: unknown): DeviceFrame | undefined {
  if (!isObject(v)) return undefined
  const kind = oneOf(v.kind, FRAME_KINDS)
  if (!kind) return undefined
  const out: DeviceFrame = { kind, theme: oneOf(v.theme, ['light', 'dark'] as const) ?? 'light' }
  const title = text(v.title, FRAME_TITLE_MAX)
  if (title !== undefined && title.trim()) out.title = title
  return out
}

function border(v: unknown): CardBorder | undefined {
  if (!isObject(v)) return undefined
  const width = num(v.width, LOOK_LIMITS.borderWidth)
  if (width === undefined) return undefined
  return { width, color: color(v.color) ?? '#ffffff', glass: v.glass === true }
}

/** The look fields of a style (everything but the aspect ratio), validated field by field. */
export function sanitizeStyleLook(s: Record<string, unknown>): Partial<StyleSettings> {
  const L = LOOK_LIMITS
  return defined<StyleSettings>({
    background: sanitizeBackground(s.background),
    padding: num(s.padding, L.padding),
    cornerRadius: num(s.cornerRadius, L.cornerRadius),
    shadow: num(s.shadow, L.shadow),
    frame: frame(s.frame),
    border: border(s.border),
    shadowStyle: oneOf(s.shadowStyle, SHADOW_STYLES),
    shadowColor: color(s.shadowColor)
  })
}

/** Cursor look fields (never visibility or a custom image), validated field by field. */
export function sanitizeCursorLook(c: Record<string, unknown>): Partial<CursorSettings> {
  const L = LOOK_LIMITS
  return defined<CursorSettings>({
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
  })
}

export function sanitizeZoomStyle(v: unknown): ZoomStyleLook {
  if (!isObject(v)) return {}
  const L = LOOK_LIMITS
  return defined<Required<ZoomStyleLook>>({
    defaultScale: num(v.defaultScale, L.zoomScale),
    easing: oneOf(v.easing, EASINGS),
    transition: num(v.transition, L.zoomTransition)
  })
}

/** A complete, valid watermark, or undefined (an image one needs its file name). */
export function sanitizeWatermark(v: unknown): WatermarkSettings | undefined {
  if (!isObject(v)) return undefined
  const kind = oneOf(v.kind, ['image', 'text'] as const)
  const position = oneOf(v.position, WATERMARK_POSITIONS)
  const size = num(v.size, WATERMARK_LIMITS.size)
  const opacity = num(v.opacity, WATERMARK_LIMITS.opacity)
  const margin = num(v.margin, WATERMARK_LIMITS.margin)
  if (!kind || !position || size === undefined || opacity === undefined || margin === undefined) return undefined
  const out: WatermarkSettings = { show: v.show !== false, kind, position, size, opacity, margin, text: text(v.text, WATERMARK_TEXT_MAX) ?? '' }
  // Only a logo has a file. A text watermark may still name the logo the project used before
  // (switching back reuses it there), but in a saved look that name is another folder's file.
  if (kind === 'image') {
    if (typeof v.path !== 'string' || !WATERMARK_FILE_RE.test(v.path)) return undefined
    out.path = v.path
  }
  return out
}

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
    style: defined<StyleSettings>({ ...sanitizeStyleLook(s), aspectRatio: oneOf(s.aspectRatio, ASPECT_RATIOS) }),
    cursor: sanitizeCursorLook(c),
    webcam: defined<WebcamSettings>({
      corner: oneOf(w.corner, CORNERS),
      size: num(w.size, L.webcamSize),
      shape: oneOf(w.shape, WEBCAM_SHAPES),
      ...readWebcamLook(w)
    }),
    effects: defined<StyleDefaults['effects']>({
      motionBlur: num(e.motionBlur, L.motionBlur),
      keystrokes: empty(keystrokes) ? undefined : keystrokes
    })
  }
  const zoom = sanitizeZoomStyle(raw.zoom)
  if (!empty(zoom)) out.zoom = zoom
  const watermark = sanitizeWatermark(raw.watermark)
  if (watermark) out.watermark = watermark
  if (typeof raw.source === 'string' && raw.source) out.source = raw.source
  return [out.style, out.cursor, out.webcam, out.effects, zoom].every(empty) && !watermark ? null : out
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
  const out: Project = {
    ...project,
    style: { ...project.style, ...d.style },
    cursor: { ...project.cursor, ...d.cursor, show: project.cursor.show && !project.capture.cursorInVideo },
    webcam: { ...project.webcam, ...d.webcam, show: project.hasWebcam },
    effects: { ...project.effects, ...d.effects, keystrokes: { ...project.effects.keystrokes, ...d.effects.keystrokes } }
  }
  if (d.zoom) out.zoomSettings = { ...zoomSettingsOf(project), ...d.zoom }
  if (d.watermark) out.watermark = d.watermark
  return out
}
