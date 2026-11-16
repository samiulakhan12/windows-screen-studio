/**
 * What the camera director's section in the Camera panel says (docs/design/camera-director.md,
 * section 2): part labels and reasons, the summary and the diff of a plan, the notes, the sound
 * status, the framing outcome and the notice after applying. Messages (camera.director.*) made from
 * plain data where they are shown, so the copy is unit-tested (tests/directorCopy.test.ts) and the
 * panel stays layout only.
 */
import type { DirectorNote, DirectorPart, DirectorPlan, DirectorReason } from './cameraDirector'
import type { DirectorSpeech } from '../audio/speech'
import type { FramingOutcome } from '../render/faceFraming'
import type { CameraLayout, DirectorSettings } from '../types'
import { fmt } from '../i18n/fmt'
import { t } from '../i18n/t'

/** "1.25×", "1.3×", "1×": a zoom as the Framing section rounds it (steps of 0.05). */
export const zoomText = (zoom: number): string => `${Number(zoom.toFixed(2))}×`

const large = (layout: CameraLayout): boolean => layout === 'camera-large'

/** The label of a part: "Intro · Camera only", "Bubble bottom left", "Camera hidden", "Outro · Large camera". */
export function partLabel(part: Pick<DirectorPart, 'kind' | 'layout' | 'corner'>): string {
  switch (part.kind) {
    case 'intro':
      return large(part.layout) ? t('camera.director.part.introLarge') : t('camera.director.part.introCamera')
    case 'outro':
      return large(part.layout) ? t('camera.director.part.outroLarge') : t('camera.director.part.outroCamera')
    case 'hidden':
      return t('camera.director.part.hidden')
    case 'corner':
      return part.corner ? t('camera.director.part.bubbleCorner', { corner: part.corner }) : t('camera.director.part.bubble')
  }
}

/** "0:16–0:23": a part's output times, in whole seconds as the viewer counts them. */
export const partTimes = (part: Pick<DirectorPart, 'outStart' | 'outEnd'>): string => `${fmt.clock(part.outStart, 'whole')}–${fmt.clock(part.outEnd, 'whole')}`

/** Why the director made a part, in muted text after it. */
export function reasonText(reason: DirectorReason): string {
  switch (reason.kind) {
    case 'talk-before':
      return t('camera.director.reason.talkBefore')
    case 'talk-after':
      return t('camera.director.reason.talkAfter')
    case 'silent':
      return t('camera.director.reason.silent', { n: fmt.count(Math.round(reason.seconds)) })
    case 'cursor':
      return t('camera.director.reason.cursor', { corner: reason.avoided })
  }
}

/** A whole row of the list: "Intro · Camera only · 0:00–0:06 · you talk before the demo". */
export const partLine = (part: DirectorPart): string => t('camera.director.partLine', { label: partLabel(part), times: partTimes(part), reason: reasonText(part.reason) })

/** The face row of the list: before applying "measured when you direct", after it the zoom it used. */
export function faceLine(applied: { zoom: number } | null): string {
  return applied ? t('camera.director.faceApplied', { zoom: fmt.factor(applied.zoom) }) : t('camera.director.facePlanned')
}

/** "4 changes · camera on screen 58% of the video". */
export function summaryLine(plan: Pick<DirectorPlan, 'parts' | 'cameraShare'>): string {
  return t('camera.director.summary', { count: plan.parts.length, n: fmt.count(plan.parts.length), percent: fmt.count(Math.round(plan.cameraShare * 100)) })
}

/** "Keeps 1 layout change and 2 camera positions of yours", or null when nothing of the user's is in the way. */
export function keptLine(kept: DirectorPlan['kept']): string | null {
  if (kept.changes && kept.positions) return t('camera.director.keptBoth', { count: kept.changes, n: fmt.count(kept.changes), positions: kept.positions, p: fmt.count(kept.positions) })
  if (kept.changes) return t('camera.director.keptChanges', { count: kept.changes, n: fmt.count(kept.changes) })
  if (kept.positions) return t('camera.director.keptPositions', { count: kept.positions, n: fmt.count(kept.positions) })
  return null
}

/** "+2 new · 1 removed · 3 unchanged": what Direct again changes against the director's segments now. */
export function diffLine(diff: DirectorPlan['diff']): string {
  return t('camera.director.diff', { added: fmt.count(diff.added), removed: fmt.count(diff.removed), unchanged: fmt.count(diff.unchanged) })
}

/** Which sound the director listens to, for the status line (`data-source`). */
export type SourceState = 'measuring' | 'mic' | 'mix' | 'mix-voice' | 'mix-refined' | 'transcript' | 'none'

/**
 * The status of the speech measurement: still measuring, or where the speech came from ('none': no
 * speech known; 'mix-voice': the mixed track, through the speech detector).
 */
export function sourceState(speech: DirectorSpeech | null, measuring: boolean): SourceState {
  if (measuring) return 'measuring'
  if (!speech) return 'none'
  if (speech.source === 'mix') return speech.refined ? 'mix-refined' : speech.detector === 'speech' ? 'mix-voice' : 'mix'
  return speech.source
}

/** The sound status line; null when no speech is known (a note says why). */
export function sourceLine(state: SourceState): string | null {
  switch (state) {
    case 'measuring':
      return t('camera.director.source.measuring')
    case 'mic':
      return t('camera.director.source.mic')
    case 'mix':
      return t('camera.director.source.mix')
    case 'mix-voice':
      return t('camera.director.source.mixVoice')
    case 'mix-refined':
      return t('camera.director.source.mixRefined')
    case 'transcript':
      return t('camera.director.source.transcript')
    case 'none':
      return null
  }
}

/** The sound could not be measured (shown with Try again); `fromCaptions`: the captions' word timings still gave the speech. */
export const soundFailed = (fromCaptions: boolean): string => (fromCaptions ? t('camera.director.soundFailedCaptions') : t('camera.director.soundFailedInput'))

/** What each note says; null for the notes the sound status line already covers. */
export const NOTE_TEXT: Readonly<Record<DirectorNote, string | null>> = {
  get 'camera-hidden'() {
    return t('camera.director.note.cameraHidden')
  },
  get 'no-sound'() {
    return t('camera.director.note.noSound')
  },
  get 'no-speech'() {
    return t('camera.director.note.noSpeech')
  },
  get 'no-input'() {
    return t('camera.director.note.noInput')
  },
  get 'no-demo'() {
    return t('camera.director.note.noDemo')
  },
  get 'kept-positions'() {
    return t('camera.director.note.keptPositions')
  },
  get 'all-yours'() {
    return t('camera.director.note.allYours')
  },
  get 'options-off'() {
    return t('camera.director.note.optionsOff')
  },
  get 'nothing'() {
    return t('camera.director.note.nothing')
  },
  get 'band'() {
    return t('camera.director.note.band')
  },
  'mixed-sound': null,
  transcript: null
}

/**
 * What a note says for a plan made with `settings`: "nothing to change" gives only the reasons of
 * the options that are on (NOTE_TEXT.nothing when all three are), as one turned off is the reason
 * for its part. The other notes do not depend on the options.
 */
export function noteText(note: DirectorNote, settings: Pick<DirectorSettings, 'intro' | 'hideAfter' | 'corners'>): string | null {
  if (note !== 'nothing') return NOTE_TEXT[note]
  const which = `${settings.intro !== 'off' ? 'i' : ''}${settings.hideAfter > 0 ? 's' : ''}${settings.corners === 'auto' ? 'c' : ''}`
  switch (which) {
    case 'isc':
      return t('camera.director.note.nothing')
    case 'is':
      return t('camera.director.nothing.is')
    case 'ic':
      return t('camera.director.nothing.ic')
    case 'sc':
      return t('camera.director.nothing.sc')
    case 'i':
      return t('camera.director.nothing.i')
    case 's':
      return t('camera.director.nothing.s')
    case 'c':
      return t('camera.director.nothing.c')
    default:
      return t('camera.director.nothing.none')
  }
}

/** The lead text of the section. */
export const lead = (): string => t('camera.director.lead')

/** The hint under the buttons. */
export const ownershipHint = (): string => t('camera.director.ownershipHint')

/** Option hints. */
export const keptPositionsHint = (): string => t('camera.director.keptPositionsHint')
export const userFramingHint = (): string => t('camera.director.userFramingHint')

/** The Layout section's hint for a block the director made. */
export const autoLayoutHint = (): string => t('camera.director.autoLayoutHint')

/** The timeline's title suffix of a block the director made. */
export const autoTitleSuffix = (): string => t('camera.director.autoTitleSuffix')

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
        text: outcome.steady ? t('camera.director.framed', { zoom: fmt.factor(outcome.zoom) }) : t('camera.director.framedMoving')
      }
    case 'not-found':
      return { status: 'not-found', text: t('camera.director.notFound') }
    case 'unavailable':
      return { status: 'unavailable', text: t('camera.director.framingUnavailable', { reason: outcome.reason.replace(/[.\s]+$/, '') }) }
    case 'skipped':
      return userFraming ? { status: 'kept', text: t('camera.director.framingKept') } : null
  }
}

/**
 * The notice after applying: "Camera directed: intro, 1 bubble move, 2 hidden, outro; face
 * centred (1.25×)" followed by `undo` (undoHint), or "Nothing to change" when the project did not
 * change. With no part and no framing: "earlier automatic changes removed" when the director's
 * segments went (`removed`), else "options saved" (only the options were written).
 */
export function directedNotice(parts: readonly Pick<DirectorPart, 'kind'>[], outcome: FramingOutcome, changed: boolean, undo: string, removed: boolean): string {
  if (!changed) return t('camera.director.done.nothing')
  const count = (k: DirectorPart['kind']): number => parts.filter((p) => p.kind === k).length
  const what: string[] = []
  if (count('intro')) what.push(t('camera.director.done.intro'))
  if (count('corner')) what.push(t('camera.director.done.moves', { count: count('corner'), n: fmt.count(count('corner')) }))
  if (count('hidden')) what.push(t('camera.director.done.hidden', { n: fmt.count(count('hidden')) }))
  if (count('outro')) what.push(t('camera.director.done.outro'))
  const face = outcome.status === 'framed' ? t('camera.director.done.face', { zoom: fmt.factor(outcome.zoom) }) : ''
  const body = what.length ? what.join(', ') + (face ? `; ${face}` : '') : face || (removed ? t('camera.director.done.removed') : t('camera.director.done.saved'))
  return `${t('camera.director.done.directed', { body })}${undo}`
}

/** The notice after "Remove automatic changes". */
export function removedNotice(changed: boolean, undo: string): string {
  return changed ? `${t('camera.director.removed')}${undo}` : t('camera.director.noneToRemove')
}

/** The primary button: "Direct camera", "Direct again" once the director's changes are in, "Up to date" when nothing would change. */
export function applyLabel(state: { directed: boolean; upToDate: boolean }): string {
  if (state.upToDate) return t('camera.director.apply.upToDate')
  return state.directed ? t('camera.director.apply.again') : t('camera.director.apply.first')
}

/** The busy button while applying: still listening, then measuring the face (`done`/`total` pictures). */
export function applyingLabel(progress: { listening: boolean; done: number; total: number }): string {
  if (progress.listening) return t('camera.director.applying.listening')
  return progress.total ? t('camera.director.applying.faceProgress', { done: fmt.count(progress.done), total: fmt.count(progress.total) }) : t('camera.director.applying.face')
}

/** Why the palette cannot direct the camera, or null when it can. */
export function directUnavailable(hasCamera: boolean, shown: boolean): string | null {
  if (!hasCamera) return t('camera.director.unavailable.noCamera')
  return shown ? null : t('camera.director.unavailable.hidden')
}
