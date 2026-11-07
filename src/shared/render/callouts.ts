/**
 * Animated callouts (docs/design/editing-polish.md §7): one motion engine for texts, shapes and
 * title cards (Captions Studio's itemPose plus Draw and Wipe), step badges and speech bubbles. Pure:
 * every pose and every place is a function of time and the project, so preview, export, seeking
 * and any frame rate draw the same frames.
 */
import type { Rect } from '../engine/layout'
import { clamp } from '../engine/math'
import { editToVideo, planOf } from '../engine/freeze'
import { viewAt } from '../captions/layout'
import { contrastRatio, luminance } from '../captions/colors'
import { EASE, itemPose, type ChunkPose } from '../captions/motion'
import { withDigits } from '../captions/words'
import type { Annotation, AnnotationStyle, CalloutMotion, CalloutMotionKind, Clip, ItemMotion, Project, Shape, ShapeKind } from '../types'
import { annotationItem, badgesByChapterOf, CALLOUT_ALLOWED, calloutOf, graphemesOf, shapeItem, type CalloutItem } from './calloutData'
import { outputChapters } from './chapters'
import { annotationMetrics } from './overlays'

export type { CalloutItem } from './calloutData'

/** What each item allows (§7.1): calloutData's table, which the readers keep to. */
export const CALLOUT_KINDS: Readonly<Record<CalloutItem, { enter: readonly CalloutMotionKind[]; exit: readonly CalloutMotionKind[] }>> = CALLOUT_ALLOWED

const motion = (kind: CalloutMotionKind, duration: number, strength = 1): CalloutMotion => ({ kind, duration, strength })

/** The motions written into new items (§7.1; texts and title cards get them only when picked). */
export const CALLOUT_DEFAULTS: Readonly<Record<CalloutItem, { enter: CalloutMotion; exit: CalloutMotion }>> = {
  text: { enter: motion('rise', 0.25), exit: motion('fade', 0.18) },
  badge: { enter: motion('pop', 0.24), exit: motion('fade', 0.18) },
  bubble: { enter: motion('pop', 0.26), exit: motion('pop', 0.18, 0.25) },
  arrow: { enter: motion('draw', 0.35), exit: motion('fade', 0.18) },
  box: { enter: motion('draw', 0.45), exit: motion('fade', 0.18) },
  highlight: { enter: motion('wipe', 0.28), exit: motion('fade', 0.18) },
  title: { enter: motion('rise', 0.35), exit: motion('fade', 0.35) }
}

/** Today's fades, the length a missing side of a motion fades over (§7.1): texts and shapes 0.15 s, title cards 0.35 s. */
export const OLD_FADE = { text: 0.15, shape: 0.15, title: 0.35 } as const

/**
 * The item a text style, a shape kind or a title card ('title') is; null for blur and pixelate,
 * which never move. Annotations read their item through calloutData's annotationItem: a text in
 * the Title style is a 'text' there, whereas 'title' here is a title card.
 */
export function calloutItemOf(kind: AnnotationStyle | ShapeKind | 'title'): CalloutItem | null {
  if (kind === 'title') return 'title'
  if (kind === 'pill' || kind === 'badge' || kind === 'bubble') return annotationItem(kind)
  return shapeItem(kind)
}

/**
 * A new shape with its kind's default motion (§7.1): arrows and lines draw themselves, boxes and
 * ellipses draw their outline, highlights wipe in. Privacy shapes and a shape that already has a
 * motion are returned as they are (old items are never given one).
 */
export function withDefaultMotion<T extends Shape>(shape: T): T {
  if (shape.enter || shape.exit) return shape
  const item = shapeItem(shape.kind)
  if (!item) return shape
  const d = CALLOUT_DEFAULTS[item]
  return { ...shape, enter: { ...d.enter }, exit: { ...d.exit } }
}

/** Captions Studio's ChunkPose plus how much of a Draw is drawn (0..1). */
export interface CalloutPose extends ChunkPose {
  drawn: number
}

/** A fade over `seconds`: the side of an item that has no motion of its own (today's fade length). */
const fadeOver = (seconds: number): ItemMotion => ({ kind: 'fade', duration: seconds, strength: 1 })
/** An ItemMotion that does nothing on its side (Draw and Wipe are worked out here, not by itemPose). */
const still = (m: CalloutMotion): ItemMotion => ({ kind: 'none', duration: m.duration, strength: m.strength })
const asItem = (m: CalloutMotion): ItemMotion => m as ItemMotion

/**
 * An item's pose at source time `t`, or null outside it (§7.1). The kinds of ItemMotion go through
 * Captions Studio's itemPose unchanged (viewing time, each side at most half the item, Calm
 * motion's clamps, exits played backwards with inCubic). 'draw' (enter only) draws the item:
 * `drawn = 1 − (1 − p)³` at full opacity. 'wipe' (enter only) reveals it from the reading start:
 * `reveal = emphDecel(p)`. A side without a motion fades over `oldFade` (today's fade length).
 * `u` is the item's em in px; `calm`: Calm motion (§7.5), under which Draw becomes a fade.
 */
export function calloutPose(
  start: number,
  end: number,
  t: number,
  clips: Clip[],
  enter: CalloutMotion | undefined,
  exit: CalloutMotion | undefined,
  u: number,
  calm: boolean,
  oldFade: number
): CalloutPose | null {
  if (!(t >= start && t < end)) return null
  let inM: CalloutMotion = enter ?? fadeOver(oldFade)
  // Draw and Wipe never leave (the readers keep them to entrances): a fade of the old length instead.
  const outM: CalloutMotion = exit && exit.kind !== 'draw' && exit.kind !== 'wipe' ? exit : fadeOver(oldFade)
  if (calm && inM.kind === 'draw') inM = { ...inM, kind: 'fade' }
  const special = inM.kind === 'draw' || inM.kind === 'wipe'
  const pose = itemPose(start, end, t, clips, special ? still(inM) : asItem(inM), asItem(outM), u, calm)
  if (!pose) return null
  const out: CalloutPose = { ...pose, drawn: 1 }
  if (!special) return out
  // The entrance's progress, timed as itemPose times its own: viewing time, at most half the item, calm at least 0.2 s.
  const from = viewAt(clips, start)
  const to = viewAt(clips, end)
  const now = viewAt(clips, t)
  const d = Math.min(calm ? Math.max(0.2, inM.duration) : inM.duration, Math.max(0, (to - from) / 2))
  if (!(d > 0) || now - from >= d) return out
  const p = clamp((now - from) / d, 0, 1)
  if (inM.kind === 'draw') out.drawn = EASE.out(p)
  else out.reveal = EASE.emphDecel(p)
  return out
}

/** The graphemes of `text` ("ক্ষা" and "👍🏽" are one each). */
export function graphemes(text: string): string[] {
  return graphemesOf(text)
}

/* ---------- step badges (§7.3) ---------- */

/** A badge's default fill. */
export const BADGE_FILL = '#0060df'
/** A badge's font size, a fraction of the frame's shorter side (the caption default: 49 px at 1080p). */
export const BADGE_SIZE = 0.045

/** 1 → A, 26 → Z, 27 → AA, 28 → AB (bijective base 26). */
function letters(k: number): string {
  let n = Math.max(1, Math.floor(k))
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** The number `k` written in a badge's numbering: '1' Western digits, 'A' letters, a language code its own digits. */
export function badgeNumber(k: number, numbering: string): string {
  if (numbering === 'A') return letters(k)
  if (numbering === '1') return String(k)
  return withDigits(String(k), 'native', numbering)
}

interface LabelMemo {
  chapters: Project['chapters']
  clips: Project['clips']
  effects: Project['effects']
  freezes: Project['freezes']
  out: ReadonlyMap<string, string>
}
const labelMemo = new WeakMap<readonly Annotation[], LabelMemo>()

/**
 * The label each automatic badge draws, by annotation id (§7.3): automatic badges in start-time
 * order (ties by id) count 1, 2, 3…; the count starts again at each chapter's start (in the
 * video's time) unless `effects.badgesByChapter` is false or the project has fewer than two
 * chapters; a badge with `startAt` takes that number and the next count on from it. Badges with
 * their own text do not count. Memoised on the annotations, chapters, clips, freezes and effects.
 */
export function badgeLabels(project: Project): ReadonlyMap<string, string> {
  const annotations = project.annotations ?? []
  const hit = labelMemo.get(annotations)
  if (hit && hit.chapters === project.chapters && hit.clips === project.clips && hit.effects === project.effects && hit.freezes === project.freezes) return hit.out
  const autos = annotations.filter((a) => a.style === 'badge' && calloutOf(a).number === 'auto').sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out = new Map<string, string>()
  if (autos.length) {
    const plan = planOf(project)
    const chapters = project.clips.length ? outputChapters(project.chapters ?? [], project.clips, plan) : []
    const byChapter = chapters.length >= 2 && badgesByChapterOf(project.effects ?? {}, chapters.length)
    const starts = byChapter ? chapters.map((c) => c.start) : []
    let chapter = -1
    let k = 0
    for (const a of autos) {
      if (byChapter) {
        const at = editToVideo(plan, viewAt(project.clips, a.start))
        let i = -1
        while (i + 1 < starts.length && starts[i + 1] <= at + 1e-6) i++
        if (i !== chapter) {
          chapter = i
          k = 0
        }
      }
      const c = calloutOf(a)
      k = c.startAt ?? k + 1
      out.set(a.id, badgeNumber(k, c.numbering))
    }
  }
  labelMemo.set(annotations, { chapters: project.chapters, clips: project.clips, effects: project.effects, freezes: project.freezes, out })
  return out
}

const HEX = /^#[0-9a-f]{6}$/i

/** White or #111111 on `fill`, whichever has the higher contrast with it (#0060df: white, 5.61:1). */
export function badgeTextColor(fill: string): '#ffffff' | '#111111' {
  if (!HEX.test(fill)) return '#ffffff'
  return contrastRatio(fill, '#ffffff') >= contrastRatio(fill, '#111111') ? '#ffffff' : '#111111'
}

/**
 * A badge's circle or pill for `label` at font `px` (§7.3): one grapheme in a circle 1.75 px
 * across; two at 0.85 px in the same circle; three or more in a pill 1.75 px high and the text's
 * width plus 0.9 px wide. Graphemes as a reader counts them.
 */
export function badgeBox(label: string, px: number, measure: (text: string, px: number) => number): { w: number; h: number; px: number; radius: number } {
  const n = graphemesOf(label).length
  const d = 1.75 * px
  if (n <= 1) return { w: d, h: d, px, radius: d / 2 }
  if (n === 2) return { w: d, h: d, px: 0.85 * px, radius: d / 2 }
  return { w: Math.max(d, measure(label, px) + 0.9 * px), h: d, px, radius: d / 2 }
}

/* ---------- speech bubbles (§7.4) ---------- */

/** A bubble's default fill. */
export const BUBBLE_FILL = '#ffffff'
/** A new bubble's body, relative to its tip, in units of the frame's shorter side (dx toward the frame's centre). */
export const BUBBLE_BODY = { dx: 0.12, dy: -0.1 } as const

const wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

/** The pieces a paragraph may break between: words with the spaces after them (Intl.Segmenter's word granularity). */
function wordPieces(text: string): string[] {
  if (!wordSegmenter) return text.match(/\S+\s*|\s+/g) ?? []
  const out: string[] = []
  for (const s of wordSegmenter.segment(text)) {
    // Spaces (and punctuation) stay with the word before them, so a line never starts with them.
    if (out.length && (/^\s+$/u.test(s.segment) || (!s.isWordLike && !/\s$/u.test(out[out.length - 1])))) out[out.length - 1] += s.segment
    else out.push(s.segment)
  }
  return out
}

const trimEnd = (s: string): string => s.replace(/\s+$/u, '')

/**
 * A bubble's lines (§7.4): greedy by words to `maxWidth`; a word wider than a line (or text
 * without spaces, as Chinese) wraps between graphemes, never inside one, so a Bangla conjunct or a
 * vowel sign stays with its letter. Line breaks in the text are kept; lines are trimmed at the end.
 */
export function wrapCallout(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    const push = (): void => {
      lines.push(trimEnd(line))
      line = ''
    }
    /** Adds `piece` grapheme by grapheme, starting a new line wherever the next one would not fit. */
    const byGraphemes = (piece: string): void => {
      for (const g of graphemesOf(piece)) {
        if (trimEnd(line) !== '' && measure(trimEnd(line + g)) > maxWidth) push()
        line += g
      }
    }
    for (const piece of wordPieces(para)) {
      if (line === '' || measure(trimEnd(line + piece)) <= maxWidth) {
        if (line === '' && measure(trimEnd(piece)) > maxWidth) byGraphemes(piece)
        else line += piece
        continue
      }
      push()
      if (measure(trimEnd(piece)) > maxWidth) byGraphemes(piece)
      else line = piece
    }
    push()
  }
  return lines
}

/**
 * A bubble's body (§7.4): its centre at `tip + body · s`, then moved by the least amount that keeps
 * it inside `area` (centred across an area smaller than it).
 */
export function bubbleBody(tip: { x: number; y: number }, body: { dx: number; dy: number }, size: { w: number; h: number }, s: number, area: Rect): Rect {
  const cx = tip.x + body.dx * s
  const cy = tip.y + body.dy * s
  const fit = (c: number, len: number, lo: number, room: number): number => (len > room ? lo + (room - len) / 2 : clamp(c - len / 2, lo, lo + room - len))
  return { x: fit(cx, size.w, area.x, area.w), y: fit(cy, size.h, area.y, area.h), w: size.w, h: size.h }
}

/**
 * A bubble's tail toward `tip` (§7.4), or null when it is left out (no tip, the tip inside the
 * body or closer to it than 0.5 f). It sits on the body's edge that faces the tip most; its base is
 * 0.6 f wide (at most 0.15 of that edge), at least the corner radius from the corners, as near the
 * tip as that allows; it reaches toward the tip, 0.5 f to 3 f long.
 */
export function bubbleTail(
  body: Rect,
  tip: { x: number; y: number } | null,
  f: number,
  radius: number
): {
  base: [{ x: number; y: number }, { x: number; y: number }]
  tip: { x: number; y: number }
} | null {
  if (!tip) return null
  const right = body.x + body.w
  const bottom = body.y + body.h
  const ox = tip.x < body.x ? body.x - tip.x : tip.x > right ? tip.x - right : 0
  const oy = tip.y < body.y ? body.y - tip.y : tip.y > bottom ? tip.y - bottom : 0
  if (Math.hypot(ox, oy) < 0.5 * f) return null
  const sides = [
    { side: 'left', d: body.x - tip.x },
    { side: 'right', d: tip.x - right },
    { side: 'top', d: body.y - tip.y },
    { side: 'bottom', d: tip.y - bottom }
  ] as const
  const edge = sides.reduce((a, b) => (b.d > a.d ? b : a))
  const across = edge.side === 'top' || edge.side === 'bottom'
  const len = across ? body.w : body.h
  const width = Math.min(0.6 * f, 0.15 * len)
  const lo = (across ? body.x : body.y) + radius + width / 2
  const hi = (across ? right : bottom) - radius - width / 2
  const mid = (across ? body.x : body.y) + len / 2
  const along = lo <= hi ? clamp(across ? tip.x : tip.y, lo, hi) : mid
  const at = across ? { x: along, y: edge.side === 'top' ? body.y : bottom } : { x: edge.side === 'left' ? body.x : right, y: along }
  const base: [{ x: number; y: number }, { x: number; y: number }] = across
    ? [
        { x: along - width / 2, y: at.y },
        { x: along + width / 2, y: at.y }
      ]
    : [
        { x: at.x, y: along - width / 2 },
        { x: at.x, y: along + width / 2 }
      ]
  const dx = tip.x - at.x
  const dy = tip.y - at.y
  const dist = Math.hypot(dx, dy) || 1
  const reach = clamp(dist, 0.5 * f, 3 * f)
  return { base, tip: { x: at.x + (dx / dist) * reach, y: at.y + (dy / dist) * reach } }
}

/** Whether a bubble of `fill` gets a thin outline (a fill lighter than 0.7, so it shows on white app pages). */
export const bubbleOutlined = (fill: string): boolean => HEX.test(fill) && luminance(fill) > 0.7

/** The line height of a bubble's text, in units of its font: 1.4 with Bengali, Devanagari or Thai, else 1.3 (annotationMetrics). */
export const bubbleLineHeight = (text: string): number => annotationMetrics({ size: 1, style: 'bubble', text }, 1, 1).lineHeight

/* ---------- where a badge or a bubble is drawn (§7.3, §7.4) ---------- */

/** What a badge or a bubble needs of the frame it is drawn in. */
export interface CalloutFrame {
  w: number
  h: number
  /** Where texts keep to (safeZones textArea); null: the whole frame. */
  area: Rect | null
  /** A point of the drawn recording (normalised) in output px, through the frame's camera; null: pins are not drawn. */
  toOut: ((x: number, y: number) => { x: number; y: number }) | null
  /** Whether an output point shows the recording (inside the card's slot, not under a camera that covers it). */
  visible: (p: { x: number; y: number }) => boolean
  /** The visible picture's rectangle (output px): a hidden tip is brought back into it, so the body keeps its place beside the picture's edge. */
  seen?: Rect | null
  /** The scene's crop: pins are stored in the full recording and drawn in its view. */
  crop?: Rect | null
}

/** A badge or a bubble as drawn: its box, a bubble's lines and tail, the point its motion scales about. */
export interface CalloutPlace {
  kind: 'badge' | 'bubble'
  /** A badge's circle or pill, or a bubble's body, output px. */
  box: Rect
  radius: number
  /** Font px and line height of the text. */
  px: number
  lineHeight: number
  /** What is written, line by line. */
  lines: string[]
  tail: { base: [{ x: number; y: number }, { x: number; y: number }]; tip: { x: number; y: number } } | null
  /** Where the pin shows (output px) while it shows; null without a pin or while it is hidden. */
  pin: { x: number; y: number } | null
  /** The point the motion scales about: a badge's centre, a bubble's tail tip (else its body's centre). */
  origin: { x: number; y: number }
  fill: string
  text: '#ffffff' | '#111111'
}

/** A full-recording point in the crop's view. */
const pinIn = (pin: { x: number; y: number }, crop: Rect | null | undefined): { x: number; y: number } => (crop ? { x: (pin.x - crop.x) / crop.w, y: (pin.y - crop.y) / crop.h } : pin)

/** The nearest point of `r` to `p`. */
const intoRect = (p: { x: number; y: number }, r: Rect): { x: number; y: number } => ({ x: clamp(p.x, r.x, r.x + r.w), y: clamp(p.y, r.y, r.y + r.h) })

/** Where a pin shows in a frame (output px), or null without a pin or a camera. */
export function pinOut(a: Annotation, frame: Pick<CalloutFrame, 'toOut' | 'crop'>): { x: number; y: number } | null {
  const c = calloutOf(a)
  if (!c.pin || !frame.toOut) return null
  const p = pinIn(c.pin, frame.crop)
  return frame.toOut(p.x, p.y)
}

/**
 * Where a badge or a bubble is drawn in a frame (§7.3, §7.4), or null for another text and for a
 * badge whose pin is outside the visible picture (not drawn). `label` is an automatic badge's
 * number; `measure(text, px, weight)` measures in the callout font. The preview's handles and the
 * drawing both place them with this.
 */
export function calloutPlace(a: Annotation, label: string | null, frame: CalloutFrame, measure: (text: string, px: number, weight: number) => number): CalloutPlace | null {
  const c = calloutOf(a)
  if (c.style !== 'badge' && c.style !== 'bubble') return null
  const S = Math.min(frame.w, frame.h)
  const m = annotationMetrics({ size: a.size, style: c.style, text: c.text }, frame.w, frame.h)
  const f = Math.max(1, m.px)
  const at = pinOut(a, frame)
  if (c.style === 'badge') {
    if (at && !frame.visible(at)) return null
    const text = label ?? c.text
    const box = badgeBox(text, f, (s, px) => measure(s, px, m.weight))
    const centre = at ?? { x: a.x * frame.w, y: a.y * frame.h }
    const fill = c.color ?? BADGE_FILL
    return {
      kind: 'badge',
      box: { x: centre.x - box.w / 2, y: centre.y - box.h / 2, w: box.w, h: box.h },
      radius: box.radius,
      px: box.px,
      lineHeight: box.px,
      lines: [text],
      tail: null,
      pin: at,
      origin: centre,
      fill,
      text: badgeTextColor(fill)
    }
  }
  const area = frame.area ?? { x: 0, y: 0, w: frame.w, h: frame.h }
  const maxBody = (frame.w >= frame.h ? 0.42 : 0.8) * frame.w
  const padX = m.padX
  const padY = m.padY
  const lh = m.lineHeight
  const lines = c.text.trim() ? wrapCallout(c.text, Math.max(f, maxBody - 2 * padX), (s) => measure(s, f, m.weight)) : ['']
  const textW = Math.max(2 * f, ...lines.map((l) => measure(l || ' ', f, m.weight)))
  const size = { w: Math.min(Math.max(maxBody, 2 * f + 2 * padX), textW + 2 * padX), h: lines.length * lh + 2 * padY }
  const radius = Math.min(0.5 * size.h, 0.6 * f)
  const fill = c.color ?? BUBBLE_FILL
  const text = badgeTextColor(fill)
  if (!at) {
    // No pin: the body centred at x, y, kept inside the text area; no tail.
    const box = bubbleBody({ x: a.x * frame.w, y: a.y * frame.h }, { dx: 0, dy: 0 }, size, S, area)
    return { kind: 'bubble', box, radius, px: f, lineHeight: lh, lines, tail: null, pin: null, origin: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, fill, text }
  }
  const shown = frame.visible(at)
  // A tip outside the picture: the body stays beside the picture's edge, without its tail.
  const anchor = shown || !frame.seen ? at : intoRect(at, frame.seen)
  const box = bubbleBody(anchor, c.body ?? BUBBLE_BODY, size, S, area)
  const tail = shown ? bubbleTail(box, at, f, radius) : null
  return {
    kind: 'bubble',
    box,
    radius,
    px: f,
    lineHeight: lh,
    lines,
    tail,
    pin: shown ? at : null,
    origin: tail ? tail.tip : { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    fill,
    text
  }
}

/* ---------- draw-on lengths (§7.2) ---------- */

/** A rectangle's perimeter (a Draw's dash length). */
export function rectPerimeter(w: number, h: number): number {
  return 2 * (w + h)
}

/** An ellipse's perimeter by Ramanujan's approximation. */
export function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
}
