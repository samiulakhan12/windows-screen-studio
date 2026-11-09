/**
 * What an AI action would cost with a choice (docs/design/smart-tools.md §11.1, §11.4): the estimate
 * of its request from the price list main shows, the higher prices a confirm uses (the bundled list's
 * and the downloaded one's, per model), the user's own prices (pref aiPrices, by provider), a
 * service's live prices this session (OpenRouter's, from its model list), and on this PC the speeds
 * measured. The data is read once and shared by every cost line; estimates are remembered per
 * request, so the line follows edits without delay.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AiTextRequest, AiUsage, ListedModel, TextChoice } from '../../../shared/api/ai'
import type { LocalAiState } from '../../../shared/api/localAi'
import { estimateScript, estimateText, estimateTranscription, usageText, type CostEstimate } from '../../../shared/ai/cost'
import { BUNDLED_PRICE_LIST, confirmList, parsePriceList, type PriceList } from '../../../shared/ai/prices'
import { DEFAULT_TEXT_LIMITS } from '../../../shared/captions/transcriptText'
import { DEFAULT_CONFIRM, sanitizeSmartPref, type ConfirmPref } from '../../../shared/smart/smartPrefs'
import type { AiProviderKind } from '../../../shared/types'
import { AI_PROVIDERS_CHANGED_EVENT } from '../settings/SettingsButton'

/** What every estimate is made from. */
export interface CostData {
  /** The list shown (the newer of the bundled and downloaded ones). */
  shown: PriceList
  /** Per model, the higher of the bundled and shown prices: what the high end and a confirm use. */
  confirm: PriceList
  /** The user's own prices, by provider id (pref aiPrices). */
  own: Readonly<Record<string, { input: number; output: number }>>
  /** AI on this PC: the model a run would use and the speeds measured. */
  local: { active: string | null; speeds: LocalAiState['speeds'] }
  /** Models a provider listed this session, by provider id (Load models). */
  listed: ReadonlyMap<string, readonly ListedModel[]>
  /** When a click asks first (pref aiConfirm). */
  ask: ConfirmPref
}

const today = (): string => new Date().toISOString().slice(0, 10)

let data: CostData = { shown: BUNDLED_PRICE_LIST, confirm: BUNDLED_PRICE_LIST, own: {}, local: { active: null, speeds: {} }, listed: new Map(), ask: DEFAULT_CONFIRM }
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

const changed = (patch: Partial<CostData>): void => {
  data = { ...data, ...patch }
  for (const l of [...listeners]) l()
}

/** Reads the price list, the user's prices and this PC's speeds again (each kept as it was when it cannot be read). */
export function refreshCostData(): Promise<void> {
  const api = (typeof window !== 'undefined' ? (window as { api?: Partial<typeof window.api> }).api : undefined) ?? {}
  loading = Promise.all([
    Promise.resolve()
      .then(() => api.getAiPriceList?.())
      .then((raw) => {
        // Main checked it; read again here all the same (a list is taken whole or not at all).
        const list = raw ? parsePriceList(raw, today()) : null
        if (list) changed({ shown: list, confirm: confirmList(BUNDLED_PRICE_LIST, list) })
      })
      .catch(() => undefined),
    Promise.resolve()
      .then(() => api.getPref?.('aiPrices'))
      .then((raw) => changed({ own: (sanitizeSmartPref('aiPrices', raw) as CostData['own'] | null) ?? {} }))
      .catch(() => undefined),
    Promise.resolve()
      .then(() => api.getPref?.('aiConfirm'))
      .then((raw) => changed({ ask: (sanitizeSmartPref('aiConfirm', raw) as ConfirmPref | null) ?? DEFAULT_CONFIRM }))
      .catch(() => undefined),
    Promise.resolve()
      .then(() => api.localAiState?.())
      .then((s) => {
        if (s && typeof s === 'object') changed({ local: { active: s.active ?? null, speeds: s.speeds ?? {} } })
      })
      .catch(() => undefined)
  ]).then(() => undefined)
  return loading
}

/** Keeps the models a provider listed (the combobox's Load models): OpenRouter's prices then win over the file for the session. */
export function rememberListedModels(providerId: string, models: readonly ListedModel[]): void {
  const listed = new Map(data.listed)
  listed.set(providerId, models)
  changed({ listed })
}

/** The cost data now (tests, and code outside React). */
export const costData = (): CostData => data

/** The cost data once read (read now when no cost line has read it yet): for a run asked about outside a cost line. */
export async function readCostData(): Promise<CostData> {
  await (loading ?? refreshCostData())
  return data
}

/** The cost data, kept up to date: read on first use, again when providers or prices change. */
export function useCostData(): CostData {
  const [, setTick] = useState(0)
  useEffect(() => {
    const l = (): void => setTick((n) => n + 1)
    listeners.add(l)
    if (!loading) void refreshCostData()
    const again = (): void => void refreshCostData()
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener(AI_PROVIDERS_CHANGED_EVENT, again)
    return () => {
      listeners.delete(l)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, again)
    }
  }, [])
  return data
}

/** A service's own price for `choice`'s model this session: OpenRouter's list's, or 'varies'. */
function liveOf(choice: TextChoice, d: CostData): { input: number; output: number } | 'varies' | undefined {
  const m = d.listed.get(choice.id)?.find((x) => x.id === choice.model)
  return m?.prices
}

/** The target an estimate of `choice` is made with. */
function targetOf(choice: TextChoice, d: CostData) {
  const own = d.own[choice.id]
  const live = liveOf(choice, d)
  const speed = choice.kind === 'local' && d.local.active ? d.local.speeds[d.local.active as keyof LocalAiState['speeds']] : undefined
  const local: TextChoice = choice.kind === 'local' && d.local.active ? { ...choice, model: d.local.active } : choice
  return { choice: local, prices: d.shown, confirmPrices: d.confirm, ...(own ? { own } : {}), ...(live ? { live } : {}), ...(speed ? { speed } : {}) }
}

/**
 * A cheap fingerprint of what a request sends: the task and its options, and the captions' or
 * items' count, ids, times and lengths. Pickers build a new request object each render; an unchanged
 * fingerprint reuses the estimate.
 */
function fingerprint(r: AiTextRequest): string {
  let chars = 0
  for (const s of r.segments) chars += s.text.length
  const items = r.names?.items ?? []
  let itemChars = 0
  for (const i of items) itemChars += i.text.length + (i.action?.length ?? 0) + (i.image?.byteLength ?? 0)
  const first = r.segments[0]
  const last = r.segments[r.segments.length - 1]
  return [
    r.task,
    r.targetLanguage ?? '',
    r.tone ?? '',
    r.length ?? '',
    r.context ? JSON.stringify(r.context).length : 0,
    r.marks?.language ?? '',
    r.segments.length,
    chars,
    first ? `${first.id}@${first.start}` : '',
    last ? `${last.id}@${last.end}` : '',
    r.names ? `${r.names.kind}/${r.names.language ?? ''}/${items.length}/${itemChars}` : ''
  ].join('|')
}

const cache = new Map<string, CostEstimate>()
let cacheData: CostData | null = null

/** The estimate of `request` with `choice` and `d` (null for no choice or request), remembered by fingerprint. */
export function estimateFor(choice: TextChoice | null, request: AiTextRequest | null, d: CostData = data): CostEstimate | null {
  if (!choice || !request) return null
  if (cacheData !== d) {
    cache.clear()
    cacheData = d
  }
  const key = `${choice.id}|${choice.kind}|${choice.model}|${choice.host ?? ''}|${choice.free ? 1 : 0}|${fingerprint(request)}`
  const hit = cache.get(key)
  if (hit) return hit
  const estimate = estimateText(request, { ...targetOf(choice, d), limits: DEFAULT_TEXT_LIMITS })
  if (cache.size > 64) cache.delete(cache.keys().next().value as string)
  cache.set(key, estimate)
  return estimate
}

/** Draft script's estimate: the notes it sends. */
export function estimateNotes(choice: TextChoice | null, notes: string | null, d: CostData = data): CostEstimate | null {
  if (!choice || !notes?.trim()) return null
  return estimateScript(notes, targetOf(choice, d))
}

/** Transcription's estimate: the recording's minutes with the provider's transcription model. */
export function estimateSound(kind: AiProviderKind, model: string, seconds: number, d: CostData = data): CostEstimate {
  return estimateTranscription(seconds, { kind, model, prices: d.shown, confirmPrices: d.confirm })
}

/** The estimate of one request with one choice (§11.1), kept up to date as the price data changes. */
export function useCost(choice: TextChoice | null, request: AiTextRequest | null): CostEstimate | null {
  const d = useCostData()
  return useMemo(() => estimateFor(choice, request, d), [choice, request, d])
}

/** The price an estimate of `choice` uses now (the user's own, a live list's, or the price list's), or null. */
export function priceFor(choice: TextChoice, d: CostData = data): CostEstimate['price'] | null {
  if (choice.kind === 'local') return null
  const t = targetOf(choice, d)
  if (t.own) return { entry: t.own }
  if (t.live && t.live !== 'varies') return { entry: t.live }
  const e = estimateText({ task: 'title', segments: [] }, { ...t, limits: DEFAULT_TEXT_LIMITS })
  return e.price ?? null
}

/**
 * What a finished run cost (§11.6), for the tool's notice: "Cost about US$0.03 (12,400 tokens)." from
 * the tokens the provider reported; empty on this PC, at no cost, or when nothing was reported.
 */
export function runCostText(usage: AiUsage | null | undefined, choice: TextChoice | null): string {
  if (!usage || !choice || choice.kind === 'local' || choice.free) return ''
  return usageText(usage, priceFor(choice))
}
