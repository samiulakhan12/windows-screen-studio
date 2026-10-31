/**
 * Colours of Captions Studio (docs/design/captions-studio.md §7): contrast, themes, the brand
 * theme, the contrast fix and speaker colours. Pure.
 */
import type { CaptionStudio, StudioTheme } from '../types'
import { SPEAKER_PALETTE } from './studioPresets'

const WHITE = '#ffffff'
const BLACK = '#000000'
const DARK = '#111111'
/** The ratio every built-in look reaches (§7.2), and what Fix aims for. */
export const CONTRAST_MIN = 4.5

/* ---------- WCAG ---------- */

const HEX6 = /^#?[0-9a-f]{6}$/i

function rgb(color: string): [number, number, number] {
  const h = HEX6.test(color) ? color.replace('#', '') : '000000'
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

const hex = (c: readonly number[]): string => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

const linear = (v: number): number => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const ratioOfLum = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/** The WCAG contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  return ratioOfLum(luminance(a), luminance(b))
}

/** `color` at `alpha` over `under`, as #rrggbb. */
export function over(color: string, alpha: number, under: string): string {
  const a = Math.min(1, Math.max(0, alpha))
  const c = rgb(color)
  const u = rgb(under)
  return hex(c.map((v, i) => v * a + u[i] * (1 - a)))
}

/** `color` mixed with `toward` by `share` (0..1). */
const mix = (color: string, toward: string, share: number): string => over(toward, share, color)

/** Text on `background`: whichever of #111111 and #ffffff contrasts more. */
export function textOn(background: string): '#111111' | '#ffffff' {
  return contrastRatio(DARK, background) >= contrastRatio(WHITE, background) ? DARK : WHITE
}

/* ---------- the static rule (§7.2) ---------- */

/** What draws a text colour: a field of the theme, a stop of a gradient, or the opacity of words not yet spoken. */
type Source = keyof StudioTheme | 'upcoming-alpha' | `fill:${number}` | `gradient:${number}`

interface Pair {
  fg: string
  bg: string
  /** What gives `fg` (what Fix may change). */
  source: Source
}

/** The surround of the look's words over any video (§7.2 rules 1–3), and whether a box or outline gives it. */
function surroundOf(s: CaptionStudio): { colours: string[]; given: boolean } {
  const t = s.theme
  const both = (c: string, alpha: number): string[] => [over(c, alpha, WHITE), over(c, alpha, BLACK)]
  // Rule 1: a box (glass counts as its tint alone).
  if (s.box.kind !== 'none') return { colours: both(t.box, s.box.alpha), given: true }
  // Rule 2: an outline of at least 0.04 em.
  if (s.edge.outline >= 0.04) return { colours: both(t.outline, s.edge.outlineAlpha), given: true }
  // Rule 3: the video itself.
  return { colours: [WHITE, BLACK], given: false }
}

/** Every text colour that can be drawn, against its surround (§7.2). */
function contrastPairs(s: CaptionStudio): Pair[] {
  const t = s.theme
  const around = surroundOf(s).colours
  const pairs: Pair[] = []
  const onSurround = (fg: string, source: Source, alpha = 1): void => {
    for (const bg of around) pairs.push({ fg: alpha < 1 ? over(fg, alpha, bg) : fg, bg, source })
  }
  const onBox = (text: string | undefined, box: string, source: Source): void => void pairs.push({ fg: text ?? textOn(box), bg: box, source })
  // Words: their colour, or every stop of a gradient fill.
  if (t.fill) t.fill.stops.forEach((c, i) => onSurround(c, `fill:${i}`))
  else onSurround(t.text, 'text')
  // Words not yet spoken at their opacity, in their own colour when they have one.
  const up = s.motion.upcoming
  if (up > 0 && up < 1) {
    if (t.upcoming) onSurround(t.upcoming, 'upcoming-alpha', up)
    else for (const c of t.fill ? t.fill.stops : [t.text]) onSurround(c, 'upcoming-alpha', up)
  } else if (t.upcoming && up > 0) onSurround(t.upcoming, 'upcoming')
  // Hollow words: their stroke against the dark halo (black at α 0.6 over white).
  if (s.edge.hollow) pairs.push({ fg: t.text, bg: over(BLACK, 0.6, WHITE), source: 'text' })
  // The spoken word.
  if (s.spoken === 'color' || s.spoken === 'glow' || s.spoken === 'weight' || s.spoken === 'fill') onSurround(t.spoken, 'spoken')
  if (s.spoken === 'box' || s.spoken === 'pill') onBox(t.spokenText, t.spoken, 'spokenText')
  if (s.spoken === 'gradient') (t.gradient ?? []).forEach((c, i) => onSurround(c, `gradient:${i}`))
  // Emphasis, in both tones.
  for (const field of ['emphasis', 'emphasis2'] as const) {
    const colour = t[field]
    if (!colour) continue
    if (s.emphasis.mark === 'marker' || s.emphasis.mark === 'box') onBox(t.emphasisText, colour, 'emphasisText')
    // The circle goes around words in emphasisText (else the words' colour).
    else if (s.emphasis.mark === 'circle') onSurround(t.emphasisText ?? t.text, t.emphasisText ? 'emphasisText' : 'text')
    else onSurround(colour, field)
  }
  // Chat: the bubbles of "You".
  if (s.box.kind === 'chat' && t.youBox) for (const bg of [over(t.youBox, s.box.alpha, WHITE), over(t.youBox, s.box.alpha, BLACK)]) pairs.push({ fg: t.youText ?? t.text, bg, source: t.youText ? 'youText' : 'text' })
  return pairs
}

/** The worst contrast of the look's text against its surround over any video (§7.2): the ratio, that text colour and what it is drawn on. */
export function staticContrast(studio: CaptionStudio): { worst: number; colour: string; against: string } {
  let worst = Infinity
  let colour = studio.theme.text
  let against = WHITE
  for (const p of contrastPairs(studio)) {
    const r = contrastRatio(p.fg, p.bg)
    if (r < worst) {
      worst = r
      colour = p.fg
      against = p.bg
    }
  }
  return { worst: Number.isFinite(worst) ? worst : 21, colour, against }
}

/**
 * Whether the static figure holds over any video (§7.3): a box of alpha 0.6 or more, or an outline
 * of 0.04 em or more at alpha 0.8 or more. Otherwise the meter measures the video.
 */
export function dependableSurround(studio: CaptionStudio): boolean {
  if (studio.box.kind !== 'none') return studio.box.alpha >= 0.6
  return studio.edge.outline >= 0.04 && studio.edge.outlineAlpha >= 0.8
}

/**
 * The 10th percentile contrast of the text colour against the pixels under the caption (§7.3):
 * `pixels` is RGBA, as getImageData gives it; fully transparent pixels are left out.
 */
export function measuredContrast(studio: CaptionStudio, pixels: Uint8ClampedArray): number {
  const text = luminance(studio.theme.text)
  const ratios: number[] = []
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue
    const l = 0.2126 * linear(pixels[i]) + 0.7152 * linear(pixels[i + 1]) + 0.0722 * linear(pixels[i + 2])
    ratios.push(ratioOfLum(text, l))
  }
  if (!ratios.length) return staticContrast(studio).worst
  ratios.sort((a, b) => a - b)
  return ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.1))]
}

/* ---------- Fix (§7.3) ---------- */

/** The theme with what `source` names set to `colour`. */
function setColour(theme: StudioTheme, source: Source, colour: string): StudioTheme {
  if (source.startsWith('fill:') && theme.fill) {
    const i = Number(source.slice(5))
    return { ...theme, fill: { ...theme.fill, stops: theme.fill.stops.map((c, k) => (k === i ? colour : c)) } }
  }
  if (source.startsWith('gradient:') && theme.gradient) {
    const i = Number(source.slice(9))
    return { ...theme, gradient: theme.gradient.map((c, k) => (k === i ? colour : c)) }
  }
  if (source === 'upcoming-alpha') return theme
  return { ...theme, [source]: colour }
}

/** The colour `source` names (the text on a box worked out by contrast when the theme has none). */
function colourOf(theme: StudioTheme, source: Source, bg: string): string {
  if (source.startsWith('fill:')) return theme.fill?.stops[Number(source.slice(5))] ?? theme.text
  if (source.startsWith('gradient:')) return theme.gradient?.[Number(source.slice(9))] ?? theme.spoken
  const v = theme[source as keyof StudioTheme]
  return typeof v === 'string' ? v : textOn(bg)
}

const worstOf = (s: CaptionStudio): number => staticContrast(s).worst

/**
 * The look with its outline or box strengthened (§7.3 Fix): no outline → 0.06 em at α 0.85; a weak
 * outline → α 1 and at least 0.05 em; a box → alpha + 0.15 (at most 0.9). When that is not enough
 * (a colour the user picked is close to its surround), the surround takes the better of dark and
 * white, words not yet spoken get more opacity, and last each failing colour moves toward what
 * its background wants, until every colour reaches 4.5:1.
 */
export function contrastFix(studio: CaptionStudio): CaptionStudio {
  let s: CaptionStudio = structuredClone(studio)
  if (s.box.kind !== 'none') s.box = { ...s.box, alpha: Math.max(s.box.alpha, Math.min(0.9, s.box.alpha + 0.15)) }
  else if (s.edge.outline < 0.04 || s.edge.outlineAlpha <= 0) s.edge = { ...s.edge, outline: Math.max(s.edge.outline, 0.06), outlineAlpha: 0.85 }
  else s.edge = { ...s.edge, outline: Math.max(s.edge.outline, 0.05), outlineAlpha: 1 }
  if (worstOf(s) >= CONTRAST_MIN) return s
  // The surround in the better of a dark colour and white.
  let best = s
  for (const c of s.box.kind !== 'none' ? ['#0a0a10', WHITE] : [BLACK, WHITE]) {
    const t: CaptionStudio = s.box.kind !== 'none' ? { ...s, box: { ...s.box, alpha: Math.max(s.box.alpha, 0.9) }, theme: { ...s.theme, box: c } } : { ...s, edge: { ...s.edge, outlineAlpha: 1 }, theme: { ...s.theme, outline: c } }
    if (worstOf(t) > worstOf(best)) best = t
  }
  s = best
  // Words not yet spoken: more opacity.
  const dimFails = (x: CaptionStudio): boolean => contrastPairs(x).some((p) => p.source === 'upcoming-alpha' && contrastRatio(p.fg, p.bg) < CONTRAST_MIN)
  while (s.motion.upcoming < 1 && dimFails(s)) s = { ...s, motion: { ...s.motion, upcoming: Math.min(1, Math.round((s.motion.upcoming + 0.05) * 100) / 100) } }
  // Each colour still failing moves toward what its background wants, a little more each round.
  for (let round = 1; round <= 40; round++) {
    const failing = contrastPairs(s).filter((p) => p.source !== 'upcoming-alpha' && contrastRatio(p.fg, p.bg) < CONTRAST_MIN)
    if (!failing.length) break
    const moved = new Set<Source>()
    for (const p of failing) {
      if (moved.has(p.source)) continue
      moved.add(p.source)
      const toward = luminance(p.bg) > 0.18 ? BLACK : WHITE
      s = { ...s, theme: setColour(s.theme, p.source, mix(colourOf(s.theme, p.source, p.bg), toward, Math.min(1, 0.05 * round))) }
    }
  }
  return s
}

/* ---------- themes (§7.1) ---------- */

/**
 * The look with `theme`'s colours and its own geometry (§7.1): words, spoken word, emphasis,
 * outline, shadow, box and glow from the theme; the look's own second emphasis colour, spoken
 * gradient, border, Chat bubbles and colour split stay; text on boxes and markers is worked out by
 * contrast again (unless the theme sets it), and a gradient fill gives way to the theme's words.
 */
export function withTheme(studio: CaptionStudio, theme: StudioTheme): CaptionStudio {
  const own = studio.theme
  const next: StudioTheme = {
    text: theme.text,
    ...(theme.upcoming ? { upcoming: theme.upcoming } : {}),
    spoken: theme.spoken,
    ...(theme.spokenText ? { spokenText: theme.spokenText } : {}),
    emphasis: theme.emphasis,
    ...(theme.emphasisText ? { emphasisText: theme.emphasisText } : {}),
    ...(own.emphasis2 ? { emphasis2: own.emphasis2 } : theme.emphasis2 ? { emphasis2: theme.emphasis2 } : {}),
    outline: theme.outline,
    shadow: theme.shadow,
    box: theme.box,
    glow: theme.glow,
    ...(own.gradient ? { gradient: own.gradient } : theme.gradient ? { gradient: theme.gradient } : {}),
    ...(theme.fill ? { fill: theme.fill } : {}),
    ...(own.border ? { border: own.border } : {}),
    ...(own.youBox ? { youBox: own.youBox } : {}),
    ...(own.youText ? { youText: own.youText } : {}),
    ...(own.split ? { split: own.split } : {})
  }
  return { ...studio, theme: next }
}

/** Most a brand colour is mixed with white (§7.1). */
const BRAND_LIGHTEN_MAX = 0.6

/**
 * The Brand theme from the kit's colours, lightened until they pass (§7.1): words white, the
 * spoken word in the first usable brand colour, emphasis in the second (the first again with only
 * one), the second emphasis colour in the third when there is one. A colour under 4.5:1 against
 * the look's surround is mixed with white in steps of 5% (at most 60%); one that still fails is
 * skipped. `lightened` lists the kit colours (as given) that were mixed. Null with no usable colour.
 */
export function brandTheme(colors: readonly string[], studio: CaptionStudio): { theme: StudioTheme; lightened: string[] } | null {
  const base: StudioTheme = { text: WHITE, spoken: WHITE, emphasis: WHITE, outline: BLACK, shadow: BLACK, box: '#0a0a10', glow: WHITE }
  const around = surroundOf(withTheme(studio, base))
  // Without a box or outline the words rest on their dark shadow: judge brand colours against it.
  const surround = around.given ? around.colours : [BLACK]
  const usable: string[] = []
  const lightened: string[] = []
  for (const raw of colors) {
    if (typeof raw !== 'string' || !HEX6.test(raw)) continue
    const c = (raw.startsWith('#') ? raw : `#${raw}`).toLowerCase()
    let found: string | null = null
    for (let step = 0; step <= Math.round(BRAND_LIGHTEN_MAX / 0.05); step++) {
      const m = mix(c, WHITE, step * 0.05)
      if (surround.every((bg) => contrastRatio(m, bg) >= CONTRAST_MIN)) {
        found = m
        break
      }
    }
    if (!found) continue
    if (found !== c) lightened.push(raw)
    usable.push(found)
  }
  if (!usable.length) return null
  const spoken = usable[0]
  return { theme: { ...base, spoken, emphasis: usable[1] ?? spoken, glow: spoken, ...(usable[2] ? { emphasis2: usable[2] } : {}) }, lightened }
}

/* ---------- speaker colours (§7.4) ---------- */

/** Hue in degrees and HSV saturation of a colour. */
function hueSat(color: string): { hue: number; sat: number } {
  const [r, g, b] = rgb(color).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let hue = 0
  if (d > 0) {
    if (max === r) hue = 60 * (((g - b) / d) % 6)
    else if (max === g) hue = 60 * ((b - r) / d + 2)
    else hue = 60 * ((r - g) / d + 4)
  }
  return { hue: (hue + 360) % 360, sat: max === 0 ? 0 : d / max }
}

/**
 * Whether two colours are too close to tell a speaker from a mark (§7.4): both saturated (HSV
 * saturation 0.25 or more) with hues less than 30° apart, or both unsaturated with a contrast
 * under 1.5:1 between them.
 */
export function tooClose(a: string, b: string): boolean {
  const x = hueSat(a)
  const y = hueSat(b)
  if (x.sat >= 0.25 && y.sat >= 0.25) {
    const d = Math.abs(x.hue - y.hue)
    return Math.min(d, 360 - d) < 30
  }
  return x.sat < 0.25 && y.sat < 0.25 && contrastRatio(a, b) < 1.5
}

/**
 * A colour for each of `speakers` speakers (in the order they first speak), from SPEAKER_PALETTE,
 * skipping those too close to the look's spoken or emphasis colour, then again from the first
 * (§7.4). When every palette colour is too close, the palette as it is.
 */
export function speakerColors(studio: CaptionStudio, speakers: number): string[] {
  const marks = [studio.theme.spoken, studio.theme.emphasis]
  const free = SPEAKER_PALETTE.filter((c) => !marks.some((m) => tooClose(c, m)))
  const list = free.length ? free : SPEAKER_PALETTE
  return Array.from({ length: Math.max(0, Math.floor(speakers)) }, (_, i) => list[i % list.length])
}
