/**
 * Adding and editing animated callouts (docs/design/editing-polish.md §2.3, §7): step badges,
 * speech bubbles, an item's motions and sound, and a badge's or a tail's pin. Each is one project
 * out (one store.update, one undo step). Pure.
 */
import { readItemSound } from '../audio/soundFxData'
import { captionLanguage } from '../captions/captionTracks'
import { nativeNumbering } from '../captions/words'
import type { Rect } from '../engine/layout'
import { clamp } from '../engine/math'
import type { Camera } from '../engine/zoom'
import { annotationItem, BADGE_TEXT_MAX, CALLOUT_ALLOWED, calloutOf, graphemesOf, readCalloutMotion, shapeItem, type CalloutItem } from '../render/calloutData'
import { BADGE_SIZE, BUBBLE_BODY, CALLOUT_DEFAULTS, withDefaultMotion } from '../render/callouts'
import { speedAt } from '../render/overlays'
import type { Annotation, CalloutMotion, Clip, Project, SfxRef, Shape, ShapeKind, TitleCard } from '../types'
import { newAnnotationId } from './annotations'
import { playheadTimes, shapeForPlayhead } from './shapes'

type Point = { x: number; y: number }

const HEX = /^#[0-9a-f]{6}$/i
const unit = (v: number): number => clamp(Number.isFinite(v) ? v : 0.5, 0, 1)
/** A pin as the reader keeps it: normalised to the recording, each −1..2. */
const pinOf = (p: Point): Point => ({ x: clamp(Number.isFinite(p.x) ? p.x : 0.5, -1, 2), y: clamp(Number.isFinite(p.y) ? p.y : 0.5, -1, 2) })
/** A body as the reader keeps it: units of S, each −1..1. */
const bodyOf = (b: { dx: number; dy: number }): { dx: number; dy: number } => ({ dx: clamp(Number.isFinite(b.dx) ? b.dx : 0, -1, 1), dy: clamp(Number.isFinite(b.dy) ? b.dy : 0, -1, 1) })

/* ---------- where a new badge or bubble goes (§2.3) ---------- */

/** Output px back to the recording (normalised), the inverse of toOutput(rect, cam). */
export function fromOutput(rect: Rect, cam: Camera): (x: number, y: number) => Point {
  const viewX = cam.cx - 0.5 / cam.scale
  const viewY = cam.cy - 0.5 / cam.scale
  return (x, y) => ({ x: viewX + (x - rect.x) / (cam.scale * rect.w), y: viewY + (y - rect.y) / (cam.scale * rect.h) })
}

/** What the preview shows at the playhead: the frame's size and its camera both ways. */
export interface CalloutView {
  w: number
  h: number
  toOut: (x: number, y: number) => Point
  fromOut: (x: number, y: number) => Point
}

/**
 * Where a new badge goes (§2.3): with the cursor showing at the playhead (`cursor`, normalised to
 * the recording), its centre 1.2 badge widths up and to the left of the pointer's tip, kept inside
 * the frame; else at the centre of what the preview shows. `pin` is that point of the recording,
 * `x`, `y` where it shows in the frame (0..1).
 */
export function badgeSpot(view: CalloutView, cursor: Point | null, size = BADGE_SIZE): { pin: Point; x: number; y: number } {
  const d = 1.75 * size * Math.min(view.w, view.h)
  const at = cursor ? view.toOut(cursor.x, cursor.y) : { x: view.w / 2, y: view.h / 2 }
  const out = cursor ? { x: clamp(at.x - 1.2 * d, d / 2, view.w - d / 2), y: clamp(at.y - 1.2 * d, d / 2, view.h - d / 2) } : at
  return { pin: pinOf(view.fromOut(out.x, out.y)), x: unit(out.x / view.w), y: unit(out.y / view.h) }
}

/**
 * Where a new bubble goes (§2.3, §7.4): its tail's tip on the pointer's tip when the cursor shows
 * at the playhead, else at the centre of what the preview shows; its body above it, toward the
 * frame's centre. `x`, `y`: where the body's centre shows (an older Flown draws the text there).
 */
export function bubbleSpot(view: CalloutView, cursor: Point | null): { pin: Point; body: { dx: number; dy: number }; x: number; y: number } {
  const tip = cursor ? view.toOut(cursor.x, cursor.y) : { x: view.w / 2, y: view.h / 2 }
  const body = { dx: tip.x > view.w / 2 ? -BUBBLE_BODY.dx : BUBBLE_BODY.dx, dy: BUBBLE_BODY.dy }
  const s = Math.min(view.w, view.h)
  return { pin: pinOf(cursor ?? view.fromOut(tip.x, tip.y)), body, x: unit((tip.x + body.dx * s) / view.w), y: unit((tip.y + body.dy * s) / view.h) }
}

/* ---------- adding (§7.1) ---------- */

/** Whether `language` (a caption or transcript language) is Bangla. */
const isBangla = (language: string | null | undefined): boolean => nativeNumbering(language ?? undefined) === 'beng'

/** The language a new badge counts in: the caption track's or the transcript's (Bangla gives ১ ২ ৩). */
export function badgeLanguage(project: Pick<Project, 'captions' | 'transcript'>): string | null {
  return captionLanguage(project) ?? null
}

/** Start and end of a new callout at the playhead `t`: fully shown there, one entrance earlier (viewing time). */
function newTimes(project: Pick<Project, 'duration' | 'clips'>, t: number, enter: CalloutMotion): { start: number; end: number } {
  return playheadTimes(t, enter.duration * speedAt(project.clips, t), project)
}

/**
 * A new step badge at the playhead (§2.3, §7.1, §7.3): numbered automatically, popping in, in the
 * brand kit's first colour (else the default blue), counting in Bangla digits when the captions or
 * the transcript are Bangla. `at.pin` (null: it stays at x, y and does not follow the zoom).
 */
export function addBadge(project: Project, t: number, at: { pin: Point | null; x: number; y: number }, language: string | null): { project: Project; id: string } {
  const d = CALLOUT_DEFAULTS.badge
  const brand = project.brand?.colors?.find((c) => HEX.test(c))
  const a: Annotation = {
    id: newAnnotationId(),
    ...newTimes(project, t, d.enter),
    text: '',
    x: unit(at.x),
    y: unit(at.y),
    size: BADGE_SIZE,
    style: 'badge',
    number: 'auto',
    ...(isBangla(language) ? { numbering: 'bn' } : {}),
    ...(brand ? { color: brand.toLowerCase() } : {}),
    ...(at.pin ? { pin: pinOf(at.pin) } : {}),
    enter: { ...d.enter },
    exit: { ...d.exit }
  }
  return { project: { ...project, annotations: [...project.annotations, a] }, id: a.id }
}

/** A new speech bubble at the playhead (§2.3, §7.4): its tail on `at.pin`, its body at `at.body`, popping in from the tip. */
export function addBubble(project: Project, t: number, at: { pin: Point; body: { dx: number; dy: number }; x: number; y: number }): { project: Project; id: string } {
  const d = CALLOUT_DEFAULTS.bubble
  const a: Annotation = {
    id: newAnnotationId(),
    ...newTimes(project, t, d.enter),
    text: '',
    x: unit(at.x),
    y: unit(at.y),
    size: BADGE_SIZE,
    style: 'bubble',
    pin: pinOf(at.pin),
    body: bodyOf(at.body),
    enter: { ...d.enter },
    exit: { ...d.exit }
  }
  return { project: { ...project, annotations: [...project.annotations, a] }, id: a.id }
}

/**
 * A new shape of `kind` for the playhead at `t` (addShapeAt, §7.1): shapeForPlayhead's, with its
 * kind's default motion, starting one entrance earlier instead of one fade so it is fully shown at
 * `t`. Privacy shapes are as before.
 */
export function newShapeForPlayhead(kind: ShapeKind, t: number, project: { duration: number; width: number; height: number; clips?: Clip[] }, cursor: Point | null, speed = 1): Shape {
  const s = withDefaultMotion(shapeForPlayhead(kind, t, project, cursor, speed))
  return s.enter ? { ...s, ...playheadTimes(t, s.enter.duration * speed, project) } : s
}

/* ---------- motions and sounds (§2.3) ---------- */

/** The item a callout ref names in `project` (null: missing, or a privacy shape). */
function itemOf(project: Project, ref: { kind: 'annotation' | 'shape' | 'title'; id: string }): CalloutItem | null {
  if (ref.kind === 'annotation') {
    const a = project.annotations.find((x) => x.id === ref.id)
    return a ? annotationItem(calloutOf(a).style) : null
  }
  if (ref.kind === 'shape') {
    const s = (project.shapes ?? []).find((x) => x.id === ref.id)
    return s ? shapeItem(s.kind) : null
  }
  return (project.titles ?? []).some((x) => x.id === ref.id) ? 'title' : null
}

/** `item` with `key` set to `v`, or without it for null; the same object when nothing changes. */
function setKey<T extends object>(item: T, key: string, v: unknown): T {
  const rec = item as Record<string, unknown>
  if (v === null || v === undefined) {
    if (!(key in rec)) return item
    const { [key]: _gone, ...rest } = rec
    void _gone
    return rest as T
  }
  if (JSON.stringify(rec[key]) === JSON.stringify(v)) return item
  return { ...item, [key]: v }
}

/**
 * An item's motions and sound (null: the default, today's fade or the project's sound rule). A
 * motion its item does not allow, or an unknown sound, changes nothing. One project out.
 */
export function withCallout(
  project: Project,
  ref: { kind: 'annotation' | 'shape' | 'title'; id: string },
  patch: {
    enter?: CalloutMotion | null
    exit?: CalloutMotion | null
    sound?: 'none' | SfxRef | null
  }
): Project {
  const item = itemOf(project, ref)
  if (!item) return project
  const allowed = CALLOUT_ALLOWED[item]
  const edit = <T extends object>(x: T): T => {
    let out = x
    for (const side of ['enter', 'exit'] as const) {
      const m = patch[side]
      if (m === undefined) continue
      const read = m === null ? null : readCalloutMotion(m, allowed[side])
      if (m !== null && !read) continue
      out = setKey(out, side, read)
    }
    if (patch.sound !== undefined) {
      const sound = patch.sound === null ? null : readItemSound(patch.sound)
      if (patch.sound === null || sound) out = setKey(out, 'sound', sound)
    }
    return out
  }
  return mapById(project, ref, edit)
}

/** `project` with the item `ref` replaced by `fn(item)` (the same project when it does not change). */
function mapById(project: Project, ref: { kind: 'annotation' | 'shape' | 'title'; id: string }, fn: <T extends object>(x: T) => T): Project {
  if (ref.kind === 'annotation') {
    let changed = false
    const annotations = project.annotations.map((a) => {
      if (a.id !== ref.id) return a
      const next = fn(a)
      changed ||= next !== a
      return next
    })
    return changed ? { ...project, annotations } : project
  }
  if (ref.kind === 'shape') {
    let changed = false
    const shapes = (project.shapes ?? []).map((s) => {
      if (s.id !== ref.id) return s
      const next = fn(s)
      changed ||= next !== s
      return next
    })
    return changed ? { ...project, shapes } : project
  }
  let changed = false
  const titles = (project.titles ?? []).map((c: TitleCard) => {
    if (c.id !== ref.id) return c
    const next = fn(c)
    changed ||= next !== c
    return next
  })
  return changed ? { ...project, titles } : project
}

/** The motion a pick of `kind` writes on `item`'s `side`: the item's own length and strength when it has a motion there, else its kind's default length. */
export function pickedMotion(item: CalloutItem, side: 'enter' | 'exit', kind: CalloutMotion['kind'], current: CalloutMotion | undefined): CalloutMotion {
  if (current) return { kind, duration: current.duration, strength: current.strength }
  const d = CALLOUT_DEFAULTS[item][side]
  return { kind, duration: d.duration, strength: d.kind === kind ? d.strength : 1 }
}

/* ---------- pins and bodies (§2.3, §4.5) ---------- */

/** An annotation `id` with `fn` applied (the same project when it is missing or unchanged). */
function mapAnnotation(project: Project, id: string, fn: (a: Annotation) => Annotation): Project {
  return mapById(project, { kind: 'annotation', id }, fn as <T extends object>(x: T) => T)
}

/**
 * A badge's or a tail's pin moved (a point of the recording), with where it shows in the frame
 * written to x, y, so an older Flown draws it near there (§4.5).
 */
export function movePin(project: Project, id: string, pin: Point, shownAt: Point): Project {
  return mapAnnotation(project, id, (a) => ({ ...a, pin: pinOf(pin), x: unit(shownAt.x), y: unit(shownAt.y) }))
}

/** A bubble's body moved around its tip (units of S), with where its centre shows written to x, y. */
export function moveBody(project: Project, id: string, body: { dx: number; dy: number }, shownAt: Point): Project {
  return mapAnnotation(project, id, (a) => ({ ...a, body: bodyOf(body), x: unit(shownAt.x), y: unit(shownAt.y) }))
}

/**
 * Follows the zoom (§2.3): on, the badge is pinned to the point of the recording it shows over
 * (`pin`); off, it stays where it shows (`shownAt`) and no longer moves with the camera.
 */
export function setFollowsZoom(project: Project, id: string, on: boolean, at: { pin: Point; shownAt: Point }): Project {
  return mapAnnotation(project, id, (a) => {
    const placed = { ...a, x: unit(at.shownAt.x), y: unit(at.shownAt.y) }
    return on ? { ...placed, pin: pinOf(at.pin) } : (setKey(placed, 'pin', null) as Annotation)
  })
}

/** A bubble's Tail (§2.3): Pointing (a tip and a body around it) or None (a body at `shownAt`, no tail). */
export function setBubbleTail(project: Project, id: string, tail: { pin: Point; body: { dx: number; dy: number } } | null, shownAt: Point): Project {
  return mapAnnotation(project, id, (a) => {
    const placed = { ...a, x: unit(shownAt.x), y: unit(shownAt.y) }
    if (tail) return { ...placed, pin: pinOf(tail.pin), body: bodyOf(tail.body) }
    return setKey(setKey(placed, 'pin', null), 'body', null) as Annotation
  })
}

/* ---------- a badge's options (§2.3, §7.3) ---------- */

/** "At most 3 letters" when a badge's own text has more graphemes than it draws, else null. */
export function badgeTextError(text: string): string | null {
  return graphemesOf(text).length > BADGE_TEXT_MAX ? `At most ${BADGE_TEXT_MAX} letters` : null
}

/**
 * A badge's Number, Count with, Start from and Colour (§2.3): `number` 'auto' numbers it, `text`
 * gives it its own text (at most 3 graphemes kept); `startAt` null counts on; `color` null takes
 * the default. One project out.
 */
export function withBadge(project: Project, id: string, patch: { number?: 'auto' | 'text'; text?: string; numbering?: string; startAt?: number | null; color?: string | null }): Project {
  return mapAnnotation(project, id, (a) => {
    let out = a
    if (patch.number === 'auto') out = setKey(out, 'number', 'auto')
    if (patch.number === 'text') out = setKey(out, 'number', null)
    if (patch.text !== undefined) out = setKey(out, 'text', graphemesOf(patch.text).slice(0, BADGE_TEXT_MAX).join(''))
    if (patch.numbering !== undefined) out = setKey(out, 'numbering', patch.numbering === '1' ? null : patch.numbering)
    if (patch.startAt !== undefined) out = setKey(out, 'startAt', patch.startAt === null ? null : clamp(Math.round(patch.startAt), 1, 999))
    if (patch.color !== undefined) out = setKey(out, 'color', patch.color && HEX.test(patch.color) ? patch.color.toLowerCase() : null)
    return out
  })
}

/** A bubble's Colour (null: white). */
export function withBubbleColor(project: Project, id: string, color: string | null): Project {
  return mapAnnotation(project, id, (a) => setKey(a, 'color', color && HEX.test(color) ? color.toLowerCase() : null))
}

/** Restart at each chapter (§7.3): written as the user sets it. */
export function withBadgesByChapter(project: Project, on: boolean): Project {
  return project.effects.badgesByChapter === on ? project : { ...project, effects: { ...project.effects, badgesByChapter: on } }
}

/** Calm motion (§7.5): on, or off (the key removed, as a project from before). */
export function withCalm(project: Project, on: boolean): Project {
  if (on) return project.effects.calm === true ? project : { ...project, effects: { ...project.effects, calm: true } }
  if (!('calm' in project.effects)) return project
  const { calm: _c, ...effects } = project.effects
  void _c
  return { ...project, effects }
}

/* ---------- Count with (§2.3, §13) ---------- */

const LANGUAGE_NAMES = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'language' }) : null
const SAMPLE_DIGITS: Readonly<Record<string, string>> = { beng: '১ ২ ৩', deva: '१ २ ३', arab: '١ ٢ ٣', arabext: '۱ ۲ ۳' }

/**
 * The choices of Count with: 1 2 3, A B C, Bangla digits always, and the digits of the caption and
 * transcript languages when they have their own. `lang` is the sample's language (screen readers).
 */
export function countWithOptions(project: Pick<Project, 'captions' | 'transcript'>): { value: string; label: string; sample: string; lang?: string }[] {
  const out: { value: string; label: string; sample: string; lang?: string }[] = [
    { value: '1', label: '1 2 3', sample: '1 2 3' },
    { value: 'A', label: 'A B C', sample: 'A B C' },
    { value: 'bn', label: 'Bangla digits', sample: SAMPLE_DIGITS.beng, lang: 'bn' }
  ]
  const langs = [project.captions?.track, project.transcript?.language].filter((l): l is string => typeof l === 'string' && l.length > 0)
  for (const lang of langs) {
    const base = lang.toLowerCase().split(/[-_]/)[0]
    const digits = nativeNumbering(base)
    if (digits === 'latn' || digits === 'beng' || out.some((o) => o.value === base)) continue
    const name = LANGUAGE_NAMES?.of(base) ?? base
    out.push({ value: base, label: `${name} digits`, sample: SAMPLE_DIGITS[digits] ?? '', lang: base })
  }
  return out
}
