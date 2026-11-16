/**
 * Test 77 (docs/design/output-and-languages.md §21.8 row X3, §23.1): the UI's digits never change
 * what captions draw. A Bangla caption project is drawn with drawFrame at the same frames with the UI
 * in English, in Bangla with Bangla digits and in Bangla with Western digits (the format locale's
 * -u-nu- tag, §9.4, as the ui.digits preference sets it): the canvas calls are the same, and the
 * captions' own Digits choice (CaptionSettings.digits) alone decides their digits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CaptionSettings, Project } from '../src/shared/types'
import { sceneFixtures } from './verticalFixtures'

/* ---------- canvases that record their calls (as tests/captionsStudioEquivalence.test.ts) ---------- */

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

const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { withStudioTile } = await import('../src/shared/captions/studioEdit')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number }) => void
const COMPOSITOR = '../src/renderer/src/render/compositor'
type Runtime = typeof import('../src/shared/i18n/t')

/** The UI as each run sets it: English, Bangla with Bangla digits, Bangla with Western digits (§9.4 step 2). */
const UIS = [
  { name: 'English', language: 'en', formatLocale: 'en-US' },
  { name: 'Bangla, Bangla digits', language: 'bn', formatLocale: 'bn-BD' },
  { name: 'Bangla, Western digits', language: 'bn', formatLocale: 'bn-BD-u-nu-latn' }
] as const

/**
 * Fresh modules in `ui`: the compositor and its caches (layouts, measured text, drawn tiles) start
 * empty in every run, so nothing one run drew can stand in for what another would draw.
 */
async function freshIn(ui: (typeof UIS)[number]): Promise<{ drawFrame: DrawFrame; runtime: Runtime; fmt: typeof import('../src/shared/i18n/fmt').fmt }> {
  vi.resetModules()
  await import('../src/shared/i18n/messages/en/index')
  const runtime = (await import('../src/shared/i18n/t')) as Runtime
  runtime.setCatalogue({ language: ui.language, messages: {}, formatLocale: ui.formatLocale, dir: 'ltr' })
  const { fmt } = await import('../src/shared/i18n/fmt')
  const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: DrawFrame }
  return { drawFrame, runtime, fmt }
}

afterEach(() => {
  vi.resetModules()
})

const SCREEN = { tag: 'screen frame' }
const FIXTURE = sceneFixtures().find((f) => f.name === 'wide-auto')!
const TIMES = [1.2, 1.9, 2.6, 4.4, 5.1]

/** The fixture with Bangla captions holding digits of both scripts, drawn with a Studio look and `digits`. */
function banglaProject(digits: CaptionSettings['digits'], tile: string | null): Project {
  const p = FIXTURE.project
  const base: CaptionSettings = { ...DEFAULT_CAPTIONS, show: true, size: 0.06 }
  const look = tile ? withStudioTile(base, tile, { w: FIXTURE.w, h: FIXTURE.h }) : base
  return {
    ...p,
    duration: Math.max(p.duration, 8),
    clips: p.clips.map((c, i) => (i === p.clips.length - 1 ? { ...c, end: Math.max(c.end, 8) } : c)),
    transcript: {
      language: 'bn',
      provider: 'local',
      model: 'bangla-medium',
      createdAt: '2026-10-20T09:05:00.000Z',
      segments: [
        { id: 'b1', start: 1, end: 3, text: 'আমরা 300% দ্রুত ২৫টি ধাপে শিখব' },
        { id: 'b2', start: 4, end: 6, text: 'মোট 12 মিনিট ৩০ সেকেন্ড' }
      ]
    },
    captions: { ...look, ...(digits ? { digits } : {}) },
    cursor: { ...p.cursor, hideWhenIdle: false }
  }
}

/** Every canvas call of drawFrame at TIMES, and the text it drew. */
function draw(drawFrame: DrawFrame, project: Project): { log: string; text: string } {
  const view = cropView(project, FIXTURE.track)
  const scene = {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, project.duration, project.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, project.duration),
    ...(view.crop ? { crop: view.crop } : {})
  }
  const src = {
    screen: { readyState: 4, videoWidth: project.width, videoHeight: project.height },
    webcam: null,
    background: null,
    screenFrame: { image: SCREEN, width: project.width, height: project.height }
  }
  const out: Call[] = []
  for (const t of TIMES) {
    const c = canvas()
    const ctx = (c.getContext as (type: string) => unknown)('2d')
    calls.length = 0
    drawFrame(ctx, FIXTURE.w, FIXTURE.h, t, scene, src, { blurSamples: 4 })
    // Canvas ids differ from run to run (each run makes its own scratch canvases); the calls and their state do not.
    const noId = (v: unknown): unknown => (v && typeof v === 'object' && 'getContext' in v ? { canvas: true, width: (v as unknown as { width: unknown }).width, height: (v as unknown as { height: unknown }).height } : v)
    out.push(...calls.map((k) => ({ ...k, canvas: 0, args: k.args.map(noId) })))
  }
  const text = out
    .filter((k) => k.name === 'fillText' || k.name === 'strokeText')
    .map((k) => String(k.args[0]))
    .join(' ')
  return { log: JSON.stringify(out), text }
}

describe('test 77: the UI digits never change caption rendering', () => {
  for (const tile of ['bold-pop', 'subtitle', null] as const)
    for (const digits of [undefined, 'native', 'western'] as const)
      it(`${tile ?? 'a Classic look'}, captions' digits ${digits ?? 'as written'}: the same calls in English and in Bangla with either digits`, async () => {
        const runs: { ui: string; log: string; text: string }[] = []
        for (const ui of UIS) {
          const { drawFrame } = await freshIn(ui)
          runs.push({ ui: ui.name, ...draw(drawFrame, banglaProject(digits, tile)) })
        }
        expect(runs[0].text.length).toBeGreaterThan(0)
        for (const r of runs.slice(1)) {
          expect(r.log, r.ui).toBe(runs[0].log)
          expect(r.text, r.ui).toBe(runs[0].text)
        }
      })

  it('the format locale did change between the runs: fmt writes the UI digits, the captions do not follow them', async () => {
    const bangla = await freshIn(UIS[1])
    expect(bangla.runtime.uiLanguage()).toBe('bn')
    expect(bangla.fmt.count(25)).toBe('২৫')
    const western = await freshIn(UIS[2])
    expect(western.fmt.count(25)).toBe('25')
  })

  it("the captions' Digits choice alone decides a Studio caption's digits, in every UI", async () => {
    for (const ui of UIS) {
      const { drawFrame } = await freshIn(ui)
      const native = draw(drawFrame, banglaProject('native', 'bold-pop')).text
      const western = draw(drawFrame, banglaProject('western', 'bold-pop')).text
      expect(native, ui.name).toMatch(/৩০০/)
      expect(native, ui.name).not.toMatch(/300/)
      expect(western, ui.name).toMatch(/25/)
      expect(western, ui.name).not.toMatch(/২৫/)
    }
  })
})
