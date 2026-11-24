/**
 * Rows, columns and frames (docs/design/auto-blur.md §6.10): what one line cannot say alone. PEM blocks
 * from BEGIN to END at the block's full width (a lost area to the frame's bottom without an END line);
 * recovery-code grids; a token that continues on the next lines (JWT heads, links and keys wrapped
 * after a dash, at most 6 lines); one space read inside a key; a token wrapped onto the next line.
 * Values beside a label box, under a short label line and under a sentence naming a code are read
 * by the line rules through their context. Pure.
 */
import { strongHits } from './keys'
import { findRecoveryCodes } from './labels'
import { coverBox, heightOf, lineHit, type DetectLine, type FrameContext, type Hit, type HitSpan, type LineContext } from './score'
import { JWT_HEAD, LINK_HEADS, PEM_END, PLAIN_WORD, SPACED_KEY, TOKEN_AT_END, TOKEN_AT_START } from './tables'

/** Lines a PEM block holds at most, and lines a token is chained over at most. */
const PEM_LINES = 60
const CHAIN = 6
/** Character widths a PEM BEGIN or END line is widened by at each end (OCR drops their dash runs). */
const PEM_WIDEN = 5
/** Character widths a PEM body line has (a lost block is at least this wide). */
const PEM_BODY = 66
/** The largest gap between two lines of wrapped text, in line heights. */
const WRAP_GAP = 0.6

const right = (l: DetectLine): number => l.box[0] + l.box[2]
const bottom = (l: DetectLine): number => l.box[1] + l.box[3]
const overlapX = (a: DetectLine, b: DetectLine): number => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.box[0], b.box[0])) / Math.max(1, Math.min(a.box[2], b.box[2]))

/** The right edge of the block a line sits in: the lines overlapping it in x within 12 line heights. */
function blockRight(l: DetectLine, all: readonly DetectLine[]): number {
  let r = right(l)
  for (const o of all) if (overlapX(o, l) > 0.3 && Math.abs(o.box[1] - l.box[1]) < 12 * heightOf(l.box)) r = Math.max(r, right(o))
  return r
}

/** The text a hit's span ends at on its line, without trailing punctuation: whether the hit runs to the line's end. */
function runsToEnd(span: HitSpan, line: DetectLine): boolean {
  return span.end >= line.raw.replace(/[\s.,;"'`]+$/, '').length
}

/** The last characters of a text, where a pattern anchored at its end can match (it never looks further back), and where they start. */
const TAIL = 2600
function tailOf(text: string): { at: number; text: string } {
  const at = Math.max(0, text.length - TAIL)
  return { at, text: at ? text.slice(at) : text }
}

/** The x-range of a whole line. */
const lineX = (l: DetectLine): [number, number] => [l.box[0], right(l)]

/** Frame rules over every read of every line: the hits with continuations added, and the new hits. */
export function rowRules(lines: readonly DetectLine[], hits: Hit[], ctx: FrameContext): Hit[] {
  const byKey = new Map<string, DetectLine>()
  for (const l of lines) byKey.set(`${l.index}:${l.variant}`, l)
  const read = (index: number, variant?: number): DetectLine | undefined => byKey.get(`${index}:${variant ?? ctx.best[index]}`)
  const bestLines = new Map<number, DetectLine>()
  for (const l of lines) if (l.variant === ctx.best[l.index]) bestLines.set(l.index, l)
  const all = [...bestLines.values()]
  const lineCtx = (l: DetectLine, found: Hit[] = []): LineContext => ({
    line: l,
    above: null,
    above2: null,
    left: [],
    recovery: true,
    regions: ctx.regions,
    kinds: ctx.kinds,
    names: ctx.names,
    found,
    offset: 0,
    frame: ctx.frame
  })
  const out: Hit[] = []

  // One space read inside a key (§6.10, new): `sk-proj-… S9f1s…` is one token when the joined token matches and the parts alone do not.
  for (const l of lines) {
    if (!l.clean.prefix.includes(' ')) continue
    for (const m of l.clean.prefix.matchAll(SPACED_KEY)) {
      const [, a, b] = m
      if (strongHits(a).length || strongHits(b).length) continue
      const joined = strongHits(a + b).filter((x) => x.start <= 0 && x.end > a.length)
      if (!joined.length) continue
      const best = joined.sort((x, y) => y.score - x.score)[0]
      const s = m.index! + m[0].indexOf(a)
      out.push(lineHit(lineCtx(l), 'key', best.rule + '+space', s, s + a.length + 1 + Math.min(b.length, best.end - a.length), best.score))
    }
  }

  // A JWT whose third part is on later lines (§6.10, new): its head at the end of a line starts a continuation.
  for (const l of lines) {
    const tail = tailOf(l.clean.prefix)
    const m = JWT_HEAD.exec(tail.text)
    if (!m) continue
    if (hits.some((h) => h.rule === 'jwt' && h.spans.some((sp) => sp.line === l.index && sp.variant === l.variant))) continue
    out.push(lineHit(lineCtx(l), 'key', 'jwt-head', tail.at + m.index, tail.at + m.index + m[0].length, 0.9))
  }

  // A webhook whose token is cut at the end of a line (wrapped after a dash, §6.10): its secret part starts a continuation.
  for (const l of lines) {
    const tail = tailOf(l.clean.url)
    for (const r of LINK_HEADS) {
      const m = r.pattern.exec(tail.text)
      if (!m) continue
      const s = tail.at + m.index + m[0].length - m[1].length
      if (hits.some((h) => h.kind === 'link' && h.spans.some((sp) => sp.line === l.index && sp.variant === l.variant))) continue
      out.push(lineHit(lineCtx(l), 'link', r.id + '-head', s, tail.at + m.index + m[0].length, r.score))
    }
  }

  const work = [...hits, ...out]

  // PEM blocks: from a BEGIN line, every line below in the same column to the END line, across the block's full width.
  for (const h of work) {
    if (h.rule !== 'private-key') continue
    const sp = h.spans[0]
    const begin = read(sp.line, sp.variant)
    if (!begin) continue
    const spans: HitSpan[] = [{ ...sp, start: 0, end: begin.raw.length }]
    const w = begin.charWidth * PEM_WIDEN
    let x0 = begin.box[0] - w
    let x1 = right(begin) + w
    let end = false
    let body = 0
    let at = ctx.below[sp.line]
    for (let k = 0; at !== null && k < PEM_LINES; k++) {
      const l = read(at)
      if (!l) break
      spans.push({ line: l.index, variant: l.variant, start: 0, end: l.raw.length })
      if (PEM_END.test(l.clean.text)) {
        x0 = Math.min(x0, l.box[0] - l.charWidth * PEM_WIDEN)
        x1 = Math.max(x1, right(l) + l.charWidth * PEM_WIDEN)
        end = true
        break
      }
      body++
      x0 = Math.min(x0, l.box[0])
      x1 = Math.max(x1, right(l))
      at = ctx.below[at]
    }
    if (end && body > 0) {
      out.push({ kind: 'key', rule: 'private-key-block', score: 0.99, spans, box: [0, 0, 0, 0], block: [x0, x1] })
    } else {
      // No END line, or no line read between BEGIN and END: the area to the frame's bottom is covered, as a lost area.
      x1 = Math.max(x1, begin.box[0] + begin.charWidth * PEM_BODY)
      out.push({ kind: 'key', rule: 'private-key-lost', score: 0.99, spans, box: [0, 0, 0, 0], block: [x0, x1], lost: true })
    }
  }

  // Recovery codes in a grid: boxes on the row of a box in a recovery block.
  for (const l of all) {
    if (ctx.recovery[l.index]) continue
    const cy = l.box[1] + l.box[3] / 2
    const mate = all.some((o) => o !== l && ctx.recovery[o.index] && Math.abs(o.box[1] + o.box[3] / 2 - cy) < 0.6 * heightOf(l.box))
    if (!mate) continue
    for (const x of findRecoveryCodes(l.clean, lineCtx(l))) out.push({ ...x, rule: 'recovery-code-grid' })
  }

  // A token that runs to the end of its line continues at the left of the lines below (§6.10).
  const continued = [...hits, ...out].map((h) => {
    if (h.kind !== 'key' && h.kind !== 'link') return h
    if (h.rule.startsWith('private-key')) return h
    let last = h.spans[h.spans.length - 1]
    let line = read(last.line, last.variant)
    if (!line || !runsToEnd(last, line)) return h
    const tail = line.raw.slice(0, last.end).replace(/[\s.,;"'`]+$/, '')
    const lastChar = tail[tail.length - 1] ?? ''
    const relaxed = /[A-Za-z0-9_+/=.~-]/.test(lastChar)
    const spans = [...h.spans]
    for (let k = 0; k < CHAIN; k++) {
      const belowIndex = ctx.below[line.index]
      if (belowIndex === null) break
      const b = read(belowIndex)
      if (!b) break
      const hh = heightOf(line.box)
      const gap = b.box[1] - bottom(line)
      // Wrapped text is set tight: a value in the next field of a form is not the rest of this one.
      if (gap > WRAP_GAP * hh || Math.abs(b.box[0] - line.box[0]) > hh) break
      // A line short of its block's right edge continues only for a token (§6.10, new).
      if (!relaxed && right(line) < blockRight(line, all) - 1.2 * hh) break
      const cont = TOKEN_AT_START.exec(b.clean.text)
      if (!cont || PLAIN_WORD.test(cont[0])) break
      // The rest of a token, not a line of its own: no '=' inside it (padding at its end only), no ':' or '=' after it.
      if (/=[^=]/.test(cont[1]) || /^\s{0,2}[:=]/.test(b.clean.text.slice(cont.index + cont[0].length))) break
      const s = cont.index + cont[0].indexOf(cont[1])
      const piece = lineHit(lineCtx(b), h.kind, h.rule, s, s + cont[1].length, h.score).spans[0]
      spans.push(piece)
      if (!runsToEnd(piece, b)) break
      last = piece
      line = b
    }
    return spans.length === h.spans.length ? h : { ...h, spans, rule: h.rule.endsWith('+continued') ? h.rule : h.rule + '+continued' }
  })

  // A token wrapped onto the next line: the line's last token and the next line's first, joined, match a strong rule neither matches alone.
  for (const l of all) {
    const belowIndex = ctx.below[l.index]
    if (belowIndex === null) continue
    const b = read(belowIndex)
    if (!b) continue
    const hh = heightOf(l.box)
    if (right(l) < blockRight(l, all) - 1.2 * hh || Math.abs(b.box[0] - l.box[0]) > 2.5 * hh) continue
    const tail = tailOf(l.clean.prefix)
    const a = TOKEN_AT_END.exec(tail.text)
    const n = TOKEN_AT_START.exec(b.clean.prefix)
    if (!a || !n) continue
    const aAt = tail.at + a.index
    const first = n[1]
    if (strongHits(a[0]).length || strongHits(first).length) continue
    for (const x of strongHits(a[0] + first)) {
      if (!(x.start < a[0].length && x.end > a[0].length)) continue
      const top = lineHit(lineCtx(l), 'key', x.rule + '+wrap', aAt + x.start, l.clean.text.length, x.score)
      const off = n.index + n[0].indexOf(first)
      const low = lineHit(lineCtx(b), 'key', x.rule + '+wrap', off, off + Math.min(first.length, x.end - a[0].length), x.score)
      continued.push({ ...top, spans: [...top.spans, ...low.spans] })
    }
  }

  // Boxes of the hits made or grown here; the caller pads and clips every box again.
  const lineOf = (s: HitSpan): DetectLine | undefined => read(s.line, s.variant)
  return continued.map((h) => (h.spans.length > 1 || h.block ? { ...h, box: coverBox(h.spans, lineOf, ctx.frame, h.block) } : h))
}

/** A line's whole x-range (for tests and the scan). */
export const lineRange = lineX
