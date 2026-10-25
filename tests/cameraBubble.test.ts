import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }))

import { bubbleSupported } from '../src/main/recording/cameraBubbleWindow'
import { bubbleLayouts, cameraMovesOf, setCameraFollows, setCameraMoves } from '../src/main/recording/cameraMoves'
import type { RecordingManifest } from '../src/main/projects'
import { BUBBLE_DIAMETER, BUBBLE_MARGIN, bubbleBounds, cornerSegments, MIN_CORNER_STAY, nearestCorner, type CameraMove } from '../src/shared/recording/cameraBubble'
import {
  DEFAULT_RECORDING_SETTINGS,
  presetMatches,
  presetRecordingPatch,
  sanitizePresetSetup,
  sanitizeRecordingSettings,
  type PresetSetup
} from '../src/shared/recording/settings'

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }

let n = 0
const ids = (): string => `s${n++}`
const segs = (moves: CameraMove[], duration = 30, def: CameraMove['corner'] = 'bottom-right') =>
  cornerSegments(moves, duration, def, ids).map(({ start, end, corner, layout }) => ({ start, end, corner, layout }))

describe('camera bubble placement', () => {
  it('sits in each corner of the work area, inside the margin', () => {
    const d = BUBBLE_DIAMETER.M
    expect(bubbleBounds(AREA, 'top-left', 'M')).toEqual({ x: BUBBLE_MARGIN, y: BUBBLE_MARGIN, width: d, height: d })
    expect(bubbleBounds(AREA, 'bottom-right', 'M')).toEqual({ x: 1920 - BUBBLE_MARGIN - d, y: 1040 - BUBBLE_MARGIN - d, width: d, height: d })
    // On a second monitor to the left (negative coordinates).
    expect(bubbleBounds({ x: -1280, y: 0, width: 1280, height: 1000 }, 'top-right', 'S')).toMatchObject({ x: -BUBBLE_MARGIN - BUBBLE_DIAMETER.S, y: BUBBLE_MARGIN })
    // Never larger than a tiny area allows.
    expect(bubbleBounds({ x: 0, y: 0, width: 200, height: 150 }, 'top-left', 'L').width).toBe(150 - 2 * BUBBLE_MARGIN)
  })

  it('a dropped bubble goes to the corner of the quadrant its centre is in', () => {
    expect(nearestCorner(AREA, { x: 100, y: 100, width: 184, height: 184 })).toBe('top-left')
    expect(nearestCorner(AREA, { x: 1500, y: 80, width: 184, height: 184 })).toBe('top-right')
    expect(nearestCorner(AREA, { x: 860, y: 600, width: 184, height: 184 })).toBe('bottom-left')
    expect(nearestCorner(AREA, { x: 1000, y: 900, width: 184, height: 184 })).toBe('bottom-right')
  })

  it('is only offered where Windows can keep it out of the capture (10 2004+)', () => {
    expect(bubbleSupported('win32', '10.0.19041')).toBe(true)
    expect(bubbleSupported('win32', '10.0.22631')).toBe(true)
    expect(bubbleSupported('win32', '10.0.18363')).toBe(false)
    expect(bubbleSupported('win32', '6.3.9600')).toBe(false)
    expect(bubbleSupported('darwin', '23.0.0')).toBe(true)
    expect(bubbleSupported('linux', '6.1.0')).toBe(true)
  })
})

describe('bubble moves become camera corners on the layout track', () => {
  it('one segment per stay away from the project corner, touching the next', () => {
    expect(
      segs([
        { t: 0, corner: 'bottom-right' },
        { t: 5, corner: 'top-left' },
        { t: 10, corner: 'top-right' },
        { t: 15, corner: 'bottom-right' }
      ])
    ).toEqual([
      { start: 5, end: 10, corner: 'top-left', layout: 'default' },
      { start: 10, end: 15, corner: 'top-right', layout: 'default' }
    ])
  })

  it('no move away from the project corner: no segments', () => {
    expect(segs([{ t: 0, corner: 'bottom-right' }])).toEqual([])
    expect(segs([])).toEqual([])
  })

  it('a start corner other than the project one applies from 0 (moves during the countdown too)', () => {
    expect(segs([{ t: 0, corner: 'top-left' }])).toEqual([{ start: 0, end: 30, corner: 'top-left', layout: 'default' }])
    // The bubble started bottom right and was moved during the countdown (negative time).
    expect(
      segs([
        { t: -2, corner: 'bottom-right' },
        { t: -1, corner: 'top-right' },
        { t: 8, corner: 'bottom-right' }
      ])
    ).toEqual([{ start: 0, end: 8, corner: 'top-right', layout: 'default' }])
  })

  it('quick back-and-forth moves are left out (shorter than MIN_CORNER_STAY)', () => {
    expect(MIN_CORNER_STAY).toBeGreaterThanOrEqual(0.5)
    // There and straight back: nothing.
    expect(
      segs([
        { t: 0, corner: 'bottom-right' },
        { t: 5, corner: 'top-left' },
        { t: 5.3, corner: 'bottom-right' }
      ])
    ).toEqual([])
    // Through a corner on the way to another: straight to the last one, at the time it got there.
    expect(
      segs([
        { t: 0, corner: 'bottom-right' },
        { t: 5, corner: 'top-left' },
        { t: 5.4, corner: 'top-right' },
        { t: 12, corner: 'bottom-right' }
      ])
    ).toEqual([{ start: 5.4, end: 12, corner: 'top-right', layout: 'default' }])
    // A short visit inside a long stay elsewhere merges into it.
    expect(
      segs([
        { t: 0, corner: 'top-left' },
        { t: 5, corner: 'bottom-left' },
        { t: 5.2, corner: 'top-left' }
      ])
    ).toEqual([{ start: 0, end: 30, corner: 'top-left', layout: 'default' }])
  })

  it('moves at the very start and the very end', () => {
    // Moved right after the start: the first corner is too short, the new one applies from 0.
    expect(
      segs([
        { t: 0, corner: 'bottom-right' },
        { t: 0.3, corner: 'top-left' }
      ])
    ).toEqual([{ start: 0, end: 30, corner: 'top-left', layout: 'default' }])
    // Moved in the last moments (and after the end): left out.
    expect(
      segs([
        { t: 0, corner: 'bottom-right' },
        { t: 29.6, corner: 'top-left' },
        { t: 31, corner: 'top-right' }
      ])
    ).toEqual([])
    // A recording shorter than a stay keeps the corner the bubble went to last.
    expect(
      segs(
        [
          { t: 0, corner: 'bottom-right' },
          { t: 0.4, corner: 'top-left' }
        ],
        0.8
      )
    ).toEqual([{ start: 0, end: 0.8, corner: 'top-left', layout: 'default' }])
  })

  it('every segment is at least MIN_CORNER_STAY long and none overlap, whatever the moves', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
    for (let run = 0; run < 200; run++) {
      const moves: CameraMove[] = []
      let t = -1
      for (let i = 0; i < 12; i++) {
        t += rand() * 3
        moves.push({ t, corner: corners[Math.floor(rand() * 4)] })
      }
      const out = cornerSegments(moves, 20, 'bottom-right', ids)
      out.forEach((s, i) => {
        expect(s.end - s.start).toBeGreaterThanOrEqual(MIN_CORNER_STAY - 1e-9)
        expect(s.start).toBeGreaterThanOrEqual(0)
        expect(s.end).toBeLessThanOrEqual(20)
        expect(s.corner).not.toBe('bottom-right')
        if (i > 0) expect(s.start).toBeGreaterThanOrEqual(out[i - 1].end)
      })
    }
  })

  it('ignores malformed moves', () => {
    expect(segs([{ t: NaN, corner: 'top-left' }, { t: 3, corner: 'middle' as never }])).toEqual([])
  })
})

describe('bubble moves in the recording manifest (main process)', () => {
  const manifest = (): RecordingManifest =>
    ({ version: 1, id: 'r', createdAt: '', status: 'recording', error: null, method: 'chromium', sourceKind: 'screen', region: null, startedAt: 1000, width: 0, height: 0, hasAudio: false, hasWebcam: true, webcamFps: 30, webcamOffset: 0, audioOffset: 0, duration: null }) as RecordingManifest

  it('times moves on the recording timeline: paused time left out, a move while paused applies on resume', () => {
    const m = manifest()
    setCameraFollows(m, true)
    // Recording from 1000 ms; paused 6000..9000 ms.
    const pauses = [{ from: 6000, to: 9000 }]
    setCameraMoves(
      m,
      [
        { at: 500, corner: 'bottom-right' }, // the countdown: from 0
        { at: 4000, corner: 'top-left' }, // 3 s in
        { at: 7000, corner: 'top-right' }, // while paused: 5 s in (on resume)
        { at: 12000, corner: 'bottom-right' } // 8 s in
      ],
      1000,
      pauses
    )
    expect(cameraMovesOf(m)).toEqual([
      { t: 0, corner: 'bottom-right' },
      { t: 3, corner: 'top-left' },
      { t: 5, corner: 'top-right' },
      { t: 8, corner: 'bottom-right' }
    ])
    expect(bubbleLayouts(m, 20, 'bottom-right').map(({ start, end, corner }) => ({ start, end, corner }))).toEqual([
      { start: 3, end: 5, corner: 'top-left' },
      { start: 5, end: 8, corner: 'top-right' }
    ])
  })

  it('no segments when the camera does not follow the bubble, or for older manifests', () => {
    const m = manifest()
    setCameraMoves(m, [{ at: 4000, corner: 'top-left' }], 1000, [])
    expect(cameraMovesOf(m)).toHaveLength(1)
    setCameraFollows(m, false)
    expect(cameraMovesOf(m)).toEqual([])
    expect(bubbleLayouts(manifest(), 20, 'bottom-right')).toEqual([])
    expect(cameraMovesOf({ ...manifest(), cameraMoves: [{ t: 'x', corner: 'top-left' }, { t: 2, corner: 'nowhere' }] } as RecordingManifest)).toEqual([])
  })
})

describe('"Camera follows the preview bubble" option', () => {
  const SETUP: PresetSetup = {
    source: 'screen',
    fps: 60,
    countdown: 3,
    autoPause: false,
    idleSeconds: 10,
    hideDesktopIcons: false,
    captureKeys: true,
    systemAudio: true,
    mic: null,
    camera: { id: 'cam', label: 'Camera' }
  }

  it('is on by default, and repaired when malformed', () => {
    expect(DEFAULT_RECORDING_SETTINGS.cameraFollowsBubble).toBe(true)
    expect(sanitizeRecordingSettings({}).cameraFollowsBubble).toBe(true)
    expect(sanitizeRecordingSettings({ cameraFollowsBubble: 'no' }).cameraFollowsBubble).toBe(true)
    expect(sanitizeRecordingSettings({ cameraFollowsBubble: false }).cameraFollowsBubble).toBe(false)
  })

  it('is part of presets that set it; older presets leave it alone', () => {
    expect(sanitizePresetSetup({ ...SETUP, cameraFollowsBubble: false }).cameraFollowsBubble).toBe(false)
    expect('cameraFollowsBubble' in sanitizePresetSetup(SETUP)).toBe(false)
    expect(presetRecordingPatch({ ...SETUP, cameraFollowsBubble: false })).toMatchObject({ cameraFollowsBubble: false })
    expect('cameraFollowsBubble' in presetRecordingPatch(SETUP)).toBe(false)
    // Matching: an older preset counts as "on"; without a camera the option does not count.
    expect(presetMatches(SETUP, { ...SETUP, cameraFollowsBubble: true })).toBe(true)
    expect(presetMatches(SETUP, { ...SETUP, cameraFollowsBubble: false })).toBe(false)
    expect(presetMatches({ ...SETUP, camera: null }, { ...SETUP, camera: null, cameraFollowsBubble: false })).toBe(true)
  })
})
