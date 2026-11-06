/**
 * Reading the stored data of Captions Studio (docs/design/captions-studio.md §4.2): the look,
 * emphasis marks, per-caption places, graphics, caption tracks, bleeps and automation records.
 * Like the other readers (readReframe, readTitleCard): anything that is not usable is dropped or
 * takes a default, numbers are clamped, texts cleaned and cut, lists bounded; an empty list reads
 * as undefined, so no empty key is ever written; every reader returns a deep-equal value when it
 * reads its own output. One rule for loading a project (engine/project.ts), prefs and the brand kit.
 */
import { FONT_ID_RE } from '../render/fonts'
import type {
  AutoOrigin,
  Bleep,
  CaptionAuto,
  CaptionMark,
  CaptionMotion,
  CaptionPlace,
  CaptionSegment,
  CaptionStudio,
  CaptionTrack,
  CaptionWord,
  CounterGraphic,
  EmojiGraphic,
  Graphic,
  ItemMotion,
  KeywordGraphic,
  ListGraphic,
  StudioBox,
  StudioEdge,
  StudioEmphasis,
  StudioLayout,
  StudioScriptFont,
  StudioText,
  StudioTheme,
  Transcript,
  WordAnchor
} from '../types'
import { CAPTION_MAX_CHARS, cleanCaptionText, LANGUAGE_RE, readWords } from './captionData'
import { catalogId, CATALOG_PREFIX } from './fontCatalog'
import { readCaptionSettings } from './settings'
import { STUDIO_BASE } from './studioPresets'
import { studioWords } from './words'

export const STUDIO_LIMITS = {
  size: { min: 0.025, max: 0.22 },
  tall: { min: 1, max: 1.6 },
  tracking: { min: -0.05, max: 0.15 },
  lineHeight: { min: 0.8, max: 1.8 },
  weight: { min: 100, max: 1000 },
  emphasisScale: { min: 1, max: 1.6 },
  outline: { min: 0, max: 0.2 },
  glow: { min: 0, max: 1 },
  pad: { min: 0, max: 1.5 },
  radius: { min: 0, max: 2 },
  /** Raised from 0.05 for the dark sticker border of Stickers (§0.1). */
  border: { min: 0, max: 0.12 },
  words: { min: 1, max: 8 },
  lines: { min: 1, max: 4 },
  chars: { min: 0, max: 80 },
  fit: { min: 0.5, max: 0.95 },
  strength: { min: 0, max: 1 },
  speed: { min: 0.5, max: 2 },
  tilt: { min: 0, max: 8 },
  shadowOffset: { min: -0.3, max: 0.3 },
  shadowBlur: { min: 0, max: 1 },
  /* The fields the approved looks of §0.1 and §0.2 added. */
  boxGap: { min: 0, max: 0.3 },
  tail: { min: 0, max: 1.5 },
  wordTilt: { min: -8, max: 8 },
  spokenScale: { min: 1, max: 1.3 },
  spokenTilt: { min: -8, max: 8 },
  extrudeSteps: { min: 1, max: 12 },
  extrudeStep: { min: -0.05, max: 0.05 },
  split: { min: 0, max: 0.1 },
  fontWidth: { min: 62.5, max: 125 }
} as const
export const MAX_MARKS = 20000
export const MAX_GRAPHICS = 500
export const MAX_TRACKS = 8
export const MAX_BLEEPS = 2000
export const GRAPHIC_TEXT_MAX = 40
export const LIST_ITEM_MAX = 60
/** Longest text a mark or word anchor keeps. */
export const ANCHOR_TEXT_MAX = 80
/** Longest bleeped word kept. */
export const BLEEP_WORD_MAX = 40
/** Longest counter prefix or suffix ("$", "%", "M"). */
const AFFIX_MAX = 12
/** Most items of a list card. */
const LIST_ITEMS_MAX = 7
/** Largest counter value kept (formatting stays sane). */
const COUNTER_MAX = 1e12

const HEX = /^#[0-9a-f]{6}$/i
const PROVIDERS = ['openai', 'gemini', 'anthropic'] as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, r: { readonly min: number; readonly max: number }): number => Math.min(r.max, Math.max(r.min, v))
/** A finite number clamped to `r`, else `fallback`. */
const num = (v: unknown, r: { readonly min: number; readonly max: number }, fallback: number): number => (finite(v) ? clamp(v, r) : fallback)
/** A whole number clamped to `r`, else `fallback`. */
const int = (v: unknown, r: { readonly min: number; readonly max: number }, fallback: number): number => (finite(v) ? clamp(Math.round(v), r) : fallback)
const pick = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const colour = (v: unknown): string | undefined => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined)
const colourOr = (v: unknown, fallback: string): string => colour(v) ?? fallback
/** `{ [key]: value }`, or nothing when the value is absent. */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }))
/** One line: control characters and line breaks become spaces, single spaces, trimmed, at most `max` characters. */
const oneLine = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
        .trim()
    : ''
const idOf = (v: unknown): string => (typeof v === 'string' && v.length <= 64 ? v : '')

/** Ids made unique: a missing or repeated one becomes `base~2`, `base~3`… (deterministic, so reading again changes nothing). */
function uniqueIds<T extends { id: string }>(items: T[], base: string): T[] {
  const seen = new Set<string>()
  return items.map((item) => {
    let id = item.id || base
    if (seen.has(id)) {
      const stem = id.slice(0, 56)
      let k = 2
      while (seen.has(`${stem}~${k}`)) k++
      id = `${stem}~${k}`
    }
    seen.add(id)
    return id === item.id ? item : { ...item, id }
  })
}

/* ---------- fonts ---------- */

/**
 * A stored look font (rule 2): 'system', 'cat:' plus a catalogue id that exists (an unknown one,
 * from a newer build, reads as 'system' so the project still draws), or a brand font id
 * (FONT_ID_RE); anything else is undefined.
 */
export function readStudioFont(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  if (v === 'system') return v
  if (v.startsWith(CATALOG_PREFIX)) return catalogId(v) ? v : 'system'
  return FONT_ID_RE.test(v) ? v : undefined
}

/** A catalogue font reference that exists, else undefined (fields where 'system' makes no sense). */
const catalogFontRef = (v: unknown): string | undefined => (catalogId(v) ? (v as string) : undefined)

/* ---------- the look (rule 2) ---------- */

function readShadow(v: unknown): { x: number; y: number; blur: number; alpha: number } | undefined {
  if (!isObj(v) || !finite(v.x) || !finite(v.y) || !finite(v.blur) || !finite(v.alpha)) return undefined
  const L = STUDIO_LIMITS
  return { x: clamp(v.x, L.shadowOffset), y: clamp(v.y, L.shadowOffset), blur: clamp(v.blur, L.shadowBlur), alpha: clamp(v.alpha, { min: 0, max: 1 }) }
}

/** Places of `count` gradient stops, 0..1 and never going back, else undefined (evenly spaced). */
function readStopsAt(v: unknown, count: number): number[] | undefined {
  if (!Array.isArray(v) || v.length !== count) return undefined
  return v.every((x, i) => finite(x) && x >= 0 && x <= 1 && (i === 0 || x >= (v[i - 1] as number))) ? (v as number[]).slice() : undefined
}

/** 2..6 valid stops (cut to the first 6), else undefined. */
function readStops(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const stops = v.map(colour).filter((c): c is string => !!c)
  return stops.length >= 2 ? stops.slice(0, 6) : undefined
}

function readScriptFont(v: unknown): StudioScriptFont | undefined {
  if (!isObj(v)) return undefined
  const font = catalogFontRef(v.font)
  if (!font || !finite(v.weight)) return undefined
  return { font, weight: clamp(v.weight, STUDIO_LIMITS.weight), ...opt('width', finite(v.width) ? clamp(v.width, STUDIO_LIMITS.fontWidth) : undefined) }
}

function readText(v: unknown): StudioText {
  const b = STUDIO_BASE.text
  if (!isObj(v)) return structuredClone(b)
  const L = STUDIO_LIMITS
  const bengali = isObj(v.scripts) ? readScriptFont(v.scripts.bengali) : undefined
  return {
    font: readStudioFont(v.font) ?? b.font,
    weight: num(v.weight, L.weight, b.weight),
    case: pick(v.case, ['asis', 'upper', 'lower'] as const, b.case),
    tracking: num(v.tracking, L.tracking, b.tracking),
    lineHeight: num(v.lineHeight, L.lineHeight, b.lineHeight),
    size: num(v.size, L.size, b.size),
    tall: num(v.tall, L.tall, b.tall),
    ...opt('spokenWeight', finite(v.spokenWeight) ? clamp(v.spokenWeight, L.weight) : undefined),
    ...opt('scripts', bengali ? { bengali } : undefined)
  }
}

function readEmphasis(v: unknown): StudioEmphasis {
  const b = STUDIO_BASE.emphasis
  if (!isObj(v)) return structuredClone(b)
  // An emphasis font from a newer build's catalogue is dropped: emphasised words then use the text's font.
  const font = typeof v.font === 'string' && v.font.startsWith(CATALOG_PREFIX) ? catalogFontRef(v.font) : readStudioFont(v.font)
  return {
    ...opt('font', font),
    weight: num(v.weight, STUDIO_LIMITS.weight, b.weight),
    scale: num(v.scale, STUDIO_LIMITS.emphasisScale, b.scale),
    mark: pick(v.mark, ['none', 'marker', 'underline', 'box', 'circle'] as const, b.mark)
  }
}

function readTheme(v: unknown): StudioTheme {
  const b = STUDIO_BASE.theme
  if (!isObj(v)) return structuredClone(b)
  const gradient = readStops(v.gradient)
  const fillStops = isObj(v.fill) ? readStops(v.fill.stops) : undefined
  const fillAt = isObj(v.fill) && fillStops ? readStopsAt(v.fill.at, fillStops.length) : undefined
  const fillAxis = isObj(v.fill) ? pick(v.fill.axis, ['across', 'down'] as const, 'across') : 'across'
  const split = Array.isArray(v.split) && v.split.length === 2 ? v.split.map(colour) : []
  return {
    text: colourOr(v.text, b.text),
    ...opt('upcoming', colour(v.upcoming)),
    spoken: colourOr(v.spoken, b.spoken),
    ...opt('spokenText', colour(v.spokenText)),
    emphasis: colourOr(v.emphasis, b.emphasis),
    ...opt('emphasisText', colour(v.emphasisText)),
    ...opt('emphasis2', colour(v.emphasis2)),
    outline: colourOr(v.outline, b.outline),
    shadow: colourOr(v.shadow, b.shadow),
    box: colourOr(v.box, b.box),
    glow: colourOr(v.glow, b.glow),
    ...opt('gradient', gradient),
    ...opt('fill', fillStops ? { stops: fillStops, ...opt('at', fillAt), axis: fillAxis } : undefined),
    ...opt('border', colour(v.border)),
    ...opt('youBox', colour(v.youBox)),
    ...opt('youText', colour(v.youText)),
    ...opt('extrude', colour(v.extrude)),
    ...opt('spokenExtrude', colour(v.spokenExtrude)),
    ...opt('split', split[0] && split[1] ? ([split[0], split[1]] as [string, string]) : undefined)
  }
}

function readEdge(v: unknown): StudioEdge {
  const b = STUDIO_BASE.edge
  if (!isObj(v)) return structuredClone(b)
  const L = STUDIO_LIMITS
  const extrude =
    isObj(v.extrude) && finite(v.extrude.steps) && finite(v.extrude.x) && finite(v.extrude.y)
      ? { steps: clamp(Math.round(v.extrude.steps), L.extrudeSteps), x: clamp(v.extrude.x, L.extrudeStep), y: clamp(v.extrude.y, L.extrudeStep) }
      : undefined
  return {
    outline: num(v.outline, L.outline, b.outline),
    outlineAlpha: num(v.outlineAlpha, { min: 0, max: 1 }, b.outlineAlpha),
    ...opt('shadow', readShadow(v.shadow)),
    glow: num(v.glow, L.glow, b.glow),
    ...opt('hollow', v.hollow === true ? (true as const) : undefined),
    ...opt('extrude', extrude),
    ...opt('split', finite(v.split) ? clamp(v.split, L.split) : undefined)
  }
}

function readBox(v: unknown): StudioBox {
  const b = STUDIO_BASE.box
  if (!isObj(v)) return structuredClone(b)
  const L = STUDIO_LIMITS
  return {
    kind: pick(v.kind, ['none', 'line', 'chunk', 'glass', 'band', 'word', 'bubble', 'chat'] as const, b.kind),
    alpha: num(v.alpha, { min: 0, max: 1 }, b.alpha),
    padX: num(v.padX, L.pad, b.padX),
    padY: num(v.padY, L.pad, b.padY),
    radius: num(v.radius, L.radius, b.radius),
    border: num(v.border, L.border, b.border),
    ...opt('gap', finite(v.gap) ? clamp(v.gap, L.boxGap) : undefined),
    ...opt('shadow', readShadow(v.shadow)),
    ...opt('tail', finite(v.tail) ? clamp(v.tail, L.tail) : undefined)
  }
}

function readLayout(v: unknown): StudioLayout {
  const b = STUDIO_BASE.layout
  if (!isObj(v)) return structuredClone(b)
  const L = STUDIO_LIMITS
  const place = isObj(v.place) && finite(v.place.x) && finite(v.place.y) ? { x: clamp(v.place.x, { min: 0, max: 1 }), y: clamp(v.place.y, { min: 0, max: 1 }) } : undefined
  return {
    chunk: pick(v.chunk, ['phrase', 'words', 'word', 'stack'] as const, b.chunk),
    words: int(v.words, L.words, b.words),
    lines: int(v.lines, L.lines, b.lines),
    chars: int(v.chars, L.chars, b.chars),
    tallChars: int(v.tallChars, L.chars, b.tallChars),
    position: pick(v.position, ['top', 'upper', 'middle', 'lower', 'bottom'] as const, b.position),
    ...opt('place', place),
    ...opt('legacyAnchor', v.legacyAnchor === true ? (true as const) : undefined),
    avoid: typeof v.avoid === 'boolean' ? v.avoid : b.avoid,
    ...opt('fit', finite(v.fit) ? clamp(v.fit, L.fit) : undefined)
  }
}

const WORD_MOTIONS = ['none', 'pulse', 'pop', 'bounce', 'rise', 'slide', 'fade', 'typewriter', 'blur', 'shake', 'wipe', 'grow'] as const

function readMotion(v: unknown): CaptionMotion {
  const b = STUDIO_BASE.motion
  if (!isObj(v)) return structuredClone(b)
  const L = STUDIO_LIMITS
  const wordTilt = Array.isArray(v.wordTilt) && v.wordTilt.length === 2 && v.wordTilt.every(finite) ? ([clamp(v.wordTilt[0], L.wordTilt), clamp(v.wordTilt[1], L.wordTilt)] as [number, number]) : undefined
  return {
    enter: pick(v.enter, ['none', 'fade', 'rise', 'drop', 'slide', 'pop', 'squeeze', 'grow', 'blur', 'wipe', 'slam'] as const, b.enter),
    exit: pick(v.exit, ['none', 'fade', 'rise', 'shrink', 'blur'] as const, b.exit),
    word: pick(v.word, WORD_MOTIONS, b.word),
    emphasis: pick(v.emphasis, WORD_MOTIONS, b.emphasis),
    upcoming: num(v.upcoming, { min: 0, max: 1 }, b.upcoming),
    strength: num(v.strength, L.strength, b.strength),
    speed: num(v.speed, L.speed, b.speed),
    tilt: num(v.tilt, L.tilt, b.tilt),
    tiltOn: pick(v.tiltOn, ['chunk', 'emphasis'] as const, b.tiltOn),
    ...opt('wordTilt', wordTilt),
    ...opt('spokenScale', finite(v.spokenScale) ? clamp(v.spokenScale, L.spokenScale) : undefined),
    ...opt('spokenTilt', finite(v.spokenTilt) ? clamp(v.spokenTilt, L.spokenTilt) : undefined),
    ...opt('calm', v.calm === true ? (true as const) : undefined)
  }
}

/**
 * A stored Captions Studio look (rule 2), or undefined when it is not an object. Each group is read
 * separately; a missing or broken field takes the value of the Subtitle look (STUDIO_BASE).
 */
export function readCaptionStudio(raw: unknown): CaptionStudio | undefined {
  if (!isObj(raw)) return undefined
  return {
    from: typeof raw.from === 'string' ? raw.from.slice(0, 64) : STUDIO_BASE.from,
    text: readText(raw.text),
    emphasis: readEmphasis(raw.emphasis),
    theme: readTheme(raw.theme),
    edge: readEdge(raw.edge),
    box: readBox(raw.box),
    spoken: pick(raw.spoken, ['none', 'color', 'fill', 'box', 'pill', 'underline', 'weight', 'glow', 'gradient'] as const, STUDIO_BASE.spoken),
    layout: readLayout(raw.layout),
    motion: readMotion(raw.motion),
    ...opt('speakerColors', raw.speakerColors === true ? (true as const) : undefined)
  }
}

/* ---------- words of a caption ---------- */

/** A text compared with words: lower-cased without punctuation or spaces (or, when that leaves nothing, only lower-cased without spaces). */
function norm(text: string): string {
  const t = text.toLowerCase().replace(/\s+/g, '')
  const bare = t.replace(/\p{P}+/gu, '')
  return bare || t
}

/** The words `from..to` of a caption as text, with a space where the caption has one. */
function joinWords(words: readonly { text: string; gap: boolean }[], from: number, to: number): string {
  let out = ''
  for (let i = from; i <= to; i++) out += (i > from && words[i].gap ? ' ' : '') + words[i].text
  return out
}

/** Whether a stored text was cut at ANCHOR_TEXT_MAX (one character less when the cut left a trailing space). */
const cutText = (text: string): boolean => text.length >= ANCHOR_TEXT_MAX - 1

/** Whether `text` (as stored, at most ANCHOR_TEXT_MAX characters) names the words `from..to`. */
function names(words: readonly { text: string; gap: boolean }[], from: number, to: number, text: string): boolean {
  const have = norm(joinWords(words, from, to))
  const want = norm(text)
  // A stored text cut at its limit (and trimmed after the cut) names words that start with it.
  return have === want || (cutText(text) && !!want && have.startsWith(want))
}

/** Per transcript (never changed in place: an edit makes a new one): its captions by id, and their words once split. */
const byId = new WeakMap<Transcript, { segments: Map<string, CaptionSegment>; words: Map<string, { text: string; gap: boolean }[]> }>()

function indexOf(transcript: Transcript): { segments: Map<string, CaptionSegment>; words: Map<string, { text: string; gap: boolean }[]> } {
  let hit = byId.get(transcript)
  if (!hit) byId.set(transcript, (hit = { segments: new Map(transcript.segments.map((s) => [s.id, s])), words: new Map() }))
  return hit
}

/** The caption `id`'s words (studioWords of its text, in the transcript's language), or null without it. */
function captionWords(transcript: Transcript | undefined, id: string): { text: string; gap: boolean }[] | null {
  if (!transcript) return null
  const index = indexOf(transcript)
  const seg = index.segments.get(id)
  if (!seg) return null
  let words = index.words.get(seg.id)
  if (!words) index.words.set(seg.id, (words = studioWords(seg.text, transcript.language)))
  return words
}

/** Final sigma read as sigma: lower-casing a word alone and in its caption differ only there. */
const sigma = (t: string): string => t.replace(/ς/g, 'σ')

/**
 * A caption's words as the search of checkAnchor compares them, made once per words list: each
 * word lower-cased without spaces (`low`) and also without punctuation (`bare`), joined, with
 * where each word starts in the joins, and for each word the first word from it that has more
 * than punctuation (itself when it does).
 */
interface Joined {
  bare: string
  bareAt: number[]
  low: string
  lowAt: number[]
  letters: number[]
}

const joinedOf = new WeakMap<readonly { text: string; gap: boolean }[], Joined>()

function joined(words: readonly { text: string; gap: boolean }[]): Joined {
  const hit = joinedOf.get(words)
  if (hit) return hit
  const n = words.length
  const out: Joined = { bare: '', bareAt: new Array<number>(n + 1), low: '', lowAt: new Array<number>(n + 1), letters: new Array<number>(n) }
  for (let k = 0; k < n; k++) {
    out.bareAt[k] = out.bare.length
    out.lowAt[k] = out.low.length
    const low = sigma(words[k].text.toLowerCase().replace(/\s+/g, ''))
    out.low += low
    out.bare += low.replace(/\p{P}+/gu, '')
  }
  out.bareAt[n] = out.bare.length
  out.lowAt[n] = out.low.length
  for (let k = n - 1, next = n; k >= 0; k--) out.letters[k] = next = out.bareAt[k + 1] > out.bareAt[k] ? k : next
  joinedOf.set(words, out)
  return out
}

/** The first m in lo+1..hi with at[m] >= target (`at` never goes down), or -1. */
function firstReaching(at: readonly number[], lo: number, hi: number, target: number): number {
  if (hi <= lo || at[hi] < target) return -1
  let a = lo + 1
  let b = hi
  while (a < b) {
    const mid = (a + b) >> 1
    if (at[mid] >= target) b = mid
    else a = mid + 1
  }
  return a
}

/**
 * The anchor's words found again in its caption (§4.2 rule 3, §11.1 "text check"), or null: the
 * anchor itself when the words at from..to still read as its text (after lower-casing and removing
 * punctuation), else the same text looked for again in the caption, nearest the old index first,
 * with new indexes; null when the caption is gone or the text is not there.
 *
 * The search reads the caption's joined words once (`joined`) and tries each start word with one
 * comparison, so a file with thousands of marks that no longer match loads at once.
 */
export function checkAnchor<T extends { caption: string; from: number; to: number; text: string }>(a: T, transcript: Transcript | undefined): T | null {
  const words = captionWords(transcript, a.caption)
  if (!words || !words.length) return null
  if (Number.isInteger(a.from) && Number.isInteger(a.to) && a.from >= 0 && a.from <= a.to && a.to < words.length && names(words, a.from, a.to, a.text)) return a
  const want = sigma(norm(a.text))
  if (!want) return null
  const cut = cutText(a.text)
  // norm keeps punctuation only for a text that has nothing else: then only words of punctuation can name it.
  const letters = want.replace(/\p{P}+/gu, '') !== ''
  const { bare, bareAt, low, lowAt, letters: next } = joined(words)
  const n = words.length
  let best: { from: number; to: number } | null = null
  for (let i = 0; i < n; i++) {
    const r = next[i]
    // m: the first word end at or past the text's length from word i; the words i..m-1 name the text.
    let m: number
    if (letters) {
      // Words of punctuation first read as themselves: longer than the text, they name nothing.
      if (r === n || lowAt[r] - lowAt[i] > want.length || !bare.startsWith(want, bareAt[i])) continue
      m = firstReaching(bareAt, r, n, bareAt[i] + want.length)
      if (m < 0 || (!cut && bareAt[m] !== bareAt[i] + want.length)) continue
    } else {
      if (r === i || !low.startsWith(want, lowAt[i])) continue
      m = firstReaching(lowAt, i, r, lowAt[i] + want.length)
      if (m < 0 || (!cut && lowAt[m] !== lowAt[i] + want.length)) continue
    }
    const j = m - 1
    // A cut text names the start of its words: they keep their number of words.
    const to = cut ? Math.max(j, Math.min(n - 1, i + Math.max(0, a.to - a.from))) : j
    if (!best || Math.abs(i - a.from) < Math.abs(best.from - a.from)) best = { from: i, to }
  }
  return best ? { ...a, from: best.from, to: best.to } : null
}

/** A stored anchor's fields, or null when they are not usable (before checkAnchor). */
export function readAnchorFields(v: unknown): WordAnchor | null {
  if (!isObj(v) || typeof v.caption !== 'string' || !v.caption || !Number.isInteger(v.from) || !Number.isInteger(v.to)) return null
  const from = v.from as number
  const to = v.to as number
  if (from < 0 || from > to) return null
  const text = oneLine(v.text, ANCHOR_TEXT_MAX)
  return text ? { caption: v.caption, from, to, text } : null
}

/* ---------- marks (rule 3) ---------- */

/**
 * Stored emphasis marks: on captions of the transcript, with valid indexes and text, checked and
 * re-found by their text (checkAnchor), overlapping marks of one caption merged, unique ids, at
 * most MAX_MARKS, in caption order.
 */
export function readCaptionMarks(raw: unknown, transcript: Transcript | undefined): CaptionMark[] | undefined {
  if (!Array.isArray(raw) || !transcript) return undefined
  const order = new Map(transcript.segments.map((s, i) => [s.id, i]))
  const marks: CaptionMark[] = []
  for (const v of raw) {
    if (marks.length >= MAX_MARKS) break
    if (!isObj(v)) continue
    const fields = readAnchorFields(v)
    if (!fields || !order.has(fields.caption)) continue
    const mark: CaptionMark = { id: idOf(v.id), ...fields, ...opt('tone', v.tone === 2 ? (2 as const) : undefined), ...opt('auto', v.auto === true ? (true as const) : undefined) }
    const checked = checkAnchor(mark, transcript)
    if (checked) marks.push(checked)
  }
  marks.sort((a, b) => order.get(a.caption)! - order.get(b.caption)! || a.from - b.from || a.to - b.to)
  // Overlapping marks of one caption become one: the first's id and tone, automatic only when both were.
  const merged: CaptionMark[] = []
  for (const m of marks) {
    const last = merged[merged.length - 1]
    if (last && last.caption === m.caption && m.from <= last.to) {
      const to = Math.max(last.to, m.to)
      const words = captionWords(transcript, m.caption)!
      const { auto: _auto, ...rest } = last
      void _auto
      merged[merged.length - 1] = { ...rest, to, text: joinWords(words, last.from, to).slice(0, ANCHOR_TEXT_MAX), ...(last.auto && m.auto ? { auto: true as const } : {}) }
    } else merged.push(m)
  }
  const out = uniqueIds(merged, 'm')
  return out.length ? out : undefined
}

/* ---------- per-caption places (rule 4) ---------- */

/** Stored per-caption positions: existing captions only, 'top' or 'bottom', one per caption, in caption order. */
export function readCaptionPlaces(raw: unknown, transcript: Transcript | undefined): CaptionPlace[] | undefined {
  if (!Array.isArray(raw) || !transcript) return undefined
  const order = new Map(transcript.segments.map((s, i) => [s.id, i]))
  const seen = new Set<string>()
  const out: CaptionPlace[] = []
  for (const v of raw) {
    if (!isObj(v) || typeof v.caption !== 'string' || !order.has(v.caption) || seen.has(v.caption)) continue
    if (v.position !== 'top' && v.position !== 'bottom') continue
    seen.add(v.caption)
    out.push({ caption: v.caption, position: v.position })
  }
  out.sort((a, b) => order.get(a.caption)! - order.get(b.caption)!)
  return out.length ? out : undefined
}

/* ---------- graphics (rule 5) ---------- */

/** The defaults readers fall back to per kind (§10.1); graphics.ts GRAPHIC_DEFAULTS holds the full set. */
const GRAPHIC_BASE: Record<Graphic['kind'], { size: number; enter: ItemMotion; exit: ItemMotion }> = {
  keyword: { size: 0.09, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 } },
  emoji: { size: 0.12, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 } },
  counter: { size: 0.11, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 } },
  list: { size: 0.045, enter: { kind: 'rise', duration: 0.22, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 } }
}

const ITEM_MOTIONS = ['none', 'fade', 'pop', 'rise', 'drop', 'slide-left', 'slide-right', 'grow', 'blur', 'typewriter'] as const

/** A stored item motion, each field falling back to `fallback`'s. */
export function readItemMotion(raw: unknown, fallback: ItemMotion): ItemMotion {
  if (!isObj(raw)) return { ...fallback }
  return {
    kind: pick(raw.kind, ITEM_MOTIONS, fallback.kind),
    duration: num(raw.duration, { min: 0.1, max: 1.5 }, fallback.duration),
    strength: num(raw.strength, { min: 0, max: 1 }, fallback.strength)
  }
}

/** A stored automatic origin (Review), or undefined when `by` or `via` is not one of theirs. */
export function readAutoOrigin(v: unknown): AutoOrigin | undefined {
  if (!isObj(v)) return undefined
  const by = pick(v.by, ['keyword', 'emoji', 'number', 'list', 'speaker', 'chapter', 'quote'] as const, null)
  const via = v.via === 'rules' ? 'rules' : pick(v.via, PROVIDERS, null)
  if (!by || !via) return undefined
  const caption = idOf(v.caption)
  const chapter = idOf(v.chapter)
  return { by, via, ...opt('caption', caption || undefined), ...opt('chapter', chapter || undefined) }
}

/** A well-formed emoji key (§4.2 rule 5): 1–10 hex code points of 1–6 digits joined by '-', each a scalar value, lower case, without FE0F; else null. */
export function emojiKeyOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 80) return null
  const parts = v.toLowerCase().split('-').filter((p) => p !== 'fe0f')
  if (!parts.length || parts.length > 10) return null
  for (const p of parts) {
    if (!/^[0-9a-f]{1,6}$/.test(p)) return null
    const cp = parseInt(p, 16)
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null
  }
  return parts.map((p) => parseInt(p, 16).toString(16)).join('-')
}

function readGraphic(v: Obj, duration: number, transcript: Transcript | undefined): Graphic | null {
  const kind = pick(v.kind, ['keyword', 'emoji', 'counter', 'list'] as const, null)
  if (!kind || !finite(v.start) || !finite(v.end)) return null
  const start = Math.min(Math.max(0, v.start), duration)
  const end = Math.min(Math.max(0, v.end), duration)
  if (!(end - start > 0.05)) return null
  const d = GRAPHIC_BASE[kind]
  const place = isObj(v.place) && finite(v.place.x) && finite(v.place.y) ? { x: clamp(v.place.x, { min: 0, max: 1 }), y: clamp(v.place.y, { min: 0, max: 1 }) } : ('auto' as const)
  const font = typeof v.font === 'string' && v.font.startsWith(CATALOG_PREFIX) ? catalogFontRef(v.font) : typeof v.font === 'string' && FONT_ID_RE.test(v.font) ? v.font : undefined
  const auto = readAutoOrigin(v.auto)
  const lang = typeof v.lang === 'string' && v.lang.length <= 35 && LANGUAGE_RE.test(v.lang) ? v.lang : undefined
  const base = {
    id: idOf(v.id),
    start,
    end,
    place,
    size: num(v.size, { min: 0.02, max: 0.3 }, d.size),
    ...opt('color', colour(v.color)),
    ...opt('accent', colour(v.accent)),
    ...opt('font', font),
    enter: readItemMotion(v.enter, d.enter),
    exit: readItemMotion(v.exit, d.exit),
    ...opt('sound', pick(v.sound, ['pop', 'ding'] as const, undefined)),
    ...opt('lang', lang),
    ...opt('auto', auto)
  }
  const anchorOf = (raw: unknown): WordAnchor | undefined => {
    const a = readAnchorFields(raw)
    return (a && checkAnchor(a, transcript)) ?? undefined
  }
  if (kind === 'keyword') {
    const text = oneLine(v.text, GRAPHIC_TEXT_MAX)
    if (!text) return null
    const anchor = anchorOf(v.anchor)
    const g: KeywordGraphic = { ...base, kind, text, look: pick(v.look, ['card', 'plain', 'outline', 'tag'] as const, 'card'), ...opt('anchor', anchor), ...opt('replace', v.replace === false ? (false as const) : undefined) }
    return g
  }
  if (kind === 'emoji') {
    const emoji = emojiKeyOf(v.emoji)
    if (!emoji) return null
    // It sits above one word: an anchor over several is dropped (the emoji stays free).
    const anchor = anchorOf(v.anchor)
    const g: EmojiGraphic = { ...base, kind, emoji, ...opt('anchor', anchor && anchor.from === anchor.to ? anchor : undefined) }
    return g
  }
  if (kind === 'counter') {
    if (!finite(v.from) || !finite(v.to)) return null
    const range = { min: -COUNTER_MAX, max: COUNTER_MAX }
    const label = oneLine(v.label, GRAPHIC_TEXT_MAX)
    const g: CounterGraphic = {
      ...base,
      kind,
      from: clamp(v.from, range),
      to: clamp(v.to, range),
      decimals: v.decimals === 1 || v.decimals === 2 ? v.decimals : 0,
      prefix: oneLine(v.prefix, AFFIX_MAX),
      suffix: oneLine(v.suffix, AFFIX_MAX),
      ...opt('label', label || undefined),
      locale: typeof v.locale === 'string' && v.locale.length <= 35 && LANGUAGE_RE.test(v.locale) ? v.locale : 'en',
      countFor: num(v.countFor, { min: 0.4, max: 5 }, 1.2)
    }
    return g
  }
  const items = (Array.isArray(v.items) ? v.items : [])
    .filter(isObj)
    .map((it) => ({ text: oneLine(it.text, LIST_ITEM_MAX), at: finite(it.at) ? Math.min(Math.max(it.at, start), end) : start }))
    .filter((it) => it.text)
    .slice(0, LIST_ITEMS_MAX)
    .sort((a, b) => a.at - b.at)
  if (!items.length) return null
  const title = oneLine(v.title, GRAPHIC_TEXT_MAX)
  const g: ListGraphic = { ...base, kind: 'list', ...opt('title', title || undefined), marker: pick(v.marker, ['number', 'bullet', 'check'] as const, 'number'), items }
  return g
}

/**
 * Stored graphics (rule 5): inside the recording, of a known kind, with their texts cleaned and
 * cut; a well-formed emoji is kept even when this build's emoji list lacks it (it is drawn only
 * when listed); anchors checked (a dropped anchor leaves the graphic free); unique ids, at most
 * MAX_GRAPHICS, in time order.
 */
export function readGraphics(raw: unknown, duration: number, transcript: Transcript | undefined): Graphic[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const dur = finite(duration) && duration > 0 ? duration : 0
  const out: Graphic[] = []
  for (const v of raw) {
    if (!isObj(v)) continue
    const g = readGraphic(v, dur, transcript)
    if (g) out.push(g)
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const unique = uniqueIds(out.slice(0, MAX_GRAPHICS), 'g')
  return unique.length ? unique : undefined
}

/* ---------- caption tracks (rule 6) ---------- */

/**
 * Stored translated tracks (rule 6): a valid language code, unique, not the spoken language;
 * segments for existing captions only (one each, in caption order), their text cleaned like
 * caption text; at most MAX_TRACKS.
 */
export function readCaptionTracks(raw: unknown, transcript: Transcript | undefined): CaptionTrack[] | undefined {
  if (!Array.isArray(raw) || !transcript) return undefined
  const order = new Map(transcript.segments.map((s, i) => [s.id, i]))
  const spoken = transcript.language?.toLowerCase()
  const languages = new Set<string>()
  const out: CaptionTrack[] = []
  for (const v of raw) {
    if (out.length >= MAX_TRACKS) break
    if (!isObj(v) || typeof v.language !== 'string' || v.language.length > 35 || !LANGUAGE_RE.test(v.language)) continue
    const key = v.language.toLowerCase()
    if (key === spoken || languages.has(key)) continue
    languages.add(key)
    const seen = new Set<string>()
    const segments: CaptionTrack['segments'] = []
    for (const s of Array.isArray(v.segments) ? v.segments : []) {
      if (!isObj(s) || typeof s.id !== 'string' || !order.has(s.id) || seen.has(s.id) || typeof s.text !== 'string') continue
      const text = cleanCaptionText(s.text).slice(0, CAPTION_MAX_CHARS)
      if (!text) continue
      seen.add(s.id)
      segments.push({ id: s.id, text, src: typeof s.src === 'string' ? s.src.slice(0, 64) : '' })
    }
    segments.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    out.push({
      language: v.language,
      by: v.by === 'local' ? 'local' : pick(v.by, PROVIDERS, 'local'),
      model: typeof v.model === 'string' ? v.model.slice(0, 200) : '',
      createdAt: typeof v.createdAt === 'string' ? v.createdAt.slice(0, 64) : '',
      segments
    })
  }
  return out.length ? out : undefined
}

/* ---------- bleeps (rule 7) ---------- */

/** Stored bleeps (rule 7): inside the recording, at least 0.02 s, the word lower-cased and cut, unique ids, at most MAX_BLEEPS, in time order. */
export function readBleeps(raw: unknown, duration: number): Bleep[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const dur = finite(duration) && duration > 0 ? duration : 0
  const out: Bleep[] = []
  for (const v of raw) {
    if (!isObj(v) || !finite(v.start) || !finite(v.end)) continue
    const start = Math.min(Math.max(0, v.start), dur)
    const end = Math.min(Math.max(0, v.end), dur)
    if (!(end - start >= 0.02)) continue
    out.push({
      id: idOf(v.id),
      start,
      end,
      word: oneLine(v.word, BLEEP_WORD_MAX).toLowerCase(),
      sound: v.sound === 'silence' ? 'silence' : 'tone',
      ...opt('auto', v.auto === true ? (true as const) : undefined)
    })
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const unique = uniqueIds(out.slice(0, MAX_BLEEPS), 'b')
  return unique.length ? unique : undefined
}

/* ---------- automation records (rule 8) ---------- */

/**
 * The stored records of what automation replaced (rule 8): the look before (read with
 * readCaptionSettings, one level, or null) and the captions' text and words before, for captions
 * that still exist (one record each).
 */
export function readCaptionAuto(raw: unknown, transcript: Transcript | undefined): CaptionAuto | undefined {
  if (!isObj(raw)) return undefined
  let style: CaptionAuto['style']
  if (isObj(raw.style) && (raw.style.by === 'great' || raw.style.by === 'polish')) {
    const was = raw.style.was === null ? null : readCaptionSettings(raw.style.was)
    if (was !== undefined) style = { was, by: raw.style.by, name: oneLine(raw.style.name, 64), ...opt('names', raw.style.names === true ? (true as const) : undefined) }
  }
  const text: NonNullable<CaptionAuto['text']> = []
  if (Array.isArray(raw.text) && transcript) {
    const seen = new Set<string>()
    for (const v of raw.text) {
      if (!isObj(v) || typeof v.caption !== 'string' || seen.has(v.caption)) continue
      const seg = indexOf(transcript).segments.get(v.caption)
      if (!seg || typeof v.text !== 'string') continue
      const t = cleanCaptionText(v.text)
      if (!t) continue
      seen.add(v.caption)
      const words: CaptionWord[] | null = readWords(v.words, seg.start, seg.end, Infinity)
      text.push({ caption: v.caption, text: t, ...opt('words', words ?? undefined) })
    }
    const order = new Map(transcript.segments.map((s, i) => [s.id, i]))
    text.sort((a, b) => order.get(a.caption)! - order.get(b.caption)!)
  }
  if (!style && !text.length) return undefined
  return { ...opt('style', style), ...opt('text', text.length ? text : undefined) }
}
