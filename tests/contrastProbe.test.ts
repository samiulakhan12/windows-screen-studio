import { describe, expect, it, vi } from 'vitest'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionStudio, Project } from '../src/shared/types'
import { calls, canvas } from './studioFakes'

/*
 * The contrast meter's measurement (docs/design/captions-studio.md §7.3): the frame at the playhead
 * drawn without captions by drawFrame on a willReadFrequently canvas, the pixels under the
 * caption block read and measured; nothing without the preview's frame source.
 */

vi.mock('../src/shared/captions/studioLayout', async () => (await import('./studioFakes')).fakeStudioLayout)
vi.mock('../src/shared/captions/motion', async () => (await import('./studioFakes')).fakeMotion)
vi.mock('../src/shared/captions/replaced', async () => (await import('./studioFakes')).fakeReplaced)
vi.mock('../src/shared/captions/captionTracks', async (original) => (await import('./studioFakes')).fakeCaptionTracks(await original()))
vi.mock('../src/shared/captions/fontStack', async () => (await import('./studioFakes')).fakeFontStack)
vi.mock('../src/shared/captions/marks', async () => (await import('./studioFakes')).fakeMarks)
vi.mock('../src/shared/captions/words', async (original) => ({ ...(await original()), ...(await import('./studioFakes')).fakeWords }))
vi.mock('../src/shared/render/actionRects', async () => (await import('./studioFakes')).fakeActionRects)
const measured = vi.fn((_s: CaptionStudio, pixels: Uint8ClampedArray) => pixels.length / 4)
vi.mock('../src/shared/captions/colors', async () => ({ ...(await import('./studioFakes')).fakeColors, measuredContrast: (s: CaptionStudio, p: Uint8ClampedArray) => measured(s, p) }))
const drawn: { project: Project; w: number; h: number; t: number; contexts: unknown[] }[] = []
vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (ctx: unknown, w: number, h: number, t: number, scene: { project: Project }) => void drawn.push({ project: scene.project, w, h, t, contexts: [ctx] })
}))

const created: { options: unknown }[] = []
vi.stubGlobal('document', {
  createElement: () => {
    const c = canvas()
    const get = c.getContext as (t: string) => unknown
    c.getContext = (type: string, options?: unknown) => {
      created.push({ options })
      return get(type)
    }
    return c
  },
  fonts: { add() {}, delete() {} }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const PROBE = '../src/renderer/src/render/contrastProbe'
const { probeContrast, setContrastSource } = (await import(/* @vite-ignore */ PROBE)) as {
  probeContrast(p: Project, t: number, s: CaptionStudio): Promise<{ ratio: number; at: number } | null>
  setContrastSource(s: (() => unknown) | null): void
}

const studio = structuredClone(studioPreset('subtitle')!.look)
const project = {
  id: 'p1',
  clips: [{ start: 0, end: 10, speed: 1 }],
  fonts: [],
  titles: [],
  webcam: { show: false },
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0.5, end: 3, text: 'Make every word count today' }] },
  captions: { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2, studio }
} as unknown as Project

describe('probeContrast (§7.3)', () => {
  it('measures nothing without the preview’s frame', async () => {
    setContrastSource(null)
    await expect(probeContrast(project, 1.2, studio)).resolves.toBeNull()
  })

  it('draws the frame without captions on a CPU canvas and reads the pixels under the block', async () => {
    setContrastSource(() => ({ scene: { project }, sources: {}, width: 1920, height: 1080 }))
    const result = await probeContrast(project, 1.2, studio)
    expect(drawn.at(-1)!.project.captions!.show).toBe(false)
    expect([drawn.at(-1)!.w, drawn.at(-1)!.h, drawn.at(-1)!.t]).toEqual([320, 180, 1.2])
    expect(created[0].options).toEqual({ willReadFrequently: true })
    const read = calls.find((c) => c.name === 'getImageData')!
    const [x, y, w, h] = read.args as number[]
    // Subtitle at the bottom of a 320 x 180 frame, centred.
    expect(y + h).toBeGreaterThan(150)
    expect(Math.abs(x + w / 2 - 160)).toBeLessThanOrEqual(1)
    expect(result).toEqual({ ratio: measured.mock.results.at(-1)!.value, at: 1.2 })
  })

  it('measures nothing where no caption shows', async () => {
    setContrastSource(() => ({ scene: { project }, sources: {}, width: 1920, height: 1080 }))
    await expect(probeContrast(project, 5, studio)).resolves.toBeNull()
  })
})
