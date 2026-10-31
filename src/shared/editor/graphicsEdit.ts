/**
 * Editing motion graphics (docs/design/captions-studio.md §10.5): each function is one update of
 * the project, and gives the project itself when nothing changes. The graphics stay as reading the
 * saved project gives them (readGraphics: inside the recording, texts cleaned, in time order).
 */
import { readGraphics } from '../captions/studioData'
import { GRAPHIC_DEFAULTS } from '../render/graphics'
import type { Graphic, Project } from '../types'

/** Shortest a graphic is trimmed to, seconds. */
const MIN_LENGTH = 0.2

/** The project with `graphics` as reading them gives them (none: no key). */
function withGraphics(project: Project, graphics: readonly Graphic[]): Project {
  const read = readGraphics(graphics, project.duration, project.transcript)
  const { graphics: _old, ...rest } = project
  void _old
  if (JSON.stringify(read) === JSON.stringify(project.graphics)) return project
  return read ? { ...rest, graphics: read } : rest
}

/** The first id `g<n>` no graphic has. */
function freshId(project: Project): string {
  const taken = new Set((project.graphics ?? []).map((g) => g.id))
  let n = (project.graphics?.length ?? 0) + 1
  while (taken.has(`g${n}`)) n++
  return `g${n}`
}

/** A counter's count for its digits (§10.1): max(1.2 s, min(2.0 s, 0.3 s per digit)). */
const countFor = (to: number): number => Math.max(1.2, Math.min(2.0, 0.3 * String(Math.floor(Math.abs(to))).length))

/** A new graphic of `kind` from `start` to `end` with the defaults of §10.1. */
function fresh(project: Project, kind: Graphic['kind'], id: string, start: number, end: number): Graphic {
  const d = GRAPHIC_DEFAULTS[kind]
  const base = { id, start, end, place: 'auto' as const, size: d.size, enter: { ...d.enter }, exit: { ...d.exit } }
  switch (kind) {
    case 'keyword':
      return { ...base, kind, text: 'Key point', look: 'card' }
    case 'emoji':
      return { ...base, kind, emoji: '2728' }
    case 'counter':
      return { ...base, kind, from: 0, to: 100, decimals: 0, prefix: '', suffix: '%', locale: project.transcript?.language ?? 'en', countFor: countFor(100) }
    case 'list':
      return { ...base, kind, marker: 'number', items: [{ text: 'First point', at: start }] }
  }
}

/**
 * A graphic of `kind` added at source time `at` (§10.5, the Add menu): its length of §10.1 (moved
 * back to fit before the end), placed automatically, `init` over its defaults; and its id.
 */
export function addGraphic(project: Project, kind: Graphic['kind'], at: number, init?: Partial<Graphic>): { project: Project; id: string } {
  const id = freshId(project)
  const duration = Math.max(0, project.duration)
  const length = Math.min(GRAPHIC_DEFAULTS[kind].length, duration)
  const start = Math.max(0, Math.min(Number.isFinite(at) ? at : 0, duration - length))
  const { id: _id, kind: _kind, ...given } = (init ?? {}) as Partial<Graphic>
  void _id
  void _kind
  const g = { ...fresh(project, kind, id, start, start + length), ...given, id, kind } as Graphic
  const next = withGraphics(project, [...(project.graphics ?? []), g])
  return { project: next, id: next.graphics?.some((x) => x.id === id) ? id : '' }
}

/** Graphic `id` with `patch` merged in (its id and kind kept). */
export function updateGraphic(project: Project, id: string, patch: Partial<Graphic>): Project {
  const list = project.graphics ?? []
  const i = list.findIndex((g) => g.id === id)
  if (i < 0) return project
  const { id: _id, kind: _kind, ...rest } = patch as Partial<Graphic>
  void _id
  void _kind
  const g = { ...list[i], ...rest } as Graphic
  return withGraphics(project, list.map((x, k) => (k === i ? g : x)))
}

/** A graphic moved by `dt` seconds, list items with it. */
function shifted(g: Graphic, dt: number): Graphic {
  const moved = { ...g, start: g.start + dt, end: g.end + dt }
  return g.kind === 'list' ? ({ ...moved, items: g.items.map((it) => ({ ...it, at: it.at + dt })) } as Graphic) : (moved as Graphic)
}

/** Graphics `ids` moved by `dt` seconds together (one timeline gesture), kept inside the recording. */
export function moveGraphics(project: Project, ids: readonly string[], dt: number): Project {
  const list = project.graphics ?? []
  const chosen = new Set(ids)
  const moving = list.filter((g) => chosen.has(g.id))
  if (!moving.length || !Number.isFinite(dt) || dt === 0) return project
  // The group moves as one: as far as its first start and last end allow.
  const lo = -Math.min(...moving.map((g) => g.start))
  const hi = project.duration - Math.max(...moving.map((g) => g.end))
  const d = Math.min(hi, Math.max(lo, dt))
  if (d === 0) return project
  return withGraphics(project, list.map((g) => (chosen.has(g.id) ? shifted(g, d) : g)))
}

/** Graphic `id` trimmed: its start or end at `t`, at least 0.2 s long, inside the recording. */
export function trimGraphic(project: Project, id: string, edge: 'start' | 'end', t: number): Project {
  const list = project.graphics ?? []
  const g = list.find((x) => x.id === id)
  if (!g || !Number.isFinite(t)) return project
  const next = edge === 'start' ? { ...g, start: Math.max(0, Math.min(t, g.end - MIN_LENGTH)) } : { ...g, end: Math.min(project.duration, Math.max(t, g.start + MIN_LENGTH)) }
  if (next.start === g.start && next.end === g.end) return project
  return withGraphics(project, list.map((x) => (x.id === id ? (next as Graphic) : x)))
}

/** Graphics `ids` deleted (one or many). */
export function deleteGraphics(project: Project, ids: readonly string[]): Project {
  const gone = new Set(ids)
  const list = project.graphics ?? []
  if (!list.some((g) => gone.has(g.id))) return project
  return withGraphics(project, list.filter((g) => !gone.has(g.id)))
}

/** A graphic placed by the user (its centre, normalised; dragged or nudged), or automatically again ('auto'). */
export function placeGraphicAt(project: Project, id: string, place: Graphic['place']): Project {
  const list = project.graphics ?? []
  const g = list.find((x) => x.id === id)
  if (!g) return project
  const next = place === 'auto' ? 'auto' : { x: Math.min(1, Math.max(0, place.x)), y: Math.min(1, Math.max(0, place.y)) }
  if (JSON.stringify(next) === JSON.stringify(g.place)) return project
  return withGraphics(project, list.map((x) => (x.id === id ? ({ ...x, place: next } as Graphic) : x)))
}
