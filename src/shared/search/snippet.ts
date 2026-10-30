/**
 * A one-line snippet of a unit's text around its first matched word (docs/design/search.md §2.7):
 * plain text parts, matched words marked `hit`. Never HTML: the page renders the parts as text.
 */
import { SEARCH_LIMITS, type SnippetPart } from './types'

export type Range = readonly [number, number]

const ELLIPSIS = '…'

/** Sorted, merged ranges inside 0..length. */
function mergeRanges(ranges: readonly Range[], length: number): [number, number][] {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, Math.min(s, length)), Math.max(0, Math.min(e, length))] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** Text from `from` to `to` cut into parts at the ranges. */
export function markRanges(text: string, ranges: readonly Range[], from = 0, to = text.length): SnippetPart[] {
  const parts: SnippetPart[] = []
  const push = (s: string, hit: boolean): void => {
    if (!s) return
    const last = parts[parts.length - 1]
    if (last && last.hit === hit) last.text += s
    else parts.push({ text: s, hit })
  }
  let at = from
  for (const [s, e] of mergeRanges(ranges, text.length)) {
    if (e <= from || s >= to) continue
    push(text.slice(at, Math.max(at, s)), false)
    push(text.slice(Math.max(at, s), Math.min(e, to)), true)
    at = Math.min(e, to)
  }
  push(text.slice(at, to), false)
  return parts
}

/** The snippet of `text` around the first of `ranges` (the whole start of the text when there is none). */
export function snippetOf(text: string, ranges: readonly Range[]): SnippetPart[] {
  const merged = mergeRanges(ranges, text.length)
  const first = merged[0] ?? [0, 0]
  // The line holding the first hit.
  const lineStart = text.lastIndexOf('\n', first[0] - 1) + 1
  const nl = text.indexOf('\n', first[1])
  const lineEnd = nl < 0 ? text.length : nl
  let from = Math.max(lineStart, first[0] - SEARCH_LIMITS.snippetBefore)
  let to = Math.min(lineEnd, first[1] + SEARCH_LIMITS.snippetAfter)
  // Cut on a word boundary: never in the middle of a word.
  if (from > lineStart) {
    const space = text.slice(from, first[0]).search(/\s/)
    from = space < 0 ? first[0] : from + space + 1
  }
  if (to < lineEnd) {
    const space = text.slice(first[1], to).search(/\s\S*$/)
    to = space < 0 ? to : first[1] + space
  }
  const parts = markRanges(text, merged, from, to)
  const trimmed = parts.length ? parts : [{ text: '', hit: false }]
  // Spaces at the cut ends would sit next to the ellipsis.
  if (from > lineStart) trimmed.unshift({ text: ELLIPSIS, hit: false })
  if (to < lineEnd) trimmed.push({ text: ELLIPSIS, hit: false })
  return joinPlain(trimmed).map((p, i, all) => ({
    hit: p.hit,
    text: i === 0 && !p.hit ? p.text.trimStart() : i === all.length - 1 && !p.hit ? p.text.trimEnd() : p.text
  }))
}

/** Neighbouring plain parts joined into one. */
function joinPlain(parts: SnippetPart[]): SnippetPart[] {
  const out: SnippetPart[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last && !last.hit && !p.hit) last.text += p.text
    else out.push({ ...p })
  }
  return out
}
