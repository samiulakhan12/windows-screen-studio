import { describe, expect, it } from 'vitest'
import type { Rect } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import { placeChunk, type CaptionLayout } from '../src/shared/captions/layout'
import { blockEdge, captionObstacles, placeStudio, studioChunkAt, studioLayout, studioMetrics, type CaptionObstacles, type StudioFace, type StudioLayout } from '../src/shared/captions/studioLayout'
import { STUDIO_BASE, studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionSegment, CaptionStudio, CaptionWord, Project, StudioPosition } from '../src/shared/types'

/* Tests 9, 10 and 11 (docs/design/captions-studio.md §16.1): chunk modes (§8.2), positions (§8.5) and keeping clear (§8.6). */

const FACE: StudioFace = { stack: 'test', weight: 600, tracking: 0 }
const measure = (text: string, px: number): number => [...text].length * 0.55 * px
const look = (id: string): CaptionStudio => structuredClone(studioPreset(id)!.look)

/** Words every `step` seconds, `dur` long, with an optional pause after some. */
function timed(text: string, step = 0.3, dur = 0.25, pauses: Record<number, number> = {}): CaptionSegment {
  let t = 0
  const words: CaptionWord[] = text.split(' ').map((w, i) => {
    const word = { text: w, start: t, end: t + dur }
    t += step + (pauses[i] ?? 0)
    return word
  })
  return { id: 'c1', start: 0, end: t, text, words }
}

function lay(seg: CaptionSegment, studio: CaptionStudio, w = 1920, h = 1080, marks?: { from: number; to: number; tone?: 2 }[]): StudioLayout {
  return studioLayout(seg, studio, w, h, measure, { faceOf: () => FACE, language: 'en', marks })
}

const chunkTexts = (l: StudioLayout): string[] => l.chunks.map((c) => c.lines.map((line) => line.words.map((w) => w.text).join(' ')).join(' / '))

describe('chunk modes (test 9)', () => {
  const few = (words = 3): CaptionStudio => ({ ...look('clean-short'), text: { ...look('clean-short').text, case: 'asis' }, layout: { ...look('clean-short').layout, words } })

  it('a few words: three at a time, ending at sentence ends and pauses of 0.15 s', () => {
    expect(chunkTexts(lay(timed('Make every word count. Today we win big'), few()))).toEqual(['Make every word', 'count.', 'Today we win', 'big'])
    // A 0.15 s pause after "every" ends the chunk there; 0.1 s does not.
    expect(chunkTexts(lay(timed('Make every word count today', 0.3, 0.25, { 1: 0.12 }), few()))[0]).toBe('Make every')
    expect(chunkTexts(lay(timed('Make every word count today', 0.3, 0.25, { 1: 0.04 }), few()))[0]).toBe('Make every word')
  })

  it('a few words: a Latin word of 1–2 letters never ends a chunk', () => {
    const l = lay(timed('So I am in the big room of my new house at the end of it'), few())
    const texts = chunkTexts(l)
    for (const t of texts.slice(0, -1)) {
      const last = t.split(/[ /]+/).pop()!
      expect(last.replace(/\W/g, '').length, t).toBeGreaterThan(2)
    }
    expect(texts[0]).toBe('So I am in the')
  })

  it('a few words: chunks start at their first word (the last at least 0.4 s before the end), and each shows until the next', () => {
    const l = lay(timed('one two three four five six seven'), few())
    expect(l.chunks.map((c) => c.start)).toEqual([0, 0.8999999999999999, 2.1 - 0.4])
    for (let i = 0; i + 1 < l.chunks.length; i++) expect(l.chunks[i].end).toBe(l.chunks[i + 1].start)
    expect(studioChunkAt(l, 0.5)).toBe(0)
    expect(studioChunkAt(l, 1)).toBe(1)
    expect(studioChunkAt(l, -0.1)).toBe(-1)
    expect(studioChunkAt(l, 99)).toBe(-1)
  })

  it('one word: a word at a time, a Latin word of 1–3 letters joins the next', () => {
    expect(chunkTexts(lay(timed('Click IN THE big box now'), look('one-word')))).toEqual(['CLICK', 'IN THE', 'BIG BOX', 'NOW'])
  })

  it('one word: Chinese words of 2–4 characters', () => {
    const l = studioLayout({ id: 'c', start: 0, end: 3, text: '我们今天学习如何导出视频' }, look('one-word'), 1080, 1920, measure, { faceOf: () => FACE, language: 'zh' })
    for (const t of chunkTexts(l)) expect([...t].length, t).toBeGreaterThanOrEqual(2)
    for (const t of chunkTexts(l)) expect([...t].length, t).toBeLessThanOrEqual(4)
  })

  it('stacked: lines fit within 0.6–2.2 times the size, and an emphasised word gets a line of its own', () => {
    const s = look('stacked')
    const l = lay(timed('this is the most important part of the whole video'), s, 1080, 1920, [{ from: 4, to: 4 }])
    const m = studioMetrics(s, 1080, 1920)
    for (const c of l.chunks) {
      expect(c.lines.length).toBeLessThanOrEqual(4)
      for (const line of c.lines) {
        expect(line.px).toBeGreaterThanOrEqual(0.6 * m.px - 1e-9)
        expect(line.px).toBeLessThanOrEqual(2.2 * m.px + 1e-9)
        // Each line fills `fit` of the room unless the clamp stopped it.
        if (line.px > 0.6 * m.px + 1e-6 && line.px < 2.2 * m.px - 1e-6) expect(line.width).toBeCloseTo(m.maxWidth * s.layout.fit!, 6)
      }
    }
    const withImportant = l.chunks.flatMap((c) => c.lines).find((line) => line.words.some((w) => w.text === 'IMPORTANT'))!
    expect(withImportant.words.map((w) => w.text)).toEqual(['IMPORTANT'])
    // At most six words per chunk.
    for (const c of l.chunks) expect(c.last - c.first + 1).toBeLessThanOrEqual(6)
  })

  it('draws a word too long for the room smaller, so no line is wider than the room or the frame (§8.4)', () => {
    // Bold Pop in a tall frame: "TROUBLESHOOTING" at the look's size is wider than the room.
    const s = look('bold-pop')
    const m = studioMetrics(s, 1080, 1920)
    const l = lay(timed('fix the troubleshooting step'), s, 1080, 1920)
    expect(15 * 0.55 * l.px).toBeGreaterThan(m.maxWidth)
    const lines = l.chunks.flatMap((c) => c.lines)
    const long = lines.find((line) => line.words.some((w) => w.text === 'TROUBLESHOOTING'))!
    expect(long.width).toBeCloseTo(m.maxWidth, 6)
    expect(long.px).toBeLessThan(l.px)
    for (const line of lines) expect(line.width).toBeLessThanOrEqual(m.maxWidth * (1 + 1e-9))
    // Lines that fit keep the look's size.
    expect(lines.find((line) => line.words.some((w) => w.text === 'FIX'))!.px).toBe(l.px)
    const c = l.chunks.find((ch) => ch.lines.includes(long))!
    const placed = placeStudio(l, c, s, 1080, 1920, {}).lines[c.lines.indexOf(long)]
    expect(placed.x).toBeGreaterThanOrEqual(0)
    expect(placed.x + placed.width).toBeLessThanOrEqual(1080)
    // One Word and Stacked too, below their 0.6 floor when they must.
    for (const id of ['one-word', 'stacked']) {
      const st = look(id)
      const room = studioMetrics(st, 1080, 1920).maxWidth
      const one = lay(timed('incomprehensibilities'), st, 1080, 1920)
      for (const line of one.chunks.flatMap((ch) => ch.lines)) expect(line.width, id).toBeLessThanOrEqual(room * (1 + 1e-9))
    }
  })

  it('emphasised words are measured at the emphasis scale, and the layout keeps room for a spoken word that grows', () => {
    const bp = look('bold-pop')
    const l = lay(timed('make every word count'), bp, 1920, 1080, [{ from: 1, to: 1 }])
    const words = l.chunks[0].lines[0].words
    expect(words[1].px).toBeCloseTo(l.px * 1.15, 9)
    expect(words[1].role).toBe('emphasis')
    expect(l.emphasis).toEqual([0, 1, 0, 0])
    const st = look('stickers')
    const plain = lay(timed('three easy steps'), { ...st, motion: { ...st.motion, spokenScale: undefined } })
    const grown = lay(timed('three easy steps'), st)
    const gap = (x: StudioLayout): number => x.chunks[0].lines[0].words[1].x - (x.chunks[0].lines[0].words[0].x + x.chunks[0].lines[0].words[0].w)
    expect(gap(grown)).toBeGreaterThan(gap(plain))
  })

  it('Stickers stand 0.2 em apart, sticker to sticker, with or without a space in the text (more.html)', () => {
    const st = look('stickers')
    const edge = st.box.padX + st.box.border / 2
    for (const [text, language] of [['Three easy steps it is a go', 'en'], ['今天我们一起来看看这个新的功能怎么用', 'zh']] as const) {
      const l = studioLayout({ id: 'c', start: 0, end: 3, text }, st, 1080, 1920, measure, { faceOf: () => FACE, language })
      const room = studioMetrics(st, 1080, 1920, null, language === 'zh' ? 'han' : 'latin').maxWidth
      let pairs = 0
      for (const line of l.chunks.flatMap((ch) => ch.lines)) {
        expect(line.width, text).toBeLessThanOrEqual(room * (1 + 1e-9))
        for (let i = 1; i < line.words.length; i++) {
          const [a, b] = [line.words[i - 1], line.words[i]]
          expect(b.x - edge * b.px - (a.x + a.w + edge * a.px), `${a.text}|${b.text}`).toBeGreaterThanOrEqual(0.2 * b.px - 1e-9)
          pairs++
        }
      }
      expect(pairs, text).toBeGreaterThan(0)
    }
  })

  it('Light to Bold measures every word at its spoken weight, so lines never re-break', () => {
    const weights: number[] = []
    studioLayout(timed('lowercase words turn bold'), look('weight-shift'), 1080, 1920, (t, px, f) => (weights.push(f.weight), measure(t, px)), { faceOf: () => ({ ...FACE, weight: 400 }) })
    expect(weights.filter((w) => w !== 400 && w !== 700)).toEqual([])
    expect(weights).toContain(700)
  })

  it('writes the look in its case and digits, and leaves Bangla without capitals', () => {
    const l = studioLayout({ id: 'c', start: 0, end: 2, text: 'step ৩ of Flown আমরা' }, look('bold-pop'), 1080, 1920, measure, { faceOf: () => FACE, language: 'bn', digits: 'western' })
    expect(l.tokens.map((t) => t.text)).toEqual(['STEP', '3', 'OF', 'FLOWN', 'আমরা'])
  })

  it('in Bangla, a pop style leaves room for a word that grows (§0.2)', () => {
    const bp = look('bold-pop')
    const seg = { id: 'c', start: 0, end: 2, text: 'এক ক্লিকে সুন্দর' }
    const gap = (s: CaptionStudio): number => {
      const words = studioLayout(seg, s, 1080, 1920, measure, { faceOf: () => FACE, language: 'bn' }).chunks[0].lines[0].words
      return words[1].x - (words[0].x + words[0].w)
    }
    expect(gap(bp)).toBeGreaterThan(gap({ ...bp, motion: { ...bp.motion, word: 'none' } }))
    expect(gap({ ...bp, motion: { ...bp.motion, calm: true } })).toBe(gap({ ...bp, motion: { ...bp.motion, word: 'none' } }))
  })

  it('raises the line height for Bangla captions', () => {
    const bn = studioLayout({ id: 'c', start: 0, end: 2, text: 'আমরা আজ শিখব' }, look('bold-pop'), 1080, 1920, measure, { faceOf: () => FACE, language: 'bn' })
    expect(bn.lineHeight / bn.px).toBeCloseTo(1.4, 9)
    expect(lay(timed('we learn today'), look('bold-pop'), 1080, 1920).lineHeight / bn.px).toBeCloseTo(1.05, 9)
  })
})

/* ---------- positions ---------- */

/** One chunk of one line, placed. */
function placeAt(studio: CaptionStudio, w: number, h: number, opts: Parameters<typeof placeStudio>[5] = {}): ReturnType<typeof placeStudio> & { layout: StudioLayout } {
  const l = lay(timed('make every word count'), studio, w, h)
  return { ...placeStudio(l, l.chunks[0], studio, w, h, opts), layout: l }
}
const withPosition = (s: CaptionStudio, position: StudioPosition, extra: Partial<CaptionStudio['layout']> = {}): CaptionStudio => ({ ...s, layout: { ...s.layout, position, ...extra } })

describe('positions (test 10)', () => {
  it('uses the anchors of §8.5 in 1920×1080 and 1080×1920', () => {
    const s = STUDIO_BASE
    const wide = (p: StudioPosition): ReturnType<typeof placeAt> => placeAt(withPosition(s, p), 1920, 1080)
    expect(wide('top').top).toBeCloseTo(0.06 * 1080, 6)
    expect(wide('upper').top + wide('upper').height / 2).toBeCloseTo(0.25 * 1080, 6)
    expect(wide('middle').top + wide('middle').height / 2).toBeCloseTo(0.5 * 1080, 6)
    expect(wide('lower').top + wide('lower').height / 2).toBeCloseTo(0.8 * 1080, 6)
    expect(wide('bottom').top + wide('bottom').height).toBeCloseTo(1080 - 0.075 * 1080, 6)
    const tall = (p: StudioPosition): ReturnType<typeof placeAt> => placeAt(withPosition(s, p), 1080, 1920)
    expect(tall('top').top).toBeCloseTo(0.13 * 1920, 6)
    expect(tall('upper').top + tall('upper').height / 2).toBeCloseTo(0.3 * 1920, 6)
    expect(tall('middle').top + tall('middle').height / 2).toBeCloseTo(0.45 * 1920, 6)
    expect(tall('lower').top + tall('lower').height / 2).toBeCloseTo(0.66 * 1920, 6)
    expect(tall('bottom').top + tall('bottom').height).toBeCloseTo(0.74 * 1920, 6)
    // Lines are centred on the frame, and the box holds them.
    const p = wide('bottom')
    expect(p.lines[0].x + p.lines[0].width / 2).toBeCloseTo(960, 6)
    expect(p.box.y).toBe(p.top)
  })

  it('reports the edge key presses keep clear of', () => {
    expect(placeAt(withPosition(STUDIO_BASE, 'lower'), 1920, 1080).edge).toBe('bottom')
    expect(placeAt(withPosition(STUDIO_BASE, 'upper'), 1920, 1080).edge).toBe('top')
    expect(blockEdge('middle', 100, 1080)).toBe('middle')
    expect(blockEdge(null, 560, 1080)).toBe('middle')
    expect(blockEdge(null, 200, 1080)).toBe('top')
    expect(blockEdge(null, 900, 1080)).toBe('bottom')
  })

  it('keeps the block inside the text area', () => {
    const area: Rect = { x: 60, y: 400, w: 960, h: 900 }
    const inset = 0.02 * 1080
    const top = placeAt(withPosition(STUDIO_BASE, 'top'), 1080, 1920, { area })
    expect(top.top).toBeCloseTo(400 + inset, 6)
    const bottom = placeAt(withPosition(STUDIO_BASE, 'bottom'), 1080, 1920, { area })
    expect(bottom.top + bottom.height).toBeCloseTo(1300 - inset, 6)
  })

  it('a dragged block is centred on its place and kept 0.06 u inside the frame', () => {
    const p = placeAt(withPosition(STUDIO_BASE, 'bottom', { place: { x: 0.3, y: 0.3 } }), 1920, 1080)
    expect(p.box.x + p.box.w / 2).toBeCloseTo(0.3 * 1920, 6)
    expect(p.top + p.height / 2).toBeCloseTo(0.3 * 1080, 6)
    expect(p.edge).toBe('top')
    const corner = placeAt(withPosition(STUDIO_BASE, 'bottom', { place: { x: 1, y: 1 } }), 1920, 1080)
    expect(corner.box.x + corner.box.w).toBeCloseTo(1920 - 0.06 * 1080, 6)
    expect(corner.top + corner.height).toBeCloseTo(1080 - 0.06 * 1080, 6)
  })

  it("with legacyAnchor, the block sits where today's placeChunk puts it, in a tall frame and in its text area", () => {
    for (const area of [null, { x: 60, y: 0.11 * 1920, w: 960, h: 0.65 * 1920 }])
      for (const [position, legacy] of [
        ['bottom', 'bottom'],
        ['middle', 'middle'],
        ['top', 'top']
      ] as const) {
        const s = withPosition(STUDIO_BASE, position, { legacyAnchor: true })
        const p = placeAt(s, 1080, 1920, { area })
        const fake = { lineHeight: p.height, padY: 0 } as CaptionLayout
        const expected = placeChunk(fake, { start: 0, end: 1, lines: [{ words: [], width: 0 }], first: 0, last: 0, width: 0 }, legacy, 1080, 1920, area)
        expect(p.top, `${position} ${area ? 'area' : 'frame'}`).toBeCloseTo(expected.top, 6)
      }
  })

  it('Chat puts the captions of You on the right and the others on the left', () => {
    const chat = look('chat')
    const at = (speaker?: string): number => {
      const l = studioLayout({ ...timed('Sure, opening the dashboard now'), ...(speaker ? { speaker } : {}) }, chat, 1920, 1080, measure, { faceOf: () => FACE })
      const p = placeStudio(l, l.chunks[0], chat, 1920, 1080, {})
      return p.box.x + p.box.w / 2
    }
    expect(at('You')).toBeGreaterThan(960)
    expect(at('Others')).toBeLessThan(960)
    expect(at()).toBe(960)
  })

  it('a caption with its own place uses that edge and does not move for obstacles', () => {
    const s = withPosition(STUDIO_BASE, 'bottom')
    const obstacles: CaptionObstacles = { camera: [{ x: 0, y: 0, w: 1920, h: 300 }], titles: [], keys: null, action: [] }
    const p = placeAt(s, 1920, 1080, { forced: 'top', obstacles })
    expect(p.top).toBeCloseTo(0.06 * 1080, 6)
    expect(p.edge).toBe('top')
  })
})

/* ---------- keeping clear ---------- */

const samples = (from: number, to: number, rect: Rect): { t: number; rect: Rect }[] => {
  const out: { t: number; rect: Rect }[] = []
  for (let t = from; t <= to + 1e-9; t += 0.1) out.push({ t: Math.round(t * 10) / 10, rect })
  return out
}
const none: CaptionObstacles = { camera: [], titles: [], keys: null, action: [] }

describe('keeping clear (test 11)', () => {
  const s = withPosition(STUDIO_BASE, 'bottom')
  const free = placeAt(s, 1920, 1080, { obstacles: none })

  it('a camera bubble at the bottom right lifts the block above it', () => {
    const bubble: Rect = { x: 1100, y: 760, w: 740, h: 300 }
    const p = placeAt({ ...s, layout: { ...s.layout } }, 1920, 1080, { obstacles: { ...none, camera: [bubble] } })
    expect(p.box.x + p.box.w).toBeGreaterThan(bubble.x)
    expect(p.top + p.height).toBeCloseTo(760 - 0.02 * 1080, 6)
    expect(p.top + p.height / 2).toBeGreaterThan(540)
    expect(free.top + free.height).toBeGreaterThan(760)
  })

  it('a camera-only layout keeps the face area clear', () => {
    const project = Object.assign(cameraProject(), { layouts: [{ id: 'l', start: 0, end: 10, layout: 'camera-only' as const }] })
    const seg: CaptionSegment = { id: 'c1', start: 1, end: 3, text: 'make every word count' }
    const obstacles = captionObstacles(project, seg, 1920, 1080, { titles: [], keys: null, action: [] })
    expect(obstacles.camera.length).toBe(1)
    const face = obstacles.camera[0]
    // The middle 40% of the camera's width, from 15% to 65% of its height.
    expect(face.w / face.h).toBeLessThan(1920 / 1080)
    const mid = placeAt(withPosition(STUDIO_BASE, 'middle'), 1920, 1080, { obstacles })
    expect(rectsOverlap(mid.box, face)).toBe(false)
    const plain = placeAt(withPosition(STUDIO_BASE, 'middle'), 1920, 1080, { obstacles: none })
    expect(rectsOverlap(plain.box, face)).toBe(true)
  })

  it('a lower third moves the caption, and key presses lift it', () => {
    const title: Rect = { x: 100, y: 880, w: 900, h: 150 }
    const p = placeAt(s, 1920, 1080, { obstacles: { ...none, titles: [title] } })
    expect(p.top + p.height).toBeLessThanOrEqual(880 - 0.02 * 1080 + 1e-6)
    const keys: Rect = { x: 800, y: 930, w: 320, h: 80 }
    const k = placeAt(s, 1920, 1080, { obstacles: { ...none, keys } })
    expect(k.top + k.height).toBeLessThanOrEqual(930 - 0.02 * 1080 + 1e-6)
  })

  it('a dragged block does not move', () => {
    const dragged = withPosition(STUDIO_BASE, 'bottom', { place: { x: 0.5, y: 0.9 } })
    const a = placeAt(dragged, 1920, 1080, { obstacles: none })
    const b = placeAt(dragged, 1920, 1080, { obstacles: { ...none, camera: [{ x: 0, y: 800, w: 1920, h: 280 }] } })
    expect(b.top).toBe(a.top)
  })

  it('a click and 1 s of cursor under a Bottom caption move it to the Top; a cursor passing through for 0.2 s does not', () => {
    const under: Rect = { x: 900, y: free.top + 5, w: 60, h: 60 }
    const busy = placeAt(s, 1920, 1080, { obstacles: { ...none, action: [{ t: 1.0, rect: under }, ...samples(1.0, 2.0, under)] } })
    expect(busy.top).toBeCloseTo(0.06 * 1080, 6)
    expect(busy.edge).toBe('top')
    const passing = placeAt(s, 1920, 1080, { obstacles: { ...none, action: samples(1.0, 1.1, under) } })
    expect(passing.top).toBeCloseTo(free.top, 6)
  })

  it('never moves onto the camera to clear the cursor', () => {
    const under: Rect = { x: 900, y: free.top + 5, w: 60, h: 60 }
    const camera: Rect = { x: 0, y: 0, w: 1920, h: 400 }
    const p = placeAt(s, 1920, 1080, { obstacles: { ...none, camera: [camera], action: samples(1.0, 2.0, under) } })
    expect(rectsOverlap(p.box, camera)).toBe(false)
  })

  it('is the same for every chunk of a caption', () => {
    const l = lay(timed('make every word count today and always for sure'), look('clean-short'), 1920, 1080)
    expect(l.chunks.length).toBeGreaterThan(1)
    const st = withPosition(look('clean-short'), 'bottom')
    const bubble: Rect = { x: 1400, y: 760, w: 440, h: 300 }
    const obstacles = { ...none, camera: [bubble] }
    const bottoms = l.chunks.map((c) => {
      const p = placeStudio(l, c, st, 1920, 1080, { obstacles })
      return p.top + p.height
    })
    for (const b of bottoms) expect(b).toBeCloseTo(bottoms[0], 6)
  })
})

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function cameraProject(): Project {
  return createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: true, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } as Project['capture'] })
}
