/**
 * Card and bank numbers (docs/design/auto-blur.md §6.8): payment cards by grouping, Luhn and issuer
 * prefix on the digit view; CVV and CVC with their label; IBANs as written, by country length and
 * mod 97, repaired by up to two OCR swaps. Their kind is 'card' ("Card and bank numbers"). Pure.
 */
import type { CleanLine } from './clean'
import { lineHit, taken, type Hit, type LineContext } from './score'
import { CARD_CANDIDATE, CVV_AFTER, CVV_LABEL_LINE, CVV_VALUE_LINE, IBAN_CANDIDATE, IBAN_LENGTHS, IBAN_SWAPS, IIN, isAllowed, LABELS } from './tables'
import { besideLabel, labelled } from './labels'

/** Luhn's check over a string of digits. */
export function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return digits.length > 0 && sum % 10 === 0
}

/** The card network of a number (its issuer prefix and an allowed length), or null. */
export function cardNetwork(digits: string): string | null {
  for (const [from, to, lengths, name] of IIN) {
    const p = digits.slice(0, from.length)
    if (p >= from && p <= to && lengths.includes(digits.length)) return name
  }
  return null
}

/** An IBAN's remainder: the first four characters moved to the end, letters as 10-35, mod 97. */
export function mod97(iban: string): number {
  const r = iban.slice(4) + iban.slice(0, 4)
  let rem = 0
  for (const c of r) {
    const v = c >= '0' && c <= '9' ? c : String(c.charCodeAt(0) - 55)
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return rem
}

/** An IBAN that fails mod 97, repaired by one, then two, OCR swaps after its first four characters; null when none passes. */
export function repairIban(iban: string): string | null {
  const pos = [...iban].map((c, i) => (i >= 4 && Object.hasOwn(IBAN_SWAPS, c) ? i : -1)).filter((i) => i >= 0).slice(0, 12)
  const swap = (s: string, i: number): string => s.slice(0, i) + IBAN_SWAPS[s[i]] + s.slice(i + 1)
  for (const i of pos) {
    const a = swap(iban, i)
    if (mod97(a) === 1) return a
  }
  for (let x = 0; x < pos.length; x++)
    for (let y = x + 1; y < pos.length; y++) {
      const a = swap(swap(iban, pos[x]), pos[y])
      if (mod97(a) === 1) return a
    }
  return null
}

const REFERENCE_BEFORE = /#\s*$/

/** Whether a card-shaped run's groups are written as cards are: no separators; one kind with groups of fours (OCR drops spaces); Amex and Diners 4-6-5, 4-6-4. */
function grouped(run: string): boolean {
  const groups = run.split(/[ -]/)
  if (groups.length === 1) return true
  const seps = new Set(run.match(/[ -]/g) ?? [])
  if (seps.size !== 1) return false
  const lens = groups.map((g) => g.length)
  const last = lens[lens.length - 1]
  if (lens.slice(0, -1).every((n) => n % 4 === 0) && last >= 1 && (last <= 4 || last % 4 === 0)) return true
  return lens.length === 3 && lens[0] === 4 && lens[1] === 6 && (lens[2] === 5 || lens[2] === 4)
}

/** Cards, CVV and CVC, and IBANs on a line. */
export function findCards(line: CleanLine, ctx: LineContext): Hit[] {
  const out: Hit[] = []
  const dv = line.digit
  const lab = labelled(line, ctx, 'card')
  if (/\d/.test(dv)) {
    for (const m of dv.matchAll(CARD_CANDIDATE)) {
      const run = m[0]
      if (!grouped(run)) continue
      const groups = run.split(/[ -]/)
      const d = groups.join('')
      if (isAllowed(d)) continue
      if ((d.match(/0/g) ?? []).length / d.length >= 0.75 || new Set(d).size <= 2) continue
      const net = cardNetwork(d)
      const ok = luhn(d)
      const before = line.label.slice(0, m.index)
      const otherLabel = !lab && (LABELS.reference.test(before) || REFERENCE_BEFORE.test(before))
      const lens = groups.map((g) => g.length)
      const s = m.index!
      if (ok && net) out.push(lineHit(ctx, 'card', 'card-luhn:' + net, s, s + run.length, otherLabel ? 0.6 : groups.length > 1 || lab ? 0.96 : 0.88))
      else if (lab && net && groups.length >= 4 && lens.every((n, i) => i === lens.length - 1 || n === 4)) out.push(lineHit(ctx, 'card', 'card-misread', s, s + run.length, 0.8))
      else if (lab && d.length >= 13 && d.length <= 19) out.push(lineHit(ctx, 'card', 'card-labelled', s, s + run.length, 0.7))
    }
    // CVV right after its label.
    for (const m of dv.matchAll(CVV_AFTER)) {
      const s = m.index! + m[0].length - m[2].length
      out.push(lineHit(ctx, 'card', 'cvv', s, s + m[2].length, 0.9))
    }
    // CVV alone under or beside its label.
    if (CVV_VALUE_LINE.test(dv) && ((ctx.above && CVV_LABEL_LINE.test(ctx.above.label)) || besideLabel(line, ctx, 'cvv'))) {
      const v = line.text.trim()
      const s = line.text.indexOf(v)
      if (!taken(ctx, s)) out.push(lineHit(ctx, 'card', 'cvv', s, s + v.length, 0.9))
    }
  }
  // IBAN, as written (lower-case text is never an IBAN).
  for (const m of line.text.matchAll(IBAN_CANDIDATE)) {
    const compact = m[1].replace(/ /g, '')
    const want = IBAN_LENGTHS[compact.slice(0, 2)]
    if (!want || compact.length < want) continue
    const s = m.index!
    let e = s + m[1].length
    if (compact.length > want) {
      // The run swallowed what follows: cut it to the country's length (spaces not counted).
      let n = 0
      let k = s
      while (k < line.text.length && n < want) {
        if (line.text[k] !== ' ') n++
        k++
      }
      e = k
    }
    const iban = line.text.slice(s, e).replace(/ /g, '')
    if (isAllowed(iban) || /XXXX|0{10,}/.test(iban)) continue
    if (mod97(iban) === 1) out.push(lineHit(ctx, 'card', 'iban', s, e, 0.97))
    else if (repairIban(iban)) out.push(lineHit(ctx, 'card', 'iban-repaired', s, e, 0.85))
    else if (labelled(line, ctx, 'iban')) out.push(lineHit(ctx, 'card', 'iban-labelled', s, e, 0.75))
  }
  return out
}
