/**
 * The automatic camera director (docs/design/camera-director.md): one click builds the camera
 * track of a recording with a webcam. The full camera for an intro and an outro while the
 * person talks before and after the demo; the bubble during the demo, in a corner kept clear of
 * the cursor and the action (measured where the compositor draws them); the camera hidden in long
 * silences; the face centred by a static webcam framing (faceFraming.ts). What it writes is
 * project data only (layout segments marked `auto`, the framing and Project.director), so the
 * preview and the export draw it alike through drawFrame.
 *
 * Plan and apply are split as in smartSpeed.ts: planDirector is pure and cheap enough to run
 * while the Camera tab is open (the panel shows the plan before it is applied);
 * applyDirectorPlan writes it, inside one store.update (one undo step), recomputed there from the
 * latest project. Segments the user placed are never written over: their layout changes are
 * locked; their camera positions (corner-only segments, from the live bubble or "Move camera
 * here") keep their corner, and what the director puts inside one is cut out of it (`cutOut`),
 * so removing the director's segments gives the position back whole (withoutDirected).
 */
import { mergeRanges, rangesToOutput, type Range } from '../audio/activity'
import { SPEECH, type DirectorSpeech } from '../audio/speech'
import { SmoothedTrack } from '../engine/cursor'
import { framingIsDirectors, framingUntouched } from '../engine/directorData'
import { cornered, LAYOUT_TRANSITION, layoutsApply, segmentCorner } from '../engine/layout'
import { outputDuration, outputToSource } from '../engine/timeline'
import { focusPathFor, zoomStyleOf } from '../engine/zoom'
import { FACE, type FramingOutcome } from '../render/faceFraming'
import type { CameraLayout, Clip, Corner, CursorSample, CursorTrack, DirectorSettings, LayoutSegment, Project } from '../types'
import { cornerCosts, planCorners, type CornerStretch } from './directorCorners'
import { demoSpan, planTimeline, settleTimeline, subtract } from './directorTimeline'
import { cornerOnly } from './layouts'

/** What the director reads of a project. */
export type DirectorProject = Pick<
  Project,
  'duration' | 'clips' | 'layouts' | 'webcam' | 'style' | 'zooms' | 'zoomSettings' | 'width' | 'height' | 'hasWebcam' | 'capture' | 'cursor' | 'watermark' | 'director'
>

export interface DirectorInput {
  project: DirectorProject
  cursor: CursorTrack
  /** The drawn cursor's path (new SmoothedTrack(samples, duration, cursor.smoothing)); built here when absent. Pass the editor's (Editor.tsx) to share it. */
  cursorPath?: SmoothedTrack
  /** The zoom camera's focus path (focusPathFor); built here when absent. */
  focusPath?: SmoothedTrack
  /** When the person talks (speech.ts), or null when the recording has no sound, or it could not be measured. */
  speech: DirectorSpeech | null
  /** Ids of new segments (tests inject a counter; default: like layouts.ts ids, prefixed 'a'). */
  newId?: () => string
}

export type DirectorPartKind = 'intro' | 'outro' | 'hidden' | 'corner'

/** Why the director made a part (shown in the Camera panel's list). */
export type DirectorReason =
  | { kind: 'talk-before' }
  | { kind: 'talk-after' }
  /** A silence of `seconds` (output). */
  | { kind: 'silent'; seconds: number }
  /** The bubble left `avoided`, where the cursor and the action were. */
  | { kind: 'cursor'; avoided: Corner }

/** One change the director makes: an intro, an outro, a hidden part or a bubble corner. */
export interface DirectorPart {
  kind: DirectorPartKind
  layout: CameraLayout
  /** The bubble's corner (corner parts), or the large camera's. */
  corner?: Corner
  /** Output seconds (what the viewer sees). */
  outStart: number
  outEnd: number
  /** Source seconds, from its first written segment's start to its last one's end. */
  start: number
  end: number
  /** Ids of the segments written for it (more than one when a camera position of the user's cuts it). */
  ids: string[]
  reason: DirectorReason
}

/** What the panel says about a plan. */
export type DirectorNote =
  /** The camera is hidden (webcam.show false): nothing to direct. */
  | 'camera-hidden'
  /** No speech is known (no sound recorded, or it could not be measured): no intro, outro or hiding. */
  | 'no-sound'
  /** Sound, but under SPEECH.minTotal of talking: no intro, outro or hiding. */
  | 'no-speech'
  /** Speech from the mixed track (no microphone stem): sounds from the PC count as talking. */
  | 'mixed-sound'
  /** The transcript's word timings decided or refined the speech. */
  | 'transcript'
  /** No mouse or keyboard data (cursor.valid false): no corner moves; the demo is found from zooms only. */
  | 'no-input'
  /** Nothing deliberate happens (no input, no zooms): no intro or outro. */
  | 'no-demo'
  /** The user's camera positions are kept (and the bubble is not moved elsewhere: corners 'keep'). */
  | 'kept-positions'
  /** The user's own layout changes cover nearly all the video (95% or more). */
  | 'all-yours'
  /** Nothing to change. */
  | 'nothing'

/** A stretch of the output timeline by what it shows, for the panel's plan strip. */
export interface DirectorStripItem {
  /** Output seconds. */
  start: number
  end: number
  /** 'yours': a segment the user placed (a layout change, or a camera position). */
  state: 'intro' | 'outro' | 'hidden' | 'bubble' | 'yours'
  /** The bubble's corner ('bubble'). */
  corner?: Corner
}

/** A plan of the director: what applying it writes, and what the panel shows about it. */
export interface DirectorPlan {
  /** The complete new list of layout segments: the user's (camera positions cut where needed) and the director's, sorted, ids kept where unchanged. */
  layouts: LayoutSegment[]
  /** The director's changes, in time order. */
  parts: DirectorPart[]
  /** The options it was made with (resolved, as directorSettingsOf gives them). */
  settings: DirectorSettings
  /** The user's segments kept as they are: layout changes, and camera positions. */
  kept: { changes: number; positions: number }
  notes: DirectorNote[]
  /** Against the director's segments in the project now (by layout, corner, marks and times). */
  diff: { added: number; removed: number; unchanged: number }
  /** Applying would change no segment (the framing aside). */
  upToDate: boolean
  /** Share (0..1) of the output with the camera visible. */
  cameraShare: number
  /** Highest zoom face framing may use: FACE.largeCameraZoom when the result shows the camera large (camera only, large camera, side by side), else FACE.maxZoom. */
  framingCap: number
  /** Source ranges where the result shows the camera (faces are sampled there: faceSampleTimes). */
  cameraShown: Range[]
  /** The whole output timeline by state. */
  strip: DirectorStripItem[]
}

/**
 * The plan for `input` with `settings` (directorSettingsOf). Pure and deterministic: the same
 * project, cursor, speech and settings give the same plan, ids included (a segment equal to one
 * in the project keeps its id). Lengths are planned in output seconds; segments are written in
 * source seconds. With the camera hidden or no webcam, an empty plan with 'camera-hidden'.
 */
export function planDirector(input: DirectorInput, settings: DirectorSettings): DirectorPlan {
  const { project, cursor } = input
  const current = project.layouts ?? []
  if (!layoutsApply(project)) return emptyPlan(current, settings)
  const clips = project.clips
  const total = outputDuration(clips)
  const home = project.webcam.corner
  const newId = input.newId ?? defaultNewId
  const notes: DirectorNote[] = []

  // Step 3: the user's segments, without every earlier result of the director.
  const base = withoutDirected(current)
  const positions = base.filter(cornerOnly)
  const locked = base.filter((s) => !cornerOnly(s))
  const lockedOut = locked.flatMap((seg) => rangesToOutput([seg], clips).map((r) => ({ ...r, seg })))
  const posOut = positions.flatMap((seg) => rangesToOutput([seg], clips).map((r) => ({ ...r, seg, corner: seg.corner as Corner })))
  const lockedRanges = mergeRanges(lockedOut)
  const posRanges = mergeRanges(posOut)

  // Step 4: speech, on the output timeline.
  let speech: Range[] | null = input.speech ? rangesToOutput(input.speech.ranges, clips) : null
  if (!input.speech) notes.push('no-sound')
  else if (lengthOf(speech!) < SPEECH.minTotal) {
    notes.push('no-speech')
    speech = null
  } else if (input.speech.source === 'transcript' || input.speech.refined) notes.push('transcript')
  else if (input.speech.source === 'mix') notes.push('mixed-sound')

  // Step 5: the demo.
  const demo = demoSpan(cursor, project.zooms, clips, zoomStyleOf(project))
  if (!cursor.valid) notes.push('no-input')
  if (!demo) notes.push('no-demo')

  // Steps 6-9, then the anti-flicker rule again with the camera positions' edges as boundaries.
  const posEdges = uniqueSorted(posOut.flatMap((r) => [r.start, r.end]))
  const timeline = settleTimeline(
    planTimeline({ total, speech, demo, locked: lockedRanges, intro: settings.intro !== 'off', hideAfter: settings.hideAfter }),
    speech,
    total,
    posEdges
  )

  // Step 10: corners in the free bubble time (camera positions keep theirs).
  const free = subtract(timeline.shown, posRanges)
  let bubble: Run[]
  if (settings.corners === 'auto' && cursor.valid && cursor.samples.length > 0 && free.length > 0) {
    const cursorPath = input.cursorPath ?? smoothedFor(cursor.samples, project.duration, project.cursor.smoothing)
    const focusPath = input.focusPath ?? focusFor(cursor.samples, project.duration)
    const costs = cornerCosts(project, cursor, cursorPath, focusPath)
    const stretches = free.map((r, i) => stretchOf(r, i > 0 ? free[i - 1].end : -Infinity, posOut, lockedOut, home))
    bubble = planCorners(costs, stretches, home).map((r) => ({ ...r, kind: 'bubble' as const }))
  } else {
    bubble = free.map((r) => ({ ...r, kind: 'bubble' as const, corner: home }))
  }

  // Step 11: the director's runs (output seconds), snapped onto the camera positions' edges.
  const runs = snapRuns(
    [
      ...(timeline.intro ? [{ ...timeline.intro, kind: 'intro' as const }] : []),
      ...timeline.hidden.map((r) => ({ ...r, kind: 'hidden' as const })),
      ...bubble,
      ...(timeline.outro ? [{ ...timeline.outro, kind: 'outro' as const }] : [])
    ].sort((a, b) => a.start - b.start),
    posEdges,
    lockedRanges,
    total
  )

  // Where the bubble is seen (free time and the camera positions not covered by a run), for a large camera's corner.
  const seen = [
    ...runs.filter((r) => r.kind === 'bubble').map((r) => ({ start: r.start, end: r.end, corner: r.corner as Corner })),
    ...posOut.flatMap((p) => subtract([p], runs).map((r) => ({ ...r, corner: p.corner })))
  ].sort((a, b) => a.start - b.start)

  // Step 12: writing, in source seconds.
  const toSource = (o: number): number => (o <= 1e-9 ? clips[0].start : o >= total - 1e-9 ? clips[clips.length - 1].end : outputToSource(clips, o).time)
  const lockedSrc = locked.map((s) => ({ start: s.start, end: s.end }))
  const posSrc = positions.map((s) => ({ start: s.start, end: s.end }))
  const written: { run: Run; layout: CameraLayout; corner?: Corner; start: number; end: number }[] = []
  const directed: DirectedRun[] = []
  for (const run of runs) {
    let layout: CameraLayout
    let corner: Corner | undefined
    if (run.kind === 'intro' || run.kind === 'outro') {
      layout = settings.intro === 'camera-large' ? 'camera-large' : 'camera-only'
      if (layout === 'camera-large') {
        const next = run.kind === 'intro' ? seen.find((r) => r.start >= run.end - 1e-6) : seen.filter((r) => r.end <= run.start + 1e-6).pop()
        corner = next && next.corner !== home ? next.corner : undefined
      }
    } else if (run.kind === 'hidden') {
      layout = 'screen-only'
    } else {
      if (run.corner === home) continue
      layout = 'default'
      corner = run.corner
    }
    const start = toSource(run.start)
    const end = toSource(run.end)
    // Never over the user's layout changes (even inside a cut); a bubble corner never inside a camera position.
    for (const piece of subtract([{ start, end }], layout === 'default' ? [...lockedSrc, ...posSrc] : lockedSrc)) {
      if (piece.end - piece.start < MIN_WRITTEN) continue
      directed.push({ ...piece, layout, ...(corner ? { corner } : {}) })
    }
    written.push({ run, layout, corner, start, end })
  }

  let layouts = withIds(spliceDirected(base, directed, newId), base, current, newId)
  const upToDate = sameList(layouts, current)
  if (upToDate) layouts = current

  // Step 14: what the panel shows.
  const parts: DirectorPart[] = []
  const gaps = speech ? subtract([{ start: 0, end: total }], speech) : []
  for (const w of written) {
    const segs = layouts.filter((s) => s.auto && s.layout === w.layout && s.start < w.end - 1e-9 && s.end > w.start + 1e-9)
    if (!segs.length) continue
    const { run } = w
    const reason: DirectorReason =
      run.kind === 'intro'
        ? { kind: 'talk-before' }
        : run.kind === 'outro'
          ? { kind: 'talk-after' }
          : run.kind === 'hidden'
            ? { kind: 'silent', seconds: Math.max(0, ...gaps.filter((g) => g.start < run.end && g.end > run.start).map((g) => g.end - g.start)) }
            : { kind: 'cursor', avoided: seen.filter((r) => r.end <= run.start + 1e-6).pop()?.corner ?? home }
    parts.push({
      kind: run.kind === 'bubble' ? 'corner' : run.kind,
      layout: w.layout,
      ...(w.corner ? { corner: w.corner } : {}),
      outStart: run.start,
      outEnd: run.end,
      start: Math.min(...segs.map((s) => s.start)),
      end: Math.max(...segs.map((s) => s.end)),
      ids: segs.map((s) => s.id),
      reason
    })
  }

  const kept = keptRanges(clips)
  const hiddenSrc = layouts.filter((s) => s.layout === 'screen-only').map((s) => ({ start: s.start, end: s.end }))
  const cameraShown = subtract(kept, hiddenSrc)
  const large = layouts.some((s) => LARGE_LAYOUTS.includes(s.layout) && kept.some((k) => s.start < k.end && s.end > k.start))

  if (positions.length && settings.corners === 'keep') notes.push('kept-positions')
  if (total > 0 && lengthOf(lockedRanges) >= ALL_YOURS * total) notes.push('all-yours')
  if (!parts.length) notes.push('nothing')

  return {
    layouts,
    parts,
    settings,
    kept: { changes: locked.length, positions: positions.length },
    notes,
    diff: diffOf(layouts, current),
    upToDate,
    cameraShare: total > 0 ? lengthOf(rangesToOutput(cameraShown, clips)) / total : 0,
    framingCap: large ? FACE.largeCameraZoom : FACE.maxZoom,
    cameraShown,
    strip: stripOf(runs, lockedRanges, posRanges, total, home)
  }
}

/**
 * `layouts` without the director's segments: every `auto` segment dropped, and each run of a
 * camera position's pieces and the director's cut-outs (touching, same corner) joined back into
 * one corner-only segment, with the id of its first piece of the user's (else of its first
 * cut-out, which the director gave the position's id when it covered it whole). The exact inverse
 * of what planDirector writes: withoutDirected(plan.layouts) equals the base it planned on.
 */
export function withoutDirected(layouts: readonly LayoutSegment[] | undefined): LayoutSegment[] {
  // The director's own segments go; its cut-outs stay to be joined back into their positions.
  const list = byStart(layouts ?? []).filter((s) => !s.auto || isCutOut(s))
  const member = (s: LayoutSegment): boolean => isCutOut(s) || (cornerOnly(s) && !s.auto)
  const out: LayoutSegment[] = []
  for (let i = 0; i < list.length; ) {
    const first = list[i]
    if (!member(first)) {
      out.push(first)
      i++
      continue
    }
    let j = i + 1
    while (j < list.length && member(list[j]) && list[j].corner === first.corner && Math.abs(list[j].start - list[j - 1].end) <= 1e-6) j++
    const run = list.slice(i, j)
    if (run.some((s) => s.auto)) {
      const keep = run.find((s) => !s.auto) ?? run[0]
      const { auto: _auto, cutOut: _cutOut, ...rest } = keep
      void _auto
      void _cutOut
      out.push({ ...rest, start: run[0].start, end: run[run.length - 1].end, layout: 'default', corner: first.corner })
    } else {
      out.push(...run)
    }
    i = j
  }
  return out
}

/** A layout the director writes over a source range (before it is cut into camera positions). */
export interface DirectedRun {
  start: number
  end: number
  layout: CameraLayout
  corner?: Corner
}

/**
 * `runs` (source seconds, sorted, not overlapping the user's layout changes) written over `base`
 * (no director's segments): in free time each becomes an `auto` segment; inside a camera position
 * P it is cut out of P ({ auto, cutOut, corner: P.corner }), and P keeps the pieces before and
 * after (a piece shorter than LAYOUT_TRANSITION before, or 2 * LAYOUT_TRANSITION after, joins the
 * cut-out, as layoutInStay does). P's id stays on its first remaining piece, else on its first
 * cut-out; other pieces get new ids. Touching auto segments alike are joined. Sorted.
 */
export function spliceDirected(base: readonly LayoutSegment[], runs: readonly DirectedRun[], newId: () => string): LayoutSegment[] {
  const positions = base.filter((s) => cornerOnly(s) && !s.auto)
  const out: LayoutSegment[] = base.filter((s) => !positions.includes(s))
  const cuts = new Map<LayoutSegment, { start: number; end: number; layout: CameraLayout }[]>()
  const free: LayoutSegment[] = []
  for (const run of [...runs].sort((a, b) => a.start - b.start)) {
    if (!(run.end > run.start)) continue
    // Inside a camera position: cut out of it (the bubble's own corner there is the position's).
    for (const p of positions) {
      const start = Math.max(run.start, p.start)
      const end = Math.min(run.end, p.end)
      if (end - start < MIN_WRITTEN || run.layout === 'default') continue
      let list = cuts.get(p)
      if (!list) cuts.set(p, (list = []))
      list.push({ start, end, layout: run.layout })
    }
    for (const piece of subtract([run], positions)) {
      if (piece.end - piece.start < MIN_WRITTEN) continue
      const prev = free[free.length - 1]
      if (prev && Math.abs(prev.end - piece.start) <= 1e-9 && prev.layout === run.layout && prev.corner === run.corner) prev.end = piece.end
      else free.push({ id: newId(), start: piece.start, end: piece.end, layout: run.layout, ...(run.corner ? { corner: run.corner } : {}), auto: true })
    }
  }
  for (const p of positions) {
    const list = cuts.get(p)
    if (!list) {
      out.push(p)
      continue
    }
    const merged: { start: number; end: number; layout: CameraLayout }[] = []
    for (const c of list.sort((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1]
      if (last && Math.abs(last.end - c.start) <= 1e-9 && last.layout === c.layout) last.end = c.end
      else merged.push({ ...c })
    }
    // Pieces of the position too short for their own change join the cut-outs, as layoutInStay does.
    if (merged[0].start - p.start < LAYOUT_TRANSITION) merged[0].start = p.start
    for (let i = 1; i < merged.length; i++) if (merged[i].start - merged[i - 1].end < 2 * LAYOUT_TRANSITION) merged[i - 1].end = merged[i].start
    const last = merged[merged.length - 1]
    if (p.end - last.end < 2 * LAYOUT_TRANSITION) last.end = p.end
    const pieces = subtract([p], merged)
    pieces.forEach((r, i) => out.push({ ...p, id: i === 0 ? p.id : newId(), start: r.start, end: r.end }))
    merged.forEach((c, i) =>
      out.push({ id: !pieces.length && i === 0 ? p.id : newId(), start: c.start, end: c.end, layout: c.layout, corner: p.corner, auto: true, cutOut: true })
    )
  }
  return [...out, ...free].sort((a, b) => a.start - b.start)
}

/**
 * The project with `plan` applied, as one edit: its layouts; Project.director = plan.settings
 * with `framed`; and, for a 'framed' outcome while the director may frame (the option on), the
 * webcam's zoom, cropX and cropY (unless within FACE.nearZoom / nearCrop of the current ones).
 * `framed` is the framing written now, else kept only while the webcam still shows it. Returns
 * `project` itself when nothing changes, so store.update adds no undo step.
 */
export function applyDirectorPlan(project: Project, plan: DirectorPlan, framing: FramingOutcome): Project {
  const layouts = sameList(project.layouts ?? [], plan.layouts) ? project.layouts : plan.layouts
  let webcam = project.webcam
  const was = framingIsDirectors(webcam, project.director) ? project.director?.framed : undefined
  let framed: Framing | undefined = was
  if (framing.status === 'framed' && plan.settings.frameFace) {
    const near =
      Math.abs(framing.zoom - (webcam.zoom ?? 1)) <= FACE.nearZoom + 1e-9 &&
      Math.abs(framing.cropX - (webcam.cropX ?? 0.5)) <= FACE.nearCrop + 1e-9 &&
      Math.abs(framing.cropY - (webcam.cropY ?? 0.5)) <= FACE.nearCrop + 1e-9
    if (!near) {
      webcam = { ...webcam, zoom: framing.zoom, cropX: framing.cropX, cropY: framing.cropY }
      framed = { zoom: framing.zoom, cropX: framing.cropX, cropY: framing.cropY }
    }
  }
  const { framed: _saved, ...options } = plan.settings
  void _saved
  const director: DirectorSettings = framed ? { ...options, framed: { ...framed } } : options
  const sameDirector = sameSettings(project.director, director)
  if (layouts === project.layouts && webcam === project.webcam && sameDirector) return project
  return { ...project, layouts: layouts ?? [], webcam, director: sameDirector ? project.director : director }
}

/**
 * "Remove automatic changes": the project without the director's segments (withoutDirected), its
 * framing reset (zoom, cropX, cropY removed) only while it is still the director's, and
 * `director.framed` dropped (the options stay). `project` itself when there is nothing to remove.
 */
export function clearDirected(project: Project): Project {
  const layouts = project.layouts?.some((s) => s.auto) ? withoutDirected(project.layouts) : project.layouts
  let webcam = project.webcam
  if (!framingUntouched(webcam) && framingIsDirectors(webcam, project.director)) {
    const { zoom: _zoom, cropX: _cropX, cropY: _cropY, ...rest } = webcam
    void _zoom
    void _cropX
    void _cropY
    webcam = rest
  }
  let director = project.director
  if (director?.framed) {
    const { framed: _framed, ...rest } = director
    void _framed
    director = rest
  }
  if (layouts === project.layouts && webcam === project.webcam && director === project.director) return project
  return { ...project, layouts, webcam, director }
}

/* ---------- helpers ---------- */

/** Shorter director segments are not written (readLayouts would drop them). */
const MIN_WRITTEN = 0.05
/** A run boundary closer than this (output seconds) to a camera position's edge moves onto it. */
const SNAP = LAYOUT_TRANSITION
/** Layouts that show the camera large (face framing is capped lower then). */
const LARGE_LAYOUTS: readonly CameraLayout[] = ['camera-only', 'camera-large', 'side-by-side']
/** The user's layout changes covering this share of the video: 'all-yours'. */
const ALL_YOURS = 0.95

let idCounter = 0
const defaultNewId = (): string => `a${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A stretch of the output the director decides (output seconds). */
interface Run {
  start: number
  end: number
  kind: 'intro' | 'outro' | 'hidden' | 'bubble'
  corner?: Corner
}

const lengthOf = (ranges: readonly Range[]): number => ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0)

function uniqueSorted(values: readonly number[]): number[] {
  const out: number[] = []
  for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 1e-9) out.push(v)
  return out
}

const keptRanges = (clips: readonly Clip[]): Range[] => mergeRanges(clips.map((c) => ({ start: c.start, end: c.end })))

const pathCache = new WeakMap<CursorSample[], Map<string, SmoothedTrack>>()
function cachedPath(samples: CursorSample[], key: string, make: () => SmoothedTrack): SmoothedTrack {
  let byKey = pathCache.get(samples)
  if (!byKey) pathCache.set(samples, (byKey = new Map()))
  let path = byKey.get(key)
  if (!path) byKey.set(key, (path = make()))
  return path
}
const smoothedFor = (samples: CursorSample[], duration: number, smoothing: number): SmoothedTrack =>
  cachedPath(samples, `cursor:${duration}:${smoothing}`, () => new SmoothedTrack(samples, duration, smoothing))
const focusFor = (samples: CursorSample[], duration: number): SmoothedTrack => cachedPath(samples, `focus:${duration}`, () => focusPathFor(samples, duration))

interface OutSeg extends Range {
  seg: LayoutSegment
}

/**
 * A free stretch of bubble time for the corner search: from the start of the video the bubble is
 * shown at home (leaving it is a move); otherwise a camera position or a cornered layout
 * change of the user's touching its start shows the camera there (entry, visible); else the
 * bubble appears where it was last seen (a position or layout change after the previous
 * stretch, else that stretch's last corner: null). A position touching its end is its exit.
 */
function stretchOf(r: Range, prevEnd: number, positions: readonly (OutSeg & { corner: Corner })[], locked: readonly OutSeg[], home: Corner): CornerStretch {
  const exit = positions.find((p) => Math.abs(p.start - r.end) <= 1e-6)?.corner ?? null
  // The video opens on the bubble at home: leaving it is a move, as from a visible bubble.
  if (r.start <= 1e-9) return { start: r.start, end: r.end, entry: home, enterVisible: true, exit }
  const pos = positions.find((p) => Math.abs(p.end - r.start) <= 1e-6)
  if (pos) return { start: r.start, end: r.end, entry: pos.corner, enterVisible: true, exit }
  const cornerOf = (s: OutSeg): Corner => segmentCorner(s.seg) ?? home
  const lock = locked.find((l) => Math.abs(l.end - r.start) <= 1e-6 && cornered(l.seg.layout))
  if (lock) return { start: r.start, end: r.end, entry: cornerOf(lock), enterVisible: true, exit }
  const before = [...positions, ...locked.filter((l) => cornered(l.seg.layout))].filter((s) => s.end <= r.start + 1e-6).sort((a, b) => a.end - b.end).pop()
  const entry = before && before.end > prevEnd + 1e-6 ? ('corner' in before ? (before.corner as Corner) : cornerOf(before)) : null
  return { start: r.start, end: r.end, entry, enterVisible: false, exit }
}

/**
 * The runs with each boundary closer than SNAP to a camera position's edge moved onto it (never
 * the video's ends or a boundary at a layout change of the user's), so no sliver of a run or of
 * the position is left on either side; then empty runs dropped and equal neighbours joined.
 */
function snapRuns(runs: readonly Run[], edges: readonly number[], locked: readonly Range[], total: number): Run[] {
  const lockedEdges = locked.flatMap((r) => [r.start, r.end])
  const snap = (x: number): number => {
    if (x <= 1e-9 || x >= total - 1e-9 || lockedEdges.some((e) => Math.abs(e - x) <= 1e-6)) return x
    let best = x
    let dist = SNAP
    for (const e of edges) {
      const d = Math.abs(e - x)
      if (d < dist && !locked.some((l) => l.start < Math.max(x, e) && l.end > Math.min(x, e))) {
        best = e
        dist = d
      }
    }
    return best
  }
  const out: Run[] = []
  for (const r of runs) {
    const prev = out[out.length - 1]
    const start = Math.max(snap(r.start), prev?.end ?? -Infinity)
    const end = snap(r.end)
    if (end - start <= 1e-9) continue
    if (prev && Math.abs(prev.end - start) <= 1e-9 && prev.kind === r.kind && prev.corner === r.corner) prev.end = end
    else out.push({ ...r, start, end })
  }
  return out
}

/** The plan strip: the runs, the user's segments, and the bubble at home anywhere else. */
function stripOf(runs: readonly Run[], locked: readonly Range[], positions: readonly Range[], total: number, home: Corner): DirectorStripItem[] {
  const items: DirectorStripItem[] = runs.map((r) => (r.kind === 'bubble' ? { start: r.start, end: r.end, state: 'bubble', corner: r.corner } : { start: r.start, end: r.end, state: r.kind }))
  for (const r of subtract(mergeRanges([...locked, ...positions]), runs)) items.push({ start: r.start, end: r.end, state: 'yours' })
  items.sort((a, b) => a.start - b.start)
  const out: DirectorStripItem[] = []
  let at = 0
  const push = (item: DirectorStripItem): void => {
    const last = out[out.length - 1]
    if (last && last.state === item.state && last.corner === item.corner && Math.abs(last.end - item.start) <= 1e-9) last.end = item.end
    else out.push({ ...item })
  }
  for (const item of items) {
    if (item.start > at + 1e-9) push({ start: at, end: item.start, state: 'bubble', corner: home })
    push(item)
    at = Math.max(at, item.end)
  }
  if (total > at + 1e-9) push({ start: at, end: total, state: 'bubble', corner: home })
  return out
}

/** Whether two segments are the same change: layout, corner, marks and times (within 1e-6). */
const sameSegment = (a: LayoutSegment, b: LayoutSegment): boolean =>
  a.layout === b.layout &&
  (a.corner ?? null) === (b.corner ?? null) &&
  !!a.auto === !!b.auto &&
  !!a.cutOut === !!b.cutOut &&
  Math.abs(a.start - b.start) <= 1e-6 &&
  Math.abs(a.end - b.end) <= 1e-6

/** A cut-out of the director's out of a camera position (as readLayouts keeps the mark). */
const isCutOut = (s: LayoutSegment): boolean => !!s.auto && !!s.cutOut && !!s.corner && s.layout !== 'default'

const byStart = (list: readonly LayoutSegment[]): LayoutSegment[] => [...list].sort((a, b) => a.start - b.start)

function sameList(a: readonly LayoutSegment[], b: readonly LayoutSegment[]): boolean {
  if (a.length !== b.length) return false
  const x = byStart(a)
  const y = byStart(b)
  return x.every((s, i) => s.id === y[i].id && sameSegment(s, y[i]))
}

/**
 * Ids for the segments `spliceDirected` wrote: the user's keep theirs; any other one equal to a
 * segment in the project now takes its id (selection survives, and directing an unchanged
 * project again changes nothing); the rest keep their new ids, made unique.
 */
function withIds(list: LayoutSegment[], base: readonly LayoutSegment[], current: readonly LayoutSegment[], newId: () => string): LayoutSegment[] {
  const baseIds = new Set(base.map((s) => s.id))
  const used = new Set(list.filter((s) => baseIds.has(s.id)).map((s) => s.id))
  const fresh = list.filter((s) => !baseIds.has(s.id))
  const unmatched: LayoutSegment[] = []
  for (const s of fresh) {
    const match = current.find((c) => !used.has(c.id) && sameSegment(c, s))
    if (match) {
      s.id = match.id
      used.add(match.id)
    } else {
      unmatched.push(s)
    }
  }
  const taken = new Set([...used, ...current.map((s) => s.id)])
  for (const s of unmatched) {
    while (taken.has(s.id)) s.id = newId()
    taken.add(s.id)
  }
  return list
}

/** The director's segments against those in the project now. */
function diffOf(layouts: readonly LayoutSegment[], current: readonly LayoutSegment[]): DirectorPlan['diff'] {
  const now = current.filter((s) => s.auto)
  let unchanged = 0
  const matched = new Set<LayoutSegment>()
  for (const s of layouts.filter((x) => x.auto)) {
    const m = now.find((c) => !matched.has(c) && sameSegment(c, s))
    if (m) {
      matched.add(m)
      unchanged++
    }
  }
  return { added: layouts.filter((s) => s.auto).length - unchanged, removed: now.length - unchanged, unchanged }
}

/** The plan with nothing to do (the camera is hidden or there is none). */
function emptyPlan(current: LayoutSegment[], settings: DirectorSettings): DirectorPlan {
  return {
    layouts: current,
    parts: [],
    settings,
    kept: { changes: 0, positions: 0 },
    notes: ['camera-hidden'],
    diff: { added: 0, removed: 0, unchanged: current.filter((s) => s.auto).length },
    upToDate: true,
    cameraShare: 0,
    framingCap: FACE.maxZoom,
    cameraShown: [],
    strip: []
  }
}

type Framing = NonNullable<DirectorSettings['framed']>

const sameFraming = (a: Framing | undefined, b: Framing | undefined): boolean =>
  !a || !b ? !a && !b : a.zoom === b.zoom && a.cropX === b.cropX && a.cropY === b.cropY

const sameSettings = (a: DirectorSettings | undefined, b: DirectorSettings): boolean =>
  !!a && a.intro === b.intro && a.corners === b.corners && a.hideAfter === b.hideAfter && a.frameFace === b.frameFace && sameFraming(a.framed, b.framed)
