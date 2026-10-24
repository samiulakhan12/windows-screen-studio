import { describe, expect, it, vi } from 'vitest'

// Cursor sprites are Path2D shapes; only whether they are drawn matters here.
vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { EditStore } from '../src/shared/editor/editStore'
import { fadeLead, revealKeptTime, revealTime, SHAPE_FADE, SPOTLIGHT_FADE } from '../src/shared/editor/shapes'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import { cursorOverVideoAt, cursorPresence, cursorSpotlightPresence, shapeAlpha, spotlightAlpha } from '../src/shared/render/shapes'
import type { Clip, CursorSample, CursorTrack, Project, Shape, ShapeKind, Spotlight } from '../src/shared/types'

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Player = { time: number; seek(t: number): void }
type Services = { store: EditStore<Project>; player: Player }
type Select = (sel: { kind: string; id: string } | null) => void
interface PlayheadItems {
  addShapeAt(services: Services, kind: ShapeKind, cursor: CursorTrack | null, opts: { at?: number; onSelect: Select }): Shape
  addSpotlightAt(services: Services, mode: Spotlight['mode'], opts: { at?: number; onSelect: Select }): Spotlight
  revealItem(player: Player, clips: Clip[], item: { start: number; end: number }, kind: ShapeKind | 'spotlight', from?: number): boolean
}
const PLAYHEAD_ITEMS = '../src/renderer/src/editor/playheadItems'
const { addShapeAt, addSpotlightAt, revealItem } = (await import(/* @vite-ignore */ PLAYHEAD_ITEMS)) as PlayheadItems
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

function project(opts: { duration?: number; width?: number; height?: number; clips?: Clip[]; cursorInVideo?: boolean } = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: opts.duration ?? 12,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: opts.cursorInVideo ? { method: 'chromium', cursorInVideo: true, region: null } : { method: 'native', cursorInVideo: false, region: null, target: 'window' }
  })
  return opts.clips ? { ...p, clips: opts.clips } : p
}

/** A player that only keeps the playhead (what the add and reveal helpers use). */
function fakePlayer(time: number): Player & { seeks: number[] } {
  const seeks: number[] = []
  return {
    time,
    seeks,
    seek(t: number) {
      seeks.push(t)
      this.time = t
    }
  }
}

const track = (samples: CursorSample[]): CursorTrack => ({ samples, clicks: [], keys: [], shapes: [], scale: 1, valid: true })
const still = (x: number, y: number, until = 12): CursorSample[] => [
  { t: 0, x, y },
  { t: until, x, y }
]

describe('revealKeptTime: showing an item on a kept frame', () => {
  it('matches revealTime when nothing is cut or re-timed', () => {
    const clips: Clip[] = [{ id: 'c', start: 0, end: 20, speed: 1 }]
    const item = { start: 4, end: 7 }
    for (const kind of ['arrow', 'blur', 'spotlight'] as const) {
      for (const t of [0, 4, 4.1, 5, 6.9, 7, 15]) expect(revealKeptTime(item, kind, clips, t)).toBeCloseTo(revealTime(item, t, fadeLead(kind)), 9)
    }
    expect(revealKeptTime({ start: 4, end: 4.2 }, 'arrow', clips, 9)).toBeCloseTo(4.1)
  })

  it('never lands in a cut or a trimmed end, where the preview shows another frame', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 4, speed: 1 },
      { id: 'b', start: 6, end: 8, speed: 1 }
    ]
    // Starts in the cut: the first kept frame past its fade-in.
    const item = { start: 5, end: 9 }
    for (const t of [0, 5.2, 5.9]) {
      const at = revealKeptTime(item, 'rect', clips, t)!
      expect(at).toBeGreaterThanOrEqual(6)
      expect(at).toBeLessThan(6.1)
    }
    // Runs past the trimmed end: before the end of the kept part.
    const at = revealKeptTime(item, 'rect', clips, 8.5)!
    expect(at).toBeGreaterThan(7.9)
    expect(at).toBeLessThan(8)
    // Already showing on a kept frame: stays.
    expect(revealKeptTime(item, 'rect', clips, 7)).toBe(7)
    // In a kept part on either side of a cut: the nearer one.
    expect(revealKeptTime({ start: 2, end: 7.5 }, 'blur', clips, 4.5)).toBeCloseTo(3.98)
    expect(revealKeptTime({ start: 2, end: 7.5 }, 'blur', clips, 5.5)).toBeCloseTo(6.01)
    // All of it cut: nothing shows it.
    expect(revealKeptTime({ start: 4.5, end: 5.5 }, 'arrow', clips, 0)).toBeNull()
    expect(revealKeptTime({ start: 9, end: 10 }, 'spotlight', clips, 0)).toBeNull()
  })

  it('fades take as long on screen in a sped-up clip, so it lands past the longer fade-in', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 6, speed: 1 },
      { id: 'b', start: 6, end: 12, speed: 4 }
    ]
    const spot = { start: 7, end: 10 }
    const at = revealKeptTime(spot, 'spotlight', clips, 0)!
    expect(at).toBeCloseTo(7 + 4 * SPOTLIGHT_FADE + 0.01)
    expect(spotlightAlpha(spot, at, 4)).toBe(1)
    // At the old target (one 1x fade in) a 4x spotlight is barely there.
    expect(spotlightAlpha(spot, 7 + SPOTLIGHT_FADE + 0.01, 4)).toBeLessThan(0.2)
    const arrow = { kind: 'arrow' as const, start: 7, end: 10 }
    expect(shapeAlpha(arrow, revealKeptTime(arrow, 'arrow', clips, 11.9)!, 4)).toBe(1)
    // Too short to show fully at 4x: the middle of its kept part.
    expect(revealKeptTime({ start: 6.9, end: 7.5 }, 'spotlight', clips, 0)).toBeCloseTo(7.2)
  })
})

describe('adding at the playhead (Shapes panel, timeline and commands alike)', () => {
  const setup = (p: Project, time: number) => {
    const store = new EditStore(p)
    const player = fakePlayer(time)
    const selected: unknown[] = []
    return { services: { store, player }, store, player, selected, onSelect: (s: unknown) => void selected.push(s) }
  }

  it('fully shown at the playhead, selected, the playhead left where it is', () => {
    const { services, store, player, selected, onSelect } = setup(project(), 5)
    const s = addShapeAt(services, 'rect', null, { onSelect })
    expect(s.start).toBeCloseTo(5 - SHAPE_FADE)
    expect(shapeAlpha(s, 5)).toBe(1)
    expect(store.state.shapes).toEqual([s])
    expect(selected).toEqual([{ kind: 'shape', id: s.id }])
    expect(player.seeks).toEqual([])
    const l = addSpotlightAt(services, 'region', { onSelect })
    expect(spotlightAlpha(l, 5)).toBe(1)
    expect(store.state.spotlights).toEqual([l])
  })

  it('at the end of a trimmed video it stays inside the kept part and the playhead moves to show it', () => {
    const clips: Clip[] = [{ id: 'c', start: 0, end: 8, speed: 1 }]
    const { services, player, onSelect } = setup(project({ clips }), 8)
    const blur = addShapeAt(services, 'blur', null, { onSelect })
    expect([blur.start, blur.end]).toEqual([5, 8])
    const arrow = addShapeAt(services, 'arrow', null, { onSelect })
    expect(arrow.end).toBe(8)
    expect(player.time).toBeLessThan(8)
    expect(shapeAlpha(arrow, player.time)).toBe(1)
  })

  it('with the playhead in a cut, on the frame the preview shows there (the next kept one)', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 4, speed: 1 },
      { id: 'b', start: 7, end: 12, speed: 2 }
    ]
    const { services, player, onSelect } = setup(project({ clips }), 5)
    const s = addSpotlightAt(services, 'region', { onSelect })
    expect(s.start).toBeCloseTo(7 - 2 * SPOTLIGHT_FADE)
    expect(player.time).toBe(7)
    expect(spotlightAlpha(s, 7, 2)).toBe(1)
  })

  it('an arrow points at the cursor viewers see; a cursor spotlight is round on screen', () => {
    const portrait = project({ width: 1080, height: 1920, cursorInVideo: true })
    const { services, onSelect } = setup(portrait, 3)
    const arrow = addShapeAt(services, 'arrow', track(still(0.7, 0.3)), { onSelect })
    expect(Math.hypot(arrow.x + arrow.w - 0.7, arrow.y + arrow.h - 0.3)).toBeLessThan(0.05)
    const spot = addSpotlightAt(services, 'cursor', { onSelect })
    expect(spot.w * 1080).toBeCloseTo(spot.h * 1920)
    // No cursor where it is off the recording: the default arrow.
    const off = addShapeAt(services, 'arrow', track(still(1.4, 0.3)), { onSelect })
    expect([off.x, off.y]).toEqual([0.3, 0.28])
  })

  it('an arrow double-clicked on the timeline goes where it was clicked', () => {
    const { services, player, onSelect } = setup(project(), 1)
    const s = addShapeAt(services, 'arrow', null, { at: 6, onSelect })
    expect(s.start).toBeCloseTo(6 - SHAPE_FADE)
    expect(player.time).toBe(6)
  })

  it('revealItem moves the playhead only when needed, never into a cut', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 4, speed: 1 },
      { id: 'b', start: 6, end: 12, speed: 4 }
    ]
    const player = fakePlayer(0)
    // Fully faded in from 6 s at 4x (one fade after its start in the cut), the first kept frame.
    expect(revealItem(player, clips, { start: 5, end: 9 }, 'spotlight')).toBe(true)
    expect(player.time).toBeCloseTo(6.01)
    expect(revealItem(player, clips, { start: 5, end: 9 }, 'spotlight')).toBe(true)
    expect(player.seeks).toHaveLength(1)
    expect(revealItem(player, clips, { start: 6, end: 9 }, 'spotlight')).toBe(true)
    expect(player.time).toBeCloseTo(7.01)
    expect(revealItem(player, clips, { start: 4.5, end: 5.5 }, 'arrow')).toBe(false)
    expect(player.seeks).toHaveLength(2)
  })
})

describe('a cursor spotlight while the cursor is off the recording', () => {
  // On the recording until 4 s, then over another window (mapped to x = 1.6) until 6 s.
  const samples: CursorSample[] = []
  for (let i = 0; i <= 240; i++) {
    const t = i * 0.05
    samples.push({ t, x: t >= 4 && t <= 6 ? 1.6 : 0.5, y: 0.5 })
  }
  const p = project()
  const path = new SmoothedTrack(samples, 12, 0.6)

  it('follows the cursor layer: hidden once the recorded position leaves, until the drawn one is back', () => {
    expect(cursorOverVideoAt(p, samples, path, 3)).toBe(true)
    expect(cursorOverVideoAt(p, samples, path, 3.99)).toBe(false)
    expect(cursorOverVideoAt(p, samples, path, 5)).toBe(false)
    // Back in the video, but the smoothed cursor is still sliding back in.
    expect(path.at(6.05).x).toBeGreaterThan(1)
    expect(cursorOverVideoAt(p, samples, path, 6.05)).toBe(false)
    expect(cursorOverVideoAt(p, samples, path, 7)).toBe(true)
    // The real cursor baked into the video: only where it was recorded counts.
    const baked = { ...p, capture: { method: 'chromium' as const, cursorInVideo: true, region: null } }
    expect(cursorOverVideoAt(baked, samples, path, 6.05)).toBe(true)
    expect(cursorOverVideoAt(baked, samples, path, 5)).toBe(false)
    expect(cursorOverVideoAt(p, [], path, 3)).toBe(false)
  })

  it('with "loop home" the recorded position glides home with the drawn one', () => {
    const leaving = [...still(0.5, 0.5, 11), { t: 11.5, x: 1.3, y: 0.5 }, { t: 12, x: 1.3, y: 0.5 }]
    const looped = { ...p, cursor: { ...p.cursor, loopHome: true } }
    const pathAt = { at: () => ({ x: 0.5, y: 0.5 }) }
    expect(cursorOverVideoAt(p, leaving, pathAt, 12)).toBe(false)
    expect(cursorOverVideoAt(looped, leaving, pathAt, 12)).toBe(true)
  })

  it('fades out before the cursor leaves and back in after it returns', () => {
    const over = (t: number): boolean => !(t >= 4 && t < 6)
    const f = SPOTLIGHT_FADE
    expect(cursorPresence(over, 3, f)).toBe(1)
    expect(cursorPresence(over, 5, f)).toBe(0)
    expect(cursorPresence(over, 4 - f / 2, f)).toBeCloseTo(0.5, 1)
    expect(cursorPresence(over, 6 + f / 2, f)).toBeCloseTo(0.5, 1)
    const out = [3.7, 3.8, 3.9, 3.95, 3.99].map((t) => cursorPresence(over, t, f))
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThan(out[i - 1])
    // Over as much more source time in a sped-up clip.
    expect(cursorSpotlightPresence(p, samples, path, 3.5, 1)).toBe(1)
    expect(cursorSpotlightPresence(p, samples, path, 3.5, 4)).toBeLessThan(0.5)
    expect(cursorSpotlightPresence(p, samples, path, 5)).toBe(0)
  })

  /** A 2D context that records the drawing calls made on it into `calls`. */
  function recordingContext(calls: string[]) {
    const state: Record<string | symbol, unknown> = {}
    return new Proxy(state, {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} })
        if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
        // Only what is drawn: an empty save/restore pair draws nothing.
        return () => void (prop === 'save' || prop === 'restore' || calls.push(String(prop)))
      },
      set(target, prop, value) {
        target[prop] = value
        return true
      }
    })
  }

  /** The drawing calls of a frame at `t`, and those on the layer several spotlights at once are drawn through. */
  const drawAt = (spotlights: Spotlight[], t: number): { frame: string[]; layer: string[] } => {
    const q = { ...p, spotlights }
    const frame: string[] = []
    const layer: string[] = []
    const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => recordingContext(layer) }) }
    vi.stubGlobal('document', doc)
    try {
      const screen = { readyState: 0, videoWidth: 0, videoHeight: 0 }
      drawFrame(recordingContext(frame), 800, 450, t, { project: q, cursor: track(samples), cursorPath: path, focusPath: path }, { screen, webcam: null, background: null }, { blurSamples: 1 })
    } finally {
      vi.stubGlobal('document', undefined)
    }
    return { frame, layer }
  }
  const spot: Spotlight = { id: 's', mode: 'cursor', start: 0, end: 12, x: 0.4, y: 0.4, w: 0.1, h: 0.2, shape: 'ellipse', dim: 0.6, feather: 0.4 }

  it('is not drawn at all there instead of darkening the whole frame (preview and export draw alike)', () => {
    expect(drawAt([spot], 3).frame).not.toEqual(drawAt([], 3).frame)
    expect(drawAt([spot], 5).frame).toEqual(drawAt([], 5).frame)
    // Two at once, with a region spotlight: the region's area is cleared out of the darkening,
    // and the cursor one's too only while its cursor is on the recording.
    const region: Spotlight = { ...spot, id: 'r', mode: 'region' }
    const cleared = (t: number): number => drawAt([spot, region], t).layer.filter((c) => c === 'translate').length
    expect(cleared(3)).toBe(2)
    expect(cleared(5)).toBe(1)
    expect(drawAt([spot, region], 5).frame).toContain('drawImage')
  })
})
