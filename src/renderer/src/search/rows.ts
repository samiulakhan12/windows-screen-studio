/**
 * The rows of Home's search results (docs/design/search.md §5), which the arrow keys move through:
 * per recording its heading, its moments shown and "more". Pure, so it is tested without a page.
 */
import type { SearchHit, SearchMoment, SnippetPart } from '../../../shared/api/search'
import { KIND_LABEL, spokenTime } from '../../../shared/search/moment'
import { SEARCH_LIMITS } from '../../../shared/search/types'

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
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
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
export const STILL_INDEXING = 'Still indexing your recordings; more results may appear.'

/** What the polite live region says for the results' `summary` (empty before the first answer). */
export function liveStatus(summary: string, building: boolean): string {
  if (!summary) return ''
  return building ? STILL_INDEXING : summary
}

/** What a screen reader says for a row. */
export function rowLabel(row: Row): string {
  const where = `In ${row.hit.name || 'Untitled'}${dateOf(row.hit.createdAt) ? `, ${dateOf(row.hit.createdAt)}` : ''}.`
  if (row.kind === 'open') return `Open ${row.hit.name || 'Untitled'}${row.hit.nameOnly ? ', found in the name' : ''}. ${dateOf(row.hit.createdAt)}, ${spokenTime(row.hit.duration)} long.`
  if (row.kind === 'more') return `Show ${row.count} more moment${row.count === 1 ? '' : 's'}. ${where}`
  const m = row.moment
  const label = KIND_LABEL[m.kind]
  const at = m.video === null ? label : `${label} at ${spokenTime(m.video)}`
  return `${at}${m.cut ? ', cut from the video' : ''}: ${textOf(m.snippet)}. ${where}`
}

