import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ReaderState } from '../../../shared/api/privacy'
import { kindLabel, NOTICE_HINT, PRIVACY_COPY } from '../../../shared/privacy/copy'
import { FIND_KINDS, findChoices, hasCaptions, minutesOf, screenKinds, type FindChoices } from '../../../shared/privacy/findState'
import { noticesApply } from '../../../shared/privacy/notices'
import { firstEstimate } from '../../../shared/privacy/plan'
import { alwaysOnRegions, regionName } from '../../../shared/privacy/regions'
import { fmt } from '../../../shared/i18n/fmt'
import { formatLocale, t } from '../../../shared/i18n/t'
import type { PrivateKind, Project } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { useModalFocus } from '../editor/modalFocus'
import { outcomeSentences } from './FindLine'
import { currentRun, outcomeFor, runFor, subscribeRuns } from './findRuns'
import { readPrefs, startFind, uiRegion } from './privacyRun'
import { setReaderState, useReaderState } from './readerState'
import { RegionsDialog } from './RegionsDialog'
import { openPrivateReview } from './reviewRequest'
import './privacyPanel.css'

/** A textarea's entries: one per line, trimmed, none empty. */
const lines = (text: string): string[] => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

/** The reader's download as a percentage, or null when it is not downloading. */
const downloadPercent = (r: ReaderState | null): number | null => (r?.status === 'downloading' ? Math.round((r.done / Math.max(1, r.total)) * 100) : null)

/** Focuses Find's progress line in the Private info section once the run shows there (finding 31). */
function focusLineWhenShown(projectId: string): void {
  const doc = (globalThis as { document?: Document }).document
  if (typeof doc?.querySelector !== 'function') return
  const focus = (): boolean => {
    const el = doc.querySelector<HTMLElement>(`[data-find-line="${projectId}"]`)
    el?.focus()
    return !!el
  }
  if (runFor(projectId)) {
    window.setTimeout(focus, 0)
    return
  }
  const off = subscribeRuns(() => {
    if (!runFor(projectId)) return
    off()
    window.setTimeout(focus, 0)
  })
  // A run that never starts (nothing to do) stops waiting with the next change.
  window.setTimeout(off, 10000)
}

/**
 * *Find private info* (docs/design/auto-blur.md §2.5): a modal dialog labelled by its title. The kinds
 * to find (decision 2's defaults, then Settings', then this video's own), the phone regions with
 * *Change…*, this video's names and never-hide words (Settings' are used too), *Also listen for
 * secrets said aloud* (on with captions unless unticked for this video, unchecked and disabled
 * without them), the reader's line with its download, the first estimate and *Find* (or *Find
 * again*). Opening puts the focus on the first checkbox; closing gives it back to what opened the
 * dialog; *Find* sends it to the section's progress line (finding 31). *Find* is disabled while
 * another Find runs in Flown, with the reason as its description.
 */
export function FindDialog(props: { services: EditorServices; onClose: () => void; mode: 'find' | 'again' }): JSX.Element {
  const { store } = props.services
  const now = (): Project => store.state
  const project = useSyncExternalStore(store.subscribe, now, now)
  const reader = useReaderState()
  const running = useSyncExternalStore(subscribeRuns, currentRun, currentRun)
  const group = useGroup()
  const box = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLInputElement>(null)
  const uid = `find-${useId().replace(/:/g, '')}`
  const [choices, setChoices] = useState<FindChoices | null>(null)
  const [namesText, setNamesText] = useState('')
  const [neverText, setNeverText] = useState('')
  const [regionsOpen, setRegionsOpen] = useState(false)
  const [notSee, setNotSee] = useState(false)
  const regionsButton = useRef<HTMLButtonElement>(null)
  useModalFocus(box, props.onClose)

  // The choices: this video's, else Settings', else the defaults (read once as it opens).
  useEffect(() => {
    let live = true
    void readPrefs().then((prefs) => {
      if (!live) return
      const c = findChoices(store.state, prefs)
      setChoices(c)
      setNamesText(c.names.join('\n'))
      setNeverText(c.neverHide.join('\n'))
    })
    return () => {
      live = false
    }
  }, [store])
  // The first checkbox takes the focus once the choices show (§11).
  const loaded = choices !== null
  useEffect(() => {
    if (loaded) first.current?.focus()
  }, [loaded])

  const captions = hasCaptions(project)
  const notices = noticesApply(project)
  const ready = reader?.status === 'ready'
  const again = props.mode === 'again' || !!project.privacy?.find
  const shownKinds = FIND_KINDS.filter((k) => k !== 'notice' || notices)
  const listen = !!choices?.listen && captions
  const screen = ready && !!choices && screenKinds(project, choices.kinds).length > 0
  const busy = !!running
  const canFind = !!choices && !busy && (screen || listen)
  const { pc, language } = uiRegion()
  const locale = formatLocale()
  const regionNames = [...alwaysOnRegions(pc, language), ...(choices?.regions ?? [])].map((r) => regionName(r, locale))
  const percent = downloadPercent(reader)
  const minutes = ready ? minutesOf(firstEstimate(project.duration, project.capture?.fps ?? 60, { width: project.width, height: project.height }, reader.decodeMs)) : null

  const setKind = (kind: PrivateKind, on: boolean): void => setChoices((c) => (c ? { ...c, kinds: on ? FIND_KINDS.filter((k) => k === kind || c.kinds.includes(k)) : c.kinds.filter((k) => k !== kind) } : c))
  const download = async (): Promise<void> => {
    try {
      setReaderState(await window.api.downloadReader())
    } catch (err) {
      setReaderState({ status: 'failed', reason: err instanceof Error ? err.message : String(err) })
    }
  }

  const find = (): void => {
    if (!choices || !canFind) return
    const chosen: FindChoices = { ...choices, listen, names: lines(namesText), neverHide: lines(neverText) }
    const projectId = store.state.id
    const done = startFind(props.services, chosen)
    props.onClose()
    focusLineWhenShown(projectId)
    // The result is said once, in the editor's notice, with *Review* when there is something to review.
    void done.then(() => {
      const o = outcomeFor(projectId)
      if (!o) return
      const text = outcomeSentences(o).join(' ')
      if (o.ok && o.found > 0) group.notice(text, { action: { label: t(PRIVACY_COPY.run.openReview), run: () => openPrivateReview(group.command) } })
      else group.notice(text)
    })
  }

  let readerLine: JSX.Element | null = null
  if (reader && !ready) {
    if (reader.status === 'unavailable') {
      readerLine = (
        <p className="privacy-line" role="alert" data-testid="find-reader-unavailable">
          {t(reader.reason === 'cpu' ? PRIVACY_COPY.settings.unavailableCpu : PRIVACY_COPY.settings.unavailableHelper)}
        </p>
      )
    } else if (percent !== null) {
      readerLine = (
        <p className="privacy-line" role="status" data-testid="find-reader-progress">
          {t(PRIVACY_COPY.find.readerProgress, { percent: fmt.count(percent) })}
        </p>
      )
    } else {
      const failed = reader.status === 'failed' ? reader.reason : null
      const damaged = reader.status === 'damaged'
      readerLine = (
        <div className="privacy-line" data-testid="find-reader">
          <p role={failed !== null || damaged ? 'alert' : undefined}>
            {failed !== null ? t(PRIVACY_COPY.find.readerFailed, { reason: failed }) : damaged ? t(PRIVACY_COPY.run.readerDamaged) : t(PRIVACY_COPY.find.readerNone)}
          </p>
          <button type="button" className="btn small" onClick={() => void download()} data-testid="find-download">
            {t(failed !== null ? PRIVACY_COPY.find.readerRetry : damaged ? PRIVACY_COPY.run.downloadAgain : PRIVACY_COPY.find.readerDownload)}
          </button>
        </div>
      )
    }
  }

  return (
    <div className="overlay modal-backdrop">
      <div className="privacy-dialog privacy-find" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={box} tabIndex={-1} data-testid="find-dialog" data-mode={again ? 'again' : 'find'}>
        <header className="modal-head">
          <h2 id={`${uid}-title`}>{t(PRIVACY_COPY.find.title)}</h2>
        </header>
        <div className="modal-body privacy-find-body">
          <p className="hint">{t(PRIVACY_COPY.find.intro)}</p>
          {again && (
            <p className="hint" data-testid="find-again">
              {t(PRIVACY_COPY.find.again)}
            </p>
          )}
          {choices && (
            <>
              <fieldset className="privacy-kinds">
                <legend>{t(PRIVACY_COPY.find.what)}</legend>
                {shownKinds.map((k, i) => (
                  <div key={k} className="privacy-kind">
                    <label className="check">
                      <input ref={i === 0 ? first : undefined} type="checkbox" checked={choices.kinds.includes(k)} onChange={(e) => setKind(k, e.target.checked)} aria-describedby={k === 'notice' ? `${uid}-notice` : undefined} data-kind={k} />
                      <span>{t(kindLabel(k as Exclude<PrivateKind, 'text'>))}</span>
                    </label>
                    {k === 'notice' && (
                      <p className="hint" id={`${uid}-notice`}>
                        {t(NOTICE_HINT)}
                      </p>
                    )}
                  </div>
                ))}
              </fieldset>
              <p className="privacy-line" data-testid="find-regions">
                <span>{t(PRIVACY_COPY.find.regions, { regions: fmt.list(regionNames) })}</span>{' '}
                <button ref={regionsButton} type="button" className="link" onClick={() => setRegionsOpen(true)} data-testid="find-regions-change">
                  {t(PRIVACY_COPY.find.regionsChange)}
                </button>
              </p>
              <label className="privacy-field">
                <span>{t(PRIVACY_COPY.find.names)}</span>
                <textarea rows={3} value={namesText} onChange={(e) => setNamesText(e.target.value)} aria-describedby={`${uid}-names ${uid}-every`} data-testid="find-names" />
              </label>
              <p className="hint" id={`${uid}-names`}>
                {t(PRIVACY_COPY.find.namesHint)}
              </p>
              <p className="hint" id={`${uid}-every`}>
                {t(PRIVACY_COPY.find.everyVideo)}
              </p>
              <label className="privacy-field">
                <span>{t(PRIVACY_COPY.find.neverHide)}</span>
                <textarea rows={2} value={neverText} onChange={(e) => setNeverText(e.target.value)} aria-describedby={`${uid}-never`} data-testid="find-never" />
              </label>
              <p className="hint" id={`${uid}-never`}>
                {t(PRIVACY_COPY.find.neverHideHint)}
              </p>
              <label className="check">
                <input type="checkbox" checked={listen} disabled={!captions} onChange={(e) => setChoices((c) => (c ? { ...c, listen: e.target.checked } : c))} aria-describedby={`${uid}-listen`} data-testid="find-listen" />
                <span>{t(PRIVACY_COPY.find.listen)}</span>
              </label>
              <p className="hint" id={`${uid}-listen`}>
                {t(captions ? PRIVACY_COPY.find.listenHint : PRIVACY_COPY.find.listenNone)}
              </p>
            </>
          )}
          {readerLine}
          {minutes !== null && (
            <p className="privacy-line" data-testid="find-estimate">
              {t(PRIVACY_COPY.find.estimate, { count: minutes, n: fmt.count(minutes) })}
            </p>
          )}
          <button type="button" className="link" aria-expanded={notSee} aria-controls={`${uid}-not-see`} onClick={() => setNotSee((o) => !o)} data-testid="find-not-see">
            {t(PRIVACY_COPY.run.notSeeLink)}
          </button>
          {notSee && (
            <ul className="find-not-see" id={`${uid}-not-see`}>
              {Object.values(PRIVACY_COPY.notSee).map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ul>
          )}
          {busy && (
            <p className="hint" id={`${uid}-busy`} data-testid="find-busy">
              {t(PRIVACY_COPY.run.busy)}
            </p>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={props.onClose} data-testid="find-cancel">
            {t(PRIVACY_COPY.find.cancel)}
          </button>
          <button type="button" className="btn primary" disabled={!canFind} aria-describedby={busy ? `${uid}-busy` : undefined} onClick={find} data-testid="find-start">
            {t(again ? PRIVACY_COPY.find.startAgain : PRIVACY_COPY.find.start)}
          </button>
        </footer>
      </div>
      {regionsOpen && choices && (
        <RegionsDialog
          regions={choices.regions}
          onDone={(regions) => {
            setChoices((c) => (c ? { ...c, regions } : c))
            setRegionsOpen(false)
          }}
          onCancel={() => setRegionsOpen(false)}
        />
      )}
    </div>
  )
}
