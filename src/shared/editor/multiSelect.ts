/**
 * Selecting several timeline items (E-06, docs/design/multi-select.md §4.1-4.4, §8): the group
 * next to the editor's single selection, its keys, and the pure rules of Ctrl+click, Shift+click,
 * the box and Ctrl+A. Pure: the renderer (multiSelectControl.ts, Editor.tsx) only reads pointers
 * and keys and calls these.
 */
import type { Project } from '../types'

/** Kinds of items that can be selected together; captions, layouts, clips and clicks stay one at a time (§3). */
export const GROUP_KINDS = ['zoom', 'annotation', 'shape', 'spotlight', 'title', 'chapter', 'freeze'] as const
export type GroupKind = (typeof GROUP_KINDS)[number]
/** `${kind}:${id}`: the snapping owner key, and what selectionKey() gives for the same item. */
export type ItemKey = `${GroupKind}:${string}`

export interface ItemGroup {
  /** Unique, in the order selected; never exactly 1. */
  readonly keys: readonly ItemKey[]
  /** The last item clicked or added: Shift+click starts there, Ctrl+A picks its track. */
  readonly anchor: ItemKey | null
  /** +1 on every group change: keeps undo merge keys of different groups apart. */
  readonly stamp: number
}

export const NO_GROUP: ItemGroup = Object.freeze({ keys: Object.freeze([]) as readonly ItemKey[], anchor: null, stamp: 0 })

/** The timeline row an item sits on (shapes and spotlights share one). */
export type ItemTrack = 'zoom' | 'text' | 'shapes' | 'titles' | 'chapters' | 'freezes'

/** One groupable item: points (chapters, freezes) have start === end (a freeze's `at`). */
export interface ItemEntry {
  key: ItemKey
  kind: GroupKind
  id: string
  track: ItemTrack
  start: number
  end: number
}

export const isGroupKind = (k: string): k is GroupKind => (GROUP_KINDS as readonly string[]).includes(k)

export const itemKey = (kind: GroupKind, id: string): ItemKey => `${kind}:${id}`

export function parseItemKey(key: string): { kind: GroupKind; id: string } | null {
  void key
  return null
}

export const trackOfKind = (k: GroupKind): ItemTrack => {
  void k
  return 'zoom'
}

export function projectItems(p: Project): ItemEntry[] {
  void p
  return []
}

export function validGroup(g: ItemGroup, p: Project): ItemGroup {
  void g
  void p
  return NO_GROUP
}

export function toggleKey(keys: readonly ItemKey[], single: ItemKey | null, key: ItemKey, anchor: ItemKey | null = null): { keys: ItemKey[]; anchor: ItemKey | null } {
  void keys
  void single
  void key
  return { keys: [], anchor }
}

export function extendTo(
  keys: readonly ItemKey[],
  anchor: ItemKey | null,
  single: ItemKey | null,
  key: ItemKey,
  items: readonly ItemEntry[]
): { keys: ItemKey[]; anchor: ItemKey | null } {
  void keys
  void single
  void key
  void items
  return { keys: [], anchor }
}

export function unionKeys(base: readonly ItemKey[], add: Iterable<ItemKey>): ItemKey[] {
  void add
  return [...base]
}

export function trackKeys(items: readonly ItemEntry[], track: ItemTrack): ItemKey[] {
  void items
  void track
  return []
}

export function selectAllStep(items: readonly ItemEntry[], selected: readonly ItemKey[], track: ItemTrack | null): { keys: ItemKey[]; scope: 'track' | 'all' | 'none' } {
  void items
  void selected
  void track
  return { keys: [], scope: 'none' }
}

/** A drawn block's rectangle (px, relative to the timeline's content). */
export interface KeyRect {
  key: ItemKey
  x: number
  y: number
  w: number
  h: number
}

export function rectsHit(rects: readonly KeyRect[], box: { x0: number; y0: number; x1: number; y1: number }): ItemKey[] {
  void rects
  void box
  return []
}

export function topmostHit(boxes: readonly KeyRect[], x: number, y: number): ItemKey | null {
  void boxes
  void x
  void y
  return null
}

export function groupLabel(keys: readonly ItemKey[]): string {
  void keys
  return ''
}

export function kindCounts(keys: readonly ItemKey[]): Partial<Record<GroupKind, number>> {
  void keys
  return {}
}
