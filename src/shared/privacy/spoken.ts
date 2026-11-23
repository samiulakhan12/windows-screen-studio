/**
 * Secrets said aloud in every text made from captions (docs/design/auto-blur.md §7.3-7.5): the
 * spoken forms of the private bleeps, taken from each hit's own words (never from the padded span),
 * the masking of those forms, and privateView, the project as it is drawn and as it leaves Flown.
 * Pure; memoised per transcript and bleeps arrays and per project object.
 */
import type { Bleep, CaptionSegment, CaptionWord, Project } from '../types'
import { isPrivateBleep, privateGroupOf, privateKindOf } from './coverData'

export interface SpokenForms {
  /** Word and phrase forms, matched on word boundaries and case-insensitively. */
  readonly phrases: readonly string[]
  /** Digit forms with their usual written groupings, matched on the digit view. */
  readonly digits: readonly string[]
}

/** The widening a bleep got around its words: 0.05 s, or 0.15 s for estimated times (§7.2). */
const WIDEN = 0.05
const WIDEN_ESTIMATED = 0.15

/** A digit in any of five scripts (Latin, Bangla, Devanagari, Arabic-Indic, Extended Arabic-Indic) as 0-9, or -1. */
function digitOf(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  for (const zero of [0x09e6, 0x0966, 0x0660, 0x06f0]) if (c >= zero && c <= zero + 9) return c - zero
  return -1
}

/** Number words said one digit or one number at a time (§7.2): English, Bangla (both ways), Spanish and Hindi. */
const NUMBER_WORDS: ReadonlyMap<string, string> = new Map(
  [
    ['zero', '0'], ['oh', '0'], ['nought', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
    ['ten', '10'], ['eleven', '11'], ['twelve', '12'], ['thirteen', '13'], ['fourteen', '14'], ['fifteen', '15'], ['sixteen', '16'], ['seventeen', '17'], ['eighteen', '18'], ['nineteen', '19'],
    ['twenty', '20'], ['thirty', '30'], ['forty', '40'], ['fifty', '50'], ['sixty', '60'], ['seventy', '70'], ['eighty', '80'], ['ninety', '90'],
    ['শূন্য', '0'], ['এক', '1'], ['দুই', '2'], ['তিন', '3'], ['চার', '4'], ['পাঁচ', '5'], ['ছয়', '6'], ['সাত', '7'], ['আট', '8'], ['নয়', '9'],
    ['জিরো', '0'], ['ওয়ান', '1'], ['টু', '2'], ['থ্রি', '3'], ['ফোর', '4'], ['ফাইভ', '5'], ['সিক্স', '6'], ['সেভেন', '7'], ['এইট', '8'], ['নাইন', '9'],
    ['cero', '0'], ['uno', '1'], ['dos', '2'], ['tres', '3'], ['cuatro', '4'], ['cinco', '5'], ['seis', '6'], ['siete', '7'], ['ocho', '8'], ['nueve', '9'],
    ['शून्य', '0'], ['एक', '1'], ['दो', '2'], ['तीन', '3'], ['चार', '4'], ['पाँच', '5'], ['छह', '6'], ['सात', '7'], ['आठ', '8'], ['नौ', '9']
  ].map(([w, d]) => [w.normalize('NFC'), d] as [string, string])
)
const REPEAT: ReadonlyMap<string, number> = new Map([
  ['double', 2],
  ['triple', 3]
])

/** A word without the punctuation and symbols around it, NFC (vowel signs and the nukta kept). */
const bare = (w: string): string => w.normalize('NFC').replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')

/** The digits a word says (a digit token, a number word, "twenty-five"), or null. */
function wordDigits(word: string): string | null {
  const w = bare(word).toLowerCase()
  if (!w) return null
  let digits = ''
  let all = true
  for (const ch of w) {
    const d = digitOf(ch)
    if (d < 0 && ch !== '-' && ch !== '.') all = false
    else if (d >= 0) digits += String(d)
  }
  if (all && digits) return digits
  const named = NUMBER_WORDS.get(w)
  if (named) return named
  // "twenty-five", "forty two" written as one token.
  const parts = w.split('-')
  if (parts.length === 2) {
    const tens = NUMBER_WORDS.get(parts[0])
    const ones = NUMBER_WORDS.get(parts[1])
    if (tens && ones && tens.length === 2 && tens.endsWith('0') && ones.length === 1 && ones !== '0') return tens[0] + ones
  }
  return null
}

/** The digit string a run of own words says, or null when one of them is not a number. */
function runDigits(words: readonly string[]): string | null {
  let out = ''
  let repeat = 1
  for (let i = 0; i < words.length; i++) {
    const w = bare(words[i]).toLowerCase()
    const times = REPEAT.get(w)
    if (times) {
      repeat = times
      continue
    }
    let d = wordDigits(words[i])
    if (d === null) return null
    // "twenty five": a tens word then a ones word make one number.
    const next = i + 1 < words.length ? wordDigits(words[i + 1]) : null
    if (d.length === 2 && d.endsWith('0') && next && next.length === 1 && next !== '0' && NUMBER_WORDS.has(bare(words[i + 1]).toLowerCase())) {
      d = d[0] + next
      i++
    }
    out += repeat > 1 && d.length === 1 ? d.repeat(repeat) : d
    repeat = 1
  }
  return out || null
}

/** The usual written groupings of a digit string: 4-4-4-4, 3-3-4, 3-2-4 (and the string alone), spaced and dashed. */
function groupings(digits: string): string[] {
  const out = new Set<string>([digits])
  const group = (sizes: number[]): void => {
    if (sizes.reduce((s, n) => s + n, 0) !== digits.length) return
    const parts: string[] = []
    let at = 0
    for (const n of sizes) {
      parts.push(digits.slice(at, at + n))
      at += n
    }
    out.add(parts.join(' '))
    out.add(parts.join('-'))
  }
  if (digits.length % 4 === 0) group(Array.from({ length: digits.length / 4 }, () => 4))
  if (digits.length === 15) group([4, 6, 5])
  group([3, 3, 4])
  group([3, 2, 4])
  return [...out]
}

const AT_WORDS = new Set(['at', 'অ্যাট', 'এট', 'arroba', 'एट'].map((w) => w.normalize('NFC')))
const DOT_WORDS = new Set(['dot', 'ডট', 'punto', 'डॉट'].map((w) => w.normalize('NFC')))

/** An address said aloud ("jane.doe at example dot com") as written, or null. */
function saidAddress(words: readonly string[]): string | null {
  const ws = words.map((w) => bare(w))
  if (ws.length === 1 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ws[0])) return ws[0]
  let at = ws.findIndex((w) => AT_WORDS.has(w.toLowerCase()))
  let skip = 1
  // "at the rate"
  if (at > 0 && ws[at + 1]?.toLowerCase() === 'the' && ws[at + 2]?.toLowerCase() === 'rate') skip = 3
  if (at <= 0) return null
  const name = ws.slice(0, at).join('')
  const domain = ws.slice(at + skip)
  if (!domain.length || !domain.some((w) => DOT_WORDS.has(w.toLowerCase()))) return null
  let host = ''
  for (const w of domain) host += DOT_WORDS.has(w.toLowerCase()) ? '.' : w
  at = host.indexOf('.')
  return name && at > 0 && !host.endsWith('.') ? `${name}@${host}` : null
}

/** A caption word is one of a private bleep's own words when its middle lies inside the bleep shrunk back by its widening. */
function ownWords(bleep: Bleep, segments: readonly CaptionSegment[]): CaptionWord[] {
  const out: CaptionWord[] = []
  for (const seg of segments) {
    if (seg.end < bleep.start - 1 || seg.start > bleep.end + 1) continue
    for (const w of seg.words ?? []) {
      const shrink = w.estimated ? WIDEN_ESTIMATED : WIDEN
      const mid = (w.start + w.end) / 2
      if (mid >= bleep.start + shrink - 1e-9 && mid <= bleep.end - shrink + 1e-9) out.push(w)
    }
  }
  return out
}

const NO_FORMS: SpokenForms = Object.freeze({ phrases: Object.freeze([]), digits: Object.freeze([]) })
const formsCache = new WeakMap<readonly Bleep[], { segments: readonly CaptionSegment[]; forms: SpokenForms | null }>()

/**
 * The spoken forms of the project's private bleeps (§7.3), once per transcript and bleeps arrays, or
 * null without private bleeps. Each group's own words (in time order) give one form: a number run
 * its digit string and groupings (never its number words), an address said aloud as written, any
 * other hit the whole phrase as written and folded.
 */
export function spokenForms(project: Pick<Project, 'transcript' | 'bleeps'>): SpokenForms | null {
  const bleeps = project.bleeps
  if (!bleeps?.length || !bleeps.some(isPrivateBleep)) return null
  const segments = project.transcript?.segments ?? []
  const hit = formsCache.get(bleeps)
  if (hit && hit.segments === segments) return hit.forms
  const groups = new Map<string, Bleep[]>()
  let lone = 0
  for (const b of bleeps) {
    if (!isPrivateBleep(b)) continue
    const key = privateGroupOf(b) ?? `#${lone++}`
    groups.set(key, [...(groups.get(key) ?? []), b])
  }
  const phrases = new Set<string>()
  const digits = new Set<string>()
  for (const list of groups.values()) {
    const words = list
      .flatMap((b) => ownWords(b, segments))
      .sort((a, b) => a.start - b.start)
      .filter((w, i, all) => i === 0 || w !== all[i - 1])
      .map((w) => w.text)
      .filter((w) => bare(w))
    if (!words.length) continue
    const kind = privateKindOf(list[0])
    const number = kind === 'email' || kind === 'name' || kind === 'password' ? null : runDigits(words)
    if (number) {
      for (const g of groupings(number)) digits.add(g)
      continue
    }
    const address = kind === 'email' || words.length === 1 ? saidAddress(words) : null
    if (address) phrases.add(address)
    if (address && kind === 'email' && words.length > 1) {
      phrases.add(words.join(' '))
      continue
    }
    phrases.add(words.join(' '))
    const folded = words.map((w) => bare(w)).join(' ')
    if (folded) phrases.add(folded)
  }
  const forms: SpokenForms = phrases.size || digits.size ? Object.freeze({ phrases: Object.freeze([...phrases]), digits: Object.freeze([...digits]) }) : NO_FORMS
  formsCache.set(bleeps, { segments, forms })
  return forms
}

/** `text` with '•' for each letter and digit (marks dropped with their letter), spaces and punctuation kept. */
export function maskChars(text: string): string {
  return text.replace(/[\p{L}\p{N}][\p{M}]*/gu, '•').replace(/\p{M}/gu, '')
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const compiled = new WeakMap<SpokenForms, { phrase: RegExp | null; digits: ReadonlySet<string>; short: ReadonlySet<string> }>()

function matcherOf(forms: SpokenForms): { phrase: RegExp | null; digits: ReadonlySet<string>; short: ReadonlySet<string> } {
  const hit = compiled.get(forms)
  if (hit) return hit
  const alternatives = [...forms.phrases]
    .filter((p) => p.trim())
    .sort((a, b) => b.length - a.length)
    .map((p) =>
      p
        .trim()
        .split(/\s+/)
        .map((w) => escape(w.normalize('NFC')))
        .join('\\s+')
    )
  // Word and phrase forms on word boundaries only: never inside a longer word ("weight", "fourteen").
  const phrase = alternatives.length ? new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}\\p{M}])`, 'giu') : null
  const digits = new Set<string>()
  const short = new Set<string>()
  for (const d of forms.digits) {
    let only = ''
    for (const ch of d) if (digitOf(ch) >= 0) only += String(digitOf(ch))
    if (!only) continue
    if (only.length < 4) short.add(only)
    else digits.add(only)
  }
  const m = { phrase, digits, short }
  compiled.set(forms, m)
  return m
}

/** A space, a dash or a no-break space between the digits of one number. */
const SEP = /^[\s \-‐‑‒–—]$/u

/**
 * `text` with every occurrence of a spoken form masked (§7.3): '•' for each letter and digit, spaces
 * and punctuation kept. Phrase forms match on word boundaries, case-insensitively; digit forms on the
 * digit view (spaces and dashes between digits ignored) and only as a whole digit run, never part of
 * a longer one; a form of fewer than 4 digits only as a whole word. `text` itself when nothing matched.
 */
export function maskPrivate(text: string, forms: SpokenForms | null): string {
  if (!text || !forms || (!forms.phrases.length && !forms.digits.length)) return text
  const m = matcherOf(forms)
  let out = text.normalize('NFC')
  let changed = false
  if (m.phrase) {
    out = out.replace(m.phrase, (hit) => {
      changed = true
      return maskChars(hit)
    })
  }
  if (m.digits.size || m.short.size) {
    const chars = [...out]
    let i = 0
    while (i < chars.length) {
      if (digitOf(chars[i]) < 0) {
        i++
        continue
      }
      // A run: digits joined by at most two spaces or dashes between each.
      const start = i
      let end = i + 1
      let digits = String(digitOf(chars[i]))
      let j = end
      for (;;) {
        let k = j
        let gap = 0
        while (k < chars.length && SEP.test(chars[k]) && gap < 2) {
          k++
          gap++
        }
        if (k < chars.length && digitOf(chars[k]) >= 0) {
          digits += String(digitOf(chars[k]))
          end = k + 1
          j = end
          continue
        }
        break
      }
      const before = start > 0 ? chars[start - 1] : ''
      const after = end < chars.length ? chars[end] : ''
      const wordEdge = !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)
      if (m.digits.has(digits) || (m.short.has(digits) && wordEdge)) {
        for (let k = start; k < end; k++) if (digitOf(chars[k]) >= 0) chars[k] = '•'
        changed = true
      }
      i = end
    }
    if (changed) out = chars.join('')
  }
  return changed ? out : text
}

/** The sorted ids of the private bleeps over caption `segmentId`, joined by ',' (a translated segment's maskedFor, §7.4); '' for none. */
export function maskedForOf(project: Pick<Project, 'transcript' | 'bleeps'>, segmentId: string): string {
  const seg = project.transcript?.segments.find((s) => s.id === segmentId)
  if (!seg || !project.bleeps?.length) return ''
  return project.bleeps
    .filter((b) => isPrivateBleep(b) && b.end > seg.start && b.start < seg.end)
    .map((b) => b.id)
    .sort()
    .join(',')
}

/**
 * A translated segment's text as it is shown and exported (§7.4): masked whole ('•' for each letter
 * and digit, spaces kept) when its spoken caption lies under a private bleep, unless it was
 * translated from the masked text (its maskedFor equals the bleeps over the caption now).
 */
export function trackText(project: Pick<Project, 'transcript' | 'bleeps'>, segment: { id: string; text: string; maskedFor?: string }): string {
  if (!project.bleeps?.some(isPrivateBleep)) return segment.text
  const over = maskedForOf(project, segment.id)
  if (!over || segment.maskedFor === over) return segment.text
  return maskChars(segment.text)
}

/** The stored texts made from, or typed beside, captions that the private view masks (§7.5). */
export const PRIVATE_TEXT_FIELDS: readonly string[] = Object.freeze([
  'chapters[].title',
  'titles[].title',
  'titles[].subtitle',
  'publish.description',
  'guide.title',
  'guide.intro',
  'guide.expected',
  'guide.actual',
  'guide.details[].text',
  'guide.steps[]',
  'guide.added[]'
])

/** Fields of a guide step that are identifiers, not words: never masked. */
const STEP_IDS = new Set(['key', 'ai', 'textAi'])

const views = new WeakMap<object, Project>()

/**
 * The project as it is drawn and as it leaves Flown (§7.5, question 19 (a)): a copy whose texts of
 * PRIVATE_TEXT_FIELDS have the spoken forms masked. `project` itself without private bleeps or when no
 * field holds a form; the same object for the same project. The stored project never changes.
 */
export function privateView<P extends Project>(project: P): P {
  const hit = views.get(project)
  if (hit) return hit as P
  const forms = spokenForms(project)
  let out: P = project
  if (forms && (forms.phrases.length || forms.digits.length)) {
    const mask = (s: string | undefined): string | undefined => (typeof s === 'string' ? maskPrivate(s, forms) : s)
    const patch: Partial<Project> = {}
    if (project.chapters?.some((c) => mask(c.title) !== c.title)) patch.chapters = project.chapters.map((c) => (mask(c.title) === c.title ? c : { ...c, title: mask(c.title)! }))
    if (project.titles?.some((c) => mask(c.title) !== c.title || mask(c.subtitle) !== c.subtitle))
      patch.titles = project.titles.map((c) => {
        const title = mask(c.title)!
        const subtitle = mask(c.subtitle)
        return title === c.title && subtitle === c.subtitle ? c : { ...c, title, ...(subtitle !== undefined ? { subtitle } : {}) }
      })
    if (project.publish && typeof project.publish.description === 'string' && mask(project.publish.description) !== project.publish.description) patch.publish = { ...project.publish, description: mask(project.publish.description)! }
    const g = project.guide
    if (g) {
      const maskStrings = <T extends object>(o: T): T => {
        let changed = false
        const copy = { ...o } as Record<string, unknown>
        for (const [k, v] of Object.entries(o)) {
          if (typeof v !== 'string' || STEP_IDS.has(k)) continue
          const m = maskPrivate(v, forms)
          if (m !== v) {
            copy[k] = m
            changed = true
          }
        }
        return changed ? (copy as T) : o
      }
      const next = {
        ...g,
        ...(g.title !== undefined ? { title: mask(g.title) } : {}),
        ...(g.intro !== undefined ? { intro: mask(g.intro) } : {}),
        ...(g.expected !== undefined ? { expected: mask(g.expected) } : {}),
        ...(g.actual !== undefined ? { actual: mask(g.actual) } : {}),
        ...(g.details ? { details: g.details.map((d) => (mask(d.text) === d.text ? d : { ...d, text: mask(d.text)! })) } : {}),
        ...(g.steps ? { steps: g.steps.map(maskStrings) } : {}),
        ...(g.added ? { added: g.added.map(maskStrings) } : {})
      }
      const same =
        next.title === g.title &&
        next.intro === g.intro &&
        next.expected === g.expected &&
        next.actual === g.actual &&
        (!g.details || next.details!.every((d, i) => d === g.details![i])) &&
        (!g.steps || next.steps!.every((d, i) => d === g.steps![i])) &&
        (!g.added || next.added!.every((d, i) => d === g.added![i]))
      if (!same) patch.guide = next
    }
    if (Object.keys(patch).length) out = { ...project, ...patch }
  }
  views.set(project, out)
  return out
}
