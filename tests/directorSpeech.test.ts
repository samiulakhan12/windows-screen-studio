import { describe, expect, it } from 'vitest'
import type { Range } from '../src/shared/audio/activity'
import type { AudioLevels } from '../src/shared/audio/loudness'
import { refineSpeech, SPEECH, speechFromLevels, speechLevelSource, transcriptSpeech } from '../src/shared/audio/speech'
import type { CaptionSegment, CursorTrack } from '../src/shared/types'

const WINDOW = 0.05

/** An envelope of `seconds` at `floor` power with `parts` ([start, end, power]) on top. */
function levels(seconds: number, parts: [number, number, number][], floor = 1e-7): AudioLevels {
  const power = new Float32Array(Math.round(seconds / WINDOW)).fill(floor)
  for (const [start, end, p] of parts) {
    for (let i = Math.round(start / WINDOW); i < Math.round(end / WINDOW); i++) power[i] = p
  }
  return { window: WINDOW, power }
}

/** Speech at 1e-3 over [start, end] with a 0.3 s word gap every 2 s. */
function talk(start: number, end: number): [number, number, number][] {
  const parts: [number, number, number][] = []
  for (let t = start; t < end; t += 2) parts.push([t, Math.min(end, t + 1.7), 1e-3])
  return parts
}

/** Keyboard ticks at 1e-4 for 0.1 s every 0.3 s over [start, end]. */
function ticks(start: number, end: number): [number, number, number][] {
  const parts: [number, number, number][] = []
  for (let t = start; t < end - 1e-9; t += 0.3) parts.push([t, t + 0.1, 1e-4])
  return parts
}

const track = (over: Partial<CursorTrack> = {}): CursorTrack => ({ samples: [], clicks: [], valid: true, ...over })

const pairs = (ranges: readonly Range[] | null | undefined): [number, number][] => (ranges ?? []).map((r) => [r.start, r.end])

function expectRanges(actual: readonly Range[] | null | undefined, expected: [number, number][], tol = 0.05): void {
  const got = pairs(actual)
  expect(got).toHaveLength(expected.length)
  got.forEach(([s, e], i) => {
    expect(Math.abs(s - expected[i][0])).toBeLessThanOrEqual(tol)
    expect(Math.abs(e - expected[i][1])).toBeLessThanOrEqual(tol)
  })
}

const seg = (id: string, start: number, end: number, words?: [number, number][]): CaptionSegment => ({
  id,
  start,
  end,
  text: 'words',
  ...(words ? { words: words.map(([s, e]) => ({ text: 'w', start: s, end: e })) } : {})
})

/** The levels fixture of the design (section 8): speech, word gaps and keyboard ticks. */
const fixture = levels(60, [...talk(0.5, 7.8), ...talk(52, 59.5), ...ticks(20, 23)])
const typing = track({ typing: [{ t: 20, end: 23 }] })
/** The PC plays music over 0-15 s while the person talks over 2-8 s; silence after. */
const music = levels(30, [[0, 15, 1e-4], ...talk(2, 8)])

describe('speechFromLevels', () => {
  it('finds the talking, joins word gaps and removes keyboard ticks', () => {
    expectRanges(speechFromLevels(fixture, typing), [
      [0.5, 7.8],
      [52, 59.5]
    ])
  })

  it('keeps the ticks as sound without input data (the hook was off)', () => {
    const heard = speechFromLevels(fixture, null)
    expect(heard).toHaveLength(3)
    expect(heard[1].start).toBeCloseTo(20, 1)
    // An invalid track says nothing about the keyboard either.
    expect(speechFromLevels(fixture, track({ valid: false, typing: [{ t: 20, end: 23 }] }))).toHaveLength(3)
  })

  it('removes click and key noise, padded around each event', () => {
    const lv = levels(20, [...talk(1, 6), [10, 10.2, 1e-3], [14, 14.25, 1e-3]])
    // Too short for speech on their own anyway: lengthen them past minUtterance with neighbours.
    const clicks = levels(20, [...talk(1, 6), [10, 10.7, 1e-3], [14, 14.7, 1e-3]])
    expect(speechFromLevels(lv, null)).toHaveLength(1)
    expect(speechFromLevels(clicks, null)).toHaveLength(3)
    const input = track({
      clicks: [
        { t: 10.15, x: 0.5, y: 0.5, button: 'left' },
        { t: 10.45, x: 0.5, y: 0.5, button: 'left' }
      ],
      keys: [
        { t: 14.15, label: 'Ctrl+C' },
        { t: 14.45, label: 'Ctrl+V' }
      ]
    })
    expectRanges(speechFromLevels(clicks, input), [[1, 6]])
  })

  it('keeps speech that only partly overlaps typing', () => {
    const lv = levels(30, [...talk(10, 16)])
    expectRanges(speechFromLevels(lv, track({ typing: [{ t: 14, end: 20 }] })), [[10, 15.7]])
  })

  it('drops an isolated blip shorter than 0.6 s', () => {
    const lv = levels(30, [...talk(1, 6), [15, 15.4, 1e-3]])
    expectRanges(speechFromLevels(lv, null), [[1, 6]])
    expect(SPEECH.minUtterance).toBe(0.6)
  })

  it('joins pauses under 1.0 s and keeps longer ones', () => {
    const lv = levels(30, [
      [1, 3, 1e-3],
      [3.9, 6, 1e-3],
      [7.2, 9, 1e-3]
    ])
    expectRanges(speechFromLevels(lv, null), [
      [1, 6],
      [7.2, 9]
    ])
  })

  it('finds nothing in silence or digital silence', () => {
    expect(speechFromLevels(levels(30, []), typing)).toEqual([])
    expect(speechFromLevels(levels(30, [], 0), typing)).toEqual([])
    expect(speechFromLevels({ window: WINDOW, power: new Float32Array(0) }, null)).toEqual([])
  })

  it('hears music the PC plays on the mixed track as sound', () => {
    // Music at -40 dB over the first half with a voice on top: the level alone cannot tell them apart.
    expectRanges(speechFromLevels(music, null), [[0, 15]])
  })

  it('treats music over the whole recording as the noise floor', () => {
    // A constant bed raises the threshold to its ceiling (-32 dB): the louder voice still shows.
    const bed = levels(30, [[0, 30, 1e-4], ...talk(2, 8)])
    expectRanges(speechFromLevels(bed, null), [[2, 7.7]])
  })
})

describe('transcriptSpeech', () => {
  it('uses the words when present, joined across 0.3 s', () => {
    const t = { segments: [seg('a', 1, 5, [[1, 1.5], [1.7, 2.2], [3, 3.4]]), seg('b', 10, 12)] }
    expectRanges(transcriptSpeech(t), [
      [1, 2.2],
      [3, 3.4],
      [10, 12]
    ], 1e-9)
  })

  it('counts a caption whole when it has no word timings', () => {
    expectRanges(transcriptSpeech({ segments: [seg('a', 2, 4), seg('b', 4.2, 6)] }), [[2, 6]], 1e-9)
  })

  it('is null without a transcript or captions', () => {
    expect(transcriptSpeech(undefined)).toBeNull()
    expect(transcriptSpeech({ segments: [] })).toBeNull()
  })
})

describe('refineSpeech', () => {
  const heard = speechFromLevels(fixture, typing)
  const words = { segments: [seg('a', 0.5, 7.8, [[0.6, 2.1], [2.5, 4], [4.6, 6], [6.4, 7.7]])] }

  it('gates the mixed track with the transcript', () => {
    const s = refineSpeech({ source: 'mix', ranges: heard }, words)
    expect(s?.source).toBe('mix')
    expect(s?.refined).toBe(true)
    expectRanges(s?.ranges, [[0.5, 7.8]])
  })

  it('removes music on the mixed track that no word explains', () => {
    const heardMusic = speechFromLevels(music, null)
    const s = refineSpeech({ source: 'mix', ranges: heardMusic }, { segments: [seg('a', 2, 7.7, [[2.1, 3.6], [4.1, 5.6], [6.1, 7.6]])] })
    expectRanges(s?.ranges, [[1.6, 8.1]], 1e-6)
    expect(s?.refined).toBe(true)
  })

  it('trusts the microphone stem as it is', () => {
    const s = refineSpeech({ source: 'mic', ranges: heard }, words)
    expect(s).toEqual({ source: 'mic', refined: false, ranges: heard })
  })

  it('uses the mixed track as it is without a transcript', () => {
    expect(refineSpeech({ source: 'mix', ranges: heard }, undefined)).toEqual({ source: 'mix', refined: false, ranges: heard })
    expect(refineSpeech({ source: 'mix', ranges: heard }, { segments: [] })?.refined).toBe(false)
  })

  it('falls back to the transcript alone, joined across 1.0 s', () => {
    const s = refineSpeech(null, { segments: [seg('a', 1, 3), seg('b', 3.8, 5), seg('c', 9, 10)] })
    expect(s?.source).toBe('transcript')
    expect(s?.refined).toBe(false)
    expectRanges(s?.ranges, [
      [1, 5],
      [9, 10]
    ], 1e-9)
  })

  it('is null when neither is known', () => {
    expect(refineSpeech(null, undefined)).toBeNull()
    expect(refineSpeech(null, { segments: [] })).toBeNull()
  })

  it('keeps an empty measurement (silence only) as no talking, not as unknown', () => {
    expect(refineSpeech({ source: 'mic', ranges: [] }, undefined)).toEqual({ source: 'mic', refined: false, ranges: [] })
  })
})

describe('speechLevelSource', () => {
  it('listens to the microphone stem when the recording kept one', () => {
    expect(speechLevelSource({ hasAudio: true, audioStems: { mic: true, system: true } })).toBe('mic')
    expect(speechLevelSource({ hasAudio: true, audioStems: { mic: true, system: false } })).toBe('mic')
  })

  it('listens to the mixed track when there is sound but the recording kept no stems', () => {
    expect(speechLevelSource({ hasAudio: true })).toBe('mix')
    expect(speechLevelSource({ hasAudio: true, audioStems: { mic: false, system: false } })).toBe('mix')
  })

  it('has nothing to listen to when the stems hold no microphone: the mixed track is PC sound only', () => {
    expect(speechLevelSource({ hasAudio: true, audioStems: { mic: false, system: true } })).toBeNull()
  })

  it('has nothing to listen to without sound', () => {
    expect(speechLevelSource({ hasAudio: false })).toBeNull()
    expect(speechLevelSource({ hasAudio: false, audioStems: { mic: true, system: false } })).toBeNull()
  })
})

describe('speechFromLevels with the speech detector (offline-captions §3.6)', () => {
  const withSpeech = (base: AudioLevels, speech: [number, number][]): AudioLevels => ({ ...base, speech: speech.map(([start, end]) => ({ start, end })) })

  it('uses the speech ranges: typing under the talking does not remove it', () => {
    // Talking from 20 to 23 s while typing: the level path drops it as keyboard noise.
    const lv = withSpeech(fixture, [
      [0.5, 7.8],
      [20.1, 22.9],
      [52, 59.5]
    ])
    expectRanges(speechFromLevels(lv, typing), [
      [0.5, 7.8],
      [20.1, 22.9],
      [52, 59.5]
    ])
    expectRanges(speechFromLevels(fixture, typing), [
      [0.5, 7.8],
      [52, 59.5]
    ])
  })

  it('joins across 1.0 s and drops utterances under 0.6 s', () => {
    const lv = withSpeech(levels(30, []), [
      [1, 2],
      [2.9, 4],
      [6, 6.5],
      [10, 11],
      [12.2, 13]
    ])
    expectRanges(speechFromLevels(lv, null), [
      [1, 4],
      [10, 11],
      [12.2, 13]
    ])
  })

  it('no speech heard means no talking, whatever the level (no trust guard for the director)', () => {
    expect(speechFromLevels(withSpeech(fixture, []), null)).toEqual([])
  })

  it('without speech the output equals the level path exactly (literals)', () => {
    expectRanges(speechFromLevels(fixture, typing), [
      [0.5, 7.8],
      [52, 59.5]
    ])
    expect(speechFromLevels({ ...fixture }, typing)).toEqual(speechFromLevels(fixture, typing))
  })

  it('refineSpeech names the detector, and leaves it out for the transcript alone', () => {
    expect(refineSpeech({ source: 'mic', ranges: [{ start: 1, end: 2 }], detector: 'speech' }, undefined)).toEqual({
      ranges: [{ start: 1, end: 2 }],
      source: 'mic',
      refined: false,
      detector: 'speech'
    })
    expect(refineSpeech({ source: 'mix', ranges: [{ start: 1, end: 2 }], detector: 'level' }, undefined)?.detector).toBe('level')
    expect(refineSpeech({ source: 'mix', ranges: [{ start: 1, end: 2 }] }, undefined)).toEqual({ ranges: [{ start: 1, end: 2 }], source: 'mix', refined: false })
    expect(refineSpeech(null, { segments: [seg('a', 1, 2)] })?.detector).toBeUndefined()
  })
})

describe('the director status line with the speech detector', async () => {
  const { sourceLine, sourceState } = await import('../src/shared/editor/directorCopy')
  it('the mixed track through the speech detector has its own line; the microphone line stays', () => {
    expect(sourceState({ ranges: [], source: 'mix', refined: false, detector: 'speech' }, false)).toBe('mix-voice')
    expect(sourceLine('mix-voice')).toBe("Listening for voices in the recording's sound (no separate microphone): voices from your PC count as talking.")
    expect(sourceState({ ranges: [], source: 'mix', refined: false, detector: 'level' }, false)).toBe('mix')
    expect(sourceState({ ranges: [], source: 'mix', refined: false }, false)).toBe('mix')
    expect(sourceState({ ranges: [], source: 'mic', refined: false, detector: 'speech' }, false)).toBe('mic')
    expect(sourceLine('mic')).toBe('Listening to your microphone.')
  })
})
