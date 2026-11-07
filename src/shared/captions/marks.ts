/**
 * Emphasis marks and per-caption places (docs/design/captions-studio.md §2.7, §11.1): toggling
 * emphasis, and keeping marks, word anchors and places on their words through edits. Pure: each
 * function gives the project of one undo step, or the project itself when nothing changes.
 */
import { lcsPairs } from '../editor/transcript'
import type { CaptionMark, CaptionPlace, CaptionSegment, Graphic, Project, Transcript, WordAnchor } from '../types'
import { captionsOf } from './settings'
import { ANCHOR_TEXT_MAX, readCaptionMarks, readCaptionPlaces, readGraphics } from './studioData'
import { legacyTwin } from './studioEdit'
import { seedOf } from './motion'
import { lcsFewestRuns, narrowedWords, newWordsOf, oldWordsOf, wordCount, wordKey, wordRanges } from './textMap'
import { studioTokens, studioWords } from './words'

/** The marks of each caption, by caption id, each list in word order. */
export function marksByCaption(marks: readonly CaptionMark[] | undefined): ReadonlyMap<string, readonly CaptionMark[]> {
  const out = new Map<string, CaptionMark[]>()
  for (const m of marks ?? []) {
    const list = out.get(m.caption)
    if (list) list.push(m)
    else out.set(m.caption, [m])
  }
  for (const list of out.values()) list.sort((a, b) => a.from - b.from || a.to - b.to)
  return out
}

/** The words of a caption joined as the text shows them (a space where it has one), at most ANCHOR_TEXT_MAX characters. */
function wordsText(words: readonly { text: string; gap: boolean }[], from: number, to: number): string {
  let out = ''
  for (let i = from; i <= to; i++) out += (i > from && words[i].gap ? ' ' : '') + words[i].text
  return out.slice(0, ANCHOR_TEXT_MAX).trim()
}

/** A mark id from its content, unique among `taken`. */
function markId(caption: string, from: number, to: number, taken: Set<string>): string {
  const base = `m-${seedOf(`${caption}|${from}|${to}`).toString(36)}`
  let id = base
  for (let k = 2; taken.has(id); k++) id = `${base}~${k}`
  taken.add(id)
  return id
}

/** Captions ordered as the transcript has them. */
const orderOf = (t: Transcript): Map<string, number> => new Map(t.segments.map((s, i) => [s.id, i]))

/** The project with `marks` (none: no key), the captions turned into the twin when asked. */
function withMarks(project: Project, marks: CaptionMark[], twin: boolean): Project {
  const { captionMarks: _old, ...rest } = project
  void _old
  const out: Project = marks.length ? { ...rest, captionMarks: marks } : rest
  if (twin && !project.captions?.studio) {
    const captions = captionsOf(project)
    out.captions = { ...captions, studio: legacyTwin(captions) }
  }
  return out
}

/**
 * `project` with its Classic look turned into the Studio twin for automatic emphasis (Make my
 * captions great, Find important words), recorded in `captionAuto.twin` (with `none` when there
 * were no caption settings), so Review's Remove of that emphasis takes the twin away again while
 * it is unedited (§11.8). A look that has its Studio look already is left as it is.
 */
export function withAutoTwin(project: Project): Project {
  if (project.captions?.studio) return project
  const captions = captionsOf(project)
  const twin = project.captionAuto?.twin ?? (project.captions ? {} : { none: true as const })
  return { ...project, captions: { ...captions, studio: legacyTwin(captions) }, captionAuto: { ...project.captionAuto, twin } }
}

/**
 * Emphasis toggled on the words of `spans` (§2.7): removed when every selected word is already
 * emphasised, else added (tone 2 with Ctrl+Shift+B), one mark per span, replacing the marks under
 * it. On a legacy look the captions become its Studio twin in the same update, so emphasis can
 * show. The project itself when nothing changes.
 */
export function toggleEmphasis(project: Project, spans: readonly { caption: string; from: number; to: number }[], tone?: 2): Project {
  const transcript = project.transcript
  if (!transcript || !spans.length) return project
  const language = transcript.language
  const segs = new Map(transcript.segments.map((s) => [s.id, s]))
  const valid = spans
    .map((sp) => {
      const seg = segs.get(sp.caption)
      if (!seg) return null
      const words = studioWords(seg.text, language)
      const from = Math.max(0, Math.min(sp.from, sp.to))
      const to = Math.min(words.length - 1, Math.max(sp.from, sp.to))
      return Number.isInteger(from) && Number.isInteger(to) && from <= to ? { caption: sp.caption, from, to, words } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  if (!valid.length) return project
  const marks = project.captionMarks ?? []
  // Emphasised already in the tone asked for (Ctrl+B on words in the second colour gives them the first).
  const covered = (caption: string, i: number): boolean => marks.some((m) => m.caption === caption && i >= m.from && i <= m.to && (m.tone === 2) === (tone === 2))
  const all = valid.every((sp) => {
    for (let i = sp.from; i <= sp.to; i++) if (!covered(sp.caption, i)) return false
    return true
  })
  // Cut the selection out of the marks under it (a mark across its edge keeps its outer part).
  const cut: CaptionMark[] = []
  const taken = new Set(marks.map((m) => m.id))
  for (const m of marks) {
    const hits = valid.filter((sp) => sp.caption === m.caption && sp.from <= m.to && sp.to >= m.from)
    if (!hits.length) {
      cut.push(m)
      continue
    }
    let pieces: [number, number][] = [[m.from, m.to]]
    for (const sp of hits) pieces = pieces.flatMap(([a, b]): [number, number][] => [...(a < sp.from ? [[a, Math.min(b, sp.from - 1)] as [number, number]] : []), ...(b > sp.to ? [[Math.max(a, sp.to + 1), b] as [number, number]] : [])])
    pieces.forEach(([a, b], k) => cut.push({ ...m, from: a, to: b, text: wordsText(hits[0].words, a, b), id: k === 0 ? m.id : markId(m.caption, a, b, taken) }))
  }
  let next = cut
  if (!all) {
    const added: CaptionMark[] = valid.map((sp) => ({ id: markId(sp.caption, sp.from, sp.to, taken), caption: sp.caption, from: sp.from, to: sp.to, text: wordsText(sp.words, sp.from, sp.to), ...(tone === 2 ? { tone: 2 as const } : {}) }))
    next = [...cut, ...added]
  }
  const order = orderOf(transcript)
  next.sort((a, b) => order.get(a.caption)! - order.get(b.caption)! || a.from - b.from)
  // Marks next to each other stay apart; the reader merges only overlapping ones.
  return withMarks(project, next, !all)
}

/** Every emphasis mark removed; the project itself when it has none. */
export function clearEmphasis(project: Project): Project {
  if (!project.captionMarks) return project
  return withMarks(project, [], false)
}

/* ---------- records follow their words (§11.1) ---------- */

/** A caption's words: their texts (as compared) and times; `stored` when the times are its stored words' (else spread over the caption). */
interface Words {
  seg: CaptionSegment
  keys: string[]
  times: { start: number; end: number }[]
  stored: boolean
}

function wordsOf(seg: CaptionSegment, language: string | undefined): Words {
  const tokens = studioTokens(seg, language)
  // Stored when the times come from its stored words: one for each word, or the same text split
  // differently (a word-list term written with a space is one stored word).
  const strip = (s: string): string => s.replace(/\s+/g, '')
  const stored = !!seg.words?.length && (seg.words.length === tokens.length || seg.words.map((w) => strip(w.text)).join('') === tokens.map((t) => strip(t.text)).join(''))
  return { seg, keys: tokens.map((t) => wordKey(t.text)), times: tokens.map((t) => ({ start: t.start, end: t.end })), stored }
}

/** Whether two stored words have the same times, exact or estimated: a word a tidy left as it was keeps its times. */
const sameTimes = (x: Words['times'][number], y: Words['times'][number]): boolean => Math.abs(x.start - y.start) < 1e-6 && Math.abs(x.end - y.end) < 1e-6

/** Where a record's words are in `next` (§11.1 rules 1–3), or null when they are gone. */
type Found = { caption: string; from: number; to: number }

/**
 * How a caption's words in `prev` became its words in `next` when a text record says so (§11.1
 * rule 1): `exact`, words from..to → the words they are now, from a record's word map; `putBack`,
 * a record without a map put back (Review's Remove of a record saved before maps were written),
 * whose words are found again with lcsFewestRuns.
 */
type TextStep = { exact: (from: number, to: number) => [number, number] } | 'putBack'

/**
 * The text steps of the captions whose text changed from `prev` to `next`, read from their text
 * records: Remove put a record's text back (`prev`'s record and map: each word back to the words it
 * came from); a tidy wrote a record (`next`'s new records: each word to every word made from it),
 * or tidied a caption again (both maps, through the words before the first tidy). Each end of a
 * record's words stays on its own word when the words the map gives it hold it once (narrowedWords:
 * not onto a word the AI fix took out or put in beside it). A map that does not fit its caption's
 * words is not used.
 */
function textSteps(next: Project, prev: Project, prevWords: Map<string, Words>, nextWords: Map<string, Words>): Map<string, TextStep> {
  const out = new Map<string, TextStep>()
  const prevRecords = prev.captionAuto?.text ?? []
  // Only records this update wrote describe its change (a hand edit drops the record, settle rule 2).
  const ownRecords = next.captionAuto?.text !== prev.captionAuto?.text ? (next.captionAuto?.text ?? []) : []
  if (!prevRecords.length && !ownRecords.length) return out
  const was = new Map(prevRecords.map((r) => [r.caption, r]))
  const own = new Map(ownRecords.map((r) => [r.caption, r]))
  const prevLang = prev.transcript?.language
  const lang = next.transcript?.language
  for (const [id, now] of nextWords) {
    const before = prevWords.get(id)
    if (!before || before.seg.text === now.seg.text) continue
    const p = was.get(id)
    const pMap = p?.map ? wordRanges(p.map, before.keys.length, wordCount(p.text, prevLang)) : null
    if (p && now.seg.text === p.text) {
      out.set(id, pMap ? { exact: narrowedWords((i) => oldWordsOf(pMap, i, i), before.keys, now.keys) } : 'putBack')
      continue
    }
    const n = own.get(id)
    const nMap = n?.map ? wordRanges(n.map, now.keys.length, wordCount(n.text, lang)) : null
    if (!n || !nMap) continue
    if (before.seg.text === n.text) out.set(id, { exact: narrowedWords((i) => newWordsOf(nMap, i, i), before.keys, now.keys) })
    else if (p && pMap && p.text === n.text) out.set(id, { exact: narrowedWords((i) => newWordsOf(nMap, ...oldWordsOf(pMap, i, i)), before.keys, now.keys) })
  }
  return out
}

function relocate(rec: { caption: string; from: number; to: number }, prev: Map<string, Words>, next: Map<string, Words>, nextList: Words[], step: TextStep | undefined): Found | null {
  const before = prev.get(rec.caption)
  if (!before || rec.from < 0 || rec.to >= before.keys.length || rec.from > rec.to) return null
  const want = before.keys.slice(rec.from, rec.to + 1)
  const same = next.get(rec.caption)
  // Rule 1: the same caption, its text changed: the words found again in order and next to each other.
  if (same) {
    if (same.seg.text === before.seg.text) return { caption: rec.caption, from: rec.from, to: rec.to }
    // A text record's word map says where the words are: no finding them again.
    if (step && step !== 'putBack') {
      const [from, to] = step.exact(rec.from, rec.to)
      return { caption: rec.caption, from, to }
    }
    const putBack = step === 'putBack'
    // Text put back pairs words so that the words it puts back stay together. Times spread over a
    // caption say nothing of which word stayed, so only stored times are compared.
    const sameTime = before.stored && same.stored ? (i: number, j: number): boolean => sameTimes(before.times[i], same.times[j]) : (): boolean => false
    const pairs = putBack ? lcsFewestRuns(before.keys, same.keys, sameTime) : lcsPairs(before.keys, same.keys)
    const map = new Map(pairs)
    const mapped: number[] = []
    for (let i = rec.from; i <= rec.to; i++) {
      const j = map.get(i)
      if (j === undefined) break
      mapped.push(j)
    }
    if (mapped.length === want.length && mapped.every((j, k) => k === 0 || j === mapped[k - 1] + 1)) return { caption: rec.caption, from: mapped[0], to: mapped[mapped.length - 1] }
    // A text fix taken back (`putBack`): words the fix changed span the words they were ("120" is
    // "one hundred and twenty" again), from the last word found before them to the next one after.
    if (putBack) {
      let from = map.get(rec.from)
      if (from === undefined) {
        from = 0
        for (const [i, j] of pairs) if (i < rec.from) from = j + 1
      }
      let to = map.get(rec.to)
      if (to === undefined) to = (pairs.find(([i]) => i > rec.to)?.[1] ?? same.keys.length) - 1
      if (from <= to) return { caption: rec.caption, from, to }
    }
  }
  // Rule 2: the words' time span, and their text looked for in the captions of `next` over it, nearest first.
  const span = { start: before.times[rec.from].start, end: before.times[rec.to].end }
  const mid = (span.start + span.end) / 2
  const candidates = nextList.filter((w) => w.seg.start < span.end + 1e-6 && w.seg.end > span.start - 1e-6)
  let best: (Found & { d: number }) | null = null
  for (const w of candidates) {
    for (let i = 0; i + want.length <= w.keys.length; i++) {
      let ok = true
      for (let k = 0; k < want.length && ok; k++) ok = w.keys[i + k] === want[k]
      if (!ok) continue
      const d = Math.abs((w.times[i].start + w.times[i + want.length - 1].end) / 2 - mid)
      if (!best || d < best.d) best = { caption: w.seg.id, from: i, to: i + want.length - 1, d }
    }
  }
  return best ? { caption: best.caption, from: best.from, to: best.to } : null
}

/** The places of `prev` kept on `next`: a caption keeps its own; captions that are new in `next` take the place of the old caption they overlap most (both halves of a split). */
function remapPlaces(places: readonly CaptionPlace[], prevT: Transcript, nextT: Transcript): CaptionPlace[] {
  const prevIds = new Set(prevT.segments.map((s) => s.id))
  const nextIds = new Set(nextT.segments.map((s) => s.id))
  const placeOf = new Map(places.map((p) => [p.caption, p.position]))
  const out: CaptionPlace[] = []
  for (const seg of nextT.segments) {
    const own = placeOf.get(seg.id)
    if (own && prevIds.has(seg.id)) {
      out.push({ caption: seg.id, position: own })
      continue
    }
    if (prevIds.has(seg.id)) continue
    // A new caption (a split's second half): the place of the old caption it overlaps most, when that one was split.
    let best: { id: string; overlap: number } | null = null
    for (const old of prevT.segments) {
      if (!placeOf.has(old.id) || !nextIds.has(old.id)) continue
      const overlap = Math.min(old.end, seg.end) - Math.max(old.start, seg.start)
      if (overlap > 1e-6 && (!best || overlap > best.overlap)) best = { id: old.id, overlap }
    }
    if (best) out.push({ caption: seg.id, position: placeOf.get(best.id)! })
  }
  return out
}

/** Deep equality of plain data. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Marks, graphic anchors and captionPlaces of `next` remapped after its captions changed from
 * `prev`'s (§11.1), as the store's settle does in the same undo step as the change: a record
 * whose caption kept its text stays; one whose caption's text changed is found again by the
 * longest common subsequence of words; one whose caption is gone (split, merge, generated again)
 * is looked for by its text in the captions over its old time, nearest first; else it is dropped
 * (a graphic then stays free). Places follow their caption, both halves of a split keep one, a
 * caption that is gone loses its. Only a mark or anchor `prev` had (same id, same words) is
 * remapped: one this update made or moved already names `next`'s words and is only checked. A
 * caption whose text a tidy changed or Review's Remove put back follows its text record's word map
 * instead (textSteps): exactly onto the words made from them, or back onto the words they came
 * from. A record without a map put back (saved before maps were written) finds the words again,
 * words the fix changed spanning the words they were. The result is what reading the saved project
 * gives for these fields; `next` itself when nothing changed.
 */
export function remapAnchors(next: Project, prev: Project): Project {
  const nt = next.transcript
  const pt = prev.transcript
  if (nt === pt || !pt) return next
  const hasRecords = !!(next.captionMarks?.length || next.captionPlaces?.length || next.graphics?.some((g) => (g.kind === 'keyword' || g.kind === 'emoji') && g.anchor))
  if (!hasRecords) return next
  if (!nt) {
    const { captionMarks: _m, captionPlaces: _p, ...rest } = next
    void _m
    void _p
    const graphics = next.graphics?.map((g) => ((g.kind === 'keyword' || g.kind === 'emoji') && g.anchor ? dropAnchor(g) : g))
    return { ...rest, ...(graphics ? { graphics } : {}) }
  }
  const lang = nt.language
  const prevWords = new Map(pt.segments.map((s) => [s.id, wordsOf(s, pt.language)]))
  const nextList = nt.segments.map((s) => wordsOf(s, lang))
  const nextWords = new Map(nextList.map((w) => [w.seg.id, w]))
  const steps = textSteps(next, prev, prevWords, nextWords)
  const textOf = (f: Found): string => {
    const words = studioWords(nextWords.get(f.caption)!.seg.text, lang)
    return wordsText(words, f.from, f.to)
  }
  // Only a record `prev` already had on these words counts them in `prev`'s captions; one this
  // update made or moved (Make my captions great's picks on the tidied text) counts them in `next`'s.
  type Spot = { caption: string; from: number; to: number; text: string }
  const prevMarks = new Map((prev.captionMarks ?? []).map((m) => [m.id, m]))
  const prevAnchors = new Map((prev.graphics ?? []).flatMap((g) => ((g.kind === 'keyword' || g.kind === 'emoji') && g.anchor ? [[g.id, g.anchor] as const] : [])))
  const fromPrev = (rec: Spot, was: Spot | undefined): boolean => !!was && was.caption === rec.caption && was.from === rec.from && was.to === rec.to && was.text === rec.text
  const move = <T extends Spot>(rec: T, was: Spot | undefined): T | null => {
    if (!fromPrev(rec, was)) return rec
    const f = relocate(rec, prevWords, nextWords, nextList, steps.get(rec.caption))
    if (!f) return null
    if (f.caption === rec.caption && f.from === rec.from && f.to === rec.to && nextWords.get(f.caption)!.seg.text === prevWords.get(rec.caption)?.seg.text) return rec
    return { ...rec, caption: f.caption, from: f.from, to: f.to, text: textOf(f) }
  }
  // Marks.
  const movedMarks = (next.captionMarks ?? []).map((m) => move(m, prevMarks.get(m.id))).filter((m): m is CaptionMark => !!m)
  const marks = readCaptionMarks(movedMarks, nt)
  // Graphic anchors.
  const graphicsIn = next.graphics?.map((g): Graphic => {
    if ((g.kind !== 'keyword' && g.kind !== 'emoji') || !g.anchor) return g
    const moved = move<WordAnchor>(g.anchor, prevAnchors.get(g.id))
    // An emoji sits above one word: moved onto several (a term or number put back, a word a tidy
    // wrote as two), it stays above the first of them.
    const a = moved && moved !== g.anchor && g.kind === 'emoji' && moved.from !== moved.to ? { ...moved, to: moved.from, text: textOf({ caption: moved.caption, from: moved.from, to: moved.from }) } : moved
    return a ? (a === g.anchor ? g : { ...g, anchor: a }) : dropAnchor(g)
  })
  const graphics = graphicsIn ? readGraphics(graphicsIn, next.duration, nt) : undefined
  // Places.
  const places = next.captionPlaces ? readCaptionPlaces(remapPlaces(next.captionPlaces, pt, nt), nt) : undefined
  if (same(marks, next.captionMarks) && same(graphics, next.graphics) && same(places, next.captionPlaces)) return next
  const { captionMarks: _m, captionPlaces: _p, graphics: _g, ...rest } = next
  void _m
  void _p
  void _g
  return { ...rest, ...(marks ? { captionMarks: marks } : {}), ...(places ? { captionPlaces: places } : {}), ...(graphics ? { graphics } : {}) }
}

/** A keyword or emoji without its anchor (it stays where it is, free; a keyword then replaces nothing). */
function dropAnchor<G extends Graphic>(g: G): G {
  if (g.kind !== 'keyword' && g.kind !== 'emoji') return g
  const { anchor: _a, ...rest } = g
  void _a
  return rest as G
}

/** Caption `caption` placed at the top or the bottom, or back to the look's place (null); one undo step; the project itself when nothing changes. */
export function withCaptionPlace(project: Project, caption: string, position: 'top' | 'bottom' | null): Project {
  const transcript = project.transcript
  if (!transcript || !transcript.segments.some((s) => s.id === caption)) return project
  const places = project.captionPlaces ?? []
  const current = places.find((p) => p.caption === caption)?.position ?? null
  if (current === position) return project
  const order = orderOf(transcript)
  const others = places.filter((p) => p.caption !== caption)
  const list = position ? [...others, { caption, position }].sort((a, b) => order.get(a.caption)! - order.get(b.caption)!) : others
  const { captionPlaces: _p, ...rest } = project
  void _p
  return list.length ? { ...rest, captionPlaces: list } : rest
}
