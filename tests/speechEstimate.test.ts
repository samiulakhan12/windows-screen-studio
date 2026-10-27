import { describe, expect, it } from 'vitest'
import { speechModel, type SpeechModelId } from '../src/shared/speech/catalog'
import { durationWords, estimateSeconds, nextTimeLeft, sizeWords, TIME_LEFT } from '../src/shared/speech/estimate'

/* The words the Captions tab and Settings use for times and sizes (docs/design/offline-captions.md §3.3, §7). */

const words = (id: SpeechModelId, seconds: number): string => durationWords(estimateSeconds(speechModel(id)!, seconds, 3, null, 'standard'))

describe('durationWords on the §3.3 table (4-core PC, 3 threads)', () => {
  it('a 20-minute recording', () => {
    expect(words('whisper-tiny', 1200)).toBe('about 1½ min')
    expect(words('whisper-base', 1200)).toBe('about 3 min')
    expect(words('whisper-small', 1200)).toBe('about 10 min')
    expect(words('whisper-turbo', 1200)).toBe('about 38 min')
  })

  it('a 60-minute recording', () => {
    expect(words('whisper-tiny', 3600)).toBe('about 5 min')
    expect(words('whisper-base', 3600)).toBe('about 8 min')
    expect(words('whisper-small', 3600)).toBe('about 30 min')
    expect(words('whisper-turbo', 3600)).toBe('about 1 h 53 min')
  })

  // §3.3 says "about 11 min" for Standard (11.2 min, rounded to the nearest); durationWords rounds up, as the table does.
  it('the compatible build is 4.3 times slower (Standard on 20 minutes 11.2 min, Accurate 41.6 min)', () => {
    expect(durationWords(estimateSeconds(speechModel('whisper-base')!, 1200, 3, null, 'compatible'))).toBe('about 12 min')
    expect(durationWords(estimateSeconds(speechModel('whisper-small')!, 1200, 3, null, 'compatible'))).toBe('about 42 min')
  })
})

describe('durationWords rounding', () => {
  it('under a minute', () => {
    expect(durationWords(0)).toBe('under 1 min')
    expect(durationWords(59.9)).toBe('under 1 min')
    expect(durationWords(Number.NaN)).toBe('under 1 min')
  })

  it('half minutes, rounded up, up to 3 min', () => {
    expect(durationWords(60)).toBe('about 1 min')
    expect(durationWords(61)).toBe('about 1½ min')
    expect(durationWords(90)).toBe('about 1½ min')
    expect(durationWords(91)).toBe('about 2 min')
    expect(durationWords(150)).toBe('about 2½ min')
    expect(durationWords(180)).toBe('about 3 min')
  })

  it('whole minutes, rounded up, then hours', () => {
    expect(durationWords(181)).toBe('about 4 min')
    expect(durationWords(59 * 60)).toBe('about 59 min')
    expect(durationWords(59 * 60 + 1)).toBe('about 1 h')
    expect(durationWords(70 * 60)).toBe('about 1 h 10 min')
    expect(durationWords(120 * 60)).toBe('about 2 h')
  })
})

describe('sizeWords', () => {
  it('decimal megabytes, whole', () => {
    expect(sizeWords(43_537_433)).toBe('44 MB')
    expect(sizeWords(59_707_625)).toBe('60 MB')
    expect(sizeWords(190_085_487)).toBe('190 MB')
    expect(sizeWords(574_041_195)).toBe('574 MB')
    expect(sizeWords(0)).toBe('0 MB')
    expect(sizeWords(-5)).toBe('0 MB')
  })

  it('gigabytes with one decimal, whole from 10 GB', () => {
    expect(sizeWords(999_400_000)).toBe('999 MB')
    expect(sizeWords(999_600_000)).toBe('1.0 GB')
    expect(sizeWords(1_160_000_000)).toBe('1.2 GB')
    expect(sizeWords(64_300_000_000)).toBe('64 GB')
  })
})

describe('nextTimeLeft', () => {
  it('is null before 10 % is done and before 15 s have passed', () => {
    expect(nextTimeLeft(null, 5, 0.05)).toBeNull()
    expect(nextTimeLeft(null, 14.9, 0.099)).toBeNull()
    expect(nextTimeLeft(null, 30, 0)).toBeNull()
    expect(nextTimeLeft(null, Number.NaN, 0.5)).toBeNull()
  })

  it('shows once 10 % is done or 15 s have passed', () => {
    expect(nextTimeLeft(null, 5, 0.1)).toBeCloseTo(45, 6)
    expect(nextTimeLeft(null, 15, 0.05)).toBeCloseTo(285, 6)
  })

  it('blends the new figure with the previous one', () => {
    // raw = 60 × 0.5 / 0.5 = 60; from 120: 120 + (60 − 120) × 0.3 = 102.
    expect(nextTimeLeft(120, 60, 0.5)).toBeCloseTo(120 + (60 - 120) * TIME_LEFT.smoothing, 6)
  })

  it('never rises by less than 30 s (no jitter), but shows a real slowdown', () => {
    // raw 150 from 100: +15 s, a jitter: stays at 100.
    expect(nextTimeLeft(100, 150, 0.5)).toBe(100)
    // raw 300 from 100: +60 s.
    expect(nextTimeLeft(100, 300, 0.5)).toBeCloseTo(160, 6)
  })

  it('reaches 0 at the end', () => {
    expect(nextTimeLeft(null, 100, 1)).toBe(0)
    expect(nextTimeLeft(10, 100, 1)).toBeCloseTo(7, 6)
  })
})
