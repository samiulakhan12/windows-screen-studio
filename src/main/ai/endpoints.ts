/**
 * Test hooks for the AI providers: SSW_AI_BASE_URL_OPENAI / _GEMINI / _ANTHROPIC point a
 * provider at another server (a local mock in the end-to-end tests), and SSW_AI_MAX_PART_SECONDS
 * / SSW_AI_GEMINI_INLINE_BYTES make recordings split into parts and Gemini use its Files API at
 * test sizes. Like SSW_CAPTURE_HELPER (nativeCapture.ts), a packaged app ignores them: its
 * requests only ever go to the providers themselves, with the user's key.
 */
import { app } from 'electron'
import type { AiProviderKind } from '../../shared/types'

const env = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name] || undefined)

/** The base URL to use for `kind` instead of the provider's own; undefined in packaged builds. */
export function baseUrlOverride(kind: AiProviderKind): string | undefined {
  const url = env(`SSW_AI_BASE_URL_${kind.toUpperCase()}`)
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? url.replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

/** A positive number from a test hook; undefined in packaged builds. */
export function testLimit(name: 'SSW_AI_MAX_PART_SECONDS' | 'SSW_AI_GEMINI_INLINE_BYTES'): number | undefined {
  const n = Number(env(name))
  return Number.isFinite(n) && n > 0 ? n : undefined
}
