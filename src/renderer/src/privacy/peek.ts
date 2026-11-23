/**
 * Peek and Listen (docs/design/auto-blur.md §2.8, §8.5): one preview-only store. Peek shows the
 * covers asked for as outlines in the editor's preview, Listen plays one private bleep's original
 * sound there, and *Show where covers are* outlines every cover. Only the player's preview scene
 * takes it (peekedScene); every output strips it (forOutput) and never reads this store.
 *
 * Peek and Listen are cleared when the project closes, before an export or guide shots start, when
 * Review closes (its own call), and after 60 s without input.
 */
import { useSyncExternalStore } from 'react'
import type { SoundGain } from '../../../shared/api/export'
import { joinGains } from '../../../shared/audio/soundsEdit'
import type { Project } from '../../../shared/types'
import type { RenderScene } from '../render/compositor'

export interface PeekState {
  /** The covers peeked at: their ids, every cover, or none. */
  ids: readonly string[] | 'all' | null
  /** *Peek while reviewing* is on (Review's header): the selected row is peeked as the user moves. */
  review: boolean
  /** The private bleep listened to (its original sound in the preview), or none. */
  listen: string | null
  /** *Show where covers are* (§2.1): on unless the preference turned it off. */
  marks: boolean
}

/** Seconds without input after which Peek and Listen stop by themselves. */
export const PEEK_IDLE_SECONDS = 60

let state: PeekState = Object.freeze({ ids: null, review: false, listen: null, marks: true })
const listeners = new Set<() => void>()
let idle: ReturnType<typeof setTimeout> | null = null
let watching = false

function emit(): void {
  for (const l of [...listeners]) l()
}

/** Any input puts off the idle stop. */
const onInput = (): void => {
  if (state.ids === null && state.listen === null) return
  arm()
}

function watch(on: boolean): void {
  const w = (globalThis as { window?: { addEventListener?: (t: string, f: () => void, c?: boolean) => void; removeEventListener?: (t: string, f: () => void, c?: boolean) => void } }).window
  if (on === watching || typeof w?.addEventListener !== 'function') return
  watching = on
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    if (on) w.addEventListener(type, onInput, true)
    else w.removeEventListener?.(type, onInput, true)
  }
}

/** (Re)starts the idle stop while anything is peeked or listened to; stops it otherwise. */
function arm(): void {
  if (idle !== null) clearTimeout(idle)
  idle = null
  const active = state.ids !== null || state.listen !== null
  watch(active)
  if (active) idle = setTimeout(clearPeek, PEEK_IDLE_SECONDS * 1000)
}

function set(next: Partial<PeekState>): void {
  const merged = { ...state, ...next }
  const same = merged.ids === state.ids && merged.review === state.review && merged.listen === state.listen && merged.marks === state.marks
  if (same) return
  state = Object.freeze(merged)
  arm()
  emit()
}

/** Peeks at covers `ids`, every cover ('all'), or stops peeking (null). */
export function peekCovers(ids: readonly string[] | 'all' | null): void {
  set({ ids: ids === null || ids === 'all' ? ids : Object.freeze([...ids]) })
}

/** *Peek while reviewing* on or off; off stops peeking. */
export function peekWhileReviewing(on: boolean): void {
  set(on ? { review: true } : { review: false, ids: null })
}

/** Plays private bleep `id`'s original sound in the preview, or stops (null). */
export function listenBleep(id: string | null): void {
  set({ listen: id })
}

/** *Show where covers are* on or off (the preference is written by its checkbox). */
export function showCoverMarks(on: boolean): void {
  set({ marks: on })
}

/** Stops Peek, *Peek while reviewing* and Listen (the cover outlines stay as the preference says). */
export function clearPeek(): void {
  set({ ids: null, review: false, listen: null })
}

/** The store now. */
export function peekNow(): PeekState {
  return state
}

/** Calls `listener` on every change; returns the unsubscribe. */
export function subscribePeek(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The store, following changes (the banner, Review's toggles). */
export function usePeek(): PeekState {
  return useSyncExternalStore(subscribePeek, peekNow)
}

/** The scene the preview drew last for each state: the same object while nothing changes. */
const scenes = new WeakMap<RenderScene, { state: PeekState; scene: RenderScene }>()

/**
 * The player's preview scene with Peek (`peek`) and the cover outlines (`coverMarks`, only for a
 * project with covers) as the store says; the scene itself when neither applies, so a project
 * without covers draws exactly as before. Only the player calls this (§8.5).
 */
export function peekedScene<S extends RenderScene>(scene: S): S {
  const s = state
  const marks = s.marks && !!scene.project.covers?.length
  if (s.ids === null && !marks) return scene
  const hit = scenes.get(scene)
  if (hit && hit.state === s) return hit.scene as S
  const out = { ...scene } as S
  if (s.ids !== null) out.peek = { ids: s.ids }
  else delete out.peek
  if (marks) out.coverMarks = true
  else delete out.coverMarks
  scenes.set(scene, { state: s, scene: out })
  return out
}

/** A project without the listened bleep (the preview's tones), or the project itself. */
export function listenedProject<P extends Pick<Project, 'bleeps'>>(project: P): P {
  const id = state.listen
  if (!id || !project.bleeps?.some((b) => b.id === id)) return project
  return { ...project, bleeps: project.bleeps.filter((b) => b.id !== id) }
}

/**
 * The preview's sound gains with the listened bleep left out (§2.8): its span opened again, except
 * where another bleep also mutes it. `gains` itself when nothing is listened to. Never the export's
 * (the exporter reads jobSoundGains of the project, not this).
 */
export function listenedGains(gains: readonly SoundGain[], project: Pick<Project, 'bleeps'>): readonly SoundGain[] {
  const id = state.listen
  const b = id ? project.bleeps?.find((x) => x.id === id) : undefined
  if (!b || !(b.end > b.start)) return gains
  const out: SoundGain[] = []
  for (const g of gains) {
    if (g.end <= b.start || g.start >= b.end) {
      out.push(g)
      continue
    }
    if (g.start < b.start) out.push({ start: g.start, end: b.start, gain: g.gain })
    if (g.end > b.end) out.push({ start: b.end, end: g.end, gain: g.gain })
  }
  // Another bleep over the listened one still mutes its own words.
  for (const o of project.bleeps ?? []) {
    if (o.id === b.id || o.end <= b.start || o.start >= b.end) continue
    out.push({ start: Math.max(o.start, b.start), end: Math.min(o.end, b.end), gain: 0 })
  }
  return joinGains(out)
}
