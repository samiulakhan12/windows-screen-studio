/**
 * Polish's Smooth cuts step and its Review mode row (docs/design/editing-polish.md §11; §19.1 tests
 * 20, 21 and 75): the step runs after Remove silences, skips when there is nothing to smooth or a
 * style was chosen, makes one row with Keep and Remove, and Smooth picks a punch-in or a crossfade by
 * the layout on both sides of each cut.
 */
import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { DEFAULT_POLISH_OPTIONS, planPolish, polishAvailability, readPolishOptions, type PolishInput, type PolishOptions } from '../src/shared/editor/polish'
import { polishResultLines } from '../src/shared/editor/polishCopy'
import { hardCutsEverywhere, smoothAllCuts, smoothHere } from '../src/shared/editor/joinsEdit'
import { createProject } from '../src/shared/engine/project'
import { joinPlan, punchAt, resolvedJoin } from '../src/shared/render/joins'
import { JOIN_ALL_KEY } from '../src/shared/review/joinReview'
import { keepItems, pendingCount, removeItems, reviewItems, reviewStatus } from '../src/shared/review/review'
import type { Clip, LayoutSegment, Project, ProjectJoins } from '../src/shared/types'

const clip = (id: string, start: number, end: number, speed = 1): Clip => ({ id, start, end, speed })

function project(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 20,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  p.webcam = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  return { ...p, clips: [clip('c0', 0, 20)], ...over }
}

/** Clips with a 1 s cut between each, the last ending at 20. */
const CUT_CLIPS = [clip('a', 0, 4), clip('b', 5, 9), clip('c', 10, 14), clip('d', 15, 20)]

const NONE: PolishOptions = { ...DEFAULT_POLISH_OPTIONS, styleId: null, zoom: false, silences: false, smoothCuts: false, captions: false, captionLook: false, director: false }

const input = (p: Project, sound: PolishInput['sound'] = null): PolishInput => ({
  project: p,
  recorded: { samples: [], clicks: [], keys: [], valid: false },
  sound,
  transcript: null,
  speech: null,
  framing: { status: 'skipped' },
  preset: null
})

const stepOf = (r: ReturnType<typeof planPolish>) => r.summary.steps.find((s) => s.step === 'smoothCuts')

describe('Polish smooths the cuts (test 21)', () => {
  it('runs after Remove silences and smooths the cuts it made', () => {
    const p = project({ duration: 12, clips: [clip('c0', 0, 12)], hasWebcam: false })
    const sound = [
      { start: 0.3, end: 3.5 },
      { start: 7.5, end: 11.9 }
    ]
    const r = planPolish(input(p, sound), { ...NONE, silences: true, smoothCuts: true })
    expect(r.project.clips).toHaveLength(2)
    expect(stepOf(r)).toEqual({ step: 'smoothCuts', status: 'changed' })
    expect(r.summary.smoothCuts).toBe(1)
    expect(r.project.joins).toEqual({ all: { kind: 'smooth' }, auto: { by: 'polish', was: null } })
    expect(polishResultLines(r.summary).find((l) => l.step === 'smoothCuts')?.text).toBe('Smooth cuts at 1 cut')
    // The cut Remove silences made is a crossfade (no camera).
    expect(joinPlan(r.project)).toHaveLength(1)
    // Polishing again changes nothing: the style is now chosen.
    const again = planPolish(input(r.project, sound), { ...NONE, silences: true, smoothCuts: true })
    expect(again.project).toBe(r.project)
    expect(stepOf(again)).toEqual({ step: 'smoothCuts', status: 'skipped', reason: 'kept-style' })
  })

  it('skips with no cuts, and keeps a chosen style, Hard cut included', () => {
    const none = planPolish(input(project()), { ...NONE, smoothCuts: true })
    expect(stepOf(none)).toEqual({ step: 'smoothCuts', status: 'skipped', reason: 'no-cuts' })
    for (const all of [{ kind: 'cut' as const }, { kind: 'crossfade' as const }, { kind: 'smooth' as const }]) {
      const p = project({ clips: CUT_CLIPS, joins: { all } })
      const r = planPolish(input(p), { ...NONE, smoothCuts: true })
      expect(stepOf(r)).toEqual({ step: 'smoothCuts', status: 'skipped', reason: 'kept-style' })
      expect(r.project).toBe(p)
    }
    // After Use hard cuts everywhere, Polish keeps the hard cuts.
    const hard = hardCutsEverywhere(project({ clips: CUT_CLIPS }))
    expect(stepOf(planPolish(input(hard), { ...NONE, smoothCuts: true }))?.reason).toBe('kept-style')
    // Off: not selected.
    expect(stepOf(planPolish(input(project({ clips: CUT_CLIPS })), NONE))).toEqual({ step: 'smoothCuts', status: 'skipped', reason: 'off' })
  })

  it('keeps the cuts\' own styles and counts only the others', () => {
    const p = project({ clips: CUT_CLIPS, joins: { cuts: [{ clip: 'c', kind: 'dip' }] } })
    const r = planPolish(input(p), { ...NONE, smoothCuts: true })
    expect(r.summary.smoothCuts).toBe(2)
    expect(r.project.joins?.cuts).toEqual([{ clip: 'c', kind: 'dip' }])
  })

  it('reads saved options without the step as off; new options have it on', () => {
    expect(readPolishOptions({ silences: true }).smoothCuts).toBe(false)
    expect(DEFAULT_POLISH_OPTIONS.smoothCuts).toBe(true)
  })

  it('offers the row unless a style is chosen, or there are no cuts and Remove silences cannot make any', () => {
    const ctx = { hasCameraFile: true, transcribers: [], transcribing: false }
    const recorded = { samples: [], clicks: [], keys: [], valid: false }
    expect(polishAvailability(project({ clips: CUT_CLIPS }), recorded, ctx).smoothCuts).toBeNull()
    expect(polishAvailability(project(), recorded, ctx).smoothCuts).toBeNull()
    expect(polishAvailability(project({ hasAudio: false }), recorded, ctx).smoothCuts).toBe('no-cuts')
    expect(polishAvailability(project({ clips: CUT_CLIPS, joins: { all: { kind: 'cut' } } }), recorded, ctx).smoothCuts).toBe('kept-style')
  })

  it('stays one undo step with Remove silences and Smooth cuts together', () => {
    const p = project({ duration: 12, clips: [clip('c0', 0, 12)], hasWebcam: false })
    const sound = [
      { start: 0.3, end: 3.5 },
      { start: 7.5, end: 11.9 }
    ]
    const store = new EditStore(p)
    store.update((s) => planPolish(input(s, sound), { ...NONE, silences: true, smoothCuts: true }).project)
    expect(store.state.joins?.all).toEqual({ kind: 'smooth' })
    expect(store.state.clips).toHaveLength(2)
    store.undo()
    expect(store.state).toBe(p)
    expect(store.canUndo).toBe(false)
  })
})

describe('the Review mode row (test 20)', () => {
  const polished = (was: ProjectJoins['all'] | null = null, over: Partial<Project> = {}): Project =>
    project({ clips: CUT_CLIPS, joins: { all: { kind: 'smooth' }, auto: { by: 'polish', was } }, ...over })

  it('lists one row with the cut count, at the first cut', () => {
    const p = polished()
    const rows = reviewItems(p).filter((i) => i.kind === 'join')
    expect(rows).toEqual([{ key: JOIN_ALL_KEY, kind: 'join', start: 5, end: 5, title: 'Smooth cuts at 3 cuts', detail: 'Polish' }])
    expect(pendingCount(p)).toBe(1)
    expect(reviewStatus(p, rows[0])).toBe('pending')
    // A project without Polish's record lists nothing.
    expect(reviewItems(project({ clips: CUT_CLIPS, joins: { all: { kind: 'smooth' } } })).filter((i) => i.kind === 'join')).toEqual([])
  })

  it('Keep drops the record, one project out, and reads kept', () => {
    const p = polished()
    const [row] = reviewItems(p)
    const kept = keepItems(p, [row])
    expect(kept).not.toBe(p)
    expect(kept.joins).toEqual({ all: { kind: 'smooth' } })
    expect(reviewStatus(kept, row)).toBe('kept')
    expect(reviewItems(kept)).toEqual([])
    expect(keepItems(kept, [row])).toBe(kept)
  })

  it('Remove puts the style from before back and deletes an empty joins', () => {
    const p = polished()
    const [row] = reviewItems(p)
    const removed = removeItems(p, [row])
    expect('joins' in removed).toBe(false)
    expect(reviewStatus(removed, row)).toBe('removed')
    expect([1, 2, 3].map((i) => resolvedJoin(removed, i))).toEqual([null, null, null])
    // A style there was before comes back, own styles stay.
    const withOwn = project({ clips: CUT_CLIPS, joins: { all: { kind: 'smooth' }, cuts: [{ clip: 'b', kind: 'dip' }], auto: { by: 'polish', was: { kind: 'slide' } } } })
    expect(removeItems(withOwn, reviewItems(withOwn)).joins).toEqual({ all: { kind: 'slide' }, cuts: [{ clip: 'b', kind: 'dip' }] })
  })

  it('reads removed once the style was changed by hand, and Keep all and Remove all include the row', () => {
    const p = polished()
    const [row] = reviewItems(p)
    const changed = { ...p, joins: { all: { kind: 'dip' as const } } }
    expect(reviewStatus(changed, row)).toBe('removed')
    const zoomed = { ...p, zooms: [{ id: 'z', start: 1, end: 3, scale: 2, focus: { mode: 'cursor' as const }, auto: true }] } as Project
    const all = reviewItems(zoomed)
    expect(all.map((i) => i.kind)).toEqual(['zoom', 'join'])
    const keptAll = keepItems(zoomed, all)
    expect(keptAll.joins).toEqual({ all: { kind: 'smooth' } })
    expect(keptAll.zooms[0].auto).toBe(false)
    const removedAll = removeItems(zoomed, all)
    expect(removedAll.joins).toBeUndefined()
    expect(removedAll.zooms).toEqual([])
    // Each is one store update.
    const store = new EditStore(zoomed)
    store.update((s) => removeItems(s, all))
    store.undo()
    expect(store.state).toBe(zoomed)
  })
})

describe('Smooth by layout (test 75)', () => {
  const seg = (id: string, start: number, end: number, layout: LayoutSegment['layout']): LayoutSegment => ({ id, start, end, layout })
  const smooth = (over: Partial<Project>): Project => project({ clips: CUT_CLIPS, joins: { all: { kind: 'smooth' } }, ...over })

  it('punches in where the camera leads on both sides, crossfades everywhere else', () => {
    for (const layout of ['camera-only', 'camera-large'] as const) {
      const p = smooth({ layouts: [seg('L', 0, 20, layout)] })
      expect(resolvedJoin(p, 1)).toEqual({ kind: 'punch', scale: 1.1 })
      expect(smoothHere(p, 1)).toBe('punch')
      expect(joinPlan(p)).toEqual([])
      expect(punchAt(p, 6)).toBe(1.1)
    }
    for (const layout of ['default', 'screen-only', 'side-by-side'] as const) {
      const p = smooth({ layouts: [seg('L', 0, 20, layout)] })
      expect(resolvedJoin(p, 1)).toEqual({ kind: 'crossfade', duration: 0.15 })
      expect(smoothHere(p, 1)).toBe('crossfade')
    }
    // Camera-large to the bubble layout: a crossfade.
    const mixed = smooth({ layouts: [seg('L', 0, 4.5, 'camera-large')] })
    expect(resolvedJoin(mixed, 1)?.kind).toBe('crossfade')
    // And the bubble layout to camera-large: the camera leads on one side only.
    const into = smooth({ layouts: [seg('L', 4.5, 20, 'camera-large')] })
    expect(resolvedJoin(into, 1)?.kind).toBe('crossfade')
    expect(resolvedJoin(into, 2)?.kind).toBe('punch')
    // A hidden camera: a crossfade.
    const hidden = smooth({ layouts: [seg('L', 0, 20, 'camera-only')], webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' } })
    expect(resolvedJoin(hidden, 1)?.kind).toBe('crossfade')
    // A Smooth length and size go to the crossfades and punch-ins.
    const sized = project({ clips: CUT_CLIPS, joins: { all: { kind: 'smooth', duration: 0.3, scale: 1.2 } }, layouts: [seg('L', 0, 9.5, 'camera-only')] })
    expect(resolvedJoin(sized, 1)).toEqual({ kind: 'punch', scale: 1.2 })
    expect(resolvedJoin(sized, 2)).toEqual({ kind: 'crossfade', duration: 0.3 })
  })

  it('counts both kinds in the Review row and the Polish summary', () => {
    const p = project({ clips: CUT_CLIPS, layouts: [seg('L', 0, 9.5, 'camera-only')] })
    const r = planPolish(input(p), { ...NONE, smoothCuts: true })
    expect(r.summary.smoothCuts).toBe(3)
    expect([1, 2, 3].map((i) => resolvedJoin(r.project, i)?.kind)).toEqual(['punch', 'crossfade', 'crossfade'])
    expect(reviewItems(r.project).find((i) => i.kind === 'join')?.title).toBe('Smooth cuts at 3 cuts')
    expect(smoothAllCuts(p).changed).toBe(3)
  })
})
