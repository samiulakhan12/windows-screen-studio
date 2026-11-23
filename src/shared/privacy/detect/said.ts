/**
 * Secrets said aloud (docs/design/auto-blur.md §7.2, §4.4), run in the renderer on the captions the
 * project holds when Find starts or Polish has just made. Every word of every caption in time order is
 * one stream: caption boundaries and full stops do not end a run of digits, a pause over 2.0 s or any
 * other word does, and `and` ends a run (finding 10, "400, 300 and 1500, 800"). Each hit keeps its own
 * word span; spoken forms and masks are built from it, never from the bleep's padded time (finding
 * 11). Each hit becomes a private bleep whose word holds its kind and its said text's group, never the
 * text (§4.4). Pure.
 */
import { asciiDigits } from '../../captions/numbers'
import { MAX_BLEEPS } from '../../captions/studioData'
import { captionWordTimes } from '../../editor/transcript'
import type { Bleep, CaptionWord, PrivateKind, Transcript } from '../../types'
import { isPrivateBleep, privateBleepWord, privateGroupOf } from '../coverData'
import { AUTO_SCORE } from '../kinds'
import { cardNetwork, luhn } from './cards'
import { foldText } from './clean'
import { detectFrame } from './detect'
import { saidNames, type NameMatcher, NO_NAMES } from './names'
import { validPhone } from './phones'
import {
  BD_MOBILE,
  DIGIT_TOKEN,
  SAID_ADDRESS_STOP,
  SAID_ADDRESS_WORD,
  SAID_AT,
  SAID_DIGITS,
  SAID_DOT,
  SAID_FILLERS,
  SAID_IS,
  SAID_LABELS,
  SAID_REPEAT,
  SAID_TENS,
  SAID_TENS_HYPHEN,
  SAID_TLDS,
  SENTENCE_END,
  VERSION_TOKEN,
  WORD_EDGES,
  YEAR,
  ZERO_INSIDE_ONLY
} from './tables'

export interface SaidHit {
  kind: PrivateKind
  score: number
  /** The own words' times (not widened). */
  start: number
  end: number
  /** One of the own words has guessed times. */
  estimated: boolean
  /** The said text's group key (its digit string, or its words folded): hits of the same said text share a group. Kept in the renderer's memory only. */
  group: string
  /** The own word span: the first and last word, indices into the caption words in time order. */
  words: [number, number]
}

export interface DigitRun {
  /** The digits said. */
  digits: string
  /** The first and last word of the run (indices into the words). */
  first: number
  last: number
  /** The digits each number word or token gave, in order ("4917", "6", "1", …). */
  tokens: string[]
}

/** A pause that ends a run of digits, and one that ends a password said aloud (seconds). */
const RUN_PAUSE = 2.0
const PASSWORD_PAUSE = 1.0
/** The label context of a run: the 12 words or 10 s before it. */
const CONTEXT_WORDS = 12
const CONTEXT_SECONDS = 10
/** The widening of a private bleep around its words (as Bleep), and for guessed times. */
const WIDEN = 0.05
const WIDEN_ESTIMATED = 0.15
/** Private bleeps of one said text closer than this are merged first when the bleeps are full. */
const MERGE_GAP = 1.0

/** A word as compared: NFC, lower case, punctuation and symbols off its ends, digits of every script as ASCII. */
export const saidWord = (w: string): string => asciiDigits(w.normalize('NFC').toLowerCase().replace(WORD_EDGES, ''))

/** The digits a bare word says ('' for none). */
function wordDigits(w: string): string {
  if (/^\d+$/.test(w)) return w
  if (VERSION_TOKEN.test(w)) return ''
  if (DIGIT_TOKEN.test(w)) return w.replace(/\D/g, '')
  if (Object.hasOwn(SAID_DIGITS, w)) return SAID_DIGITS[w]
  const hy = SAID_TENS_HYPHEN.exec(w)
  if (hy) return SAID_TENS[hy[1]] + SAID_DIGITS[hy[2]]
  if (Object.hasOwn(SAID_TENS, w)) return SAID_TENS[w] + '0'
  return ''
}

/**
 * Runs of digits said over the caption words in time order (§7.2): across captions and full stops,
 * ended by a pause over 2.0 s or a word that is neither a number word nor a filler (`and` ends one).
 */
export function digitRuns(words: readonly CaptionWord[]): DigitRun[] {
  const runs: DigitRun[] = []
  let cur: DigitRun | null = null
  let repeat = 0
  const close = (): void => {
    if (cur && cur.digits.length) runs.push(cur)
    cur = null
    repeat = 0
  }
  const open = (i: number): DigitRun => (cur ??= { digits: '', first: i, last: i, tokens: [] })
  for (let i = 0; i < words.length; i++) {
    const w = saidWord(words[i].text)
    if (cur && i > 0 && words[i].start - words[i - 1].end > RUN_PAUSE) close()
    if (Object.hasOwn(SAID_REPEAT, w)) {
      open(i).last = i
      repeat = SAID_REPEAT[w]
      continue
    }
    let d = wordDigits(w)
    if (ZERO_INSIDE_ONLY.has(w) && !cur) d = ''
    // "twenty five": a tens word and a ones word make one number.
    if (d.length === 2 && d.endsWith('0') && i + 1 < words.length) {
      const next = saidWord(words[i + 1].text)
      const ones = Object.hasOwn(SAID_DIGITS, next) ? SAID_DIGITS[next] : ''
      if (ones.length === 1 && ones !== '0' && !ZERO_INSIDE_ONLY.has(next) && /^[a-z]+$/.test(next) && words[i + 1].start - words[i].end <= RUN_PAUSE) {
        const run = open(i)
        run.digits += d[0] + ones
        run.tokens.push(d[0] + ones)
        run.last = i + 1
        repeat = 0
        i++
        continue
      }
    }
    if (d) {
      const run = open(i)
      if (repeat && d.length === 1) d = d.repeat(repeat)
      repeat = 0
      run.digits += d
      run.tokens.push(d)
      run.last = i
    } else if (cur && SAID_FILLERS.has(w)) {
      continue
    } else close()
  }
  close()
  return runs
}

/** A run said as a code: one 4-8 digit number, single digits (4 or more), or groups of 3-4; never a year or a version. */
function codeShaped(r: DigitRun): boolean {
  const t = r.tokens
  if (t.some((x) => YEAR.test(x))) return false
  return (t.length === 1 && t[0].length >= 4) || (t.length >= 4 && t.every((x) => x.length <= 2)) || (t.length >= 2 && t.every((x) => x.length === 3 || x.length === 4))
}

/** Every caption word in time order (guessed times where the caption has none). */
export function transcriptWords(transcript: Pick<Transcript, 'segments'> | null | undefined): CaptionWord[] {
  const out: CaptionWord[] = []
  for (const seg of transcript?.segments ?? []) out.push(...captionWordTimes(seg))
  return out.map((w, i) => ({ w, i })).sort((a, b) => a.w.start - b.w.start || a.i - b.i).map(({ w }) => w)
}

const hitOf = (words: readonly CaptionWord[], kind: PrivateKind, score: number, first: number, last: number, group: string): SaidHit => ({
  kind,
  score,
  start: words[first].start,
  end: words[last].end,
  estimated: words.slice(first, last + 1).some((w) => !!w.estimated),
  group,
  words: [first, last]
})

/** The group key of words said: their digit string for a number, else the words folded. */
const wordsKey = (words: readonly CaptionWord[], first: number, last: number): string =>
  'w:' + foldText(words.slice(first, last + 1).map((w) => saidWord(w.text)).join(' '))

/** Secrets said aloud in the captions (§7.2): cards, codes, phones, IDs, passwords, emails and listed names. */
export function detectSaid(transcript: Pick<Transcript, 'segments'> | null | undefined, options: { kinds: readonly PrivateKind[]; regions: readonly string[]; names: NameMatcher }): SaidHit[] {
  const kinds = new Set(options.kinds)
  const words = transcriptWords(transcript)
  if (!words.length) return []
  const found: SaidHit[] = []
  const contextOf = (i: number): string => {
    const t0 = words[i].start - CONTEXT_SECONDS
    const out: string[] = []
    for (let k = i - 1; k >= 0 && k >= i - CONTEXT_WORDS && words[k].start >= t0; k--) out.unshift(words[k].text.normalize('NFC'))
    return out.join(' ')
  }
  for (const r of digitRuns(words)) {
    const d = r.digits
    const context = contextOf(r.first)
    const said = (k: keyof typeof SAID_LABELS): boolean => SAID_LABELS[k].test(context)
    const group = 'd:' + d
    if (d.length >= 13 && d.length <= 19 && luhn(d) && cardNetwork(d)) found.push(hitOf(words, 'card', 0.96, r.first, r.last, group))
    else if (d.length >= 13 && d.length <= 19 && said('card')) found.push(hitOf(words, 'card', 0.85, r.first, r.last, group))
    else if (d.length >= 4 && d.length <= 8 && said('code') && codeShaped(r)) found.push(hitOf(words, 'code', 0.9, r.first, r.last, group))
    // An ID word is more particular than a phone word ("social security number"): IDs first.
    else if (d.length >= 6 && d.length <= 20 && said('id')) found.push(hitOf(words, 'id', 0.85, r.first, r.last, group))
    else if (d.length >= 7 && d.length <= 15 && (said('phone') || BD_MOBILE.test(d))) {
      // The same check as on screen (§6.8): valid for one of the regions, or a Bangladeshi mobile.
      const valid = validPhone(d, options.regions) || (BD_MOBILE.test(d) && validPhone(d.startsWith('880') ? d : '880' + d.replace(/^0/, ''), [], true))
      found.push(hitOf(words, 'phone', valid ? 0.92 : 0.85, r.first, r.last, group))
    }
  }
  // Emails said aloud: <1-4 words> at | at the rate <domain word> dot <tld word> [dot <tld word>].
  const bare = words.map((w) => saidWord(w.text))
  for (let i = 0; i < bare.length; i++) {
    let atLen = 0
    if (SAID_AT.has(bare[i])) atLen = 1
    if (bare[i] === 'at' && bare[i + 1] === 'the' && bare[i + 2] === 'rate') atLen = 3
    if (!atLen) continue
    let j = i + atLen
    if (j >= bare.length) continue
    j++ // the domain word
    let dots = 0
    while (j + 1 < bare.length && SAID_DOT.has(bare[j]) && SAID_TLDS.has(bare[j + 1])) {
      dots++
      j += 2
    }
    if (!dots) continue
    let first = i - 1
    // Up to 4 words before `at`, said without a pause (an address is said in one go).
    while (
      first - 1 >= 0 &&
      i - first < 4 &&
      words[first].start - words[first - 1].end <= PASSWORD_PAUSE &&
      (SAID_DOT.has(bare[first - 1]) || (SAID_ADDRESS_WORD.test(bare[first - 1]) && !SAID_ADDRESS_STOP.test(bare[first - 1])))
    )
      first--
    if (first < 0) continue
    found.push(hitOf(words, 'email', 0.9, first, j - 1, wordsKey(words, first, j - 1)))
  }
  // An address, key or token written as one word (Whisper writes `jsmith@gmail.com` as one token): the screen's rules, on
  // the word itself (punctuation off its ends), at the Auto tier only: a role or reserved address is a box on screen, but
  // muting speech for a stand-in costs more than it hides.
  const screenKinds = (['email', 'key', 'link'] as const).filter((k) => kinds.has(k))
  if (screenKinds.length) {
    words.forEach((w, i) => {
      const text = w.text.normalize('NFC').trim().replace(WORD_EDGES, '')
      if (!text.includes('@') && !/[A-Za-z0-9_-]{16,}/.test(text)) return
      const n = text.length
      const line = { box: [0, 0, n * 10, 20] as [number, number, number, number], quad: [], variants: [{ model: 'tiny' as const, text, conf: 1, spans: Array.from({ length: n }, (_v, k) => [k * 10, k * 10 + 10] as [number, number]) }], ring: '#000000', spread: 0 }
      const hits = detectFrame([line], [], { kinds: screenKinds, regions: [], names: NO_NAMES, frame: { width: n * 10 + 40, height: 40 } }).filter((h) => h.score >= AUTO_SCORE && h.spans.some((sp) => sp.start === 0 && sp.end === n))
      if (!hits.length) return
      const best = hits.sort((a, b) => b.score - a.score)[0]
      found.push(hitOf(words, best.kind, best.score, i, i, 'w:' + foldText(text)))
    })
  }
  // A password said after its word: "the password is hunter two", then up to 6 words, to a pause over 1 s or the sentence's end.
  for (let i = 0; i < words.length; i++) {
    if (!SAID_LABELS.password.test(words[i].text.normalize('NFC'))) continue
    let j = i + 1
    if (j >= words.length || !SAID_IS.has(bare[j])) continue
    while (j < words.length && SAID_IS.has(bare[j])) j++
    if (j >= words.length) continue
    let k = j
    while (k + 1 < words.length && k - j < 5 && words[k + 1].start - words[k].end <= PASSWORD_PAUSE && !SENTENCE_END.test(words[k].text)) k++
    found.push(hitOf(words, 'password', 0.9, j, k, wordsKey(words, j, k)))
  }
  if (kinds.has('name')) for (const h of saidNames(words, options.names)) found.push({ ...h, group: wordsKey(words, h.words[0], h.words[1]) })
  // Kinds on; a hit inside a larger one is dropped.
  const live = found.filter((h) => kinds.has(h.kind)).sort((a, b) => b.words[1] - b.words[0] - (a.words[1] - a.words[0]) || b.score - a.score)
  const kept: SaidHit[] = []
  for (const h of live) if (!kept.some((k) => k.words[0] <= h.words[0] && k.words[1] >= h.words[1])) kept.push(h)
  return kept.sort((a, b) => a.start - b.start || a.words[0] - b.words[0])
}

/** A group id: 10 characters of [a-z0-9] (§4.4). */
function groupId(random: () => number, taken: Set<string>): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (;;) {
    let s = ''
    for (let i = 0; i < 10; i++) s += abc[Math.floor(Math.min(0.999999, Math.max(0, random())) * abc.length)]
    if (!taken.has(s)) {
      taken.add(s)
      return s
    }
  }
}

interface Pending {
  start: number
  end: number
  kind: PrivateKind
  group: string
  hits: number
}

/**
 * The private bleeps of said hits (§7.2, §4.4): each from its first word's start − 0.05 s to its last
 * word's end + 0.05 s (0.15 s for guessed times), `auto`, its kind and group in its word; hits of one
 * said text share a group; a hit inside an existing bleep adds nothing. The total with `existing`
 * stays at or under MAX_BLEEPS: private bleeps of one group within 1 s are merged first, then across
 * groups, each merge only growing a bleep (it keeps the earlier group); the hits that still cannot be
 * placed are counted in `unplaced`, never dropped silently. Returns the new bleeps only.
 */
export function saidBleeps(hits: readonly SaidHit[], existing: readonly Bleep[] | undefined, random: () => number): { bleeps: Bleep[]; unplaced: number } {
  const have = existing ?? []
  const groups = new Map<string, string>()
  const used = new Set<string>()
  for (const b of have) {
    const g = privateGroupOf(b)
    if (g) used.add(g)
  }
  // One bleep a hit, those of one group that overlap joined.
  let list: Pending[] = []
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    const pad = h.estimated ? WIDEN_ESTIMATED : WIDEN
    const start = Math.max(0, h.start - pad)
    const end = h.end + pad
    if (!(end > start)) continue
    if (have.some((b) => b.start <= start + 1e-9 && b.end >= end - 1e-9)) continue
    let g = groups.get(h.group)
    if (!g) groups.set(h.group, (g = groupId(random, used)))
    const prev = list.find((p) => p.group === g && p.start <= end && start <= p.end)
    if (prev) {
      prev.start = Math.min(prev.start, start)
      prev.end = Math.max(prev.end, end)
      prev.hits++
    } else list.push({ start, end, kind: h.kind, group: g, hits: 1 })
  }
  list.sort((a, b) => a.start - b.start)
  const room = Math.max(0, MAX_BLEEPS - have.length)
  // Over the limit: merge neighbours within 1 s, those of one group first, the smallest gap first.
  for (const sameGroup of [true, false]) {
    while (list.length > room) {
      let best = -1
      let gap = Infinity
      for (let i = 0; i + 1 < list.length; i++) {
        const g = list[i + 1].start - list[i].end
        if ((sameGroup && list[i].group !== list[i + 1].group) || g > MERGE_GAP || g >= gap) continue
        best = i
        gap = g
      }
      if (best < 0) break
      const a = list[best]
      const b = list[best + 1]
      list.splice(best, 2, { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), kind: a.kind, group: a.group, hits: a.hits + b.hits })
    }
  }
  let unplaced = 0
  if (list.length > room) {
    // Keep the bleeps that place the most hits, the earliest first among equals.
    const keep = new Set([...list].sort((a, b) => b.hits - a.hits || a.start - b.start).slice(0, room))
    for (const p of list) if (!keep.has(p)) unplaced += p.hits
    list = list.filter((p) => keep.has(p))
  }
  const ids = new Set(have.map((b) => b.id))
  const bleeps = list.map((p): Bleep => {
    let id = `pb-${p.group}-${Math.round(p.start * 1000).toString(36)}`
    for (let n = 2; ids.has(id); n++) id = `pb-${p.group}-${Math.round(p.start * 1000).toString(36)}-${n}`
    ids.add(id)
    return { id, start: Math.floor(p.start * 1000) / 1000, end: Math.ceil(p.end * 1000) / 1000, word: privateBleepWord(p.kind, p.group), sound: 'tone', auto: true }
  })
  return { bleeps, unplaced }
}

/** Whether a bleep is one this module makes (a private bleep). */
export const isSaidBleep = (b: Pick<Bleep, 'word'>): boolean => isPrivateBleep(b)
