/**
 * The screenshot of each step (docs/design/smart-tools.md §5.5): which moment it shows, the
 * project it is drawn from (the export's own drawing, with every blur and pixelate shape and
 * nothing laid over the recording), the part of the frame it shows, and the ring and arrow drawn
 * into it. Rectangles are pixels of the recorded frame (before `project.crop`); points are
 * fractions of it, as clicks are. Pure.
 */
import { contrastRatio } from '../captions/colors'
import { clipIndexAt } from '../engine/timeline'
import type { Rect } from '../engine/layout'
import { isPrivacyKind } from '../editor/shapes'
import type { Clip, GuideStepEdit, NormRect, Project, Shape } from '../types'
import type { GuideStep } from './steps'

export const SHOT = { cropBase: 950, maxWidth: 1600, maxSource: 3840, ringAt: 960, ringDiameter: 44, ringWidth: 4, halo: 3, arrowHead: 16, ring: '#0060df', send: 768, copy: 1200 } as const

/** Spare room a drag's ends keep inside the crop, as a share of its width on each side (§5.5.3). */
const DRAG_SPARE = 0.08
/** Blur an area… covers this share of the frame (§5.5.8). */
const AREA_W = 0.3
const AREA_H = 0.1
/** Blur the typed text: px at 100%, the box starting this far left of the typing place. */
const TYPED_W = 360
const TYPED_H = 48
const TYPED_LEFT = 40
/** A screen change's shot, after it settled (§5.5.1); a typing step's shown after its typing. */
const AFTER_CHANGE = 0.75
const AFTER_TYPING = 0.2
const HEX = /^#[0-9a-f]{6}$/i

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * The project a step's shot is drawn from (§5.5.2): the clips, crop, cursor (no click effect),
 * input edits, every blur and pixelate shape and the colour grade; nothing laid over the
 * recording (zooms, the camera, captions, title cards, graphics, texts, other shapes,
 * spotlights and magnifiers, images, the watermark, key presses, tilt, layouts, vertical
 * framing, cut styles, the progress bar); no padding, corners, shadow or device frame, at the
 * recording's own aspect. So nothing blurred or pixelated in the video can show in a guide.
 */
export function guideProject(project: Project): Project {
  const {
    watermark: _watermark,
    tilt: _tilt,
    reframe: _reframe,
    joins: _joins,
    chapterBar: _chapterBar,
    director: _director,
    ...rest
  } = project
  void _watermark
  void _tilt
  void _reframe
  void _joins
  void _chapterBar
  void _director
  const { frame: _frame, border: _border, ...style } = project.style
  void _frame
  void _border
  return {
    ...rest,
    zooms: [],
    autoZoom: false,
    annotations: [],
    shapes: (project.shapes ?? []).filter((s) => isPrivacyKind(s.kind)),
    spotlights: [],
    layouts: [],
    titles: [],
    graphics: [],
    overlays: [],
    webcam: { ...project.webcam, show: false },
    cursor: { ...project.cursor, clickEffect: false },
    effects: { ...project.effects, motionBlur: 0, keystrokes: { ...project.effects.keystrokes, show: false } },
    ...(project.captions ? { captions: { ...project.captions, show: false } } : {}),
    style: { ...style, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
  }
}

/** `t` kept inside the clip that holds `at` (or `t` when no clip holds it). */
function inClip(clips: readonly Clip[], at: number, t: number, frame: number): number {
  const i = clipIndexAt(clips as Clip[], at)
  if (i < 0) return t
  const c = clips[i]
  return clamp(t, c.start, Math.max(c.start, c.end - frame))
}

/**
 * The source time a step's shot shows (§5.5.1): one frame before a click, a drag, a key press or
 * a click into a field, kept inside the clip that holds it; one frame before a lone burst of
 * typing; 0.2 s after the typing with *Show the screen after typing*; 0.75 s after a screen
 * change; a badge's start; an added step's time.
 */
export function shotTime(step: GuideStep, clips: readonly Clip[], fps: number, after: boolean): number {
  const frame = 1 / (finite(fps) && fps > 0 ? fps : 60)
  if (after && step.typing) return inClip(clips, step.typing.end, step.typing.end + AFTER_TYPING, frame)
  switch (step.kind) {
    case 'screen':
      return inClip(clips, step.t, step.t + AFTER_CHANGE, frame)
    case 'badge':
    case 'added':
      return step.t
    case 'type': {
      const at = step.typing?.t ?? step.t
      return inClip(clips, at, at - frame, frame)
    }
    default:
      return inClip(clips, step.t, step.t - frame, frame)
  }
}

/** The part of the recorded frame the video shows (`project.crop`), in pixels. */
export function visibleRect(frame: { w: number; h: number }, crop: NormRect | null): Rect {
  if (!crop) return { x: 0, y: 0, w: frame.w, h: frame.h }
  return { x: crop.x * frame.w, y: crop.y * frame.h, w: crop.w * frame.w, h: crop.h * frame.h }
}

/** The point a step's shot is centred on and its ring marks: the click, a drag's press, the typing place, a badge's pin; null for the whole screen. */
export function stepPoint(step: GuideStep): { x: number; y: number } | null {
  if (step.kind === 'keys' || step.kind === 'screen' || step.kind === 'added') return null
  if (step.kind === 'badge') return step.place ?? null
  if (step.kind === 'type') return step.typing?.place ?? null
  return finite(step.x) && finite(step.y) ? { x: step.x, y: step.y } : null
}

const inside = (p: { x: number; y: number }, r: Rect, frame: { w: number; h: number }): boolean => {
  const px = p.x * frame.w
  const py = p.y * frame.h
  return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && px >= r.x - 1e-6 && px <= r.x + r.w + 1e-6 && py >= r.y - 1e-6 && py <= r.y + r.h + 1e-6
}

/**
 * The part of the recorded frame a step's shot shows (§5.5.3): `round(950 × scale)` recording
 * pixels wide, at least a third of the shown width and at most all of it, at the shown aspect,
 * centred on the step's point and moved to stay inside; a drag widened until both ends fit with
 * 8% to spare. The whole shown frame for key presses, screen changes, added steps, badges without
 * a pin, *Whole screen*, and a point outside the shown frame (`outside`: "The click was outside
 * the recorded area."). A stored `rect` (Adjust) wins.
 */
export function shotRect(step: GuideStep, frame: { w: number; h: number }, crop: NormRect | null, scale: number, view: { whole: boolean; rect?: GuideStepEdit['rect'] }): { rect: Rect; outside: boolean } {
  const shown = visibleRect(frame, crop)
  const point = stepPoint(step)
  const outside = !!point && !inside(point, shown, frame)
  if (view.rect) {
    const r = view.rect
    return { rect: { x: r.x * frame.w, y: r.y * frame.h, w: r.w * frame.w, h: r.h * frame.h }, outside }
  }
  if (view.whole || !point || outside) return { rect: shown, outside }
  const s = finite(scale) && scale > 0 ? scale : 1
  const aspect = shown.h / shown.w
  let w = clamp(Math.round(SHOT.cropBase * s), Math.round(shown.w / 3), shown.w)
  let cx = point.x * frame.w
  let cy = point.y * frame.h
  if (step.kind === 'drag' && step.to) {
    const x1 = step.to.x * frame.w
    const y1 = step.to.y * frame.h
    const room = 1 - 2 * DRAG_SPARE
    w = clamp(Math.max(w, Math.abs(x1 - cx) / room, Math.abs(y1 - cy) / room / aspect), w, shown.w)
    cx = (cx + x1) / 2
    cy = (cy + y1) / 2
  }
  const h = Math.min(shown.h, w * aspect)
  const x = clamp(cx - w / 2, shown.x, shown.x + shown.w - w)
  const y = clamp(cy - h / 2, shown.y, shown.y + shown.h - h)
  return { rect: { x, y, w, h }, outside: false }
}

/** The ring and arrow sizes in an image `outW` wide (a 960 px image has the sizes of SHOT). */
const sized = (outW: number): number => (outW > 0 ? outW : SHOT.ringAt) / SHOT.ringAt

/**
 * The ring drawn into a step's image (§5.5.4), in pixels of an image `outW` wide showing `rect`: a
 * 44 px circle with a 4 px ring and a 3 px halo in a 960 px image, scaled with its width, at the
 * click (a drag's press, a badge's pin) or Adjust's `at`. Null for key presses, screen changes,
 * typing alone, added steps, and a point outside the shot.
 */
export function ringOf(step: GuideStep, rect: Rect, outW: number, frame: { w: number; h: number }, crop: NormRect | null, at?: GuideStepEdit['ring']): { cx: number; cy: number; r: number; width: number; halo: number } | null {
  if (step.kind === 'type' && !at) return null
  const point = at ?? stepPoint(step)
  if (!point || !inside(point, visibleRect(frame, crop), frame) || !inside(point, rect, frame)) return null
  const k = outW / rect.w
  const u = sized(outW)
  return { cx: (point.x * frame.w - rect.x) * k, cy: (point.y * frame.h - rect.y) * k, r: (SHOT.ringDiameter / 2) * u, width: SHOT.ringWidth * u, halo: SHOT.halo * u }
}

/** A drag's arrow from press to release (§5.5.4), in the same pixels as ringOf: a 4 px line with a 16 px head in a 960 px image; null for other steps. */
export function arrowOf(step: GuideStep, rect: Rect, outW: number, frame: { w: number; h: number }, crop: NormRect | null, at?: GuideStepEdit['ring']): { x0: number; y0: number; x1: number; y1: number; width: number; head: number } | null {
  void crop
  if (step.kind !== 'drag' || !step.to || !finite(step.x) || !finite(step.y)) return null
  const k = outW / rect.w
  const u = sized(outW)
  const from = at ?? { x: step.x, y: step.y }
  return {
    x0: (from.x * frame.w - rect.x) * k,
    y0: (from.y * frame.h - rect.y) * k,
    x1: (step.to.x * frame.w - rect.x) * k,
    y1: (step.to.y * frame.h - rect.y) * k,
    width: SHOT.ringWidth * u,
    head: SHOT.arrowHead * u
  }
}

/** The ring's colour (§5.5.4): the brand's first colour when it has 3:1 contrast with white (and the guide uses the brand), else #0060df. */
export function ringColour(project: Project): string {
  const first = project.guide?.brand === false ? undefined : project.brand?.colors?.[0]
  return first && HEX.test(first) && contrastRatio(first, '#ffffff') >= 3 ? first.toLowerCase() : SHOT.ring
}

/**
 * The boxes the panel blurs (§5.5.8), as fractions of the recorded frame: `area` (*Blur an
 * area…*) 30% × 10% of the frame centred on the step's point (the frame's centre without one);
 * `typed` (*Blur the typed text*, typing steps only) 360 × 48 px × scale from 40 px × scale left
 * of the typing place, so it covers a field that grows to the right. Both kept inside the frame.
 */
export function blurBoxes(step: GuideStep, frame: { w: number; h: number }, scale: number): { area: NormRect; typed: NormRect | null } {
  const s = finite(scale) && scale > 0 ? scale : 1
  const p = stepPoint(step) ?? { x: 0.5, y: 0.5 }
  const box = (x: number, y: number, w: number, h: number): NormRect => {
    const bw = clamp(w, 0.001, 1)
    const bh = clamp(h, 0.001, 1)
    return { x: clamp(x, 0, 1 - bw), y: clamp(y, 0, 1 - bh), w: bw, h: bh }
  }
  const area = box(p.x - AREA_W / 2, p.y - AREA_H / 2, AREA_W, AREA_H)
  let typed: NormRect | null = null
  if (step.typing) {
    const w = (TYPED_W * s) / frame.w
    const h = (TYPED_H * s) / frame.h
    typed = box(step.typing.place.x - (TYPED_LEFT * s) / frame.w, step.typing.place.y - h / 2, w, h)
  }
  return { area, typed }
}

/** The size a shot of `rect` is made at (§5.5.3): its own width, at most `max` (1600) px, at its aspect. */
export function shotSize(rect: Rect, max: number = SHOT.maxWidth): { w: number; h: number } {
  const w = Math.max(1, Math.round(Math.min(rect.w, max)))
  return { w, h: Math.max(1, Math.round((w * rect.h) / rect.w)) }
}

/** A shot to make: its step key, time, part of the frame, ring and arrow, and what it depends on. */
export interface ShotPlan {
  key: string
  t: number
  rect: Rect
  whole: boolean
  outside: boolean
  ring: ReturnType<typeof ringOf>
  arrow: ReturnType<typeof arrowOf>
  /** Everything the picture depends on: a shot is made again when this changes (§5.5.6). */
  sig: string
}

/** The privacy shapes (blur, pixelate) that cover a frame at `t`, as the privacy layer reads them (half a frame and 1 ms of slack). */
export function privacyAt(project: Pick<Project, 'shapes' | 'capture'>, t: number): Shape[] {
  const slack = 0.5 / (project.capture?.fps ?? 60) + 0.001
  return (project.shapes ?? []).filter((s) => isPrivacyKind(s.kind) && t + slack >= s.start && t - slack < s.end)
}

/**
 * The shot of `step` (§5.5): in the guide's view (zoomed to the action unless *Whole screen*, a
 * stored `rect` and `ring` winning) or the demo's (the whole screen unless *Zoom to the click in
 * the demo*), at most SHOT.maxWidth wide, with what the picture depends on: the time, the part of
 * the frame, the ring and arrow, the privacy shapes covering that time, the crop, the colour grade,
 * the cursor and the ring's colour.
 */
export function planShot(step: GuideStep, project: Project, edit: GuideStepEdit | undefined, scale: number, view: 'guide' | 'demo'): ShotPlan {
  const frame = { w: project.width, h: project.height }
  const crop = project.crop ?? null
  const fps = project.capture?.fps ?? 60
  const t = shotTime(step, project.clips, fps, !!edit?.after)
  const whole = view === 'demo' ? !edit?.demoZoom : !!edit?.whole
  const { rect, outside } = shotRect(step, frame, crop, scale, { whole, rect: whole ? undefined : edit?.rect })
  const outW = shotSize(rect).w
  const ring = ringOf(step, rect, outW, frame, crop, edit?.ring)
  const arrow = arrowOf(step, rect, outW, frame, crop, edit?.ring)
  return { key: step.key, t, rect, whole: whole || outside, outside, ring, arrow, sig: shotSig(project, t, rect, ring, arrow) }
}

/** What a shot's picture depends on (ShotPlan.sig). */
function shotSig(project: Project, t: number, rect: Rect, ring: ShotPlan['ring'], arrow: ShotPlan['arrow']): string {
  return JSON.stringify({
    t,
    rect,
    ring,
    arrow,
    privacy: privacyAt(project, t).map((s) => [s.id, s.kind, s.start, s.end, s.x, s.y, s.w, s.h, s.strength]),
    crop: project.crop ?? null,
    grade: project.grade?.screen ?? null,
    cursor: [project.cursor.show, project.cursor.size, project.cursor.style ?? null],
    inputEdits: project.inputEdits ?? null,
    colour: ringColour(project)
  })
}

/**
 * The picture *Adjust* draws its crop and ring over (§5.5.3): the whole part of the frame the video
 * shows (`project.crop`) at the step's shot time, with no ring or arrow (Adjust draws its own).
 */
export function planFrame(step: GuideStep, project: Project, edit: GuideStepEdit | undefined): ShotPlan {
  const t = shotTime(step, project.clips, project.capture?.fps ?? 60, !!edit?.after)
  const rect = visibleRect({ w: project.width, h: project.height }, project.crop ?? null)
  return { key: step.key, t, rect, whole: true, outside: false, ring: null, arrow: null, sig: shotSig(project, t, rect, null, null) }
}

/** The bug report's Actual shot (§5.5.1): the whole screen at `actualAt`, no ring. */
export function planActual(project: Project, actualAt: number): ShotPlan {
  const frame = { w: project.width, h: project.height }
  const rect = visibleRect(frame, project.crop ?? null)
  const t = Math.min(Math.max(0, actualAt), project.duration)
  const sig = JSON.stringify({ t, rect, privacy: privacyAt(project, t).map((s) => [s.id, s.start, s.end, s.x, s.y, s.w, s.h, s.strength]), grade: project.grade?.screen ?? null, cursor: [project.cursor.show, project.cursor.size] })
  return { key: 'actual', t, rect, whole: true, outside: false, ring: null, arrow: null, sig }
}
