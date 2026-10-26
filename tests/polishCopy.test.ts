import { describe, expect, it } from 'vitest'
import type { PolishStepResult, PolishSummary } from '../src/shared/editor/polish'
import {
  polishFailed,
  polishHeadline,
  polishHint,
  polishNotice,
  polishResultLines,
  polishSkipText,
  polishStepLabel,
  providerName,
  SILENCE_ACTION_CHIPS,
  transcriberLabel,
  transcribePhaseText
} from '../src/shared/editor/polishCopy'

/** What the Polish dialog and its notice say (docs/design/polish-in-one-click.md §5). */

const UNDO = ' · Ctrl + Z to undo'

function summary(steps: PolishStepResult[], over: Partial<PolishSummary> = {}): PolishSummary {
  return {
    steps,
    saved: 0,
    silences: 0,
    silenceAction: 'cut',
    zooms: { auto: 0, kept: 0 },
    camera: { intro: false, outro: false, hidden: 0, moves: 0 },
    framing: null,
    captions: 0,
    captionsLeftOutAfter: null,
    style: null,
    ...over
  }
}

const changed = (step: PolishStepResult['step']): PolishStepResult => ({ step, status: 'changed' })
const unchanged = (step: PolishStepResult['step']): PolishStepResult => ({ step, status: 'unchanged' })
const skipped = (step: PolishStepResult['step'], reason: PolishStepResult['reason'], error?: string): PolishStepResult => ({ step, status: 'skipped', reason, error })

/** Every step changed something: 9 silences cut (72 s), 12 automatic zooms and 2 of yours, a directed camera, 63 captions, Studio. */
const EVERYTHING = summary(['style', 'zoom', 'silences', 'captions', 'director'].map((s) => changed(s as PolishStepResult['step'])), {
  saved: 72,
  silences: 9,
  zooms: { auto: 12, kept: 2 },
  camera: { intro: true, outro: true, hidden: 2, moves: 1 },
  framing: { status: 'framed', zoom: 1.25, cropX: 0.5, cropY: 0.45, found: 6, sampled: 6, steady: true },
  captions: 63,
  style: 'Studio'
})

describe('headline', () => {
  it('says how much shorter the video is', () => {
    expect(polishHeadline(summary([changed('silences')], { saved: 3.5 }), true)).toBe('Polished: the video is 3.5 s shorter')
    expect(polishHeadline(summary([changed('silences')], { saved: 72 }), true)).toBe('Polished: the video is 1:12.0 shorter')
    expect(polishHeadline(summary([changed('zoom')], { saved: 0 }), true)).toBe('Polished')
    expect(polishHeadline(summary([unchanged('zoom')]), false)).toBe('Already polished: nothing to change')
  })
})

describe('summary lines', () => {
  it('one line per step, in run order, each with its status', () => {
    const lines = polishResultLines(EVERYTHING)
    expect(lines.map((l) => [l.step, l.status])).toEqual([
      ['style', 'changed'],
      ['zoom', 'changed'],
      ['silences', 'changed'],
      ['captions', 'changed'],
      ['director', 'changed']
    ])
    expect(lines.map((l) => l.text)).toEqual([
      'Style: Studio',
      'Auto zoom turned on: 12 zooms · 2 of yours kept',
      'Cut 9 silences: 1:12.0 shorter',
      'Captions: 63 captions',
      'Camera: intro, 1 bubble move, 2 hidden, outro; face centred (1.25×)'
    ])
  })

  it('unchanged steps say why nothing changed', () => {
    const s = summary(['style', 'zoom', 'silences', 'director'].map((x) => unchanged(x as PolishStepResult['step'])), { zooms: { auto: 10, kept: 2 }, style: 'Studio' })
    expect(polishResultLines(s).map((l) => l.text)).toEqual(['Style: already Studio', 'Auto zoom: already on · 12 zooms', 'No silences of 1.0 s or more', 'Camera: already directed'])
    expect(polishResultLines(summary([unchanged('silences')], { silenceAction: 4 }))[0].text).toBe('No silences of 1.0 s or more to speed up')
  })

  it('speeding up, captions left out, and a face that was not found', () => {
    const s = summary([changed('silences'), changed('captions'), changed('director')], {
      silences: 2,
      silenceAction: 4,
      saved: 48,
      captions: 5000,
      captionsLeftOutAfter: 3725,
      camera: { intro: false, outro: false, hidden: 0, moves: 2 },
      framing: { status: 'not-found', found: 1, sampled: 8 }
    })
    expect(polishResultLines(s).map((l) => l.text)).toEqual([
      'Sped up 2 silences 4×: 48.0 s shorter',
      'Captions: 5000 captions. A project keeps at most 5000 captions, so the captions after 62:05 were left out.',
      'Camera: 2 bubble moves. No one was found in the camera picture, so the framing was left as it was.'
    ])
  })

  it('skipped steps are named with their reason; captions say what failed', () => {
    const s = summary([
      skipped('style', 'off'),
      skipped('zoom', 'no-input'),
      skipped('silences', 'nothing-heard'),
      skipped('captions', 'failed', 'No credits or quota left.'),
      skipped('director', 'camera-hidden')
    ])
    expect(polishResultLines(s).map((l) => [l.status, l.text])).toEqual([
      ['skipped', 'Style: the current look is kept'],
      ['skipped', 'Auto zoom: no clicks were captured'],
      ['skipped', 'Remove silences: nothing is heard in this recording, so nothing was cut'],
      ['skipped', 'Captions not made: No credits or quota left. Try again in the Captions tab.'],
      ['skipped', 'Camera director: show the camera first']
    ])
    expect(polishResultLines(summary([skipped('captions', 'cancelled')]))[0].text).toBe('Captions: skipped')
    expect(polishResultLines(summary([skipped('zoom', 'off')]))[0].text).toBe('Auto zoom: not selected')
  })
})

describe('notice', () => {
  it('lists only the steps that changed something, then the undo hint', () => {
    expect(polishNotice(EVERYTHING, true, UNDO)).toBe(
      'Polished: 1:12.0 shorter · Studio style · auto zoom on · 9 silences cut · 63 captions · 5 camera changes, face centred · Ctrl + Z to undo'
    )
    const some = summary([unchanged('style'), changed('zoom'), skipped('silences', 'muted'), changed('captions'), unchanged('director')], { captions: 1, style: 'Studio' })
    expect(polishNotice(some, true, UNDO)).toBe('Polished · auto zoom on · 1 caption · Ctrl + Z to undo')
    expect(polishNotice(summary([changed('silences')], { silences: 1, silenceAction: 2, saved: 1.5 }), true, '')).toBe('Polished: 1.5 s shorter · 1 silence sped up 2×')
    expect(polishNotice(some, false, UNDO)).toBe('Already polished: nothing to change')
  })
})

describe('rows and progress', () => {
  it('names the steps and the silence actions as the Clip panel does', () => {
    expect(['style', 'zoom', 'silences', 'captions', 'director'].map((s) => polishStepLabel(s as PolishStepResult['step']))).toEqual([
      'Style',
      'Auto zoom',
      'Remove silences',
      'Captions',
      'Camera director'
    ])
    expect(SILENCE_ACTION_CHIPS.map((c) => c.label)).toEqual(['Cut', '2×', '4×', '8×'])
  })

  it('hints follow the options', () => {
    const state = { silenceAction: 'cut' as const, autoZoomOn: false, provider: { label: '', kind: 'gemini' as const } }
    expect(polishHint('silences', state)).toBe('Cuts pauses of 1.0 s or more, keeping a quarter second next to the sound.')
    expect(polishHint('silences', { ...state, silenceAction: 4 })).toBe('Plays pauses of 1.0 s or more 4× as fast, keeping a quarter second next to the sound.')
    expect(polishHint('zoom', state)).toBe('Turns auto zoom on. Zooms you added or edited are kept.')
    expect(polishHint('zoom', { ...state, autoZoomOn: true })).toBe('Auto zoom is on: your zooms stay as they are.')
    expect(polishHint('captions', state)).toBe('The sound is sent to Gemini with your key and billed to your account.')
    expect(providerName({ label: 'Work key', kind: 'openai' })).toBe('Work key')
    expect(transcriberLabel({ label: '', kind: 'openai', transcriptionModel: 'whisper-1' })).toBe('OpenAI · whisper-1')
  })

  it('disabled rows say why', () => {
    expect(polishSkipText('silences', 'no-sound')).toBe('This recording has no sound')
    expect(polishSkipText('silences', 'muted')).toBe('The sound is muted: turn it on in the Audio tab')
    expect(polishSkipText('zoom', 'no-input')).toBe('No clicks were captured')
    expect(polishSkipText('captions', 'has-captions')).toBe('This video already has captions; they are kept')
    expect(polishSkipText('captions', 'no-provider')).toBe('Add an AI provider that can transcribe (OpenAI or Gemini)')
    expect(polishSkipText('director', 'no-camera')).toBe('This recording has no camera')
    expect(polishFailed('boom.')).toBe('Polish failed: boom. Nothing was changed.')
  })

  it('the Captions row shows the transcription as the Captions tab does', () => {
    const p = (phase: 'extracting' | 'uploading' | 'transcribing' | 'finishing', done: number, total: number) => ({ projectId: 'p', phase, done, total })
    expect(transcribePhaseText(p('uploading', 1, 3), false)).toBe('Sending the sound… Part 2 of 3.')
    expect(transcribePhaseText(p('transcribing', 0, 1), false)).toBe('Transcribing…')
    expect(transcribePhaseText(p('extracting', 0, 1), false)).toBe('Preparing the sound…')
    expect(transcribePhaseText(p('finishing', 3, 3), false)).toBe('Finishing… Part 3 of 3.')
    expect(transcribePhaseText(null, false)).toBe('Starting…')
    expect(transcribePhaseText(p('transcribing', 1, 3), true)).toBe('Stopping…')
  })
})
