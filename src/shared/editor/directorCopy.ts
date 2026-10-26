/**
 * What the camera director's section in the Camera panel says (docs/design/camera-director.md,
 * section 2): part labels and reasons, the summary and the diff of a plan, the notes, the sound
 * status, the framing outcome and the notice after applying. Pure text from plain data, so the
 * copy is unit-tested (tests/directorCopy.test.ts) and the panel stays layout only.
 */
import type { DirectorNote, DirectorPart, DirectorPlan, DirectorReason } from './cameraDirector'
import type { DirectorSpeech } from '../audio/speech'
import type { FramingOutcome } from '../render/faceFraming'
import { formatTime } from '../engine/project'
import type { CameraLayout, Corner } from '../types'

const CORNER_WORDS: Record<Corner, string> = {
  'top-left': 'top left',
  'top-right': 'top right',
  'bottom-left': 'bottom left',
  'bottom-right': 'bottom right'
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`

/** "1.25×", "1.3×", "1×": a zoom as the Framing section rounds it (steps of 0.05). */
export const zoomText = (zoom: number): string => `${Number(zoom.toFixed(2))}×`

/** "Camera only" / "Large camera": how an intro or outro shows the camera. */
const bigCamera = (layout: CameraLayout): string => (layout === 'camera-large' ? 'Large camera' : 'Camera only')

/** The label of a part: "Intro · Camera only", "Bubble bottom left", "Camera hidden", "Outro · Large camera". */
export function partLabel(part: Pick<DirectorPart, 'kind' | 'layout' | 'corner'>): string {
  switch (part.kind) {
    case 'intro':
      return `Intro · ${bigCamera(part.layout)}`
    case 'outro':
      return `Outro · ${bigCamera(part.layout)}`
    case 'hidden':
      return 'Camera hidden'
    case 'corner':
      return part.corner ? `Bubble ${CORNER_WORDS[part.corner]}` : 'Bubble'
  }
}

/** "0:16–0:23": a part's output times, in whole seconds as the viewer counts them. */
export const partTimes = (part: Pick<DirectorPart, 'outStart' | 'outEnd'>): string => `${formatTime(part.outStart, false)}–${formatTime(part.outEnd, false)}`

/** Why the director made a part, in muted text after it. */
export function reasonText(reason: DirectorReason): string {
  switch (reason.kind) {
    case 'talk-before':
      return 'you talk before the demo'
    case 'talk-after':
      return 'you talk after the demo'
    case 'silent':
      return `silent for ${Math.round(reason.seconds)} s`
    case 'cursor':
      return `your cursor works in the ${CORNER_WORDS[reason.avoided]}`
  }
}

/** A whole row of the list: "Intro · Camera only · 0:00–0:06 · you talk before the demo". */
export const partLine = (part: DirectorPart): string => `${partLabel(part)} · ${partTimes(part)} · ${reasonText(part.reason)}`

/** The face row of the list: before applying "measured when you direct", after it the zoom it used. */
export function faceLine(applied: { zoom: number } | null): string {
  return applied ? `Face centred · ${zoomText(applied.zoom)}` : 'Face centred · measured when you direct'
}

/** "4 changes · camera on screen 58% of the video". */
export function summaryLine(plan: Pick<DirectorPlan, 'parts' | 'cameraShare'>): string {
  return `${plural(plan.parts.length, 'change')} · camera on screen ${Math.round(plan.cameraShare * 100)}% of the video`
}

/** "Keeps 1 layout change and 2 camera positions of yours", or null when nothing of the user's is in the way. */
export function keptLine(kept: DirectorPlan['kept']): string | null {
  const what = [kept.changes ? plural(kept.changes, 'layout change') : '', kept.positions ? plural(kept.positions, 'camera position') : ''].filter(Boolean)
  return what.length ? `Keeps ${what.join(' and ')} of yours` : null
}

/** "+2 new · 1 removed · 3 unchanged": what Direct again changes against the director's segments now. */
export function diffLine(diff: DirectorPlan['diff']): string {
  return `+${diff.added} new · ${diff.removed} removed · ${diff.unchanged} unchanged`
}

/** Which sound the director listens to, for the status line (`data-source`). */
export type SourceState = 'measuring' | 'mic' | 'mix' | 'mix-refined' | 'transcript' | 'none'

/** The status of the speech measurement: still measuring, or where the speech came from ('none': no speech known). */
export function sourceState(speech: DirectorSpeech | null, measuring: boolean): SourceState {
  if (measuring) return 'measuring'
  if (!speech) return 'none'
  if (speech.source === 'mix') return speech.refined ? 'mix-refined' : 'mix'
  return speech.source
}

/** The sound status line; null when no speech is known (a note says why). */
export function sourceLine(state: SourceState): string | null {
  switch (state) {
    case 'measuring':
      return 'Listening for speech…'
    case 'mic':
      return 'Listening to your microphone.'
    case 'mix':
      return "Listening to the recording's sound (no separate microphone): sounds from your PC count as talking."
    case 'mix-refined':
      return "Listening to the recording's sound, checked against your captions."
    case 'transcript':
      return "Using your captions' word timings."
    case 'none':
      return null
  }
}

/** The sound could not be measured (shown with Try again); `fromCaptions`: the captions' word timings still gave the speech. */
export const soundFailed = (fromCaptions: boolean): string =>
  fromCaptions ? "The sound could not be measured: the plan uses your captions' word timings." : 'The sound could not be measured: the plan uses the mouse and keyboard only.'

/** What each note says; null for the notes the sound status line already covers. */
export const NOTE_TEXT: Record<DirectorNote, string | null> = {
  'camera-hidden': 'The camera is hidden: show it to direct it.',
  'no-sound': 'No sound was recorded, so there is no intro, outro or hiding: the director keeps the bubble clear of your cursor and centres your face.',
  'no-speech': 'No talking was heard, so the camera stays on throughout and there is no intro or outro.',
  'mixed-sound': null,
  transcript: null,
  'no-input': 'This recording has no mouse or keyboard data: the director hides the camera in silences and frames your face, but cannot keep the bubble clear of the cursor.',
  'no-demo': 'Nothing happens on screen that the director can see (no clicks, typing or zooms), so it cannot tell the intro from the demo.',
  'kept-positions': 'Your camera positions are kept.',
  'all-yours': 'Your own camera changes cover the whole video: nothing left to direct.',
  'options-off': 'The intro and outro, hiding and bubble moves are all off, so the director adds nothing to the camera track.',
  nothing: 'Nothing to change: no talking before or after the demo, no long silences, and the cursor never came near the camera.'
}

/** The lead text of the section. */
export const LEAD =
  'One click builds your camera track: the full camera while you talk before and after the demo, the bubble kept clear of your cursor, hidden in long silences, and your face centred. Changes you made yourself are kept.'

/** The hint under the buttons. */
export const OWNERSHIP_HINT =
  'Changing a block made by the director makes it yours: Direct again keeps it. Direct again brings back automatic changes you deleted; turn off what made them above.'

/** Option hints. */
export const KEPT_POSITIONS_HINT = 'You placed the camera yourself (while recording or with Move camera here): those positions are kept either way.'
export const USER_FRAMING_HINT = 'You framed the camera yourself; turn this on to let the director frame it.'

/** The Layout section's hint for a block the director made. */
export const AUTO_LAYOUT_HINT = 'Made by the auto director. Changing it makes it yours; Direct again keeps it.'

/** The timeline's title suffix of a block the director made. */
export const AUTO_TITLE_SUFFIX = ' · automatic: change it to keep it when you direct again'

/** What the framing came to, for `data-status`: as the outcome says, with the user's own framing kept named apart. */
export type FramingStatus = 'framed' | 'not-found' | 'unavailable' | 'skipped' | 'kept'

/**
 * The framing outcome line, or null when there is nothing to say (skipped because the option was
 * off on a framing the director may set). `userFraming`: the framing was the user's and the option off.
 */
export function framingLine(outcome: FramingOutcome, userFraming: boolean): { status: FramingStatus; text: string } | null {
  switch (outcome.status) {
    case 'framed':
      return {
        status: 'framed',
        text: outcome.steady ? `Face centred (${zoomText(outcome.zoom)}).` : 'You move around a lot, so the camera is centred on you with little zoom.'
      }
    case 'not-found':
      return { status: 'not-found', text: 'No one was found in the camera picture, so the framing was left as it was.' }
    case 'unavailable':
      return { status: 'unavailable', text: `Face framing is unavailable: ${outcome.reason.replace(/[.\s]+$/, '')}. The rest of the camera track was directed.` }
    case 'skipped':
      return userFraming ? { status: 'kept', text: 'Your framing is kept (turn on Centre my face to let the director frame you).' } : null
  }
}

/**
 * The notice after applying: "Camera directed: intro, 1 bubble move, 2 hidden, outro; face
 * centred (1.25×)" followed by `undo` (undoHint), or "Nothing to change" when the project did not
 * change. With no part and no framing: "earlier automatic changes removed" when the director's
 * segments went (`removed`), else "options saved" (only the options were written).
 */
export function directedNotice(parts: readonly Pick<DirectorPart, 'kind'>[], outcome: FramingOutcome, changed: boolean, undo: string, removed: boolean): string {
  if (!changed) return 'Nothing to change'
  const count = (k: DirectorPart['kind']): number => parts.filter((p) => p.kind === k).length
  const what: string[] = []
  if (count('intro')) what.push('intro')
  if (count('corner')) what.push(plural(count('corner'), 'bubble move'))
  if (count('hidden')) what.push(`${count('hidden')} hidden`)
  if (count('outro')) what.push('outro')
  const face = outcome.status === 'framed' ? `face centred (${zoomText(outcome.zoom)})` : ''
  const body = what.length ? what.join(', ') + (face ? `; ${face}` : '') : face || (removed ? 'earlier automatic changes removed' : 'options saved')
  return `Camera directed: ${body}${undo}`
}

/** The notice after "Remove automatic changes". */
export function removedNotice(changed: boolean, undo: string): string {
  return changed ? `Automatic camera changes removed${undo}` : 'No automatic changes to remove'
}

/** The primary button: "Direct camera", "Direct again" once the director's changes are in, "Up to date" when nothing would change. */
export function applyLabel(state: { directed: boolean; upToDate: boolean }): string {
  if (state.upToDate) return 'Up to date'
  return state.directed ? 'Direct again' : 'Direct camera'
}

/** The busy button while applying: still listening, then measuring the face (`done`/`total` pictures). */
export function applyingLabel(progress: { listening: boolean; done: number; total: number }): string {
  if (progress.listening) return 'Listening for speech…'
  return progress.total ? `Finding your face… ${progress.done}/${progress.total}` : 'Finding your face…'
}

/** Why the palette cannot direct the camera, or null when it can. */
export function directUnavailable(hasCamera: boolean, shown: boolean): string | null {
  if (!hasCamera) return 'This recording has no camera'
  return shown ? null : 'Show the camera first'
}
