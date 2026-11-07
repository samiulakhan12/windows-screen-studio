/**
 * Loading a project's LUTs in the renderer (docs/design/editing-polish.md §9.5; §19.1 tests 57 and
 * 80): a LUT is used only when its file reads back with the SHA-256 it was imported with and parses
 * strictly; a missing, changed, oversized or broken file is never used, and lutProblem and the
 * export dialog's question say so. prepareEditingAssets waits for it, so the export's frame 0 (and
 * the thumbnail and the contrast probe, which draw after it) are graded with it; a badge's script
 * fonts are among the fonts loaded before frame 0.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { ColorLut, Project } from '../src/shared/types'

/** Files the fake studio-media:// serves, by file name; a missing name is a 404. */
const served = new Map<string, Uint8Array>()
const fetched: string[] = []
vi.stubGlobal('fetch', async (url: string) => {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop()!)
  fetched.push(name)
  const bytes = served.get(name)
  return bytes ? new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], { status: 200 }) : new Response('', { status: 404 })
})

// Grading is watched: frame 0 must be drawn with the LUT already there.
const graded: { lut: unknown }[] = []
vi.mock('../src/renderer/src/render/gradeLayer', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return {
    ...real,
    gradeScreen: (_t: unknown, frame: unknown, _g: unknown, lut: unknown) => {
      graded.push({ lut })
      return frame
    }
  }
})

/** A canvas whose 2D context does nothing (the compositor's drawing is not looked at here). */
function canvas(): Record<string, unknown> {
  const c: Record<string, unknown> = { width: 0, height: 0 }
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (prop === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
      // Gradients and patterns: objects that take any call.
      return () => ({ addColorStop: () => undefined, setTransform: () => undefined })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = () => ctx
  return c
}
vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const CACHE = '../src/renderer/src/render/lutCache'
const ASSETS = '../src/renderer/src/editor/editingAssets'
const COMPOSITOR = '../src/renderer/src/render/compositor'
const FONTS = '../src/renderer/src/render/fontLoader'
interface LutCache {
  lutFor(p: Project, which: 'screen' | 'camera'): { size: number; title: string } | null
  lutProblem(p: Project, which: 'screen' | 'camera'): string | null
  prepareLuts(p: Project): Promise<void>
  onLutReady(cb: () => void): () => void
  missingLutQuestion(p: Project): string | null
  LUT_PROBLEM: string
}
const L = (await import(/* @vite-ignore */ CACHE)) as LutCache
const { prepareEditingAssets } = (await import(/* @vite-ignore */ ASSETS)) as { prepareEditingAssets(p: Project): Promise<void> }
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as { drawFrame: (...a: unknown[]) => void }
const { catalogFontsFor } = (await import(/* @vite-ignore */ FONTS)) as { catalogFontsFor(p: Project): string[] }

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** A size-n .cube that swaps red and blue. */
function swapCube(n: number, title = 'Swap'): Uint8Array {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`]
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${b / (n - 1)} ${g / (n - 1)} ${r / (n - 1)}`)
  return enc(lines.join('\n') + '\n')
}

let ids = 0
/** A project whose `which` grade uses `ref` (a fresh id each time, so nothing is cached from another test). */
function project(refs: Partial<Record<'screen' | 'camera', ColorLut>>): Project {
  const p = createProject({
    id: `rec-lut-${++ids}`,
    name: 'p',
    duration: 10,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  const grade: Project['grade'] = {}
  if (refs.screen) grade.screen = { lut: refs.screen }
  if (refs.camera) grade.camera = { lut: refs.camera }
  return { ...p, grade }
}

/** Serves `bytes` as `file` and gives the reference an import would have made. */
function imported(file: string, bytes: Uint8Array, size: number): ColorLut {
  served.set(file, bytes)
  return { file, sha256: sha(bytes), title: 'Swap', size }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  served.clear()
  fetched.length = 0
  graded.length = 0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => warn.mockRestore())

describe('loading a LUT (test 57)', () => {
  it('uses a file that reads back with its SHA-256 and parses, once it is ready', async () => {
    const ref = imported('lut-1.cube', swapCube(5), 5)
    const p = project({ camera: ref })
    let ready = 0
    const off = L.onLutReady(() => ready++)
    // The frame loop never waits: null while it loads.
    expect(L.lutFor(p, 'camera')).toBeNull()
    expect(L.lutProblem(p, 'camera')).toBeNull()
    await L.prepareLuts(p)
    off()
    expect(L.lutFor(p, 'camera')).toMatchObject({ size: 5, title: 'Swap' })
    expect(L.lutProblem(p, 'camera')).toBeNull()
    expect(L.missingLutQuestion(p)).toBeNull()
    expect(ready).toBe(1)
    // Loaded once; a grade without a LUT asks for nothing.
    await L.prepareLuts(p)
    expect(fetched).toEqual(['lut-1.cube'])
    expect(L.lutFor(p, 'screen')).toBeNull()
    expect(L.lutProblem(p, 'screen')).toBeNull()
  })

  it('never uses a changed file, and says so', async () => {
    const ref = imported('lut-2.cube', swapCube(5), 5)
    served.set('lut-2.cube', swapCube(5, 'Other'))
    const p = project({ camera: ref })
    await L.prepareLuts(p)
    expect(L.lutFor(p, 'camera')).toBeNull()
    expect(L.lutProblem(p, 'camera')).toBe(L.LUT_PROBLEM)
    expect(L.LUT_PROBLEM).toBe('The LUT file is missing or has changed. Import it again.')
    expect(L.missingLutQuestion(p)).toBe("The camera's LUT is missing or has changed. Export without it?")
    expect(warn).toHaveBeenCalledWith('The LUT lut-2.cube is not used: the file has changed since it was imported')
  })

  it('never uses a missing file, and asks before an export without it', async () => {
    const screen = { file: 'lut-3.cube', sha256: 'a'.repeat(64), title: 't', size: 5 }
    const p = project({ screen })
    await L.prepareLuts(p)
    expect(L.lutFor(p, 'screen')).toBeNull()
    expect(L.lutProblem(p, 'screen')).toBe(L.LUT_PROBLEM)
    expect(L.missingLutQuestion(p)).toBe("The screen's LUT is missing or has changed. Export without it?")
    const both = project({ screen, camera: { ...screen, file: 'lut-4.cube' } })
    await L.prepareLuts(both)
    expect(L.missingLutQuestion(both)).toBe("The screen's and the camera's LUTs are missing or have changed. Export without them?")
  })

  it('never uses a file whose hash matches but that does not parse, has another size, or is over 16 MB', async () => {
    const broken = enc('LUT_3D_SIZE 2\n0 0 0\n1 1\n')
    const a = project({ camera: imported('lut-5.cube', broken, 2) })
    const b = project({ camera: { ...imported('lut-6.cube', swapCube(5), 5), size: 9 } })
    const big = new Uint8Array(16 * 1024 * 1024 + 1).fill(0x20)
    const c = project({ camera: imported('lut-7.cube', big, 2) })
    for (const p of [a, b, c]) {
      await L.prepareLuts(p)
      expect(L.lutFor(p, 'camera')).toBeNull()
      expect(L.lutProblem(p, 'camera')).toBe(L.LUT_PROBLEM)
    }
    // The oversized file is refused while it is read, before it is hashed or parsed.
    expect(warn).toHaveBeenCalledWith('The LUT lut-7.cube is not used: the file is larger than 16 MB')
  })

  it('a file put back is found again when the export prepares', async () => {
    const bytes = swapCube(3)
    const ref = { file: 'lut-8.cube', sha256: sha(bytes), title: 'Swap', size: 3 }
    const p = project({ screen: ref })
    await L.prepareLuts(p)
    expect(L.lutProblem(p, 'screen')).toBe(L.LUT_PROBLEM)
    served.set('lut-8.cube', bytes)
    await L.prepareLuts(p)
    expect(L.lutProblem(p, 'screen')).toBeNull()
    expect(L.lutFor(p, 'screen')).toMatchObject({ size: 3 })
  })
})

describe('ready before the first frame (test 80)', () => {
  it('prepareEditingAssets waits for a LUT imported just before, and frame 0 is graded with it', async () => {
    const ref = imported('lut-9.cube', swapCube(17), 17)
    const p = { ...project({ screen: ref }), grade: { screen: { lut: ref, contrast: 0.1 } } }
    await prepareEditingAssets(p)
    const lut = L.lutFor(p, 'screen')
    expect(lut).toMatchObject({ size: 17 })
    const ctx = (canvas().getContext as () => unknown)()
    const scene = { project: p, cursor: { samples: [], clicks: [], keys: [], scale: 1, valid: false }, cursorPath: { at: () => ({ x: 0.5, y: 0.5 }) }, focusPath: { at: () => ({ x: 0.5, y: 0.5 }) } }
    const src = { screen: { readyState: 4, videoWidth: 1280, videoHeight: 720 }, webcam: null, background: null, screenFrame: { image: { tag: 'frame 0' }, width: 1280, height: 720 } }
    drawFrame(ctx, 1280, 720, 0, scene, src, { blurSamples: 1 }, 0)
    expect(graded).toHaveLength(1)
    expect(graded[0].lut).toBe(lut)
  })

  it('the export, the thumbnail and the contrast probe draw only after it', () => {
    const src = (file: string): string => fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src', file), 'utf8')
    const exporter = src('editor/exporter.ts')
    const prepare = exporter.slice(exporter.indexOf('async function prepare<'), exporter.indexOf('return { ...input, project, scene }'))
    expect(prepare).toContain('await prepareEditingAssets(project)')
    // The export and the thumbnail draw nothing before prepare() is done.
    for (const fn of ['export async function renderThumbnail', 'export async function exportVideo']) {
      const at = exporter.indexOf(fn)
      expect(at, fn).toBeGreaterThan(0)
      const body = exporter.slice(at)
      expect(body.indexOf('await prepare(raw)'), fn).toBeGreaterThan(0)
      expect(body.indexOf('await prepare(raw)'), fn).toBeLessThan(body.indexOf('drawFrame('))
    }
    expect(exporter.match(/await prepare\(raw\)/g)!.length).toBeGreaterThanOrEqual(2)
    const probe = src('render/contrastProbe.ts')
    expect(probe.indexOf('await prepareEditingAssets(project)')).toBeGreaterThan(0)
    expect(probe.indexOf('await prepareEditingAssets(project)')).toBeLessThan(probe.indexOf('drawFrame(c'))
  })

  it("a badge's Bangla font is among the fonts loaded before frame 0", () => {
    const p = project({})
    const badge = { ...p, annotations: [{ id: 'a', start: 0, end: 2, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge' as const }] }
    expect(catalogFontsFor(badge)).toContain('noto-sans-bengali')
    expect(catalogFontsFor(p)).not.toContain('noto-sans-bengali')
  })
})
