import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FindProgress } from '../../../shared/api/privacy'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { minutesOf, type FindOutcome } from '../../../shared/privacy/findState'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
import { isTracked, outcomeFor, runFor, subscribeRuns, type FindRun } from './findRuns'
import './privacyPanel.css'

/** A progress's share done, 0-100. */
const percentOf = (p: FindProgress): number => (p.total > 0 ? Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100))) : 0)

/** The phase's line (§2.6): looking, reading, following, or waiting while Flown records. */
export function phaseText(p: FindProgress): string {
  switch (p.phase) {
    case 'look':
      return t(PRIVACY_COPY.run.look, { percent: fmt.count(percentOf(p)) })
    case 'read':
      return t(PRIVACY_COPY.run.read, { done: fmt.count(p.done), total: fmt.count(p.total) })
    case 'follow':
      return t(PRIVACY_COPY.run.follow)
    case 'waiting':
      return t(PRIVACY_COPY.run.waiting)
  }
}

/** Where focus goes once a run stopped here: its result line where it shows, else the section's *Find private info…*. */
function focusAfterStop(projectId: string): void {
  const doc = (globalThis as { document?: Document }).document
  if (typeof doc?.querySelector !== 'function') return
  const el = doc.querySelector<HTMLElement>(`[data-find-result="${projectId}"]`) ?? doc.querySelector<HTMLElement>('[data-testid="privacy-find"]')
  el?.focus()
}

/**
 * Find's progress line (docs/design/auto-blur.md §2.6, §11): the phase, the time left (main's second
 * estimate) and *Stop* for a run of this window; for another request of the project (Cover this
 * text everywhere's), its progress since the line showed. Its live region speaks at each phase
 * change and at most every 10%; the visible text follows every step. Nothing when no run goes on.
 */
export function FindLine({ projectId }: { projectId: string; onReview?: () => void }): JSX.Element | null {
  const runOf = (): FindRun | null => runFor(projectId)
  const run = useSyncExternalStore(subscribeRuns, runOf, runOf)
  const [loose, setLoose] = useState<FindProgress | null>(null)
  const said = useRef({ phase: '', step: -1, text: '' })
  useEffect(() => {
    const api = (globalThis as { window?: { api?: { onFindProgress?: (l: (p: FindProgress) => void) => () => void } } }).window?.api
    if (typeof api?.onFindProgress !== 'function') return
    return api.onFindProgress((p) => {
      if (p.projectId === projectId && !isTracked(p.requestId)) setLoose(p)
    })
  }, [projectId])
  const progress = run?.progress ?? loose
  if (!progress) return null
  const text = phaseText(progress)
  // Announced at a phase change and every 10%, never more often (§11).
  const step = progress.phase === 'look' || progress.phase === 'read' ? Math.floor(percentOf(progress) / 10) : 0
  if (said.current.phase !== progress.phase || said.current.step !== step) said.current = { phase: progress.phase, step, text }
  const minutes = progress.secondsLeft !== null && progress.phase !== 'waiting' ? minutesOf(progress.secondsLeft) : null
  const stop = async (): Promise<void> => {
    if (!run) return
    await run.stop()
    focusAfterStop(projectId)
  }
  return (
    <div className="find-line" data-testid="find-progress" data-find-line={projectId} data-phase={progress.phase} tabIndex={-1}>
      <span className="find-line-text" aria-hidden="true">
        {text}
      </span>
      {minutes !== null && (
        <span className="find-line-left" aria-hidden="true" data-testid="find-left">
          {t(PRIVACY_COPY.run.left, { count: minutes, n: fmt.count(minutes) })}
        </span>
      )}
      {(progress.phase === 'look' || progress.phase === 'read') && (
        <span className="find-line-bar" aria-hidden="true">
          <span style={{ width: `${percentOf(progress)}%` }} />
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite" data-testid="find-said">
        {said.current.text}
      </span>
      {run && (
        <button type="button" className="btn small" onClick={() => void stop()} data-testid="find-stop">
          {t(PRIVACY_COPY.run.stop)}
        </button>
      )}
    </div>
  )
}

/** The sentences of a run's result (§2.6), each whole, in the order shown. */
export function outcomeSentences(o: FindOutcome): string[] {
  if (!o.ok) {
    const keys: Record<Extract<FindOutcome, { ok: false }>['reason'], MessageKey> = {
      reader: PRIVACY_COPY.run.readerDamaged,
      busy: PRIVACY_COPY.run.busy,
      tooLarge: PRIVACY_COPY.run.tooLarge,
      helper: PRIVACY_COPY.run.failedHelper,
      video: PRIVACY_COPY.run.failedVideo,
      crashed: PRIVACY_COPY.run.failedCrashed,
      failed: PRIVACY_COPY.run.failedOther
    }
    return [t(keys[o.reason])]
  }
  const counted = (key: MessageKey, count: number): string => t(key, { count, n: fmt.count(count) })
  const out = [o.found > 0 ? counted(PRIVACY_COPY.run.found, o.found) : t(PRIVACY_COPY.run.foundNone)]
  if (o.check > 0) out.push(counted(PRIVACY_COPY.run.foundCheck, o.check))
  if (o.said > 0) out.push(counted(PRIVACY_COPY.run.said, o.said))
  if (o.failedReads > 0) out.push(counted(PRIVACY_COPY.run.failedReads, o.failedReads))
  if ((o.notFollowed ?? 0) > 0) out.push(counted(PRIVACY_COPY.run.notFollowed, o.notFollowed!))
  if (o.thinned !== null) out.push(counted(PRIVACY_COPY.run.thinned, o.thinned))
  if (o.suppressed > 0) out.push(counted(PRIVACY_COPY.run.suppressed, o.suppressed))
  if (o.saidFull) out.push(t(PRIVACY_COPY.run.saidFull))
  if (o.crashed) out.push(t(PRIVACY_COPY.run.failedCrashed))
  else if (o.stopped) out.push(t(PRIVACY_COPY.run.stopped))
  return out
}

/**
 * The last run's result line for `projectId` (§2.6): *Found 3 private items.*, then each of what
 * applies as a sentence of its own; *found nothing* with the *What Find does not see* link; a
 * failure with its cause in one sentence, and *Download again* for damaged reader files; *Review*
 * when it found something and `onReview` is given. A polite status, said once when it shows.
 */
export function FindResultLine({ projectId, onReview }: { projectId: string; onReview?: () => void }): JSX.Element | null {
  const outcomeOf = (): FindOutcome | null => outcomeFor(projectId)
  const outcome = useSyncExternalStore(subscribeRuns, outcomeOf, outcomeOf)
  const runningNow = (): boolean => !!runFor(projectId)
  const running = useSyncExternalStore(subscribeRuns, runningNow, runningNow)
  const [notSee, setNotSee] = useState(false)
  if (!outcome || running) return null
  const sentences = outcomeSentences(outcome)
  const none = outcome.ok && outcome.found === 0
  const listId = `find-not-see-${projectId.replace(/[^A-Za-z0-9_-]/g, '-')}`
  return (
    <div className="find-result" role="status" aria-live="polite" data-testid="find-result" data-find-result={projectId} tabIndex={-1}>
      <p className="find-result-text">
        {sentences.map((s, i) => (
          <span key={i} className="find-sentence" data-testid="find-sentence">
            {s}{' '}
          </span>
        ))}
      </p>
      <div className="find-result-actions">
        {none && (
          <button type="button" className="link" aria-expanded={notSee} aria-controls={listId} onClick={() => setNotSee((o) => !o)} data-testid="find-not-see">
            {t(PRIVACY_COPY.run.notSeeLink)}
          </button>
        )}
        {!outcome.ok && outcome.reason === 'reader' && (
          <button type="button" className="link" onClick={() => void window.api.downloadReader().catch(() => undefined)} data-testid="find-download-again">
            {t(PRIVACY_COPY.run.downloadAgain)}
          </button>
        )}
        {outcome.ok && outcome.found > 0 && onReview && (
          <button type="button" className="link" onClick={onReview} data-testid="find-review">
            {t(PRIVACY_COPY.run.openReview)}
          </button>
        )}
      </div>
      {none && notSee && (
        <ul className="find-not-see" id={listId} data-testid="find-not-see-list">
          {Object.values(PRIVACY_COPY.notSee).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
