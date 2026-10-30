// Listening to one source (docs/design/sound-finder.md §4.2): windows, skipping, bytes, chunking.
import { describe, expect, it } from 'vitest'
import { SCAN, SCORE_COLUMNS, SOUND_KINDS, SPEECH_CLASSES } from '../src/shared/audio/sounds'
import { kindBytes, quietWindow, skipKey, SoundScanner, speechCover } from '../src/shared/audio/soundsScan'

const RATE = SCAN.rate
const COLS = SCORE_COLUMNS.length

/** `seconds` of a 440 Hz tone at `amp`. */
const tone = (seconds: number, amp = 0.3): Float32Array => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / RATE))

/** A classifier that scores the window's first sample's amplitude as a ding, and records what it saw. */
function fakeClassifier(): { classify: (w: Float32Array) => Float32Array; seen: number[] } {
  const seen: number[] = []
  return {
    seen,
    classify: (w) => {
      seen.push(w.length)
      const s = new Float32Array(521)
      let peak = 0
      for (const v of w) peak = Math.max(peak, Math.abs(v))
      s[477] = Math.min(1, peak * 2) // Ding
      s[0] = 0.1 // Speech
      return s
    }
  }
}

describe('kindBytes', () => {
  it('keeps the highest class of each column as a byte, speech first', () => {
    const s = new Float32Array(521)
    s[42] = 0.2
    s[43] = 0.6 // Throat clearing beats Cough
    s[132] = 1.4 // clipped to 1
    s[SPEECH_CLASSES[2]] = 0.5
    const b = kindBytes(s)
    expect(b.length).toBe(COLS)
    expect(b[0]).toBe(Math.round(0.5 * 255))
    expect(b[1 + Object.keys(SOUND_KINDS).indexOf('cough')]).toBe(Math.round(0.6 * 255))
    expect(b[1 + Object.keys(SOUND_KINDS).indexOf('music')]).toBe(255)
    expect(b[1 + Object.keys(SOUND_KINDS).indexOf('dog')]).toBe(0)
  })
})

describe('quietWindow and speechCover', () => {
  it('calls a window quiet only when its loudest 20 ms is below -50 dBFS', () => {
    expect(quietWindow(new Float32Array(SCAN.window))).toBe(true)
    expect(quietWindow(tone(0.975, 10 ** (-56 / 20)))).toBe(true)
    const w = new Float32Array(SCAN.window)
    // A 20 ms click at -40 dBFS RMS in silence.
    for (let i = 8000; i < 8320; i++) w[i] = 10 ** (-40 / 20) * Math.SQRT2 * Math.sin(i)
    expect(quietWindow(w)).toBe(false)
  })

  it('measures how much of a stretch is inside the ranges', () => {
    const r = [{ start: 0, end: 1 }, { start: 2, end: 3 }]
    expect(speechCover(r, 0.5, 2.5)).toBeCloseTo(0.5)
    expect(speechCover(r, 3, 4)).toBe(0)
    expect(speechCover(r, 2, 3)).toBe(1)
  })

  it('keys the skipped speech to the millisecond', () => {
    expect(skipKey(null)).toBe('none')
    expect(skipKey([])).toBe('none')
    const a = skipKey([{ start: 1, end: 2 }])
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(skipKey([{ start: 1.0001, end: 2 }])).toBe(a)
    expect(skipKey([{ start: 1.002, end: 2 }])).not.toBe(a)
  })
})

describe('SoundScanner', () => {
  it('classifies a window every half window, padding the last one', () => {
    const f = fakeClassifier()
    const s = new SoundScanner(f.classify)
    s.push(tone(3))
    const r = s.finish()
    // 3 s = 48000 samples: whole windows start at 0, 7800, ..., 31200 (the 5th ends at 46800); the 1200
    // samples after it are fewer than SCAN.minTail, so no padded window.
    expect(r.n).toBe(5)
    expect(f.seen.every((n) => n === SCAN.window)).toBe(true)
    expect(r.scores.length).toBe(5 * COLS)
    const longer = new SoundScanner(fakeClassifier().classify)
    longer.push(tone(3.5))
    // 3.5 s = 56000: a 6th whole window (39000..54600), 1400 samples after it: none padded.
    // 3.75 s = 60000: 5400 samples after the 6th: a 7th, padded, from 46800.
    expect(longer.finish().n).toBe(6)
    const padded = new SoundScanner(fakeClassifier().classify)
    padded.push(tone(3.75))
    expect(padded.finish().n).toBe(7)
    const ding = 1 + Object.keys(SOUND_KINDS).indexOf('ping')
    expect(r.scores[ding]).toBe(Math.round(0.6 * 255))
    expect(s.seconds).toBe(3)
  })

  it('gives the same scores however the sound is chunked', () => {
    const sound = Float32Array.from({ length: RATE * 7 }, (_, i) => (i % 16000 < 3000 ? 0.4 : 0.01) * Math.sin(i / 3))
    const whole = new SoundScanner(fakeClassifier().classify)
    whole.push(sound)
    const a = whole.finish()
    const chunked = new SoundScanner(fakeClassifier().classify)
    for (let i = 0; i < sound.length; i += 1234) chunked.push(sound.subarray(i, i + 1234))
    const b = chunked.finish()
    expect(b.n).toBe(a.n)
    expect([...b.scores]).toEqual([...a.scores])
    // A chunk much larger than the buffer too.
    const big = new SoundScanner(fakeClassifier().classify)
    big.push(sound.subarray(0, 100))
    big.push(sound.subarray(100))
    expect([...big.finish().scores]).toEqual([...a.scores])
  })

  it('skips quiet windows and windows inside speech, and leaves their scores at zero', () => {
    const f = fakeClassifier()
    const sound = new Float32Array(RATE * 6)
    sound.set(tone(2), RATE * 2) // sound from 2 s to 4 s, silence around it
    const s = new SoundScanner(f.classify, [{ start: 2, end: 3.5 }])
    s.push(sound)
    const r = s.finish()
    expect(s.stats.windows).toBe(r.n)
    expect(s.stats.quiet).toBeGreaterThan(0)
    expect(s.stats.speech).toBeGreaterThan(0)
    expect(s.stats.classified).toBe(f.seen.length)
    expect(s.stats.quiet + s.stats.speech + s.stats.classified).toBe(r.n)
    for (let i = 0; i < r.n; i++) {
      const start = (i * SCAN.hop) / RATE
      const inSpeech = start >= 2 && start + 0.975 <= 3.5 + 0.0975 * 0
      if (inSpeech) expect([...r.scores.subarray(i * COLS, (i + 1) * COLS)].every((v) => v === 0)).toBe(true)
    }
    // Without the speech, those windows are classified.
    const all = new SoundScanner(fakeClassifier().classify)
    all.push(sound)
    all.finish()
    expect(all.stats.classified).toBe(s.stats.classified + s.stats.speech)
  })

  it('drops a tail shorter than a quarter second', () => {
    const s = new SoundScanner(fakeClassifier().classify)
    s.push(tone(0.975 + 0.2))
    expect(s.finish().n).toBe(1)
    const t = new SoundScanner(fakeClassifier().classify)
    t.push(tone(0.1))
    expect(t.finish().n).toBe(0)
  })
})
