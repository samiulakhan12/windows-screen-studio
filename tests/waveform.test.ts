// The audio waveform on the timeline (E-04, shared/audio/waveform): lanes, reference level,
// column heights, the pauses it shades, and its palette command.
import { describe, expect, it } from 'vitest'
import { sourceActivity } from '../src/shared/audio/soundtrack'
import { LEVEL_WINDOW, type AudioLevels } from '../src/shared/audio/loudness'
import { pauseRanges, WAVEFORM, waveformColumns, waveformHeight, waveformLanes, waveformRef } from '../src/shared/audio/waveform'
import { commandInfo, PALETTE_COMMANDS, searchCommands } from '../src/shared/editor/commands'
import { findSilences } from '../src/shared/editor/smartSpeed'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { migrateProject } from '../src/shared/engine/project'
import type { Clip, Project } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })

/** An envelope from per-window dB levels (-200 is digital silence). */
const levels = (db: number[], window = LEVEL_WINDOW): AudioLevels => ({ window, power: Float32Array.from(db, (v) => (v <= -200 ? 0 : 10 ** (v / 10))) })
/** `seconds` of `db`. */
const run = (db: number, seconds: number): number[] => new Array(Math.round(seconds / LEVEL_WINDOW)).fill(db)

function project(over: Partial<Project> = {}): Project {
  return migrateProject({
    version: 2,
    id: 'p',
    name: 'p',
    createdAt: '',
    duration: 10,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: [clip(0, 10)],
    zooms: [],
    autoZoom: false,
    annotations: [],
    style: { background: { type: 'color', color: '#000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: { show: false, size: 1, smoothing: 0.5, clickEffect: false, hideWhenIdle: false },
    webcam: { show: false, corner: 'bottom-right', size: 0.2, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.03 } },
    audio: { volume: 1, muted: false },
    ...over
  })
}

const STEMS = { mic: true, system: true }
const near = (got: ArrayLike<number>, want: number[]): void => {
  expect(got.length).toBe(want.length)
  want.forEach((v, i) => expect(got[i], `column ${i}`).toBeCloseTo(v, 6))
}

describe('waveform lanes', () => {
  it('draws nothing without sound, the mix mirrored, or the two stems up and down', () => {
    expect(waveformLanes(project({ hasAudio: false }))).toEqual([])
    expect(waveformLanes(project())).toEqual([{ source: 'mix', side: 'both', muted: false }])
    expect(waveformLanes(project({ audioStems: STEMS }))).toEqual([
      { source: 'mic', side: 'up', muted: false },
      { source: 'system', side: 'down', muted: false }
    ])
    expect(waveformLanes(project({ audioStems: { mic: true, system: false } }))).toEqual([{ source: 'mic', side: 'both', muted: false }])
    expect(waveformLanes(project({ audioStems: { mic: false, system: true } }))).toEqual([{ source: 'system', side: 'both', muted: false }])
  })

  it('greys a lane that is not heard: its own gain or the master at 0', () => {
    const muted = (audio: Project['audio'], stems?: Project['audioStems']): boolean[] =>
      waveformLanes(project({ audio, ...(stems ? { audioStems: stems } : {}) })).map((l) => l.muted)
    expect(muted({ volume: 1, muted: true })).toEqual([true])
    expect(muted({ volume: 1, muted: true }, STEMS)).toEqual([true, true])
    expect(muted({ volume: 0, muted: false }, STEMS)).toEqual([true, true])
    expect(muted({ volume: 1, muted: false, mic: { volume: 0, muted: false } }, STEMS)).toEqual([true, false])
    expect(muted({ volume: 1, muted: false, system: { volume: 1, muted: true } }, STEMS)).toEqual([false, true])
    // Volume and normalisation change how loud it is, not whether it is heard.
    expect(muted({ volume: 0.2, muted: false, normalize: true, mic: { volume: 1.8, muted: false } }, STEMS)).toEqual([false, false])
  })
})

describe('waveform reference level', () => {
  it('is the 99th percentile of the heard windows of the loudest source', () => {
    expect(waveformRef([levels([...run(-20, 5), ...run(-60, 5)])])).toBeCloseTo(-20, 2)
    expect(waveformRef([levels(run(-20, 2)), levels(run(-30, 2))])).toBeCloseTo(-20, 2)
    expect(waveformRef([levels(run(-30, 2)), levels(run(-20, 2))])).toBeCloseTo(-20, 2)
    // A few loud clicks do not set it: 1% of the windows is left above.
    expect(waveformRef([levels([...run(-30, 9.9), ...run(0, 0.05)])])).toBeCloseTo(-30, 2)
    // Digital silence is not counted.
    expect(waveformRef([levels([...run(-200, 9), ...run(-25, 1)])])).toBeCloseTo(-25, 2)
  })

  it('is null when nothing is heard', () => {
    expect(waveformRef([levels(run(-200, 2))])).toBeNull()
    expect(waveformRef([{ window: LEVEL_WINDOW, power: new Float32Array(0) }])).toBeNull()
    expect(waveformRef([])).toBeNull()
  })

  it('leaves its input as it was', () => {
    const l = levels([-10, -40, -20, -30, -200, -5])
    const before = Array.from(l.power)
    waveformRef([l])
    expect(Array.from(l.power)).toEqual(before)
  })
})

describe('waveform heights', () => {
  it('maps the 45 dB below the reference linearly onto 0..1', () => {
    expect(waveformHeight(-20, -20)).toBe(1)
    expect(waveformHeight(-42.5, -20)).toBeCloseTo(0.5, 9)
    expect(waveformHeight(-65, -20)).toBe(0)
    expect(waveformHeight(-Infinity, -20)).toBe(0)
    expect(waveformHeight(-10, -20)).toBe(1)
    expect(WAVEFORM.rangeDb).toBe(45)
  })

  it('shows the loudest window of each column', () => {
    near(waveformColumns(levels([...run(-20, 1), ...run(-200, 1)]), -20, 0, 2, 4), [1, 1, 0, 0])
    // 1.5 / 0.05 is a hair above 30 in floating point: window 30 is still the second column's.
    near(waveformColumns(levels([...run(-20, 1), ...run(-200, 2)]), -20, 0, 3, 2), [1, 0])
    // One loud window among silent ones still shows when zoomed out.
    const one = run(-200, 2)
    one[3] = -20
    near(waveformColumns(levels(one), -20, 0, 2, 4), [1, 0, 0, 0])
    near(waveformColumns(levels(run(-20, 2)), -20, 1.9, 2.1, 2), [1, 0])
  })

  it('interpolates between window centres when a column is under half a window', () => {
    const cols = waveformColumns(levels([-20, -65]), -20, 0, 0.1, 8)
    expect(cols[0]).toBeCloseTo(1, 6)
    expect(cols[1]).toBeCloseTo(1, 6)
    expect(cols[4]).toBeCloseTo(0.375, 6)
    expect(cols[7]).toBeCloseTo(0, 6)
    // Monotonic between the two centres: no staircase.
    for (let k = 1; k < 8; k++) expect(cols[k]).toBeLessThanOrEqual(cols[k - 1] + 1e-9)
  })

  it('is silent before 0 and past the measured sound', () => {
    const l = levels(run(-20, 1))
    near(waveformColumns(l, -20, -0.5, 0.5, 4), [0, 0, 1, 1])
    near(waveformColumns(l, -20, -0.05, 0.05, 8), [0, 0, 0, 0, 1, 1, 1, 1])
    near(waveformColumns(l, -20, 0.9, 1.1, 16), [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(waveformColumns(l, -20, 0, 1, 0)).toHaveLength(0)
    near(waveformColumns({ window: LEVEL_WINDOW, power: new Float32Array(0) }, -20, 0, 1, 3), [0, 0, 0])
  })
})

describe('pauses shaded on the waveform', () => {
  it('are the gaps of the sound inside the recording, at least half a second long', () => {
    expect(pauseRanges([{ start: 0.3, end: 3.5 }, { start: 7.5, end: 11.9 }], 12)).toEqual([{ start: 3.5, end: 7.5 }])
    expect(pauseRanges([{ start: 2, end: 4 }], 10)).toEqual([{ start: 0, end: 2 }, { start: 4, end: 10 }])
    expect(pauseRanges([], 10)).toEqual([])
    expect(pauseRanges([{ start: 0, end: 10 }], 10)).toEqual([])
    expect(pauseRanges([{ start: 1, end: 2 }, { start: 2.4, end: 3 }], 3)).toEqual([{ start: 0, end: 1 }])
    expect(WAVEFORM.minPause).toBe(0.5)
  })

  it('take unsorted, overlapping or outlying sound and a custom minimum', () => {
    expect(pauseRanges([{ start: 6, end: 7 }, { start: 1, end: 3 }, { start: 2, end: 4 }], 8)).toEqual([{ start: 0, end: 1 }, { start: 4, end: 6 }, { start: 7, end: 8 }])
    expect(pauseRanges([{ start: -1, end: 1 }, { start: 9, end: 12 }], 10)).toEqual([{ start: 1, end: 9 }])
    expect(pauseRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }], 5, 1.5)).toEqual([])
    expect(pauseRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }], 5, 1)).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }])
    // Sound only after the end of the recording: nothing heard in it.
    expect(pauseRanges([{ start: 11, end: 12 }], 10)).toEqual([])
  })

  describe('agree with Remove silences', () => {
    // 12 s, mix only: a voice from 0.3 to 3.5 s and from 7.5 to 11.9 s (talkSilenceTalk in the e2e tests).
    const p = project({ duration: 12, clips: [clip(0, 12)] })
    const mix = levels([...run(-200, 0.3), ...run(-20, 3.2), ...run(-200, 4), ...run(-20, 4.4), ...run(-200, 0.1)])
    const act = sourceActivity(p, { mix })!
    const pauses = pauseRanges(act, 12)

    it('shade the one pause', () => {
      expect(pauses).toHaveLength(1)
      expect(pauses[0].start).toBeCloseTo(3.5, 6)
      expect(pauses[0].end).toBeCloseTo(7.5, 6)
    })

    it('hold every silence it cuts, with its padding, at 1x and sped up', () => {
      for (const clips of [[clip(0, 12)], [clip(0, 6), clip(6, 12, 2)]]) {
        const parts = findSilences(act, clips, { minLength: 1, padding: 0.25 })
        expect(parts.length, JSON.stringify(clips)).toBeGreaterThan(0)
        for (const part of parts) {
          expect(
            pauses.some((r) => part.start - 0.25 >= r.start - 1e-6 && part.end + 0.25 <= r.end + 1e-6),
            `${part.start}–${part.end} in ${JSON.stringify(pauses)}`
          ).toBe(true)
        }
      }
    })

    it('do not depend on the clips', () => {
      const cut = project({ duration: 12, clips: [clip(0, 3.75), clip(7.25, 12)] })
      expect(pauseRanges(sourceActivity(cut, { mix })!, 12)).toEqual(pauses)
    })

    it('are none when the recording is muted', () => {
      const muted = sourceActivity(project({ duration: 12, audio: { volume: 1, muted: true } }), { mix })
      expect(muted).toEqual([])
      expect(pauseRanges(muted!, 12)).toEqual([])
    })
  })
})

describe('audio waveform command', () => {
  const titles = (query: string): string[] => searchCommands(PALETTE_COMMANDS, query).map((r) => r.command.title)

  it('is a Timeline toggle in the palette, found by "waveform" and "pauses", with no default key', () => {
    const info = commandInfo('toggleWaveform')
    expect(info.category).toBe('Timeline')
    expect(info.title).toBe('Audio waveform on the timeline')
    expect(info.toggle).toBe(true)
    expect(PALETTE_COMMANDS).toContain(info)
    expect(titles('waveform')[0]).toBe(info.title)
    expect(titles('pauses')).toContain(info.title)
    expect(DEFAULT_KEYMAP.toggleWaveform).toEqual([])
  })
})
