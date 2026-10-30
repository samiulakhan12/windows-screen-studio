/**
 * Edit distances for typo-tolerant search (docs/design/search.md §2.5): insertions, deletions,
 * substitutions and swaps of two neighbours each count 1 (optimal string alignment). Code points,
 * not UTF-16 units, so a Bangla vowel sign or an emoji is one character. Bounded: past `max` the
 * answer is `max + 1`, found early.
 */

const chars = (s: string): string[] => Array.from(s)

/**
 * The table of distances between every prefix of `a` and every prefix of `b`, row by row; the
 * caller reads the last row. Returns null as soon as a whole row exceeds `max`.
 */
function lastRow(a: string[], b: string[], max: number): number[] | null {
  const m = b.length
  let prev2: number[] = []
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(m + 1)
    row[0] = i
    let best = row[0]
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1)
      row[j] = d
      if (d < best) best = d
    }
    if (best > max) return null
    prev2 = prev
    prev = row
  }
  return prev
}

/** Distance between `a` and `b`, or `max + 1` when it is more than `max`. */
export function editDistance(a: string, b: string, max: number): number {
  const x = chars(a)
  const y = chars(b)
  if (Math.abs(x.length - y.length) > max) return max + 1
  const row = lastRow(x, y, max)
  return row ? Math.min(row[y.length], max + 1) : max + 1
}

/**
 * Distance between `query` and the closest prefix of `term` (typing "setin" is 1 from "settings"),
 * or `max + 1` when that is more than `max`.
 */
export function prefixDistance(query: string, term: string, max: number): number {
  const q = chars(query)
  const t = chars(term)
  if (t.length < q.length - max) return max + 1
  // Prefixes of the term longer than the query plus `max` can never be closer.
  const row = lastRow(q, t.slice(0, q.length + max), max)
  return row ? Math.min(Math.min(...row), max + 1) : max + 1
}
