/**
 * Numbers, sizes, times, dates and lists as the UI shows them (docs/design/output-and-languages.md
 * §11). One module for every process; it formats with the format locale setCatalogue gives and never
 * with the runtime's default locale.
 *
 * The contracts write the English profile (§11.2): each function in English is today's helper, moved,
 * not rewritten, so every call site X6 moves here keeps its exact English output (test 8). Other
 * languages give the English output until part P6 writes their branch (§11.3).
 */

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

export const fmt = {
  /** A count: "1234"; with grouping, "1,234" (toLocaleString('en-US'), notes and script drafts). */
  count(n: number, opts?: { grouping?: boolean }): string {
    return opts?.grouping ? n.toLocaleString('en-US') : String(n)
  },
  /** A number: String(n); with `digits` min equal to max (or max alone), toFixed(max); else up to `max` decimals. */
  number(n: number, digits?: { min?: number; max?: number }): string {
    if (!digits) return String(n)
    const max = digits.max ?? digits.min ?? 0
    const min = digits.min ?? max
    if (min === max) return n.toFixed(max)
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: false }).format(n)
  },
  /** A share: 0.5 → "50%". */
  percent(ratio: number): string {
    return `${Math.round(ratio * 100)}%`
  },
  /** A zoom, speed or level factor: "1.5×" (formatLevel, formatRate, zoomText). */
  factor(x: number): string {
    return `${Number(x.toFixed(2))}×`
  },
  /** A file size: "1.50 GB", "12.3 MB", "340 KB" (formatBytes of the export dialog, sizeText of long jobs). */
  bytes(n: number): string {
    return bytesEn(n)
  },
  /** A length in words: "45 s", "2 min 5 s", "3 min" (formatDuration of the export dialog). */
  duration(seconds: number): string {
    return durationEn(seconds)
  },
  /** A short length in seconds with one decimal: "1.2 s" (lengthText of the sounds list). */
  seconds(s: number): string {
    return `${Math.max(0.1, Math.round(s * 10) / 10).toFixed(1)} s`
  },
  /** A timecode in one of today's shapes (ClockStyle); "tenths" (formatTime) by default. */
  clock(seconds: number, style: ClockStyle = 'tenths'): string {
    return clockEn(seconds, style)
  },
  /** A ruler label: "m:ss", with tenths when the ticks are closer than a second (formatTick). */
  tick(t: number, step: number): string {
    return tickEn(t, step)
  },
  /**
   * A date: 'day' "Mar 12", 'dayYear' "Mar 12, 2026", 'dayTime' "3/12/26, 2:02 PM" (the locale-less
   * calls of today, en-US), 'version' "Today 14:02" (versionTime, en-GB months).
   */
  date(ms: number, style: 'day' | 'dayYear' | 'dayTime' | 'version'): string {
    return dateEn(ms, style)
  },
  /** A time of day: 'short' "02:02 PM" (hour and minute, two digits), 'seconds' "2:02:00 PM" (toLocaleTimeString()). */
  time(ms: number, style: 'short' | 'seconds' = 'short'): string {
    const d = new Date(ms)
    return style === 'seconds' ? d.toLocaleTimeString('en-US') : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  },
  /** How long ago: "today", "yesterday", "12 days ago", "never" for 0 (usedAgo). */
  relative(ms: number, now: number): string {
    return relativeEn(ms, now)
  },
  /** A list: "A, B and C" (listPhrase); "A, B or C". */
  list(items: readonly string[], kind: 'and' | 'or' = 'and'): string {
    return listEn(items, kind)
  },
  /** A progress detail inside a sentence (§9.6): English lower-cases it, as the running view does today; other languages leave it (P6). */
  inSentence(text: string): string {
    return text.toLowerCase()
  },
  /** A number typed or pasted in any digits Flown shows (0–9, ০–৯, ०–९); NaN otherwise. */
  parseNumber(text: string): number {
    const latin = text.trim().replace(/[٠-٩۰-۹०-९০-৯]/g, (d) => {
      const c = d.charCodeAt(0)
      return String(c - DIGIT_ZEROS.find((z) => c >= z && c <= z + 9)!)
    })
    return latin === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(latin) ? Number.NaN : Number(latin)
  }
}
