/** Projects for Captions Studio part P4's tests: a recording with captions in a frame of a given shape. */
import { createProject } from '../src/shared/engine/project'
import type { AspectRatio, CaptionSegment, LayoutSegment, Project } from '../src/shared/types'

export const WIDE = { w: 1920, h: 1080 }
export const TALL = { w: 1080, h: 1920 }
export const SQUARE = { w: 1080, h: 1080 }

/** Captions every 4 s ("c0", "c1", …), each 3.6 s long. */
export function captions(texts: readonly string[], prefix = 'c', every = 4): CaptionSegment[] {
  return texts.map((text, i) => ({ id: `${prefix}${i}`, start: i * every, end: i * every + every * 0.9, text }))
}

export function studioProject(
  opts: { segments?: CaptionSegment[]; language?: string; aspect?: AspectRatio; camera?: 'none' | 'small' | 'large'; duration?: number } & Partial<Project> = {}
): Project {
  const { segments = [], language = 'en', aspect = '16:9', camera = 'none', duration, ...over } = opts
  const end = duration ?? Math.max(30, ...segments.map((s) => s.end + 1))
  const p = createProject({
    id: 'p4',
    name: 'p4',
    duration: end,
    width: 1920,
    height: 1080,
    hasWebcam: camera !== 'none',
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  const layouts: LayoutSegment[] = camera === 'large' ? [{ id: 'l1', start: 0, end, layout: 'camera-large' }] : []
  return {
    ...p,
    clips: [{ id: 'k0', start: 0, end, speed: 1 }],
    style: { ...p.style, aspectRatio: aspect },
    webcam: { ...p.webcam, show: camera !== 'none' },
    ...(layouts.length ? { layouts } : {}),
    ...(segments.length ? { transcript: { language, provider: 'local', model: 'm', createdAt: '', segments } } : {}),
    ...over
  } as Project
}
