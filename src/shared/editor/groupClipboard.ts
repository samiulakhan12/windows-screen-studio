/**
 * Copy, paste and duplicate items (E-06, docs/design/multi-select.md §4.11): what the in-memory
 * item clipboard holds, and where pasted items go (one project out). Pure: the renderer keeps the
 * clipboard's value (renderer/editor/itemClipboard.ts); nothing is written to the OS clipboard, so
 * no untrusted data is ever parsed here.
 *
 * Every item keeps its distance to the others: the copy's start (`origin`) goes to the paste time.
 */
import { MAX_FREEZES } from '../engine/freeze'
import { clamp } from '../engine/math'
import { formatTime } from '../engine/project'
import { MIN_NEW_ZOOM, newZoomId, zoomAt } from '../engine/zoom'
import { chapterInVideo } from '../render/chapters'
import type { Annotation, Chapter, Freeze, Project, Shape, Spotlight, TitleCard, ZoomSegment } from '../types'
import { newAnnotationId } from './annotations'
import { displayTime } from './clips'
import { freezeAtPlayhead } from './freezeEdit'
import { itemKey, KIND_WORDS, parseItemKey, type GroupKind, type ItemKey } from './multiSelect'
import { newShapeId, newSpotlightId } from './shapes'
import { chapterNear, createChapter, newTitleId } from './titles'

export type ClipItem =
  | { kind: 'zoom'; item: ZoomSegment }
  | { kind: 'annotation'; item: Annotation }
  | { kind: 'shape'; item: Shape }
  | { kind: 'spotlight'; item: Spotlight }
  | { kind: 'title'; item: TitleCard }
  | { kind: 'chapter'; item: Chapter }
  | { kind: 'freeze'; item: Freeze }

export interface ItemClipboard {
  version: 1
  /** The recording the items were copied from: freeze frames paste only into it. */
  projectId: string
  /** The copied items' start (smallest start, t or at). */
  origin: number
  /** Their end (largest end, t or at + length) minus `origin`. */
  span: number
  items: readonly ClipItem[]
}

/** Why a copied item was not pasted. */
export type PasteSkip =
  | 'outside'
  | 'zoom-taken'
  | 'chapter-near'
  | 'chapter-end'
  | 'freeze-cut'
  | 'freeze-taken'
  | 'freeze-frozen'
  | 'freeze-full'
  | 'freeze-other-recording'

export interface PasteResult {
  project: Project
  /** The pasted items (what becomes the selection). */
  keys: ItemKey[]
  /** Where the items' start went. */
  at: number
  /** The paste was moved back so the items fit before the end. */
  movedBack: boolean
  /** Zooms shortened to fit a free gap. */
  shortened: number
  skipped: { kind: GroupKind; why: PasteSkip }[]
}

/** A duplicate goes at least this far after the original (a group of chapters only would land on itself). */
export const DUPLICATE_MIN_OFFSET = 1

/** An item's start and end on the timeline; a freeze ends where the time it holds ends (at + length). */
function extent(c: ClipItem): { start: number; end: number } {
  switch (c.kind) {
    case 'chapter':
      return { start: c.item.t, end: c.item.t }
    case 'freeze':
      return { start: c.item.at, end: c.item.at + c.item.length }
    default:
      return { start: c.item.start, end: c.item.end }
  }
}

/** The copied item of `key` (a deep copy), or null when it is not there. */
function clipItemOf(p: Project, key: ItemKey): ClipItem | null {
  const k = parseItemKey(key)
  if (!k) return null
  const find = <T extends { id: string }>(list: readonly T[] | undefined): T | undefined => list?.find((x) => x.id === k.id)
  const copy = <T>(x: T | undefined): T | null => (x ? structuredClone(x) : null)
  switch (k.kind) {
    case 'zoom': {
      const item = copy(find(p.zooms))
      return item && { kind: 'zoom', item }
    }
    case 'annotation': {
      const item = copy(find(p.annotations))
      return item && { kind: 'annotation', item }
    }
    case 'shape': {
      const item = copy(find(p.shapes))
      return item && { kind: 'shape', item }
    }
    case 'spotlight': {
      const item = copy(find(p.spotlights))
      return item && { kind: 'spotlight', item }
    }
    case 'title': {
      const item = copy(find(p.titles))
      return item && { kind: 'title', item }
    }
    case 'chapter': {
      const item = copy(find(p.chapters))
      return item && { kind: 'chapter', item }
    }
    case 'freeze': {
      const item = copy(find(p.freezes))
      return item && { kind: 'freeze', item }
    }
  }
}

/** Deep copies of the items of `keys` (in time order), with their origin and span; null when none is there. */
export function copyItems(p: Project, keys: readonly ItemKey[]): ItemClipboard | null {
  const items = keys.map((k) => clipItemOf(p, k)).filter((c): c is ClipItem => c !== null)
  if (items.length === 0) return null
  items.sort((a, b) => extent(a).start - extent(b).start || extent(a).end - extent(b).end)
  const origin = Math.min(...items.map((c) => extent(c).start))
  const end = Math.max(...items.map((c) => extent(c).end))
  return { version: 1, projectId: p.id, origin, span: end - origin, items }
}

/**
 * The clipboard's items placed so their start is at `at` (each keeps its distance to the others), in
 * one project: fresh ids; zooms made yours, keeping their start, shortened to a free gap of at least
 * MIN_NEW_ZOOM (else skipped); chapters and freezes through their own rules.
 */
function place(p: Project, clip: ItemClipboard, at: number, movedBack: boolean): PasteResult {
  const offset = at - clip.origin
  const { duration } = p
  let q = p
  const keys: ItemKey[] = []
  const skipped: { kind: GroupKind; why: PasteSkip }[] = []
  let shortened = 0
  const outside = (end: number): boolean => end > duration + 1e-9
  for (const c of clip.items) {
    switch (c.kind) {
      case 'annotation': {
        const item = { ...c.item, id: newAnnotationId(), start: c.item.start + offset, end: c.item.end + offset }
        if (outside(item.end)) skipped.push({ kind: c.kind, why: 'outside' })
        else {
          q = { ...q, annotations: [...q.annotations, item] }
          keys.push(itemKey(c.kind, item.id))
        }
        break
      }
      case 'shape': {
        const item = { ...c.item, id: newShapeId(), start: c.item.start + offset, end: c.item.end + offset }
        if (outside(item.end)) skipped.push({ kind: c.kind, why: 'outside' })
        else {
          q = { ...q, shapes: [...(q.shapes ?? []), item] }
          keys.push(itemKey(c.kind, item.id))
        }
        break
      }
      case 'spotlight': {
        const item = { ...c.item, id: newSpotlightId(), start: c.item.start + offset, end: c.item.end + offset }
        if (outside(item.end)) skipped.push({ kind: c.kind, why: 'outside' })
        else {
          q = { ...q, spotlights: [...(q.spotlights ?? []), item] }
          keys.push(itemKey(c.kind, item.id))
        }
        break
      }
      case 'title': {
        const item = { ...c.item, id: newTitleId(), start: c.item.start + offset, end: c.item.end + offset }
        if (outside(item.end)) skipped.push({ kind: c.kind, why: 'outside' })
        else {
          q = { ...q, titles: [...(q.titles ?? []), item] }
          keys.push(itemKey(c.kind, item.id))
        }
        break
      }
      case 'zoom': {
        // Its start stays (insertZoom would move it back); a zoom in the way shortens it, or takes its place.
        const start = c.item.start + offset
        const length = c.item.end - c.item.start
        if (start < 0 || start >= duration || zoomAt(q.zooms, start)) {
          skipped.push({ kind: c.kind, why: 'zoom-taken' })
          break
        }
        const room = Math.min(duration, ...q.zooms.filter((z) => z.start >= start).map((z) => z.start)) - start
        if (room < Math.min(length, MIN_NEW_ZOOM) - 1e-9) {
          skipped.push({ kind: c.kind, why: 'zoom-taken' })
          break
        }
        const end = start + Math.min(length, room)
        if (room < length - 1e-9) shortened++
        const { anchor: _anchor, ...rest } = c.item
        void _anchor
        const item: ZoomSegment = { ...rest, id: newZoomId(), start, end, auto: false }
        q = { ...q, zooms: [...q.zooms, item].sort((a, b) => a.start - b.start) }
        keys.push(itemKey(c.kind, item.id))
        break
      }
      case 'chapter': {
        const t = c.item.t + offset
        if (chapterNear(q.chapters ?? [], t)) skipped.push({ kind: c.kind, why: 'chapter-near' })
        else if (t > duration || !chapterInVideo(q.clips, t)) skipped.push({ kind: c.kind, why: 'chapter-end' })
        else {
          const item = createChapter(t, c.item.title)
          q = { ...q, chapters: [...(q.chapters ?? []), item] }
          keys.push(itemKey(c.kind, item.id))
        }
        break
      }
      case 'freeze': {
        if (clip.projectId !== p.id) {
          skipped.push({ kind: c.kind, why: 'freeze-other-recording' })
          break
        }
        const r = freezeAtPlayhead(q, c.item.at + offset, { length: c.item.length, sound: c.item.sound })
        if ('refused' in r) skipped.push({ kind: c.kind, why: `freeze-${r.refused}` })
        else {
          q = r.project
          keys.push(itemKey(c.kind, r.id))
        }
        break
      }
    }
  }
  return { project: keys.length ? q : p, keys, at, movedBack, shortened, skipped }
}

/**
 * The clipboard pasted at the playhead, in one project: on the frame the preview shows there (in a
 * cut, the next kept one), moved back when the items would run past the end. Freeze frames hold a
 * frame of their own recording, so they paste only into it.
 */
export function pasteItems(p: Project, clip: ItemClipboard, playhead: number): PasteResult {
  const want = displayTime(p.clips, playhead)
  const at = clamp(want, 0, Math.max(0, p.duration - clip.span))
  return place(p, clip, at, at < want - 1e-9)
}

/** A fresh copy of `keys` right after themselves (at least DUPLICATE_MIN_OFFSET later), with paste's rules; the clipboard is not used. */
export function duplicateItems(p: Project, keys: readonly ItemKey[]): PasteResult {
  const clip = copyItems(p, keys)
  if (!clip) return { project: p, keys: [], at: 0, movedBack: false, shortened: 0, skipped: [] }
  const want = clip.origin + Math.max(clip.span, DUPLICATE_MIN_OFFSET)
  const at = clamp(want, 0, Math.max(0, p.duration - clip.span))
  return place(p, clip, at, at < want - 1e-9)
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const countOf = (n: number, kind: GroupKind): string => `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`

/** Why items were skipped, as the end of a notice: "1 zoom is already there, 1 freeze frame is in a cut". */
function skipText(kind: GroupKind, why: PasteSkip, n: number): string {
  const is = n === 1 ? 'is' : 'are'
  const what = countOf(n, kind)
  switch (why) {
    case 'outside':
      return `${what} would end after the video`
    case 'zoom-taken':
    case 'chapter-near':
    case 'freeze-taken':
      return `${what} ${is} already there`
    case 'chapter-end':
      return `${what} would be at the very end`
    case 'freeze-cut':
      return `${what} ${is} in a cut`
    case 'freeze-frozen':
      return `${what} would land where the picture is already frozen`
    case 'freeze-full':
      return `${what} would go past the limit of ${MAX_FREEZES}`
    case 'freeze-other-recording':
      return `${what} ${is} from another recording`
  }
}

/**
 * What a paste (or, with `verb` "Duplicated", a duplicate) did: "Pasted 6 items", "Pasted 6 items
 * at 0:52.0 (moved back so they fit)", "Pasted 4 of 6: 1 zoom is already there, …", "… · 1 zoom
 * was shortened to fit". `total` is how many items were copied.
 */
export function pasteNotice(r: PasteResult, total: number, verb = 'Pasted'): string {
  const n = r.keys.length
  const counts = new Map<string, { kind: GroupKind; why: PasteSkip; n: number }>()
  for (const s of r.skipped) {
    const id = `${s.kind}:${s.why}`
    const c = counts.get(id)
    if (c) c.n++
    else counts.set(id, { ...s, n: 1 })
  }
  const reasons = [...counts.values()].map((c) => skipText(c.kind, c.why, c.n)).join(', ')
  const where = r.movedBack ? ` at ${formatTime(r.at)} (moved back so they fit)` : ''
  let text: string
  if (n === 0) text = `Nothing ${verb.toLowerCase()}${reasons ? `: ${reasons}` : ''}`
  else if (n < total) text = `${verb} ${n} of ${total}${where}${reasons ? `: ${reasons}` : ''}`
  else text = `${verb} ${plural(n, 'item')}${where}`
  if (r.shortened) text += ` · ${countOf(r.shortened, 'zoom')} ${r.shortened === 1 ? 'was' : 'were'} shortened to fit`
  return text
}
