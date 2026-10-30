/**
 * Review mode (E-02, docs/design/review-mode.md): the automatic changes of a project as one list in
 * time order, each one's status derived from the project (so undo and redo need nothing more),
 * and Keep / Remove as pure edits, each one project out (one store.update, one undo step).
 *
 * Kinds: auto zooms (ZoomSegment.auto), the camera director's segments (LayoutSegment.auto) and its
 * face framing (framingIsDirectors), and the recorded automatic cuts and speed-ups
 * (Project.autoCuts, autoCuts.ts). Keeping makes a change the user's, as an edit by hand does;
 * removing puts back what was there before.
 */
import { framingIsDirectors, framingUntouched } from '../engine/directorData'
import type { AutoCut, LayoutSegment, Project } from '../types'
import { byHand, cornerOnly } from '../editor/layouts'
import { autoCutIntact, footageBack, liveAutoCuts, undoAutoCut, withAutoCuts } from './autoCuts'
import {
  cutDetail,
  cutKind,
  cutTitle,
  DIRECTOR_DETAIL,
  FRAMING_TITLE,
  layoutTitle,
  REVIEW_KINDS,
  zoomDetail,
  zoomTitle,
  type ReviewKind,
  type ReviewStatus
} from './copy'

export type { ReviewKind, ReviewStatus } from './copy'

export const FRAMING_KEY = 'camera:framing'

export interface ReviewItem {
  /** 'zoom:<id>', 'camera:<id>', 'camera:framing' or 'cut:<id>'. */
  key: string
  kind: ReviewKind
  /** Source seconds. */
  start: number
  end: number
  title: string
  detail: string
  /** A camera segment as listed (its status compares the layout). */
  segment?: Pick<LayoutSegment, 'id' | 'layout' | 'corner' | 'cutOut'>
  /** A cut or speed-up as listed (its status reads the footage after the record is gone). */
  cut?: AutoCut
}

const EPS = 1e-6
const kindOrder = (k: ReviewKind): number => REVIEW_KINDS.indexOf(k)
const byTime = (a: ReviewItem, b: ReviewItem): number => a.start - b.start || kindOrder(a.kind) - kindOrder(b.kind) || a.key.localeCompare(b.key)

/** Whether the director's face framing is on the webcam now (and changes the picture). */
const directorsFraming = (p: Pick<Project, 'webcam' | 'director'>): boolean => framingIsDirectors(p.webcam, p.director) && !framingUntouched(p.webcam)

/** Every automatic change still automatic in `project`, in time order (pending by construction). */
export function reviewItems(project: Project): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const z of project.zooms) {
    if (z.auto) items.push({ key: `zoom:${z.id}`, kind: 'zoom', start: z.start, end: z.end, title: zoomTitle(z), detail: zoomDetail(z) })
  }
  for (const s of project.layouts ?? []) {
    if (!s.auto) continue
    const segment = { id: s.id, layout: s.layout, ...(s.corner ? { corner: s.corner } : {}), ...(s.cutOut ? { cutOut: true } : {}) }
    items.push({ key: `camera:${s.id}`, kind: 'camera', start: s.start, end: s.end, title: layoutTitle(s), detail: DIRECTOR_DETAIL, segment })
  }
  if (directorsFraming(project)) {
    const at = project.clips[0]?.start ?? 0
    items.push({ key: FRAMING_KEY, kind: 'camera', start: at, end: at, title: FRAMING_TITLE, detail: DIRECTOR_DETAIL })
  }
  for (const c of liveAutoCuts(project)) {
    items.push({ key: `cut:${c.id}`, kind: cutKind(c), start: c.start, end: c.end, title: cutTitle(c), detail: cutDetail(c), cut: c })
  }
  return items.sort(byTime)
}

/** How many automatic changes are waiting for review (the Review button's count). */
export const pendingCount = (project: Project): number => reviewItems(project).length

const idOf = (key: string): string => key.slice(key.indexOf(':') + 1)

/** Whether `item` is still automatic, was kept (now the user's) or removed, read from `project` (§2.3). */
export function reviewStatus(project: Project, item: ReviewItem): ReviewStatus {
  if (item.key === FRAMING_KEY) {
    if (directorsFraming(project)) return 'pending'
    return framingUntouched(project.webcam) ? 'removed' : 'kept'
  }
  const id = idOf(item.key)
  if (item.kind === 'zoom') {
    const z = project.zooms.find((x) => x.id === id)
    return !z ? 'removed' : z.auto ? 'pending' : 'kept'
  }
  if (item.kind === 'camera') {
    const s = (project.layouts ?? []).find((x) => x.id === id)
    if (!s) return 'removed'
    if (s.auto) return 'pending'
    // A removed cut-out turns back into its camera position, which may keep its id; any other
    // segment no longer automatic is the user's, edited or not.
    return item.segment?.cutOut && s.layout === 'default' && item.segment.layout !== 'default' ? 'removed' : 'kept'
  }
  const cut = item.cut
  if (!cut) return 'removed'
  const rec = (project.autoCuts ?? []).find((c) => c.id === id)
  if (rec && autoCutIntact(rec, project.clips)) return 'pending'
  return footageBack(cut, project.clips) ? 'removed' : 'kept'
}

/** Reviewed items of `statuses` and how many in all. */
export function reviewProgress(statuses: readonly ReviewStatus[]): { reviewed: number; total: number } {
  return { reviewed: statuses.filter((s) => s !== 'pending').length, total: statuses.length }
}

/**
 * The panel's list: what it showed (`shown`, kept and removed items stay, marked) plus every item of
 * `current` (pending now) it did not show yet, in time order. A pending item also shown takes its
 * current title (a record's text never changes; a zoom's place could).
 */
export function mergeSnapshot(shown: readonly ReviewItem[], current: readonly ReviewItem[]): ReviewItem[] {
  const now = new Map(current.map((i) => [i.key, i]))
  const keys = new Set(shown.map((i) => i.key))
  const out = shown.map((i) => now.get(i.key) ?? i)
  for (const i of current) if (!keys.has(i.key)) out.push(i)
  return out.sort(byTime)
}

/** The items of `items` still pending in `project`. */
const pendingOf = (project: Project, items: readonly ReviewItem[]): ReviewItem[] => items.filter((i) => reviewStatus(project, i) === 'pending')

/**
 * The project with `items` kept (§2.4): zooms and camera segments no longer automatic (as an edit
 * by hand), the face framing the user's (director.framed dropped), cut records dropped (the cuts
 * stay, as plain cuts). Items not pending are left alone. `project` itself when nothing changes.
 */
export function keepItems(project: Project, items: readonly ReviewItem[]): Project {
  const todo = pendingOf(project, items)
  if (todo.length === 0) return project
  const keys = new Set(todo.map((i) => i.key))
  let next = project
  if (todo.some((i) => i.kind === 'zoom')) next = { ...next, zooms: next.zooms.map((z) => (keys.has(`zoom:${z.id}`) ? { ...z, auto: false } : z)) }
  if (todo.some((i) => i.kind === 'camera' && i.key !== FRAMING_KEY)) {
    next = { ...next, layouts: (next.layouts ?? []).map((s) => (keys.has(`camera:${s.id}`) ? byHand(s) : s)) }
  }
  if (keys.has(FRAMING_KEY) && next.director) {
    const { framed: _framed, ...director } = next.director
    void _framed
    next = { ...next, director }
  }
  if (todo.some((i) => i.cut)) next = withAutoCuts(next, (next.autoCuts ?? []).filter((c) => !keys.has(`cut:${c.id}`)))
  return next
}

/**
 * The project with `items` removed (§2.4): zooms deleted; the director's segments deleted (a
 * cut-out given back to its camera position); the face framing reset; each cut or speed-up taken
 * back (undoAutoCut, latest first) and its record dropped. Items not pending are left alone.
 * `project` itself when nothing changes.
 */
export function removeItems(project: Project, items: readonly ReviewItem[]): Project {
  const todo = pendingOf(project, items)
  if (todo.length === 0) return project
  const keys = new Set(todo.map((i) => i.key))
  let next = project
  if (todo.some((i) => i.kind === 'zoom')) next = { ...next, zooms: next.zooms.filter((z) => !keys.has(`zoom:${z.id}`)) }
  const segIds = todo.filter((i) => i.kind === 'camera' && i.key !== FRAMING_KEY).map((i) => idOf(i.key))
  if (segIds.length) next = { ...next, layouts: withoutSegments(next.layouts ?? [], segIds) }
  if (keys.has(FRAMING_KEY)) {
    const { zoom: _zoom, cropX: _cropX, cropY: _cropY, ...webcam } = next.webcam
    void _zoom
    void _cropX
    void _cropY
    next = { ...next, webcam }
    if (next.director) {
      const { framed: _framed, ...director } = next.director
      void _framed
      next = { ...next, director }
    }
  }
  const cuts = todo.flatMap((i) => (i.cut ? [(next.autoCuts ?? []).find((c) => c.id === i.cut!.id)!] : [])).filter(Boolean)
  if (cuts.length) {
    let clips = next.clips
    for (const c of [...cuts].sort((a, b) => b.start - a.start)) clips = undoAutoCut(clips, c, next.duration)
    const gone = new Set(cuts.map((c) => c.id))
    next = withAutoCuts({ ...next, clips }, (next.autoCuts ?? []).filter((c) => !gone.has(c.id)))
  }
  return next
}

/**
 * `layouts` without the director's segments `ids` (only `auto` ones): each is deleted, except a
 * cut-out (LayoutSegment.cutOut), which turns back into its camera position's corner and joins the
 * position's touching pieces in that corner (the first piece's id stays), as withoutDirected does
 * for the whole track.
 */
export function withoutSegments(layouts: readonly LayoutSegment[], ids: readonly string[]): LayoutSegment[] {
  const drop = new Set(ids)
  const back = new Set<string>()
  const list: LayoutSegment[] = []
  for (const s of [...layouts].sort((a, b) => a.start - b.start)) {
    if (!drop.has(s.id) || !s.auto) list.push(s)
    else if (s.cutOut && s.corner) {
      list.push({ id: s.id, start: s.start, end: s.end, layout: 'default', corner: s.corner })
      back.add(s.id)
    }
  }
  if (back.size === 0) return list
  const member = (s: LayoutSegment): boolean => cornerOnly(s) && !s.auto
  const out: LayoutSegment[] = []
  for (let i = 0; i < list.length; ) {
    let j = i + 1
    if (member(list[i])) {
      while (j < list.length && member(list[j]) && list[j].corner === list[i].corner && Math.abs(list[j].start - list[j - 1].end) <= EPS) j++
    }
    const run = list.slice(i, j)
    if (run.length > 1 && run.some((s) => back.has(s.id))) out.push({ ...run[0], end: run[run.length - 1].end })
    else out.push(...run)
    i = j
  }
  return out
}
