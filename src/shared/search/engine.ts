/**
 * The in-memory index and its queries (docs/design/search.md §2.5, §2.6): an inverted index from
 * terms to recordings, typo-tolerant prefix matching against the vocabulary, every query word
 * required, recordings and their moments ranked. Pure: the main process feeds it entries and asks.
 */
import { prefixDistance } from './distance'
import { codePoints, isNumeric, queryTerms, tokenize } from './normalize'
import { markRanges, snippetOf, type Range } from './snippet'
import { SEARCH_LIMITS, type IndexedProject, type SearchHit, type SearchKind, type SearchMoment, type SearchUnit } from './types'

/** How much a match in each kind counts. */
export const KIND_WEIGHT: Record<SearchKind, number> = { name: 3, file: 2, chapter: 2.5, title: 2.5, text: 1.5, said: 1, notes: 0.8 }

/** Kinds where a one-letter word matches by prefix (typing the first letter of a name lists it, not every caption). */
const STRONG_KINDS: ReadonlySet<SearchKind> = new Set(['name', 'file', 'chapter', 'title'])

/** Match qualities (§2.5). */
export const QUALITY = { exact: 1, prefixBase: 0.75, prefixLength: 0.2, typo1: 0.55, typo2: 0.4 } as const

/** Bonuses (§2.6). */
const PHRASE_BONUS = 0.5
const OTHER_UNIT_BONUS = 0.25
const OTHER_UNITS_COUNTED = 8
const ALL_TERMS_BONUS = 0.5

/** Scripts written without spaces: a one-character word is a whole word there, matched by prefix everywhere. */
const UNSPACED_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

/**
 * A recording in the index: every unit's terms and their ranges in one packed array each (units
 * `u` runs from bounds[u] to bounds[u + 1]), so 40,000 captions are not 120,000 small arrays.
 */
interface Doc {
  id: string
  entry: IndexedProject
  terms: Int32Array
  starts: Int32Array
  ends: Int32Array
  bounds: Int32Array
}

/** A query word's matches, by term id: quality (0 = no match), and 1 where the match counts only in the strong kinds. */
interface TermMatches {
  quality: Float32Array
  strongOnly: Uint8Array
  ids: number[]
}

export interface SearchOptions {
  hits?: number
  moments?: number
  /** Only these recordings (Home's list: a recording deleted a moment ago is never shown). */
  only?: ReadonlySet<string>
}

/** Allowed typos for a query word of `length` code points (§2.5). */
export function allowedTypos(term: string, length = codePoints(term)): number {
  if (isNumeric(term)) return 0
  return length >= 8 ? 2 : length >= 4 ? 1 : 0
}

export class SearchIndex {
  private readonly termIds = new Map<string, number>()
  private readonly terms: string[] = []
  private readonly termLengths: number[] = []
  private readonly postings: Set<Doc>[] = []
  private readonly docs = new Map<string, Doc>()

  get size(): number {
    return this.docs.size
  }

  has(id: string): boolean {
    return this.docs.has(id)
  }

  get(id: string): IndexedProject | undefined {
    return this.docs.get(id)?.entry
  }

  ids(): string[] {
    return [...this.docs.keys()]
  }

  /** Recordings indexed without a transcript. */
  withoutTranscript(only?: ReadonlySet<string>): number {
    let n = 0
    for (const d of this.docs.values()) if (!d.entry.hasTranscript && (!only || only.has(d.id))) n++
    return n
  }

  private termId(term: string): number {
    let id = this.termIds.get(term)
    if (id === undefined) {
      id = this.terms.length
      this.termIds.set(term, id)
      this.terms.push(term)
      this.termLengths.push(codePoints(term))
      this.postings.push(new Set())
    }
    return id
  }

  /** Indexes (or indexes again) a recording. */
  add(id: string, entry: IndexedProject): void {
    this.remove(id)
    const perUnit = entry.units.map((u) => tokenize(u.text))
    const count = perUnit.reduce((n, t) => n + t.length, 0)
    const doc: Doc = { id, entry, terms: new Int32Array(count), starts: new Int32Array(count), ends: new Int32Array(count), bounds: new Int32Array(entry.units.length + 1) }
    let k = 0
    perUnit.forEach((tokens, u) => {
      doc.bounds[u] = k
      for (const t of tokens) {
        const tid = this.termId(t.term)
        doc.terms[k] = tid
        doc.starts[k] = t.start
        doc.ends[k] = t.end
        this.postings[tid].add(doc)
        k++
      }
    })
    doc.bounds[entry.units.length] = k
    this.docs.set(id, doc)
  }

  remove(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    for (const tid of doc.terms) this.postings[tid].delete(doc)
    this.docs.delete(id)
  }

  /** The vocabulary's matches for one query word. */
  private match(q: string): TermMatches {
    const n = this.terms.length
    const quality = new Float32Array(n)
    const strongOnly = new Uint8Array(n)
    const ids: number[] = []
    const qLength = codePoints(q)
    const typos = allowedTypos(q, qLength)
    const shortPrefix = qLength === 1 && !UNSPACED_RE.test(q)
    for (let tid = 0; tid < n; tid++) {
      if (this.postings[tid].size === 0) continue
      const t = this.terms[tid]
      let quality_ = 0
      if (t === q) {
        quality_ = QUALITY.exact
      } else if (t.startsWith(q)) {
        quality_ = QUALITY.prefixBase + QUALITY.prefixLength * (qLength / this.termLengths[tid])
        if (shortPrefix) strongOnly[tid] = 1
      } else if (typos > 0 && this.termLengths[tid] >= qLength - typos && !isNumeric(t)) {
        const d = prefixDistance(q, t, typos)
        if (d <= typos) quality_ = d === 1 ? QUALITY.typo1 : QUALITY.typo2
      }
      if (quality_ > 0) {
        quality[tid] = quality_
        ids.push(tid)
      }
    }
    return { quality, strongOnly, ids }
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const words = queryTerms(query)
    if (!words.length) return []
    const matches = words.map((q) => this.match(q))
    // Recordings holding every word somewhere (strong-only matches are checked per unit below).
    let candidates: Set<Doc> | null = null
    for (const m of matches) {
      const docs = new Set<Doc>()
      for (const tid of m.ids) for (const d of this.postings[tid]) if (!candidates || candidates.has(d)) docs.add(d)
      candidates = docs
      if (!docs.size) return []
    }
    // Score every candidate first; moments and snippets only for those returned.
    const scored: { doc: Doc; score: number }[] = []
    for (const doc of candidates ?? []) {
      if (options.only && !options.only.has(doc.id)) continue
      const score = docScore(doc, matches)
      if (score !== null) scored.push({ doc, score })
    }
    scored.sort((a, b) => b.score - a.score || b.doc.entry.createdAt.localeCompare(a.doc.entry.createdAt) || a.doc.id.localeCompare(b.doc.id))
    return scored.slice(0, options.hits ?? SEARCH_LIMITS.hits).map(({ doc, score }) => hitOf(doc, score, matches, options.moments ?? SEARCH_LIMITS.moments))
  }
}

/** Whether nothing of `start..end` is kept (no clip overlaps it; a point is cut when no clip holds it). */
export function isCut(kept: readonly (readonly [number, number])[], start: number, end: number): boolean {
  if (!kept.length) return false
  return !kept.some(([s, e]) => (end > start ? s < end && e > start : start >= s && start < e))
}

/** A unit's score and how many query words it holds; `found` is set for each word it holds. */
interface UnitScore {
  unit: number
  score: number
  terms: number
}

/** The query's words next to each other in the order typed. */
function hasPhrase(at: Int8Array, length: number, n: number): boolean {
  for (let k = 0; k + n <= length; k++) {
    let i = 0
    while (i < n && at[k + i] === i) i++
    if (i === n) return true
  }
  return false
}

/** Buffers reused by scoreUnit (one query at a time; never shared across calls). */
let bestBuffer = new Float32Array(8)
let atBuffer = new Int8Array(256)

/** Scores unit `u` of `doc`; marks the words it holds in `found`. Null when it holds none. */
function scoreUnit(doc: Doc, u: number, matches: TermMatches[], found: boolean[] | null): UnitScore | null {
  const kind = doc.entry.units[u].kind
  const strong = STRONG_KINDS.has(kind)
  const from = doc.bounds[u]
  const to = doc.bounds[u + 1]
  const n = matches.length
  if (bestBuffer.length < n) bestBuffer = new Float32Array(n)
  if (atBuffer.length < to - from) atBuffer = new Int8Array(to - from)
  const best = bestBuffer.fill(0, 0, n)
  const at = n > 1 ? atBuffer.fill(-1, 0, to - from) : null
  let any = false
  for (let k = from; k < to; k++) {
    const tid = doc.terms[k]
    for (let i = 0; i < n; i++) {
      const m = matches[i]
      const q = m.quality[tid]
      if (q === 0 || (!strong && m.strongOnly[tid])) continue
      any = true
      if (q > best[i]) best[i] = q
      if (at && at[k - from] < 0) at[k - from] = i
    }
  }
  if (!any) return null
  let terms = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    if (best[i] > 0) {
      terms++
      sum += best[i]
      if (found) found[i] = true
    }
  }
  const weight = KIND_WEIGHT[kind]
  const score = sum * weight + (at && hasPhrase(at, to - from, n) ? PHRASE_BONUS * weight : 0)
  return { unit: u, score, terms }
}

/** The units of `doc` holding any query word. */
function matchingUnits(doc: Doc, matches: TermMatches[], found: boolean[] | null): UnitScore[] {
  const out: UnitScore[] = []
  for (let u = 0; u < doc.entry.units.length; u++) {
    const s = scoreUnit(doc, u, matches, found)
    if (s) out.push(s)
  }
  return out
}

/** The recording's score (§2.6), or null when one of the words is in none of its units. */
function docScore(doc: Doc, matches: TermMatches[]): number | null {
  const found = new Array<boolean>(matches.length).fill(false)
  const units = matchingUnits(doc, matches, found)
  if (!found.every(Boolean)) return null
  let best: UnitScore = units[0]
  for (const s of units) if (s.score > best.score) best = s
  return best.score + OTHER_UNIT_BONUS * Math.min(OTHER_UNITS_COUNTED, units.length - 1) + (best.terms === matches.length ? ALL_TERMS_BONUS : 0)
}

/** The ranges of the matched words in unit `u`. */
function unitRanges(doc: Doc, u: number, matches: TermMatches[]): Range[] {
  const strong = STRONG_KINDS.has(doc.entry.units[u].kind)
  const ranges: Range[] = []
  for (let k = doc.bounds[u]; k < doc.bounds[u + 1]; k++) {
    const tid = doc.terms[k]
    if (matches.some((m) => m.quality[tid] > 0 && (strong || !m.strongOnly[tid]))) ranges.push([doc.starts[k], doc.ends[k]])
  }
  return ranges
}

function hitOf(doc: Doc, score: number, matches: TermMatches[], momentLimit: number): SearchHit {
  const units = matchingUnits(doc, matches, null)
  const unit = (s: UnitScore): SearchUnit => doc.entry.units[s.unit]
  const name = units.find((s) => unit(s).kind === 'name')
  const title = name ? markRanges(unit(name).text, unitRanges(doc, name.unit, matches)) : [{ text: doc.entry.name, hit: false }]
  const momentUnits = units
    .filter((s) => unit(s).kind !== 'name' && unit(s).kind !== 'file')
    .sort((a, b) => b.terms - a.terms || b.score - a.score || (unit(a).start ?? Infinity) - (unit(b).start ?? Infinity))
  const moments: SearchMoment[] = momentUnits.slice(0, momentLimit).map((s) => {
    const u = unit(s)
    return {
      kind: u.kind,
      start: u.start,
      end: u.end,
      snippet: snippetOf(u.text, unitRanges(doc, s.unit, matches)),
      terms: s.terms,
      cut: u.start !== null && isCut(doc.entry.kept, u.start, u.end ?? u.start)
    }
  })
  return {
    id: doc.id,
    name: doc.entry.name,
    createdAt: doc.entry.createdAt,
    duration: doc.entry.duration,
    title,
    score,
    moments,
    more: Math.max(0, momentUnits.length - moments.length),
    nameOnly: momentUnits.length === 0
  }
}
