/**
 * The cost up front (docs/design/smart-tools.md §11): estimates from the exact prompts and the price
 * list, the line's words and when to ask first. Part P5 writes this file; the contracts' stub gives
 * its types and exported names, with an estimate that knows no price.
 */
import type { AiTextRequest, TextChoice } from '../api/ai'
import type { TextLimits } from '../captions/transcriptText'
import type { AiProviderKind } from '../types'
import type { PriceEntry, PriceList } from './prices'
import type { ConfirmPref } from '../smart/smartPrefs'

export type { ConfirmPref } from '../smart/smartPrefs'

export interface CostEstimate {
  requests: number
  words: number
  pictures: number
  inputTokens: [number, number]
  outputTokens: [number, number]
  usd: [number, number] | null
  unknown?: 'no-price' | 'varies'
  seconds?: [number, number]
  price?: { entry: PriceEntry | { input: number; output: number }; updated?: string }
}

/** A run on this PC longer than this asks first (§11.5). */
export const CONFIRM_LOCAL_S = 600

const NONE: CostEstimate = { requests: 0, words: 0, pictures: 0, inputTokens: [0, 0], outputTokens: [0, 0], usd: null, unknown: 'no-price' }

export function estimateText(
  request: AiTextRequest,
  target: { choice: TextChoice; limits: TextLimits; prices: PriceList; confirmPrices: PriceList; own?: { input: number; output: number }; speed?: { read: number; write: number }; calibration?: { input: number; output: number } }
): CostEstimate {
  void request
  void target
  return { ...NONE }
}

export function estimateTranscription(seconds: number, target: { kind: AiProviderKind; model: string; prices: PriceList }): CostEstimate {
  void seconds
  void target
  return { ...NONE }
}

export function costPart(estimate: CostEstimate): string {
  void estimate
  return 'cost unknown'
}

export function costLineText(estimates: readonly { label: string; estimate: CostEstimate }[], where: string, what: string, model: string, full: boolean): string {
  void estimates
  void what
  void model
  void full
  return `Sends ${what} to ${where}`
}

export function costSentence(estimate: CostEstimate, where: string): string {
  void estimate
  return `Sends it to ${where}.`
}

export function needsConfirm(estimate: CostEstimate, pref: ConfirmPref, askedUnknown: boolean): boolean {
  void estimate
  void pref
  void askedUnknown
  return false
}
