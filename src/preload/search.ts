import { ipcRenderer } from 'electron'
import type { SearchApi, SearchStatus } from '../shared/api/search'
import { subscribe } from './ipc'

// Channel names as in SEARCH_CHANNELS (src/shared/api/search.ts), written out so the sandboxed preload
// bundle imports nothing but types (tests/searchService.test.ts checks them).
export const searchApi: SearchApi = {
  searchLibrary: (query) => ipcRenderer.invoke('search:query', query),
  refreshSearch: () => ipcRenderer.invoke('search:refresh'),
  onSearchStatus: (cb) => subscribe<SearchStatus>('search:status', cb)
}
