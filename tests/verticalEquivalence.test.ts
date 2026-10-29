import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AspectRatio, CaptionSettings, CursorTrack, Project, TitleCard, WatermarkSettings } from '../src/shared/types'
import { digest, rng, sceneFixtures, seededTimes, seededTrack, seededZooms, type SceneFixture } from './verticalFixtures'

/*
 * The equivalence guard of vertical video (docs/design/vertical-video.md §11.2, tests 2, 12, 13,
 * 41, 47 and 53): what old projects load, lay out, aim the camera at, draw and place text at,
 * pinned against the code before following existed (Flown 0.6.0, aeca5c5). Following only adds
 * optional parameters and a branch taken when `reframe.mode` is 'follow' in a narrower frame, so
 * every value here must stay the same bit for bit, after every part merges. Values are compared
 * as digests of their exact JSON (tests/verticalFixtures.ts digest); a changed digest names the
 * fixture and the function. The snapshots are never regenerated to make a change pass.
 */

/* ---------- canvases that record their calls (as tests/compositorCrop.test.ts) ---------- */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  quality: unknown
  smoothing: unknown
  alpha: unknown
}
const calls: Call[] = []
let canvases = 0

/** A canvas whose 2D context records its calls. */
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
        void calls.push({ canvas: id, name: String(prop), args, quality: target.imageSmoothingQuality, smoothing: target.imageSmoothingEnabled, alpha: target.globalAlpha })
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
const { cameraShownAt, layoutMoving, sceneLayout } = await import('../src/shared/engine/layout')
const { aimAt, blendCameras, cameraAt, cameraFor, clampCamera, DEFAULT_ZOOM_STYLE, focusPathFor, zoomStyleOf, zoomTargetScale, zoomTimings } = await import('../src/shared/engine/zoom')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { cropView } = await import('../src/shared/engine/crop')
const { captionLayout, captionMetrics, placeChunk } = await import('../src/shared/captions/layout')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { watermarkRect } = await import('../src/shared/engine/watermark')
const { titleLayout } = await import('../src/shared/render/titleCards')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Ctx = unknown
type DrawFrame = (ctx: Ctx, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number; frameInterval?: number }) => void
type DrawKeystrokes = (ctx: Ctx, w: number, h: number, t: number, project: unknown, cursor: unknown) => void
type CaptionBlockAt = (ctx: Ctx, project: unknown, t: number, w: number, h: number) => unknown
const COMPOSITOR = '../src/renderer/src/render/compositor'
const TEXT_OVERLAYS = '../src/renderer/src/render/textOverlays'
const CAPTIONS_LAYER = '../src/renderer/src/render/captionsLayer'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
const { drawKeystrokes } = (await import(/* @vite-ignore */ TEXT_OVERLAYS)) as { drawKeystrokes: DrawKeystrokes }
const { captionBlockAt } = (await import(/* @vite-ignore */ CAPTIONS_LAYER)) as { captionBlockAt: CaptionBlockAt }

/** The digests of today's outputs (aeca5c5), by section and fixture. */
const SNAPSHOT: Record<string, Record<string, string>> = {
  frames: {
    'wide-auto': '1920x1080 of 1920x1080',
    'tall-fitted': '1080x1920 of 1920x1080',
    'square-fitted': '1080x1080 of 1920x1080',
    'wide-corners': '1920x1080 of 1920x1080',
    'wide-side': '1920x1080 of 1920x1080',
    'tall-layouts': '1080x1920 of 1920x1080',
    'square-corners': '1080x1080 of 2560x1440',
    'crop-wide': '2010x1080 of 1920x1032',
    'crop-tall': '1080x1920 of 960x864',
    'frame-browser': '1920x1080 of 1920x1080',
    'frame-laptop-tall': '1080x1920 of 1920x1080',
    'window-43': '1440x1080 of 1200x900'
  },
  layout: {
    'wide-auto': 'f9aa712ebb9a787371bc0933d77c8407',
    'tall-fitted': '99c824700a11f50d845db55039259efc',
    'square-fitted': 'f690ab63efee28c7657f99f5171a8a77',
    'wide-corners': 'cd447f73c2a3a572a0868df98225f888',
    'wide-side': '992a9d28c6b4e8efcbb5ec8d0d4ed216',
    'tall-layouts': '1c952562588fc30c76550139f3dc0b1b',
    'square-corners': 'b4b2b2f190351fa75ab5b1ec431de52e',
    'crop-wide': 'd0010ff6314ecabacc2ceacac09cb5c1',
    'crop-tall': '6d5af11285eb24b96566d3bc7bcd85f0',
    'frame-browser': '9dd922e3e95154f88c07864be48c306e',
    'frame-laptop-tall': '9d5674be9e7b49f23340d917e38e4472',
    'window-43': '71b311304f1d1e85af1bf06acd68f52a'
  },
  camera: {
    clampCamera: '4865678c75609ad8b46ad3af13e339f4',
    cameraFor: '2284f81b2edc0084cb342d0fc6bb4855',
    blendCameras: '0f26402faf428d597948c1be8456eb75',
    zoomTargetScale: 'a64b026790d39293444b8b60dbecbee1',
    zoomTimings: 'd9e5c35397bfd9e71207cee4746dc112',
    aimAt: '322063f7f9ee39f7789c71b9e4e20f16'
  },
  cameraAt: {
    'lists 0-9': '50ee2164af3230461d92003cb17ea290',
    'lists 10-19': '6722ed090db0baff61f355a5aad5258e',
    'lists 20-29': '4abb8f8ef04b14f2c5e7f7ed3cf7746b',
    'lists 30-39': '95eb7d82e1876b77b351925d4f09bf86',
    'lists 40-49': '218d897a8a6c25b4a49e16d2b9a0f020',
    'lists 50-59': '920cb6fe4f7de04a8c2c569d4e8d91ab',
    'lists 60-69': '5ee847038fba8e7707e00cba69b989ed',
    'lists 70-79': '70204ae180314e11002940bab74870d4',
    'lists 80-89': '03789bdfc999d18a56ddfaf9d4c190ff',
    'lists 90-99': '17b9bc2ecd22caa6743c619fc6978e23'
  },
  frameCamera: {
    'wide-auto': '975f3cd3b95ba8f4ed76e0c9a9734214',
    'tall-fitted': '5b87b9c16c23f3d3ebdba0d8f6aa69a2',
    'square-fitted': '729e9ba6f39ac38462d3d1e1f57b19e9',
    'wide-corners': '359d82b208649805bb8e1925ca8d3750',
    'wide-side': 'e89b815b7afdaa25d70c10eabd4cf681',
    'tall-layouts': 'b460992bf31aac2621144637552a2747',
    'square-corners': '30ff51670dea21b71ff860a2b7651eee',
    'crop-wide': '0f175a5e48bcea5d72161cf22b244292',
    'crop-tall': '0ed1651f3768feae8cb975f5ab12c19a',
    'frame-browser': '7a6225d516d9c9ebb37d7ddea4313050',
    'frame-laptop-tall': '012812b9d1cf10d2fb0f6aa6763e1b2e',
    'window-43': '66679e6819ef8b0032d5978712d2cc45'
  },
  drawFrame: {
    'tall-fitted': '8f051e9fb1148e2ec7d5560d8309c4f3',
    'wide-auto': 'f056572fcb8cdbfab15699ad41017b9c',
    'square-fitted': '58c0c7d92912c77ad44a0830e04410f5',
    'tall-layouts': 'f03526935a9ace920a864e1274d4ee48'
  },
  text: {
    captions: '53a57756c4e873c094afdbcc6cf52216',
    watermark: '8ff243f58487e3ab5f254e28ecce8879',
    titles: 'ac4336097044d92fe5013250fd8ea038',
    keystrokes: '533981334c1d21f5f9cd0a709d2b10c7'
  }
}

/** Checks `value` against the digest pinned for `section` and `key`. */
function pin(section: string, key: string, value: string): void {
  expect(value, `${section} ${key}`).toBe(SNAPSHOT[section]?.[key])
}

const FIXTURES = sceneFixtures()

/** A context of a fresh recording canvas. */
const context = (): { ctx: Ctx; id: number } => {
  const c = canvas()
  return { ctx: (c.getContext as (t: string) => unknown)('2d'), id: c.id as number }
}

/** `log` with canvases numbered by first use and canvas arguments named, so only what is drawn where counts. */
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
    quality: c.quality,
    smoothing: c.smoothing,
    alpha: c.alpha
  }))
}

/* ---------- test 2: old projects load exactly as before ---------- */

interface OldFixture {
  name: string
  raw: Record<string, unknown>
  /** Object.keys of the migrated project (a key may hold undefined, which the JSON leaves out). */
  keys: string[]
  migrated: Record<string, unknown>
}

const OLD: OldFixture[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vertical-old-projects.json'), 'utf8'))
/** Written in the snapshot for a clip id migrateProject makes up (an early file without clips gets a new one each load). */
const GENERATED = '(generated)'

describe('old projects load as before (test 2)', () => {
  it('has the 16:9, 9:16 and 1:1 projects from before following', () => {
    expect(OLD.map((f) => f.name)).toEqual(['16:9', '9:16', '1:1'])
    expect(OLD.map((f) => (f.raw.style as { aspectRatio: AspectRatio }).aspectRatio)).toEqual(['auto', '9:16', '1:1'])
  })

  for (const f of OLD) {
    it(`${f.name}: no reframe or copyOf key, the same keys and byte-equal JSON`, () => {
      const p = migrateProject(structuredClone(f.raw)) as unknown as Record<string, unknown>
      expect(p).not.toHaveProperty('reframe')
      expect(p).not.toHaveProperty('copyOf')
      const clips = p.clips as { id: string }[]
      if (!Array.isArray(f.raw.clips)) {
        expect(clips[0].id).toMatch(/^c[0-9a-z]+$/)
        p.clips = [{ ...clips[0], id: GENERATED }]
      }
      expect(Object.keys(p)).toEqual(f.keys)
      expect(JSON.stringify(p)).toBe(JSON.stringify(f.migrated))
      // Saved and opened again: the same file.
      const again = migrateProject(JSON.parse(JSON.stringify(p))) as unknown as Record<string, unknown>
      expect(JSON.stringify(again)).toBe(JSON.stringify(p))
    })
  }
})

/* ---------- test 12: the layout of every frame ---------- */

describe('sceneLayout of the twelve fixtures (test 12)', () => {
  it('has twelve fixtures with 500 seeded times each', () => {
    expect(FIXTURES).toHaveLength(12)
    expect(new Set(FIXTURES.map((f) => f.name)).size).toBe(12)
    for (const f of FIXTURES) expect(f.times.length).toBeGreaterThanOrEqual(500)
    for (const f of FIXTURES) pin('frames', f.name, `${f.w}x${f.h} of ${f.vw}x${f.vh}`)
    // They cover screens moving between layouts and cameras fading out.
    const moving = FIXTURES.filter((f) => f.times.some((t) => layoutMoving(f.drawn, t))).map((f) => f.name)
    expect(moving).toEqual(expect.arrayContaining(['wide-side', 'tall-layouts', 'crop-wide', 'frame-browser']))
    expect(FIXTURES.some((f) => f.times.some((t) => !cameraShownAt(f.drawn, f.w, f.h, f.vw, f.vh, t) && f.drawn.webcam.show))).toBe(true)
  })

  for (const f of FIXTURES) {
    it(`${f.name}: the same screen and camera at every time, no follow, moving as layoutMoving`, () => {
      const rows = f.times.map((t) => {
        const l = sceneLayout(f.drawn, f.w, f.h, f.vw, f.vh, t)
        expect(l).not.toHaveProperty('follow')
        expect(l.moving).toBe(layoutMoving(f.drawn, t))
        return { l, shown: cameraShownAt(f.drawn, f.w, f.h, f.vw, f.vh, t) }
      })
      pin('layout', f.name, digest(rows))
    })
  }
})

/* ---------- test 13: the zoom camera without a base ---------- */

describe('the zoom camera without a base (test 13)', () => {
  const N = 10_000
  const r = rng(13)
  const unit = (): number => -0.5 + r() * 2
  const scale = (): number => {
    const k = r()
    return k < 0.1 ? 1 : k < 0.15 ? 0.5 : k < 0.2 ? 0.02 : 0.03 + r() * 6
  }
  const cam = () => ({ scale: scale(), cx: unit(), cy: unit() })
  const clampIn = Array.from({ length: N }, cam)
  const forIn = Array.from({ length: N }, () => [scale(), unit(), unit()] as const)
  const blendIn = Array.from({ length: N }, () => [cam(), cam(), -0.2 + r() * 1.5] as const)
  // 100 zoom lists of 100 times each, with a smoothed cursor (or no cursor data) and a project style.
  const lists = Array.from({ length: 100 }, (_, i) => {
    const lr = rng(5000 + i)
    const duration = 20 + lr() * 40
    const zooms = seededZooms(lr, duration, 2 + Math.floor(lr() * 10))
    const focus = i % 4 === 3 ? null : new SmoothedTrack(seededTrack(lr, duration).samples, duration, 1)
    const style = i % 3 === 0 ? DEFAULT_ZOOM_STYLE : { easing: (['smooth', 'snappy', 'bouncy', 'linear'] as const)[i % 4], transition: 0.15 + lr() * 2 }
    return { zooms, focus, style, times: seededTimes(6000 + i, 100, duration) }
  })

  it('covers cursor, fixed, region and pull-back zooms, anchors, easings and connected zooms', () => {
    const all = lists.flatMap((l) => l.zooms)
    expect(new Set(all.map((z) => z.focus.mode))).toEqual(new Set(['cursor', 'fixed', 'region']))
    expect(all.some((z) => z.scale < 1 && z.focus.mode === 'cursor')).toBe(true)
    expect(all.some((z) => z.anchor?.until !== undefined)).toBe(true)
    expect(new Set(all.map((z) => z.easing))).toEqual(new Set(['smooth', 'snappy', 'bouncy', 'linear', undefined]))
    expect(lists.some((l) => [...zoomTimings(l.zooms, l.style).values()].some((x) => x.toNext))).toBe(true)
  })

  it('clampCamera, cameraFor and blendCameras give the values of today for 10,000 seeded inputs', () => {
    pin('camera', 'clampCamera', digest(clampIn.map((c) => clampCamera(c))))
    pin('camera', 'cameraFor', digest(forIn.map(([s, x, y]) => cameraFor(s, x, y))))
    pin('camera', 'blendCameras', digest(blendIn.map(([a, b, w]) => blendCameras(a, b, w))))
  })

  it('cameraAt gives the values of today for 100 seeded zoom lists at 100 times each', () => {
    for (let g = 0; g < 10; g++) pin('cameraAt', `lists ${g * 10}-${g * 10 + 9}`, digest(lists.slice(g * 10, g * 10 + 10).map((l) => l.times.map((t) => cameraAt(l.zooms, t, l.focus, l.style)))))
  })

  it('zoomTargetScale, zoomTimings and aimAt give the values of today for the same lists', () => {
    pin('camera', 'zoomTargetScale', digest(lists.map((l) => l.zooms.map((z) => zoomTargetScale(z)))))
    pin('camera', 'zoomTimings', digest(lists.map((l) => [...zoomTimings(l.zooms, l.style)])))
    pin('camera', 'aimAt', digest(lists.filter((l) => l.focus).map((l) => l.times.map((t) => aimAt(l.zooms, t, l.focus!, l.style)))))
  })
})

/* ---------- test 41 (reference): the camera of every frame ---------- */

describe('the camera of every frame of the twelve fixtures (reference of test 41)', () => {
  for (const f of FIXTURES) {
    it(`${f.name}: cameraAt with the drawn zooms, the focus path and the project's zoom style`, () => {
      const focus = f.cursor.valid ? focusPathFor(f.cursor.samples, f.drawn.duration) : null
      const style = zoomStyleOf(f.drawn)
      pin('frameCamera', f.name, digest(f.times.map((t) => cameraAt(f.drawn.zooms, t, focus, style))))
    })
  }
})

/* ---------- test 47: what drawFrame draws for fitted frames ---------- */

const SCREEN = { tag: 'screen frame' }
const CAMERA = { tag: 'camera frame' }

/** A caption, text, logo, lower third, shapes, a spotlight and key presses on top of fixture `f`. */
function dressed(f: SceneFixture): Project {
  const p = f.project
  return {
    ...p,
    annotations: [{ id: 'a1', start: 1, end: 9, text: 'Open the billing page', x: 0.5, y: 0.85, size: 0.05, style: 'pill' }],
    shapes: [
      { id: 's1', start: 2, end: 12, kind: 'arrow', x: 0.3, y: 0.3, w: 0.2, h: -0.1, color: '#ef4444', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 },
      { id: 's2', start: 0, end: 30, kind: 'blur', x: 0.6, y: 0.1, w: 0.2, h: 0.1, color: '#000000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }
    ],
    spotlights: [{ id: 'l1', start: 14, end: 19, mode: 'region', x: 0.2, y: 0.2, w: 0.3, h: 0.2, shape: 'rect', dim: 0.6, feather: 0.3 }],
    titles: [{ id: 't1', start: 0, end: 4, title: 'Billing demo', subtitle: 'Qbexel', style: 'lower-third', background: 'blur' }],
    watermark: { show: true, kind: 'text', text: 'qbexel.com', position: 'bottom-right', size: 0.03, opacity: 0.8, margin: 0.03 },
    transcript: {
      provider: 'local',
      model: 'speech-small',
      createdAt: '2026-10-12T10:20:00.000Z',
      segments: [
        { id: 'k1', start: 1, end: 5, text: 'Here is the billing page, with every invoice of the month.' },
        { id: 'k2', start: 12, end: 17, text: 'Invoices are listed by month.' }
      ]
    },
    captions: { ...DEFAULT_CAPTIONS, preset: 'boxed', background: 'box' },
    cursor: { ...p.cursor, hideWhenIdle: false }
  }
}

describe('drawFrame of fitted frames (test 47)', () => {
  const SCENES = ['tall-fitted', 'wide-auto', 'square-fitted', 'tall-layouts']
  for (const name of SCENES) {
    it(`${name}: the same calls at every sampled frame`, () => {
      const f = FIXTURES.find((x) => x.name === name)!
      const project = dressed(f)
      const view = cropView(project, f.track)
      const scene = {
        project: view.project,
        cursor: view.cursor,
        cursorPath: new SmoothedTrack(view.cursor.samples, project.duration, project.cursor.smoothing),
        focusPath: focusPathFor(view.cursor.samples, project.duration),
        ...(view.crop ? { crop: view.crop } : {})
      }
      const webcam = project.hasWebcam ? { readyState: 4, videoWidth: 1280, videoHeight: 720 } : null
      const src = {
        screen: { readyState: 4, videoWidth: f.project.width, videoHeight: f.project.height },
        webcam,
        background: null,
        screenFrame: { image: SCREEN, width: f.project.width, height: f.project.height },
        ...(webcam ? { webcamFrame: { image: CAMERA, width: 1280, height: 720 } } : {})
      }
      const out: string[] = []
      const times = seededTimes(4700 + SCENES.indexOf(name), 16, 30)
      for (const [i, t] of times.entries()) {
        const { ctx } = context()
        calls.length = 0
        // Preview frames, and every fourth one as the export draws it.
        const options = i % 4 === 3 ? { blurSamples: 10, frameInterval: 1 / 30 } : { blurSamples: 4 }
        drawFrame(ctx, f.w, f.h, t, scene, src, options)
        expect(calls.some((c) => c.name === 'drawImage' && c.args[0] === SCREEN)).toBe(true)
        out.push(digest(stripped(calls)))
      }
      pin('drawFrame', name, digest(out))
    })
  }
})

/* ---------- test 53: captions, key presses, logo and lower thirds without a text area ---------- */

const SIZES: [number, number][] = [
  [1920, 1080],
  [1080, 1920]
]
/** Text as wide as the compositor's fallback font measures it, roughly: half the size per character, bolder wider. */
const measure = (text: string, px: number, weight: number): number => text.length * px * (weight >= 700 ? 0.56 : 0.5)

describe('text placement without a text area (test 53)', () => {
  const segs = [
    { id: 'k1', start: 1, end: 3, text: 'Hello vertical world' },
    {
      id: 'k2',
      start: 4,
      end: 12,
      text: 'Invoices are listed by month, and each one opens the customer it was sent to with every payment made since.',
      words: 'Invoices are listed by month, and each one opens the customer it was sent to with every payment made since.'.split(' ').map((w, i) => ({ text: w, start: 4 + i * 0.35, end: 4 + i * 0.35 + 0.3 }))
    },
    { id: 'k3', start: 13, end: 15, text: 'مرحبا بالعالم' }
  ]

  it('captionMetrics, captionLayout and placeChunk give the values of today', () => {
    const out: unknown[] = []
    for (const [w, h] of SIZES)
      for (const preset of ['clean', 'bold', 'boxed', 'karaoke', 'minimal'] as const)
        for (const position of ['bottom', 'middle', 'top'] as const)
          for (const background of ['none', 'box', 'shadow'] as const)
            for (const maxLines of [1, 2] as const)
              for (const size of [0.045, 0.08]) {
                const settings: CaptionSettings = { ...DEFAULT_CAPTIONS, preset, position, background, maxLines, size }
                const layouts = segs.map((s) => captionLayout(s, settings, w, h, measure))
                out.push(captionMetrics(settings, w, h), layouts, layouts.map((l) => l.chunks.map((c) => placeChunk(l, c, position, w, h))))
              }
    pin('text', 'captions', digest(out))
  })

  it('watermarkRect gives the values of today', () => {
    const out: unknown[] = []
    for (const [w, h] of SIZES)
      for (const kind of ['image', 'text'] as const)
        for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'] as const)
          for (const size of [0.03, 0.2, 0.9])
            for (const margin of [0, 0.03, 0.2])
              for (const aspect of [0.5, 3, Number.NaN]) {
                const wm: Pick<WatermarkSettings, 'kind' | 'size' | 'position' | 'margin'> = { kind, size, position, margin }
                out.push(watermarkRect(w, h, wm, aspect))
              }
    pin('text', 'watermark', digest(out))
  })

  it('titleLayout gives the values of today', () => {
    const out: unknown[] = []
    for (const [w, h] of SIZES)
      for (const style of ['centered', 'lower-third', 'big'] as const)
        for (const title of ['Billing demo', 'A much longer title that has to be broken over more than one line to fit'])
          for (const subtitle of [undefined, 'Qbexel', 'A subtitle long enough to need a second line of its own as well']) {
            const card: Pick<TitleCard, 'title' | 'subtitle' | 'style'> = { title, style, ...(subtitle ? { subtitle } : {}) }
            out.push(titleLayout(card, w, h, measure))
          }
    pin('text', 'titles', digest(out))
  })

  it('drawKeystrokes and captionBlockAt give the calls and blocks of today', () => {
    const f = FIXTURES[0]
    const out: unknown[] = []
    let drawn = 0
    for (const [w, h] of SIZES)
      for (const position of ['bottom', 'top'] as const)
        for (const captions of ['bottom', 'top', 'none'] as const) {
          const p: Project = {
            ...dressed(f),
            effects: { motionBlur: 0, keystrokes: { show: true, position, size: 0.035 } },
            captions: { ...DEFAULT_CAPTIONS, position: captions === 'none' ? 'bottom' : captions, show: captions !== 'none' }
          }
          const cursor: CursorTrack = { ...f.track, keys: [1.2, 1.5, 2.4, 13.1, 14.8].map((t, i) => ({ t, label: ['Ctrl + C', 'Ctrl + V', 'Alt + Tab', 'Ctrl + Shift + P', 'Enter'][i] })) }
          for (const t of [0.5, 1.3, 1.6, 2.6, 3.5, 13.2, 15, 16.5]) {
            const { ctx } = context()
            calls.length = 0
            drawKeystrokes(ctx, w, h, t, p, cursor)
            out.push(stripped(calls), captionBlockAt(ctx, p, t, w, h))
            drawn += calls.filter((c) => c.name === 'fillText').length
          }
        }
    expect(drawn).toBeGreaterThan(0)
    pin('text', 'keystrokes', digest(out))
  })
})
