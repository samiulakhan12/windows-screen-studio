import { describe, expect, it } from 'vitest'
import { captionAlpha } from '../src/shared/captions/layout'
import { animationTime } from '../src/shared/engine/backgrounds'
import { loopHomeWeight } from '../src/shared/render/cursorFx'
import { chapterParts } from '../src/shared/render/exportBundle'
import { overlayAlpha, overlayClockMs } from '../src/shared/render/imageOverlays'
import { titlePhase } from '../src/shared/render/titleCards'
import type { ChapterPart } from '../src/shared/render/exportBundle'
import type { Chapter, Clip, Project } from '../src/shared/types'

interface Run {
  partSource<S extends { project: Project }>(source: S, part: ChapterPart, last: boolean): S
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/editor/exportBundleRun'
const { partSource } = (await import(/* @vite-ignore */ RUN)) as Run

const clip = (id: string, start: number, end: number): Clip => ({ id, start, end, speed: 1 })
const ch = (t: number, title: string): Chapter => ({ id: `k${t}`, t, title })

describe('one file per chapter', () => {
  // The whole edit 0-60 s, chapters at 0, 20 and 40 s; the scene holds the project as drawn.
  const project = { clips: [clip('a', 0, 60)], chapters: [ch(0, 'One'), ch(20, 'Two'), ch(40, 'Three')] } as unknown as Project
  const scene = { project: { ...project } }
  const parts = chapterParts(project)
  const sources = parts.map((part, i) => partSource({ project, scene }, part, i === parts.length - 1))

  it('exports each part with its own clips but draws it with the whole edit', () => {
    expect(sources.map((s) => s.project.clips.map((c) => [c.start, c.end]))).toEqual([[[0, 20]], [[20, 40]], [[40, 60]]])
    for (const s of sources) {
      expect('chapters' in s.project).toBe(false)
      expect(s.scene).toBe(scene)
    }
  })

  it('shows captions, titles, overlays, the background and the cursor as the whole export does', () => {
    const whole = scene.project.clips
    const [first, second] = sources.map((s) => s.scene.project.clips)
    const caption = [{ id: 'c', start: 19.5, end: 21, text: 'Across' }]
    expect(captionAlpha(caption, 0, 20, second)).toBe(captionAlpha(caption, 0, 20, whole))
    expect(captionAlpha(caption, 0, 19.95, first)).toBe(captionAlpha(caption, 0, 19.95, whole))
    const card = { start: 18, end: 25, style: 'centered' } as const
    expect(titlePhase(card, 20, second)).toEqual(titlePhase(card, 20, whole))
    const logo = { start: 0, end: 60, opacity: 1, fadeIn: 0.5, fadeOut: 0.5 }
    expect(overlayAlpha(logo, 20, second)).toBe(1)
    expect(overlayAlpha(logo, 19.8, first)).toBe(1)
    expect(overlayClockMs({ start: 15 }, 20, second)).toBe(overlayClockMs({ start: 15 }, 20, whole))
    expect(animationTime(second, 20)).toBe(animationTime(whole, 20))
    expect(loopHomeWeight(first, 19.5)).toBe(loopHomeWeight(whole, 19.5))
  })
})
