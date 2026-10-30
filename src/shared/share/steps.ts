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

/** What "Try again" on `step` starts: a post the failed copy held back goes with that copy again. */
export function retryTargets(run: ShareRunView, step: ShareStepView): string[] {
  if (step.kind !== 'post' || step.message !== 'Not posted: the copy failed.') return [step.target]
  return [...run.steps.filter((s) => s.kind === 'copy' && s.state === 'failed').map((s) => s.target), step.target]
}
