import { timelineGaps } from '../../../shared/editor/clips'
import { shortcutLabel } from '../../../shared/editor/shortcuts'
import type { ClickRow } from '../../../shared/engine/inputData'
import { isZoomClick } from '../../../shared/engine/zoom'
import { isGroupKind, parseItemKey, type ItemKey } from '../../../shared/editor/multiSelect'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'
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
  /** A motion graphic made from captions (Captions Studio §2.11). */
  | { kind: 'graphic'; id: string }
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
    case 'graphic':
      return (project.graphics ?? []).some((g) => g.id === sel.id) ? sel : null
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

/** The single selection of a groupable item's key (E-06): `selectionKey(selectionOfKey(k)) === k`. */
export const selectionOfKey = (k: ItemKey): Selection => {
  const parsed = parseItemKey(k)
  return parsed ? { kind: parsed.kind, id: parsed.id } : null
}

/** The key of a selection that can join a group, or null (clips, gaps, ranges, clicks, captions, layouts). */
export const groupKeyOf = (s: Selection): ItemKey | null => (s && 'id' in s && isGroupKind(s.kind) ? (`${s.kind}:${s.id}` as ItemKey) : null)

/* ---------- how a recorded click is described (timeline markers, Zoom and Cursor panels) ---------- */

/** "Left click", "Right click", "Middle click". */
export const clickKind = (button: ClickEvent['button']): string => t('editor.click.kind', { button })

/** Why detection ignored a click, as the end of a sentence (the Zoom panel's "{reason}"); made when read. */
export const STRAY_REASON_TEXT: Readonly<Record<StrayReason, string>> = {
  get start(): string {
    return t('editor.click.stray.start')
  },
  get end(): string {
    return t('editor.click.stray.end')
  },
  get moving(): string {
    return t('editor.click.stray.moving')
  }
}

/** A click marker's tooltip when detection ignored it, one whole sentence per reason. */
const STRAY_TOOLTIP: Readonly<Record<StrayReason, MessageKey>> = {
  start: 'editor.click.tooltip.strayStart',
  end: 'editor.click.tooltip.strayEnd',
  moving: 'editor.click.tooltip.strayMoving'
}

/** A click's state: used, ignored by the user, or ignored by stray-click detection. */
export const clickState = (row: ClickRow): 'used' | 'ignored' | 'stray' => (!row.ignored ? 'used' : row.ignored.stray ? 'stray' : 'ignored')

/**
 * The tooltip of a click marker on the timeline. `deleteKeys`: the Delete selection shortcut
 * (the keymap's deleteSelection); `rightClicks`: Auto zoom › Right clicks, so a click that never
 * starts a zoom does not promise to drop one.
 */
export function clickTooltip(row: ClickRow, deleteKeys: readonly string[], rightClicks: boolean): string {
  const at = fmt.clock(row.click.t)
  const stray = row.ignored?.stray
  if (stray) return t(STRAY_TOOLTIP[stray], { at })
  if (row.ignored) return t('editor.click.tooltip.ignored', { at })
  const values = { button: row.click.button, at, zoom: isZoomClick(row.click, rightClicks) ? 'yes' : 'no' }
  return deleteKeys.length ? t('editor.click.tooltip.usedKey', { ...values, key: shortcutLabel(deleteKeys[0]) }) : t('editor.click.tooltip.used', values)
}

/** What a used click does, for the Selected click section: only left clicks (and right clicks when enabled) start zooms. */
export function usedClickText(click: ClickEvent, rightClicks: boolean): string {
  if (isZoomClick(click, rightClicks)) return t('editor.click.usedZoom')
  return click.button === 'right' ? t('editor.click.usedRight') : t('editor.click.used')
}

/** A count's values: the plural's number and its digits. */
const counted = (n: number): { count: number; n: string } => ({ count: n, n: fmt.count(n) })

/**
 * The start of the Zoom › Auto zoom summary: what auto zoom can zoom for. "3 left clicks (1
 * ignored) · 1 long scroll detected."; with every click ignored that is a sentence of its own:
 * "All 3 left clicks are ignored. 1 typing burst detected."
 */
export function autoZoomFoundText(
  found: { clicks: number; ignored: number; typing: number; marks: number; scrolls: number },
  rightClicks: boolean
): string {
  const allIgnored = found.clicks > 0 && found.ignored === found.clicks
  const ignored = !allIgnored
    ? ''
    : found.clicks === 1
      ? t(rightClicks ? 'zoom.found.onlyClickIgnored' : 'zoom.found.onlyLeftClickIgnored')
      : t(rightClicks ? 'zoom.found.allClicksIgnored' : 'zoom.found.allLeftClicksIgnored', counted(found.clicks))
  const clicks = (): string => {
    const values = { ...counted(found.clicks), ignored: fmt.count(found.ignored) }
    if (found.ignored) return t(rightClicks ? 'zoom.found.clicksIgnored' : 'zoom.found.leftClicksIgnored', values)
    return t(rightClicks ? 'zoom.found.clicks' : 'zoom.found.leftClicks', values)
  }
  const counts = [
    found.clicks > 0 && !allIgnored && clicks(),
    found.typing > 0 && t('zoom.found.typing', counted(found.typing)),
    found.marks > 0 && t('zoom.found.marks', counted(found.marks)),
    found.scrolls > 0 && t('zoom.found.scrolls', counted(found.scrolls))
  ].filter(Boolean)
  // The counts are a line of facts, one after another with a middle dot; the sentence holds them as {list}.
  const detected = counts.length ? t('zoom.found.detected', { list: counts.join(' · ') }) : allIgnored ? '' : t('zoom.found.none')
  return [ignored, detected].filter(Boolean).join(' ')
}
