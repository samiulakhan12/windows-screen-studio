/**
 * The price list (docs/design/smart-tools.md §11.4): US$ per million tokens, or per minute of sound,
 * by service (a provider kind or a service preset) and model. Flown carries BUNDLED_PRICE_LIST (a
 * test keeps it equal to resources/ai-prices.json) and refreshes it from that file on GitHub (part
 * P5's src/main/ai/priceList.ts). A downloaded list is untrusted: parsePriceList takes it whole or
 * not at all, its date may not be in the future, and the confirm uses, per model, the higher of the
 * bundled and downloaded prices, so a bad push can raise an estimate but never lower a confirm.
 */

/** One model's price. A `prefix` entry matches every model whose id starts with `model`. */
export interface PriceEntry {
  service: string
  model: string
  prefix?: true
  /** US$ per million input tokens. */
  input?: number
  /** US$ per million output tokens. */
  output?: number
  /** US$ per minute of sound (transcription). */
  perMinute?: number
  /** The model's own rule for pictures: `base` tokens plus `perTile` for each `tile`-pixel tile. */
  imageTokens?: { base: number; perTile: number; tile: number }
}

export interface PriceList {
  version: 1
  /** YYYY-MM-DD: of the bundled and downloaded lists, the newer is shown. */
  updated: string
  currency: 'USD'
  models: PriceEntry[]
}

/** The list bundled with this version (equal to resources/ai-prices.json). */
export const BUNDLED_PRICE_LIST: PriceList = {
  version: 1,
  updated: '2026-11-07',
  currency: 'USD',
  models: [
    { service: 'openai', model: 'gpt-6.1-sol', input: 2.0, output: 10.0 },
    { service: 'openai', model: 'whisper-1', perMinute: 0.006 },
    { service: 'openai', model: 'gpt-transcribe', perMinute: 0.0045 },
    { service: 'gemini', model: 'gemini-3.8-flash', input: 0.75, output: 3.75 },
    { service: 'anthropic', model: 'claude-opus-5-5', input: 4.0, output: 20.0 },
    { service: 'groq', model: 'openai/gpt-oss-20b', input: 0.075, output: 0.3 }
  ]
}

/** The list on GitHub, on the default branch (as MODEL_LIST_URL, src/shared/ai/modelList.ts). */
export const PRICE_LIST_URL = 'https://raw.githubusercontent.com/samiulakhan12/windows-screen-studio/HEAD/resources/ai-prices.json'
/** Largest list read. */
export const PRICE_LIST_MAX_BYTES = 256 * 1024

/** Most entries a list may hold, the highest price taken, the most tokens a picture rule may name. */
const MAX_ENTRIES = 2000
const MAX_PRICE = 1000
const MAX_IMAGE_TOKENS = 100_000
const SERVICE_RE = /^[a-z0-9-]{1,40}$/
/** As keyStore checks a saved model name. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const price = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE

/** Milliseconds of a real YYYY-MM-DD date (UTC midnight), else NaN. */
function dayMs(s: unknown): number {
  if (typeof s !== 'string') return Number.NaN
  const m = DATE_RE.exec(s)
  if (!m) return Number.NaN
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const d = new Date(t)
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : Number.NaN
}

/** One entry, checked, or null (which refuses the whole list). */
function readEntry(v: unknown): PriceEntry | null {
  if (!isObj(v) || typeof v.service !== 'string' || !SERVICE_RE.test(v.service)) return null
  if (typeof v.model !== 'string' || v.model.length > 100 || !MODEL_RE.test(v.model)) return null
  const e: PriceEntry = { service: v.service, model: v.model }
  if (v.prefix !== undefined) {
    if (v.prefix !== true) return null
    e.prefix = true
  }
  for (const k of ['input', 'output', 'perMinute'] as const) {
    if (v[k] === undefined) continue
    if (!price(v[k])) return null
    e[k] = v[k] as number
  }
  const tokens = e.input !== undefined && e.output !== undefined
  if (!tokens && e.perMinute === undefined) return null
  if (v.imageTokens !== undefined) {
    const r = v.imageTokens
    const ok = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= MAX_IMAGE_TOKENS
    if (!isObj(r) || !ok(r.base, 0) || !ok(r.perTile, 0) || !ok(r.tile, 1)) return null
    e.imageTokens = { base: r.base, perTile: r.perTile, tile: r.tile }
  }
  return e
}

/**
 * A price list as read from a file (bundled or downloaded), or null when anything in it is wrong:
 * version 1, currency 'USD', `updated` a real date no later than `today` (YYYY-MM-DD) plus one day,
 * at most 2,000 entries, each with a service, a model, and prices of 0 to 1,000 (input and output,
 * or per minute). A list is taken whole or not at all.
 */
export function parsePriceList(raw: unknown, today: string): PriceList | null {
  if (!isObj(raw) || raw.version !== 1 || raw.currency !== 'USD' || !Array.isArray(raw.models) || raw.models.length > MAX_ENTRIES) return null
  const updated = dayMs(raw.updated)
  const now = dayMs(today)
  if (!Number.isFinite(updated) || !Number.isFinite(now) || updated > now + DAY_MS) return null
  const models: PriceEntry[] = []
  for (const v of raw.models) {
    const e = readEntry(v)
    if (!e) return null
    models.push(e)
  }
  return { version: 1, updated: raw.updated as string, currency: 'USD', models }
}

/** The entry for `model` of `service`: an exact one first, else the longest prefix entry; null when none. */
export function priceOf(list: PriceList, service: string, model: string): PriceEntry | null {
  let best: PriceEntry | null = null
  for (const e of list.models) {
    if (e.service !== service) continue
    if (!e.prefix && e.model === model) return e
    if (e.prefix && model.startsWith(e.model) && (!best || e.model.length > best.model.length)) best = e
  }
  return best
}

/**
 * The price a confirm uses (§11.4): per field, the higher of the bundled and the downloaded list's;
 * a downloaded 0 where the bundled list has a price is ignored. Null when neither list knows it.
 */
export function confirmPrice(bundled: PriceList, downloaded: PriceList | null, service: string, model: string): PriceEntry | null {
  const b = priceOf(bundled, service, model)
  const d = downloaded ? priceOf(downloaded, service, model) : null
  if (!b || !d) return b ?? d
  const out: PriceEntry = { ...b }
  for (const k of ['input', 'output', 'perMinute'] as const) {
    const bv = b[k]
    const dv = d[k]
    if (dv === undefined || (dv === 0 && bv !== undefined)) continue
    out[k] = bv === undefined ? dv : Math.max(bv, dv)
  }
  if (!out.imageTokens && d.imageTokens) out.imageTokens = d.imageTokens
  return out
}

/** A price OpenRouter gives as text, US$ per token, as US$ per million tokens; null unless a finite number of 0 or more. */
function perMillion(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[0-9.eE+-]+\s*$/.test(v) ? Number(v) : Number.NaN
  if (!Number.isFinite(n) || n < 0) return null
  const m = n * 1e6
  return m <= MAX_PRICE ? Math.round(m * 1e6) / 1e6 : null
}

/**
 * OpenRouter's price of one model of its list (§10.4): `pricing.prompt` and `pricing.completion` (US$
 * per token, as text), given as the model entry or its `pricing` object. "-1", a missing value or
 * anything not a finite number of 0 or more is unknown: 'varies' (its router models).
 */
export function readOpenRouterPrice(raw: unknown): { input: number; output: number } | 'varies' {
  const p = isObj(raw) && isObj(raw.pricing) ? raw.pricing : raw
  if (!isObj(p)) return 'varies'
  const input = perMillion(p.prompt)
  const output = perMillion(p.completion)
  return input === null || output === null ? 'varies' : { input, output }
}
