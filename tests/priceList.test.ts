import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_PRICE_LIST, parsePriceList, priceOf, PRICE_LIST_MAX_BYTES, type PriceList } from '../src/shared/ai/prices'

/*
 * The price list (docs/design/smart-tools.md §11.4, §22 test 89): the bundled file parses; a list with a
 * negative price, one over 1,000, 2,001 entries, a bad date or a date two days ahead is refused as a
 * whole; an exact entry wins over a prefix; the newer list is shown; the refresh runs at most daily,
 * only while automatic updates are on, with redirect: 'error' and the 256 KB cap.
 */

const h = vi.hoisted(() => ({ userData: '', packaged: false }))
vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData,
    get isPackaged() {
      return h.packaged
    }
  },
  net: { fetch: () => Promise.reject(new Error('no net in tests')) }
}))

const { priceList, refreshPriceList, resetPriceList, loadPriceCache, PRICE_CACHE_FILE } = await import('../src/main/ai/priceList')

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-20T10:00:00Z')
const list = (models: unknown[], updated = '2026-11-19'): Record<string, unknown> => ({ version: 1, updated, currency: 'USD', models })
const NEWER = list([{ service: 'openai', model: 'gpt-6.1-sol', input: 2.5, output: 12 }])

/** A fetch that answers `body` and records each call. */
function fake(body: string | (() => Response)): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return typeof body === 'string' ? new Response(body, { status: 200 }) : body()
    }) as unknown as typeof fetch
  }
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'))
  resetPriceList()
})
afterEach(() => fs.rmSync(h.userData, { recursive: true, force: true }))

describe('parsing (test 89)', () => {
  it('the bundled file parses; bad lists are refused whole', () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'ai-prices.json'), 'utf8'))
    expect(parsePriceList(file, '2026-11-20')).toEqual(BUNDLED_PRICE_LIST)
    const ok = { service: 'groq', model: 'm', input: 1, output: 2 }
    expect(parsePriceList(list([ok]), '2026-11-20')).not.toBeNull()
    expect(parsePriceList(list([{ ...ok, input: -0.01 }]), '2026-11-20')).toBeNull()
    expect(parsePriceList(list([{ ...ok, output: 1000.5 }]), '2026-11-20')).toBeNull()
    expect(parsePriceList(list(Array.from({ length: 2001 }, () => ok)), '2026-11-20')).toBeNull()
    expect(parsePriceList(list([ok], '2026-13-01'), '2026-11-20')).toBeNull()
    expect(parsePriceList(list([ok], '2026-11-22'), '2026-11-20')).toBeNull()
    expect(parsePriceList(list([ok], '2026-11-21'), '2026-11-20')).not.toBeNull()
  })

  it('an exact entry wins over a prefix; the longest prefix over a shorter one', () => {
    const l = parsePriceList(
      list([
        { service: 'openai', model: 'gpt-6', prefix: true, input: 1, output: 1 },
        { service: 'openai', model: 'gpt-6.1', prefix: true, input: 2, output: 2 },
        { service: 'openai', model: 'gpt-6.1-sol', input: 3, output: 3 }
      ]),
      '2026-11-20'
    ) as PriceList
    expect(priceOf(l, 'openai', 'gpt-6.1-sol')?.input).toBe(3)
    expect(priceOf(l, 'openai', 'gpt-6.1-mini')?.input).toBe(2)
    expect(priceOf(l, 'openai', 'gpt-6-nano')?.input).toBe(1)
    expect(priceOf(l, 'openai', 'o5')).toBeNull()
    expect(priceOf(l, 'groq', 'gpt-6.1-sol')).toBeNull()
  })
})

describe('the refresh (test 89)', () => {
  it('shows the newer list; the confirm keeps the higher prices', async () => {
    const f = fake(JSON.stringify(NEWER))
    expect((await refreshPriceList({ fetch: f.fetch, now: NOW, updatesOn: true })).updated).toBe('2026-11-19')
    const { shown, confirm } = priceList()
    expect(shown.updated).toBe('2026-11-19')
    expect(priceOf(confirm, 'openai', 'gpt-6.1-sol')).toMatchObject({ input: 2.5, output: 12 })
    // Bundled entries the download lacks stay for the confirm.
    expect(priceOf(confirm, 'anthropic', 'claude-opus-5-5')).toMatchObject({ input: 4, output: 20 })
    // Kept for the next start.
    const cached = JSON.parse(fs.readFileSync(path.join(h.userData, PRICE_CACHE_FILE), 'utf8'))
    expect(cached.list).toEqual(NEWER)
    resetPriceList()
    loadPriceCache(path.join(h.userData, PRICE_CACHE_FILE), NOW)
    expect(priceList().shown.updated).toBe('2026-11-19')
  })

  it('runs at most daily', async () => {
    const f = fake(JSON.stringify(NEWER))
    await refreshPriceList({ fetch: f.fetch, now: NOW, updatesOn: true })
    await refreshPriceList({ fetch: f.fetch, now: NOW + DAY - 1, updatesOn: true })
    expect(f.calls).toHaveLength(1)
    await refreshPriceList({ fetch: f.fetch, now: NOW + DAY, updatesOn: true })
    expect(f.calls).toHaveLength(2)
  })

  it('only while automatic updates are on', async () => {
    const f = fake(JSON.stringify(NEWER))
    expect(await refreshPriceList({ fetch: f.fetch, now: NOW, updatesOn: false })).toBe(BUNDLED_PRICE_LIST)
    expect(f.calls).toHaveLength(0)
  })

  it("asks with redirect: 'error' from the list's address, and refuses a body over 256 KB", async () => {
    const big = JSON.stringify({ ...NEWER, pad: 'x'.repeat(PRICE_LIST_MAX_BYTES) })
    const f = fake(big)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await refreshPriceList({ fetch: f.fetch, now: NOW, updatesOn: true })).toBe(BUNDLED_PRICE_LIST)
    expect(f.calls[0].init.redirect).toBe('error')
    expect(f.calls[0].url).toBe('https://raw.githubusercontent.com/samiulakhan12/windows-screen-studio/HEAD/resources/ai-prices.json')
    expect(warn.mock.calls.flat().join(' ')).toMatch(/too large/)
    warn.mockRestore()
  })

  it('ignores a list dated after tomorrow, and one that does not parse', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await refreshPriceList({ fetch: fake(JSON.stringify(list([{ service: 'openai', model: 'gpt-6.1-sol', input: 0.01, output: 0.01 }], '2099-01-01'))).fetch, now: NOW, updatesOn: true })
    expect(priceList().shown).toBe(BUNDLED_PRICE_LIST)
    resetPriceList()
    await refreshPriceList({ fetch: fake('{"version":1,').fetch, now: NOW, updatesOn: true })
    expect(priceList().shown).toBe(BUNDLED_PRICE_LIST)
    warn.mockRestore()
  })

  it('a failed refresh waits an hour before the next try', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const f = fake(() => new Response('', { status: 500 }))
    await refreshPriceList({ fetch: f.fetch, now: NOW, updatesOn: true })
    await refreshPriceList({ fetch: f.fetch, now: NOW + 60_000, updatesOn: true })
    expect(f.calls).toHaveLength(1)
    await refreshPriceList({ fetch: f.fetch, now: NOW + 61 * 60_000, updatesOn: true })
    expect(f.calls).toHaveLength(2)
    warn.mockRestore()
  })
})
