/**
 * Numbers, sizes, times, dates and lists as the UI shows them (docs/design/output-and-languages.md
 * §11). One module for every process; it formats with the format locale setCatalogue gives and never
 * with the runtime's default locale.
 *
 * The contracts write the English profile (§11.2): each function in English is today's helper, moved,
 * not rewritten, so every call site X6 moves here keeps its exact English output (test 8). Other
 * languages format through Intl with the format locale (§11.3, part P6): its `-u-nu-` tag carries the
 * user's digits, units and codec names stay Latin, Bangla dates use full month names, and timecodes
 * keep their English shape in the language's digits.
 */
import type { UiLanguage } from '../api/ui'
import { formatLocale, uiLanguage } from './t'

/** How a clock reads: the old helpers' shapes, each kept exactly. */
export type ClockStyle =
  /** formatTime (engine/project.ts): "1:02.5", tenths cut, never rounded. */
  | 'tenths'
  /** formatTime(s, false) and formatClock(s): "1:02". */
  | 'whole'
  /** formatClock(s, true) (export dialog): "1:02.5", tenths rounded. */
  | 'rounded-tenths'
  /** clockTime (search): "1:02", "1:02:03" past an hour, whole seconds cut. */
  | 'hours'
  /** lengthText (share): "2:31", "1:02:03", seconds rounded. */
  | 'hours-rounded'

const pad2 = (n: number): string => String(n).padStart(2, '0')

/* ---------- the English profile: today's helpers, moved ---------- */

function bytesEn(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

function durationEn(seconds: number): string {
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds - m * 60)
  return s ? `${m} min ${s} s` : `${m} min`
}

function clockEn(seconds: number, style: ClockStyle): string {
  switch (style) {
    case 'tenths':
    case 'whole': {
      const s = Math.max(0, seconds)
      const m = Math.floor(s / 60)
      const rest = s - m * 60
      const whole = Math.floor(rest)
      const base = `${m}:${whole.toString().padStart(2, '0')}`
      return style === 'tenths' ? `${base}.${Math.floor((rest - whole) * 10)}` : base
    }
    case 'rounded-tenths': {
      const s = Math.max(0, seconds)
      const m = Math.floor(s / 60)
      const rest = s - m * 60
      return `${m}:${rest.toFixed(1).padStart(4, '0')}`
    }
    case 'hours': {
      const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = (s % 60).toString().padStart(2, '0')
      return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`
    }
    case 'hours-rounded': {
      const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const ss = String(s % 60).padStart(2, '0')
      return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
    }
  }
}

function tickEn(t: number, step: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const whole = Math.floor(s + 1e-6)
  const base = `${m}:${whole.toString().padStart(2, '0')}`
  return step < 1 ? `${base}.${Math.round((s - whole) * 10) % 10}` : base
}

/** versionTime (editor/versions.ts): "Today 14:02", "Yesterday 09:15", "12 Mar 14:02", "12 Mar 2025 14:02". */
function versionEn(ms: number, now: Date): string {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return ''
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86_400_000)
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Yesterday ${time}`
  const month = d.toLocaleString('en-GB', { month: 'short' })
  return `${d.getDate()} ${month}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`} ${time}`
}

function dateEn(ms: number, style: 'day' | 'dayYear' | 'dayTime' | 'version'): string {
  const d = new Date(ms)
  switch (style) {
    case 'day':
      return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
    case 'dayYear':
      return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
    case 'dayTime':
      return d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
    case 'version':
      return versionEn(ms, new Date())
  }
}

/** listPhrase (editor/shortcuts.ts): "A, B and C" (Intl.ListFormat('en') would write "A, B, and C"). */
function listEn(items: readonly string[], kind: 'and' | 'or'): string {
  if (items.length < 2) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${kind} ${items[items.length - 1]}`
}

/** usedAgo (storage/rules.ts): "today", "yesterday", "12 days ago". */
function relativeEn(ms: number, now: number): string {
  if (ms <= 0) return 'never'
  const days = Math.floor((now - ms) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/** Native digits of the scripts Flown shows (Bengali, Devanagari, Arabic-Indic, extended Arabic-Indic). */
const DIGIT_ZEROS = [0x09e6, 0x0966, 0x0660, 0x06f0]

/* ---------- other languages: Intl with the format locale (§11.3, part P6) ---------- */

/**
 * How a time of day reads in each language. Bangla's form is the reviewers' choice before S5
 * (§11.3): 'dayPeriod' puts a Bangla day period before the time ("দুপুর ২:০৫"), never a Latin "PM";
 * '24h' writes a 24-hour clock ("১৪:০৫"). Other languages use CLDR's own ('locale').
 */
export const TIME_FORMS: Readonly<Partial<Record<UiLanguage, 'dayPeriod' | '24h'>>> = { bn: 'dayPeriod' }

/** Languages whose dates use full month names (§11.3: "৭ নভেম্বর ২০২৬", not CLDR's "৭ নভে, ২০২৬"). */
const FULL_MONTHS: ReadonlySet<UiLanguage> = new Set(['bn'])

const english = (): boolean => uiLanguage() === 'en'

const numberFormats = new Map<string, Intl.NumberFormat>()
/** A NumberFormat for the format locale, made once per locale and options. */
function nf(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const locale = formatLocale()
  const key = `${locale}|${JSON.stringify(options)}`
  let f = numberFormats.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, options)
    numberFormats.set(key, f)
  }
  return f
}

const dateFormats = new Map<string, Intl.DateTimeFormat>()
function df(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = formatLocale()
  const key = `${locale}|${JSON.stringify(options)}`
  let f = dateFormats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options)
    dateFormats.set(key, f)
  }
  return f
}

const digitTables = new Map<string, string[]>()
/** `text` with its ASCII digits written in the format locale's digits (timecodes keep their English shape, §11.1). */
function localDigits(text: string): string {
  const locale = formatLocale()
  let digits = digitTables.get(locale)
  if (!digits) {
    const f = new Intl.NumberFormat(locale, { useGrouping: false })
    digits = [...'0123456789'].map((d) => f.format(Number(d)))
    digitTables.set(locale, digits)
  }
  const table = digits
  return text.replace(/[0-9]/g, (d) => table[Number(d)]!)
}

/** Amounts with their units in words ("২ মিনিট, ৫ সেকেন্ড"): what Intl.DurationFormat's long style writes, made from NumberFormat units and a unit list so every runtime gives the same text. */
function unitList(amounts: readonly (readonly [number, 'minute' | 'second'])[]): string {
  const parts = amounts.map(([n, unit]) => nf({ style: 'unit', unit, unitDisplay: 'long' }).format(n))
  return new Intl.ListFormat(formatLocale(), { type: 'unit', style: 'long' }).format(parts)
}

function durationOther(seconds: number): string {
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return unitList([[Math.max(1, Math.round(seconds)), 'second']])
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return unitList(s ? [[m, 'minute'], [s, 'second']] : [[m, 'minute']])
}

function bytesOther(bytes: number): string {
  if (bytes >= 1e9) return `${nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bytes / 1e9)} GB`
  if (bytes >= 1e6) return `${nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1e6)} MB`
  return `${nf().format(Math.max(1, Math.round(bytes / 1e3)))} KB`
}

const validDate = (d: Date): boolean => Number.isFinite(d.getTime())

/** A time of day in the language's form (TIME_FORMS). */
function timeOther(ms: number, style: 'short' | 'seconds'): string {
  const d = new Date(ms)
  if (!validDate(d)) return ''
  const withSeconds = style === 'seconds'
  const form = TIME_FORMS[uiLanguage()] ?? 'locale'
  if (form === '24h') return df({ hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hourCycle: 'h23' }).format(d)
  if (form === 'dayPeriod') {
    const parts = df({ hour: 'numeric', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: true, dayPeriod: 'short' }).formatToParts(d)
    const period = parts.find((p) => p.type === 'dayPeriod')?.value
    const clock = parts
      .filter((p) => p.type !== 'dayPeriod')
      .map((p) => p.value)
      .join('')
      .trim()
    return period ? `${period} ${clock}` : clock
  }
  return df({ hour: 'numeric', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) }).format(d)
}

/** Day and month (and year), with full month names where the language writes them so (FULL_MONTHS). */
function dayOther(d: Date, year: boolean): string {
  if (FULL_MONTHS.has(uiLanguage())) {
    const parts = df({ day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}) }).formatToParts(d)
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
    return [part('day'), part('month'), year ? part('year') : ''].filter(Boolean).join(' ')
  }
  return df({ day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }).format(d)
}

/** "Today", "Yesterday" in the language (Intl.RelativeTimeFormat), its first letter a capital where the script has them. */
function dayWord(daysAgo: 0 | 1): string {
  const word = new Intl.RelativeTimeFormat(formatLocale(), { numeric: 'auto' }).format(-daysAgo, 'day')
  return word.charAt(0).toLocaleUpperCase(formatLocale()) + word.slice(1)
}

function dateOther(ms: number, style: 'day' | 'dayYear' | 'dayTime' | 'version'): string {
  const d = new Date(ms)
  if (!validDate(d)) return ''
  switch (style) {
    case 'day':
      return dayOther(d, false)
    case 'dayYear':
      return dayOther(d, true)
    case 'dayTime':
      return FULL_MONTHS.has(uiLanguage()) ? `${dayOther(d, true)}, ${timeOther(ms, 'short')}` : df({ dateStyle: 'medium', timeStyle: 'short' }).format(d)
    case 'version': {
      const now = new Date()
      const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
      const days = Math.round((day(now) - day(d)) / 86_400_000)
      const time = timeOther(ms, 'short')
      if (days === 0 || days === 1) return `${dayWord(days)} ${time}`
      return `${dayOther(d, d.getFullYear() !== now.getFullYear())} ${time}`
    }
  }
}

/** Days ago in words ("আজ", "গতকাল", "১২ দিন আগে"). "Never" is a sentence of its own in other languages, so a time of 0 gives '' and the call site shows its own message. */
function relativeOther(ms: number, now: number): string {
  if (ms <= 0) return ''
  const days = Math.max(0, Math.floor((now - ms) / 86_400_000))
  return new Intl.RelativeTimeFormat(formatLocale(), { numeric: 'auto' }).format(-days, 'day')
}

/** The format locale's decimal separator. */
const decimalSeparator = (): string => nf().formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.'

export const fmt = {
  /** A count: "1234"; with grouping, "1,234" (toLocaleString('en-US'), notes and script drafts). Other languages: "১২৩৪", grouped "১,২৩৪". */
  count(n: number, opts?: { grouping?: boolean }): string {
    if (english()) return opts?.grouping ? n.toLocaleString('en-US') : String(n)
    return nf(opts?.grouping ? { maximumFractionDigits: 20 } : { useGrouping: false, maximumFractionDigits: 20 }).format(n)
  },
  /** A number: String(n); with `digits` min equal to max (or max alone), toFixed(max); else up to `max` decimals. Other languages group as the locale does ("১২,৩৪,৫৬৭.৮৯১"). */
  number(n: number, digits?: { min?: number; max?: number }): string {
    if (!english()) {
      if (!digits) return nf({ maximumFractionDigits: 20 }).format(n)
      const max = digits.max ?? digits.min ?? 0
      return nf({ minimumFractionDigits: digits.min ?? max, maximumFractionDigits: max }).format(n)
    }
    if (!digits) return String(n)
    const max = digits.max ?? digits.min ?? 0
    const min = digits.min ?? max
    if (min === max) return n.toFixed(max)
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: false }).format(n)
  },
  /** A share: 0.5 → "50%" ("৫০%"). */
  percent(ratio: number): string {
    if (!english()) return nf({ style: 'percent', maximumFractionDigits: 0 }).format(Math.round(ratio * 100) / 100)
    return `${Math.round(ratio * 100)}%`
  },
  /** A zoom, speed or level factor: "1.5×" (formatLevel, formatRate, zoomText). */
  factor(x: number): string {
    if (!english()) return `${nf({ maximumFractionDigits: 2, useGrouping: false }).format(Number(x.toFixed(2)))}×`
    return `${Number(x.toFixed(2))}×`
  },
  /** A file size: "1.50 GB", "12.3 MB", "340 KB" (formatBytes of the export dialog, sizeText of long jobs); units stay Latin ("১.৫ MB"). */
  bytes(n: number): string {
    return english() ? bytesEn(n) : bytesOther(n)
  },
  /** A length in words: "45 s", "2 min 5 s", "3 min" (formatDuration of the export dialog); other languages in long units ("২ মিনিট, ৫ সেকেন্ড"). */
  duration(seconds: number): string {
    return english() ? durationEn(seconds) : durationOther(seconds)
  },
  /** A short length in seconds with one decimal: "1.2 s" (lengthText of the sounds list). */
  seconds(s: number): string {
    const value = Math.max(0.1, Math.round(s * 10) / 10)
    if (!english()) return `${nf({ minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(value)} s`
    return `${value.toFixed(1)} s`
  },
  /** A timecode in one of today's shapes (ClockStyle); "tenths" (formatTime) by default. Other languages: the same shape in their digits ("১:০২.৫"). */
  clock(seconds: number, style: ClockStyle = 'tenths'): string {
    return english() ? clockEn(seconds, style) : localDigits(clockEn(seconds, style))
  },
  /** A ruler label: "m:ss", with tenths when the ticks are closer than a second (formatTick). */
  tick(t: number, step: number): string {
    return english() ? tickEn(t, step) : localDigits(tickEn(t, step))
  },
  /**
   * A date: 'day' "Mar 12", 'dayYear' "Mar 12, 2026", 'dayTime' "3/12/26, 2:02 PM" (the locale-less
   * calls of today, en-US), 'version' "Today 14:02" (versionTime, en-GB months). Other languages:
   * CLDR's forms, Bangla with full month names ("৭ নভেম্বর ২০২৬").
   */
  date(ms: number, style: 'day' | 'dayYear' | 'dayTime' | 'version'): string {
    return english() ? dateEn(ms, style) : dateOther(ms, style)
  },
  /** A time of day: 'short' "02:02 PM" (hour and minute, two digits), 'seconds' "2:02:00 PM" (toLocaleTimeString()). Other languages: TIME_FORMS. */
  time(ms: number, style: 'short' | 'seconds' = 'short'): string {
    if (!english()) return timeOther(ms, style)
    const d = new Date(ms)
    return style === 'seconds' ? d.toLocaleTimeString('en-US') : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  },
  /** How long ago: "today", "yesterday", "12 days ago", "never" for 0 (usedAgo). Other languages: Intl's words, and '' for 0. */
  relative(ms: number, now: number): string {
    return english() ? relativeEn(ms, now) : relativeOther(ms, now)
  },
  /** A list: "A, B and C" (listPhrase); "A, B or C". Other languages: Intl.ListFormat ("A, B এবং C"). */
  list(items: readonly string[], kind: 'and' | 'or' = 'and'): string {
    if (!english()) return new Intl.ListFormat(formatLocale(), { type: kind === 'and' ? 'conjunction' : 'disjunction' }).format(items)
    return listEn(items, kind)
  },
  /** A progress detail inside a sentence (§9.6): English lower-cases it, as the running view does today; other languages leave it. */
  inSentence(text: string): string {
    return english() ? text.toLowerCase() : text
  },
  /**
   * A number typed or pasted in any digits Flown shows (0–9, ০–৯, ०–९); NaN otherwise. Outside
   * English a comma reads as the decimal point where the format locale writes one ("2,5" in es).
   */
  parseNumber(text: string): number {
    let latin = text.trim().replace(/[٠-٩۰-۹०-९০-৯]/g, (d) => {
      const c = d.charCodeAt(0)
      return String(c - DIGIT_ZEROS.find((z) => c >= z && c <= z + 9)!)
    })
    if (!english() && !latin.includes('.') && decimalSeparator() === ',') latin = latin.replace(',', '.')
    return latin === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(latin) ? Number.NaN : Number(latin)
  }
}
