/**
 * A guide's steps from the recording (docs/design/smart-tools.md §5.1): one step per click,
 * double-click, drag, shortcut and stretch of typing, a screen change when no clicks were recorded,
 * the steps the user added, or the automatically numbered step badges. Each step has a key from its
 * input event's time, so the guide's edits find their step again after the video is edited.
 *
 * `findSteps` takes the effective track (inputTrack.ts: ignored and stray clicks are gone). Times
 * are source seconds; distances are pixels of the captured area. Pure, and linear in the input
 * after sorting (§18: 10,000 clicks in under 50 ms).
 */
import type { SceneScan } from '../api/projects'
import { cursorAt } from '../engine/cursor'
import { editToVideo, planOf } from '../engine/freeze'
import type { Rect } from '../engine/layout'
import { scrollSessions } from '../engine/scroll'
import { viewAt } from '../captions/layout'
import { userChapters } from '../chapters/pending'
import { badgesByChapterOf } from '../render/calloutData'
import { badgeLabels } from '../render/callouts'
import { outputChapters } from '../render/chapters'
import { isCut } from '../search/moment'
import { screenChanges } from '../smart/screenChanges'
import type { ClickEvent, CursorShape, CursorTrack, Project } from '../types'

export type StepKind = 'click' | 'double' | 'right' | 'middle' | 'drag' | 'type' | 'keys' | 'screen' | 'badge' | 'added'

export interface GuideStep {
  key: string
  t: number
  kind: StepKind
  x?: number
  y?: number
  to?: { x: number; y: number }
  times?: number
  keys?: string
  typing?: { t: number; end: number; place: { x: number; y: number } }
  then?: string
  scroll?: 'up' | 'down' | 'left' | 'right'
  shape?: CursorShape
  place?: { x: number; y: number }
  badge?: { label: string; section?: string }
  hiddenByDefault?: true
}

export const STEP_RULES = {
  doubleS: 0.5,
  doublePx: 4,
  dragHeldS: 0.25,
  dragTravel: 0.02,
  repeatS: 1.5,
  repeatPx: 12,
  typingJoinS: 5,
  typingMinS: 0.5,
  typingPauseS: 6,
  typingTailS: 0.3,
  keyAfterTypingS: 1.5,
  screenAfterKeyS: 1.5,
  scrollAheadS: 10,
  maxSteps: 200
} as const

/** Keys a typing step takes as its last press ("… and press Enter"). */
const THEN_KEYS = new Set(['enter', 'tab', 'return'])
/** How far back (seconds) the click a lone burst types into may be (zoom.ts TYPING_CLICK_WINDOW). */
const TYPING_CLICK_WINDOW = 10
const EPS = 1e-6

type StepProject = Pick<Project, 'clips' | 'duration' | 'width' | 'height' | 'capture' | 'guide' | 'annotations' | 'chapters' | 'effects'>

/** A step while it is being built. */
interface Draft extends GuideStep {
  /** The last press (repeats), the last key (key presses), or the end of the typing. */
  last: number
  /** The click's button, for repeats. */
  button?: ClickEvent['button']
}

/** 'c' + the click's time in ms, 'k' a key press's, 't' a lone burst's, 's' a screen change's, 'b' a badge's, 'a' an added step's. */
export function stepKey(kind: StepKind, t: number): string {
  const prefix = kind === 'keys' ? 'k' : kind === 'type' ? 't' : kind === 'screen' ? 's' : kind === 'badge' ? 'b' : kind === 'added' ? 'a' : 'c'
  return `${prefix}${Math.round(t * 1000)}`
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inUnit = (p: { x: number; y: number }): boolean => finite(p.x) && finite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** First index of `xs` (sorted) greater than `t`. */
function upperBound(xs: readonly number[], t: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Where the cursor was when a press held from `c.t` to `c.up` was released, when it was held at
 * least STEP_RULES.dragHeldS and the cursor travelled at least STEP_RULES.dragTravel of the frame's
 * height from the press; else null.
 */
function dragOf(c: ClickEvent, samples: CursorTrack['samples'], times: readonly number[], w: number, h: number): { x: number; y: number } | null {
  if (!finite(c.up) || c.up < c.t || c.up - c.t < STEP_RULES.dragHeldS - EPS) return null
  const end = cursorAt(samples, c.up)
  if (!end) return null
  const travel = (p: { x: number; y: number }): number => Math.hypot((p.x - c.x) * w, (p.y - c.y) * h) / h
  let far = travel(end)
  for (let i = upperBound(times, c.t); i < samples.length && samples[i].t <= c.up; i++) far = Math.max(far, travel(samples[i]))
  return far >= STEP_RULES.dragTravel - EPS ? { x: clamp01(end.x), y: clamp01(end.y) } : null
}

const KIND_OF: Record<ClickEvent['button'], StepKind> = { left: 'click', right: 'right', middle: 'middle' }

/** Which way a scroll session went, from its wheel events' sums (down when nothing moved). */
function scrollWay(events: readonly { dx: number; dy: number }[]): GuideStep['scroll'] {
  let dx = 0
  let dy = 0
  for (const e of events) {
    if (finite(e.dx)) dx += e.dx
    if (finite(e.dy)) dy += e.dy
  }
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy < 0 ? 'up' : 'down'
}

/**
 * The steps of the recording, in time order (§5.1): rules 1–10, or with `guide.from === 'badges'`
 * and automatic badges, rule 11 (the badges, and the other steps listed hidden). A step whose time
 * is cut is dropped; at most STEP_RULES.maxSteps, the first in time.
 */
export function findSteps(input: { track: CursorTrack; project: StepProject; scan: SceneScan | null }): GuideStep[] {
  const { track, project, scan } = input
  const w = project.width > 0 ? project.width : 1920
  const h = project.height > 0 ? project.height : 1080
  const scale = finite(track.scale) && track.scale > 0 ? track.scale : 1
  const kept = project.clips.filter((c) => c.end > c.start).map((c) => [c.start, c.end] as const)
  const isKept = (t: number): boolean => !isCut(kept, t, t)
  const samples = track.valid ? (track.samples ?? []) : []
  const sampleTimes = samples.map((s) => s.t)

  // Rule 1: usable clicks, in time order.
  const clicks = (track.valid ? track.clicks : [])
    .filter((c) => finite(c.t) && inUnit(c) && (c.button === 'left' || c.button === 'right' || c.button === 'middle'))
    .sort((a, b) => a.t - b.t)
  const clickTimes = clicks.map((c) => c.t)
  const shapes = (track.shapes ?? []).filter((s) => finite(s.t)).sort((a, b) => a.t - b.t)
  const shapeTimes = shapes.map((s) => s.t)
  const shapeAt = (t: number): CursorShape | undefined => {
    const i = upperBound(shapeTimes, t + EPS) - 1
    return i >= 0 ? shapes[i].shape : undefined
  }

  // Rules 2 and 3: drags and double-clicks.
  const clickSteps: Draft[] = []
  for (let i = 0; i < clicks.length; i++) {
    const c = clicks[i]
    const shape = shapeAt(c.t)
    const base = { key: stepKey('click', c.t), t: c.t, x: c.x, y: c.y, last: c.t, button: c.button, ...(shape ? { shape } : {}) }
    const to = dragOf(c, samples, sampleTimes, w, h)
    if (to) {
      clickSteps.push({ ...base, kind: 'drag', to, last: c.up! })
      continue
    }
    const next = clicks[i + 1]
    if (
      next &&
      next.button === c.button &&
      next.t - c.t <= STEP_RULES.doubleS + EPS &&
      Math.hypot((next.x - c.x) * w, (next.y - c.y) * h) <= STEP_RULES.doublePx * scale + EPS &&
      !dragOf(next, samples, sampleTimes, w, h)
    ) {
      clickSteps.push({ ...base, kind: 'double', last: next.t })
      i++
      continue
    }
    clickSteps.push({ ...base, kind: KIND_OF[c.button] })
  }

  // Rule 4: the same button on the same spot in a row is one step, "… 3 times".
  const pressed: Draft[] = []
  for (const s of clickSteps) {
    const prev = pressed[pressed.length - 1]
    if (
      prev &&
      prev.kind === s.kind &&
      s.kind !== 'drag' &&
      prev.button === s.button &&
      s.t - prev.last <= STEP_RULES.repeatS + EPS &&
      Math.hypot((s.x! - prev.x!) * w, (s.y! - prev.y!) * h) <= STEP_RULES.repeatPx * scale + EPS
    ) {
      prev.times = (prev.times ?? 1) + 1
      prev.last = s.last
    } else pressed.push(s)
  }
  const pressedTimes = pressed.map((s) => s.t)

  // Rule 5: typing. Bursts up to 6 s apart with no click between are one burst.
  const bursts = (track.typing ?? [])
    .filter((b) => finite(b.t) && finite(b.end))
    .map((b) => ({ t0: b.t, t1: Math.max(b.t, b.end) }))
    .sort((a, b) => a.t0 - b.t0)
  const runs: { t0: number; t1: number }[] = []
  for (const b of bursts) {
    const cur = runs[runs.length - 1]
    if (cur) {
      const i = upperBound(clickTimes, cur.t1)
      const clickBetween = i < clickTimes.length && clickTimes[i] < b.t0
      if (b.t0 - cur.t1 <= STEP_RULES.typingPauseS + EPS && !clickBetween) {
        cur.t1 = Math.max(cur.t1, b.t1)
        continue
      }
    }
    runs.push({ ...b })
  }
  const typingSteps: Draft[] = []
  /** The step each run became (joined to a click or alone); null when it was too short. */
  const runStep: (Draft | null)[] = []
  for (const r of runs) {
    // The step holding the last click before the burst.
    const i = upperBound(pressedTimes, r.t0) - 1
    const into = i >= 0 ? pressed[i] : null
    if (into && into.kind !== 'drag' && !into.typing && into.last <= r.t0 + EPS && r.t0 - into.last <= STEP_RULES.typingJoinS + EPS) {
      into.typing = { t: r.t0, end: r.t1, place: { x: into.x!, y: into.y! } }
      into.last = Math.max(into.last, r.t1)
      runStep.push(into)
      continue
    }
    if (r.t1 - r.t0 < STEP_RULES.typingMinS - EPS) {
      runStep.push(null)
      continue
    }
    // The field typed into: the last click up to 10 s before, else the cursor where it began.
    const k = upperBound(clickTimes, r.t0) - 1
    const field = k >= 0 && r.t0 - clicks[k].t <= TYPING_CLICK_WINDOW ? clicks[k] : null
    const cursor = field ? null : cursorAt(samples, r.t0)
    const place = field ? { x: field.x, y: field.y } : cursor ? { x: clamp01(cursor.x), y: clamp01(cursor.y) } : { x: 0.5, y: 0.5 }
    const step: Draft = { key: stepKey('type', r.t0), t: r.t0, kind: 'type', typing: { t: r.t0, end: r.t1, place }, last: r.t1 }
    typingSteps.push(step)
    runStep.push(step)
  }
  const runEnds = runs.map((r) => r.t1)
  const runStarts = runs.map((r) => r.t0)

  // Rule 6: key presses outside the bursts; Enter or Tab just after a burst joins it.
  const keySteps: Draft[] = []
  const keys = (track.keys ?? []).filter((k) => finite(k.t) && typeof k.label === 'string' && k.label.trim()).sort((a, b) => a.t - b.t)
  for (const k of keys) {
    const label = k.label.trim()
    // The run that ended last before the key.
    const j = upperBound(runEnds, k.t - EPS) - 1
    const after = j >= 0 ? runStep[j] : null
    if (after && THEN_KEYS.has(label.toLowerCase()) && !after.then && k.t - runs[j].t1 <= STEP_RULES.keyAfterTypingS + EPS) {
      after.then = label
      after.last = Math.max(after.last, k.t)
      continue
    }
    // Inside a burst: from its start to 0.3 s after its end.
    const r = upperBound(runStarts, k.t) - 1
    if (r >= 0 && k.t <= runs[r].t1 + STEP_RULES.typingTailS + EPS) continue
    keySteps.push({ key: stepKey('keys', k.t), t: k.t, kind: 'keys', keys: label, last: k.t })
  }

  let steps: Draft[] = [...pressed, ...typingSteps, ...keySteps].sort((a, b) => a.t - b.t)

  // The same key repeated in a row is one step, "Press Tab 3 times".
  const merged: Draft[] = []
  for (const s of steps) {
    const prev = merged[merged.length - 1]
    if (prev && prev.kind === 'keys' && s.kind === 'keys' && prev.keys === s.keys && s.t - prev.last <= STEP_RULES.repeatS + EPS) {
      prev.times = (prev.times ?? 1) + 1
      prev.last = s.t
    } else merged.push(s)
  }
  steps = merged

  // Rule 8: no usable clicks: each settled screen change is a step, unless a key press or typing
  // just before it caused it.
  if (!clicks.length && scan) {
    const busy = steps.filter((s) => s.kind === 'keys' || s.kind === 'type').map((s) => ({ from: s.typing ? s.typing.t : s.t, to: s.last + STEP_RULES.screenAfterKeyS }))
    for (const change of screenChanges(scan, track.scrolls)) {
      if (busy.some((b) => change.t >= b.from - EPS && change.t <= b.to + EPS)) continue
      steps.push({ key: stepKey('screen', change.t), t: change.t, kind: 'screen', last: change.t })
    }
    steps.sort((a, b) => a.t - b.t)
  }

  // Rule 7: a scroll followed by a step within 10 s: "Scroll down, then …".
  const starts = steps.map((s) => s.t)
  const scrolls = (track.scrolls ?? []).filter((e) => finite(e.t)).sort((a, b) => a.t - b.t)
  const scrollTimes = scrolls.map((e) => e.t)
  for (const session of scrollSessions(scrolls)) {
    const next = steps[upperBound(starts, session.end - EPS)]
    if (!next || next.t - session.end > STEP_RULES.scrollAheadS + EPS) continue
    next.scroll = scrollWay(scrolls.slice(upperBound(scrollTimes, session.start - EPS), upperBound(scrollTimes, session.end + EPS)))
  }

  // Rule 9: the steps the user added.
  for (const a of project.guide?.added ?? []) steps.push({ key: a.key, t: a.t, kind: 'added', last: a.t })

  // Rule 11: from the step badges; the other recorded steps are listed hidden.
  const badges = project.guide?.from === 'badges' ? badgeSteps(project) : []
  if (badges.length) {
    for (const s of steps) if (s.kind !== 'added') s.hiddenByDefault = true
    steps.push(...badges.map((b) => ({ ...b, last: b.t })))
  }

  steps = steps.filter((s) => isKept(s.t)).sort((a, b) => a.t - b.t || order(a) - order(b))
  return steps.slice(0, STEP_RULES.maxSteps).map(({ last: _last, button: _button, ...s }) => s)
}

/** At equal times: a badge first, then the recorded steps, then the added ones. */
const order = (s: GuideStep): number => (s.kind === 'badge' ? 0 : s.kind === 'added' ? 2 : 1)

/** How many automatically numbered step badges the project has (the panel offers *Steps from* with any). */
export function autoBadgeCount(project: Pick<Project, 'annotations'>): number {
  return (project.annotations ?? []).filter((a) => a.style === 'badge' && a.number === 'auto' && finite(a.start)).length
}

/**
 * The automatically numbered badges as steps (rule 11): at each one's start, at its pin, numbered
 * by badgeLabels; where the count starts again at a user chapter, its title is a section heading.
 */
function badgeSteps(project: StepProject): GuideStep[] {
  const full = project as Project
  const autos = (project.annotations ?? [])
    .filter((a) => a.style === 'badge' && a.number === 'auto' && finite(a.start))
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!autos.length) return []
  const labels = badgeLabels(full)
  const plan = planOf(full)
  const chapters = project.clips.length ? outputChapters(userChapters(project), project.clips, plan) : []
  const byChapter = chapters.length >= 2 && badgesByChapterOf(project.effects ?? {}, chapters.length)
  let chapter = -1
  return autos.map((a) => {
    let section: string | undefined
    if (byChapter) {
      const at = editToVideo(plan, viewAt(project.clips, a.start))
      let i = -1
      while (i + 1 < chapters.length && chapters[i + 1].start <= at + 1e-6) i++
      if (i !== chapter) {
        chapter = i
        if (i >= 0) section = chapters[i].title
      }
    }
    const pin = a.pin && inUnit(a.pin) ? { x: a.pin.x, y: a.pin.y } : undefined
    return {
      key: stepKey('badge', a.start),
      t: a.start,
      kind: 'badge' as const,
      ...(pin ? { place: pin } : {}),
      badge: { label: labels.get(a.id) ?? '', ...(section ? { section } : {}) }
    }
  })
}

/**
 * The steps whose shot may show what was typed in an earlier step (§5.5.7), as step key → the key of
 * the typing step: a burst that ended before the step's shot time, with no settled page change
 * (§7.2, at least 30% of the pixels) between its end and the shot (without a scan, every later shot
 * counts), and a shot that holds the typing place with a margin of 5% of the frame (a whole-screen
 * shot always does). The latest such burst names the step. `shots` and `frame` are in pixels of the
 * recorded frame.
 */
export function typedBefore(
  steps: readonly GuideStep[],
  shots: ReadonlyMap<string, { t: number; rect: Rect; whole: boolean }>,
  scan: SceneScan | null,
  frame: { w: number; h: number }
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  const typed = steps
    .filter((s) => s.typing)
    .map((s) => ({ key: s.key, end: s.typing!.end, place: s.typing!.place }))
    .sort((a, b) => a.end - b.end)
  if (!typed.length) return out
  const ends = typed.map((b) => b.end)
  const pages = scan ? screenChanges(scan).filter((c) => c.page).map((c) => c.t) : []
  const mx = 0.05 * frame.w
  const my = 0.05 * frame.h
  for (const s of steps) {
    const shot = shots.get(s.key)
    if (!shot) continue
    // The last page change up to the shot hides every burst that ended before it.
    const p = upperBound(pages, shot.t) - 1
    const pageAt = p >= 0 ? pages[p] : -Infinity
    for (let i = upperBound(ends, shot.t - EPS) - 1; i >= 0; i--) {
      const b = typed[i]
      if (pageAt > b.end) break
      const px = b.place.x * frame.w
      const py = b.place.y * frame.h
      const r = shot.rect
      if (shot.whole || (px >= r.x - mx && px <= r.x + r.w + mx && py >= r.y - my && py <= r.y + r.h + my)) {
        out.set(s.key, b.key)
        break
      }
    }
  }
  return out
}
