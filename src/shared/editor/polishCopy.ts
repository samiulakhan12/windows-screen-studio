/**
 * Every string the Polish dialog and its notice show (E-01, docs/design/polish-in-one-click.md
 * §5). Pure, so the copy is tested without a DOM.
 *
 * Contracts commit: the step labels and the silence chips are final; the texts are filled by E-01
 * (TODO(E-01) below). Only E-01's dialog calls them.
 */
import type { TranscribeProgress } from '../api/ai'
import type { PolishSkip, PolishStep, PolishStepResult, PolishSummary } from './polish'
import type { SmartSpeedAction } from './smartSpeed'

const STEP_LABEL: Record<PolishStep, string> = {
  style: 'Style',
  zoom: 'Auto zoom',
  silences: 'Remove silences',
  captions: 'Captions',
  director: 'Camera director'
}

/** A row's name in the dialog. */
export function polishStepLabel(step: PolishStep): string {
  return STEP_LABEL[step]
}

/** The "Silence action" chips: as the Clip panel's Remove silences offers them, Cut first. */
export const SILENCE_ACTION_CHIPS: readonly { value: SmartSpeedAction; label: string; title: string }[] = [
  { value: 'cut', label: 'Cut', title: 'Remove pauses from the video' },
  { value: 2, label: '2×', title: 'Play pauses twice as fast' },
  { value: 4, label: '4×', title: 'Play pauses four times as fast' },
  { value: 8, label: '8×', title: 'Play pauses eight times as fast' }
]

/** Why a row is disabled or a step was skipped ("This recording has no sound", …). */
export function polishSkipText(step: PolishStep, reason: PolishSkip, error?: string): string {
  // TODO(E-01): design §5.
  void step
  void reason
  void error
  return ''
}

/** The Captions row while it runs, in the Captions tab's words ("Transcribing… Part 2 of 3."). */
export function transcribePhaseText(progress: TranscribeProgress | null, stopping: boolean): string {
  // TODO(E-01): design §5, Running view.
  void progress
  void stopping
  return ''
}

/** The summary's lines, one per step, in POLISH_STEPS order. */
export function polishResultLines(summary: PolishSummary): { step: PolishStep; status: PolishStepResult['status']; text: string }[] {
  // TODO(E-01): design §5, Summary view.
  void summary
  return []
}

/** "Polished: the video is 1:12.0 shorter", "Polished" or "Already polished: nothing to change". */
export function polishHeadline(summary: PolishSummary, changed: boolean): string {
  // TODO(E-01): design §5, Summary view.
  void summary
  void changed
  return ''
}

/** The notice when the dialog closes: the steps that changed something, then `undo` (undoHint). */
export function polishNotice(summary: PolishSummary, changed: boolean, undo: string): string {
  // TODO(E-01): design §5, Notice.
  void summary
  void changed
  void undo
  return ''
}
