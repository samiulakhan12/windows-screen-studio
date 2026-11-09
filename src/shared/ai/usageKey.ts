/**
 * How far the token estimates were off (docs/design/smart-tools.md §11.6), as main keeps it
 * (src/main/ai/usage.ts) and the estimates read it (cost.ts): ratios of reported to estimated tokens
 * per key, a provider kind or host, a model name and a prompt's name joined by "|" (no text). Pure.
 */

/** A key: kind or host, model, the prompt's name, joined by "|"; nothing else (no text). */
export const USAGE_KEY_RE = /^[a-z0-9.:[\]-]{1,260}\|[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}\|[a-z_]{1,40}$/

/** The ratios kept: each between 0.5 and 2.0; at most 200 keys. */
export const USAGE_RATIO = { min: 0.5, max: 2, entries: 200 } as const

/** Ratios of reported to estimated input and output tokens, by key. */
export type UsageRatios = Readonly<Record<string, { input: number; output: number }>>

/** The key of a provider's model and prompt: "openai|gpt-6.1-sol|summary", "api.groq.com|llama|names"; null when any part is not one. */
export function usageKey(kindOrHost: string, model: string, task: string): string | null {
  const key = `${kindOrHost.toLowerCase()}|${model}|${task}`
  return USAGE_KEY_RE.test(key) ? key : null
}

const ratioOk = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= USAGE_RATIO.min && n <= USAGE_RATIO.max

/** `raw` read as ratios (what main sent): keys and ratios checked, anything else left out. */
export function readUsageRatios(raw: unknown): UsageRatios {
  const out: Record<string, { input: number; output: number }> = Object.create(null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let n = 0
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= USAGE_RATIO.entries) break
    const r = v as { input?: unknown; output?: unknown } | null
    if (!USAGE_KEY_RE.test(key) || !r || typeof r !== 'object' || !ratioOk(r.input) || !ratioOk(r.output)) continue
    out[key] = { input: r.input, output: r.output }
    n++
  }
  return out
}
