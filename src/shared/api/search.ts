/**
 * Search every recording (F-18, docs/design/search.md) between Home and the main process. Every
 * channel answers the main window's own page only.
 */
import type { SearchResponse, SearchStatus } from '../search/types'

export type { SearchHit, SearchMoment, SearchResponse, SearchStatus, SnippetPart } from '../search/types'

export const SEARCH_CHANNELS = {
  /** invoke, Home (query: string) → SearchResponse. */
  query: 'search:query',
  /** invoke, Home → SearchStatus, once the index matches the folders again (Home's list changed). */
  refresh: 'search:refresh',
  /** main → Home: SearchStatus while the index is built, and when it is ready. */
  status: 'search:status'
} as const

export interface SearchApi {
  /** Recordings matching every word of `query`, best first, with their moments. */
  searchLibrary(query: string): Promise<SearchResponse>
  /** Brings the index up to date with the project folders (a recording was added or deleted). */
  refreshSearch(): Promise<SearchStatus>
  onSearchStatus(cb: (status: SearchStatus) => void): () => void
}
