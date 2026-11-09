/**
 * The progress line and Stop beside a busy button while AI on this PC runs request `requestId`
 * (docs/design/smart-tools.md §2.5, §14): "On this PC: loading the model…", "reading the text…
 * 45%", "writing… about 2 minutes left", "Waiting for AI on this PC…", with "Memory is low: this
 * may be slow" when the free memory is under the model's peak plus 1 GB. Nothing for a request that
 * is not on this PC (no progress is heard for it). A progress bar "AI on this PC" whose value text
 * says the phase ("Reading, 45 percent", "Writing, about 2 minutes left"); the phase is announced
 * politely once, the percentage and the time left are shown, not read out at every step.
 *
 * Also the two lines a text tool shows with On this PC (§2.5): the catalogue's note for its tasks
 * beside the choice (LocalNote), and "Written on this PC: check it before you use it." with a
 * result (LocalWritten).
 */
import type { AiTextTask, NamesRequest, TextChoice } from '../../../shared/api/ai'
import type { LocalAiProgress, LocalAiState } from '../../../shared/api/localAi'
import { LOCAL_MODELS } from '../../../shared/localAi/catalog'
import { LOCAL_MESSAGES, progressWords, timeLeft } from '../../../shared/localAi/messages'
import { useStopFocus } from '../editor/returnFocus'
import { localNote, modelInUse, useLocalAi, useLocalAiProgress } from './localAiState'
import './localAi.css'

/** Whether the free memory is under the peak of the model in use plus 1 GB (§9.5). */
export function memoryLow(state: LocalAiState): boolean {
  const id = modelInUse(state)
  const spec = id ? LOCAL_MODELS.find((m) => m.id === id) : undefined
  return !!spec && state.pc.freeMemBytes < spec.peakMB * 2 ** 20 + 2 ** 30
}

const PHASE_WORDS: Record<LocalAiProgress['phase'], string> = {
  waiting: LOCAL_MESSAGES.waiting,
  loading: 'On this PC: loading the model',
  reading: 'On this PC: reading the text',
  writing: 'On this PC: writing'
}

/** The progress bar's value text (§14): "Reading, 45 percent", "Writing, about 2 minutes left". */
export function progressValueText(p: LocalAiProgress): string {
  switch (p.phase) {
    case 'waiting':
      return 'Waiting for AI on this PC'
    case 'loading':
      return 'Loading the model'
    case 'reading':
      return `Reading, ${p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0} percent`
    case 'writing':
      return `Writing, ${timeLeft(p.secondsLeft ?? 0)}`
  }
}

/**
 * `returnFocus`: the id of the tool's button. Stop, or the run ending, takes the line and its Stop
 * away; when the keyboard had the focus on Stop, it goes back to that button (working again by
 * then) instead of falling to the page, where typed keys would run editor shortcuts.
 */
export function LocalProgress(props: { requestId: string | null; onStop(): void; returnFocus?: string }): JSX.Element | null {
  const progress = useLocalAiProgress(props.requestId)
  const local = useLocalAi()
  const shown = !!props.requestId && !!progress
  const stopFocus = useStopFocus(shown, props.returnFocus)
  if (!shown) return null
  const low = local.status === 'ready' && progress.phase !== 'waiting' && memoryLow(local.state)
  // Waiting and loading have no amount to show: the bar is indeterminate.
  const fraction = progress.total > 0 && (progress.phase === 'reading' || progress.phase === 'writing') ? Math.min(1, progress.done / progress.total) : null
  return (
    <div className="local-progress" data-testid="local-progress" data-phase={progress.phase}>
      <span className="sr-only" role="status" aria-live="polite">
        {PHASE_WORDS[progress.phase]}
      </span>
      <span className="local-progress-text" aria-hidden="true">
        {progressWords(progress)}
        {low ? ` · ${LOCAL_MESSAGES.lowMemory}` : ''}
      </span>
      <progress className="local-progress-bar" max={1} {...(fraction !== null ? { value: fraction } : {})} aria-label="AI on this PC" aria-valuetext={progressValueText(progress)} />
      <button
        type="button"
        className="btn ghost settings-small"
        onClick={props.onStop}
        {...stopFocus}
        aria-label="Stop AI on this PC"
      >
        Stop
      </button>
    </div>
  )
}

/** The catalogue's notes for `tasks` with the model a run would use, when `choice` is On this PC (pure). */
export function localNotesFor(state: LocalAiState | null, choice: Pick<TextChoice, 'kind'> | null, tasks: readonly AiTextTask[], kind?: NamesRequest['kind']): string[] {
  if (!state || choice?.kind !== 'local') return []
  return [...new Set(tasks.map((t) => localNote(state, t, kind)).filter((n): n is string => !!n))]
}

/**
 * The catalogue's note for the tasks of a tool beside its choice, when the choice is On this PC
 * (§2.5: "Small: titles often repeat the first sentence"); nothing otherwise.
 */
export function LocalNote(props: { choice: Pick<TextChoice, 'kind'> | null; tasks: readonly AiTextTask[]; kind?: NamesRequest['kind']; id?: string }): JSX.Element | null {
  const local = useLocalAi()
  const notes = localNotesFor(local.status === 'ready' ? local.state : null, props.choice, props.tasks, props.kind)
  if (!notes.length) return null
  return (
    <p className="hint local-note" id={props.id} data-testid="local-note">
      {notes.join(' · ')}
    </p>
  )
}

/** "Written on this PC: check it before you use it." under a result made on this PC (§2.5). */
export function LocalWritten(props: { show: boolean }): JSX.Element | null {
  if (!props.show) return null
  return (
    <p className="hint local-written" data-testid="local-written">
      {LOCAL_MESSAGES.written}
    </p>
  )
}
