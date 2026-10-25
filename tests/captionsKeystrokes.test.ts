import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import { CAPTION_FONT } from '../src/shared/captions/layout'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import type { CaptionSettings, CursorTrack, KeystrokeSettings } from '../src/shared/types'

type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }

/** The keystroke pill's fill (textOverlays.ts). */
const PILL = 'rgba(16,16,22,0.84)'

interface Drawn {
  /** The keystroke pill: top and bottom, px. */
  pill: { top: number; bottom: number } | null
  /** The caption text: the top of its first line and the bottom of its last, px. */
  caption: { top: number; bottom: number } | null
}

/** One frame at t = 2 s with a shortcut pressed at 1.9 s and a caption from 1 s to 4 s. */
function frame(w: number, h: number, keys: Partial<KeystrokeSettings>, captions: Partial<CaptionSettings>, text = 'Press control and S to save the project now'): Drawn {
  const project = createProject({
    id: 'p',
    name: 'p',
    duration: 6,
    width: 1600,
    height: 900,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  project.effects = { ...project.effects, keystrokes: { ...project.effects.keystrokes, ...keys } }
  project.transcript = { provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 1, end: 4, text }] }
  project.captions = { ...DEFAULT_CAPTIONS, ...captions }
  const cursor: CursorTrack = { samples: [], clicks: [], keys: [{ t: 1.9, label: 'Ctrl+S' }], shapes: [], scale: 1, valid: false }
  const path = new SmoothedTrack([], 6, 0)
  const drawn: Drawn = { pill: null, caption: null }
  let rect: number[] = []
  const state: Record<string | symbol, unknown> = {}
  const saved: Record<string | symbol, unknown>[] = []
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      // The font set while measuring captions must not leak into the keystroke overlay's text.
      if (prop === 'save') return () => void saved.push({ ...target })
      if (prop === 'restore') return () => void Object.assign(target, saved.pop() ?? {})
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} })
      // Every character as wide as half the font size.
      if (prop === 'measureText') return (s: string) => ({ width: s.length * (parseFloat(String(/(\d+(\.\d+)?)px/.exec(String(target.font))?.[1] ?? 10)) / 2), actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 })
      if (prop === 'roundRect') return (...a: number[]) => void (rect = a)
      if (prop === 'fill') return () => void (target.fillStyle === PILL && (drawn.pill = { top: rect[1], bottom: rect[1] + rect[3] }))
      if (prop === 'fillText') {
        return (_s: string, _x: number, y: number) => {
          if (!String(target.font).includes(CAPTION_FONT)) return
          const px = parseFloat(/(\d+(\.\d+)?)px/.exec(String(target.font))![1])
          const c = drawn.caption
          // Glyphs reach about half the text size above and below the line's middle.
          drawn.caption = { top: Math.min(c?.top ?? Infinity, y - px * 0.6), bottom: Math.max(c?.bottom ?? -Infinity, y + px * 0.6) }
        }
      }
      return () => {}
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  const screenFrame = { image: { tag: 'frame' }, width: 1600, height: 900 }
  drawFrame(ctx, w, h, 2, { project, cursor, cursorPath: path, focusPath: path }, { screen: { readyState: 0, videoWidth: 0, videoHeight: 0 }, webcam: null, background: null, screenFrame }, { blurSamples: 1 })
  return drawn
}

const apart = (d: Drawn): boolean => !!d.pill && !!d.caption && (d.pill.bottom <= d.caption.top || d.pill.top >= d.caption.bottom)

describe('captions and the keystroke overlay keep clear of each other (CAP-3)', () => {
  it('default settings at 1080p: both at the bottom, the keys above the caption', () => {
    const d = frame(1920, 1080, {}, {})
    expect(d.pill && d.caption).toBeTruthy()
    expect(apart(d)).toBe(true)
    expect(d.pill!.bottom).toBeLessThanOrEqual(d.caption!.top)
  })

  it('two-line captions in a box, a large overlay, a vertical frame', () => {
    const long = 'Press control and S to save the project now and then keep on talking for a while so the caption needs two lines'
    for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
      expect(apart(frame(w, h, { size: 0.06 }, { background: 'box', preset: 'boxed', size: 0.06 }, long))).toBe(true)
    }
  })

  it('both at the top: the keys go below the caption; at opposite edges nothing moves', () => {
    const top = frame(1920, 1080, { position: 'top' }, { position: 'top' })
    expect(apart(top)).toBe(true)
    expect(top.pill!.top).toBeGreaterThanOrEqual(top.caption!.bottom)
    const apartAlready = frame(1920, 1080, { position: 'top' }, {})
    expect(apartAlready.pill!.top).toBeCloseTo(1080 * 0.05, 6)
  })
})
