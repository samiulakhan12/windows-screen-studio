/**
 * Review mode (E-02, docs/design/review-mode.md): the automatic changes of a project as one list in
 * time order, each one's status read from the project (so undo and redo need nothing more), and
 * Keep / Remove as pure edits, each one project out (one store.update, one undo step).
 *
 * Kinds: auto zooms (ZoomSegment.auto), the camera director's segments (LayoutSegment.auto) and its
 * face framing (framingIsDirectors), and the recorded automatic cuts and speed-ups
 * (Project.autoCuts, autoCuts.ts). Keeping makes a change the user's, as an edit by hand does;
 * removing puts back what was there before. For a cut or speed-up the choice itself is recorded
 * (Project.autoCutOutcomes) in the same edit, since the footage alone cannot always tell.
 */
import { framingIsDirectors, framingUntouched } from '../engine/directorData'
import type { AutoCut, AutoCutOutcome, LayoutSegment, Project } from '../types'
import { byHand, cornerOnly } from '../editor/layouts'
import { withOutcomes } from './autoCutData'
import { changeGone, finish, liveAutoCuts, staleAmong, takeBackSteps, withAutoCuts, withSpeedUpsKept } from './autoCuts'
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
  /** A cut or speed-up: its record as last listed. */
  cut?: AutoCut
  /**
   * A cut or speed-up whose record went with no choice made (an undo, an edit by hand, a later run):
   * how it read in the first state without its record (mergeSnapshot), kept as a choice is.
   */
  went?: 'kept' | 'removed'
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
  const chosen = outcomesOf(project)
  for (const c of liveAutoCuts(project)) {
    if (!chosen.has(c.id)) items.push({ key: `cut:${c.id}`, kind: cutKind(c), start: c.start, end: c.end, title: cutTitle(c), detail: cutDetail(c), cut: c })
  }
  return items.sort(byTime)
}

/**
 * How many automatic changes are waiting for review (the Review button's count): reviewItems'
 * length, counted without making the rows (their titles) or putting them in order, since it is
 * worked out again on every edit.
 */
export function pendingCount(project: Project): number {
  let n = 0
  for (const z of project.zooms) if (z.auto) n++
  for (const s of project.layouts ?? []) if (s.auto) n++
  if (directorsFraming(project)) n++
  const chosen = outcomesOf(project)
  for (const c of liveAutoCuts(project)) if (!chosen.has(c.id)) n++
  return n
}

const idOf = (key: string): string => key.slice(key.indexOf(':') + 1)

const recordMemo = new WeakMap<readonly AutoCut[], Map<string, AutoCut>>()
/** The records by id, the first for an id (worked out once for each list). */
function recordsById(records: readonly AutoCut[]): ReadonlyMap<string, AutoCut> {
  let byId = recordMemo.get(records)
  if (!byId) {
    byId = new Map()
    for (const c of records) if (!byId.has(c.id)) byId.set(c.id, c)
    recordMemo.set(records, byId)
  }
  return byId
}

const NO_OUTCOMES: ReadonlyMap<string, AutoCutOutcome['outcome']> = new Map()
const outcomeMemo = new WeakMap<readonly AutoCutOutcome[], Map<string, AutoCutOutcome['outcome']>>()
/** The choices made in the panel for cuts and speed-ups, by record id (worked out once for each list). */
function outcomesOf(project: Pick<Project, 'autoCutOutcomes'>): ReadonlyMap<string, AutoCutOutcome['outcome']> {
  const list = project.autoCutOutcomes
  if (!list?.length) return NO_OUTCOMES
  let byId = outcomeMemo.get(list)
  if (!byId) outcomeMemo.set(list, (byId = new Map(list.map((o) => [o.id, o.outcome]))))
  return byId
}

/**
 * Whether `item` is still automatic, was kept (now the user's) or removed, read from `project`
 * (§2.3). A cut or speed-up: the choice made for it in the panel (Project.autoCutOutcomes); else
 * pending while its record is there and intact; else (it went with no choice made: an undo, an
 * edit by hand, a later tool run) how it read in the first state without its record (`went`, set by
 * mergeSnapshot), else in `project`: removed when its change is gone from the video (changeGone),
 * kept otherwise.
 */
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
  const chosen = outcomesOf(project).get(cut.id)
  if (chosen) return chosen
  // Looked up by id, and judged once for all the rows of a state (staleAmong): a long recording
  // has thousands of rows, read again on every change.
  const records = project.autoCuts ?? []
  const rec = recordsById(records).get(cut.id)
  if (rec && !staleAmong(records, project.clips).has(rec)) return 'pending'
  return item.went ?? (changeGone(cut, project.clips) ? 'removed' : 'kept')
}

/** Reviewed items of `statuses` and how many in all. */
export function reviewProgress(statuses: readonly ReviewStatus[]): { reviewed: number; total: number } {
  return { reviewed: statuses.filter((s) => s !== 'pending').length, total: statuses.length }
}

/**
 * The panel's list in `project`: what it showed (`shown`; kept and removed items stay, marked) plus
 * every item pending now that it did not show yet, in time order. A pending item also shown takes its
 * current version (a zoom's place could change; a record's pieces could, when a speed-up around it
 * was removed). A cut or speed-up whose record is gone from `project` with no choice made gets how it
 * reads there (`went`) and keeps it until its record comes back (undo, redo): a later run over the
 * same footage (Polish undone and run again), an edit by hand or another row's Keep or Remove leaves
 * that row as it read when its record went, as they leave a choice. The panel calls this on every
 * state the project takes while it is open; a record leaves the project only once the edit settles
 * (a drag's moves keep it), so the reading is the settled one.
 */
export function mergeSnapshot(shown: readonly ReviewItem[], project: Project): ReviewItem[] {
  const current = reviewItems(project)
  const now = new Map(current.map((i) => [i.key, i]))
  const keys = new Set(shown.map((i) => i.key))
  let records: ReadonlySet<string> | null = null
  const went = (i: ReviewItem): ReviewItem => {
    if (!i.cut || i.went || outcomesOf(project).has(i.cut.id)) return i
    records ??= new Set((project.autoCuts ?? []).map((c) => c.id))
    return records.has(i.cut.id) ? i : { ...i, went: changeGone(i.cut, project.clips) ? 'removed' : 'kept' }
  }
  const out = shown.map((i) => now.get(i.key) ?? went(i))
  for (const i of current) if (!keys.has(i.key)) out.push(i)
  return out.sort(byTime)
}

/** The items of `items` still pending in `project`. */
const pendingOf = (project: Project, items: readonly ReviewItem[]): ReviewItem[] => items.filter((i) => reviewStatus(project, i) === 'pending')

/**
 * The project with `items` kept (§2.4): zooms and camera segments no longer automatic (as an edit
 * by hand), the face framing the user's (director.framed dropped), cut records dropped (the cuts
 * stay, as plain cuts; a speed-up kept inside another one makes that part of the other the user's,
 * withSpeedUpsKept) and each recorded as kept (withChoices). Items not pending are left alone.
 * `project` itself when nothing changes.
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
  if (todo.some((i) => i.cut)) {
    // All at once (one pass over the records for each level outward, not one for each kept).
    let list = next.autoCuts ?? []
    list = withSpeedUpsKept(list, list.filter((c) => keys.has(`cut:${c.id}`)))
    next = withChoices(withAutoCuts(next, list.filter((c) => !keys.has(`cut:${c.id}`) && c.was.length > 0)), todo, 'kept')
  }
  return next
}

/**
 * The project with `items` removed (§2.4): zooms deleted; the director's segments deleted (a
 * cut-out given back to its camera position); the face framing reset; each cut or speed-up taken
 * back (takeBack: undoAutoCut, latest first), its record dropped and the choice recorded
 * (withChoices). A speed-up taken back leaves the records inside it holding their footage at its
 * speed from before (withoutSpeedUp), so removing a cut inside it later, in any order, never brings
 * the footage back at the removed speed. A piece of a cut too short to come back alone comes back
 * with its neighbours of the same Remove all, joins a clip it touches, or goes to a cut still to
 * review next to it (takeBack, §4.1). Items not pending are left alone. `project` itself when
 * nothing changes.
 */
export function removeItems(project: Project, items: readonly ReviewItem[]): Project {
  return finish(removeSteps(project, items))
}

/**
 * removeItems one cut or speed-up at a time (takeBackSteps): it yields after each one it takes back
 * and gives the same project at the end, so the panel's Remove all over thousands of them can be
 * spread over several tasks and still be one store.update (one undo step).
 */
export function* removeSteps(project: Project, items: readonly ReviewItem[]): Generator<void, Project, undefined> {
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
  const ids = todo.flatMap((i) => (i.cut ? [i.cut.id] : []))
  if (ids.some((id) => (next.autoCuts ?? []).some((c) => c.id === id))) {
    const from = next
    const chosen = outcomesOf(from)
    let listed: ReadonlySet<string> | null = null
    // A piece too short to come back alone goes to a cut still to review next to it.
    const heir = (c: AutoCut): boolean => !chosen.has(c.id) && (listed ??= new Set(liveAutoCuts(from).map((x) => x.id))).has(c.id)
    const { clips, list } = yield* takeBackSteps(from.clips, from.autoCuts ?? [], ids, from.duration, heir)
    next = withChoices(withAutoCuts({ ...from, clips }, list), todo, 'removed')
  }
  return next
}

/** `project` with `outcome` recorded for each cut or speed-up of `items` (Project.autoCutOutcomes). */
function withChoices(project: Project, items: readonly ReviewItem[], outcome: AutoCutOutcome['outcome']): Project {
  const chosen = items.flatMap((i) => (i.cut ? [{ id: i.cut.id, outcome }] : []))
  return chosen.length ? { ...project, autoCutOutcomes: withOutcomes(project.autoCutOutcomes ?? [], chosen) } : project
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
