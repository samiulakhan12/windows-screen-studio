/**
 * Names the user lists (docs/design/auto-blur.md §6.11, §7.2). On screen the match is visual: both
 * sides folded (§6.2) with spaces optional, Damerau-Levenshtein distance 0 for 4 letters or fewer, 1
 * for 5-8 and 2 for 9 or more, up to 4 OCR words a match, the smallest distance winning where matches
 * overlap; exact after folding 0.97, within tolerance 0.80. One word of a listed full name alone is
 * not a match. Said aloud, a caption word matches a listed word by its double-metaphone codes and an
 * edit distance of 2 or less (Latin script), or by the edit distance of the NFC forms (Bangla). Names
 * never reach a log (§10.6). Pure.
 */
import type { CaptionWord } from '../../types'
import { doubleMetaphone } from '../vendor/double-metaphone.js'
import { foldText, type CleanLine } from './clean'
import { detectFrame } from './detect'
import { lineHit, type Hit, type LineContext } from './score'
import type { SaidHit } from './said'
import { BANGLA_WORD, LATIN_WORD, NAME_LIKE, NAME_WORD, WORD_EDGES } from './tables'

export interface NameEntry {
  /** The entry folded, spaces removed, without its wildcards. */
  folded: string
  /** Its words, lower case, NFC, without punctuation at their ends (for speech). */
  words: string[]
  /** `Acme*`: any letters may follow; `*Corp`: any may come before. */
  prefix: boolean
  suffix: boolean
}

export interface NameMatcher {
  entries: readonly NameEntry[]
  /** Never-hide entries, folded: a hit whose own folded text equals one is dropped. */
  never: ReadonlySet<string>
}

/** Listed names at most (as readPrivacy keeps). */
const MAX_NAMES = 200

/** A name folded for matching: Latin accents dropped, then foldText (§6.2). */
export function nameFold(s: string): string {
  return foldText(s.normalize('NFKD').replace(/([A-Za-z])\p{M}+/gu, '$1')).replace(/[.'’-]/g, '')
}

/** The edits a listed name of `n` folded characters allows. */
export const allowedEdits = (n: number): number => (n <= 4 ? 0 : n <= 8 ? 1 : 2)

/** Damerau-Levenshtein distance (optimal string alignment), or more than `max` as soon as it must be. */
export function editDistance(a: string, b: string, max = Infinity): number {
  const A = [...a]
  const B = [...b]
  if (Math.abs(A.length - B.length) > max) return max + 1
  let prev2: number[] = []
  let prev = Array.from({ length: B.length + 1 }, (_v, j) => j)
  for (let i = 1; i <= A.length; i++) {
    const cur = [i]
    let low = i
    for (let j = 1; j <= B.length; j++) {
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) d = Math.min(d, prev2[j - 2] + 1)
      cur.push(d)
      if (d < low) low = d
    }
    if (low > max) return max + 1
    prev2 = prev
    prev = cur
  }
  return prev[B.length]
}

/** A word without punctuation and symbols at its ends, lower case, NFC (vowel signs and the nukta kept). */
export const bareWord = (w: string): string => w.normalize('NFC').toLowerCase().replace(WORD_EDGES, '')

/** The names to find (Settings' and this video's) and the words never to hide. */
export function compileNames(entries: readonly string[], neverHide: readonly string[]): NameMatcher {
  const out: NameEntry[] = []
  const seen = new Set<string>()
  for (const raw of entries.slice(0, MAX_NAMES)) {
    if (typeof raw !== 'string') continue
    const text = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
    const prefix = text.endsWith('*')
    const suffix = text.startsWith('*')
    const body = text.replace(/^\*+|\*+$/g, '').trim()
    const folded = nameFold(body)
    if (folded.length < 2 || seen.has((prefix ? '>' : '') + (suffix ? '<' : '') + folded)) continue
    seen.add((prefix ? '>' : '') + (suffix ? '<' : '') + folded)
    out.push({ folded, words: body.split(' ').map(bareWord).filter(Boolean), prefix, suffix })
  }
  const never = new Set<string>()
  for (const raw of neverHide.slice(0, MAX_NAMES)) if (typeof raw === 'string' && raw.trim()) never.add(nameFold(raw.normalize('NFC').trim()))
  return { entries: out, never }
}

/** No names and nothing never to hide. */
export const NO_NAMES: NameMatcher = Object.freeze({ entries: Object.freeze([]), never: new Set<string>() })

/** The spans of a line's text matching the listed names: [start, end) of the cleaned text and the distance. */
export function nameSpans(text: string, m: NameMatcher): { s: number; e: number; d: number }[] {
  if (!m.entries.length) return []
  const words = [...text.matchAll(NAME_WORD)].map((w) => ({ s: w.index!, e: w.index! + w[0].length, f: nameFold(w[0]) }))
  const hits: { s: number; e: number; d: number }[] = []
  for (const entry of m.entries) {
    const want = entry.folded
    const edits = allowedEdits(want.length)
    for (let i = 0; i < words.length; i++) {
      let joined = ''
      for (let j = i; j < Math.min(words.length, i + 4); j++) {
        joined += words[j].f
        const cand = entry.prefix ? joined.slice(0, want.length) : entry.suffix ? joined.slice(-want.length) : joined
        const lengthOk = entry.prefix ? joined.length >= want.length : entry.suffix ? true : Math.abs(joined.length - want.length) <= edits
        if (lengthOk) {
          const d = editDistance(cand, want, edits)
          if (d <= edits) {
            hits.push({ s: words[i].s, e: words[j].e, d })
            break
          }
        }
        if (!entry.prefix && !entry.suffix && joined.length > want.length + edits) break
        if ((entry.prefix || entry.suffix) && joined.length > want.length + 40) break
      }
    }
  }
  // The best match wins where two overlap ("as Riad Hasan" against "Riad Hasan").
  hits.sort((a, b) => a.d - b.d || a.e - a.s - (b.e - b.s))
  const kept: { s: number; e: number; d: number }[] = []
  for (const h of hits) if (!kept.some((k) => h.s < k.e && k.s < h.e)) kept.push(h)
  return kept.sort((a, b) => a.s - b.s)
}

/** Listed names on a line: exact after folding 0.97, within tolerance 0.80. */
export function findNames(line: CleanLine, m: NameMatcher, ctx: LineContext): Hit[] {
  return nameSpans(line.text, m).map((h) => lineHit(ctx, 'name', h.d ? 'name-fuzzy' : 'name', h.s, h.e, h.d ? 0.8 : 0.97))
}

/** Whether a caption word sounds like a listed word: the same double-metaphone code and at most 2 edits (Latin), or within the edits of their length (Bangla, NFC). */
function saidWordMatches(said: string, listed: string, prefix: boolean, suffix: boolean): { ok: boolean; exact: boolean } {
  if (!said || !listed) return { ok: false, exact: false }
  if (said === listed) return { ok: true, exact: true }
  if (prefix && said.startsWith(listed)) return { ok: true, exact: true }
  if (suffix && said.endsWith(listed)) return { ok: true, exact: true }
  if (LATIN_WORD.test(said) && LATIN_WORD.test(listed)) {
    const a = doubleMetaphone(said)
    const b = doubleMetaphone(listed)
    const codes = (a[0] && (a[0] === b[0] || a[0] === b[1])) || (a[1] && (a[1] === b[0] || a[1] === b[1]))
    return { ok: !!codes && editDistance(said, listed, 2) <= 2, exact: false }
  }
  if (BANGLA_WORD.test(said) && BANGLA_WORD.test(listed)) return { ok: editDistance(said, listed, allowedEdits([...listed].length)) <= allowedEdits([...listed].length), exact: false }
  return { ok: false, exact: false }
}

/** Listed names said aloud, each entry's words in order (§7.2). `words` is every caption word in time order. */
export function saidNames(words: readonly CaptionWord[], m: NameMatcher): SaidHit[] {
  const out: SaidHit[] = []
  if (!m.entries.length) return out
  const bare = words.map((w) => bareWord(w.text))
  for (const entry of m.entries) {
    const k = entry.words.length
    if (!k) continue
    for (let i = 0; i + k <= words.length; i++) {
      let ok = true
      let exact = true
      for (let j = 0; j < k && ok; j++) {
        const r = saidWordMatches(bare[i + j], entry.words[j], entry.prefix && j === k - 1, entry.suffix && j === 0)
        ok = r.ok
        exact = exact && r.exact
      }
      if (!ok) continue
      const last = i + k - 1
      out.push({ kind: 'name', score: exact ? 0.97 : 0.8, start: words[i].start, end: words[last].end, estimated: words.slice(i, last + 1).some((w) => !!w.estimated), group: 'name:' + entry.folded, words: [i, last] })
      i = last
    }
  }
  return out
}

/**
 * Whether a text could be a name (§5.9): at most 40 characters of letters, spaces, '.', ''' and '-',
 * and no rule of §6.4-6.8 hits it. A key, a password, a code or a number is never name-like.
 */
export function looksLikeName(text: string): boolean {
  if (typeof text !== 'string') return false
  const t = text.normalize('NFC').trim()
  if (!t || t.length > 40 || !NAME_LIKE.test(t) || !/\p{L}/u.test(t)) return false
  const n = t.length
  const line = { box: [0, 0, n * 10, 20] as [number, number, number, number], quad: [], variants: [{ model: 'tiny' as const, text: t, conf: 1, spans: Array.from({ length: n }, (_v, i) => [i * 10, i * 10 + 10] as [number, number]) }], ring: '#000000', spread: 0 }
  const hits = detectFrame([line], [], { kinds: ['password', 'code', 'key', 'link', 'email', 'card', 'phone', 'id'], regions: [], names: NO_NAMES, frame: { width: n * 10 + 40, height: 40 } })
  return hits.length === 0
}
