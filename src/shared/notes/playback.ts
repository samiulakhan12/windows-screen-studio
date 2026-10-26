/**
 * How the notes window page follows the recording (docs/design/teleprompter.md, "Lifecycle"):
 * whether the text scrolls now, and whether it goes back to the top, after each new NotesView or
 * a play / pause from the presenter. Pure, so every transition is unit-tested; the page applies
 * the result to its ScrollClock.
 *
 * The model: `want` is what the presenter wants (scrolling or not); the text scrolls when they
 * want it and nothing holds it. The countdown and a hidden window always hold it; a paused
 * recording holds it until the presenter presses play there themselves. So pausing (by hand, by
 * auto-pause, or by hiding the window) remembers whether it was scrolling, and the resume
 * continues only if it was.
 */
import type { NotesMode, NotesRecordingState } from '../api/notes'

/** The parts of a NotesView (and its settings) that decide playback. */
export interface PlaybackInput {
  mode: NotesMode
  recording: NotesRecordingState | null
  take: number
  shown: boolean
  autoStart: boolean
}

export interface Playback {
  mode: NotesMode
  recording: NotesRecordingState | null
  take: number
  shown: boolean
  /** Scrolling now. */
  playing: boolean
  /** The presenter wants it to scroll (kept through pauses and hiding). */
  want: boolean
  /** This take's recording has started (autoStart applies only to its first 'recording'). */
  started: boolean
  /** The presenter pressed play or pause before the recording started (that wins over autoStart). */
  chosen: boolean
  /** The presenter pressed play while the recording is paused (rehearsing a passage meanwhile). */
  duringPause: boolean
}

export interface PlaybackStep {
  state: Playback
  /** Go back to the top of the text (a new window, a new take, a countdown). */
  toTop: boolean
}

/** Holds that a play from the presenter does not override. */
const blocked = (p: Pick<Playback, 'recording' | 'shown'>): boolean => p.recording === 'countdown' || !p.shown

/** The state after a new view (`prev` null: the page has just loaded). */
export function applyView(prev: Playback | null, input: PlaybackInput): PlaybackStep {
  const fresh = !prev || prev.take !== input.take || prev.mode !== input.mode
  const base: Playback = fresh
    ? { mode: input.mode, recording: null, take: input.take, shown: input.shown, playing: false, want: false, started: false, chosen: false, duringPause: false }
    : { ...prev }
  let toTop = fresh
  let { want, started, chosen, duringPause } = base
  let playing: boolean
  const rec = input.mode === 'record' ? input.recording : null

  if (rec === 'countdown') {
    if (base.recording !== 'countdown') toTop = true
    playing = false
  } else if (rec === 'recording') {
    duringPause = false
    if (!started) {
      started = true
      want = chosen ? want : input.autoStart
    }
    playing = want && input.shown
  } else if (rec === 'paused') {
    // A pause from the bar or auto-pause stops the text; a play pressed during it is kept.
    if (base.recording !== 'paused') duringPause = false
    playing = duringPause && want && input.shown
  } else {
    // Rehearsal (or a recording window before its first status): only hiding holds it.
    playing = want && input.shown
  }

  return { state: { mode: input.mode, recording: rec, take: input.take, shown: input.shown, playing, want, started, chosen, duringPause }, toTop }
}

/** The presenter's play / pause (button, Space, hotkey): `play` true to scroll. */
export function choosePlaying(p: Playback, play: boolean): Playback {
  const chosen = p.started ? p.chosen : true
  const duringPause = p.recording === 'paused' ? play : p.duringPause
  return { ...p, want: play, chosen, duringPause, playing: play && !blocked(p) }
}

/** The text reached its end: it stops, and stays stopped after Back until the presenter plays again. */
export function reachedEnd(p: Playback): Playback {
  return { ...p, want: false, playing: false }
}
