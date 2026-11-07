import { describe, expect, it, vi } from 'vitest'
import type { Rect } from '../src/shared/engine/layout'
import type { CaptionSettings, ChapterBar, Project, TitleCard } from '../src/shared/types'
import { sceneFixtures } from './verticalFixtures'

/*
 * The progress bar (docs/design/editing-polish.md §8, §19.1 tests 31 to 34 and 77): its segments
 * from the exported chapters, its place and size, its state at a video time, the room the text
 * keeps from it, its names, and its drawing (on a canvas that records its calls).
 */

interface Call {
  name: string
  args: unknown[]
  alpha: unknown
  fill: unknown
  font: unknown
}
const calls: Call[] = []
function recordingContext(): unknown {
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => void calls.push({ name: String(prop), args, alpha: target.globalAlpha, fill: target.fillStyle, font: target.font })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
}
vi.stubGlobal('Path2D', class {})

const { createProject } = await import('../src/shared/engine/project')
const { DEFAULT_REFRAME } = await import('../src/shared/engine/reframeData')
const { CHAPTER_BAR, barBand, barLabels, barState, captionsAtTop, chapterBarLayout, fitName, graphemeList } = await import('../src/shared/render/chapterBar')
const { textArea, textAreaWithoutBar, COMMON_SAFE } = await import('../src/shared/render/safeZones')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { STUDIO_BASE } = await import('../src/shared/captions/studioPresets')
const { videoDuration, planOf } = await import('../src/shared/engine/freeze')
const { titlePhase } = await import('../src/shared/render/titleCards')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const RENDER = '../src/renderer/src/render/'
type Fc = { ctx: unknown; w: number; h: number; t: number; project: Project; vw: number; vh: number }
const { drawChapterBar } = (await import(/* @vite-ignore */ `${RENDER}chapterBarLayer`)) as { drawChapterBar: (fc: Fc, video: number) => void }
const { captionBlockAt } = (await import(/* @vite-ignore */ `${RENDER}captionsLayer`)) as {
  captionBlockAt: (ctx: unknown, project: Project, t: number, w: number, h: number, area?: Rect | null) => { top: number; bottom: number } | null
}

const BAR: ChapterBar = { show: true, place: 'auto', style: 'float', labels: 'current' }
const chapter = (id: string, t: number, title: string) => ({ id, t, title })

/** A 30 s 1920 x 1080 recording, kept whole, with `extra`. */
function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 30,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  return { ...p, captions: { ...DEFAULT_CAPTIONS, show: false }, chapterBar: BAR, ...extra }
}
const tall = (p: Project, appSafe: boolean): Project => ({ ...p, style: { ...p.style, aspectRatio: '9:16' }, reframe: { ...DEFAULT_REFRAME, mode: 'fit', appSafe } })
const CHAPTERS = [chapter('a', 6, 'Setup'), chapter('b', 15, 'Build'), chapter('c', 24, 'Ship')]
const SPEECH = { segments: [{ id: 's1', start: 1, end: 29, text: 'one two three four five six seven eight nine ten eleven twelve' }] }
const captions = (c: Partial<CaptionSettings>): Partial<Project> => ({ captions: { ...DEFAULT_CAPTIONS, ...c }, transcript: SPEECH as Project['transcript'] })

const layoutOf = (p: Project, w = 1920, h = 1080): NonNullable<ReturnType<typeof chapterBarLayout>> =>
  chapterBarLayout(p, w, h, textAreaWithoutBar(p, w, h, 1920, 1080, 1))!

describe('chapterBarLayout (test 31)', () => {
  it('splits at the exported chapters, with an unlabelled intro segment; holds included', () => {
    const p = project({ chapters: CHAPTERS })
    const l = layoutOf(p)
    expect(l.segments.map((s) => [s.from, s.to, s.title])).toEqual([
      [0, 6, null],
      [6, 15, 'Setup'],
      [15, 24, 'Build'],
      [24, 30, 'Ship']
    ])
    // A cut of 9-11 s and a 2 s hold at 3 s: chapters move to their video times.
    const cut = project({ chapters: CHAPTERS, clips: [{ id: 'c1', start: 0, end: 9, speed: 1 }, { id: 'c2', start: 11, end: 30, speed: 1 }], freezes: [{ id: 'f', at: 3, length: 2, sound: 'pause' }] })
    const total = videoDuration(cut.clips, planOf(cut))
    expect(total).toBeCloseTo(30, 9)
    expect(layoutOf(cut).segments.map((s) => [s.from, s.to])).toEqual([
      [0, 8],
      [8, 15],
      [15, 24],
      [24, total]
    ])
    // A first chapter at the very start: no intro segment.
    expect(layoutOf(project({ chapters: [chapter('a', 0.05, 'A'), chapter('b', 10, 'B')] })).segments.map((s) => [s.from, s.title])).toEqual([
      [0, 'A'],
      [10, 'B']
    ])
  })

  it('is one plain segment with fewer than two chapters, and shows no names then', () => {
    for (const chapters of [[], [chapter('a', 6, 'Only')]]) {
      const l = layoutOf(project({ chapters }))
      expect(l.segments.map((s) => [s.from, s.to, s.title])).toEqual([[0, 30, null]])
      expect(l.labels).toBe('none')
    }
  })

  it('leaves a gap of max(2 px, 0.005 S) between segments; a tiny one is drawn half a gap wide', () => {
    const l = layoutOf(project({ chapters: CHAPTERS }))
    const S = 1080
    const g = 0.005 * S
    expect(l.gap).toBeCloseTo(g, 9)
    const L = l.x1 - l.x0
    expect(l.segments[0].x0).toBeCloseTo(l.x0, 9)
    expect(l.segments[0].x1).toBeCloseTo(l.x0 + (L * 6) / 30 - g / 2, 9)
    expect(l.segments[1].x0).toBeCloseTo(l.x0 + (L * 6) / 30 + g / 2, 9)
    expect(l.segments[3].x1).toBeCloseTo(l.x1, 9)
    expect(layoutOf(project({ chapters: CHAPTERS }), 200, 112).gap).toBe(2)
    const tiny = layoutOf(project({ chapters: [chapter('a', 10, 'A'), chapter('b', 10.12, 'B'), chapter('c', 20, 'C')] }))
    const s = tiny.segments[1]
    expect(s.x1 - s.x0).toBeCloseTo(g / 2, 9)
    const share = (tiny.x1 - tiny.x0) / 30
    expect((s.x0 + s.x1) / 2).toBeCloseTo(tiny.x0 + share * 10.06, 6)
  })

  it('Floating and Edge in 1920 x 1080', () => {
    const S = 1080
    const f = layoutOf(project({ chapters: CHAPTERS }))
    expect(f).toMatchObject({ edge: 'top', round: true, color: '#ffffff' })
    expect(f.x0).toBeCloseTo(0.03 * S, 9)
    expect(f.x1).toBeCloseTo(1920 - 0.03 * S, 9)
    expect(f.y).toBeCloseTo(0.03 * S, 9)
    expect(f.th).toBeCloseTo(0.008 * S, 9)
    const e = layoutOf(project({ chapters: CHAPTERS, chapterBar: { ...BAR, style: 'edge', place: 'bottom' } }))
    expect(e).toMatchObject({ edge: 'bottom', round: false, x0: 0, x1: 1920 })
    expect(e.th).toBeCloseTo(0.006 * S, 9)
    expect(e.y).toBeCloseTo(1080 - 0.006 * S, 9)
  })

  it('in 1080 x 1920 with app-safe zones: inside COMMON_SAFE, and Edge drawn as Floating', () => {
    const S = 1080
    for (const style of ['float', 'edge'] as const) {
      const p = tall(project({ chapters: CHAPTERS, chapterBar: { ...BAR, style } }), true)
      const l = layoutOf(p, 1080, 1920)
      expect(l.round).toBe(true)
      expect(l.th).toBeCloseTo(0.008 * S, 9)
      expect(l.x0).toBeCloseTo(COMMON_SAFE.x * 1080 + 0.03 * S, 9)
      expect(l.x1).toBeCloseTo((COMMON_SAFE.x + COMMON_SAFE.w) * 1080 - 0.03 * S, 9)
      expect(l.y).toBeCloseTo(COMMON_SAFE.y * 1920 + 0.03 * S, 9)
    }
    // Without app-safe zones, Edge is flush with the tall frame.
    expect(layoutOf(tall(project({ chapterBar: { ...BAR, style: 'edge' } }), false), 1080, 1920)).toMatchObject({ x0: 0, x1: 1080, y: 0, round: false })
  })

  it('takes the brand colour, then white; its own colour first', () => {
    expect(layoutOf(project({ brand: { colors: ['#123456', '#abcdef'] } })).color).toBe('#123456')
    expect(layoutOf(project({ brand: { colors: ['#123456'] }, chapterBar: { ...BAR, color: '#ff0000' } })).color).toBe('#ff0000')
  })

  it('is null without chapterBar.show', () => {
    expect(chapterBarLayout(project({ chapterBar: undefined }), 1920, 1080, null)).toBeNull()
    expect(chapterBarLayout(project({ chapterBar: { ...BAR, show: false } }), 1920, 1080, null)).toBeNull()
  })
})

describe('barState (test 32)', () => {
  const p = project({ chapters: CHAPTERS })
  const l = layoutOf(p)

  it('fades in over 0.3 s from the start; the current segment grows over 0.15 s', () => {
    expect(barState(l, 0, 0, p).alpha).toBe(0)
    expect(barState(l, 0.15, 0.15, p).alpha).toBeCloseTo(0.5, 12)
    expect(barState(l, 5, 5, p)).toEqual({ alpha: 1, current: 0, grow: 1.5, labelAlpha: 1 })
    expect(barState(l, 6, 6, p)).toMatchObject({ current: 1, grow: 1 })
    expect(barState(l, 6.075, 6.075, p).grow).toBeCloseTo(1.25, 12)
    expect(barState(l, 6.15, 6.15, p).grow).toBe(1.5)
    expect(barState(l, 29.9, 29.9, p).current).toBe(3)
  })

  it('Show only when a chapter starts: 3 s from each segment start, with 0.3 s fades', () => {
    const only = { ...p, chapterBar: { ...BAR, onlyAtChapters: true } }
    const a = (v: number): number => barState(l, v, v, only).alpha
    expect(a(1.5)).toBe(1)
    expect(a(3.5)).toBe(0)
    expect(a(6)).toBe(0)
    expect(a(6.15)).toBeCloseTo(0.5, 12)
    expect(a(7)).toBe(1)
    expect(a(9 - 0.15)).toBeCloseTo(0.5, 12)
    expect(a(9.2)).toBe(0)
    // A segment shorter than 3 s keeps the bar showing into the next one, without a flicker.
    const close = { ...only, chapters: [chapter('a', 6, 'A'), chapter('b', 7, 'B'), chapter('c', 20, 'C')] }
    const lc = layoutOf(close)
    expect(barState(lc, 7, 7, close).alpha).toBe(1)
    expect(barState(lc, 7.1, 7.1, close).alpha).toBe(1)
  })

  it('names hide while an automatic chapter-title card shows', () => {
    const card: TitleCard = { id: 't', start: 6, end: 9, title: 'Setup', style: 'lower-third', background: 'blur', auto: { by: 'chapter', via: 'chapters', chapter: 'a' } as TitleCard['auto'] }
    const q = { ...p, titles: [card] }
    expect(barState(l, 7, 7, q).labelAlpha).toBe(0)
    expect(barState(l, 10, 10, q).labelAlpha).toBe(1)
    // A lower third does not fade the bar.
    expect(barState(l, 7, 7, q).alpha).toBe(1)
  })

  it('the fill is linear in video time and keeps moving through a pause hold (drawn)', () => {
    const held = project({ chapters: CHAPTERS, freezes: [{ id: 'f', at: 10, length: 2, sound: 'pause' }] })
    const lh = layoutOf(held)
    const played = (v: number): number => {
      calls.length = 0
      // Inside the hold the picture's source time stays at 10.
      drawChapterBar({ ctx: recordingContext(), w: 1920, h: 1080, t: 10, project: held, vw: 1920, vh: 1080 }, v)
      // The played parts (filled in the bar's colour), each after its own path: segment 1's starts at its x0.
      const played = calls.flatMap((k, i) => (k.name === 'fill' && k.fill === '#ffffff' ? [calls.slice(0, i).filter((c) => c.name === 'roundRect').at(-1)!] : []))
      const rr = played.find((c) => Math.abs((c.args[0] as number) - lh.segments[1].x0) < 1e-9)!
      return rr.args[2] as number
    }
    const seg = lh.segments[1]
    expect([seg.from, seg.to]).toEqual([6, 17])
    const w = seg.x1 - seg.x0
    for (const v of [10.2, 11, 11.8]) expect(played(v)).toBeCloseTo((w * (v - seg.from)) / (seg.to - seg.from), 9)
    expect(played(11) - played(10.5)).toBeCloseTo(played(11.5) - played(11), 9)
  })
})

describe('room for the bar (test 33)', () => {
  const S = 1080
  it('textArea shrinks by the band: 0.042 S without names, 0.111 S with them in a wide frame', () => {
    const plain = project({ chapters: [] })
    expect(barBand(plain, 1920, 1080)!.size).toBeCloseTo((0.03 + 1.5 * 0.008) * S, 9)
    const a = textArea(plain, 1920, 1080, 1920, 1080, 1)!
    expect([a.x, a.w]).toEqual([0, 1920])
    expect(a.y).toBeCloseTo((0.03 + 0.012) * S, 9)
    expect(a.y + a.h).toBeCloseTo(1080, 9)
    const named = project({ chapters: CHAPTERS })
    const band = barBand(named, 1920, 1080)!
    expect(band.size).toBeCloseTo((0.03 + 0.012 + 0.01 + 1.4 * 0.042) * S, 9)
    expect(band.size / S).toBeCloseTo(0.111, 3)
    expect(barBand({ ...named, chapterBar: { ...BAR, labels: 'none' } }, 1920, 1080)!.size).toBeCloseTo(0.042 * S, 9)
    expect(textArea(named, 1920, 1080, 1920, 1080, 1)!.y).toBeCloseTo(band.size, 9)
    // At the bottom, the area's bottom moves up.
    const low = { ...named, chapterBar: { ...BAR, place: 'bottom' as const } }
    const b = textArea(low, 1920, 1080, 1920, 1080, 1)!
    expect([b.x, b.y, b.w]).toEqual([0, 0, 1920])
    expect(b.h).toBeCloseTo(1080 - band.size, 9)
  })

  it('a legacy caption and a Studio block at the top keep clear of a bar at the top', () => {
    const ctx = recordingContext()
    for (const look of [captions({ position: 'top' }), captions({ studio: { ...STUDIO_BASE, layout: { ...STUDIO_BASE.layout, position: 'top' } } })]) {
      const p = project({ chapters: CHAPTERS, chapterBar: { ...BAR, place: 'top' }, ...look })
      const area = textArea(p, 1920, 1080, 1920, 1080, 5)
      const block = captionBlockAt(ctx, p, 5, 1920, 1080, area)!
      expect(block.top).toBeGreaterThanOrEqual(barBand(p, 1920, 1080)!.size)
      // Without the bar the same caption sits higher, in the band.
      const before = captionBlockAt(ctx, { ...p, chapterBar: undefined }, 5, 1920, 1080, textArea({ ...p, chapterBar: undefined }, 1920, 1080, 1920, 1080, 5))!
      expect(before.top).toBeLessThan(barBand(p, 1920, 1080)!.size)
    }
  })

  it('without the bar, textArea is today\'s for every fixture', () => {
    for (const f of sceneFixtures()) {
      for (const t of f.times.slice(0, 40)) {
        const today = textAreaWithoutBar(f.drawn, f.w, f.h, f.vw, f.vh, t)
        expect(textArea(f.drawn, f.w, f.h, f.vw, f.vh, t), f.name).toEqual(today)
        expect(textArea({ ...f.drawn, chapterBar: { ...BAR, show: false } }, f.w, f.h, f.vw, f.vh, t), f.name).toEqual(today)
      }
    }
  })
})

describe('names (test 34)', () => {
  const measure = (s: string): number => [...s].length * 10

  it('Current: at its segment start, moved left to stay inside the bar, crossfading over 0.2 s', () => {
    const p = project({ chapters: [chapter('a', 3, 'Start'), chapter('b', 29.5, 'A long last chapter')] })
    const l = layoutOf(p)
    const last = barLabels(l, barState(l, 29.9, 29.9, p), 29.9, 1080, measure)
    expect(last).toHaveLength(1)
    expect(last[0].x + last[0].w).toBeCloseTo(l.x1, 9)
    expect(last[0].x).toBeLessThan(l.segments[2].x0)
    // 0.1 s after a chapter starts: half the new name, half the old one.
    const mid = barLabels(l, barState(l, 29.6, 29.6, p), 29.6, 1080, measure)
    expect(mid.map((k) => [k.text, k.alpha])).toEqual([
      ['Start', expect.closeTo(0.5, 9)],
      ['A long last chapter', expect.closeTo(0.5, 9)]
    ])
    // The pill: 1.4 em high, 0.01 S under the grown bar.
    const px = 0.042 * 1080
    expect(last[0].h).toBeCloseTo(1.4 * px, 9)
    expect(last[0].y).toBeCloseTo(l.y + 1.5 * l.th + 0.01 * 1080, 9)
    expect(last[0].w).toBeCloseTo(measure('A long last chapter') + px, 9)
  })

  it('All: centred over each segment, shortened by graphemes, never inside a Bangla conjunct', () => {
    const name = 'অধ্যায় তিন'
    const g = graphemeList(name)
    expect(g).toEqual(['অ', 'ধ্যা', 'য়', ' ', 'তি', 'ন'])
    for (let max = 0; max <= 200; max += 5) {
      const fit = fitName(name, max, measure)
      if (fit === null) continue
      if (fit === name) continue
      const kept = fit.slice(0, -1)
      expect(fit.endsWith('…')).toBe(true)
      // Whole graphemes only: the kept part is a run of the name's graphemes.
      const k = graphemeList(kept).length
      expect(g.slice(0, k).join('').trimEnd()).toBe(kept)
      expect(kept.endsWith('্')).toBe(false)
      expect(measure(fit)).toBeLessThanOrEqual(max)
    }
    const p = project({ chapters: [chapter('a', 0, name), chapter('b', 15, 'Two')], chapterBar: { ...BAR, labels: 'all' } })
    const l = layoutOf(p)
    const names = barLabels(l, barState(l, 5, 5, p), 5, 1080, measure)
    expect(names.map((k) => k.text)).toEqual([name, 'Two'])
    for (const [i, k] of names.entries()) expect(k.x + k.w / 2).toBeCloseTo((l.segments[i].x0 + l.segments[i].x1) / 2, 9)
  })

  it('a name with fewer than three graphemes left is hidden; a short name that fits shows', () => {
    expect(fitName('Introduction', 25, (s) => [...s].length * 10)).toBeNull()
    expect(fitName('Introduction', 40, (s) => [...s].length * 10)).toBe('Int…')
    expect(fitName('Go', 25, (s) => [...s].length * 10)).toBe('Go')
    // "All": a segment too narrow for three graphemes shows no name.
    const p = project({ chapters: [chapter('a', 0, 'Introduction'), chapter('b', 0.5, 'Body')], chapterBar: { ...BAR, labels: 'all' } })
    const l = layoutOf(p)
    expect(barLabels(l, barState(l, 5, 5, p), 5, 1080, measure).map((k) => k.text)).toEqual(['Body'])
  })
})

describe('placement and size (test 77)', () => {
  it('Auto is the top with bottom captions and the bottom with top captions', () => {
    expect(layoutOf(project({ ...captions({ position: 'bottom' }) })).edge).toBe('top')
    expect(layoutOf(project({ ...captions({ position: 'top' }) })).edge).toBe('bottom')
    expect(layoutOf(project({ ...captions({ position: 'top', show: false }) })).edge).toBe('top')
    const studio = (layout: Partial<typeof STUDIO_BASE.layout>) => captions({ studio: { ...STUDIO_BASE, layout: { ...STUDIO_BASE.layout, ...layout } } })
    expect(captionsAtTop(project(studio({ position: 'upper' })), 1920, 1080)).toBe(true)
    expect(captionsAtTop(project(studio({ position: 'lower' })), 1920, 1080)).toBe(false)
    expect(captionsAtTop(project(studio({ position: 'bottom', place: { x: 0.5, y: 0.2 } })), 1920, 1080)).toBe(true)
    // No words: nothing shows.
    expect(captionsAtTop(project({ ...captions({ position: 'top' }), transcript: undefined }), 1920, 1080)).toBe(false)
  })

  it('the bar fades out under a full-frame title card (alpha 1 - b), not under a lower third', () => {
    const card: TitleCard = { id: 't', start: 0, end: 4, title: 'Intro', style: 'centered', background: 'blur' }
    const p = project({ chapters: CHAPTERS, titles: [card] })
    const l = layoutOf(p)
    // The intro opens the video: its background is fully on, the bar hidden.
    expect(barState(l, 2, 2, p).alpha).toBe(0)
    const mid: TitleCard = { ...card, start: 10, end: 14 }
    const q = project({ chapters: CHAPTERS, titles: [mid] })
    for (const t of [10.1, 10.2, 12, 13.8]) {
      const b = titlePhase(mid, t, q.clips)!.background
      expect(barState(l, t, t, q).alpha).toBeCloseTo(1 - b, 12)
    }
    expect(barState(l, 12, 12, project({ chapters: CHAPTERS, titles: [{ ...mid, style: 'lower-third' }] })).alpha).toBe(1)
  })

  it('names are 0.042 S in 1920 x 1080 and 0.036 S in 1080 x 1920, weight 700, on a pill of alpha 0.55', () => {
    for (const [w, h, size] of [
      [1920, 1080, 0.042],
      [1080, 1920, 0.036]
    ] as const) {
      const p = { ...project({ chapters: CHAPTERS }), style: { ...project().style, aspectRatio: w > h ? ('16:9' as const) : ('9:16' as const) } }
      const l = chapterBarLayout(p, w, h, null)!
      expect(l.labelPx).toBeCloseTo(size * 1080, 9)
      calls.length = 0
      drawChapterBar({ ctx: recordingContext(), w, h, t: 8, project: p, vw: 1920, vh: 1080 }, 8)
      const text = calls.find((k) => k.name === 'fillText')!
      expect(text.args[0]).toBe('Setup')
      expect(String(text.font).startsWith(`700 ${size * 1080}px `)).toBe(true)
      // The bundled script fonts, so a Bangla name draws the same on every PC.
      expect(String(text.font)).toContain('FlownCat-noto-sans-bengali')
      expect(text.fill).toBe('#ffffff')
      const pill = calls.find((k) => k.name === 'fill' && k.fill === `rgba(0, 0, 0, ${CHAPTER_BAR.pillAlpha})`)
      expect(pill).toBeTruthy()
      expect(CHAPTER_BAR.pillAlpha).toBe(0.55)
    }
  })

  it('draws nothing without chapterBar.show', () => {
    calls.length = 0
    drawChapterBar({ ctx: recordingContext(), w: 1920, h: 1080, t: 5, project: project({ chapterBar: undefined }), vw: 1920, vh: 1080 }, 5)
    drawChapterBar({ ctx: recordingContext(), w: 1920, h: 1080, t: 5, project: project({ chapterBar: { ...BAR, show: false } }), vw: 1920, vh: 1080 }, 5)
    expect(calls).toEqual([])
  })
})
