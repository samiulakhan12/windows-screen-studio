/**
 * Keys and tokens (docs/design/auto-blur.md §6.4): the 36 strong rules translated from gitleaks
 * v8.30.1, run on the prefix view, and PEM BEGIN lines (dashes not required). A payload with XXXX,
 * xxxxxx, eight zeros, ****, .... or at most two distinct characters in its last 12 is a placeholder;
 * the allow list and AWS's `…EXAMPLE` ids are skipped. Checksums are not checked: one misread
 * character breaks them, and the cover needs only the place. Pure.
 */
import type { CleanLine } from './clean'
import { lineHit, type Hit, type LineContext } from './score'
import { isAllowed, PLACEHOLDER_PAYLOAD, STRONG_RULES } from './tables'

const PRIVATE_KEY = STRONG_RULES.find((r) => r.id === 'private-key')!
const TOKEN_RULES = STRONG_RULES.filter((r) => r.id !== 'private-key')

/** Whether a strong rule's match is a placeholder or an allow-listed example. */
export function notAKey(rule: string, value: string): boolean {
  if (isAllowed(value)) return true
  if (PLACEHOLDER_PAYLOAD.test(value) || new Set(value.slice(-12)).size <= 2) return true
  if (rule === 'aws-id' && /EXAMPLE$/.test(value)) return true
  return false
}

/** Whether a line is a PEM BEGIN line of a private key. */
export function pemBegin(line: CleanLine): boolean {
  PRIVATE_KEY.pattern.lastIndex = 0
  const hit = PRIVATE_KEY.pattern.test(line.text)
  PRIVATE_KEY.pattern.lastIndex = 0
  return hit
}

/** Strong keys and tokens on a line, and a PEM BEGIN line (the whole line). */
export function findKeys(line: CleanLine, ctx: LineContext): Hit[] {
  const out: Hit[] = []
  if (pemBegin(line)) out.push(lineHit(ctx, 'key', 'private-key', 0, line.text.length, PRIVATE_KEY.score))
  const pv = line.prefix
  if (pv.length < 12) return out
  for (const r of TOKEN_RULES) {
    for (const m of pv.matchAll(r.pattern)) {
      const v = m[0]
      if (notAKey(r.id, v)) continue
      out.push(lineHit(ctx, 'key', r.id, m.index!, m.index! + v.length, r.score))
    }
  }
  return out
}

/** Whether `text` (one token, cleaned) holds a strong key or token on its own (the wrap join and one space in a key, §6.10). */
export function strongHits(text: string): { rule: string; start: number; end: number; score: number }[] {
  const out: { rule: string; start: number; end: number; score: number }[] = []
  for (const r of TOKEN_RULES) for (const m of text.matchAll(r.pattern)) if (!notAKey(r.id, m[0])) out.push({ rule: r.id, start: m.index!, end: m.index! + m[0].length, score: r.score })
  return out
}
