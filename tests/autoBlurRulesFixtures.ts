/*
 * Helpers of the text rules' tests (docs/design/auto-blur.md §17.1, tests 101-135 and 223-228): the
 * rule vectors with their placeholders expanded as scripts/privacy/detect/runVectors.mjs does, lines
 * laid out as a reader returns them, the committed reads and truth of the evaluation set, and the
 * scorer of scripts/privacy/detect/evalReads.mjs (found: hits cover half an item; covered: the padded
 * covers hold all of it). Token-shaped values are made at run time from seeded placeholders, so no
 * test source holds one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DEFAULT_KINDS } from '../src/shared/privacy/kinds'
import type { Box, ReadLine } from '../src/shared/privacy/protocol'
import { detectFrame, type Hit } from '../src/shared/privacy/detect/detect'
import { compileNames, NO_NAMES } from '../src/shared/privacy/detect/names'
import type { PrivateKind, Transcript } from '../src/shared/types'

export const ROOT = path.resolve(__dirname, '..')
const EVAL = path.join(ROOT, 'tests', 'fixtures', 'privacy-eval')

/* ---------- vectors ---------- */

export interface ScreenVector {
  id: string
  rule: string
  text: string
  expect: { kind: string; text: string; tier: 'auto' | 'check' }[]
  regions?: string[]
  above?: string
  options?: { dots?: boolean; randomStrings?: boolean }
  names?: string[]
  left?: string[]
  recovery?: boolean
}
export interface SpeechVector {
  id: string
  rule: string
  words: string
  expect: { kind: string; words: string }[]
}
export interface Vectors {
  seed: number
  screen: ScreenVector[]
  speech: SpeechVector[]
}

export const VECTORS: Vectors = JSON.parse(fs.readFileSync(path.join(EVAL, 'rule-vectors.json'), 'utf8'))

const CLASSES: Record<string, string> = {
  A: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  a: 'abcdefghijklmnopqrstuvwxyz0123456789',
  H: '0123456789abcdef',
  U: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  D: '0123456789',
  L: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  B: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
  S: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+'
}
function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32
}
function hash(s: string): number {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return h
}
/** The placeholder expander of one vector (`«=ghp_|A36»`: text, then 36 characters of class A), seeded by the vector's id. */
export function expander(id: string, seed = VECTORS.seed): (s: string) => string {
  const cache = new Map<string, string>()
  const r = rng(seed ^ hash(id))
  return (str) =>
    str.replace(/«([^»]*)»/g, (_m, body: string) => {
      const hit = cache.get(body)
      if (hit !== undefined) return hit
      let out = ''
      for (const item of body.split('|')) {
        if (item.startsWith('=')) out += item.slice(1)
        else {
          const cls = CLASSES[item[0]]
          const n = Number(item.slice(1))
          for (let i = 0; i < n; i++) out += cls[Math.floor(r() * cls.length)]
        }
      }
      cache.set(body, out)
      return out
    })
}
/** A token made at run time: `«…»` placeholders expanded with `seed`. */
export const token = (pattern: string, seed = 1): string => expander('token:' + pattern, seed)(pattern)

/* ---------- lines ---------- */

/** A line as the reader returns it: each character 10 px wide, at (x, y), 20 px high. */
export function line(text: string, x = 100, y = 200, opts: { charW?: number; h?: number; model?: 'tiny' | 'small'; conf?: number; more?: { text: string; model?: 'tiny' | 'small'; conf?: number }[] } = {}): ReadLine {
  const w = opts.charW ?? 10
  const h = opts.h ?? 20
  const variant = (t: string, model: 'tiny' | 'small', conf: number) => ({ model, text: t, conf, spans: Array.from({ length: t.length }, (_v, i) => [x + i * w, x + (i + 1) * w] as [number, number]) })
  const n = Math.max(text.length, ...(opts.more ?? []).map((m) => m.text.length))
  const box: Box = [x, y, n * w, h]
  return {
    box,
    quad: [
      [x, y],
      [x + n * w, y],
      [x + n * w, y + h],
      [x, y + h]
    ],
    variants: [variant(text, opts.model ?? 'tiny', opts.conf ?? 0.99), ...(opts.more ?? []).map((m) => variant(m.text, m.model ?? 'small', m.conf ?? 0.99))],
    ring: '#1c1c22',
    spread: 0
  }
}

export const FRAME = { width: 1920, height: 1080 }

/** The kinds a vector is run with: the defaults, and the off-by-default ones it turns on. */
export function vectorKinds(v: Pick<ScreenVector, 'options'>): PrivateKind[] {
  const kinds: PrivateKind[] = [...DEFAULT_KINDS]
  if (v.options?.dots) kinds.push('dots')
  if (v.options?.randomStrings) kinds.push('random')
  return kinds
}

/** The product kind a vector's kind is (§6: IBANs are card and bank numbers, link secrets are 'link', dots and random text their own kinds). */
export function productKind(v: ScreenVector, kind: string): PrivateKind {
  if (kind === 'bank') return 'card'
  if (kind === 'key' && (v.id.startsWith('url-') || v.id === 'key-dsn' || v.id === 'reg-sas')) return 'link'
  if (v.options?.randomStrings && kind === 'key') return 'random'
  if (v.options?.dots && kind === 'password') return 'dots'
  return kind as PrivateKind
}

/** A vector's lines: its line, the label line above, the boxes to its left, and a recovery heading. */
export function vectorLines(v: ScreenVector, ex: (s: string) => string): { lines: ReadLine[]; main: number } {
  const lines: ReadLine[] = []
  let x = 100
  for (const l of v.left ?? []) {
    const t = ex(l)
    lines.push(line(t, x, 400))
    x += t.length * 10 + 30
  }
  const main = lines.length
  lines.push(line(ex(v.text), x, 400))
  if (v.above) lines.push(line(ex(v.above), x, 370))
  if (v.recovery) lines.push(line('Recovery codes', x, v.above ? 340 : 370))
  return { lines, main }
}

export const tier = (s: number): 'auto' | 'check' | 'drop' => (s >= 0.85 ? 'auto' : s >= 0.5 ? 'check' : 'drop')

/** The own text of a hit on line `index` (its spans there, joined). */
export function hitText(h: Hit, lines: readonly ReadLine[], index: number): string {
  return h.spans
    .filter((s) => s.line === index)
    .map((s) => lines[s.line].variants[s.variant].text.slice(s.start, s.end))
    .join('')
}

/** The hits on one line (`text`), with a label line above, boxes to its left and other lines below it: each with its own text and tier. */
export function hitsOn(
  text: string,
  opts: { above?: string; above2?: string; left?: string[]; below?: string[]; kinds?: PrivateKind[]; regions?: string[]; names?: string[]; neverHide?: string[]; recovery?: boolean } = {}
): { kind: PrivateKind; rule: string; score: number; text: string; tier: string; hit: Hit }[] {
  const lines: ReadLine[] = []
  let x = 100
  for (const l of opts.left ?? []) {
    lines.push(line(l, x, 400))
    x += l.length * 10 + 30
  }
  const main = lines.length
  lines.push(line(text, x, 400))
  if (opts.above) lines.push(line(opts.above, x, 370))
  if (opts.above2) lines.push(line(opts.above2, x, 340))
  if (opts.recovery) lines.push(line('Recovery codes', x, opts.above ? 340 : 370))
  ;(opts.below ?? []).forEach((b, i) => lines.push(line(b, x, 424 + 24 * i)))
  const hits = detectFrame(lines, [], { kinds: opts.kinds ?? DEFAULT_KINDS, regions: opts.regions ?? ['US', 'BD'], names: compileNames(opts.names ?? [], opts.neverHide ?? []), frame: FRAME })
  return hits.filter((h) => h.spans.some((s) => s.line === main)).map((h) => ({ kind: h.kind, rule: h.rule, score: h.score, text: hitText(h, lines, main), tier: tier(h.score), hit: h }))
}

/** What is wrong with one screen vector ([] when it passes). */
export function screenProblems(v: ScreenVector): string[] {
  const ex = expander(v.id)
  const { lines, main } = vectorLines(v, ex)
  const hits = detectFrame(lines, [], { kinds: vectorKinds(v), regions: v.regions ?? ['US', 'BD'], names: v.names ? compileNames(v.names, []) : NO_NAMES, frame: FRAME })
  const mine = hits.filter((h) => h.spans.some((s) => s.line === main))
  const problems: string[] = []
  for (const w of v.expect) {
    const want = ex(w.text)
    const h = mine.find((x) => hitText(x, lines, main) === want)
    if (!h) problems.push(`missing ${w.kind} "${want}" (got ${mine.map((x) => `${x.kind}/${x.rule}/${x.score} "${hitText(x, lines, main)}"`).join(', ') || 'nothing'})`)
    else if (h.kind !== productKind(v, w.kind) || tier(h.score) !== w.tier) problems.push(`got ${h.kind}/${tier(h.score)} (${h.score}, ${h.rule}), want ${productKind(v, w.kind)}/${w.tier}`)
  }
  for (const h of mine) if (!v.expect.some((w) => ex(w.text) === hitText(h, lines, main))) problems.push(`extra ${h.kind}/${h.rule}/${h.score} "${hitText(h, lines, main)}"`)
  return problems
}

/** A speech vector's captions: 0.35 s words every 0.4 s, `<pause n>` adding n seconds, `||` a new caption. */
export function speechTranscript(words: string): Transcript {
  const toks = words.replace(/<pause ([\d.]+)>/g, '<pause:$1>').split(/\s+/).filter(Boolean)
  const segments: Transcript['segments'] = []
  let cur: { text: string; start: number; end: number }[] = []
  let t = 0
  const flush = (): void => {
    if (!cur.length) return
    segments.push({ id: `s${segments.length}`, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' '), words: cur })
    cur = []
  }
  for (const tok of toks) {
    if (tok === '||') {
      flush()
      continue
    }
    const p = /^<pause:([\d.]+)>$/.exec(tok)
    if (p) {
      t += Number(p[1])
      continue
    }
    cur.push({ text: tok, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.35) * 1000) / 1000 })
    t += 0.4
  }
  flush()
  return { provider: 'local', model: 'test', createdAt: '2026-11-23T00:00:00.000Z', segments }
}

/* ---------- the evaluation set ---------- */

export interface Truth {
  listedNames: string[]
  frames: { file: string; width: number; height: number; items: { id: string; kind: string; on: boolean; text: string; rects: [number, number, number, number][] }[] }[]
}
interface RawReads {
  frames: { file: string; lines: { quad: [number, number][]; bbox: [number, number, number, number]; variants: { model: 'tiny' | 'small'; text: string; conf: number; spans: [number, number][] }[] }[] }[]
}

const gz = <T>(file: string): T => JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8')) as T
export const loadTruth = (name: 'truth' | 'holdout-truth'): Truth => gz<Truth>(path.join(EVAL, `${name}.json.gz`))
/** A committed read set as the helper's lines (box as x, y, w, h). */
export function loadReads(name: string): { file: string; lines: ReadLine[] }[] {
  return gz<RawReads>(path.join(EVAL, 'reads', `${name}.json.gz`)).frames.map((f) => ({
    file: f.file,
    lines: f.lines.map((l) => ({ box: [l.bbox[0], l.bbox[1], l.bbox[2] - l.bbox[0], l.bbox[3] - l.bbox[1]] as Box, quad: l.quad, variants: l.variants, ring: '#000000', spread: 0 }))
  }))
}

/** The held-out set's frame names are its main names with an 'h' in front. */
const frameOf = <T extends { file: string }>(reads: readonly T[], file: string): T | undefined => reads.find((r) => r.file === file || r.file === 'h' + file || 'h' + r.file === file)

export interface Score {
  n: number
  found: number
  covered: number
  /** Visible (not planted to cover) items at least half covered. */
  touched: number
  misses: string[]
  touchedItems: string[]
}

/** The rules' covers scored against the truth (scripts/privacy/detect/evalReads.mjs): text items only; QR codes are the reader's. */
export function scoreReads(truth: Truth, reads: { file: string; lines: ReadLine[] }[], variants: 'first' | 'all', regions: readonly string[] = ['US', 'GB', 'BD']): Score {
  const names = compileNames(truth.listedNames, [])
  const out: Score = { n: 0, found: 0, covered: 0, touched: 0, misses: [], touchedItems: [] }
  for (const f of truth.frames) {
    const r = frameOf(reads, f.file)
    if (!r) continue
    const lines = variants === 'first' ? r.lines.map((l) => ({ ...l, variants: l.variants.slice(0, 1) })) : r.lines
    const hits = detectFrame(lines, [], { kinds: DEFAULT_KINDS, regions, names, frame: { width: f.width, height: f.height } })
    const rects = hits.map((h) => [h.box[0], h.box[1], h.box[0] + h.box[2], h.box[1] + h.box[3]])
    const coverage = (item: [number, number, number, number]): number => {
      const [x, y, w, hh] = item
      let n = 0
      let c = 0
      for (let i = 0.5; i < w; i += 2)
        for (let j = 0.5; j < hh; j += 2) {
          n++
          if (rects.some((q) => x + i >= q[0] && x + i <= q[2] && y + j >= q[1] && y + j <= q[3])) c++
        }
      return n ? c / n : 0
    }
    for (const item of f.items) {
      if (item.kind === 'qr') continue
      const covs = item.rects.map(coverage)
      if (!item.on) {
        if (Math.max(...covs) >= 0.5) {
          out.touched++
          out.touchedItems.push(`${f.file} ${item.kind} "${item.text.slice(0, 40)}"`)
        }
        continue
      }
      out.n++
      const area = item.rects.reduce((s, q) => s + q[2] * q[3], 0)
      const covArea = item.rects.reduce((s, q, i) => s + covs[i] * q[2] * q[3], 0) / area
      if (covArea >= 0.5) out.found++
      if (covs.every((c) => c >= 0.999)) out.covered++
      else out.misses.push(`${item.kind} ${item.id} ${covArea.toFixed(2)}`)
    }
  }
  return out
}
