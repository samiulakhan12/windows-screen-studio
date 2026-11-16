/**
 * Making a copy from the editor (X-04, NW-05, docs/design/vertical-video.md §2.3, §4.8): flush
 * the save (asking before copying when it failed), build the copy with projectCopy (measuring
 * text as the compositor does), call the API with progress, and say what was made. The editor
 * pauses before, shows CopyProgress meanwhile (it appears after 0.5 s) and opens the copy after.
 */
import type { DuplicateProgress, DuplicateResult } from '../../../shared/api/projects'
import { withRecordedStems } from '../../../shared/audio/settings'
import { captionCopyNotice, projectCopy, type CopyKind, type MeasureText } from '../../../shared/editor/duplicate'
import { withRecordedCamera } from '../../../shared/engine/webcamData'
import type { Project } from '../../../shared/types'
import { t, type MessageKey } from '../../../shared/i18n/t'

/** Every message a failed copy shows: "Could not make the copy: …" (§2.3). */
const failed = (reason: string): string => t('review.copy.failed', { reason })
/** What was made, said in the copy (`look`: also the caption look chosen again for its shape). */
const MADE: Record<CopyKind, { plain: MessageKey; look: MessageKey }> = {
  vertical: { plain: 'review.copy.madeVertical', look: 'review.copy.madeVerticalLook' },
  square: { plain: 'review.copy.madeSquare', look: 'review.copy.madeSquareLook' },
  copy: { plain: 'review.copy.madeCopy', look: 'review.copy.madeCopyLook' }
}

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

/**
 * The new project's id and the notice to show there, or null when cancelled or not confirmed. Rejects with the message to show.
 * `stored` is the project as loaded (LoadedProject.project): the editor opens it without its stems or camera while one of
 * their files is missing, and the copy keeps them as a save does, so it uses them too once the file is back.
 */
export async function runDuplicate(
  kind: CopyKind,
  deps: {
    project: Project
    stored: Pick<Project, 'audioStems' | 'hasWebcam'>
    flush(): Promise<boolean>
    confirm(msg: string): boolean
    onProgress(p: DuplicateProgress | null): void
    signal: AbortSignal
  }
): Promise<{ id: string; notice: string } | null> {
  const { project, stored, signal } = deps
  // The copy is built from the editor's state, so it has the latest edit even when the save failed.
  const saved = await deps.flush()
  if (signal.aborted || (!saved && !deps.confirm(t('review.copy.unsaved')))) return null
  const copy = projectCopy(withRecordedCamera(withRecordedStems(project, stored), stored), kind, canvasMeasure())
  const off = window.api.onDuplicateProgress((p) => {
    if (!signal.aborted) deps.onProgress(p)
  })
  try {
    const making = window.api.duplicateProject(project.id, copy)
    const made = await new Promise<DuplicateResult | null>((resolve, reject) => {
      // Cancel answers at once; main stops at the next piece of the file it is copying and removes the half-made folder.
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
    const name = project.name.trim() || t('review.copy.untitled')
    // Captions Studio §10.5: the caption look chosen again for the new shape is said too.
    const look = captionCopyNotice(project, copy, kind)
    return { id: made.id, notice: look ? t(MADE[kind].look, { look, name }) : t(MADE[kind].plain, { name }) }
  } catch (err) {
    const message = ipcMessage(err)
    // Main's own refusals already start so (projectCopy.ts); in English this is "Could not make the copy: ".
    throw new Error(message.startsWith(failed('')) ? message : failed(message))
  } finally {
    off()
    deps.onProgress(null)
  }
}
