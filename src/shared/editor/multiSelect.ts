/**
 * Selecting several timeline items (E-06, docs/design/multi-select.md §4.1-4.4, §8): the group
 * next to the editor's single selection, its keys, and the pure rules of Ctrl+click, Shift+click,
 * the box and Ctrl+A. Pure: the renderer (multiSelectControl.ts, Editor.tsx) only reads pointers
 * and keys and calls these.
 */
import type { Project } from '../types'

/** Kinds of items that can be selected together; captions, layouts, clips and clicks stay one at a time (§3). */
export const GROUP_KINDS = ['zoom', 'annotation', 'shape', 'spotlight', 'overlay', 'title', 'chapter', 'freeze'] as const
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
export type ItemTrack = 'zoom' | 'text' | 'shapes' | 'images' | 'titles' | 'chapters' | 'freezes'

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

/** The kind and id of a key, or null when it is not a groupable item's key. */
export function parseItemKey(key: string): { kind: GroupKind; id: string } | null {
  const i = key.indexOf(':')
  if (i <= 0) return null
  const kind = key.slice(0, i)
  const id = key.slice(i + 1)
  return isGroupKind(kind) && id ? { kind, id } : null
}

const TRACK_OF: Readonly<Record<GroupKind, ItemTrack>> = {
  zoom: 'zoom',
  annotation: 'text',
  shape: 'shapes',
  spotlight: 'shapes',
  overlay: 'images',
  title: 'titles',
  chapter: 'chapters',
  freeze: 'freezes'
}

export const trackOfKind = (k: GroupKind): ItemTrack => TRACK_OF[k]

const byTime = (a: ItemEntry, b: ItemEntry): number => a.start - b.start || a.end - b.end || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** Every groupable item of the project, sorted by start, then end, then key (deterministic for equal starts). */
export function projectItems(p: Project): ItemEntry[] {
  const out: ItemEntry[] = []
  const add = (kind: GroupKind, list: readonly { id: string; start: number; end: number }[] | undefined): void => {
    for (const x of list ?? []) out.push({ key: itemKey(kind, x.id), kind, id: x.id, track: TRACK_OF[kind], start: x.start, end: x.end })
  }
  add('zoom', p.zooms)
  add('annotation', p.annotations)
  add('shape', p.shapes)
  add('spotlight', p.spotlights)
  add('overlay', p.overlays)
  add('title', p.titles)
  for (const c of p.chapters ?? []) out.push({ key: itemKey('chapter', c.id), kind: 'chapter', id: c.id, track: 'chapters', start: c.t, end: c.t })
  for (const f of p.freezes ?? []) out.push({ key: itemKey('freeze', f.id), kind: 'freeze', id: f.id, track: 'freezes', start: f.at, end: f.at })
  return out.sort(byTime)
}

/** The ids of every item of `kind` in the project. */
function idsOf(p: Project, kind: GroupKind): readonly { id: string }[] {
  switch (kind) {
    case 'zoom':
      return p.zooms
    case 'annotation':
      return p.annotations
    case 'shape':
      return p.shapes ?? []
    case 'spotlight':
      return p.spotlights ?? []
    case 'overlay':
      return p.overlays ?? []
    case 'title':
      return p.titles ?? []
    case 'chapter':
      return p.chapters ?? []
    case 'freeze':
      return p.freezes ?? []
  }
}

/**
 * The group without the keys whose item is gone (after undo, Delete, regenerating auto zoom). The
 * same object when nothing is dropped; NO_GROUP when nothing is left. One key left is returned as a
 * one-key group: the editor then shows it as the single selection.
 */
export function validGroup(g: ItemGroup, p: Project): ItemGroup {
  if (g.keys.length === 0) return g
  const present = new Map<GroupKind, Set<string>>()
  const has = (key: ItemKey): boolean => {
    const k = parseItemKey(key)
    if (!k) return false
    let ids = present.get(k.kind)
    if (!ids) present.set(k.kind, (ids = new Set(idsOf(p, k.kind).map((x) => x.id))))
    return ids.has(k.id)
  }
  const keys = g.keys.filter(has)
  if (keys.length === g.keys.length) return g
  if (keys.length === 0) return NO_GROUP
  const anchor = g.anchor && keys.includes(g.anchor) ? g.anchor : keys[keys.length - 1]
  return { keys, anchor, stamp: g.stamp }
}

/** The keys a gesture starts from: the group's, else the single groupable selection's. */
const baseOf = (keys: readonly ItemKey[], single: ItemKey | null): ItemKey[] => (keys.length ? [...keys] : single ? [single] : [])

/**
 * Ctrl+click: `key` joins (it becomes the anchor) or leaves (the anchor stays, or when the anchor
 * left, the last remaining key). A single groupable selection (`single`) is the first member; with a
 * non-groupable one the caller passes null and the result is the clicked item alone.
 */
export function toggleKey(keys: readonly ItemKey[], single: ItemKey | null, key: ItemKey, anchor: ItemKey | null = null): { keys: ItemKey[]; anchor: ItemKey | null } {
  const base = baseOf(keys, single)
  if (!base.includes(key)) return { keys: [...base, key], anchor: key }
  const rest = base.filter((k) => k !== key)
  const was = anchor ?? (keys.length ? null : single)
  return { keys: rest, anchor: was && was !== key && rest.includes(was) ? was : (rest[rest.length - 1] ?? null) }
}

/**
 * Shift+click: with the anchor on the same track, every item of that track from the anchor to `key`
 * (in track order: start, end, key; shapes and spotlights interleaved) joins, and the anchor stays.
 * Otherwise `key` joins as with Ctrl and becomes the anchor. Never removes.
 */
export function extendTo(
  keys: readonly ItemKey[],
  anchor: ItemKey | null,
  single: ItemKey | null,
  key: ItemKey,
  items: readonly ItemEntry[]
): { keys: ItemKey[]; anchor: ItemKey | null } {
  const base = baseOf(keys, single)
  const from = anchor ?? single
  const byKey = new Map(items.map((x) => [x.key, x]))
  const a = from ? byKey.get(from) : undefined
  const b = byKey.get(key)
  if (!a || !b || a.track !== b.track) return { keys: unionKeys(base, [key]), anchor: key }
  const row = items.filter((x) => x.track === a.track).sort(byTime)
  const i = row.indexOf(a)
  const j = row.indexOf(b)
  const run = row.slice(Math.min(i, j), Math.max(i, j) + 1).map((x) => x.key)
  return { keys: unionKeys(base, run), anchor: from }
}

/** `base` followed by the keys of `add` it does not have yet, in order. */
export function unionKeys(base: readonly ItemKey[], add: Iterable<ItemKey>): ItemKey[] {
  const out = [...base]
  const seen = new Set(out)
  for (const k of add) {
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** The keys of the items on `track`, in time order. */
export function trackKeys(items: readonly ItemEntry[], track: ItemTrack): ItemKey[] {
  return items.filter((x) => x.track === track).map((x) => x.key)
}

/**
 * One press of Ctrl+A: every item of `track` when some of them are not selected yet; otherwise
 * (no track, an empty track, or all of it selected) every item; nothing when there is none.
 */
export function selectAllStep(items: readonly ItemEntry[], selected: readonly ItemKey[], track: ItemTrack | null): { keys: ItemKey[]; scope: 'track' | 'all' | 'none' } {
  if (items.length === 0) return { keys: [], scope: 'none' }
  if (track) {
    const row = trackKeys(items, track)
    const sel = new Set(selected)
    if (row.length > 0 && row.some((k) => !sel.has(k))) return { keys: row, scope: 'track' }
  }
  return { keys: items.map((x) => x.key), scope: 'all' }
}

/** A drawn block's rectangle (px, relative to the timeline's content). */
export interface KeyRect {
  key: ItemKey
  x: number
  y: number
  w: number
  h: number
}

/** Keys whose rectangle intersects the box (touching counts), each once, in rectangle order. */
export function rectsHit(rects: readonly KeyRect[], box: { x0: number; y0: number; x1: number; y1: number }): ItemKey[] {
  const left = Math.min(box.x0, box.x1)
  const right = Math.max(box.x0, box.x1)
  const top = Math.min(box.y0, box.y1)
  const bottom = Math.max(box.y0, box.y1)
  const out: ItemKey[] = []
  const seen = new Set<ItemKey>()
  for (const r of rects) {
    if (seen.has(r.key)) continue
    if (r.x > right || r.x + r.w < left || r.y > bottom || r.y + r.h < top) continue
    seen.add(r.key)
    out.push(r.key)
  }
  return out
}

/** The first box (draw order, topmost first) containing the point, or null. */
export function topmostHit(boxes: readonly KeyRect[], x: number, y: number): ItemKey | null {
  for (const b of boxes) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.key
  return null
}

/** Singular and plural words of each kind, as notices and the Selection view say them. */
export const KIND_WORDS: Readonly<Record<GroupKind, readonly [string, string]>> = {
  zoom: ['zoom', 'zooms'],
  annotation: ['text item', 'text items'],
  shape: ['shape', 'shapes'],
  spotlight: ['spotlight', 'spotlights'],
  overlay: ['image', 'images'],
  title: ['title card', 'title cards'],
  chapter: ['chapter', 'chapters'],
  freeze: ['freeze frame', 'freeze frames']
}

/** "3 zooms", "1 text item". */
export const countOf = (n: number, kind: GroupKind): string => `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`

/** How many keys of each kind. */
export function kindCounts(keys: readonly ItemKey[]): Partial<Record<GroupKind, number>> {
  const out: Partial<Record<GroupKind, number>> = {}
  for (const k of keys) {
    const kind = parseItemKey(k)?.kind
    if (kind) out[kind] = (out[kind] ?? 0) + 1
  }
  return out
}

/** "3 zooms · 2 text items", kinds in GROUP_KINDS order. */
export function groupLabel(keys: readonly ItemKey[]): string {
  const counts = kindCounts(keys)
  return GROUP_KINDS.filter((k) => counts[k])
    .map((k) => countOf(counts[k]!, k))
    .join(' · ')
}
