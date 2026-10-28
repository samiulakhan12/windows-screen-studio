/**
 * Making a copy from the editor (X-04, NW-05, docs/design/vertical-video.md §2.3, §4.8): flush
 * the save (asking before copying when it failed), build the copy with projectCopy (measuring
 * text as the compositor does), call the API with progress, and say what was made. The editor
 * pauses before, shows CopyProgress meanwhile (it appears after 0.5 s) and opens the copy after.
 */
import type { DuplicateProgress, DuplicateResult } from '../../../shared/api/projects'
import { projectCopy, type CopyKind, type MeasureText } from '../../../shared/editor/duplicate'
import type { Project } from '../../../shared/types'

/** Every message a failed copy shows starts with this (§2.3). */
const FAILED = 'Could not make the copy: '
const UNSAVED = 'Your latest changes could not be saved. Make the copy anyway? It will include them.'
const MADE: Record<CopyKind, string> = { vertical: 'Made a vertical version.', square: 'Made a square version.', copy: 'Made a copy.' }

/** "Error invoking remote method 'x': Error: message" -> "message". */
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** Text widths as the compositor's canvas draws them (fonts the editor loaded included); null without a canvas. */
function canvasMeasure(): MeasureText | null {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  return (text, px, font, weight) => {
    ctx.font = `${weight} ${px}px ${font}`
    return ctx.measureText(text).width
  }
}

/** The new project's id and the notice to show there, or null when cancelled or not confirmed. Rejects with the message to show. */
export async function runDuplicate(
  kind: CopyKind,
  deps: { project: Project; flush(): Promise<boolean>; confirm(msg: string): boolean; onProgress(p: DuplicateProgress | null): void; signal: AbortSignal }
): Promise<{ id: string; notice: string } | null> {
  const { project, signal } = deps
  // The copy is built from the editor's state, so it has the latest edit even when the save failed.
  const saved = await deps.flush()
  if (signal.aborted || (!saved && !deps.confirm(UNSAVED))) return null
  const copy = projectCopy(project, kind, canvasMeasure())
  const off = window.api.onDuplicateProgress((p) => {
    if (!signal.aborted) deps.onProgress(p)
  })
  try {
    const making = window.api.duplicateProject(project.id, copy)
    const made = await new Promise<DuplicateResult | null>((resolve, reject) => {
      // Cancel answers at once; main removes the half-made folder once the file it is copying is done.
      const onAbort = (): void => {
        window.api.cancelDuplicate()
        // Finished all the same as Cancel was pressed: the user asked for no copy.
        making.then((m) => window.api.deleteProject(m.id)).catch(() => undefined)
        resolve(null)
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      making.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
    if (!made) return null
    const name = project.name.trim() || 'Untitled recording'
    return { id: made.id, notice: `${MADE[kind]} Your original “${name}” is unchanged.` }
  } catch (err) {
    const message = ipcMessage(err)
    throw new Error(message.startsWith(FAILED) ? message : `${FAILED}${message}`)
  } finally {
    off()
    deps.onProgress(null)
  }
}
