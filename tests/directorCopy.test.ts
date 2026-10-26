import { describe, expect, it } from 'vitest'
import type { DirectorPart } from '../src/shared/editor/cameraDirector'
import { commandInfo, PALETTE_COMMANDS, searchCommands } from '../src/shared/editor/commands'
import {
  applyingLabel,
  applyLabel,
  diffLine,
  directedNotice,
  directUnavailable,
  faceLine,
  framingLine,
  keptLine,
  NOTE_TEXT,
  noteText,
  partLabel,
  partLine,
  partTimes,
  reasonText,
  removedNotice,
  soundFailed,
  sourceLine,
  sourceState,
  summaryLine,
  zoomText
} from '../src/shared/editor/directorCopy'
import { DEFAULT_KEYMAP, undoHint } from '../src/shared/editor/shortcuts'

/** The plan of the e2e fixture (camera-director.md, F1): intro, hidden, bubble bottom left, hidden, outro. */
const part = (p: Partial<DirectorPart> & Pick<DirectorPart, 'kind' | 'layout' | 'outStart' | 'outEnd' | 'reason'>): DirectorPart => ({ start: p.outStart, end: p.outEnd, ids: ['a1'], ...p })
const F1: DirectorPart[] = [
  part({ kind: 'intro', layout: 'camera-only', outStart: 0, outEnd: 6.5, reason: { kind: 'talk-before' } }),
  part({ kind: 'hidden', layout: 'screen-only', outStart: 6.5, outEnd: 16.2, reason: { kind: 'silent', seconds: 11 } }),
  part({ kind: 'corner', layout: 'default', corner: 'bottom-left', outStart: 16.2, outEnd: 23, reason: { kind: 'cursor', avoided: 'bottom-right' } }),
  part({ kind: 'hidden', layout: 'screen-only', outStart: 23, outEnd: 33.7, reason: { kind: 'silent', seconds: 12 } }),
  part({ kind: 'outro', layout: 'camera-only', outStart: 33.7, outEnd: 48, reason: { kind: 'talk-after' } })
]

describe('the rows of the plan', () => {
  it('labels each part with its layout, times and reason', () => {
    expect(F1.map(partLine)).toEqual([
      'Intro · Camera only · 0:00–0:06 · you talk before the demo',
      'Camera hidden · 0:06–0:16 · silent for 11 s',
      'Bubble bottom left · 0:16–0:23 · your cursor works in the bottom right',
      'Camera hidden · 0:23–0:33 · silent for 12 s',
      'Outro · Camera only · 0:33–0:48 · you talk after the demo'
    ])
    expect(partLabel({ kind: 'intro', layout: 'camera-large', corner: 'bottom-left' })).toBe('Intro · Large camera')
    expect(partLabel({ kind: 'outro', layout: 'camera-large' })).toBe('Outro · Large camera')
    expect(partLabel({ kind: 'corner', layout: 'default', corner: 'top-right' })).toBe('Bubble top right')
    expect(partTimes({ outStart: 61.4, outEnd: 125.9 })).toBe('1:01–2:05')
    expect(reasonText({ kind: 'silent', seconds: 11.6 })).toBe('silent for 12 s')
  })

  it('names the face framing before and after applying', () => {
    expect(faceLine(null)).toBe('Face centred · measured when you direct')
    expect(faceLine({ zoom: 1.25 })).toBe('Face centred · 1.25×')
    expect(zoomText(1.3)).toBe('1.3×')
    expect(zoomText(1)).toBe('1×')
  })
})

describe('the summary', () => {
  it('counts the changes and the camera time, what of the user is kept, and the diff', () => {
    expect(summaryLine({ parts: F1.slice(0, 4), cameraShare: 0.581 })).toBe('4 changes · camera on screen 58% of the video')
    expect(summaryLine({ parts: F1.slice(0, 1), cameraShare: 1 })).toBe('1 change · camera on screen 100% of the video')
    expect(keptLine({ changes: 1, positions: 2 })).toBe('Keeps 1 layout change and 2 camera positions of yours')
    expect(keptLine({ changes: 2, positions: 0 })).toBe('Keeps 2 layout changes of yours')
    expect(keptLine({ changes: 0, positions: 1 })).toBe('Keeps 1 camera position of yours')
    expect(keptLine({ changes: 0, positions: 0 })).toBeNull()
    expect(diffLine({ added: 2, removed: 1, unchanged: 3 })).toBe('+2 new · 1 removed · 3 unchanged')
  })

  it('labels the primary button by the state of the project', () => {
    expect(applyLabel({ directed: false, upToDate: false })).toBe('Direct camera')
    expect(applyLabel({ directed: true, upToDate: false })).toBe('Direct again')
    expect(applyLabel({ directed: true, upToDate: true })).toBe('Up to date')
    expect(applyingLabel({ listening: true, done: 0, total: 0 })).toBe('Listening for speech…')
    expect(applyingLabel({ listening: false, done: 7, total: 12 })).toBe('Finding your face… 7/12')
  })
})

describe('the sound status and the notes', () => {
  it('says which sound the director listens to', () => {
    expect(sourceState(null, true)).toBe('measuring')
    expect(sourceState(null, false)).toBe('none')
    expect(sourceState({ ranges: [], source: 'mic', refined: false }, false)).toBe('mic')
    expect(sourceState({ ranges: [], source: 'mix', refined: false }, false)).toBe('mix')
    expect(sourceState({ ranges: [], source: 'mix', refined: true }, false)).toBe('mix-refined')
    expect(sourceState({ ranges: [], source: 'transcript', refined: true }, false)).toBe('transcript')
    expect(sourceLine('mic')).toBe('Listening to your microphone.')
    expect(sourceLine('mix')).toBe("Listening to the recording's sound (no separate microphone): sounds from your PC count as talking.")
    expect(sourceLine('mix-refined')).toBe("Listening to the recording's sound, checked against your captions.")
    expect(sourceLine('transcript')).toBe("Using your captions' word timings.")
    expect(sourceLine('measuring')).toBe('Listening for speech…')
    expect(sourceLine('none')).toBeNull()
  })

  it('has the spec copy for every note (the status line covers mixed sound and the transcript)', () => {
    expect(NOTE_TEXT['camera-hidden']).toBe('The camera is hidden: show it to direct it.')
    expect(NOTE_TEXT.nothing).toBe('Nothing to change: no talking before or after the demo, no long silences, and the cursor never came near the camera.')
    expect(NOTE_TEXT['all-yours']).toBe('Your own camera changes cover the whole video: nothing left to direct.')
    expect(NOTE_TEXT['mixed-sound']).toBeNull()
    expect(NOTE_TEXT.transcript).toBeNull()
    expect(NOTE_TEXT['options-off']).toBe('The intro and outro, hiding and bubble moves are all off, so the director adds nothing to the camera track.')
    for (const n of ['no-sound', 'no-speech', 'no-input', 'no-demo', 'kept-positions'] as const) expect(NOTE_TEXT[n]).toMatch(/\.$/)
  })

  it('"nothing to change" gives only the reasons of the options that are on', () => {
    const on = { intro: 'camera-only', hideAfter: 10, corners: 'auto' } as const
    expect(noteText('nothing', on)).toBe(NOTE_TEXT.nothing)
    expect(noteText('nothing', { ...on, intro: 'camera-large' })).toBe(NOTE_TEXT.nothing)
    // Intro and outro Off, hide Never: only the bubble moves could have changed something.
    expect(noteText('nothing', { intro: 'off', hideAfter: 0, corners: 'auto' })).toBe('Nothing to change: the cursor never came near the camera.')
    expect(noteText('nothing', { intro: 'camera-only', hideAfter: 0, corners: 'keep' })).toBe('Nothing to change: no talking before or after the demo.')
    expect(noteText('nothing', { intro: 'off', hideAfter: 5, corners: 'keep' })).toBe('Nothing to change: no long silences.')
    expect(noteText('nothing', { intro: 'off', hideAfter: 20, corners: 'auto' })).toBe('Nothing to change: no long silences and the cursor never came near the camera.')
    expect(noteText('nothing', { intro: 'camera-large', hideAfter: 10, corners: 'keep' })).toBe('Nothing to change: no talking before or after the demo and no long silences.')
    // All three off is the options-off note; should "nothing" come anyway, it gives no reason.
    expect(noteText('nothing', { intro: 'off', hideAfter: 0, corners: 'keep' })).toBe('Nothing to change.')
    // The other notes do not depend on the options.
    expect(noteText('all-yours', { intro: 'off', hideAfter: 0, corners: 'auto' })).toBe(NOTE_TEXT['all-yours'])
    expect(noteText('mixed-sound', on)).toBeNull()
  })

  it('says what a plan uses when the sound could not be measured (dir-plan-6)', () => {
    expect(soundFailed(false)).toBe('The sound could not be measured: the plan uses the mouse and keyboard only.')
    expect(soundFailed(true)).toBe("The sound could not be measured: the plan uses your captions' word timings.")
  })
})

describe('the framing outcome', () => {
  it('reports each outcome', () => {
    expect(framingLine({ status: 'framed', zoom: 1.25, cropX: 0.62, cropY: 0.4, found: 12, sampled: 12, steady: true }, false)).toEqual({ status: 'framed', text: 'Face centred (1.25×).' })
    expect(framingLine({ status: 'framed', zoom: 1.2, cropX: 0.5, cropY: 0.4, found: 9, sampled: 12, steady: false }, false)?.text).toBe(
      'You move around a lot, so the camera is centred on you with little zoom.'
    )
    expect(framingLine({ status: 'not-found', found: 1, sampled: 12 }, false)?.status).toBe('not-found')
    expect(framingLine({ status: 'unavailable', reason: 'WebGL is not available.' }, false)?.text).toBe(
      'Face framing is unavailable: WebGL is not available. The rest of the camera track was directed.'
    )
    expect(framingLine({ status: 'skipped' }, true)).toEqual({ status: 'kept', text: 'Your framing is kept (turn on Centre my face to let the director frame you).' })
    expect(framingLine({ status: 'skipped' }, false)).toBeNull()
  })
})

describe('the notices', () => {
  const undo = undoHint(DEFAULT_KEYMAP)
  it('names what was directed, with the undo hint', () => {
    const framed = { status: 'framed', zoom: 1.25, cropX: 0.62, cropY: 0.4, found: 12, sampled: 12, steady: true } as const
    expect(directedNotice(F1, framed, true, undo, false)).toBe(`Camera directed: intro, 1 bubble move, 2 hidden, outro; face centred (1.25×)${undo}`)
    expect(undo).toMatch(/to undo$/)
    expect(directedNotice(F1.slice(2, 3), { status: 'skipped' }, true, '', false)).toBe('Camera directed: 1 bubble move')
    expect(directedNotice([], framed, true, '', true)).toBe('Camera directed: face centred (1.25×)')
    expect(directedNotice(F1, framed, false, undo, false)).toBe('Nothing to change')
    expect(removedNotice(true, '')).toBe('Automatic camera changes removed')
    expect(removedNotice(false, undo)).toBe('No automatic changes to remove')
  })

  it('says the earlier automatic changes were removed only when they were; else that the options were saved (ui-dir-3)', () => {
    for (const outcome of [{ status: 'skipped' }, { status: 'not-found', found: 0, sampled: 12 }, { status: 'unavailable', reason: 'no WebGL' }] as const) {
      expect(directedNotice([], outcome, true, '', true)).toBe('Camera directed: earlier automatic changes removed')
      expect(directedNotice([], outcome, true, '', false)).toBe('Camera directed: options saved')
    }
  })
})

describe('the palette command', () => {
  it('is a Camera command without a default shortcut, found by "direct"', () => {
    const c = commandInfo('directCamera')
    expect(c.title).toBe('Direct the camera automatically')
    expect(c.category).toBe('Camera')
    expect(DEFAULT_KEYMAP.directCamera).toEqual([])
    expect(PALETTE_COMMANDS.map((p) => p.id)).toContain('directCamera')
    expect(searchCommands(PALETTE_COMMANDS, 'direct', [])[0].command.id).toBe('directCamera')
  })

  it('says why it is unavailable', () => {
    expect(directUnavailable(false, true)).toBe('This recording has no camera')
    expect(directUnavailable(true, false)).toBe('Show the camera first')
    expect(directUnavailable(true, true)).toBeNull()
  })
})
