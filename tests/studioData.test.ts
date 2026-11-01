import { describe, expect, it } from 'vitest'
import { readCaptionSettings } from '../src/shared/captions/settings'
import {
  checkAnchor,
  emojiKeyOf,
  MAX_BLEEPS,
  MAX_GRAPHICS,
  MAX_MARKS,
  MAX_TRACKS,
  readBleeps,
  readCaptionAuto,
  readCaptionMarks,
  readCaptionPlaces,
  readCaptionStudio,
  readCaptionTracks,
  readGraphics,
  readItemMotion,
  readStudioFont,
  STUDIO_LIMITS
} from '../src/shared/captions/studioData'
import { STUDIO_BASE, STUDIO_PRESETS } from '../src/shared/captions/studioPresets'
import { studioWordTexts } from '../src/shared/captions/words'
import { migrateProject } from '../src/shared/engine/project'
import { readTitleCard } from '../src/shared/engine/titleData'
import type { CaptionMark, CaptionStudio, Graphic, Transcript } from '../src/shared/types'

/* docs/design/captions-studio.md §4.2, tests 4 and 5 (and the reader half of test 1). */

const transcript: Transcript = {
  language: 'en',
  provider: 'local',
  model: 'm',
  createdAt: '',
  segments: [
    { id: 'c1', start: 0.5, end: 3, text: 'Make every word count today' },
    { id: 'c2', start: 3.5, end: 6.5, text: 'Sales grew 300 percent this year, thanks to Auto Save.' },
    { id: 'c3', start: 7, end: 9.8, text: '我们今天学习如何导出视频' }
  ]
}
const zh: Transcript = { ...transcript, language: 'zh' }

/** A look with every group replaced by `patch` (a deep merge of plain objects). */
function lookWith(patch: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(STUDIO_BASE) as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[k] as object), ...v } : v
  return out
}

describe('readCaptionStudio (test 4)', () => {
  it('reads anything but an object as absent, and {} as Subtitle', () => {
    for (const raw of [undefined, null, 7, 'subtitle', [STUDIO_BASE]]) expect(readCaptionStudio(raw)).toBeUndefined()
    expect(readCaptionStudio({})).toEqual(STUDIO_BASE)
    expect(STUDIO_BASE.from).toBe('subtitle')
  })

  it('reads every built-in look back unchanged, and its own output unchanged', () => {
    for (const p of STUDIO_PRESETS) {
      expect(readCaptionStudio(p.look), p.id).toEqual(p.look)
      expect(readCaptionStudio(JSON.parse(JSON.stringify(p.look))), p.id).toEqual(p.look)
    }
  })

  it('clamps every number to STUDIO_LIMITS', () => {
    const big = readCaptionStudio(
      lookWith({
        text: { weight: 5000, tracking: 1, lineHeight: 9, size: 1, tall: 5, spokenWeight: 9000, scripts: { bengali: { font: 'cat:anek-bangla', weight: 2, width: 500 } } },
        emphasis: { weight: 1, scale: 9 },
        edge: { outline: 1, outlineAlpha: 7, glow: 5, shadow: { x: 9, y: -9, blur: 9, alpha: 9 }, extrude: { steps: 99, x: 1, y: -1 }, split: 1 },
        box: { alpha: 2, padX: 9, padY: -1, radius: 9, border: 1, gap: 9, tail: 9, shadow: { x: 1, y: 1, blur: -1, alpha: -1 } },
        layout: { words: 99, lines: 99, chars: 999, tallChars: -5, fit: 0.1, place: { x: 9, y: -9 } },
        motion: { upcoming: 2, strength: 3, speed: 9, tilt: 99, wordTilt: [-99, 99], spokenScale: 9, spokenTilt: 99 }
      })
    )!
    const L = STUDIO_LIMITS
    expect(big.text).toMatchObject({ weight: L.weight.max, tracking: L.tracking.max, lineHeight: L.lineHeight.max, size: L.size.max, tall: L.tall.max, spokenWeight: L.weight.max })
    expect(big.text.scripts).toEqual({ bengali: { font: 'cat:anek-bangla', weight: L.weight.min, width: L.fontWidth.max } })
    expect(big.emphasis).toMatchObject({ weight: L.weight.min, scale: L.emphasisScale.max })
    expect(big.edge).toMatchObject({ outline: L.outline.max, outlineAlpha: 1, glow: L.glow.max, shadow: { x: 0.3, y: -0.3, blur: 1, alpha: 1 }, extrude: { steps: 12, x: 0.05, y: -0.05 }, split: L.split.max })
    expect(big.box).toMatchObject({ alpha: 1, padX: L.pad.max, padY: 0, radius: L.radius.max, border: L.border.max, gap: L.boxGap.max, tail: L.tail.max, shadow: { x: 0.3, y: 0.3, blur: 0, alpha: 0 } })
    expect(big.layout).toMatchObject({ words: L.words.max, lines: L.lines.max, chars: L.chars.max, tallChars: 0, fit: L.fit.min, place: { x: 1, y: 0 } })
    expect(big.motion).toMatchObject({ upcoming: 1, strength: 1, speed: L.speed.max, tilt: L.tilt.max, wordTilt: [-8, 8], spokenScale: L.spokenScale.max, spokenTilt: L.spokenTilt.max })
    const small = readCaptionStudio(lookWith({ text: { size: 0, tall: 0, tracking: -1, lineHeight: 0 }, motion: { speed: 0, spokenScale: 0, spokenTilt: -99 }, layout: { words: 0, lines: 0 } }))!
    expect(small.text).toMatchObject({ size: L.size.min, tall: L.tall.min, tracking: L.tracking.min, lineHeight: L.lineHeight.min })
    expect(small.motion).toMatchObject({ speed: L.speed.min, spokenScale: 1, spokenTilt: L.spokenTilt.min })
    expect(small.layout).toMatchObject({ words: 1, lines: 1 })
  })

  it('gives a broken field or group the Subtitle value, and drops a broken optional field', () => {
    const r = readCaptionStudio({
      from: 'x'.repeat(100),
      text: { font: 42, weight: 'heavy', case: 'title', size: Number.NaN, tall: Infinity, scripts: { bengali: { font: 'cat:nope', weight: 700 } } },
      emphasis: 'bold',
      theme: { text: 'white', spoken: '#FFE14D', upcoming: '#12', gradient: 'x', fill: { stops: ['#000000'], axis: 'down' }, split: ['#ff0000'] },
      edge: { outline: '0.1', shadow: { x: 0, y: 0, blur: 0 }, hollow: 'yes', extrude: { steps: 3 } },
      box: { kind: 'circle' },
      spoken: 'sparkle',
      layout: { chunk: 'lines', position: 'left', avoid: 'yes', place: { x: 0.5 }, legacyAnchor: 1 },
      motion: { enter: 'spin', exit: 'pop', word: 'dance', tiltOn: 'word', wordTilt: [1], calm: 'true' },
      speakerColors: 1
    })!
    expect(r.from).toHaveLength(64)
    // The Bangla font names a catalogue font that does not exist: dropped (the default draws).
    const { scripts: _scripts, ...plainText } = STUDIO_BASE.text
    void _scripts
    expect(r.text).toEqual(plainText)
    expect(r.emphasis).toEqual(STUDIO_BASE.emphasis)
    expect(r.theme.text).toBe(STUDIO_BASE.theme.text)
    expect(r.theme.spoken).toBe('#ffe14d')
    for (const k of ['upcoming', 'gradient', 'fill', 'split'] as const) expect(r.theme).not.toHaveProperty(k)
    expect(r.edge).toEqual({ outline: STUDIO_BASE.edge.outline, outlineAlpha: STUDIO_BASE.edge.outlineAlpha, glow: STUDIO_BASE.edge.glow })
    expect(r.box).toEqual(STUDIO_BASE.box)
    expect(r.spoken).toBe(STUDIO_BASE.spoken)
    expect(r.layout).toEqual(STUDIO_BASE.layout)
    expect(r.motion).toEqual(STUDIO_BASE.motion)
    expect(r).not.toHaveProperty('speakerColors')
  })

  it('reads fonts: system, known catalogue ids, brand font ids; an unknown catalogue id draws as system', () => {
    expect(readStudioFont('system')).toBe('system')
    expect(readStudioFont('cat:montserrat')).toBe('cat:montserrat')
    expect(readStudioFont('cat:a-font-from-2030')).toBe('system')
    expect(readStudioFont('font-1')).toBe('font-1')
    expect(readStudioFont('../x')).toBeUndefined()
    expect(readStudioFont(7)).toBeUndefined()
    const r = readCaptionStudio(lookWith({ text: { font: 'cat:a-font-from-2030' }, emphasis: { font: 'cat:a-font-from-2030' } }))!
    expect(r.text.font).toBe('system')
    // An emphasis font from a newer build is dropped: emphasised words use the text's font.
    expect(r.emphasis).not.toHaveProperty('font')
    expect(readCaptionStudio(lookWith({ emphasis: { font: 'cat:instrument-serif-italic' } }))!.emphasis.font).toBe('cat:instrument-serif-italic')
  })

  it('lower-cases colours and keeps 2 to 6 gradient stops (1 dropped, 7 cut)', () => {
    const r = readCaptionStudio(lookWith({ theme: { text: '#ABCDEF', emphasis2: '#FF6AD5', gradient: ['#FE9F1B', '#F76E49'], fill: { stops: ['#FF3DCB', 'pink', '#FF8A00'], axis: 'down' }, split: ['#FF004C', '#00E5FF'] } }))!
    expect(r.theme.text).toBe('#abcdef')
    expect(r.theme.emphasis2).toBe('#ff6ad5')
    expect(r.theme.gradient).toEqual(['#fe9f1b', '#f76e49'])
    expect(r.theme.fill).toEqual({ stops: ['#ff3dcb', '#ff8a00'], axis: 'down' })
    expect(r.theme.split).toEqual(['#ff004c', '#00e5ff'])
    expect(readCaptionStudio(lookWith({ theme: { gradient: ['#ffffff'] } }))!.theme).not.toHaveProperty('gradient')
    const seven = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007']
    expect(readCaptionStudio(lookWith({ theme: { gradient: seven } }))!.theme.gradient).toEqual(seven.slice(0, 6))
  })

  it('keeps a fill’s stop places only one for each stop, 0..1 and never going back (Gold: 0, 45, 55, 100%)', () => {
    const fill = (at: unknown): unknown => readCaptionStudio(lookWith({ theme: { fill: { stops: ['#fff3c4', '#f5c84c', '#b7862b', '#f9e08a'], at, axis: 'down' } } }))!.theme.fill
    expect(fill([0, 0.45, 0.55, 1])).toEqual({ stops: ['#fff3c4', '#f5c84c', '#b7862b', '#f9e08a'], at: [0, 0.45, 0.55, 1], axis: 'down' })
    for (const bad of [[0, 0.5, 1], [0, 0.55, 0.45, 1], [0, 0.45, 0.55, 1.2], [-0.1, 0.45, 0.55, 1], [0, Number.NaN, 0.55, 1], [0, '0.45', 0.55, 1], 'x', null])
      expect(fill(bad), JSON.stringify(bad)).toEqual({ stops: ['#fff3c4', '#f5c84c', '#b7862b', '#f9e08a'], axis: 'down' })
    // A stop dropped as no colour drops the places too: they no longer say which stop is where.
    expect(readCaptionStudio(lookWith({ theme: { fill: { stops: ['#ffffff', 'pink', '#000000'], at: [0, 0.5, 1], axis: 'down' } } }))!.theme.fill).toEqual({ stops: ['#ffffff', '#000000'], axis: 'down' })
  })

  it('keeps a dragged place only with finite x and y', () => {
    expect(readCaptionStudio(lookWith({ layout: { place: { x: 0.25, y: 0.75 } } }))!.layout.place).toEqual({ x: 0.25, y: 0.75 })
    expect(readCaptionStudio(lookWith({ layout: { place: { x: 0.25, y: Number.NaN } } }))!.layout).not.toHaveProperty('place')
  })
})

describe('readCaptionSettings, readTitleCard and migrateProject with the new fields', () => {
  it('adds studio, track, picked and digits only when set and valid', () => {
    const base = { show: true, preset: 'clean' }
    const plain = readCaptionSettings(base)!
    for (const k of ['studio', 'track', 'picked', 'digits']) expect(plain).not.toHaveProperty(k)
    const s = readCaptionSettings({ ...base, studio: STUDIO_PRESETS[0].look, track: 'bn', picked: true, digits: 'native' })!
    expect(s.studio).toEqual(STUDIO_PRESETS[0].look)
    expect(s).toMatchObject({ track: 'bn', picked: true, digits: 'native' })
    const bad = readCaptionSettings({ ...base, studio: 'bold-pop', track: 'not a code', picked: 'yes', digits: 'roman' })!
    for (const k of ['studio', 'track', 'picked', 'digits']) expect(bad).not.toHaveProperty(k)
  })

  it("reads the 'quote' style, automatic origins and catalogue fonts on title cards", () => {
    const card = readTitleCard({ id: 't', start: 1, end: 4, title: 'Q', style: 'quote', background: 'blur', font: 'cat:instrument-serif-italic', auto: { by: 'quote', via: 'gemini', caption: 'c1' } } as never, 10)!
    expect(card).toMatchObject({ style: 'quote', font: 'cat:instrument-serif-italic', auto: { by: 'quote', via: 'gemini', caption: 'c1' } })
    const odd = readTitleCard({ id: 't', start: 1, end: 4, title: 'Q', style: 'lower-third', background: 'blur', font: 'cat:nope', auto: { by: 'magic', via: 'rules' } } as never, 10)!
    expect(odd).not.toHaveProperty('font')
    expect(odd).not.toHaveProperty('auto')
    expect(readTitleCard({ id: 't', start: 1, end: 4, title: 'Q', style: 'centered', background: 'blur', font: 'font-2', auto: { by: 'chapter', via: 'rules', chapter: 'ch1' } } as never, 10)).toMatchObject({ font: 'font-2', auto: { by: 'chapter', via: 'rules', chapter: 'ch1' } })
  })

  it('a project with every new field loads them through their readers, and saving and loading again changes nothing', () => {
    const raw = {
      id: 'p',
      version: 2,
      duration: 10,
      clips: [{ id: 'c', start: 0, end: 10, speed: 1 }],
      transcript,
      captions: { show: true, preset: 'bold', studio: STUDIO_PRESETS.find((p) => p.id === 'bold-pop')!.look, picked: true },
      captionMarks: [{ id: 'm1', caption: 'c1', from: 1, to: 1, text: 'every' }, { id: 'm2', caption: 'gone', from: 0, to: 0, text: 'x' }],
      captionPlaces: [{ caption: 'c2', position: 'top' }],
      graphics: [{ id: 'g1', kind: 'counter', start: 3.5, end: 6, from: 0, to: 300, decimals: 0, prefix: '', suffix: '%', locale: 'en', countFor: 1.5, place: 'auto', size: 0.11, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 } }],
      captionTracks: [{ language: 'bn', by: 'gemini', model: 'g', createdAt: '', segments: [{ id: 'c1', text: 'প্রতিটি শব্দ', src: 'ab12' }] }],
      bleeps: [{ id: 'b1', start: 4, end: 4.3, word: 'Darn', sound: 'tone', auto: true }],
      captionAuto: { style: { was: null, by: 'great', name: 'Bold Pop' } }
    }
    const p = migrateProject(raw)
    expect(p.captionMarks).toEqual([{ id: 'm1', caption: 'c1', from: 1, to: 1, text: 'every' }])
    expect(p.captionPlaces).toEqual([{ caption: 'c2', position: 'top' }])
    expect(p.graphics).toHaveLength(1)
    expect(p.captionTracks![0].segments).toHaveLength(1)
    expect(p.bleeps![0].word).toBe('darn')
    expect(p.captionAuto).toEqual({ style: { was: null, by: 'great', name: 'Bold Pop' } })
    expect(migrateProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it('every reader reads absent input as undefined', () => {
    expect(readCaptionMarks(undefined, transcript)).toBeUndefined()
    expect(readCaptionPlaces(undefined, transcript)).toBeUndefined()
    expect(readGraphics(undefined, 10, transcript)).toBeUndefined()
    expect(readCaptionTracks(undefined, transcript)).toBeUndefined()
    expect(readBleeps(undefined, 10)).toBeUndefined()
    expect(readCaptionAuto(undefined, transcript)).toBeUndefined()
    // Empty lists too, so no empty key is ever written.
    expect(readCaptionMarks([], transcript)).toBeUndefined()
    expect(readCaptionPlaces([], transcript)).toBeUndefined()
    expect(readGraphics([], 10, transcript)).toBeUndefined()
    expect(readCaptionTracks([], transcript)).toBeUndefined()
    expect(readBleeps([], 10)).toBeUndefined()
    expect(readCaptionAuto({}, transcript)).toBeUndefined()
    // Records that point at captions need a transcript.
    expect(readCaptionMarks([{ id: 'm', caption: 'c1', from: 0, to: 0, text: 'Make' }], undefined)).toBeUndefined()
  })
})

describe('readCaptionMarks and checkAnchor (test 5, rule 3)', () => {
  const mark = (over: Partial<CaptionMark>): CaptionMark => ({ id: 'm', caption: 'c1', from: 1, to: 1, text: 'every', ...over })

  it('drops marks on unknown captions, with from > to or negative indexes; cuts the text; keeps tone 2 only', () => {
    const out = readCaptionMarks(
      [
        mark({ id: 'a' }),
        mark({ id: 'b', caption: 'nope' }),
        mark({ id: 'c', from: 3, to: 2 }),
        mark({ id: 'd', from: -1, to: 0 }),
        { ...mark({ id: 'e', caption: 'c2', from: 0, to: 0, text: 'Sales' }), tone: 3 },
        { ...mark({ id: 'f', caption: 'c2', from: 2, to: 3, text: '300 percent' }), tone: 2, auto: true },
        null,
        'mark'
      ],
      transcript
    )!
    expect(out.map((m) => m.id)).toEqual(['a', 'e', 'f'])
    expect(out[1]).not.toHaveProperty('tone')
    expect(out[2]).toMatchObject({ tone: 2, auto: true })
  })

  it('gives repeated or missing ids new unique ones', () => {
    const out = readCaptionMarks([mark({ id: 'x' }), mark({ id: 'x', from: 3, to: 3, text: 'count' }), mark({ id: '', from: 4, to: 4, text: 'today' })], transcript)!
    expect(new Set(out.map((m) => m.id)).size).toBe(3)
    expect(out[0].id).toBe('x')
  })

  it('merges overlapping marks of one caption, keeping the first one’s id and tone', () => {
    const out = readCaptionMarks([mark({ id: 'a', from: 1, to: 2, text: 'every word', tone: 2 }), mark({ id: 'b', from: 2, to: 3, text: 'word count' }), mark({ id: 'c', from: 4, to: 4, text: 'today' })], transcript)!
    expect(out).toEqual([
      { id: 'a', caption: 'c1', from: 1, to: 3, text: 'every word count', tone: 2 },
      { id: 'c', caption: 'c1', from: 4, to: 4, text: 'today' }
    ])
  })

  it('finds a mark again by its text when its indexes point at other words (an ICU change), nearest first; else drops it', () => {
    const moved = checkAnchor(mark({ from: 3, to: 3, text: 'Every' }), transcript)
    expect(moved).toMatchObject({ from: 1, to: 1 })
    // Punctuation and case do not matter when comparing.
    expect(checkAnchor(mark({ caption: 'c2', from: 0, to: 1, text: 'auto save' }), transcript)).toMatchObject({ from: 8, to: 9 })
    expect(checkAnchor(mark({ text: 'tomorrow' }), transcript)).toBeNull()
    expect(checkAnchor(mark({ caption: 'gone' }), transcript)).toBeNull()
    const same = mark({})
    expect(checkAnchor(same, transcript)).toBe(same)
    // Chinese words come from the Segmenter: a mark on 学习 is found wherever the split puts it.
    const words = studioWordTexts(zh.segments[2].text, 'zh')
    const i = words.indexOf('学习')
    expect(i).toBeGreaterThan(0)
    expect(checkAnchor({ caption: 'c3', from: 0, to: 0, text: '学习' }, zh)).toEqual({ caption: 'c3', from: i, to: i, text: '学习' })
    expect(readCaptionMarks([mark({ from: 0, to: 0, text: 'tomorrow' })], transcript)).toBeUndefined()
  })

  it('finds words past punctuation, and a text of punctuation only among words of punctuation', () => {
    const t: Transcript = { ...transcript, segments: [{ id: 'p', start: 0, end: 3, text: 'Wait — what ?! okay … then' }] }
    expect(studioWordTexts(t.segments[0].text, 'en')).toEqual(['Wait', '—', 'what', '?!', 'okay', '…', 'then'])
    const at = (from: number, text: string): unknown => checkAnchor({ caption: 'p', from, to: from, text }, t)
    // A dash before the words compares as nothing, so the nearest start may be the dash.
    expect(at(0, 'what')).toMatchObject({ from: 1, to: 2 })
    expect(at(4, 'What okay')).toMatchObject({ from: 2, to: 4 })
    expect(at(0, '?!')).toMatchObject({ from: 3, to: 3 })
    expect(at(6, '…')).toMatchObject({ from: 5, to: 5 })
    expect(at(0, '!?')).toBeNull()
    expect(at(0, '!')).toBeNull()
  })

  it('looks again for marks that no longer match without freezing the load (a file with thousands of them)', () => {
    // 249 one-letter words, marks of 80 characters that are not there: each start word is tried once.
    const segments = [
      { id: 'a', start: 0, end: 9, text: Array.from({ length: 249 }, (_, i) => 'abcdefghijklmnopqrstuvwxy'[i % 25]).join(' ') },
      { id: 'z', start: 9, end: 18, text: Array.from({ length: 249 }, () => 'z').join(' ') }
    ]
    const t: Transcript = { ...transcript, segments }
    const raw = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, caption: i % 2 ? 'a' : 'z', from: 0, to: 0, text: i % 2 ? 'z'.repeat(80) : `${'z'.repeat(78)}y` }))
    const t0 = performance.now()
    expect(readCaptionMarks(raw, t)).toBeUndefined()
    // About 13 s before; a few milliseconds now. The margin keeps a slow machine passing.
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it('keeps at most MAX_MARKS', () => {
    const segments = Array.from({ length: 4100 }, (_, i) => ({ id: `s${i}`, start: i, end: i + 0.9, text: 'one two three four five' }))
    const t: Transcript = { ...transcript, segments }
    const raw = segments.flatMap((s) => [0, 1, 2, 3, 4].map((w) => ({ id: `${s.id}-${w}`, caption: s.id, from: w, to: w, text: ['one', 'two', 'three', 'four', 'five'][w] })))
    expect(raw.length).toBeGreaterThan(MAX_MARKS)
    expect(readCaptionMarks(raw, t)).toHaveLength(MAX_MARKS)
  })

  it('reads its own output unchanged', () => {
    const once = readCaptionMarks([mark({ id: 'a', from: 1, to: 2, text: 'every word' }), mark({ id: 'a', from: 2, to: 4, text: 'word count today', auto: true }), mark({ caption: 'c2', from: 7, to: 9, text: 'to Auto Save' })], transcript)
    expect(readCaptionMarks(JSON.parse(JSON.stringify(once)), transcript)).toEqual(once)
  })
})

describe('readCaptionPlaces (rule 4)', () => {
  it('keeps existing captions, top or bottom, one per caption, in caption order', () => {
    const out = readCaptionPlaces(
      [
        { caption: 'c2', position: 'top' },
        { caption: 'c1', position: 'bottom' },
        { caption: 'c2', position: 'bottom' },
        { caption: 'nope', position: 'top' },
        { caption: 'c3', position: 'middle' }
      ],
      transcript
    )
    expect(out).toEqual([
      { caption: 'c1', position: 'bottom' },
      { caption: 'c2', position: 'top' }
    ])
    expect(readCaptionPlaces(JSON.parse(JSON.stringify(out)), transcript)).toEqual(out)
  })
})

describe('readGraphics (rule 5)', () => {
  const motion = { kind: 'pop', duration: 0.24, strength: 1 }
  const g = (over: Record<string, unknown>): Record<string, unknown> => ({ id: 'g', kind: 'keyword', start: 1, end: 2, place: 'auto', size: 0.09, enter: motion, exit: motion, text: 'Export', look: 'card', ...over })

  it('drops graphics outside the recording, of unknown kinds, with empty text, malformed emoji, non-finite counters or no list items', () => {
    const out = readGraphics(
      [
        g({ id: 'ok' }),
        g({ id: 'late', start: 9.98, end: 12 }),
        g({ id: 'kind', kind: 'sparkle' }),
        g({ id: 'empty', text: '  \n ' }),
        g({ id: 'bad-emoji', kind: 'emoji', emoji: '1f525-zz' }),
        g({ id: 'surrogate', kind: 'emoji', emoji: 'd83d' }),
        g({ id: 'nan', kind: 'counter', from: 0, to: Number.NaN }),
        g({ id: 'nolist', kind: 'list', items: [{ text: ' ', at: 1 }] }),
        g({ id: 'unlisted', kind: 'emoji', emoji: '10FFFD-FE0F' })
      ],
      10,
      transcript
    )!
    expect(out.map((x) => x.id)).toEqual(['ok', 'unlisted'])
    // A well-formed emoji is kept (lower case, without FE0F) even when this build does not list it.
    expect(out[1]).toMatchObject({ kind: 'emoji', emoji: '10fffd' })
    expect(emojiKeyOf('1F468-200D-1F4BB')).toBe('1f468-200d-1f4bb')
    expect(emojiKeyOf(['1f525'])).toBeNull()
    expect(emojiKeyOf('110000')).toBeNull()
    expect(emojiKeyOf(Array(11).fill('1f525').join('-'))).toBeNull()
  })

  it('cleans and cuts texts, clamps sizes and times, reads motions and keeps valid fields only', () => {
    const [kw, list, counter] = readGraphics(
      [
        g({ id: 'k', text: 'A\tvery\nlong keyword that goes on and on past forty characters', size: 9, color: '#FFE14D', accent: 'red', font: 'cat:nope', sound: 'boom', lang: 'bn', enter: { kind: 'spin', duration: 9, strength: -1 }, place: { x: 2, y: 0.5 } }),
        g({ id: 'l', kind: 'list', start: 2, end: 8, title: 'Three steps', marker: 'tick', items: [{ text: 'Save', at: 7 }, { text: 'Open settings and then everything else that is far too long for an item', at: 1 }, ...Array(9).fill({ text: 'x', at: 5 })] }),
        g({ id: 'c', kind: 'counter', start: 3, end: 6, from: 0, to: 1e20, decimals: 5, prefix: '$$$$$$$$$$$$$$$$', suffix: '%', locale: '!!', countFor: 99, font: 'cat:anton' })
      ],
      10,
      transcript
    ) as [Graphic & { kind: 'keyword' }, Graphic & { kind: 'list' }, Graphic & { kind: 'counter' }]
    expect(kw.text).toBe('A very long keyword that goes on and on')
    expect(kw.size).toBe(0.3)
    expect(kw.color).toBe('#ffe14d')
    expect(kw).not.toHaveProperty('accent')
    expect(kw).not.toHaveProperty('font')
    expect(kw).not.toHaveProperty('sound')
    expect(kw.lang).toBe('bn')
    expect(kw.enter).toEqual({ kind: 'pop', duration: 1.5, strength: 0 })
    expect(kw.place).toEqual({ x: 1, y: 0.5 })
    expect(list.marker).toBe('number')
    expect(list.items).toHaveLength(7)
    expect(list.items[0]).toEqual({ text: 'Open settings and then everything else that is far too long', at: 2 })
    expect(counter).toMatchObject({ to: 1e12, decimals: 0, prefix: '$$$$$$$$$$$$', locale: 'en', countFor: 5, font: 'cat:anton' })
    expect(readItemMotion(null, { kind: 'fade', duration: 0.2, strength: 1 })).toEqual({ kind: 'fade', duration: 0.2, strength: 1 })
  })

  it('checks anchors: a dropped anchor leaves the graphic free; an emoji anchor is one word', () => {
    const out = readGraphics(
      [
        g({ id: 'a', anchor: { caption: 'c2', from: 0, to: 0, text: 'Sales' } }),
        g({ id: 'b', anchor: { caption: 'c2', from: 0, to: 0, text: 'Profits' } }),
        g({ id: 'c', kind: 'emoji', emoji: '1f4c8', anchor: { caption: 'c2', from: 1, to: 1, text: 'grew' } }),
        g({ id: 'd', kind: 'emoji', emoji: '1f4c8', anchor: { caption: 'c2', from: 1, to: 2, text: 'grew 300' } }),
        g({ id: 'e', replace: false, anchor: { caption: 'c1', from: 3, to: 3, text: 'every' } })
      ],
      10,
      transcript
    )!
    expect(out.find((x) => x.id === 'a')).toMatchObject({ anchor: { caption: 'c2', from: 0, to: 0, text: 'Sales' } })
    expect(out.find((x) => x.id === 'b')).not.toHaveProperty('anchor')
    expect(out.find((x) => x.id === 'c')).toHaveProperty('anchor')
    expect(out.find((x) => x.id === 'd')).not.toHaveProperty('anchor')
    expect(out.find((x) => x.id === 'e')).toMatchObject({ replace: false, anchor: { from: 1, to: 1 } })
  })

  it('keeps unique ids, at most MAX_GRAPHICS, in time order, and reads its own output unchanged', () => {
    const raw = Array.from({ length: MAX_GRAPHICS + 20 }, (_, i) => g({ id: i % 3 ? `g${i}` : 'same', start: 9 - i * 0.01, end: 9.5 }))
    const out = readGraphics(raw, 10, transcript)!
    expect(out).toHaveLength(MAX_GRAPHICS)
    expect(new Set(out.map((x) => x.id)).size).toBe(MAX_GRAPHICS)
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start)
    expect(readGraphics(JSON.parse(JSON.stringify(out)), 10, transcript)).toEqual(out)
  })
})

describe('readCaptionTracks (rule 6)', () => {
  it('keeps valid, unique languages that are not the spoken one, with segments of existing captions', () => {
    const out = readCaptionTracks(
      [
        { language: 'bn', by: 'local', model: 'enbn', createdAt: '2026-10-31', segments: [{ id: 'c2', text: ' দ্বিতীয়\n', src: 'b' }, { id: 'c1', text: 'প্রথম', src: 'a' }, { id: 'c1', text: 'again', src: 'a' }, { id: 'nope', text: 'x', src: '' }, { id: 'c3', text: '   ', src: '' }] },
        { language: 'BN', by: 'gemini', model: '', createdAt: '', segments: [] },
        { language: 'en', by: 'gemini', model: '', createdAt: '', segments: [] },
        { language: 'not a code', by: 'gemini', model: '', createdAt: '', segments: [] },
        { language: 'es', by: 'someone', model: 'x', createdAt: '', segments: 'none' }
      ],
      transcript
    )!
    expect(out.map((t) => t.language)).toEqual(['bn', 'es'])
    expect(out[0].segments).toEqual([
      { id: 'c1', text: 'প্রথম', src: 'a' },
      { id: 'c2', text: 'দ্বিতীয়', src: 'b' }
    ])
    expect(out[1]).toEqual({ language: 'es', by: 'local', model: 'x', createdAt: '', segments: [] })
    expect(readCaptionTracks(JSON.parse(JSON.stringify(out)), transcript)).toEqual(out)
    const many = Array.from({ length: 12 }, (_, i) => ({ language: `x${String.fromCharCode(97 + i)}`, by: 'local', model: '', createdAt: '', segments: [] }))
    expect(readCaptionTracks(many, transcript)).toHaveLength(MAX_TRACKS)
  })
})

describe('readBleeps (rule 7)', () => {
  it('keeps bleeps of 0.02 s or more inside the recording, lower-cased, in time order', () => {
    const out = readBleeps(
      [
        { id: 'b', start: 5, end: 5.3, word: 'DARN IT', sound: 'silence' },
        { id: 'a', start: 1, end: 1.4, word: 'x'.repeat(60), sound: 'boing', auto: true },
        { id: 'c', start: 2, end: 2.01, word: 'short', sound: 'tone' },
        { id: 'd', start: 9.99, end: 12, word: 'late', sound: 'tone' }
      ],
      10
    )!
    expect(out.map((b) => b.id)).toEqual(['a', 'b'])
    expect(out[0]).toEqual({ id: 'a', start: 1, end: 1.4, word: 'x'.repeat(40), sound: 'tone', auto: true })
    expect(out[1].word).toBe('darn it')
    expect(readBleeps(JSON.parse(JSON.stringify(out)), 10)).toEqual(out)
    expect(readBleeps(Array.from({ length: MAX_BLEEPS + 5 }, (_, i) => ({ id: `b${i}`, start: i * 0.004, end: i * 0.004 + 0.03, word: 'w', sound: 'tone' })), 10)).toHaveLength(MAX_BLEEPS)
  })
})

describe('readCaptionAuto (rule 8)', () => {
  it('reads the look before (one level, its own look too) or null, and text records of existing captions', () => {
    const was = { show: true, preset: 'clean', studio: { ...STUDIO_PRESETS[0].look, text: { ...STUDIO_PRESETS[0].look.text, size: 9 } }, captionAuto: 'nested' }
    const out = readCaptionAuto(
      {
        style: { was, by: 'polish', name: 'Bold Pop' },
        text: [
          { caption: 'c1', text: 'make every word count today', words: [{ text: 'make', start: 0.5, end: 0.9 }] },
          { caption: 'c1', text: 'again' },
          { caption: 'gone', text: 'x' },
          { caption: 'c2', text: '' }
        ]
      },
      transcript
    )!
    expect(out.style!.by).toBe('polish')
    expect((out.style!.was as unknown as { studio: CaptionStudio }).studio.text.size).toBe(0.22)
    expect(out.style!.was).not.toHaveProperty('captionAuto')
    expect(out.text).toEqual([{ caption: 'c1', text: 'make every word count today', words: [{ text: 'make', start: 0.5, end: 0.9 }] }])
    expect(readCaptionAuto(JSON.parse(JSON.stringify(out)), transcript)).toEqual(out)
    expect(readCaptionAuto({ style: { was: null, by: 'great', name: 'x' } }, transcript)).toEqual({ style: { was: null, by: 'great', name: 'x' } })
    expect(readCaptionAuto({ style: { was: 7, by: 'great', name: 'x' } }, transcript)).toBeUndefined()
    expect(readCaptionAuto({ style: { was: null, by: 'robot', name: 'x' } }, transcript)).toBeUndefined()
  })
})

describe('long marks and anchors', () => {
  it('keeps a mark whose words are longer than its stored text (cut at 80 characters)', () => {
    const long = 'Open the advanced export settings panel and choose the hardware accelerated encoder option today'
    const t: Transcript = { ...transcript, segments: [{ id: 'l1', start: 0, end: 9, text: long }] }
    const words = long.split(' ')
    const out = readCaptionMarks([{ id: 'm', caption: 'l1', from: 0, to: words.length - 1, text: long }], t)!
    expect(out[0].text.length).toBeLessThanOrEqual(80)
    expect(out[0]).toMatchObject({ from: 0, to: words.length - 1 })
    expect(readCaptionMarks(JSON.parse(JSON.stringify(out)), t)).toEqual(out)
    // Its words moved by one (a word inserted before): found again from the cut text.
    const moved = { ...t, segments: [{ id: 'l1', start: 0, end: 9, text: `Now ${long}` }] }
    expect(readCaptionMarks(out, moved)).toEqual([{ ...out[0], from: 1, to: words.length }])
  })
})
