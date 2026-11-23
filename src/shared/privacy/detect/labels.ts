/**
 * Values that a label names (docs/design/auto-blur.md §6.6, §6.7, §6.10): strong labels in code and in
 * the UI (Check, 0.75) and authenticator setup keys (0.95); passwords; PINs and one-time codes;
 * recovery codes. A value counts after its label on the line, under a short label line, or beside a
 * label box on the row; labels are matched on the label view, in English, Bangla, Spanish and Hindi.
 * Pure.
 */
import { asciiDigits } from '../../captions/numbers'
import type { CleanLine } from './clean'
import { lineHit, taken, type Hit, type LineContext } from './score'
import {
  ALGORITHM,
  ASSIGNMENT,
  CAMEL_IDENTIFIER,
  CODE_EXPR,
  CODE_FIRST,
  CODE_NOT,
  CODE_VALUE,
  ENV_ASSIGNMENT,
  GENERIC_STOP,
  HEADING_NUMBER,
  KEY_LABEL_BOX,
  LABEL_FAR_IS,
  LABEL_LINE_EXTRA,
  LABEL_SEPARATOR,
  LABELS,
  LABELS_ALL,
  LETTERS_ONLY,
  NOT_A_KEY_VALUE,
  NOT_A_PASSWORD,
  OTP_SECRET,
  PASS_AFTER_USER,
  PASSWORD_DOTS,
  PASSWORD_LABEL_BOX,
  PASSWORD_UI,
  PATH_VALUE,
  PIN_AS_WRITTEN,
  PIN_VALUE,
  PLACEHOLDER,
  RECOVERY_CODE,
  RECOVERY_TOKEN,
  TRAILING_PUNCT,
  URL_SCHEME,
  YEAR
} from './tables'

type LabelKind = keyof typeof LABELS

/** Shannon entropy of a string, in bits a character. */
export function entropy(s: string): number {
  const f = new Map<string, number>()
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1)
  let h = 0
  const n = [...s].length
  for (const k of f.values()) {
    const p = k / n
    h -= p * Math.log2(p)
  }
  return h
}

/** Whether the line, or the line above, holds a label of `kind`. */
export function labelled(line: CleanLine, ctx: Pick<LineContext, 'above'>, kind: LabelKind): boolean {
  return LABELS[kind].test(line.label) || (!!ctx.above && LABELS[kind].test(ctx.above.label))
}

/** Every label of `kind` on the line: its word and where it ends. */
export function labelHits(line: CleanLine, kind: LabelKind): { word: string; end: number }[] {
  return [...line.label.matchAll(LABELS_ALL[kind])].map((m) => ({ word: m[1], end: m.index! + m[0].length }))
}

const DIGIT_KINDS = new Set<LabelKind>(['id', 'pin', 'code', 'phone'])

/** The value right after a label of `kind` that matches `value` (anchored): where it starts, the value, and whether a separator came between. */
export function afterLabel(line: CleanLine, kind: LabelKind, value: RegExp, sepRequired: boolean): { s: number; v: string; hasSep: boolean } | null {
  for (const h of labelHits(line, kind)) {
    const rest = (DIGIT_KINDS.has(kind) ? line.digit : line.text).slice(h.end)
    let sep: { text: string; has: boolean } | null = null
    const near = LABEL_SEPARATOR.exec(rest)!
    sep = { text: near[0], has: !!(near[1] || near[2]) }
    // "PIN for the shared phone is 2580": up to five words between the label and "is".
    if (!sep.has && (kind === 'password' || kind === 'pin' || kind === 'code')) {
      const far = LABEL_FAR_IS.exec(rest)
      if (far) sep = { text: far[0], has: true }
    }
    if (sepRequired && !sep.has) continue
    const word = h.word.toLowerCase()
    if (word === 'pass' && !/[:=]/.test(sep.text)) continue
    if (word === 'pass' && !PASS_AFTER_USER.test(line.text.slice(0, h.end - h.word.length))) continue
    const v = value.exec(rest.slice(sep.text.length))
    if (v) {
      const vv = v[0].replace(TRAILING_PUNCT, '')
      if (vv) return { s: h.end + sep.text.length, v: vv, hasSep: sep.has }
    }
  }
  return null
}

/** The line is the value under a short label line of `kind` ("Password", "API key *"). */
export function underLabel(line: CleanLine, ctx: Pick<LineContext, 'above'>, kind: LabelKind): { s: number; v: string } | null {
  if (!ctx.above) return null
  const a = ctx.above.label.trim()
  if (a.length > 40 || a.split(/\s+/).length > 4 || !LABELS[kind].test(a)) return null
  if (a.replace(LABELS[kind], '').replace(LABEL_LINE_EXTRA, '').length > 10) return null
  const v = line.text.trim()
  if (!v) return null
  if (/\s/.test(v)) {
    const digits = (asciiDigits(v).match(/\d/g) ?? []).length
    if (!((kind === 'id' || kind === 'code') && v.length <= 30 && digits / v.replace(/\s/g, '').length >= 0.5)) return null
  }
  return { s: line.text.indexOf(v), v }
}

/** The line is the value of a label box to its left on the row (other boxes may sit between). */
export function besideLabel(line: CleanLine, ctx: Pick<LineContext, 'left'>, kind: LabelKind): { s: number; v: string } | null {
  const left = ctx.left.slice(-3).reverse()
  for (const b of left) {
    const c = b.label.trim()
    if (c.split(/\s+/).length > 6) break
    if (LABELS[kind].test(c) || (kind === 'key' && (LABELS.keyShort.test(c) || KEY_LABEL_BOX.test(c))) || (kind === 'password' && PASSWORD_LABEL_BOX.test(c))) {
      const v = line.text.trim().replace(/^["'`]|["'`,;]+$/g, '')
      if (!v) return null
      return { s: line.text.indexOf(v), v }
    }
  }
  return null
}

/** A short label line above of `kind`, also with the short key labels ("Setup key", "Token"). */
function underShort(line: CleanLine, ctx: Pick<LineContext, 'above'>, kind: LabelKind): { s: number; v: string } | null {
  const u = underLabel(line, ctx, kind)
  if (u || kind !== 'key' || !ctx.above) return u
  const a = ctx.above.label.trim()
  if (a.length > 40 || a.split(/\s+/).length > 4 || !LABELS.keyShort.test(a)) return null
  const v = line.text.trim()
  if (!v) return null
  return !/\s/.test(v) || OTP_SECRET.test(v) ? { s: line.text.indexOf(v), v } : null
}

/** The line starts with a label of `kind`. */
function startsWithLabel(line: CleanLine, kind: LabelKind): boolean {
  const m = LABELS[kind].exec(line.label)
  return !!m && line.label.slice(0, m.index + m[0].length - m[1].length).trim() === ''
}

/** Labelled assignments in code and config (gitleaks generic-api-key): Check, with Shannon entropy 3.0 or more a character. */
export function findAssignments(line: CleanLine, ctx: LineContext): Hit[] {
  const out: Hit[] = []
  const t = line.text
  for (const m of t.matchAll(ASSIGNMENT)) {
    const v = m[2]
    const s = m.index! + m[0].length - v.length - (/["'`]$/.test(m[0]) ? 1 : 0)
    if (LETTERS_ONLY.test(v) || GENERIC_STOP.test(v) || PLACEHOLDER.test(v)) continue
    if (URL_SCHEME.test(v) && t.slice(m.index! + m[0].length).startsWith('://')) continue
    if (PATH_VALUE.test(v) || ENV_ASSIGNMENT.test(v)) continue
    if (entropy(v) < 3.0) continue
    if (ctx.found.some((h) => h.kind === 'key' && h.spans.some((sp) => sp.line === ctx.line.index && sp.variant === ctx.line.variant && sp.start <= line.map[s] && sp.end >= line.map[Math.min(s + v.length, line.text.length) - 1]))) continue
    out.push(lineHit(ctx, 'key', 'labelled-assignment', s, s + v.length, 0.75))
  }
  return out
}

/** Passwords (0.90), and password dots (0.60, off by default) after or under a label. */
export function findPasswords(line: CleanLine, ctx: LineContext): Hit[] {
  if (PASSWORD_UI.test(line.label)) return []
  const t = line.text
  let same = afterLabel(line, 'password', /^\S{4,64}/, !startsWithLabel(line, 'password') || t.trim().split(/\s+/).length !== 2)
  if (same) {
    const v = same.v.replace(TRAILING_PUNCT, '').replace(/^['"`]/, '')
    // A label and a word with nothing between ("Password dots", a heading) is not a field: without a separator the value needs more than letters.
    const plainWord = !same.hasSep && /^\p{L}+$/u.test(v)
    same = v.length >= 4 && !plainWord && !(CAMEL_IDENTIFIER.test(v) && /^[A-Z]|[a-z][A-Z]/.test(v)) ? { s: same.s + (same.v.startsWith(v) ? 0 : 1), v, hasSep: same.hasSep } : null
  }
  const beside = besideLabel(line, ctx, 'password')
  const under = ctx.above && !PASSWORD_UI.test(ctx.above.label) ? underLabel(line, ctx, 'password') : null
  const hit = same ?? under ?? (beside && !NOT_A_PASSWORD.test(beside.v) ? beside : null)
  if (!hit || NOT_A_PASSWORD.test(hit.v)) return []
  if (PASSWORD_DOTS.test(hit.v)) return ctx.kinds.has('dots') ? [lineHit(ctx, 'dots', 'password-dots', hit.s, hit.s + hit.v.length, 0.6)] : []
  if (PLACEHOLDER.test(hit.v) || CODE_EXPR.test(hit.v) || /^[\p{P}\p{S}]+$/u.test(hit.v)) return []
  return [lineHit(ctx, 'password', same ? 'password-labelled' : 'password-below-label', hit.s, hit.s + hit.v.length, 0.9)]
}

/** A code value that is not an algorithm name or a year. */
const codeOk = (v: string): boolean => (!ALGORITHM.test(v) && !YEAR.test(v) && /\d/.test(v.replace(/^[A-Z]-/, ''))) || /^[A-Z]{4}-[A-Z]{4}$/.test(v)

/** PINs (0.90) and one-time codes (0.90; alphanumeric 0.85). */
export function findCodes(line: CleanLine, ctx: LineContext): Hit[] {
  const out: Hit[] = []
  const t = line.text
  const pinOk = labelHits(line, 'pin').some((h) => PIN_AS_WRITTEN.test(h.word))
  let pin: { s: number; v: string } | null = pinOk ? afterLabel(line, 'pin', PIN_VALUE, false) : null
  if (!pin) {
    const b = besideLabel(line, ctx, 'pin')
    if (b && /^\d{4,8}$/.test(asciiDigits(b.v))) pin = b
  }
  if (pin) out.push(lineHit(ctx, 'code', 'pin-labelled', pin.s, pin.s + pin.v.length, 0.9))
  if (CODE_NOT.test(t)) return out
  let code: { s: number; v: string } | null = afterLabel(line, 'code', CODE_VALUE, false)
  if (code && !codeOk(code.v)) code = null
  if (!code) {
    // The value first: "G-482913 is your Google verification code".
    const m = CODE_FIRST.exec(line.digit)
    if (m && LABELS.code.test(line.label.slice(m.index + m[0].length, m.index + m[0].length + 48))) code = { s: m.index + (m[0].indexOf(m[1])), v: m[1] }
  }
  if (!code) {
    // A code alone on its line under a line (or two) that names a code, even in a sentence.
    const v = t.trim()
    const d = asciiDigits(v)
    const value = CODE_VALUE.exec(d)
    const near = [ctx.above, ctx.above2].filter((a): a is CleanLine => !!a)
    if (v && value && d.length === value[0].length && codeOk(d) && near.some((a) => LABELS.code.test(a.label) && !CODE_NOT.test(a.text))) code = { s: t.indexOf(v), v }
  }
  if (code && !taken({ ...ctx, found: [...ctx.found, ...out] }, code.s)) {
    const alnum = /[A-Z]{3}/i.test(code.v)
    out.push(lineHit(ctx, 'code', alnum ? 'code-alnum-labelled' : 'code-labelled', code.s, code.s + code.v.length, alnum ? 0.85 : 0.9))
  }
  return out
}

/** Codes on a line of a recovery-codes block (§6.7): when 60% or more of its tokens are code-shaped. */
export function findRecoveryCodes(line: CleanLine, ctx: LineContext): Hit[] {
  if (!ctx.recovery) return []
  // A heading number ("1. ", "2) ") is not a token of the line, nor a code.
  const heading = HEADING_NUMBER.exec(line.text)
  const from = heading ? heading[0].length : 0
  const tokens = line.text.slice(from).trim().split(/\s+/).filter(Boolean)
  const codeish = tokens.filter((x) => RECOVERY_TOKEN.test(x) && /\d/.test(x)).length
  if (!tokens.length || codeish / tokens.length < 0.6) return []
  const out: Hit[] = []
  for (const m of line.text.matchAll(RECOVERY_CODE)) {
    const v = m[0]
    if (m.index! < from) continue
    if (!/\d/.test(v) || v.replace(/[- ]/g, '').length < 6 || YEAR.test(v)) continue
    if (taken({ ...ctx, found: [...ctx.found, ...out] }, m.index!)) continue
    out.push(lineHit(ctx, 'code', 'recovery-code', m.index!, m.index! + v.length, 0.9))
  }
  return out
}

/** A key's value named by a UI label ("API key", "Secret key", …): Check, or an authenticator setup key (0.95). Only where no key was found on the line. */
export function findKeyLabels(line: CleanLine, ctx: LineContext): Hit[] {
  if (ctx.found.some((h) => h.kind === 'key')) return []
  const hit = afterLabel(line, 'key', /^\S{12,200}/, true) ?? underShort(line, ctx, 'key') ?? besideLabel(line, ctx, 'key')
  if (!hit) return []
  if (OTP_SECRET.test(hit.v)) return [lineHit(ctx, 'key', 'otp-secret', hit.s, hit.s + hit.v.length, 0.95)]
  if (/\s/.test(hit.v) || NOT_A_KEY_VALUE.test(hit.v)) return []
  if (hit.v.length >= 12 && /\d/.test(hit.v) && /[A-Za-z]/.test(hit.v) && !PLACEHOLDER.test(hit.v) && !CODE_EXPR.test(hit.v) && entropy(hit.v) >= 3.0) return [lineHit(ctx, 'key', 'key-strong-label', hit.s, hit.s + hit.v.length, 0.75)]
  return []
}
