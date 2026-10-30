/**
 * What the index keeps of a project (docs/design/search.md §2.2): its name, imported file name,
 * chapters, title cards, text on screen, captions and speaker notes, each a unit with its time.
 * Read defensively: project.json may be old, damaged or edited by hand; anything that is not what
 * it should be is left out, never an error.
 */
import { importedSource } from '../import/imported'
import type { Project } from '../types'
import { SEARCH_LIMITS, type IndexedProject, type SearchUnit } from './types'

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const listOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : [])

/** Text worth indexing: a string with something other than spaces, capped. */
function textOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s.slice(0, SEARCH_LIMITS.unitChars) : null
}

/** Paragraphs of the speaker notes: split on line breaks, at most notesUnits of them. */
function notesParagraphs(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = textOf(line)
    if (!t) continue
    if (out.length === SEARCH_LIMITS.notesUnits) break
    out.push(t)
  }
  return out
}

/** The units of a project, in a stable order (name, file, chapters, titles, text, captions, notes), within the text cap. */
export function projectUnits(raw: unknown): SearchUnit[] {
  if (!isObject(raw)) return []
  const p = raw as Partial<Record<keyof Project, unknown>>
  const units: SearchUnit[] = []
  let chars = 0
  const add = (kind: SearchUnit['kind'], text: string | null, start: number | null = null, end: number | null = start): void => {
    if (!text || chars + text.length > SEARCH_LIMITS.projectChars) return
    chars += text.length
    units.push({ kind, start, end: end ?? start, text })
  }

  add('name', textOf(p.name))
  const source = importedSource(raw as Pick<Project, 'source'>)
  if (source) add('file', textOf(source.fileName))
  for (const c of listOf(p.chapters)) {
    const t = time(c.t)
    if (t !== null) add('chapter', textOf(c.title), t, t)
  }
  for (const c of listOf(p.titles)) {
    const start = time(c.start)
    if (start === null) continue
    const end = Math.max(start, time(c.end) ?? start)
    const words = [textOf(c.title), textOf(c.subtitle)].filter((s): s is string => !!s).join(' · ')
    add('title', textOf(words), start, end)
  }
  for (const a of listOf(p.annotations)) {
    const start = time(a.start)
    if (start !== null) add('text', textOf(a.text), start, Math.max(start, time(a.end) ?? start))
  }
  const transcript = isObject(p.transcript) ? p.transcript : null
  for (const s of listOf(transcript?.segments)) {
    const start = time(s.start)
    if (start !== null) add('said', textOf(s.text), start, Math.max(start, time(s.end) ?? start))
  }
  const script = isObject(p.script) && typeof p.script.text === 'string' ? p.script.text : ''
  for (const para of notesParagraphs(script)) add('notes', para)
  return units
}

/** The clips' source ranges, sorted; none (everything counts as kept) when they cannot be read. */
export function keptRanges(raw: unknown): [number, number][] {
  const out: [number, number][] = []
  for (const c of listOf(raw)) {
    const start = time(c.start)
    const end = time(c.end)
    if (start !== null && end !== null && end > start) out.push([start, end])
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, 10_000)
}

/** The index entry of a project read from project.json (`stamp`: its mtimeMs:size). Null when it is not a project. */
export function indexedProject(raw: unknown, stamp: string): IndexedProject | null {
  if (!isObject(raw)) return null
  const transcript = isObject(raw.transcript) ? raw.transcript : null
  return {
    stamp,
    name: typeof raw.name === 'string' ? raw.name.slice(0, SEARCH_LIMITS.unitChars) : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : '',
    duration: time(raw.duration) ?? 0,
    units: projectUnits(raw),
    hasTranscript: listOf(transcript?.segments).length > 0,
    kept: keptRanges(raw.clips)
  }
}
