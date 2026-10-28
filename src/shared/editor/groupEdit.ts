/**
 * Editing several items together (E-06, docs/design/multi-select.md §4.9-4.12): the field table
 * the Selection view, "Mixed" and copy look / paste look are built from, how one value is written
 * to many items (one project out), deleting a group, and looks. Pure.
 */
import type { ZoomStyle } from '../engine/zoom'
import type { Background, NormRect, Project, ZoomSegment } from '../types'
import type { GroupKind, ItemKey } from './multiSelect'

/** Items that share a look: shapes split into marks and privacy shapes; chapters have none. */
export type LookClass = 'zoom' | 'text' | 'mark' | 'privacy' | 'spotlight' | 'title' | 'freeze'

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
}

export const GROUP_FIELDS: readonly GroupField[] = []

/** A copied look: its class, the values of the class's look fields, and the item's name ("Box"). */
export interface Look {
  cls: LookClass
  values: Readonly<Record<string, unknown>>
  label: string
}

/** A shared value, or Mixed; `value` is the first target's. */
export type Shared<V> = { mixed: false; value: V } | { mixed: true; value: V }

export function lookClassOf(p: Project, key: ItemKey): LookClass | null {
  void p
  void key
  return null
}

export function fieldsFor(p: Project, keys: readonly ItemKey[]): { cls: LookClass; keys: ItemKey[]; fields: { field: GroupField; targets: ItemKey[] }[] }[] {
  void p
  void keys
  return []
}

export function sharedValue<V>(values: readonly V[], eq?: (a: V, b: V) => boolean): Shared<V> | null {
  void values
  void eq
  return null
}

export function mapItems(p: Project, kind: GroupKind, ids: ReadonlySet<string>, fn: (item: any) => any): Project {
  void kind
  void ids
  void fn
  return p
}

export function applyField(p: Project, field: GroupField, keys: readonly ItemKey[], v: unknown, ctx: FieldCtx): { project: Project; applied: number; refused: number } {
  void field
  void keys
  void v
  void ctx
  return { project: p, applied: 0, refused: 0 }
}

export function deleteItems(p: Project, keys: readonly ItemKey[]): Project {
  void keys
  return p
}

export function copyLook(p: Project, key: ItemKey, ctx: FieldCtx): Look | null {
  void p
  void key
  void ctx
  return null
}

export function pasteLook(p: Project, keys: readonly ItemKey[], look: Look, ctx: FieldCtx): { project: Project; applied: number; other: number } {
  void keys
  void look
  void ctx
  return { project: p, applied: 0, other: 0 }
}

export function lookLabel(look: Look): string {
  return look.label
}
