/**
 * The text rules on one read of one frame (docs/design/auto-blur.md §6, §5.7): every rule on every
 * read of every line (tiny, and small when it was read again), the rows and columns the lines form,
 * the QR codes; then the reads of a line joined, contained hits dropped and the cover boxes padded
 * (the width rounding of §6.1 is found.ts's). Runs in main's rules worker (D20), never on main's
 * event loop and never in the renderer. Pure.
 */
import { CHECK_SCORE } from '../kinds'
import type { ReadLine, ReadResult } from '../protocol'
import { cleanLine, foldText, type CleanLine } from './clean'
import { findCards } from './cards'
import { findEmail } from './email'
import { findExtra } from './extra'
import { findIds, findProductKeys } from './ids'
import { findKeys } from './keys'
import { findAssignments, findCodes, findKeyLabels, findPasswords, findRecoveryCodes } from './labels'
import { findLinks } from './links'
import { findNames, nameFold } from './names'
import { findPhones } from './phones'
import { classQr } from './qr'
import { rowRules } from './rows'
import { clipBox, coverBox, detectLineOf, heightOf, type DetectLine, type DetectOptions, type FrameContext, type Hit, type HitSpan, type LineContext } from './score'
import { LABELS, LONG_TOKEN_RUN } from './tables'
import { extendAtEdges, lineWindows, windowOf } from './windows'

export type { DetectOptions, Hit, HitSpan } from './score'

type Finder = (line: CleanLine, ctx: LineContext) => Hit[]

/** The line rules, in the order each may rely on what the ones before it took. */
const FINDERS: readonly Finder[] = [
  findKeys,
  findProductKeys,
  findLinks,
  findAssignments,
  findEmail,
  findCards,
  findIds,
  findPhones,
  findPasswords,
  findCodes,
  findRecoveryCodes,
  findKeyLabels,
  (line, ctx) => findNames(line, ctx.names, ctx),
  findExtra
]

const right = (b: readonly number[]): number => b[0] + b[2]
const bottomOf = (b: readonly number[]): number => b[1] + b[3]

/** The most confident read of a line: the one its surroundings are read by. */
function bestVariant(line: ReadLine): number {
  let best = 0
  for (let k = 1; k < line.variants.length; k++) if (line.variants[k].conf > line.variants[best].conf) best = k
  return best
}

/** The lines' surroundings (§6.10): the line above in the same column and below, the boxes to the left on the row, recovery blocks. */
export function frameContext(lines: readonly ReadLine[], texts: readonly (string | null)[], options: DetectOptions): FrameContext {
  const n = lines.length
  const above: (number | null)[] = new Array(n).fill(null)
  const below: (number | null)[] = new Array(n).fill(null)
  const left: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const L = lines[i].box
    const h = heightOf(L)
    let best: number | null = null
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const A = lines[j].box
      if (bottomOf(A) > L[1] + 2 || L[1] - bottomOf(A) > 2.2 * h) continue
      const overlap = Math.max(0, Math.min(right(A), right(L)) - Math.max(A[0], L[0])) / Math.max(1, Math.min(A[2], L[2]))
      if (overlap < 0.3 && Math.abs(A[0] - L[0]) > h) continue
      if (best === null || bottomOf(A) > bottomOf(lines[best].box)) best = j
    }
    above[i] = best
    const cy = L[1] + L[3] / 2
    const leftOf = (o: readonly number[], j: number): boolean => j !== i && o[0] < L[0] && right(o) <= L[0] + 0.6 * h
    // A label with a line under it (a hint), the box centred on the pair: the pair is on its row (§6.10,
    // new; "Router admin PIN" over "From the sticker" at 150% display scale, 0.64 line heights above).
    const inPair = (o: readonly number[], j: number): boolean => {
      const d = o[1] + o[3] / 2 - cy
      if (Math.abs(d) >= 1.2 * h) return false
      return lines.some(({ box: p }, k) => {
        if (k === j || !leftOf(p, k) || Math.abs(p[0] - o[0]) > h) return false
        // Stacked tight, the box's centre within a quarter of their pitch of their middle.
        const e = p[1] + p[3] / 2 - cy
        return Math.abs(d + e) / 2 <= 0.25 * Math.abs(e - d) && p[1] - bottomOf(o) <= 0.6 * h && o[1] - bottomOf(p) <= 0.6 * h
      })
    }
    left[i] = lines
      .map((o, j) => ({ o: o.box, j }))
      .filter(({ o, j }) => leftOf(o, j) && (Math.abs(o[1] + o[3] / 2 - cy) < 0.6 * h || inPair(o, j)))
      .sort((a, b) => a.o[0] - b.o[0])
      .map(({ j }) => j)
  }
  for (let i = 0; i < n; i++) {
    const a = above[i]
    if (a !== null && (below[a] === null || lines[below[a]!].box[1] > lines[i].box[1])) below[a] = i
  }
  const recovery: boolean[] = new Array(n).fill(false)
  for (let i = 0; i < n; i++) {
    let prose = 0
    for (let a = above[i], k = 0; a !== null && k < 8; a = above[a], k++) {
      const t = texts[a] ?? ''
      if (LABELS.recovery.test(t)) {
        recovery[i] = true
        break
      }
      if (t.split(/\s+/).length > 6 && ++prose > 1) break
    }
  }
  return { frame: options.frame, regions: options.regions, kinds: new Set(options.kinds), names: options.names, above, below, left, recovery, best: lines.map(bestVariant) }
}

/** Every rule on one read of one line, in windows of 512 characters (§10.3). */
function lineRules(line: DetectLine, ctx: FrameContext, context: (j: number | null) => CleanLine | null): Hit[] {
  const above = context(ctx.above[line.index])
  const aboveIndex = ctx.above[line.index]
  const above2 = aboveIndex === null ? null : context(ctx.above[aboveIndex])
  const left = ctx.left[line.index].map((j) => context(j)).filter((c): c is CleanLine => !!c)
  const found: Hit[] = []
  for (const w of lineWindows(line.clean.text)) {
    const view = windowOf(line.clean, w.start, w.text.length)
    const lctx: LineContext = { line, above, above2, left, recovery: ctx.recovery[line.index], regions: ctx.regions, kinds: ctx.kinds, names: ctx.names, found: [], offset: w.start, frame: ctx.frame }
    for (const find of FINDERS) for (const h of find(view, lctx)) lctx.found.push(h)
    found.push(...lctx.found)
  }
  return extendAtEdges(found, line.clean, line.index, line.variant)
}

/** The own text of a span (the raw characters of that read). */
function spanText(lines: ReadonlyMap<string, DetectLine>, s: HitSpan): string {
  return lines.get(`${s.line}:${s.variant}`)?.raw.slice(s.start, s.end) ?? ''
}

/** Each span's x-range, by line. */
function ranges(h: Hit, lineOf: (s: HitSpan) => DetectLine | undefined): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>()
  for (const s of h.spans) {
    const l = lineOf(s)
    if (!l) continue
    const n = l.raw.length
    const a = n ? l.chars[2 * Math.max(0, Math.min(n - 1, s.start))] : l.box[0]
    const b = n ? l.chars[2 * Math.max(Math.min(n, s.end), Math.min(n - 1, s.start) + 1) - 1] : right(l.box)
    const x0 = h.block ? Math.min(a, h.block[0]) : a
    const x1 = h.block ? Math.max(b, h.block[1]) : b
    out.set(s.line, [...(out.get(s.line) ?? []), [x0, x1]])
  }
  return out
}

/** Whether two hits overlap on a line they share. */
function overlaps(a: Map<number, [number, number][]>, b: Map<number, [number, number][]>): boolean {
  for (const [line, ra] of a) {
    const rb = b.get(line)
    if (!rb) continue
    for (const x of ra) for (const y of rb) if (x[0] < y[1] && y[0] < x[1]) return true
  }
  return false
}

/** Whether every part of `a` lies inside a part of `b` on the same line (within half a pixel). */
function contained(a: Map<number, [number, number][]>, b: Map<number, [number, number][]>): boolean {
  for (const [line, ra] of a) {
    const rb = b.get(line)
    if (!rb) return false
    for (const x of ra) if (!rb.some((y) => y[0] <= x[0] + 0.5 && y[1] >= x[1] - 0.5)) return false
  }
  return a.size > 0
}

/** Kinds on, scores of 0.50 or more, never-hide, the reads joined, contained hits dropped, boxes padded (§6.1); `lines` by `${line}:${variant}`. */
export function finishHits(hits: readonly Hit[], lines: ReadonlyMap<string, DetectLine>, options: DetectOptions): Hit[] {
  const kinds = new Set(options.kinds)
  const lineOf = (s: HitSpan): DetectLine | undefined => lines.get(`${s.line}:${s.variant}`)
  const never = options.names.never
  const live = hits.filter((h) => kinds.has(h.kind) && h.score >= CHECK_SCORE && !(never.size && h.spans.length && never.has(nameFold(h.spans.map((s) => spanText(lines, s)).join(' ')))))
  // Variants: hits of one kind that overlap are joined; the higher score and the union of their spans win.
  const joined: { hit: Hit; r: Map<number, [number, number][]> }[] = []
  for (const h of [...live].sort((a, b) => b.score - a.score || b.spans.length - a.spans.length)) {
    const r = ranges(h, lineOf)
    const into = h.spans.length ? joined.find((j) => j.hit.kind === h.kind && overlaps(j.r, r)) : undefined
    if (!into) {
      joined.push({ hit: { ...h, spans: [...h.spans] }, r })
      continue
    }
    const spans = unionSpans([...into.hit.spans, ...h.spans])
    const block: [number, number] | undefined = into.hit.block || h.block ? [Math.min(into.hit.block?.[0] ?? Infinity, h.block?.[0] ?? Infinity), Math.max(into.hit.block?.[1] ?? -Infinity, h.block?.[1] ?? -Infinity)] : undefined
    into.hit = { ...into.hit, spans, ...(block ? { block } : {}), ...(into.hit.lost || h.lost ? { lost: true as const } : {}) }
    into.r = ranges(into.hit, lineOf)
  }
  // Dedupe: a hit contained in a kept hit is dropped; never one that only overlaps a hit of another kind.
  joined.sort((a, b) => b.hit.score - a.hit.score || width(b.r) - width(a.r))
  const kept: { hit: Hit; r: Map<number, [number, number][]> }[] = []
  for (const j of joined) if (!j.hit.spans.length || !kept.some((k) => k.hit.spans.length && contained(j.r, k.r))) kept.push(j)
  return kept
    .map(({ hit }) => {
      if (!hit.spans.length) return hit
      const box = coverBox(hit.spans, lineOf, options.frame, hit.block)
      return { ...hit, box: hit.lost ? clipBox(box[0], box[1], box[0] + box[2], options.frame.height, options.frame) : box }
    })
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0] || a.kind.localeCompare(b.kind))
}

/** Spans with those of one read of a line that overlap or touch merged into one, in their first order. */
function unionSpans(spans: readonly HitSpan[]): HitSpan[] {
  const out: HitSpan[] = []
  for (const s of spans) {
    const same = out.findIndex((x) => x.line === s.line && x.variant === s.variant && x.start <= s.end && s.start <= x.end)
    if (same < 0) out.push({ ...s })
    else out[same] = { ...out[same], start: Math.min(out[same].start, s.start), end: Math.max(out[same].end, s.end) }
  }
  return out
}

const width = (r: Map<number, [number, number][]>): number => {
  let w = 0
  for (const xs of r.values()) for (const x of xs) w += x[1] - x[0]
  return w
}

/** A QR code's hit: its quad's box padded by four modules' worth (the quiet zone), at most. */
function qrHit(q: ReadResult['qr'][number], frame: DetectOptions['frame']): Hit | null {
  if (!q.quad.length) return null
  const xs = q.quad.map((p) => p[0])
  const ys = q.quad.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const x1 = Math.max(...xs)
  const y1 = Math.max(...ys)
  const pad = Math.max(4, (4 * Math.min(x1 - x0, y1 - y0)) / 21)
  const c = classQr(q.payload)
  return { kind: 'qr', rule: 'qr-' + c.class, score: c.score, spans: [], box: clipBox(x0 - pad, y0 - pad, x1 + pad, y1 + pad, frame) }
}

/**
 * The hits of one read of a frame: every rule on every read of every line, the rows and columns, the
 * QR codes; reads joined, contained hits dropped, boxes padded and clipped (§6.1). Hits below 0.50 and
 * of kinds that are off are not returned.
 */
export function detectFrame(lines: readonly ReadLine[], qr: ReadResult['qr'], options: DetectOptions): Hit[] {
  const reads: DetectLine[] = []
  const byKey = new Map<string, DetectLine>()
  lines.forEach((line, i) =>
    line.variants.forEach((_v, k) => {
      const d = detectLineOf(line, i, k)
      reads.push(d)
      byKey.set(`${i}:${k}`, d)
    })
  )
  const bests = lines.map(bestVariant)
  const texts = lines.map((l, i) => (l.variants.length ? byKey.get(`${i}:${bests[i]}`)!.clean.label : null))
  const ctx = frameContext(lines, texts, options)
  const contextOf = (j: number | null): CleanLine | null => (j === null ? null : (byKey.get(`${j}:${ctx.best[j]}`)?.clean ?? null))
  const hits: Hit[] = []
  for (const r of reads) hits.push(...lineRules(r, ctx, contextOf))
  const all = rowRules(reads, hits, ctx)
  for (const q of qr) {
    const h = qrHit(q, options.frame)
    if (h) all.push(h)
  }
  return finishHits(all, byKey, options)
}

/**
 * Careful-long's trigger (§5.6, question 16): a line the small recogniser reads again because it has a
 * rule hit, a confidence under 0.9, or a run of 16 or more token characters after cleaning. A line
 * already read again needs nothing more.
 */
export function needsCareful(line: ReadLine, hits: readonly Hit[], index: number): boolean {
  if (!line.variants.length || line.variants.some((v) => v.model === 'small')) return false
  if (hits.some((h) => h.spans.some((s) => s.line === index))) return true
  const first = line.variants[0]
  if (first.conf < 0.9) return true
  return LONG_TOKEN_RUN.test(cleanLine(first.text).text)
}

/** A hit's own text folded (§6.2): its group key, kept in main's memory only (§5.7). */
export function groupKeyOf(hit: Hit, lines: readonly ReadLine[]): string {
  return foldText(hit.spans.map((s) => lines[s.line]?.variants[s.variant]?.text.slice(s.start, s.end) ?? '').join(''))
}
