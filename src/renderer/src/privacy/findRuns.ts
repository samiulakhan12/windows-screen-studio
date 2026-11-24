/**
 * Find private info's runs in this window (docs/design/auto-blur.md §2.6, §5.1): the one run going on
 * (started by *Find private info…* or by Polish), its progress as main sends it, how to stop it and
 * apply what it found, and the last run's outcome for each project (its result line). One Find runs
 * in Flown at a time, and it belongs to the open editor. Main's progress events are taken only for
 * the run's own project and request. No screen text is ever held here.
 */
import type { FindProgress } from '../../../shared/api/privacy'
import type { FindOutcome } from '../../../shared/privacy/findState'

export interface FindRun {
  projectId: string
  requestId: string
  /** Who started it: the Find dialog, or Polish's step. */
  by: 'find' | 'polish'
  /** Main's latest progress for it (a first one before main says anything). */
  progress: FindProgress
  /** Stops it and resolves once what it found is applied (*Stop*, *Stop Find and export*, leaving). */
  stop: () => Promise<void>
}

let run: FindRun | null = null
/** Every request id a run of this window had: their events never show as another request's progress. */
const tracked = new Set<string>()
const outcomes = new Map<string, FindOutcome>()
const listeners = new Set<() => void>()
let listening: (() => void) | null = null

function emit(): void {
  for (const l of [...listeners]) l()
}

/** Main's progress, for the run going on (its project and request only). */
function onProgress(p: FindProgress): void {
  if (!run || p.projectId !== run.projectId || p.requestId !== run.requestId) return
  run = { ...run, progress: p }
  emit()
}

/** Hears main's progress events, once for the window. */
function listen(): void {
  if (listening) return
  const api = (globalThis as { window?: { api?: { onFindProgress?: (l: (p: FindProgress) => void) => () => void } } }).window?.api
  listening = typeof api?.onFindProgress === 'function' ? api.onFindProgress(onProgress) : () => undefined
}

/** Calls `listener` on every change of the runs; returns the unsubscribe. */
export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener)
  listen()
  return () => {
    listeners.delete(listener)
  }
}

/** The run going on in Flown, or null. */
export const currentRun = (): FindRun | null => run

/** The run going on for `projectId`, or null. */
export const runFor = (projectId: string): FindRun | null => (run && run.projectId === projectId ? run : null)

/** Starts tracking a run (one at a time: false when one already runs). */
export function beginRun(r: Omit<FindRun, 'progress'>): boolean {
  if (run) return false
  listen()
  tracked.add(r.requestId)
  run = { ...r, progress: { projectId: r.projectId, requestId: r.requestId, phase: 'look', done: 0, total: 100, secondsLeft: null } }
  outcomes.delete(r.projectId)
  emit()
  return true
}

/** Ends run `requestId` (its results applied, or nothing to apply), keeping its outcome for the result line. */
export function endRun(requestId: string, outcome: FindOutcome | null): void {
  if (!run || run.requestId !== requestId) return
  const id = run.projectId
  run = null
  if (outcome) outcomes.set(id, outcome)
  emit()
}

/** Whether `requestId` is (or was) a run of this window's: Find's or Polish's, not Cover this text everywhere's. */
export const isTracked = (requestId: string): boolean => tracked.has(requestId)

/** The last run's outcome for `projectId` (its result line), or null. */
export const outcomeFor = (projectId: string): FindOutcome | null => outcomes.get(projectId) ?? null

/** Forgets the outcome of `projectId` (the project closed). */
export function forgetOutcome(projectId: string): void {
  if (outcomes.delete(projectId)) emit()
}

/** Tests: no run and no outcome. */
export function resetRuns(): void {
  run = null
  listening = null
  tracked.clear()
  outcomes.clear()
  emit()
}
