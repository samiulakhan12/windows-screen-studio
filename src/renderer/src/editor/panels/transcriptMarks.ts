/**
 * Emphasis in the Transcript tab (docs/design/captions-studio.md §2.7): the tab's words are each
 * caption's text split on spaces, marks count the words of studioWordTexts (§8.1), which splits a
 * long piece of Chinese, Japanese or Thai further. These map one onto the other, so a selection of
 * the tab's words gives the marks' spans and each word shows whether it is emphasised.
 */
import { studioWords } from '../../../../shared/captions/words'
import type { TranscriptWord } from '../../../../shared/editor/transcript'
import type { CaptionMark, CaptionSegment } from '../../../../shared/types'

/** For each space-separated piece of `text`, the first and last of its words as studioWordTexts counts them. */
export function pieceWords(text: string, language?: string): [number, number][] {
  const out: [number, number][] = []
  studioWords(text, language).forEach((w, i) => {
    // A new piece starts at the first word and at every word with white space before it.
    if (i === 0 || w.gap) out.push([i, i])
    else out[out.length - 1][1] = i
  })
  return out
}

/** Each caption's first index in `words` (the tab's words of the whole transcript). */
function firstIndexes(words: readonly TranscriptWord[]): Map<string, number> {
  const first = new Map<string, number>()
  for (const w of words) if (!first.has(w.caption)) first.set(w.caption, w.index)
  return first
}

/** The marks' spans of the tab's words `a..b`: one per caption they cover, in studioWordTexts indexes (§2.7: a selection over two captions emphasises the words of each). */
export function selectionSpans(words: readonly TranscriptWord[], a: number, b: number, segments: readonly CaptionSegment[], language?: string): { caption: string; from: number; to: number }[] {
  const first = firstIndexes(words)
  const texts = new Map(segments.map((s) => [s.id, s.text]))
  const spans = new Map<string, { caption: string; from: number; to: number }>()
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const w = words[i]
    if (!w) continue
    const pieces = pieceWords(texts.get(w.caption) ?? '', language)
    const piece = pieces[Math.min(i - first.get(w.caption)!, pieces.length - 1)]
    if (!piece) continue
    const s = spans.get(w.caption)
    if (s) s.to = Math.max(s.to, piece[1])
    else spans.set(w.caption, { caption: w.caption, from: piece[0], to: piece[1] })
  }
  return [...spans.values()]
}

/** For each of the tab's words: 0 not emphasised, 1 emphasised, 2 emphasised in the second colour (any of its studio words marked). */
export function wordEmphasis(words: readonly TranscriptWord[], marks: readonly CaptionMark[] | undefined, segments: readonly CaptionSegment[], language?: string): (0 | 1 | 2)[] {
  const out = new Array<0 | 1 | 2>(words.length).fill(0)
  if (!marks?.length) return out
  const byCaption = new Map<string, CaptionMark[]>()
  for (const m of marks) byCaption.set(m.caption, [...(byCaption.get(m.caption) ?? []), m])
  const first = firstIndexes(words)
  const texts = new Map(segments.map((s) => [s.id, s.text]))
  const pieces = new Map<string, [number, number][]>()
  for (const w of words) {
    const list = byCaption.get(w.caption)
    if (!list) continue
    let ps = pieces.get(w.caption)
    if (!ps) pieces.set(w.caption, (ps = pieceWords(texts.get(w.caption) ?? '', language)))
    const piece = ps[w.index - first.get(w.caption)!]
    if (!piece) continue
    const hit = list.find((m) => m.from <= piece[1] && m.to >= piece[0])
    if (hit) out[w.index] = hit.tone === 2 ? 2 : 1
  }
  return out
}

/** Whether toggling `tone` on `spans` removes emphasis: every word of them already has it in that tone (as toggleEmphasis decides). */
export function removesEmphasis(spans: readonly { caption: string; from: number; to: number }[], marks: readonly CaptionMark[] | undefined, tone?: 2): boolean {
  if (!spans.length) return false
  const covered = (caption: string, i: number): boolean => (marks ?? []).some((m) => m.caption === caption && i >= m.from && i <= m.to && (m.tone === 2) === (tone === 2))
  return spans.every((s) => {
    for (let i = s.from; i <= s.to; i++) if (!covered(s.caption, i)) return false
    return true
  })
}

const words = (n: number): string => `${n} ${n === 1 ? 'word' : 'words'}`

/** "Emphasised 2 words", "Removed emphasis from 2 words"; on a Classic look the first emphasis says the look became its own version (§2.7). */
export function emphasisNotice(n: number, removed: boolean, twinOf: string | null): string {
  if (removed) return `Removed emphasis from ${words(n)}`
  const base = `Emphasised ${words(n)}`
  return twinOf ? `${base}. Your captions are now your own version of ${twinOf}, which can show emphasis.` : base
}
