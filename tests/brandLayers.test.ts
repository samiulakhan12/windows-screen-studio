import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { ImageOverlay, Project } from '../src/shared/types'

/*
 * Brand fonts and image overlays in the compositor's layers (docs/design/brand-kit.md §4): text
 * draws with its project font's stack, widths measured with one font are never reused for
 * another, and an overlay is drawn rotated about its centre at its box with its alpha. Drawn on
 * canvases that record every call; measureText is wider for the brand font.
 */

interface Call {
  name: string
  args: unknown[]
  font: string
  alpha: number
}
const calls: Call[] = []

function recordingCanvas(): Record<string, unknown> {
  const canvas: Record<string, unknown> = { width: 0, height: 0 }
  let state = { font: '', globalAlpha: 1 }
  const stack: (typeof state)[] = []
  const ctx: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'canvas') return canvas
      if (prop === 'font') return state.font
      if (prop === 'globalAlpha') return state.globalAlpha
      if (prop in target) return target[prop]
      if (prop === 'measureText')
        return (text: string) => {
          calls.push({ name: 'measureText', args: [text], font: state.font, alpha: state.globalAlpha })
          return { width: text.length * (state.font.includes('FlownFont') ? 80 : 50) }
        }
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} })
      return (...args: unknown[]) => {
        if (prop === 'save') stack.push({ ...state })
        if (prop === 'restore') state = stack.pop() ?? state
        calls.push({ name: String(prop), args, font: state.font, alpha: state.globalAlpha })
      }
    },
    set(target, prop, value) {
      if (prop === 'font') state.font = value
      else if (prop === 'globalAlpha') state.globalAlpha = value
      else target[prop] = value
      return true
    }
  })
  canvas.getContext = () => ctx
  return canvas
}

class FakeImage {
  naturalWidth = 400
  naturalHeight = 200
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  crossOrigin = ''
  decoding = ''
  set src(_v: string) {
    setTimeout(() => this.onload?.(), 0)
  }
}

vi.stubGlobal('document', { createElement: () => recordingCanvas(), fonts: { add() {}, delete() {} } })
vi.stubGlobal('Image', FakeImage)

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Layer = (fc: unknown) => void
const RENDER = '../src/renderer/src/render/'
const { drawTitleCardsLayer } = (await import(/* @vite-ignore */ `${RENDER}titleCardLayer`)) as { drawTitleCardsLayer: Layer }
const { drawCaptionsLayer } = (await import(/* @vite-ignore */ `${RENDER}captionsLayer`)) as { drawCaptionsLayer: Layer }
const { drawAnnotations } = (await import(/* @vite-ignore */ `${RENDER}textOverlays`)) as { drawAnnotations: (ctx: unknown, w: number, h: number, t: number, p: Project) => void }
const overlays = (await import(/* @vite-ignore */ `${RENDER}overlayLayer`)) as {
  drawOverlaysLayer: Layer
  preloadOverlay: (id: string, o: Partial<ImageOverlay>) => Promise<number>
}

const FONTS = [{ id: 'f1', name: 'Brand', file: 'font-1.ttf' }]

function project(extra: Partial<Project> = {}): Project {
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
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  return { ...p, fonts: FONTS, ...extra }
}

const frame = (p: Project, t: number) => {
  const canvas = recordingCanvas()
  const ctx = (canvas.getContext as () => unknown)()
  return { ctx, w: 1920, h: 1080, t, k: 1, project: p, background: null }
}
const fontsUsed = (re: RegExp): string[] => calls.filter((c) => c.name === 'fillText' && re.test(c.font)).map((c) => c.font)

beforeEach(() => {
  calls.length = 0
})

describe('brand fonts in the text layers', () => {
  it('a title card draws with its font first, then the title stack', () => {
    const p = project({ titles: [{ id: 't', start: 0, end: 3, title: 'Brand title', style: 'centered', background: 'solid', font: 'f1' }] })
    drawTitleCardsLayer(frame(p, 1))
    const used = fontsUsed(/./)
    expect(used.length).toBeGreaterThan(0)
    expect(used.every((f) => f.includes('"FlownFont-f1", \'Segoe UI Variable Display\''))).toBe(true)
  })

  it('a card measured with the default font is measured again with a brand font (no shared widths)', () => {
    const plain = project({ titles: [{ id: 't', start: 0, end: 3, title: 'Same words here', style: 'lower-third', background: 'solid' }] })
    drawTitleCardsLayer(frame(plain, 1))
    calls.length = 0
    const branded = project({ titles: [{ id: 't', start: 0, end: 3, title: 'Same words here', style: 'lower-third', background: 'solid', font: 'f1' }] })
    drawTitleCardsLayer(frame(branded, 1))
    // Widths cached for the default font would lay the brand font out wrong: it is measured itself.
    expect(calls.some((c) => c.name === 'measureText' && c.font.includes('FlownFont-f1'))).toBe(true)
    expect(calls.find((c) => c.name === 'fillText')?.font).toContain('FlownFont-f1')
  })

  it('captions use the captions font; widths measured with it differ from the default', () => {
    const transcript = { provider: 'local' as const, model: 'm', createdAt: '', segments: [{ id: 's', start: 0, end: 3, text: 'Hello brand world' }] }
    const withFont = project({ transcript, captions: { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#facc15', background: 'none', maxLines: 2, font: 'f1' } })
    drawCaptionsLayer(frame(withFont, 1))
    expect(fontsUsed(/FlownFont-f1/).length).toBeGreaterThan(0)
    calls.length = 0
    const plain = project({ transcript: { ...transcript, segments: [{ ...transcript.segments[0] }] }, captions: { ...withFont.captions!, font: undefined } })
    drawCaptionsLayer(frame(plain, 1))
    expect(calls.some((c) => c.name === 'measureText' && !c.font.includes('FlownFont'))).toBe(true)
    const used = fontsUsed(/./)
    expect(used.length).toBeGreaterThan(0)
    expect(used.some((f) => f.includes('FlownFont'))).toBe(false)
  })

  it('a text annotation draws with its font; an unknown font id draws with the default stack', () => {
    const a = { id: 'a', start: 0, end: 3, text: 'Hi', x: 0.5, y: 0.5, size: 0.05, style: 'pill' as const }
    const canvas = recordingCanvas()
    drawAnnotations((canvas.getContext as () => unknown)(), 1920, 1080, 1, project({ annotations: [{ ...a, font: 'f1' }] }))
    expect(fontsUsed(/FlownFont-f1/).length).toBe(1)
    calls.length = 0
    drawAnnotations((canvas.getContext as () => unknown)(), 1920, 1080, 1, project({ annotations: [{ ...a, font: 'gone' }] }))
    expect(fontsUsed(/./)).toEqual([expect.stringMatching(/^600 \d+(\.\d+)?px 'Segoe UI', system-ui, sans-serif$/)])
  })
})

describe('image overlays in the compositor', () => {
  const o: ImageOverlay = { id: 'o', start: 1, end: 4, file: 'overlay-1.png', x: 0.25, y: 0.5, w: 0.4, h: 0.2, rotation: 30, opacity: 0.5, fadeIn: 0, fadeOut: 0 }

  it('decodes once and draws rotated about its centre, at its box, with its alpha', async () => {
    expect(await overlays.preloadOverlay('p', o)).toBeCloseTo(2)
    const p = project({ overlays: [o] })
    calls.length = 0
    overlays.drawOverlaysLayer(frame(p, 2))
    const translate = calls.find((c) => c.name === 'translate')
    const rotate = calls.find((c) => c.name === 'rotate')
    const draw = calls.find((c) => c.name === 'drawImage')
    expect(translate?.args).toEqual([480, 540])
    expect(rotate?.args[0]).toBeCloseTo(Math.PI / 6)
    expect(draw?.args.slice(1)).toEqual([-216, -108, 432, 216])
    expect(draw?.alpha).toBeCloseTo(0.5)
  })

  it('draws nothing outside its time, and later overlays on top', async () => {
    const p = project({ overlays: [o, { ...o, id: 'o2', sticker: 'star', file: undefined, rotation: 0 }] })
    await overlays.preloadOverlay('p', { sticker: 'star' })
    calls.length = 0
    overlays.drawOverlaysLayer(frame(p, 0.5))
    expect(calls.some((c) => c.name === 'drawImage')).toBe(false)
    overlays.drawOverlaysLayer(frame(p, 2))
    expect(calls.filter((c) => c.name === 'drawImage')).toHaveLength(2)
  })
})
