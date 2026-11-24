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
import { asciiDigits } from '../../captions/numbers'
import { CODE_NOT, CODE_VALUE, JWT_HEAD, LABELS, LINK_HEADS, PEM_END, PLAIN_WORD, SHORT_TAIL, SPACED_KEY, TOKEN_AT_END, TOKEN_AT_START, YEAR } from './tables'

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

/**
 * The line a wrapped line goes on in: the nearest line below whose left edge is within one line height
 * of `x` and whose top is at most WRAP_GAP line heights under the line's bottom; of the reads at that
 * height, the widest (the reader also returns a line's piece cut at a tile's edge, and a row read twice).
 */
function lineUnder(line: DetectLine, x: number, all: readonly DetectLine[], hh: number): DetectLine | undefined {
  let best: DetectLine | undefined
  for (const o of all) {
    if (o.index === line.index || o.box[1] + 2 < bottom(line) || o.box[1] - bottom(line) > WRAP_GAP * hh || Math.abs(o.box[0] - x) > hh) continue
    if (!best || o.box[1] < best.box[1] - 0.3 * hh || (Math.abs(o.box[1] - best.box[1]) <= 0.3 * hh && o.box[2] > best.box[2])) best = o
  }
  return best
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

  // One space read inside a quoted key (§6.10, new): a key hit that opens a quoted value and stops one
  // space before the value's last one to eight token characters and its closing quote runs to the
  // quote (an underscore read as a space, `"pypi-…QL1 6i0c"` at 200%).
  for (const h of hits) {
    if (h.kind !== 'key' || h.spans.length !== 1) continue
    const sp = h.spans[0]
    const l = read(sp.line, sp.variant)
    const q = l?.raw[sp.start - 1]
    if (!l || !q || !'"\'`'.includes(q)) continue
    const m = /^ ([A-Za-z0-9_+/=-]{1,8})(["'`])/.exec(l.raw.slice(sp.end))
    if (!m || m[2] !== q) continue
    out.push({ ...h, rule: h.rule + '+space', spans: [{ ...sp, end: sp.end + 1 + m[1].length }] })
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
    // The line under the block so far: the frameContext's line below, or, when that went to another box
    // of the row (a BEGIN marker read apart from the JSON key before it), the nearest line under the row
    // overlapping the block (the 200% small editor).
    const under = (l: DetectLine): number | null => {
      if (ctx.below[l.index] !== null) return ctx.below[l.index]
      const hh = heightOf(l.box)
      let best: DetectLine | undefined
      for (const o of all) {
        if (o.box[1] + 2 < bottom(l) || o.box[1] - bottom(l) > 2.2 * hh) continue
        if (Math.max(0, Math.min(right(o), x1) - Math.max(o.box[0], x0)) < 0.3 * Math.min(o.box[2], x1 - x0)) continue
        if (!best || o.box[1] < best.box[1] - 0.3 * hh || (Math.abs(o.box[1] - best.box[1]) <= 0.3 * hh && o.box[2] > best.box[2])) best = o
      }
      return best ? best.index : null
    }
    let at = under(begin)
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
      at = under(l)
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

  // A one-time code's two digit groups read as boxes of their own (a code's fields at 150%), under a
  // line naming a code: joined, a code (§6.10, new).
  for (const l of all) {
    const a = asciiDigits(l.clean.text.trim())
    if (!/^\d{3,4}$/.test(a)) continue
    const hh = heightOf(l.box)
    const cy = l.box[1] + l.box[3] / 2
    let next: DetectLine | undefined
    for (const o of all) {
      if (o === l || o.box[0] < right(l) - 2 || o.box[0] - right(l) > hh || Math.abs(o.box[1] + o.box[3] / 2 - cy) >= 0.6 * hh) continue
      if (!next || o.box[0] < next.box[0]) next = o
    }
    const b = next ? asciiDigits(next.clean.text.trim()) : ''
    if (!next || !/^\d{3,4}$/.test(b)) continue
    const joined = `${a} ${b}`
    const v = CODE_VALUE.exec(joined)
    if (!v || v[0].length !== joined.length || YEAR.test(a) || YEAR.test(b)) continue
    const up = ctx.above[l.index]
    const near = [up, up === null ? null : ctx.above[up]].map((j) => (j === null ? undefined : read(j)))
    if (!near.some((n) => n && LABELS.code.test(n.clean.label) && !CODE_NOT.test(n.clean.text))) continue
    const own = (d: DetectLine): HitSpan => ({ line: d.index, variant: d.variant, start: d.raw.length - d.raw.trimStart().length, end: d.raw.trimEnd().length })
    out.push({ kind: 'code', rule: 'code-labelled-groups', score: 0.9, spans: [own(l), own(next)], box: [0, 0, 0, 0] })
  }

  // A token that runs to the end of its line continues at the left of the lines below (§6.10).
  const continued = [...hits, ...out].flatMap((h) => {
    if (h.kind !== 'key' && h.kind !== 'link') return [h]
    if (h.rule.startsWith('private-key')) return [h]
    let last = h.spans[h.spans.length - 1]
    let line = read(last.line, last.variant)
    if (!line || !runsToEnd(last, line)) return [h]
    const tail = line.raw.slice(0, last.end).replace(/[\s.,;"'`]+$/, '')
    const lastChar = tail[tail.length - 1] ?? ''
    const relaxed = /[A-Za-z0-9_+/=.~-]/.test(lastChar)
    const spans = [...h.spans]
    let short: HitSpan | null = null
    for (let k = 0; k < CHAIN; k++) {
      const hh = heightOf(line.box)
      // A line short of its block's right edge continues only for a token (§6.10, new).
      const atEdge = right(line) >= blockRight(line, all) - 1.2 * hh
      if (!relaxed && !atEdge) break
      const b = lineUnder(line, line.box[0], all, hh)
      let cont = b ? TOKEN_AT_START.exec(b.clean.text) : null
      if (cont && PLAIN_WORD.test(cont[0])) cont = null
      // The rest of a token, not a line of its own: no '=' inside it (padding at its end only), no ':' or '=' after it.
      if (b && cont && !/=[^=]/.test(cont[1]) && !/^\s{0,2}[:=]/.test(b.clean.text.slice(cont.index + cont[0].length))) {
        const s = cont.index + cont[0].indexOf(cont[1])
        const piece = lineHit(lineCtx(b), h.kind, h.rule, s, s + cont[1].length, h.score).spans[0]
        spans.push(piece)
        if (!runsToEnd(piece, b)) break
        last = piece
        line = b
        continue
      }
      // The last one to three characters of a token wrapped at its block's right edge, alone on the next
      // row but for a closing quote or bracket: under the line, or at the start of its row (the reader
      // reads a log line's time apart from its message). They are a cover of their own: the hit's one box
      // would take in the row above from the row's start (a label, the log line's time).
      if (!relaxed || !atEdge) break
      const leftmost = ctx.left[line.index]?.[0]
      const rowStart = leftmost === undefined ? undefined : read(leftmost)
      const under = rowStart ? lineUnder(line, rowStart.box[0], all, hh) : undefined
      // At the row's start the tail is alone on its row (not an editor's next line number).
      const alone = (t: DetectLine): boolean => !all.some((o) => o.box[0] >= right(t) && Math.abs(o.box[1] + o.box[3] / 2 - (t.box[1] + t.box[3] / 2)) < 0.6 * heightOf(t.box))
      for (const t of [b, under && alone(under) ? under : undefined]) {
        const m = t ? SHORT_TAIL.exec(t.clean.text) : null
        if (!t || !m) continue
        const s = m.index + m[0].indexOf(m[1])
        short = lineHit(lineCtx(t), h.kind, h.rule, s, s + m[1].length, h.score).spans[0]
        break
      }
      break
    }
    const whole = spans.length === h.spans.length ? h : { ...h, spans, rule: h.rule.endsWith('+continued') ? h.rule : h.rule + '+continued' }
    if (!short) return [whole]
    const ofTail = read(short.line, short.variant)!
    return [whole, { kind: h.kind, rule: h.rule.replace(/\+continued$/, '') + '+tail', score: h.score, spans: [short], box: coverBox([short], () => ofTail, ctx.frame) }]
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
