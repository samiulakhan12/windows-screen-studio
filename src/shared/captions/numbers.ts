/**
 * Numbers in captions (docs/design/captions-studio.md §11.4): statistics for counters, and
 * spelled-out numbers. Pure: word spans index studioWordTexts (§8.1), and a value is always read
 * here from the user's own words, never taken from an AI answer (§11.2 rule 4).
 */
import type { CaptionSegment } from '../types'
import { NUMBER_WORDS } from './numberData'
import { studioWordTexts } from './words'

/* ---------- digits ---------- */

/** The zero of each digit script read (Latin, Bengali, Devanagari, Arabic-Indic, Eastern Arabic-Indic). */
const ZEROS = [0x30, 0x9e6, 0x966, 0x660, 0x6f0]
const ALL_DIGITS = /[0-9০-৯०-९٠-٩۰-۹]/gu

/** A digit of a script read (ALL_DIGITS without its global flag, for a test). */
const ANY_DIGIT = /[0-9০-৯०-९٠-٩۰-۹]/u
/** Digits other than 0–9: most words have none, and those are returned as they are. */
const OTHER_DIGITS = /[০-৯०-९٠-٩۰-۹]/u

/** `text` with every digit as 0–9 (digit for digit). */
export function asciiDigits(text: string): string {
  if (!OTHER_DIGITS.test(text)) return text
  return text.replace(ALL_DIGITS, (ch) => {
    const c = ch.codePointAt(0)!
    for (const z of ZEROS) if (c >= z && c <= z + 9) return String(c - z)
    return ch
  })
}

/* ---------- word lists (team-written, §11.4) ---------- */

/** The base language last read: a run asks for one language for every word. */
let lastBase: { language: string | undefined; base: string } | null = null
const baseLanguage = (language: string | undefined): string => {
  if (!lastBase || lastBase.language !== language) lastBase = { language, base: (language ?? 'en').toLowerCase().split(/[-_]/)[0] }
  return lastBase.base
}
/** Bare forms made (speech repeats its words, and every rule asks for them). */
const bareForms = new Map<string, string>()
/** A word as compared with the lists: lower case, punctuation off both ends. */
export const bareWord = (w: string): string => {
  let bare = bareForms.get(w)
  if (bare === undefined) {
    if (bareForms.size >= 20000) bareForms.clear()
    bareForms.set(w, (bare = w.toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')))
  }
  return bare
}
/** Sentence and clause marks after a word. */
const TRAILING = /[.,!?;:…।)"”'’\]]+$/u

/** Currency signs written before (or after) the digits. */
const CURRENCY_SIGN = /[$€£¥₹৳]/u
/** Currency words after a number. */
const CURRENCY_WORDS = new Set([
  'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'rupee', 'rupees', 'taka', 'yen', 'bucks',
  'টাকা', 'ডলার', 'রুপি', 'ইউরো', 'रुपये', 'रुपए', 'रुपया', 'डॉलर', 'यूरो',
  'dólares', 'pesos', 'reais'
])
/** Percent words: the suffix becomes "%". */
const PERCENT_WORDS = new Set(['percent', 'pct', 'শতাংশ', 'শতকরা', 'प्रतिशत', 'फीसदी', 'prozent', 'procent', 'процентов', 'процента'])
/** Two-word percent phrases. */
const PERCENT_PAIRS = new Set(['per cent', 'por ciento', 'pour cent', 'por cento', 'per cento'])
/** Magnitudes after a number. */
const MAGNITUDE_WORDS = new Set([
  'thousand', 'million', 'millions', 'billion', 'billions', 'trillion', 'lakh', 'lakhs', 'crore', 'crores',
  'হাজার', 'লাখ', 'লক্ষ', 'কোটি', 'हज़ार', 'हजार', 'लाख', 'करोड़', 'करोड',
  'mil', 'millón', 'millones', 'mille', 'milliards', 'milliard', 'tausend', 'millionen', 'milliarden', 'milhões', 'milhão', 'bilhões'
])
/** "times", as the suffix ×. */
const TIMES_WORDS = new Set(['times', 'fold', 'গুণ', 'গুন', 'गुना', 'veces', 'fois', 'vezes'])

/** Units of measure: a number with one is an instruction or a setting, never a counter (§11.4). */
const MEASURE_WORDS = new Set([
  'px', 'pixel', 'pixels', 'pt', 'pts', 'em', 'ems', 'ms', 'millisecond', 'milliseconds', 'second', 'seconds', 'sec', 'secs', 'minute', 'minutes', 'min', 'mins',
  'hour', 'hours', 'hr', 'hrs', 'day', 'days', 'week', 'weeks', 'fps', 'hz', 'khz', 'kb', 'mb', 'gb', 'tb', 'cm', 'mm', 'inch', 'inches', 'dpi', 'degree', 'degrees',
  'সেকেন্ড', 'মিনিট', 'ঘণ্টা', 'ঘন্টা', 'দিন', 'পিক্সেল', 'सेकंड', 'मिनट', 'घंटे', 'घंटा', 'दिन', 'पिक्सेल',
  'segundos', 'minutos', 'horas', 'secondes', 'heures', 'sekunden', 'minuten', 'stunden', 'píxeles'
])
/** Words before a number that make it a label or a version ("step 3", "version 2", "Ctrl 5"). */
const LABEL_WORDS = new Set([
  'version', 'v', 'step', 'chapter', 'page', 'line', 'ctrl', 'control', 'alt', 'shift', 'level', 'part', 'episode', 'season', 'lesson', 'module', 'slide', 'row', 'column', 'item', 'number', 'no', 'room', 'tab',
  'ধাপ', 'অধ্যায়', 'পৃষ্ঠা', 'লাইন', 'পর্ব', 'সংস্করণ', 'चरण', 'अध्याय', 'पृष्ठ', 'पेज', 'लाइन', 'संस्करण', 'भाग',
  'paso', 'capítulo', 'página', 'étape', 'chapitre', 'schritt', 'kapitel', 'seite', 'passo'
])
/** Words that state a change around a number (§11.4). */
const CHANGE_WORDS = new Set([
  'grew', 'grow', 'grows', 'growing', 'growth', 'increased', 'increase', 'increases', 'rose', 'risen', 'doubled', 'tripled', 'quadrupled', 'dropped', 'drop', 'drops', 'fell', 'fallen',
  'cut', 'saved', 'gained', 'jumped', 'soared', 'boosted', 'reduced', 'decreased', 'declined', 'shrank', 'climbed',
  'বেড়েছে', 'বেড়ে', 'বাড়িয়েছে', 'কমেছে', 'কমে', 'কমিয়েছে', 'बढ़ा', 'बढ़ी', 'बढ़े', 'बढ़कर', 'घटा', 'घटी', 'घटे', 'घटकर',
  'creció', 'aumentó', 'subió', 'bajó', 'cayó', 'augmenté', 'baissé', 'gestiegen', 'gesunken', 'cresceu', 'aumentou', 'caiu'
])
/** The word before "by" in "up by", "down by", "grew by" (§11.4). */
const BY_CHANGE = new Set(['up', 'down', 'increased', 'decreased', 'grew', 'rose', 'fell', 'dropped', 'cut', 'reduced'])
/** "from X to Y": the word before X and the word between them. */
const FROM_WORDS = new Set(['from', 'de', 'desde', 'von', 'da'])
const TO_WORDS = new Set(['to', 'a', 'à', 'hasta', 'auf', 'bis', 'para'])
/** Bangla and Hindi put "from" after X: "২০ থেকে ৮০", "20 से 80". */
const FROM_AFTER = new Set(['থেকে', 'হতে', 'से'])
/** Words never taken as a counter's label. */
const NOT_LABEL = new Set([
  'to', 'the', 'and', 'of', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'than', 'more', 'less', 'per', 'a', 'an', 'or', 'is', 'are', 'was', 'were', 'this', 'that', 'it', 'up', 'down',
  'over', 'into', 'about', 'but', 'so', 'which', 'who', 'we', 'you', 'they', 'our', 'your', 'their', 'its', 'now', 'then', 'last', 'next', 'year', 'month', 'years', 'months'
])

/** Languages that write a decimal comma (1,5) and group with dots or spaces. */
const COMMA_DECIMAL = new Set(['de', 'fr', 'es', 'pt', 'it', 'nl', 'ru', 'uk', 'pl', 'tr', 'id', 'vi', 'sv', 'da', 'no', 'nb', 'fi', 'cs', 'ro', 'hu', 'el', 'bg'])

/* ---------- spelled-out numbers ---------- */

const EN_SMALL: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
}
const EN_SCALES: Readonly<Record<string, number>> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, lakh: 1e5, crore: 1e7 }
/** Team-written spellings beside CLDR's words. */
const EXTRA: Readonly<Record<'bn' | 'hi', { words: Readonly<Record<string, number>>; hundreds: readonly string[]; scales: Readonly<Record<string, number>> }>> = {
  bn: { words: { দু: 2 }, hundreds: ['শ', 'শত'], scales: { লক্ষ: 1e5 } },
  hi: { words: {}, hundreds: [], scales: { हजार: 1e3, करोड: 1e7 } }
}

const ENDS_CLAUSE = /[.!?,;:…।]["'”’)\]]*$/u

/** Whether `table` has the word `w` itself: never a name every object has, such as "constructor". */
const has = (table: Readonly<Record<string, number>>, w: string): boolean => Object.hasOwn(table, w)
/** A word's value in `table`, or undefined. */
const valueIn = (table: Readonly<Record<string, number>>, w: string): number | undefined => (has(table, w) ? table[w] : undefined)

/** A word that can begin or go on with an English number (the parse below stops at any other). */
const enNumberish = (w: string): boolean => has(EN_SMALL, w) || has(EN_SCALES, w) || w === 'hundred' || w === 'a' || w === 'an' || w === 'and'

/** Whether an English number can begin with this bare word (its part before a hyphen); a word of punctuation alone is read past. */
function beginsEnglish(bare: string): boolean {
  const cut = bare.indexOf('-')
  const head = cut < 0 ? bare : bare.slice(0, cut)
  return !head || has(EN_SMALL, head) || head === 'a' || head === 'an'
}

/** The units an English ordinal after a tens word ends in ("twenty first"); not "second", which is also a unit of time ("a thirty second clip"). */
const EN_ORDINAL_UNITS = new Set(['first', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'])

/**
 * English: "twenty five", "twenty-five", "one hundred and five", "a thousand", "nineteen hundred".
 * One number only: a number word joins at the start, after "hundred" or a scale, or a unit after a
 * tens word ("twenty five"); "and" only after "hundred" or a scale. Numbers said one after the
 * other ("nineteen ninety nine", "five six seven", "twenty twenty four") and an ordinal said in
 * two words ("twenty first") give none: they are never added up. A word only partly made of
 * number words ("twenty-first", "nine-to-five") is never read.
 */
function parseEnglish(words: readonly string[]): { value: number; used: number } | null {
  // A first word that cannot begin a number (most words: a caption is parsed from each of them)
  // gives none. A word of punctuation alone is read past, as below.
  if (!beginsEnglish(bareWord(words[0] ?? ''))) return null
  const parts: { w: string; end: boolean; index: number }[] = []
  for (let k = 0; k < words.length && parts.length < 40; k++) {
    const end = ENDS_CLAUSE.test(words[k])
    const pieces = bareWord(words[k]).split('-').filter(Boolean)
    // The words after one that is no number word are never read: a caption is parsed from each of
    // its words, and reading on to the clause's end (up to 40 words) read each word many times.
    if (!pieces.every(enNumberish)) break
    pieces.forEach((w, j) => parts.push({ w, end: end && j === pieces.length - 1, index: k }))
    if (end) break
  }
  let total = 0
  let group = 0
  let used = 0
  let any = false
  // What the last number word was: nothing yet, a unit (1–9, zero, "a"), a teen or ten, a tens
  // word, "hundred", or a scale.
  let last: 'start' | 'unit' | 'teen' | 'tens' | 'hundred' | 'scale' = 'start'
  for (let i = 0; i < parts.length; i++) {
    const { w, end, index } = parts[i]
    const next = parts[i + 1]?.w
    if (has(EN_SMALL, w)) {
      const v = EN_SMALL[w]
      const kind = v >= 20 ? 'tens' : v >= 10 ? 'teen' : 'unit'
      const joins = last === 'start' || last === 'hundred' || last === 'scale' || (last === 'tens' && kind === 'unit' && v > 0)
      // Two numbers said one after the other: none.
      if (!joins) return null
      group += v
      last = kind
    } else if (w === 'hundred' && (last === 'unit' || last === 'teen' || last === 'tens')) {
      group = group * 100
      last = 'hundred'
    } else if (has(EN_SCALES, w) && last !== 'start' && last !== 'scale') {
      total += group * EN_SCALES[w]
      group = 0
      last = 'scale'
    } else if ((w === 'a' || w === 'an') && !any && next && (next === 'hundred' || has(EN_SCALES, next))) {
      group = 1
      any = true
      last = 'unit'
      continue
    } else if (w === 'and' && (last === 'hundred' || last === 'scale') && next && has(EN_SMALL, next)) continue
    else break
    any = true
    used = index + 1
    if (end) break
  }
  // "twenty first", "forty fifth": an ordinal, not 20 and a word.
  if (last === 'tens' && used && !ENDS_CLAUSE.test(words[used - 1]) && EN_ORDINAL_UNITS.has(bareWord(words[used] ?? ''))) return null
  return any && used ? { value: total + group, used } : null
}

/**
 * Bangla and Hindi from CLDR's tables: "তিনশো", "দুই হাজার", "तीन सौ", "पाँच लाख". One number only,
 * as in English: a word for 0–99 joins at the start or after a hundred or a scale; numbers said one
 * after the other ("এক দুই তিন") give none.
 */
function parseTable(words: readonly string[], lang: 'bn' | 'hi'): { value: number; used: number } | null {
  const t = NUMBER_WORDS[lang]
  const extra = EXTRA[lang]
  const small = (w: string): number | undefined => valueIn(t.words, w) ?? valueIn(extra.words, w)
  const scale = (w: string): number | undefined => valueIn(t.scales, w) ?? valueIn(extra.scales, w)
  const hundreds = [t.hundred.word, ...extra.hundreds]
  let total = 0
  let group = 0
  let used = 0
  let any = false
  let last: 'start' | 'small' | 'hundred' | 'scale' = 'start'
  for (let k = 0; k < words.length; k++) {
    const w = bareWord(words[k])
    let v = small(w)
    let fused = false
    // A hundred written onto its multiplier: তিনশো, দুইশ.
    if (v === undefined)
      for (const h of hundreds)
        if (w.length > h.length && w.endsWith(h) && small(w.slice(0, -h.length)) !== undefined) {
          v = small(w.slice(0, -h.length))! * 100
          fused = true
          break
        }
    if (v !== undefined) {
      // Two numbers said one after the other: none.
      if (!(last === 'start' || last === 'scale' || (last === 'hundred' && !fused))) return null
      group += v
      last = fused ? 'hundred' : 'small'
    } else if (hundreds.includes(w) && last === 'small') {
      group = group * 100
      last = 'hundred'
    } else if (scale(w) !== undefined && (last === 'small' || last === 'hundred')) {
      total += group * scale(w)!
      group = 0
      last = 'scale'
    } else break
    any = true
    used = k + 1
    if (ENDS_CLAUSE.test(words[k])) break
  }
  return any ? { value: total + group, used } : null
}

/** A spelled-out number at the start of `words` ("twenty five"), and how many words it used. */
export function parseNumberWords(words: readonly string[], language?: string): { value: number; used: number } | null {
  if (!words.length) return null
  const lang = baseLanguage(language)
  if (lang === 'bn' || lang === 'hi') return parseTable(words, lang) ?? parseEnglish(words)
  return parseEnglish(words)
}

/* ---------- numbers written with digits ---------- */

interface DigitNumber {
  value: number
  decimals: 0 | 1 | 2
  prefix: string
  /** The unit written onto the number (% x × k K M B), or ''. */
  unit: string
  /** Digits alone: no sign, unit, grouping or decimals. */
  plain: boolean
}

/** A word written as a number: an optional currency sign, digits with grouping, an optional unit. */
function digitNumber(word: string, language: string | undefined): DigitNumber | null {
  // Most words have no digit, and a number needs one.
  if (!ANY_DIGIT.test(word)) return null
  const core = asciiDigits(word).replace(/^[("“'‘[]+/u, '').replace(TRAILING, '')
  const m = /^([$€£¥₹৳])?(\d[\d.,]*)([$€£¥₹৳]|%|x|×|k|K|M|B|bn)?$/u.exec(core)
  if (!m) return null
  const sign = m[1] ?? (m[3] && CURRENCY_SIGN.test(m[3]) ? m[3] : '')
  const unit = m[3] && !CURRENCY_SIGN.test(m[3]) ? (m[3] === 'x' ? '×' : m[3]) : ''
  const commaDecimal = COMMA_DECIMAL.has(baseLanguage(language))
  const parts = m[2].split(commaDecimal ? ',' : '.')
  if (parts.length > 2) return null
  // Groups of three (or India's twos) after the first; a version like 2.0.1 is not a number.
  const whole = parts[0].split(commaDecimal ? '.' : ',')
  if (whole.some((g, i) => !g || (i > 0 && !/^\d{2,3}$/.test(g)))) return null
  const fraction = parts[1] ?? ''
  if (parts.length === 2 && !/^\d+$/.test(fraction)) return null
  const value = Number(whole.join('') + (fraction ? '.' + fraction : ''))
  if (!Number.isFinite(value)) return null
  return { value, decimals: Math.min(2, fraction.length) as 0 | 1 | 2, prefix: sign, unit, plain: !sign && !unit && whole.length === 1 && !fraction }
}

/** Whether a word is written as a number (any digit script, with a sign, grouping or unit). */
export function isNumberWord(word: string, language?: string): boolean {
  return digitNumber(word, language) !== null
}

/** Whether a number word is a year 1900–2100 written alone. */
export function isYearWord(word: string): boolean {
  const n = digitNumber(word, undefined)
  return !!n && n.plain && n.value >= 1900 && n.value <= 2100
}

/** Whether the word before a number makes it a label ("version 2", "step 3", "Ctrl 5"). */
export function isLabelWord(word: string): boolean {
  return LABEL_WORDS.has(bareWord(word))
}

/** A time ("10:30"), a phone number or a code with dashes: never a counter. */
const NOT_A_NUMBER = /^\d{1,2}:\d{2}|^\+?\d[\d-]{6,}\d$|^\d+(-\d+)+$/u

export interface FoundNumber {
  /** Word indexes (studioWordTexts) of the number and its unit. */
  from: number
  to: number
  value: number
  /** What a counter counts from ("from 20 to 80"); absent: 0. */
  start?: number
  decimals: 0 | 1 | 2
  prefix: string
  suffix: string
  /** The noun after the number ("users"). */
  label?: string
  /** A counter is made only for a statistic (§11.4). */
  statistic: boolean
}

/** The numbers of a caption (word spans), with what a counter needs and whether each is a statistic. */
export function findNumbers(seg: CaptionSegment, language?: string): FoundNumber[] {
  const words = studioWordTexts(seg.text, language)
  const bare = words.map(bareWord)
  const lang = baseLanguage(language)
  const commaDecimal = COMMA_DECIMAL.has(lang)
  const out: FoundNumber[] = []
  let i = 0
  while (i < words.length) {
    if (NOT_A_NUMBER.test(asciiDigits(words[i]))) {
      i++
      continue
    }
    let num = digitNumber(words[i], language)
    let last = i
    let spelled = false
    if (num) {
      // Space grouping (1 000 000) where the language writes it.
      const grouping = commaDecimal && num.plain
      while (grouping && last + 1 < words.length && /^\d{3}$/.test(asciiDigits(words[last + 1]).replace(TRAILING, ''))) {
        const joined = digitNumber(words.slice(i, last + 2).join('.'), language)
        if (!joined) break
        num = { ...joined, plain: false }
        last++
      }
    } else {
      const w = lang === 'bn' || lang === 'hi' || beginsEnglish(bare[i]) ? parseNumberWords(words.slice(i), language) : null
      // A lone "one", "a" or "an" is no number worth a counter.
      if (w && !(w.used === 1 && /^(a|an|one)$/.test(bare[i]))) {
        num = { value: w.value, decimals: 0, prefix: '', unit: '', plain: true }
        last = i + w.used - 1
        spelled = true
      } else if (!w && parseNumberWords([words[i]], language)) {
        // Numbers said one after the other ("nineteen ninety nine"): none of them is a counter.
        while (i + 1 < words.length && !ENDS_CLAUSE.test(words[i]) && parseNumberWords([words[i + 1]], language)) i++
      }
    }
    if (!num) {
      i++
      continue
    }
    const found = describe(words, bare, i, last, num, spelled)
    out.push(found)
    i = found.to + 1
  }
  return mergeRanges(out, bare)
}

/** One number with its unit, magnitude, currency and label, and whether it is a statistic. */
function describe(words: readonly string[], bare: readonly string[], from: number, last: number, num: DigitNumber, spelled: boolean): FoundNumber {
  let to = last
  let suffix = num.unit
  const prefix = num.prefix
  const written = (k: number): string => (words[k] ?? '').replace(TRAILING, '')
  const after = (): string => bare[to + 1] ?? ''
  let unitWord = false
  if (!suffix && PERCENT_WORDS.has(after())) {
    suffix = '%'
    to++
    unitWord = true
  } else if (!suffix && PERCENT_PAIRS.has(`${after()} ${bare[to + 2] ?? ''}`)) {
    suffix = '%'
    to += 2
    unitWord = true
  } else if (!suffix && MAGNITUDE_WORDS.has(after())) {
    suffix = ` ${written(to + 1)}`
    to++
    unitWord = true
  } else if (!suffix && TIMES_WORDS.has(after())) {
    suffix = '×'
    to++
    unitWord = true
  }
  let currency = !!prefix
  // A sign written after the number as its own word ("1.250,5 €").
  if (!prefix && /^[$€£¥₹৳]$/u.test(written(to + 1))) {
    suffix += ` ${written(to + 1)}`
    to++
    currency = true
  } else if (CURRENCY_WORDS.has(after())) {
    if (!prefix) suffix += ` ${written(to + 1)}`
    to++
    currency = true
  }
  const measure = MEASURE_WORDS.has(after())
  const before = bare[from - 1] ?? ''
  const label = LABEL_WORDS.has(before)
  const year = num.plain && !spelled && Number.isInteger(num.value) && num.value >= 1900 && num.value <= 2100 && !suffix && !currency
  // A change stated around it: a change word in the 4 words before or the word after, or "up by".
  let change = CHANGE_WORDS.has(after())
  for (let k = Math.max(0, from - 4); k < from; k++) if (CHANGE_WORDS.has(bare[k])) change = true
  if (before === 'by' && BY_CHANGE.has(bare[from - 2] ?? '')) change = true
  let statistic = !!suffix || currency || unitWord || change
  // Measures, labels and years never count, nor plain numbers under 10 (§11.4).
  if (measure || label || year) statistic = false
  if (!suffix && !currency && num.value < 10) statistic = false
  // The noun after it ("users").
  let noun: string | undefined
  const next = words[to + 1]
  if (next && !measure) {
    const clean = next.replace(TRAILING, '')
    const b = bareWord(clean)
    if (/^\p{L}[\p{L}\p{M}]*$/u.test(clean) && [...clean].length >= 3 && !NOT_LABEL.has(b) && !CHANGE_WORDS.has(b) && !FROM_AFTER.has(b) && !TO_WORDS.has(b)) noun = clean
  }
  return { from, to, value: num.value, decimals: num.decimals, prefix, suffix, ...(noun ? { label: noun } : {}), statistic }
}

/** "from 20 to 80" (and "২০ থেকে ৮০"): one counter from the first value to the second (§11.4). */
function mergeRanges(found: FoundNumber[], bare: readonly string[]): FoundNumber[] {
  const out: FoundNumber[] = []
  for (let k = 0; k < found.length; k++) {
    const a = found[k]
    const b = found[k + 1]
    if (b) {
      const between = bare.slice(a.to + 1, b.from)
      const fromTo = FROM_WORDS.has(bare[a.from - 1] ?? '') && between.length === 1 && TO_WORDS.has(between[0])
      const fromAfter = between.length === 1 && FROM_AFTER.has(between[0])
      if (fromTo || fromAfter) {
        out.push({
          ...b,
          ...(b.label === undefined && a.label ? { label: a.label } : {}),
          from: a.from,
          start: a.value,
          prefix: b.prefix || a.prefix,
          suffix: b.suffix || a.suffix,
          decimals: Math.max(a.decimals, b.decimals) as 0 | 1 | 2,
          statistic: rangeIsStatistic(a, b, bare)
        })
        k++
        continue
      }
    }
    out.push(a)
  }
  return out
}

/** "from X to Y" states a change, so it is a statistic, unless it is a measure, a year or a label. */
function rangeIsStatistic(a: FoundNumber, b: FoundNumber, bare: readonly string[]): boolean {
  if (MEASURE_WORDS.has(bare[b.to + 1] ?? '')) return false
  const year = (n: FoundNumber): boolean => !n.prefix && !n.suffix && Number.isInteger(n.value) && n.value >= 1900 && n.value <= 2100
  if (year(a) || year(b)) return false
  if (LABEL_WORDS.has(bare[a.from - 2] ?? '') || LABEL_WORDS.has(bare[a.from - 1] ?? '')) return false
  return b.value >= 10 || !!b.suffix || !!b.prefix
}
