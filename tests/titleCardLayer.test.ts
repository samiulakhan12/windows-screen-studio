import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { titlePhase } from '../src/shared/render/titleCards'
import type { Project, TitleCard } from '../src/shared/types'

/*
 * Title cards in the compositor (render/titleCardLayer.ts): the text with its soft shadow, and a
 * lower third's accent bar and solid band with its shadow, are drawn once on a canvas of their
 * own; each frame of the card only copies it, at whole pixels, with its fade as the alpha.
 * Drawn on canvases that record every call with the alpha it was made at.
 */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  alpha: number
}
const calls: Call[] = []
let canvases = 0

function recordingCanvas(): Record<string, unknown> {
  const id = canvases++
  const canvas: Record<string, unknown> = { width: 0, height: 0, id }
  let state = { globalAlpha: 1 }
  const stack: (typeof state)[] = []
  const ctx: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'canvas') return canvas
      if (prop === 'globalAlpha') return state.globalAlpha
      if (prop in target) return target[prop]
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 50 })
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} })
      return (...args: unknown[]) => {
        if (prop === 'save') stack.push({ ...state })
        if (prop === 'restore') state = stack.pop() ?? state
        calls.push({ canvas: id, name: String(prop), args, alpha: state.globalAlpha })
      }
    },
    set(target, prop, value) {
      if (prop === 'globalAlpha') state.globalAlpha = value
      else target[prop] = value
      calls.push({ canvas: id, name: `set ${String(prop)}`, args: [value], alpha: state.globalAlpha })
      return true
    }
  })
  canvas.getContext = () => ctx
  return canvas
}

vi.stubGlobal('document', { createElement: () => recordingCanvas() })

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const LAYER = '../src/renderer/src/render/titleCardLayer'
const { drawTitleCardsLayer } = (await import(/* @vite-ignore */ LAYER)) as { drawTitleCardsLayer: (fc: unknown) => void }

function project(card: Omit<TitleCard, 'id' | 'start' | 'end'>): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.titles = [{ id: 'c', start: 2, end: 6, ...card }]
  return p
}

/** Draws the card on `out` at each time; returns the calls made per frame. */
function frames(p: Project, out: Record<string, unknown>, times: number[]): Call[][] {
  const ctx = (out.getContext as () => unknown)()
  return times.map((t) => {
    calls.length = 0
    drawTitleCardsLayer({ ctx, w: 1920, h: 1080, t, k: 1, project: p, background: null })
    return [...calls]
  })
}

const on = (c: Call[], canvas: unknown): Call[] => c.filter((x) => x.canvas === (canvas as { id: number }).id)
const TEXT = ['fillText', 'set shadowBlur']

describe('title cards: the text is drawn once and copied', () => {
  it('a big title over the blurred video: one copy per frame, at its fade, never the glyphs or their shadow again', () => {
    const p = project({ style: 'big', title: 'Ship faster\nwith better tools', subtitle: 'A quick tour', background: 'blur' })
    const out = recordingCanvas()
    const times = [2.1, 2.2, 3, 4, 5.9]
    const drawn = frames(p, out, times)
    const sprites = new Set<number>()
    drawn.forEach((c, i) => {
      const mine = on(c, out)
      expect(mine.filter((x) => TEXT.includes(x.name))).toEqual([])
      // The background (the blurred frame) and the text: the text is the copy at whole pixels, at its fade.
      const copies = mine.filter((x) => x.name === 'drawImage' && x.args.length === 3)
      expect(copies).toHaveLength(1)
      expect(Number.isInteger(copies[0].args[1]) && Number.isInteger(copies[0].args[2])).toBe(true)
      expect(copies[0].alpha).toBeCloseTo(titlePhase(p.titles![0], times[i], p.clips)!.text, 9)
      sprites.add((copies[0].args[0] as { id: number }).id)
    })
    // One picture of the text, its glyphs and shadow drawn in the first frame only.
    expect(sprites.size).toBe(1)
    const [sprite] = [...sprites]
    expect(drawn[0].filter((x) => x.canvas === sprite && x.name === 'fillText').length).toBe(3)
    expect(drawn[0].filter((x) => x.canvas === sprite && x.name === 'set shadowBlur').length).toBeGreaterThan(0)
    for (const c of drawn.slice(1)) expect(c.filter((x) => x.canvas === sprite)).toEqual([])
  })

  it('a solid lower third: the band, its shadow, the accent bar and the text are one copy', () => {
    const p = project({ style: 'lower-third', title: 'Samiul Khan', subtitle: 'Product designer', background: 'solid', color: '#2563eb' })
    const out = recordingCanvas()
    const drawn = frames(p, out, [2.1, 3, 4])
    for (const c of drawn) {
      const mine = on(c, out)
      expect(mine.filter((x) => ['fillText', 'set shadowBlur', 'fill', 'roundRect'].includes(x.name))).toEqual([])
      expect(mine.filter((x) => x.name === 'drawImage')).toHaveLength(1)
    }
  })

  it('a lower third over the video: the band shows the frame each frame, the accent bar and text are a copy', () => {
    const p = project({ style: 'lower-third', title: 'Samiul Khan', background: 'blur' })
    const out = recordingCanvas()
    for (const c of frames(p, out, [2.1, 3, 4])) {
      const mine = on(c, out)
      expect(mine.filter((x) => x.name === 'fillText')).toEqual([])
      expect(mine.filter((x) => x.name === 'clip')).toHaveLength(1)
      expect(mine.filter((x) => x.name === 'stroke')).toHaveLength(1)
      // The blurred frame in the band, then the copy.
      expect(mine.filter((x) => x.name === 'drawImage').length).toBe(2)
    }
  })

  it('makes a new copy for new text', () => {
    const out = recordingCanvas()
    const a = frames(project({ style: 'centered', title: 'One', background: 'solid' }), out, [3])[0]
    const b = frames(project({ style: 'centered', title: 'Two', background: 'solid' }), out, [3])[0]
    const copy = (c: Call[]) => (on(c, out).find((x) => x.name === 'drawImage' && x.args.length === 3)!.args[0] as { id: number }).id
    expect(copy(a)).not.toBe(copy(b))
    expect(b.some((x) => x.name === 'fillText' && x.args[0] === 'Two')).toBe(true)
  })
})
