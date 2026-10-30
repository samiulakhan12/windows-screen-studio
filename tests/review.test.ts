import { describe, expect, it } from 'vitest'
import { withoutDirected } from '../src/shared/editor/cameraDirector'
import { EditStore } from '../src/shared/editor/editStore'
import { DEFAULT_POLISH_OPTIONS, planPolish, type PolishOptions } from '../src/shared/editor/polish'
import { applySmartSpeed } from '../src/shared/editor/smartSpeed'
import { transcriptWords } from '../src/shared/editor/transcript'
import { createProject } from '../src/shared/engine/project'
import { cutRange, outputDuration } from '../src/shared/engine/timeline'
import { recordAutoCuts } from '../src/shared/review/autoCuts'
import { previewStretch, PREVIEW_MAX } from '../src/shared/review/preview'
import { FRAMING_KEY, keepItems, mergeSnapshot, pendingCount, removeItems, reviewItems, reviewProgress, reviewStatus, withoutSegments } from '../src/shared/review/review'
import { suggestionRanges } from '../src/shared/review/wordCuts'
import type { AutoCut, Clip, LayoutSegment, Project, ZoomSegment } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1, id = `c${start}`): Clip => ({ id, start, end, speed })
const spans = (clips: Clip[]): [number, number, number][] => clips.map((c) => [+c.start.toFixed(4), +c.end.toFixed(4), c.speed])

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
  return { ...p, clips: [clip(0, 20)], ...over }
}

const zoom = (id: string, start: number, over: Partial<ZoomSegment> = {}): ZoomSegment => ({
  id,
  start,
  end: start + 2,
  scale: 2,
  focus: { mode: 'cursor' },
  auto: true,
  anchor: { t: start + 0.5, x: 0.9, y: 0.1 },
  ...over
})
const silence: AutoCut = { id: 's1', by: 'silences', action: 'cut', start: 8, end: 10.4, was: [{ start: 8, end: 10.4, speed: 1 }] }

/** An auto zoom at 2 s, a director segment at 5 s, a silence cut at 8 s, a user zoom at 14 s. */
function fixture(): Project {
  return project({
    zooms: [zoom('z1', 2), zoom('mine', 14, { auto: false })],
    layouts: [{ id: 'l1', start: 5, end: 7, layout: 'default', corner: 'top-left', auto: true }],
    clips: [clip(0, 8), clip(10.4, 20)],
    autoCuts: [silence]
  })
}

describe('reviewItems', () => {
  it('lists every automatic change in time order, with exact titles', () => {
    const items = reviewItems(fixture())
    expect(items.map((i) => [i.key, i.kind, i.title, i.detail])).toEqual([
      ['zoom:z1', 'zoom', 'Zoom in on a click, top right', '2×'],
      ['camera:l1', 'camera', 'Camera to the top left corner', 'Camera director'],
      ['cut:s1', 'silence', 'Cut 2.4 s of silence', 'Remove silences']
    ])
    expect(pendingCount(fixture())).toBe(3)
  })

  it('names typing zooms, pull backs, layouts and the face framing', () => {
    const p = project({
      zooms: [zoom('t', 1, { anchor: { t: 1, x: 0.5, y: 0.5, until: 2 } }), zoom('b', 4, { scale: 0.75 }), zoom('n', 7, { anchor: undefined })],
      layouts: [
        { id: 'a', start: 10, end: 11, layout: 'camera-only', auto: true },
        { id: 'b', start: 12, end: 13, layout: 'screen-only', auto: true },
        { id: 'c', start: 14, end: 15, layout: 'side-by-side', auto: true },
        { id: 'd', start: 16, end: 17, layout: 'camera-large', auto: true }
      ],
      webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle', zoom: 1.6, cropX: 0.4, cropY: 0.45 },
      director: { intro: 'off', corners: 'auto', hideAfter: 0, frameFace: true, framed: { zoom: 1.6, cropX: 0.4, cropY: 0.45 } }
    })
    expect(reviewItems(p).map((i) => i.title)).toEqual([
      'Camera framed on your face',
      'Zoom in on typing, middle',
      'Pull back',
      'Zoom in',
      'Full camera',
      'Camera hidden',
      'Camera side by side',
      'Large camera'
    ])
  })

  it('lists only intact records, and names each source', () => {
    const records: AutoCut[] = [
      { ...silence, id: 'p', by: 'polish' },
      { id: 'i', by: 'smart-speed', action: 4, start: 12, end: 15, was: [{ start: 12, end: 15, speed: 1 }] },
      { id: 'f', by: 'filler', action: 'cut', start: 1, end: 1.4, was: [{ start: 1, end: 1.4, speed: 1 }], words: 'um' },
      { id: 'r', by: 'retake', action: 'cut', start: 3, end: 4, was: [{ start: 3, end: 4, speed: 1 }], words: 'so the' },
      { id: 'gone', by: 'repeat', action: 'cut', start: 16, end: 17, was: [{ start: 16, end: 17, speed: 1 }], words: 'the the' }
    ]
    const p = project({ clips: [clip(0, 1), clip(1.4, 3), clip(4, 8), clip(10.4, 12), clip(12, 15, 4), clip(15, 20)], autoCuts: records })
    expect(reviewItems(p).map((i) => [i.kind, i.title, i.detail])).toEqual([
      ['words', 'Removed “um”', 'Filler'],
      ['words', 'Removed a retake: “so the”', 'Retake'],
      ['silence', 'Cut 2.4 s of silence', 'Polish'],
      ['idle', 'Sped up 3.0 s of idle time 4×', 'Smart speed']
    ])
  })

  it('a project without automatic changes has nothing to review', () => {
    expect(reviewItems(project())).toEqual([])
  })
})

describe('keep and remove', () => {
  it('Keep makes each change the user’s and its status kept', () => {
    const p = fixture()
    const items = reviewItems(p)
    const kept = keepItems(p, items)
    expect(kept.zooms.find((z) => z.id === 'z1')?.auto).toBe(false)
    expect(kept.layouts?.[0]).toEqual({ id: 'l1', start: 5, end: 7, layout: 'default', corner: 'top-left' })
    expect('autoCuts' in kept).toBe(false)
    expect(kept.clips).toBe(p.clips)
    expect(items.map((i) => reviewStatus(kept, i))).toEqual(['kept', 'kept', 'kept'])
    expect(reviewItems(kept)).toEqual([])
  })

  it('Remove takes each change back and its status removed', () => {
    const p = fixture()
    const items = reviewItems(p)
    const removed = removeItems(p, items)
    expect(removed.zooms.map((z) => z.id)).toEqual(['mine'])
    expect(removed.layouts).toEqual([])
    expect(spans(removed.clips)).toEqual([[0, 20, 1]])
    expect('autoCuts' in removed).toBe(false)
    expect(items.map((i) => reviewStatus(removed, i))).toEqual(['removed', 'removed', 'removed'])
  })

  it('leaves items that are not pending alone, and gives the same project when nothing changes', () => {
    const p = fixture()
    const items = reviewItems(p)
    const kept = keepItems(p, items)
    expect(removeItems(kept, items)).toBe(kept)
    expect(keepItems(kept, items)).toBe(kept)
  })

  it('the face framing: Keep drops director.framed, Remove resets the webcam framing', () => {
    const p = project({
      webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle', zoom: 1.6, cropX: 0.4, cropY: 0.45 },
      director: { intro: 'off', corners: 'auto', hideAfter: 0, frameFace: true, framed: { zoom: 1.6, cropX: 0.4, cropY: 0.45 } }
    })
    const [item] = reviewItems(p)
    expect(item.key).toBe(FRAMING_KEY)
    const kept = keepItems(p, [item])
    expect(kept.webcam.zoom).toBe(1.6)
    expect(kept.director?.framed).toBeUndefined()
    expect(reviewStatus(kept, item)).toBe('kept')
    const removed = removeItems(p, [item])
    expect(removed.webcam.zoom).toBeUndefined()
    expect(removed.director?.framed).toBeUndefined()
    expect(removed.director?.frameFace).toBe(true)
    expect(reviewStatus(removed, item)).toBe('removed')
  })

  it('a cut the user restored by hand is no longer listed, and reads as removed', () => {
    const p = fixture()
    const item = reviewItems(p).find((i) => i.kind === 'silence')!
    const restored = { ...p, clips: [clip(0, 20)] }
    expect(reviewItems(restored).some((i) => i.kind === 'silence')).toBe(false)
    expect(reviewStatus(restored, item)).toBe('removed')
    // Re-timed by hand instead: not the original footage, so kept.
    expect(reviewStatus({ ...p, clips: [clip(0, 8), clip(8, 10.4, 2), clip(10.4, 20)] }, item)).toBe('kept')
  })

  it('removing a director cut-out gives its time back to the camera position', () => {
    const layouts: LayoutSegment[] = [
      { id: 'pos', start: 0, end: 4, layout: 'default', corner: 'top-left' },
      { id: 'cut', start: 4, end: 6, layout: 'screen-only', corner: 'top-left', auto: true, cutOut: true },
      { id: 'pos2', start: 6, end: 10, layout: 'default', corner: 'top-left' },
      { id: 'other', start: 12, end: 14, layout: 'camera-only', auto: true }
    ]
    const out = withoutSegments(layouts, ['cut'])
    expect(out).toEqual([
      { id: 'pos', start: 0, end: 10, layout: 'default', corner: 'top-left' },
      { id: 'other', start: 12, end: 14, layout: 'camera-only', auto: true }
    ])
    // The same as the director's own inverse for that run.
    expect(withoutSegments(layouts, ['cut', 'other'])).toEqual(withoutDirected(layouts))
    // A position covered whole keeps its id on the cut-out: it still reads as removed.
    const whole: LayoutSegment[] = [{ id: 'pos', start: 4, end: 6, layout: 'screen-only', corner: 'top-left', auto: true, cutOut: true }]
    const p = project({ layouts: whole })
    const [item] = reviewItems(p)
    const r = removeItems(p, [item])
    expect(r.layouts).toEqual([{ id: 'pos', start: 4, end: 6, layout: 'default', corner: 'top-left' }])
    expect(reviewStatus(r, item)).toBe('removed')
  })

  it('a removed cut keeps its speed: a 2x piece comes back at 2x', () => {
    const p = project({ clips: [clip(0, 8, 2), clip(10, 20, 2)], autoCuts: [{ ...silence, end: 10, was: [{ start: 8, end: 10, speed: 2 }] }] })
    const r = removeItems(p, reviewItems(p))
    expect(spans(r.clips)).toEqual([[0, 20, 2]])
  })
})

describe('undo: one step per action, statuses follow', () => {
  const settle = (next: Project): Project => next
  it('Keep, Remove, Keep all and Remove all are each one undo step', () => {
    const store = new EditStore(fixture(), 200, 800, () => 0, settle)
    const items = reviewItems(store.state)
    store.update((p) => keepItems(p, [items[0]]))
    expect(reviewStatus(store.state, items[0])).toBe('kept')
    store.update((p) => removeItems(p, [items[2]]))
    expect(reviewStatus(store.state, items[2])).toBe('removed')
    expect(spans(store.state.clips)).toEqual([[0, 20, 1]])
    store.undo()
    expect(reviewStatus(store.state, items[2])).toBe('pending')
    expect(spans(store.state.clips)).toEqual([
      [0, 8, 1],
      [10.4, 20, 1]
    ])
    store.undo()
    expect(reviewStatus(store.state, items[0])).toBe('pending')
    expect(store.canUndo).toBe(false)
    store.update((p) => keepItems(p, reviewItems(p)))
    expect(reviewProgress(items.map((i) => reviewStatus(store.state, i)))).toEqual({ reviewed: 3, total: 3 })
    store.undo()
    expect(store.canUndo).toBe(false)
    store.update((p) => removeItems(p, reviewItems(p).filter((i) => i.kind === 'zoom')))
    expect(store.state.zooms.map((z) => z.id)).toEqual(['mine'])
    store.undo()
    expect(store.canUndo).toBe(false)
  })
})

describe('mergeSnapshot', () => {
  it('keeps reviewed items listed and adds new pending ones in time order', () => {
    const p = fixture()
    const shown = reviewItems(p)
    const after = keepItems(p, [shown[0]])
    const fresh = { ...after, zooms: [...after.zooms, zoom('z9', 0.5)] }
    expect(mergeSnapshot(shown, reviewItems(fresh)).map((i) => i.key)).toEqual(['zoom:z9', 'zoom:z1', 'camera:l1', 'cut:s1'])
  })
})

describe('previewStretch', () => {
  it('plays across a cut point: 1.5 s before and after it', () => {
    const clips = [clip(0, 8), clip(10.4, 20)]
    const s = previewStretch(clips, 8, 10.4)
    expect(s.from).toBeCloseTo(6.5)
    expect(s.until).toBeCloseTo(9.5)
  })

  it('is capped at PREVIEW_MAX and clamped to the video', () => {
    const clips = [clip(0, 20)]
    const long = previewStretch(clips, 2, 18)
    expect(long.until - 0.5).toBeCloseTo(PREVIEW_MAX)
    const start = previewStretch(clips, 0.5, 1)
    expect(start.from).toBe(0)
    const end = previewStretch(clips, 19.5, 20)
    expect(end.until).toBeCloseTo(outputDuration(clips))
  })
})

describe('recording at the sources', () => {
  const NONE: PolishOptions = { ...DEFAULT_POLISH_OPTIONS, styleId: null, zoom: false, silences: false, captions: false, director: false }
  const input = (p: Project) => ({
    project: p,
    recorded: { samples: [], clicks: [], keys: [], valid: false },
    sound: [
      { start: 0.3, end: 3.5 },
      { start: 7.5, end: 11.9 }
    ],
    transcript: null,
    speech: null,
    framing: { status: 'skipped' as const },
    preset: null
  })

  it('Polish’s silences are recorded as Polish, and polishing again records nothing', () => {
    const p = project({ duration: 12, clips: [clip(0, 12)], hasWebcam: false })
    const r = planPolish(input(p), { ...NONE, silences: true })
    expect(r.project.autoCuts?.map((c) => [c.by, c.action, +c.start.toFixed(2), +c.end.toFixed(2)])).toEqual([['polish', 'cut', 3.75, 7.25]])
    expect(reviewItems(r.project).map((i) => i.title)).toEqual(['Cut 3.5 s of silence'])
    const again = planPolish({ ...input(r.project) }, { ...NONE, silences: true })
    expect(again.project).toBe(r.project)
  })

  it('recordAutoCuts on the Clip panel’s apply: the same clips as before, plus the record', () => {
    const p = project()
    const ranges = [{ start: 4, end: 9, saved: 5 }]
    const next = recordAutoCuts(p, applySmartSpeed(p.clips, ranges, 'cut'), ranges, 'cut', 'smart-speed')
    expect(spans(next.clips)).toEqual(spans(applySmartSpeed(p.clips, ranges, 'cut')))
    expect(reviewItems(next)[0].title).toBe('Cut 5.0 s of idle time')
  })

  it('suggestionRanges: the ranges cutWords cuts, by kind, with the words', () => {
    const transcript = {
      provider: 'test',
      language: 'en',
      createdAt: '',
      segments: [
        {
          id: 's',
          start: 0,
          end: 3,
          text: 'so um hello',
          words: [
            { text: 'so', start: 0, end: 0.4 },
            { text: 'um', start: 1, end: 1.3 },
            { text: 'hello', start: 2, end: 2.6 }
          ]
        }
      ]
    }
    const words = transcriptWords(transcript as never)
    const [r] = suggestionRanges(words, [{ kind: 'filler', first: 1, last: 1 }], 20)
    expect(r).toEqual({ start: 0.7, end: 1.65, by: 'filler', words: 'um' })
    const p = project()
    const next = recordAutoCuts(p, cutRange(p.clips, r.start, r.end), [r], 'cut', 'filler')
    expect(reviewItems(next)[0].title).toBe('Removed “um”')
  })
})
