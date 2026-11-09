/**
 * A short clip made into a copy of the project (docs/design/smart-tools.md §8.5): Duplicate's copy
 * in the shape asked for (projectCopy: its framing, caption look and refit), cut to the moment's
 * kept pieces, with only the pending changes it shows, and captions on when asked. The original
 * never changes: main gives the copy its own id and folder. Pure.
 */
import { captionsOf } from '../captions/settings'
import { projectCopy, type CopyKind, type MeasureText } from '../editor/duplicate'
import { outputTimeAt } from '../editor/clips'
import { newClipId } from '../engine/timeline'
import { clipsBetween } from '../render/exportBundle'
import { withAutoCuts } from '../review/autoCuts'
import { expandGroups } from '../review/captionReview'
import { keepItems, reviewItems, type ReviewItem } from '../review/review'
import type { Clip, Freeze, Project } from '../types'
import type { Moment } from './moments'

/** Longest name of a copy (duplicate.ts NAME_MAX; main cuts what it writes to the same length). */
export const CLIP_NAME_MAX = 120
/** Longest `clipOf.why` kept (readClipOrigin). */
const WHY_MAX = 120
const EPS = 1e-6

export type ClipShape = 'same' | 'vertical' | 'square'

/** The kind of copy Duplicate makes for a shape. */
export const copyKindOf = (shape: ClipShape): CopyKind => (shape === 'same' ? 'copy' : shape)

const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** `text` cut to at most `max` UTF-16 units at a grapheme boundary (never inside a cluster or a conjunct's marks). */
function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text
  let end = 0
  for (const { segment, index } of graphemer.segment(text)) {
    if (index + segment.length > max) break
    end = index + segment.length
  }
  return text.slice(0, end)
}

/** "<base><suffix>" within 120 characters (copyName's rule: the base is cut, the suffix kept), cut by graphemes. */
export function suffixedName(base: string, suffix: string): string {
  const name = (typeof base === 'string' ? base.replace(/\s+/g, ' ').trim() : '') || 'Untitled recording'
  return `${cutUnits(name, CLIP_NAME_MAX - suffix.length).trimEnd()}${suffix}`
}

/** One line of at most 120 characters. */
const oneLine = (text: string): string => cutUnits(text.replace(/\s+/g, ' ').trim(), WHY_MAX).trimEnd()

/** The project's clips and freezes inside source seconds [start, end) (by edit time, as chapterParts and partProject cut them). */
export function clipsInRange(project: Pick<Project, 'clips' | 'freezes'>, start: number, end: number): Pick<Project, 'clips' | 'freezes'> {
  const clips = project.clips
  if (!clips.length || !(end > start)) return { clips: [] }
  const e0 = outputTimeAt(clips, start)
  const e1 = outputTimeAt(clips, end)
  const pieces = e1 > e0 + EPS ? clipsBetween(clips, e0, e1) : []
  return withFreezesIn({ clips: pieces }, project.freezes)
}

/** `part` with the freezes of `freezes` whose frame is inside one of its clips (none: no key). */
function withFreezesIn(part: { clips: Clip[] }, freezes: readonly Freeze[] | undefined): Pick<Project, 'clips' | 'freezes'> {
  const inside = (at: number): boolean => part.clips.some((c) => at >= c.start - 1e-9 && at < c.end - 1e-9)
  const kept = (freezes ?? []).filter((f) => inside(f.at))
  return kept.length ? { clips: part.clips, freezes: kept } : { clips: part.clips }
}

/** The clips of several pieces (in order), each clip id once: a clip cut into two pieces gives its second a new id. */
export function piecesClips(project: Pick<Project, 'clips' | 'freezes'>, pieces: readonly { start: number; end: number }[]): Pick<Project, 'clips' | 'freezes'> {
  const seen = new Set<string>()
  const clips: Clip[] = []
  for (const p of pieces) {
    for (const c of clipsInRange({ clips: project.clips }, p.start, p.end).clips) {
      clips.push(seen.has(c.id) ? { ...c, id: newClipId() } : c)
      seen.add(c.id)
    }
  }
  return withFreezesIn({ clips }, project.freezes)
}

/** Whether [a, b] lies inside one of `ranges` (1 µs slack). */
const insideOne = (a: number, b: number, ranges: readonly { start: number; end: number }[]): boolean => ranges.some((r) => a >= r.start - EPS && b <= r.end + EPS)
/** Whether [a, b] (a point when a = b) shares no time with any of `ranges`. */
const outsideAll = (a: number, b: number, ranges: readonly { start: number; end: number }[]): boolean =>
  ranges.every((r) => (b > a ? b <= r.start + EPS || a >= r.end - EPS : a < r.start - EPS || a > r.end + EPS))

/**
 * A copy with only the pending changes it shows (§8.5 step 3): the original's automatic cut
 * records kept only when they lie inside one of `ranges` (the rest dropped with no outcome, so
 * Remove in the copy never brings back footage from outside them); every other pending Review item
 * (automatic zooms, camera moves, Captions Studio's automatic items, cut styles) lying wholly
 * outside them settled by Review's own Keep, which only drops its record. What lies inside stays
 * listed. `copy` itself when nothing changes.
 */
export function withinRange(copy: Project, ranges: readonly { start: number; end: number }[]): Project {
  let next = copy
  const records = copy.autoCuts ?? []
  const inside = records.filter((c) => insideOne(c.start, c.end, ranges))
  if (inside.length !== records.length) next = withAutoCuts(next, inside)
  const outside: ReviewItem[] = expandGroups(reviewItems(next)).filter((i) => !i.cut && outsideAll(i.start, i.end, ranges))
  return outside.length ? keepItems(next, outside) : next
}

/** `copy` with its captions shown or hidden as the panel's Captions choice says (§8.5 step 4); unchanged without captions. */
export function withClipCaptions(copy: Project, captions: boolean): Project {
  if (!copy.transcript?.segments.some((s) => s.text.trim())) return copy
  const c = captionsOf(copy)
  if (c.show === captions) return copy
  return { ...copy, captions: { ...c, show: captions } }
}

/** The project without chapters and the guide (a clip shows neither, §8.5 step 2). */
function withoutChaptersAndGuide(p: Project): Project {
  const { chapters: _chapters, guide: _guide, ...rest } = p
  void _chapters
  void _guide
  return rest
}

/**
 * The copy a moment makes (§8.5): projectCopy in the shape asked for ('same' a plain copy), cut to
 * the moment by edit time (each piece keeps its speed), the freezes inside it only, no chapters
 * and no guide, named "<title> (clip)", `clipOf` set, only its own pending changes (withinRange),
 * and captions shown when asked. Still `project.id`: main gives the copy its new id.
 */
export function clipCopy(project: Project, moment: Moment, opts: { shape: ClipShape; captions: boolean; measure: MeasureText | null }): Project {
  const part = clipsInRange(project, moment.start, moment.end)
  if (part.clips.length === 0) throw new Error('This moment is no longer in the video: find short clips again.')
  const base = projectCopy(project, copyKindOf(opts.shape), opts.measure)
  const why = oneLine(moment.reasons.join(' · '))
  let copy: Project = { ...withoutChaptersAndGuide(base), clips: part.clips }
  if (part.freezes) copy.freezes = part.freezes
  else delete copy.freezes
  copy = {
    ...copy,
    name: suffixedName(moment.title, ' (clip)'),
    clipOf: { kind: 'moment', start: moment.start, end: moment.end, ...(why ? { why } : {}) }
  }
  return withClipCaptions(withinRange(copy, [{ start: moment.start, end: moment.end }]), opts.captions)
}
