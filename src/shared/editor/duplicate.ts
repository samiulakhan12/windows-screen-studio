/**
 * Duplicate, Make a vertical version and Make a square version (X-04, NW-05,
 * docs/design/vertical-video.md §4.8): the copy's name, whether a copy can be made, and the
 * project the copy starts as. Pure: the renderer builds the copy from the editor's current state
 * (unsaved edits included); main gives it its new id, copies the files and writes it last
 * (src/main/projectCopy.ts).
 */
import { visibleSize } from '../engine/crop'
import { outputSize, type Rect } from '../engine/layout'
import { canFollow, DEFAULT_REFRAME, followApplies } from '../engine/reframeData'
import { fontStack } from '../render/fonts'
import { overlayBox } from '../render/imageOverlays'
import { ANNOTATION_FONT, annotationMetrics, type TextBoxMetrics } from '../render/overlays'
import { keepInArea, textArea } from '../render/safeZones'
import { autoStyle } from '../captions/autoStyle'
import { captionsOf } from '../captions/settings'
import { studioEdited } from '../captions/studioEdit'
import { studioPreset } from '../captions/studioPresets'
import type { Annotation, AspectRatio, CaptionSettings, Graphic, ImageOverlay, Project, ProjectFont, ReframeSettings } from '../types'

export type CopyKind = 'copy' | 'vertical' | 'square'

/** Longest name of a copy (main cuts what it writes to the same length). */
const NAME_MAX = 120
/** The name a copy of a project without one starts from. */
const UNTITLED = 'Untitled recording'
const SUFFIX: Record<CopyKind, string> = { copy: ' (copy)', vertical: ' (vertical)', square: ' (square)' }
/** The frame each kind of version is made in. */
const FRAME: Record<Exclude<CopyKind, 'copy'>, AspectRatio> = { vertical: '9:16', square: '1:1' }
/** Smallest share of its size a text or an image is shrunk to by the refit (§4.8). */
const MIN_SCALE = 0.6
/** Width of a character as a share of the font size, when no measure is given (Segoe UI's average). */
const CHAR_WIDTH = 0.55

/** At most `max` UTF-16 units of `s`, never ending in half of a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const code = s.charCodeAt(max - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/** "Billing demo (copy)", "(vertical)", "(square)"; a blank name gives "Untitled recording (…)"; at most 120 characters. */
export function copyName(name: string, kind: CopyKind): string {
  const suffix = SUFFIX[kind]
  const base = (typeof name === 'string' ? name.trim() : '') || UNTITLED
  // A long name is cut before its suffix, so the copy still says what it is.
  return `${cut(base, NAME_MAX - suffix.length).trimEnd()}${suffix}`
}

/** Measures text as the compositor draws it (px wide). */
export type MeasureText = (text: string, px: number, font: string, weight: number) => number

/** Whether a copy of `kind` can be made, with the menu's reason when not (§2.2). vw × vh: the recording as cropped. */
export function canCopyAs(project: Project, kind: CopyKind, vw: number, vh: number): { ok: true } | { ok: false; reason: string } {
  if (kind === 'copy') return { ok: true }
  const aspect = FRAME[kind]
  const frame = outputSize(aspect, vw, vh, 1080)
  if (project.style.aspectRatio === aspect && followApplies(project, frame.width, frame.height, vw, vh)) return { ok: false, reason: 'This video already follows the action' }
  if (!canFollow(aspect, vw, vh)) return { ok: false, reason: kind === 'vertical' ? 'Your recording is already tall' : 'Your recording is already square or tall' }
  return { ok: true }
}

/**
 * The project as copied (still with `project.id`; main gives the new id):
 *  - 'copy': only the name changes.
 *  - 'vertical' / 'square': aspectRatio '9:16' / '1:1'; reframe = { ...DEFAULT_REFRAME, ...project.reframe,
 *    mode: 'follow', camera: kind === 'vertical' ? (project.reframe?.camera ?? 'top') : 'bubble',
 *    appSafe: kind === 'vertical' }; text annotations and image overlays refitted (refitItems).
 * Captions Studio (docs/design/captions-studio.md §10.5): the caption look is chosen again for the
 * new shape (what Auto style gives the new frame) when it was not picked by hand or is an unedited
 * built-in tile, and kept when edited, saved or the brand kit's; dragged graphics and a dragged
 * caption block are refitted as images are.
 * Never changes clips, zooms, layouts, shapes, crop, freezes or any other field. Pure: the input is not mutated.
 *
 * Each text and image goes into the new frame's text area at its start (textArea: the area the
 * apps leave free in a tall frame, clear of the camera band in effect there), or into the whole
 * frame when there is none (a square). The frame is the canonical one the follow plan uses,
 * outputSize(aspect, vw, vh, 1080): positions are fractions of the frame and sizes of its
 * shorter side, so every frame of the aspect gives the same result.
 */
export function projectCopy(project: Project, kind: CopyKind, measure: MeasureText | null): Project {
  const name = copyName(project.name, kind)
  if (kind === 'copy') return { ...project, name }
  const aspectRatio = FRAME[kind]
  const reframe: ReframeSettings = {
    ...DEFAULT_REFRAME,
    ...project.reframe,
    mode: 'follow',
    camera: kind === 'vertical' ? (project.reframe?.camera ?? 'top') : 'bubble',
    appSafe: kind === 'vertical'
  }
  const copy: Project = { ...project, name, style: { ...project.style, aspectRatio }, reframe }
  const { width: vw, height: vh } = visibleSize(project)
  const { width: w, height: h } = outputSize(aspectRatio, vw, vh, 1080)
  const areaAt = (t: number): Rect => textArea(copy, w, h, vw, vh, t) ?? { x: 0, y: 0, w, h }
  const refitted: Project = { ...copy, ...refit(copy, w, h, areaAt, measure, project.fonts) }
  return refitCaptions(withCopyLook(refitted, { w, h }), w, h, areaAt)
}

/**
 * Whether a copy in another shape gets its caption look chosen again (§10.5): a look not picked
 * by hand (an automatic one, or the default Classic look), or an unedited built-in tile. An edited,
 * saved or brand look, and a Classic look picked by hand, are kept.
 */
export function lookChosenAgain(captions: CaptionSettings | undefined): boolean {
  const c = captions
  if (!c?.picked) return true
  const s = c.studio
  return !!s && !!studioPreset(s.from) && !studioEdited(s)
}

/** The copy with what Auto style gives its frame, when it has captions and its look is chosen again; it is not a pick, and a dragged place stays. */
function withCopyLook(copy: Project, frame: { w: number; h: number }): Project {
  const c = captionsOf(copy)
  // Without captions there is no look to choose: Auto style gives one when the first captions come.
  if (!copy.transcript?.segments.length || !lookChosenAgain(copy.captions)) return copy
  const { picked: _picked, ...free } = c
  void _picked
  const chosen = autoStyle({ ...copy, captions: free }, frame, null)
  if (!chosen) return copy
  const tile = studioPreset(chosen.tile)
  const place = c.studio?.layout.place
  const studio = place ? { ...chosen.studio, layout: { ...chosen.studio.layout, place: { ...place } } } : chosen.studio
  return { ...copy, captions: { ...free, ...(tile ? { preset: tile.fallback } : {}), studio } }
}

/** A normalised centre moved into `area` (px of a w × h frame). */
const intoArea = (p: { x: number; y: number }, w: number, h: number, area: Rect): { x: number; y: number } => ({
  x: Math.min(area.x + area.w, Math.max(area.x, p.x * w)) / w,
  y: Math.min(area.y + area.h, Math.max(area.y, p.y * h)) / h
})

/**
 * A dragged caption block and dragged graphics moved into the text area of the new frame, as
 * images are (§10.5): a graphic's box (its size in the shorter side, twice as wide as tall) is
 * shifted in, and shrunk to fit but not below 60%; the caption block's centre is moved in.
 * Graphics placed automatically need nothing. Lists without a change stay the same arrays.
 */
function refitCaptions(copy: Project, w: number, h: number, areaAt: (t: number) => Rect): Project {
  let out = copy
  const place = copy.captions?.studio?.layout.place
  if (place) {
    const at = intoArea(place, w, h, areaAt(0))
    if (at.x !== place.x || at.y !== place.y) {
      const c = copy.captions!
      out = { ...out, captions: { ...c, studio: { ...c.studio!, layout: { ...c.studio!.layout, place: at } } } }
    }
  }
  const graphics = copy.graphics
  if (graphics?.some((g) => g.place !== 'auto')) {
    const u = Math.min(w, h)
    const next = graphics.map((g): Graphic => {
      if (g.place === 'auto') return g
      const area = areaAt(g.start)
      const bh = g.size * u
      const bw = bh * 2
      const fit = keepInArea({ x: g.place.x * w - bw / 2, y: g.place.y * h - bh / 2, w: bw, h: bh }, area, MIN_SCALE)
      if (fit.dx === 0 && fit.dy === 0 && fit.scale === 1) return g
      return { ...g, place: { x: (g.place.x * w + fit.dx) / w, y: (g.place.y * h + fit.dy) / h }, size: g.size * fit.scale }
    })
    if (next.some((g, i) => g !== graphics[i])) out = { ...out, graphics: next }
  }
  return out
}

const VERSION: Record<Exclude<CopyKind, 'copy'>, string> = { vertical: 'the vertical version', square: 'the square version' }

/**
 * "Captions: Bold Pop for the vertical version" when the copy's look was chosen again (§10.5), else
 * null. A kept look whose dragged block was only moved into the new frame is not chosen again.
 */
export function captionCopyNotice(before: Project, after: Project, kind: CopyKind): string | null {
  if (kind === 'copy' || !after.transcript?.segments.length) return null
  const a = after.captions?.studio
  if (!a || a === before.captions?.studio || !lookChosenAgain(before.captions)) return null
  const name = studioPreset(a.from)?.name
  return name ? `Captions: ${name} for ${VERSION[kind]}` : null
}

/**
 * Text and images moved into `area` (output px of a w × h frame; §6.4): each item already inside is the same object;
 * else shifted in; if larger than the area, scaled down to fit but not below 60% of its size; a text still too wide
 * at 60% is broken at the space nearest its middle ("\n"), then shifted.
 */
export function refitItems(
  project: Pick<Project, 'annotations' | 'overlays'>,
  w: number,
  h: number,
  area: Rect,
  measure: MeasureText | null
): Pick<Project, 'annotations' | 'overlays'> {
  return refit(project, w, h, () => area, measure, undefined)
}

/** refitItems with the area at each item's start and the project's fonts to measure with. A list without a change is the same array. */
function refit(
  project: Pick<Project, 'annotations' | 'overlays'>,
  w: number,
  h: number,
  areaAt: (t: number) => Rect,
  measure: MeasureText | null,
  fonts: readonly ProjectFont[] | undefined
): Pick<Project, 'annotations' | 'overlays'> {
  const usable = (area: Rect): boolean => w > 0 && h > 0 && area.w > 0 && area.h > 0 && [area.x, area.y, area.w, area.h].every(Number.isFinite)
  const same = <T>(list: T[], next: T[]): T[] => (next.every((v, i) => v === list[i]) ? list : next)
  const annotations = same(
    project.annotations,
    project.annotations.map((a) => {
      const area = areaAt(a.start)
      return usable(area) ? refitText(a, w, h, area, measure, fonts) : a
    })
  )
  const out: Pick<Project, 'annotations' | 'overlays'> = { annotations }
  const overlays = project.overlays
  if (overlays) {
    out.overlays = same(
      overlays,
      overlays.map((o) => {
        const area = areaAt(o.start)
        return usable(area) ? refitImage(o, w, h, area) : o
      })
    )
  }
  return out
}

/** The box drawAnnotations draws `text` in, centred on (cx, cy) (the widest line, padded), and each line's width. */
function textBox(text: string, cx: number, cy: number, m: TextBoxMetrics, font: string, measure: MeasureText | null): { box: Rect; widths: number[] } {
  const lines = text.split('\n')
  const widths = lines.map((l) => {
    const line = l || ' '
    const width = measure ? measure(line, m.px, font, m.weight) : line.length * CHAR_WIDTH * m.px
    return Number.isFinite(width) && width > 0 ? width : 0
  })
  const bw = Math.max(...widths) + m.padX * 2
  const bh = m.lineHeight * lines.length + m.padY * 2
  return { box: { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh }, widths }
}

/**
 * `text` with its widest line broken at the run of spaces nearest that line's middle (counted in
 * characters), or null when that line has no space between two words.
 */
function breakWidest(text: string, widths: number[]): string | null {
  const lines = text.split('\n')
  let widest = 0
  for (let i = 1; i < lines.length; i++) if (widths[i] > widths[widest]) widest = i
  const line = lines[widest]
  const middle = line.length / 2
  let best: { start: number; end: number } | null = null
  for (const run of line.matchAll(/ +/g)) {
    const start = run.index ?? 0
    const end = start + run[0].length
    // Only spaces between words: a break never leaves an empty line.
    if (start === 0 || end === line.length) continue
    if (!best || Math.abs((start + end) / 2 - middle) < Math.abs((best.start + best.end) / 2 - middle)) best = { start, end }
  }
  if (!best) return null
  lines.splice(widest, 1, line.slice(0, best.start), line.slice(best.end))
  return lines.join('\n')
}

/** A text annotation refitted into `area`: the same object when it is inside already. */
function refitText(a: Annotation, w: number, h: number, area: Rect, measure: MeasureText | null, fonts: readonly ProjectFont[] | undefined): Annotation {
  // A blank text is not drawn (drawAnnotations), so there is nothing to keep clear.
  if (!a.text.trim()) return a
  const m = annotationMetrics(a, w, h)
  const font = fontStack(fonts, a.font, ANNOTATION_FONT)
  const cx = a.x * w
  const cy = a.y * h
  let text = a.text
  let { box, widths } = textBox(text, cx, cy, m, font, measure)
  let fit = keepInArea(box, area, MIN_SCALE)
  // Still too wide at the smallest size: broken between words until it fits or cannot break again.
  while (fit.scale <= MIN_SCALE && box.w * fit.scale > area.w) {
    const broken = breakWidest(text, widths)
    if (broken === null) break
    text = broken
    ;({ box, widths } = textBox(text, cx, cy, m, font, measure))
    fit = keepInArea(box, area, MIN_SCALE)
  }
  if (fit.dx === 0 && fit.dy === 0 && fit.scale === 1 && text === a.text) return a
  return { ...a, text, x: (cx + fit.dx) / w, y: (cy + fit.dy) / h, size: a.size * fit.scale }
}

/** An image overlay refitted into `area` by its rotated bounds: the same object when it is inside already. */
function refitImage(o: ImageOverlay, w: number, h: number, area: Rect): ImageOverlay {
  const b = overlayBox(o, w, h)
  const cos = Math.abs(Math.cos(b.angle))
  const sin = Math.abs(Math.sin(b.angle))
  const bw = b.w * cos + b.h * sin
  const bh = b.w * sin + b.h * cos
  const fit = keepInArea({ x: b.cx - bw / 2, y: b.cy - bh / 2, w: bw, h: bh }, area, MIN_SCALE)
  if (fit.dx === 0 && fit.dy === 0 && fit.scale === 1) return o
  return { ...o, x: (b.cx + fit.dx) / w, y: (b.cy + fit.dy) / h, w: o.w * fit.scale, h: o.h * fit.scale }
}
