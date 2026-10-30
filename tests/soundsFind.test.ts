// From scores to rows (docs/design/sound-finder.md §4.3).
import { describe, expect, it } from 'vitest'
import type { AudioLevels } from '../src/shared/audio/loudness'
import { FIND, findSounds, fitToLevels, HOP_SECONDS, scanSources, SCORE_COLUMNS, soundKey, SOUND_KIND_ORDER, subtractRanges, voiceSource, WINDOW_SECONDS, type SoundKind, type SourceScores } from '../src/shared/audio/sounds'
import type { AudioSource } from '../src/shared/audio/settings'

const COLS = SCORE_COLUMNS.length
const col = (k: SoundKind | 'speech'): number => (k === 'speech' ? 0 : 1 + SOUND_KIND_ORDER.indexOf(k))

/** Scores of `seconds` of a source with `marks`: [kind, first window, last window, score 0..1]. */
function scores(source: AudioSource, seconds: number, marks: [SoundKind | 'speech', number, number, number][]): SourceScores {
  const n = Math.floor((seconds - WINDOW_SECONDS) / HOP_SECONDS) + 1
  const s = new Uint8Array(n * COLS)
  for (const [k, a, b, v] of marks) for (let i = a; i <= b; i++) s[i * COLS + col(k)] = Math.round(v * 255)
  return { source, n, scores: s }
}

const at = (w: number): number => w * HOP_SECONDS

/** Levels: silence (−80 dB) with `loud` ranges at −20 dB. */
function levels(seconds: number, loud: [number, number][]): AudioLevels {
  const n = Math.round(seconds / 0.05)
  const power = new Float32Array(n).fill(1e-8)
  for (const [a, b] of loud) for (let i = Math.round(a / 0.05); i < Math.round(b / 0.05); i++) power[i] = 1e-2
  return { window: 0.05, power }
}

describe('findSounds', () => {
  it('lists a kind where its windows reach the threshold, joined, by time, with stable keys', () => {
    const rows = findSounds({ sources: [scores('system', 30, [['ping', 10, 11, 0.8], ['dog', 30, 30, 0.34], ['dog', 40, 40, 0.5]])], speech: [] })
    expect(rows.map((r) => r.kind)).toEqual(['ping', 'dog'])
    expect(rows[0].start).toBeCloseTo(at(10), 4)
    expect(rows[0].end).toBeCloseTo(at(11) + WINDOW_SECONDS, 4)
    expect(rows[0].score).toBeCloseTo(0.8, 2)
    expect(rows[0].key).toBe(soundKey('ping', at(10)))
    expect(rows[0].key).toMatch(/^ping-\d+$/)
    expect(rows[1].start).toBeCloseTo(at(40), 4)
    // The same input, the same rows.
    expect(findSounds({ sources: [scores('system', 30, [['ping', 10, 11, 0.8], ['dog', 30, 30, 0.34], ['dog', 40, 40, 0.5]])], speech: [] })).toEqual(rows)
  })

  it('never lists a window whose speech score is as high', () => {
    const rows = findSounds({ sources: [scores('mic', 20, [['cough', 5, 5, 0.6], ['speech', 5, 5, 0.6], ['cough', 20, 20, 0.6], ['speech', 20, 20, 0.4]])], speech: [] })
    expect(rows.map((r) => r.start)).toEqual([+at(20).toFixed(4)])
  })

  it('joins windows less than half a second apart, and not further', () => {
    // Windows 2 and 5: the gap between the end of 2 (0.975 + 0.975) and the start of 5 is 0.49 s.
    const near = findSounds({ sources: [scores('mic', 20, [['typing', 2, 2, 0.5], ['typing', 5, 5, 0.5]])], speech: [] })
    expect(near).toHaveLength(1)
    const far = findSounds({ sources: [scores('mic', 20, [['typing', 2, 2, 0.5], ['typing', 6, 6, 0.5]])], speech: [] })
    expect(far).toHaveLength(2)
  })

  it('fits a short sound to its levels, but not music', () => {
    const lv = levels(30, [[10.2, 10.5], [20, 26]])
    const [cough] = findSounds({ sources: [scores('mic', 30, [['cough', 20, 21, 0.7]])], speech: [], levels: { mic: lv } })
    expect(cough.start).toBeCloseTo(10.15, 4)
    expect(cough.end).toBeCloseTo(10.55, 4)
    const [music] = findSounds({ sources: [scores('mic', 30, [['music', 40, 50, 0.9]])], speech: [], levels: { mic: lv } })
    expect(music.start).toBeCloseTo(at(40), 4)
    expect(fitToLevels(1, 2, undefined)).toEqual({ start: 1, end: 2 })
    expect(fitToLevels(1, 2, levels(5, []))).toEqual({ start: 1, end: 2 }) // all equally quiet: the loudest is everywhere
  })

  it('keys a row by its windows, not by its fitted bounds, and fits each piece left by speech on its own', () => {
    const input = { sources: [scores('mic', 30, [['cough', 20, 21, 0.7]])], speech: [] }
    const plain = findSounds(input)
    const fitted = findSounds({ ...input, levels: { mic: levels(30, [[10.2, 10.5]]) } })
    expect(fitted[0].key).toBe(plain[0].key)
    expect(fitted[0].start).not.toBe(plain[0].start)
    // Loud speech before the sound does not set the level it is fitted to: the piece after speech is.
    const lv = levels(30, [[9.75, 10.3]])
    for (let i = Math.round(10.6 / 0.05); i < Math.round(10.8 / 0.05); i++) lv.power[i] = 1e-4
    const [after] = findSounds({ sources: [scores('mic', 30, [['cough', 20, 21, 0.7]])], speech: [{ start: 9.75, end: 10.3 }], levels: { mic: lv } })
    expect(after.start).toBeCloseTo(10.55, 4)
    expect(after.end).toBeCloseTo(10.85, 4)
    expect(after.key).toBe(soundKey('cough', 10.4))
  })

  it('takes speech out: a cough inside speech goes, music between sentences stays where it is long enough', () => {
    const speech = [{ start: 9, end: 12 }, { start: 20, end: 30 }, { start: 34, end: 50 }]
    const rows = findSounds({ sources: [scores('mic', 60, [['cough', 20, 21, 0.9], ['music', 26, 80, 0.9]])], speech })
    // The cough (9.75–11.2) lies inside speech; music 12.675–39.975 keeps 12.675–19.9 (7.2 s) and 30.1–33.9 (3.8 s).
    expect(rows.every((r) => r.kind === 'music')).toBe(true)
    expect(rows.map((r) => [+r.start.toFixed(2), +r.end.toFixed(2)])).toEqual([
      [12.68, 19.9],
      [30.1, 33.9]
    ])
    // Without the detector, YAMNet's own speech score guards.
    const own = findSounds({ sources: [scores('mic', 30, [['cough', 10, 10, 0.9], ['speech', 9, 12, 0.6], ['dog', 9, 9, 0.9]])], speech: null })
    expect(own).toEqual([])
  })

  it('drops what speech leaves too short for its kind', () => {
    expect(findSounds({ sources: [scores('mic', 30, [['music', 10, 20, 0.9]])], speech: [{ start: 6, end: 9.5 }] })).toEqual([])
  })

  it('joins the same kind heard on both sources into one row', () => {
    const rows = findSounds({ sources: [scores('mic', 20, [['dog', 4, 5, 0.5]]), scores('system', 20, [['dog', 5, 6, 0.9], ['ping', 5, 5, 0.9]])], speech: [] })
    expect(rows.map((r) => r.kind)).toEqual(['dog', 'ping'])
    expect(rows[0].start).toBeCloseTo(at(4), 4)
    expect(rows[0].end).toBeCloseTo(at(6) + WINDOW_SECONDS, 4)
    expect(rows[0].score).toBeCloseTo(0.9, 2)
    expect(rows[0].source).toBe('mic')
  })

  it('gives every row its own key, also when the two sources fit the same windows apart', () => {
    const mic = levels(30, [[2.0, 2.1]])
    const system = levels(30, [[2.6, 2.7]])
    const rows = findSounds({ sources: [scores('mic', 30, [['ping', 4, 4, 0.6]]), scores('system', 30, [['ping', 4, 4, 0.9]])], speech: [], levels: { mic, system } })
    expect(rows).toHaveLength(1)
    expect(rows[0].start).toBeCloseTo(1.95, 4)
    expect(rows[0].end).toBeCloseTo(2.75, 4)
    expect(rows[0].score).toBeCloseTo(0.9, 2)
  })

  it('keeps the strongest rows when there are too many, and stays fast on an hour', () => {
    const marks: [SoundKind, number, number, number][] = []
    for (let w = 0; w < 7000; w += 4) marks.push(['typing', w, w, 0.4 + (w % 7) / 20])
    const t0 = performance.now()
    const rows = findSounds({ sources: [scores('mic', 3600, marks), scores('system', 3600, [])], speech: [{ start: 100, end: 200 }] })
    expect(performance.now() - t0).toBeLessThan(500)
    expect(rows).toHaveLength(FIND.maxRows)
    expect(rows.every((r) => r.score >= 0.6)).toBe(true)
    for (let i = 1; i < rows.length; i++) expect(rows[i].start).toBeGreaterThanOrEqual(rows[i - 1].start)
  })
})

describe('helpers', () => {
  it('subtracts ranges', () => {
    expect(subtractRanges({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 5, end: 12 }])).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 }
    ])
    expect(subtractRanges({ start: 4, end: 5 }, [{ start: 0, end: 10 }])).toEqual([])
    expect(subtractRanges({ start: 4, end: 5 }, [])).toEqual([{ start: 4, end: 5 }])
  })

  it('listens to the stems, else the mixed track, and not without sound', () => {
    expect(scanSources({ hasAudio: true, audioStems: { mic: true, system: true } })).toEqual(['mic', 'system'])
    expect(scanSources({ hasAudio: true })).toEqual(['mix'])
    expect(scanSources({ hasAudio: false, audioStems: { mic: true, system: true } })).toEqual([])
    expect(voiceSource({ hasAudio: true, audioStems: { mic: true, system: true } })).toBe('mic')
    expect(voiceSource({ hasAudio: true, audioStems: { mic: false, system: true } })).toBe('mix')
  })
})
