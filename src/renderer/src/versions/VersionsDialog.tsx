import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ReadVersion } from '../../../shared/api/versions'
import {
  changedAreas,
  compareSummaries,
  defaultVersionName,
  summaryLine,
  VERSION_LIMITS,
  versionSummary,
  versionTime,
  type SummaryChange,
  type VersionMeta
} from '../../../shared/editor/versions'
import { formatBytes } from '../../../shared/storage/rules'
import type { Project } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { ipcMessage } from '../editor/captionItems'
import { useModalFocus } from '../editor/modalFocus'
import { keepVersionBefore, onVersionsChanged, versionsChanged } from './autoVersion'
import './versions.css'

/** What a row shows below itself: nothing, the comparison, the rename field or the delete question. */
type RowView =
  | { id: string; kind: 'compare'; result: { changes: SummaryChange[]; areas: string[] } | 'loading' | { error: string } }
  | { id: string; kind: 'rename' }
  | { id: string; kind: 'delete' }

const listPhrase = (items: string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/**
 * Versions of the edit (E-12, docs/design/versions.md §2.4, §2.7): save one, and list, compare,
 * open, rename or delete the kept ones. Opening keeps the edit now as an automatic version first;
 * `onOpen` puts the version in place (one undo step).
 */
export function VersionsDialog({
  getProject,
  focusName,
  onOpen,
  onNotice,
  onClose
}: {
  /** The edit as it is at the moment of asking (store.state). */
  getProject: () => Project
  /** Opened with Save a version: the name field takes the focus. */
  focusName: boolean
  onOpen: (version: ReadVersion) => void
  onNotice: (text: string) => void
  onClose: () => void
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useModalFocus(boxRef, onClose)
  const projectId = getProject().id
  const [list, setList] = useState<VersionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [row, setRow] = useState<RowView | null>(null)
  const [renameText, setRenameText] = useState('')
  /** The version whose rename field Esc closed: its blur, which follows, must not save. */
  const renameCancelled = useRef<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList(await window.api.listVersions(projectId))
    } catch (err) {
      setList([])
      setError(`Could not list the versions: ${ipcMessage(err)}`)
    }
  }, [projectId])
  useEffect(() => void refresh(), [refresh])
  useEffect(() => onVersionsChanged(() => void refresh()), [refresh])
  useEffect(() => {
    ;(focusName ? nameRef.current : boxRef.current)?.focus({ preventScroll: true })
  }, [focusName])

  const named = (list ?? []).filter((v) => !v.auto).length
  const full = named >= VERSION_LIMITS.named

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || full) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.saveVersion(projectId, getProject(), { name })
      setName('')
      if (r.saved) onNotice(`Saved “${r.saved.name}”`)
      versionsChanged()
    } catch (err) {
      setError(`Could not save the version: ${ipcMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const open = async (v: VersionMeta): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // The edit now first: going back to it is always possible.
      await keepVersionBefore(getProject(), 'open', v.name)
      onOpen(await window.api.readVersion(projectId, v.id))
    } catch (err) {
      setError(`Could not open this version: ${ipcMessage(err)}`)
      setBusy(false)
    }
  }

  const compare = async (v: VersionMeta): Promise<void> => {
    if (row?.id === v.id && row.kind === 'compare') return setRow(null)
    setRow({ id: v.id, kind: 'compare', result: 'loading' })
    try {
      const r = await window.api.readVersion(projectId, v.id)
      const now = getProject()
      const result = { changes: compareSummaries(versionSummary(r.project), versionSummary(now)), areas: changedAreas(r.project, now) }
      setRow((cur) => (cur?.id === v.id && cur.kind === 'compare' ? { ...cur, result } : cur))
    } catch (err) {
      setRow((cur) => (cur?.id === v.id && cur.kind === 'compare' ? { ...cur, result: { error: ipcMessage(err) } } : cur))
    }
  }

  const rename = async (v: VersionMeta): Promise<void> => {
    if (renameCancelled.current === v.id) return
    renameCancelled.current = v.id
    try {
      await window.api.renameVersion(projectId, v.id, renameText)
      setRow(null)
      versionsChanged()
    } catch (err) {
      renameCancelled.current = null
      setError(`Could not rename the version: ${ipcMessage(err)}`)
    }
  }

  const remove = async (v: VersionMeta): Promise<void> => {
    try {
      await window.api.deleteVersion(projectId, v.id)
      setRow(null)
      onNotice(`Deleted “${v.name}”`)
      versionsChanged()
      boxRef.current?.focus({ preventScroll: true })
    } catch (err) {
      setError(`Could not delete the version: ${ipcMessage(err)}`)
    }
  }

  /** Esc in a row's field or question closes that, not the dialog. */
  const escapeRow = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    setRow(null)
  }

  return (
    <div className="overlay modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal versions-modal" role="dialog" aria-modal="true" aria-labelledby="versions-title" ref={boxRef} tabIndex={-1} data-testid="versions-dialog">
        <header className="modal-head">
          <h2 id="versions-title">Versions</h2>
          <button type="button" className="btn ghost icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </header>
        <p className="hint versions-intro">A version keeps this edit as it is now. Your recording is never changed.</p>
        <form className="versions-save" onSubmit={(e) => void save(e)}>
          <input
            ref={nameRef}
            type="text"
            aria-label="Version name"
            placeholder={defaultVersionName(named)}
            maxLength={VERSION_LIMITS.name}
            value={name}
            disabled={full}
            onChange={(e) => setName(e.target.value)}
            data-testid="version-name"
          />
          <button type="submit" className="btn primary" disabled={busy || full} data-testid="version-save">
            Save version
          </button>
        </form>
        {full && <p className="hint">You have {VERSION_LIMITS.named} saved versions. Delete one to save another.</p>}
        {error && (
          <p className="versions-error" role="alert">
            {error}
          </p>
        )}
        <div className="versions-list" aria-busy={list === null}>
          {list !== null && list.length === 0 && <p className="hint versions-empty">No versions yet. Save one before a big change, so you can always go back.</p>}
          {list !== null && list.length > 0 && (
            <ul aria-label="Kept versions">
              {list.map((v) => {
                const view = row?.id === v.id ? row : null
                return (
                  <li key={v.id} className="version-row" data-testid="version-row" data-version={v.id} data-auto={v.auto}>
                    <div className="version-main">
                      <div className="version-text" title={formatBytes(v.bytes)}>
                        {view?.kind === 'rename' ? (
                          <input
                            className="version-rename"
                            type="text"
                            aria-label={`New name for ${v.name}`}
                            autoFocus
                            maxLength={VERSION_LIMITS.name}
                            value={renameText}
                            onChange={(e) => setRenameText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') renameCancelled.current = v.id
                              escapeRow(e)
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                void rename(v)
                              }
                            }}
                            onBlur={() => void rename(v)}
                          />
                        ) : (
                          <span className="version-name">{v.name}</span>
                        )}
                        <span className="version-meta">
                          {v.auto && <span className="version-badge">Automatic</span>}
                          <span>{versionTime(v.createdAt)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{summaryLine(v.summary)}</span>
                        </span>
                      </div>
                      <div className="version-actions">
                        <button type="button" className="btn small primary" disabled={busy} onClick={() => void open(v)} aria-label={`Open ${v.name}`} title="Open this version: your edit now is kept as a version first">
                          Open
                        </button>
                        <button type="button" className="btn small" aria-expanded={view?.kind === 'compare'} onClick={() => void compare(v)} aria-label={`Compare ${v.name} with your edit now`}>
                          Compare
                        </button>
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={() => {
                            renameCancelled.current = null
                            setRenameText(v.name)
                            setRow({ id: v.id, kind: 'rename' })
                          }}
                          aria-label={`Rename ${v.name}`}
                        >
                          Rename
                        </button>
                        <button type="button" className="btn small ghost danger" onClick={() => setRow({ id: v.id, kind: 'delete' })} aria-label={`Delete ${v.name}`}>
                          Delete
                        </button>
                      </div>
                    </div>
                    {view?.kind === 'compare' && <CompareView result={view.result} />}
                    {view?.kind === 'delete' && (
                      <div className="version-confirm" role="group" aria-label={`Delete ${v.name}?`} onKeyDown={escapeRow}>
                        <span>Delete “{v.name}”? This cannot be undone.</span>
                        <button type="button" className="btn small danger" autoFocus onClick={() => void remove(v)} data-testid="version-delete-confirm">
                          Delete
                        </button>
                        <button type="button" className="btn small" onClick={() => setRow(null)}>
                          Keep
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <footer className="modal-foot versions-foot">
          <p className="hint">Flown also keeps a version before Polish, Remove all and Make a vertical version (the last {VERSION_LIMITS.auto}).</p>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}

function CompareView({ result }: { result: { changes: SummaryChange[]; areas: string[] } | 'loading' | { error: string } }): JSX.Element {
  if (result === 'loading') return <p className="hint version-compare">Comparing…</p>
  if ('error' in result) return <p className="versions-error version-compare">Could not compare: {result.error}</p>
  const { changes, areas } = result
  if (changes.length === 0 && areas.length === 0)
    return (
      <p className="hint version-compare" data-testid="version-compare">
        Same as your edit now.
      </p>
    )
  return (
    <div className="version-compare" data-testid="version-compare">
      {changes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">What</span>
              </th>
              <th scope="col">This version</th>
              <th scope="col">Now</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.label}>
                <th scope="row">{c.label}</th>
                <td>{c.version}</td>
                <td>{c.now}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {areas.length > 0 && <p className="hint">{changes.length ? 'Also different' : 'Different'}: {listPhrase(areas)}.</p>}
    </div>
  )
}
