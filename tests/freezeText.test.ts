// Text on a freeze (E-11, docs/design/freeze-frame.md §4.8): "Add text on the freeze" shows through
// the whole freeze, also on a pause freeze at or just before the edit's end. Its text then runs to the
// edit's end, and the hold repeats a moment inside the text's fade-out there.
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('Path2D', class {})

import { createAnnotation } from '../src/shared/editor/annotations'
import { freezeTextRange } from '../src/shared/editor/freezeEdit'
import { planOf, videoFrames } from '../src/shared/engine/freeze'
import { createProject } from '../src/shared/engine/project'
import { outputDuration, outputToSource } from '../src/shared/engine/timeline'
import type { Freeze, Project } from '../src/shared/types'

type DrawAnnotations = (ctx: unknown, w: number, h: number, t: number, project: Project) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const TEXT_OVERLAYS = '../src/renderer/src/render/textOverlays'
const { drawAnnotations } = (await import(/* @vite-ignore */ TEXT_OVERLAYS)) as { drawAnnotations: DrawAnnotations }

/** The opacity the project's text is drawn with at source time `t` (0: not drawn). */
function alphaAt(p: Project, t: number): number {
  let alpha = 0
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 10 })
      if (prop === 'fillText') return () => void (alpha = Number(target.globalAlpha))
      return () => {}
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  drawAnnotations(ctx, 1280, 720, t, p)
  return alpha
}

const freeze = (id: string, at: number, sound: Freeze['sound'] = 'pause'): Freeze => ({ id, at, length: 3, sound })

/** A 6 s recording (as in the e2e) with `freezes`, and a text added on `on` as the Clip panel adds it. */
function project(freezes: Freeze[], on?: Freeze): Project {
  const p: Project = {
    ...createProject({
      id: 'p',
      name: 'Text',
      duration: 6,
      width: 1280,
      height: 720,
      hasWebcam: false,
      hasAudio: true,
      webcamOffset: 0,
      zooms: [],
      cursorValid: false,
      capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
    }),
    ...(freezes.length > 0 && { freezes })
  }
  const range = on ? freezeTextRange(p.clips, on)! : { start: 5.5, end: 6 }
  return { ...p, annotations: [{ ...createAnnotation(range.start, p.duration, range), text: 'Read this' }] }
}

describe('text on a freeze near the end of the video', () => {
  it('shows fully on every held frame of a freeze at the end: the export at 30 and 60 fps, the preview, the Frame slider', () => {
    const f = freeze('e', 6)
    const p = project([f], f)
    expect(p.annotations[0]).toMatchObject({ start: 5.5, end: 6 })
    for (const fps of [30, 60]) {
      const { pictures, held } = videoFrames(p.clips, planOf(p), fps)
      const last = pictures.length - 1
      expect(held![last]).toBe(1)
      expect(alphaAt(p, pictures[last])).toBe(1)
    }
    // The preview's end hold (frameTimeFor(last.end) at 60 fps) and the export dialog's Frame slider in it.
    expect(alphaAt(p, 6 - 1 / 240)).toBe(1)
    expect(alphaAt(p, outputToSource(p.clips, outputDuration(p.clips) - 0.001).time)).toBe(1)
    // It still fades in.
    expect(alphaAt(p, 5.55)).toBeCloseTo(1 / 3, 9)
  })

  it('shows fully through a pause freeze less than a fade before the end', () => {
    const f = freeze('n', 5.9)
    const p = project([f], f)
    expect(p.annotations[0].end).toBe(6)
    expect(alphaAt(p, 5.9)).toBe(1)
  })

  it('fades out at the end as before when no pause freeze holds the end', () => {
    // At the last frame of a 30 fps export: 0.033 s before the end, with a 0.15 s fade.
    const lastFrame = 179 / 30
    const before = (6 - lastFrame) / 0.15
    expect(alphaAt(project([]), lastFrame)).toBeCloseTo(before, 9)
    expect(alphaAt(project([freeze('a', 2)]), lastFrame)).toBeCloseTo(before, 9)
    expect(alphaAt(project([freeze('m', 5.8)]), lastFrame)).toBeCloseTo(before, 9)
    expect(alphaAt(project([freeze('k', 5.9, 'continue')]), lastFrame)).toBeCloseTo(before, 9)
  })
})
