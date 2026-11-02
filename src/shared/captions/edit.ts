/**
 * Editing captions: the Captions tab's transcript editor (split, merge, delete, find and replace),
 * the caption track's drags, and checking what an AI text task returns before it replaces
 * anything. Pure; every operation returns new arrays and leaves the others untouched.
 */
import { clamp } from '../engine/math'
import { captionWordTimes } from '../editor/transcript'
import { normalise, notedPieces, NOTHING_SAID, saidOf } from '../publish/check'
import { sliceAt } from '../publish/text'
import type { CaptionSegment, CaptionWord } from '../types'
import { capAiLinks, cleanCaptionText, MIN_CAPTION, newCaptionId } from './captionData'

/** Shortest caption a drag on the track leaves, seconds. */
export const MIN_CAPTION_DRAG = 0.2

/** Where a caption may go while it is dragged: between its neighbours, inside the recording. */
export function captionDragBounds(segments: readonly CaptionSegment[], id: string, duration: number): { min: number; max: number } {
  const i = segments.findIndex((s) => s.id === id)
  return { min: i > 0 ? segments[i - 1].end : 0, max: i >= 0 && i + 1 < segments.length ? segments[i + 1].start : duration }
}

/**
 * Times of a caption dragged by `dt` seconds: 'move' keeps its length, 'start' and 'end' trim
 * it; never past its neighbours (`bounds`) nor shorter than MIN_CAPTION_DRAG (or than it was).
 */
export function dragCaptionTimes(initial: { start: number; end: number }, mode: 'move' | 'start' | 'end', dt: number, bounds: { min: number; max: number }): { start: number; end: number } {
  const len = initial.end - initial.start
  const minLen = Math.min(MIN_CAPTION_DRAG, len)
  if (mode === 'move') {
    const start = clamp(initial.start + dt, bounds.min, Math.max(bounds.min, bounds.max - len))
    return { start, end: start + len }
  }
  if (mode === 'start') return { start: clamp(initial.start + dt, bounds.min, initial.end - minLen), end: initial.end }
  return { start: initial.start, end: clamp(initial.end + dt, initial.start + minLen, bounds.max) }
}

/**
 * The caption moved or trimmed to `next`, its word timings moved with it (a move) and kept inside
 * it; a trim leaves a word deleted in the Transcript tab where it was said, in the cut
 * (edit-by-text.md §4.2).
 */
export function retimeWords(seg: CaptionSegment, next: { start: number; end: number }): CaptionSegment {
  const out: CaptionSegment = { ...seg, ...next }
  if (!seg.words) return out
  const shift = Math.abs(next.end - next.start - (seg.end - seg.start)) < 1e-9 ? next.start - seg.start : 0
  out.words = seg.words.map((w) => (w.deleted && shift === 0 ? w : { ...w, start: clamp(w.start + shift, next.start, next.end), end: clamp(w.end + shift, next.start, next.end) }))
  return out
}

/**
 * The links an AI wrote into caption `before` by giving it `text` (as stored: cleanCaptionText), for
 * CaptionSegment.aiLinks (capAiLinks): the pieces of `text` the link check notes against what `before`
 * said (check.ts, as `normalise` reads them: "ログインflown.jp/download" when "flown.jp/download" was
 * said), against nothing when an AI wrote a link into `before` too. A caption with aiLinks is never
 * read as said (saidLinks). The same text keeps its record (docs/design/publish-pack.md §4.6).
 */
export function aiLinksAfter(before: Pick<CaptionSegment, 'text' | 'aiLinks'>, text: string): string[] {
  if (text === before.text) return before.aiLinks ? [...before.aiLinks] : []
  const said = before.aiLinks?.length ? NOTHING_SAID : saidOf([before.text])
  return capAiLinks([...new Set(notedPieces(text, said).map((p) => normalise(p.text)))])
}

/**
 * Caption `seg` with `text` typed by hand (the Captions tab's field). The words are the user's, but the
 * record of the links an AI wrote into it (aiLinks) stays while anything link-like is left in the text
 * (aiLinksAfter, against nothing said), so that fixing a word next to an AI's link never makes the link
 * said; it goes once no link is left (docs/design/publish-pack.md §4.6).
 */
export const typedCaption = (seg: CaptionSegment, text: string): CaptionSegment => withAiLinks({ ...seg, text }, seg.aiLinks?.length ? aiLinksAfter(seg, text) : undefined)

/** `seg` with `aiLinks` (none when empty; capAiLinks). */
function withAiLinks<T extends CaptionSegment>(seg: T, aiLinks: readonly string[] | undefined): T {
  const { aiLinks: _old, ...rest } = seg
  return (aiLinks?.length ? { ...rest, aiLinks: capAiLinks(aiLinks) } : rest) as T
}

/** The caption with new text: its word timings are kept while the text still has as many words. */
export function withCaptionText(seg: CaptionSegment, text: string): CaptionSegment {
  return { ...seg, text }
}

/**
 * A caption's word timings one per shown word: its own when they match its text one to one, else
 * each word's time as the Transcript tab has it (captionWordTimes: guesses stay marked), so a
 * split or a merge keeps every word where it was, and a word cut by its time stays cut.
 */
const timingsOf = (seg: CaptionSegment, count: number): CaptionWord[] => (seg.words && seg.words.length === count ? seg.words : captionWordTimes(seg))

/**
 * Splits caption `id` at source time `t` into two (the text divided at the word spoken there, or
 * by length without word timings). Null when `t` is too close to an edge or there is only one word.
 */
export function splitCaption(segments: readonly CaptionSegment[], id: string, t: number): CaptionSegment[] | null {
  const i = segments.findIndex((s) => s.id === id)
  const seg = segments[i]
  if (!seg || t - seg.start < MIN_CAPTION || seg.end - t < MIN_CAPTION) return null
  const words = seg.text.split(' ').filter(Boolean)
  if (words.length < 2) return null
  let k: number
  const timed = seg.words?.length ? timingsOf(seg, words.length) : null
  if (timed) {
    // The first word that starts after t goes to the second caption.
    k = timed.findIndex((w) => (w.start + w.end) / 2 >= t)
    if (k < 0) k = words.length - 1
  } else {
    const share = (t - seg.start) / (seg.end - seg.start)
    const total = words.reduce((n, w) => n + w.length + 1, 0)
    let acc = 0
    k = words.length - 1
    for (let j = 0; j < words.length; j++) {
      if (acc / total >= share) {
        k = j
        break
      }
      acc += words[j].length + 1
    }
  }
  k = clamp(k, 1, words.length - 1)
  // Links an AI wrote stay its own in both halves, and both halves keep the speaker.
  const a: CaptionSegment = withAiLinks({ id: seg.id, start: seg.start, end: t, text: words.slice(0, k).join(' ') }, seg.aiLinks)
  const b: CaptionSegment = withAiLinks({ id: newCaptionId(), start: t, end: seg.end, text: words.slice(k).join(' ') }, seg.aiLinks)
  if (seg.speaker) a.speaker = b.speaker = seg.speaker
  if (timed) {
    // A deleted word keeps its own time (retimeWords).
    const inside = (w: CaptionWord, s: number, e: number): CaptionWord => (w.deleted ? w : { ...w, start: clamp(w.start, s, e), end: clamp(w.end, s, e) })
    a.words = timed.slice(0, k).map((w) => inside(w, a.start, a.end))
    b.words = timed.slice(k).map((w) => inside(w, b.start, b.end))
  }
  return [...segments.slice(0, i), a, b, ...segments.slice(i + 1)]
}

/** Merges caption `id` with the one after it (their texts joined; word timings kept when either has them). Null for the last one. */
export function mergeWithNext(segments: readonly CaptionSegment[], id: string): CaptionSegment[] | null {
  const i = segments.findIndex((s) => s.id === id)
  if (i < 0 || i + 1 >= segments.length) return null
  const a = segments[i]
  const b = segments[i + 1]
  // Joined by a space (cleanCaptionText). What an AI wrote a link into stays the AI's: the merged caption keeps both records.
  const ai = [...(a.aiLinks ?? []), ...(b.aiLinks ?? [])]
  const merged: CaptionSegment = withAiLinks({ id: a.id, start: a.start, end: b.end, text: cleanCaptionText(`${a.text} ${b.text}`) }, [...new Set(ai)])
  // The first caption's speaker, else the second's.
  const speaker = a.speaker ?? b.speaker
  if (speaker) merged.speaker = speaker
  const count = (s: CaptionSegment): number => s.text.split(' ').filter(Boolean).length
  if (a.words?.length || b.words?.length) merged.words = [...timingsOf(a, count(a)), ...timingsOf(b, count(b))]
  return [...segments.slice(0, i), merged, ...segments.slice(i + 2)]
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches of `find` in caption texts (ignoring case), as [caption id, count]. */
export function findInCaptions(segments: readonly CaptionSegment[], find: string): { id: string; count: number }[] {
  if (!find) return []
  const re = new RegExp(escapeRegExp(find), 'gi')
  const out: { id: string; count: number }[] = []
  for (const s of segments) {
    const n = s.text.match(re)?.length ?? 0
    if (n) out.push({ id: s.id, count: n })
  }
  return out
}

/**
 * Every `find` (ignoring case) replaced by `replace` in the captions' texts; captions left empty
 * are removed. Returns the captions and how many replacements were made.
 */
export function replaceInCaptions(segments: readonly CaptionSegment[], find: string, replace: string): { segments: CaptionSegment[]; count: number } {
  if (!find) return { segments: [...segments], count: 0 }
  const re = new RegExp(escapeRegExp(find), 'gi')
  let count = 0
  const out: CaptionSegment[] = []
  for (const s of segments) {
    const n = s.text.match(re)?.length ?? 0
    if (!n) {
      out.push(s)
      continue
    }
    count += n
    const text = cleanCaptionText(s.text.replace(re, () => replace))
    if (text) out.push(withCaptionText(s, text))
  }
  return { segments: out, count }
}

/**
 * The captions with the texts an AI task returned ('cleanup', 'translate'), or null when the result
 * does not match them: the same ids in the same order with the same times (within a millisecond),
 * and text for each (a caption that was already empty may stay empty). Word timings are kept only
 * where the result kept them (a clean-up that kept the words; never a translation, whose words
 * are not the ones spoken), and then the captions' own, not times sent back. The text is stored as
 * the AI wrote it (cleanCaptionText), and each caption records the links that stored text has and
 * it did not (aiLinks, aiLinksAfter): the copy pack never trusts them as said.
 */
export function applyTextResult(current: readonly CaptionSegment[], result: unknown): CaptionSegment[] | null {
  if (!Array.isArray(result) || result.length !== current.length) return null
  const out: CaptionSegment[] = []
  for (let i = 0; i < current.length; i++) {
    const c = current[i]
    const r = result[i] as Partial<CaptionSegment> | null
    if (!r || typeof r !== 'object' || r.id !== c.id || typeof r.text !== 'string') return null
    if (typeof r.start !== 'number' || typeof r.end !== 'number' || Math.abs(r.start - c.start) > 1e-3 || Math.abs(r.end - c.end) > 1e-3) return null
    const text = cleanCaptionText(r.text)
    if (!text) {
      if (cleanCaptionText(c.text)) return null
      out.push(c)
      continue
    }
    const { words, aiLinks: _old, ...rest } = c
    const aiLinks = aiLinksAfter(c, text)
    out.push({ ...rest, text, ...(Array.isArray(r.words) && words ? { words } : {}), ...(aiLinks.length ? { aiLinks } : {}) })
  }
  return out
}

/** Chapters an AI task suggested, inside the recording and in order (unusable entries dropped); titles one line, at most 100 UTF-16 units. */
export function readSuggestedChapters(result: unknown, duration: number): { t: number; title: string }[] {
  if (!Array.isArray(result)) return []
  const out: { t: number; title: string }[] = []
  for (const c of result.slice(0, 100)) {
    if (!c || typeof c !== 'object') continue
    const { t, title } = c as { t?: unknown; title?: unknown }
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof title !== 'string') continue
    const name = sliceAt(title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), 100)
    if (!name) continue
    out.push({ t: clamp(t, 0, duration), title: name })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * A title (one line, without quotation marks at its ends, at most 120 UTF-16 units) or a summary (line
 * breaks kept, at most 4000) an AI task suggested, as the Captions tab shows it; '' when there is none.
 */
export function readSuggestedText(task: 'title' | 'summary', text: unknown): string {
  if (typeof text !== 'string') return ''
  const shown =
    task === 'title'
      ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/^["“'\s]+|["”'\s]+$/g, '')
      : text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return sliceAt(shown, task === 'title' ? 120 : 4000)
}
