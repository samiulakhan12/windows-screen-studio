/**
 * The cost up front (docs/design/smart-tools.md §11): what an AI action sends, estimated from the
 * exact prompts runTextTask would send (textPrompts), and what it costs with the price list, or how
 * long it takes on this PC; the words of the line; and when a click asks first. Nothing is sent to
 * count tokens: characters are counted exactly and tokens estimated from them (tokens.ts). Pure.
 *
 * Prices: the user's own win over everything; then a service's live list (OpenRouter's, for the
 * session); then the price list. The low end of an estimate uses the shown list, the high end and the
 * confirm the higher of the bundled and downloaded prices (`confirmPrices`), so a bad price list can
 * raise an estimate but never lower a confirm (§11.4). A preset's prices and "no cost" apply only at
 * its own host (presets.ts).
 */
import type { AiTextRequest, AiUsage, TextChoice } from '../api/ai'
import { DEFAULT_TEXT_LIMITS, maxChapters, textPrompts, type TextLimits, type TextPrompt } from '../captions/transcriptText'
import type { ScriptTag } from '../captions/words'
import type { AiProviderKind } from '../types'
import { scriptPrompt } from '../notes/scriptDraft'
import { presetAt, SERVICE_PRESETS } from './presets'
import { BUNDLED_PRICE_LIST, priceOf, type PriceEntry, type PriceList } from './prices'
import { blendedRatio, countWords, estimateTokens, imageTokens, jpegSize, tokenFamily, tokenRatio, type TokenFamily } from './tokens'
import type { ConfirmPref } from '../smart/smartPrefs'

export type { ConfirmPref } from '../smart/smartPrefs'

export interface CostEstimate {
  /** Requests the action sends (batches included). */
  requests: number
  /** Words of what is sent (the captions, notes or items; not Flown's instructions). */
  words: number
  pictures: number
  inputTokens: [number, number]
  outputTokens: [number, number]
  /** US$, low and high; null when no price is known; [0, 0] for no cost. */
  usd: [number, number] | null
  /** Why `usd` is null: no price in any list, or a model whose price varies (a router). */
  unknown?: 'no-price' | 'varies'
  /** On this PC: seconds, low and high. */
  seconds?: [number, number]
  /** The price used (the low end's) and the date of its list (absent for the user's own or a live list). */
  price?: { entry: PriceEntry | { input: number; output: number }; updated?: string }
}

/** A run on this PC longer than this asks first (§11.5). */
export const CONFIRM_LOCAL_S = 600

/** How far an input estimate may be off: ±25% with a known tokenizer, ±40% for a service's, ±60% for pictures (§11.2). */
export const INPUT_SPREAD = { known: 0.25, service: 0.4, pictures: 0.6 } as const

/** Speeds of AI on this PC before one was measured (§18's lower measures), tokens a second; seconds to load. */
export const LOCAL_DEFAULT_SPEED = { read: 300, write: 7 } as const
const LOCAL_LOAD_S: [number, number] = [2, 8]

/** Output tokens a request of the publishing pack writes at Normal length (§11.3); Short halves them. */
const PACK_OUTPUT: Readonly<Record<'youtube' | 'linkedin' | 'xpost' | 'article' | 'releaseNotes', [number, number]>> = {
  youtube: [450, 900],
  linkedin: [250, 500],
  xpost: [60, 90],
  article: [900, 2000],
  releaseNotes: [400, 1000]
}

/** How hard each task thinks (as main asks: aiIpc's EFFORT): what thinking adds to a request's high end. */
const MEDIUM_TASKS: ReadonlySet<AiTextRequest['task']> = new Set(['cleanup', 'translate', 'chapters', 'youtube', 'article', 'releaseNotes'])
const THINKING = { low: 500, medium: 2000 } as const

/** Models that think before they answer (their thinking is billed as output). */
export function thinks(kind: AiProviderKind | 'local', model: string): boolean {
  const m = model.toLowerCase()
  if (kind === 'local') return false
  if (kind === 'anthropic') return /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-(opus|sonnet)-4-[6-9]/.test(m)
  if (kind === 'gemini') return /^gemini-(2\.5|[3-9])/.test(m)
  // OpenAI's reasoning models, and services' that think (gpt-oss, Qwen 3, DeepSeek R1, o-series).
  return /^(o\d|gpt-[5-9])/.test(m) || /(^|\/)(gpt-oss|qwen3|deepseek-r1|o\d)/.test(m)
}

/** The script a translation into `language` (a name as Languages sends it, "Bengali", or a code) is written in; Latin for any other. */
const LANGUAGE_SCRIPTS: Readonly<Record<string, ScriptTag>> = {
  bn: 'bengali', bengali: 'bengali', bangla: 'bengali',
  hi: 'devanagari', hindi: 'devanagari', mr: 'devanagari', marathi: 'devanagari', ne: 'devanagari', nepali: 'devanagari',
  ar: 'arabic', arabic: 'arabic', ur: 'arabic', urdu: 'arabic', fa: 'arabic', persian: 'arabic',
  he: 'hebrew', hebrew: 'hebrew',
  ru: 'cyrillic', russian: 'cyrillic', uk: 'cyrillic', ukrainian: 'cyrillic', bg: 'cyrillic', bulgarian: 'cyrillic', sr: 'cyrillic', serbian: 'cyrillic',
  el: 'greek', greek: 'greek', ta: 'tamil', tamil: 'tamil', te: 'telugu', telugu: 'telugu', th: 'thai', thai: 'thai',
  ko: 'hangul', korean: 'hangul', ja: 'kana', japanese: 'kana', zh: 'han', chinese: 'han'
}
export function languageScript(language: string | undefined): ScriptTag {
  if (!language) return 'latin'
  const l = language.trim().toLowerCase()
  return LANGUAGE_SCRIPTS[l] ?? LANGUAGE_SCRIPTS[l.split(/[-_]/)[0]] ?? 'latin'
}

/** Scripts written without spaces between words. */
const UNSPACED: ReadonlySet<ScriptTag> = new Set(['han', 'kana', 'thai'])

/**
 * Characters per token of ordinary text in `script` for `family`: its letters with the spaces and
 * punctuation that go with them (as the source's ratio is of its whole text), so translating within
 * one script keeps about as many tokens.
 */
export function typicalRatio(script: ScriptTag, family: TokenFamily): number {
  const r = (run: ScriptTag | 'punct'): number => tokenRatio(run, family)
  if (script === 'latin') return 1 / (0.97 / r('latin') + 0.03 / r('punct'))
  if (UNSPACED.has(script)) return 1 / (0.95 / r(script) + 0.05 / r('punct'))
  return 1 / (0.82 / r(script) + 0.15 / r('latin') + 0.03 / r('punct'))
}

/** What a request sends, measured once per request object (§11.1): the estimate updates as the user edits without delay. */
interface Measure {
  requests: number
  words: number
  pictures: number
  /** Tokens of every prompt (instructions, data and schema). */
  promptTokens: number
  pictureTokens: number
  /** Tokens of the captions (or items) alone, their characters per token, and how many. */
  contentTokens: number
  contentRatio: number
  captions: number
  items: number
}

const measures = new WeakMap<object, Map<string, Measure>>()

/** The text of what a request works on: its captions, or its items. */
function contentOf(request: AiTextRequest): { text: string; captions: number; items: number } {
  if (request.task === 'names') {
    const items = request.names?.items ?? []
    return { text: items.map((i) => i.text).join('\n'), captions: 0, items: items.length }
  }
  const segs = request.segments.filter((s) => s.text.trim())
  return { text: segs.map((s) => s.text).join('\n'), captions: segs.length, items: 0 }
}

/** A picture whose size cannot be read is counted at the size the guide sends (§5.3.1: 768 px on the longer side). */
const PICTURE_DEFAULT = { w: 768, h: 432 }

/** The picture rule of a model's price list entry (§11.4), as part of a measure's key. */
type PictureRule = PriceEntry['imageTokens']
const ruleKey = (rule: PictureRule): string => (rule ? `${rule.base}/${rule.perTile}/${rule.tile}` : '-')

function measure(request: AiTextRequest, limits: TextLimits, family: TokenFamily, kind: AiProviderKind, rule?: PictureRule): Measure {
  const key = `${limits.batchSegments}/${limits.batchChars}/${limits.transcriptTokens}/${limits.namesItems}/${limits.namesChars}|${family}|${kind}|${ruleKey(rule)}`
  let byKey = measures.get(request)
  const hit = byKey?.get(key)
  if (hit) return hit
  const prompts = textPrompts(request, limits)
  const m = measurePrompts(prompts, contentOf(request), family, kind, rule)
  if (!byKey) measures.set(request, (byKey = new Map()))
  byKey.set(key, m)
  return m
}

/**
 * What `prompts` send: their text's tokens and their pictures' (§5.3.1): each picture by its own
 * size read from the JPEG, priced by the model's rule in the price list when it has one, else by its
 * provider's (imageTokens).
 */
function measurePrompts(prompts: readonly TextPrompt[], content: { text: string; captions: number; items: number }, family: TokenFamily, kind: AiProviderKind, rule?: PictureRule): Measure {
  let promptTokens = 0
  let pictureTokens = 0
  let pictures = 0
  for (const p of prompts) {
    promptTokens += estimateTokens(p.system, family) + estimateTokens(p.user, family) + estimateTokens(JSON.stringify(p.schema), family)
    for (const img of p.images ?? []) {
      pictures++
      pictureTokens += imageTokens(kind, jpegSize(img.data) ?? PICTURE_DEFAULT, rule)
    }
  }
  return {
    requests: prompts.length,
    words: countWords(content.text),
    pictures,
    promptTokens,
    pictureTokens,
    contentTokens: estimateTokens(content.text, family),
    contentRatio: blendedRatio(content.text, family),
    captions: content.captions,
    items: content.items
  }
}

/** Output tokens of `request` low and high (§11.3), before thinking. */
function outputOf(request: AiTextRequest, m: Measure, family: TokenFamily): [number, number] {
  const short = request.length === 'short' ? 0.5 : 1
  switch (request.task) {
    case 'cleanup':
      return [m.contentTokens + 12 * m.captions, m.contentTokens * 1.15 + 12 * m.captions]
    case 'translate': {
      const factor = m.contentRatio / typicalRatio(languageScript(request.targetLanguage), family)
      return [m.contentTokens * factor * 0.9 + 12 * m.captions, m.contentTokens * factor * 1.2 + 12 * m.captions]
    }
    case 'chapters': {
      const end = request.segments.reduce((a, s) => Math.max(a, s.end), 0)
      return [25, 25 * maxChapters(end)]
    }
    case 'title':
      return [15, 40]
    case 'summary':
      return [80, 300]
    case 'marks':
      return [5 * m.captions, 20 * m.captions]
    case 'names':
      return request.names?.kind === 'note' ? [30 * m.items, 90 * m.items] : [8 * m.items, 25 * m.items]
    case 'youtube':
    case 'linkedin':
    case 'xpost':
    case 'article':
    case 'releaseNotes': {
      const [lo, hi] = PACK_OUTPUT[request.task]
      return [lo * short, hi * short]
    }
  }
}

/** The service a choice's prices are listed under: its kind, a preset at its own host, or none. */
function priceService(choice: TextChoice): string | null {
  if (choice.kind === 'local') return null
  if (!choice.host) return choice.kind
  return SERVICE_PRESETS[presetAt(choice.host)].priceService
}

/** Whether a choice costs nothing: Ollama or LM Studio at its own address (any other address is priced: it may be a paid proxy). */
function isFree(choice: TextChoice): boolean {
  if (!choice.free) return false
  return !choice.host || SERVICE_PRESETS[presetAt(choice.host)].free
}

/** The model's own picture rule in the price list (§5.3.1, §11.4), when it has one. */
function pictureRule(choice: TextChoice, prices: PriceList): PictureRule {
  const service = priceService(choice)
  return service ? (priceOf(prices, service, choice.model)?.imageTokens ?? undefined) : undefined
}

type Rates = { input: number; output: number }
const rates = (e: PriceEntry | Rates | null | undefined): Rates | null => (e && e.input !== undefined && e.output !== undefined ? { input: e.input, output: e.output } : null)

/** What the prices say for a choice: the low end's and the high end's rates, or why none is known. */
function pricesFor(
  choice: TextChoice,
  t: { prices: PriceList; confirmPrices: PriceList; own?: Rates; live?: Rates | 'varies' }
): { low: Rates; high: Rates; price: CostEstimate['price'] } | { unknown: 'no-price' | 'varies' } {
  if (t.own) return { low: t.own, high: t.own, price: { entry: t.own } }
  const service = priceService(choice)
  if (service === 'openrouter') {
    if (t.live === 'varies' || /^openrouter\//.test(choice.model)) return { unknown: 'varies' }
    if (t.live) return { low: t.live, high: t.live, price: { entry: t.live } }
  }
  if (!service) return { unknown: 'no-price' }
  const shown = priceOf(t.prices, service, choice.model)
  const low = rates(shown)
  const high = rates(priceOf(t.confirmPrices, service, choice.model)) ?? low
  if (!low || !high) return { unknown: 'no-price' }
  // Never lower than the shown list either: the high end is the higher of the two, per rate.
  const top = { input: Math.max(low.input, high.input), output: Math.max(low.output, high.output) }
  return { low, high: top, price: { entry: shown!, updated: t.prices.updated } }
}

const round = (n: number): number => Math.max(0, Math.round(n))

/**
 * The estimate of `request` with `target.choice` (§11.1–11.5): its requests, the words and pictures
 * sent, input and output tokens (each a range), and its cost in US$ or, on this PC, its time.
 * `live`: a service's own price for the model this session (OpenRouter's list), or 'varies'.
 */
export function estimateText(
  request: AiTextRequest,
  target: {
    choice: TextChoice
    limits: TextLimits
    prices: PriceList
    confirmPrices: PriceList
    own?: { input: number; output: number }
    speed?: { read: number; write: number }
    calibration?: { input: number; output: number }
    live?: { input: number; output: number } | 'varies'
  }
): CostEstimate {
  const { choice } = target
  const family = tokenFamily(choice.kind, choice.model)
  const kind: AiProviderKind = choice.kind === 'local' ? 'openai' : choice.kind
  const limits = target.limits ?? DEFAULT_TEXT_LIMITS
  const shownRule = pictureRule(choice, target.prices)
  const m = measure(request, limits, family, kind, shownRule)
  const out = outputOf(request, m, family)
  if (thinks(choice.kind, choice.model)) out[1] += m.requests * (MEDIUM_TASKS.has(request.task) ? THINKING.medium : THINKING.low)
  // The low end counts pictures by the shown list's rule; the high end by the most of it, the confirm
  // list's and Flown's own (the bundled list's, else the provider's), so a downloaded rule can raise
  // a confirm but never lower it (§11.4).
  let pictureTokensHigh = m.pictureTokens
  if (m.pictures) {
    const seen = new Set([ruleKey(shownRule)])
    for (const rule of [pictureRule(choice, BUNDLED_PRICE_LIST), pictureRule(choice, target.confirmPrices)]) {
      if (seen.has(ruleKey(rule))) continue
      seen.add(ruleKey(rule))
      pictureTokensHigh = Math.max(pictureTokensHigh, measure(request, limits, family, kind, rule).pictureTokens)
    }
  }
  return finish({ ...m, pictureTokensHigh }, out, choice, target)
}

/** The rest of an estimate once what is sent and what comes back are known. */
function finish(
  m: Pick<Measure, 'requests' | 'words' | 'pictures' | 'promptTokens' | 'pictureTokens'> & { pictureTokensHigh?: number },
  out: [number, number],
  choice: TextChoice,
  target: { prices: PriceList; confirmPrices: PriceList; own?: Rates; speed?: { read: number; write: number }; calibration?: { input: number; output: number }; live?: Rates | 'varies' }
): CostEstimate {
  const spread = choice.host ? INPUT_SPREAD.service : INPUT_SPREAD.known
  const cal = target.calibration ?? { input: 1, output: 1 }
  const inputTokens: [number, number] = [
    round((m.promptTokens * (1 - spread) + m.pictureTokens * (1 - INPUT_SPREAD.pictures)) * cal.input),
    round((m.promptTokens * (1 + spread) + (m.pictureTokensHigh ?? m.pictureTokens) * (1 + INPUT_SPREAD.pictures)) * cal.input)
  ]
  const outputTokens: [number, number] = [round(out[0] * cal.output), round(out[1] * cal.output)]
  const base = { requests: m.requests, words: m.words, pictures: m.pictures, inputTokens, outputTokens }
  if (choice.kind === 'local') {
    const speed = target.speed && target.speed.read > 0 && target.speed.write > 0 ? target.speed : LOCAL_DEFAULT_SPEED
    const seconds: [number, number] = [
      LOCAL_LOAD_S[0] + inputTokens[0] / speed.read + outputTokens[0] / speed.write,
      LOCAL_LOAD_S[1] + inputTokens[1] / speed.read + outputTokens[1] / speed.write
    ]
    return { ...base, usd: [0, 0], seconds }
  }
  if (isFree(choice)) return { ...base, usd: [0, 0] }
  const p = pricesFor(choice, target)
  if ('unknown' in p) return { ...base, usd: null, unknown: p.unknown }
  const usd: [number, number] = [
    (inputTokens[0] * p.low.input + outputTokens[0] * p.low.output) / 1e6,
    (inputTokens[1] * p.high.input + outputTokens[1] * p.high.output) / 1e6
  ]
  return { ...base, usd, ...(p.price ? { price: p.price } : {}) }
}

/**
 * Draft script's estimate (§11.3: the notes' tokens × 1.0 to × 2.0): the one prompt scriptPrompt
 * builds. Thinking widens its high end as a medium-effort task's.
 */
export function estimateScript(
  notes: string,
  target: { choice: TextChoice; prices: PriceList; confirmPrices: PriceList; own?: Rates; speed?: { read: number; write: number }; calibration?: { input: number; output: number }; live?: Rates | 'varies' }
): CostEstimate {
  const { choice } = target
  const family = tokenFamily(choice.kind, choice.model)
  const kind: AiProviderKind = choice.kind === 'local' ? 'openai' : choice.kind
  const m = measurePrompts([scriptPrompt({ notes })], { text: notes, captions: 0, items: 0 }, family, kind)
  const notesTokens = estimateTokens(notes, family)
  const out: [number, number] = [notesTokens, notesTokens * 2]
  if (thinks(choice.kind, choice.model)) out[1] += THINKING.medium
  return finish(m, out, choice, target)
}

/**
 * Transcription's estimate (§11.3): minutes × the price a minute (whisper-1, gpt-transcribe); for
 * Gemini, 32 input tokens a second of sound plus the words written with their times.
 */
export function estimateTranscription(seconds: number, target: { kind: AiProviderKind; model: string; prices: PriceList; confirmPrices?: PriceList }): CostEstimate {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const base: CostEstimate = { requests: 1, words: 0, pictures: 0, inputTokens: [0, 0], outputTokens: [0, 0], usd: null }
  const shown = priceOf(target.prices, target.kind, target.model)
  const high = (target.confirmPrices && priceOf(target.confirmPrices, target.kind, target.model)) || shown
  if (shown?.perMinute !== undefined) {
    const minutes = s / 60
    return { ...base, usd: [minutes * shown.perMinute, minutes * Math.max(shown.perMinute, high?.perMinute ?? 0)], price: { entry: shown, updated: target.prices.updated } }
  }
  if (target.kind === 'gemini') {
    const input: [number, number] = [round(32 * s + 300), round(32 * s + 600)]
    // About 2 to 3 words a second, each written with its times.
    const output: [number, number] = [round(s * 2 * 12), round(s * 3 * 20)]
    const lo = rates(shown)
    const hi = rates(high) ?? lo
    if (!lo || !hi) return { ...base, inputTokens: input, outputTokens: output, unknown: 'no-price' }
    return {
      ...base,
      inputTokens: input,
      outputTokens: output,
      usd: [(input[0] * lo.input + output[0] * lo.output) / 1e6, (input[1] * Math.max(lo.input, hi.input) + output[1] * Math.max(lo.output, hi.output)) / 1e6],
      price: { entry: shown!, updated: target.prices.updated }
    }
  }
  return { ...base, unknown: 'no-price' }
}

/* ---------- words ---------- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "7 November 2026" for '2026-11-07'. */
export function priceDate(updated: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(updated)
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : updated
}

/** US$ amounts as the line writes them: cents below US$100, whole dollars above. */
export function usd(amount: number): string {
  if (amount >= 100) return `US$${Math.round(amount).toLocaleString('en-US')}`
  return `US$${amount.toFixed(2)}`
}

/** "about 40 seconds", "about 4 minutes", "about 2 hours". */
export function aboutTime(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`
  if (seconds < 90 * 60) {
    const m = Math.max(1, Math.round(seconds / 60))
    return `about ${m} ${m === 1 ? 'minute' : 'minutes'}`
  }
  const h = Math.round(seconds / 3600)
  return `about ${h} ${h === 1 ? 'hour' : 'hours'}`
}

/** "about 8,200": two significant figures from a thousand, tens from a hundred. */
export function aboutCount(n: number): string {
  const r = n >= 1000 ? Math.round(n / 10 ** (Math.floor(Math.log10(n)) - 1)) * 10 ** (Math.floor(Math.log10(n)) - 1) : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n)
  return r.toLocaleString('en-US')
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** "1 screenshot", "12 screenshots" (§5.3.1). */
const screenshots = (n: number): string => `${n} ${n === 1 ? 'screenshot' : 'screenshots'}`

/**
 * One action's cost in the line (§11.5's table): "under US$0.01", "about US$0.03", "US$0.02 to
 * US$0.05", "cost unknown", "no cost", or on this PC "about 4 minutes". An unknown price never reads
 * "under US$0.01".
 */
export function costPart(estimate: CostEstimate): string {
  if (estimate.seconds) return aboutTime(estimate.seconds[1])
  const u = estimate.usd
  if (!u) return 'cost unknown'
  if (u[1] <= 0) return 'no cost'
  if (u[1] < 0.01) return 'under US$0.01'
  if (u[1] < 2 * u[0]) return `about ${usd((u[0] + u[1]) / 2)}`
  return u[0] < 0.005 ? `up to ${usd(u[1])}` : `${usd(u[0])} to ${usd(u[1])}`
}

/** Why a cost is unknown, after "Cost unknown for <model>". */
const unknownWhy = (e: CostEstimate): string => (e.unknown === 'varies' ? 'it picks a model for each request' : 'add its prices in Settings')

/** Where a known price comes from, in the full line's brackets. */
function priceSource(e: CostEstimate): string {
  if (!e.price) return ''
  return e.price.updated ? `prices of ${priceDate(e.price.updated)}` : 'your prices'
}

/**
 * The line under a group of AI tools (§2.7, §11.5): what is sent and where, once ("Sends about 8,200
 * words of captions to OpenAI"), then each action's cost ("Chapters about US$0.02 · Title under
 * US$0.01"); `full` (an action alone) the cost with the model and the date of its prices ("· About
 * US$0.03 (gpt-6.1-sol, prices of 7 November 2026)"). On this PC: "Stays on this PC · About 4
 * minutes". `what` names what is sent ("captions", "notes"); `where` the choice's place.
 */
export function costLineText(estimates: readonly { label: string; estimate: CostEstimate }[], where: string, what: string, model: string, full: boolean): string {
  if (!estimates.length) return ''
  const local = estimates.some((e) => e.estimate.seconds)
  const words = Math.max(0, ...estimates.map((e) => e.estimate.words))
  const pictures = Math.max(0, ...estimates.map((e) => e.estimate.pictures))
  // With pictures (§5.3.1): "12 screenshots and about 300 words", or the screenshots alone when nothing was said.
  const said = words ? `about ${aboutCount(words)} words${what && !pictures ? ` of ${what}` : ''}` : pictures ? '' : what || 'it'
  const sent = [pictures ? screenshots(pictures) : '', said].filter(Boolean).join(' and ')
  const head = local ? 'Stays on this PC' : `Sends ${sent} to ${where}`
  const all = estimates.map((e) => e.estimate)
  let tail: string
  if (full || estimates.length === 1) {
    const e = all[0]
    const label = estimates[0].label
    if (e.seconds) tail = full ? cap(aboutTime(e.seconds[1])) : `${label} ${aboutTime(e.seconds[1])}`
    else if (!e.usd) tail = `Cost unknown${model ? ` for ${model}` : ''}: ${unknownWhy(e)}`
    else if (e.usd[1] <= 0) tail = 'No cost'
    else if (full) {
      const bracket = [model, priceSource(e)].filter(Boolean).join(', ')
      tail = `${cap(costPart(e))}${bracket ? ` (${bracket})` : ''}`
    } else tail = `${label} ${costPart(e)}`
  } else if (all.every((e) => !e.seconds && !e.usd)) {
    tail = `Cost unknown${model ? ` for ${model}` : ''}: ${unknownWhy(all[0])}`
  } else if (all.every((e) => !e.seconds && e.usd && e.usd[1] <= 0)) {
    tail = 'No cost'
  } else {
    tail = estimates.map((e) => `${e.label} ${costPart(e.estimate)}`).join(' · ')
  }
  return `${head} · ${tail}`
}

/**
 * The short sentence a button's aria-describedby reads (§11.5): "About US$0.02; sends your captions
 * to OpenAI." / "About 4 minutes; stays on this PC."
 */
export function costSentence(estimate: CostEstimate, where: string, what = 'your text'): string {
  if (estimate.seconds) return `${cap(aboutTime(estimate.seconds[1]))}; stays on this PC.`
  // With pictures (§5.3.1): "About US$0.04; sends 12 screenshots and the steps' narration to OpenAI."
  const sent = estimate.pictures ? `${screenshots(estimate.pictures)}${estimate.words ? ` and ${what}` : ''}` : what
  return `${cap(costPart(estimate))}; sends ${sent} to ${where}.`
}

/** The amount `pref` asks above, US$: null for 'never', 0 for 'always' (every paid run). */
const ASK_ABOVE: Readonly<Record<ConfirmPref, number | null>> = { always: 0, '0.1': 0.1, '1': 1, '5': 5, never: null }

/**
 * Whether a click asks first (§11.5): a paid run whose high end passes the amount of pref `aiConfirm`
 * ('always': every paid run; 'never': none); an unknown cost once per (provider, model) in a session
 * (`askedUnknown`: already asked), not with 'never'; on this PC a run longer than 10 minutes.
 */
export function needsConfirm(estimate: CostEstimate, pref: ConfirmPref, askedUnknown: boolean): boolean {
  if (estimate.seconds) return estimate.seconds[1] > CONFIRM_LOCAL_S
  const above = ASK_ABOVE[pref] ?? ASK_ABOVE['1']
  if (pref === 'never' || above === null) return false
  if (!estimate.usd) return !askedUnknown
  if (estimate.usd[1] <= 0) return false
  return estimate.usd[1] > above
}

/** The question a confirm asks (§2.7). */
export function confirmText(estimate: CostEstimate, model: string): { text: string; action: string } {
  if (estimate.seconds) return { text: `This takes ${aboutTime(estimate.seconds[1])} on this PC. You can keep editing meanwhile. Start?`, action: 'Start' }
  if (!estimate.usd) return { text: `Flown does not know what this costs with ${model}. Run it?`, action: 'Run' }
  return { text: `This costs up to about ${usd(estimate.usd[1])} with ${model}. Run it?`, action: 'Run' }
}

/**
 * After a run with a service (§11.6): "Cost about US$0.03 (12,400 tokens)." from the tokens it
 * reported and the price the estimate used; the tokens alone without a price; nothing without usage.
 */
export function usageText(usage: AiUsage | null | undefined, price: CostEstimate['price'] | null | undefined): string {
  if (!usage || !(usage.input >= 0) || !(usage.output >= 0)) return ''
  const tokens = `${Math.round(usage.input + usage.output).toLocaleString('en-US')} tokens`
  const r = price ? rates(price.entry as PriceEntry) : null
  if (!r) return `It used ${tokens}.`
  const cost = (usage.input * r.input + usage.output * r.output) / 1e6
  if (cost <= 0) return `No cost (${tokens}).`
  return `Cost ${cost < 0.01 ? 'under US$0.01' : `about ${usd(cost)}`} (${tokens}).`
}

/** Several actions run at once (Write all): their requests, tokens, cost and time added up; unknown when any is. */
export function sumEstimates(list: readonly CostEstimate[]): CostEstimate | null {
  if (!list.length) return null
  const add = (a: [number, number], b: [number, number]): [number, number] => [a[0] + b[0], a[1] + b[1]]
  let out: CostEstimate = { ...list[0] }
  for (const e of list.slice(1)) {
    out = {
      ...out,
      requests: out.requests + e.requests,
      words: Math.max(out.words, e.words),
      pictures: out.pictures + e.pictures,
      inputTokens: add(out.inputTokens, e.inputTokens),
      outputTokens: add(out.outputTokens, e.outputTokens),
      usd: out.usd && e.usd ? add(out.usd, e.usd) : null,
      ...(out.usd && e.usd ? {} : { unknown: out.unknown ?? e.unknown ?? 'no-price' }),
      ...(out.seconds || e.seconds ? { seconds: add(out.seconds ?? [0, 0], e.seconds ?? [0, 0]) } : {})
    }
  }
  return out
}
