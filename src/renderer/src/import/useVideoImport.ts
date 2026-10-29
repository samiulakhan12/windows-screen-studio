import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportProgress, ImportResult } from '../../../shared/api/import'
import { IMPORT_COPY } from '../../../shared/import/plan'

/** What the import dialog shows (docs/design/import-video.md §6). */
export type ImportView =
  | { kind: 'idle' }
  | { kind: 'running'; fileName: string; stage: ImportProgress['stage']; progress: number | null; startedAt: number }
  | { kind: 'done'; fileName: string; projectId: string; notes: string[] }
  | { kind: 'failed'; fileName: string | null; error: string }

export interface VideoImporter {
  view: ImportView
  /** An import runs (or its result is shown): Home is not idle. */
  busy: boolean
  pick(): void
  /** Imports files dropped on the library: exactly one. */
  drop(files: FileList | readonly File[]): void
  cancel(): void
  close(): void
  open(projectId: string): void
}

/**
 * Runs imports for Home: one at a time, the dialog's state from main's progress, and the result:
 * the editor opens at once, or after the notes were read; a refusal is shown until closed.
 */
export function useVideoImport(onOpen: (projectId: string) => void, onFinished: () => void): VideoImporter {
  const [view, setView] = useState<ImportView>({ kind: 'idle' })
  const running = useRef(false)
  const latest = useRef({ onOpen, onFinished })
  latest.current = { onOpen, onFinished }

  useEffect(
    () =>
      window.api.onImportProgress((p) => {
        if (!running.current) return
        // The time left counts from when the copy started, not from the checks before it.
        setView((v) => ({ kind: 'running', fileName: p.fileName, stage: p.stage, progress: p.progress, startedAt: v.kind === 'running' && v.stage === 'converting' ? v.startedAt : performance.now() }))
      }),
    []
  )

  const finish = useCallback((r: ImportResult | null): void => {
    running.current = false
    if (r === null) return setView({ kind: 'idle' })
    if (r.ok && r.notes.length === 0) {
      setView({ kind: 'idle' })
      latest.current.onOpen(r.projectId)
      return
    }
    latest.current.onFinished()
    if (r.ok) setView({ kind: 'done', fileName: r.fileName, projectId: r.projectId, notes: r.notes })
    else if (r.cancelled) setView({ kind: 'idle' })
    else setView({ kind: 'failed', fileName: r.fileName, error: r.error })
  }, [])

  const start = useCallback(
    (job: () => Promise<ImportResult | null>): void => {
      if (running.current) return
      running.current = true
      job().then(finish, (err: unknown) => finish({ ok: false, fileName: null, error: err instanceof Error ? err.message : String(err) }))
    },
    [finish]
  )

  const pick = useCallback(() => start(() => window.api.importPickedVideo()), [start])

  const drop = useCallback(
    (files: FileList | readonly File[]): void => {
      if (running.current) return
      const list = Array.from(files)
      if (list.length !== 1) return setView({ kind: 'failed', fileName: null, error: IMPORT_COPY.several })
      const file = list[0]
      const path = window.api.importPathForFile(file)
      if (!path) return setView({ kind: 'failed', fileName: file.name, error: IMPORT_COPY.cannotOpen })
      setView({ kind: 'running', fileName: file.name, stage: 'checking', progress: null, startedAt: performance.now() })
      start(() => window.api.importVideoFile(path))
    },
    [start]
  )

  const cancel = useCallback(() => void window.api.cancelImport(), [])
  const close = useCallback(() => setView({ kind: 'idle' }), [])
  const open = useCallback((projectId: string) => {
    setView({ kind: 'idle' })
    latest.current.onOpen(projectId)
  }, [])

  return { view, busy: view.kind !== 'idle', pick, drop, cancel, close, open }
}
