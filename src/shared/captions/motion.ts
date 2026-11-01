/**
 * The Captions Studio motion engine (docs/design/captions-studio.md §9): every pose a pure
 * function of time, so preview, export, seeking and any frame rate draw the same frames. No state
 * between frames, no clock, no random numbers: durations run in viewing time (a cut or a speed
 * change neither jumps nor stretches an animation), and rotations and shakes come from seeds
 * hashed from the caption's id and the word's index.
 */
import { cubicBezier } from '../engine/easing'
import { clamp, lerp } from '../engine/math'
import { outputToSource } from '../engine/timeline'
import type { CaptionMotion, CaptionStudio, ChunkEnter, ChunkExit, Clip, CounterGraphic, ItemMotion, ItemMotionKind, ListGraphic, WordMotion } from '../types'
import { scriptScale } from './fontStack'
import { CAPTION_JOIN, viewAt } from './layout'
import type { StudioChunk, StudioLayout } from './studioLayout'

/* ---------- easing (§9.2) ---------- */

const emphDecel = cubicBezier(0.05, 0.7, 0.1, 1)
const emphAccel = cubicBezier(0.3, 0, 0.8, 0.15)
/** The wipe of words and emphasis marks (§9.3). */
const wipeEase = cubicBezier(0.3, 0, 0.2, 1)
const unit = (p: number): number => clamp(p, 0, 1)

/** The easings of §9.2. */
export const EASE: Record<'out' | 'outQuart' | 'inCubic' | 'outExpo' | 'emphDecel' | 'emphAccel', (p: number) => number> = {
  out: (p) => 1 - (1 - unit(p)) ** 3,
  outQuart: (p) => 1 - (1 - unit(p)) ** 4,
  inCubic: (p) => unit(p) ** 3,
  outExpo: (p) => (p >= 1 ? 1 : p <= 0 ? 0 : 1 - 2 ** (-10 * p)),
  emphDecel: (p) => emphDecel(unit(p)),
  emphAccel: (p) => emphAccel(unit(p))
}

/** back(c): overshoot easing, 1 + (c + 1)(p − 1)³ + c(p − 1)² (peak 1.10 near p = 0.58 at c = 1.7). */
export function back(p: number, c: number): number {
  const q = unit(p) - 1
  return 1 + (c + 1) * q ** 3 + c * q * q
}

const ZETA = 0.45
const OMEGA = 18
const OMEGA_D = OMEGA * Math.sqrt(1 - ZETA * ZETA)
const rawSpring = (p: number): number => 1 - Math.exp(-ZETA * OMEGA * p) * (Math.cos(OMEGA_D * p) + ((ZETA * OMEGA) / OMEGA_D) * Math.sin(OMEGA_D * p))
const SPRING_END = rawSpring(1)

/** The damped spring of §9.2 (ζ 0.45, ω₀ 18), divided by its value at p = 1 so it ends at exactly 1. */
export function spring(p: number): number {
  return rawSpring(unit(p)) / SPRING_END
}

/* ---------- seeds and cache keys (§9.1 rules 4, 5) ---------- */

const encoder = new TextEncoder()

/** A 32-bit FNV-1a hash of `key`'s UTF-8 bytes (seeds for rotation and shake, §9.1 rule 4). */
export function seedOf(key: string): number {
  let h = 0x811c9dc5
  for (const b of encoder.encode(key)) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** A cache key of the clips' starts, ends and speeds (§9.1 rule 5): their FNV-1a hash in hex. */
export function clipsKey(clips: readonly Clip[]): string {
  return seedOf(clips.map((c) => `${c.start},${c.end},${c.speed}`).join(';')).toString(16).padStart(8, '0')
}

/** A seeded number in [−1, 1]. */
const signed = (seed: number): number => (seed / 0xffffffff) * 2 - 1

/* ---------- poses ---------- */

export interface WordPose {
  token: number
  /** Offsets from the word's place at rest, px. */
  dx: number
  dy: number
  scale: number
  scaleX: number
  /** Degrees. */
  rotate: number
  alpha: number
  /** Blur radius, px (drawn from pre-blurred sprites, never ctx.filter). */
  blur: number
  /**
   * Share of the word revealed from its reading start (wipe, typewriter): 1 shown whole. For a
   * typewriter it is k / n, k whole graphemes of n (typewriterClip turns it into the clip).
   */
  reveal: number
  /** The spoken colour: a crossfade share ('color', 'glow', 'weight', box and pill text) or the swept share in reading direction ('fill', 'gradient'). */
  fill: number
  /** Share of the way to the spoken weight ('weight' mark, Light to Bold). */
  weight: number
  /** Share of an emphasis mark (marker, underline, box, circle) drawn, in its wipe timing. */
  mark: number
}

export interface ChunkPose {
  alpha: number
  dx: number
  dy: number
  scale: number
  scaleX: number
  /** Degrees. */
  rotate: number
  blur: number
  /** Share revealed from the reading start (wipe); for Glass Pill's outgoing chunk, the share of its box width still blended in. */
  reveal: number
}

/** The spoken box, pill or underline (§9.3), in the line's own coordinates (x from the line's left edge, px). */
export interface MarkBox {
  x: number
  w: number
  /** Index of the line in the chunk. */
  line: number
  alpha: number
  /** The words it covers (a big mark covers words together, §9.6). */
  first: number
  last: number
}

const REST: Readonly<ChunkPose> = Object.freeze({ alpha: 1, dx: 0, dy: 0, scale: 1, scaleX: 1, rotate: 0, blur: 0, reveal: 1 })
const rest = (): ChunkPose => ({ ...REST })

/* ---------- calm motion (§9.5) ---------- */

const CALM_ENTER: Partial<Record<ChunkEnter, ChunkEnter>> = { pop: 'grow', drop: 'grow', slam: 'grow', blur: 'fade' }
const CALM_EXIT: Partial<Record<ChunkExit, ChunkExit>> = { blur: 'fade' }
const CALM_WORD: Partial<Record<WordMotion, WordMotion>> = { pop: 'grow', bounce: 'grow', blur: 'fade', shake: 'none' }

/** Motion with the clamps of Calm motion (§9.5): pop, bounce, drop and slam grow; blur fades; no shake, tilt or growing spoken word. */
export function calmed(m: CaptionMotion): CaptionMotion {
  const { wordTilt: _wt, spokenScale: _ss, spokenTilt: _st, ...rest } = m
  void _wt
  void _ss
  void _st
  return {
    ...rest,
    enter: CALM_ENTER[m.enter] ?? m.enter,
    exit: CALM_EXIT[m.exit] ?? m.exit,
    word: CALM_WORD[m.word] ?? m.word,
    emphasis: CALM_WORD[m.emphasis] ?? m.emphasis,
    tilt: 0,
    calm: true
  }
}

const calmCache = new WeakMap<CaptionMotion, CaptionMotion>()
/** calmed(m), once per motion object. */
function calmedOf(m: CaptionMotion): CaptionMotion {
  let c = calmCache.get(m)
  if (!c) calmCache.set(m, (c = calmed(m)))
  return c
}

/** Calm motion's clamp of a pose: scale within 0.96–1.04, movement at most 0.015 u, no rotation or blur. */
function calmPose<T extends { dx: number; dy: number; scale: number; scaleX: number; rotate: number; blur: number }>(p: T, u: number): T {
  const move = 0.015 * u
  return { ...p, dx: clamp(p.dx, -move, move), dy: clamp(p.dy, -move, move), scale: clamp(p.scale, 0.96, 1.04), scaleX: clamp(p.scaleX, 0.96, 1.04), rotate: 0, blur: 0 }
}

/* ---------- timing ---------- */

/** Viewing times of the tokens' starts and ends and the chunks' starts and ends, per clips array and layout (§9.1 rule 2). */
const viewCache = new WeakMap<readonly Clip[], WeakMap<StudioLayout, { starts: Float64Array; ends: Float64Array; chunkStarts: Float64Array; chunkEnds: Float64Array }>>()

function viewTimes(layout: StudioLayout, clips: Clip[]): { starts: Float64Array; ends: Float64Array; chunkStarts: Float64Array; chunkEnds: Float64Array } {
  let byLayout = viewCache.get(clips)
  if (!byLayout) viewCache.set(clips, (byLayout = new WeakMap()))
  let v = byLayout.get(layout)
  if (!v) {
    v = {
      starts: Float64Array.from(layout.tokens, (t) => viewAt(clips, t.start)),
      ends: Float64Array.from(layout.tokens, (t) => viewAt(clips, t.end)),
      chunkStarts: Float64Array.from(layout.chunks, (c) => viewAt(clips, c.start)),
      chunkEnds: Float64Array.from(layout.chunks, (c) => viewAt(clips, c.end))
    }
    byLayout.set(layout, v)
  }
  return v
}

/** A duration divided by speed, at least `min` (chunk motion 0.1 s, word motion 0.06 s; calm 0.2 s); strength 0 keeps colour and fade within 0.12 s. */
function duration(d: number, m: CaptionMotion, min: number): number {
  let out = Math.max(min, d / m.speed)
  if (m.calm) out = Math.max(0.2, out)
  if (m.strength <= 0) out = Math.min(out, 0.12)
  return out
}

/** The seed key of a caption: its id, else its first word's time and text (a layout made by hand in a test). */
const captionKey = (layout: StudioLayout): string => layout.caption ?? `${layout.tokens[0]?.start ?? 0}|${layout.tokens.map((t) => t.text).join(' ')}`

/* ---------- chunk entrances and exits (§9.3) ---------- */

/** The pose of a chunk entrance at progress p (0..1). */
function enterPose(kind: ChunkEnter, p: number, s: number, em: number, index: number, rtl: boolean, calm: boolean): ChunkPose {
  const pose = rest()
  const from = rtl ? 1 : -1
  switch (kind) {
    case 'fade':
      pose.alpha = EASE.out(p)
      break
    case 'rise': {
      const e = EASE.emphDecel(p)
      pose.dy = (1 - e) * 0.35 * em * s
      pose.alpha = e
      break
    }
    case 'drop': {
      const e = calm ? EASE.out(p) : back(p, 1.7 * s)
      pose.dy = -(1 - e) * 0.6 * em * s
      pose.alpha = Math.min(1, 3 * p)
      break
    }
    case 'slide': {
      const e = EASE.outExpo(p)
      pose.dx = from * (1 - e) * 1.2 * em * s
      pose.alpha = e
      break
    }
    case 'pop': {
      const e = EASE.out(p)
      pose.scale = 1 - 0.2 * s * (1 - e)
      pose.dy = (1 - e) * 0.42 * em * s
      pose.alpha = Math.min(1, 3 * p)
      break
    }
    case 'squeeze': {
      const e = EASE.outQuart(p)
      pose.scaleX = 1 - 0.2 * s * (1 - e)
      pose.alpha = e
      break
    }
    case 'grow': {
      const e = EASE.emphDecel(p)
      pose.scale = 1 - 0.04 * s * (1 - e)
      pose.alpha = e
      break
    }
    case 'blur': {
      const e = EASE.emphDecel(p)
      pose.blur = (1 - e) * 0.12 * em * s
      pose.alpha = e
      break
    }
    case 'wipe':
      pose.reveal = EASE.out(p)
      break
    case 'slam': {
      const kindOf = index % 3
      if (kindOf === 0) return enterPose('drop', p, s, em, index, rtl, calm)
      if (kindOf === 1) {
        // From alternating sides.
        const e = EASE.outExpo(p)
        pose.dx = (index % 2 ? 1 : -1) * (1 - e) * 1.2 * em * s
        pose.alpha = e
      } else {
        const e = calm ? EASE.out(p) : back(p, 2.2 * s)
        pose.scale = 1 - 0.6 * s * (1 - e)
        pose.alpha = Math.min(1, 3 * p)
      }
      break
    }
  }
  return pose
}

/** Seconds a chunk entrance takes (§9.3; slam: 0.22, 0.20 or 0.24 by the chunk's index). */
function enterDuration(kind: ChunkEnter, index: number): number {
  switch (kind) {
    case 'fade':
      return 0.12
    case 'rise':
      return 0.26
    case 'drop':
      return 0.22
    case 'slide':
      return 0.2
    case 'pop':
      return 0.167
    case 'squeeze':
      return 0.133
    case 'grow':
    case 'blur':
      return 0.2
    case 'wipe':
      return 0.3
    case 'slam':
      return [0.22, 0.2, 0.24][index % 3]
    default:
      return 0
  }
}

/** The pose of a chunk exit at progress q (0 when it starts, 1 at the end). */
function exitPose(kind: ChunkExit, q: number, s: number, em: number): ChunkPose {
  const pose = rest()
  switch (kind) {
    case 'fade':
      pose.alpha = 1 - EASE.inCubic(q)
      break
    case 'rise': {
      const e = EASE.emphAccel(q)
      pose.dy = -0.2 * em * s * e
      pose.alpha = 1 - e
      break
    }
    case 'shrink': {
      const e = EASE.emphAccel(q)
      pose.scale = 1 - 0.04 * s * e
      pose.alpha = 1 - e
      break
    }
    case 'blur': {
      const e = EASE.emphAccel(q)
      pose.blur = 0.12 * em * s * e
      pose.alpha = 1 - e
      break
    }
  }
  return pose
}

const EXIT_DURATION: Record<ChunkExit, number> = { none: 0, fade: 0.12, rise: 0.18, shrink: 0.14, blur: 0.16 }

/** Two poses applied one after the other. */
function combine(a: ChunkPose, b: ChunkPose): ChunkPose {
  return { alpha: a.alpha * b.alpha, dx: a.dx + b.dx, dy: a.dy + b.dy, scale: a.scale * b.scale, scaleX: a.scaleX * b.scaleX, rotate: a.rotate + b.rotate, blur: Math.max(a.blur, b.blur), reveal: Math.min(a.reveal, b.reveal) }
}

/** How long chunks of one caption hand over in News Bar (a vertical push) and Glass Pill (the box width glides), §9.3. */
const PUSH = 0.2
const GLIDE = 0.16

/* ---------- word motion (§9.3) ---------- */

/** Seconds a word motion takes before the speed and the word's own length change it; and how early it starts. */
const WORD_TIMING: Record<Exclude<WordMotion, 'none' | 'typewriter' | 'wipe'>, { d: number; early: number }> = {
  pulse: { d: 0.18, early: 0 },
  pop: { d: 0.22, early: 0 },
  bounce: { d: 0.35, early: 0 },
  rise: { d: 0.25, early: 0 },
  slide: { d: 0.25, early: 0 },
  fade: { d: 0.18, early: 0 },
  blur: { d: 0.28, early: 0.08 },
  shake: { d: 0.3, early: 0 },
  grow: { d: 0.2, early: 0 }
}

const graphemer = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const graphemeCount = (text: string): number => (/^[\x20-\x7e]*$/.test(text) ? text.length : graphemer ? [...graphemer.segment(text)].length : Array.from(text).length)

interface WordCtx {
  /** Viewing seconds since the word's start (negative before it). */
  age: number
  /** The word's viewing length. */
  len: number
  em: number
  u: number
  s: number
  m: CaptionMotion
  /** Shown or dim before its start (an entrance), else a beat. */
  entrance: boolean
  upcoming: number
  dir: 'l' | 'r'
  seed: number
  graphemes: number
  calm: boolean
}

/** A word's motion pose (§9.3): position, scale, alpha, blur and reveal. */
function wordMotion(kind: WordMotion, c: WordCtx): Pick<WordPose, 'dx' | 'dy' | 'scale' | 'scaleX' | 'rotate' | 'alpha' | 'blur' | 'reveal'> {
  const pose = { dx: 0, dy: 0, scale: 1, scaleX: 1, rotate: 0, alpha: 1, blur: 0, reveal: 1 }
  const before = c.entrance ? c.upcoming : 1
  if (kind === 'none') {
    if (c.age < 0) pose.alpha = before
    return pose
  }
  const cap = (d: number): number => Math.min(duration(d, c.m, 0.06), Math.max(0.06, 0.6 * c.len))
  if (kind === 'typewriter') {
    const n = Math.max(1, c.graphemes)
    const d = Math.max(0.06, Math.min(c.len, (n * 0.045) / c.m.speed))
    const k = c.age < 0 ? 0 : Math.min(n, Math.floor(unit(c.age / d) * n + 1e-9))
    pose.reveal = c.entrance ? k / n : 1
    if (c.age < 0 && !c.entrance) pose.alpha = before
    return pose
  }
  if (kind === 'wipe') {
    const d = Math.max(0.06, Math.min(0.35, c.len) / c.m.speed)
    const p = unit((c.age + 0.06) / d)
    if (c.entrance) pose.reveal = wipeEase(p)
    else if (c.age < 0) pose.alpha = before
    return pose
  }
  const timing = WORD_TIMING[kind]
  const d = cap(timing.d)
  const a = c.age + timing.early
  if (a < 0) {
    // Not started: as it waits (hidden or dim words before an entrance).
    pose.alpha = before
    if (c.entrance && (kind === 'pop' || kind === 'grow')) pose.scale = kind === 'pop' ? 1 - 0.4 * c.s : 1 - 0.04 * c.s
    return pose
  }
  if (a >= d) return pose
  const p = a / d
  switch (kind) {
    case 'pulse': {
      // Up over 0.08 s of its 0.18 s, back over the rest.
      const up = 0.08 / 0.18
      const peak = 0.08 * c.s
      pose.scale = p < up ? 1 + peak * EASE.out(p / up) : 1 + peak * (1 - EASE.out((p - up) / (1 - up)))
      break
    }
    case 'pop': {
      const e = c.calm ? EASE.out(p) : back(p, 1.7 * c.s)
      pose.scale = lerp(c.entrance ? 1 - 0.4 * c.s : 1 - 0.1 * c.s, 1, e)
      if (c.entrance) pose.alpha = lerp(before, 1, Math.min(1, 3 * p))
      break
    }
    case 'bounce':
      pose.dy = -0.035 * c.u * c.s * (1 - (c.calm ? EASE.out(p) : spring(p)))
      break
    case 'rise': {
      const e = EASE.emphDecel(p)
      pose.dy = (1 - e) * 0.3 * c.em * c.s
      if (c.entrance) pose.alpha = lerp(before, 1, e)
      break
    }
    case 'slide': {
      const e = EASE.emphDecel(p)
      pose.dx = (c.dir === 'r' ? 1 : -1) * (1 - e) * 0.5 * c.em * c.s
      if (c.entrance) pose.alpha = lerp(before, 1, e)
      break
    }
    case 'fade':
      pose.alpha = lerp(before, 1, EASE.out(p))
      break
    case 'blur': {
      const e = EASE.emphDecel(p)
      pose.blur = (1 - e) * 0.22 * c.em * c.s
      pose.dy = (1 - e) * 0.1 * c.em * c.s
      if (c.entrance) pose.alpha = lerp(before, 1, e)
      break
    }
    case 'shake': {
      const f1 = ((c.seed & 0xffff) / 0x10000) * 2 * Math.PI
      const f2 = ((c.seed >>> 16) / 0x10000) * 2 * Math.PI
      pose.dx = 0.012 * c.u * c.s * (1 - p) * (0.6 * Math.sin(2 * Math.PI * 5 * a + f1) + 0.4 * Math.sin(2 * Math.PI * 7 * a + f2))
      break
    }
    case 'grow': {
      const e = EASE.emphDecel(p)
      pose.scale = 1 - 0.04 * c.s * (1 - e)
      if (c.entrance) pose.alpha = lerp(before, 1, e)
      break
    }
  }
  return pose
}

/** How an emphasis mark draws in (§5.3, §0.1): from 0.06 s before the word, over this long. */
const MARK_DRAW: Record<string, number> = { marker: 0.22, underline: 0.22, box: 0.15, circle: 0.3 }

/* ---------- the spoken mark (§9.3, §9.6) ---------- */

/** The flash rule's dwell of a big mark (§9.6 rule 1). */
const DWELL = 0.34

/** Words of a chunk grouped so a big mark stays on each group for at least 0.34 s of viewing time; one word each otherwise. */
function markGroups(layout: StudioLayout, chunk: StudioChunk, starts: Float64Array, dwell: boolean): { first: number; last: number }[] {
  const lineOf = new Map<number, number>()
  chunk.lines.forEach((l, i) => l.words.forEach((w) => lineOf.set(w.token, i)))
  const groups: { first: number; last: number }[] = []
  for (let i = chunk.first; i <= chunk.last; i++) {
    if (layout.tokens[i].label) continue
    const g = groups[groups.length - 1]
    if (dwell && g && starts[i] - starts[g.first] < DWELL && lineOf.get(i) === lineOf.get(g.first)) g.last = i
    else groups.push({ first: i, last: i })
  }
  return groups
}

/** Per chunk (and clips and dwell): its mark groups and each word's size and place in its line, made once. */
const chunkCache = new WeakMap<StudioChunk, { clips: readonly Clip[]; dwell: boolean; groups: { first: number; last: number }[]; wordBox: Map<number, { px: number; place: number }> }>()

function chunkInfo(layout: StudioLayout, chunk: StudioChunk, clips: readonly Clip[], starts: Float64Array, dwell: boolean): { groups: { first: number; last: number }[]; wordBox: Map<number, { px: number; place: number }> } {
  const hit = chunkCache.get(chunk)
  if (hit && hit.clips === clips && hit.dwell === dwell) return hit
  const wordBox = new Map<number, { px: number; place: number }>()
  chunk.lines.forEach((l) => l.words.forEach((w, k) => wordBox.set(w.token, { px: w.px, place: k })))
  const info = { clips, dwell, groups: markGroups(layout, chunk, starts, dwell), wordBox }
  chunkCache.set(chunk, info)
  return info
}

/** The box of words first..last on their line (x and width in the line's coordinates). */
function spanOf(chunk: StudioChunk, first: number, last: number): { x: number; w: number; line: number } | null {
  for (let li = 0; li < chunk.lines.length; li++) {
    const ws = chunk.lines[li].words.filter((w) => w.token >= first && w.token <= last)
    if (!ws.length) continue
    const x = Math.min(...ws.map((w) => w.x))
    return { x, w: Math.max(...ws.map((w) => w.x + w.w)) - x, line: li }
  }
  return null
}

/**
 * The poses of chunk `chunk` at source time `t` (§9.3): the chunk's entrance or exit (exits only
 * before a pause of CAPTION_JOIN or more until `nextStart`, the next caption's start; null: none
 * follows), each word's motion, spoken mark and emphasis mark, and the spoken box, pill or
 * underline. During News Bar's push and Glass Pill's glide (the first 0.2 s of a chunk after the
 * first) the outgoing chunk comes with its pose. On Glass Pill's chunks after the first, `box` is
 * the pose of the pills: the chunk's without its entrance, so they never fade out and in between
 * chunks (§5.3). `opts.spoken` false (a translated track): no spoken mark, no word motion and
 * every word shown.
 */
export function captionPoses(
  layout: StudioLayout,
  chunk: number,
  t: number,
  clips: Clip[],
  studio: CaptionStudio,
  u: number,
  nextStart: number | null,
  opts?: { spoken: boolean }
): { chunk: ChunkPose; words: WordPose[]; mark: MarkBox | null; out?: { chunk: number; pose: ChunkPose }; box?: ChunkPose } {
  const ch = layout.chunks[chunk]
  if (!ch) return { chunk: rest(), words: [], mark: null }
  const m = studio.motion.calm ? calmedOf(studio.motion) : studio.motion
  const calm = !!m.calm
  const s = m.strength
  const em = layout.px
  const v = viewTimes(layout, clips)
  const now = viewAt(clips, t)
  const key = captionKey(layout)
  const spoken = opts?.spoken !== false
  const rtl = layout.rtl
  const handOver = chunk > 0 && (studio.box.kind === 'band' || studio.box.kind === 'glass')

  /* the chunk */
  const age = now - v.chunkStarts[chunk]
  const length = v.chunkEnds[chunk] - v.chunkStarts[chunk]
  let pose = rest()
  let out: { chunk: number; pose: ChunkPose } | undefined
  const glide = handOver && studio.box.kind === 'glass'
  if (handOver && studio.box.kind === 'band') {
    // News Bar: the new chunk rises in while the old one is pushed up and out; the band stays.
    const d = duration(PUSH, m, 0.1)
    if (age < d) {
      const e = EASE.emphDecel(age / d)
      const lift = layout.lineHeight * s
      pose = { ...rest(), dy: (1 - e) * lift, alpha: e }
      out = { chunk: chunk - 1, pose: { ...rest(), dy: -e * lift, alpha: 1 - e } }
    }
  } else {
    const d = duration(enterDuration(m.enter, chunk), m, 0.1)
    if (m.enter !== 'none' && age < d) pose = enterPose(m.enter, Math.max(0, age) / d, s, em, chunk, rtl, calm)
    if (glide) {
      // Glass Pill: the box width glides from the old chunk's to this one's (`out.pose.reveal`, the
      // share of the old width); the old words are not drawn.
      const g = duration(GLIDE, m, 0.1)
      if (age < g) out = { chunk: chunk - 1, pose: { ...rest(), alpha: 0, reveal: 1 - EASE.emphDecel(age / g) } }
    }
  }
  // An exit only before a pause: on the caption's last chunk, when the next caption starts CAPTION_JOIN or more later.
  const last = chunk === layout.chunks.length - 1
  let exit: ChunkPose | null = null
  if (last && m.exit !== 'none' && (nextStart === null || viewAt(clips, nextStart) - v.chunkEnds[chunk] >= CAPTION_JOIN)) {
    const d = Math.min(duration(EXIT_DURATION[m.exit], m, 0.1), length / 3)
    const left = v.chunkEnds[chunk] - now
    if (d > 0 && left < d) exit = exitPose(m.exit, 1 - Math.max(0, left) / d, s, em)
  }
  const finish = (p: ChunkPose): ChunkPose => {
    let q = exit ? combine(p, exit) : p
    // Tilt on chunks: a seeded angle, the same for the chunk's whole time.
    if (m.tilt > 0 && m.tiltOn === 'chunk') q = { ...q, rotate: q.rotate + signed(seedOf(`${key}|c${chunk}`)) * m.tilt * s }
    return calm ? calmPose(q, u) : q
  }
  pose = finish(pose)
  // Glass Pill's pills: the chunk's pose without its entrance.
  const boxPose = glide ? finish(rest()) : undefined

  /* the words */
  const spokenAt = (() => {
    if (!spoken) return -1
    let k = -1
    for (let i = ch.first; i <= ch.last; i++) {
      if (layout.tokens[i].label) continue
      if (layout.tokens[i].start <= t) k = i
      else break
    }
    return k
  })()
  const bigMark = !!layout.bigMark && (studio.spoken === 'box' || studio.spoken === 'pill' || studio.spoken === 'underline' || studio.spoken === 'glow')
  const { groups, wordBox } = chunkInfo(layout, ch, clips, v.starts, bigMark)
  const groupOf = (i: number): { first: number; last: number } | undefined => groups.find((g) => i >= g.first && i <= g.last)
  const spokenGroup = spokenAt >= 0 ? groupOf(spokenAt) : undefined
  const words: WordPose[] = []
  for (let i = ch.first; i <= ch.last; i++) {
    const tok = layout.tokens[i]
    const pose: WordPose = { token: i, dx: 0, dy: 0, scale: 1, scaleX: 1, rotate: 0, alpha: 1, blur: 0, reveal: 1, fill: 0, weight: 0, mark: 0 }
    // Speaker labels take the chunk's pose only.
    if (tok.label) {
      words.push(pose)
      continue
    }
    const box = wordBox.get(i)
    const wem = box?.px ?? em
    const emph = layout.emphasis[i] ?? 0
    const ageW = now - v.starts[i]
    const lenW = Math.max(0, v.ends[i] - v.starts[i])
    if (spoken) {
      // Estimated words move gently (§9.1 rule 7).
      const wm = tok.estimated && !calm ? calmedOf(m) : m
      const kind = emph ? wm.emphasis : wm.word
      const ctx: WordCtx = { age: ageW, len: lenW, em: wem, u, s, m: wm, entrance: m.upcoming < 1, upcoming: m.upcoming, dir: layout.dirs[i] ?? 'l', seed: kind === 'shake' ? seedOf(`${key}|${i}`) : 0, graphemes: kind === 'typewriter' ? graphemeCount(tok.text) : 0, calm: calm || !!tok.estimated }
      Object.assign(pose, wordMotion(kind, ctx))
      /* the spoken mark */
      const isSpoken = spokenAt === i || (!!spokenGroup && i >= spokenGroup.first && i <= spokenGroup.last && bigMark)
      const past = spokenAt >= 0 && i < spokenAt
      const inMark = duration(0.06, m, 0.06)
      const fromStart = (d: number): number => unit(ageW / d)
      switch (studio.spoken) {
        case 'color':
        case 'glow': {
          if (isSpoken) {
            const group = bigMark && spokenGroup ? spokenGroup : { first: i, last: i }
            pose.fill = unit((now - v.starts[group.first]) / inMark)
          } else if (past) {
            // Back over 0.06 s once the next word (or group) starts.
            const after = groupOf(i)
            const next = after && after.last + 1 <= ch.last ? v.starts[after.last + 1] : Infinity
            pose.fill = 1 - unit((now - next) / inMark)
          }
          break
        }
        case 'fill':
        case 'gradient': {
          // The sweep over the word in its reading direction (estimated words: a whole-word change); spoken
          // words stay filled, and so do emphasised ones under the fill.
          const sweep = tok.estimated ? inMark : studio.spoken === 'fill' ? Math.min(1.5, Math.max(lenW, 0.12)) : Math.max(lenW, 0.2)
          if (emph && studio.spoken === 'fill') pose.fill = 1
          else pose.fill = ageW < 0 ? 0 : past ? 1 : fromStart(sweep)
          if (studio.spoken === 'gradient' && ageW >= 0 && !calm) {
            // Scale 1.04 while swept, settling to 1 over 0.15 s after the word.
            const settle = unit((ageW - lenW) / duration(0.15, m, 0.06))
            pose.scale *= 1 + 0.04 * s * (1 - settle)
          }
          break
        }
        case 'weight': {
          const d = duration(0.1, m, 0.06)
          pose.weight = ageW < 0 ? 0 : unit(ageW / d)
          pose.fill = pose.weight
          break
        }
        case 'box':
        case 'pill':
        case 'underline':
          pose.fill = isSpoken ? 1 : 0
          break
      }
      /* growing while spoken (Bold Pop, Stickers, Spotlight Word; ×1.14 at most in Bangla; by strength,
         none at 0; estimated words keep their size) */
      const grow = calm ? 0 : (scriptScale(tok.script, wm.spokenScale ?? 1) - 1) * s
      if (grow > 0) {
        const up = duration(0.2, m, 0.06)
        const down = duration(0.1, m, 0.06)
        if (spokenAt === i) pose.scale *= 1 + grow * (ageW < 0 ? 0 : back(unit(ageW / up), 1.7 * s))
        else if (past) {
          const next = i + 1 <= ch.last ? v.starts[i + 1] : Infinity
          pose.scale *= 1 + grow * (1 - EASE.out((now - next) / down))
        }
      }
      /* Bold Pop's spoken word tilts (-2°) while spoken; not in Bangla, as the approved Bangla pop */
      if (!calm && s > 0 && wm.spokenTilt && spokenAt === i && tok.script !== 'bengali') pose.rotate += wm.spokenTilt * s
    }
    /* emphasis marks draw with the wipe timing */
    if (emph && studio.emphasis.mark !== 'none') {
      const d = Math.max(0.06, (MARK_DRAW[studio.emphasis.mark] ?? 0.22) / m.speed)
      pose.mark = spoken ? wipeEase(unit((ageW + 0.06) / d)) : 1
    }
    /* tilt: Stickers' fixed tilt by the word's place in its chunk, and a seeded tilt on emphasised words */
    if (!calm && m.wordTilt) pose.rotate += ((box?.place ?? 0) % 2 === 0 ? m.wordTilt[0] : m.wordTilt[1]) * s
    if (!calm && emph && m.tilt > 0 && m.tiltOn === 'emphasis') pose.rotate += signed(seedOf(`${key}|${i}`)) * m.tilt * s
    words.push(calm ? calmPose(pose, u) : pose)
  }

  /* the spoken box, pill or underline */
  let mark: MarkBox | null = null
  if (spoken && spokenAt >= 0 && (studio.spoken === 'box' || studio.spoken === 'pill' || studio.spoken === 'underline')) {
    const group = spokenGroup ?? { first: spokenAt, last: spokenAt }
    const here = spanOf(ch, group.first, group.last)
    if (here) {
      const gi = groups.indexOf(group as { first: number; last: number })
      const prev = gi > 0 ? groups[gi - 1] : undefined
      const there = prev ? spanOf(ch, prev.first, prev.last) : null
      const since = now - v.starts[group.first]
      let x = here.x
      let w = here.w
      if (there && there.line === here.line) {
        // Glides from the previous word on the same line.
        const e = EASE.emphDecel(since / duration(0.12, m, 0.06))
        x = lerp(there.x, here.x, e)
        w = lerp(there.w, here.w, e)
      } else if (!there) {
        // The chunk's first word: grows from its leading edge (an underline from zero width).
        const d = duration(studio.spoken === 'underline' ? 0.16 : 0.15, m, 0.06)
        const k = EASE.out(since / d)
        const lead = layout.dirs[group.first] === 'r'
        w = here.w * k
        x = lead ? here.x + here.w - w : here.x
      }
      mark = { x, w, line: here.line, alpha: 1, first: group.first, last: group.last }
    }
  }
  return { chunk: pose, words, mark, ...(out ? { out } : {}), ...(boxPose ? { box: boxPose } : {}) }
}

/* ---------- Typewriter's caret (§5.3) ---------- */

/**
 * Typewriter's caret (§5.3): after the last shown letter while letters appear, then blinking 0.53 s
 * on and 0.53 s off (0.94 Hz) until the chunk ends; the token it follows, or null before the first.
 */
export function caretAt(layout: StudioLayout, chunk: number, t: number, clips: Clip[]): { token: number; on: boolean } | null {
  const ch = layout.chunks[chunk]
  if (!ch) return null
  const v = viewTimes(layout, clips)
  const now = viewAt(clips, t)
  let token = -1
  for (let i = ch.first; i <= ch.last; i++) if (!layout.tokens[i].label && v.starts[i] <= now) token = i
  if (token < 0) return null
  const n = Math.max(1, graphemeCount(layout.tokens[token].text))
  const typed = v.starts[token] + Math.min(Math.max(0, v.ends[token] - v.starts[token]), n * 0.045)
  if (now < typed || token < ch.last) return { token, on: true }
  return { token, on: Math.floor((now - typed) / 0.53) % 2 === 0 }
}

/* ---------- the circle of the Circle look (§0.1) ---------- */

/** The mock-up's hand-drawn ellipse in a 100 × 40 box: a start point and three cubic curves. */
const CIRCLE = [8, 22, 10, 6, 88, 2, 94, 18, 98, 34, 20, 40, 6, 26, 2, 18, 30, 6, 60, 8]

/**
 * The hand-drawn ellipse around an emphasised word (§0.1 Circle): the mock-up's path stretched
 * over the word's box widened by 0.57 em on each side and 0.36 em above and below, each point
 * moved a little by a seed of the word's index, so every word has its own fixed path (never
 * random). `points`: the start x, y, then x1, y1, x2, y2, x, y of each of three cubic curves;
 * `width`: the stroke, px. WordPose.mark says how much of it is drawn.
 */
export function circlePath(box: { x: number; y: number; w: number; h: number }, word: number, em: number): { points: number[]; width: number } {
  const x0 = box.x - 0.57 * em
  const y0 = box.y - 0.36 * em
  const w = box.w + 1.14 * em
  const h = box.h + 0.72 * em
  const seed = seedOf(`circle|${word}`)
  const points = CIRCLE.map((v, k) => {
    const jitter = (((seed >>> k % 24) & 0xff) / 255 - 0.5) * 4
    return k % 2 === 0 ? x0 + ((v + jitter) / 100) * w : y0 + ((v + jitter * 0.6) / 40) * h
  })
  return { points, width: 0.1 * em }
}

/* ---------- graphics and cards (§10.1) ---------- */

/** Seconds of viewing time an item motion takes (its own duration; calm: at least 0.2 s). */
const itemDuration = (m: ItemMotion, calm: boolean): number => (calm ? Math.max(0.2, m.duration) : m.duration)

const CALM_ITEM: Partial<Record<ItemMotionKind, ItemMotionKind>> = { pop: 'grow', drop: 'grow', blur: 'fade' }

/** An item motion's pose at eased progress e (0: start, 1: at rest) and raw progress p. */
function itemMotionPose(kind: ItemMotionKind, e: number, p: number, s: number, em: number, overshoot: boolean): ChunkPose {
  const pose = rest()
  switch (kind) {
    case 'fade':
      pose.alpha = e
      break
    case 'pop':
      pose.scale = lerp(1 - 0.4 * s, 1, overshoot ? back(p, 1.7 * s) : e)
      pose.alpha = Math.min(1, 3 * p)
      break
    case 'rise':
      pose.dy = (1 - e) * 0.4 * em * s
      pose.alpha = e
      break
    case 'drop':
      pose.dy = -(1 - (overshoot ? back(p, 1.7 * s) : e)) * 0.6 * em * s
      pose.alpha = Math.min(1, 3 * p)
      break
    case 'slide-left':
    case 'slide-right':
      pose.dx = (kind === 'slide-left' ? 1 : -1) * (1 - e) * 1.2 * em * s
      pose.alpha = e
      break
    case 'grow':
      pose.scale = 1 - 0.04 * s * (1 - e)
      pose.alpha = e
      break
    case 'blur':
      pose.blur = (1 - e) * 0.12 * em * s
      pose.alpha = e
      break
    case 'typewriter':
      pose.reveal = e
      break
  }
  return pose
}

/**
 * A graphic's or card's pose at source time `t`, or null while it is not shown (§10.1): its
 * entrance from `start`, its exit (the kind played backwards with inCubic) before `end`, each at
 * most half the item, in viewing time. `u` is the item's em, px (its size times the frame's
 * shorter side): rise, drop, slide and blur move by fractions of it. `calm`: Calm motion's clamps.
 */
export function itemPose(start: number, end: number, t: number, clips: Clip[], enter: ItemMotion, exit: ItemMotion, u: number, calm: boolean): ChunkPose | null {
  if (!(t >= start && t < end)) return null
  const from = viewAt(clips, start)
  const to = viewAt(clips, end)
  const now = viewAt(clips, t)
  const half = Math.max(0, (to - from) / 2)
  const inKind = calm ? (CALM_ITEM[enter.kind] ?? enter.kind) : enter.kind
  const outKind = calm ? (CALM_ITEM[exit.kind] ?? exit.kind) : exit.kind
  const dIn = Math.min(itemDuration(enter, calm), half)
  const dOut = Math.min(itemDuration(exit, calm), half)
  let pose = rest()
  if (inKind !== 'none' && dIn > 0 && now - from < dIn) {
    const p = unit((now - from) / dIn)
    const e = inKind === 'fade' || inKind === 'typewriter' ? EASE.out(p) : inKind === 'slide-left' || inKind === 'slide-right' ? EASE.outExpo(p) : inKind === 'rise' || inKind === 'grow' || inKind === 'blur' ? EASE.emphDecel(p) : EASE.out(p)
    pose = itemMotionPose(inKind, e, p, enter.strength, u, !calm)
  } else if (outKind !== 'none' && dOut > 0 && to - now < dOut) {
    const q = unit(1 - (to - now) / dOut)
    const e = 1 - EASE.inCubic(q)
    pose = itemMotionPose(outKind, e, e, exit.strength, u, false)
  }
  if (!calm) return pose
  // Calm motion: scale within 0.96–1.04, movement at most 0.15 em (0.015 u at a graphic's usual 0.1 u), no blur.
  const move = 0.15 * u
  return { ...pose, dx: clamp(pose.dx, -move, move), dy: clamp(pose.dy, -move, move), scale: clamp(pose.scale, 0.96, 1.04), scaleX: clamp(pose.scaleX, 0.96, 1.04), rotate: 0, blur: 0 }
}

/** The seeded bob of an emoji while shown (§10.1): ±0.04 em at 0.8 Hz, off with calm motion or strength 0; dy in px. */
export function emojiBob(id: string, start: number, t: number, clips: Clip[], em: number, strength: number, calm: boolean): number {
  if (calm || strength <= 0) return 0
  const age = viewAt(clips, t) - viewAt(clips, start)
  const phase = (seedOf(`bob|${id}`) / 0xffffffff) * 2 * Math.PI
  return 0.04 * em * strength * Math.sin(2 * Math.PI * 0.8 * age + phase)
}

/** The number a counter shows at `t` (§10.1): from `from` to `to` over `countFor` viewing seconds with the out easing, then held. */
export function counterValue(g: CounterGraphic, t: number, clips: Clip[]): number {
  const age = viewAt(clips, t) - viewAt(clips, g.start)
  if (!(age > 0)) return g.from
  const p = g.countFor > 0 ? unit(age / g.countFor) : 1
  return p >= 1 ? g.to : g.from + (g.to - g.from) * EASE.out(p)
}

/** Seconds without a new item before a list card fades out, and how early it comes back before the next (§10.1). */
const LIST_IDLE = 6
const LIST_BACK = 0.3

/**
 * When a list card shows (§10.1), in source seconds: from its start; when no item has appeared
 * for 6 s of viewing time it hides, and it comes back 0.3 s before the next item; the last window
 * ends with the card (or 6 s after its last item). A pure function of the items.
 */
export function listWindows(g: ListGraphic, clips: Clip[]): { start: number; end: number }[] {
  const V = (x: number): number => viewAt(clips, x)
  const source = (o: number): number => (clips.length ? outputToSource(clips, o).time : o)
  const ats = g.items.map((i) => i.at).filter((a) => a >= g.start && a < g.end).sort((a, b) => a - b)
  const out: { start: number; end: number }[] = []
  let open = g.start
  let lastSeen = g.start
  for (const at of ats) {
    if (V(at) - V(lastSeen) > LIST_IDLE) {
      const close = source(V(lastSeen) + LIST_IDLE)
      if (close > open) out.push({ start: open, end: close })
      open = Math.max(close, source(Math.max(0, V(at) - LIST_BACK)))
    }
    lastSeen = Math.max(lastSeen, at)
  }
  const end = V(g.end) - V(lastSeen) > LIST_IDLE ? source(V(lastSeen) + LIST_IDLE) : g.end
  if (end > open) out.push({ start: open, end: Math.min(end, g.end) })
  return out
}

/* ---------- the flash rule (§9.6) ---------- */

/** Share of the frame above which a chunk or a mark is big (§9.6). */
const BIG = 0.025
/** Fewest viewing seconds a big chunk shows (§9.6 rule 2). */
const MIN_BIG = 0.34

/**
 * The layout with chunks merged so big changes stay at 3 a second or fewer (the flash rule, §9.6):
 * a chunk whose block covers more than 2.5% of the frame and shows for less than 0.34 s of viewing
 * time is merged with the next one (the last with the one before), and `bigMark` is set when a
 * spoken box or pill around the widest word would cover more than 2.5% of the frame, so the mark
 * dwells. Each merged chunk goes through `fit` (studioLayout's fitChunk), which draws it smaller
 * when its stacked lines would run past the frame. The layout itself when nothing changes.
 */
export function flashSafeChunks(layout: StudioLayout, clips: Clip[], frameArea: number, boxArea: (chunk: number) => number, fit?: (chunk: StudioChunk) => StudioChunk): StudioLayout {
  const limit = BIG * frameArea
  let chunks = layout.chunks
  const big = chunks.map((_, i) => boxArea(i) > limit)
  let merged = false
  const V = (x: number): number => viewAt(clips, x)
  const join = (a: StudioChunk, b: StudioChunk): StudioChunk => ({
    start: a.start,
    end: b.end,
    lines: [...a.lines, ...b.lines],
    first: a.first,
    last: b.last,
    width: Math.max(a.width, b.width),
    height: a.height + b.height
  })
  const out: StudioChunk[] = []
  const bigOut: boolean[] = []
  for (let i = 0; i < chunks.length; i++) {
    let c = chunks[i]
    let isBig = big[i]
    while (isBig && V(c.end) - V(c.start) < MIN_BIG - 1e-9 && i + 1 < chunks.length) {
      c = join(c, chunks[++i])
      isBig = true
      merged = true
    }
    out.push(c)
    bigOut.push(isBig)
  }
  // A last big chunk still too short goes with the one before it.
  while (out.length > 1 && bigOut[out.length - 1] && V(out[out.length - 1].end) - V(out[out.length - 1].start) < MIN_BIG - 1e-9) {
    const b = out.pop()!
    bigOut.pop()
    out[out.length - 1] = join(out[out.length - 1], b)
    merged = true
  }
  if (merged) {
    const own = new Set(layout.chunks)
    chunks = fit ? out.map((c) => (own.has(c) ? c : fit(c))) : out
  }
  // The spoken mark around the widest word: its box with the padding of §5.1 (0.15 / 0.09 em) around a 1 em glyph box.
  let widest = 0
  for (const c of layout.chunks) for (const l of c.lines) for (const w of l.words) widest = Math.max(widest, (w.w + 0.3 * w.px) * 1.18 * w.px)
  const bigMark = widest > limit
  if (!merged && bigMark === !!layout.bigMark) return layout
  const { bigMark: _old, ...rest } = layout
  void _old
  return { ...rest, chunks, ...(bigMark ? { bigMark: true as const } : {}) }
}

/* ---------- typewriter (§9.3) ---------- */

/**
 * The typewriter clip of a word after k graphemes (§9.3), px from its reading start: the measured
 * advance of its first k graphemes where a prefix draws as in the word (`prefixAdvances[k - 1]`),
 * else k / n of its width (Arabic, Hebrew, Thai and the Indic scripts).
 */
export function typewriterClip(word: { graphemes: number; prefixAdvances?: readonly number[]; width: number }, k: number): number {
  const n = Math.max(0, Math.floor(word.graphemes))
  const kk = clamp(Math.floor(k), 0, n)
  if (kk === 0 || n === 0) return 0
  if (kk === n) return word.width
  const adv = word.prefixAdvances
  if (adv && adv.length >= kk && Number.isFinite(adv[kk - 1])) return clamp(adv[kk - 1], 0, word.width)
  return (word.width * kk) / n
}
