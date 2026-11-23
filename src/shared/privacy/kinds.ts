/**
 * What Find looks for (docs/design/auto-blur.md §2.5, §0 decision 2) and the scores that make a
 * suggestion Auto or Check (§6.1). Pure.
 */
import type { PrivateKind } from '../types'

/** Every kind, in the Find dialog's order (§2.5), then 'text' (Cover this text everywhere). */
export const PRIVATE_KINDS: readonly PrivateKind[] = Object.freeze(['password', 'code', 'qr', 'key', 'link', 'email', 'card', 'phone', 'id', 'name', 'notice', 'address', 'dots', 'random', 'text'] as const)

/** The kinds on by default (decision 2): everything but street addresses, password dots and random-looking text. */
export const DEFAULT_KINDS: readonly PrivateKind[] = Object.freeze(['password', 'code', 'qr', 'key', 'link', 'email', 'card', 'phone', 'id', 'name', 'notice'] as const)

/** The kinds a secret said aloud can be (§7.2). */
export const SAID_KINDS: readonly PrivateKind[] = Object.freeze(['card', 'code', 'phone', 'id', 'password', 'email', 'name'] as const)

/** A suggestion scored this or more is Auto (§6.1). */
export const AUTO_SCORE = 0.85
/** A suggestion scored this or more (and under AUTO_SCORE) is Check; under it, nothing is suggested. */
export const CHECK_SCORE = 0.5

/** The tier of a score: 'auto', 'check', or null (not suggested, or not a finite score). */
export function tierOf(score: number): 'auto' | 'check' | null {
  if (!Number.isFinite(score)) return null
  if (score >= AUTO_SCORE) return 'auto'
  if (score >= CHECK_SCORE) return 'check'
  return null
}

/** Dark: the `--surface-2` token's colour, used when a ring's colours are too mixed (§8.4) and for unreadable colours. */
export const COVER_DARK = '#1c1c22'

/** The colour chips of a selected cover and of Settings (§2.2, §2.14). */
export const COVER_COLOURS: Readonly<Record<'dark' | 'light' | 'black' | 'white', string>> = Object.freeze({
  dark: COVER_DARK,
  light: '#e8e8ee',
  black: '#000000',
  white: '#ffffff'
})

/** Whether `v` is one of PRIVATE_KINDS. */
export const isPrivateKind = (v: unknown): v is PrivateKind => typeof v === 'string' && (PRIVATE_KINDS as readonly string[]).includes(v)
