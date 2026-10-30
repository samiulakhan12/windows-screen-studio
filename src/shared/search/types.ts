/**
 * Search every recording (F-18, docs/design/search.md): what the index holds and what a query
 * returns. Pure data, shared by the main process (which owns the index) and Home (which shows it).
 */

/**
 * Bump when WHAT is extracted from a project changes (docs/design/search.md §2.8): an index file
 * of another version is built again. A change in how text is split into terms needs no bump,
 * since terms are made again whenever the file is loaded.
 */
export const SEARCH_INDEX_VERSION = 1

/** Where in a recording words were found. */
export type SearchKind = 'name' | 'file' | 'chapter' | 'title' | 'text' | 'said' | 'notes'

export const SEARCH_KINDS: readonly SearchKind[] = ['name', 'file', 'chapter', 'title', 'text', 'said', 'notes']

/** A piece of a recording's text: its kind, its time (source seconds; null when it has none) and its text. */
export interface SearchUnit {
  kind: SearchKind
  start: number | null
  end: number | null
  text: string
}

/** What the index keeps of one project (also what the index file stores, units as tuples). */
export interface IndexedProject {
  /** project.json's `mtimeMs:size` when it was read; a different stamp means it is read again. */
  stamp: string
  name: string
  createdAt: string
  duration: number
  units: SearchUnit[]
  /** It has a transcript (so words said can be found in it). */
  hasTranscript: boolean
  /** The kept parts of the recording (its clips, source seconds), to tell a moment that was cut. */
  kept: [number, number][]
}

/** A piece of a snippet: plain text, `hit` when it is a matched word. Never HTML. */
export interface SnippetPart {
  text: string
  hit: boolean
}

/** A place in a recording where the words were found. */
export interface SearchMoment {
  kind: SearchKind
  /** Source seconds; null for notes (no time). */
  start: number | null
  end: number | null
  snippet: SnippetPart[]
  /** How many of the query's words it holds. */
  terms: number
  /** Its time is cut from the video (nothing of it is kept). */
  cut: boolean
}

/** A recording that matches every word of the query. */
export interface SearchHit {
  id: string
  name: string
  createdAt: string
  duration: number
  /** The name, with its matched words marked. */
  title: SnippetPart[]
  score: number
  /** Best first; `name` and `file` matches are not moments (the name is the heading). */
  moments: SearchMoment[]
  /** Matching moments beyond those returned. */
  more: number
  /** Found in its name or its imported file's name only. */
  nameOnly: boolean
}

/** How far the index is. */
export interface SearchStatus {
  /** 'building': the first build or a rebuild is running; results so far are partial. */
  state: 'idle' | 'building' | 'ready'
  /** Recordings indexed, and how many there are (known once the folders are listed). */
  indexed: number
  total: number
}

export interface SearchResponse {
  /** The query as it was understood (trimmed, capped). */
  query: string
  hits: SearchHit[]
  status: SearchStatus
  /** Recordings indexed without a transcript (Home explains that words said cannot be found in them). */
  withoutTranscript: number
}

/** Numbers of docs/design/search.md §4. */
export const SEARCH_LIMITS = {
  queryChars: 200,
  queryTerms: 8,
  hits: 50,
  moments: 50,
  unitChars: 2000,
  projectChars: 400_000,
  notesUnits: 200,
  termCodePoints: 40,
  snippetBefore: 60,
  snippetAfter: 120
} as const
