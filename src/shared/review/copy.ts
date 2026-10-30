/**
 * The words of Review mode (docs/design/review-mode.md §4.2, §4.3, §5): item titles, kind names,
 * statuses, progress and the live messages. Pure.
 */
import type { AutoCut, CameraLayout, Corner, LayoutSegment, ZoomSegment } from '../types'
import { formatLevel } from '../editor/zoomEdit'

export type ReviewKind = 'zoom' | 'camera' | 'silence' | 'idle' | 'words'
export type ReviewStatus = 'pending' | 'kept' | 'removed'

/** Kinds in the order items at the same time are listed. */
export const REVIEW_KINDS: readonly ReviewKind[] = ['camera', 'zoom', 'silence', 'idle', 'words']

/** Each kind's chip, its name in a sentence, and its plural on "Remove all …". */
export const KIND_WORDS: Record<ReviewKind, { chip: string; name: string; all: string; one: string; plural: string }> = {
  zoom: { chip: 'Zoom', name: 'zoom', all: 'Remove all zooms', one: 'zoom', plural: 'zooms' },
  camera: { chip: 'Camera', name: 'camera', all: 'Remove all camera changes', one: 'camera change', plural: 'camera changes' },
  silence: { chip: 'Silence', name: 'silence', all: 'Remove all silence cuts', one: 'silence cut', plural: 'silence cuts' },
  idle: { chip: 'Idle', name: 'idle time', all: 'Remove all idle-time changes', one: 'idle-time change', plural: 'idle-time changes' },
  words: { chip: 'Words', name: 'words', all: 'Remove all word cuts', one: 'word cut', plural: 'word cuts' }
}

export const STATUS_WORDS: Record<ReviewStatus, string> = { pending: 'not reviewed', kept: 'kept', removed: 'removed' }

export const REVIEW_TITLE = 'Review automatic changes'
export const REVIEW_EMPTY = 'Nothing to review. Flown has not changed anything by itself yet, or you have reviewed it all.'
export const REVIEW_HINT = 'N or ↓ next, P or ↑ previous, K keep, Delete remove'

/** Where a normalised point is, in thirds of the frame: "top left" … "middle" … "bottom right". */
export function placeOf(x: number, y: number): string {
  const col = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : ''
  const row = y < 1 / 3 ? 'top' : y > 2 / 3 ? 'bottom' : ''
  if (row && col) return `${row} ${col}`
  return row || col || 'middle'
}

/** The point a zoom aims at: its click or typing anchor, else a fixed point, else a region's centre; null when it follows the cursor. */
function zoomPoint(z: ZoomSegment): { x: number; y: number } | null {
  if (z.anchor) return z.anchor
  if (z.focus.mode === 'fixed') return z.focus
  if (z.focus.mode === 'region') return { x: z.focus.x + z.focus.w / 2, y: z.focus.y + z.focus.h / 2 }
  return null
}

export function zoomTitle(z: ZoomSegment): string {
  if (z.scale < 1) return 'Pull back'
  const at = zoomPoint(z)
  const place = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? placeOf(at.x, at.y) : null
  if (z.anchor && typeof z.anchor.until === 'number') return `Zoom in on typing${place ? `, ${place}` : ''}`
  if (z.anchor) return `Zoom in on a click${place ? `, ${place}` : ''}`
  return place ? `Zoom in, ${place}` : 'Zoom in'
}

export const zoomDetail = (z: ZoomSegment): string => formatLevel(z.scale)

const CORNER_WORDS: Record<Corner, string> = { 'top-left': 'top left', 'top-right': 'top right', 'bottom-left': 'bottom left', 'bottom-right': 'bottom right' }
const LAYOUT_TITLES: Record<Exclude<CameraLayout, 'default'>, string> = {
  'camera-only': 'Full camera',
  'camera-large': 'Large camera',
  'side-by-side': 'Camera side by side',
  'screen-only': 'Camera hidden'
}

export function layoutTitle(s: Pick<LayoutSegment, 'layout' | 'corner'>): string {
  if (s.layout !== 'default') return LAYOUT_TITLES[s.layout]
  return s.corner ? `Camera to the ${CORNER_WORDS[s.corner]} corner` : 'Camera bubble'
}

export const FRAMING_TITLE = 'Camera framed on your face'
export const DIRECTOR_DETAIL = 'Camera director'

/** The kind a record is listed as. */
export function cutKind(cut: Pick<AutoCut, 'by'>): ReviewKind {
  if (cut.by === 'silences' || cut.by === 'polish') return 'silence'
  if (cut.by === 'smart-speed') return 'idle'
  return 'words'
}

/** Seconds of footage a record changed, "2.4 s". */
export function cutSeconds(cut: Pick<AutoCut, 'was'>): string {
  const total = cut.was.reduce((s, p) => s + Math.max(0, p.end - p.start), 0)
  return `${total.toFixed(1)} s`
}

export function cutTitle(cut: AutoCut): string {
  const kind = cutKind(cut)
  if (kind === 'words') {
    const said = `“${cut.words ?? '…'}”`
    if (cut.by === 'retake') return `Removed a retake: ${said}`
    if (cut.by === 'repeat') return `Removed a repeat: ${said}`
    return `Removed ${said}`
  }
  const what = kind === 'silence' ? 'silence' : 'idle time'
  return cut.action === 'cut' ? `Cut ${cutSeconds(cut)} of ${what}` : `Sped up ${cutSeconds(cut)} of ${what} ${cut.action}×`
}

const CUT_DETAILS: Record<AutoCut['by'], string> = {
  silences: 'Remove silences',
  polish: 'Polish',
  'smart-speed': 'Smart speed',
  filler: 'Filler',
  retake: 'Retake',
  repeat: 'Repeat'
}

export const cutDetail = (cut: Pick<AutoCut, 'by'>): string => CUT_DETAILS[cut.by]

/** "12 of 40 reviewed". */
export const progressText = (reviewed: number, total: number): string => `${reviewed} of ${total} reviewed`

/** What a screen reader says for a row: "Cut 2.4 s of silence, silence, at 0:12.4, not reviewed". */
export function itemAccessibleName(item: { title: string; kind: ReviewKind }, time: string, status: ReviewStatus): string {
  return `${item.title}, ${KIND_WORDS[item.kind].name}, at ${time}, ${STATUS_WORDS[status]}`
}

/** The live message after one Keep or Remove: "Kept. 13 of 40 reviewed." */
export function actedMessage(action: 'keep' | 'remove', reviewed: number, total: number): string {
  return `${action === 'keep' ? 'Kept' : 'Removed'}. ${progressText(reviewed, total)}.`
}

/** The live message after Keep all or Remove all: "Kept 26 changes.", "Removed 5 zooms." */
export function bulkMessage(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  if (action === 'keep') return `Kept ${count} ${count === 1 ? 'change' : 'changes'}.`
  const k = kind ? KIND_WORDS[kind] : null
  const noun = count === 1 ? (k?.one ?? 'change') : (k?.plural ?? 'changes')
  return `Removed ${count} ${noun}.`
}

/** The Review button's accessible name. */
export const buttonLabel = (pending: number): string => (pending > 0 ? `${REVIEW_TITLE}, ${pending} to review` : `${REVIEW_TITLE}, nothing to review`)
