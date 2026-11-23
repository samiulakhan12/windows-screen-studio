import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AiTextRequest } from '../src/shared/api/ai'
import type { ExportJob } from '../src/shared/api/export'
import type { CaptionSegment, CursorTrack, Project } from '../src/shared/types'
import { digest, rng, sceneFixtures, seededTrack } from './verticalFixtures'

/*
 * Test 20, the equivalence guard of auto-blur private information (docs/design/auto-blur.md §17.2,
 * §16.0 item 1). Written and committed alone against the code of every wave through wave 12
 * (37f9355), before any other change of this wave. Auto-blur only adds optional fields (covers,
 * privacy, a segment's maskedFor, the private bleep's word form) and paths behind them, so for every
 * old project and stored setting each value here stays the same bit for bit after the contracts and
 * after every part: what a project loads to and the bytes it is written as, what drawFrame and the
 * join layer draw at 24 export frames, every gain and soundtrack graph, every text made from
 * captions, every AI request the pure builders make, the stored export settings, bundle choices,
 * user presets and editor preferences, Polish's plan, the guide's shot signatures and Home's
 * summaries. Values are digests of their exact JSON (tests/verticalFixtures.ts digest) kept in
 * tests/fixtures/autoblur-equivalence.json. The digests are never regenerated to make a change
 * pass: a changed digest names the section and the fixture.
 *
 * Three functions arrive with the contracts: projectFileText (src/main/projectFile.ts), privateView
 * (src/shared/privacy/spoken.ts) and maskRequest (src/shared/privacy/aiRequest.ts). While their
 * files do not exist, the guard reads them as what they must equal for these fixtures
 * (JSON.stringify(project, null, 2) and the identity); once they exist, it calls them.
 */

/* ---------- canvases that record their calls (as tests/outputEquivalence.test.ts) ---------- */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  font: unknown
  fill: unknown
  stroke: unknown
  alpha: unknown
  quality: unknown
  composite: unknown
  dash: unknown
  filter: unknown
}
const calls: Call[] = []
let canvases = 0

/** A canvas whose 2D context records its calls with the state they draw with. */
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  const stack: Record<string | symbol, unknown>[] = []
  const record = (target: Record<string | symbol, unknown>, name: string, args: unknown[]): void =>
    void calls.push({
      canvas: id,
      name,
      args,
      font: target.font,
      fill: target.fillStyle,
      stroke: target.strokeStyle,
      alpha: target.globalAlpha,
      quality: target.imageSmoothingQuality,
      composite: target.globalCompositeOperation,
      dash: target.lineDashOffset,
      filter: target.filter
    })
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {}, setTransform() {} })
      if (prop === 'measureText')
        return (text: string) => ({
          width: String(text).length * 9,
          actualBoundingBoxAscent: 7,
          actualBoundingBoxDescent: 2
        })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (prop === 'getLineDash') return () => []
      // The colour grade's CPU path reads pixels back: a small fixed image keeps its calls cheap and the same.
      if (prop === 'getImageData')
        return (...args: unknown[]) => {
          record(target, 'getImageData', args)
          return { data: new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 128]), width: 2, height: 1 }
        }
      if (prop === 'save')
        return () => {
          stack.push({ ...target })
          record(target, 'save', [])
        }
      if (prop === 'restore')
        return () => {
          const back = stack.pop()
          if (back) {
            for (const k of Object.keys(target)) delete target[k]
            Object.assign(target, back)
          }
          record(target, 'restore', [])
        }
      return (...args: unknown[]) => record(target, String(prop), args)
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  c.toBlob = (cb: (b: null) => void) => cb(null)
  return c
}

vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

/* ---------- a LUT the fake studio-media:// serves (as tests/lutCache.test.ts) ---------- */

/** A 2×2×2 .cube that swaps red and blue. */
const CUBE = ['TITLE "Swap"', 'LUT_3D_SIZE 2', '0 0 0', '0 0 1', '0 1 0', '0 1 1', '1 0 0', '1 0 1', '1 1 0', '1 1 1', ''].join('\n')
const CUBE_BYTES = new TextEncoder().encode(CUBE)
const CUBE_SHA = createHash('sha256').update(CUBE_BYTES).digest('hex')
vi.stubGlobal('fetch', async (url: string) => {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop()!)
  return name === 'lut-1.cube' ? new Response(CUBE_BYTES as unknown as ConstructorParameters<typeof Response>[0], { status: 200 }) : new Response('', { status: 404 })
})

/* ---------- main's file system: a private userData and Videos folder ---------- */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-autoblur-guard-'))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(ROOT, name),
    getName: () => 'Flown',
    getVersion: () => '0.0.0',
    isPackaged: false
  },
  ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  shell: {},
  dialog: {}
}))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const { migrateProject, createProject } = await import('../src/shared/engine/project')
const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { outputSize } = await import('../src/shared/engine/layout')
const { planOf, videoFrames } = await import('../src/shared/engine/freeze')
const { joinAt, joinPlan } = await import('../src/shared/render/joins')
const { planSoundtrack } = await import('../src/shared/render/audioPlan')
const { jobSoundGains } = await import('../src/shared/audio/soundsEdit')
const { bleepGains, maskedSegments, maskBleeped } = await import('../src/shared/captions/cleanup')
const { burnedSegments, captionsToTranslate, textHash } = await import('../src/shared/captions/captionTracks')
const { trackCues } = await import('../src/shared/captions/trackCues')
const { languageSubtitleFile, spokenSegments } = await import('../src/shared/captions/subtitles')
const { studioPreset } = await import('../src/shared/captions/studioPresets')
const { projectUnits, indexedProject } = await import('../src/shared/search/extract')
const { reviewItems, pendingCount, reviewStatus } = await import('../src/shared/review/review')
const { changedAreas, versionSummary } = await import('../src/shared/editor/versions')
const { textPrompts, marksBatches } = await import('../src/shared/captions/transcriptText')
const { publishSegments, PUBLISH_KINDS } = await import('../src/shared/publish/pack')
const { guideSegments, namesRequestForSteps } = await import('../src/shared/guide/stepTitles')
const { namesRequestForChapters } = await import('../src/shared/chapters/names')
const { findSteps } = await import('../src/shared/guide/steps')
const { planShot, planFrame, planActual, guideProject } = await import('../src/shared/guide/shots')
const { planPolish, readPolishOptions, DEFAULT_POLISH_OPTIONS } = await import('../src/shared/editor/polish')
const presets = await import('../src/shared/render/exportPresets')
const { normalizeBundle } = await import('../src/shared/render/exportBundle')
const { readUserPresets } = await import('../src/shared/render/userPresets')
const { readPrefSync, writePrefSync } = await import('../src/main/prefsIpc')
const { listProjects } = await import('../src/main/projects')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number; frameInterval?: number }, soundTime?: number, extras?: unknown) => void
const COMPOSITOR = '../src/renderer/src/render/compositor'
const JOIN_LAYER = '../src/renderer/src/render/joinLayer'
const LUT_CACHE = '../src/renderer/src/render/lutCache'
const PUBLISH_RUN = '../src/renderer/src/publish/publishRun'
const CLIPS_RUN = '../src/renderer/src/clips/clipsRun'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
const joinLayer = (await import(/* @vite-ignore */ JOIN_LAYER)) as {
  scratchTarget(raster: 'gpu' | 'cpu', w: number, h: number): { canvas: Record<string, unknown> }
  composeJoinStill(scratch: unknown, out: unknown, w: number, h: number, window: unknown, scene: unknown, stills: unknown, background: null): void
}
const { prepareLuts, lutFor } = (await import(/* @vite-ignore */ LUT_CACHE)) as { prepareLuts(p: Project): Promise<void>; lutFor(p: Project, which: 'screen'): unknown }
const { packRequest } = (await import(/* @vite-ignore */ PUBLISH_RUN)) as {
  packRequest(kind: string, ctx: { providerId: string; segments: CaptionSegment[]; tone: string; length: string; context?: { title?: string; chapters?: string[] }; key: string }): AiTextRequest
}
const { namesRequestForMoments } = (await import(/* @vite-ignore */ CLIPS_RUN)) as {
  namesRequestForMoments(project: Project, moments: readonly { start: number; end: number }[]): AiTextRequest['names']
}

/* ---------- the functions the contracts add, read as what they must equal here until they exist ---------- */

const here = (file: string): boolean => fs.existsSync(path.join(__dirname, '..', file))
const PROJECT_FILE = '../src/main/projectFile'
const SPOKEN = '../src/shared/privacy/spoken'
const AI_REQUEST = '../src/shared/privacy/aiRequest'
const projectFileText: (p: Project, form?: 'pretty' | 'compact') => string = here('src/main/projectFile.ts')
  ? ((await import(/* @vite-ignore */ PROJECT_FILE)) as { projectFileText: (p: Project, form?: 'pretty' | 'compact') => string }).projectFileText
  : (p, form = 'pretty') => (form === 'compact' ? JSON.stringify(p) : JSON.stringify(p, null, 2))
const privateView: (p: Project) => Project = here('src/shared/privacy/spoken.ts') ? ((await import(/* @vite-ignore */ SPOKEN)) as { privateView: (p: Project) => Project }).privateView : (p) => p
const maskRequest: <R extends object>(r: R, p: Project) => R = here('src/shared/privacy/aiRequest.ts')
  ? ((await import(/* @vite-ignore */ AI_REQUEST)) as { maskRequest: <R extends object>(r: R, p: Project) => R }).maskRequest
  : (r) => r

/* ---------- the digests ---------- */

const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'autoblur-equivalence.json'), 'utf8')) as Record<string, Record<string, string>>

/** A value compared with SNAPSHOT[section][name]. */
function pinned(section: string, name: string, value: unknown): void {
  expect(digest(value), `${section} of ${name}`).toBe(SNAPSHOT[section]?.[name])
}

/* ---------- fixtures ---------- */

interface OldFixture {
  name: string
  raw: Record<string, unknown>
}
const load = (file: string): OldFixture[] => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))

const words = (id: string, start: number, text: string, speaker?: string): CaptionSegment => {
  const list = text.split(' ')
  return {
    id,
    start,
    end: start + list.length * 0.4,
    text,
    words: list.map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.35 })),
    ...(speaker ? { speaker } : {})
  } as CaptionSegment
}

const base = (id: string, duration: number, over: { hasWebcam?: boolean; fps?: number; width?: number; height?: number } = {}): Project =>
  createProject({
    id,
    name: id,
    duration,
    width: over.width ?? 1920,
    height: over.height ?? 1080,
    hasWebcam: over.hasWebcam ?? true,
    hasAudio: true,
    webcamOffset: 0.2,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: over.fps ?? 30 }
  })

const SEGMENTS: CaptionSegment[] = [
  words('k1', 1, 'Welcome to the billing page'),
  words('k2', 4, 'My card is 4917 6123 4567'),
  words('k3', 7.2, 'eight nine zero four and the code is 482913'),
  words('k4', 12, 'Click the Save button now'),
  words('k5', 17, 'Then open the Export dialog'),
  words('k6', 22, 'Call me on 01712 345678 tomorrow'),
  words('k7', 27, 'The password is hunter two'),
  words('k8', 31, 'Write to jane.doe at example dot com'),
  words('k9', 36, 'Sales grew three hundred percent'),
  words('k10', 41, 'That is all for today friends')
]

/**
 * A project saved by wave 12 with everything auto-blur draws over or masks beside: blur and
 * pixelate shapes, a crop, a screen grade with a LUT, magnifiers, a freeze, cut styles, the tilt, a
 * chapter title card on the blurred frame, the Glass caption look, bleeps (one automatic), spoken
 * numbers, a translated track shown on the video, chapters and the bar, the pack's description and
 * a guide with its edits.
 */
function wave12Project(variant: 'full' | 'plain'): Project {
  const p = base(variant === 'full' ? 'w12full' : 'w12plain', 46, { fps: 60 })
  const glass = studioPreset('glass')?.look
  const full = variant === 'full'
  return {
    ...p,
    createdAt: '2026-11-15T10:00:00.000Z',
    ...(full ? { crop: { x: 0.05, y: 0.04, w: 0.9, h: 0.88 } } : {}),
    clips: [
      { id: 'a', start: 0.5, end: 10, speed: 1 },
      { id: 'b', start: 11, end: 20, speed: 1 },
      { id: 'c', start: 20, end: 30, speed: 1.5 },
      { id: 'd', start: 31, end: 46, speed: 1 }
    ],
    freezes: [{ id: 'f1', at: 8, length: 1.5, sound: 'pause' }],
    zooms: [
      { id: 'z1', start: 2, end: 6, scale: 2, focus: { mode: 'cursor' }, auto: true },
      { id: 'z2', start: 13, end: 16, scale: 1.6, focus: { mode: 'fixed', x: 0.3, y: 0.4 } }
    ],
    shapes: [
      { id: 'h1', start: 1, end: 9, kind: 'blur', x: 0.6, y: 0.1, w: 0.25, h: 0.08, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.6 },
      { id: 'h2', start: 4, end: 25, kind: 'pixelate', x: 0.1, y: 0.7, w: 0.3, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.4 },
      { id: 'h3', start: 12, end: 15, kind: 'rect', x: 0.4, y: 0.3, w: 0.2, h: 0.15, color: '#30d158', strokeWidth: 5, fill: false, opacity: 1, strength: 0.5 },
      { id: 'h4', start: 33, end: 44, kind: 'blur', x: 0.02, y: 0.02, w: 0.2, h: 0.06, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 1 }
    ],
    spotlights: [
      { id: 's1', start: 5, end: 9, mode: 'region', x: 0.55, y: 0.05, w: 0.3, h: 0.2, shape: 'rect', dim: 0, feather: 0.1, magnify: 2 },
      { id: 's2', start: 21, end: 26, mode: 'cursor', x: 0, y: 0, w: 0.2, h: 0.2, shape: 'ellipse', dim: 0.3, feather: 0.2, magnify: 2.5 }
    ],
    joins: {
      all: { kind: 'crossfade', duration: 0.3 },
      cuts: [{ clip: 'd', kind: 'slide', duration: 0.4, from: 'left' }]
    },
    ...(full ? { grade: { screen: { look: 'vivid', contrast: 0.1, lut: { file: 'lut-1.cube', sha256: CUBE_SHA, title: 'Swap', size: 2, strength: 0.8 } } } } : {}),
    tilt: { enabled: full, rotateX: 8, rotateY: -12, perspective: 0.5, animate: 'none' },
    titles: [
      { id: 't1', start: 11, end: 13, title: 'Billing', subtitle: 'Card 4917 6123 4567 8904', style: 'centered', background: 'blur' },
      { id: 't2', start: 31, end: 33.5, title: 'Priya Raman', subtitle: 'Support', style: 'lower-third', background: 'solid', color: '#1d1d24' }
    ],
    chapters: [
      { id: 'ch1', t: 0.5, title: 'Start' },
      { id: 'ch2', t: 11, title: 'Billing 4917 6123 4567 8904' },
      { id: 'ch3', t: 31, title: 'Wrap up', auto: { by: 'find', from: ['page', 'pause'], name: 'sentence' } }
    ],
    chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' },
    transcript: { language: 'en', provider: 'local', model: 'speech-small', createdAt: '2026-11-15T09:00:00.000Z', segments: SEGMENTS },
    ...(glass ? { captions: { ...p.captions!, show: true, ...(full ? { track: 'es' } : {}), studio: glass } } : {}),
    captionTracks: [
      {
        language: 'es',
        by: 'local',
        model: 'text-small',
        createdAt: '2026-11-15T09:30:00.000Z',
        segments: SEGMENTS.map((s, i) => ({ id: s.id, text: `Texto ${i} ${s.text}`, src: i === 3 ? 'stale' : textHash(s.text) }))
      },
      { language: 'bn', by: 'openai', host: 'api.groq.com', model: 'm', createdAt: '2026-11-15T09:40:00.000Z', segments: SEGMENTS.slice(0, 4).map((s) => ({ id: s.id, text: `বাংলা ${s.text}`, src: textHash(s.text) })) }
    ],
    bleeps: [
      { id: 'b1', start: 22.75, end: 24.2, word: '01712', sound: 'tone' },
      { id: 'b2', start: 28.15, end: 28.95, word: 'hunter', sound: 'silence', auto: true }
    ],
    publish: { description: 'Card 4917 6123 4567 8904 and hunter two.' } as Project['publish'],
    guide: {
      title: 'Pay with card 4917 6123 4567 8904',
      intro: 'The code is 482913.',
      language: 'en',
      steps: [{ key: 'c12000', title: 'Click Save', text: 'Card 4917 6123 4567 8904' }],
      added: [{ key: 'a20000', t: 20, title: 'Type hunter two', text: 'jane.doe@example.com' }]
    },
    effects: { ...p.effects, motionBlur: 0.6, keystrokes: { show: true, position: 'bottom', size: 0.03 } },
    audio: { ...p.audio, fadeIn: 0.5, fadeOut: 1 },
    soundFx: { titles: 'sfx:whoosh-soft', volume: 0.35 }
  } as unknown as Project
}

/** A bug report saved by wave 12: Expected, Actual at a time, details, and a bleep inside the shot's time. */
function wave12Bug(): Project {
  const p = base('w12bug', 30, { hasWebcam: false })
  return {
    ...p,
    createdAt: '2026-11-16T10:00:00.000Z',
    clips: [{ id: 'a', start: 0, end: 30, speed: 1 }],
    shapes: [{ id: 'h1', start: 5, end: 20, kind: 'pixelate', x: 0.3, y: 0.3, w: 0.2, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 }],
    transcript: { language: 'en', provider: 'openai', model: 'whisper-1', createdAt: '2026-11-16T09:00:00.000Z', segments: SEGMENTS.slice(0, 6) },
    bleeps: [{ id: 'b1', start: 5.95, end: 7.15, word: '6123', sound: 'tone', auto: true }],
    guide: {
      kind: 'bug',
      title: 'Export fails',
      expected: 'The card 4917 6123 4567 8904 is saved',
      actual: 'It says the code 482913 is wrong',
      actualAt: 12,
      details: [{ text: 'Windows 11' }, { text: 'Flown 1.12', off: true }]
    }
  } as unknown as Project
}

/** A Bangla project saved by wave 12 with an ordinary bleep. */
function wave12Bangla(): Project {
  const p = base('w12bn', 20, { hasWebcam: false })
  return {
    ...p,
    createdAt: '2026-11-17T10:00:00.000Z',
    clips: [{ id: 'a', start: 0, end: 20, speed: 1 }],
    transcript: {
      language: 'bn',
      provider: 'local',
      model: 'speech-bn',
      createdAt: '2026-11-17T09:00:00.000Z',
      segments: [words('k1', 1, 'আমার কার্ড নম্বর চার নয় এক সাত'), words('k2', 6, 'এখন আমরা সেটিংস খুলব'), words('k3', 11, 'কোড হলো চার আট দুই নয়')]
    },
    bleeps: [{ id: 'b1', start: 6.75, end: 7.15, word: 'আমরা', sound: 'tone' }],
    chapters: [{ id: 'ch1', t: 0, title: 'শুরু' }]
  } as Project
}

interface ProjectFixture {
  name: string
  raw: unknown
}

/** Every project the guard loads: the earlier guards' files, their scenes, and projects of waves 12. */
function projectFixtures(): ProjectFixture[] {
  const out: ProjectFixture[] = []
  for (const f of load('vertical-old-projects.json')) out.push({ name: `vertical ${f.name}`, raw: f.raw })
  for (const f of load('wave8-old-projects.json')) out.push({ name: `wave8 ${f.name}`, raw: f.raw })
  for (const f of load('captions-old-projects.json')) out.push({ name: `captions ${f.name}`, raw: f.raw })
  for (const s of sceneFixtures()) out.push({ name: `scene ${s.name}`, raw: JSON.parse(JSON.stringify(s.project)) })
  out.push({ name: 'wave12 full', raw: JSON.parse(JSON.stringify(wave12Project('full'))) })
  out.push({ name: 'wave12 plain', raw: JSON.parse(JSON.stringify(wave12Project('plain'))) })
  out.push({ name: 'wave12 bug', raw: JSON.parse(JSON.stringify(wave12Bug())) })
  out.push({ name: 'wave12 bangla', raw: JSON.parse(JSON.stringify(wave12Bangla())) })
  return out
}
const FIXTURES = projectFixtures()

/** A fixture loaded as the editor holds it; files without clips get a clip whose new id is named here so the bytes compare. */
function loaded(f: ProjectFixture): Project {
  const p = migrateProject(structuredClone(f.raw))
  if (!Array.isArray((f.raw as { clips?: unknown }).clips)) p.clips = [{ ...p.clips[0], id: '(generated)' }]
  return p
}

/** The fixtures that are whole projects (the captions file's data alone is not). */
const PROJECTS = FIXTURES.filter((f) => f.name !== 'captions caption-data').map((f) => ({ name: f.name, project: loaded(f) }))

/* ---------- projects: load and write ---------- */

describe('test 20: old projects load and are written as before', () => {
  it('loads every fixture', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(27)
  })
  for (const f of FIXTURES) {
    it(`${f.name}: migrateProject then projectFileText, pretty and compact, give the same bytes`, () => {
      const p = loaded(f)
      const pretty = projectFileText(p)
      const compact = projectFileText(p, 'compact')
      expect(pretty).toBe(JSON.stringify(p, null, 2))
      expect(compact).toBe(JSON.stringify(p))
      pinned('project', f.name, pretty)
      // Reading the written file again gives the same project (a file without clips gets a clip with a new id).
      if (Array.isArray((f.raw as { clips?: unknown }).clips)) expect(migrateProject(JSON.parse(pretty))).toEqual(p)
    })
  }
})

/* ---------- drawing ---------- */

interface DrawCase {
  name: string
  project: Project
  track: CursorTrack
  alpha?: 'background' | 'overlays'
  compare?: boolean
}

function drawCases(): DrawCase[] {
  const out: DrawCase[] = []
  for (const { name, project } of PROJECTS) {
    if (name.startsWith('scene ')) continue
    out.push({ name, project, track: seededTrack(rng(2000 + out.length), project.duration) })
  }
  for (const s of sceneFixtures()) out.push({ name: `scene ${s.name}`, project: s.project, track: s.track })
  const full = PROJECTS.find((p) => p.name === 'wave12 full')!.project
  const track = seededTrack(rng(2101), full.duration)
  out.push({ name: 'wave12 full, see-through background', project: full, track, alpha: 'background' })
  out.push({ name: 'wave12 full, see-through overlays', project: full, track, alpha: 'overlays' })
  out.push({ name: 'wave12 full, Compare', project: full, track, compare: true })
  return out
}

const FPS = 30

/** Calls with canvases numbered by first use and canvas arguments named, so only what is drawn where counts. */
function stripped(log: Call[]): unknown[] {
  const order = new Map<number, number>()
  const local = (id: number): number => {
    if (!order.has(id)) order.set(id, order.size)
    return order.get(id)!
  }
  return log.map((c) => ({
    ...c,
    canvas: local(c.canvas),
    args: JSON.stringify(c.args, (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? `canvas${local((v as unknown as { id: number }).id)}` : v))
  }))
}

/** The scene as Editor.tsx builds it (cropView of the project and its track). */
function sceneOf(c: DrawCase): { scene: Record<string, unknown>; w: number; h: number; src: Record<string, unknown> } {
  const { project } = c
  const view = cropView(project, c.track)
  const scene = {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, project.duration, project.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, project.duration),
    ...(view.crop ? { crop: view.crop } : {}),
    ...(c.alpha ? { alpha: c.alpha } : {}),
    ...(c.compare ? { compare: true } : {})
  }
  const { width: w, height: h } = outputSize(project.style.aspectRatio, project.width, project.height, 1080)
  const webcam = project.hasWebcam ? { readyState: 4, videoWidth: 1280, videoHeight: 720 } : null
  const src = {
    screen: { readyState: 4, videoWidth: project.width, videoHeight: project.height },
    webcam,
    background: null,
    screenFrame: { image: { tag: 'screen frame' }, width: project.width, height: project.height },
    ...(webcam ? { webcamFrame: { image: { tag: 'camera frame' }, width: 1280, height: 720 } } : {})
  }
  return { scene, w, h, src }
}

/** 24 export frames of `project` at 30 fps: around every cut and join, every shape, spotlight and title, then seeded ones. */
function sampled(project: Project, seed: number): { times: number[]; pictures: number[]; held: Uint8Array | null; picked: number[] } {
  const { times, pictures, held } = videoFrames(project.clips, planOf(project), FPS)
  const n = times.length
  const want = new Set<number>()
  const add = (i: number): void => {
    if (i >= 0 && i < n) want.add(i)
  }
  const firstAtOrAfter = (s: number): number => {
    for (let i = 0; i < n; i++) if (times[i] >= s) return i
    return -1
  }
  for (const w of joinPlan(project)) {
    add(Math.ceil(w.from * FPS))
    add(Math.floor(((w.from + w.to) / 2) * FPS))
  }
  project.clips.forEach((c, i) => {
    if (i > 0) add(firstAtOrAfter(c.start))
  })
  for (const s of [...(project.shapes ?? []), ...(project.spotlights ?? []), ...(project.titles ?? [])]) add(firstAtOrAfter(s.start + 0.2))
  let list = [...want].sort((a, b) => a - b)
  if (list.length > 16) list = Array.from({ length: 16 }, (_, k) => list[Math.floor((k * list.length) / 16)])
  const r = rng(seed)
  const picked = new Set(list)
  while (picked.size < Math.min(24, n)) picked.add(Math.floor(r() * n))
  return { times, pictures, held, picked: [...picked].sort((a, b) => a - b) }
}

/** The digests of the 24 frames' call logs, drawn as the export draws them (joins' stills composed as the export composes them; motion blur on odd frames). */
function framesOf(c: DrawCase, seed: number): string[] {
  const { scene, w, h, src } = sceneOf(c)
  const { times, pictures, held, picked } = sampled(c.project, seed)
  const windows = joinPlan(c.project)
  const stills = new Map<number, unknown>()
  const out: string[] = []
  for (const i of picked) {
    const at = windows.length ? joinAt(windows, i / FPS) : null
    let still: unknown = null
    if (at?.window.still) {
      if (!stills.has(at.window.index)) {
        calls.length = 0
        const target = canvas()
        const scratch = joinLayer.scratchTarget('cpu', w, h)
        joinLayer.composeJoinStill(scratch, target, w, h, at.window, scene, { screen: { image: { tag: 'still' }, width: c.project.width, height: c.project.height }, camera: null }, null)
        out.push(`still ${at.window.index}:${digest(stripped(calls))}`)
        stills.set(at.window.index, target)
      }
      still = stills.get(at.window.index)
    }
    const target = canvas()
    const ctx = (target.getContext as (t: string) => unknown)('2d')
    calls.length = 0
    const options = held?.[i] ? { frameInterval: 1 / FPS, blurSamples: 1 } : i % 2 ? { frameInterval: 1 / FPS, blurSamples: 10 } : { blurSamples: 4 }
    drawFrame(ctx, w, h, pictures[i], scene, src, options, times[i], { video: i / FPS, join: at ? { at, still } : null })
    out.push(`${i}:${digest(stripped(calls))}`)
  }
  return out
}

describe('test 20: drawFrame and the join layer draw the same calls', () => {
  const cases = drawCases()
  it('draws blur and pixelate shapes, crops, a grade with a LUT, Compare, motion blur, magnifiers, joins, freezes, the tilt, a title card on the blurred frame, the Glass look and both see-through modes', async () => {
    const full = cases.find((c) => c.name === 'wave12 full')!.project
    expect(full.crop).toBeDefined()
    expect(full.grade?.screen?.lut).toBeDefined()
    expect(full.tilt?.enabled).toBe(true)
    expect(full.spotlights?.every((s) => s.magnify)).toBe(true)
    expect(full.titles?.[0].background).toBe('blur')
    expect(full.captions?.studio?.box.kind).toBe('glass')
    expect(joinPlan(full).map((w) => w.kind)).toEqual(['crossfade', 'slide'])
    expect(cases.map((c) => c.alpha ?? null)).toContain('overlays')
    expect(cases.some((c) => c.compare)).toBe(true)
    // The LUT is loaded before the first frame, as the export loads it.
    await prepareLuts(full)
    expect(lutFor(full, 'screen')).not.toBeNull()
  })
  cases.forEach((c, n) => {
    it(`${c.name}: the same 24 frames`, () => {
      const frames = framesOf(c, 9300 + n)
      expect(frames.filter((f) => !f.startsWith('still')).length).toBe(Math.min(24, videoFrames(c.project.clips, planOf(c.project), FPS).times.length))
      pinned('frames', c.name, frames)
    })
  })
})

/* ---------- sound ---------- */

describe('test 20: gains and soundtrack graphs', () => {
  for (const { name, project } of PROJECTS) {
    it(`${name}: jobSoundGains, bleepGains and the soundtrack graph of its gains`, () => {
      const sounds = jobSoundGains(project)
      const gains = bleepGains(project)
      const job: ExportJob = {
        width: 0,
        height: 0,
        fps: 60,
        frames: 600,
        format: 'm4a',
        quality: 'high',
        video: { kind: 'none' },
        outputPath: '/o.m4a',
        audio: { clips: project.clips, volume: 1, ...(sounds ? { sounds } : {}) }
      }
      const graph = planSoundtrack(job, { mix: '/p/screen.mp4', stems: { mic: '/p/mic.m4a', system: '/p/system.m4a' }, music: null }, 0)
      pinned('sound', name, { sounds: sounds ?? null, gains, graph })
    })
  }
})

/* ---------- captions and text ---------- */

/** Every text made from a project's captions that exists today. */
function textsOf(project: Project): unknown {
  const segments = project.transcript?.segments ?? []
  const languages = [project.transcript?.language ?? 'und', ...(project.captionTracks ?? []).map((t) => t.language)]
  const items = reviewItems(project)
  return {
    masked: maskedSegments(segments, project.bleeps),
    burned: burnedSegments(project),
    spoken: spokenSegments(project),
    cues: languages.map((l) => trackCues(project, l)),
    bleepedTexts: [...segments.map((s) => s.text), ...(project.chapters ?? []).map((c) => c.title), ...(project.titles ?? []).map((t) => t.title)].map((t) => maskBleeped(t, project.bleeps)),
    files: (['srt', 'vtt', 'txt'] as const).map((f) => [null, ...languages.slice(1)].map((l) => languageSubtitleFile(project, l, f))),
    review: items,
    pending: pendingCount(project),
    statuses: items.map((i) => reviewStatus(project, i)),
    summary: versionSummary(project)
  }
}

describe('test 20: texts made from captions, Review and search', () => {
  for (const { name, project } of PROJECTS) {
    it(`${name}: captions, subtitles, bleep masks, Review and the version summary`, () => {
      pinned('texts', name, textsOf(project))
    })
  }
  for (const f of FIXTURES) {
    it(`${f.name}: the search index`, () => {
      pinned('search', f.name, { units: projectUnits(structuredClone(f.raw)), indexed: indexedProject(structuredClone(f.raw), 'stamp') })
    })
  }
  it('changedAreas of every fixture against itself and against changed copies', () => {
    const out: unknown[] = []
    for (const { project } of PROJECTS) {
      const changes: Project[] = [
        project,
        { ...project, shapes: [...(project.shapes ?? []), { id: 'zz', start: 1, end: 2, kind: 'blur', x: 0.1, y: 0.1, w: 0.1, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 }] },
        { ...project, bleeps: [...(project.bleeps ?? []), { id: 'zz', start: 1, end: 1.4, word: 'word', sound: 'tone' }] },
        { ...project, chapters: [...(project.chapters ?? []), { id: 'zz', t: 1, title: 'New' }] },
        { ...project, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
        { ...project, name: `${project.name} 2` }
      ]
      out.push(changes.map((c) => [changedAreas(project, c), changedAreas(c, project)]))
    }
    pinned('versions', 'changedAreas', out)
  })
})

/* ---------- AI requests ---------- */

/** The requests the pure builders make for `project`, as each call site sends them. */
function requestsOf(project: Project): { name: string; request: AiTextRequest }[] {
  const out: { name: string; request: AiTextRequest }[] = []
  const segments = project.transcript?.segments ?? []
  if (!segments.length) return out
  const language = project.transcript?.language
  out.push({ name: 'marks', request: { task: 'marks', segments, marks: { ...(language ? { language } : {}), captions: [] } } })
  out.push({ name: 'cleanup', request: { task: 'cleanup', segments } })
  for (const code of ['es', 'bn', 'fr']) {
    const sent = captionsToTranslate(project, code)
    if (sent.length) out.push({ name: `translate ${code}`, request: { task: 'translate', segments: sent, targetLanguage: code } })
  }
  out.push({ name: 'chapters', request: { task: 'chapters', segments: [...spokenSegments(project)] } })
  for (const task of ['title', 'summary'] as const) out.push({ name: task, request: { task, segments: [...spokenSegments(project)] } })
  const starts = (project.chapters ?? []).map((c) => c.t)
  out.push({ name: 'chapter names', request: { task: 'names', names: namesRequestForChapters(project, starts.length ? starts : [project.clips[0]?.start ?? 0]), segments: [] } })
  const moments = [
    { start: 0, end: Math.min(15, project.duration) },
    { start: project.duration / 2, end: project.duration }
  ]
  out.push({ name: 'clip names', request: { task: 'names', names: namesRequestForMoments(project, moments), segments: [] } })
  const pack = publishSegments(project)
  for (const kind of PUBLISH_KINDS) {
    out.push({ name: `pack ${kind}`, request: packRequest(kind, { providerId: 'p', segments: pack, tone: 'friendly', length: 'medium', context: { title: project.name, chapters: (project.chapters ?? []).map((c) => c.title) }, key: 'k' }) })
  }
  const steps = findSteps({ track: seededTrack(rng(4100), project.duration), project, scan: null })
  for (const kind of ['step', 'note'] as const) out.push({ name: `guide ${kind}s`, request: { task: 'names', names: namesRequestForSteps(project, steps, kind), segments: [] } })
  return out
}

describe('test 20: AI requests', () => {
  for (const { name, project } of PROJECTS) {
    it(`${name}: every request and the prompts main makes of it; maskRequest returns each as the same object`, () => {
      const requests = requestsOf(project)
      for (const r of requests) expect(maskRequest(r.request, project), r.name).toBe(r.request)
      pinned(
        'ai',
        name,
        requests.map((r) => ({ name: r.name, request: r.request, prompts: textPrompts(r.request) }))
      )
      pinned('ai segments', name, { pack: publishSegments(project), guide: guideSegments(project), marks: marksBatches(project.transcript?.segments ?? [], project.transcript?.language) })
    })
  }
})

/* ---------- texts made from captions: the private view ---------- */

describe('test 20: privateView of every fixture is the fixture itself', () => {
  for (const { name, project } of PROJECTS) {
    it(`${name}: the same object`, () => {
      expect(privateView(project)).toBe(project)
    })
  }
})

/* ---------- settings and presets ---------- */

interface StoredValues {
  settings: string[]
  batch: string[]
  bundle: string[]
}
const STORED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'export-settings-old.json'), 'utf8')) as StoredValues

/** Bundle choices of wave 12 (stems, timelines and the original recordings' timeline). */
const BUNDLES_12 = [
  '{"srt":true,"vtt":false,"chapters":true,"thumbnail":false,"description":true,"perChapter":false,"stems":true}',
  '{"srt":false,"vtt":false,"chapters":false,"thumbnail":false,"description":false,"perChapter":false,"timelines":["resolve","premiere"]}',
  '{"srt":false,"vtt":true,"chapters":false,"thumbnail":true,"description":false,"perChapter":false,"timelines":["finalcut"],"timelineMedia":"recordings"}',
  '{"srt":false,"vtt":false,"chapters":false,"thumbnail":false,"description":false,"perChapter":true,"stems":true,"timelines":["resolve","premiere","finalcut","edl"],"timelineMedia":"recordings"}'
]

/** The user's export presets as wave 12 stores them. */
const USER_PRESETS = {
  version: 1,
  presets: [
    {
      id: 'user:0123456789ab',
      name: 'Team review',
      options: { format: 'mp4', resolution: 1080, fps: 30, quality: 'medium', encoder: 'auto', aspect: '16:9' },
      bundle: { srt: true, vtt: false, chapters: true, thumbnail: false, description: false, perChapter: false, timelines: ['premiere', 'edl'], timelineMedia: 'recordings' },
      saved: 1763200000000
    },
    { id: 'user:abcdefabcdef', name: 'বাংলা GIF', options: { format: 'gif', resolution: 720, fps: 15, quality: 'small', encoder: 'software' }, saved: 1763300000000 }
  ]
}

/** An editor-prefs.json as wave 12 writes it: every key it knows. */
const PREFS = {
  stylePresets: [{ id: 'p1', name: 'Mine', look: {} }],
  shortcuts: { addZoom: 'Z' },
  polish: { styleId: null, zoom: true, silences: true, silenceAction: 'cut', smoothCuts: true, captions: true, captionsProvider: null, captionLook: true, chapters: true, director: true },
  captionsGreat: { tidy: true },
  captionWordList: [{ word: 'Flown', kind: 'keep' }],
  aiConfirm: 'always',
  guide: { names: 'offline' },
  findChapters: { split: 'offline', names: 'offline' },
  shortClips: { length: 'short' },
  exportPresets: USER_PRESETS,
  ui: { language: 'en' }
}

describe('test 20: stored settings, presets and preferences are read and written back byte for byte', () => {
  STORED.settings.forEach((stored, i) => {
    it(`export-settings ${i}`, () => {
      expect(JSON.stringify(presets.normalizeOptions(JSON.parse(stored)))).toBe(stored)
    })
  })
  ;[...STORED.bundle, ...BUNDLES_12].forEach((stored, i) => {
    it(`export-bundle ${i}`, () => {
      expect(JSON.stringify(normalizeBundle(JSON.parse(stored)))).toBe(stored)
    })
  })
  it('the original recordings stay a bundle choice of stored values', () => {
    expect(normalizeBundle(JSON.parse(BUNDLES_12[2])).timelineMedia).toBe('recordings')
  })
  it('user presets', () => {
    const read = readUserPresets(structuredClone(USER_PRESETS))
    pinned('settings', 'userPresets', read)
    expect(readUserPresets(JSON.parse(JSON.stringify(read)))).toEqual(read)
  })
  it('editor-prefs.json: every key reads as before and writing each back leaves the file as it was', () => {
    const file = path.join(ROOT, 'userData', 'editor-prefs.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const text = JSON.stringify(PREFS, null, 2)
    fs.writeFileSync(file, text)
    const read = Object.fromEntries(Object.keys(PREFS).map((k) => [k, readPrefSync(k as never)]))
    pinned('settings', 'prefs', read)
    for (const k of Object.keys(PREFS)) writePrefSync(k as never, readPrefSync(k as never))
    pinned('settings', 'prefsFile', fs.readFileSync(file, 'utf8'))
  })
})

/* ---------- Polish ---------- */

/** The steps and option keys of today (a later step or option is not part of these values). */
const POLISH_STEPS_TODAY = ['style', 'zoom', 'silences', 'smoothCuts', 'captions', 'chapters', 'captionLook', 'director']
const OPTION_KEYS_TODAY = ['styleId', 'zoom', 'silences', 'silenceAction', 'smoothCuts', 'captions', 'captionsProvider', 'captionLook', 'chapters', 'director']
const todays = (o: object): Record<string, unknown> => Object.fromEntries(OPTION_KEYS_TODAY.map((k) => [k, (o as Record<string, unknown>)[k]]))

describe('test 20: Polish with saved options', () => {
  const saved: Record<string, unknown> = {
    'wave 9': { styleId: null, zoom: true, silences: true, silenceAction: 'cut', captions: false, captionsProvider: null, director: true },
    'wave 12': PREFS.polish,
    'zoom only': { zoom: true, silences: false, captions: false, director: false }
  }
  it('saved options read as before', () => {
    pinned('polish', 'options', Object.entries(saved).map(([k, v]) => [k, todays(readPolishOptions(v))]))
    pinned('polish', 'defaults', todays(DEFAULT_POLISH_OPTIONS))
  })
  for (const { name, project } of PROJECTS.filter((p) => /^(wave12|wave8|vertical)/.test(p.name))) {
    it(`${name}: planPolish plans the same project and steps`, () => {
      const out: unknown[] = []
      for (const [label, raw] of Object.entries(saved)) {
        const r = planPolish(
          {
            project,
            recorded: seededTrack(rng(5100), project.duration),
            sound: [{ start: 0, end: project.duration }],
            transcript: null,
            speech: null,
            framing: { status: 'skipped' } as never,
            preset: null,
            newId: (() => {
              let n = 0
              return () => `n${++n}`
            })()
          },
          readPolishOptions(raw)
        )
        const { steps, ...summary } = r.summary
        out.push({ label, project: r.project, steps: steps.filter((s) => POLISH_STEPS_TODAY.includes(s.step)), summary, director: r.directorPlan })
      }
      pinned('polish', name, out)
    })
  }
})

/* ---------- the guide ---------- */

describe('test 20: guide shot signatures', () => {
  for (const { name, project } of PROJECTS) {
    it(`${name}: planShot, planFrame and planActual of every step`, () => {
      const track = seededTrack(rng(6100), project.duration)
      const guided = guideProject(project)
      const steps = findSteps({ track, project: guided, scan: null })
      const edits = new Map((guided.guide?.steps ?? []).map((e) => [e.key, e]))
      const out = steps.map((s) => ({
        key: s.key,
        guide: planShot(s, guided, edits.get(s.key), 1, 'guide').sig,
        demo: planShot(s, guided, edits.get(s.key), 1.5, 'demo').sig,
        frame: planFrame(s, guided, edits.get(s.key)).sig
      }))
      const actual = [0, 6, 12, project.duration / 2].map((t) => planActual(guided, t).sig)
      pinned('guide', name, { project: guided === project, steps: out, actual })
    })
  }
})

/* ---------- Home ---------- */

describe("test 20: Home's summaries", () => {
  it('listProjects lists the fixture folder as before', async () => {
    const videos = path.join(ROOT, 'videos', 'Flown')
    fs.mkdirSync(videos, { recursive: true })
    for (const { project } of PROJECTS) {
      const dir = path.join(videos, project.id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
    }
    const list = await listProjects()
    expect(list.map((s) => s.createdAt)).toEqual(list.map((s) => s.createdAt).sort().reverse())
    // The one field auto-blur adds (§9 row 17): the boxes Home fills over a thumbnail, present only for a
    // project with a cover or a blur or pixelate shape about the thumbnail's time (min(1 s, 15%)). Every
    // field of today is compared without it.
    for (const s of list) {
      const p = PROJECTS.find((x) => x.project.id === s.id)!.project
      const t = Math.min(1, p.duration * 0.15)
      const shaped = (p.shapes ?? []).some((h) => (h.kind === 'blur' || h.kind === 'pixelate') && h.start <= t + 0.1 && h.end > t - 0.1)
      expect('thumbCovers' in s, s.id).toBe(shaped || !!p.covers?.length)
    }
    // Summaries with the same creation time come in folder order: compared by id.
    pinned(
      'home',
      'listProjects',
      list
        .map((s) => {
          const { thumbCovers: _boxes, ...today } = s as typeof s & { thumbCovers?: unknown }
          void _boxes
          return { ...today, dir: path.relative(ROOT, s.dir).split(path.sep).join('/') }
        })
        .sort((a, b) => a.id.localeCompare(b.id))
    )
  })
})
