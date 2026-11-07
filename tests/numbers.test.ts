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

  it('reads one number only: numbers said one after the other and ordinals in two words give none', () => {
    const en = (text: string): ReturnType<typeof parseNumberWords> => parseNumberWords(text.split(' '))
    for (const text of ['nineteen ninety nine', 'twenty twenty four', 'five six seven eight', 'seven twelve', 'eleven twelve', 'twenty five six', 'one twenty', 'twenty first century', 'forty fifth president', 'twenty-first century', 'nine-to-five'])
      expect(en(text), text).toBeNull()
    // "and" joins after a hundred or a scale only: two numbers with "and" between are two numbers.
    expect(en('ten and twenty seconds')).toEqual({ value: 10, used: 1 })
    expect(en('twenty and thirty')).toEqual({ value: 20, used: 1 })
    expect(en('a hundred and ten and a hundred and twenty')).toEqual({ value: 110, used: 4 })
    // Still one number.
    expect(en('nineteen hundred and ninety nine')).toEqual({ value: 1999, used: 5 })
    expect(en('twenty five hundred')).toEqual({ value: 2500, used: 3 })
    expect(en('two hundred and fifty five people')).toEqual({ value: 255, used: 5 })
    expect(en('one thousand two hundred and thirty four')).toEqual({ value: 1234, used: 7 })
    expect(en('forty two thousand')).toEqual({ value: 42000, used: 3 })
    expect(en('three thousand four hundred')).toEqual({ value: 3400, used: 4 })
    expect(en('five hundred thousand')).toEqual({ value: 500000, used: 3 })
    expect(en('twenty one pilots')).toEqual({ value: 21, used: 2 })
    // "second" is also a unit of time; a clause between them keeps the number.
    expect(en('thirty second clip')).toEqual({ value: 30, used: 1 })
    expect(en('twenty, first')).toEqual({ value: 20, used: 1 })
    // Bangla and Hindi alike.
    expect(parseNumberWords(['এক', 'দুই', 'তিন'], 'bn')).toBeNull()
    expect(parseNumberWords(['দুই', 'তিনশো'], 'bn')).toBeNull()
    expect(parseNumberWords(['দুই', 'হাজার', 'পাঁচশো'], 'bn')).toEqual({ value: 2500, used: 3 })
    expect(parseNumberWords(['দুই', 'শো', 'পঞ্চাশ'], 'bn')).toEqual({ value: 250, used: 3 })
    expect(parseNumberWords(['दो', 'तीन'], 'hi')).toBeNull()
    expect(parseNumberWords(['दो', 'सौ', 'पचास'], 'hi')).toEqual({ value: 250, used: 3 })
  })

  it('gives no counter for numbers said one after the other', () => {
    expect(findNumbers(seg('we grew from nineteen ninety nine users to five six percent'), 'en')).toEqual([])
    expect(findNumbers(seg('revenue grew twenty five percent'), 'en')).toMatchObject([{ value: 25 }])
  })
})
