/**
 * The kinds that are off by default (docs/design/auto-blur.md §6.12): street addresses (Check, 0.60)
 * by a house number and a street word on one line (either order), or a postcode shape on the line
 * below such a line; random-looking text (Check, 0.55) of 24 or more token characters of two classes
 * with entropy 4.0 or more. Password dots are found with passwords (labels.ts). Each runs only when
 * its kind is on. Pure.
 */
import type { CleanLine } from './clean'
import { entropy } from './labels'
import { lineHit, taken, type Hit, type LineContext } from './score'
import { BLOCK_ADDRESS, POSTCODE, RANDOM_STRING, STREET, STREET_FIRST } from './tables'

/** Street addresses on a line (when 'address' is on): from the house number or street word to the line's end (the town and postcode follow), or a postcode under an address line. */
export function findAddresses(line: CleanLine, ctx: LineContext): Hit[] {
  if (!ctx.kinds.has('address')) return []
  const t = line.text
  const starts = [STREET.exec(t), STREET_FIRST.exec(t), BLOCK_ADDRESS.exec(t)].filter((m): m is RegExpExecArray => !!m).map((m) => m.index)
  if (starts.length) {
    const s = Math.min(...starts)
    return [lineHit(ctx, 'address', 'street', s, t.trimEnd().length, 0.6)]
  }
  if (ctx.above && (STREET.test(ctx.above.text) || STREET_FIRST.test(ctx.above.text))) {
    const post = POSTCODE.exec(t)
    if (post) return [lineHit(ctx, 'address', 'postcode', post.index, post.index + post[0].length, 0.6)]
  }
  return []
}

/** Random-looking text on a line (when 'random' is on), where no other rule found something. */
export function findRandom(line: CleanLine, ctx: LineContext): Hit[] {
  if (!ctx.kinds.has('random')) return []
  const out: Hit[] = []
  for (const m of line.text.matchAll(RANDOM_STRING)) {
    const v = m[0]
    if (taken(ctx, m.index!)) continue
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length
    if (classes < 2 || entropy(v) < 4.0) continue
    out.push(lineHit(ctx, 'random', 'random-string', m.index!, m.index! + v.length, 0.55))
  }
  return out
}

/** The off-by-default kinds on a line. */
export function findExtra(line: CleanLine, ctx: LineContext): Hit[] {
  return [...findAddresses(line, ctx), ...findRandom(line, ctx)]
}
