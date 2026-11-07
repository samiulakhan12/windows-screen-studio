/**
 * A seeded randomized differential test of text records' word maps (docs/design/captions-studio.md
 * §11.1 rule 1, §11.8): random captions made of known pieces (plain words, word-list heard forms
 * and terms, spelled numbers, punctuation written apart), random word lists and Digits choices,
 * one or two tidies, random marks (before the tidy or on the tidied words), keyword anchors and
 * places, then Keep and Remove in a random order through the editor's store. Checked against the
 * pieces the captions were made of: after Remove every mark and anchor covers exactly the words it
 * covered before the tidy (a mark on part of a piece the tidy wrote as one, the whole piece; a term
 * said as its own words, in lower case, is a piece per word; a comma written apart goes with the
 * last word of its piece).
 */
import { describe, expect, it } from 'vitest'
import { settleCaptionAuto } from '../src/shared/captions/captionAutoSettle'
import { tidyCaptions, type CleanupChoices, type WordListEntry } from '../src/shared/captions/cleanup'
import { studioWordTexts } from '../src/shared/captions/words'
import { EditStore } from '../src/shared/editor/editStore'
import { settleDeletedWords } from '../src/shared/editor/transcript'
import { migrateProject } from '../src/shared/engine/project'
import { settleAutoCuts } from '../src/shared/review/autoCuts'
import { EMPHASIS_GROUP, TEXT_GROUP } from '../src/shared/review/captionReview'
import { keepItems, removeItems, reviewItems } from '../src/shared/review/review'
import type { CaptionMark, CaptionSegment, Graphic, Project } from '../src/shared/types'
import { studioProject } from './p4Fixtures'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
function below1000(n: number, hyphen: boolean): string[] {
  const out: string[] = []
  const h = Math.floor(n / 100)
  const rest = n % 100
  if (h) out.push(ONES[h], 'hundred')
  if (h && rest) out.push('and')
  if (rest && rest < 20) out.push(ONES[rest])
  else if (rest) {
    if (rest % 10 && hyphen) out.push(`${TENS[Math.floor(rest / 10)]}-${ONES[rest % 10]}`)
    else out.push(TENS[Math.floor(rest / 10)], ...(rest % 10 ? [ONES[rest % 10]] : []))
  }
  return out
}
/** A number spelled in English ("two hundred and fifty", "three thousand four", "twenty-five", "two million"). */
function spell(n: number, hyphen: boolean): string[] {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return [...below1000(n / 1_000_000, hyphen), 'million']
  const th = Math.floor(n / 1000)
  const rest = n % 1000
  return [...(th ? [...below1000(th, hyphen), 'thousand'] : []), ...(rest ? below1000(rest, hyphen) : [])]
}

/** The word list a scenario draws from: terms with spaces and punctuation, heard forms of one to three words. */
const ENTRIES: WordListEntry[] = [
  { term: 'Flown', heard: ['flow in'] },
  { term: 'Q&A', heard: ['q and a'] },
  { term: 'R&D', heard: ['r and d'] },
  { term: 'Google Docs', heard: ['google dogs'] },
  { term: 'DevOps', heard: ['ops'] },
  { term: 'VS Code', heard: ['vscode'] },
  { term: 'Visual Studio', heard: [] }
]
/** Plain words: some are also parts of heard forms ("and", "in", "d", "dogs"), so the same word comes again; none starts a heard form or is a number. */
const PLAIN = ['open', 'and', 'in', 'the', 'save', 'users', 'click', 'then', 'd', 'dogs', 'teams', 'we', 'it', 'and', 'in', 'go', 'docs']

/** A piece of a caption: its words as said, and how many words it is once tidied. */
interface Piece {
  words: string[]
  tidied: number
  /** A term said as its own words ("visual studio"): each word is a piece of its own once punctuated. */
  apart?: true
  /** A comma written apart at its end: it joins the last tidied word alone. */
  comma?: true
}

/** A random caption of pieces, with the word-list entries it uses, for a Digits choice. */
function caption(r: () => number, digits: CleanupChoices['digits'], entries: WordListEntry[]): Piece[] {
  const pieces: Piece[] = []
  const n = 2 + Math.floor(r() * 9)
  let lastNumber = false
  for (let k = 0; k < n; k++) {
    const roll = r()
    if (roll < 0.3 && !lastNumber) {
      // A number; never right after another one, nor after "and" after one.
      const big = r()
      const value = big < 0.3 ? 2 + Math.floor(r() * 18) : big < 0.6 ? 20 + Math.floor(r() * 980) : big < 0.9 ? 1000 + Math.floor(r() * 998_999) : (2 + Math.floor(r() * 8)) * 1_000_000
      const words = spell(value, r() < 0.3)
      const converted = digits === 'all' || (digits === 'above-ten' && value > 10)
      if (converted) pieces.push({ words, tidied: 1 })
      // Left as words: each word is its own piece.
      else for (const w of words) pieces.push({ words: [w], tidied: 1 })
      lastNumber = true
      continue
    }
    if (roll < 0.55 && entries.length) {
      const e = entries[Math.floor(r() * entries.length)]
      const said = e.heard.length && r() < 0.8 ? e.heard[Math.floor(r() * e.heard.length)] : e.term.toLowerCase()
      const tidied = studioWordTexts(e.term, 'en').length
      const words = said.split(' ')
      pieces.push({ words, tidied, ...(said === e.term.toLowerCase() && words.length === tidied && tidied > 1 ? { apart: true as const } : {}) })
    } else {
      const w = PLAIN[Math.floor(r() * PLAIN.length)]
      // "and" after a number is fine, but a number may not follow it.
      pieces.push({ words: [w], tidied: 1 })
      if (lastNumber && w === 'and') continue
    }
    lastNumber = false
  }
  // Punctuation: a comma on a piece's last word, or written apart (it joins the word before it).
  for (const p of pieces) {
    const roll = r()
    if (roll < 0.1) p.words = [...p.words.slice(0, -1), `${p.words[p.words.length - 1]},`]
    else if (roll < 0.17) {
      p.words = [...p.words, ',']
      p.comma = true
    }
  }
  // A term said as its own words keeps each word on its own; a comma written apart goes with the last.
  return pieces.flatMap((p) => (p.apart ? Array.from({ length: p.tidied }, (_, k) => ({ words: k < p.tidied - 1 ? [p.words[k]] : p.words.slice(k), tidied: 1, ...(k === p.tidied - 1 && p.comma ? { comma: true as const } : {}) })) : [p]))
}

/**
 * For each word index, its piece; for each piece, its first word (as said, and as tidied); and
 * where words go: `tidy`, said words a..b as tidied words (each piece's words onto all of its
 * tidied words, a comma written apart onto the last only); `back`, tidied words a..b as said words
 * (each onto all of its piece's words, but a tidied word before the last of a piece with a comma
 * written apart, which leaves the comma out).
 */
function index(pieces: Piece[]): {
  saidPiece: number[]
  tidiedPiece: number[]
  saidAt: number[]
  tidiedAt: number[]
  tidy: (a: number, b: number) => [number, number]
  back: (a: number, b: number) => [number, number]
} {
  const saidPiece: number[] = []
  const tidiedPiece: number[] = []
  const saidAt: number[] = []
  const tidiedAt: number[] = []
  pieces.forEach((p, i) => {
    saidAt.push(saidPiece.length)
    tidiedAt.push(tidiedPiece.length)
    for (const _ of p.words) saidPiece.push(i)
    for (let k = 0; k < p.tidied; k++) tidiedPiece.push(i)
  })
  saidAt.push(saidPiece.length)
  tidiedAt.push(tidiedPiece.length)
  const tidy = (a: number, b: number): [number, number] => {
    const p = saidPiece[a]
    const comma = pieces[p].comma && a === saidAt[p + 1] - 1 && saidAt[p + 1] - saidAt[p] > 1
    return [comma ? tidiedAt[p + 1] - 1 : tidiedAt[p], tidiedAt[saidPiece[b] + 1] - 1]
  }
  const back = (a: number, b: number): [number, number] => {
    const p = tidiedPiece[b]
    const comma = pieces[p].comma && b < tidiedAt[p + 1] - 1
    return [saidAt[tidiedPiece[a]], saidAt[p + 1] - (comma ? 2 : 1)]
  }
  return { saidPiece, tidiedPiece, saidAt, tidiedAt, tidy, back }
}

/** JSON with keys in order: the same data whatever order its fields were set in. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

const storeOf = (p: Project): EditStore<Project> => new EditStore(p, undefined, undefined, undefined, (next, prev) => settleAutoCuts(settleCaptionAuto(settleDeletedWords(next, prev), prev), prev))

type Times = 'exact' | 'estimated' | 'none'

interface Scenario {
  seed: number
  failures: string[]
  /** What the scenario covered: marks before or after the tidy, the word times, one tidy or two, Remove on the group or on items. */
  kind: string
}

function run(seed: number): Scenario {
  const r = rng(seed)
  const failures: string[] = []
  const fail = (what: string): void => void failures.push(`seed ${seed}: ${what}`)
  const digits = (['all', 'above-ten', 'off'] as const)[Math.floor(r() * 3)]
  const entries = ENTRIES.filter(() => r() < 0.6)
  const times = (['exact', 'estimated', 'none'] as Times[])[Math.floor(r() * 3)]
  const count = 1 + Math.floor(r() * 3)
  const shapes = Array.from({ length: count }, () => caption(r, digits, entries))
  // Captions 4 s apart; a full stop goes on each (a long pause after it).
  const segments: CaptionSegment[] = shapes.map((pieces, i) => {
    const said = pieces.flatMap((p) => p.words)
    const start = i * 4
    const end = start + 2.5
    const seg: CaptionSegment = { id: `c${i}`, start, end, text: said.join(' ') }
    if (times === 'none') return seg
    const step = (end - start) / said.length
    return { ...seg, words: said.map((text, k) => ({ text, start: start + k * step, end: start + (k + 1) * step, ...(times === 'estimated' ? { estimated: true as const } : {}) })) }
  })
  const s = storeOf(migrateProject(JSON.parse(JSON.stringify(studioProject({ segments })))))
  const textOf = (q: Project, id: string): string => q.transcript!.segments.find((x) => x.id === id)!.text
  const wordsAt = (q: Project, id: string, from: number, to: number): string => studioWordTexts(textOf(q, id), 'en').slice(from, to + 1).join(' ')
  // Marks before the tidy (the user's), or on the tidied words (automatic, as Make my captions great picks them).
  const before = r() < 0.5
  // Each mark's words once Remove put the text back, and (made before the tidy) once tidied.
  const marks = new Map<string, { said: [number, number]; tidied?: [number, number] }>()
  const pick = (n: number): [number, number] => {
    const a = Math.floor(r() * n)
    const b = Math.min(n - 1, a + Math.floor(r() * 3))
    return [a, b]
  }
  if (before) {
    s.update((q) => {
      const list: CaptionMark[] = shapes.map((pieces, i) => {
        const [a, b] = pick(pieces.flatMap((p) => p.words).length)
        return { id: `m${i}`, caption: `c${i}`, from: a, to: b, text: wordsAt(q, `c${i}`, a, b) }
      })
      return { ...q, captionMarks: list, captionPlaces: shapes.map((_, i) => ({ caption: `c${i}`, position: i % 2 ? 'top' : 'bottom' })) }
    })
    for (const m of s.state.captionMarks ?? []) {
      const ix = index(shapes[+m.caption.slice(1)])
      const tidied = ix.tidy(m.from, m.to)
      marks.set(m.id, { said: ix.back(...tidied), tidied })
    }
  }
  // One tidy, or two: the first with capitals and part of the word list only.
  const all: CleanupChoices = { caps: true, punct: true, digits, bleep: 'off', bleepSound: 'tone', ai: false }
  const twice = r() < 0.4
  if (twice) {
    const first = entries.filter(() => r() < 0.5)
    s.update((q) => tidyCaptions(q, { ...all, punct: false, digits: 'off', words: first }).project)
  }
  s.update((q) => tidyCaptions(q, { ...all, words: entries }).project)
  // The pieces as tidied: as many words as expected.
  shapes.forEach((pieces, i) => {
    const want = pieces.reduce((n, p) => n + p.tidied, 0)
    const have = studioWordTexts(textOf(s.state, `c${i}`), 'en').length
    if (want !== have) fail(`c${i} “${segments[i].text}” → “${textOf(s.state, `c${i}`)}”: ${have} words, expected ${want}`)
  })
  if (failures.length) return { seed, failures, kind: '' }
  // Marks before the tidy are on the tidied words of their pieces now.
  for (const m of s.state.captionMarks ?? []) {
    const want = marks.get(m.id)?.tidied
    if (!want) continue
    if (m.from !== want[0] || m.to !== want[1]) fail(`tidy moved mark ${m.id} to ${m.from}..${m.to}, expected ${want}`)
  }
  if (!before) {
    s.update((q) => ({
      ...q,
      captionMarks: shapes.map((pieces, i): CaptionMark => {
        const [a, b] = pick(pieces.reduce((n, p) => n + p.tidied, 0))
        return { id: `m${i}`, caption: `c${i}`, from: a, to: b, text: wordsAt(q, `c${i}`, a, b), auto: true }
      }),
      captionPlaces: shapes.map((_, i) => ({ caption: `c${i}`, position: i % 2 ? 'top' : 'bottom' }))
    }))
    for (const m of s.state.captionMarks ?? []) {
      const ix = index(shapes[+m.caption.slice(1)])
      marks.set(m.id, { said: ix.back(m.from, m.to) })
    }
  }
  // A keyword pop-up anchored on the tidied words of each caption.
  const anchors = new Map<string, [number, number]>()
  s.update((q) => ({
    ...q,
    graphics: shapes.map((pieces, i): Graphic => {
      const [a, b] = pick(pieces.reduce((n, p) => n + p.tidied, 0))
      const seg = q.transcript!.segments[i]
      const text = wordsAt(q, `c${i}`, a, b)
      return { id: `k${i}`, kind: 'keyword', text, look: 'card', start: seg.start, end: seg.end, place: 'auto', size: 0.1, enter: { kind: 'pop', duration: 0.3, strength: 1 }, exit: { kind: 'fade', duration: 0.3, strength: 1 }, anchor: { caption: `c${i}`, from: a, to: b, text }, auto: { by: 'keyword', via: 'rules', caption: `c${i}` } } as Graphic
    })
  }))
  for (const g of s.state.graphics ?? []) {
    if (g.kind !== 'keyword' || !g.anchor) continue
    const ix = index(shapes[+g.anchor.caption.slice(1)])
    anchors.set(g.id, ix.back(g.anchor.from, g.anchor.to))
  }
  const tidiedMarks = new Map((s.state.captionMarks ?? []).map((m) => [m.id, [m.from, m.to] as [number, number]]))
  const tidiedAnchors = new Map((s.state.graphics ?? []).flatMap((g) => (g.kind === 'keyword' && g.anchor ? [[g.id, [g.anchor.from, g.anchor.to] as [number, number]] as const] : [])))
  // Keep and Remove in a random order: each caption's text item kept, removed or left; the emphasis kept or left.
  type Op = { kind: 'text'; caption: string; action: 'keep' | 'remove' } | { kind: 'emphasis' }
  const ops: Op[] = shapes.map((_, i) => ({ kind: 'text' as const, caption: `c${i}`, action: r() < 0.75 ? ('remove' as const) : ('keep' as const) }))
  const keepEmphasis = !before && r() < 0.5
  if (keepEmphasis) ops.push({ kind: 'emphasis' })
  for (let k = ops.length - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1))
    ;[ops[k], ops[j]] = [ops[j], ops[k]]
  }
  const byGroup = r() < 0.3 && ops.every((o) => o.kind !== 'text' || o.action === 'remove')
  if (byGroup) {
    // Remove on the text group row, the emphasis kept before or after.
    if (keepEmphasis && r() < 0.5) s.update((q) => keepItems(q, [reviewItems(q).find((x) => x.key === EMPHASIS_GROUP)!]))
    s.update((q) => removeItems(q, [reviewItems(q).find((x) => x.key === TEXT_GROUP)!]))
    if (keepEmphasis && s.state.captionMarks?.some((m) => m.auto)) s.update((q) => keepItems(q, [reviewItems(q).find((x) => x.key === EMPHASIS_GROUP)!]))
  } else {
    for (const op of ops) {
      if (op.kind === 'emphasis') {
        const row = reviewItems(s.state).find((x) => x.key === EMPHASIS_GROUP)
        if (row) s.update((q) => keepItems(q, [row]))
        continue
      }
      const item = reviewItems(s.state).find((x) => x.key === TEXT_GROUP)?.parts?.find((p) => p.key === `text:${op.caption}`)
      if (!item) continue
      s.update((q) => (op.action === 'keep' ? keepItems(q, [item]) : removeItems(q, [item])))
    }
  }
  // Each caption: its words before the tidy where it was removed, else the tidied ones.
  const removed = new Set(ops.filter((o): o is Extract<Op, { kind: 'text' }> => o.kind === 'text' && o.action === 'remove').map((o) => o.caption))
  shapes.forEach((_, i) => {
    const id = `c${i}`
    if (removed.has(id) !== (textOf(s.state, id) === segments[i].text)) fail(`${id} text “${textOf(s.state, id)}”`)
  })
  // Every mark and anchor on exactly its words.
  const marksNow = new Map((s.state.captionMarks ?? []).map((m) => [m.id, m]))
  for (const [id, { said }] of marks) {
    const m = marksNow.get(id)
    const caption = `c${id.slice(1)}`
    const want = removed.has(caption) ? said : tidiedMarks.get(id)!
    if (!m) fail(`mark ${id} gone`)
    else if (m.caption !== caption || m.from !== want[0] || m.to !== want[1]) fail(`mark ${id} on ${m.from}..${m.to} “${m.text}” of “${textOf(s.state, caption)}”, expected ${want} (${removed.has(caption) ? 'removed' : 'kept'})`)
    else if (!!m.auto !== (!before && !keepEmphasis)) fail(`mark ${id} auto ${!!m.auto}`)
  }
  for (const [id, said] of anchors) {
    const g = s.state.graphics?.find((x) => x.id === id)
    const caption = `c${id.slice(1)}`
    const want = removed.has(caption) ? said : tidiedAnchors.get(id)!
    const a = g && g.kind === 'keyword' ? g.anchor : undefined
    if (!a || a.from !== want[0] || a.to !== want[1]) fail(`anchor ${id} on ${a ? `${a.from}..${a.to}` : 'nothing'}, expected ${want}`)
  }
  // Places stay with their captions.
  if (JSON.stringify(s.state.captionPlaces) !== JSON.stringify(shapes.map((_, i) => ({ caption: `c${i}`, position: i % 2 ? 'top' : 'bottom' })))) fail('places moved')
  // The project in memory is what saving and reopening gives.
  const saved = migrateProject(JSON.parse(JSON.stringify(s.state)))
  for (const key of ['captionMarks', 'captionPlaces', 'graphics', 'captionAuto'] as const) if (canonical(saved[key]) !== canonical(s.state[key])) fail(`${key} differs once saved: ${canonical(s.state[key])} → ${canonical(saved[key])}`)
  return { seed, failures, kind: `${before ? 'before' : 'after'} ${times} ${twice ? 'twice' : 'once'} ${byGroup ? 'group' : 'items'}` }
}

describe('word maps: random captions, word lists, numbers, marks and orders (seeded)', () => {
  it('after Remove every mark and anchor covers exactly the words it covered before the tidy', () => {
    const failures: string[] = []
    const kinds = new Map<string, number>()
    for (let seed = 1; seed <= 600; seed++) {
      const out = run(seed)
      failures.push(...out.failures)
      kinds.set(out.kind, (kinds.get(out.kind) ?? 0) + 1)
    }
    expect(failures.slice(0, 20), `${failures.length} failures`).toEqual([])
    // Every mix of marks before or after, word times, one tidy or two, and group or item Remove came up.
    expect(kinds.size).toBe(2 * 3 * 2 * 2)
  })
})
