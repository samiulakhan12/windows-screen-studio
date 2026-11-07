/**
 * Reading animated callouts (docs/design/editing-polish.md §4.2, §7): the motions and sounds of
 * texts, shapes and title cards, and the step badges' and speech bubbles' fields.
 *
 * Shapes and title cards go through their readers (shapeData.ts, titleData.ts), which call
 * readCalloutMotion with what their kind allows. Annotations are loaded as raw objects (no reader),
 * and that stays: the drawing code reads their new fields through calloutOf(a), memoised per
 * object, so a damaged value draws as if absent and the file is left as it was.
 */
import { nativeNumbering } from '../captions/words'
import { readItemSound } from '../audio/soundFxData'
import type { Annotation, AnnotationStyle, CalloutMotion, CalloutMotionKind, EffectSettings, SfxRef, ShapeKind } from '../types'

/** What a callout is, for the motions it allows (§7.1). */
export type CalloutItem = 'text' | 'badge' | 'bubble' | 'arrow' | 'box' | 'highlight' | 'title'

/**
 * The motions each item allows (§7.1): what the reader keeps and the panels offer. 'blur' never
 * (blur on the frame canvas is banned for its cost), 'draw' and 'wipe' on enter only.
 */
export const CALLOUT_ALLOWED: Readonly<Record<CalloutItem, { enter: readonly CalloutMotionKind[]; exit: readonly CalloutMotionKind[] }>> = {
  text: {
    enter: ['fade', 'pop', 'rise', 'drop', 'slide-left', 'slide-right', 'grow', 'typewriter', 'wipe'],
    exit: ['fade', 'pop', 'rise', 'slide-left', 'slide-right', 'grow']
  },
  badge: {
    enter: ['fade', 'pop', 'rise', 'drop', 'grow'],
    exit: ['fade', 'pop', 'grow']
  },
  bubble: {
    enter: ['fade', 'pop', 'rise', 'grow', 'typewriter'],
    exit: ['fade', 'pop', 'grow']
  },
  arrow: {
    enter: ['draw', 'fade', 'pop', 'grow'],
    exit: ['fade', 'pop', 'grow']
  },
  box: {
    enter: ['draw', 'fade', 'pop', 'grow'],
    exit: ['fade', 'pop', 'grow']
  },
  highlight: { enter: ['wipe', 'fade'], exit: ['fade'] },
  title: {
    enter: ['fade', 'pop', 'rise', 'slide-left', 'slide-right', 'grow', 'typewriter', 'wipe'],
    exit: ['fade', 'pop', 'rise', 'grow']
  }
}

/** A callout motion's length (viewing seconds). */
export const CALLOUT_DURATION = { min: 0.1, max: 1.5 } as const

/** The item an annotation style is. */
export function annotationItem(style: AnnotationStyle): CalloutItem {
  return style === 'badge' ? 'badge' : style === 'bubble' ? 'bubble' : 'text'
}

/** The item a shape kind is, or null for the privacy shapes (blur and pixelate never move). */
export function shapeItem(kind: ShapeKind): CalloutItem | null {
  if (kind === 'arrow' || kind === 'line') return 'arrow'
  if (kind === 'rect' || kind === 'ellipse') return 'box'
  if (kind === 'highlight') return 'highlight'
  return null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A stored motion whose kind is in `allowed`, its duration clamped to 0.1..1.5 and its strength to 0..1; else undefined. */
export function readCalloutMotion(raw: unknown, allowed: readonly CalloutMotionKind[]): CalloutMotion | undefined {
  if (!isObject(raw) || raw.kind === 'blur' || !allowed.includes(raw.kind as CalloutMotionKind)) return undefined
  if (!finite(raw.duration) || !finite(raw.strength)) return undefined
  return {
    kind: raw.kind as CalloutMotionKind,
    duration: clamp(raw.duration, CALLOUT_DURATION.min, CALLOUT_DURATION.max),
    strength: clamp(raw.strength, 0, 1)
  }
}

/** The motions and sound of an item as its reader keeps them: each absent unless readable. */
export function readCalloutFields(raw: Record<string, unknown>, item: CalloutItem): { enter?: CalloutMotion; exit?: CalloutMotion; sound?: 'none' | SfxRef } {
  const enter = readCalloutMotion(raw.enter, CALLOUT_ALLOWED[item].enter)
  const exit = readCalloutMotion(raw.exit, CALLOUT_ALLOWED[item].exit)
  const sound = readItemSound(raw.sound)
  return {
    ...(enter ? { enter } : {}),
    ...(exit ? { exit } : {}),
    ...(sound ? { sound } : {})
  }
}

/** The graphemes of `text` as a reader counts them ("ক্ষা" and "👍🏽" are one each). */
export function graphemesOf(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
  return [...text]
}

/** Most graphemes a badge's own text draws. */
export const BADGE_TEXT_MAX = 3
/** A badge's own numbering: Western digits, letters, or a language with digits of its own. */
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** A stored numbering: '1', 'A', or a language code whose native digits are not Latin; else '1'. */
export function readNumbering(raw: unknown): string {
  if (raw === '1' || raw === 'A') return raw
  if (typeof raw === 'string' && raw.length <= 35 && LANGUAGE_RE.test(raw) && nativeNumbering(raw) !== 'latn') return raw
  return '1'
}

/** An annotation's callout fields, as drawn. */
export interface Callout {
  style: AnnotationStyle
  enter?: CalloutMotion
  exit?: CalloutMotion
  sound?: 'none' | SfxRef
  /** 'badge' and 'bubble': #rrggbb, else absent (the style's default). */
  color?: string
  number?: 'auto'
  /** '1', 'A' or a language code (§7.3). */
  numbering: string
  /** 1..999. */
  startAt?: number
  /** Normalised to the recording, each −1..2. */
  pin?: { x: number; y: number }
  /** Units of S, each −1..1. */
  body?: { dx: number; dy: number }
  /** What is written: a badge's own text cut to its first 3 graphemes, else the annotation's text. */
  text: string
}

const HEX = /^#[0-9a-f]{6}$/i
const STYLES: readonly AnnotationStyle[] = ['pill', 'title', 'badge', 'bubble']
const callouts = new WeakMap<Annotation, Callout>()

function readPoint(raw: unknown, min: number, max: number): { x: number; y: number } | undefined {
  if (!isObject(raw) || !finite(raw.x) || !finite(raw.y)) return undefined
  return { x: clamp(raw.x, min, max), y: clamp(raw.y, min, max) }
}

/** The callout fields of an annotation (memoised per object; a damaged value reads as absent). */
export function calloutOf(a: Annotation): Callout {
  const known = callouts.get(a)
  if (known) return known
  const raw = a as unknown as Record<string, unknown>
  const style = STYLES.includes(a.style) ? a.style : 'pill'
  const out: Callout = {
    style,
    ...readCalloutFields(raw, annotationItem(style)),
    numbering: '1',
    text: typeof a.text === 'string' ? a.text : ''
  }
  if ((style === 'badge' || style === 'bubble') && typeof raw.color === 'string' && HEX.test(raw.color)) out.color = raw.color
  if (style === 'badge') {
    if (raw.number === 'auto') out.number = 'auto'
    out.numbering = readNumbering(raw.numbering)
    if (Number.isInteger(raw.startAt) && (raw.startAt as number) >= 1 && (raw.startAt as number) <= 999) out.startAt = raw.startAt as number
    out.text = graphemesOf(out.text).slice(0, BADGE_TEXT_MAX).join('')
  }
  if (style === 'badge' || style === 'bubble') {
    const pin = readPoint(raw.pin, -1, 2)
    if (pin) out.pin = pin
  }
  if (style === 'bubble' && isObject(raw.body) && finite(raw.body.dx) && finite(raw.body.dy)) out.body = { dx: clamp(raw.body.dx, -1, 1), dy: clamp(raw.body.dy, -1, 1) }
  callouts.set(a, out)
  return out
}

/** Whether an annotation is drawn by the callout code: a motion of its own, or a badge or a bubble. Old texts never are (§4.4). */
export function isCallout(a: Annotation): boolean {
  if (a.style === 'badge' || a.style === 'bubble') return true
  const c = calloutOf(a)
  return !!(c.enter || c.exit)
}

/** Calm motion (§7.5): only a stored true turns it on. */
export const calmOf = (effects: EffectSettings): boolean => effects.calm === true

/** Whether automatic badges start again at each chapter (§7.3): a stored boolean, else yes when the project has two chapters or more. */
export function badgesByChapterOf(effects: EffectSettings, chapters: number): boolean {
  return typeof effects.badgesByChapter === 'boolean' ? effects.badgesByChapter : chapters >= 2
}
