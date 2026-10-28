import { createAnnotation } from '../src/shared/editor/annotations'
import { createShape, createSpotlight } from '../src/shared/editor/shapes'
import { createProject } from '../src/shared/engine/project'
import type { Annotation, Chapter, Freeze, Project, Shape, Spotlight, TitleCard, ZoomSegment } from '../src/shared/types'

/*
 * The fixture of the E-06 unit tests (docs/design/multi-select.md §10.1): P20, a 20 s recording
 * with a cut at 8-10 s (clips 0-8 and 10-20), at 60 fps, and helpers that make items with fixed ids.
 */

export const zoom = (id: string, start: number, end: number, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id,
  start,
  end,
  scale: 2,
  focus: { mode: 'cursor' },
  auto: false,
  ...extra
})

export const text = (id: string, start: number, end: number, extra: Partial<Annotation> = {}): Annotation => ({ ...createAnnotation(start, 100), id, start, end, ...extra })

export const shape = (id: string, kind: Shape['kind'], start: number, end: number, extra: Partial<Shape> = {}): Shape => ({ ...createShape(kind, start, 100), id, start, end, ...extra })

export const spot = (id: string, start: number, end: number, extra: Partial<Spotlight> = {}): Spotlight => ({ ...createSpotlight('region', start, 100), id, start, end, ...extra })

export const title = (id: string, start: number, end: number, extra: Partial<TitleCard> = {}): TitleCard => ({
  id,
  start,
  end,
  title: 'Title',
  style: 'centered',
  background: 'blur',
  ...extra
})

export const chapter = (id: string, t: number, name = 'Chapter'): Chapter => ({ id, t, title: name })

export const freeze = (id: string, at: number, extra: Partial<Freeze> = {}): Freeze => ({ id, at, length: 2, sound: 'pause', ...extra })

/** P20 with `items` added. */
export function p20(items: Partial<Pick<Project, 'zooms' | 'annotations' | 'shapes' | 'spotlights' | 'titles' | 'chapters' | 'freezes' | 'crop'>> = {}): Project {
  const p = createProject({
    id: 'p20',
    name: 'P20',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  return {
    ...p,
    clips: [
      { id: 'c0', start: 0, end: 8, speed: 1 },
      { id: 'c1', start: 10, end: 20, speed: 1 }
    ],
    ...items
  }
}
