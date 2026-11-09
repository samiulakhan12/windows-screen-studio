import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExportJob, FfmpegVideoEncoder } from '../src/shared/api/export'
import type { CaptionSegment, CursorTrack, Project } from '../src/shared/types'
import { digest, rng, sceneFixtures, seededTrack } from './verticalFixtures'

/*
 * The equivalence guard of output and the app (docs/design/output-and-languages.md §21.0 and §23.2:
 * tests 1, 2, 3 and 4), pinned against the code after waves 10 and 11 merged and before any shared
 * file of this wave changed (be3cbdc). Wave 12 only adds optional fields (§4) and new paths behind
 * them, so for everything that exists today every value here stays the same bit for bit after the
 * contracts and after every part merges: what old projects load to, how stored export settings are
 * read and written back, every ffmpeg argument list and soundtrack graph, and what drawFrame and the
 * join layer draw. Values are digests of their exact JSON (tests/verticalFixtures.ts digest), or the
 * stored strings themselves; a changed digest names the fixture and the function. The snapshots are
 * never regenerated to make a change pass.
 */

/* ---------- canvases that record their calls (as tests/editingEquivalence.test.ts) ---------- */

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
}
const calls: Call[] = []
let canvases = 0
/** Options each canvas's context was asked for, by canvas id. */
const contextOptions = new Map<number, unknown>()

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
      dash: target.lineDashOffset
    })
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
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
  c.getContext = (type: string, options?: unknown) => {
    if (type !== '2d') return null
    if (!contextOptions.has(id)) contextOptions.set(id, options ?? null)
    return ctx
  }
  c.toBlob = (cb: (b: null) => void) => cb(null)
  return c
}

vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

const { migrateProject, createProject } = await import('../src/shared/engine/project')
const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { outputSize } = await import('../src/shared/engine/layout')
const { planOf, videoFrames } = await import('../src/shared/engine/freeze')
const { joinAt, joinPlan } = await import('../src/shared/render/joins')
const { planSoundtrack } = await import('../src/shared/render/audioPlan')
const presets = await import('../src/shared/render/exportPresets')
const { normalizeBundle } = await import('../src/shared/render/exportBundle')
const { exportRoutes, routeLabel, exportSize, exportProject, isAudioOnly, videoCodecOf } = await import('../src/shared/render/exportPlan')
const { ffmpegPlan, gifEncodeArgs, gifPaletteArgs, nextGifFit, describeGifFit } = await import('../src/main/exportArgs')
const { validateJob } = await import('../src/main/exportJob')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number; frameInterval?: number }, soundTime?: number, extras?: unknown) => void
const COMPOSITOR = '../src/renderer/src/render/compositor'
const JOIN_LAYER = '../src/renderer/src/render/joinLayer'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
const joinLayer = (await import(/* @vite-ignore */ JOIN_LAYER)) as {
  scratchTarget(raster: 'gpu' | 'cpu', w: number, h: number): { canvas: Record<string, unknown> }
  composeJoinStill(scratch: unknown, out: unknown, w: number, h: number, window: unknown, scene: unknown, stills: unknown, background: null): void
  endJoin(ctx: unknown, w: number, h: number, join: unknown): void
  releaseScratch(): void
}

/** The digests of today's outputs (be3cbdc), by section and name. */
const SNAPSHOT: Record<string, Record<string, string>> = {
  project: {
    'vertical 16:9': '04b202012f7718e8ee675a5bf76d677b',
    'vertical 9:16': '5f6e141d4b9771e0eaf9074cd136338b',
    'vertical 1:1': '8b12516ba08f5c5a8cb867bfb624b221',
    'wave8 publish-pack': '0734ea033ee5306563158006e66c1b97',
    'wave8 review-mode': 'ee713de7cd94ad7e484552efd63474ea',
    'wave8 sound-finder': '225c27befc771ad0ddac4c8abc6fded9',
    'captions nw09-speakers': 'c916adb2a35c7a9f2232a4ebca799caf',
    'captions tall-karaoke': 'ca521dc07dd91400f2b8b8157436ff8a',
    'captions caption-data': 'bb317e748ce8c53c8f0c0e8bb23ec7a5',
    'captions default-look': '3f1ba14773b81d08932983cfd1f63bda',
    'captions minimal-hidden': 'fcccf73646eb246353c0f0ff7c6020cc',
    'scene wide-auto': '6b6d58ac74510f1e9150bc35a7e51277',
    'scene tall-fitted': '04ff985e8d44efab64f631672dfa4532',
    'scene square-fitted': 'fdc340cc52f31181b199bd88380c88e0',
    'scene wide-corners': 'fe5ab934806d903bee37223bb59e9862',
    'scene wide-side': '4ee95d9d8258ff343b16fee9b01e4096',
    'scene tall-layouts': '014a178c1c45ab6a377abb7fc7d91001',
    'scene square-corners': '0f906d89fc4c254c914f5981927b64ad',
    'scene crop-wide': '6eb28683da948de4a12324ed2bb15451',
    'scene crop-tall': '158bda87accd2aecee3cd10e1d0ca636',
    'scene frame-browser': '6bb4eee7103b85316f5de6f3326ee3b9',
    'scene frame-laptop-tall': '94db5862837f660e40358a3a1ee5caca',
    'scene window-43': 'be30ba1cf9e01eadaf8c88b5f5fb6049',
    'wave 10': 'f00dd07e95372a26237aa78b73b7b9f2',
    'wave 11': '214a1629fe68c0719bb05567d1214e59'
  },
  odd: {
    settings: 'c0ab02c16106c379d946bf0c83ae2cf4',
    bundle: '4bf09d39f6f35e5323726552d89909e9'
  },
  presets: {
    applied: 'c2f8f00a5e6a1ef8c9ffc1f1af568573'
  },
  tweaks: {
    'youtube-1080': '872cba48a51a2a26c7a19edd32cbf68d'
  },
  batch: {
    items: 'd9c15f182ce364df01d6adcb5c61bfb4',
    names: 'c357ae0e77f0a3d4b20a62dfab77ddeb',
    m4a: '8cd6deef22e8674dbe8c3d532b2890f9'
  },
  plan: {
    'mp4 raw libx264': 'eb3c1a12c3ea297335116bc0eb88a726',
    'mp4 raw h264_nvenc': '36703901a1c7620416aa4be85fe1f250',
    'mp4 raw h264_qsv': 'b7e3cf2469b78f85a876e7a3d3a3b50d',
    'mp4 raw h264_amf': '1bc84df400de371b82198bbd29ada37b',
    'mp4 raw h264_mf': '2aefa28c35ddb3d60c57ef5c39580d44',
    'mp4 raw rgba libx264': '87724134dfec690d52d76c056fcc4d39',
    'mp4 webcodecs h264': '27d90091821be81d9784ba407e2cc96e',
    'mov raw libx264': '38de17beaef9150b6e3c186a6532c68d',
    'mov raw h264_nvenc': '061709a86dbc1159fd31c1026b797f1b',
    'mov raw h264_qsv': '30ec2432d72371a58e61150eac8aa7c4',
    'mov raw h264_amf': '82cb5fb75bf140f035637cf45a945696',
    'mov raw h264_mf': 'eacbb65f00205c3968be443e80cb63c3',
    'mov raw rgba libx264': '08834f89db0fa1dc664c5326516c0674',
    'mov webcodecs h264': '8795ae4ec3ec8e18698a41b7c272a0cb',
    'webm raw libvpx-vp9': '2d14fa5eafa4b1136cb455440177acbd',
    'webm webcodecs vp9': '946f6eac1377f22676f9ba7f99080a7c',
    'gif raw': '80a8d7b7791f1891cc003697c7ec12bf',
    m4a: 'eb19d1e750f0a73891cb87608081ade6',
    'with chapters and subtitles': '0e5f7b6445278ddd7a96d4f59d56dd4d',
    'silent and clicks': '255deb0aab8e9b37705aa5b6229e917a'
  },
  gif: {
    fits: 'b583e80c93dd130087a6e6848157b1a7'
  },
  sound: {
    plain: '70fdba7315be43d709420d7f7c43072d',
    stems: 'e2f25296975da0f0a538a3f483943660',
    'stems one': 'fffa20af7c929b0e3382ead6ab268e36',
    'noise and loudness': '9762ef3300f9902ab2147e2b34e5168a',
    'stems noise loudness': 'e2e940dd462925864129a9add2a2b8de',
    holds: '7c5c489be67ce6bc6d1ddb7a74df97f9',
    'cut fades': '399e988922f4fdecd7f48c377ac3671b',
    sounds: '419d4c8c28fe02c6d39f52b6746223dc',
    voice: '7ac8b0e4a0945db58f86a6cd6a013d91',
    music: '3699162d4f3972fc7341cedb38cb8de4',
    'music ducked': '0e1afc4bb2b144e6d9fcb834dd0bdb52',
    'music only': 'fc97760bc287adc0bdef6f7ec9436b21',
    clicks: 'bf7200325d55f4eb739765048d3d3405',
    pops: '8c84b916dae41e527c926135fece2d0b',
    tones: 'a0b51f8890e45a0085bc18bc9c25e6cc',
    fades: 'c945bce0ec2824a555604bf4ee5497e1',
    everything: '7990671aeb219e532dc2c03eca5f2e29',
    video: '2da3c84c3089c971422357a92aca7686'
  },
  routes: {
    all: 'e3dc988fc535831cd3af2478ade709cc',
    codecs: '2a7a2d237defe8ffe57bae26a47eed41',
    sizes: 'b2cf740393fca77bca5a7c2bba412d50',
    exportProject: 'ac29052a70bb3848a5827272b309a3b8'
  },
  frames: {
    'old 16:9': 'd40af2cbb0a1cb1d3a0db38c16fbfb5d',
    'old 9:16': '76d89d88ef9517cc1fa40ba4e098b6ba',
    'scene wide-corners': '8c0e8f7312b644f6105d992abc5498fa',
    'scene frame-browser': 'dd5b2276157286251c8cb2a9dd1787b6',
    'wave 10': 'b324ceca4d54d50545f8140e63e81926',
    'wave 11': '66d7a6d075d5721402b0bc12cb8f19d2'
  },
  joins: {
    compose: 'bf4111d4414fb1f96ea18053b4937427',
    endJoin: '46543a9374ad80618b0210c900469ee9'
  }
}

/** A value compared with SNAPSHOT[section][name]. */
function pinned(section: string, name: string, value: unknown): void {
  expect(digest(value), `${section} of ${name}`).toBe(SNAPSHOT[section]?.[name])
}

/* ---------- fixtures: projects ---------- */

interface OldFixture {
  name: string
  raw: Record<string, unknown>
}
const load = (file: string): OldFixture[] => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))

const words = (id: string, start: number, text: string): CaptionSegment => {
  const list = text.split(' ')
  return { id, start, end: start + list.length * 0.4, text, words: list.map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.35 })) }
}

const base = (id: string, duration: number, over: { hasWebcam?: boolean; fps?: number } = {}): Project =>
  createProject({
    id,
    name: id,
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: over.hasWebcam ?? true,
    hasAudio: true,
    webcamOffset: 0.2,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: over.fps ?? 30 }
  })

/** A project saved by wave 10: cut styles with each kind, colour, the progress bar, sound effects and step badges. */
function wave10Project(): Project {
  const p = base('w10', 40)
  return {
    ...p,
    createdAt: '2026-10-01T10:00:00.000Z',
    clips: [
      { id: 'a', start: 0.5, end: 8, speed: 1 },
      { id: 'b', start: 9, end: 16, speed: 1 },
      { id: 'c', start: 17, end: 24, speed: 1.5 },
      { id: 'd', start: 25, end: 32, speed: 1 },
      { id: 'e', start: 33, end: 40, speed: 1 }
    ],
    zooms: [{ id: 'z1', start: 2, end: 6, scale: 2, focus: { mode: 'cursor' } }],
    chapters: [
      { id: 'ch1', t: 0.5, title: 'Start' },
      { id: 'ch2', t: 17, title: 'Middle' }
    ],
    annotations: [
      { id: 'b1', start: 3, end: 6, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge', number: 'auto', pin: { x: 0.3, y: 0.4 } },
      { id: 't1', start: 10, end: 13, text: 'Hello', x: 0.5, y: 0.2, size: 0.05, style: 'pill', enter: { kind: 'rise', duration: 0.35, strength: 1 }, exit: { kind: 'fade', duration: 0.2, strength: 1 } }
    ],
    joins: {
      all: { kind: 'crossfade', duration: 0.3 },
      cuts: [
        { clip: 'c', kind: 'dip', duration: 0.6, color: '#102030' },
        { clip: 'd', kind: 'slide', duration: 0.4, from: 'left' },
        { clip: 'e', kind: 'punch', scale: 1.1 }
      ]
    },
    grade: { screen: { look: 'vivid', contrast: 0.1 } },
    chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' },
    soundFx: { zoomIn: 'sfx:whoosh-soft', volume: 0.35 },
    transcript: {
      language: 'en',
      provider: 'local',
      model: 'speech-small',
      createdAt: '2026-11-01T09:00:00.000Z',
      segments: [words('k1', 2, 'Click the Save button now'), words('k2', 11, 'Then open the Export dialog'), words('k3', 26, 'That is all for today')]
    },
    effects: { ...p.effects, badgesByChapter: true }
  } as unknown as Project
}

/** A project saved by wave 11: a found chapter not reviewed yet, a guide's choices and a short clip's origin. */
function wave11Project(): Project {
  const p = base('w11', 60, { hasWebcam: false, fps: 60 })
  return {
    ...p,
    createdAt: '2026-11-02T10:00:00.000Z',
    clips: [
      { id: 'a', start: 0, end: 20, speed: 1 },
      { id: 'b', start: 24, end: 60, speed: 1 }
    ],
    chapters: [
      { id: 'ch1', t: 0, title: 'Intro' },
      { id: 'ch2', t: 30, title: 'Billing', auto: { by: 'find', from: ['page', 'pause'], name: 'sentence' } }
    ],
    guide: { title: 'How to export', intro: 'Three steps.', language: 'en', steps: [] },
    clipOf: { kind: 'moment', start: 12, end: 40, why: 'Opens with a question · 6 clicks' },
    transcript: {
      language: 'bn',
      provider: 'local',
      model: 'speech-bn',
      createdAt: '2026-11-02T09:00:00.000Z',
      segments: [words('k1', 2, 'এখন আমরা সেটিংস খুলব'), words('k2', 31, 'বিলিং পাতাটি দেখুন')]
    }
  } as Project
}

interface ProjectFixture {
  name: string
  raw: unknown
}

/** Every project test 1 loads: the earlier guards' files, their scenes, and a project from each of waves 10 and 11. */
function projectFixtures(): ProjectFixture[] {
  const out: ProjectFixture[] = []
  for (const f of load('vertical-old-projects.json')) out.push({ name: `vertical ${f.name}`, raw: f.raw })
  for (const f of load('wave8-old-projects.json')) out.push({ name: `wave8 ${f.name}`, raw: f.raw })
  for (const f of load('captions-old-projects.json')) out.push({ name: `captions ${f.name}`, raw: f.raw })
  for (const s of sceneFixtures()) out.push({ name: `scene ${s.name}`, raw: JSON.parse(JSON.stringify(s.project)) })
  out.push({ name: 'wave 10', raw: JSON.parse(JSON.stringify(wave10Project())) })
  out.push({ name: 'wave 11', raw: JSON.parse(JSON.stringify(wave11Project())) })
  return out
}

/* ---------- test 1 ---------- */

describe('old projects load to the same bytes (test 1)', () => {
  for (const f of projectFixtures()) {
    it(`${f.name}: the same JSON`, () => {
      const loaded = migrateProject(structuredClone(f.raw))
      // Files without clips get a clip with a new id: named here so the bytes compare.
      if (!Array.isArray((f.raw as { clips?: unknown }).clips)) loaded.clips = [{ ...loaded.clips[0], id: '(generated)' }]
      pinned('project', f.name, JSON.stringify(loaded))
    })
  }
})

/* ---------- test 2: stored export settings ---------- */

interface StoredValues {
  settings: string[]
  batch: string[]
  bundle: string[]
  /** Hand-edited or partial values: how today's code reads them. */
  odd: { key: 'settings' | 'batch' | 'bundle'; stored: string }[]
}
const STORED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'export-settings-old.json'), 'utf8')) as StoredValues

/** What the dialog writes back for a stored `export-bundle` value: the subtitle languages are never remembered. */
function bundleBack(stored: string): string {
  const b = normalizeBundle(JSON.parse(stored))
  delete b.languages
  return JSON.stringify(b)
}

describe('stored export settings are read and written back byte for byte (test 2)', () => {
  it('holds 40 stored values of the release before this wave', () => {
    expect(STORED.settings.length + STORED.batch.length + STORED.bundle.length).toBe(40)
    const read = STORED.settings.map((s) => JSON.parse(s) as Record<string, unknown>)
    expect(new Set(read.map((o) => o.format))).toEqual(new Set(['mp4', 'mov', 'webm', 'gif', 'm4a']))
    expect(new Set(read.map((o) => o.quality))).toEqual(new Set(['high', 'medium', 'small']))
    expect(new Set(read.map((o) => o.encoder))).toEqual(new Set(['auto', 'software']))
    expect(new Set(read.map((o) => o.preset).filter(Boolean))).toEqual(new Set(presets.EXPORT_PRESETS.map((p) => p.id).filter((id) => ['youtube-1080', 'youtube-4k', 'x', 'linkedin', 'reels', 'tiktok', 'shorts', 'square', 'slack-gif', 'email'].includes(id))))
    expect(new Set(read.map((o) => o.aspect).filter(Boolean))).toEqual(new Set(['auto', '16:9', '9:16', '1:1', '4:3']))
    expect(read.some((o) => typeof o.targetSizeMB === 'number')).toBe(true)
  })

  STORED.settings.forEach((stored, i) => {
    it(`export-settings ${i}: normalizeOptions and tweakOptions give the stored string back`, () => {
      const o = presets.normalizeOptions(JSON.parse(stored))
      expect(JSON.stringify(o)).toBe(stored)
      expect(JSON.stringify(presets.tweakOptions(o, {}))).toBe(stored)
    })
  })

  STORED.bundle.forEach((stored, i) => {
    it(`export-bundle ${i}: normalizeBundle gives the stored string back`, () => {
      expect(bundleBack(stored)).toBe(stored)
    })
  })

  STORED.batch.forEach((stored, i) => {
    it(`export-batch ${i}: lists only destinations and shapes the dialog keeps, so it is read back as stored`, () => {
      const b = JSON.parse(stored) as { presets: string[]; aspects: string[] }
      expect(Object.keys(b)).toEqual(['presets', 'aspects'])
      for (const id of b.presets) expect(presets.presetById(id), id).toBeDefined()
      for (const a of b.aspects) expect(presets.BATCH_ASPECTS as readonly string[]).toContain(a)
    })
  })

  it('reads hand-edited values as today', () => {
    pinned(
      'odd',
      'settings',
      STORED.odd.filter((o) => o.key === 'settings').map((o) => JSON.stringify(presets.normalizeOptions(JSON.parse(o.stored))))
    )
    pinned(
      'odd',
      'bundle',
      STORED.odd.filter((o) => o.key === 'bundle').map((o) => bundleBack(o.stored))
    )
  })

  it("every built-in destination of today still matches its own settings, and keeps its card through a read and a tweak", () => {
    const today = ['youtube-1080', 'youtube-4k', 'x', 'linkedin', 'reels', 'tiktok', 'shorts', 'square', 'slack-gif', 'email']
    for (const id of today) {
      const p = presets.presetById(id)!
      expect(p, id).toBeDefined()
      for (const encoder of ['auto', 'software'] as const) {
        const o = presets.applyPreset({ encoder }, p)
        expect(presets.matchesPreset(o, p), id).toBe(true)
        expect(presets.normalizeOptions(JSON.parse(JSON.stringify(o))).preset, id).toBe(id)
        expect(presets.tweakOptions(o, { encoder: encoder === 'auto' ? 'software' : 'auto' }).preset, id).toBe(id)
        expect(presets.tweakOptions(o, { quality: o.quality === 'high' ? 'small' : 'high' }).preset, id).toBeUndefined()
      }
    }
    pinned('presets', 'applied', today.map((id) => presets.applyPreset({ encoder: 'auto' }, presets.presetById(id)!)))
  })

  it('tweaks, batches and file names come out as today', () => {
    const o = presets.normalizeOptions({ format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto', preset: 'youtube-1080', aspect: '16:9' })
    const tweaks: Partial<import('../src/shared/render/exportPresets').ExportOptions>[] = [
      { fps: 30 },
      { format: 'webm' },
      { aspect: undefined },
      { targetSizeMB: 25 },
      { resolution: 720, quality: 'small' },
      { format: 'gif', fps: 30 }
    ]
    pinned('tweaks', 'youtube-1080', tweaks.map((t) => presets.tweakOptions(o, t)))
    const items = presets.batchItems(['youtube-1080', 'reels', 'slack-gif', 'email'], ['16:9', '9:16', '1:1', '4:3'], { format: 'mov', resolution: 1440, fps: 30, quality: 'medium', encoder: 'software' })
    pinned('batch', 'items', items)
    pinned('batch', 'names', presets.batchFileNames('Demo: a "test"', items))
    pinned('batch', 'm4a', presets.batchItems([], ['9:16'], { format: 'm4a', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }))
  })
})

/* ---------- test 3: ffmpeg arguments and soundtrack graphs ---------- */

const RECORDING = {
  clips: [
    { id: 'a', start: 0, end: 2, speed: 1 },
    { id: 'b', start: 3, end: 5, speed: 2 }
  ],
  volume: 0.9
}

const RAW_H264: FfmpegVideoEncoder[] = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']
const COLOR = { primaries: 1, transfer: 1, matrix: 6, fullRange: false }
const QUALITIES = ['high', 'medium', 'small'] as const

/** One export job of the matrix. */
function job(format: ExportJob['format'], video: ExportJob['video'], quality: ExportJob['quality'], fps: number, target: boolean, extra: Partial<ExportJob> = {}): ExportJob {
  const audioOnly = format === 'm4a'
  return {
    width: audioOnly ? 0 : 1920,
    height: audioOnly ? 0 : 1080,
    fps,
    frames: fps * 6,
    format,
    quality,
    video,
    audio: RECORDING,
    ...(target ? (format === 'gif' ? { maxBytes: 15_000_000 } : { bitrate: { video: audioOnly ? 0 : 2_500_000, audio: 128_000 } }) : {}),
    outputPath: `/out/x.${format}`,
    ...extra
  }
}

/** Every job of the matrix by group: format × encoder, each over quality × size target × fps 30 and 60. */
function jobMatrix(): Record<string, ExportJob[]> {
  const groups: Record<string, ExportJob[]> = {}
  const add = (name: string, make: (q: ExportJob['quality'], fps: number, target: boolean) => ExportJob, rates: readonly number[] = [30, 60]): void => {
    const list: ExportJob[] = []
    for (const q of QUALITIES) for (const target of [false, true]) for (const fps of rates) list.push(make(q, fps, target))
    groups[name] = list
  }
  for (const format of ['mp4', 'mov'] as const) {
    for (const encoder of RAW_H264) add(`${format} raw ${encoder}`, (q, fps, t) => job(format, { kind: 'raw', encoder, pixelFormat: 'yuv420p' }, q, fps, t))
    add(`${format} raw rgba libx264`, (q, fps, t) => job(format, { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' }, q, fps, t))
    add(`${format} webcodecs h264`, (q, fps, t) => job(format, { kind: 'h264', color: COLOR }, q, fps, t))
  }
  add('webm raw libvpx-vp9', (q, fps, t) => job('webm', { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'yuv420p' }, q, fps, t))
  add('webm webcodecs vp9', (q, fps, t) => job('webm', { kind: 'vp9', color: { primaries: 1, transfer: 1, matrix: 6, fullRange: null } }, q, fps, t))
  add('gif raw', (q, fps, t) => job('gif', { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' }, q, fps, t, { audio: undefined }), [15, 30, 60])
  add('m4a', (q, _fps, t) => job('m4a', { kind: 'none' }, q, 60, t), [60])
  // Chapters, subtitle streams, silent and click-only jobs.
  const chapters = [
    { start: 0, title: 'Intro' },
    { start: 2.5, title: 'Billing = money; #1' }
  ]
  const subtitles = [
    { language: 'en', name: 'English', vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n', default: true },
    { language: 'bn', name: 'বাংলা', vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nনমস্কার\n', default: false }
  ]
  groups['with chapters and subtitles'] = [
    job('mp4', { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' }, 'high', 60, false, { chapters, subtitles }),
    job('mp4', { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' }, 'high', 60, true, { chapters, subtitles }),
    job('mov', { kind: 'h264', color: COLOR }, 'medium', 30, false, { chapters, subtitles }),
    job('webm', { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'yuv420p' }, 'small', 30, true, { chapters, subtitles }),
    job('webm', { kind: 'vp9', color: COLOR }, 'high', 60, false, { chapters, subtitles }),
    job('m4a', { kind: 'none' }, 'high', 60, false, { chapters })
  ]
  groups['silent and clicks'] = [
    job('mp4', { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' }, 'high', 60, false, { audio: undefined }),
    job('mov', { kind: 'raw', encoder: 'h264_nvenc', pixelFormat: 'yuv420p' }, 'high', 30, false, { audio: undefined, clicks: { times: [0.5, 1.5], volume: 0.8 } }),
    job('webm', { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'yuv420p' }, 'medium', 60, true, { audio: undefined }),
    job('m4a', { kind: 'none' }, 'medium', 60, false, { audio: undefined, clicks: { times: [1], volume: 1 } })
  ]
  return groups
}

/** The plan main builds for `job`, with fixed paths. */
function ffmpegPlanOf(job: ExportJob): unknown {
  const music = job.music ? `/p/${job.music.file}` : null
  return ffmpegPlan(job, { audioInput: job.audio ? '/p/screen.mp4' : null, stems: undefined, music, output: '/out/.x.partial.tmp', tempStem: '/tmp/flown-stem' })
}

/** Soundtrack jobs: every kind of sound today's exports mix. */
function soundJobs(): Record<string, ExportJob> {
  const m4a = (over: Partial<ExportJob>): ExportJob => ({ width: 0, height: 0, fps: 60, frames: 600, format: 'm4a', quality: 'high', video: { kind: 'none' }, outputPath: '/o.m4a', ...over })
  const clips = [
    { id: 'a', start: 0, end: 3, speed: 1 },
    { id: 'b', start: 4, end: 7, speed: 1.5 },
    { id: 'c', start: 8, end: 12, speed: 0.75 }
  ]
  const music = { file: 'music.mp3', volume: 0.4, loop: true, fadeIn: 1, fadeOut: 2, duration: 4.5 }
  return {
    plain: m4a({ audio: { clips, volume: 1 } }),
    stems: m4a({ audio: { clips, volume: 0.8, stems: { mic: 1, system: 0.5 } } }),
    'stems one': m4a({ audio: { clips, volume: 1, stems: { mic: 1 } } }),
    'noise and loudness': m4a({ audio: { clips, volume: 1.2, noiseReduction: 0.6, normalize: true } }),
    'stems noise loudness': m4a({ audio: { clips, volume: 1, stems: { mic: 1, system: 1 }, noiseReduction: 0.4, normalize: true } }),
    holds: m4a({ audio: { clips, volume: 1, holds: [{ at: 1, length: 1.5 }, { at: 9, length: 2 }] } }),
    'cut fades': m4a({ audio: { clips, volume: 1, cutFade: 0.03 } }),
    sounds: m4a({ audio: { clips, volume: 1, sounds: [{ start: 1, end: 2, gain: 0 }, { start: 9, end: 10, gain: 0.3 }] } }),
    voice: m4a({ audio: { clips, volume: 1, stems: { mic: 1, system: 1 }, voice: 'strong' } }),
    music: m4a({ audio: { clips, volume: 1 }, music }),
    'music ducked': m4a({ audio: { clips, volume: 1 }, music: { ...music, loop: false, duck: { depth: 0.6, attack: 0.3, release: 0.8, ranges: [{ start: 0.5, end: 3 }, { start: 5, end: 8 }] } } }),
    'music only': m4a({ music }),
    clicks: m4a({ audio: { clips, volume: 1 }, clicks: { times: [0.4, 2.2, 5.1], volume: 0.7 } }),
    pops: m4a({ audio: { clips, volume: 1 }, pops: [{ times: [1, 2.5], sound: 'pop' }, { times: [3], sound: 'ding' }] }),
    tones: m4a({ audio: { clips, volume: 1 }, tones: [{ start: 1.2, end: 1.6 }] }),
    fades: m4a({ audio: { clips, volume: 1 }, fadeIn: 0.5, fadeOut: 1.5 }),
    everything: m4a({
      audio: { clips, volume: 0.9, stems: { mic: 1, system: 0.6 }, noiseReduction: 0.3, normalize: true, holds: [{ at: 5, length: 1 }], cutFade: 0.02, sounds: [{ start: 9, end: 9.5, gain: 0 }] },
      music: { ...music, duck: { depth: 0.5, attack: 0.2, release: 0.5, ranges: [{ start: 0, end: 4 }] } },
      clicks: { times: [0.4, 6], volume: 1 },
      pops: [{ times: [2], sound: 'pop' }],
      tones: [{ start: 3, end: 3.4 }],
      fadeIn: 0.2,
      fadeOut: 0.4
    }),
    video: { ...m4a({ audio: { clips, volume: 1, stems: { mic: 1, system: 1 } }, music }), format: 'mp4', width: 1280, height: 720, fps: 30, frames: 300, video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' } }
  }
}

describe('ffmpeg arguments and soundtrack graphs are as before (test 3)', () => {
  const groups = jobMatrix()
  for (const [name, list] of Object.entries(groups)) {
    it(`${name}: every job passes validateJob and plans the same processes`, () => {
      for (const j of list) expect(() => validateJob(j), JSON.stringify(j)).not.toThrow()
      pinned('plan', name, list.map((j) => ffmpegPlanOf(j)))
    })
  }

  it('GIF fits: the reduced passes and their descriptions', () => {
    const size = { width: 1280, height: 720, fps: 30 }
    const fits: unknown[] = []
    let fit: { fps: number; scale: number; colors: number } | null = { fps: 30, scale: 1, colors: 256 }
    for (let k = 0; k < 8 && fit; k++) {
      fits.push({ fit, palette: gifPaletteArgs('/t/i.mkv', '/t/p.png', fit, size), encode: gifEncodeArgs('/t/i.mkv', '/t/p.png', '/o.gif', fit, size), said: describeGifFit(fit, size) })
      fit = nextGifFit(fit, size, 40_000_000 / (k + 1), 15_000_000)
    }
    pinned('gif', 'fits', fits)
  })

  const sounds = soundJobs()
  for (const [name, j] of Object.entries(sounds)) {
    it(`soundtrack ${name}: planSoundtrack gives the same inputs and graph`, () => {
      const files = { mix: '/p/screen.mp4', stems: { mic: '/p/mic.m4a', system: '/p/system.m4a' }, music: j.music ? `/p/${j.music.file}` : null }
      pinned('sound', name, planSoundtrack(j, files, j.video.kind === 'none' ? 0 : 1))
    })
  }

  it('routes, route labels, sizes and codecs of the settings of today', () => {
    const caps = (hw: ('h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_mf')[], forced?: 'webcodecs-software' | 'ffmpeg') => ({ hardwareEncoders: hw, overrides: forced ? { videoEncoder: forced } : {} })
    const out: unknown[] = []
    for (const format of ['mp4', 'mov', 'webm', 'gif', 'm4a'] as const)
      for (const encoder of ['auto', 'software'] as const)
        for (const targetSizeMB of [undefined, 25])
          for (const c of [caps([]), caps(['h264_nvenc', 'h264_qsv']), caps(['h264_amf', 'h264_mf']), caps([], 'webcodecs-software'), caps(['h264_nvenc'], 'ffmpeg')]) {
            const routes = exportRoutes({ format, encoder, ...(targetSizeMB ? { targetSizeMB } : {}) }, c)
            out.push({ format, encoder, targetSizeMB, routes, labels: routes.map((r) => routeLabel(r, format)) })
          }
    pinned('routes', 'all', out)
    pinned('routes', 'codecs', (['mp4', 'mov', 'webm', 'gif', 'm4a'] as const).map((f) => [videoCodecOf(f), isAudioOnly(f)]))
    const project = migrateProject(JSON.parse(JSON.stringify(base('size', 10))))
    const sizes: unknown[] = []
    for (const resolution of [720, 1080, 1440, 2160] as const)
      for (const aspect of [undefined, 'auto', '16:9', '9:16', '1:1', '4:3'] as const)
        for (const format of ['mp4', 'gif'] as const) sizes.push(exportSize(project, { format, resolution, fps: 60, quality: 'high', encoder: 'auto', ...(aspect ? { aspect } : {}) }))
    pinned('routes', 'sizes', sizes)
    const tall = exportProject(project, { aspect: '9:16' })
    expect(tall).not.toBe(project)
    expect(exportProject(project, {})).toBe(project)
    pinned('routes', 'exportProject', tall.style)
  })
})

/* ---------- test 4: drawing ---------- */

interface DrawCase {
  name: string
  project: Project
  track: CursorTrack
}

/** The six projects whose frames test 4 draws. */
function drawCases(): DrawCase[] {
  const old = Object.fromEntries([...load('vertical-old-projects.json'), ...load('wave8-old-projects.json')].map((f) => [f.name, f.raw]))
  const scenes = Object.fromEntries(sceneFixtures().map((s) => [s.name, s]))
  const migrated = (raw: unknown): Project => migrateProject(structuredClone(raw))
  return [
    { name: 'old 16:9', project: migrated(old['16:9']), track: seededTrack(rng(8101), migrated(old['16:9']).duration) },
    { name: 'old 9:16', project: migrated(old['9:16']), track: seededTrack(rng(8102), migrated(old['9:16']).duration) },
    { name: 'scene wide-corners', project: scenes['wide-corners'].project, track: scenes['wide-corners'].track },
    { name: 'scene frame-browser', project: scenes['frame-browser'].project, track: scenes['frame-browser'].track },
    { name: 'wave 10', project: migrated(JSON.parse(JSON.stringify(wave10Project()))), track: seededTrack(rng(8105), 40) },
    { name: 'wave 11', project: migrated(JSON.parse(JSON.stringify(wave11Project()))), track: seededTrack(rng(8106), 60) }
  ]
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

function sceneOf(c: DrawCase): { scene: Record<string, unknown>; w: number; h: number; src: Record<string, unknown> } {
  const { project } = c
  const view = cropView(project, c.track)
  const scene = {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, project.duration, project.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, project.duration),
    ...(view.crop ? { crop: view.crop } : {})
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

/** 24 export frames of `project` (indices into videoFrames at 30 fps): the frames around every cut and join, then seeded ones. */
function sampled(project: Project, seed: number): { times: number[]; pictures: number[]; held: Uint8Array | null; picked: number[] } {
  const { times, pictures, held } = videoFrames(project.clips, planOf(project), FPS)
  const n = times.length
  const want = new Set<number>()
  const add = (i: number): void => {
    if (i >= 0 && i < n) want.add(i)
  }
  for (const w of joinPlan(project)) {
    const first = Math.ceil(w.from * FPS)
    add(first)
    add(Math.floor(((w.from + w.to) / 2) * FPS))
    add(Math.ceil(w.to * FPS) - 1)
  }
  project.clips.forEach((c, i) => {
    if (i === 0) return
    for (let k = 0; k < n; k++)
      if (times[k] >= c.start) {
        add(k - 1)
        add(k)
        break
      }
  })
  let list = [...want].sort((a, b) => a - b)
  if (list.length > 16) list = Array.from({ length: 16 }, (_, k) => list[Math.floor((k * list.length) / 16)])
  const r = rng(seed)
  const picked = new Set(list)
  while (picked.size < Math.min(24, n)) picked.add(Math.floor(r() * n))
  return { times, pictures, held, picked: [...picked].sort((a, b) => a - b) }
}

/** The digests of the 24 frames' call logs, drawn as the export draws them (with the joins' stills composed as the export composes them). */
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
        const target = canvas()
        const scratch = joinLayer.scratchTarget('cpu', w, h)
        joinLayer.composeJoinStill(scratch, target, w, h, at.window, scene, { screen: { image: { tag: 'still' }, width: c.project.width, height: c.project.height }, camera: null }, null)
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

describe('drawFrame and the join layer draw the same calls (test 4)', () => {
  const cases = drawCases()
  it('draws six projects, one of them with every kind of cut style', () => {
    expect(cases.map((c) => c.name)).toEqual(['old 16:9', 'old 9:16', 'scene wide-corners', 'scene frame-browser', 'wave 10', 'wave 11'])
    expect(joinPlan(cases[4].project).map((w) => w.kind)).toEqual(['crossfade', 'dip', 'slide'])
  })
  cases.forEach((c, n) => {
    it(`${c.name}: the same 24 frames`, () => {
      const frames = framesOf(c, 9100 + n)
      expect(frames).toHaveLength(24)
      pinned('frames', c.name, frames)
    })
  })

  it("the joins' stills are composed with the same calls, on an opaque scratch target", () => {
    const c = cases[4]
    const { scene, w, h } = sceneOf(c)
    joinLayer.releaseScratch()
    const out: unknown[] = []
    for (const window of joinPlan(c.project)) {
      calls.length = 0
      const target = canvas()
      const scratch = joinLayer.scratchTarget('gpu', w, h)
      joinLayer.composeJoinStill(scratch, target, w, h, window, scene, { screen: { image: { tag: 'still' }, width: 1920, height: 1080 }, camera: { image: { tag: 'camera' }, width: 1280, height: 720 } }, null)
      out.push({ window, calls: digest(stripped(calls)), scratch: contextOptions.get(scratch.canvas.id as number), out: contextOptions.get(target.id as number) })
    }
    pinned('joins', 'compose', out)
  })

  it('endJoin draws the same calls through every window', () => {
    const c = cases[4]
    const { w, h } = sceneOf(c)
    const out: unknown[] = []
    for (const window of joinPlan(c.project)) {
      for (const p of [0, 0.25, 0.5, 0.75, 0.99]) {
        for (const still of [null, { tag: 'still' }]) {
          const target = canvas()
          const ctx = (target.getContext as (t: string) => unknown)('2d')
          calls.length = 0
          // A slide's endJoin restores the saves beginJoin and the picture made.
          ;(ctx as { save(): void }).save()
          ;(ctx as { save(): void }).save()
          calls.length = 0
          joinLayer.endJoin(ctx, w, h, { at: { window, p }, still })
          out.push(digest(stripped(calls)))
        }
      }
    }
    pinned('joins', 'endJoin', out)
  })
})
