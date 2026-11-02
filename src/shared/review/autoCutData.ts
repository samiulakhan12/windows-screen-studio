/**
 * Reading the stored record of automatic cuts and the choices made for them in the Review panel
 * (Review mode, docs/design/review-mode.md §3): the migration's sanitisers, kept free of editor
 * code so engine/project.ts can import them. Pure.
 */
import { clamp } from '../engine/math'
import { MAX_SPEED, MIN_SPEED } from '../engine/timeline'
import type { AutoCut, AutoCutOutcome, AutoCutSource } from '../types'

export const AUTO_CUT_SOURCES: readonly AutoCutSource[] = ['silences', 'smart-speed', 'polish', 'filler', 'retake', 'repeat']
export const AUTO_CUT_ACTIONS: readonly AutoCut['action'][] = ['cut', 2, 4, 8]
export const AUTO_CUT_OUTCOMES: readonly AutoCutOutcome['outcome'][] = ['kept', 'removed']

/**
 * At most this many records are kept (the newest): well above what the runs over one long recording
 * write (Remove silences and then Polish on a 1-hour video write over a thousand).
 */
export const MAX_AUTO_CUTS = 10_000
/** At most this many choices made in the Review panel are kept (the newest): one for each record. */
export const MAX_AUTO_CUT_OUTCOMES = MAX_AUTO_CUTS
/**
 * At most this many pieces in a record a tool run writes (a longer share is split over several
 * records), and in one a too-short piece of a cut is handed to (takeBack). A record grows past it
 * when the records around it change (Keep of a speed-up inside it gives up those parts), so the
 * reader keeps whole records within MAX_AUTO_CUT_PIECES in all instead.
 */
export const MAX_WAS_PIECES = 64
/**
 * At most this many pieces in all the records kept (the newest records, each whole), whatever their
 * count: what bounds the work on a hand-made file.
 */
export const MAX_AUTO_CUT_PIECES = 64_000
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
 * The newest records of `list` (the last ones) that fit whole: walking from the newest, at most
 * MAX_AUTO_CUTS records and MAX_AUTO_CUT_PIECES pieces in all, up to the first that does not fit.
 * `list` itself when all fit. The editor keeps its records so (withAutoCuts) and the reader reads a
 * file so, so a project saves and opens again as it was, every record with all its pieces.
 */
export function newestAutoCuts<T extends { was: readonly unknown[] }>(list: T[]): T[] {
  let k = list.length
  let pieces = 0
  while (k > 0 && list.length - k < MAX_AUTO_CUTS && pieces + list[k - 1].was.length <= MAX_AUTO_CUT_PIECES) {
    pieces += list[k - 1].was.length
    k--
  }
  return k === 0 ? list : list.slice(k)
}

/**
 * `list` with no two pieces of one action overlapping, as the editor writes records, within 1 ms (a
 * cut or a speed-up claims footage no other record of its action holds, and a record's pieces never
 * overlap; a record whose footage plays again for under 1 ms stays, and a later run can claim that
 * footage again): the pieces of each action gone through by where they start, a piece that starts
 * before the end of those kept already keeps only its part past that end (dropped when nothing is
 * left), and a record left without a piece goes. So a piece is never dropped for a sliver another
 * one shares with it. A hand-made file that stacks pieces would otherwise make the steps that split
 * records at a speed-up's pieces (withSpeedsBefore, autoCuts.ts) grow with the product of the two.
 * Idempotent.
 */
function withoutOverlaps(list: AutoCut[]): AutoCut[] {
  const all = list.flatMap((c, i) => c.was.map((p, j) => ({ i, j, p, a: c.action })))
  /** A piece trimmed (its new start) or dropped (null), by `${record}:${piece}`. */
  const changed = new Map<string, number | null>()
  const byAction = new Map<AutoCut['action'], typeof all>()
  for (const x of all) {
    const xs = byAction.get(x.a)
    if (xs) xs.push(x)
    else byAction.set(x.a, [x])
  }
  for (const xs of byAction.values()) {
    xs.sort((u, v) => u.p.start - v.p.start || u.i - v.i || u.j - v.j)
    let end = -Infinity
    for (const x of xs) {
      if (x.p.start >= end - EPS) end = Math.max(end, x.p.end)
      else if (x.p.end - end > EPS) {
        changed.set(`${x.i}:${x.j}`, end)
        end = x.p.end
      } else changed.set(`${x.i}:${x.j}`, null)
    }
  }
  if (changed.size === 0) return list
  return list.flatMap((c, i) => {
    if (!c.was.some((_, j) => changed.has(`${i}:${j}`))) return [c]
    const was: AutoCut['was'] = []
    c.was.forEach((p, j) => {
      const to = changed.get(`${i}:${j}`)
      if (to === undefined) was.push(p)
      else if (to !== null) was.push({ ...p, start: to })
    })
    return was.length === 0 ? [] : [{ ...c, was }]
  })
}

/**
 * The stored records, sanitised (§3): plain objects only, fields read one by one; ids 1..64
 * characters and unique; `by`/`action` from their lists; ranges finite, clamped to [0, duration]
 * and not empty; pieces inside the range with a speed in [MIN_SPEED, MAX_SPEED]; `words` cut to
 * MAX_WORDS_TEXT; no two pieces of one action over the same footage (withoutOverlaps); the newest
 * records that fit whole in MAX_AUTO_CUTS records and MAX_AUTO_CUT_PIECES pieces (newestAutoCuts). A
 * record without a piece is dropped. Undefined when nothing is left (no key in the project).
 * Idempotent.
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
      // One with more pieces than all may hold never fits (newestAutoCuts): no need to read on.
      if (was.length > MAX_AUTO_CUT_PIECES) break
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
  const kept = newestAutoCuts(withoutOverlaps(out))
  return kept.length ? kept : undefined
}

/**
 * `list` with each of `chosen` recorded: one entry per id, a new choice for an id taking the old
 * one's place at the end (the newest last), at most MAX_AUTO_CUT_OUTCOMES (the newest).
 */
export function withOutcomes(list: readonly AutoCutOutcome[], chosen: readonly AutoCutOutcome[]): AutoCutOutcome[] {
  const byId = new Map(list.map((o) => [o.id, o]))
  for (const o of chosen) {
    byId.delete(o.id)
    byId.set(o.id, { id: o.id, outcome: o.outcome })
  }
  const out = [...byId.values()]
  return out.length > MAX_AUTO_CUT_OUTCOMES ? out.slice(out.length - MAX_AUTO_CUT_OUTCOMES) : out
}

/**
 * The stored choices made in the Review panel, sanitised (§3): plain objects only, fields read one
 * by one; ids 1..64 characters; `outcome` from its list; one entry per id (a later entry for an id
 * is the newer choice and takes its place); at most MAX_AUTO_CUT_OUTCOMES (the newest). Undefined
 * when nothing is left (no key in the project). Idempotent.
 */
export function readAutoCutOutcomes(raw: unknown): AutoCutOutcome[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const read: AutoCutOutcome[] = []
  for (const r of raw) {
    if (!isObject(r)) continue
    const id = r.id
    const outcome = AUTO_CUT_OUTCOMES.find((o) => o === r.outcome)
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID || !outcome) continue
    read.push({ id, outcome })
  }
  const out = withOutcomes([], read)
  return out.length ? out : undefined
}

