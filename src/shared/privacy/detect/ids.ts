/**
 * ID numbers (docs/design/auto-blur.md §6.8): US social security numbers without the SSA's
 * never-assigned areas, groups and serials (0.85; 0.95 labelled); UK National Insurance numbers by
 * HMRC's prefix rules (0.85); a value of 4-30 characters, half or more digits, after, under or beside
 * an ID label, every label on a line counting (0.85); Windows product keys (0.90, kind 'key') and
 * licence keys after their label (0.85). Pure.
 */
import { asciiDigits } from '../../captions/numbers'
import type { CleanLine } from './clean'
import { afterLabel, besideLabel, labelHits, labelled, underLabel } from './labels'
import { lineHit, taken, type Hit, type LineContext } from './score'
import { ID_SEPARATOR, ID_VALUE, isAllowed, LICENCE_VALUE, NINO, PLACEHOLDER_PAYLOAD, PRODUCT_KEY, SSN } from './tables'

/** SSNs, NI numbers, labelled IDs and licence keys on a line. */
export function findIds(line: CleanLine, ctx: LineContext): Hit[] {
  const out: Hit[] = []
  const has = (s: number): boolean => taken({ ...ctx, found: [...ctx.found, ...out] }, s)
  if (/\d/.test(line.digit)) {
    for (const m of line.digit.matchAll(SSN)) {
      const [all, area, , group, serial] = m
      if (area === '000' || area === '666' || area[0] === '9' || group === '00' || serial === '0000') continue
      if (isAllowed(area + group + serial)) continue
      out.push(lineHit(ctx, 'id', 'ssn', m.index!, m.index! + all.length, labelled(line, ctx, 'id') ? 0.95 : 0.85))
    }
    for (const m of line.text.matchAll(NINO)) out.push(lineHit(ctx, 'id', 'uk-nino', m.index!, m.index! + m[0].length, 0.85))
  }
  // Labelled IDs: after each label on the line, under a short label line, or beside a label box.
  const values: { s: number; v: string }[] = []
  for (const h of labelHits(line, 'id')) {
    const rest = line.digit.slice(h.end)
    const sep = ID_SEPARATOR.exec(rest)!
    const v = ID_VALUE.exec(rest.slice(sep[0].length))
    if (v) values.push({ s: h.end + sep[0].length, v: v[0].replace(/[ -]+$/, '') })
  }
  const u = underLabel(line, ctx, 'id') ?? besideLabel(line, ctx, 'id')
  if (u) values.push({ s: u.s, v: asciiDigits(u.v) })
  for (const hit of values) {
    const digits = (hit.v.match(/\d/g) ?? []).length
    if (digits >= 4 && digits / hit.v.replace(/[ -]/g, '').length >= 0.5 && !has(hit.s)) out.push(lineHit(ctx, 'id', 'id-labelled', hit.s, hit.s + hit.v.length, 0.85))
  }
  const lk = afterLabel(line, 'licence', LICENCE_VALUE, false)
  if (lk && /\d/.test(lk.v) && !has(lk.s)) out.push(lineHit(ctx, 'id', 'licence-labelled', lk.s, lk.s + lk.v.length, 0.85))
  return out
}

/** Windows product keys (with a digit): 0.90, kind 'key'. */
export function findProductKeys(line: CleanLine, ctx: LineContext): Hit[] {
  const out: Hit[] = []
  if (!line.prefix.includes('-')) return out
  for (const m of line.prefix.matchAll(PRODUCT_KEY)) {
    const v = m[0]
    if (!/\d/.test(v) || PLACEHOLDER_PAYLOAD.test(v) || new Set(v.slice(-12)).size <= 2) continue
    out.push(lineHit(ctx, 'key', 'product-key', m.index!, m.index! + v.length, 0.9))
  }
  return out
}
