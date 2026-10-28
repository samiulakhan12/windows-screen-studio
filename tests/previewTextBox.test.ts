import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Annotation, Project } from '../src/shared/types'

/*
 * The selected text's outline and drag handle, and its multi-select hit box, on the preview
 * (PreviewStage's textBox) cover the box the compositor draws (drawAnnotations), also for a text in
 * a brand font. Both measure on fake canvases whose measureText is wider for the brand font.
 */

const sizeOf = (font: string): number => parseFloat(/(\d+(\.\d+)?)px/.exec(font)?.[1] ?? '10')
const widthOf = (font: string, text: string): number => text.length * sizeOf(font) * (font.includes('FlownFont') ? 0.8 : 0.5)

/** A 2D context that measures with widthOf and keeps the boxes drawn with roundRect. */
function fakeContext(boxes: number[][] = []): Record<string | symbol, unknown> {
  let font = ''
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'font') return font
      if (prop === 'measureText') return (text: string) => ({ width: widthOf(font, text) })
      if (prop === 'roundRect') return (...args: number[]) => boxes.push(args)
      if (prop in target) return target[prop]
      return () => undefined
    },
    set(target, prop, value) {
      if (prop === 'font') font = value
      else target[prop] = value
      return true
    }
  })
}
vi.stubGlobal('document', { createElement: () => ({ getContext: () => fakeContext() }), fonts: { add() {}, delete() {} } })

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Box = { x: number; y: number; w: number; h: number }
const STAGE = '../src/renderer/src/editor/PreviewStage'
const TEXT = '../src/renderer/src/render/textOverlays'
const { textBox } = (await import(/* @vite-ignore */ STAGE)) as { textBox: (a: Annotation, box: { w: number; h: number }, p: Project) => Box }
const { drawAnnotations } = (await import(/* @vite-ignore */ TEXT)) as { drawAnnotations: (ctx: unknown, w: number, h: number, t: number, p: Project) => void }

const FONTS = [{ id: 'f1', name: 'Brand Mono', file: 'font-1.ttf' }]

function project(a: Partial<Annotation>): Project {
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
  const text: Annotation = { id: 'a', start: 0, end: 3, text: 'Click Settings', x: 0.5, y: 0.4, size: 0.05, style: 'pill', ...a }
  return { ...p, fonts: FONTS, annotations: [text] }
}

/** The pill the compositor draws for the project's text at full opacity, in a w × h frame. */
function drawnBox(p: Project, w: number, h: number): Box {
  const boxes: number[][] = []
  drawAnnotations(fakeContext(boxes), w, h, 1.5, p)
  const [x, y, bw, bh] = boxes[0]
  const a = p.annotations[0]
  return { x: a.x * w + x, y: a.y * h + y, w: bw, h: bh }
}

describe('the text box on the preview', () => {
  for (const [name, a] of [
    ['in the default font', {}],
    ['in a brand font', { font: 'f1' }],
    ['in a brand font, on two lines', { font: 'f1', text: 'Click\nSettings first' }]
  ] as const) {
    it(`covers the text the compositor draws ${name}`, () => {
      const p = project(a)
      const drawn = drawnBox(p, 960, 540)
      const box = textBox(p.annotations[0], { w: 960, h: 540 }, p)
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(box[k]).toBeCloseTo(drawn[k], 6)
    })
  }

  it('is wider for a wider brand font than for the default one', () => {
    const plain = project({})
    const branded = project({ font: 'f1' })
    expect(textBox(branded.annotations[0], { w: 960, h: 540 }, branded).w).toBeGreaterThan(textBox(plain.annotations[0], { w: 960, h: 540 }, plain).w)
  })
})
