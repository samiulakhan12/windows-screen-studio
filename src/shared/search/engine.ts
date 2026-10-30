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

interface UnitData {
  unit: SearchUnit
  terms: Int32Array
  starts: Int32Array
  ends: Int32Array
}

interface Doc {
  id: string
  entry: IndexedProject
  units: UnitData[]
}

/** A query word's matches: term id → quality, and whether a match is allowed only in the strong kinds. */
interface TermMatches {
  quality: Map<number, number>
  strongOnly: Set<number>
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
    const doc: Doc = { id, entry, units: [] }
    for (const unit of entry.units) {
      const tokens = tokenize(unit.text)
      const data: UnitData = { unit, terms: new Int32Array(tokens.length), starts: new Int32Array(tokens.length), ends: new Int32Array(tokens.length) }
      tokens.forEach((t, i) => {
        const tid = this.termId(t.term)
        data.terms[i] = tid
        data.starts[i] = t.start
        data.ends[i] = t.end
        this.postings[tid].add(doc)
      })
      doc.units.push(data)
    }
    this.docs.set(id, doc)
  }

  remove(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    for (const u of doc.units) for (const tid of u.terms) this.postings[tid].delete(doc)
    this.docs.delete(id)
  }

  /** The vocabulary's matches for one query word. */
  private match(q: string): TermMatches {
    const quality = new Map<number, number>()
    const strongOnly = new Set<number>()
    const qLength = codePoints(q)
    const typos = allowedTypos(q, qLength)
    const shortPrefix = qLength === 1 && !UNSPACED_RE.test(q)
    for (let tid = 0; tid < this.terms.length; tid++) {
      if (this.postings[tid].size === 0) continue
      const t = this.terms[tid]
      if (t === q) {
        quality.set(tid, QUALITY.exact)
      } else if (t.startsWith(q)) {
        quality.set(tid, QUALITY.prefixBase + QUALITY.prefixLength * (qLength / this.termLengths[tid]))
        if (shortPrefix) strongOnly.add(tid)
      } else if (typos > 0 && this.termLengths[tid] >= qLength - typos && !isNumeric(t)) {
        const d = prefixDistance(q, t, typos)
        if (d <= typos) quality.set(tid, d === 1 ? QUALITY.typo1 : QUALITY.typo2)
      }
    }
    return { quality, strongOnly }
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const words = queryTerms(query)
    if (!words.length) return []
    const matches = words.map((q) => this.match(q))
    // Recordings holding every word somewhere (strong-only matches are checked per unit below).
    let candidates: Set<Doc> | null = null
    for (const m of matches) {
      const docs = new Set<Doc>()
      for (const tid of m.quality.keys()) for (const d of this.postings[tid]) if (!candidates || candidates.has(d)) docs.add(d)
      candidates = docs
      if (!docs.size) return []
    }
    const hits: SearchHit[] = []
    for (const doc of candidates ?? []) {
      if (options.only && !options.only.has(doc.id)) continue
      const hit = scoreDoc(doc, matches, options.moments ?? SEARCH_LIMITS.moments)
      if (hit) hits.push(hit)
    }
    hits.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    return hits.slice(0, options.hits ?? SEARCH_LIMITS.hits)
  }
}

interface ScoredUnit {
  data: UnitData
  score: number
  terms: number
  ranges: Range[]
}

/** Whether nothing of `start..end` is kept (no clip overlaps it; a point is cut when no clip holds it). */
export function isCut(kept: readonly (readonly [number, number])[], start: number, end: number): boolean {
  if (!kept.length) return false
  return !kept.some(([s, e]) => (end > start ? s < end && e > start : start >= s && start < e))
}

function scoreUnit(data: UnitData, matches: TermMatches[]): ScoredUnit | null {
  const kind = data.unit.kind
  const strong = STRONG_KINDS.has(kind)
  const best = new Array<number>(matches.length).fill(0)
  const ranges: Range[] = []
  // Which query word each position matches (-1: none), for the phrase bonus.
  const at = new Int8Array(data.terms.length).fill(-1)
  for (let k = 0; k < data.terms.length; k++) {
    const tid = data.terms[k]
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]
      const q = m.quality.get(tid)
      if (q === undefined || (!strong && m.strongOnly.has(tid))) continue
      if (q > best[i]) best[i] = q
      if (at[k] < 0) at[k] = i
      ranges.push([data.starts[k], data.ends[k]])
    }
  }
  const terms = best.filter((q) => q > 0).length
  if (!terms) return null
  const weight = KIND_WEIGHT[kind]
  let score = best.reduce((a, b) => a + b, 0) * weight
  if (matches.length > 1 && hasPhrase(at, matches.length)) score += PHRASE_BONUS * weight
  return { data, score, terms, ranges }
}

/** The query's words next to each other in the order typed. */
function hasPhrase(at: Int8Array, n: number): boolean {
  for (let k = 0; k + n <= at.length; k++) {
    let i = 0
    while (i < n && at[k + i] === i) i++
    if (i === n) return true
  }
  return false
}

function scoreDoc(doc: Doc, matches: TermMatches[], momentLimit: number): SearchHit | null {
  const scored: ScoredUnit[] = []
  const found = new Array<boolean>(matches.length).fill(false)
  for (const data of doc.units) {
    const s = scoreUnit(data, matches)
    if (!s) continue
    scored.push(s)
    // Which words this unit holds (scoreUnit counted them; recount per word for the AND).
    for (let i = 0; i < matches.length; i++) {
      if (found[i]) continue
      const m = matches[i]
      for (const tid of data.terms) {
        if (m.quality.has(tid) && (STRONG_KINDS.has(data.unit.kind) || !m.strongOnly.has(tid))) {
          found[i] = true
          break
        }
      }
    }
  }
  if (!found.every(Boolean)) return null
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const score = best.score + OTHER_UNIT_BONUS * Math.min(OTHER_UNITS_COUNTED, scored.length - 1) + (best.terms === matches.length ? ALL_TERMS_BONUS : 0)

  const nameUnit = scored.find((s) => s.data.unit.kind === 'name')
  const title = nameUnit ? markRanges(nameUnit.data.unit.text, nameUnit.ranges) : [{ text: doc.entry.name, hit: false }]
  const momentUnits = scored
    .filter((s) => s.data.unit.kind !== 'name' && s.data.unit.kind !== 'file')
    .sort((a, b) => b.terms - a.terms || b.score - a.score || (a.data.unit.start ?? Infinity) - (b.data.unit.start ?? Infinity))
  const moments: SearchMoment[] = momentUnits.slice(0, momentLimit).map((s) => {
    const u = s.data.unit
    return {
      kind: u.kind,
      start: u.start,
      end: u.end,
      snippet: snippetOf(u.text, s.ranges),
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
