/** What the done view's Share block says and retries (F-22, docs/design/share.md §2.7). Pure. */
import type { ShareRunView, ShareStepView } from '../api/share'
import { placeText } from './cloudFolders'

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

/** A step's buttons, as they read on screen. */
export type StepButton = 'Try again' | 'Show in folder' | 'Copy link'

/**
 * A step button's name for screen readers and speech control: its visible words first (WCAG 2.5.3,
 * so "click Show in folder" finds it), then the destination: "Show in folder: the copy in OneDrive".
 */
export function stepButtonName(button: StepButton, s: ShareStepView): string {
  if (button === 'Try again') return `Try again: ${s.kind === 'copy' ? 'copy to' : 'post to'} ${s.label}`
  return `${button}: the copy in ${s.label}`
}

/** A run's Cancel, named by what it still has to do: "Cancel share: OneDrive and #demos". */
export function cancelName(run: ShareRunView): string {
  const left = run.steps.filter((s) => s.state === 'running' || s.state === 'waiting').map((s) => s.label)
  return left.length ? `Cancel share: ${left.join(' and ')}` : 'Cancel share'
}

/**
 * What "Try again" on `step` starts: a post the failed copy held back goes with that copy again,
 * unless the copy has been saved since (`latest`: the latest step of each destination).
 */
export function retryTargets(run: ShareRunView, step: ShareStepView, latest: readonly ShareStepView[] = run.steps): string[] {
  if (step.kind !== 'post' || step.message !== 'Not posted: the copy failed.') return [step.target]
  const saved = (target: string): boolean => latest.some((s) => s.target === target && s.state === 'done')
  return [...run.steps.filter((s) => s.kind === 'copy' && s.state === 'failed' && !saved(s.target)).map((s) => s.target), step.target]
}
