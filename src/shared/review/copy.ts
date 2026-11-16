/**
 * The words of Review mode (docs/design/review-mode.md §4.2, §4.3, §5): item titles, kind names,
 * statuses, progress and the live messages. Pure. The words are messages of the review namespace
 * (docs/design/output-and-languages.md §9.1): tables hold their keys, and the text is made where it
 * is shown.
 */
import type { AutoCut, CameraLayout, Corner, LayoutSegment, ZoomSegment } from '../types'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'

/**
 * Review mode's own kinds, then Captions Studio's (docs/design/captions-studio.md §11.8): the look,
 * the automatic emphasis and the text fixes (one group row each), emoji, the other graphics and
 * title cards, and bleeps; then editing polish's (docs/design/editing-polish.md §11): Polish's cut
 * style and Auto colour; then smart tools' (docs/design/smart-tools.md §13.1): found chapters and
 * the shorter version's cuts.
 */
export type ReviewKind = 'zoom' | 'camera' | 'silence' | 'idle' | 'words' | 'style' | 'emphasis' | 'text' | 'emoji' | 'graphic' | 'bleep' | 'join' | 'colour' | 'chapter' | 'short'
export type ReviewStatus = 'pending' | 'kept' | 'removed'

/** Kinds in the order items at the same time are listed (Captions Studio's after the others). */
export const REVIEW_KINDS: readonly ReviewKind[] = ['camera', 'zoom', 'silence', 'idle', 'words', 'style', 'emphasis', 'text', 'emoji', 'graphic', 'bleep', 'join', 'colour', 'chapter', 'short']

/** A kind's words, as message keys: its chip, its name in a sentence, its "Remove all …" and its count ("5 zooms", a plural). */
export interface KindKeys {
  chip: MessageKey
  name: MessageKey
  all: MessageKey
  count: MessageKey
}

const kindKeys = (k: ReviewKind): KindKeys => ({ chip: `review.kind.${k}.chip`, name: `review.kind.${k}.name`, all: `review.kind.${k}.all`, count: `review.kind.${k}.count` })

/**
 * Each kind's words (§9.1: a table holds keys). Emphasis and text fixes are one group row each:
 * their Remove is the same as Remove all of the kind. Graphics are Captions Studio's pop-ups,
 * counters, list cards and the title cards made from captions; join is Polish's Smooth cuts step,
 * colour Auto colour on the camera; chapter and short are smart tools' found chapters and Make a
 * shorter version's cuts.
 */
export const KIND_WORDS: Readonly<Record<ReviewKind, KindKeys>> = Object.fromEntries(REVIEW_KINDS.map((k) => [k, kindKeys(k)])) as Record<ReviewKind, KindKeys>

/** A kind's chip: "Zoom". */
export const kindChip = (kind: ReviewKind): string => t(KIND_WORDS[kind].chip)
/** A kind's name in a sentence: "idle time". */
export const kindName = (kind: ReviewKind): string => t(KIND_WORDS[kind].name)
/** A kind's Remove all: "Remove all zooms". */
export const kindAll = (kind: ReviewKind): string => t(KIND_WORDS[kind].all)
/** A count of a kind: "1 zoom", "5 zooms". */
export const kindCount = (kind: ReviewKind, count: number): string => t(KIND_WORDS[kind].count, { count, n: fmt.count(count) })
/** A count of changes of any kind: "1 change", "26 changes". */
const changesCount = (count: number): string => t('review.changes', { count, n: fmt.count(count) })

const STATUS_WORDS: Record<ReviewStatus, MessageKey> = { pending: 'review.status.pending', kept: 'review.status.kept', removed: 'review.status.removed' }
/** A status as a row says it: "not reviewed", "kept", "removed". */
export const statusWord = (status: ReviewStatus): string => t(STATUS_WORDS[status])

export const reviewTitle = (): string => t('review.title')
export const reviewEmpty = (): string => t('review.empty')
export const reviewHint = (): string => t('review.hint')

/** Where a normalised point is, in thirds of the frame, by row then column. */
const PLACES: readonly (readonly MessageKey[])[] = [
  ['review.place.topLeft', 'review.place.top', 'review.place.topRight'],
  ['review.place.left', 'review.place.middle', 'review.place.right'],
  ['review.place.bottomLeft', 'review.place.bottom', 'review.place.bottomRight']
]

/** Where a normalised point is, in thirds of the frame: "top left" … "middle" … "bottom right". */
export function placeOf(x: number, y: number): string {
  const col = x < 1 / 3 ? 0 : x > 2 / 3 ? 2 : 1
  const row = y < 1 / 3 ? 0 : y > 2 / 3 ? 2 : 1
  return t(PLACES[row][col])
}

/** The point a zoom aims at: its click or typing anchor, else a fixed point, else a region's centre; null when it follows the cursor. */
function zoomPoint(z: ZoomSegment): { x: number; y: number } | null {
  if (z.anchor) return z.anchor
  if (z.focus.mode === 'fixed') return z.focus
  if (z.focus.mode === 'region') return { x: z.focus.x + z.focus.w / 2, y: z.focus.y + z.focus.h / 2 }
  return null
}

export function zoomTitle(z: ZoomSegment): string {
  if (z.scale < 1) return t('review.zoom.pullBack')
  const at = zoomPoint(z)
  const place = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? placeOf(at.x, at.y) : null
  if (z.anchor && typeof z.anchor.until === 'number') return place ? t('review.zoom.typingAt', { place }) : t('review.zoom.typing')
  if (z.anchor) return place ? t('review.zoom.clickAt', { place }) : t('review.zoom.click')
  return place ? t('review.zoom.inAt', { place }) : t('review.zoom.in')
}

export const zoomDetail = (z: ZoomSegment): string => fmt.factor(z.scale)

const CORNER_TITLES: Record<Corner, MessageKey> = {
  'top-left': 'review.layout.corner.topLeft',
  'top-right': 'review.layout.corner.topRight',
  'bottom-left': 'review.layout.corner.bottomLeft',
  'bottom-right': 'review.layout.corner.bottomRight'
}
const LAYOUT_TITLES: Record<Exclude<CameraLayout, 'default'>, MessageKey> = {
  'camera-only': 'review.layout.cameraOnly',
  'camera-large': 'review.layout.cameraLarge',
  'side-by-side': 'review.layout.sideBySide',
  'screen-only': 'review.layout.screenOnly'
}

export function layoutTitle(s: Pick<LayoutSegment, 'layout' | 'corner'>): string {
  if (s.layout !== 'default') return t(LAYOUT_TITLES[s.layout])
  return s.corner ? t(CORNER_TITLES[s.corner]) : t('review.layout.bubble')
}

/**
 * The framing row's title and the camera rows' detail, in English: review.ts, which lists the rows,
 * reads these constants (no extraction part owns it). framingTitle() and directorDetail() give the
 * same words in the UI language.
 */
export const FRAMING_TITLE = 'Camera framed on your face'
export const DIRECTOR_DETAIL = 'Camera director'
export const framingTitle = (): string => t('review.framing.title')
export const directorDetail = (): string => t('review.framing.detail')

/** The kind a record is listed as. */
export function cutKind(cut: Pick<AutoCut, 'by'>): ReviewKind {
  if (cut.by === 'silences' || cut.by === 'polish') return 'silence'
  if (cut.by === 'smart-speed') return 'idle'
  // Make a shorter version (smart-tools.md §13.1).
  if (cut.by === 'short') return 'short'
  return 'words'
}

/** Seconds of footage a record changed, "2.4 s". */
export function cutSeconds(cut: Pick<AutoCut, 'was'>): string {
  const total = cut.was.reduce((s, p) => s + Math.max(0, p.end - p.start), 0)
  return `${fmt.number(total, { max: 1 })} s`
}

export function cutTitle(cut: AutoCut): string {
  const kind = cutKind(cut)
  if (kind === 'words') {
    const said = cut.words ?? '…'
    if (cut.by === 'retake') return t('review.cut.retake', { said })
    if (cut.by === 'repeat') return t('review.cut.repeat', { said })
    return t('review.cut.words', { said })
  }
  const seconds = cutSeconds(cut)
  if (kind === 'short') return t('review.cut.short', { seconds })
  if (cut.action === 'cut') return t(kind === 'silence' ? 'review.cut.silence' : 'review.cut.idle', { seconds })
  return t(kind === 'silence' ? 'review.sped.silence' : 'review.sped.idle', { seconds, factor: fmt.number(cut.action) })
}

/** The tool that made each kind of record, as message keys. */
export const CUT_DETAILS: Record<AutoCut['by'], MessageKey> = {
  silences: 'review.cutBy.silences',
  polish: 'review.cutBy.polish',
  'smart-speed': 'review.cutBy.smartSpeed',
  filler: 'review.cutBy.filler',
  retake: 'review.cutBy.retake',
  repeat: 'review.cutBy.repeat',
  short: 'review.cutBy.short'
}

export const cutDetail = (cut: Pick<AutoCut, 'by'>): string => t(CUT_DETAILS[cut.by])

/** "12 of 40 reviewed". */
export const progressText = (reviewed: number, total: number): string => t('review.progress', { reviewed: fmt.count(reviewed), total: fmt.count(total) })

/**
 * What a screen reader says for a row, everything the row shows in its order: "Cut 2.4 s of
 * silence, silence, at 0:12.4, Polish, not reviewed", "Zoom in on a click, top right, zoom, at 0:02.0, 2×, kept".
 */
export function itemAccessibleName(item: { title: string; kind: ReviewKind; detail: string }, time: string, status: ReviewStatus): string {
  return t('review.row.name', { title: item.title, kind: kindName(item.kind), time, detail: item.detail, status: statusWord(status) })
}

/** The live message after one Keep or Remove: "Kept. 13 of 40 reviewed." */
export function actedMessage(action: 'keep' | 'remove', reviewed: number, total: number): string {
  return t(action === 'keep' ? 'review.acted.keep' : 'review.acted.remove', { reviewed: fmt.count(reviewed), total: fmt.count(total) })
}

/** The live message after Keep all or Remove all: "Kept 26 changes.", "Removed 5 zooms." */
export function bulkMessage(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  if (action === 'keep') return t('review.bulk.kept', { things: changesCount(count) })
  return t('review.bulk.removed', { things: kind ? kindCount(kind, count) : changesCount(count) })
}

/** "8098 changes", "5399 silence cuts": what Keep all or Remove all works on. */
function workNoun(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  return action === 'remove' && kind ? kindCount(kind, count) : changesCount(count)
}

/** What waits while Keep all or Remove all works on a long list, and what stops it, said as it starts (§4.3). */
export const busyRule = (): string => t('review.busy.rule')

/**
 * The live message as Keep all or Remove all starts on a long list, before the work (§4.3), with
 * what waits for it: "Keeping 8098 changes… Keep, Remove, Undo and Redo wait until it is done."
 */
export function busyMessage(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  return t(action === 'keep' ? 'review.busy.keeping' : 'review.busy.removing', { things: workNoun(action, count, kind), rule: busyRule() })
}

/** Said when Keep all or Remove all is pressed while one works: "Still removing 5399 silence cuts…". */
export function stillBusyMessage(action: 'keep' | 'remove', count: number, kind?: ReviewKind): string {
  return t(action === 'keep' ? 'review.stillBusy.keeping' : 'review.stillBusy.removing', { things: workNoun(action, count, kind) })
}

const WAIT: Record<'keep' | 'remove', Record<'keep' | 'remove', MessageKey>> = {
  keep: { keep: 'review.wait.keepDuringKeepAll', remove: 'review.wait.keepDuringRemoveAll' },
  remove: { keep: 'review.wait.removeDuringKeepAll', remove: 'review.wait.removeDuringRemoveAll' }
}

/** Said when a row's Keep or Remove is pressed while Keep all or Remove all works: "Keep waits until Remove all is done." */
export function waitMessage(action: 'keep' | 'remove', busy: 'keep' | 'remove'): string {
  return t(WAIT[action][busy])
}

/**
 * Said when a Keep or Remove that waited finds its row reviewed meanwhile (by the Keep all or
 * Remove all it waited for): "Not kept: already removed.", "Already removed."
 */
export function staleMessage(action: 'keep' | 'remove', status: Exclude<ReviewStatus, 'pending'>): string {
  if (status === 'kept') return t(action === 'keep' ? 'review.stale.alreadyKept' : 'review.stale.notRemoved')
  return t(action === 'remove' ? 'review.stale.alreadyRemoved' : 'review.stale.notKept')
}

/**
 * The editor's notice when closing the panel stopped Keep all or Remove all (§4.3): "Remove all
 * stopped: nothing was removed.", "Keep all stopped: nothing was kept."
 */
export function stoppedMessage(action: 'keep' | 'remove', kind?: ReviewKind): string {
  if (action === 'keep') return t('review.stopped.keepAll')
  return t('review.stopped.removeAll', { action: kind ? kindAll(kind) : t('common.action.removeAll') })
}

/** What a footer button reads while it works. */
export const BUSY_WORDS: Readonly<Record<'keep' | 'remove', MessageKey>> = { keep: 'review.busyWord.keep', remove: 'review.busyWord.remove' }
export const busyWord = (action: 'keep' | 'remove'): string => t(BUSY_WORDS[action])

/** The Review button's accessible name. */
export const buttonLabel = (pending: number): string => (pending > 0 ? t('review.button.pending', { n: fmt.count(pending) }) : t('review.button.none'))
