import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CaptionPreset, CaptionSegment, CaptionSettings, Project } from '../src/shared/types'
import { digest, sceneFixtures, seededTimes } from './verticalFixtures'

/*
 * The equivalence guard of Captions Studio (docs/design/captions-studio.md §16.2, tests 1 to 3):
 * what old projects load, how legacy captions are laid out and placed, and what drawFrame draws
 * for each of the five legacy looks, pinned against the code before any Captions Studio change
 * (Flown 0.7.1 with NW-09's speakers, bafa13a). Captions Studio only adds optional fields, and the
 * legacy path changes by three guarded calls that return their input without them, so every value
 * here must stay the same bit for bit, after every part merges. Values are compared as digests of
 * their exact JSON (tests/verticalFixtures.ts digest); a changed digest names the fixture and the
 * function. The snapshots are never regenerated to make a change pass.
 */

/* ---------- canvases that record their calls (as tests/verticalEquivalence.test.ts) ---------- */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  font: unknown
  fill: unknown
  stroke: unknown
  alpha: unknown
  direction: unknown
}
const calls: Call[] = []
let canvases = 0

/** A canvas whose 2D context records its calls with the state they draw with. */
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
      return (...args: unknown[]) =>
        void calls.push({ canvas: id, name: String(prop), args, font: target.font, fill: target.fillStyle, stroke: target.strokeStyle, alpha: target.globalAlpha, direction: target.direction })
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

const { migrateProject } = await import('../src/shared/engine/project')
const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { captionLayout, captionMetrics, placeChunk } = await import('../src/shared/captions/layout')
const { DEFAULT_CAPTIONS, withPreset } = await import('../src/shared/captions/settings')
const { speakerCaption } = await import('../src/shared/captions/speakers')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Ctx = unknown
type DrawFrame = (ctx: Ctx, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number; frameInterval?: number }) => void
type CaptionBlockAt = (ctx: Ctx, project: unknown, t: number, w: number, h: number) => unknown
const COMPOSITOR = '../src/renderer/src/render/compositor'
const CAPTIONS_LAYER = '../src/renderer/src/render/captionsLayer'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
const { captionBlockAt } = (await import(/* @vite-ignore */ CAPTIONS_LAYER)) as { captionBlockAt: CaptionBlockAt }

/** The digests of today's outputs (bafa13a), by section and fixture. */
const SNAPSHOT: Record<string, Record<string, string>> = {
  keys: {
    'nw09-speakers': 'f0a4257f4565bce828054e9d0ae0852d',
    'tall-karaoke': '121ddac2ee382ed677880dc4fa99385b',
    'caption-data': '919774719060127f161aead5ec62b9ed',
    'default-look': '795a9ad1e7af3d4a668c1716f9199bf8',
    'minimal-hidden': '121ddac2ee382ed677880dc4fa99385b'
  },
  migrated: {
    'nw09-speakers': 'c916adb2a35c7a9f2232a4ebca799caf',
    'tall-karaoke': 'ca521dc07dd91400f2b8b8157436ff8a',
    'caption-data': 'bb317e748ce8c53c8f0c0e8bb23ec7a5',
    'default-look': '3f1ba14773b81d08932983cfd1f63bda',
    'minimal-hidden': 'fcccf73646eb246353c0f0ff7c6020cc'
  },
  layout: {
    '1920x1080 clean': '4cfb6d89c82598be7117fb49d713f52d',
    '1920x1080 bold': '0aa1d239bda1e982a46081ce0e2f3849',
    '1920x1080 boxed': '46cebe0df0e928bbb61d05ada0497a2c',
    '1920x1080 karaoke': 'eca1a7443f9bca91451b6f3ebc974e0e',
    '1920x1080 minimal': 'fe67a5f5c99109413f0412715f50bfce',
    '1080x1920 clean': '78a60f142aeb49a376648a7c56d24090',
    '1080x1920 bold': '513819777db88c6576182f340ccc7f59',
    '1080x1920 boxed': '614d2dac93ef4eae14d11456f170c746',
    '1080x1920 karaoke': 'aee15daf35f1974d18fa3e0bc5b6667c',
    '1080x1920 minimal': '29ba6e8df6f84ebefc9be87d26195220'
  },
  drawFrame: {
    'wide-auto clean': '009336aa19a6c16b67632aa91ae9530e',
    'wide-auto bold': '2f5baa0150ec7430c28a936f3c942bb8',
    'wide-auto boxed': '14a066ee0225e8d111c8cce512bbc323',
    'wide-auto karaoke': '365da2f685eb90d0c7fa554b370c31e3',
    'wide-auto minimal': 'cdaeb440498e7007ab7fb1ac8269394a',
    'tall-fitted clean': '495539fa4531c5b98a30ecaefd3c422c',
    'tall-fitted bold': '711237d0bd9b13db03e59a914b10fdc9',
    'tall-fitted boxed': 'f21433313ab6c230c712eca8571688fb',
    'tall-fitted karaoke': 'b027773fc92ac84d0d9df02a3e1e0fa6',
    'tall-fitted minimal': 'b608020b0279ddab9695c78f071b6e01'
  }
}

/** Checks `value` against the digest pinned for `section` and `key`. */
function pin(section: string, key: string, value: string): void {
  expect(value, `${section} ${key}`).toBe(SNAPSHOT[section]?.[key])
}

/** Keys Captions Studio adds; an old project never gets one by loading (§4.4). */
const NEW_PROJECT_KEYS = ['captionMarks', 'captionPlaces', 'graphics', 'captionTracks', 'bleeps', 'captionAuto']
const NEW_CAPTION_KEYS = ['studio', 'track', 'picked']

/* ---------- test 1: old projects load exactly as before ---------- */

interface OldFixture {
  name: string
  raw: Record<string, unknown>
}

const OLD: OldFixture[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'captions-old-projects.json'), 'utf8'))
const VERTICAL_OLD: OldFixture[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vertical-old-projects.json'), 'utf8'))

describe('old projects load as before (test 1)', () => {
  it('has the NW-09, tall karaoke, captionData, default-look and hidden-minimal projects', () => {
    expect(OLD.map((f) => f.name)).toEqual(['nw09-speakers', 'tall-karaoke', 'caption-data', 'default-look', 'minimal-hidden'])
    // The NW-09 project has speakers, estimated and deleted words and speaker names on.
    const nw09 = OLD[0].raw as unknown as Project
    expect(nw09.transcript!.segments.some((s) => s.speaker)).toBe(true)
    expect(nw09.transcript!.segments.some((s) => s.words?.some((w) => w.deleted))).toBe(true)
    expect(nw09.captions!.showSpeaker).toBe(true)
  })

  for (const f of OLD) {
    it(`${f.name}: the same keys and byte-equal JSON, no Captions Studio key`, () => {
      const p = migrateProject(structuredClone(f.raw)) as unknown as Record<string, unknown>
      for (const k of NEW_PROJECT_KEYS) expect(p, k).not.toHaveProperty(k)
      if (p.captions) for (const k of NEW_CAPTION_KEYS) expect(p.captions, k).not.toHaveProperty(k)
      for (const t of (p.titles as Record<string, unknown>[]) ?? []) expect(t).not.toHaveProperty('auto')
      pin('keys', f.name, digest(Object.keys(p)))
      pin('migrated', f.name, digest(JSON.stringify(p)))
      // Saved and opened again: the same project (a partial hand-edited file may list its keys in another order).
      const again = migrateProject(JSON.parse(JSON.stringify(p))) as unknown as Record<string, unknown>
      expect(again).toEqual(p)
    })
  }

  for (const f of VERTICAL_OLD) {
    it(`vertical ${f.name}: no Captions Studio key`, () => {
      const p = migrateProject(structuredClone(f.raw)) as unknown as Record<string, unknown>
      for (const k of NEW_PROJECT_KEYS) expect(p, k).not.toHaveProperty(k)
      if (p.captions) for (const k of NEW_CAPTION_KEYS) expect(p.captions, k).not.toHaveProperty(k)
    })
  }
})

/* ---------- test 2: legacy layout and placement ---------- */

const SIZES: [number, number][] = [
  [1920, 1080],
  [1080, 1920]
]
const PRESETS: CaptionPreset[] = ['clean', 'bold', 'boxed', 'karaoke', 'minimal']
/** Text as wide as the compositor's fallback font measures it, roughly: half the size per character, bolder wider. */
const measure = (text: string, px: number, weight: number): number => [...text].length * px * (weight >= 700 ? 0.56 : 0.5)

const plain: CaptionSegment = { id: 'g1', start: 1, end: 3, text: 'Hello caption world' }
const timed: CaptionSegment = {
  id: 'g2',
  start: 4,
  end: 12,
  text: 'Click the Save button, then open the Export dialog and choose where the video goes on this computer.',
  words: 'Click the Save button, then open the Export dialog and choose where the video goes on this computer.'.split(' ').map((w, i) => ({ text: w, start: 4 + i * 0.4, end: 4 + i * 0.4 + 0.35 }))
}
const arabic: CaptionSegment = { id: 'g3', start: 13, end: 15, text: 'مرحبا بالعالم من Visual Studio Code اليوم' }
const speakerRaw: CaptionSegment = { id: 'g4', start: 16, end: 19, text: 'Sales grew 300 percent this year', speaker: 'Priya' }
const speaker: CaptionSegment = speakerCaption(speakerRaw)
const bangla: CaptionSegment = { id: 'g5', start: 20, end: 23, text: 'আমরা আজ Flown শিখব এক ক্লিকে সুন্দর ভিডিও' }
const SEGS = [plain, timed, arabic, speaker, bangla]
/** A tall frame's text area (safeZones.ts textArea), so the area branch of placeChunk is pinned too. */
const AREA = { x: 54, y: 211, w: 972, h: 1248 }

describe('legacy layout and placement (test 2)', () => {
  it('the speaker caption carries its label token', () => {
    expect(speaker.text.startsWith('Priya')).toBe(true)
  })

  for (const [w, h] of SIZES)
    for (const preset of PRESETS)
      it(`${w}x${h} ${preset}: captionMetrics, captionLayout and placeChunk give the values of today`, () => {
        const out: unknown[] = []
        for (const position of ['bottom', 'middle', 'top'] as const)
          for (const background of ['none', 'box', 'shadow'] as const)
            for (const maxLines of [1, 2] as const)
              for (const size of [0.045, 0.08]) {
                const settings: CaptionSettings = { ...DEFAULT_CAPTIONS, preset, position, background, maxLines, size }
                for (const a of h > w ? [null, AREA] : [null]) {
                  const layouts = SEGS.map((s) => captionLayout(s, settings, w, h, measure, a))
                  out.push(captionMetrics(settings, w, h, a), layouts, layouts.map((l) => l.chunks.map((c) => placeChunk(l, c, position, w, h, a))))
                }
              }
        pin('layout', `${w}x${h} ${preset}`, digest(out))
      })
})

/* ---------- test 3: what drawFrame draws for each legacy look ---------- */

const SCREEN = { tag: 'screen frame' }
const FIXTURES = sceneFixtures()

/** Calls with canvases numbered by first use and canvas arguments named, so only what is drawn where counts. */
function stripped(log: Call[]): unknown[] {
  const order = new Map<number, number>()
  const local = (id: number): number => {
    if (!order.has(id)) order.set(id, order.size)
    return order.get(id)!
  }
  return log.map((c) => ({
    on: local(c.canvas),
    name: c.name,
    args: JSON.stringify(c.args, (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? `canvas${local((v as unknown as { id: number }).id)}` : v)),
    font: c.font,
    fill: c.fill,
    stroke: c.stroke,
    alpha: c.alpha,
    direction: c.direction
  }))
}

/** Times inside and around the captions: every word change of the timed caption and seeded ones. */
const TIMES = [0.9, 1.05, 2.95, 4.05, 4.45, 4.85, 5.25, 7.3, 11.9, 13.1, 14.95, 16.02, 17.5, 20.4, 22.9, 23.5, ...seededTimes(9301, 8, 24)]

function captioned(name: string, preset: CaptionPreset, showSpeaker: boolean): { project: Project; w: number; h: number } {
  const f = FIXTURES.find((x) => x.name === name)!
  const p = f.project
  return {
    w: f.w,
    h: f.h,
    project: {
      ...p,
      duration: Math.max(p.duration, 25),
      clips: p.clips.map((c, i) => (i === p.clips.length - 1 ? { ...c, end: Math.max(c.end, 25) } : c)),
      transcript: {
        language: 'en',
        provider: 'local',
        model: 'speech-small',
        createdAt: '2026-10-20T09:05:00.000Z',
        segments: [plain, timed, arabic, speakerRaw, bangla]
      },
      captions: { ...withPreset({ ...DEFAULT_CAPTIONS, size: 0.06 }, preset), ...(showSpeaker ? { showSpeaker: true as const } : {}) },
      cursor: { ...p.cursor, hideWhenIdle: false }
    }
  }
}

describe('drawFrame of the legacy looks (test 3)', () => {
  it('samples 24 times, with every karaoke word change of the timed caption', () => {
    expect(TIMES).toHaveLength(24)
    expect(TIMES.filter((t) => t >= 4 && t < 6)).toHaveLength(4)
  })

  for (const scene of ['wide-auto', 'tall-fitted'])
    for (const preset of PRESETS)
      it(`${scene} ${preset}: the same calls and caption blocks at every sampled frame`, () => {
        const { project, w, h } = captioned(scene, preset, preset === 'boxed' || preset === 'karaoke')
        const f = FIXTURES.find((x) => x.name === scene)!
        const view = cropView(project, f.track)
        const sceneArg = {
          project: view.project,
          cursor: view.cursor,
          cursorPath: new SmoothedTrack(view.cursor.samples, project.duration, project.cursor.smoothing),
          focusPath: focusPathFor(view.cursor.samples, project.duration),
          ...(view.crop ? { crop: view.crop } : {})
        }
        const webcam = project.hasWebcam ? { readyState: 4, videoWidth: 1280, videoHeight: 720 } : null
        const src = {
          screen: { readyState: 4, videoWidth: project.width, videoHeight: project.height },
          webcam,
          background: null,
          screenFrame: { image: SCREEN, width: project.width, height: project.height },
          ...(webcam ? { webcamFrame: { image: { tag: 'camera frame' }, width: 1280, height: 720 } } : {})
        }
        const out: string[] = []
        let text = 0
        for (const [i, t] of TIMES.entries()) {
          const c = canvas()
          const ctx = (c.getContext as (t: string) => unknown)('2d')
          calls.length = 0
          drawFrame(ctx, w, h, t, sceneArg, src, i % 4 === 3 ? { blurSamples: 10, frameInterval: 1 / 30 } : { blurSamples: 4 })
          text += calls.filter((k) => k.name === 'fillText').length
          out.push(digest(stripped(calls)), digest(captionBlockAt(ctx, project, t, w, h)))
        }
        expect(text).toBeGreaterThan(0)
        pin('drawFrame', `${scene} ${preset}`, digest(out))
      })
})
