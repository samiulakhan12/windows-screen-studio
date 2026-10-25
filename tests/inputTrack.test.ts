/**
 * The effective track (docs/design/smarter-auto-zoom.md §3): the recorded track with the
 * project's input edits applied, memoised, and what the ignored clicks no longer drive.
 */
import { describe, expect, it } from 'vitest'
import { inputGaps } from '../src/shared/editor/smartSpeed'
import { effectiveTrack, type InputContext } from '../src/shared/engine/inputTrack'
import { createProject } from '../src/shared/engine/project'
import { clickSoundJob, soundingClicks } from '../src/shared/render/clickSound'
import type { ClickEvent, CursorSample, CursorTrack, InputEdits, Project } from '../src/shared/types'

const click = (t: number, x = 0.5, y = 0.5, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x, y, button })

/** A rest at (0.2, 0.5), a wobbly move over 1.0..1.6 s, a rest at (0.6, 0.5); clicks at 2, 4 and 9 (resting). */
function recordedTrack(): CursorTrack {
  const samples: CursorSample[] = [
    { t: 0, x: 0.2, y: 0.5 },
    { t: 0.5, x: 0.2, y: 0.5 },
    { t: 1, x: 0.2, y: 0.5 }
  ]
  for (let k = 1; k < 36; k++) {
    const u = k / 36
    samples.push({ t: 1 + k / 60, x: 0.2 + 0.4 * u, y: 0.5 + 0.02 * Math.sin(3 * Math.PI * u) })
  }
  samples.push({ t: 1.6, x: 0.6, y: 0.5 }, { t: 5, x: 0.6, y: 0.5 }, { t: 20, x: 0.6, y: 0.5 })
  return { samples, clicks: [click(2, 0.6), click(4, 0.6), click(9, 0.6)], valid: true, scrolls: [] }
}

/** Deeply frozen, so any write to the recorded track throws. */
function frozen<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v as object).forEach(frozen)
    Object.freeze(v)
  }
  return v
}

const ctx = (inputEdits?: InputEdits, cursorInVideo = false): InputContext => ({
  inputEdits,
  capture: { method: 'native', cursorInVideo, region: null },
  width: 1920,
  height: 1080
})

function project(inputEdits?: InputEdits): Project {
  const p = createProject({
    id: 'rec-1',
    name: 'Test',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return { ...p, cursor: { ...p.cursor, clickSound: true }, ...(inputEdits ? { inputEdits } : {}) }
}

describe('effectiveTrack', () => {
  it('returns the recorded track itself without edits, and with the cursor in the video when only straightening', () => {
    const rec = frozen(recordedTrack())
    expect(effectiveTrack(rec, ctx())).toBe(rec)
    expect(effectiveTrack(rec, ctx({}))).toBe(rec)
    expect(effectiveTrack(rec, ctx({ straighten: true }, true))).toBe(rec)
    expect(effectiveTrack(rec, ctx({ paths: [{ start: 0, end: 20, mode: 'straight' }] }, true))).toBe(rec)
    // Ignored keys that name no click change nothing either.
    expect(effectiveTrack(rec, ctx({ ignoredClicks: [{ ms: 3000 }] }))).toBe(rec)
    const invalid = frozen({ samples: [], clicks: [click(4)], valid: false })
    expect(effectiveTrack(invalid, ctx({ ignoredClicks: [{ ms: 4000 }], straighten: true }))).toBe(invalid)
  })

  it('drops ignored clicks and keeps the samples array', () => {
    const rec = frozen(recordedTrack())
    const copy = structuredClone(recordedTrack())
    const eff = effectiveTrack(rec, ctx({ ignoredClicks: [{ ms: 4000 }] }))
    expect(eff.clicks.map((c) => c.t)).toEqual([2, 9])
    expect(eff.clicks[0]).toBe(rec.clicks[0])
    expect(eff.samples).toBe(rec.samples)
    expect(eff.scrolls).toBe(rec.scrolls)
    expect(eff.valid).toBe(true)
    expect(rec).toEqual(copy)
  })

  it('straightens moves when Flown draws the cursor, keeping the clicks array', () => {
    const rec = frozen(recordedTrack())
    const eff = effectiveTrack(rec, ctx({ straighten: true }))
    expect(eff).not.toBe(rec)
    expect(eff.clicks).toBe(rec.clicks)
    expect(eff.samples).not.toBe(rec.samples)
    const at13 = eff.samples.find((s) => Math.abs(s.t - 1.3) < 1e-9)!
    expect(at13.x).toBeCloseTo(0.4, 9)
    expect(at13.y).toBeCloseTo(0.5, 9)
    // Straightening reads the recorded clicks: a click inside the move blocks it even when ignored.
    const blocked = frozen({ ...recordedTrack(), clicks: [click(1.3)] })
    expect(effectiveTrack(blocked, ctx({ straighten: true, ignoredClicks: [{ ms: 1300 }] })).samples).toBe(blocked.samples)
  })

  it('is memoised: the same inputs give the same object, and each edit keeps the other array', () => {
    const rec = frozen(recordedTrack())
    const ignored = [{ ms: 4000 }]
    const paths = [{ start: 0.5, end: 2, mode: 'straight' as const }]
    const a = effectiveTrack(rec, ctx({ ignoredClicks: ignored, paths }))
    expect(effectiveTrack(rec, ctx({ ignoredClicks: ignored, paths }))).toBe(a)
    // Ignoring another click (a new list) keeps the samples array: the smoothed paths are not rebuilt.
    const b = effectiveTrack(rec, ctx({ ignoredClicks: [{ ms: 2000 }, { ms: 4000 }], paths }))
    expect(b.samples).toBe(a.samples)
    expect(b.clicks.map((c) => c.t)).toEqual([9])
    // Turning straightening on keeps the clicks array.
    const c = effectiveTrack(rec, ctx({ ignoredClicks: ignored, paths, straighten: true }))
    expect(c.clicks).toBe(a.clicks)
    // Going back gives the same arrays again.
    const d = effectiveTrack(rec, ctx({ ignoredClicks: ignored, paths }))
    expect(d.samples).toBe(a.samples)
    expect(d.clicks).toBe(a.clicks)
  })

  it('takes the aspect from the project size: another size is another plan', () => {
    const rec = frozen(recordedTrack())
    const wide = effectiveTrack(rec, ctx({ straighten: true }))
    const square = effectiveTrack(rec, { ...ctx({ straighten: true }), width: 1080, height: 1080 })
    expect(square).not.toBe(wide)
  })
})

describe('what an ignored click no longer drives', () => {
  it('click sounds: soundingClicks and clickSoundJob skip it', () => {
    const rec = frozen(recordedTrack())
    const p = project({ ignoredClicks: [{ ms: 4000 }] })
    const eff = effectiveTrack(rec, p)
    expect(soundingClicks(rec)).toEqual([2, 4, 9])
    expect(soundingClicks(eff)).toEqual([2, 9])
    expect(clickSoundJob(p, eff, p.clips)?.times).toEqual([2, 9])
  })

  it('smart speed: its activity is gone', () => {
    const rec = frozen({ samples: [{ t: 0, x: 0.5, y: 0.5 }], clicks: [click(2), click(4), click(9)], valid: true })
    const gaps = (t: CursorTrack) => inputGaps(t, 20)!.map((g) => [+g.start.toFixed(3), +g.end.toFixed(3)])
    expect(gaps(rec)).toEqual([
      [0, 1.95],
      [2.05, 3.95],
      [4.05, 8.95],
      [9.05, 20]
    ])
    expect(gaps(effectiveTrack(rec, ctx({ ignoredClicks: [{ ms: 4000 }] })))).toEqual([
      [0, 1.95],
      [2.05, 8.95],
      [9.05, 20]
    ])
  })
})
