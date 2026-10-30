import { useEffect, useRef, useState } from 'react'
import type { ShareMeta, ShareRunView, ShareStepView, ShareTargets } from '../../../shared/api/share'
import { linkHint, type CloudService } from '../../../shared/share/cloudFolders'
import { retryTargets, stepText } from '../../../shared/share/steps'
import { ipcMessage } from '../settings/providerText'
import { actionLabel, actionTitle, offeredIds, useShareRuns } from './useShare'
import './share.css'

/** The latest step for each destination, across this file's runs. */
function latestSteps(runs: readonly ShareRunView[]): { run: ShareRunView; step: ShareStepView }[] {
  const out = new Map<string, { run: ShareRunView; step: ShareStepView }>()
  for (const run of runs) for (const step of run.steps) out.set(step.target, { run, step })
  return [...out.values()]
}

/**
 * The export done view's "Share" block (F-22): each step's progress and result, Cancel for a run,
 * Try again, Show in folder and how to get a link, and buttons for the destinations not used yet.
 * Buttons name their destination for screen readers; when one goes away (a step ends) focus moves
 * to the block, not to the page.
 */
export function ShareDone({ file, meta, targets, startError }: { file: string; meta: ShareMeta; targets: ShareTargets | null; startError?: string | null }): JSX.Element | null {
  const runs = useShareRuns(file)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string[]>([])
  const box = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  useEffect(() => {
    if (hadFocus.current && (document.activeElement === document.body || document.activeElement === null)) box.current?.focus({ preventScroll: true })
  }, [runs, pending])

  const steps = latestSteps(runs)
  const offered = offeredIds(targets).filter((id) => !steps.some((s) => s.step.target === id))
  const shownError = error ?? startError ?? null
  if (!steps.length && !offered.length && !shownError) return null

  const start = (ids: string[]): void => {
    setError(null)
    setPending((p) => [...p, ...ids])
    window.api
      .shareStart(file, ids, meta)
      .catch((err: unknown) => setError(ipcMessage(err)))
      .finally(() => setPending((p) => p.filter((x) => !ids.includes(x))))
  }
  const copied = steps.filter((s) => s.step.kind === 'copy' && s.step.state === 'done')
  const hints = [...new Set(copied.map((s) => linkHint(s.step.service as CloudService)))]
  // Said to screen readers on each change of state (not each percent).
  const spoken = steps.map((s) => stepText({ ...s.step, fraction: undefined })).join('. ')
  const running = runs.filter((r) => !r.finished)

  return (
    <div
      className="share-done"
      role="group"
      aria-label="Share"
      tabIndex={-1}
      ref={box}
      onFocus={() => (hadFocus.current = true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hadFocus.current = e.relatedTarget === null
      }}
    >
      <p className="share-done-title">Share</p>
      {steps.length > 0 && (
        <ul className="share-steps">
          {steps.map(({ run, step }) => (
            <li key={step.target} className={`share-step ${step.state}`} data-share-step={step.target} data-state={step.state}>
              <span className="share-step-mark" aria-hidden="true">
                {step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : step.state === 'running' ? '…' : '·'}
              </span>
              <span className="share-step-text">{stepText(step)}</span>
              {step.kind === 'copy' && step.state === 'running' && <progress className="share-progress" max={1} value={step.fraction ?? 0} aria-hidden="true" />}
              {(step.state === 'failed' || step.state === 'cancelled') && run.finished && (
                <button className="btn ghost small" disabled={pending.includes(step.target)} aria-label={`Try again: ${step.kind === 'copy' ? 'copy to' : 'post to'} ${step.label}`} onClick={() => start(retryTargets(run, step))}>
                  Try again
                </button>
              )}
              {step.kind === 'copy' && step.state === 'done' && step.dest && (
                <button className="btn ghost small" aria-label={`Show the copy in ${step.label}`} onClick={() => void window.api.showItemInFolder(step.dest!)}>
                  Show in folder
                </button>
              )}
              {step.link && (
                <button className="btn ghost small" aria-label={`Copy the ${step.label} link`} onClick={() => void navigator.clipboard.writeText(step.link!)}>
                  Copy link
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {running.map((run) => (
        <div key={run.id}>
          <button className="btn ghost small" data-share-cancel={run.id} onClick={() => void window.api.shareCancel(run.id)} aria-label={`Cancel sharing to ${run.steps.filter((s) => s.state === 'running' || s.state === 'waiting').map((s) => s.label).join(' and ')}`}>
            Cancel share
          </button>
        </div>
      ))}
      {hints.map((h) => (
        <p key={h} className="hint">
          {h}
        </p>
      ))}
      {offered.length > 0 && (
        <div className="share-offers">
          {offered.map((id) => (
            <button key={id} className="btn small" title={actionTitle(targets, id)} data-share-offer={id} disabled={pending.includes(id)} onClick={() => start([id])}>
              {actionLabel(targets, id)}
            </button>
          ))}
        </div>
      )}
      {shownError && (
        <p className="error" role="alert">
          {shownError}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {spoken}
      </p>
    </div>
  )
}
