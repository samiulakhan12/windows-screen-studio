/**
 * Numbers in captions (docs/design/captions-studio.md §11.4): statistics for counters, and
 * spelled-out numbers.
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written.
 */
import type { CaptionSegment } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** The numbers of a caption (word spans), with what a counter needs and whether each is a statistic. */
export function findNumbers(
  seg: CaptionSegment,
  language?: string
): { from: number; to: number; value: number; start?: number; decimals: 0 | 1 | 2; prefix: string; suffix: string; label?: string; statistic: boolean }[] {
  return notImplemented('findNumbers', seg, language)
}

/** A spelled-out number at the start of `words` ("twenty five"), and how many words it used. */
export function parseNumberWords(words: readonly string[], language?: string): { value: number; used: number } | null {
  return notImplemented('parseNumberWords', words, language)
}
