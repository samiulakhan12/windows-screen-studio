import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Annotation, Graphic, Project, Shape, Spotlight, TitleCard } from '../src/shared/types'
import { digest, rng, sceneFixtures } from './verticalFixtures'

/*
 * The contracts step of editing polish (docs/design/editing-polish.md §17.0, §19.1 tests 1 to 7):
 * old projects migrate byte for byte with no new key; the readers of the new fields (joins, colour,
 * the progress bar, sound effects, callouts, shapes, spotlights, title cards, a graphic's sound)
 * keep what is valid, clamp, and drop the rest; the strict .cube parser; the sound library's
 * catalogue and its committed files; and the stubs and seams, which change nothing for a project
 * from before (the frame's calls, settle, Review, fonts, assets, the export's sound, Polish's step,
 * the commands).
 */

/* ---------- canvases that record their calls (as tests/editingEquivalence.test.ts) ---------- */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  alpha: unknown
  fill: unknown
}
const calls: Call[] = []
let canvases = 0
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args, alpha: target.globalAlpha, fill: target.fillStyle })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  return c
}
vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

// prepareLuts is watched: a project without a LUT never asks for one (§17.0, test 7).
const lutLoads: unknown[] = []
vi.mock('../src/renderer/src/render/lutCache', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return { ...real, prepareLuts: async (p: unknown) => void lutLoads.push(p) }
})

// The progress bar's band (part P2's barBand) answered here, so textArea's seam is seen to apply it only with chapterBar.show.
let band: { edge: 'top' | 'bottom'; size: number } | null = null
vi.mock('../src/shared/render/chapterBar', async (orig) => ({ ...(await orig<Record<string, unknown>>()), barBand: () => band }))

const { migrateProject, createProject } = await import('../src/shared/engine/project')
const { readJoins, readCutJoin, MAX_CUT_STYLES } = await import('../src/shared/engine/joinData')
const { readColorGrade, readProjectGrade } = await import('../src/shared/render/gradeData')
const { readChapterBar } = await import('../src/shared/render/chapterBarData')
const { readSoundFx, readSfxRef, readGraphicSound } = await import('../src/shared/audio/soundFxData')
const { CALLOUT_ALLOWED, calloutOf, readCalloutMotion, isCallout } = await import('../src/shared/render/calloutData')
const { readShape, readSpotlight } = await import('../src/shared/engine/shapeData')
const { readTitleCard } = await import('../src/shared/engine/titleData')
const { readGraphics } = await import('../src/shared/captions/studioData')
const { parseCube, CubeError, CUBE_LIMITS } = await import('../src/shared/render/cubeLut')
const lib = await import('../src/shared/audio/soundLibrary')
const { settleJoins } = await import('../src/shared/editor/joinsEdit')
const { settleGrade } = await import('../src/shared/editor/colourEdit')
const { editingReviewItems, editingPendingCount } = await import('../src/shared/review/editingReview')
const { pendingCount, reviewItems } = await import('../src/shared/review/review')
const { editingFontIds, CALLOUT_FALLBACK_IDS } = await import('../src/shared/render/editingFonts')
const { planPolish, DEFAULT_POLISH_OPTIONS, POLISH_STEPS, readPolishOptions } = await import('../src/shared/editor/polish')
const { COMMANDS } = await import('../src/shared/editor/commands')
const { DEFAULT_KEYMAP, findConflicts } = await import('../src/shared/editor/shortcuts')
const { popJob } = await import('../src/shared/render/popSound')
const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { textArea, textAreaWithoutBar } = await import('../src/shared/render/safeZones')
const PACKAGING = '../scripts/lib/packaging.cjs'
const packaging = (await import(/* @vite-ignore */ PACKAGING)) as unknown as { SOUND_LIBRARY_BUDGET: { compressed: number; installed: number }; soundLibraryResource(): { from: string; to: string } }

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown, soundTime?: number, extras?: unknown) => void
const COMPOSITOR = '../src/renderer/src/render/compositor'
const ASSETS = '../src/renderer/src/editor/editingAssets'
const { drawFrame, drawFramePicture, drawFrameOverlays } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  drawFrame: DrawFrame
  drawFramePicture: (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown, soundTime?: number) => unknown
  drawFrameOverlays: (top: unknown, soundTime: number, video: number) => void
}
const { prepareEditingAssets, needsEditingAssets } = (await import(/* @vite-ignore */ ASSETS)) as { prepareEditingAssets(p: Project): Promise<void>; needsEditingAssets(p: Project): boolean }

const ROOT = path.join(__dirname, '..')
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

interface OldFixture {
  name: string
  raw: Record<string, unknown>
  migrated?: unknown
}
const load = (file: string): OldFixture[] => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))

/** Keys editing polish adds; an old project never gets one by loading (§4.4). */
const NEW_PROJECT_KEYS = ['joins', 'grade', 'chapterBar', 'soundFx']

function noNewKeys(p: Project): void {
  for (const k of NEW_PROJECT_KEYS) expect(p, k).not.toHaveProperty(k)
  for (const s of p.shapes ?? []) for (const k of ['enter', 'exit', 'sound']) expect(s, k).not.toHaveProperty(k)
  for (const s of p.spotlights ?? []) expect(s).not.toHaveProperty('magnify')
  for (const t of p.titles ?? []) for (const k of ['enter', 'exit', 'sound']) expect(t, k).not.toHaveProperty(k)
  for (const k of ['calm', 'badgesByChapter']) expect(p.effects, k).not.toHaveProperty(k)
  expect(p.audio.music ?? {}).not.toHaveProperty('library')
}

/** A project with Captions Studio's and wave 8's fields, as it would be saved (§19.1 test 1). */
function studioProject(): Project {
  const p = createProject({
    id: 'w10c',
    name: 'Studio',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [{ id: 'z1', start: 1, end: 4, scale: 2, focus: { mode: 'cursor' }, auto: true }],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  const graphic: Graphic = {
    id: 'g1',
    kind: 'keyword',
    start: 2,
    end: 4,
    place: 'auto',
    size: 0.06,
    enter: { kind: 'pop', duration: 0.3, strength: 1 },
    exit: { kind: 'fade', duration: 0.2, strength: 1 },
    sound: 'ding',
    text: 'Save',
    look: 'card',
    auto: { by: 'keyword', via: 'rules' }
  }
  return {
    ...p,
    clips: [
      { id: 'a', start: 0, end: 8, speed: 1 },
      { id: 'b', start: 9, end: 20, speed: 1.5 }
    ],
    freezes: [{ id: 'f1', at: 5, length: 1, sound: 'pause' }],
    shapes: [{ id: 's1', start: 1, end: 3, kind: 'arrow', x: 0.1, y: 0.1, w: 0.2, h: 0.2, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }],
    spotlights: [{ id: 'p1', start: 1, end: 3, mode: 'region', x: 0.2, y: 0.2, w: 0.3, h: 0.3, shape: 'ellipse', dim: 0.6, feather: 0.4 }],
    titles: [{ id: 't1', start: 0, end: 2, title: 'Hello', style: 'centered', background: 'blur' }],
    chapters: [
      { id: 'c1', t: 0, title: 'Start' },
      { id: 'c2', t: 10, title: 'End' }
    ],
    transcript: { language: 'en', provider: 'local', model: 'speech-small', createdAt: '2026-11-01T09:00:00.000Z', segments: [{ id: 'k1', start: 1, end: 3, text: 'Click the Save button' }] },
    graphics: [graphic],
    bleeps: [{ id: 'b1', start: 2, end: 2.3, word: 'damn', sound: 'tone' }],
    autoCuts: [],
    publish: { description: 'A tour' } as Project['publish'],
    sounds: { spans: [{ start: 1, end: 1.4, action: 'mute', kind: 'cough' }], ignored: [] } as unknown as Project['sounds']
  } as Project
}

/* ---------- test 1 ---------- */

describe('old projects migrate byte for byte, with no new key (test 1)', () => {
  for (const f of load('vertical-old-projects.json')) {
    it(`vertical ${f.name}: the same JSON as before following existed`, () => {
      const p = migrateProject(structuredClone(f.raw))
      noNewKeys(p)
      // A file without clips gets one with a new id (as tests/verticalEquivalence.test.ts reads it).
      if (!Array.isArray(f.raw.clips)) p.clips = [{ ...p.clips[0], id: '(generated)' }]
      expect(JSON.stringify(p)).toBe(JSON.stringify(f.migrated))
    })
  }

  // The digests captionsStudioEquivalence pins for these fixtures (taken before Captions Studio and wave 10).
  const PINNED: Record<string, string> = {
    'publish-pack': '0734ea033ee5306563158006e66c1b97',
    'review-mode': 'ee713de7cd94ad7e484552efd63474ea',
    'sound-finder': '225c27befc771ad0ddac4c8abc6fded9',
    'nw09-speakers': 'c916adb2a35c7a9f2232a4ebca799caf',
    'tall-karaoke': 'ca521dc07dd91400f2b8b8157436ff8a',
    'caption-data': 'bb317e748ce8c53c8f0c0e8bb23ec7a5',
    'default-look': '3f1ba14773b81d08932983cfd1f63bda',
    'minimal-hidden': 'fcccf73646eb246353c0f0ff7c6020cc'
  }
  for (const f of [...load('wave8-old-projects.json'), ...load('captions-old-projects.json')]) {
    it(`${f.name}: the same JSON, and a load of its save gives it back`, () => {
      const p = migrateProject(structuredClone(f.raw))
      if (f.name !== 'caption-data') noNewKeys(p)
      expect(digest(JSON.stringify(p))).toBe(PINNED[f.name])
      // Saved and opened again: the same project (a partial hand-edited file may list its keys in another order).
      expect(migrateProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    })
  }

  it('a Captions Studio project with every wave-8 field: no new key, and its save loads to the same bytes', () => {
    const p = migrateProject(JSON.parse(JSON.stringify(studioProject())))
    noNewKeys(p)
    const saved = JSON.stringify(p)
    expect(JSON.stringify(migrateProject(JSON.parse(saved)))).toBe(saved)
  })

  it('a project with every new field saved by this version loads to the same bytes', () => {
    const base = migrateProject(JSON.parse(JSON.stringify(studioProject())))
    const withNew = {
      ...base,
      shapes: base.shapes!.map((s) => ({ ...s, enter: { kind: 'draw', duration: 0.35, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, sound: 'sfx:pop' })),
      spotlights: base.spotlights!.map((s) => ({ ...s, magnify: 2 })),
      titles: base.titles!.map((t) => ({ ...t, enter: { kind: 'rise', duration: 0.35, strength: 1 }, exit: { kind: 'fade', duration: 0.35, strength: 1 }, sound: 'none' })),
      effects: { ...base.effects, calm: true, badgesByChapter: false },
      joins: { all: { kind: 'smooth', duration: 0.15, scale: 1.1 }, cuts: [{ clip: 'b', kind: 'dip', duration: 0.5, color: '#000000' }], auto: { by: 'polish', was: null } },
      grade: { screen: { look: 'vivid', contrast: 0 }, camera: { temperature: 0.2, exposure: 0.5 }, auto: { camera: null } },
      chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' },
      soundFx: { zoomIn: 'sfx:whoosh-soft', volume: 0.35 }
    }
    const saved = JSON.stringify(migrateProject(JSON.parse(JSON.stringify(withNew))))
    expect(saved).toBe(JSON.stringify(migrateProject(JSON.parse(saved))))
    const again = JSON.parse(saved) as Project
    expect(again.joins).toEqual(withNew.joins)
    expect(again.grade).toEqual(withNew.grade)
    expect(again.chapterBar).toEqual(withNew.chapterBar)
    expect(again.soundFx).toEqual(withNew.soundFx)
    expect(again.spotlights![0].magnify).toBe(2)
    expect(again.shapes![0]).toMatchObject({ enter: { kind: 'draw' }, sound: 'sfx:pop' })
    expect(again.titles![0]).toMatchObject({ enter: { kind: 'rise' }, sound: 'none' })
  })

  it('damaged new fields are dropped on load, never stored as empty objects', () => {
    const raw = { ...structuredClone(load('wave8-old-projects.json')[0].raw), joins: { all: { kind: 'nope' } }, grade: 'warm', chapterBar: { show: 'yes' }, soundFx: { zoomIn: 'sfx:nope' } }
    noNewKeys(migrateProject(raw))
  })

  it('every new reader returns undefined for absent input and is idempotent', () => {
    for (const read of [readJoins, (x: unknown) => readColorGrade(x, 'camera'), (x: unknown) => readColorGrade(x, 'screen'), readProjectGrade, readChapterBar, readSoundFx, readSfxRef])
      for (const absent of [undefined, null]) expect(read(absent)).toBeUndefined()
    // Valid, partly valid and damaged values: reading twice gives what reading once gives.
    const r = rng(1001)
    const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)]
    const junk = (): unknown => pick([undefined, null, 1, -3, 1e9, NaN, 'x', '#ABCDEF', '#abc', true, {}, [], 0.5, 'sfx:pop', 'sfx:nope', 'lut-1.cube', 'a'.repeat(70)])
    for (let i = 0; i < 300; i++) {
      const join = () => ({ kind: pick(['cut', 'smooth', 'crossfade', 'dip', 'slide', 'punch', 'wipe']), duration: junk(), color: junk(), from: pick(['left', 'up', 'right']), scale: junk() })
      const joins = { all: join(), cuts: [join(), { ...join(), clip: pick(['a', 'b', '', 'a']) }, { ...join(), clip: 'b' }], auto: { by: pick(['polish', 'great']), was: pick([null, join(), 3]) } }
      expect(readJoins(readJoins(joins))).toEqual(readJoins(joins))
      const grade = () => ({
        temperature: junk(),
        tint: junk(),
        contrast: junk(),
        exposure: junk(),
        look: pick(['warm', 'vivid', 'mono', 'film']),
        lookStrength: junk(),
        lut: { file: pick(['lut-1.cube', 'lut-0.cube']), sha256: 'a'.repeat(64), size: pick([17, 66, 1.5]), title: pick(['A‮B', 3]) }
      })
      const g = { screen: grade(), camera: grade(), auto: { camera: pick([null, grade(), 'x']) } }
      expect(readProjectGrade(readProjectGrade(g))).toEqual(readProjectGrade(g))
      const bar = { show: pick([true, false, 'yes']), place: junk(), style: junk(), labels: pick(['all', 'none', 'some']), color: junk(), onlyAtChapters: junk() }
      expect(readChapterBar(readChapterBar(bar))).toEqual(readChapterBar(bar))
      const fx = { zoomIn: junk(), zoomOut: 'sfx:whoosh-out', titles: junk(), callouts: junk(), volume: junk() }
      expect(readSoundFx(readSoundFx(fx))).toEqual(readSoundFx(fx))
    }
  })
})

/* ---------- test 2 ---------- */

describe('readJoins and readCutJoin (test 2)', () => {
  it('drops an unknown kind and keeps only the fields of the kind', () => {
    expect(readCutJoin({ kind: 'wipe' })).toBeNull()
    expect(readCutJoin('dip')).toBeNull()
    expect(readCutJoin({ kind: 'smooth', duration: 0.2, scale: 1.15, color: '#000000', from: 'left' })).toEqual({ kind: 'smooth', duration: 0.2, scale: 1.15 })
    expect(readCutJoin({ kind: 'crossfade', duration: 0.2, scale: 1.1, color: '#000000' })).toEqual({ kind: 'crossfade', duration: 0.2 })
    expect(readCutJoin({ kind: 'slide', from: 'top', color: '#ffffff' })).toEqual({ kind: 'slide', from: 'top' })
    expect(readCutJoin({ kind: 'slide', from: 'up' })).toEqual({ kind: 'slide' })
    expect(readCutJoin({ kind: 'punch', scale: 1.1, duration: 0.3 })).toEqual({ kind: 'punch', scale: 1.1 })
    expect(readCutJoin({ kind: 'cut', duration: 1, scale: 1.1 })).toEqual({ kind: 'cut' })
  })

  it("clamps durations to the kind's range, drops non-finite ones, and lower-cases a colour", () => {
    expect(readCutJoin({ kind: 'crossfade', duration: 2 })).toEqual({ kind: 'crossfade', duration: 0.5 })
    expect(readCutJoin({ kind: 'crossfade', duration: 0.01 })).toEqual({ kind: 'crossfade', duration: 0.05 })
    expect(readCutJoin({ kind: 'dip', duration: 0.1 })).toEqual({ kind: 'dip', duration: 0.2 })
    expect(readCutJoin({ kind: 'dip', duration: 5 })).toEqual({ kind: 'dip', duration: 1.2 })
    expect(readCutJoin({ kind: 'slide', duration: 0.1 })).toEqual({ kind: 'slide', duration: 0.25 })
    expect(readCutJoin({ kind: 'slide', duration: 1 })).toEqual({ kind: 'slide', duration: 0.7 })
    expect(readCutJoin({ kind: 'smooth', duration: 3, scale: 2 })).toEqual({ kind: 'smooth', duration: 0.5, scale: 1.2 })
    expect(readCutJoin({ kind: 'punch', scale: 1 })).toEqual({ kind: 'punch', scale: 1.05 })
    expect(readCutJoin({ kind: 'crossfade', duration: NaN })).toEqual({ kind: 'crossfade' })
    expect(readCutJoin({ kind: 'crossfade', duration: Infinity })).toEqual({ kind: 'crossfade' })
    expect(readCutJoin({ kind: 'dip', color: '#0060DF' })).toEqual({ kind: 'dip', color: '#0060df' })
    expect(readCutJoin({ kind: 'dip', color: 'red' })).toEqual({ kind: 'dip' })
  })

  it('keeps the first of a repeated clip, at most 20,000 styles, and reads an empty object as undefined', () => {
    const joins = readJoins({
      cuts: [
        { clip: 'b', kind: 'dip' },
        { clip: 'b', kind: 'slide' },
        { clip: '', kind: 'dip' },
        { clip: 'x'.repeat(65), kind: 'dip' },
        { clip: 'c', kind: 'nope' },
        { clip: 'c', kind: 'punch' }
      ]
    })
    expect(joins).toEqual({
      cuts: [
        { clip: 'b', kind: 'dip' },
        { clip: 'c', kind: 'punch' }
      ]
    })
    expect(readJoins({})).toBeUndefined()
    expect(readJoins({ all: { kind: 'nope' }, cuts: [] })).toBeUndefined()
    expect(readJoins([])).toBeUndefined()
    const many = Array.from({ length: MAX_CUT_STYLES + 1 }, (_, i) => ({ clip: `c${i}`, kind: 'crossfade' }))
    expect(MAX_CUT_STYLES).toBe(20000)
    expect(readJoins({ cuts: many })!.cuts).toHaveLength(20000)
  })

  it('keeps Polish\'s record only with by "polish" and a readable `was` (or null)', () => {
    expect(readJoins({ all: { kind: 'smooth' }, auto: { by: 'polish', was: null } })).toEqual({ all: { kind: 'smooth' }, auto: { by: 'polish', was: null } })
    expect(readJoins({ all: { kind: 'smooth' }, auto: { by: 'polish', was: { kind: 'cut' } } })!.auto).toEqual({ by: 'polish', was: { kind: 'cut' } })
    expect(readJoins({ all: { kind: 'smooth' }, auto: { by: 'polish', was: { kind: 'nope' } } })).toEqual({ all: { kind: 'smooth' } })
    expect(readJoins({ all: { kind: 'smooth' }, auto: { by: 'polish' } })).toEqual({ all: { kind: 'smooth' } })
    expect(readJoins({ all: { kind: 'smooth' }, auto: { by: 'great', was: null } })).toEqual({ all: { kind: 'smooth' } })
  })
})

/* ---------- test 3 ---------- */

describe('readColorGrade and readProjectGrade (test 3)', () => {
  const lut = { file: 'lut-3.cube', sha256: 'ab'.repeat(32), title: 'Teal', size: 33 }

  it('clamps, drops non-finite values and keeps 0 as written', () => {
    expect(readColorGrade({ temperature: 3, tint: -3, brightness: NaN, contrast: 0, saturation: 'x', vibrance: Infinity }, 'camera')).toEqual({ temperature: 1, tint: -1, contrast: 0 })
    expect(readColorGrade({ exposure: 5 }, 'camera')).toEqual({ exposure: 2 })
    expect(readColorGrade({ exposure: -5 }, 'camera')).toEqual({ exposure: -2 })
    expect(readColorGrade({ lookStrength: 2, look: 'mono' }, 'camera')).toEqual({ lookStrength: 1, look: 'mono' })
    expect(readColorGrade({ shadows: 0, highlights: -0.5 }, 'screen')).toEqual({ shadows: 0, highlights: -0.5 })
    expect(readColorGrade({}, 'camera')).toBeUndefined()
  })

  it('drops an unknown look, and on the screen every look but Natural, Vivid and Mono', () => {
    expect(readColorGrade({ look: 'film', contrast: 0.1 }, 'camera')).toEqual({ contrast: 0.1 })
    expect(readColorGrade({ look: 'warm' }, 'camera')).toEqual({ look: 'warm' })
    expect(readColorGrade({ look: 'warm' }, 'screen')).toBeUndefined()
    for (const look of ['natural', 'vivid', 'mono']) expect(readColorGrade({ look }, 'screen')).toEqual({ look })
    for (const look of ['cool', 'soft', 'cinematic', 'vintage']) expect(readColorGrade({ look }, 'screen')).toBeUndefined()
  })

  it('drops exposure on the screen', () => {
    expect(readColorGrade({ exposure: 1, contrast: 0.2 }, 'screen')).toEqual({ contrast: 0.2 })
  })

  it('drops a LUT with a bad file name, hash, size or title, and cleans a title', () => {
    expect(readColorGrade({ lut }, 'camera')).toEqual({ lut })
    expect(readColorGrade({ lut: { ...lut, strength: 3 } }, 'camera')).toEqual({ lut: { ...lut, strength: 1 } })
    for (const bad of [
      { file: 'lut-0.cube' },
      { file: '../lut-1.cube' },
      { file: 'lut-1.CUBE' },
      { sha256: 'AB'.repeat(32) },
      { sha256: 'ab' },
      { size: 66 },
      { size: 1 },
      { size: 17.5 },
      { title: 4 }
    ])
      expect(readColorGrade({ lut: { ...lut, ...bad } }, 'camera'), JSON.stringify(bad)).toBeUndefined()
    const title = `A‮B\u0000C${'x'.repeat(100)}`
    const read = readColorGrade({ lut: { ...lut, title } }, 'screen')!
    expect(read.lut!.title).toBe(`ABC${'x'.repeat(77)}`)
    expect(read.lut!.title).toHaveLength(80)
    expect(read.lut!.title).not.toMatch(/[‮\u0000]/)
  })

  it("keeps Auto colour's record only as a readable camera grade or null", () => {
    expect(readProjectGrade({ camera: { temperature: 0.2 }, auto: { camera: null } })).toEqual({ camera: { temperature: 0.2 }, auto: { camera: null } })
    expect(readProjectGrade({ camera: { temperature: 0.2 }, auto: { camera: { tint: 0.1 } } })!.auto).toEqual({ camera: { tint: 0.1 } })
    expect(readProjectGrade({ camera: { temperature: 0.2 }, auto: { camera: 'x' } })).toEqual({ camera: { temperature: 0.2 } })
    expect(readProjectGrade({ camera: { temperature: 0.2 }, auto: {} })).toEqual({ camera: { temperature: 0.2 } })
    expect(readProjectGrade({ screen: { look: 'warm' }, camera: {} })).toBeUndefined()
  })
})

/* ---------- test 4 ---------- */

describe('the other readers (test 4)', () => {
  it('readChapterBar: show must be a boolean; unknown values read as the defaults', () => {
    expect(readChapterBar({ place: 'top' })).toBeUndefined()
    expect(readChapterBar({ show: 'yes' })).toBeUndefined()
    expect(readChapterBar({ show: true })).toEqual({ show: true, place: 'auto', style: 'float', labels: 'current' })
    expect(readChapterBar({ show: false, place: 'left', style: 'round', labels: 'some', color: 'red', onlyAtChapters: 1 })).toEqual({ show: false, place: 'auto', style: 'float', labels: 'current' })
    expect(readChapterBar({ show: true, place: 'bottom', style: 'edge', labels: 'all', color: '#ff0000', onlyAtChapters: true })).toEqual({
      show: true,
      place: 'bottom',
      style: 'edge',
      labels: 'all',
      color: '#ff0000',
      onlyAtChapters: true
    })
  })

  it("readSfxRef and readSoundFx: only the library's effects; the volume clamped", () => {
    expect(readSfxRef('sfx:pop-soft')).toBe('sfx:pop-soft')
    for (const bad of ['sfx:nope', 'pop', 'sfx:', 'sfx:../x', 3, null]) expect(readSfxRef(bad), String(bad)).toBeUndefined()
    expect(readSoundFx({ zoomIn: 'sfx:whoosh-soft', zoomOut: 'sfx:nope', titles: 'bell', volume: 3 })).toEqual({ zoomIn: 'sfx:whoosh-soft', volume: 1 })
    expect(readSoundFx({ volume: -1 })).toEqual({ volume: 0 })
    expect(readSoundFx({ zoomIn: 'sfx:nope' })).toBeUndefined()
  })

  it("readCalloutMotion: 'blur' never; 'draw' only on enter for arrows, lines and boxes; 'wipe' only on enter", () => {
    const m = (kind: string) => ({ kind, duration: 0.3, strength: 1 })
    for (const item of Object.keys(CALLOUT_ALLOWED) as (keyof typeof CALLOUT_ALLOWED)[]) {
      const { enter, exit } = CALLOUT_ALLOWED[item]
      expect(readCalloutMotion(m('blur'), enter), item).toBeUndefined()
      expect(readCalloutMotion(m('blur'), exit), item).toBeUndefined()
      expect(exit).not.toContain('draw')
      expect(exit).not.toContain('wipe')
      expect(enter.includes('draw'), item).toBe(item === 'arrow' || item === 'box')
    }
    expect(readCalloutMotion(m('draw'), CALLOUT_ALLOWED.arrow.enter)).toEqual(m('draw'))
    expect(readCalloutMotion(m('draw'), CALLOUT_ALLOWED.arrow.exit)).toBeUndefined()
    expect(readCalloutMotion(m('draw'), CALLOUT_ALLOWED.text.enter)).toBeUndefined()
    expect(readCalloutMotion(m('wipe'), CALLOUT_ALLOWED.highlight.enter)).toEqual(m('wipe'))
    expect(readCalloutMotion(m('wipe'), CALLOUT_ALLOWED.highlight.exit)).toBeUndefined()
    expect(readCalloutMotion({ kind: 'pop', duration: 9, strength: -1 }, CALLOUT_ALLOWED.badge.enter)).toEqual({ kind: 'pop', duration: 1.5, strength: 0 })
    expect(readCalloutMotion({ kind: 'pop', duration: 0, strength: 2 }, CALLOUT_ALLOWED.badge.enter)).toEqual({ kind: 'pop', duration: 0.1, strength: 1 })
    expect(readCalloutMotion({ kind: 'pop', duration: NaN, strength: 1 }, CALLOUT_ALLOWED.badge.enter)).toBeUndefined()
    // Never blur, whatever list a caller passes (blur on the frame canvas is banned for its cost).
    expect(readCalloutMotion(m('blur'), ['blur', 'fade'])).toBeUndefined()
  })

  const shape = (kind: Shape['kind'], extra: Record<string, unknown> = {}): Partial<Shape> =>
    ({ id: 's', start: 1, end: 3, kind, x: 0.1, y: 0.1, w: 0.2, h: 0.2, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5, ...extra }) as Partial<Shape>

  it('readShape: motions and sounds kept on marks, dropped on blur and pixelate', () => {
    const motion = { enter: { kind: 'draw', duration: 0.35, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, sound: 'sfx:pop' }
    expect(readShape(shape('arrow', motion))).toMatchObject(motion)
    expect(readShape(shape('rect', motion))).toMatchObject(motion)
    for (const kind of ['blur', 'pixelate'] as const) {
      const read = readShape(shape(kind, motion))!
      for (const k of ['enter', 'exit', 'sound']) expect(read, `${kind} ${k}`).not.toHaveProperty(k)
    }
    // A highlight cannot Draw; a text-only motion is dropped from a shape.
    expect(readShape(shape('highlight', { enter: { kind: 'draw', duration: 0.3, strength: 1 } }))).not.toHaveProperty('enter')
    expect(readShape(shape('line', { enter: { kind: 'typewriter', duration: 0.3, strength: 1 }, sound: 'sfx:nope' }))).not.toHaveProperty('enter')
    expect(readShape(shape('line', { sound: 'none' }))!.sound).toBe('none')
  })

  it('readSpotlight: a magnifier keeps magnify, clamped; NaN dropped', () => {
    const spot = (magnify: unknown): Partial<Spotlight> =>
      ({ id: 'p', start: 1, end: 3, mode: 'region', x: 0.2, y: 0.2, w: 0.3, h: 0.3, shape: 'ellipse', dim: 0, feather: 0, magnify }) as Partial<Spotlight>
    expect(readSpotlight(spot(2))!.magnify).toBe(2)
    expect(readSpotlight(spot(9))!.magnify).toBe(4)
    expect(readSpotlight(spot(1))!.magnify).toBe(1.5)
    expect(readSpotlight(spot(NaN))).not.toHaveProperty('magnify')
    expect(readSpotlight(spot('2'))).not.toHaveProperty('magnify')
  })

  it('readTitleCard keeps its motions and sound', () => {
    const card = {
      id: 't',
      start: 0,
      end: 3,
      title: 'Hi',
      style: 'centered',
      background: 'blur',
      enter: { kind: 'typewriter', duration: 0.5, strength: 1 },
      exit: { kind: 'grow', duration: 0.3, strength: 1 },
      sound: 'sfx:bell'
    } as Partial<TitleCard>
    expect(readTitleCard(card)).toMatchObject({ enter: { kind: 'typewriter' }, exit: { kind: 'grow' }, sound: 'sfx:bell' })
    // A title card cannot slide out or wipe out; a missing sound is no key.
    const bad = readTitleCard({ ...card, exit: { kind: 'slide-left', duration: 0.3, strength: 1 }, sound: 'sfx:nope' } as Partial<TitleCard>)!
    expect(bad).not.toHaveProperty('exit')
    expect(bad).not.toHaveProperty('sound')
  })

  it("a graphic's sound: 'pop', 'ding' or an effect of the library; 'sfx:nope' dropped", () => {
    expect(readGraphicSound('pop')).toBe('pop')
    expect(readGraphicSound('ding')).toBe('ding')
    expect(readGraphicSound('sfx:pop-soft')).toBe('sfx:pop-soft')
    expect(readGraphicSound('sfx:nope')).toBeUndefined()
    const g = {
      id: 'g1',
      kind: 'keyword',
      start: 1,
      end: 2,
      place: 'auto',
      size: 0.06,
      enter: { kind: 'pop', duration: 0.3, strength: 1 },
      exit: { kind: 'fade', duration: 0.2, strength: 1 },
      text: 'Save',
      look: 'card'
    }
    expect(readGraphics([{ ...g, sound: 'sfx:pop-soft' }], 10, undefined)![0].sound).toBe('sfx:pop-soft')
    expect(readGraphics([{ ...g, sound: 'sfx:nope' }], 10, undefined)![0]).not.toHaveProperty('sound')
    expect(readGraphics([{ ...g, sound: 'ding' }], 10, undefined)![0].sound).toBe('ding')
  })

  it('calloutOf: pin and body clamped, an unknown numbering read as 1, startAt 0 and 1,000 dropped, a badge drawn with its first 3 graphemes', () => {
    const a = (extra: Record<string, unknown>): Annotation => ({ id: 'a', start: 0, end: 2, text: 'Step', x: 0.5, y: 0.5, size: 0.045, style: 'badge', ...extra }) as Annotation
    expect(calloutOf(a({ pin: { x: 5, y: -5 } })).pin).toEqual({ x: 2, y: -1 })
    expect(calloutOf(a({ pin: { x: NaN, y: 0 } })).pin).toBeUndefined()
    expect(calloutOf(a({ style: 'bubble', pin: { x: 0.5, y: 0.5 }, body: { dx: 3, dy: -3 } })).body).toEqual({ dx: 1, dy: -1 })
    expect(calloutOf(a({ numbering: 'xx' })).numbering).toBe('1')
    expect(calloutOf(a({ numbering: 'en' })).numbering).toBe('1')
    expect(calloutOf(a({ numbering: 'bn' })).numbering).toBe('bn')
    expect(calloutOf(a({ numbering: 'A' })).numbering).toBe('A')
    expect(calloutOf(a({ startAt: 0 })).startAt).toBeUndefined()
    expect(calloutOf(a({ startAt: 1000 })).startAt).toBeUndefined()
    expect(calloutOf(a({ startAt: 2.5 })).startAt).toBeUndefined()
    expect(calloutOf(a({ startAt: 999 })).startAt).toBe(999)
    expect(calloutOf(a({ text: 'abcde' })).text).toBe('abc')
    // A Bangla conjunct with its vowel sign and an emoji with a skin tone are one grapheme each.
    expect(calloutOf(a({ text: 'ক্ষা👍🏽xyz' })).text).toBe('ক্ষা👍🏽x')
    // Damaged values draw as absent and the object is left as it was.
    const raw = a({ enter: { kind: 'blur', duration: 1, strength: 1 }, color: 'blue' })
    expect(calloutOf(raw).enter).toBeUndefined()
    expect(calloutOf(raw).color).toBeUndefined()
    expect((raw as unknown as { color: string }).color).toBe('blue')
  })

  it('only texts with a motion, badges and bubbles are callouts: a text from before never is', () => {
    const text = { id: 't', start: 0, end: 2, text: 'Hi', x: 0.5, y: 0.5, size: 0.05, style: 'pill' } as Annotation
    expect(isCallout(text)).toBe(false)
    expect(isCallout({ ...text, style: 'title' })).toBe(false)
    expect(isCallout({ ...text, enter: { kind: 'rise', duration: 0.25, strength: 1 } } as Annotation)).toBe(true)
    expect(isCallout({ ...text, style: 'badge' } as Annotation)).toBe(true)
    expect(isCallout({ ...text, style: 'bubble' } as Annotation)).toBe(true)
  })
})

/* ---------- test 5 ---------- */

/** A .cube file of size n (identity), with extra header lines and data written by `line`. */
function cube(n: number, opts: { header?: string[]; shaper?: number; eol?: string; line?: (r: number, g: number, b: number) => string } = {}): string {
  const eol = opts.eol ?? '\n'
  const lines = [...(opts.header ?? []), ...(opts.shaper ? [`LUT_1D_SIZE ${opts.shaper}`] : []), `LUT_3D_SIZE ${n}`]
  if (opts.shaper) for (let i = 0; i < opts.shaper; i++) lines.push(`${(i / (opts.shaper - 1)).toFixed(6)} ${(i / (opts.shaper - 1)).toFixed(6)} ${(i / (opts.shaper - 1)).toFixed(6)}`)
  const line = opts.line ?? ((r, g, b) => `${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`)
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(line(r / (n - 1), g / (n - 1), b / (n - 1)))
  return lines.join(eol) + eol
}

function rejects(text: string | Uint8Array, line?: number, reason?: RegExp): void {
  let err: unknown = null
  try {
    parseCube(typeof text === 'string' ? enc(text) : text)
  } catch (e) {
    err = e
  }
  expect(err, 'should be refused').toBeInstanceOf(CubeError)
  const e = err as InstanceType<typeof CubeError>
  expect(e.message).toMatch(/^This LUT could not be used: /)
  if (line !== undefined) expect(e.line).toBe(line)
  if (reason) expect(e.message).toMatch(reason)
}

describe('parseCube (test 5)', () => {
  it('accepts sizes 2, 17, 33 and 65, red changing fastest', () => {
    for (const n of [2, 17, 33]) {
      const lut = parseCube(enc(cube(n)))
      expect(lut.size).toBe(n)
      expect(lut.data).toHaveLength(n ** 3 * 3)
      // Entry (r=1, g=0, b=0) is the second triple.
      expect(Array.from(lut.data.slice(3, 6)).map((v) => Math.round(v * (n - 1)))).toEqual([1, 0, 0])
      expect(lut.shaper).toBeNull()
      expect(lut.domainMin).toEqual([0, 0, 0])
      expect(lut.domainMax).toEqual([1, 1, 1])
    }
    const big = enc(cube(65))
    const t0 = performance.now()
    const lut = parseCube(big)
    const ms = performance.now() - t0
    expect(lut.data).toHaveLength(65 ** 3 * 3)
    expect(ms).toBeLessThan(150)
  })

  it('accepts a Resolve shaper of 65,536 entries with its 3D table, and the domain and input ranges', () => {
    const resolve = parseCube(enc(cube(2, { shaper: 65536, header: ['LUT_1D_INPUT_RANGE 0.0 1.0', 'LUT_3D_INPUT_RANGE -0.1 1.1'] })))
    expect(resolve.shaper).toMatchObject({ size: 65536, min: 0, max: 1 })
    expect(resolve.shaper!.data).toHaveLength(65536 * 3)
    expect(resolve.domainMin).toEqual([-0.1, -0.1, -0.1])
    expect(resolve.domainMax).toEqual([1.1, 1.1, 1.1])
    const domain = parseCube(enc(cube(2, { header: ['DOMAIN_MIN 0 0.1 0', 'DOMAIN_MAX 1 1 0.9'] })))
    expect(domain.domainMin).toEqual([0, 0.1, 0])
    expect(domain.domainMax).toEqual([1, 1, 0.9])
  })

  it('accepts CRLF, a BOM, tabs, comments, a title and the video-range keywords', () => {
    const text = '﻿# made by hand\r\nTITLE "Warm ‮film"\r\nlut_in_video_range\r\nLUT_OUT_VIDEO_RANGE\r\n' + cube(2, { eol: '\r\n', line: (r, g, b) => `${r}\t${g}  ${b} # note` })
    const lut = parseCube(enc(text))
    expect(lut.title).toBe('Warm film')
    expect(lut.size).toBe(2)
  })

  it('rejects a NUL byte, size 66, a 1D size of 65,537 and too narrow a range', () => {
    rejects(cube(2).replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\u0000'), 1, /NUL/)
    rejects('LUT_3D_SIZE 66\n0 0 0\n', 1, /66/)
    rejects('LUT_1D_SIZE 65537\nLUT_3D_SIZE 2\n', 1, /65,537/)
    rejects(cube(2, { header: ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 0.0000005 1'] }), 2, /narrower/)
    rejects(cube(2, { header: ['LUT_3D_INPUT_RANGE 0.5 0.5'] }), 1, /narrower/)
    rejects(cube(2, { header: ['LUT_1D_INPUT_RANGE 0 1e-40'] }), 1, /narrower/)
  })

  it('rejects NaN, 1e999, 17.5, hex and other non-numbers', () => {
    const at = (bad: string): string => cube(2).replace('1.000000 0.000000 0.000000', bad)
    rejects(at('NaN 0 0'), 3, /not a number/)
    rejects(at('1e999 0 0'), 3, /too large/)
    rejects(at('17.5 0 0'), 3, /larger than 16/)
    rejects(at('0x1F 0 0'), 3, /not a number/)
    rejects(at('Infinity 0 0'), 3)
    rejects(at('1,5 0 0'), 3)
  })

  it('rejects a short file, an extra line, a keyword after the data, LUT_2D_SIZE, an unknown or repeated keyword', () => {
    const lines = cube(2).trimEnd().split('\n')
    rejects(lines.slice(0, -1).join('\n'), 8, /ends after 7 of 8/)
    rejects([...lines, '0 0 0'].join('\n'), 10, /one more line/)
    rejects([...lines, 'TITLE "late"'].join('\n'), 10, /after the data/)
    rejects('LUT_2D_SIZE 2\n', 1, /unknown keyword LUT_2D_SIZE/)
    rejects('LUT_3D_SIZE 2\nFOO 1\n', 2, /unknown keyword FOO/)
    rejects('LUT_3D_SIZE 2\nlut_3d_size 2\n', 2, /repeats/)
    rejects('# nothing\n', 0, /no LUT_3D_SIZE/)
    rejects(cube(2).replace('0.000000 0.000000 0.000000', '0 0'), 2, /has 2 numbers, not 3/)
  })

  it('rejects a 1,025-character line, invalid UTF-8 and 16 MiB + 1 byte, and names the line', () => {
    rejects(`# ${'x'.repeat(1023)}\n${cube(2)}`, 1, /longer than 1,024/)
    expect(() => parseCube(enc(`# ${'x'.repeat(1022)}\n${cube(2)}`))).not.toThrow()
    rejects(new Uint8Array([0x4c, 0x55, 0x54, 0xc3, 0x28, 0x0a]), 0, /UTF-8/)
    rejects(new Uint8Array(CUBE_LIMITS.maxBytes + 1).fill(0x20), 0, /larger than 16 MB/)
    const err = (() => {
      try {
        parseCube(enc(cube(17).replace('0.062500 0.000000 0.000000', '0.0625 0')))
      } catch (e) {
        return e as InstanceType<typeof CubeError>
      }
      return null
    })()
    expect(err?.message).toBe('This LUT could not be used: line 3 has 2 numbers, not 3.')
  })
})

/* ---------- test 6 ---------- */

describe('the sound library catalogue and its files (test 6)', () => {
  const pins = lib.PREPARED_PINS
  const bundledDir = path.join(ROOT, 'resources', 'sound-library')
  const evidenceDir = path.join(ROOT, 'scripts', 'sound-library', 'evidence')

  it('has unique ids, twelve beds in five moods and sixteen effects, every one prepared and pinned', () => {
    const ids = [...lib.BED_SOURCES, ...lib.EFFECT_SOURCES].map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(lib.BED_SOURCES).toHaveLength(12)
    expect(lib.EFFECT_SOURCES).toHaveLength(16)
    expect(new Set(lib.BED_SOURCES.map((b) => b.mood))).toEqual(new Set(['calm', 'upbeat', 'corporate', 'lofi', 'cinematic']))
    expect(lib.MUSIC_BEDS).toHaveLength(12)
    expect(lib.SOUND_EFFECTS).toHaveLength(16)
    expect(Object.keys(pins).sort()).toEqual([...ids].sort())
    const files = Object.values(pins).map((p) => p.file)
    expect(new Set(files).size).toBe(files.length)
    for (const b of lib.MUSIC_BEDS) {
      expect(b.prepared).toMatchObject({ loopStart: b.loop.start, loopEnd: b.loop.end, pad: lib.BED_PAD, samples: b.loop.end + lib.BED_PAD })
      expect(b.prepared.loopStart).toBeLessThan(b.prepared.loopEnd)
    }
    for (const e of lib.SOUND_EFFECTS) {
      expect(e.prepared.seconds).toBeGreaterThan(0)
      expect(e.prepared.peakAt).toBeGreaterThanOrEqual(0)
      expect(e.prepared.peakAt).toBeLessThan(e.prepared.seconds)
    }
  })

  it('every bundled file exists with its pinned bytes and SHA-256; the downloadable beds have no file here', () => {
    let total = 0
    for (const x of [...lib.MUSIC_BEDS.filter((b) => b.bundled), ...lib.SOUND_EFFECTS]) {
      const bytes = fs.readFileSync(path.join(bundledDir, x.prepared.file))
      expect(bytes.length, x.id).toBe(x.prepared.bytes)
      expect(sha(bytes), x.id).toBe(x.prepared.sha256)
      total += bytes.length
    }
    for (const b of lib.MUSIC_BEDS.filter((b) => !b.bundled)) expect(fs.existsSync(path.join(bundledDir, b.prepared.file)), b.id).toBe(false)
    expect(lib.MUSIC_BEDS.filter((b) => b.bundled).map((b) => b.mood)).toEqual(['calm', 'upbeat', 'corporate', 'lofi'])
    // The folder holds those files and SOUNDS.md only.
    const expected = [...lib.MUSIC_BEDS.filter((b) => b.bundled), ...lib.SOUND_EFFECTS].map((x) => x.prepared.file)
    expect(fs.readdirSync(bundledDir).sort()).toEqual([...expected, 'SOUNDS.md'].sort())
    // The installer grows by about 2.78 MB (§0): under the budget.
    total += fs.statSync(path.join(bundledDir, 'SOUNDS.md')).size
    expect(total).toBeLessThanOrEqual(packaging.SOUND_LIBRARY_BUDGET.installed)
    expect(total).toBeLessThanOrEqual(packaging.SOUND_LIBRARY_BUDGET.compressed)
    expect(packaging.soundLibraryResource()).toMatchObject({ from: 'resources/sound-library', to: 'sound-library' })
  })

  it('pins every upstream file and every archive member, all CC0', () => {
    for (const b of lib.BED_SOURCES) {
      expect(b.licence).toBe('CC0-1.0')
      expect(b.upstream.url).toMatch(/^https:\/\/files\.freemusicarchive\.org\/storage-freemusicarchive-org\//)
      expect(b.upstream.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(b.upstream.bytes).toBeGreaterThan(1e6)
      expect(b.page).toMatch(/^https:\/\/freemusicarchive\.org\/music\//)
    }
    for (const e of lib.EFFECT_SOURCES) {
      expect(e.licence).toBe('CC0-1.0')
      const up = lib.SFX_UPSTREAM[e.upstream]
      expect(up, e.id).toBeDefined()
      expect(up.url).toMatch(/^https:\/\/opengameart\.org\/sites\/default\/files\//)
      expect(up.sha256).toMatch(/^[0-9a-f]{64}$/)
      const archive = /\.(zip|7z)$/.test(e.upstream)
      expect(e.member !== null, e.id).toBe(archive)
      if (e.member) {
        expect(e.member.archive).toBe(e.upstream)
        expect(e.member.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(e.member.bytes).toBeGreaterThan(0)
        expect(e.member.path).not.toMatch(/(^\/|\.\.)/)
      }
    }
  })

  it("every bed's artist has evidence that agrees with CC0 (a URL, a date, the sentence and its saved page, pinned); none is rejected", () => {
    const artists = new Map(lib.ARTISTS.map((a) => [a.name, a]))
    for (const b of lib.BED_SOURCES) {
      expect(lib.REJECTED_ARTISTS, b.id).not.toContain(b.artist)
      const a = artists.get(b.artist)
      expect(a, b.id).toBeDefined()
      expect(a!.url).toMatch(/^https:\/\//)
      expect(a!.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(a!.quote.length).toBeGreaterThan(20)
    }
    expect(lib.REJECTED_ARTISTS).toContain('John Bartmann')
    for (const a of [...lib.ARTISTS, ...lib.REJECTED_EVIDENCE]) {
      const bytes = fs.readFileSync(path.join(evidenceDir, a.evidence))
      expect(sha(bytes), a.evidence).toBe(a.sha256)
      expect(bytes.toString('utf8').replace(/\s+/g, ' '), a.evidence).toContain(a.quote)
    }
  })

  it('SOUNDS.md and the notices list every file; the download source is not set yet', () => {
    const md = fs.readFileSync(path.join(bundledDir, 'SOUNDS.md'), 'utf8')
    const notice = fs.readFileSync(path.join(ROOT, 'resources', 'notices', '37-sound-library.txt'), 'utf8')
    const all = fs.readFileSync(path.join(ROOT, 'resources', 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    for (const p of Object.values(pins)) {
      expect(md, p.file).toContain(p.file)
      expect(md, p.file).toContain(p.sha256)
      expect(notice, p.file).toContain(p.file)
      expect(all, p.file).toContain(p.file)
    }
    // §0 decision 1: the separate repository does not exist yet, so the eight download rows are hidden.
    expect(lib.SOUND_LIBRARY_SOURCE).toBeNull()
    expect(lib.SOUND_LIBRARY_RELEASE.prefix).toBe(`https://github.com/${lib.SOUND_LIBRARY_RELEASE.repository}/releases/download/${lib.SOUND_LIBRARY_RELEASE.tag}/`)
  })

  it('build-sound-library.mjs --check passes on the committed files, with no network', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-sound-library.mjs'), '--check'], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    expect(r.stderr.trim()).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('matches its pins: 28 files')
  })

  it('names sounds for the UI and Review, serves only catalogue names, and credits a bed', () => {
    expect(lib.sfxTitle('pop')).toBe('Original pop')
    expect(lib.sfxTitle('ding')).toBe('Original ding')
    expect(lib.sfxTitle('sfx:pop-soft')).toBe('Soft pop')
    const re = lib.soundFileRe()
    for (const p of Object.values(pins)) expect(re.test(p.file), p.file).toBe(true)
    for (const bad of ['../bed-calm-old-key.ogg', 'sfx-pop.ogg/x', 'music-1.ogg', 'SOUNDS.md', 'sfx-pop.oggx']) expect(re.test(bad), bad).toBe(false)
    const p = createProject({ id: 'm', name: 'm', duration: 5, width: 100, height: 100, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
    const music = { path: 'music-1.ogg', volume: 0.35, ducking: 0.7, loop: true, fadeIn: 1, fadeOut: 2 }
    expect(lib.musicCredit({ ...p, audio: { ...p.audio, music } })).toBeNull()
    expect(lib.musicCredit({ ...p, audio: { ...p.audio, music: { ...music, library: { id: 'upbeat-sweet-sun' } } } })).toBe('Music: Sweet Sun by Loyalty Freak Music (CC0)')
    expect(lib.musicCredit({ ...p, audio: { ...p.audio, music: { ...music, library: { id: 'nope' } } } })).toBeNull()
  })
})

/* ---------- test 7 ---------- */

describe('the contracts change nothing for a project from before (test 7)', () => {
  /** The call log of drawing `draw` for a scene fixture at `t` on a fresh canvas. */
  const FIX = sceneFixtures()
  const sceneOf = (name: string): { scene: Record<string, unknown>; src: Record<string, unknown>; w: number; h: number; project: Project } => {
    const f = FIX.find((x) => x.name === name)!
    const view = cropView(f.project, f.track)
    const scene = {
      project: view.project,
      cursor: view.cursor,
      cursorPath: new SmoothedTrack(view.cursor.samples, f.project.duration, f.project.cursor.smoothing),
      focusPath: focusPathFor(view.cursor.samples, f.project.duration),
      ...(view.crop ? { crop: view.crop } : {})
    }
    const webcam = f.project.hasWebcam ? { readyState: 4, videoWidth: 1280, videoHeight: 720 } : null
    const src = {
      screen: { readyState: 4, videoWidth: f.project.width, videoHeight: f.project.height },
      webcam,
      background: null,
      screenFrame: { image: { tag: 'screen' }, width: f.project.width, height: f.project.height },
      ...(webcam ? { webcamFrame: { image: { tag: 'camera' }, width: 1280, height: 720 } } : {})
    }
    return { scene, src, w: f.w, h: f.h, project: f.project }
  }
  const logOf = (run: (ctx: unknown) => void): string => {
    const c = canvas()
    calls.length = 0
    run((c.getContext as (t: string) => unknown)('2d'))
    canvases = 0
    return digest(calls.map((k) => ({ ...k, canvas: undefined, args: JSON.stringify(k.args, (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? 'canvas' : v)) })))
  }

  for (const name of ['wide-corners', 'frame-browser', 'tall-layouts', 'crop-wide']) {
    it(`${name}: a frame drawn with and without the hooks has the same calls`, () => {
      const { scene, src, w, h } = sceneOf(name)
      for (const t of [1.5, 9.5, 12.25, 21]) {
        const plain = logOf((ctx) => drawFrame(ctx, w, h, t, scene, src, { blurSamples: 4 }, t))
        // A video time, no join, Compare (no grade to leave out): the same frame.
        expect(
          logOf((ctx) => drawFrame(ctx, w, h, t, scene, src, { blurSamples: 4 }, t, { video: t + 3, join: null })),
          `${t} extras`
        ).toBe(plain)
        expect(
          logOf((ctx) => drawFrame(ctx, w, h, t, { ...scene, compare: true }, src, { blurSamples: 4 }, t)),
          `${t} compare`
        ).toBe(plain)
        // The two halves and the restore are drawFrame.
        const halves = logOf((ctx) => {
          const top = drawFramePicture(ctx, w, h, t, scene, src, { blurSamples: 4 }, t)
          drawFrameOverlays(top, t, t)
          ;(ctx as { restore(): void }).restore()
        })
        expect(halves, `${t} halves`).toBe(plain)
      }
    })
  }

  it('textArea gives way to the bar only with chapterBar.show', () => {
    band = { edge: 'top', size: 50 }
    try {
      for (const f of FIX) {
        const t = 5
        const area = textAreaWithoutBar(f.drawn, f.w, f.h, f.vw, f.vh, t)
        const whole = area ?? { x: 0, y: 0, w: f.w, h: f.h }
        expect(textArea(f.drawn, f.w, f.h, f.vw, f.vh, t), f.name).toEqual(area)
        expect(textArea({ ...f.drawn, chapterBar: { show: false, place: 'auto', style: 'float', labels: 'current' } }, f.w, f.h, f.vw, f.vh, t), f.name).toEqual(area)
        const shown = { ...f.drawn, chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' } } as Project
        expect(textArea(shown, f.w, f.h, f.vw, f.vh, t), f.name).toEqual({ ...whole, y: whole.y + 50, h: whole.h - 50 })
        band = { edge: 'bottom', size: 40 }
        expect(textArea(shown, f.w, f.h, f.vw, f.vh, t), f.name).toEqual({ ...whole, h: whole.h - 40 })
        band = { edge: 'top', size: 50 }
      }
    } finally {
      band = null
    }
  })

  it('settleJoins and settleGrade return the next project itself; Review lists nothing new', () => {
    for (const f of [...load('vertical-old-projects.json'), ...load('wave8-old-projects.json')]) {
      const prev = migrateProject(structuredClone(f.raw))
      const next = { ...prev, zooms: [...prev.zooms] }
      expect(settleJoins(next, prev)).toBe(next)
      expect(settleGrade(next, prev)).toBe(next)
      expect(editingReviewItems(prev)).toEqual([])
      expect(editingPendingCount(prev)).toBe(0)
      expect(pendingCount(prev)).toBe(reviewItems(prev).length)
      expect(reviewItems(prev).some((i) => i.kind === 'join' || i.kind === 'colour')).toBe(false)
    }
  })

  it('editingFontIds is empty for old projects, and prepareEditingAssets does no work for them', async () => {
    lutLoads.length = 0
    for (const f of [...load('vertical-old-projects.json'), ...load('wave8-old-projects.json'), ...load('captions-old-projects.json')]) {
      if (f.name === 'caption-data') continue
      const p = migrateProject(structuredClone(f.raw))
      expect(editingFontIds(p)).toEqual([])
      expect(needsEditingAssets(p)).toBe(false)
      await prepareEditingAssets(p)
    }
    expect(lutLoads).toEqual([])
    // A badge, or a progress bar with names over two chapters, needs the script fonts; a LUT is loaded.
    const p = migrateProject(JSON.parse(JSON.stringify(studioProject())))
    expect(editingFontIds({ ...p, annotations: [{ id: 'a', start: 0, end: 1, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge' }] })).toEqual([...CALLOUT_FALLBACK_IDS].sort())
    expect(editingFontIds({ ...p, chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' } })).toEqual([...CALLOUT_FALLBACK_IDS].sort())
    expect(editingFontIds({ ...p, chapterBar: { show: true, place: 'auto', style: 'float', labels: 'none' } })).toEqual([])
    const graded = { ...p, grade: { camera: { lut: { file: 'lut-1.cube', sha256: 'a'.repeat(64), title: 't', size: 2 } } } }
    await prepareEditingAssets(graded)
    expect(lutLoads).toEqual([graded])
  })

  it('hasSound is unchanged without library effects, and counts them when there are some', async () => {
    const EXPORTER = '../src/renderer/src/editor/exporter'
    const { hasSound } = (await import(/* @vite-ignore */ EXPORTER)) as { hasSound(s: Record<string, unknown>): boolean }
    expect(hasSound({})).toBe(false)
    expect(hasSound({ effects: [] })).toBe(false)
    expect(hasSound({ pops: [], tones: [] })).toBe(false)
    expect(hasSound({ pops: [{ times: [1], sound: 'pop' }] })).toBe(true)
    expect(hasSound({ clicks: { times: [1], volume: 1 } })).toBe(true)
    // A silent recording whose only sound is a zoom whoosh still exports with sound (§10.8).
    expect(hasSound({ effects: [{ id: 'whoosh-soft', times: [1.2], gain: 0.35 }] })).toBe(true)
  })

  it("popJob leaves a library sound to sfxJob and keeps 'pop' and 'ding' as they were", () => {
    const p = migrateProject(JSON.parse(JSON.stringify(studioProject())))
    const before = popJob(p)
    expect(before).toEqual([{ times: [expect.any(Number)], sound: 'ding' }])
    const g = p.graphics![0]
    expect(popJob({ ...p, graphics: [{ ...g, sound: 'sfx:pop-soft' }] })).toEqual([])
    expect(popJob({ ...p, graphics: [{ ...g, sound: 'pop' }] })).toEqual([{ times: before[0].times, sound: 'pop' }])
  })

  it('Polish declares the Smooth cuts step after Remove silences and skips it as not selected', () => {
    expect(POLISH_STEPS.indexOf('smoothCuts')).toBe(POLISH_STEPS.indexOf('silences') + 1)
    expect(DEFAULT_POLISH_OPTIONS.smoothCuts).toBe(true)
    expect(readPolishOptions({}).smoothCuts).toBe(false)
    const project = migrateProject(JSON.parse(JSON.stringify(studioProject())))
    const r = planPolish(
      { project, recorded: { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }, sound: null, transcript: null, speech: null, framing: { status: 'skipped' }, preset: null },
      DEFAULT_POLISH_OPTIONS
    )
    expect(r.summary.steps.find((s) => s.step === 'smoothCuts')).toEqual({ step: 'smoothCuts', status: 'skipped', reason: 'off' })
  })

  it('the thirteen commands exist, after the versions commands, with no default keys and no conflicts', () => {
    const NEW: [string, string, string, boolean?][] = [
      ['smoothAllCuts', 'Playback', 'Smooth all cuts'],
      ['hardCutsEverywhere', 'Playback', 'Use hard cuts everywhere'],
      ['nextCut', 'Playback', 'Go to next cut'],
      ['previousCut', 'Playback', 'Go to previous cut'],
      ['playCut', 'Playback', 'Play this cut'],
      ['addMagnifier', 'Add', 'Add magnifier'],
      ['addMagnifierCursor', 'Add', 'Add magnifier on the cursor'],
      ['addStepBadge', 'Add', 'Add step badge'],
      ['addSpeechBubble', 'Add', 'Add speech bubble'],
      ['toggleProgressBar', 'Effects', 'Progress bar on the video', true],
      ['compareColour', 'Effects', 'Compare with original colour', true],
      ['autoColour', 'Camera', 'Auto colour for the camera'],
      ['musicLibrary', 'Panels', 'Music library…']
    ]
    const ids = COMMANDS.map((c) => c.id as string)
    expect(ids.slice(-NEW.length)).toEqual(NEW.map((n) => n[0]))
    expect(ids.indexOf('versions')).toBe(ids.length - NEW.length - 1)
    for (const [id, category, title, toggle] of NEW) {
      const c = COMMANDS.find((x) => x.id === id)!
      expect(c.category, id).toBe(category)
      expect(c.title, id).toBe(title)
      expect(!!(c as { toggle?: boolean }).toggle, id).toBe(!!toggle)
      expect(DEFAULT_KEYMAP[c.id], id).toEqual([])
    }
    expect(COMMANDS.find((c) => c.id === 'toggleProgressBar')!.keywords).toMatch(/progress/)
    expect(COMMANDS.find((c) => c.id === 'toggleProgressBar')!.keywords).toMatch(/chapter bar/)
    expect([...findConflicts(DEFAULT_KEYMAP).entries()]).toEqual([])
  })
})
