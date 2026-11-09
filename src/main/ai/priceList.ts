/**
 * The price list in main (docs/design/smart-tools.md §11.4): the list bundled with this version and
 * the last one downloaded from GitHub (kept in userData/ai-prices.json), refreshed at most daily and
 * only while automatic updates are on, with redirects refused and a 256 KB cap, as the model list is
 * (modelList.ts). A downloaded list is untrusted: parsePriceList takes it whole or not at all and
 * refuses one dated after tomorrow; the newer of the two lists is shown, but the high end of an
 * estimate and a confirm use, per model, the higher of the two prices (confirmList), so a bad push can
 * raise an estimate but never lower a confirm.
 *
 * Test hook (§22 test 104): SSW_PRICE_LIST_URL, read only when the app is not packaged; development
 * and the tests refresh only from an address they give.
 */
import { app, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLED_PRICE_LIST, confirmList, newerList, parsePriceList, PRICE_LIST_MAX_BYTES, PRICE_LIST_URL, type PriceList } from '../../shared/ai/prices'
import { writeFileAtomicSync } from '../atomicWrite'

export const PRICE_CACHE_FILE = 'ai-prices.json'
const DAY_MS = 24 * 60 * 60 * 1000
/** A failed refresh waits this long before the next try. */
const RETRY_MS = 60 * 60 * 1000

let downloaded: PriceList | null = null
let fetchedAt = 0
let triedAt = 0
let cacheFile: string | null = null
let loaded = false
let inFlight: Promise<PriceList> | null = null

/** YYYY-MM-DD of `now` (UTC): what a list's date is checked against. */
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)

/** Back to the bundled list only (tests). */
export function resetPriceList(): void {
  downloaded = null
  fetchedAt = 0
  triedAt = 0
  cacheFile = null
  loaded = false
  inFlight = null
}

/** Reads the list last downloaded from `file` (a bad one, or one dated after tomorrow, is ignored). */
export function loadPriceCache(file: string, now = Date.now()): void {
  cacheFile = file
  loaded = true
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring the unreadable price list')
    return
  }
  const r = raw && typeof raw === 'object' ? (raw as { fetchedAt?: unknown; list?: unknown }) : {}
  const at = typeof r.fetchedAt === 'string' ? Date.parse(r.fetchedAt) : NaN
  if (Number.isFinite(at)) fetchedAt = at
  downloaded = parsePriceList(r.list, dayOf(now))
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    loadPriceCache(path.join(app.getPath('userData'), PRICE_CACHE_FILE))
  } catch {
    // No userData (tests): the bundled list.
  }
}

/** What the line shows (the newer list, with its date) and what a confirm uses (the higher prices). */
export function priceList(): { shown: PriceList; confirm: PriceList } {
  ensureLoaded()
  void autoRefresh()
  return { shown: newerList(BUNDLED_PRICE_LIST, downloaded), confirm: confirmList(BUNDLED_PRICE_LIST, downloaded) }
}

/** Where the list is refreshed from: GitHub; SSW_PRICE_LIST_URL instead only when the app is not packaged. */
export function priceListUrl(): string {
  return !app.isPackaged && process.env.SSW_PRICE_LIST_URL ? process.env.SSW_PRICE_LIST_URL : PRICE_LIST_URL
}

/** A refresh when the list is asked for, while automatic updates are on (packaged, or a test address given). */
async function autoRefresh(): Promise<void> {
  if (!app.isPackaged && !process.env.SSW_PRICE_LIST_URL) return
  try {
    const { updatesAuto } = await import('../updates/updatesIpc')
    await refreshPriceList({ updatesOn: updatesAuto() })
  } catch {
    // The bundled or cached list stays.
  }
}

/** The body as text, or null past `max` bytes or when it is not UTF-8. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > max) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    return null
  }
}

/**
 * Downloads the list when the last download is a day old, only while automatic updates are on
 * (`updatesOn`); no redirects, 15 s, at most 256 KB; a list parsePriceList refuses is ignored as a
 * whole. A failure waits an hour. Resolves with the list shown afterwards.
 */
export async function refreshPriceList(opts: { fetch?: typeof fetch; now?: number; updatesOn: boolean }): Promise<PriceList> {
  ensureLoaded()
  const now = opts.now ?? Date.now()
  const shown = (): PriceList => newerList(BUNDLED_PRICE_LIST, downloaded)
  if (!opts.updatesOn) return shown()
  // A download time later than now (the clock was ahead then) does not count.
  if (fetchedAt > 0 && now >= fetchedAt && now - fetchedAt < DAY_MS) return shown()
  if (triedAt > 0 && now >= triedAt && now - triedAt < RETRY_MS) return shown()
  if (inFlight) return inFlight
  triedAt = now
  const fetcher = opts.fetch ?? ((url: string, init: RequestInit) => net.fetch(url, init))
  inFlight = (async (): Promise<PriceList> => {
    try {
      const res = await fetcher(priceListUrl(), { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await readCapped(res, PRICE_LIST_MAX_BYTES)
      if (text === null) throw new Error('too large or not UTF-8')
      const raw = JSON.parse(text) as unknown
      const list = parsePriceList(raw, dayOf(now))
      if (!list) throw new Error('not a list Flown can use')
      downloaded = list
      fetchedAt = now
      if (cacheFile) {
        try {
          writeFileAtomicSync(cacheFile, `${JSON.stringify({ fetchedAt: new Date(now).toISOString(), list: raw }, null, 2)}\n`)
        } catch (err) {
          console.warn('Could not keep the price list:', err instanceof Error ? err.message : String(err))
        }
      }
    } catch (err) {
      console.warn('Could not refresh the price list:', err instanceof Error ? err.message : String(err))
    }
    return shown()
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}
