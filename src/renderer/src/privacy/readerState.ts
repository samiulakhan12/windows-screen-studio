/**
 * The text reader's state and Find's progress for the UI (docs/design/auto-blur.md §2.6, §16.5): one
 * shared reader state for every user of it (finding 29: the Find dialog, Settings, the Private info
 * section and Polish read the same one, from main's state events), Find's progress line, and the
 * question asked before leaving the editor while Find runs.
 */
import { createElement, useSyncExternalStore } from 'react'
import type { FindProgress, ReaderState } from '../../../shared/api/privacy'
import { t } from '../../../shared/i18n/t'
import { askConfirm } from '../i18n/askConfirm'
import type { EditorServices } from '../editor/context'
import { FindLine, type FindLinePlace } from './FindLine'
import { runFor, subscribeRuns } from './findRuns'

let reader: ReaderState | null = null
const readerListeners = new Set<() => void>()
let started = false

/** Sets the reader's state for every user (main's events, and what a download or removal answers). */
export function setReaderState(state: ReaderState): void {
  if (reader === state) return
  reader = state
  for (const l of [...readerListeners]) l()
}

type ReaderApi = { readerState?: () => Promise<ReaderState>; onReaderState?: (l: (s: ReaderState) => void) => () => void }

/** Starts following main's reader state, once for the window: its events, and the state asked for once. */
export function startReaderState(): void {
  if (started) return
  const api = (globalThis as { window?: { api?: ReaderApi } }).window?.api
  if (typeof api?.readerState !== 'function') return
  started = true
  if (typeof api.onReaderState === 'function') api.onReaderState(setReaderState)
  api.readerState().then(
    (s) => {
      // An event that came first is newer.
      if (reader === null) setReaderState(s)
    },
    () => undefined
  )
}

/** Calls `listener` on every change of the reader's state; returns the unsubscribe. */
export function subscribeReader(listener: () => void): () => void {
  readerListeners.add(listener)
  startReaderState()
  return () => {
    readerListeners.delete(listener)
  }
}

/** The reader's state now (null until main has said). */
export const readerNow = (): ReaderState | null => reader

/** Tests: forget the state and follow main again from the start. */
export function resetReaderState(): void {
  reader = null
  started = false
  for (const l of [...readerListeners]) l()
}

/** The reader's state, shared by every user (null until known). */
export function useReaderState(): ReaderState | null {
  return useSyncExternalStore(subscribeReader, readerNow, readerNow)
}

/** Find's progress for `projectId` while a run of it goes on in this window (null otherwise). */
export function useFindProgress(projectId: string): FindProgress | null {
  const progress = (): FindProgress | null => runFor(projectId)?.progress ?? null
  return useSyncExternalStore(subscribeRuns, progress, progress)
}

/**
 * The one progress line of §2.6 (a polite status, announced at most every 10% and at each phase
 * change), with *Stop*; once a run of `projectId` ended, its result line (§2.6) with *Review*.
 */
export function FindProgressLine(props: { projectId: string; onReview?: () => void; place?: FindLinePlace }): JSX.Element | null {
  return createElement(FindLine, props)
}

/**
 * Asks before leaving the editor while Find runs (§2.6), through askConfirm as the unsaved-changes
 * question is asked: declined, the editor stays and Find goes on; confirmed, Find stops and what it
 * found is applied (one undo step) before the editor saves and leaves.
 */
export async function confirmLeaveFind(services: EditorServices): Promise<boolean> {
  const run = runFor(services.store.state.id)
  if (!run || run.by !== 'find') return true
  if (!(await askConfirm(t('privacy.leave.body'), 'privacy.leave.action'))) return false
  await run.stop()
  return true
}
