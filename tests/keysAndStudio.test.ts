import { beforeEach, describe, expect, it, vi } from 'vitest'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionStudio, CursorTrack, Project, StudioPosition } from '../src/shared/types'
import { calls, canvas, contextOf, hooks } from './studioFakes'

/*
 * Key presses and Captions Studio blocks (docs/design/captions-studio.md §8.5, test 54): the
 * Studio branch of captionBlockAt reports the block's nearer edge, so the key presses
 * (textOverlays.ts, unchanged) sit just inside it and never cover it.
 */

vi.mock('../src/shared/captions/studioLayout', async () => (await import('./studioFakes')).fakeStudioLayout)
vi.mock('../src/shared/captions/motion', async () => (await import('./studioFakes')).fakeMotion)
vi.mock('../src/shared/captions/replaced', async () => (await import('./studioFakes')).fakeReplaced)
vi.mock('../src/shared/captions/captionTracks', async (original) => (await import('./studioFakes')).fakeCaptionTracks(await original()))
vi.mock('../src/shared/captions/fontStack', async () => (await import('./studioFakes')).fakeFontStack)
vi.mock('../src/shared/captions/colors', async () => (await import('./studioFakes')).fakeColors)
vi.mock('../src/shared/captions/marks', async () => (await import('./studioFakes')).fakeMarks)
vi.mock('../src/shared/captions/words', async (original) => ({ ...(await original()), ...(await import('./studioFakes')).fakeWords }))
vi.mock('../src/shared/render/actionRects', async () => (await import('./studioFakes')).fakeActionRects)

vi.stubGlobal('document', { createElement: () => canvas(), fonts: { add() {}, delete() {} } })
vi.stubGlobal('Path2D', class {})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const OVERLAYS = '../src/renderer/src/render/textOverlays'
const LAYER = '../src/renderer/src/render/captionsLayer'
const { drawKeystrokes } = (await import(/* @vite-ignore */ OVERLAYS)) as { drawKeystrokes: (ctx: unknown, w: number, h: number, t: number, p: Project, cursor: CursorTrack, area?: unknown) => void }
const STUDIO = '../src/renderer/src/render/studioLayer'
const { captionBlockAt } = (await import(/* @vite-ignore */ LAYER)) as { captionBlockAt: (ctx: unknown, p: Project, t: number, w: number, h: number) => { position: string; top: number; bottom: number } | null }
const { studioBlockAt } = (await import(/* @vite-ignore */ STUDIO)) as { studioBlockAt: (ctx: unknown, p: Project, t: number, w: number, h: number) => { box: { y: number; h: number } } | null }

const cursor = { valid: true, samples: [], clicks: [], keys: [{ t: 1.0, label: 'Ctrl+S' }] } as unknown as CursorTrack

function project(id: string, position: StudioPosition): Project {
  const studio: CaptionStudio = structuredClone(studioPreset(id)!.look)
  studio.layout.position = position
  return {
    id: 'p1',
    clips: [{ start: 0, end: 10, speed: 1 }],
    fonts: [],
    annotations: [],
    titles: [],
    webcam: { show: false },
    effects: { keystrokes: { show: true, position: 'bottom', size: 0.035 } },
    transcript: { language: 'en', segments: [{ id: 'c1', start: 0.5, end: 3, text: 'Open the export dialog and save' }] },
    captions: { show: true, preset: 'boxed', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'box', maxLines: 2, studio }
  } as unknown as Project
}

/** The key presses' box: the dark pill drawn on the frame. */
function keyBox(id: number): { top: number; bottom: number } {
  const pill = calls.find((c) => c.canvas === id && c.name === 'roundRect' && calls.some((f) => f.canvas === id && f.name === 'fill' && f.fill === 'rgba(16,16,22,0.84)'))!
  const [, y, , h] = pill.args as number[]
  return { top: y, bottom: y + h }
}

beforeEach(() => {
  calls.length = 0
  hooks.log.length = 0
})

describe('key presses keep clear of Studio blocks (test 54)', () => {
  for (const id of ['editorial', 'weight-shift'])
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920]
    ])
      it(`${id} at Lower in ${w}x${h}: the keys and the caption do not overlap`, () => {
        const p = project(id, 'lower')
        const c = canvas(w, h)
        const ctx = contextOf(c)
        expect(captionBlockAt(ctx, p, 1.3, w, h)!.position).toBe('bottom')
        drawKeystrokes(ctx, w, h, 1.3, p, cursor)
        const keys = keyBox(c.id)
        // The block as the Studio layer draws it.
        const { box } = studioBlockAt(ctx, p, 1.3, w, h)!
        expect(keys.bottom <= box.y || keys.top >= box.y + box.h).toBe(true)
      })

  it('reports the nearer edge: bottom for Lower and Bottom, top for Upper and Top, middle for Middle', () => {
    const ctx = contextOf(canvas())
    const edge = (position: StudioPosition): string => captionBlockAt(ctx, project('editorial', position), 1.0, 1920, 1080)!.position
    expect([edge('bottom'), edge('lower'), edge('middle'), edge('upper'), edge('top')]).toEqual(['bottom', 'bottom', 'middle', 'top', 'top'])
  })
})
