/**
 * The progress bar (docs/design/editing-polish.md §8): its layout from the chapters, the band it
 * takes from the text area, its state at a video time, and where its names go. Pure: preview and
 * export ask the same functions of the frame's video time, so they draw the same bar.
 *
 * Users see it as the "Progress bar"; the code keeps the name chapterBar.
 */
import type { Rect } from '../engine/layout'
import { planOf, videoDuration } from '../engine/freeze'
import { clamp } from '../engine/math'
import { isTall } from '../engine/reframeData'
import type { ChapterBar, Clip, Project } from '../types'
import { MIN_CHAPTER_GAP, outputChapters } from './chapters'
import { titlePhase } from './titleCards'

export const CHAPTER_BAR: {
  inset: 0.03
  thick: 0.008
  edgeThick: 0.006
  gap: 0.005
  label: 0.042
  labelTall: 0.036
  labelGap: 0.01
  pillAlpha: 0.55
  grow: 1.5
  growTime: 0.15
  fade: 0.3
  show: 3
  cross: 0.2
} = {
  inset: 0.03,
  thick: 0.008,
  edgeThick: 0.006,
  gap: 0.005,
  label: 0.042,
  labelTall: 0.036,
  labelGap: 0.01,
  pillAlpha: 0.55,
  grow: 1.5,
  growTime: 0.15,
  fade: 0.3,
  show: 3,
  cross: 0.2
}

/** A name's pill: padding of 0.2 em above and below and 0.5 em at the sides, so 1.4 em high. */
const PILL = { padY: 0.2, padX: 0.5 }
/** "All chapters": a name's pill keeps this much (in em) of its segment free, so neighbours never touch. */
const ALL_SPARE = 0.4
/** Fewer graphemes than this left after shortening: the name is left out. */
const MIN_GRAPHEMES = 3
const HEX = /^#[0-9a-f]{6}$/i
/** The first strong letter is from a right-to-left script (captions/layout.ts's RTL_FIRST). */
const RTL_FIRST = /^[^\p{L}]*[֐-ࣿיִ-﷿ﹰ-﻿]/u

export interface BarSegment {
  from: number
  to: number
  title: string | null
  x0: number
  x1: number
}

export interface BarLayout {
  edge: 'top' | 'bottom'
  x0: number
  x1: number
  y: number
  th: number
  gap: number
  round: boolean
  color: string
  labels: ChapterBar['labels']
  labelPx: number
  segments: BarSegment[]
}

/**
 * Whether the captions show and sit in the top half of a w x h frame: a Captions Studio block at
 * Top or Upper (or dragged above the middle), or the legacy look at Top. Captions show when they
 * are on and the transcript has any.
 */
export function captionsAtTop(project: Project, w: number, h: number): boolean {
  void w
  void h
  const c = project.captions
  if (!c?.show || !project.transcript?.segments?.length) return false
  const layout = c.studio?.layout
  if (layout) {
    if (layout.place && Number.isFinite(layout.place.y)) return layout.place.y < 0.5
    return layout.position === 'top' || layout.position === 'upper'
  }
  return c.position === 'top'
}

/** The bar's edge: Top or Bottom as chosen; Auto is the top unless the captions sit in the top half. */
function edgeOf(project: Project, bar: ChapterBar, w: number, h: number): 'top' | 'bottom' {
  if (bar.place === 'top' || bar.place === 'bottom') return bar.place
  return captionsAtTop(project, w, h) ? 'bottom' : 'top'
}

/** Edge draws flush with the frame, except in a tall frame with app-safe zones on (the apps cover the edges): Floating there. */
const flushOf = (project: Project, bar: ChapterBar, w: number, h: number): boolean => bar.style === 'edge' && !(isTall(w, h) && project.reframe?.appSafe === true)

interface Segments {
  clips: Clip[]
  chapters: Project['chapters']
  freezes: Project['freezes']
  total: number
  list: { from: number; to: number; title: string | null }[]
}
const segmentMemo = new WeakMap<Clip[], Segments>()

/**
 * The bar's segments in video seconds (holds included): one per chapter of the exported video
 * (outputChapters), plus an unlabelled first segment when the first chapter starts after 0.1 s;
 * one plain segment with fewer than two chapters.
 */
function segmentsOf(project: Project): Segments {
  const hit = segmentMemo.get(project.clips)
  if (hit && hit.chapters === project.chapters && hit.freezes === project.freezes) return hit
  const plan = planOf(project)
  const total = Math.max(0, videoDuration(project.clips, plan))
  const chapters = outputChapters(project.chapters ?? [], project.clips, plan)
  let list: Segments['list']
  if (chapters.length < 2) {
    list = [{ from: 0, to: total, title: null }]
  } else {
    list = []
    if (chapters[0].start > MIN_CHAPTER_GAP) list.push({ from: 0, to: chapters[0].start, title: null })
    chapters.forEach((c, i) => list.push({ from: list.length === 0 ? 0 : c.start, to: i + 1 < chapters.length ? chapters[i + 1].start : total, title: c.title }))
  }
  const out: Segments = { clips: project.clips, chapters: project.chapters, freezes: project.freezes, total, list }
  segmentMemo.set(project.clips, out)
  return out
}

/** Whether the bar shows names: a choice other than None, and two chapters or more in the video. */
function namesShown(project: Project, bar: ChapterBar): boolean {
  return bar.labels !== 'none' && segmentsOf(project).list.filter((s) => s.title !== null).length >= 2
}

/** The names' size in px: 0.042 S in wide and square frames, 0.036 S in tall ones. */
const labelPxOf = (w: number, h: number): number => (isTall(w, h) ? CHAPTER_BAR.labelTall : CHAPTER_BAR.label) * Math.min(w, h)

/**
 * The bar in a w x h frame inside `area` (the text area without the bar, null: the whole frame),
 * or null when it does not show. Floating: inset 0.03 S from the area's edges, 0.008 S thick, round
 * ends. Edge: the frame's full width, 0.006 S thick, flush with its top or bottom, square ends.
 * Segments are their shares of the length, less half a gap at each inner end; one narrower than
 * half a gap is drawn half a gap wide, centred on its share.
 */
export function chapterBarLayout(project: Project, w: number, h: number, area: Rect | null): BarLayout | null {
  const bar = project.chapterBar
  if (!bar?.show || !(w > 0 && h > 0)) return null
  const S = Math.min(w, h)
  const R = area ?? { x: 0, y: 0, w, h }
  const edge = edgeOf(project, bar, w, h)
  const flush = flushOf(project, bar, w, h)
  const i = CHAPTER_BAR.inset * S
  const th = (flush ? CHAPTER_BAR.edgeThick : CHAPTER_BAR.thick) * S
  const x0 = flush ? 0 : R.x + i
  const x1 = flush ? w : R.x + R.w - i
  const y = flush ? (edge === 'top' ? 0 : h - th) : edge === 'top' ? R.y + i : R.y + R.h - i - th
  const gap = Math.max(2, CHAPTER_BAR.gap * S)
  const { list, total } = segmentsOf(project)
  const L = Math.max(0, x1 - x0)
  const at = (v: number): number => x0 + (total > 0 ? L * clamp(v / total, 0, 1) : 0)
  const segments = list.map((s, k): BarSegment => {
    const a = at(s.from)
    const b = k === list.length - 1 ? x1 : at(s.to)
    let sx0 = k > 0 ? a + gap / 2 : a
    let sx1 = k < list.length - 1 ? b - gap / 2 : b
    if (sx1 - sx0 < gap / 2) {
      const c = (a + b) / 2
      sx0 = c - gap / 4
      sx1 = c + gap / 4
    }
    return { from: s.from, to: s.to, title: s.title, x0: sx0, x1: sx1 }
  })
  const brand = project.brand?.colors?.find((c) => HEX.test(c))
  const color = bar.color && HEX.test(bar.color) ? bar.color : (brand ?? '#ffffff')
  return { edge, x0, x1, y, th, gap, round: !flush, color, labels: namesShown(project, bar) ? bar.labels : 'none', labelPx: labelPxOf(w, h), segments }
}

/**
 * The band the bar takes from the text area at its edge (output px), or null without a bar: the
 * inset and the grown bar (i + 1.5 th), plus 0.01 S and a name's pill (1.4 times the name size)
 * when names show, 0.111 S in a wide frame. Captions, key presses, the logo and lower thirds,
 * which all place themselves in textArea, keep clear of it.
 */
export function barBand(project: Project, w: number, h: number): { edge: 'top' | 'bottom'; size: number } | null {
  const bar = project.chapterBar
  if (!bar?.show || !(w > 0 && h > 0)) return null
  const S = Math.min(w, h)
  const th = (flushOf(project, bar, w, h) ? CHAPTER_BAR.edgeThick : CHAPTER_BAR.thick) * S
  let size = CHAPTER_BAR.inset * S + CHAPTER_BAR.grow * th
  if (namesShown(project, bar)) size += CHAPTER_BAR.labelGap * S + (1 + 2 * PILL.padY) * labelPxOf(w, h)
  return { edge: edgeOf(project, bar, w, h), size }
}

/** The background opacity of the full-frame title cards showing at source time `t` (the strongest). */
function fullFrameCover(project: Project, t: number): number {
  let b = 0
  for (const card of project.titles ?? []) {
    if (card.style === 'lower-third' || card.style === 'quote') continue
    const phase = titlePhase(card, t, project.clips)
    if (phase) b = Math.max(b, clamp(phase.background, 0, 1))
  }
  return b
}

/** Whether a Captions Studio chapter-title card shows at source time `t` (the bar's names would say it twice). */
function chapterTitleShows(project: Project, t: number): boolean {
  return (project.titles ?? []).some((card) => card.auto?.by === 'chapter' && titlePhase(card, t, project.clips) !== null)
}

/**
 * The bar's opacity, its current segment, that segment's growth (1 to 1.5 over 0.15 s of video
 * time after its start, linearly) and its names' opacity at video time `video` (source time `t`).
 * The bar fades in over 0.3 s from the start; with "Show only when a chapter starts", it shows for
 * 3 s from each segment's start with 0.3 s fades. A full-frame title card fades it out with its
 * background (alpha times 1 - b); names hide while a chapter-title card shows.
 */
export function barState(layout: BarLayout, video: number, t: number, project: Project): { alpha: number; current: number; grow: number; labelAlpha: number } {
  const segs = layout.segments
  let current = 0
  for (let k = 1; k < segs.length; k++) if (video >= segs[k].from) current = k
  const seg = segs[current]
  const grow = seg ? 1 + (CHAPTER_BAR.grow - 1) * clamp((video - seg.from) / CHAPTER_BAR.growTime, 0, 1) : 1
  let alpha: number
  if (project.chapterBar?.onlyAtChapters) {
    alpha = 0
    for (let k = current; k >= 0; k--) {
      const e = video - segs[k].from
      if (e > CHAPTER_BAR.show) break
      alpha = Math.max(alpha, clamp(Math.min(e / CHAPTER_BAR.fade, (CHAPTER_BAR.show - e) / CHAPTER_BAR.fade), 0, 1))
    }
  } else {
    alpha = clamp(video / CHAPTER_BAR.fade, 0, 1)
  }
  alpha *= 1 - fullFrameCover(project, t)
  return { alpha, current, grow, labelAlpha: chapterTitleShows(project, t) ? 0 : 1 }
}

/** A name on the bar: its text (shortened when needed), its pill (output px), its opacity and direction. */
export interface BarLabel {
  text: string
  x: number
  y: number
  w: number
  h: number
  alpha: number
  rtl: boolean
}

/** A string's graphemes (Intl.Segmenter), so a Bangla conjunct or an emoji with a skin tone stays whole. */
export function graphemeList(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
  return [...text]
}

/**
 * `text` as it fits in `max` px: whole, or shortened by graphemes with an ellipsis; null when
 * fewer than three graphemes would be left.
 */
export function fitName(text: string, max: number, measure: (s: string) => number): string | null {
  if (measure(text) <= max) return text
  const g = graphemeList(text)
  let lo = MIN_GRAPHEMES
  let hi = g.length - 1
  let best: string | null = null
  while (lo <= hi) {
    const k = (lo + hi) >> 1
    const candidate = `${g.slice(0, k).join('').trimEnd()}…`
    if (measure(candidate) <= max) {
      best = candidate
      lo = k + 1
    } else {
      hi = k - 1
    }
  }
  return best
}

/**
 * The names on the bar at video time `video` (§8): on a pill 1.4 em high, 0.01 S from the grown
 * bar on its inner side. Current chapter: at its segment's start, moved left to stay inside the
 * bar, crossfading with the previous name over 0.2 s; All chapters: each centred over its segment,
 * shortened to the segment's width less 0.4 em, left out when fewer than three graphemes fit.
 * `measure` gives a text's width at the names' size. Opacities here are the names' own (the bar's
 * and labelAlpha multiply them).
 */
export function barLabels(layout: BarLayout, state: { current: number }, video: number, S: number, measure: (text: string) => number): BarLabel[] {
  if (layout.labels === 'none') return []
  const px = layout.labelPx
  const h = (1 + 2 * PILL.padY) * px
  const pad = 2 * PILL.padX * px
  const off = CHAPTER_BAR.grow * layout.th + CHAPTER_BAR.labelGap * S
  const y = layout.edge === 'top' ? layout.y + off : layout.y + layout.th - off - h
  const label = (title: string, maxText: number, place: (w: number) => number, alpha: number): BarLabel | null => {
    const text = fitName(title, maxText, measure)
    if (text === null) return null
    const w = measure(text) + pad
    return { text, x: place(w), y, w, h, alpha, rtl: RTL_FIRST.test(text) }
  }
  const out: BarLabel[] = []
  if (layout.labels === 'all') {
    for (const s of layout.segments) {
      if (s.title === null) continue
      const room = s.x1 - s.x0 - ALL_SPARE * px
      const l = label(s.title, room - pad, (w) => (s.x0 + s.x1) / 2 - w / 2, 1)
      if (l) out.push(l)
    }
    return out
  }
  const room = layout.x1 - layout.x0
  const at = (s: BarSegment, alpha: number): void => {
    if (s.title === null || alpha <= 0) return
    const l = label(s.title, room - pad, (w) => clamp(s.x0, layout.x0, Math.max(layout.x0, layout.x1 - w)), alpha)
    if (l) out.push(l)
  }
  const cur = layout.segments[state.current]
  if (!cur) return out
  const p = clamp((video - cur.from) / CHAPTER_BAR.cross, 0, 1)
  const prev = layout.segments[state.current - 1]
  if (prev && p < 1) at(prev, 1 - p)
  at(cur, state.current === 0 ? 1 : p)
  return out
}

/** The bar a project gets when it is first turned on (§2.4): Auto, Floating, the current chapter's name. */
export const NEW_CHAPTER_BAR: Readonly<ChapterBar> = Object.freeze({ show: true, place: 'auto', style: 'float', labels: 'current' })

/** The project with its bar changed by `patch` (from NEW_CHAPTER_BAR when it has none yet): one update. */
export function withChapterBar(project: Project, patch: Partial<ChapterBar>): Project {
  return { ...project, chapterBar: { ...(project.chapterBar ?? NEW_CHAPTER_BAR), ...patch } }
}
