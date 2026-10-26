import { timelineGaps } from '../../../shared/editor/clips'
import type { ClickRow } from '../../../shared/engine/inputData'
import { formatTime } from '../../../shared/engine/project'
import type { ClickEvent, Project, StrayReason } from '../../../shared/types'

/** What the user has selected on the timeline. Times are source seconds. */
export type Selection =
  | { kind: 'zoom'; id: string }
  | { kind: 'annotation'; id: string }
  | { kind: 'clip'; id: string }
  | { kind: 'shape'; id: string }
  | { kind: 'spotlight'; id: string }
  | { kind: 'layout'; id: string }
  | { kind: 'title'; id: string }
  | { kind: 'chapter'; id: string }
  | { kind: 'caption'; id: string }
  | { kind: 'gap'; start: number; end: number }
  | { kind: 'range'; start: number; end: number }
  /** A recorded click, by its key (clickKey: its time in whole milliseconds). */
  | { kind: 'click'; ms: number }
  | null

/** The selection if it still refers to something in `project` (e.g. after undo), else null. */
export function validSelection(sel: Selection, project: Project): Selection {
  if (!sel) return null
  switch (sel.kind) {
    case 'zoom':
      return project.zooms.some((z) => z.id === sel.id) ? sel : null
    case 'annotation':
      return project.annotations.some((a) => a.id === sel.id) ? sel : null
    case 'clip':
      return project.clips.some((c) => c.id === sel.id) ? sel : null
    case 'shape':
      return (project.shapes ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'spotlight':
      return (project.spotlights ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'layout':
      return (project.layouts ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'title':
      return (project.titles ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'chapter':
      return (project.chapters ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'caption':
      return (project.transcript?.segments ?? []).some((s) => s.id === sel.id) ? sel : null
    case 'gap':
      return timelineGaps(project.clips, project.duration).some((g) => Math.abs(g.start - sel.start) < 1e-6 && Math.abs(g.end - sel.end) < 1e-6)
        ? sel
        : null
    case 'range':
      return sel.end - sel.start > 0.01 ? sel : null
    case 'click':
      // Only the time is checked: cursor.json never changes, so a click selection survives undo.
      return Number.isFinite(sel.ms) && sel.ms >= 0 && sel.ms <= Math.round(project.duration * 1000) ? sel : null
  }
}

export const selectionKey = (sel: Selection): string =>
  !sel ? '' : 'id' in sel ? `${sel.kind}:${sel.id}` : sel.kind === 'click' ? `click:${sel.ms}` : `${sel.kind}:${sel.start}:${sel.end}`

/* ---------- how a recorded click is described (timeline markers, Zoom and Cursor panels) ---------- */

/** "Left click", "Right click", "Middle click". */
export const clickKind = (button: ClickEvent['button']): string => `${button[0].toUpperCase()}${button.slice(1)} click`

/** Why detection ignored a click, as the end of a sentence. */
export const STRAY_REASON_TEXT: Record<StrayReason, string> = {
  start: 'the first moment of the recording, usually the click that focuses the app',
  end: 'right before the recording stopped',
  moving: 'made while the cursor was flying past'
}

/** A click's state: used, ignored by the user, or ignored by stray-click detection. */
export const clickState = (row: ClickRow): 'used' | 'ignored' | 'stray' => (!row.ignored ? 'used' : row.ignored.stray ? 'stray' : 'ignored')

/** The tooltip of a click marker on the timeline. */
export function clickTooltip(row: ClickRow): string {
  const at = formatTime(row.click.t)
  const stray = row.ignored?.stray
  if (stray) return `Ignored automatically at ${at}: ${STRAY_REASON_TEXT[stray]} · select it to use it again`
  if (row.ignored) return `Ignored click at ${at} · select it to use it again`
  return `${clickKind(row.click.button)} at ${at} · select it and press Delete to ignore it (no zoom, click effect or sound)`
}
