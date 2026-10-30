import { useState } from 'react'
import type { ShareMeta, ShareRunView, ShareStepView, ShareTargets } from '../../../shared/api/share'
import { linkHint, placeText, type CloudService } from '../../../shared/share/cloudFolders'
import { ipcMessage } from '../settings/providerText'
import { actionLabel, actionTitle, offeredIds, useShareRuns } from './useShare'
import './share.css'

/** What a step says now. */
export function stepText(s: ShareStepView): string {
  const pct = s.fraction !== undefined ? ` ${Math.floor(s.fraction * 100)}%` : ''
  if (s.kind === 'copy') {
    if (s.state === 'waiting') return `Waiting to copy to ${s.label}`
    if (s.state === 'running') return `Copying to ${s.label}…${pct}`
    if (s.state === 'done') return s.message ?? `Saved to ${placeText(s.label)}`
    if (s.state === 'cancelled') return `Not copied to ${s.label}: cancelled`
    return `Could not copy to ${s.label}: ${s.message ?? 'something went wrong.'}`
  }
  if (s.state === 'waiting') return `Waiting to post to ${s.label}`
  if (s.state === 'running') return `Posting to ${s.label}…`
  if (s.state === 'done') return `Posted to ${s.label}`
  if (s.state === 'cancelled') return `Not posted to ${s.label}: cancelled`
  return `Could not post to ${s.label}: ${s.message ?? 'something went wrong.'}`
}

/** The latest step for each destination, across this file's runs. */
function latestSteps(runs: readonly ShareRunView[]): { run: ShareRunView; step: ShareStepView }[] {
  const out = new Map<string, { run: ShareRunView; step: ShareStepView }>()
  for (const run of runs) for (const step of run.steps) out.set(step.target, { run, step })
  return [...out.values()]
}

/**
 * The export done view's "Share" block (F-22): each step's progress and result, Cancel, Try again,
 * Show in folder and how to get a link, and buttons for the destinations not used yet.
 */
export function ShareDone({ file, meta, targets }: { file: string; meta: ShareMeta; targets: ShareTargets | null }): JSX.Element | null {
  const runs = useShareRuns(file)
  const [error, setError] = useState<string | null>(null)
  const steps = latestSteps(runs)
  const offered = offeredIds(targets).filter((id) => !steps.some((s) => s.step.target === id))
  if (!steps.length && !offered.length) return null

  const start = (id: string): void => {
    setError(null)
    window.api.shareStart(file, [id], meta).catch((err: unknown) => setError(ipcMessage(err)))
  }
  const copied = steps.filter((s) => s.step.kind === 'copy' && s.step.state === 'done')
  const hints = [...new Set(copied.map((s) => linkHint(s.step.service as CloudService)))]
  // Said to screen readers on each change of state (not each percent).
  const spoken = steps.map((s) => stepText({ ...s.step, fraction: undefined })).join('. ')

  return (
    <div className="share-done" aria-label="Share">
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
              {!run.finished && step.state !== 'done' && step.state !== 'failed' && (
                <button className="btn ghost small" onClick={() => void window.api.shareCancel(run.id)}>
                  Cancel
                </button>
              )}
              {(step.state === 'failed' || step.state === 'cancelled') && run.finished && (
                <button className="btn ghost small" onClick={() => start(step.target)}>
                  Try again
                </button>
              )}
              {step.kind === 'copy' && step.state === 'done' && step.dest && (
                <button className="btn ghost small" onClick={() => void window.api.showItemInFolder(step.dest!)}>
                  Show in folder
                </button>
              )}
              {step.link && (
                <button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(step.link!)}>
                  Copy link
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {hints.map((h) => (
        <p key={h} className="hint">
          {h}
        </p>
      ))}
      {offered.length > 0 && (
        <div className="share-offers">
          {offered.map((id) => (
            <button key={id} className="btn small" title={actionTitle(targets, id)} data-share-offer={id} onClick={() => start(id)}>
              {actionLabel(targets, id)}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {spoken}
      </p>
    </div>
  )
}
