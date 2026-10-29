import { describe, expect, it } from 'vitest'
import { captionAlpha } from '../src/shared/captions/layout'
import { animationTime } from '../src/shared/engine/backgrounds'
import { planOf, videoFrames } from '../src/shared/engine/freeze'
import { loopHomeWeight } from '../src/shared/render/cursorFx'
import { chapterParts, chaptersNote, stillAcrossChapters } from '../src/shared/render/exportBundle'
import { overlayAlpha, overlayClockMs } from '../src/shared/render/imageOverlays'
import { titlePhase } from '../src/shared/render/titleCards'
import type { ChapterPart } from '../src/shared/render/exportBundle'
import type { Chapter, Clip, Freeze, Project } from '../src/shared/types'

interface Run {
  partSource<S extends { project: Project }>(source: S, part: ChapterPart, last: boolean): S
  partThumbnailFrame(project: Pick<Project, 'clips' | 'freezes'>): { time: number; soundTime: number; held: boolean }
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/editor/exportBundleRun'
const { partSource, partThumbnailFrame } = (await import(/* @vite-ignore */ RUN)) as Run

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

  it('takes the thumbnail 1 s in as the part draws it, a freeze that keeps the sound playing included', () => {
    const freezes: Freeze[] = [{ id: 'f', at: 20, length: 5, sound: 'continue' }]
    const still = { clips: [clip('a', 0, 60)], freezes, chapters: [ch(0, 'One'), ch(20, 'Two')] } as unknown as Project
    const stillParts = chapterParts(still)
    expect(stillAcrossChapters(still, stillParts)).toBe(false)
    const second = partSource({ project: still }, stillParts[1], true).project
    const fps = 30
    const frames = videoFrames(second.clips, planOf(second), fps)
    expect(partThumbnailFrame(second)).toEqual({ time: frames.pictures[fps], soundTime: frames.times[fps], held: !!frames.held?.[fps] })
    expect(partThumbnailFrame(second)).toEqual({ time: 20, soundTime: 21, held: true })
    // Without freezes: the live frame 1 s in, with motion blur.
    expect(partThumbnailFrame(sources[1].project)).toEqual({ time: 21, soundTime: 21, held: false })
  })
})

describe('one file per chapter: what the export dialog says', () => {
  interface El {
    type: unknown
    props: Record<string, unknown>
  }
  type Options = (props: Record<string, unknown>) => unknown
  // Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
  const OPTIONS = '../src/renderer/src/editor/ExportBundleOptions'
  const elements = (node: unknown, out: El[] = []): El[] => {
    if (Array.isArray(node)) node.forEach((n) => elements(n, out))
    else if (node && typeof node === 'object' && 'props' in node) {
      out.push(node as El)
      elements((node as El).props.children, out)
    }
    return out
  }
  const thumbnailTitle = async (perChapter: boolean): Promise<string> => {
    const { ExportBundleOptions } = (await import(/* @vite-ignore */ OPTIONS)) as { ExportBundleOptions: Options }
    const tree = ExportBundleOptions({
      value: { srt: false, vtt: false, chapters: false, thumbnail: true, description: false, perChapter },
      onChange: () => undefined,
      format: 'mp4',
      has: { captions: false, chapters: true },
      mode: 'single',
      chapterCount: 3
    })
    return String(elements(tree).find((e) => e.props['data-sidecar'] === 'thumbnail')!.props.title)
  }

  it('says the parts have no chapter markers', () => {
    expect(chaptersNote(3, false, false)).toBe('3 chapters, written into the file.')
    expect(chaptersNote(3, false, true)).toBe('3 chapters, one file each (the files have no chapter markers).')
    expect(chaptersNote(1, true, false)).toBe('1 chapter · GIFs have no chapters, other formats keep them.')
  })

  it('says each part gets the frame 1 s in as its thumbnail, not the frame chosen above', async () => {
    expect(await thumbnailTitle(false)).toBe('Save the frame chosen above as a PNG at the export size')
    expect(await thumbnailTitle(true)).toBe('Save the frame 1 s into each part as a PNG at the export size')
  })
})
