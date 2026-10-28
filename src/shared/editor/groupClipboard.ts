/**
 * Copy, paste and duplicate items (E-06, docs/design/multi-select.md §4.11): what the in-memory
 * item clipboard holds, and where pasted items go (one project out). Pure: the renderer keeps the
 * clipboard's value (renderer/editor/itemClipboard.ts); nothing is written to the OS clipboard.
 */
import type { Annotation, Chapter, Freeze, Project, Shape, Spotlight, TitleCard, ZoomSegment } from '../types'
import type { GroupKind, ItemKey } from './multiSelect'

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

export function copyItems(p: Project, keys: readonly ItemKey[]): ItemClipboard | null {
  void p
  void keys
  return null
}

export function pasteItems(p: Project, clip: ItemClipboard, playhead: number): PasteResult {
  void clip
  return { project: p, keys: [], at: playhead, movedBack: false, shortened: 0, skipped: [] }
}

export function duplicateItems(p: Project, keys: readonly ItemKey[]): PasteResult {
  void keys
  return { project: p, keys: [], at: 0, movedBack: false, shortened: 0, skipped: [] }
}

export function pasteNotice(r: PasteResult, total: number, verb = 'Pasted'): string {
  void r
  void total
  return verb
}
