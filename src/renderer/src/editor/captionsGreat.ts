/**
 * Make my captions great from the Look section's button and from the palette command
 * (docs/design/captions-studio.md §2.8, §2.14): one run at a time per window, with the saved
 * options, through part P4's runner (greatRun.ts: the AI marks first, cancellable, then one undo
 * step). While it runs the button reads Working… and Cancel stops it.
 */
import { useSyncExternalStore } from 'react'
import { readGreatOptions } from '../../../shared/captions/great'
import type { EditStore } from '../../../shared/editor/editStore'
import type { Project } from '../../../shared/types'
import { runCaptionsGreat } from './greatRun'

let running: AbortController | null = null
/** The project the run edits: closing its editor stops the run (cancelCaptionsGreatFor). */
let runningStore: EditStore<Project> | null = null
const listeners = new Set<() => void>()
const publish = (): void => {
  for (const l of listeners) l()
}

/**
 * Runs Make my captions great on `store` for a `frame`-sized output and shows its notice, ending
 * with `review` (reviewHint) and `undo` (undoHint); nothing while a run goes on.
 */
export async function startCaptionsGreat(deps: { store: EditStore<Project>; frame: { w: number; h: number }; notice: (message: string) => void; undo?: string; review?: string }): Promise<void> {
  if (running) return
  const ctrl = new AbortController()
  running = ctrl
  runningStore = deps.store
  publish()
  try {
    const options = readGreatOptions(await window.api.getPref('captionsGreat').catch(() => null))
    const r = await runCaptionsGreat({ store: deps.store, frame: deps.frame, options, signal: ctrl.signal, undo: deps.undo ?? '', review: deps.review ?? '' })
    if (r && !ctrl.signal.aborted) deps.notice(r.notice)
  } catch (err) {
    if (!ctrl.signal.aborted) deps.notice(`Make my captions great could not finish: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    running = null
    runningStore = null
    publish()
  }
}

/** Cancel: stops a run waiting for an AI provider or still planning (nothing is changed). */
export function cancelCaptionsGreat(): void {
  running?.abort()
}

/**
 * Closing `store`'s editor stops its run, and the provider's request with it: nothing is written,
 * no version is kept, and the next project's button is free once it ends.
 */
export function cancelCaptionsGreatFor(store: EditStore<Project>): void {
  if (runningStore === store) running?.abort()
}

export const captionsGreatBusy = (): boolean => running !== null

export function useCaptionsGreatBusy(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    captionsGreatBusy
  )
}
