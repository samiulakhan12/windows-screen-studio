/**
 * AI on this PC as the text tools see it (docs/design/smart-tools.md §2.5, §9.2): the state main
 * sends (read once, then kept up to date by localAi:changed), whether a model is ready, the
 * progress of one request, and the catalogue's note for a task.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AiTextTask, NamesRequest } from '../../../shared/api/ai'
import type { LocalAiProgress, LocalAiState, LocalModelId } from '../../../shared/api/localAi'
import { LOCAL_MODELS } from '../../../shared/localAi/catalog'

export type LocalAiStatus = { status: 'loading' } | { status: 'ready'; state: LocalAiState } | { status: 'failed' }

let current: LocalAiStatus = { status: 'loading' }
const listeners = new Set<() => void>()
let started = false

function set(next: LocalAiStatus): void {
  current = next
  for (const l of listeners) l()
}

const api = (): Window['api'] | undefined => (typeof window !== 'undefined' ? window.api : undefined)

/** Reads the state again (Settings after an action; the first hook starts it). */
export function loadLocalAiState(): void {
  const read = api()?.localAiState
  if (!read) return
  void read().then(
    (state) => set(state ? { status: 'ready', state } : { status: 'failed' }),
    () => set({ status: 'failed' })
  )
}

function start(): void {
  if (started) return
  const a = api()
  if (!a?.localAiState) return
  started = true
  a.onLocalAiState?.((state) => set({ status: 'ready', state }))
  loadLocalAiState()
}

/** Puts a state in place (Settings after an action resolves with one). */
export function setLocalAiState(state: LocalAiState): void {
  set({ status: 'ready', state })
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The state of AI on this PC, kept up to date. */
export function useLocalAi(): LocalAiStatus {
  start()
  return useSyncExternalStore(subscribe, () => current)
}

/**
 * Whether the text tools offer On this PC (pure): a model is downloaded and this PC is not blocked
 * for it, and a pinned Use names such a model.
 */
export function localReady(state: LocalAiState): boolean {
  const usable = state.models.filter((m) => m.state === 'ready' && !m.block).map((m) => m.id)
  return state.use === 'auto' ? usable.length > 0 : usable.includes(state.use)
}

/** Whether a model is downloaded and this PC can run it: the text tools then offer On this PC. */
export function useLocalAiReady(): boolean {
  const s = useLocalAi()
  return s.status === 'ready' && localReady(s.state)
}

/** The model a run would use (pure): main's pick, else the pinned one or the first usable one. */
export function modelInUse(state: LocalAiState): LocalModelId | null {
  if (state.active) return state.active
  const usable = state.models.filter((m) => m.state === 'ready' && !m.block).map((m) => m.id)
  if (state.use !== 'auto') return usable.includes(state.use) ? state.use : null
  return usable[0] ?? null
}

/** The catalogue's note for `task` with the model a run would use (pure), or null. */
export function localNote(state: LocalAiState, task: AiTextTask, kind?: NamesRequest['kind']): string | null {
  const id = modelInUse(state)
  const spec = id ? LOCAL_MODELS.find((m) => m.id === id) : undefined
  if (!spec) return null
  // Step titles and chapter names are titles too: the title note applies to them.
  const key: AiTextTask = task === 'names' && (kind === 'step' || kind === 'chapter' || kind === 'clip') ? 'title' : task
  return spec.notes[key] ?? null
}

/** The progress of request `requestId` on this PC, or null (no request, or none heard yet). */
export function useLocalAiProgress(requestId: string | null): LocalAiProgress | null {
  const [progress, setProgress] = useState<{ id: string; p: LocalAiProgress } | null>(null)
  useEffect(() => {
    if (!requestId) return
    const on = api()?.onLocalAiProgress
    if (!on) return
    return on((p) => {
      if (p.requestId === requestId) setProgress({ id: requestId, p })
    })
  }, [requestId])
  return requestId && progress?.id === requestId ? progress.p : null
}

/** The catalogue's note for `task` with the model a run would use ("Small: titles often repeat the first sentence"), or null. */
export function useLocalNote(task: AiTextTask, kind?: NamesRequest['kind']): string | null {
  const s = useLocalAi()
  return s.status === 'ready' ? localNote(s.state, task, kind) : null
}
