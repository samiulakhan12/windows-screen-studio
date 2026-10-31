import { describe, expect, it } from 'vitest'
import { POP_SOUNDS, popJob, popSoundSource, popWaveform, toneJob, toneSoundSource, toneWaveform, graphicDrawn, BLEEP_TONE } from '../src/shared/render/popSound'
import { editToVideo, planOf } from '../src/shared/engine/freeze'
import type { Bleep, Clip, EmojiGraphic, Freeze, Graphic, KeywordGraphic, ListGraphic, Project } from '../src/shared/types'

/*
 * Test 26 (docs/design/captions-studio.md §16.1, §10.6): the pop and ding waveforms equal the
 * formula of their partials; pop times are output times on the captions' clock (in a continue
 * freeze, the sound time; at a pause freeze, when it starts); graphics that never show make no
 * sound. And the bleep tones of §11.7: output spans of the 'tone' bleeps, split at cuts and at pause
 * freezes.
 */

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `c${start}`, start, end, speed })
const motion = { kind: 'pop' as const, duration: 0.24, strength: 1 }
const keyword = (id: string, start: number, end: number, extra: Partial<KeywordGraphic> = {}): Graphic => ({
  id,
  kind: 'keyword',
  start,
  end,
  place: 'auto',
  size: 0.09,
  enter: motion,
  exit: { kind: 'fade', duration: 0.18, strength: 1 },
  text: 'Export',
  look: 'card',
  sound: 'pop',
  ...extra
})

function project(over: Partial<Project> = {}): Project {
  return { id: 'p', clips: [clip(0, 20)], graphics: [], ...over } as unknown as Project
}

describe('pop and ding sounds (test 26)', () => {
  for (const sound of ['pop', 'ding'] as const) {
    it(`${sound}: the waveform is the sum of its decaying partials`, () => {
      const rate = 48000
      const wave = popWaveform(sound, rate)
      expect(wave.length).toBe(Math.round(POP_SOUNDS[sound].duration * rate))
      for (const i of [0, 1, 7, 100, 1234, wave.length - 1]) {
        const t = i / rate
        let v = 0
        for (const p of POP_SOUNDS[sound].partials) v += p.amp * Math.sin(2 * Math.PI * p.freq * t) * Math.exp(-t / p.tau)
        expect(wave[i]).toBeCloseTo(v, 6)
      }
    })
  }

  it('the partials are those of §10.6', () => {
    expect(POP_SOUNDS.pop.partials.map((p) => [p.freq, p.amp, p.tau])).toEqual([[520, 0.55, 0.04], [1040, 0.25, 0.02], [2600, 0.08, 0.006]])
    expect(POP_SOUNDS.ding.partials.map((p) => [p.freq, p.amp, p.tau])).toEqual([[1320, 0.4, 0.35], [2640, 0.12, 0.18], [3960, 0.05, 0.08]])
    expect([POP_SOUNDS.pop.duration, POP_SOUNDS.ding.duration]).toEqual([0.12, 0.9])
  })

  it('the ffmpeg source is the same formula, without characters a filtergraph would need escaped', () => {
    const src = popSoundSource('pop')
    expect(src).toBe('aevalsrc=0.55*sin(2*PI*520*t)*exp(-t/0.04)+0.25*sin(2*PI*1040*t)*exp(-t/0.02)+0.08*sin(2*PI*2600*t)*exp(-t/0.006):d=0.12:s=48000')
    expect(popSoundSource('ding')).toContain(':d=0.9:s=48000')
    expect(src.split(':')[0]).not.toMatch(/[,;'[\]]/)
  })

  it('times are output times of each graphic start, by sound, sorted; graphics without a sound are silent', () => {
    const p = project({
      clips: [clip(0, 4), clip(6, 20, 2)],
      graphics: [keyword('a', 8, 9), keyword('b', 1, 2, { sound: 'ding' }), keyword('c', 2, 3), keyword('d', 3, 4, { sound: undefined })]
    })
    // 8 s is 2 s into the 2x clip that starts at output 4: output 5.
    expect(popJob(p)).toEqual([
      { times: [2, 5], sound: 'pop' },
      { times: [1], sound: 'ding' }
    ])
  })

  it('a graphic starting in a cut sounds when it first shows; one wholly in a cut is silent', () => {
    const p = project({ clips: [clip(0, 4), clip(6, 20)], graphics: [keyword('a', 5, 7), keyword('b', 4.5, 5.5)] })
    expect(popJob(p)).toEqual([{ times: [4], sound: 'pop' }])
  })

  it('a list card sounds once, at its start', () => {
    const list: ListGraphic = { ...(keyword('l', 2, 12) as KeywordGraphic), kind: 'list', marker: 'number', items: [{ text: 'One', at: 2 }, { text: 'Two', at: 9 }] } as unknown as ListGraphic
    expect(popJob(project({ graphics: [list] }))).toEqual([{ times: [2], sound: 'pop' }])
  })

  it('in a continue freeze a pop sounds at its graphic start on the sound clock; at a pause freeze, when the freeze starts', () => {
    const freezes: Freeze[] = [{ id: 'f1', at: 3, length: 4, sound: 'continue' } as Freeze]
    const cont = project({ freezes, graphics: [keyword('a', 5, 6)] })
    // The picture holds 3 s, but the sound runs on: the graphic appears when the sound reaches 5 s.
    expect(planOf(cont).stills.length).toBe(1)
    expect(popJob(cont)).toEqual([{ times: [5], sound: 'pop' }])
    const paused = project({ freezes: [{ id: 'f2', at: 5, length: 2, sound: 'pause' } as Freeze], graphics: [keyword('a', 5, 6), keyword('b', 8, 9)] })
    const plan = planOf(paused)
    expect(plan.holds.length).toBe(1)
    // At the freeze: when it starts (5); after it: 2 s later than without it.
    expect(popJob(paused)).toEqual([{ times: [5, 10], sound: 'pop' }])
    expect(editToVideo(plan, 8)).toBe(10)
  })

  it('a graphic that never shows makes no sound: another language than the burned-in captions, an unlisted emoji', () => {
    const emoji = (id: string, e: string): EmojiGraphic => ({ ...(keyword(id, 1, 2) as KeywordGraphic), kind: 'emoji', emoji: e }) as unknown as EmojiGraphic
    const p = project({
      transcript: { language: 'en', segments: [] } as unknown as Project['transcript'],
      graphics: [keyword('a', 1, 2, { lang: 'bn' }), keyword('b', 3, 4, { lang: 'en' }), emoji('c', '1f525'), emoji('d', 'ffffff')]
    })
    expect(popJob(p)).toEqual([{ times: [1, 3], sound: 'pop' }])
    expect(graphicDrawn(p, p.graphics![0])).toBe(false)
    const bn = { ...p, captions: { ...(p.captions ?? {}), track: 'bn' } } as Project
    expect(popJob(bn)).toEqual([{ times: [1], sound: 'pop' }])
  })

  it('a project without graphics has no pops', () => {
    expect(popJob(project({ graphics: undefined }))).toEqual([])
  })
})

describe('bleep tones (§11.7)', () => {
  const bleep = (start: number, end: number, sound: Bleep['sound'] = 'tone'): Bleep => ({ id: `b${start}`, start, end, word: 'darn', sound })

  it('the tone is a 1 kHz sine at 0.25 with short ramps; its ffmpeg source starts at phase 0', () => {
    const w = toneWaveform(0.1, 48000)
    expect(w.length).toBe(4800)
    expect(w[0]).toBe(0)
    const mid = 2400 + 12
    expect(w[mid]).toBeCloseTo(BLEEP_TONE.gain * Math.sin((2 * Math.PI * 1000 * mid) / 48000), 6)
    expect(Math.max(...w)).toBeLessThanOrEqual(0.25 + 1e-6)
    expect(toneSoundSource(1.5)).toBe('aevalsrc=0.25*sin(2*PI*1000*t):d=1.5:s=48000')
  })

  it('only tone bleeps sound, in output time, split at cuts', () => {
    const p = project({ clips: [clip(0, 5), clip(6, 20)], bleeps: [bleep(2, 2.5), bleep(4.8, 6.4), bleep(8, 8.4, 'silence'), bleep(5.2, 5.8)] })
    const spans = toneJob(p)
    expect(spans.map((s) => [+s.start.toFixed(6), +s.end.toFixed(6)])).toEqual([
      [2, 2.5],
      [4.8, 5],
      [5, 5.4]
    ])
  })

  it('spans follow re-timed clips', () => {
    const p = project({ clips: [clip(0, 4), clip(4, 20, 2)], bleeps: [bleep(6, 7)] })
    expect(toneJob(p)).toEqual([{ start: 5, end: 5.5 }])
  })

  it('a pause freeze inside a span splits it: the tone waits with the sound', () => {
    const p = project({ freezes: [{ id: 'f', at: 3, length: 2, sound: 'pause' } as Freeze], bleeps: [bleep(2.8, 3.4)] })
    expect(toneJob(p).map((s) => [+s.start.toFixed(6), +s.end.toFixed(6)])).toEqual([
      [2.8, 3],
      [5, 5.4]
    ])
  })

  it('overlapping bleeps make one span; none without bleeps', () => {
    const p = project({ bleeps: [bleep(2, 3), bleep(2.5, 3.5)] })
    expect(toneJob(p)).toEqual([{ start: 2, end: 3.5 }])
    expect(toneJob(project())).toEqual([])
  })
})
