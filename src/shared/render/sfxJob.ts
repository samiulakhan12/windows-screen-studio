/**
 * When the library's sound effects sound (docs/design/editing-polish.md §10.6): on zooms, title
 * cards, texts and shapes by the project's rules, items' own sounds, and Captions Studio's pop-ups
 * with a library sound; video seconds, for the export job and the preview alike. Pure.
 *
 * Every time is in video seconds (edit seconds past the pause freezes, editToVideo, as popJob's),
 * less the effect's peakAt, so its loudest moment lands on the moment it belongs to:
 * - Zooming in: the fastest point of the move in (source seg.start + tin / 2), for each zoom that
 *   does not pan from the previous one; Zooming out: seg.end − tout / 2, for each zoom that does
 *   not pan into the next (zoomTimings already merges connected zooms). A pull-back (a level below
 *   100%) swaps the two, as its picture shrinks first and grows back; a zoom at 100% never sounds.
 * - Title cards, texts and shapes: the item's start plus half its enter motion (or its old fade).
 *   An item's own sound wins over the rule ('none' silences it); privacy shapes never sound.
 * - Captions Studio's pop-ups with a library sound: when the graphic starts to show (startOf, the
 *   callback popJob gets), with popJob's own rules, so a pop-up sounds where its 'pop' would.
 * A rule's times closer than RULE_GAP to the rule's last kept time are dropped; items' own sounds
 * never are. Times of one effect closer than MERGE_GAP merge into the first.
 */
import { soundEffect } from '../audio/soundLibrary'
import { isPrivacyKind, SHAPE_FADE } from '../editor/shapes'
import { editToVideo, planOf, type FreezePlan } from '../engine/freeze'
import { outputDuration, playableFrom, sourceToOutput } from '../engine/timeline'
import { zoomStyleOf, zoomTargetScale, zoomTimings } from '../engine/zoom'
import type { CalloutMotion, Clip, Graphic, Project, SfxRef } from '../types'
import { ANNOTATION_FADE } from './overlays'
import { graphicDrawn, MAX_POP_TIMES } from './popSound'
import { TITLE_FADE } from './titleCards'

export const SFX_VOLUME = 0.35
export const MAX_SFX = 16
/** A rule's sound plays at most once every this many seconds of video. */
export const RULE_GAP = 3.0
/** Times of one effect closer than this (seconds) merge into the first. */
export const MERGE_GAP = 0.05

export type SfxRule = 'zoomIn' | 'zoomOut' | 'titles' | 'callouts'
export const SFX_RULES: readonly SfxRule[] = ['zoomIn', 'zoomOut', 'titles', 'callouts']

/** One time a sound plays: its effect and video seconds. */
interface Hit {
  id: string
  at: number
}

/** The effect id of a reference of the catalogue, or null. */
function effectOf(ref: SfxRef | 'none' | 'pop' | 'ding' | undefined): string | null {
  if (typeof ref !== 'string' || !ref.startsWith('sfx:')) return null
  const id = ref.slice(4)
  return soundEffect(id) ? id : null
}

/** The video time of source time `s` when the edit shows it, or null (it lies in a cut, or past the end). */
function videoOf(clips: Clip[], plan: FreezePlan, total: number, s: number): number | null {
  const at = sourceToOutput(clips, s)
  if (at === null || at >= total) return null
  return editToVideo(plan, at)
}

/** The first source time at or after `s` that is in the edit, as popJob's shownFrom. */
function shownFrom(clips: Clip[], s: number): number | null {
  const at = sourceToOutput(clips, s)
  if (at !== null) return at
  const next = playableFrom(clips, s)
  return next ? sourceToOutput(clips, next.time) : null
}

/** The time effect `id` starts at so that its loudest moment is on `at` (never before 0). */
const placed = (id: string, at: number): Hit => ({ id, at: Math.max(0, at - (soundEffect(id)?.prepared.peakAt ?? 0)) })

/** Half an item's way in: its enter motion's, else its old fade's. */
const halfIn = (enter: CalloutMotion | undefined, oldFade: number): number => (enter && Number.isFinite(enter.duration) ? enter.duration : oldFade) / 2

/** Every time each rule and each item sounds, before the spacing and merging. */
function hits(project: Project, startOf?: (g: Graphic) => number): { rules: Record<SfxRule, Hit[]>; own: Hit[] } {
  const rules: Record<SfxRule, Hit[]> = { zoomIn: [], zoomOut: [], titles: [], callouts: [] }
  const own: Hit[] = []
  const clips = project.clips
  if (clips.length === 0) return { rules, own }
  const fx = project.soundFx
  const plan = planOf(project)
  const total = outputDuration(clips)
  const zoomIn = effectOf(fx?.zoomIn)
  const zoomOut = effectOf(fx?.zoomOut)
  if ((zoomIn || zoomOut) && project.zooms.length > 0) {
    const timings = zoomTimings(project.zooms, zoomStyleOf(project))
    for (const z of project.zooms) {
      const tm = timings.get(z.id)
      if (!tm) continue
      // A pull-back (a level below 100%) zooms out as it starts and back in as it ends; a zoom at
      // 100% never moves.
      const scale = zoomTargetScale(z)
      if (Math.abs(scale - 1) < 1e-3) continue
      const [inRule, outRule] = scale > 1 ? (['zoomIn', 'zoomOut'] as const) : (['zoomOut', 'zoomIn'] as const)
      const inFx = scale > 1 ? zoomIn : zoomOut
      const outFx = scale > 1 ? zoomOut : zoomIn
      // A zoom that starts in a cut is never seen moving in.
      if (inFx && tm.tin > 0 && !tm.fromPrev && videoOf(clips, plan, total, z.start) !== null) {
        const at = videoOf(clips, plan, total, z.start + tm.tin / 2)
        if (at !== null) rules[inRule].push(placed(inFx, at))
      }
      if (outFx && tm.tout > 0 && !tm.toNext) {
        const at = videoOf(clips, plan, total, z.end - tm.tout / 2)
        if (at !== null) rules[outRule].push(placed(outFx, at))
      }
    }
  }
  /** An item: its own sound, else its rule's; from its start (never one in a cut) plus half its way in. */
  const item = (rule: 'titles' | 'callouts', start: number, sound: 'none' | SfxRef | undefined, enter: CalloutMotion | undefined, oldFade: number): void => {
    if (sound === 'none') return
    const mine = effectOf(sound)
    const id = mine ?? effectOf(fx?.[rule])
    if (!id) return
    const from = videoOf(clips, plan, total, start)
    if (from === null) return
    const hit = placed(id, from + halfIn(enter, oldFade))
    if (mine) own.push(hit)
    else rules[rule].push(hit)
  }
  for (const c of project.titles ?? []) item('titles', c.start, c.sound, c.enter, TITLE_FADE)
  for (const a of project.annotations ?? []) item('callouts', a.start, a.sound, a.enter, ANNOTATION_FADE)
  for (const s of project.shapes ?? []) if (!isPrivacyKind(s.kind)) item('callouts', s.start, s.sound, s.enter, SHAPE_FADE)
  // Captions Studio's pop-ups with a library sound (§10.7): popJob's rules exactly, at its time.
  for (const g of project.graphics ?? []) {
    const id = effectOf(g.sound)
    if (!id || !graphicDrawn(project, g)) continue
    const at = shownFrom(clips, startOf ? startOf(g) : g.start)
    if (at === null || at >= total) continue
    const end = sourceToOutput(clips, g.end) ?? shownFrom(clips, g.end) ?? total
    if (!(end > at)) continue
    own.push(placed(id, editToVideo(plan, at)))
  }
  return { rules, own }
}

/** A rule's times in order, each at least RULE_GAP after the last one kept. */
function spaced(list: readonly Hit[]): Hit[] {
  const out: Hit[] = []
  let last = -Infinity
  for (const h of [...list].sort((a, b) => a.at - b.at)) {
    if (h.at - last < RULE_GAP - 1e-9) continue
    out.push(h)
    last = h.at
  }
  return out
}

/** The effects' gain: the project's effects volume, else SFX_VOLUME. */
export function sfxGain(project: Pick<Project, 'soundFx'>): number {
  const v = project.soundFx?.volume
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : SFX_VOLUME
}

/** Each library effect that sounds once, with its times (video seconds) and gain. */
export function sfxJob(project: Project, startOf?: (g: Graphic) => number): { id: string; times: number[]; gain: number }[] {
  const { rules, own } = hits(project, startOf)
  const all = [...own, ...SFX_RULES.flatMap((r) => spaced(rules[r]))]
  if (all.length === 0) return []
  const byId = new Map<string, number[]>()
  for (const h of all) {
    const list = byId.get(h.id)
    if (list) list.push(h.at)
    else byId.set(h.id, [h.at])
  }
  const gain = sfxGain(project)
  const out: { id: string; times: number[]; gain: number }[] = []
  for (const [id, raw] of byId) {
    const times: number[] = []
    for (const t of raw.sort((a, b) => a - b)) {
      if (times.length > 0 && t - times[times.length - 1] < MERGE_GAP) continue
      times.push(t)
    }
    out.push({ id, times: times.slice(0, MAX_POP_TIMES), gain })
  }
  // In order of each effect's first sound, at most MAX_SFX effects.
  return out.sort((a, b) => a.times[0] - b.times[0] || (a.id < b.id ? -1 : 1)).slice(0, MAX_SFX)
}

const anyLibraryRef = (items: readonly { sound?: string }[] | undefined): boolean => !!items?.some((i) => typeof i.sound === 'string' && i.sound.startsWith('sfx:'))
const heard = new WeakMap<Project, boolean>()

/**
 * Whether any library effect sounds in the project (the export then has a soundtrack, and the
 * preview plays through its audio graph). Old projects answer at once; else once per project state.
 */
export function hasLibrarySounds(project: Project): boolean {
  const fx = project.soundFx
  const rules = !!fx && SFX_RULES.some((r) => !!fx[r])
  if (!rules && !anyLibraryRef(project.annotations) && !anyLibraryRef(project.shapes) && !anyLibraryRef(project.titles) && !anyLibraryRef(project.graphics)) return false
  let v = heard.get(project)
  if (v === undefined) {
    v = sfxJob(project).length > 0
    heard.set(project, v)
  }
  return v
}

/** Every library effect the project names, on its rules and its items, whether or not it sounds (the preview decodes them ahead). */
export function sfxIds(project: Project): string[] {
  const ids = new Set<string>()
  const add = (ref: string | undefined): void => {
    const id = effectOf(ref as SfxRef | undefined)
    if (id) ids.add(id)
  }
  for (const r of SFX_RULES) add(project.soundFx?.[r])
  for (const list of [project.titles, project.annotations, project.shapes, project.graphics] as (readonly { sound?: string }[] | undefined)[]) for (const i of list ?? []) add(i.sound)
  return [...ids]
}

/** How many times each rule's sound plays ("Plays 24 times"). */
export function sfxCounts(project: Project, startOf?: (g: Graphic) => number): Readonly<Record<'zoomIn' | 'zoomOut' | 'titles' | 'callouts', number>> {
  const { rules } = hits(project, startOf)
  return { zoomIn: spaced(rules.zoomIn).length, zoomOut: spaced(rules.zoomOut).length, titles: spaced(rules.titles).length, callouts: spaced(rules.callouts).length }
}
