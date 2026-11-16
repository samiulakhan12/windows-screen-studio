import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ReadVersion } from '../../../shared/api/versions'
import { changedAreas, VERSION_LIMITS, versionSummary, type SummaryChange, type VersionMeta } from '../../../shared/editor/versions'
import { migrateProject } from '../../../shared/engine/project'
import { fmt } from '../../../shared/i18n/fmt'
import { t, uiLanguage } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { ipcMessage } from '../editor/captionItems'
import { useModalFocus } from '../editor/modalFocus'
import { keepVersionBefore, onVersionsChanged, protecting, versionsChanged } from './autoVersion'
import { areaName, compareSummaries, summaryLine } from '../../../shared/editor/versionWords'
import './versions.css'

/** What a row shows below itself: nothing, the comparison, the rename field or the delete question. */
type RowView =
  | { id: string; kind: 'compare'; result: { changes: SummaryChange[]; areas: string[] } | 'loading' | { error: string } }
  | { id: string; kind: 'rename' }
  | { id: string; kind: 'delete' }

/**
 * Versions of the edit (E-12, docs/design/versions.md §2.4, §2.7): save one, and list, compare,
 * open, rename or delete the kept ones. Opening keeps the edit now as an automatic version first;
 * `onOpen` puts the version in place (one undo step).
 */
export function VersionsDialog({
  getProject,
  settle,
  focusName,
  onOpen,
  onNotice,
  onClose
}: {
  /** The edit as it is at the moment of asking (store.state). */
  getProject: () => Project
  /**
   * Has work still holding the edit (Review mode's Remove all) make its edit at once (store.finish),
   * before a version is saved or the edit is kept to open one: the version has it, and nothing lands
   * on a version opened.
   */
  settle?: () => void
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
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList(await window.api.listVersions(projectId))
    } catch (err) {
      setList([])
      setError(t('review.versions.error.list', { error: ipcMessage(err) }))
    }
  }, [projectId])
  useEffect(() => void refresh(), [refresh])
  useEffect(() => onVersionsChanged(() => void refresh()), [refresh])
  useEffect(() => {
    ;(focusName ? nameRef.current : boxRef.current)?.focus({ preventScroll: true })
  }, [focusName])
  const latestList = useRef(list)
  latestList.current = list
  // Keep, Esc or a finished rename takes the focused control away with the row's view: the focus
  // goes back to that row's own button, not to the page (a row that went, or a focus that moved
  // on, is left alone).
  const lastRow = useRef<RowView | null>(null)
  useEffect(() => {
    const was = lastRow.current
    lastRow.current = row
    if (!was || row || document.activeElement !== document.body) return
    const v = latestList.current?.find((x) => x.id === was.id)
    if (!v) return
    const label = was.kind === 'rename' ? t('review.versions.renameName', { name: v.name }) : was.kind === 'delete' ? t('common.action.deleteName', { name: v.name }) : t('review.versions.compareName', { name: v.name })
    // The button by its whole name in the UI language (the row has one of each), quoted as a CSS string.
    boxRef.current?.querySelector<HTMLElement>(`[data-version="${was.id}"] button[aria-label^="${label.replace(/["\\]/g, '\\$&')}"]`)?.focus({ preventScroll: true })
  }, [row])

  const named = (list ?? []).filter((v) => !v.auto).length
  const full = named >= VERSION_LIMITS.named
  /** The name a version saved with the field left empty gets: main names it "Version 3" in English; another UI language sends this name. */
  const defaultName = t('review.versions.defaultName', { n: fmt.count(named + 1) })

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || full) return
    setBusy(true)
    setError(null)
    try {
      settle?.()
      const r = await window.api.saveVersion(projectId, getProject(), { name: (name.trim() || uiLanguage() === 'en') ? name : defaultName })
      setName('')
      if (r.saved) onNotice(t('review.versions.saved', { name: r.saved.name }))
      versionsChanged()
    } catch (err) {
      setError(t('review.versions.error.save', { error: ipcMessage(err) }))
    } finally {
      setBusy(false)
    }
  }

  const open = async (v: VersionMeta): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // The edit now first: going back to it is always possible. Without it, nothing is opened. Work
      // holding the edit makes it first, and the version it keeps (Remove all) never prunes this one.
      if (settle) protecting(v.id, settle)
      const kept = await keepVersionBefore(getProject(), 'open', v.name, v.id)
      if (kept && 'failed' in kept) throw new Error(t('review.versions.error.keepFirst', { reason: kept.failed }))
      const read = await window.api.readVersion(projectId, v.id)
      // Closed meanwhile (Esc): the user no longer asked for it.
      if (mounted.current) onOpen(read)
    } catch (err) {
      setError(t('review.versions.error.open', { error: ipcMessage(err) }))
      setBusy(false)
    }
  }

  const compare = async (v: VersionMeta): Promise<void> => {
    if (row?.id === v.id && row.kind === 'compare') return setRow(null)
    setRow({ id: v.id, kind: 'compare', result: 'loading' })
    try {
      const r = await window.api.readVersion(projectId, v.id)
      // The edit now as it would be kept (saveVersion stores it migrated): a freeze at the edit's end is kept to 1 ms.
      const now = migrateProject(getProject())
      // Also a background or cursor image a later pick wrote over: the same name, another picture.
      const areas = [...changedAreas(r.project, now), ...r.changed].map(areaName)
      const result = { changes: compareSummaries(versionSummary(r.project), versionSummary(now)), areas }
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
      // Only the rename field: a question or comparison opened meanwhile (the click that left the field) stays.
      setRow((cur) => (cur?.id === v.id && cur.kind === 'rename' ? null : cur))
      versionsChanged()
    } catch (err) {
      renameCancelled.current = null
      setError(t('review.versions.error.rename', { error: ipcMessage(err) }))
    }
  }

  const remove = async (v: VersionMeta): Promise<void> => {
    try {
      await window.api.deleteVersion(projectId, v.id)
      setRow(null)
      onNotice(t('review.versions.deleted', { name: v.name }))
      versionsChanged()
      boxRef.current?.focus({ preventScroll: true })
    } catch (err) {
      setError(t('review.versions.error.delete', { error: ipcMessage(err) }))
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
          <h2 id="versions-title">{t('review.versions.title')}</h2>
          <button type="button" className="btn ghost icon-btn" onClick={onClose} title={t('common.action.close')} aria-label={t('common.action.close')}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <p className="hint versions-intro">{t('review.versions.intro')}</p>
        <form className="versions-save" onSubmit={(e) => void save(e)}>
          <input
            ref={nameRef}
            type="text"
            aria-label={t('review.versions.nameField')}
            placeholder={defaultName}
            maxLength={VERSION_LIMITS.name}
            value={name}
            disabled={full}
            onChange={(e) => setName(e.target.value)}
            data-testid="version-name"
          />
          <button type="submit" className="btn primary" disabled={busy || full} data-testid="version-save">
            {t('review.versions.save')}
          </button>
        </form>
        {full && <p className="hint">{t('review.versions.full', { n: fmt.count(VERSION_LIMITS.named) })}</p>}
        {error && (
          <p className="versions-error" role="alert">
            {error}
          </p>
        )}
        <div className="versions-list" aria-busy={list === null}>
          {list !== null && list.length === 0 && <p className="hint versions-empty">{t('review.versions.empty')}</p>}
          {list !== null && list.length > 0 && (
            <ul aria-label={t('review.versions.list')}>
              {list.map((v) => {
                const view = row?.id === v.id ? row : null
                return (
                  <li key={v.id} className="version-row" data-testid="version-row" data-version={v.id} data-auto={v.auto}>
                    <div className="version-main">
                      <div className="version-text" title={fmt.bytes(v.bytes, 'storage')}>
                        {view?.kind === 'rename' ? (
                          <input
                            className="version-rename"
                            type="text"
                            aria-label={t('review.versions.renameField', { name: v.name })}
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
                          {v.auto && <span className="version-badge">{t('review.versions.automatic')}</span>}
                          <span>{fmt.date(Date.parse(v.createdAt), 'version')}</span>
                          <span aria-hidden="true">·</span>
                          <span>{summaryLine(v.summary)}</span>
                        </span>
                      </div>
                      <div className="version-actions">
                        <button type="button" className="btn small primary" disabled={busy} onClick={() => void open(v)} aria-label={t('review.versions.openName', { name: v.name })} title={t('review.versions.openHint')}>
                          {t('review.versions.open')}
                        </button>
                        <button type="button" className="btn small" aria-expanded={view?.kind === 'compare'} onClick={() => void compare(v)} aria-label={t('review.versions.compareName', { name: v.name })}>
                          {t('review.versions.compare')}
                        </button>
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={() => {
                            renameCancelled.current = null
                            setRenameText(v.name)
                            setRow({ id: v.id, kind: 'rename' })
                          }}
                          aria-label={t('review.versions.renameName', { name: v.name })}
                        >
                          {t('review.versions.rename')}
                        </button>
                        <button type="button" className="btn small ghost danger" onClick={() => setRow({ id: v.id, kind: 'delete' })} aria-label={t('common.action.deleteName', { name: v.name })}>
                          {t('common.action.delete')}
                        </button>
                      </div>
                    </div>
                    {view?.kind === 'compare' && <CompareView result={view.result} />}
                    {view?.kind === 'delete' && (
                      <div className="version-confirm" role="group" aria-label={t('review.versions.deleteAsk', { name: v.name })} onKeyDown={escapeRow}>
                        <span>{t('review.versions.deleteQuestion', { name: v.name })}</span>
                        <button type="button" className="btn small danger" autoFocus onClick={() => void remove(v)} data-testid="version-delete-confirm">
                          {t('common.action.delete')}
                        </button>
                        <button type="button" className="btn small" onClick={() => setRow(null)}>
                          {t('common.action.keep')}
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
          <p className="hint" data-testid="versions-auto-hint">
            {t('review.versions.autoHint', { n: fmt.count(VERSION_LIMITS.auto) })}
          </p>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.action.close')}
          </button>
        </footer>
      </div>
    </div>
  )
}

function CompareView({ result }: { result: { changes: SummaryChange[]; areas: string[] } | 'loading' | { error: string } }): JSX.Element {
  if (result === 'loading') return <p className="hint version-compare">{t('review.versions.comparing')}</p>
  if ('error' in result) return <p className="versions-error version-compare">{t('review.versions.error.compare', { error: result.error })}</p>
  const { changes, areas } = result
  if (changes.length === 0 && areas.length === 0)
    return (
      <p className="hint version-compare" data-testid="version-compare">
        {t('review.versions.same')}
      </p>
    )
  return (
    <div className="version-compare" data-testid="version-compare">
      {changes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">{t('review.versions.what')}</span>
              </th>
              <th scope="col">{t('review.versions.thisVersion')}</th>
              <th scope="col">{t('review.versions.now')}</th>
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
      {areas.length > 0 && <p className="hint">{t(changes.length ? 'review.versions.alsoDifferent' : 'review.versions.different', { areas: fmt.list(areas) })}</p>}
    </div>
  )
}
