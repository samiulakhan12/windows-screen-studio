import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { OriginCovers } from '../../../shared/api/privacy'
import { coversFromShapes } from '../../../shared/editor/coverEdit'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { anyExportLine, exportNoteLines, withOriginCovers } from '../../../shared/privacy/findState'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'
import { EditorContext } from '../editor/context'
import { ringColourAt } from './coverPick'
import { runFor, subscribeRuns } from './findRuns'
import { stopAndApply } from './privacyRun'
import { useReaderState } from './readerState'
import './privacyPanel.css'

const counted = (key: MessageKey, count: number): string => t(key, { count, n: fmt.count(count) })

/**
 * The export dialog's note above *Export* (docs/design/auto-blur.md §2.12): how many private items
 * the video hides and how many are still to check (*Review*); which blurred areas can be read back
 * (*Turn them all into covers*, one undo step); that Find has not checked the video (only once the
 * reader is downloaded) or did not finish (*Find…*, *Find again…*); what it read less often; secrets
 * said aloud no longer bleeped; captions changed since Find listened; a Find still running, with
 * *Wait for Find* and *Stop Find and export* (Export stays disabled while it runs: `onWait`); and,
 * on a copy, covers its original has (*Bring them over*, one undo step). Nothing at all when no line
 * applies, so the dialog of a project hiding nothing, for a user who never downloaded the reader,
 * is as before. *Review* and *Find…* close the dialog first (finding 30): the dialog's callbacks.
 */
export function PrivacyExportNote(props: { project: Project; onReview: () => void; onFind: () => void; onWait: (waiting: boolean) => void; onStopAndExport: () => void }): JSX.Element | null {
  const services = useContext(EditorContext)
  const { project } = props
  const reader = useReaderState()
  const runningNow = (): boolean => !!runFor(project.id)
  const running = useSyncExternalStore(subscribeRuns, runningNow, runningNow)
  const [waited, setWaited] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [origin, setOrigin] = useState<OriginCovers | null>(null)
  const onWait = useRef(props.onWait)
  onWait.current = props.onWait

  // Export waits while Find runs for this video, until what it found is applied (§2.12).
  const held = useRef(false)
  useEffect(() => {
    if (held.current === running) return
    held.current = running
    onWait.current(running)
    if (!running) setWaited(false)
  }, [running])

  // A copy made before Find: what its original has that it lacks (main compares the two files).
  const copyOf = !!project.copyOf
  useEffect(() => {
    setOrigin(null)
    if (!copyOf) return
    let live = true
    window.api.originCovers(project.id).then(
      (o) => live && setOrigin(o && o.missing > 0 ? o : null),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [project.id, copyOf])

  const lines = exportNoteLines(project, reader?.status === 'ready')
  if (!anyExportLine(lines) && !running && !origin) return null

  const turnAll = async (): Promise<void> => {
    if (!services) return
    const { store } = services
    const shapes = (store.state.shapes ?? []).filter((s) => s.kind === 'blur' || s.kind === 'pixelate')
    if (!shapes.length) return
    const colours: Record<string, string> = {}
    for (const s of shapes) colours[s.id] = await ringColourAt(store.state.id, (s.start + s.end) / 2, { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) })
    store.update((p) => coversFromShapes(p, shapes.map((s) => s.id), colours).project)
  }
  const stopAndExport = async (): Promise<void> => {
    if (!services || stopping) return
    setStopping(true)
    try {
      await stopAndApply(services)
      props.onStopAndExport()
    } finally {
      setStopping(false)
    }
  }
  const bringOver = (): void => {
    if (!services || !origin) return
    const o = origin
    services.store.update((p) => withOriginCovers(p, o, Math.random))
    setOrigin(null)
  }

  return (
    <div className="privacy-export-note" data-testid="privacy-export-note">
      {lines.hides > 0 && (
        <p className="privacy-line" data-testid="export-note-hides">
          <span>{counted(PRIVACY_COPY.export.hides, lines.hides)}</span>
          {lines.toCheck > 0 && <span data-testid="export-note-to-check"> {counted(PRIVACY_COPY.export.toCheck, lines.toCheck)}</span>}{' '}
          <button type="button" className="link" onClick={props.onReview} data-testid="export-note-review">
            {t(PRIVACY_COPY.export.review)}
          </button>
        </p>
      )}
      {lines.weak > 0 && (
        <p className="privacy-line" data-testid="export-note-weak">
          <span>{counted(PRIVACY_COPY.export.weak, lines.weak)}</span>{' '}
          <button type="button" className="link" onClick={() => void turnAll()} data-testid="export-note-weak-turn">
            {t(PRIVACY_COPY.export.weakTurn)}
          </button>
        </p>
      )}
      {lines.notChecked && !running && (
        <p className="privacy-line" data-testid="export-note-not-checked">
          <span>{t(PRIVACY_COPY.export.notChecked)}</span>{' '}
          <button type="button" className="link" onClick={props.onFind} data-testid="export-note-find">
            {t(PRIVACY_COPY.export.find)}
          </button>
        </p>
      )}
      {lines.unfinished !== null && !running && (
        <p className="privacy-line" data-testid="export-note-unfinished">
          <span>{t(PRIVACY_COPY.export.unfinished, { time: lines.unfinished })}</span>{' '}
          <button type="button" className="link" onClick={props.onFind} data-testid="export-note-find-again">
            {t(PRIVACY_COPY.export.findAgain)}
          </button>
        </p>
      )}
      {lines.thinned !== null && (
        <p className="privacy-line" data-testid="export-note-thinned">
          {counted(PRIVACY_COPY.export.thinned, lines.thinned)}
        </p>
      )}
      {lines.saidRemoved > 0 && (
        <p className="privacy-line" data-testid="export-note-said-removed">
          {counted(PRIVACY_COPY.export.saidRemoved, lines.saidRemoved)}
        </p>
      )}
      {lines.captionsChanged && !running && (
        <p className="privacy-line" data-testid="export-note-captions-changed">
          <span>{t(PRIVACY_COPY.export.captionsChanged)}</span>{' '}
          <button type="button" className="link" onClick={props.onFind} data-testid="export-note-captions-find">
            {t(PRIVACY_COPY.export.findAgain)}
          </button>
        </p>
      )}
      {running && (
        <div className="privacy-line privacy-running" role="status" data-testid="export-note-running">
          <p>{t(PRIVACY_COPY.export.running)}</p>
          <button type="button" className="btn small" aria-pressed={waited} onClick={() => setWaited(true)} data-testid="export-note-wait">
            {t(PRIVACY_COPY.export.wait)}
          </button>
          <button type="button" className="btn small" disabled={stopping} onClick={() => void stopAndExport()} data-testid="export-note-stop">
            {t(PRIVACY_COPY.export.stopAndExport)}
          </button>
        </div>
      )}
      {origin && (
        <p className="privacy-line" data-testid="export-note-from-original">
          <span>{t(PRIVACY_COPY.export.fromOriginal)}</span>{' '}
          <button type="button" className="link" onClick={bringOver} data-testid="export-note-bring-over">
            {t(PRIVACY_COPY.export.bringOver)}
          </button>
        </p>
      )}
    </div>
  )
}
