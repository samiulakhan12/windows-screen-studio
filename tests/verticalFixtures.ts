import { createHash } from 'node:crypto'
import { cropView } from '../src/shared/engine/crop'
import { outputSize } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import type { CameraLayout, ClickEvent, Corner, CursorSample, CursorTrack, LayoutSegment, NormRect, Project, ZoomEasing, ZoomFocus, ZoomSegment } from '../src/shared/types'

/*
 * The fixtures of the vertical video equivalence guard (docs/design/vertical-video.md §11.2):
 * twelve projects from before following existed (16:9, 9:16, 1:1 and 4:3 frames, camera layouts
 * with corners, side by side, crops, padding and device frames), their cursor tracks, seeded
 * times and zoom lists, and a digest of exact values. tests/verticalEquivalence.test.ts pins
 * today's outputs for them; the parts' tests (followLayout, zoomBase, frameView,
 * compositorFollow, textArea) compare the new code with the same fixtures. Everything here is a
 * literal or comes from a seeded generator, never from the code under test.
 */

/** A seeded random generator (mulberry32): the same numbers on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** SHA-256 of `value` as JSON: numbers are written in their shortest exact form, so equal digests mean equal values bit for bit. */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]
const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** `n` seeded times over -0.5 .. duration + 0.5 (outside the recording too), rounded to the millisecond. */
export function seededTimes(seed: number, n: number, duration: number): number[] {
  const r = rng(seed)
  return Array.from({ length: n }, () => round3(-0.5 + r() * (duration + 1)))
}

const EASINGS: readonly (ZoomEasing | undefined)[] = ['smooth', 'snappy', 'bouncy', 'linear', undefined, undefined]

/**
 * A seeded list of zooms over `duration`: cursor, fixed, region and pull-back zooms, with and
 * without anchors (clicks and typing), easings and transitions of their own, some connected,
 * some overlapping (as a hand-edited file may have them).
 */
export function seededZooms(r: () => number, duration: number, count: number): ZoomSegment[] {
  const out: ZoomSegment[] = []
  let t = r() * 2
  for (let i = 0; i < count && t < duration - 0.5; i++) {
    const start = round3(t)
    const end = round3(Math.min(duration, start + 0.6 + r() * 5))
    const kind = r()
    let focus: ZoomFocus = { mode: 'cursor' }
    let scale = round3(1.05 + r() * 2.5)
    if (kind < 0.2) focus = { mode: 'fixed', x: round3(r()), y: round3(r()) }
    else if (kind < 0.35) {
      const w = round3(0.1 + r() * 0.7)
      const h = round3(0.1 + r() * 0.7)
      focus = { mode: 'region', x: round3(r() * (1 - w)), y: round3(r() * (1 - h)), w, h }
    } else if (kind < 0.5) scale = round3(0.5 + r() * 0.49)
    const z: ZoomSegment = { id: `z${i}`, start, end, scale, focus, auto: r() < 0.5 }
    if (focus.mode === 'cursor' && r() < 0.6) {
      const at = round3(start + r() * (end - start))
      z.anchor = r() < 0.3 ? { t: at, x: round3(r()), y: round3(r()), until: round3(Math.min(end + 1, at + r() * 3)) } : { t: at, x: round3(r()), y: round3(r()) }
    }
    const easing = pick(r, EASINGS)
    if (easing) z.easing = easing
    if (r() < 0.3) z.transition = round3(0.15 + r() * 2.35)
    out.push(z)
    const gap = r()
    t = end + (gap < 0.15 ? -r() * 0.5 : gap < 0.45 ? r() * 0.6 : 0.6 + r() * 4)
  }
  return out
}

/** A seeded cursor track over `duration`: a wandering cursor at 60 Hz with rests, flicks off the frame, clicks, keys, typing and scrolling. */
export function seededTrack(r: () => number, duration: number, valid = true): CursorTrack {
  const samples: CursorSample[] = []
  let x = 0.5
  let y = 0.5
  let vx = 0
  let vy = 0
  for (let i = 0; i * (1 / 60) <= duration; i++) {
    const t = round3(i / 60)
    // Rest sometimes, wander otherwise; now and then a flick off the recorded frame.
    if (r() < 0.02) {
      vx = (r() - 0.5) * 0.04
      vy = (r() - 0.5) * 0.04
    }
    if (r() < 0.01) {
      vx = 0
      vy = 0
    }
    x = Math.min(1.4, Math.max(-0.4, x + vx))
    y = Math.min(1.4, Math.max(-0.4, y + vy))
    if (x <= -0.4 || x >= 1.4) vx = -vx
    if (y <= -0.4 || y >= 1.4) vy = -vy
    samples.push({ t, x: round3(x), y: round3(y) })
  }
  const clicks: ClickEvent[] = []
  for (let t = 0.7; t < duration; t += 0.4 + r() * 3) {
    const s = samples[Math.min(samples.length - 1, Math.round(t * 60))]
    clicks.push({ t: round3(t), x: s.x, y: s.y, button: r() < 0.85 ? 'left' : 'right', ...(r() < 0.5 ? { up: round3(t + r() * 0.8) } : {}) })
  }
  const keys = Array.from({ length: Math.floor(duration / 6) }, (_, i) => ({ t: round3(2 + i * 6 + r()), label: pick(r, ['Ctrl + C', 'Ctrl + V', 'Alt + Tab', 'Ctrl + Shift + P']) }))
  const typing = Array.from({ length: Math.floor(duration / 9) }, (_, i) => {
    const t = round3(4 + i * 9 + r())
    return { t, end: round3(t + 0.5 + r() * 2.5) }
  })
  const scrolls = Array.from({ length: 24 }, (_, i) => ({ t: round3(duration * 0.6 + i * 0.12), x: 0.5, y: 0.6, dx: 0, dy: 1 }))
  return { samples, clicks, keys, shapes: [], typing, scrolls, scale: 1, valid }
}

const layout = (id: string, start: number, end: number, l: CameraLayout, corner?: Corner): LayoutSegment => ({ id, start, end, layout: l, ...(corner ? { corner } : {}) })

/** One equivalence fixture: a stored project and its recorded track, and what is drawn from them. */
export interface SceneFixture {
  name: string
  /** The project as stored (full-frame positions). */
  project: Project
  track: CursorTrack
  /** The project and track as drawn (cropView): view space, the crop's size. */
  drawn: Project
  cursor: CursorTrack
  /** The drawn recording's size. */
  vw: number
  vh: number
  /** The frame at the canonical 1080 size (outputSize). */
  w: number
  h: number
  times: number[]
}

const DURATION = 30

/** A project of a `width` x `height` recording, 30 s, cut at 9-11 s and 2x speed over 20-24 s. */
function base(id: string, width: number, height: number, extra: Partial<Project> = {}, webcam = false): Project {
  const p = createProject({
    id,
    name: id,
    duration: DURATION,
    width,
    height,
    hasWebcam: webcam,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  return {
    ...p,
    createdAt: '2026-10-01T09:00:00.000Z',
    clips: [
      { id: 'c1', start: 0, end: 9, speed: 1 },
      { id: 'c2', start: 11, end: 20, speed: 1 },
      { id: 'c3', start: 20, end: 24, speed: 2 },
      { id: 'c4', start: 24, end: DURATION, speed: 1 }
    ],
    ...extra
  }
}

const style = (p: Project, s: Partial<Project['style']>): Project['style'] => ({ ...p.style, ...s })

/** The bottom 48 px of a 1080 px high recording (a Windows taskbar at 100%). */
const TASKBAR: NormRect = { x: 0, y: 0, w: 1, h: 1032 / 1080 }

/** The twelve projects of the guard, each with its own seeded zooms, track and times. */
export function sceneFixtures(): SceneFixture[] {
  const list: { name: string; make: () => Project; valid?: boolean }[] = [
    { name: 'wide-auto', make: () => base('wide-auto', 1920, 1080) },
    { name: 'tall-fitted', make: () => withStyle(base('tall-fitted', 1920, 1080), { aspectRatio: '9:16' }) },
    { name: 'square-fitted', make: () => withStyle(base('square-fitted', 1920, 1080, {}, true), { aspectRatio: '1:1' }) },
    {
      name: 'wide-corners',
      make: () =>
        withStyle(
          base(
            'wide-corners',
            1920,
            1080,
            {
              layouts: [
                layout('l1', 1, 4, 'default', 'top-left'),
                layout('l2', 4, 7, 'camera-large', 'top-right'),
                layout('l3', 12, 15, 'screen-only'),
                layout('l4', 15, 18, 'camera-only'),
                layout('l5', 21, 26, 'default', 'bottom-left')
              ]
            },
            true
          ),
          { aspectRatio: '16:9' }
        )
    },
    {
      name: 'wide-side',
      make: () =>
        base(
          'wide-side',
          1920,
          1080,
          {
            layouts: [layout('l1', 2, 8, 'side-by-side', 'top-left'), layout('l2', 8, 14, 'side-by-side', 'bottom-right'), layout('l3', 16, 25, 'side-by-side')]
          },
          true
        )
    },
    {
      name: 'tall-layouts',
      make: () =>
        withStyle(
          base(
            'tall-layouts',
            1920,
            1080,
            {
              layouts: [
                layout('l1', 1.5, 6, 'side-by-side', 'top-right'),
                layout('l2', 6, 9.5, 'camera-only'),
                layout('l3', 12, 16, 'screen-only'),
                layout('l4', 17, 22, 'camera-large', 'bottom-left'),
                layout('l5', 25, 29, 'default', 'top-left')
              ]
            },
            true
          ),
          { aspectRatio: '9:16', padding: 0 }
        )
    },
    {
      name: 'square-corners',
      make: () => {
        const p = base('square-corners', 2560, 1440, { layouts: [layout('l1', 3, 9, 'default', 'top-left'), layout('l2', 13, 19, 'camera-large'), layout('l3', 22, 28, 'side-by-side', 'bottom-left')] }, true)
        return { ...withStyle(p, { aspectRatio: '1:1', padding: 0.12 }), webcam: { ...p.webcam, shape: 'rounded', size: 0.3 } }
      }
    },
    {
      name: 'crop-wide',
      make: () => base('crop-wide', 1920, 1080, { crop: TASKBAR, layouts: [layout('l1', 5, 12, 'side-by-side'), layout('l2', 18, 23, 'camera-only')] }, true)
    },
    {
      name: 'crop-tall',
      make: () => withStyle(base('crop-tall', 1920, 1080, { crop: { x: 0.1, y: 0.05, w: 0.5, h: 0.8 }, layouts: [layout('l1', 4, 10, 'camera-large', 'top-left')] }, true), { aspectRatio: '9:16' })
    },
    {
      name: 'frame-browser',
      make: () =>
        withStyle(base('frame-browser', 1920, 1080, { layouts: [layout('l1', 6, 14, 'side-by-side', 'bottom-left'), layout('l2', 14, 20, 'screen-only')] }, true), {
          padding: 0.1,
          frame: { kind: 'browser', theme: 'dark', title: 'flown.app' }
        })
    },
    {
      name: 'frame-laptop-tall',
      make: () => {
        const p = base('frame-laptop-tall', 1920, 1080, {}, true)
        return { ...withStyle(p, { aspectRatio: '9:16', padding: 0.12, frame: { kind: 'laptop', theme: 'light' } }), webcam: { ...p.webcam, show: false } }
      }
    },
    {
      name: 'window-43',
      make: () => withStyle(base('window-43', 1200, 900, { layouts: [layout('l1', 3, 20, 'camera-large', 'top-right')] }, true), { aspectRatio: '4:3', padding: 0 }),
      valid: false
    }
  ]
  return list.map(({ name, make, valid }, i) => {
    const r = rng(1000 + i)
    const stored = make()
    const track = seededTrack(r, DURATION, valid !== false)
    const project: Project = { ...stored, zooms: seededZooms(r, DURATION, 9) }
    const view = cropView(project, track)
    const vw = view.project.width
    const vh = view.project.height
    const { width: w, height: h } = outputSize(project.style.aspectRatio, vw, vh, 1080)
    // Seeded times, plus each layout change's ramps (where the screen moves).
    const ramps = (project.layouts ?? []).flatMap((l) => [l.start + 0.05, l.start + 0.2, l.start + 0.35, l.end - 0.3, l.end - 0.1])
    return { name, project, track, drawn: view.project, cursor: view.cursor, vw, vh, w, h, times: [...seededTimes(2000 + i, 500, DURATION), ...ramps] }
  })
}

function withStyle(p: Project, s: Partial<Project['style']>): Project {
  return { ...p, style: style(p, s) }
}
