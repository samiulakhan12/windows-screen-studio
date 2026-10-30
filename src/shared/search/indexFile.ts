/**
 * The index file, userData/search/index.json (docs/design/search.md §2.8): the text of each
 * recording, not its terms (made again on load). Anything that does not validate is dropped and
 * built again from the project; a file of another version is dropped whole.
 */
import { SEARCH_INDEX_VERSION, SEARCH_KINDS, SEARCH_LIMITS, type IndexedProject, type SearchKind, type SearchUnit } from './types'

/** A unit as stored: [kind, start, end, text]. */
type StoredUnit = [SearchKind, number | null, number | null, string]

interface StoredProject {
  stamp: string
  name: string
  createdAt: string
  duration: number
  hasTranscript: boolean
  kept: [number, number][]
  units: StoredUnit[]
}

export interface IndexFile {
  version: number
  projects: Record<string, StoredProject>
}

const ID_RE = /^[a-zA-Z0-9_-]+$/
/** Most kept ranges an entry holds (extract.ts keptRanges). */
const MAX_KEPT = 10_000
const KINDS: ReadonlySet<string> = new Set(SEARCH_KINDS)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const timeOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
const isRange = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[1] > v[0]

function readUnit(v: unknown): SearchUnit | null {
  if (!Array.isArray(v) || v.length !== 4) return null
  const [kind, start, end, text] = v as unknown[]
  if (typeof kind !== 'string' || !KINDS.has(kind) || !timeOrNull(start) || !timeOrNull(end) || typeof text !== 'string') return null
  return { kind: kind as SearchKind, start, end, text: text.slice(0, SEARCH_LIMITS.unitChars) }
}

/** One stored project, or null when any part of it does not validate (it is then read again from its folder). */
function readProject(v: unknown): IndexedProject | null {
  if (!isObject(v)) return null
  const { stamp, name, createdAt, duration, hasTranscript, kept, units } = v
  if (typeof stamp !== 'string' || typeof name !== 'string' || typeof createdAt !== 'string' || typeof duration !== 'number' || !Number.isFinite(duration)) return null
  if (typeof hasTranscript !== 'boolean' || !Array.isArray(kept) || !kept.every(isRange) || !Array.isArray(units)) return null
  // The caps of extract.ts: an entry over them was not written by Flown (or is damaged), and could
  // stall the main process while it is indexed; it is read again from its project instead.
  if (kept.length > MAX_KEPT || units.length > SEARCH_LIMITS.projectChars) return null
  const out: SearchUnit[] = []
  let chars = 0
  let notes = 0
  for (const u of units) {
    const unit = readUnit(u)
    if (!unit) return null
    chars += unit.text.length
    if (unit.kind === 'notes') notes++
    if (chars > SEARCH_LIMITS.projectChars || notes > SEARCH_LIMITS.notesUnits) return null
    out.push(unit)
  }
  return { stamp, name, createdAt, duration, hasTranscript, kept: kept.map(([s, e]) => [s, e]), units: out }
}

/** The projects of a parsed index file; empty for a file of another version or one that is not an index. */
export function parseIndexFile(raw: unknown): Map<string, IndexedProject> {
  const out = new Map<string, IndexedProject>()
  if (!isObject(raw) || raw.version !== SEARCH_INDEX_VERSION || !isObject(raw.projects)) return out
  for (const [id, value] of Object.entries(raw.projects)) {
    if (!ID_RE.test(id)) continue
    const p = readProject(value)
    if (p) out.set(id, p)
  }
  return out
}

/** The file's JSON (compact: it is read by Flown only). */
export function serializeIndex(projects: ReadonlyMap<string, IndexedProject>): string {
  // No prototype: a project folder named __proto__ is an entry like any other.
  const file: IndexFile = { version: SEARCH_INDEX_VERSION, projects: Object.create(null) as IndexFile['projects'] }
  for (const [id, p] of projects) {
    file.projects[id] = {
      stamp: p.stamp,
      name: p.name,
      createdAt: p.createdAt,
      duration: p.duration,
      hasTranscript: p.hasTranscript,
      kept: p.kept,
      units: p.units.map((u) => [u.kind, u.start, u.end, u.text])
    }
  }
  return JSON.stringify(file)
}
