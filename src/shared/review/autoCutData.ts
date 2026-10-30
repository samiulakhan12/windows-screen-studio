/**
 * Reading the stored record of automatic cuts (Review mode, docs/design/review-mode.md §3): the
 * migration's sanitiser, kept free of editor code so engine/project.ts can import it. Pure.
 */
import { clamp } from '../engine/math'
import { MAX_SPEED, MIN_SPEED } from '../engine/timeline'
import type { AutoCut, AutoCutSource } from '../types'

export const AUTO_CUT_SOURCES: readonly AutoCutSource[] = ['silences', 'smart-speed', 'polish', 'filler', 'retake', 'repeat']
export const AUTO_CUT_ACTIONS: readonly AutoCut['action'][] = ['cut', 2, 4, 8]

/** At most this many records are kept (the newest). */
export const MAX_AUTO_CUTS = 1000
/** At most this many pieces per record. */
export const MAX_WAS_PIECES = 64
/** Longest `words` text kept. */
export const MAX_WORDS_TEXT = 80
const MAX_ID = 64
const EPS = 1e-6

export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** `words` cut to MAX_WORDS_TEXT characters (an ellipsis marks the cut), or undefined when empty. */
export function wordsText(text: string | undefined): string | undefined {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length <= MAX_WORDS_TEXT ? t : `${t.slice(0, MAX_WORDS_TEXT - 1).trimEnd()}…`
}

/**
 * The stored records, sanitised (§3): plain objects only, fields read one by one; ids 1..64
 * characters and unique; `by`/`action` from their lists; ranges finite, clamped to [0, duration]
 * and not empty; pieces inside the range with a speed in [MIN_SPEED, MAX_SPEED], at most
 * MAX_WAS_PIECES; `words` cut to MAX_WORDS_TEXT; at most MAX_AUTO_CUTS (the newest). A record
 * without a piece is dropped. Undefined when nothing is left (no key in the project). Idempotent.
 */
export function readAutoCuts(raw: unknown, duration: number): AutoCut[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const ids = new Set<string>()
  const out: AutoCut[] = []
  for (const r of raw) {
    if (!isObject(r)) continue
    const id = r.id
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID || ids.has(id)) continue
    const by = AUTO_CUT_SOURCES.find((s) => s === r.by)
    const action = AUTO_CUT_ACTIONS.find((a) => a === r.action)
    if (!by || action === undefined || !finite(r.start) || !finite(r.end)) continue
    const start = clamp(r.start, 0, duration)
    const end = clamp(r.end, 0, duration)
    if (end - start <= EPS) continue
    const was: AutoCut['was'] = []
    for (const p of Array.isArray(r.was) ? r.was : []) {
      if (was.length >= MAX_WAS_PIECES) break
      if (!isObject(p) || !finite(p.start) || !finite(p.end) || !finite(p.speed)) continue
      const a = clamp(p.start, start, end)
      const b = clamp(p.end, start, end)
      if (b - a <= EPS) continue
      was.push({ start: a, end: b, speed: clamp(p.speed, MIN_SPEED, MAX_SPEED) })
    }
    if (was.length === 0) continue
    const words = typeof r.words === 'string' ? wordsText(r.words) : undefined
    ids.add(id)
    out.push({ id, by, action, start, end, was, ...(words ? { words } : {}) })
  }
  const kept = out.length > MAX_AUTO_CUTS ? out.slice(out.length - MAX_AUTO_CUTS) : out
  return kept.length ? kept : undefined
}

