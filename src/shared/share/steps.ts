/** What the done view's Share block says and retries (F-22, docs/design/share.md §2.7). Pure. */
import type { ShareRunView, ShareStepView } from '../api/share'
import { placeText, SERVICE_LABELS, type CloudService, type FolderSource } from './cloudFolders'
import { fmt } from '../i18n/fmt'
import { t, uiLanguage, type MessageKey } from '../i18n/t'

/**
 * Whether a post's message says the failed copy held it back: main writes it in the UI language
 * (errors.shareService.notPostedTheCopy), from the same catalogue as here (§9.6).
 */
const heldBack = (message: string | undefined): boolean => message === t('errors.shareService.notPostedTheCopy')

/** What a step says now. */
export function stepText(s: ShareStepView): string {
  const label = s.label
  if (s.kind === 'copy') {
    if (s.state === 'waiting') return t('review.share.step.waitingCopy', { label })
    if (s.state === 'running') return s.fraction !== undefined ? t('review.share.step.copyingPercent', { label, percent: fmt.percent(Math.floor(s.fraction * 100) / 100) }) : t('review.share.step.copying', { label })
    if (s.state === 'done') return s.message ?? t('review.share.step.saved', { place: placeText(label) })
    if (s.state === 'cancelled') return t('review.share.step.notCopied', { label })
    return s.message ? t('review.share.step.copyFailed', { label, reason: s.message }) : t('review.share.step.copyFailedUnknown', { label })
  }
  if (s.state === 'waiting') return t('review.share.step.waitingPost', { label })
  if (s.state === 'running') return t('review.share.step.posting', { label })
  if (s.state === 'done') return t('review.share.step.posted', { label })
  if (s.state === 'cancelled') return t('review.share.step.notPosted', { label })
  return s.message ? t('review.share.step.postFailed', { label, reason: s.message }) : t('review.share.step.postFailedUnknown', { label })
}

/** A step's buttons: Try again, Show in folder, Copy link. */
export type StepButton = 'retry' | 'show' | 'link'

/** Each button's visible words (its name starts with them). */
const BUTTON_WORDS: Readonly<Record<StepButton, MessageKey>> = { retry: 'common.action.tryAgain', show: 'common.action.showInFolder', link: 'review.share.copyLink' }

/**
 * A step button's name for screen readers and speech control: its visible words first (WCAG 2.5.3,
 * so "click Show in folder" finds it), then the destination: "Show in folder: the copy in OneDrive".
 */
export function stepButtonName(button: StepButton, s: ShareStepView): string {
  const action = t(BUTTON_WORDS[button])
  if (button === 'retry') return t(s.kind === 'copy' ? 'review.share.button.retryCopy' : 'review.share.button.retryPost', { action, label: s.label })
  return t('review.share.button.theCopy', { action, label: s.label })
}

/** A run's Cancel, named by what it still has to do: "Cancel share: OneDrive and #demos". */
export function cancelName(run: ShareRunView): string {
  const left = run.steps.filter((s) => s.state === 'running' || s.state === 'waiting').map((s) => s.label)
  if (!left.length) return t('review.share.cancel')
  // English keeps today's "A and B and C"; other languages list them as their own lists do.
  return t('review.share.cancelNamed', { targets: uiLanguage() === 'en' ? left.join(' and ') : fmt.list(left) })
}

/** Where a cloud folder came from, shown next to it (cloudFolders.ts's sourceText, which main loads too, in the UI language). */
export function folderSourceText(service: CloudService, source: FolderSource): string {
  if (source === 'picked') return t('review.share.source.picked')
  if (source === 'usual') return t('review.share.source.usual')
  return t('review.share.source.app', { service: SERVICE_LABELS[service] })
}

/** How to get a share link for a copy, per service (cloudFolders.ts's linkHint, in the UI language). */
export function linkHintText(service: CloudService): string {
  if (service === 'onedrive') return t('review.share.linkHint.onedrive')
  if (service === 'dropbox') return t('review.share.linkHint.dropbox')
  if (service === 'gdrive') return t('review.share.linkHint.gdrive')
  return t('review.share.linkHint.folder')
}

/**
 * What "Try again" on `step` starts: a post the failed copy held back goes with that copy again,
 * unless the copy has been saved since (`latest`: the latest step of each destination).
 */
export function retryTargets(run: ShareRunView, step: ShareStepView, latest: readonly ShareStepView[] = run.steps): string[] {
  if (step.kind !== 'post' || !heldBack(step.message)) return [step.target]
  const saved = (target: string): boolean => latest.some((s) => s.target === target && s.state === 'done')
  return [...run.steps.filter((s) => s.kind === 'copy' && s.state === 'failed' && !saved(s.target)).map((s) => s.target), step.target]
}
