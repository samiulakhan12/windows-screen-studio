/**
 * The rows of Home's search results (docs/design/search.md §5), which the arrow keys move through:
 * per recording its heading, its moments shown and "more". Pure, so it is tested without a page.
 */
import type { SearchHit, SearchMoment, SnippetPart } from '../../../shared/api/search'
import type { SearchKind } from '../../../shared/search/types'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import { SEARCH_LIMITS } from '../../../shared/search/types'

/*
 * The words below are messages of the review namespace (docs/design/output-and-languages.md §9.1).
 * shared/search/moment.ts, which main imports too, keeps the English forms of KIND_LABEL,
 * spokenTime and resultsSummary for main and its tests; these are the same words in the UI language.
 */

/** Short label of where the words were found: "Said", "On screen". */
export const kindLabel = (kind: SearchKind): string => t(`review.search.kind.${kind}`)

/** "1 minute 23 seconds", for screen readers (moment.ts's spokenTime). */
export function spokenTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts: string[] = []
  if (h) parts.push(t('review.search.time.hours', { count: h, n: fmt.count(h) }))
  if (m) parts.push(t('review.search.time.minutes', { count: m, n: fmt.count(m) }))
  if (sec || !parts.length) parts.push(t('review.search.time.seconds', { count: sec, n: fmt.count(sec) }))
  return parts.join(' ')
}

/** The live region's sentence: "3 recordings found", "No recordings match "x"." (moment.ts's resultsSummary). */
export function resultsSummary(count: number, query: string, limit = Infinity): string {
  if (count === 0) return t('review.search.noMatch', { query })
  if (count >= limit) return t('review.search.firstFound', { n: fmt.count(count) })
  return t('review.search.found', { count, n: fmt.count(count) })
}

/** A recording's name, or Untitled. */
export const hitName = (hit: Pick<SearchHit, 'name'>): string => hit.name || t('review.search.untitled')

/** Moments shown per recording until "more" is pressed (§4). */
export const MOMENTS_SHOWN = 4

/** One row the arrow keys move through. */
export type Row =
  | { kind: 'open'; key: string; hit: SearchHit }
  | { kind: 'moment'; key: string; hit: SearchHit; moment: SearchMoment }
  | { kind: 'more'; key: string; hit: SearchHit; count: number }

const textOf = (parts: SnippetPart[]): string => parts.map((p) => p.text).join('')

export function dateOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : fmt.date(d.getTime(), 'dayYear')
}

/** The rows of the results, in order: per recording its heading, its moments shown, and "more". */
export function resultRows(hits: readonly SearchHit[], expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  for (const hit of hits) {
    rows.push({ kind: 'open', key: `${hit.id}:open`, hit })
    const shown = expanded.has(hit.id) ? hit.moments : hit.moments.slice(0, MOMENTS_SHOWN)
    // Keyed by what the moment is, not its place: results that change while the index is built keep the active row.
    const seen = new Map<string, number>()
    for (const moment of shown) {
      const base = `${hit.id}:${moment.kind}:${moment.start ?? 'none'}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      rows.push({ kind: 'moment', key: `${base}:${n}`, hit, moment })
    }
    const hidden = hit.moments.length - shown.length
    if (hidden > 0) rows.push({ kind: 'more', key: `${hit.id}:more`, hit, count: hidden })
  }
  return rows
}

/** The text of the box as the main process answers it (a response's `query`). */
export const answeredQuery = (text: string): string => text.slice(0, SEARCH_LIMITS.queryChars).trim()

/**
 * What Enter in the box opens: the active row (null when the results no longer hold it), else the
 * first row of results that answer the text in the box. `wait` while the results shown are still
 * those of what was typed before (`answered`: the query they answer, null for none yet): the first
 * row of the answer opens when it comes, never one of the old results.
 */
export function enterTarget(rows: readonly Row[], activeKey: string | null, answered: string | null, text: string): Row | 'wait' | null {
  if (activeKey !== null) return rows.find((r) => r.key === activeKey) ?? null
  const q = answeredQuery(text)
  if (!q) return null
  return answered === q ? (rows[0] ?? null) : 'wait'
}

/** What the live region says while the index is built: one sentence that does not change as it goes, so it is read once. */
export const stillIndexing = (): string => t('review.search.stillIndexing')

/** What the polite live region says for the results' `summary` (empty before the first answer). */
export function liveStatus(summary: string, building: boolean): string {
  if (!summary) return ''
  return building ? stillIndexing() : summary
}

/** What a screen reader says for a row. */
export function rowLabel(row: Row): string {
  const name = hitName(row.hit)
  const date = dateOf(row.hit.createdAt)
  const where = date ? t('review.search.row.in', { name, date }) : t('review.search.row.inNoDate', { name })
  if (row.kind === 'open') return t(row.hit.nameOnly ? 'review.search.row.openName' : 'review.search.row.open', { name, date, length: spokenTime(row.hit.duration) })
  if (row.kind === 'more') return t('review.search.row.more', { count: row.count, n: fmt.count(row.count), where })
  const m = row.moment
  const values = { kind: kindLabel(m.kind), text: textOf(m.snippet), where }
  if (m.video === null) return t(m.cut ? 'review.search.row.momentCut' : 'review.search.row.moment', values)
  return t(m.cut ? 'review.search.row.momentAtCut' : 'review.search.row.momentAt', { ...values, time: spokenTime(m.video) })
}

