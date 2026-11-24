/**
 * Review's private rows (docs/design/auto-blur.md §2.7, §14.3): one row per group of found covers or
 * private bleeps still waiting, with its places (one per cover, when there are several) as `parts`.
 * Each row's status is read from the project through privacyIndex (§13.1), so undo and redo need
 * nothing more. Keep covered and Uncover go through part P1's cover edits (keepCovers,
 * deleteCovers: Uncover writes each suggestion's path to privacy.rejected in the same update). The
 * screen's text is never in a row: its title is the kind's title and its times, its detail where it
 * is on screen. Pure.
 *
 * Keys: a row is `private:<kind>:<group>`; a place `private:<kind>:<group>:c:<cover id>`. The kind
 * is in the key so a row keeps it after its covers are gone (the kind filter, the kind's sentences).
 */
import { deleteCovers, keepCovers } from '../editor/coverEdit'
import { planOf } from '../engine/freeze'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'
import { kindTitle } from '../privacy/copy'
import { isPrivateBleep, privateKindOf } from '../privacy/coverData'
import { boxAt, pathKeys } from '../privacy/coverPath'
import { placeOf, privacyIndex } from '../privacy/covers'
import { isPrivateKind, PRIVATE_KINDS } from '../privacy/kinds'
import type { Bleep, Cover, NormRect, PrivateKind, Project } from '../types'
import type { ReviewItem, ReviewStatus } from './review'
import { rowTimes } from './times'

const PREFIX = 'private:'

/** What a private row's or place's key names. */
export interface PrivateKey {
  kind: PrivateKind
  group: string
  /** A place: its cover's id; absent for a row. */
  cover?: string
}

/** A row's key. */
export const privateRowKey = (kind: PrivateKind, group: string): string => `${PREFIX}${kind}:${group}`
/** A place's key (one cover of a row). */
export const privatePartKey = (kind: PrivateKind, group: string, coverId: string): string => `${privateRowKey(kind, group)}:c:${coverId}`

/** The kind, group and (for a place) cover a key names, or null for any other key. */
export function parsePrivateKey(key: string): PrivateKey | null {
  if (!key.startsWith(PREFIX)) return null
  const parts = key.slice(PREFIX.length).split(':')
  const [kind, group] = parts
  if (!isPrivateKind(kind) || !group) return null
  if (parts.length === 2) return { kind, group }
  if (parts.length === 4 && parts[2] === 'c' && parts[3]) return { kind, group, cover: parts[3] }
  return null
}

const NO_COVERS: readonly Cover[] = Object.freeze([])
const NO_BLEEPS: readonly Bleep[] = Object.freeze([])

/** The covers by id, made once for each covers array. */
const coverMaps = new WeakMap<readonly Cover[], Map<string, Cover>>()
function coversById(project: Pick<Project, 'covers'>): ReadonlyMap<string, Cover> {
  const list = project.covers ?? NO_COVERS
  let map = coverMaps.get(list)
  if (!map) {
    map = new Map(list.map((c) => [c.id, c]))
    coverMaps.set(list, map)
  }
  return map
}

/** The bleeps by id, made once for each bleeps array. */
const bleepMaps = new WeakMap<readonly Bleep[], Map<string, Bleep>>()
function bleepsById(project: Pick<Project, 'bleeps'>): ReadonlyMap<string, Bleep> {
  const list = project.bleeps ?? NO_BLEEPS
  let map = bleepMaps.get(list)
  if (!map) {
    map = new Map(list.map((b) => [b.id, b]))
    bleepMaps.set(list, map)
  }
  return map
}

interface GroupNow {
  covers: Cover[]
  bleeps: Bleep[]
  waiting: boolean
  check: boolean
}

/** A group's covers (in start order) and private bleeps as the project holds them now. */
function groupOf(project: Pick<Project, 'covers' | 'bleeps'>, group: string): GroupNow | null {
  const entry = privacyIndex(project).group(group)
  if (!entry) return null
  const byId = coversById(project)
  const bleepById = bleepsById(project)
  const covers = entry.covers.map((id) => byId.get(id)).filter((c): c is Cover => !!c)
  covers.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
  const bleeps = entry.bleeps.map((id) => bleepById.get(id)).filter((b): b is Bleep => !!b)
  return { covers, bleeps, waiting: entry.waiting, check: entry.check }
}

/** The kind a group hides: its first cover's, else its first private bleep's. */
function kindOfGroup(covers: readonly Cover[], bleeps: readonly Bleep[]): PrivateKind | null {
  for (const c of covers) if (c.kind) return c.kind
  for (const b of bleeps) {
    const k = privateKindOf(b)
    if (k) return k
  }
  return null
}

/** A cover's first box (at its start). */
const firstBox = (c: Cover): NormRect | null => boxAt(c, c.start)

/** "Top right of the screen": where a box's middle is, in thirds. */
const whereOf = (box: NormRect): string => t('privacy.review.where', { place: placeOf(box) })

/** The largest share of the screen a cover's boxes cover, 0..1. */
function largestShare(c: Cover): number {
  let most = 0
  for (const k of pathKeys(c)) most = Math.max(most, Math.max(0, Math.min(1, k.w)) * Math.max(0, Math.min(1, k.h)))
  return most
}

interface WaitingGroup {
  group: string
  kind: PrivateKind
  covers: Cover[]
  bleeps: Bleep[]
}

/** The waiting groups, each with its kind. */
function waitingGroups(project: Project): WaitingGroup[] {
  const index = privacyIndex(project)
  const out: WaitingGroup[] = []
  for (const group of index.groups) {
    const g = groupOf(project, group)
    if (!g || !g.waiting) continue
    const kind = kindOfGroup(g.covers, g.bleeps)
    if (!kind) continue
    out.push({ group, kind, covers: g.covers, bleeps: g.bleeps })
  }
  return out
}

/**
 * One row per group still waiting, its places as `parts` when it has more than one cover (§2.7). A
 * row's title is the kind's title with the first start and last end ("Email address · 0:42–3:10"),
 * in the video's time as every row's time is; its detail where its first cover is on screen ("Top
 * right of the screen"), or *Said aloud* for a group of private bleeps. A place's title is where it
 * is and its own times. No title ever holds what is hidden.
 */
export function privacyReviewItems(project: Project): ReviewItem[] {
  const groups = waitingGroups(project)
  if (!groups.length) return []
  // Every time shown, in one pass over the clips (times.ts keeps them for the same clips).
  const at: { start: number }[] = []
  for (const g of groups) {
    for (const c of g.covers) at.push({ start: c.start }, { start: c.end })
    for (const b of g.bleeps) at.push({ start: b.start }, { start: b.end })
  }
  const shown = rowTimes(at, project.clips, planOf(project))
  const clock = new Map<number, string>()
  at.forEach((x, i) => clock.set(x.start, shown[i]))
  const time = (s: number): string => clock.get(s) ?? fmt.clock(s)
  const out: ReviewItem[] = []
  for (const g of groups) {
    let start = Infinity
    let end = -Infinity
    for (const s of [...g.covers, ...g.bleeps]) {
      start = Math.min(start, s.start)
      end = Math.max(end, s.end)
    }
    const title = t('privacy.review.title', { kind: t(kindTitle(g.kind)), start: time(start), end: time(end) })
    const box = g.covers.length ? firstBox(g.covers[0]) : null
    const detail = box ? whereOf(box) : t('privacy.review.said')
    const row: ReviewItem = { key: privateRowKey(g.kind, g.group), kind: 'private', start, end, title, detail }
    if (g.covers.length > 1) {
      row.parts = g.covers.map((c) => {
        const b = firstBox(c)
        const where = b ? whereOf(b) : detail
        return { key: privatePartKey(g.kind, g.group, c.id), kind: 'private', start: c.start, end: c.end, title: t('privacy.review.place', { where, start: time(c.start), end: time(c.end) }), detail: where }
      })
    }
    out.push(row)
  }
  return out
}

/** How many private rows wait: the waiting groups of privacyIndex, counted without making rows (titles, times). */
export function privacyPendingCount(project: Project): number {
  const index = privacyIndex(project)
  let n = 0
  for (const group of index.groups) if (index.group(group)?.waiting) n++
  return n
}

/**
 * A private row's status, read from the project (§14.3): pending while any of its covers is a
 * suggestion or any of its private bleeps is still automatic; removed once none of them is left;
 * kept otherwise. A place: its cover's.
 */
export function privacyStatus(project: Project, item: ReviewItem): ReviewStatus {
  const key = parsePrivateKey(item.key)
  if (!key) return 'kept'
  if (key.cover) {
    const c = coversById(project).get(key.cover)
    return !c ? 'removed' : c.found ? 'pending' : 'kept'
  }
  const g = privacyIndex(project).group(key.group)
  if (!g || (!g.covers.length && !g.bleeps.length)) return 'removed'
  return g.waiting ? 'pending' : 'kept'
}

/** The covers and private bleeps the rows and places of `items` name, as the project holds them now. */
function targetsOf(project: Project, items: readonly ReviewItem[]): { covers: string[]; bleeps: string[] } {
  const covers = new Set<string>()
  const bleeps = new Set<string>()
  const index = privacyIndex(project)
  for (const item of items) {
    if (item.kind !== 'private') continue
    const key = parsePrivateKey(item.key)
    if (!key) continue
    if (key.cover) {
      covers.add(key.cover)
      continue
    }
    const g = index.group(key.group)
    if (!g) continue
    for (const id of g.covers) covers.add(id)
    for (const id of g.bleeps) bleeps.add(id)
  }
  return { covers: [...covers], bleeps: [...bleeps] }
}

/** The project with private bleeps `ids` no longer automatic (the user's); itself when none changes. */
function keepBleeps(project: Project, ids: readonly string[]): Project {
  if (!ids.length || !project.bleeps?.length) return project
  const want = new Set(ids)
  let changed = false
  const bleeps = project.bleeps.map((b) => {
    if (!want.has(b.id) || !b.auto || !isPrivateBleep(b)) return b
    changed = true
    const { auto: _a, ...rest } = b
    void _a
    return rest
  })
  return changed ? { ...project, bleeps } : project
}

/** The project without private bleeps `ids` (the secret is heard again); itself when none goes. */
function dropBleeps(project: Project, ids: readonly string[]): Project {
  if (!ids.length || !project.bleeps?.length) return project
  const want = new Set(ids)
  const bleeps = project.bleeps.filter((b) => !(want.has(b.id) && isPrivateBleep(b)))
  if (bleeps.length === project.bleeps.length) return project
  if (bleeps.length) return { ...project, bleeps }
  const { bleeps: _b, ...rest } = project
  void _b
  return rest
}

/**
 * *Keep covered* (§2.7): every cover and private bleep of the rows (a place: its cover) the user's,
 * the covers through part P1's keepCovers. The project itself when nothing changes.
 */
export function privacyKeep(project: Project, items: readonly ReviewItem[]): Project {
  const { covers, bleeps } = targetsOf(project, items)
  return keepBleeps(covers.length ? keepCovers(project, covers) : project, bleeps)
}

/**
 * *Uncover* (§2.7): the rows' covers and private bleeps deleted (a place: its cover), each
 * suggestion's path written to privacy.rejected in the same update by part P1's deleteCovers. The
 * project itself when nothing changes.
 */
export function privacyRemove(project: Project, items: readonly ReviewItem[]): Project {
  const { covers, bleeps } = targetsOf(project, items)
  return dropBleeps(covers.length ? deleteCovers(project, covers) : project, bleeps)
}

/** Whether a private row or place is a Check one now (any of its covers a Check suggestion). */
function isCheck(project: Project, item: ReviewItem): boolean {
  const key = parsePrivateKey(item.key)
  if (!key) return false
  if (key.cover) return coversById(project).get(key.cover)?.found === 'check'
  return !!privacyIndex(project).group(key.group)?.check
}

/**
 * The private rows in Review's order (§2.7): Check rows first, then the rest, each by start time;
 * the other rows after them in the order given. ReviewPanel applies it when the *Private* filter is
 * on and keeps it there.
 */
export function privacyOrder(items: readonly ReviewItem[], project: Project): ReviewItem[] {
  const priv = items.filter((i) => i.kind === 'private')
  const rest = items.filter((i) => i.kind !== 'private')
  const check = new Map(priv.map((i) => [i.key, isCheck(project, i)]))
  priv.sort((a, b) => Number(check.get(b.key)) - Number(check.get(a.key)) || a.start - b.start || a.key.localeCompare(b.key))
  return [...priv, ...rest]
}

/** The kinds of the private rows waiting, in the kinds' order (§2.5), for the kind filter. */
export function privacyKinds(project: Project): PrivateKind[] {
  const found = new Set(waitingGroups(project).map((g) => g.kind))
  return PRIVATE_KINDS.filter((k) => found.has(k))
}

/** The kind a private row or place hides (from its key, so it stays after its covers are gone). */
export const privateRowKind = (item: Pick<ReviewItem, 'key'>): PrivateKind | null => parsePrivateKey(item.key)?.kind ?? null

/**
 * *Done reviewing* (§2.7): every waiting private suggestion kept, in one step: every found cover and
 * every automatic private bleep the user's. The project itself when none waits.
 */
export function doneReviewing(project: Project): Project {
  const covers = (project.covers ?? []).filter((c) => c.found).map((c) => c.id)
  const bleeps = (project.bleeps ?? []).filter((b) => b.auto && isPrivateBleep(b)).map((b) => b.id)
  return keepBleeps(covers.length ? keepCovers(project, covers) : project, bleeps)
}

/** What *Done reviewing* keeps (its confirm): the covers still waiting, and the private rows of them that are Check rows. */
export function doneCounts(project: Project): { waiting: number; check: number } {
  let waiting = 0
  for (const c of project.covers ?? []) if (c.found) waiting++
  for (const b of project.bleeps ?? []) if (b.auto && isPrivateBleep(b)) waiting++
  let check = 0
  const index = privacyIndex(project)
  for (const group of index.groups) if (index.group(group)?.check) check++
  return { waiting, check }
}

/**
 * A row as the panel merges it with the project's rows now (Review's mergeSnapshot): its places as
 * they were listed (reviewed ones marked) with the current version of each, and any new one; its
 * title, times and detail as they are now. A row no longer listed keeps how it was shown.
 */
export function mergePrivateRow(shown: ReviewItem, now: ReviewItem | undefined): ReviewItem {
  if (!now) return shown
  if (!shown.parts) return now
  const fresh = new Map((now.parts ?? []).map((p) => [p.key, p]))
  const parts = shown.parts.map((p) => fresh.get(p.key) ?? p)
  const had = new Set(shown.parts.map((p) => p.key))
  for (const p of now.parts ?? []) if (!had.has(p.key)) parts.push(p)
  parts.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
  return { ...now, parts }
}

/** What a private row shows besides its title and detail (§2.7). */
export interface PrivateRowView {
  kind: PrivateKind
  /** Badges as message keys, in the order shown: Check, Said aloud, Covers an area, Not found again, Read less often here. */
  badges: MessageKey[]
  places: number
  /** The largest lost area: its share of the screen (formatted) and how long (the editor's clock). */
  area: { percent: string; time: string } | null
  /** The covers Peek and Select on the timeline act on. */
  coverIds: string[]
  /** The private bleep Listen plays, if any. */
  bleepId: string | null
}

/**
 * A private row's or place's view (§2.7), from the project as it is now: its covers' badges (a Check
 * suggestion, a lost area, not found again, read less often), *Said aloud* for its private bleeps,
 * its places, and the largest lost area's share of the screen and length.
 */
export function privateRowView(project: Project, item: ReviewItem): PrivateRowView | null {
  const key = parsePrivateKey(item.key)
  if (!key) return null
  let covers: Cover[] = []
  let bleeps: Bleep[] = []
  if (key.cover) {
    const c = coversById(project).get(key.cover)
    if (c) covers = [c]
  } else {
    const g = groupOf(project, key.group)
    covers = g?.covers ?? []
    bleeps = g?.bleeps ?? []
  }
  const badges: MessageKey[] = []
  if (covers.some((c) => c.found === 'check')) badges.push('privacy.review.check')
  if (bleeps.length) badges.push('privacy.review.said')
  const lost = covers.filter((c) => c.lost)
  if (lost.length) badges.push('privacy.review.lost')
  if (covers.some((c) => c.missed)) badges.push('privacy.review.missed')
  if (covers.some((c) => c.thin)) badges.push('privacy.review.thin')
  let area: PrivateRowView['area'] = null
  if (lost.length) {
    let best = lost[0]
    for (const c of lost) if (largestShare(c) > largestShare(best)) best = c
    area = { percent: fmt.percent(largestShare(best)), time: fmt.clock(Math.max(0, best.end - best.start)) }
  }
  const places = key.cover ? 1 : Math.max(covers.length, item.parts?.length ?? 0)
  return { kind: key.kind, badges, places, area, coverIds: covers.map((c) => c.id), bleepId: bleeps[0]?.id ?? null }
}
