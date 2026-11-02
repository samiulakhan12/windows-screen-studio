/**
 * Captions Studio test 38 (docs/design/captions-studio.md §11.4): numbers for counters, statistics
 * only, Bengali digits and spelled-out numbers.
 */
import { describe, expect, it } from 'vitest'
import { findNumbers, parseNumberWords } from '../src/shared/captions/numbers'
import type { CaptionSegment } from '../src/shared/types'

const seg = (text: string): CaptionSegment => ({ id: 'c1', start: 0, end: 3, text })
const stats = (text: string, language = 'en') => findNumbers(seg(text), language).filter((n) => n.statistic)

describe('findNumbers (test 38)', () => {
  it('reads percentages, money and magnitudes as statistics', () => {
    const [p] = stats('Sales grew 300% this year')
    expect(p).toMatchObject({ value: 300, suffix: '%', prefix: '', decimals: 0, statistic: true })
    const [m] = stats('We raised $1.2M in the first round')
    expect(m).toMatchObject({ value: 1.2, prefix: '$', suffix: 'M', decimals: 1 })
    const [k] = stats('It has 50k downloads')
    expect(k).toMatchObject({ value: 50, suffix: 'k', label: 'downloads' })
    const [t] = stats('It is 3x faster now')
    expect(t).toMatchObject({ value: 3, suffix: '×' })
    const [w] = stats('Over 2 million people use it')
    expect(w).toMatchObject({ value: 2, suffix: ' million', label: 'people' })
  })

  it('"grew 300 percent" and "$1.2M" are statistics', () => {
    const [p] = stats('Revenue grew 300 percent')
    expect(p).toMatchObject({ value: 300, suffix: '%', from: 2, to: 3 })
    expect(stats('$1.2M')).toHaveLength(1)
  })

  it('gives no counter for instructions: pixels, plain counts and seconds', () => {
    expect(stats('set the width to 300 pixels')).toEqual([])
    expect(stats('there are 12 options')).toEqual([])
    expect(stats('wait 30 seconds')).toEqual([])
    // Found, but not statistics.
    expect(findNumbers(seg('there are 12 options'), 'en')).toMatchObject([{ value: 12, statistic: false, label: 'options' }])
  })

  it('leaves out labels, years, versions, times, phone numbers and small numbers', () => {
    expect(stats('Open step 2 in 2024')).toEqual([])
    expect(stats('Version 2 grew a lot')).toEqual([])
    expect(stats('Meet at 10:30 today')).toEqual([])
    expect(stats('Call 555-123-4567 now')).toEqual([])
    expect(stats('We grew to 5 people')).toEqual([])
    expect(findNumbers(seg('Update to 2.0.1 today'), 'en')).toEqual([])
  })

  it('a stated change makes a plain number a statistic, and "up by" counts the change', () => {
    expect(stats('Signups increased 45 this week')).toMatchObject([{ value: 45 }])
    const [up] = stats('Usage is up by 40%')
    expect(up).toMatchObject({ value: 40, suffix: '%' })
    expect(up.start).toBeUndefined()
  })

  it('"from 20 to 80" counts from 20', () => {
    const [r] = stats('Our score went from 20 to 80 points')
    expect(r).toMatchObject({ value: 80, start: 20, from: 4, to: 6 })
    expect(stats('Change the margin from 20 to 80 pixels')).toEqual([])
  })

  it('reads Bengali digits and Bangla units', () => {
    const [b] = stats('বিক্রি ৩০০ শতাংশ বেড়েছে', 'bn')
    expect(b).toMatchObject({ value: 300, suffix: '%', from: 1, to: 2 })
    const [t] = stats('আয় ৫০ লাখ টাকা হয়েছে', 'bn')
    expect(t).toMatchObject({ value: 50, suffix: ' লাখ টাকা' })
  })

  it('reads grouping in each language', () => {
    expect(stats('We saved $12,500 last year')).toMatchObject([{ value: 12500, prefix: '$' }])
    expect(stats('Wir haben 1.250,5 € gespart', 'de')).toMatchObject([{ value: 1250.5, decimals: 1, suffix: ' €' }])
    expect(stats('Il a 1 000 000 € gagné', 'fr')).toMatchObject([{ value: 1_000_000, suffix: ' €' }])
  })

  it('reads spelled-out numbers with a sign of a statistic', () => {
    expect(stats('Revenue grew twenty five percent')).toMatchObject([{ value: 25, suffix: '%', from: 2, to: 4 }])
    expect(stats('It costs three hundred dollars')).toMatchObject([{ value: 300, suffix: ' dollars' }])
    expect(stats('বিক্রি তিনশো শতাংশ বেড়েছে', 'bn')).toMatchObject([{ value: 300, suffix: '%' }])
  })
})

describe('parseNumberWords (test 38)', () => {
  it('reads English', () => {
    expect(parseNumberWords(['twenty', 'five', 'users'])).toEqual({ value: 25, used: 2 })
    expect(parseNumberWords(['twenty-five'])).toEqual({ value: 25, used: 1 })
    expect(parseNumberWords(['one', 'hundred', 'and', 'five'])).toEqual({ value: 105, used: 4 })
    expect(parseNumberWords(['a', 'thousand', 'people'])).toEqual({ value: 1000, used: 2 })
    expect(parseNumberWords(['three', 'million'])).toEqual({ value: 3_000_000, used: 2 })
    expect(parseNumberWords(['two', 'thousand', 'and', 'twenty'])).toEqual({ value: 2020, used: 4 })
    expect(parseNumberWords(['hello'])).toBeNull()
    expect(parseNumberWords(['and', 'one'])).toBeNull()
  })

  it('stops at the end of a clause', () => {
    expect(parseNumberWords(['five.', 'six'])).toEqual({ value: 5, used: 1 })
  })

  it('reads no number from a word every object has a name for ("constructor")', () => {
    expect(parseNumberWords(['constructor', 'call'], 'en')).toBeNull()
    expect(parseNumberWords(['twenty', 'constructor'], 'en')).toEqual({ value: 20, used: 1 })
    expect(parseNumberWords(['constructor'], 'bn')).toBeNull()
    expect(parseNumberWords(['constructor'], 'hi')).toBeNull()
    expect(findNumbers(seg('Our constructor grew 300 percent'), 'en')).toEqual([expect.objectContaining({ value: 300, from: 3, to: 4 })])
  })

  it('reads Bangla and Hindi from the CLDR tables', () => {
    expect(parseNumberWords(['তিনশো'], 'bn')).toEqual({ value: 300, used: 1 })
    expect(parseNumberWords(['পঁচিশ', 'হাজার'], 'bn')).toEqual({ value: 25000, used: 2 })
    expect(parseNumberWords(['দুই', 'লাখ', 'পঞ্চাশ', 'হাজার'], 'bn')).toEqual({ value: 250000, used: 4 })
    expect(parseNumberWords(['तीन', 'सौ'], 'hi')).toEqual({ value: 300, used: 2 })
    expect(parseNumberWords(['पाँच', 'लाख'], 'hi')).toEqual({ value: 500000, used: 2 })
  })
})
