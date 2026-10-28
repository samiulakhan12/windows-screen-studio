import { timelineGaps } from '../../../shared/editor/clips'
import { shortcutLabel } from '../../../shared/editor/shortcuts'
import type { ClickRow } from '../../../shared/engine/inputData'
import { formatTime } from '../../../shared/engine/project'
import { isZoomClick } from '../../../shared/engine/zoom'
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
  | { kind: 'freeze'; id: string }
  | { kind: 'overlay'; id: string }
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
    case 'freeze':
      return (project.freezes ?? []).some((f) => f.id === sel.id) ? sel : null
    case 'overlay':
      return (project.overlays ?? []).some((o) => o.id === sel.id) ? sel : null
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

/**
 * The tooltip of a click marker on the timeline. `deleteKeys`: the Delete selection shortcut
 * (the keymap's deleteSelection); `rightClicks`: Auto zoom › Right clicks, so a click that never
 * starts a zoom does not promise to drop one.
 */
export function clickTooltip(row: ClickRow, deleteKeys: readonly string[], rightClicks: boolean): string {
  const at = formatTime(row.click.t)
  const stray = row.ignored?.stray
  if (stray) return `Ignored automatically at ${at}: ${STRAY_REASON_TEXT[stray]} · select it to use it again`
  if (row.ignored) return `Ignored click at ${at} · select it to use it again`
  const how = deleteKeys.length ? `select it and press ${shortcutLabel(deleteKeys[0])} to ignore it` : 'select it to ignore it in the Zoom panel'
  const what = isZoomClick(row.click, rightClicks) ? 'no zoom, click effect or sound' : 'no click effect or sound'
  return `${clickKind(row.click.button)} at ${at} · ${how} (${what})`
}

/** What a used click does, for the Selected click section: only left clicks (and right clicks when enabled) start zooms. */
export function usedClickText(click: ClickEvent, rightClicks: boolean): string {
  if (isZoomClick(click, rightClicks)) {
    return 'Used: it can start an automatic zoom, shows the click effect, plays the click sound and counts as activity for smart speed.'
  }
  const hint = click.button === 'right' ? ' Turn on Auto zoom › Right clicks to zoom for it too.' : ''
  return `Used: it shows the click effect, plays the click sound and counts as activity for smart speed.${hint}`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The start of the Zoom › Auto zoom summary: what auto zoom can zoom for. "3 left clicks (1
 * ignored) · 1 long scroll detected."; with every click ignored that is a sentence of its own:
 * "All 3 left clicks are ignored. 1 typing burst detected."
 */
export function autoZoomFoundText(
  found: { clicks: number; ignored: number; typing: number; marks: number; scrolls: number },
  rightClicks: boolean
): string {
  const clickWord = rightClicks ? 'click' : 'left click'
  const allIgnored = found.clicks > 0 && found.ignored === found.clicks
  const ignored = !allIgnored ? '' : found.clicks === 1 ? `The only ${clickWord} is ignored.` : `All ${found.clicks} ${clickWord}s are ignored.`
  const counts = [
    found.clicks > 0 && !allIgnored && `${plural(found.clicks, clickWord)}${found.ignored ? ` (${found.ignored} ignored)` : ''}`,
    found.typing > 0 && plural(found.typing, 'typing burst'),
    found.marks > 0 && plural(found.marks, 'zoom mark'),
    found.scrolls > 0 && plural(found.scrolls, 'long scroll')
  ].filter(Boolean)
  const detected = counts.length ? `${counts.join(' · ')} detected.` : allIgnored ? '' : 'No usable input detected.'
  return [ignored, detected].filter(Boolean).join(' ')
}
