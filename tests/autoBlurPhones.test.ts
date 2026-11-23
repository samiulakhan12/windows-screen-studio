import { describe, expect, it, vi } from 'vitest'
import isValidPhoneNumber from '../src/shared/privacy/vendor/libphonenumber/es6/isValidPhoneNumber.js'
import { phoneRegions } from '../src/shared/privacy/detect/phones'
import { hitsOn } from './autoBlurRulesFixtures'

/*
 * Auto-blur P3: phone numbers (docs/design/auto-blur.md §6.8, test 110). The vendored library is
 * wrapped so the test sees that its isValidPhoneNumber decides what is valid.
 */

vi.mock('../src/shared/privacy/vendor/libphonenumber/es6/isValidPhoneNumber.js', async (importOriginal) => {
  const real = (await importOriginal()) as { default: (...args: unknown[]) => boolean }
  return { default: Object.assign(vi.fn(real.default), { real: real.default }) }
})

const phone = (text: string, regions: string[] = ['US', 'BD']) => hitsOn(text, { regions }).filter((h) => h.kind === 'phone').map((h) => ({ rule: h.rule, score: h.score, text: h.text }))

describe('auto-blur P3: phones', () => {
  it('110. phones: + numbers valid and possible; labels; the region’s written formats; bare mobiles at 0.60 and never NANP; dates, IPs, times and decimals refused; Bengali digits converted first; the vendored library’s isValidPhoneNumber is what is called', () => {
    const valid = vi.mocked(isValidPhoneNumber)
    const real = (isValidPhoneNumber as unknown as { real: typeof isValidPhoneNumber }).real
    valid.mockClear()
    // `+` numbers: valid 0.92; of a possible length only, 0.85 grouped and 0.60 ungrouped (Ofcom's drama range).
    expect(phone('Office +44 20 7946 0958')).toEqual([{ rule: 'phone-intl', score: 0.92, text: '+44 20 7946 0958' }])
    expect(phone('Sms: +44 7700 900461')).toEqual([{ rule: 'phone-intl', score: 0.85, text: '+44 7700 900461' }])
    expect(phone('Sms: +447700900461')).toEqual([{ rule: 'phone-intl', score: 0.6, text: '+447700900461' }])
    expect(phone('00 44 20 7946 0958')).toEqual([{ rule: 'phone-intl', score: 0.92, text: '00 44 20 7946 0958' }])
    expect(valid).toHaveBeenCalled()
    // The vendored check decides: refused there, refused here.
    valid.mockImplementation(() => false)
    expect(phone('Office +44 20 7946 0958').filter((h) => h.score > 0.85)).toEqual([])
    expect(phone('Call (213) 373-4253 today')).toEqual([])
    valid.mockImplementation(real)
    // A phone label on the line or above with a number valid for one of the regions: 0.92.
    expect(phone('Phone: 2133734253', ['US'])).toEqual([{ rule: 'phone-labelled', score: 0.92, text: '2133734253' }])
    expect(hitsOn('2133734253', { above: 'Mobile', regions: ['US'] }).map((h) => h.rule)).toEqual(['phone-labelled'])
    // Written in one of the region's formats: 0.85.
    expect(phone('Reach us at (213) 373-4253 today', ['US'])).toEqual([{ rule: 'phone-grouped', score: 0.85, text: '(213) 373-4253' }])
    expect(phone('01712-345678', ['BD'])).toEqual([{ rule: 'phone-grouped', score: 0.85, text: '01712-345678' }])
    expect(phone('21 337 34253', ['US'])).toEqual([])
    // A bare mobile with its national prefix: 0.60, not with an order word on the line, never NANP.
    expect(phone('01712345678', ['BD'])).toEqual([{ rule: 'phone-bare-mobile', score: 0.6, text: '01712345678' }])
    expect(phone('Order 01712345678', ['BD'])).toEqual([])
    expect(phone('Invoice 2133734253', ['US'])).toEqual([])
    expect(phone('2133734253', ['US'])).toEqual([])
    // Not in the user's regions: nothing.
    expect(phone('01712345678', ['US'])).toEqual([])
    // Dates, IPs, times, versions and decimals are refused first.
    for (const t of ['Updated 2024-11-23', 'Due 23/11/2024', 'Server 192.168.10.254', '10:30:45 PM', 'libphonenumber-js 1.13.16', 'Total $1,234,567.89', 'd="M 0 1.5-.8 1.5-1.5 0-1.2"', 'pi = 3.14159265358'])
      expect(phone(t), t).toEqual([])
    // Bengali and Devanagari digits are converted before the library is called.
    valid.mockClear()
    expect(phone('মোবাইল: ০১৭১২৩৪৫৬৭৮', ['BD'])).toEqual([{ rule: 'phone-labelled', score: 0.92, text: '০১৭১২৩৪৫৬৭৮' }])
    expect(valid.mock.calls.some((c) => c[0] === '01712345678')).toBe(true)
    expect(valid.mock.calls.every((c) => !/[০-৯]/.test(String(c[0])))).toBe(true)
    // The regions: the PC's, the UI language's, and up to 5 added, each once.
    expect(phoneRegions('US', 'bn', ['GB', 'IN', 'US', 'ES', 'DE', 'FR', 'JP'])).toEqual(['US', 'BD', 'GB', 'IN', 'ES', 'DE'])
    expect(phoneRegions(null, 'en', [])).toEqual([])
    expect(phoneRegions('XX', 'hi', ['zz'])).toEqual(['IN'])
  })
})
