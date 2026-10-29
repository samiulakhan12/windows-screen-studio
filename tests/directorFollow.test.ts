import { describe, expect, it } from 'vitest'
import type { DirectorSpeech } from '../src/shared/audio/speech'
import { planDirector, type DirectorInput } from '../src/shared/editor/cameraDirector'
import { NOTE_TEXT } from '../src/shared/editor/directorCopy'
import { cornerCosts } from '../src/shared/editor/directorCorners'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { directorSettingsOf } from '../src/shared/engine/directorData'
import { createProject } from '../src/shared/engine/project'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import { focusPathFor } from '../src/shared/engine/zoom'
import type { AspectRatio, Corner, CursorSample, CursorTrack, Project, ReframeSettings } from '../src/shared/types'

/*
 * The camera director while the view follows the action (docs/design/vertical-video.md §5.14,
 * test 46): the bubble's corners are costed where the cursor is drawn in the followed frame, and
 * with a camera band the director moves no corner but keeps the intro, the outro and the hidden
 * parts.
 */

function project(aspectRatio: AspectRatio, reframe: Partial<ReframeSettings> | null, duration = 40): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return {
    ...p,
    style: { ...p.style, padding: 0, aspectRatio },
    webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    cursor: { ...p.cursor, show: true, hideWhenIdle: false, smoothing: 0 },
    ...(reframe ? { reframe: { ...DEFAULT_REFRAME, ...reframe } } : {})
  }
}

const still = (x: number, y: number, duration = 40): CursorTrack => ({
  samples: Array.from({ length: duration * 20 + 1 }, (_, i): CursorSample => ({ t: i / 20, x, y })),
  clicks: [],
  valid: true
})

/** The highest cost of each corner over the video. */
function peaks(p: Project, track: CursorTrack): Record<Corner, number> {
  const costs = cornerCosts(p, track, new SmoothedTrack(track.samples, p.duration, p.cursor.smoothing), focusPathFor(track.samples, p.duration))
  const out = {} as Record<Corner, number>
  for (const c of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) out[c] = Math.max(...costs.costs[c])
  return out
}

describe('corner costs as drawn in the followed frame (test 46)', () => {
  it('a cursor at x 0.85 centred in a 9:16 view costs no corner, where a 16:9 frame puts it by the right corner', () => {
    const track = still(0.85, 0.94)
    const followed = peaks(project('9:16', { camera: 'bubble' }), track)
    for (const c of Object.values(followed)) expect(c).toBe(0)
    expect(peaks(project('auto', null), track)['bottom-right']).toBeGreaterThan(0.4)
  })

  it('a cursor drawn in the bottom right of the followed view costs that corner, where the fitted 9:16 frame does not', () => {
    const track = still(0.95, 0.95)
    expect(peaks(project('9:16', { camera: 'bubble' }), track)['bottom-right']).toBeGreaterThan(0.4)
    expect(peaks(project('9:16', { camera: 'bubble', mode: 'fit' }), track)['bottom-right']).toBe(0)
    expect(peaks(project('9:16', null), track)['bottom-right']).toBe(0)
  })

  it('caches per follow settings and plan', () => {
    const p = project('9:16', { camera: 'bubble' })
    const track = still(0.95, 0.95)
    const path = new SmoothedTrack(track.samples, p.duration, 0)
    const focus = focusPathFor(track.samples, p.duration)
    const a = cornerCosts(p, track, path, focus)
    expect(cornerCosts({ ...p }, track, path, focus)).toBe(a)
    expect(cornerCosts({ ...p, reframe: { ...p.reframe!, level: 1.5 } }, track, path, focus)).not.toBe(a)
  })
})

describe('the director with a camera band (test 46)', () => {
  // As the director's e2e fixture: the cursor rests in the middle, goes to the bottom right at 8 s and clicks there; talk before and after.
  const duration = 48
  const samples: CursorSample[] = Array.from({ length: 481 }, (_, i) => {
    const t = i / 10
    const k = Math.min(1, Math.max(0, (t - 8) / 0.5))
    return { t, x: 0.5 + 0.42 * k, y: 0.5 + 0.4 * k }
  })
  const cursor: CursorTrack = { samples, clicks: [13, 16, 19, 22, 25].map((t) => ({ t, x: 0.92, y: 0.9, button: 'left' as const })), valid: true }
  const speech: DirectorSpeech = { source: 'mic', refined: false, ranges: [{ start: 0.5, end: 6 }, { start: 17, end: 22 }, { start: 34, end: 46.5 }] }
  const plan = (p: Project) => {
    let n = 0
    const input: DirectorInput = { project: p, cursor, speech, newId: () => `a${++n}` }
    return planDirector(input, directorSettingsOf(p))
  }

  it('moves no corner in a band, and keeps the intro, the outro and the hidden parts', () => {
    const band = plan(project('9:16', { camera: 'top' }, duration))
    const kinds = band.parts.map((p) => p.kind)
    expect(kinds).toContain('intro')
    expect(kinds).toContain('outro')
    expect(kinds).toContain('hidden')
    expect(kinds).not.toContain('corner')
    expect(band.layouts.some((s) => s.layout === 'default' && s.corner)).toBe(false)
    expect(band.notes).toContain('band')
    expect(NOTE_TEXT.band).toBe('The camera is in a band while the view follows the action, so it is not moved between corners.')
  })

  it('in the bubble the same video moves the corner away from the cursor; the fitted 16:9 frame as before, without the band note', () => {
    const bubble = plan(project('9:16', { camera: 'bubble' }, duration))
    expect(bubble.parts.some((p) => p.kind === 'corner')).toBe(true)
    expect(bubble.notes).not.toContain('band')
    const wide = plan(project('auto', null, duration))
    expect(wide.parts.some((p) => p.kind === 'corner')).toBe(true)
    expect(wide.notes).not.toContain('band')
    // A band chosen in a frame that does not follow is no band.
    expect(plan(project('auto', { camera: 'top' }, duration)).notes).not.toContain('band')
  })
})
