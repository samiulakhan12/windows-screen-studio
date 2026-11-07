/**
 * Editing cut styles (docs/design/editing-polish.md §2.1, §11, §16): Smooth all cuts, Use hard
 * cuts everywhere, a cut's own style, and the settle step that drops styles whose cut went. Each
 * is one project out (one store.update, one undo step), and returns `project` itself when it
 * changes nothing.
 */
import { planOf } from '../engine/freeze'
import { formatTime } from '../engine/project'
import { cutsOf, smoothAt, type CutRef } from '../render/joins'
import type { CutJoin, CutStyle, Project, ProjectJoins } from '../types'

const SMOOTH: CutJoin = { kind: 'smooth' }

const sameJoin = (a: CutJoin | null | undefined, b: CutJoin | null | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** `project` with `joins` (an empty one deleted). */
function withJoins(project: Project, joins: ProjectJoins): Project {
  const out: ProjectJoins = {}
  if (joins.all) out.all = joins.all
  if (joins.cuts?.length) out.cuts = joins.cuts
  if (joins.auto) out.auto = joins.auto
  if (Object.keys(out).length === 0) {
    if (!project.joins) return project
    const { joins: _gone, ...rest } = project
    return rest
  }
  return { ...project, joins: out }
}

/** The cuts of `project`, in order. */
const cutsIn = (project: Project): readonly CutRef[] => cutsOf(project.clips, planOf(project))

/** The clip ids that have a style of their own and still follow a cut. */
function ownStyled(project: Project): Set<string> {
  const own = project.joins?.cuts
  if (!own?.length) return new Set()
  const after = new Set(cutsIn(project).map((c) => c.clip))
  return new Set(own.map((c) => c.clip).filter((id) => after.has(id)))
}

/**
 * Every cut set to Smooth in one update: `joins.all` becomes Smooth; cuts with their own style
 * keep it. `changed`: the cuts that get Smooth; `kept`: those that keep their own style.
 * `project` itself, with nothing changed, when every cut already is Smooth.
 */
export function smoothAllCuts(project: Project): { project: Project; changed: number; kept: number } {
  const cuts = cutsIn(project)
  const own = ownStyled(project)
  const kept = cuts.filter((c) => own.has(c.clip)).length
  if (project.joins?.all?.kind === 'smooth') return { project, changed: 0, kept }
  const { auto: _auto, ...joins } = project.joins ?? {}
  return { project: withJoins(project, { ...joins, all: SMOOTH }), changed: cuts.length - kept, kept }
}

/** Every cut a hard cut, stored as { kind: 'cut' } so Polish keeps it; cuts lose their own styles. */
export function hardCutsEverywhere(project: Project): Project {
  const j = project.joins
  if (j && sameJoin(j.all, { kind: 'cut' }) && !j.cuts?.length && !j.auto) return project
  return withJoins(project, { all: { kind: 'cut' } })
}

/** The style of every cut (null: none, a hard cut); a choice by hand, so Polish's record goes. */
export function withJoinAll(project: Project, join: CutJoin | null): Project {
  const j = project.joins
  if (sameJoin(j?.all, join) && !j?.auto) return project
  const { all: _all, auto: _auto, ...rest } = j ?? {}
  return withJoins(project, join ? { ...rest, all: join } : rest)
}

/** The style of the cut before clip `clip` (null: the same as every cut). */
export function withCutJoin(project: Project, clip: string, join: CutJoin | null): Project {
  const cuts = project.joins?.cuts ?? []
  const at = cuts.findIndex((c) => c.clip === clip)
  if (join === null) {
    if (at < 0) return project
    return withJoins(project, { ...project.joins, cuts: cuts.filter((_, i) => i !== at) })
  }
  const style: CutStyle = { clip, ...join }
  if (at >= 0 && sameJoin(cuts[at], style)) return project
  const next = at >= 0 ? cuts.map((c, i) => (i === at ? style : c)) : [...cuts, style]
  return withJoins(project, { ...project.joins, cuts: next })
}

/** Cuts with their own style given every cut's (their own styles cleared). */
export function giveSameStyle(project: Project): Project {
  if (!project.joins?.cuts?.length) return project
  const { cuts: _cuts, ...rest } = project.joins
  return withJoins(project, rest)
}

/**
 * `next` with the styles of cuts that went dropped (a restore, a trim, a Review Remove of a silence
 * cut: the clip is gone or no longer follows a cut), and Polish's record when every cut's style was
 * changed by hand; `next` itself when nothing applies (old projects pass through untouched).
 */
export function settleJoins(next: Project, prev: Project): Project {
  const j = next.joins
  if (!j) return next
  if (next.clips === prev.clips && j === prev.joins) return next
  let cuts = j.cuts
  if (cuts?.length && next.clips !== prev.clips) {
    const after = new Set(cutsIn(next).map((c) => c.clip))
    const left = cuts.filter((c) => after.has(c.clip))
    if (left.length !== cuts.length) cuts = left
  }
  // Polish's record goes when `all` changed by hand (Polish sets both in one update, with no record before).
  const handEdited = !!j.auto && !!prev.joins?.auto && !sameJoin(j.all, prev.joins.all)
  if (cuts === j.cuts && !handEdited) return next
  const { auto, cuts: _cuts, ...rest } = j
  return withJoins(next, { ...rest, ...(cuts ? { cuts } : {}), ...(auto && !handEdited ? { auto } : {}) })
}

export function cutCount(project: Project): number {
  return cutsIn(project).length
}

/** The position of the cut whose B starts at source time `start` (a gap selection's end), or -1. */
function cutAtStart(project: Project, start: number): number {
  return cutsIn(project).findIndex((c) => Math.abs(project.clips[c.index].start - start) < 1e-9)
}

/** "Cut 5 of 37" for the cut whose B starts at source time `start` (null: no cut there). */
export function cutNumber(project: Project, start: number): { n: number; of: number } | null {
  const k = cutAtStart(project, start)
  return k < 0 ? null : { n: k + 1, of: cutsIn(project).length }
}

/** The cut whose B starts at source time `start` (a gap selection's end), or null. */
export function cutAt(project: Project, start: number): CutRef | null {
  const k = cutAtStart(project, start)
  return k < 0 ? null : cutsIn(project)[k]
}

const NAMES: Record<CutJoin['kind'], string> = {
  cut: 'Hard cut',
  smooth: 'Smooth',
  crossfade: 'Crossfade',
  dip: 'Dip to colour',
  slide: 'Slide',
  punch: 'Punch-in'
}

/** A style's name in the UI ("Hard cut", "Smooth", "Crossfade"). */
export function joinName(kind: CutJoin['kind'] | null): string {
  return NAMES[kind ?? 'cut']
}

/** A join's name in the UI with its length or size ("Crossfade, 0.15 s", "Punch-in, 110 %"). */
export function joinLabel(join: CutJoin | null): string {
  if (!join || join.kind === 'cut') return NAMES.cut
  if (join.kind === 'punch') return `${NAMES.punch}, ${Math.round((join.scale ?? 1.1) * 100)} %`
  if (join.kind === 'smooth') return NAMES.smooth
  const d = join.duration ?? (join.kind === 'dip' ? 0.5 : join.kind === 'slide' ? 0.4 : 0.15)
  return `${NAMES[join.kind]}, ${Number(d.toFixed(2))} s`
}

const gapOf = (project: Project, c: CutRef): { start: number; end: number } => ({ start: project.clips[c.index - 1].end, end: project.clips[c.index].start })

/** The first cut whose B starts after source time `t` (from a cut's B, the next one), as its gap. */
export function nextCutAfter(project: Project, t: number): { start: number; end: number } | null {
  const c = cutsIn(project).find((x) => project.clips[x.index].start > t + 1e-6)
  return c ? gapOf(project, c) : null
}

/** The last cut whose B starts before source time `t`, as its gap. */
export function prevCutBefore(project: Project, t: number): { start: number; end: number } | null {
  const cuts = cutsIn(project)
  for (let k = cuts.length - 1; k >= 0; k--) if (project.clips[cuts[k].index].start < t - 1e-6) return gapOf(project, cuts[k])
  return null
}

/** What Smooth gives cut `index` (B's clip index): a crossfade, or a punch-in when the camera leads on both sides. */
export function smoothHere(project: Project, index: number): 'crossfade' | 'punch' {
  return smoothAt(project, index)
}

/** The cuts without a style of their own: what Smooth all cuts and Polish change ("Smooth cuts at 37 cuts"). */
export function cutsWithoutOwnStyle(project: Project): number {
  const own = ownStyled(project)
  return cutsIn(project).filter((c) => !own.has(c.clip)).length
}

/** "1:23.4 to 1:25.0": a cut's source span, as the timeline names it. */
export function cutSpan(gap: { start: number; end: number }): string {
  return `${formatTime(gap.start)} to ${formatTime(gap.end)}`
}
