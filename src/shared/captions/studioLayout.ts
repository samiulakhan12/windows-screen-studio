/**
 * The Captions Studio layout (docs/design/captions-studio.md §8): sizes, chunks, phrase breaks,
 * positions and keeping clear of the action, the camera, lower thirds and key presses. Pure:
 * text is measured through a function the renderer passes, at each word's own size and face, so
 * the preview and the export break the same words onto the same lines.
 */
import { visibleSize } from '../engine/crop'
import { cameraBoxShown, layoutPhaseAt, sceneCameraBox, type Rect } from '../engine/layout'
import { isTall } from '../engine/reframeData'
import { TEXT_INSET } from '../render/safeZones'
import type { CaptionSegment, CaptionSettings, CaptionStudio, Project, StudioPosition } from '../types'
import { scriptLineHeight, scriptScale } from './fontStack'
import { CAPTION_MAX_WIDTH, CAPTION_SAFE, displayOrder, RTL_FIRST } from './layout'
import { CLAUSE_END, CURRENCY, END_WORDS, JOIN_WORDS, NO_LINE_END, NO_LINE_START, POST_WORDS, SENTENCE_END, UNIT_WORDS } from './phraseWords'
import { hasCase, mainScript, scriptOf, studioTokens, withDigits, type ScriptTag, type StudioToken } from './words'

/** A word's font as drawn: the stack (its script's font first, §6.5), weight and letter spacing (em). */
export interface StudioFace {
  stack: string
  weight: number
  tracking: number
  /** The font's width (wdth axis, percent; drawn as the nearest canvas width keyword) when the look asks for one (§0.2: Stacked's Anek Bangla at 75, 'condensed'); absent: 100. */
  stretch?: number
}

/** Width of `text` at `px` pixels in `face`. */
export type StudioMeasure = (text: string, px: number, face: StudioFace) => number

export interface StudioWordBox {
  /** Index into StudioLayout.tokens. */
  token: number
  text: string
  /** Left edge from the line's left edge, px. */
  x: number
  w: number
  /** Its own size, px (emphasised words are bigger, stacked lines differ). */
  px: number
  face: StudioFace
  role: 'text' | 'emphasis'
  tone?: 2
}

export interface StudioLine {
  words: StudioWordBox[]
  width: number
  height: number
  px: number
}

export interface StudioChunk {
  start: number
  end: number
  lines: StudioLine[]
  first: number
  last: number
  width: number
  height: number
}

export interface StudioLayout {
  tokens: StudioToken[]
  chunks: StudioChunk[]
  px: number
  lineHeight: number
  rtl: boolean
  /** Each token's own reading direction (layout.ts tokenDirs), for fills, wipes and typewriters. */
  dirs: ('l' | 'r')[]
  /** 0: not emphasised; 1 or 2: the emphasis tone. */
  emphasis: (0 | 1 | 2)[]
  /** The caption's id (CaptionSegment.id): the seed of its rotations and shakes (§9.1 rule 4). */
  caption?: string
  /** The caption's speaker (NW-09): Chat puts the captions of "You" on the right, others on the left (§0.1). */
  speaker?: string
  /** Set by flashSafeChunks when a spoken box, pill, underline or glow would cover more than 2.5% of the frame: it then dwells 0.34 s (§9.6 rule 1). */
  bigMark?: true
}

/** What a caption keeps clear of (§8.6), in output px. */
export interface CaptionObstacles {
  camera: readonly Rect[]
  titles: readonly Rect[]
  keys: Rect | null
  action: readonly { t: number; rect: Rect }[]
}


/* ---------- size and room (§8.4) ---------- */

/** Scripts written without capitals or spaces that keep their own character limit (§6.6). */
const CJK: ReadonlySet<ScriptTag> = new Set(['han', 'kana', 'hangul'])
/** Most characters per line of Chinese, Japanese and Korean, wide and tall (§6.6), when the look asks for more. */
const CJK_CHARS = { wide: 24, tall: 16 }

/** Horizontal padding of the look's box around a line or chunk, em; 0 without a box. */
const padXOf = (studio: CaptionStudio): number => (studio.box.kind === 'none' ? 0 : studio.box.padX)

/** The text size, line height, room and character limit of `studio` in a `w` x `h` frame (§8.4). */
export function studioMetrics(studio: CaptionStudio, w: number, h: number, area?: Rect | null, script?: ScriptTag): { px: number; lineHeight: number; maxWidth: number; maxChars: number; tall: boolean } {
  const u = Math.min(w, h)
  const tall = isTall(w, h)
  const px = studio.text.size * (tall ? studio.text.tall : 1) * u
  const lineHeight = px * scriptLineHeight(script ?? 'latin', studio.text.lineHeight)
  const safe = CAPTION_SAFE * u
  const full = Math.min(w * CAPTION_MAX_WIDTH, w - safe * 2)
  // In a text area the lines, still centred on the frame, stay inside it on both sides; a band spans 0.05..0.95 W.
  let room = area ? Math.min(full, 2 * Math.min(w / 2 - area.x, area.x + area.w - w / 2)) : full
  if (studio.box.kind === 'band') room = Math.min(room, w * 0.9)
  const maxWidth = Math.max(px * 2, room - padXOf(studio) * px * 2)
  let maxChars = tall ? studio.layout.tallChars : studio.layout.chars
  if (script && CJK.has(script)) {
    const cap = tall ? CJK_CHARS.tall : CJK_CHARS.wide
    if (maxChars === 0 || maxChars > cap) maxChars = cap
  }
  return { px, lineHeight, maxWidth, maxChars, tall }
}

/* ---------- phrase breaks (§8.3) ---------- */

/** Each chunk costs this much, so two lines on screen together beat two chunks of one line. */
const CHUNK_COST = 5
/** Two lines for words that fit on one: a line that fits is broken only for a much better place. */
const NEEDLESS_BREAK = 6

const graphemer = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
function graphemes(text: string): number {
  if (/^[\x20-\x7e]*$/.test(text)) return text.length
  if (!graphemer) return Array.from(text).length
  let n = 0
  for (const _ of graphemer.segment(text)) n++
  return n
}

/** A word compared with the word lists: lower case, punctuation off both ends. */
const bare = (text: string): string => text.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
const baseLanguage = (language: string | undefined): string => (language ?? 'en').toLowerCase().split(/[-_]/)[0]
const isNumber = (text: string): boolean => /\p{Nd}/u.test(text)
/** A token with a letter or digit (not punctuation alone). */
const WORDISH = /[\p{L}\p{N}]/u
const capitalised = (text: string): boolean => /^[^\p{L}]*\p{Lu}/u.test(text)

/** Whether word `i` starts a sentence: the caption's first word, or the first after a sentence end. */
function sentenceStart(tokens: readonly StudioToken[], i: number): boolean {
  let k = i - 1
  while (k >= 0 && tokens[k].label) k--
  return k < 0 || SENTENCE_END.test(tokens[k].text)
}

/** The cost of a line break after word `i` (before word `i + 1`), §8.3; Infinity where one is not allowed. */
function breakCost(tokens: readonly StudioToken[], i: number, language: string | undefined): number {
  const a = tokens[i]
  const b = tokens[i + 1]
  // The speaker's name is never broken, and never shown on a line alone (checked per line).
  if (a.label && b.label) return Infinity
  // Chinese and Japanese line rules (kinsoku).
  if (NO_LINE_START.test(b.text) || NO_LINE_END.test(a.text)) return Infinity
  let cost = 0
  if (SENTENCE_END.test(a.text)) cost -= 6
  else if (CLAUSE_END.test(a.text) || a.text === '–' || a.text === '—') cost -= 3
  const pause = b.start - a.end
  if (!a.label && !a.estimated && !b.estimated) {
    if (pause >= 0.25) cost -= 3
    else if (pause >= 0.15) cost -= 1
  }
  const lang = baseLanguage(language)
  const join = JOIN_WORDS[lang]
  const ends = END_WORDS[lang]
  const wa = bare(a.text)
  const wb = bare(b.text)
  if (join?.includes(wb)) cost -= 1
  if (POST_WORDS[lang]?.includes(wb)) cost += 8
  if (!SENTENCE_END.test(a.text) && !CLAUSE_END.test(a.text) && (join?.includes(wa) || ends?.includes(wa))) cost += 4
  // A number and its unit or currency ("300 percent", "$ 5").
  if ((isNumber(a.text) && !CLAUSE_END.test(a.text) && !SENTENCE_END.test(a.text) && (UNIT_WORDS.has(wb) || /^[%‰]/.test(b.text))) || (CURRENCY.test(a.text) && isNumber(b.text))) cost += 8
  // Inside a run of capitalised words ("Visual Studio Code"), a capital at a sentence start not counting: §8.3
  // gives +4, which one chunk fewer outweighs, so a name is kept together like a number and its unit.
  if (!a.label && capitalised(a.text) && capitalised(b.text) && !sentenceStart(tokens, i) && !SENTENCE_END.test(a.text) && !CLAUSE_END.test(a.text)) cost += 8
  return cost
}

/** Widths and character counts of lines over the words, with the room before each word in `spaces` (0 where the text has no space, but between stickers). */
function lineMeter(widths: readonly number[], tokens: readonly StudioToken[], spaces?: readonly number[]): { width(a: number, b: number): number; chars(a: number, b: number): number } {
  const n = tokens.length
  const wSum = new Float64Array(n + 1)
  const cSum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const gap = tokens[i].gap
    wSum[i + 1] = wSum[i] + widths[i] + (spaces?.[i] ?? 0)
    cSum[i + 1] = cSum[i] + graphemes(tokens[i].text) + (gap ? 1 : 0)
  }
  return {
    // The first word's own space is not part of its line.
    width: (a, b) => wSum[b] - wSum[a] - (spaces?.[a] ?? 0),
    chars: (a, b) => cSum[b] - cSum[a] - (tokens[a].gap ? 1 : 0)
  }
}

/**
 * The lines of each chunk as [from, to) word ranges, chosen by the phrase cost of §8.3: dynamic
 * programming over the words of a caption, minimising the break costs, the raggedness of every
 * line but the last of a chunk, and the two-line rules, with a cost per line and per chunk so a
 * line that fits is never broken. Lines are no wider than `room` and no longer than `maxChars`
 * (0: no limit; a word alone always fits); a chunk holds at most `lines` (1 or 2) lines. `spaces`:
 * the room before each word: its space where the text has one, the gap between stickers (none: 0).
 */
export function breakPhrases(widths: number[], tokens: StudioToken[], room: number, maxChars: number, lines: number, language?: string, spaces?: readonly number[]): [number, number][][] {
  const n = tokens.length
  if (!n) return []
  const per = Math.max(1, Math.min(2, Math.round(lines)))
  const meter = lineMeter(widths, tokens, spaces)
  const bc = Array.from({ length: Math.max(0, n - 1) }, (_, i) => breakCost(tokens, i, language))
  // Words that count as a word on a line (not the speaker's name, not punctuation alone), as prefix sums.
  const plain = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) plain[i + 1] = plain[i] + (!tokens[i].label && WORDISH.test(tokens[i].text) ? 1 : 0)
  const words = (a: number, b: number): number => plain[b] - plain[a]
  const within = (a: number, b: number): boolean => meter.width(a, b) <= room * (1 + 1e-9) && (maxChars <= 0 || meter.chars(a, b) <= maxChars)
  const fits = (a: number, b: number): boolean => {
    const plain = words(a, b)
    // Never the speaker's name (or punctuation) alone; a word alone, with its name or punctuation, always fits.
    if (plain === 0) return false
    return plain === 1 || within(a, b)
  }
  // How full a line is: of the room, or of the character limit when that binds first.
  const ragged = (a: number, b: number): number => 10 * (1 - Math.min(1, Math.max(meter.width(a, b) / room, maxChars > 0 ? meter.chars(a, b) / maxChars : 0))) ** 2
  const heavy = (a: number, k: number, b: number): number => (meter.width(a, k) - meter.width(k, b) > 0.1 * room ? 2 : 0) + (words(a, k) <= 2 ? 3 : 0)
  const best = new Float64Array(n + 1).fill(Infinity)
  const from: { i: number; k: number }[] = new Array(n + 1)
  best[0] = 0
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (!Number.isFinite(best[i])) continue
      const before = i > 0 ? bc[i - 1] : 0
      if (!Number.isFinite(before)) continue
      // One line.
      if (fits(i, j)) {
        const c = best[i] + before + CHUNK_COST
        if (c < best[j]) {
          best[j] = c
          from[j] = { i, k: -1 }
        }
      }
      // Two lines, broken after word k - 1.
      if (per === 2)
        for (let k = i + 1; k < j; k++) {
          if (!Number.isFinite(bc[k - 1]) || !fits(i, k) || !fits(k, j)) continue
          const c = best[i] + before + CHUNK_COST + bc[k - 1] + ragged(i, k) + heavy(i, k, j) + (within(i, j) ? NEEDLESS_BREAK : 0)
          if (c < best[j]) {
            best[j] = c
            from[j] = { i, k }
          }
        }
      // A chunk never holds more than `per` lines' worth of words: once one line from i no longer fits two lines, stop.
      if (i < j - 1 && (meter.width(i, j) > room * per * 1.5 || (maxChars > 0 && meter.chars(i, j) > maxChars * per * 1.5))) break
    }
  }
  if (!Number.isFinite(best[n])) return greedyChunks(tokens, meter, room, maxChars, per)
  const out: [number, number][][] = []
  for (let j = n; j > 0; ) {
    const { i, k } = from[j]
    out.unshift(k < 0 ? [[i, j]] : [[i, k], [k, j]])
    j = i
  }
  return out
}

/** Lines filled greedily (when every arrangement breaks a rule, as a caption made only of forbidden breaks). */
function greedyChunks(tokens: readonly StudioToken[], meter: ReturnType<typeof lineMeter>, room: number, maxChars: number, per: number): [number, number][][] {
  const lines: [number, number][] = []
  let a = 0
  for (let b = 1; b <= tokens.length; b++) {
    const over = meter.width(a, b) > room || (maxChars > 0 && meter.chars(a, b) > maxChars)
    if (over && b - 1 > a) {
      lines.push([a, b - 1])
      a = b - 1
    }
  }
  lines.push([a, tokens.length])
  const out: [number, number][][] = []
  for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per))
  return out
}

/** The best lines for the words a..b of one chunk (A few words): one line when it fits, else the cheapest break into up to `per` lines. */
function chunkLines(tokens: readonly StudioToken[], meter: ReturnType<typeof lineMeter>, a: number, b: number, room: number, maxChars: number, per: number, language: string | undefined): [number, number][] {
  const fits = (x: number, y: number): boolean => y - x === 1 || (meter.width(x, y) <= room * (1 + 1e-9) && (maxChars <= 0 || meter.chars(x, y) <= maxChars))
  if (fits(a, b) || per < 2 || b - a < 2) return [[a, b]]
  let best = Infinity
  let at = -1
  for (let k = a + 1; k < b; k++) {
    if (!fits(a, k) || !fits(k, b)) continue
    const c = breakCost(tokens, k - 1, language) + 10 * (1 - Math.min(1, meter.width(a, k) / room)) ** 2 + (meter.width(a, k) - meter.width(k, b) > 0.1 * room ? 2 : 0)
    if (c < best) {
      best = c
      at = k
    }
  }
  if (at < 0) {
    // No break keeps both lines inside: fill greedily.
    const out: [number, number][] = []
    let x = a
    for (let y = a + 1; y <= b; y++) if (!fits(x, y) && y - 1 > x) out.push([x, (x = y - 1)])
    out.push([x, b])
    return out
  }
  return [
    [a, at],
    [at, b]
  ]
}

/* ---------- chunks (§8.2) ---------- */

/** A Latin word of at most `n` letters (they never end a chunk: "IN THE"). */
const shortLatin = (t: StudioToken, n: number): boolean => t.script === 'latin' && (t.text.match(/\p{L}/gu)?.length ?? 0) <= n

/** A few words (§8.2): a chunk ends at `words` words, a sentence end, a pause of 0.15 s or more, or the line limits; 1–2-letter Latin words join the next. */
function fewWordsChunks(tokens: readonly StudioToken[], meter: ReturnType<typeof lineMeter>, words: number, room: number, maxChars: number, per: number, language: string | undefined): [number, number][][] {
  const n = tokens.length
  const fitsLines = (a: number, b: number): boolean => {
    const lines = chunkLines(tokens, meter, a, b, room, maxChars, per, language)
    return lines.length <= per && lines.every(([x, y]) => y - x === 1 || (meter.width(x, y) <= room * (1 + 1e-9) && (maxChars <= 0 || meter.chars(x, y) <= maxChars)))
  }
  const out: [number, number][][] = []
  let a = 0
  while (a < n) {
    let count = 0
    let b = a
    while (b < n) {
      const t = tokens[b]
      if (!t.label) count++
      b++
      if (b >= n) break
      if (t.label) continue
      const next = tokens[b]
      // A word of one or two Latin letters goes with the next word.
      if (shortLatin(t, 2) && !SENTENCE_END.test(t.text)) {
        if (fitsLines(a, b + 1)) continue
      }
      if (count >= words || SENTENCE_END.test(t.text) || next.start - t.end >= 0.15 || !fitsLines(a, b + 1)) break
    }
    out.push(chunkLines(tokens, meter, a, b, room, maxChars, per, language))
    a = b
  }
  return out
}

/** One word (§8.2): one word per chunk; a Latin word of 1–3 letters joins the next ("IN THE"); Chinese, Japanese and Thai words of 2–4 characters. */
function oneWordChunks(tokens: readonly StudioToken[]): [number, number][][] {
  const n = tokens.length
  const out: [number, number][][] = []
  let a = 0
  while (a < n) {
    let b = a
    while (b < n && tokens[b].label) b++
    if (b >= n) {
      out.push([[a, n]])
      break
    }
    const t = tokens[b]
    b++
    if (b < n && !SENTENCE_END.test(t.text)) {
      if (shortLatin(t, 3) && t.script === 'latin') b++
      else if (!tokens[b].gap) {
        // Words split out of one piece (no spaces): together while under 2 characters, never past 4.
        let size = graphemes(t.text)
        while (b < n && !tokens[b].gap && size < 2 && size + graphemes(tokens[b].text) <= 4) size += graphemes(tokens[b++].text)
      }
    }
    out.push([[a, b]])
    a = b
  }
  return out
}

/**
 * Stacked (§8.2): `words` words on up to `lines` lines; an emphasised word gets a line of its own,
 * the others go about two to a line, evened out by characters.
 */
function stackedChunks(tokens: readonly StudioToken[], emphasis: readonly (0 | 1 | 2)[], words: number, lines: number): [number, number][][] {
  const n = tokens.length
  const linesOf = (a: number, b: number): [number, number][] => {
    // Runs of plain words between emphasised words (labels go with what follows them).
    const runs: [number, number, boolean][] = []
    let x = a
    for (let i = a; i < b; i++) {
      if (emphasis[i] && !tokens[i].label) {
        if (i > x) runs.push([x, i, false])
        runs.push([i, i + 1, true])
        x = i + 1
      }
    }
    if (x < b) runs.push([x, b, false])
    const out: [number, number][] = []
    for (const [p, q, alone] of runs) {
      if (alone) {
        out.push([p, q])
        continue
      }
      const own = q - p
      const count = Math.max(1, Math.ceil(own / 2))
      // Even out by characters.
      let start = p
      for (let k = 1; k <= count; k++) {
        const left = q - start
        const take = k === count ? left : Math.max(1, Math.round(left / (count - k + 1)))
        out.push([start, start + take])
        start += take
      }
    }
    // Too many lines: merge plain neighbours, shortest first.
    while (out.length > lines) {
      let best = -1
      for (let k = 0; k + 1 < out.length; k++) {
        const plain = (r: [number, number]): boolean => !(r[1] - r[0] === 1 && emphasis[r[0]])
        if (plain(out[k]) && plain(out[k + 1]) && (best < 0 || out[k][1] - out[k][0] + out[k + 1][1] - out[k + 1][0] < out[best][1] - out[best][0] + out[best + 1][1] - out[best + 1][0])) best = k
      }
      if (best < 0) break
      out.splice(best, 2, [out[best][0], out[best + 1][1]])
    }
    return out
  }
  const chunks: [number, number][][] = []
  let a = 0
  while (a < n) {
    let count = 0
    let b = a
    while (b < n) {
      if (!tokens[b].label) count++
      b++
      if (b < n && (count >= words || SENTENCE_END.test(tokens[b - 1].text))) break
    }
    // Cut the chunk earlier while its emphasised words leave too many lines.
    let l = linesOf(a, b)
    while (l.length > lines && b - a > 1) l = linesOf(a, --b)
    chunks.push(l)
    a = b
  }
  return chunks
}

/* ---------- the layout ---------- */

/** The word in the look's case (scripts without case ignore it; Turkish İ through the language). */
function cased(text: string, c: CaptionStudio['text']['case'], language: string | undefined, script: ScriptTag): string {
  if (c === 'asis' || !hasCase(script)) return text
  try {
    return c === 'upper' ? text.toLocaleUpperCase(language || undefined) : text.toLocaleLowerCase(language || undefined)
  } catch {
    return c === 'upper' ? text.toUpperCase() : text.toLowerCase()
  }
}

/** The spoken weight of the 'weight' mark (Light to Bold's 700): StudioText.spokenWeight, else 300 heavier (at most 900). */
export const spokenWeightOf = (studio: CaptionStudio): number => studio.text.spokenWeight ?? Math.min(900, studio.text.weight + 300)

/**
 * Caption `seg` laid out for `studio`: tokens (in the look's case and the Digits choice), chunks
 * (§8.2) and lines broken at natural phrases (§8.3), each word measured at its own size and face.
 * Emphasised words draw at the emphasis scale (×1.14 at most in Bangla); the 'weight' mark
 * measures every word at its spoken weight so lines never re-break; a spoken word that grows
 * (CaptionMotion.spokenScale) gets room on both sides so it never touches its neighbours, and
 * stays inside the room (§8.4).
 */
export function studioLayout(
  seg: CaptionSegment,
  studio: CaptionStudio,
  w: number,
  h: number,
  measure: StudioMeasure,
  opts: { faceOf: (token: StudioToken, role: 'text' | 'emphasis') => StudioFace; area?: Rect | null; marks?: readonly { from: number; to: number; tone?: 2 }[]; language?: string; showSpeaker?: boolean; spoken?: boolean; digits?: 'native' | 'western' }
): StudioLayout {
  const language = opts.language
  // Digits in the Digits choice: a word's script follows its new digits (300% written ৩০০% is Bangla,
  // drawn in the Bangla font with the Bangla rules, as typed); a Latin word keeps its own ("MP3").
  const tokens: StudioToken[] = studioTokens(seg, language, !!opts.showSpeaker).map((t) => {
    const text = t.script === 'latin' ? t.text : withDigits(t.text, opts.digits, language)
    const script = text === t.text ? t.script : scriptOf(text)
    return { ...t, script, text: cased(text, studio.text.case, language, script) }
  })
  const emphasis: (0 | 1 | 2)[] = tokens.map((t) => {
    if (t.label) return 0
    let tone: 0 | 1 | 2 = 0
    for (const m of opts.marks ?? []) if (t.word >= m.from && t.word <= m.to) tone = m.tone === 2 ? 2 : 1
    return tone
  })
  const own = tokens.filter((t) => !t.label).map((t) => t.text).join(' ')
  const main = mainScript(own)
  const m = studioMetrics(studio, w, h, opts.area, main.share >= 0.5 ? main.script : 'latin')
  const lhMul = m.lineHeight / m.px
  const rtl = RTL_FIRST.test(own)
  const dirs = tokens.map((t) => t.dir)
  const spoken = opts.spoken !== false
  const faces = tokens.map((t, i) => opts.faceOf(t, emphasis[i] ? 'emphasis' : 'text'))
  const pxOf = tokens.map((t, i) => (emphasis[i] ? m.px * scriptScale(t.script, studio.emphasis.scale) : m.px))
  const measureFace = (i: number): StudioFace => (spoken && studio.spoken === 'weight' && !tokens[i].label ? { ...faces[i], weight: Math.max(faces[i].weight, spokenWeightOf(studio)) } : faces[i])
  const widths = tokens.map((t, i) => measure(t.text, pxOf[i], measureFace(i)))
  // Room for a word that grows, on the side of each neighbour: the spoken word's size times the peak
  // of its word motion (Bold Pop: 1.18 × a 1.08 pulse), and in Bangla the peak of a pop style's word
  // motion alone too (§0.2: a grown word never touches its neighbours).
  const calm = !!studio.motion.calm
  const s0 = studio.motion.strength
  const motionPeak = (k: number): number => {
    const kind = emphasis[k] ? studio.motion.emphasis : studio.motion.word
    return kind === 'pulse' ? 1 + 0.08 * s0 : kind === 'pop' ? 1 + 0.04 * s0 : 1
  }
  const peak = (k: number): number => {
    if (!spoken || calm || tokens[k].label) return 1
    const grow = scriptScale(tokens[k].script, studio.motion.spokenScale ?? 1)
    if (grow > 1) return grow * motionPeak(k)
    return tokens[k].script === 'bengali' ? motionPeak(k) : 1
  }
  // Stickers (§0.1, more.html): each word is its own sticker, reaching padX and half its border past
  // the word, so neighbours stand 0.2 em apart sticker to sticker, with or without a space in the text.
  const box = studio.box
  const sticker = (k: number): number => (box.padX + box.border / 2) * pxOf[k]
  const g = (k: number): number => (peak(k) - 1) * widths[k]
  const spaces = tokens.map((t, i) => {
    const grow = i > 0 ? Math.max(g(i - 1), g(i)) / 2 : 0
    if (box.kind === 'word' && i > 0) return sticker(i - 1) + sticker(i) + 0.2 * pxOf[i] + grow
    return t.gap ? measure(' ', pxOf[i], faces[i]) + grow : 0
  })
  const meter = lineMeter(widths, tokens, spaces)
  const lay = studio.layout
  const per = Math.max(1, Math.min(2, lay.lines))
  let ranges: [number, number][][]
  if (lay.chunk === 'phrase') ranges = breakPhrases(widths, tokens, m.maxWidth, m.maxChars, per, language, spaces)
  else if (lay.chunk === 'words') ranges = fewWordsChunks(tokens, meter, Math.max(1, lay.words), m.maxWidth, m.maxChars, per, language)
  else if (lay.chunk === 'word') ranges = oneWordChunks(tokens)
  else ranges = stackedChunks(tokens, emphasis, Math.max(1, lay.words), Math.max(1, Math.min(4, lay.lines)))
  // 'word' and 'stack' fit each line to `fit` of the room (0.6..2.2 times the look's size). No line
  // is wider than the room: one holding a word too long for it ("TROUBLESHOOTING") is drawn smaller.
  // Every spoken word stays inside the room at its peak size too (Bold Pop's 1.18 × pulse), so it
  // never runs past the frame or the text area: a line whose first or last word (or a word alone)
  // would grow past the room is drawn just small enough for it to fit.
  const fitted = (lay.chunk === 'word' || lay.chunk === 'stack') && lay.fit !== undefined
  const lineScale = (a: number, b: number): number => {
    const at = meter.width(a, b)
    if (!(at > 0)) return 1
    const k = fitted ? Math.min(2.2, Math.max(0.6, (m.maxWidth * lay.fit!) / at)) : 1
    // Each word grows by g(i) around its middle: the line, centred, needs twice what it reaches past its nearer end.
    let need = at
    let x = 0
    for (let i = a; i < b; i++) {
      if (i > a) x += spaces[i]
      need = Math.max(need, at + g(i) - 2 * Math.min(x, at - x - widths[i]))
      x += widths[i]
    }
    return need * k > m.maxWidth * (1 + 1e-9) ? m.maxWidth / need : k
  }
  const chunks: StudioChunk[] = ranges.map((group) => {
    const lines: StudioLine[] = group.map(([a, b]) => {
      const k = lineScale(a, b)
      const words: StudioWordBox[] = []
      let x = 0
      for (let i = a; i < b; i++) {
        if (i > a) x += spaces[i] * k
        words.push({ token: i, text: tokens[i].text, x, w: widths[i] * k, px: pxOf[i] * k, face: faces[i], role: emphasis[i] ? 'emphasis' : 'text', ...(emphasis[i] === 2 ? { tone: 2 as const } : {}) })
        x += widths[i] * k
      }
      displayOrder(words, x, dirs, rtl ? 'r' : 'l')
      // Each line is as tall as the tallest script on it needs (§0.2: Bangla 1.4), so a Bangla word
      // among English ones keeps its vowel signs clear of the next line.
      const top = Math.max(...words.map((wd) => wd.px))
      const tall = Math.max(lhMul, ...words.map((wd) => scriptLineHeight(tokens[wd.token].script, studio.text.lineHeight)))
      return { words, width: x, height: top * tall, px: m.px * k }
    })
    const first = group[0][0]
    const last = group[group.length - 1][1] - 1
    const lead = tokens.slice(first, last + 1).find((t) => !t.label) ?? tokens[first]
    return { start: lead.start, end: 0, lines, first, last, width: Math.max(...lines.map((l) => l.width)), height: lines.reduce((s, l) => s + l.height, 0) }
  })
  timeChunks(chunks, seg)
  return { tokens, chunks, px: m.px, lineHeight: m.lineHeight, rtl, dirs, emphasis, caption: seg.id, ...(seg.speaker ? { speaker: seg.speaker } : {}) }
}

/** Chunk times as captionLayout gives them (§8.2): from the first word, the first from the caption's start; chunks starting together share the time; each shows at least min(0.4 s, caption / chunks); a chunk shows until the next one starts. */
function timeChunks(chunks: StudioChunk[], seg: Pick<CaptionSegment, 'start' | 'end'>): void {
  if (!chunks.length) return
  chunks.forEach((ch, i) => {
    ch.start = i === 0 ? seg.start : Math.min(seg.end, Math.max(seg.start, ch.start))
  })
  for (let i = 1; i < chunks.length; ) {
    const from = chunks[i - 1].start
    if (chunks[i].start > from) {
      i++
      continue
    }
    let j = i
    while (j < chunks.length && chunks[j].start <= from) j++
    const to = j < chunks.length ? chunks[j].start : seg.end
    for (let k = i; k < j; k++) chunks[k].start = from + ((k - i + 1) / (j - i + 1)) * (to - from)
    i = j
  }
  const minShow = Math.min(0.4, (seg.end - seg.start) / chunks.length)
  for (let i = chunks.length - 1; i > 0; i--) {
    const latest = (i + 1 < chunks.length ? chunks[i + 1].start : seg.end) - minShow
    if (chunks[i].start <= latest) break
    chunks[i].start = latest
  }
  chunks.forEach((ch, i) => {
    ch.end = i + 1 < chunks.length ? Math.max(ch.start, chunks[i + 1].start) : seg.end
  })
}

/** Index of the chunk showing at source time `t`, or -1 before the first and after the last. */
export function studioChunkAt(layout: StudioLayout, t: number): number {
  const { chunks } = layout
  if (!chunks.length || t < chunks[0].start || t >= chunks[chunks.length - 1].end) return -1
  let lo = 0
  let hi = chunks.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (chunks[mid].start <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/* ---------- positions (§8.5) and keeping clear (§8.6) ---------- */

/** The rows of a chunk's block: each line's own box (per-line backgrounds) or one box around them all, and the block's size. */
function blockOf(chunk: StudioChunk, studio: CaptionStudio, px: number, w: number): { rows: { offset: number; height: number }[]; width: number; height: number } {
  const b = studio.box
  const perLine = b.kind === 'line' || b.kind === 'glass' || b.kind === 'word' || b.kind === 'band'
  const rows: { offset: number; height: number }[] = []
  let y = 0
  let width = 0
  if (perLine) {
    chunk.lines.forEach((l, i) => {
      const lp = l.px || px
      const hgt = l.height + 2 * b.padY * lp
      if (i > 0) y += (b.gap ?? 0) * px
      rows.push({ offset: y + b.padY * lp, height: l.height })
      y += hgt
      width = Math.max(width, l.width + 2 * b.padX * lp)
    })
    if (b.kind === 'band') width = w * 0.9
    return { rows, width, height: y }
  }
  const pad = b.kind === 'none' ? 0 : b.padY * px
  y = pad
  for (const l of chunk.lines) {
    rows.push({ offset: y, height: l.height })
    y += l.height
  }
  const tail = b.kind === 'bubble' ? (b.tail ?? 0) * px : 0
  return { rows, width: chunk.width + (b.kind === 'none' ? 0 : 2 * b.padX * px), height: y + pad + tail }
}

/** Where a block of `height` px sits at `position` in a `w` x `h` frame (§8.5): its top. */
function anchorTop(position: StudioPosition, height: number, w: number, h: number): number {
  const u = Math.min(w, h)
  if (isTall(w, h)) {
    if (position === 'top') return 0.13 * h
    if (position === 'upper') return 0.3 * h - height / 2
    if (position === 'middle') return 0.45 * h - height / 2
    if (position === 'lower') return 0.66 * h - height / 2
    return 0.74 * h - height
  }
  if (position === 'top') return 0.06 * u
  if (position === 'upper') return 0.25 * h - height / 2
  if (position === 'middle') return 0.5 * h - height / 2
  if (position === 'lower') return 0.8 * h - height / 2
  return h - 0.075 * u - height
}

/** NW-09's name of the microphone's speaker (speakers.ts STEM_SPEAKERS.mic). */
const CHAT_YOU = 'You'

/** The legacy look's position a Studio position stands for (a twin's top, middle or bottom). */
const legacyPosition = (p: StudioPosition): CaptionSettings['position'] => (p === 'top' || p === 'upper' ? 'top' : p === 'middle' ? 'middle' : 'bottom')

/** Today's placeChunk top for a block of `height` px (§8.5 legacy anchors), inside the text area as today. */
function legacyTop(position: CaptionSettings['position'], height: number, w: number, h: number, area: Rect | null | undefined, anchor?: (p: CaptionSettings['position']) => number): number {
  const u = Math.min(w, h)
  if (anchor) {
    const y = anchor(position)
    return position === 'top' ? y : position === 'middle' ? y - height / 2 : y - height
  }
  const margin = CAPTION_SAFE * u
  const frameTop = position === 'top' ? margin : position === 'middle' ? (h - height) / 2 : h - margin * 1.25 - height
  if (!area) return frameTop
  const inset = TEXT_INSET * u
  if (position === 'top') return Math.max(frameTop, area.y + inset)
  if (position === 'middle') return area.y + (area.h - height) / 2
  return Math.min(frameTop, area.y + area.h - inset - height)
}

/** The edge a block reports to key presses (captionBlockAt, §8.5): Top and Upper 'top', Lower and Bottom 'bottom', Middle 'middle'; a dragged block 'middle' within 0.1 H of the middle, else the nearer edge. */
export function blockEdge(position: StudioPosition | null, centreY: number, h: number): 'top' | 'middle' | 'bottom' {
  if (position === 'top' || position === 'upper') return 'top'
  if (position === 'lower' || position === 'bottom') return 'bottom'
  if (position === 'middle') return 'middle'
  if (Math.abs(centreY - h / 2) <= 0.1 * h) return 'middle'
  return centreY < h / 2 ? 'top' : 'bottom'
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** A caption's place after keeping clear (§8.6): its position, a vertical shift and its centre x. Decided once per caption. */
interface Plan {
  position: StudioPosition
  dy: number
  cx: number
}

const plans = new WeakMap<StudioLayout, WeakMap<object, Map<string, Plan>>>()

/** Seconds of viewing time the action spends under `rect`: each sample stands for 0.1 s (actionRects samples every 0.1 s). */
function actionTime(action: CaptionObstacles['action'], rect: Rect): number {
  const at = new Set<number>()
  for (const a of action) if (overlaps(a.rect, rect)) at.add(Math.round(a.t * 10))
  return at.size * 0.1
}

/** How long the action may stay under a caption before it moves (§8.6 rule 2). */
const ACTION_LIMIT = 0.3

/**
 * The caption's place (§8.6), from its tallest and widest block, so it never jumps between its
 * chunks: lift or lower it clear of the camera, lower thirds and key presses (on the same side of
 * the middle, inside the area); with the action under it for more than 0.3 s, the opposite edge;
 * else a free span beside the obstacles at least half the frame wide; else the other positions
 * (bottom, lower, upper, top); else where it was. Never onto the camera to clear the cursor.
 */
function keepClear(studio: CaptionStudio, size: { width: number; height: number }, w: number, h: number, bounds: { top: number; bottom: number }, obstacles: CaptionObstacles, topOf: (p: StudioPosition, height: number) => number, cx0: number): Plan {
  const u = Math.min(w, h)
  const clear = 0.02 * u
  const hard = [...obstacles.camera, ...obstacles.titles, ...(obstacles.keys ? [obstacles.keys] : [])]
  const rectAt = (p: StudioPosition, dy: number, cx: number): Rect => ({ x: cx - size.width / 2, y: topOf(p, size.height) + dy, w: size.width, h: size.height })
  const inside = (r: Rect): boolean => r.y >= bounds.top - 0.5 && r.y + r.h <= bounds.bottom + 0.5
  const hitsHard = (r: Rect): boolean => hard.some((o) => overlaps(o, r))
  const hitsCamera = (r: Rect): boolean => obstacles.camera.some((o) => overlaps(o, r))
  const busy = (r: Rect): boolean => actionTime(obstacles.action, r) > ACTION_LIMIT + 1e-9
  // Rule 1: lift or lower clear of the camera, lower thirds and key presses.
  const shifted = (p: StudioPosition, cx: number): number | null => {
    let dy = 0
    for (let k = 0; k < 6; k++) {
      const r = rectAt(p, dy, cx)
      const hit = hard.filter((o) => overlaps(o, r))
      if (!hit.length) return dy
      const centre = r.y + r.h / 2
      const below = p === 'middle' ? hit.every((o) => o.y + o.h / 2 < centre) : centre >= h / 2
      // In the lower half (or below a middle obstacle) move up past the obstacles' tops, else down past their bottoms.
      const next = below === (p !== 'middle') ? Math.min(...hit.map((o) => o.y)) - clear - r.h - (r.y - dy) : Math.max(...hit.map((o) => o.y + o.h)) + clear - (r.y - dy)
      const moved = rectAt(p, next, cx)
      const sameSide = p === 'middle' || (moved.y + moved.h / 2 >= h / 2) === (centre >= h / 2)
      if (!inside(moved) || !sameSide) return null
      dy = next
    }
    return null
  }
  const start = studio.layout.position
  const tryAt = (p: StudioPosition, cx = cx0): Plan | null => {
    const dy = shifted(p, cx)
    if (dy === null) return null
    const r = rectAt(p, dy, cx)
    return busy(r) ? null : { position: p, dy, cx }
  }
  const first = tryAt(start)
  if (first) return first
  // Rule 2: the action under the caption for more than 0.3 s: the opposite edge.
  const lifted = shifted(start, cx0)
  if (lifted !== null && busy(rectAt(start, lifted, cx0))) {
    const opposite: Partial<Record<StudioPosition, StudioPosition>> = { bottom: 'top', top: 'bottom', lower: 'upper', upper: 'lower' }
    const o = opposite[start]
    const there = o ? tryAt(o) : null
    if (there) return there
  }
  // Rule 3: a free span beside the obstacles, at least half the frame wide, that the block fits in.
  const band = rectAt(start, lifted ?? 0, cx0)
  const blockers = [...hard, ...obstacles.action.map((a) => a.rect)].filter((o) => o.y < band.y + band.h && band.y < o.y + o.h)
  const margin = CAPTION_SAFE * u
  const edges = [margin, ...blockers.flatMap((o) => [o.x, o.x + o.w]), w - margin].sort((a, b) => a - b)
  let span: [number, number] | null = null
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = Math.max(margin, edges[i])
    const b = Math.min(w - margin, edges[i + 1])
    const mid: Rect = { x: a, y: band.y, w: Math.max(0, b - a), h: band.h }
    if (b - a >= 0.5 * w && b - a >= size.width && !blockers.some((o) => overlaps(o, mid)) && (!span || b - a > span[1] - span[0])) span = [a, b]
  }
  if (span) {
    const narrowed = tryAt(start, (span[0] + span[1]) / 2)
    if (narrowed) return narrowed
  }
  // Rule 4: the other positions.
  for (const p of ['bottom', 'lower', 'upper', 'top'] as const) {
    if (p === start) continue
    const there = tryAt(p)
    if (there) return there
  }
  // Rule 5: where it was, lifted when that alone works and does not put it on the camera.
  return { position: start, dy: lifted !== null && !hitsCamera(rectAt(start, lifted, cx0)) && !hitsHard(rectAt(start, lifted, cx0)) ? lifted : 0, cx: cx0 }
}

/** How far up and down a block may go (§8.5): inside the text area, else 0.03 u from the frame's edges. */
function boundsOf(w: number, h: number, area: Rect | null): { top: number; bottom: number } {
  const u = Math.min(w, h)
  const margin = CAPTION_SAFE * u
  const inset = TEXT_INSET * u
  return area ? { top: Math.max(margin, area.y + inset), bottom: Math.min(h - margin, area.y + area.h - inset) } : { top: margin * 0.5, bottom: h - margin * 0.5 }
}

/**
 * `chunk` drawn smaller when its block, box included, is taller than placeStudio leaves it at the
 * look's place: a chunk the flash rule merged (§9.6 rule 2) stacks the lines of several, and would
 * otherwise run past the frame or the text area. Every word's size and place and every line's
 * size scale alike; a chunk that fits is returned as it is.
 */
export function fitChunk(
  layout: StudioLayout,
  chunk: StudioChunk,
  studio: CaptionStudio,
  w: number,
  h: number,
  opts: { area?: Rect | null; forced?: 'top' | 'bottom'; legacyAnchor?: (position: CaptionSettings['position']) => number }
): StudioChunk {
  const area = opts.area ?? null
  const lay = studio.layout
  const bounds = boundsOf(w, h, area)
  const legacy = !!lay.legacyAnchor && !opts.forced
  let room: number
  if (lay.place && !opts.forced) {
    // Dragged: kept 0.06 u inside the frame, or inside the text area.
    room = area ? bounds.bottom - bounds.top : h - 2 * CAPTION_SAFE * Math.min(w, h)
  } else if (area && !legacy) room = bounds.bottom - bounds.top
  else {
    // At an anchor the top is a - c × height (c: 0 for a top edge, 1/2 for a centre, 1 for a bottom edge).
    const p = opts.forced ?? lay.position
    const topOf = (height: number): number => (legacy ? legacyTop(legacyPosition(p), height, w, h, area, opts.legacyAnchor) : anchorTop(p, height, w, h))
    const a = topOf(0)
    const c = a - topOf(1)
    room = Infinity
    if (c > 1e-9) room = Math.min(room, (a - bounds.top) / c)
    if (c < 1 - 1e-9) room = Math.min(room, (bounds.bottom - a) / (1 - c))
  }
  const height = blockOf(chunk, studio, layout.px, w).height
  if (!(height > room) || !(chunk.height > 0)) return chunk
  // The box's padding counts as fixed (where it is per line it shrinks too, leaving a little to spare).
  const k = Math.min(1, Math.max(0.1, (room - (height - chunk.height)) / chunk.height))
  return {
    ...chunk,
    lines: chunk.lines.map((l) => ({ ...l, words: l.words.map((wd) => ({ ...wd, x: wd.x * k, w: wd.w * k, px: wd.px * k })), width: l.width * k, height: l.height * k, px: l.px * k })),
    width: chunk.width * k,
    height: chunk.height * k
  }
}

/** Where `chunk` goes (§8.5, §8.6): its lines, block and the edge key presses keep clear of. */
export function placeStudio(
  layout: StudioLayout,
  chunk: StudioChunk,
  studio: CaptionStudio,
  w: number,
  h: number,
  opts: { area?: Rect | null; obstacles?: CaptionObstacles; forced?: 'top' | 'bottom'; legacyAnchor?: (position: CaptionSettings['position']) => number }
): { lines: { x: number; y: number; width: number }[]; top: number; height: number; box: Rect; edge: 'top' | 'middle' | 'bottom' } {
  const u = Math.min(w, h)
  const lay = studio.layout
  const block = blockOf(chunk, studio, layout.px, w)
  const area = opts.area ?? null
  const margin = CAPTION_SAFE * u
  const bounds = boundsOf(w, h, area)
  const intoArea =(top: number, height: number): number => (area ? Math.min(Math.max(top, bounds.top), Math.max(bounds.top, bounds.bottom - height)) : top)
  const topOf = (p: StudioPosition, height: number): number => (lay.legacyAnchor && !opts.forced ? legacyTop(legacyPosition(p), height, w, h, area, opts.legacyAnchor) : intoArea(anchorTop(p, height, w, h), height))
  let top: number
  // Chat (§0.1): the captions of "You" sit on the right, others on the left.
  const side = studio.box.kind === 'chat' && layout.speaker ? (layout.speaker === CHAT_YOU ? w - margin - block.width / 2 : margin + block.width / 2) : w / 2
  let cx = side
  let position: StudioPosition | null = lay.position
  if (opts.forced) {
    position = opts.forced
    top = intoArea(anchorTop(opts.forced, block.height, w, h), block.height)
  } else if (lay.place) {
    // Dragged: centred on the place, kept 0.06 u inside the frame (and the text area); it never moves for obstacles.
    position = null
    const lo = { x: margin, y: area ? bounds.top : margin }
    const hi = { x: w - margin, y: area ? bounds.bottom : h - margin }
    cx = Math.min(Math.max(lay.place.x * w, lo.x + block.width / 2), Math.max(lo.x + block.width / 2, hi.x - block.width / 2))
    top = Math.min(Math.max(lay.place.y * h - block.height / 2, lo.y), Math.max(lo.y, hi.y - block.height))
  } else {
    let plan: Plan = { position: lay.position, dy: 0, cx: side }
    if (lay.avoid && opts.obstacles) {
      // Once per caption, from its tallest and widest block, so the caption never jumps between its chunks.
      const key = `${w}x${h}|${area ? `${area.x},${area.y},${area.w},${area.h}` : '-'}|${lay.position}|${lay.legacyAnchor ? 1 : 0}|${side}`
      let byObstacles = plans.get(layout)
      if (!byObstacles) plans.set(layout, (byObstacles = new WeakMap()))
      let byKey = byObstacles.get(opts.obstacles)
      if (!byKey) byObstacles.set(opts.obstacles, (byKey = new Map()))
      let found = byKey.get(key)
      if (!found) {
        const size = layout.chunks.reduce((s, c) => {
          const b = blockOf(c, studio, layout.px, w)
          return { width: Math.max(s.width, b.width), height: Math.max(s.height, b.height) }
        }, { width: 0, height: 0 })
        found = keepClear(studio, size, w, h, bounds, opts.obstacles, topOf, side)
        byKey.set(key, found)
      }
      plan = found
    }
    position = plan.position
    cx = plan.cx
    top = topOf(plan.position, block.height) + plan.dy
  }
  const lines = chunk.lines.map((l, i) => ({ x: cx - l.width / 2, y: top + block.rows[i].offset + block.rows[i].height / 2, width: l.width }))
  const box: Rect = { x: cx - block.width / 2, y: top, w: block.width, h: block.height }
  return { lines, top, height: block.height, box, edge: blockEdge(position, top + block.height / 2, h) }
}

/** The camera's boxes over [t0, t1] (§8.6 rule 2): at the start, the end and every layout change between; for camera-only and large-camera layouts the face area. */
function cameraRects(project: Project, w: number, h: number, t0: number, t1: number): Rect[] {
  if (!project.hasWebcam || !project.webcam?.show) return []
  const { width: vw, height: vh } = visibleSize(project)
  const times = new Set<number>([t0, t1 - 1e-6])
  for (const s of project.layouts ?? []) {
    if (s.start > t0 && s.start < t1) times.add(s.start)
    if (s.end > t0 && s.end < t1) times.add(s.end - 1e-6)
  }
  const out: Rect[] = []
  for (const t of [...times].sort((a, b) => a - b)) {
    const box = sceneCameraBox(project, w, h, vw, vh, t)
    if (!cameraBoxShown(box)) continue
    const layout = layoutPhaseAt(project, t).to
    const r = box.rect
    const rect = layout === 'camera-only' || layout === 'camera-large' ? { x: r.x + r.w * 0.3, y: r.y + r.h * 0.15, w: r.w * 0.4, h: r.h * 0.5 } : r
    if (!out.some((o) => o.x === rect.x && o.y === rect.y && o.w === rect.w && o.h === rect.h)) out.push(rect)
  }
  return out
}

/** The obstacles of caption `seg` (§8.6): the camera over its time, the placed title boxes, key presses and the action passed in by the renderer. */
export function captionObstacles(
  project: Project,
  seg: CaptionSegment,
  w: number,
  h: number,
  given: { titles: readonly { start: number; end: number; box: Rect }[]; keys: Rect | null; action: readonly { t: number; rect: Rect }[] }
): CaptionObstacles {
  return {
    camera: cameraRects(project, w, h, seg.start, seg.end),
    titles: given.titles.filter((t) => t.start < seg.end && t.end > seg.start).map((t) => t.box),
    keys: given.keys,
    action: given.action.filter((a) => a.t >= seg.start && a.t <= seg.end)
  }
}
