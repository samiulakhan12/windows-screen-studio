/**
 * The words of Review mode (docs/design/review-mode.md §4.2, §4.3, §5): item titles, kind names,
 * statuses, progress and the live messages. Pure.
 */
import type { AutoCut, CameraLayout, Corner, LayoutSegment, ZoomSegment } from '../types'
import { formatLevel } from '../editor/zoomEdit'

/**
 * Review mode's own kinds, then Captions Studio's (docs/design/captions-studio.md §11.8): the look,
 * the automatic emphasis and the text fixes (one group row each), emoji, the other graphics and
 * title cards, and bleeps.
 */
export type ReviewKind = 'zoom' | 'camera' | 'silence' | 'idle' | 'words' | 'style' | 'emphasis' | 'text' | 'emoji' | 'graphic' | 'bleep'
export type ReviewStatus = 'pending' | 'kept' | 'removed'

/** Kinds in the order items at the same time are listed (Captions Studio's after the others). */
export const REVIEW_KINDS: readonly ReviewKind[] = ['camera', 'zoom', 'silence', 'idle', 'words', 'style', 'emphasis', 'text', 'emoji', 'graphic', 'bleep']

/** Each kind's chip, its name in a sentence, and its plural on "Remove all …". */
export const KIND_WORDS: Record<ReviewKind, { chip: string; name: string; all: string; one: string; plural: string }> = {
  zoom: { chip: 'Zoom', name: 'zoom', all: 'Remove all zooms', one: 'zoom', plural: 'zooms' },
  camera: { chip: 'Camera', name: 'camera', all: 'Remove all camera changes', one: 'camera change', plural: 'camera changes' },
  silence: { chip: 'Silence', name: 'silence', all: 'Remove all silence cuts', one: 'silence cut', plural: 'silence cuts' },
  idle: { chip: 'Idle', name: 'idle time', all: 'Remove all idle-time changes', one: 'idle-time change', plural: 'idle-time changes' },
  words: { chip: 'Words', name: 'words', all: 'Remove all word cuts', one: 'word cut', plural: 'word cuts' },
  style: { chip: 'Style', name: 'caption style', all: 'Remove all caption style changes', one: 'caption style change', plural: 'caption style changes' },
  // One group row each: its Remove is the same as Remove all of the kind.
  emphasis: { chip: 'Emphasis', name: 'emphasis', all: 'Remove all emphasis', one: 'emphasis', plural: 'emphasis' },
  text: { chip: 'Text', name: 'text fixes', all: 'Remove all text fixes', one: 'text fix', plural: 'text fixes' },
  emoji: { chip: 'Emoji', name: 'emoji', all: 'Remove all emoji', one: 'emoji', plural: 'emoji' },
  graphic: { chip: 'Pop-up', name: 'pop-up', all: 'Remove all pop-ups', one: 'pop-up', plural: 'pop-ups' },
  bleep: { chip: 'Bleep', name: 'bleep', all: 'Remove all bleeps', one: 'bleep', plural: 'bleeps' }
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

/**
 * What a screen reader says for a row, everything the row shows in its order: "Cut 2.4 s of
 * silence, silence, at 0:12.4, Polish, not reviewed", "Zoom in on a click, top right, zoom, at 0:02.0, 2×, kept".
 */
export function itemAccessibleName(item: { title: string; kind: ReviewKind; detail: string }, time: string, status: ReviewStatus): string {
  return `${item.title}, ${KIND_WORDS[item.kind].name}, at ${time}, ${item.detail}, ${STATUS_WORDS[status]}`
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

/** "8098 changes", "5399 silence cuts": what Keep all or Remove all works on. */
function workNoun(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  const k = action === 'remove' && kind ? KIND_WORDS[kind] : null
  return `${count} ${count === 1 ? (k?.one ?? 'change') : (k?.plural ?? 'changes')}`
}

/** What waits while Keep all or Remove all works on a long list, and what stops it, said as it starts (§4.3). */
export const BUSY_RULE = 'Keep, Remove, Undo and Redo wait until it is done. Closing the panel stops it.'

/**
 * The live message as Keep all or Remove all starts on a long list, before the work (§4.3), with
 * what waits for it: "Keeping 8098 changes… Keep, Remove, Undo and Redo wait until it is done."
 */
export function busyMessage(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  return `${action === 'keep' ? 'Keeping' : 'Removing'} ${workNoun(action, count, kind)}… ${BUSY_RULE}`
}

/** Said when Keep all or Remove all is pressed while one works: "Still removing 5399 silence cuts…". */
export function stillBusyMessage(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  return `Still ${action === 'keep' ? 'keeping' : 'removing'} ${workNoun(action, count, kind)}…`
}

/** Said when a row's Keep or Remove is pressed while Keep all or Remove all works: "Keep waits until Remove all is done." */
export function waitMessage(action: 'keep' | 'remove', busy: 'keep' | 'remove'): string {
  return `${action === 'keep' ? 'Keep' : 'Remove'} waits until ${busy === 'keep' ? 'Keep all' : 'Remove all'} is done.`
}

/**
 * Said when a Keep or Remove that waited finds its row reviewed meanwhile (by the Keep all or
 * Remove all it waited for): "Not kept: already removed.", "Already removed."
 */
export function staleMessage(action: 'keep' | 'remove', status: Exclude<ReviewStatus, 'pending'>): string {
  const did = action === 'keep' ? 'kept' : 'removed'
  return did === status ? `Already ${status}.` : `Not ${did}: already ${status}.`
}

/**
 * The editor's notice when closing the panel stopped Keep all or Remove all (§4.3): "Remove all
 * stopped: nothing was removed.", "Keep all stopped: nothing was kept."
 */
export function stoppedMessage(action: 'keep' | 'remove', kind?: ReviewKind): string {
  if (action === 'keep') return 'Keep all stopped: nothing was kept.'
  return `${kind ? KIND_WORDS[kind].all : 'Remove all'} stopped: nothing was removed.`
}

/** What a footer button reads while it works. */
export const BUSY_WORDS = { keep: 'Keeping…', remove: 'Removing…' } as const

/** The Review button's accessible name. */
export const buttonLabel = (pending: number): string => (pending > 0 ? `${REVIEW_TITLE}, ${pending} to review` : `${REVIEW_TITLE}, nothing to review`)
