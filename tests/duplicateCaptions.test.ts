import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionSettings, Graphic, Project } from '../src/shared/types'

/*
 * Make a vertical version with Captions Studio (docs/design/captions-studio.md §10.5, test 59): the
 * caption look is chosen again for the new shape when it was not picked by hand or is an unedited
 * tile, with its notice; an edited, saved or brand look is kept; a dragged caption block and dragged
 * graphics are refitted. Auto style (part P4) is a stand-in that picks as §11.6 does for the tall
 * frame: Bold Pop when the camera leads, Clean Short otherwise.
 */

const auto = vi.hoisted(() => ({ cameraLed: false, calls: [] as { project: Project; frame: { w: number; h: number } }[] }))
vi.mock('../src/shared/captions/autoStyle', async () => {
  const { studioPreset } = await import('../src/shared/captions/studioPresets')
  return {
    autoStyle: (project: Project, frame: { w: number; h: number }) => {
      auto.calls.push({ project, frame })
      const tile = auto.cameraLed ? 'bold-pop' : 'clean-short'
      return { tile, studio: { ...studioPreset(tile)!.look, from: tile }, reason: 'tall' }
    }
  }
})
vi.mock('../src/shared/captions/studioEdit', async () => await import('./studioStandIns'))

const { captionCopyNotice, lookChosenAgain, projectCopy } = await import('../src/shared/editor/duplicate')
const { createProject } = await import('../src/shared/engine/project')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { studioPreset } = await import('../src/shared/captions/studioPresets')

const subtitle = studioPreset('subtitle')!.look
function wide(captions?: CaptionSettings, extra: Partial<Project> = {}): Project {
  return {
    ...createProject({ id: 'p', name: 'Demo', duration: 20, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
    transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count today' }] } as Project['transcript'],
    ...(captions ? { captions } : {}),
    ...extra
  }
}

beforeEach(() => {
  auto.cameraLed = false
  auto.calls.length = 0
})

describe('the caption look of a vertical version', () => {
  it('an automatic Subtitle becomes Clean Short (screen-led), with the notice', () => {
    const p = wide({ ...DEFAULT_CAPTIONS, studio: subtitle })
    const copy = projectCopy(p, 'vertical', null)
    expect(copy.captions?.studio?.from).toBe('clean-short')
    expect(copy.captions?.preset).toBe(studioPreset('clean-short')!.fallback)
    expect(copy.captions).not.toHaveProperty('picked')
    expect(auto.calls[0].frame.h).toBeGreaterThan(auto.calls[0].frame.w)
    expect(captionCopyNotice(p, copy, 'vertical')).toBe('Captions: Clean Short for the vertical version')
  })

  it('an unedited Subtitle picked by hand becomes Bold Pop when the camera leads', () => {
    auto.cameraLed = true
    const p = wide({ ...DEFAULT_CAPTIONS, studio: subtitle, picked: true })
    const copy = projectCopy(p, 'vertical', null)
    expect(copy.captions?.studio?.from).toBe('bold-pop')
    expect(captionCopyNotice(p, copy, 'vertical')).toBe('Captions: Bold Pop for the vertical version')
    // Auto style is asked about the look as if nobody had picked it.
    expect(auto.calls[0].project.captions).not.toHaveProperty('picked')
  })

  it('the default Classic look, never picked, is chosen again', () => {
    expect(projectCopy(wide(), 'square', null).captions?.studio?.from).toBe('clean-short')
    expect(lookChosenAgain(undefined)).toBe(true)
  })

  it('keeps an edited, a saved, a brand and a Classic look picked by hand, without a notice', () => {
    const edited = { ...DEFAULT_CAPTIONS, studio: { ...subtitle, text: { ...subtitle.text, size: 0.07 } }, picked: true as const }
    const saved = { ...DEFAULT_CAPTIONS, studio: { ...subtitle, from: 'mine:abc' }, picked: true as const }
    const brand = { ...DEFAULT_CAPTIONS, studio: { ...subtitle, from: 'brand' }, picked: true as const }
    const classic = { ...DEFAULT_CAPTIONS, preset: 'boxed' as const, picked: true as const }
    for (const c of [edited, saved, brand, classic]) {
      const p = wide(c)
      const copy = projectCopy(p, 'vertical', null)
      expect(copy.captions).toBe(c)
      expect(captionCopyNotice(p, copy, 'vertical')).toBeNull()
    }
    expect(auto.calls).toHaveLength(0)
  })

  it('a plain copy and a project without captions keep their look', () => {
    const p = wide({ ...DEFAULT_CAPTIONS, studio: subtitle })
    expect(projectCopy(p, 'copy', null).captions).toBe(p.captions)
    const none = { ...p, transcript: undefined }
    expect(projectCopy(none, 'vertical', null).captions).toBe(p.captions)
    expect(auto.calls).toHaveLength(0)
  })
})

describe('dragged captions and graphics are refitted (§10.5)', () => {
  it('a dragged caption block moves into the text area of the tall frame and keeps its drag', () => {
    const p = wide({ ...DEFAULT_CAPTIONS, studio: { ...subtitle, layout: { ...subtitle.layout, place: { x: 0.5, y: 0.99 } } }, picked: true })
    const place = projectCopy(p, 'vertical', null).captions!.studio!.layout.place!
    expect(place.y).toBeLessThan(0.99)
    expect(place.x).toBe(0.5)
  })

  it('a dragged graphic is shifted in, one placed automatically is left alone', () => {
    const g = (id: string, place: Graphic['place']): Graphic => ({ id, kind: 'keyword', start: 1, end: 3, place, size: 0.09, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, text: 'Auto Save', look: 'card' }) as Graphic
    const autoPlaced = g('a', 'auto')
    const p = wide(undefined, { graphics: [autoPlaced, g('d', { x: 0.98, y: 0.02 })] })
    const [a, d] = projectCopy(p, 'vertical', null).graphics!
    expect(a).toBe(autoPlaced)
    const place = d.place as { x: number; y: number }
    expect(place.x).toBeLessThan(0.98)
    expect(place.y).toBeGreaterThan(0.02)
  })
})
