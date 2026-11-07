import { describe, expect, it } from 'vitest'
import { bedLoop, bedSeconds, bedTime, MUSIC_BEDS, soundBed, soundEffect } from '../src/shared/audio/soundLibrary'
import { editToVideo, planOf } from '../src/shared/engine/freeze'
import { sourceToOutput } from '../src/shared/engine/timeline'
import { popJob } from '../src/shared/render/popSound'
import { MAX_SFX, RULE_GAP, SFX_VOLUME, sfxCounts, sfxJob } from '../src/shared/render/sfxJob'
import type { Annotation, Clip, Freeze, Graphic, KeywordGraphic, Project, SfxRef, Shape, TitleCard, ZoomSegment } from '../src/shared/types'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §10.4, §10.6, §19.1 tests 59, 61, 62, 63):
 * a library bed's timing, and when the library's sound effects sound.
 */

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `c${start}`, start, end, speed })
const zoom = (id: string, start: number, end: number, extra: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id,
  start,
  end,
  scale: 2,
  focus: { mode: 'fixed', x: 0.5, y: 0.5 },
  auto: false,
  ...extra
})
const peak = (id: string): number => soundEffect(id)!.prepared.peakAt

function project(over: Partial<Project> = {}): Project {
  return { id: 'p', clips: [clip(0, 60)], zooms: [], annotations: [], graphics: [], ...over } as unknown as Project
}

/** Video seconds of source second `s` in `p`. */
const video = (p: Project, s: number): number => editToVideo(planOf(p), sourceToOutput(p.clips, s)!)

describe("a bed's timing (test 59)", () => {
  const bed = soundBed('upbeat-sweet-sun')!
  const { start: S, end: E } = bedLoop(bed)

  it('one pass is E / 48000, never the length of the file', () => {
    expect(bedSeconds(bed)).toBe(E / 48000)
    expect(bedSeconds(bed)).toBeCloseTo(103.376, 3)
    for (const b of MUSIC_BEDS) {
      expect(bedSeconds(b)).toBe(b.prepared.loopEnd / 48000)
      // The file holds the pad after E, which is never played.
      expect(b.prepared.samples).toBe(b.prepared.loopEnd + b.prepared.pad)
      expect(bedSeconds(b)).toBeLessThan(b.prepared.samples / 48000)
    }
  })

  it('is linear before E, from S after it, and continuous at E', () => {
    for (const t of [0, 1, 50.5, E / 48000 - 0.001]) expect(bedTime(bed, t, true)).toBeCloseTo(t, 9)
    expect(bedTime(bed, E / 48000, true)).toBeCloseTo(S / 48000, 9)
    // Just before E and just after: the file's end runs straight on at S.
    const before = bedTime(bed, E / 48000 - 1e-4, true)
    const after = bedTime(bed, E / 48000 + 1e-4, true)
    expect(before).toBeCloseTo(E / 48000 - 1e-4, 9)
    expect(after).toBeCloseTo(S / 48000 + 1e-4, 9)
    // Later passes repeat the body.
    const body = (E - S) / 48000
    for (const k of [1, 2, 7]) expect(bedTime(bed, E / 48000 + k * body + 3, true)).toBeCloseTo(S / 48000 + 3, 6)
    expect(bedTime(bed, -2, true)).toBe(0)
  })

  it('without Loop it stops at E', () => {
    expect(bedTime(bed, 10, false)).toBe(10)
    expect(bedTime(bed, E / 48000, false)).toBe(E / 48000)
    expect(bedTime(bed, 500, false)).toBe(E / 48000)
  })
})

describe('sfxJob on zooms (test 61)', () => {
  const rule = (zoomIn?: SfxRef, zoomOut?: SfxRef): Project['soundFx'] => ({ ...(zoomIn ? { zoomIn } : {}), ...(zoomOut ? { zoomOut } : {}) })

  it('zoom in at seg.start + tin / 2 less peakAt, in video time (Soft whoosh after a 0.7 s move: 0.277 s in)', () => {
    const p = project({ zooms: [zoom('a', 10, 14)], soundFx: rule('sfx:whoosh-soft') })
    const job = sfxJob(p)
    expect(job).toEqual([{ id: 'whoosh-soft', times: [10 + 0.35 - peak('whoosh-soft')], gain: SFX_VOLUME }])
    expect(job[0].times[0] - 10).toBeCloseTo(0.277, 9)
  })

  it('zoom out at seg.end − tout / 2 less peakAt; none for a pan into the next or from the previous', () => {
    // b starts 0.2 s after a ends: connected (a pan), so neither a's zoom out nor b's zoom in sounds.
    const p = project({ zooms: [zoom('a', 10, 14), zoom('b', 14.2, 18), zoom('c', 30, 34)], soundFx: rule('sfx:whoosh-in', 'sfx:whoosh-out') })
    const job = sfxJob(p)
    const zin = job.find((j) => j.id === 'whoosh-in')!
    const zout = job.find((j) => j.id === 'whoosh-out')!
    expect(zin.times).toEqual([10 + 0.35 - peak('whoosh-in'), 30 + 0.35 - peak('whoosh-in')])
    expect(zout.times).toEqual([18 - 0.35 - peak('whoosh-out'), 34 - 0.35 - peak('whoosh-out')])
  })

  it('a zoom with no move out (tout 0) has no zoom out; a zoom starting in a cut sounds nothing coming in', () => {
    const p = project({ clips: [clip(0, 9), clip(12, 60)], zooms: [zoom('a', 10, 14)], soundFx: rule('sfx:whoosh-soft', 'sfx:whoosh-out') })
    const job = sfxJob(p)
    expect(job.find((j) => j.id === 'whoosh-soft')).toBeUndefined()
    expect(job.find((j) => j.id === 'whoosh-out')!.times).toEqual([video(p, 14 - 0.35) - peak('whoosh-out')])
  })

  it('cuts, speed and pause freezes shift the times', () => {
    const freezes: Freeze[] = [{ id: 'f', at: 8, length: 2, sound: 'pause' }]
    const p = project({ clips: [clip(0, 4), clip(6, 60, 2)], freezes, zooms: [zoom('a', 20, 24)], soundFx: rule('sfx:whoosh-soft') })
    const at = video(p, 20.35)
    // 20.35 s is 14.35 s into the 2× clip that starts at edit 4: edit 11.175, after the 2 s hold at source 8.
    expect(at).toBeCloseTo(4 + 14.35 / 2 + 2, 9)
    expect(sfxJob(p)[0].times).toEqual([at - peak('whoosh-soft')])
  })

  it('zooms 1 s apart give one whoosh every 3 s, and sfxCounts counts what is kept', () => {
    // Short zooms 1 s apart, never connected (0.4 s moves; gaps of 0.8 s). Each 0.2 s zoom moves in for 0.1 s.
    const zooms = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => zoom(`z${k}`, 10 + k, 10.2 + k, { transition: 0.4 }))
    const p = project({ zooms, soundFx: rule('sfx:whoosh-soft') })
    const times = sfxJob(p)[0].times
    expect(times.length).toBe(3)
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(RULE_GAP - 1e-9)
    expect(times[0]).toBeCloseTo(10 + 0.05 - peak('whoosh-soft'), 9)
    expect(sfxCounts(p)).toEqual({ zoomIn: 3, zoomOut: 0, titles: 0, callouts: 0 })
    // Four zooms 1 s apart: two whooshes (§19.3 E14).
    expect(sfxJob({ ...p, zooms: zooms.slice(0, 4) })[0].times.length).toBe(2)
  })

  it('no rule, no sound; an unknown effect is no sound', () => {
    expect(sfxJob(project({ zooms: [zoom('a', 10, 14)] }))).toEqual([])
    expect(sfxJob(project({ zooms: [zoom('a', 10, 14)], soundFx: rule('sfx:nope' as SfxRef) }))).toEqual([])
    expect(sfxCounts(project({ zooms: [zoom('a', 10, 14)] }))).toEqual({ zoomIn: 0, zoomOut: 0, titles: 0, callouts: 0 })
  })
})

describe('sfxJob on title cards, texts and shapes (test 62)', () => {
  const text = (id: string, start: number, extra: Partial<Annotation> = {}): Annotation => ({ id, start, end: start + 2, text: 'Hi', x: 0.5, y: 0.5, size: 0.05, style: 'pill', ...extra })
  const title = (id: string, start: number, extra: Partial<TitleCard> = {}): TitleCard => ({ id, start, end: start + 3, title: 'T', style: 'centered', background: 'blur', ...extra })
  const shape = (id: string, start: number, kind: Shape['kind'], extra: Partial<Shape> = {}): Shape => ({
    id,
    start,
    end: start + 2,
    kind,
    x: 0.1,
    y: 0.1,
    w: 0.2,
    h: 0.2,
    color: '#ff0000',
    strokeWidth: 4,
    fill: false,
    opacity: 1,
    strength: 0.5,
    ...extra
  })

  it('half the enter motion (or the old fade) less peakAt', () => {
    const p = project({
      titles: [title('t1', 5), title('t2', 20, { enter: { kind: 'rise', duration: 0.8, strength: 1 } })],
      annotations: [text('a1', 30), text('a2', 40, { enter: { kind: 'pop', duration: 0.5, strength: 1 } })],
      shapes: [shape('s1', 50, 'arrow')],
      soundFx: { titles: 'sfx:bell', callouts: 'sfx:pop' }
    })
    const job = sfxJob(p)
    expect(job.find((j) => j.id === 'bell')!.times).toEqual([5 + 0.35 / 2 - peak('bell'), 20 + 0.4 - peak('bell')])
    expect(job.find((j) => j.id === 'pop')!.times).toEqual([30 + 0.15 / 2 - peak('pop'), 40 + 0.25 - peak('pop'), 50 + 0.15 / 2 - peak('pop')])
    expect(sfxCounts(p)).toEqual({ zoomIn: 0, zoomOut: 0, titles: 2, callouts: 3 })
  })

  it("an item's own sound beats the rule and is never dropped by the 3 s spacing; 'none' silences", () => {
    const p = project({
      annotations: [text('a1', 10), text('a2', 10.5, { sound: 'sfx:chime' }), text('a3', 11), text('a4', 11.5, { sound: 'none' }), text('a5', 14)],
      soundFx: { callouts: 'sfx:pop' }
    })
    const job = sfxJob(p)
    // The rule: 10 kept, 11 dropped (within 3 s), 14 kept. a2's own chime is kept; a4 is silent.
    expect(job.find((j) => j.id === 'pop')!.times).toEqual([10 + 0.075 - peak('pop'), 14 + 0.075 - peak('pop')])
    expect(job.find((j) => j.id === 'chime')!.times).toEqual([10.5 + 0.075 - peak('chime')])
    expect(sfxCounts(p).callouts).toBe(2)
    // Own sounds close together are all kept.
    const own = project({ annotations: [1, 1.5, 2, 2.5].map((s, i) => text(`o${i}`, s, { sound: 'sfx:chime' })) })
    expect(sfxJob(own)[0].times.length).toBe(4)
  })

  it('privacy shapes never sound; items starting in a cut never sound', () => {
    const p = project({
      clips: [clip(0, 9), clip(12, 60)],
      shapes: [shape('b', 2, 'blur'), shape('x', 3, 'pixelate'), shape('r', 4, 'rect'), shape('c', 10, 'ellipse', { sound: 'sfx:chime' })],
      titles: [title('t', 10.5)],
      soundFx: { callouts: 'sfx:pop', titles: 'sfx:bell' }
    })
    expect(sfxJob(p)).toEqual([{ id: 'pop', times: [4 + 0.075 - peak('pop')], gain: SFX_VOLUME }])
  })

  it('times of one effect within 0.05 s merge into the first; never below 0', () => {
    const p = project({ annotations: [text('a', 0, { sound: 'sfx:rise' }), text('b', 5, { sound: 'sfx:chime' }), text('c', 5.03, { sound: 'sfx:chime' }), text('d', 5.2, { sound: 'sfx:chime' })] })
    const job = sfxJob(p)
    // Rise peaks 0.354 s in, after its 0.075 s half fade: it would start before 0.
    expect(job.find((j) => j.id === 'rise')!.times).toEqual([0])
    expect(job.find((j) => j.id === 'chime')!.times).toEqual([5 + 0.075 - peak('chime'), 5.2 + 0.075 - peak('chime')])
  })

  it('at most 500 times per effect and 16 effects; the gain is the volume', () => {
    const many = Array.from({ length: 700 }, (_, i) => text(`a${i}`, 1 + i * 0.1, { sound: 'sfx:click' }))
    const job = sfxJob(project({ clips: [clip(0, 100)], annotations: many, soundFx: { volume: 0.6 } }))
    expect(job[0].times.length).toBe(500)
    expect(job[0].gain).toBe(0.6)
    const all = project({ annotations: SOUND_EFFECT_IDS.map((id, i) => text(`e${i}`, 1 + i, { sound: `sfx:${id}` as SfxRef })), soundFx: { volume: 0 } })
    const out = sfxJob(all)
    expect(out.length).toBe(Math.min(MAX_SFX, SOUND_EFFECT_IDS.length))
    expect(out.every((e) => e.gain === 0)).toBe(true)
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length)
  })
})

const SOUND_EFFECT_IDS = ['whoosh-in', 'whoosh-out', 'whoosh-soft', 'swish-quick', 'pop', 'pop-soft', 'pop-bubble', 'click', 'tick', 'bell', 'chime', 'success', 'rise', 'fall', 'bubble-in', 'drop']

describe("Captions Studio's pop-ups with a library sound (test 63)", () => {
  const keyword = (id: string, start: number, end: number, sound: Graphic['sound']): Graphic =>
    ({
      id,
      kind: 'keyword',
      start,
      end,
      place: 'auto',
      size: 0.09,
      enter: { kind: 'pop', duration: 0.24, strength: 1 },
      exit: { kind: 'fade', duration: 0.18, strength: 1 },
      text: 'Export',
      look: 'card',
      sound
    }) as KeywordGraphic

  it("sounds at startOf(g) less peakAt, when popJob would sound a 'pop' on the same graphic", () => {
    const base = project({ clips: [clip(0, 4), clip(6, 20, 2)], freezes: [{ id: 'f', at: 9, length: 1.5, sound: 'pause' }] })
    for (const [start, end] of [
      [2, 3],
      [8, 12],
      [5, 7],
      [12, 14]
    ]) {
      const pop = popJob({ ...base, graphics: [keyword('k', start, end, 'pop')] })
      const sfx = sfxJob({ ...base, graphics: [keyword('k', start, end, 'sfx:pop-soft')] })
      expect(sfx, `${start}`).toEqual([{ id: 'pop-soft', times: pop[0].times.map((t) => Math.max(0, t - peak('pop-soft'))), gain: SFX_VOLUME }])
    }
    // Wholly in a cut: silent, as popJob's.
    expect(popJob({ ...base, graphics: [keyword('k', 4.5, 5.5, 'pop')] })).toEqual([])
    expect(sfxJob({ ...base, graphics: [keyword('k', 4.5, 5.5, 'sfx:pop-soft')] })).toEqual([])
  })

  it('a pop-up moved by what moves its graphic (the progress bar\'s band) sounds where it shows, as its pop would', () => {
    const p = project({ graphics: [keyword('k', 3, 6, 'sfx:pop-bubble'), keyword('j', 10, 12, 'pop')] })
    // The startOf the export and the preview pass: here the band delays the card 0.7 s.
    const startOf = (g: Graphic): number => g.start + 0.7
    expect(sfxJob(p, startOf)).toEqual([{ id: 'pop-bubble', times: [3.7 - peak('pop-bubble')], gain: SFX_VOLUME }])
    expect(popJob(p, startOf)).toEqual([{ times: [10.7], sound: 'pop' }])
    // The same graphic with 'pop' sounds at the same moment.
    const asPop = popJob({ ...p, graphics: [{ ...p.graphics![0], sound: 'pop' }] }, startOf)
    expect(sfxJob(p, startOf)[0].times[0]).toBe(asPop[0].times[0] - peak('pop-bubble'))
  })

  it("popJob is unchanged for 'pop' and 'ding', and leaves library sounds to sfxJob", () => {
    const p = project({ graphics: [keyword('a', 2, 3, 'pop'), keyword('b', 4, 5, 'ding'), keyword('c', 6, 7, 'sfx:pop')] })
    expect(popJob(p)).toEqual([
      { times: [2], sound: 'pop' },
      { times: [4], sound: 'ding' }
    ])
    expect(sfxJob(p)).toEqual([{ id: 'pop', times: [6 - peak('pop')], gain: SFX_VOLUME }])
  })
})
