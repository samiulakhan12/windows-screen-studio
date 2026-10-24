import type { AspectRatio, CameraLayout, Corner, LayoutSegment, Project, StyleSettings, WebcamSettings } from '../types'
import { frameInsets, frameOf } from './deviceFrames'
import { clamp, easeInOutCubic, lerp } from './math'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const RATIOS: Record<Exclude<AspectRatio, 'auto'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Display shapes whose standard sizes an 'auto' export snaps to (16:9, 16:10, 4:3, 3:2, ultrawide, square). */
const STANDARD_RATIOS = [16 / 9, 16 / 10, 4 / 3, 3 / 2, 64 / 27, 43 / 18, 1].flatMap((r) => (r === 1 ? [1] : [r, 1 / r]))

/**
 * Aspect ratio of an 'auto' export. A source within 1% of a standard shape (a
 * 1918x1080 window, a 1366x768 laptop) uses that shape, so 4K is 3840x2160 rather
 * than an off-standard 3834x2160; the recording is fitted inside, so nothing stretches.
 */
export function autoAspect(srcW: number, srcH: number): number {
  const ratio = srcW / srcH
  // The nearest one: 64:27 and 43:18 (3440x1440) are less than 1% apart.
  let best = ratio
  let bestErr = 0.01
  for (const r of STANDARD_RATIOS) {
    const err = Math.abs(ratio / r - 1)
    if (err < bestErr) {
      best = r
      bestErr = err
    }
  }
  return best
}

/** Output frame size for an aspect ratio, given the target height (the shorter side for portrait). */
export function outputSize(aspect: AspectRatio, srcW: number, srcH: number, height: number): { width: number; height: number } {
  const ratio = aspect === 'auto' ? autoAspect(srcW, srcH) : RATIOS[aspect]
  if (ratio >= 1) return { width: even(height * ratio), height: even(height) }
  // Portrait: keep the long side at `height * 16/9`-ish by treating `height` as the width.
  return { width: even(height), height: even(height / ratio) }
}

/** Rectangle where the recording is drawn: fitted inside the padded output, centred. */
export function contentRect(outW: number, outH: number, srcW: number, srcH: number, padding: number): Rect {
  const pad = Math.min(outW, outH) * padding
  const availW = Math.max(1, outW - pad * 2)
  const availH = Math.max(1, outH - pad * 2)
  const scale = Math.min(availW / srcW, availH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (outW - w) / 2, y: (outH - h) / 2, w, h }
}

/**
 * Rectangle where the recording itself is drawn for a style: inside the padding, leaving room
 * for the device frame's chrome (title bar, bezels, laptop base) around it. Every caller that
 * maps between the output frame and the recording goes through this.
 */
export function styleContentRect(outW: number, outH: number, srcW: number, srcH: number, style: Pick<StyleSettings, 'padding' | 'frame'>): Rect {
  const frame = frameOf(style)
  if (!frame) return contentRect(outW, outH, srcW, srcH, style.padding)
  // The chrome is sized in multiples of the recording's shorter side, so the whole device
  // grows linearly with the recording: fit that, then centre the device (not the recording).
  const ins = frameInsets(frame.kind, srcW > srcH)
  const pad = Math.min(outW, outH) * style.padding
  const availW = Math.max(1, outW - pad * 2)
  const availH = Math.max(1, outH - pad * 2)
  const m = Math.min(srcW, srcH)
  const scale = Math.min(availW / (srcW + (ins.left + ins.right) * m), availH / (srcH + (ins.top + ins.bottom) * m))
  const u = m * scale
  const w = srcW * scale
  const h = srcH * scale
  const outerW = w + (ins.left + ins.right) * u
  const outerH = h + (ins.top + ins.bottom) * u
  return { x: (outW - outerW) / 2 + ins.left * u, y: (outH - outerH) / 2 + ins.top * u, w, h }
}

export function webcamRect(outW: number, outH: number, settings: Pick<WebcamSettings, 'corner' | 'size'>): Rect {
  const size = Math.min(outW, outH) * settings.size
  const margin = Math.min(outW, outH) * 0.04
  const corner: Corner = settings.corner
  const x = corner.endsWith('left') ? margin : outW - margin - size
  const y = corner.startsWith('top') ? margin : outH - margin - size
  return { x, y, w: size, h: size }
}


/* ---------- camera layouts ---------- */

/** Seconds a change of camera layout takes to animate. */
export const LAYOUT_TRANSITION = 0.4
/** Smallest size of the camera in the 'camera-large' layout (fraction of the output's shorter side). */
const LARGE_CAMERA = 0.56
/** The camera card next to the screen is 3:4 beside it and 4:3 above or below it. */
const SIDE_CAMERA_ASPECT = 3 / 4
/** Gap between the screen and the camera card (fraction of the output's shorter side). */
const SIDE_GAP = 0.03
/** A hidden camera shrinks to this much of its bubble while it fades out. */
const HIDDEN_SCALE = 0.6
/** Size of the screen hidden under a camera that fills the frame (well inside it, shadow and all). */
const BEHIND_SCALE = 0.5
/** Layout segments closer than this (seconds) are back to back: one changes straight into the next. */
const ADJACENT = 1e-3

/** Where the camera is drawn (output px), its corner radius and its opacity (0: hidden). */
export interface CameraBox {
  rect: Rect
  radius: number
  opacity: number
}

/** The screen and the camera at one moment. `moving`: the screen's rectangle is animating between layouts. */
export interface SceneLayout {
  screen: Rect
  camera: CameraBox | null
  moving: boolean
}

/** What the layout of a frame depends on (clips and duration only decide where changes animate). */
export type SceneProject = Pick<Project, 'style' | 'layouts' | 'webcam' | 'hasWebcam'> & Partial<Pick<Project, 'clips' | 'duration'>>

/** Corner radius of a camera of `shape` drawn in `r`. */
export function cameraRadius(shape: WebcamSettings['shape'], r: Rect): number {
  if (shape === 'circle') return Math.min(r.w, r.h) / 2
  if (shape === 'square') return 0
  return Math.min(r.w, r.h) * 0.18
}

const scaleRect = (r: Rect, s: number): Rect => ({ x: r.x + (r.w * (1 - s)) / 2, y: r.y + (r.h * (1 - s)) / 2, w: r.w * s, h: r.h * s })

export const lerpRect = (a: Rect, b: Rect, e: number): Rect => ({ x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), w: lerp(a.w, b.w, e), h: lerp(a.h, b.h, e) })

/** The area inside the padding, where the cards go. */
function paddedArea(outW: number, outH: number, padding: number): Rect {
  const pad = Math.min(outW, outH) * padding
  return { x: pad, y: pad, w: Math.max(1, outW - pad * 2), h: Math.max(1, outH - pad * 2) }
}

/** Width / height of the recording together with its device frame's chrome. */
function screenOuterAspect(srcW: number, srcH: number, style: Pick<StyleSettings, 'frame'>): number {
  const frame = frameOf(style)
  if (!frame) return srcW / srcH
  const ins = frameInsets(frame.kind, srcW > srcH)
  const m = Math.min(srcW, srcH)
  return (srcW + (ins.left + ins.right) * m) / (srcH + (ins.top + ins.bottom) * m)
}

/** The recording fitted into `slot` with its device frame around it, as styleContentRect fits it into the frame. */
function fitScreen(slot: Rect, srcW: number, srcH: number, style: Pick<StyleSettings, 'frame'>): Rect {
  const r = styleContentRect(slot.w, slot.h, srcW, srcH, { padding: 0, frame: style.frame })
  return { x: slot.x + r.x, y: slot.y + r.y, w: r.w, h: r.h }
}

/**
 * Screen and camera cards next to each other inside the padding: side by side (a tall camera)
 * or stacked (a wide camera), whichever shows the screen larger. The camera goes on the side
 * of its corner.
 */
function sideBySide(project: SceneProject, outW: number, outH: number, srcW: number, srcH: number): { screen: Rect; camera: Rect } {
  const area = paddedArea(outW, outH, project.style.padding)
  const gap = Math.min(outW, outH) * SIDE_GAP
  const a = screenOuterAspect(srcW, srcH, project.style)
  const tall = Math.max(1, Math.min(area.h, (area.w - gap) / (SIDE_CAMERA_ASPECT + a)))
  const wide = Math.max(1, Math.min(area.w, (area.h - gap) / (SIDE_CAMERA_ASPECT + 1 / a)))
  const { corner } = project.webcam
  if (tall * tall * a >= (wide * wide) / a) {
    const cw = tall * SIDE_CAMERA_ASPECT
    const sw = tall * a
    const x0 = area.x + (area.w - (cw + gap + sw)) / 2
    const y = area.y + (area.h - tall) / 2
    const left = corner.endsWith('left')
    return {
      screen: fitScreen({ x: left ? x0 + cw + gap : x0, y, w: sw, h: tall }, srcW, srcH, project.style),
      camera: { x: left ? x0 : x0 + sw + gap, y, w: cw, h: tall }
    }
  }
  const ch = wide * SIDE_CAMERA_ASPECT
  const sh = wide / a
  const x = area.x + (area.w - wide) / 2
  const y0 = area.y + (area.h - (ch + gap + sh)) / 2
  const top = corner.startsWith('top')
  return {
    screen: fitScreen({ x, y: top ? y0 + ch + gap : y0, w: wide, h: sh }, srcW, srcH, project.style),
    camera: { x, y: top ? y0 : y0 + sh + gap, w: wide, h: ch }
  }
}

/**
 * Where the screen and the camera are in `layout`, standing still. The camera keeps its
 * bubble shape over the screen; as a card (filling the frame, or next to the screen) it takes
 * the screen's corner radius. A hidden camera is its bubble, smaller and fully transparent,
 * so it fades out where it was.
 */
export function layoutGeometry(layout: CameraLayout, project: SceneProject, outW: number, outH: number, srcW: number, srcH: number): { screen: Rect; camera: CameraBox } {
  const base = styleContentRect(outW, outH, srcW, srcH, project.style)
  const card = project.style.cornerRadius * (Math.min(outW, outH) / 1080)
  const { webcam } = project
  switch (layout) {
    case 'camera-only':
      return { screen: scaleRect(base, BEHIND_SCALE), camera: { rect: paddedArea(outW, outH, project.style.padding), radius: card, opacity: 1 } }
    case 'side-by-side': {
      const g = sideBySide(project, outW, outH, srcW, srcH)
      return { screen: g.screen, camera: { rect: g.camera, radius: card, opacity: 1 } }
    }
    case 'camera-large': {
      const r = webcamRect(outW, outH, { corner: webcam.corner, size: Math.max(LARGE_CAMERA, Math.min(0.8, webcam.size * 2)) })
      return { screen: base, camera: { rect: r, radius: cameraRadius(webcam.shape, r), opacity: 1 } }
    }
    case 'screen-only': {
      const r = scaleRect(webcamRect(outW, outH, webcam), HIDDEN_SCALE)
      return { screen: base, camera: { rect: r, radius: cameraRadius(webcam.shape, r), opacity: 0 } }
    }
    default: {
      const r = webcamRect(outW, outH, webcam)
      return { screen: base, camera: { rect: r, radius: cameraRadius(webcam.shape, r), opacity: 1 } }
    }
  }
}

/** The layouts that place the screen alike: changing between them leaves the screen still. */
const screenPlace = (l: CameraLayout): string => (l === 'camera-only' || l === 'side-by-side' ? l : 'base')

/** Whether the camera layouts of `project` apply: a recording with a camera that is shown. */
export const layoutsApply = (project: Pick<Project, 'hasWebcam' | 'webcam'>): boolean => project.hasWebcam && project.webcam.show

const sortedLists = new WeakMap<LayoutSegment[], LayoutSegment[]>()

/** The usable segments of `list` by start time (cached per list: the render path asks every frame). */
export function sortedLayouts(list: LayoutSegment[]): LayoutSegment[] {
  let sorted = sortedLists.get(list)
  if (!sorted) {
    sorted = list.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).sort((a, b) => a.start - b.start)
    sortedLists.set(list, sorted)
  }
  return sorted
}

/** A layout change in progress: from which layout to which, and how far it has got (1 = settled). */
export interface LayoutPhase {
  from: CameraLayout
  to: CameraLayout
  progress: number
}

const SETTLED: LayoutPhase = { from: 'default', to: 'default', progress: 1 }

/**
 * The layout change at `t`. A segment's layout animates in over its first LAYOUT_TRANSITION
 * seconds and back to 'default' over its last ones, like a zoom; back-to-back segments change
 * straight from one layout to the next at the second one's start. A change at the very start or
 * end of the edit is instant, so the video starts (and ends) in that layout.
 */
export function layoutPhaseAt(project: Omit<SceneProject, 'style'>, t: number): LayoutPhase {
  const list = project.layouts
  if (!list || list.length === 0 || !layoutsApply(project)) return SETTLED
  const blocks = sortedLayouts(list)
  let lo = 0
  let hi = blocks.length - 1
  let i = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (blocks[mid].start <= t) {
      i = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (i < 0 || t >= blocks[i].end) return SETTLED
  const b = blocks[i]
  const prev = blocks[i - 1]
  const next = blocks[i + 1]
  const from: CameraLayout = prev && b.start - prev.end <= ADJACENT ? prev.layout : 'default'
  const nextAdjacent = !!next && next.start - b.end <= ADJACENT
  const keptStart = project.clips?.length ? project.clips[0].start : 0
  const keptEnd = project.clips?.length ? project.clips[project.clips.length - 1].end : (project.duration ?? Infinity)
  const rampIn = from !== b.layout && b.start > keptStart + ADJACENT
  const rampOut = !nextAdjacent && b.layout !== 'default' && b.end < keptEnd - ADJACENT
  const len = b.end - b.start
  const span = Math.min(LAYOUT_TRANSITION, rampIn && rampOut ? len / 2 : len)
  if (rampIn && t < b.start + span) return { from, to: b.layout, progress: (t - b.start) / span }
  if (rampOut && t > b.end - span) return { from: b.layout, to: 'default', progress: (t - (b.end - span)) / span }
  return { from: b.layout, to: b.layout, progress: 1 }
}

/** Seconds of a segment's animated change in and out (0 when it changes instantly or not at all), as layoutPhaseAt animates them. */
export function layoutRamps(project: Omit<SceneProject, 'style'>, seg: LayoutSegment): { in: number; out: number } {
  const len = seg.end - seg.start
  if (!(len > 0)) return { in: 0, out: 0 }
  const at = (t: number): LayoutPhase => layoutPhaseAt(project, t)
  const first = at(seg.start)
  const last = at(seg.end - 1e-6)
  const rampIn = first.progress < 1
  const rampOut = last.progress < 1 && last.from === seg.layout && last.to !== seg.layout
  const span = Math.min(LAYOUT_TRANSITION, rampIn && rampOut ? len / 2 : len)
  return { in: rampIn ? span : 0, out: rampOut ? span : 0 }
}

/** Whether the screen's rectangle is animating at `t` (the compositor then draws the card as it moves instead of from its cache). */
export function layoutMoving(project: Omit<SceneProject, 'style'>, t: number): boolean {
  const p = layoutPhaseAt(project, t)
  return p.progress < 1 && screenPlace(p.from) !== screenPlace(p.to)
}

/** Where the screen and the camera are at source time `t`, with layout changes animated (eased). */
export function sceneLayout(project: SceneProject, outW: number, outH: number, srcW: number, srcH: number, t: number): SceneLayout {
  if (!project.webcam.show) return { screen: styleContentRect(outW, outH, srcW, srcH, project.style), camera: null, moving: false }
  const phase = layoutPhaseAt(project, t)
  const to = layoutGeometry(phase.to, project, outW, outH, srcW, srcH)
  if (phase.progress >= 1 || phase.from === phase.to) return { ...to, moving: false }
  const from = layoutGeometry(phase.from, project, outW, outH, srcW, srcH)
  const e = easeInOutCubic(clamp(phase.progress, 0, 1))
  return {
    screen: lerpRect(from.screen, to.screen, e),
    camera: { rect: lerpRect(from.camera.rect, to.camera.rect, e), radius: lerp(from.camera.radius, to.camera.radius, e), opacity: lerp(from.camera.opacity, to.camera.opacity, e) },
    moving: screenPlace(phase.from) !== screenPlace(phase.to)
  }
}

/**
 * Rectangle of the recording in the output frame at source time `t`, after the camera layout
 * in effect then (side-by-side moves the screen aside; layouts animate between each other).
 * The compositor and the preview's pointer mapping use this, so they always agree.
 */
export function sceneContentRect(project: SceneProject, outW: number, outH: number, srcW: number, srcH: number, t: number): Rect {
  return sceneLayout(project, outW, outH, srcW, srcH, t).screen
}

/** Where the camera is at source time `t` (null when it is not shown), matching sceneContentRect. */
export function sceneCameraBox(project: SceneProject, outW: number, outH: number, srcW: number, srcH: number, t: number): CameraBox | null {
  return sceneLayout(project, outW, outH, srcW, srcH, t).camera
}

/**
 * The part of the camera picture (camera pixels) shown in a `boxW` x `boxH` box: the picture
 * covers the box, then `zoom` (1..3) crops into it around (cropX, cropY), normalised and kept
 * inside the picture. Zoom 1, centred, is exactly a centred cover fit.
 */
export function cameraSourceRect(camW: number, camH: number, boxW: number, boxH: number, crop: Pick<WebcamSettings, 'zoom' | 'cropX' | 'cropY'>): Rect {
  const cover = Math.max(boxW / camW, boxH / camH)
  const zoom = clamp(Number.isFinite(crop.zoom) ? crop.zoom! : 1, 1, 3)
  const w = Math.min(camW, boxW / cover / zoom)
  const h = Math.min(camH, boxH / cover / zoom)
  const cx = clamp(Number.isFinite(crop.cropX) ? crop.cropX! : 0.5, 0, 1) * camW
  const cy = clamp(Number.isFinite(crop.cropY) ? crop.cropY! : 0.5, 0, 1) * camH
  return { x: clamp(cx - w / 2, 0, camW - w), y: clamp(cy - h / 2, 0, camH - h), w, h }
}
