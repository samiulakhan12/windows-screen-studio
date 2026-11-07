import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_PRICE_LIST, confirmPrice, parsePriceList, priceOf, PRICE_LIST_MAX_BYTES, readOpenRouterPrice, type PriceList } from '../src/shared/ai/prices'
import { guideCopyProblem, guidePayloadProblem, GUIDE_SAVE_LIMITS } from '../src/shared/api/guide'
import { sanitizeSmartPref } from '../src/shared/smart/smartPrefs'

/*
 * The readers the contracts complete for the parts (docs/design/smart-tools.md §20.0): the price
 * list file and its reader (§11.4), the preferences' sanitisers (§4.7), and the guide save's limits
 * the preload checks before sending (§5.8).
 */

const list = (models: unknown[], updated = '2026-11-07'): unknown => ({ version: 1, updated, currency: 'USD', models })

describe('the price list (§11.4)', () => {
  it('the bundled file is BUNDLED_PRICE_LIST, parses, and fits its cap', () => {
    const file = fs.readFileSync(path.join(__dirname, '..', 'resources', 'ai-prices.json'))
    expect(file.length).toBeLessThan(PRICE_LIST_MAX_BYTES)
    expect(parsePriceList(JSON.parse(file.toString('utf8')), '2026-11-07')).toEqual(BUNDLED_PRICE_LIST)
  })

  it('refuses the whole list for a negative price, one over 1,000, 2,001 entries, a bad date or one two days ahead', () => {
    const ok = { service: 'openai', model: 'x', input: 1, output: 2 }
    expect(parsePriceList(list([ok]), '2026-11-07')).not.toBeNull()
    expect(parsePriceList(list([ok, { ...ok, input: -1 }]), '2026-11-07')).toBeNull()
    expect(parsePriceList(list([{ ...ok, output: 1000.01 }]), '2026-11-07')).toBeNull()
    expect(parsePriceList(list(Array.from({ length: 2001 }, () => ok)), '2026-11-07')).toBeNull()
    expect(parsePriceList(list([ok], '2026-02-30'), '2026-11-07')).toBeNull()
    expect(parsePriceList(list([ok], '2026-11-09'), '2026-11-07')).toBeNull()
    expect(parsePriceList(list([ok], '2026-11-08'), '2026-11-07')).not.toBeNull()
    expect(parsePriceList(list([{ service: 'openai', model: 'x' }]), '2026-11-07')).toBeNull()
    expect(parsePriceList({ ...(list([ok]) as object), currency: 'EUR' }, '2026-11-07')).toBeNull()
  })

  it('priceOf takes an exact entry before the longest prefix', () => {
    const l = parsePriceList(
      list([
        { service: 'openai', model: 'gpt-6', prefix: true, input: 1, output: 1 },
        { service: 'openai', model: 'gpt-6.1', prefix: true, input: 2, output: 2 },
        { service: 'openai', model: 'gpt-6.1-sol', input: 3, output: 3 }
      ]),
      '2026-11-07'
    )!
    expect(priceOf(l, 'openai', 'gpt-6.1-sol')?.input).toBe(3)
    expect(priceOf(l, 'openai', 'gpt-6.1-mini')?.input).toBe(2)
    expect(priceOf(l, 'openai', 'gpt-6-nano')?.input).toBe(1)
    expect(priceOf(l, 'gemini', 'gpt-6.1-sol')).toBeNull()
  })

  it('a confirm uses the higher price per model; a downloaded 0 where the bundled list has one is ignored', () => {
    const bundled = parsePriceList(list([{ service: 'groq', model: 'm', input: 1, output: 4 }]), '2026-11-07') as PriceList
    const lower = parsePriceList(list([{ service: 'groq', model: 'm', input: 0, output: 2 }]), '2026-11-07')
    const higher = parsePriceList(list([{ service: 'groq', model: 'm', input: 3, output: 1 }]), '2026-11-07')
    expect(confirmPrice(bundled, lower, 'groq', 'm')).toMatchObject({ input: 1, output: 4 })
    expect(confirmPrice(bundled, higher, 'groq', 'm')).toMatchObject({ input: 3, output: 4 })
    expect(confirmPrice(bundled, null, 'groq', 'm')).toMatchObject({ input: 1, output: 4 })
    expect(confirmPrice(bundled, higher, 'groq', 'other')).toBeNull()
  })

  it("OpenRouter's prices: per token as text; -1, missing or not a number is 'varies'", () => {
    expect(readOpenRouterPrice({ pricing: { prompt: '0.000002', completion: '0.00001' } })).toEqual({ input: 2, output: 10 })
    expect(readOpenRouterPrice({ prompt: '0', completion: '0' })).toEqual({ input: 0, output: 0 })
    expect(readOpenRouterPrice({ prompt: '-1', completion: '-1' })).toBe('varies')
    expect(readOpenRouterPrice({ prompt: '0.000001' })).toBe('varies')
    expect(readOpenRouterPrice({ prompt: 'abc', completion: '1' })).toBe('varies')
    expect(readOpenRouterPrice(null)).toBe('varies')
  })
})

describe("smart tools' preferences (§4.7)", () => {
  it('aiConfirm: one of the five, else 1', () => {
    for (const v of ['always', '0.1', '1', '5', 'never']) expect(sanitizeSmartPref('aiConfirm', v)).toBe(v)
    for (const v of ['2', 1, {}, 'ALWAYS']) expect(sanitizeSmartPref('aiConfirm', v)).toBe('1')
    expect(sanitizeSmartPref('aiConfirm', null)).toBeNull()
  })

  it('aiPrices keeps provider prices of 0 to 1,000; the rest, the defaults field by field', () => {
    expect(sanitizeSmartPref('aiPrices', { ai1: { input: 2, output: 8 }, svc1: { input: -1, output: 1 }, 'a b': { input: 1, output: 1 }, x: { input: 1001, output: 1 } })).toEqual({ ai1: { input: 2, output: 8 } })
    expect(sanitizeSmartPref('aiPrices', 'nope')).toEqual({})
    expect(sanitizeSmartPref('guide', { format: 'demo', page: 'Letter', titles: 'local', notes: 'a b', extra: 1 })).toEqual({ format: 'demo', page: 'Letter', titles: 'local' })
    expect(sanitizeSmartPref('findChapters', { density: 'many', use: { screen: false }, names: 'svc1' })).toEqual({ density: 'normal', use: { screen: false, pauses: true, words: true }, names: 'svc1' })
    expect(sanitizeSmartPref('shortClips', 7)).toEqual({ length: 'any', shape: 'vertical', names: 'offline', captions: true })
    expect(sanitizeSmartPref('captionWordList', ['kept as it is'])).toEqual(['kept as it is'])
  })
})

describe("the guide save's limits, checked before sending (§5.8)", () => {
  const png = (n: number): Uint8Array => {
    const b = new Uint8Array(n)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    return b
  }
  it('refuses a 301st image, an image that is not PNG, JPEG or WebP, 64 MB + 1 of HTML and 256 MB + 1 in all', () => {
    expect(guidePayloadProblem({ format: 'markdown', name: 'Guide', markdown: '# x', images: [png(100)] })).toBeNull()
    expect(guidePayloadProblem({ format: 'markdown', name: 'Guide', markdown: '# x', images: Array.from({ length: 301 }, () => png(16)) })).toMatch(/too many/)
    expect(guidePayloadProblem({ format: 'markdown', name: 'Guide', markdown: '# x', images: [new Uint8Array([1, 2, 3, 4])] })).toMatch(/cannot be saved/)
    expect(guidePayloadProblem({ format: 'html', name: 'Guide', html: 'x'.repeat(GUIDE_SAVE_LIMITS.html + 1) })).toMatch(/too large/)
    const big = png(GUIDE_SAVE_LIMITS.image)
    const images = Array.from({ length: 16 }, () => big)
    // 16 images of 16 MB are 256 MB exactly; one byte more in all is refused.
    expect(guidePayloadProblem({ format: 'markdown', name: 'Guide', markdown: '', images })).toBeNull()
    expect(guidePayloadProblem({ format: 'markdown', name: 'Guide', markdown: '#', images })).toMatch(/too large/)
    expect(guidePayloadProblem({ format: 'exe', name: 'Guide' })).toMatch(/Unknown/)
    expect(guidePayloadProblem({ format: 'pdf', name: 'x'.repeat(121), html: '' })).toMatch(/name/)
    expect(guideCopyProblem({ html: '<p>x</p>', text: 'x' })).toBeNull()
    expect(guideCopyProblem({ html: '<p>x</p>', text: 'x'.repeat(GUIDE_SAVE_LIMITS.clipText + 1) })).toMatch(/too large/)
  })
})
