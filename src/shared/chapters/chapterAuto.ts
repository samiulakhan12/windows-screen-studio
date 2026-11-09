/**
 * Applying found chapters, settling them and Polish's step (docs/design/smart-tools.md §7.7, §13.3).
 * Found chapters carry `auto` (ChapterOrigin) until the user keeps or edits them; a run replaces
 * the chapters the run before it found that are still pending, and the chapter-title cards
 * Captions Studio made from them while those are pending. Pure.
 */
import type { SceneScan } from '../api/projects'
import type { PolishInput } from '../editor/polish'
import { createChapter } from '../editor/titles'
import { effectiveTrack } from '../engine/inputTrack'
import type { Chapter, ChapterOrigin, Project, TitleCard } from '../types'
import { chapterNames } from './names'
import { userChapters } from './pending'
import { planChapters } from './plan'

/** A found chapter found again this close (s), with the same title and origin, stays the same chapter. */
const SAME_PLACE = 0.05

/** Whether two origins say the same. */
export function sameOrigin(a: ChapterOrigin | undefined, b: ChapterOrigin | undefined): boolean {
  if (!a || !b) return a === b
  return a.by === b.by && a.name === b.name && a.via === b.via && a.host === b.host && a.from.length === b.from.length && a.from.every((s, i) => s === b.from[i])
}

/** `titles` without the pending chapter-title cards Captions Studio made from the chapters `ids`; the same array when there are none. */
function withoutCardsOf(titles: TitleCard[] | undefined, ids: ReadonlySet<string>): TitleCard[] | undefined {
  if (!titles?.length || !ids.size) return titles
  const kept = titles.filter((c) => !(c.auto?.by === 'chapter' && c.auto.chapter !== undefined && ids.has(c.auto.chapter)))
  return kept.length === titles.length ? titles : kept
}

/** `project` without the chapters `ids` and the pending chapter-title cards made from them; itself when nothing goes. */
export function withoutChapters(project: Project, ids: ReadonlySet<string>): Project {
  const chapters = project.chapters ?? []
  if (!ids.size || !chapters.some((c) => ids.has(c.id))) return project
  const titles = withoutCardsOf(project.titles, ids)
  return { ...project, chapters: chapters.filter((c) => !ids.has(c.id)), ...(titles !== project.titles ? { titles } : {}) }
}

/**
 * `project` with the found chapters `found` in place of its pending ones (§7.7), in one update:
 * pending found chapters not found again go, with the pending chapter-title cards made from them;
 * each new one is added with a new id and its origin. A chapter found again within 0.05 s of a
 * pending one with the same title and an equal origin keeps that chapter object (its id and
 * `auto`), so a second identical run returns `project` itself. The user's chapters stay.
 */
export function withFoundChapters(project: Project, found: readonly { t: number; title: string; origin: ChapterOrigin }[]): Project {
  const chapters = project.chapters ?? []
  const pending = chapters.filter((c) => c.auto)
  const reused = new Set<Chapter>()
  const added: Chapter[] = []
  for (const f of found) {
    if (!Number.isFinite(f.t)) continue
    const again = pending.find((c) => !reused.has(c) && Math.abs(c.t - f.t) <= SAME_PLACE && c.title === f.title && sameOrigin(c.auto, f.origin))
    if (again) reused.add(again)
    else added.push({ ...createChapter(f.t, f.title), auto: { ...f.origin, from: [...f.origin.from] } })
  }
  const gone = new Set(pending.filter((c) => !reused.has(c)).map((c) => c.id))
  if (!gone.size && !added.length) return project
  const without = withoutChapters(project, gone)
  return { ...without, chapters: [...(without.chapters ?? []), ...added] }
}

/** `project` without its pending found chapters and their pending chapter-title cards (Remove all found chapters); itself when there are none. */
export function withoutPendingChapters(project: Project): Project {
  return withoutChapters(project, new Set((project.chapters ?? []).filter((c) => c.auto).map((c) => c.id)))
}

/**
 * The settle chain's step (§7.7): a found chapter whose `t` or `title` changed while its `auto`
 * object stayed the same object was edited by hand, and loses `auto` in the same update: it is the
 * user's. Automation always writes new `auto` objects, so its own updates keep them. `next` itself
 * when nothing applies.
 */
export function settleChapters(next: Project, prev: Project): Project {
  const now = next.chapters
  if (!now?.length || now === prev.chapters || !now.some((c) => c.auto)) return next
  const before = new Map((prev.chapters ?? []).map((c) => [c.id, c]))
  let changed = false
  const chapters = now.map((c) => {
    const was = before.get(c.id)
    if (!c.auto || !was || was.auto !== c.auto || (was.t === c.t && was.title === c.title)) return c
    changed = true
    const { auto: _auto, ...mine } = c
    return mine
  })
  return changed ? { ...next, chapters } : next
}

/**
 * Polish's Find chapters step (§13.3): offline, Normal, every signal, names from what was said,
 * `by: 'polish'`, in Polish's one update. Adds nothing over the user's chapters, without captions,
 * or when every name would be a number ("Part 2, Part 3" never reaches an exported file). Found
 * chapters found again are kept as they are, so polishing twice changes nothing.
 */
export function polishChapters(project: Project, input: PolishInput & { scan: SceneScan | null }): Project {
  if (userChapters(project).length) return project
  if (!project.transcript?.segments.some((s) => s.text.trim())) return project
  const plan = planChapters({
    project,
    track: effectiveTrack(input.recorded, project),
    scan: input.scan,
    speech: input.speech?.ranges ?? null,
    density: 'normal',
    use: { screen: true, pauses: true, words: true }
  })
  if (!plan.ok) return project
  const names = chapterNames(project, plan.starts)
  if (names.every((n) => n.name === 'number')) return project
  return withFoundChapters(
    project,
    plan.starts.map((s, i) => ({ t: s.t, title: names[i].title, origin: { by: 'polish', from: s.from, name: names[i].name } }))
  )
}
