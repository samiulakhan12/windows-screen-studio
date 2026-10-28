/**
 * Editing several items together (E-06, docs/design/multi-select.md §4.9-4.12): the field table
 * the Selection view, "Mixed" and copy look / paste look are built from, how one value is written
 * to many items (one project out), deleting a group, and looks. Pure.
 *
 * Every spatial value is read and written in the crop's view (zoomInView, setZoomLevelInView,
 * toCrop / fromCrop), as the single-item panels do, so a crop is respected.
 */
import { fromCrop, toCrop, zoomInView } from '../engine/crop'
import { ZOOM_EASINGS } from '../engine/easing'
import { FREEZE } from '../engine/freeze'
import { MAX_TRANSITION, MIN_TRANSITION, ZOOM_MAX_SCALE, ZOOM_MIN_SCALE, zoomEasing, zoomTargetScale, zoomTransition, type ZoomStyle } from '../engine/zoom'
import type { Annotation, Background, Chapter, Freeze, NormRect, Project, Shape, Spotlight, TitleCard, ZoomSegment } from '../types'
import { ANNOTATION_SIZE } from './annotations'
import { setZoomLevelInView } from './cropEdit'
import { removeFreeze, setFreezeLength, setFreezeSound } from './freezeEdit'
import { parseItemKey, type GroupKind, type ItemKey } from './multiSelect'
import { hasStroke, HIGHLIGHT_COLORS, isPrivacyKind, SHAPE_COLORS, shapeLabel, STROKE_LIMITS } from './shapes'
import { TITLE_BACKGROUNDS, TITLE_COLORS, TITLE_STYLES, TITLE_TEXT_COLORS, titleColorOf, titleTextColorOf } from './titles'
import { formatLevel } from './zoomEdit'

/** Items that share a look: shapes split into marks and privacy shapes; chapters have none. */
export type LookClass = 'zoom' | 'text' | 'mark' | 'privacy' | 'spotlight' | 'title' | 'freeze'

/** The order sections and looks come in. */
export const LOOK_CLASSES: readonly LookClass[] = ['zoom', 'text', 'mark', 'privacy', 'spotlight', 'title', 'freeze']

/** What reads and writes need besides the project: the crop (levels and points are in its view), the zoom style, the background. */
export interface FieldCtx {
  crop: NormRect | null
  cursorValid: boolean
  style: ZoomStyle
  background: Background
  /** Where a cursor-following zoom looks now (full frame), so Fixed point keeps the view. */
  focusFor?: (z: ZoomSegment) => { x: number; y: number }
}

export type FieldControl =
  | { type: 'slider'; min: number; max: number; step: number; format: (v: number) => string }
  | { type: 'chips'; options: readonly { value: string | number; label: string; title?: string }[] }
  | { type: 'toggle' }
  | { type: 'color'; presets: readonly string[] }
  | { type: 'action'; label: string }

export interface GroupField {
  id: string
  cls: LookClass
  label: string
  control: FieldControl
  /** Part of the class's look (copy look / paste look). */
  look: boolean
  applies(item: unknown, p: Project): boolean
  read(item: unknown, p: Project, ctx: FieldCtx): unknown
  eq?(a: unknown, b: unknown): boolean
  write: { item(item: unknown, v: unknown, ctx: FieldCtx): unknown } | { project(p: Project, id: string, v: unknown, ctx: FieldCtx): Project }
  /** Colour presets for these targets (default: the control's). */
  presets?(targets: readonly unknown[]): readonly string[]
  /** The row shows only when every item of its section takes it (a title card's Colour: every card solid). */
  onlyWhenAll?: boolean
}

/** A copied look: its class, the values of the class's look fields, and the item's name ("Box"). */
export interface Look {
  cls: LookClass
  values: Readonly<Record<string, unknown>>
  label: string
}

/** A shared value, or Mixed; `value` is the first target's. */
export type Shared<V> = { mixed: false; value: V } | { mixed: true; value: V }

const pctFmt = (v: number): string => `${Math.round(v * 100)}%`
const secFmt = (v: number): string => `${v.toFixed(2)} s`
const tenthsFmt = (v: number): string => `${v.toFixed(1)} s`
const sizeFmt = (v: number): string => `${Math.round(v * 1000) / 10}%`

/** Numbers within 1e-6 are equal; anything else only when identical (undefined equals only undefined). */
const sameValue = (a: unknown, b: unknown): boolean => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 : a === b)
/** Zoom levels within 1e-3 are equal (as the Zoom panel's preset chips). */
const sameLevel = (a: unknown, b: unknown): boolean => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-3
/** Colours compare in lower case. */
const sameColor = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

const isMark = (s: Shape): boolean => !isPrivacyKind(s.kind)
const zoomLevelOf = (z: ZoomSegment, ctx: FieldCtx): number => zoomTargetScale(zoomInView(ctx.crop, z))

/** A field writing `patch(v)` into an item of its class. */
function patchField<T>(
  spec: Omit<GroupField, 'write' | 'applies' | 'read'> & {
    applies?: (item: T, p: Project) => boolean
    read: (item: T, p: Project, ctx: FieldCtx) => unknown
    patch: (item: T, v: unknown, ctx: FieldCtx) => T
  }
): GroupField {
  const { applies, read, patch, ...rest } = spec
  return {
    ...rest,
    applies: (item, p) => (applies ? applies(item as T, p) : true),
    read: (item, p, ctx) => read(item as T, p, ctx),
    write: { item: (item, v, ctx) => patch(item as T, v, ctx) }
  }
}

/** Where a zoom looks now, in the crop's view: a region's centre, its fixed point, or where the cursor-following camera is. */
function lookPoint(z: ZoomSegment, ctx: FieldCtx): { x: number; y: number } {
  const f = zoomInView(ctx.crop, z).focus
  if (f.mode === 'region') return { x: f.x + f.w / 2, y: f.y + f.h / 2 }
  if (f.mode === 'fixed') return { x: f.x, y: f.y }
  return toCrop(ctx.crop, ctx.focusFor ? ctx.focusFor(z) : fromCrop(ctx.crop, { x: 0.5, y: 0.5 }))
}

/**
 * The fields a group edits, in section and row order (§4.9.1). Ranges are the single panels'
 * own constants. Free text, region focus, pan to next zoom, spotlight mode and size and shape
 * geometry are left out on purpose (§4.9.1).
 */
export const GROUP_FIELDS: readonly GroupField[] = [
  patchField<ZoomSegment>({
    id: 'zoom.level',
    cls: 'zoom',
    label: 'Zoom level',
    control: { type: 'slider', min: ZOOM_MIN_SCALE, max: ZOOM_MAX_SCALE, step: 0.05, format: formatLevel },
    look: true,
    read: (z, _p, ctx) => zoomLevelOf(z, ctx),
    eq: sameLevel,
    patch: (z, v, ctx) => setZoomLevelInView(ctx.crop, z, v as number)
  }),
  patchField<ZoomSegment>({
    id: 'zoom.focus',
    cls: 'zoom',
    label: 'Focus',
    control: {
      type: 'chips',
      options: [
        { value: 'cursor', label: 'Follow cursor', title: 'Follow the cursor' },
        { value: 'fixed', label: 'Fixed point', title: 'Look at the point each zoom looks at now' }
      ]
    },
    look: false,
    read: (z) => z.focus.mode,
    patch: (z, v, ctx) => {
      const level = zoomLevelOf(z, ctx)
      if (v === 'cursor') return { ...z, focus: { mode: 'cursor' }, scale: level, auto: false }
      const at = fromCrop(ctx.crop, lookPoint(z, ctx))
      return { ...z, focus: { mode: 'fixed', x: at.x, y: at.y }, scale: level, auto: false }
    }
  }),
  patchField<ZoomSegment>({
    id: 'zoom.easing',
    cls: 'zoom',
    label: 'Easing',
    control: { type: 'chips', options: ZOOM_EASINGS },
    look: true,
    read: (z, _p, ctx) => zoomEasing(z, ctx.style),
    patch: (z, v) => ({ ...z, easing: v as ZoomSegment['easing'], auto: false })
  }),
  patchField<ZoomSegment>({
    id: 'zoom.transition',
    cls: 'zoom',
    label: 'Transition',
    control: { type: 'slider', min: MIN_TRANSITION, max: MAX_TRANSITION, step: 0.05, format: secFmt },
    look: true,
    read: (z, _p, ctx) => zoomTransition(z, ctx.style),
    patch: (z, v) => ({ ...z, transition: v as number, auto: false })
  }),
  patchField<ZoomSegment>({
    id: 'zoom.ownStyle',
    cls: 'zoom',
    label: 'Use zoom style',
    control: { type: 'action', label: 'Use zoom style' },
    look: false,
    applies: (z) => z.easing !== undefined || z.transition !== undefined,
    read: () => null,
    patch: (z) => ({ ...z, easing: undefined, transition: undefined, auto: false })
  }),

  patchField<Annotation>({
    id: 'text.style',
    cls: 'text',
    label: 'Text style',
    control: {
      type: 'chips',
      options: [
        { value: 'pill', label: 'Caption pill' },
        { value: 'title', label: 'Title' }
      ]
    },
    look: true,
    read: (a) => a.style,
    patch: (a, v) => ({ ...a, style: v as Annotation['style'] })
  }),
  patchField<Annotation>({
    id: 'text.size',
    cls: 'text',
    label: 'Size',
    control: { type: 'slider', min: ANNOTATION_SIZE.min, max: ANNOTATION_SIZE.max, step: 0.002, format: sizeFmt },
    look: true,
    read: (a) => a.size,
    patch: (a, v) => ({ ...a, size: v as number })
  }),
  patchField<Annotation>({
    id: 'text.x',
    cls: 'text',
    label: 'Position X',
    control: { type: 'slider', min: 0, max: 1, step: 0.005, format: pctFmt },
    look: false,
    read: (a) => a.x,
    patch: (a, v) => ({ ...a, x: v as number })
  }),
  patchField<Annotation>({
    id: 'text.y',
    cls: 'text',
    label: 'Position Y',
    control: { type: 'slider', min: 0, max: 1, step: 0.005, format: pctFmt },
    look: false,
    read: (a) => a.y,
    patch: (a, v) => ({ ...a, y: v as number })
  }),

  patchField<Shape>({
    id: 'mark.color',
    cls: 'mark',
    label: 'Colour',
    control: { type: 'color', presets: SHAPE_COLORS },
    look: true,
    applies: isMark,
    read: (s) => s.color,
    eq: sameColor,
    patch: (s, v) => ({ ...s, color: (v as string).toLowerCase() }),
    presets: (targets) => ((targets as Shape[]).length > 0 && (targets as Shape[]).every((s) => s.kind === 'highlight') ? HIGHLIGHT_COLORS : SHAPE_COLORS)
  }),
  patchField<Shape>({
    id: 'mark.fill',
    cls: 'mark',
    label: 'Filled',
    control: { type: 'toggle' },
    look: true,
    applies: (s) => s.kind === 'rect' || s.kind === 'ellipse',
    read: (s) => s.fill,
    patch: (s, v) => ({ ...s, fill: !!v })
  }),
  patchField<Shape>({
    id: 'mark.strokeWidth',
    cls: 'mark',
    label: 'Line width',
    control: { type: 'slider', min: STROKE_LIMITS.min, max: STROKE_LIMITS.max, step: 0.5, format: (v) => `${+v.toFixed(1)} px` },
    look: true,
    // Checked on the item as it is after a Filled write (paste look applies fields in this order).
    applies: (s) => isMark(s) && hasStroke(s),
    read: (s) => s.strokeWidth,
    patch: (s, v) => ({ ...s, strokeWidth: v as number })
  }),
  patchField<Shape>({
    id: 'mark.opacity',
    cls: 'mark',
    label: 'Opacity',
    control: { type: 'slider', min: 0.1, max: 1, step: 0.01, format: pctFmt },
    look: true,
    applies: isMark,
    read: (s) => s.opacity,
    patch: (s, v) => ({ ...s, opacity: v as number })
  }),

  patchField<Shape>({
    id: 'privacy.kind',
    cls: 'privacy',
    label: 'Effect',
    control: {
      type: 'chips',
      options: [
        { value: 'blur', label: 'Blur', title: 'A soft blur over the area' },
        { value: 'pixelate', label: 'Pixelate', title: 'Large square pixels over the area' }
      ]
    },
    look: true,
    applies: (s) => isPrivacyKind(s.kind),
    read: (s) => s.kind,
    patch: (s, v) => ({ ...s, kind: v as Shape['kind'] })
  }),
  patchField<Shape>({
    id: 'privacy.strength',
    cls: 'privacy',
    label: 'Amount',
    control: { type: 'slider', min: 0, max: 1, step: 0.01, format: pctFmt },
    look: true,
    applies: (s) => isPrivacyKind(s.kind),
    read: (s) => s.strength,
    patch: (s, v) => ({ ...s, strength: v as number })
  }),

  patchField<Spotlight>({
    id: 'spotlight.shape',
    cls: 'spotlight',
    label: 'Shape',
    control: {
      type: 'chips',
      options: [
        { value: 'ellipse', label: 'Ellipse' },
        { value: 'rect', label: 'Rectangle' }
      ]
    },
    look: true,
    read: (s) => s.shape,
    patch: (s, v) => ({ ...s, shape: v as Spotlight['shape'] })
  }),
  patchField<Spotlight>({
    id: 'spotlight.dim',
    cls: 'spotlight',
    label: 'Darkness',
    control: { type: 'slider', min: 0.1, max: 0.95, step: 0.01, format: pctFmt },
    look: true,
    read: (s) => s.dim,
    patch: (s, v) => ({ ...s, dim: v as number })
  }),
  patchField<Spotlight>({
    id: 'spotlight.feather',
    cls: 'spotlight',
    label: 'Soft edge',
    control: { type: 'slider', min: 0, max: 1, step: 0.01, format: pctFmt },
    look: true,
    read: (s) => s.feather,
    patch: (s, v) => ({ ...s, feather: v as number })
  }),

  patchField<TitleCard>({
    id: 'title.style',
    cls: 'title',
    label: 'Style',
    control: { type: 'chips', options: TITLE_STYLES },
    look: true,
    read: (c) => c.style,
    patch: (c, v) => ({ ...c, style: v as TitleCard['style'] })
  }),
  patchField<TitleCard>({
    id: 'title.background',
    cls: 'title',
    label: 'Background',
    control: { type: 'chips', options: TITLE_BACKGROUNDS },
    look: true,
    read: (c) => c.background,
    patch: (c, v) => ({ ...c, background: v as TitleCard['background'] })
  }),
  patchField<TitleCard>({
    id: 'title.color',
    cls: 'title',
    label: 'Colour',
    control: { type: 'color', presets: TITLE_COLORS },
    look: true,
    onlyWhenAll: true,
    applies: (c) => c.background === 'solid',
    read: (c) => titleColorOf(c),
    eq: sameColor,
    patch: (c, v) => ({ ...c, color: (v as string).toLowerCase() })
  }),
  patchField<TitleCard>({
    id: 'title.textColor',
    cls: 'title',
    label: 'Text colour',
    control: { type: 'color', presets: TITLE_TEXT_COLORS },
    look: true,
    read: (c, _p, ctx) => titleTextColorOf(c, ctx.background),
    eq: sameColor,
    patch: (c, v) => ({ ...c, textColor: (v as string).toLowerCase() })
  }),

  {
    id: 'freeze.length',
    cls: 'freeze',
    label: 'Hold for',
    control: { type: 'slider', min: FREEZE.min, max: FREEZE.max, step: FREEZE.step, format: tenthsFmt },
    look: true,
    applies: () => true,
    read: (f) => (f as Freeze).length,
    write: { project: (p, id, v) => setFreezeLength(p, id, v as number) }
  },
  {
    id: 'freeze.sound',
    cls: 'freeze',
    label: 'Sound',
    control: {
      type: 'chips',
      options: [
        { value: 'pause', label: 'Pause the sound', title: 'Adds the time to the video. The recording waits; music keeps playing.' },
        { value: 'continue', label: 'Keep the sound playing', title: 'Adds no time. The picture holds while the recording plays on.' }
      ]
    },
    look: true,
    applies: () => true,
    read: (f) => (f as Freeze).sound,
    write: { project: (p, id, v) => setFreezeSound(p, id, v as Freeze['sound']) }
  }
]

/** The kind of item a look class's items are. */
const KIND_OF: Readonly<Record<LookClass, GroupKind>> = {
  zoom: 'zoom',
  text: 'annotation',
  mark: 'shape',
  privacy: 'shape',
  spotlight: 'spotlight',
  title: 'title',
  freeze: 'freeze'
}

/** The item list of `kind`. */
function listOf(p: Project, kind: GroupKind): readonly { id: string }[] {
  switch (kind) {
    case 'zoom':
      return p.zooms
    case 'annotation':
      return p.annotations
    case 'shape':
      return p.shapes ?? []
    case 'spotlight':
      return p.spotlights ?? []
    case 'title':
      return p.titles ?? []
    case 'chapter':
      return p.chapters ?? []
    case 'freeze':
      return p.freezes ?? []
  }
}

/** Items by key, looked up once per call. */
function itemsOf(p: Project, keys: readonly ItemKey[]): Map<ItemKey, unknown> {
  const out = new Map<ItemKey, unknown>()
  const byKind = new Map<GroupKind, Map<string, unknown>>()
  for (const key of keys) {
    const k = parseItemKey(key)
    if (!k) continue
    let ids = byKind.get(k.kind)
    if (!ids) byKind.set(k.kind, (ids = new Map(listOf(p, k.kind).map((x) => [x.id, x]))))
    const item = ids.get(k.id)
    if (item) out.set(key, item)
  }
  return out
}

const classOfItem = (kind: GroupKind, item: unknown): LookClass | null => {
  switch (kind) {
    case 'zoom':
      return 'zoom'
    case 'annotation':
      return 'text'
    case 'shape':
      return isPrivacyKind((item as Shape).kind) ? 'privacy' : 'mark'
    case 'spotlight':
      return 'spotlight'
    case 'title':
      return 'title'
    case 'freeze':
      return 'freeze'
    case 'chapter':
      return null
  }
}

/** The look class of an item: shapes split into marks and privacy shapes; chapters (and missing items) have none. */
export function lookClassOf(p: Project, key: ItemKey): LookClass | null {
  const k = parseItemKey(key)
  if (!k) return null
  const item = listOf(p, k.kind).find((x) => x.id === k.id)
  return item ? classOfItem(k.kind, item) : null
}

/**
 * The Selection view's sections: one per look class present (in LOOK_CLASSES order), with the
 * fields that apply to at least one of its items and those items (`targets`). A field that applies
 * only when it applies to all (onlyWhenAll) is left out otherwise.
 */
export function fieldsFor(p: Project, keys: readonly ItemKey[]): { cls: LookClass; keys: ItemKey[]; fields: { field: GroupField; targets: ItemKey[] }[] }[] {
  const items = itemsOf(p, keys)
  const byClass = new Map<LookClass, ItemKey[]>()
  for (const [key, item] of items) {
    const cls = classOfItem(parseItemKey(key)!.kind, item)
    if (!cls) continue
    const list = byClass.get(cls)
    if (list) list.push(key)
    else byClass.set(cls, [key])
  }
  return LOOK_CLASSES.filter((cls) => byClass.has(cls)).map((cls) => {
    const members = byClass.get(cls)!
    const fields = GROUP_FIELDS.filter((f) => f.cls === cls)
      .map((field) => ({ field, targets: members.filter((k) => field.applies(items.get(k), p)) }))
      .filter(({ field, targets }) => targets.length > 0 && (!field.onlyWhenAll || targets.length === members.length))
    return { cls, keys: members, fields }
  })
}

/** The items of `keys` as the field reads them (for presets and Mixed). */
export function fieldItems(p: Project, keys: readonly ItemKey[]): unknown[] {
  return [...itemsOf(p, keys).values()]
}

/** One value when every value is equal (numbers within 1e-6, unless `eq` says otherwise), else Mixed; null for none. */
export function sharedValue<V>(values: readonly V[], eq: (a: V, b: V) => boolean = sameValue): Shared<V> | null {
  if (values.length === 0) return null
  const first = values[0]
  return values.every((v) => eq(v, first)) ? { mixed: false, value: first } : { mixed: true, value: first }
}

/** The value a field shows for `targets`: shared or Mixed (null when none). */
export function fieldValue(p: Project, field: GroupField, targets: readonly ItemKey[], ctx: FieldCtx): Shared<unknown> | null {
  const items = itemsOf(p, targets)
  return sharedValue(
    [...items.values()].map((item) => field.read(item, p, ctx)),
    field.eq ?? sameValue
  )
}

/** Writes `list` of `kind` into the project (freezes kept in anchor order). */
function withList(p: Project, kind: GroupKind, list: unknown[]): Project {
  switch (kind) {
    case 'zoom':
      return { ...p, zooms: list as ZoomSegment[] }
    case 'annotation':
      return { ...p, annotations: list as Annotation[] }
    case 'shape':
      return { ...p, shapes: list as Shape[] }
    case 'spotlight':
      return { ...p, spotlights: list as Spotlight[] }
    case 'title':
      return { ...p, titles: list as TitleCard[] }
    case 'chapter':
      return { ...p, chapters: list as Chapter[] }
    case 'freeze':
      return { ...p, freezes: (list as Freeze[]).sort((a, b) => a.at - b.at) }
  }
}

/** The items of `kind` with an id in `ids` replaced by `fn(item)`, in one O(n) pass; the same project when none changed. */
export function mapItems(p: Project, kind: GroupKind, ids: ReadonlySet<string>, fn: (item: any) => any): Project {
  if (ids.size === 0) return p
  const list = listOf(p, kind)
  let out: unknown[] | null = null
  for (let i = 0; i < list.length; i++) {
    const x = list[i]
    if (!ids.has(x.id)) continue
    const next = fn(x)
    if (next === x) continue
    out ??= list.slice()
    out[i] = next
  }
  return out ? withList(p, kind, out) : p
}

/**
 * Writes `v` to every item of `keys` the field applies to, in one project. Items that already have
 * the value are left as they are, so writing what is there returns the same project (no undo step).
 * `applied` counts the items changed; `refused` the ones a project-level write would not change
 * to `v` (a freeze at the edit's end keeps pausing the sound).
 */
export function applyField(p: Project, field: GroupField, keys: readonly ItemKey[], v: unknown, ctx: FieldCtx): { project: Project; applied: number; refused: number } {
  const eq = field.eq ?? sameValue
  const action = field.control.type === 'action'
  const items = itemsOf(p, keys)
  const kind = KIND_OF[field.cls]
  const targets: { key: ItemKey; id: string; item: unknown }[] = []
  for (const [key, item] of items) {
    const k = parseItemKey(key)!
    if (k.kind !== kind || classOfItem(k.kind, item) !== field.cls || !field.applies(item, p)) continue
    if (!action && eq(field.read(item, p, ctx), v)) continue
    targets.push({ key, id: k.id, item })
  }
  if (targets.length === 0) return { project: p, applied: 0, refused: 0 }
  const write = field.write
  if ('item' in write) {
    let applied = 0
    const project = mapItems(p, kind, new Set(targets.map((t) => t.id)), (item) => {
      const next = write.item(item, v, ctx)
      if (next !== item) applied++
      return next
    })
    return { project, applied, refused: 0 }
  }
  let q = p
  let applied = 0
  let refused = 0
  for (const t of targets) {
    const next = write.project(q, t.id, v, ctx)
    if (next === q) refused++
    else applied++
    q = next
  }
  return { project: q, applied, refused }
}

/** The project without the items of `keys`, in one result (no `freezes` key once the last freeze is gone). */
export function deleteItems(p: Project, keys: readonly ItemKey[]): Project {
  const ids = new Map<GroupKind, Set<string>>()
  for (const key of keys) {
    const k = parseItemKey(key)
    if (!k) continue
    const set = ids.get(k.kind)
    if (set) set.add(k.id)
    else ids.set(k.kind, new Set([k.id]))
  }
  let q = p
  for (const [kind, set] of ids) {
    if (kind === 'freeze') {
      for (const id of set) q = removeFreeze(q, id)
      continue
    }
    const list = listOf(q, kind)
    const rest = list.filter((x) => !set.has(x.id))
    if (rest.length !== list.length) q = withList(q, kind, rest)
  }
  return q
}

/** An item's name for looks and notices: "Box", "Arrow", "Blur", "Zoom", "Text", "Title card", "Spotlight", "Freeze frame". */
function lookName(kind: GroupKind, item: unknown): string {
  switch (kind) {
    case 'zoom':
      return 'Zoom'
    case 'annotation':
      return 'Text'
    case 'shape':
      return shapeLabel((item as Shape).kind)
    case 'spotlight':
      return 'Spotlight'
    case 'title':
      return 'Title card'
    case 'freeze':
      return 'Freeze frame'
    case 'chapter':
      return 'Chapter'
  }
}

/** The look of one item: the values of its class's look fields, read in the crop's view. Null for a chapter or a missing item. */
export function copyLook(p: Project, key: ItemKey, ctx: FieldCtx): Look | null {
  const k = parseItemKey(key)
  const item = k ? itemsOf(p, [key]).get(key) : undefined
  if (!k || !item) return null
  const cls = classOfItem(k.kind, item)
  if (!cls) return null
  const values: Record<string, unknown> = {}
  for (const f of GROUP_FIELDS) if (f.cls === cls && f.look && f.applies(item, p)) values[f.id] = f.read(item, p, ctx)
  return { cls, values, label: lookName(k.kind, item) }
}

/**
 * The look on every selected item of its class, field by field in table order (so Line width is
 * checked after Filled), in one project. Items of other classes are left as they are (`other`).
 * The same project when every target already has the look.
 */
export function pasteLook(p: Project, keys: readonly ItemKey[], look: Look, ctx: FieldCtx): { project: Project; applied: number; other: number } {
  const items = itemsOf(p, keys)
  const targets = [...items].filter(([key, item]) => classOfItem(parseItemKey(key)!.kind, item) === look.cls).map(([key]) => key)
  let q = p
  for (const f of GROUP_FIELDS) {
    if (f.cls !== look.cls || !f.look || !(f.id in look.values)) continue
    q = applyField(q, f, targets, look.values[f.id], ctx).project
  }
  return { project: q, applied: targets.length, other: items.size - targets.length }
}

const optionLabel = (field: string, v: unknown): string => {
  const f = GROUP_FIELDS.find((x) => x.id === field)
  const opt = f?.control.type === 'chips' ? f.control.options.find((o) => o.value === v) : undefined
  return opt?.label ?? String(v)
}

/** What a held look is, for tooltips: "Text: Title style, 7 %", "Box: #ff3b30, 6 px", "Zoom: 2×, smooth". */
export function lookLabel(look: Look): string {
  const v = look.values
  const num = (id: string): number | null => (typeof v[id] === 'number' ? (v[id] as number) : null)
  const pct = (x: number | null): string | null => (x === null ? null : `${Math.round(x * 100)} %`)
  const parts: (string | null)[] = []
  switch (look.cls) {
    case 'zoom':
      parts.push(num('zoom.level') === null ? null : formatLevel(num('zoom.level')!), v['zoom.easing'] ? optionLabel('zoom.easing', v['zoom.easing']).toLowerCase() : null)
      break
    case 'text':
      parts.push(v['text.style'] ? `${optionLabel('text.style', v['text.style'])} style` : null, num('text.size') === null ? null : `${Math.round(num('text.size')! * 1000) / 10} %`)
      break
    case 'mark':
      parts.push(typeof v['mark.color'] === 'string' ? (v['mark.color'] as string) : null, v['mark.fill'] === true ? 'filled' : num('mark.strokeWidth') === null ? null : `${+num('mark.strokeWidth')!.toFixed(1)} px`)
      break
    case 'privacy':
      parts.push(pct(num('privacy.strength')))
      break
    case 'spotlight':
      parts.push(v['spotlight.shape'] ? optionLabel('spotlight.shape', v['spotlight.shape']).toLowerCase() : null, num('spotlight.dim') === null ? null : `${pct(num('spotlight.dim'))} dark`)
      break
    case 'title':
      parts.push(v['title.style'] ? optionLabel('title.style', v['title.style']) : null, v['title.background'] ? optionLabel('title.background', v['title.background']) : null)
      break
    case 'freeze':
      parts.push(num('freeze.length') === null ? null : tenthsFmt(num('freeze.length')!), v['freeze.sound'] === 'continue' ? 'sound plays on' : v['freeze.sound'] === 'pause' ? 'sound paused' : null)
      break
  }
  const text = parts.filter(Boolean).join(', ')
  return text ? `${look.label}: ${text}` : look.label
}

/** What each look class's items are called, singular and plural ("Pasted the box look onto 3 shapes"). */
export const LOOK_CLASS_WORDS: Readonly<Record<LookClass, readonly [string, string]>> = {
  zoom: ['zoom', 'zooms'],
  text: ['text item', 'text items'],
  mark: ['shape', 'shapes'],
  privacy: ['blur or pixelate area', 'blur or pixelate areas'],
  spotlight: ['spotlight', 'spotlights'],
  title: ['title card', 'title cards'],
  freeze: ['freeze frame', 'freeze frames']
}
