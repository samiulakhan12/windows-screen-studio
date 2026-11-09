/**
 * How far the token estimates were off (docs/design/smart-tools.md §11.6): userData/ai-usage.json
 * keeps, per (kind or host, model, task), the ratio of the tokens a provider reported to the tokens
 * estimated, for input and output, blended (0.7 × old + 0.3 × new) and clamped to 0.5..2.0. Later
 * estimates are multiplied by it (the renderer reads the ratios through ai:usage). It holds no text: keys are made of a provider kind or host, a model
 * name and a task, each checked. At most 200 entries, the oldest dropped. Written atomically.
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AiUsage } from '../../shared/api/ai'
import { estimateTokens } from '../../shared/ai/tokens'
import { USAGE_KEY_RE as KEY_RE, USAGE_RATIO, usageKey, type UsageRatios } from '../../shared/ai/usageKey'
import type { TextPrompt } from '../../shared/captions/transcriptText'
import { writeFileAtomicSync } from '../atomicWrite'

export { usageKey } from '../../shared/ai/usageKey'

export const USAGE_FILE = 'ai-usage.json'
export const USAGE_LIMITS = { entries: USAGE_RATIO.entries, min: USAGE_RATIO.min, max: USAGE_RATIO.max, keep: 0.7 } as const

interface Entry {
  input: number
  output: number
  /** When it was last updated (ISO), to drop the oldest. */
  at: string
}

let file: string | null = null
let entries: Map<string, Entry> | null = null

/** Uses `path` for the file (tests); null: userData's. */
export function useUsageFile(at: string | null): void {
  file = at
  entries = null
}

function fileOf(): string | null {
  if (file) return file
  try {
    return path.join(app.getPath('userData'), USAGE_FILE)
  } catch {
    return null
  }
}

const ratioOk = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= USAGE_LIMITS.min && n <= USAGE_LIMITS.max
const clamp = (n: number): number => Math.min(USAGE_LIMITS.max, Math.max(USAGE_LIMITS.min, n))

function load(): Map<string, Entry> {
  if (entries) return entries
  entries = new Map()
  const f = fileOf()
  if (!f) return entries
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return entries
  }
  const list = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : null
  if (!list || typeof list !== 'object' || Array.isArray(list)) return entries
  for (const [key, v] of Object.entries(list as Record<string, unknown>)) {
    if (entries.size >= USAGE_LIMITS.entries) break
    const e = v as Partial<Entry> | null
    if (KEY_RE.test(key) && e && ratioOk(e.input) && ratioOk(e.output) && typeof e.at === 'string') entries.set(key, { input: e.input, output: e.output, at: e.at })
  }
  return entries
}

/** The ratios later estimates of `key` are multiplied by (1 and 1 before any run). */
export function calibration(key: string): { input: number; output: number } {
  const e = load().get(key)
  return e ? { input: e.input, output: e.output } : { input: 1, output: 1 }
}

/** Every key's ratios (ai:usage), for the estimates the renderer makes: no dates, no text. */
export function usageRatios(): UsageRatios {
  const out: Record<string, { input: number; output: number }> = {}
  for (const [key, e] of load()) out[key] = { input: e.input, output: e.output }
  return out
}

/**
 * Keeps how `used` (the tokens a provider reported) compares with `estimated` for `key`: each ratio
 * blended into the one kept and clamped to 0.5..2.0. Nothing for a key that is not one, or an
 * estimate of 0.
 */
export async function recordUsage(key: string, estimated: { input: number; output: number }, used: AiUsage, now = new Date()): Promise<void> {
  if (!KEY_RE.test(key)) return
  const all = load()
  const old = all.get(key) ?? { input: 1, output: 1, at: '' }
  const blend = (before: number, est: number, got: number): number => (est > 0 && Number.isFinite(got) && got >= 0 ? clamp(USAGE_LIMITS.keep * before + (1 - USAGE_LIMITS.keep) * (got / est)) : before)
  all.delete(key)
  all.set(key, { input: blend(old.input, estimated.input, used.input), output: blend(old.output, estimated.output, used.output), at: now.toISOString() })
  // The oldest dropped past 200.
  const sorted = [...all.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at))
  while (sorted.length > USAGE_LIMITS.entries) all.delete(sorted.shift()![0])
  const f = fileOf()
  if (!f) return
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    writeFileAtomicSync(f, JSON.stringify({ version: 1, entries: Object.fromEntries(all) }, null, 2))
  } catch (err) {
    console.warn('Could not keep the AI usage figures:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * After a request a provider reported its tokens for: compares them with the estimate of the prompt
 * sent and of the answer written (tokens.ts) and keeps the ratios under (kind or host, model, the
 * prompt's task). A prompt with pictures (smart-tools.md §5.3.1) is left out: their tokens follow
 * each provider's own rule, not the text's, and would skew the text's ratio. Never throws; nothing
 * of the text is kept.
 */
export function noteUsage(kindOrHost: string, model: string, prompt: Pick<TextPrompt, 'name' | 'system' | 'user' | 'schema' | 'images'>, answer: string, used: AiUsage): void {
  if (prompt.images?.length) return
  try {
    const key = usageKey(kindOrHost, model, prompt.name)
    if (!key) return
    const family = kindOrHost === 'anthropic' ? 'claude' : 'o200k'
    const input = estimateTokens(prompt.system, family) + estimateTokens(prompt.user, family) + estimateTokens(JSON.stringify(prompt.schema), family)
    const output = estimateTokens(answer, family)
    void recordUsage(key, { input, output }, used).catch(() => undefined)
  } catch {
    // Figures only: a run never fails for them.
  }
}
