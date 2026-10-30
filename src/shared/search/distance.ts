/**
 * Edit distances for typo-tolerant search (docs/design/search.md §2.5): insertions, deletions,
 * substitutions and swaps of two neighbours each count 1 (optimal string alignment). Code points,
 * not UTF-16 units, so a Bangla vowel sign or an emoji is one character. Bounded: past `max` the
 * answer is `max + 1`, found early.
 */

/** Characters as numbers: UTF-16 units when there is no surrogate pair (the usual case), code points otherwise. */
type Chars = ArrayLike<number>

const SURROGATE_RE = /[\uD800-\uDFFF]/

function charsOf(s: string): Chars {
  if (!SURROGATE_RE.test(s)) {
    const out = new Uint16Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  }
  return Array.from(s, (c) => c.codePointAt(0) ?? 0)
}

/** Three rows of the table, reused between calls (grown when needed). */
let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)]

/**
 * The last row of the table of distances between the prefixes of `a` and of `b[0..m)`; null as
 * soon as a whole row exceeds `max`. The returned row is reused by the next call.
 */
function lastRow(a: Chars, b: Chars, m: number, max: number): Int32Array | null {
  if (rows[0].length < m + 1) rows = [new Int32Array(m + 1), new Int32Array(m + 1), new Int32Array(m + 1)]
  let [prev2, prev, row] = rows
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    row[0] = i
    let best = i
    const ai = a[i - 1]
    for (let j = 1; j <= m; j++) {
      const bj = b[j - 1]
      let d = prev[j - 1] + (ai === bj ? 0 : 1)
      if (prev[j] + 1 < d) d = prev[j] + 1
      if (row[j - 1] + 1 < d) d = row[j - 1] + 1
      if (i > 1 && j > 1 && ai === b[j - 2] && a[i - 2] === bj && prev2[j - 2] + 1 < d) d = prev2[j - 2] + 1
      row[j] = d
      if (d < best) best = d
    }
    if (best > max) return null
    const spare = prev2
    prev2 = prev
    prev = row
    row = spare
  }
  rows = [prev2, prev, row]
  return prev
}

/** Distance between `a` and `b`, or `max + 1` when it is more than `max`. */
export function editDistance(a: string, b: string, max: number): number {
  const x = charsOf(a)
  const y = charsOf(b)
  if (Math.abs(x.length - y.length) > max) return max + 1
  const row = lastRow(x, y, y.length, max)
  return row ? Math.min(row[y.length], max + 1) : max + 1
}

/**
 * Distance between `query` and the closest prefix of `term` (typing "setin" is 1 from "settings"),
 * or `max + 1` when that is more than `max`.
 */
export function prefixDistance(query: string, term: string, max: number): number {
  const q = charsOf(query)
  const t = charsOf(term)
  if (t.length < q.length - max) return max + 1
  // Prefixes of the term longer than the query plus `max` can never be closer.
  const m = Math.min(t.length, q.length + max)
  const row = lastRow(q, t, m, max)
  if (!row) return max + 1
  let best = max + 1
  for (let j = 0; j <= m; j++) if (row[j] < best) best = row[j]
  return best
}
