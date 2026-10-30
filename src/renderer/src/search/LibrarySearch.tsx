/**
 * Search every recording (F-18, docs/design/search.md §1, §5): the box under Recent recordings on
 * Home and its results, grouped by recording. A combobox: focus stays in the box, arrow keys move
 * through the results (aria-activedescendant), Enter opens the recording at the moment, Escape
 * clears. Ctrl+F puts the cursor in the box. While there is text, the recording grid is hidden
 * (search.css) and the results take its place.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SearchResponse, SearchStatus, SnippetPart } from '../../../shared/api/search'
import { clockTime, KIND_LABEL, resultsSummary } from '../../../shared/search/moment'
import type { ProjectSummary } from '../../../shared/types'
import { clearPendingMoment, setPendingMoment } from './openAt'
import { dateOf, resultRows, rowLabel, type Row } from './rows'
import './search.css'

/** Typing pause before a query is sent (§4). */
export const SEARCH_DEBOUNCE_MS = 150

/** A snippet's parts as text, matched words in <mark> (never HTML: docs/design/search.md §2.7). */
function Snippet({ parts }: { parts: SnippetPart[] }): JSX.Element {
  return (
    <>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  )
}

export function LibrarySearch({ projects, onOpen }: { projects: ProjectSummary[]; onOpen: (projectId: string) => void }): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [status, setStatus] = useState<SearchStatus | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const seq = useRef(0)
  const searching = query.trim().length > 0

  // A moment picked before, never taken (its editor failed to open): it must not apply later.
  useEffect(() => clearPendingMoment(), [])

  const run = useCallback((q: string) => {
    const n = ++seq.current
    if (!q.trim()) {
      setResponse(null)
      return
    }
    window.api.searchLibrary(q).then(
      (r) => {
        if (n === seq.current) setResponse(r)
      },
      () => console.warn('Search failed')
    )
  }, [])

  // Typing: a query 150 ms after the last key.
  useEffect(() => {
    const timer = window.setTimeout(() => run(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, run])

  // New results start with nothing active and nothing expanded.
  useEffect(() => {
    setActive(-1)
    setExpanded(new Set())
  }, [response])

  // While the index is built, results fill in as it goes.
  const queryRef = useRef(query)
  queryRef.current = query
  useEffect(
    () =>
      window.api.onSearchStatus((s) => {
        setStatus(s)
        if (queryRef.current.trim()) run(queryRef.current)
      }),
    [run]
  )

  // The library changed (a recording added, deleted, recovered): bring the index up to date.
  const idsKey = useMemo(() => projects.map((p) => p.id).join('\n'), [projects])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    window.api.refreshSearch().then(
      (s) => {
        setStatus(s)
        if (queryRef.current.trim()) run(queryRef.current)
      },
      () => undefined
    )
  }, [idsKey, run])

  // Ctrl+F on Home puts the cursor in the box (not while a dialog is open over Home).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
      if (document.querySelector('[role="dialog"][aria-modal="true"], .modal, dialog[open]')) return
      e.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Only recordings Home lists (one deleted a moment ago is gone at once).
  const known = useMemo(() => new Set(projects.map((p) => p.id)), [projects])
  const hits = useMemo(() => (searching && response ? response.hits.filter((h) => known.has(h.id)) : []), [searching, response, known])
  const rows = useMemo(() => resultRows(hits, expanded), [hits, expanded])
  const activeRow = active >= 0 ? rows[active] : undefined
  const optionId = (key: string): string => `${listId}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const activeId = activeRow ? optionId(activeRow.key) : undefined

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const activate = (row: Row): void => {
    if (row.kind === 'more') {
      const next = new Set(expanded)
      next.add(row.hit.id)
      setExpanded(next)
      // Stay on the first moment that was hidden.
      setActive(rows.indexOf(row))
      return
    }
    if (row.kind === 'moment' && row.moment.start !== null) setPendingMoment(row.hit.id, row.moment.start)
    else clearPendingMoment()
    onOpen(row.hit.id)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + step))))
    } else if (e.key === 'Enter') {
      // Still composing (an input method, as many Bangla keyboards use): the Enter is the IME's.
      if (e.nativeEvent.isComposing) return
      const row = activeRow ?? rows[0]
      if (!row) return
      e.preventDefault()
      activate(row)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (query) setQuery('')
      else input.current?.blur()
    }
  }

  if (projects.length === 0) return null

  const live = status ?? response?.status ?? null
  const building = live?.state === 'building'
  const summary = searching && response ? resultsSummary(hits.length, response.query) : ''

  return (
    <div className="library-search" data-active={searching ? 'true' : 'false'}>
      <div className="library-search-box">
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="icon">
          <path d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8" />
        </svg>
        <input
          ref={input}
          type="search"
          role="combobox"
          placeholder="Search recordings"
          aria-label="Search recordings: words said, titles, chapters and notes"
          title="Search every recording (Ctrl+F)"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          value={query}
          maxLength={200}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid="library-search"
        />
        {query && (
          <button type="button" className="btn ghost icon-btn library-search-clear" aria-label="Clear search" title="Clear search" onClick={() => (setQuery(''), input.current?.focus())}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="icon">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {summary}
      </p>
      {searching && (
        <div className="search-results">
          {building && live && (
            <p className="hint search-building">
              Still indexing your recordings{live.total ? ` (${live.indexed} of ${live.total})` : ''}…
            </p>
          )}
          {response && hits.length === 0 && (
            <div className="search-empty">
              <strong>{summary}</strong>
              <p>
                Search looks in what was said (captions), titles, chapters, text on screen, speaker notes and names.
                {response.withoutTranscript > 0 && ' Recordings without captions are found by their name, titles, chapters, text on screen and notes.'}
              </p>
            </div>
          )}
          <div id={listId} role="listbox" aria-label="Search results" className="search-list" hidden={rows.length === 0}>
            {hits.map((hit) => (
              <div key={hit.id} role="group" aria-label={hit.name || 'Untitled'} className="search-hit">
                {rows
                  .map((row, index) => ({ row, index }))
                  .filter(({ row }) => row.hit === hit)
                  .map(({ row, index }) => (
                    <div
                      key={row.key}
                      id={optionId(row.key)}
                      role="option"
                      aria-selected={index === active}
                      aria-label={rowLabel(row)}
                      className={`search-row search-${row.kind}${index === active ? ' active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => activate(row)}
                      onMouseMove={() => index !== active && setActive(index)}
                    >
                      {row.kind === 'open' && (
                        <>
                          <span className="search-hit-name">
                            <Snippet parts={hit.title} />
                          </span>
                          <span className="search-hit-meta">
                            {dateOf(hit.createdAt)} · {clockTime(hit.duration)}
                            {hit.nameOnly && ' · Found in the name'}
                          </span>
                        </>
                      )}
                      {row.kind === 'moment' && (
                        <>
                          <span className="search-time">{row.moment.start === null ? '' : clockTime(row.moment.start)}</span>
                          <span className="search-kind">{KIND_LABEL[row.moment.kind]}</span>
                          <span className="search-snippet">
                            <Snippet parts={row.moment.snippet} />
                          </span>
                          {row.moment.cut && (
                            <span className="search-cut" title="This part was cut from the video">
                              Cut
                            </span>
                          )}
                        </>
                      )}
                      {row.kind === 'more' && (
                        <span className="search-more-label">
                          {row.count} more moment{row.count === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
