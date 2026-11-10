/**
 * Straight alpha out of a transparent export (docs/design/output-and-languages.md §6.3; §23.1 tests
 * 26 and 29). A canvas with alpha holds premultiplied pixels; a VideoFrame of it reads back
 * premultiplied BGRA, getImageData straight RGBA. alphaRawSink sends straight 'bgra' whichever way
 * it reads, with getImageData's own rounding, so both give the same bytes. Then, with the Linux
 * ffmpeg, those frames survive a VP9 WebM (decoded with libvpx) and a CineForm RGBA MOV.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { rng } from './verticalFixtures'

/** Pixels Chromium's getImageData made straight in Electron 44 ([alpha, colour, straight]). */
const MEASURED = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/chromium-unpremultiply.json'), 'utf8')) as { random: [number, number, number][]; ties: [number, number, number][] }

/* ---------- a canvas that holds premultiplied pixels, as Chromium's does ---------- */

const f32 = Math.fround
/** A float rounded ties to even. */
const even = (v: number): number => {
  const d = Math.floor(v)
  return v - d > 0.5 || (v - d === 0.5 && d % 2 === 1) ? d + 1 : d
}
/** Chromium's unpremultiply of getImageData (Skia's float pipeline), written here on its own: the reference. */
const straightOf = (c: number, a: number): number => (a === 0 ? 0 : Math.min(255, even(f32(f32(f32(c * f32(1 / 255)) * f32(1 / f32(a * f32(1 / 255)))) * 255))))

interface FakeCanvas {
  width: number
  height: number
  /** Premultiplied BGRA, as the canvas stores it. */
  pixels: Uint8Array
  /** The layout a VideoFrame of it reports. */
  layout: string | null
}

/** Paints `rgba` (straight, alpha 0..1) over a w × h rectangle, source-over in premultiplied 8 bits. */
function paint(c: FakeCanvas, x0: number, y0: number, w: number, h: number, rgba: [number, number, number, number]): void {
  const [r, g, b, a] = rgba
  const pa = Math.round(a * 255)
  const src = [Math.round((b * pa) / 255), Math.round((g * pa) / 255), Math.round((r * pa) / 255), pa]
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * c.width + x) * 4
      for (let k = 0; k < 4; k++) c.pixels[i + k] = Math.min(255, src[k] + Math.round((c.pixels[i + k] * (255 - pa)) / 255))
    }
  }
}

/**
 * A transparent frame as the compositor draws one: clear corners, a soft 50% grey shadow, a card
 * with a red edge and a blue picture, and a 50% red pixel and a 4% green one over the clear part.
 */
function drawnFrame(width = 64, height = 48, layout: string | null = 'BGRA'): FakeCanvas {
  const c: FakeCanvas = { width, height, pixels: new Uint8Array(width * height * 4), layout }
  for (let k = 0; k < 6; k++) paint(c, 10 - k, 10 - k, 44 + 2 * k, 30 + 2 * k, [0, 0, 0, 0.5 / (k + 1)])
  paint(c, 12, 10, 40, 28, [230, 20, 20, 1])
  paint(c, 14, 12, 36, 24, [40, 110, 230, 1])
  paint(c, 2, 2, 1, 1, [255, 0, 0, 0.5])
  paint(c, 4, 2, 1, 1, [30, 200, 90, 0.04])
  return c
}

/** The canvas's 2D context: getImageData unpremultiplies as Chromium does and gives RGBA. */
function contextOf(c: FakeCanvas, willReadFrequently = false) {
  return {
    getContextAttributes: () => ({ alpha: true, willReadFrequently }),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < data.length; i += 4) {
        const a = c.pixels[i + 3]
        data[i] = straightOf(c.pixels[i + 2], a)
        data[i + 1] = straightOf(c.pixels[i + 1], a)
        data[i + 2] = straightOf(c.pixels[i], a)
        data[i + 3] = a
      }
      return { data, width: w, height: h }
    })
  }
}

/** A VideoFrame of a fake canvas: its pixels as stored, in the layout it reports (RGBA swaps them). */
const frames = vi.fn()
class FakeVideoFrame {
  readonly format: string | null
  constructor(private readonly canvas: FakeCanvas) {
    frames(canvas)
    this.format = canvas.layout
  }
  allocationSize(): number {
    return this.canvas.pixels.length
  }
  async copyTo(dest: Uint8Array): Promise<void> {
    dest.set(this.canvas.pixels)
    if (this.format === 'RGBA' || this.format === 'RGBX')
      for (let i = 0; i < dest.length; i += 4) {
        const b = dest[i]
        dest[i] = dest[i + 2]
        dest[i + 2] = b
      }
  }
  close(): void {}
}
vi.stubGlobal('VideoFrame', FakeVideoFrame)

const sent: Uint8Array[] = []
const api = { exportFrame: vi.fn(async (d: Uint8Array) => void sent.push(new Uint8Array(d))), exportFinish: vi.fn(async () => ({ bytes: 1 })) }
vi.stubGlobal('window', { api })

const READBACK = '../src/renderer/src/render/alphaReadback'
type Sink = { push(i: number): Promise<void>; finish(): Promise<unknown>; close(): void }
const { alphaRawSink, unpremultiply } = (await import(/* @vite-ignore */ READBACK)) as {
  alphaRawSink(canvas: unknown, ctx: unknown, startJob: (input: unknown) => Promise<void>, readback?: 'videoframe' | 'imagedata'): Sink
  unpremultiply(src: Uint8Array | Uint8ClampedArray, out: Uint8Array): void
}

/** The frames a sink sends for `canvas` drawn `n` times, and the inputs its job was started with. */
async function run(canvas: FakeCanvas, readback: 'videoframe' | 'imagedata' | undefined, n = 1, willReadFrequently = false): Promise<{ frames: Uint8Array[]; inputs: unknown[] }> {
  sent.length = 0
  const inputs: unknown[] = []
  const sink = alphaRawSink(canvas, contextOf(canvas, willReadFrequently), async (input) => void inputs.push(input), readback)
  for (let i = 0; i < n; i++) await sink.push(i)
  await sink.finish()
  return { frames: sent.slice(), inputs }
}

const pixel = (data: Uint8Array, width: number, x: number, y: number): number[] => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4))
/** A BGRA pixel as [R, G, B, A]. */
const rgbaOf = (bgra: number[]): number[] => [bgra[2], bgra[1], bgra[0], bgra[3]]

beforeEach(() => {
  frames.mockClear()
  api.exportFrame.mockClear()
})

describe('unpremultiply and the readbacks (test 26)', () => {
  it("matches Chromium's getImageData on 1,000 random premultiplied pixels and on every rounding tie", () => {
    expect(MEASURED.random).toHaveLength(1000)
    expect(MEASURED.ties.length).toBeGreaterThan(200)
    for (const list of [MEASURED.random, MEASURED.ties]) {
      const src = new Uint8Array(list.length * 4)
      list.forEach(([a, c], k) => src.set([c, c, c, a], k * 4))
      const out = new Uint8Array(src.length)
      unpremultiply(src, out)
      list.forEach(([a, , straight], k) => expect([out[k * 4], out[k * 4 + 1], out[k * 4 + 2], out[k * 4 + 3]], `alpha ${a}`).toEqual([straight, straight, straight, a]))
    }
    // The reference this file's getImageData uses agrees with Chromium too.
    for (const [a, c, straight] of [...MEASURED.random, ...MEASURED.ties]) expect(straightOf(c, a)).toBe(straight)
  })

  it('keeps 0 where alpha is 0, an opaque pixel as it is, works in place and keeps the byte order', () => {
    const src = new Uint8Array([0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 128, 128, 4, 8, 1, 10])
    const copy = src.slice()
    const out = new Uint8Array(src.length)
    unpremultiply(src, out)
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 255, 128, 102, 204, 26, 10])
    unpremultiply(copy, copy)
    expect(copy).toEqual(out)
    // Random premultiplied pixels (c ≤ a): each channel as the reference makes it.
    const r = rng(2626)
    const many = new Uint8Array(4000)
    for (let i = 0; i < many.length; i += 4) {
      const a = Math.floor(r() * 256)
      many.set([Math.floor(r() * (a + 1)), Math.floor(r() * (a + 1)), Math.floor(r() * (a + 1)), a], i)
    }
    const straight = new Uint8Array(many.length)
    unpremultiply(many, straight)
    for (let i = 0; i < many.length; i += 4) for (let k = 0; k < 3; k++) expect(straight[i + k]).toBe(straightOf(many[i + k], many[i + 3]))
  })

  it("a drawn transparent frame gives the same bytes through 'videoframe' and 'imagedata', straight BGRA", async () => {
    const canvas = drawnFrame()
    const viaFrame = await run(canvas, 'videoframe')
    expect(frames).toHaveBeenCalledTimes(1)
    const viaImage = await run(canvas, 'imagedata')
    expect(frames).toHaveBeenCalledTimes(1)
    expect(viaFrame.frames).toHaveLength(1)
    expect(viaFrame.frames[0]).toEqual(viaImage.frames[0])
    const out = viaFrame.frames[0]
    expect(out.length).toBe(64 * 48 * 4)
    // The 50% red pixel reads [255, 0, 0, 128] within 1: straight, not [128, 0, 0, 128].
    const red = rgbaOf(pixel(out, 64, 2, 2))
    ;[255, 0, 0, 128].forEach((v, k) => expect(Math.abs(red[k] - v)).toBeLessThanOrEqual(1))
    // The corner is clear, the card opaque, the shadow's black half see-through.
    expect(pixel(out, 64, 0, 47)).toEqual([0, 0, 0, 0])
    expect(rgbaOf(pixel(out, 64, 30, 24))).toEqual([40, 110, 230, 255])
    expect(rgbaOf(pixel(out, 64, 12, 30))).toEqual([230, 20, 20, 255])
    const shadow = rgbaOf(pixel(out, 64, 9, 20))
    expect(shadow.slice(0, 3)).toEqual([0, 0, 0])
    expect(shadow[3]).toBeGreaterThan(64)
    expect(shadow[3]).toBeLessThan(200)
  })

  it("starts the job once with straight 'bgra' frames that carry alpha", async () => {
    const { frames: out, inputs } = await run(drawnFrame(), 'videoframe', 3)
    expect(out).toHaveLength(3)
    expect(inputs).toEqual([{ alpha: true, video: { kind: 'raw', pixelFormat: 'bgra' } }])
  })

  it('reads an RGBA VideoFrame and swaps it to BGRA; a layout without alpha falls back to getImageData', async () => {
    const want = (await run(drawnFrame(), 'imagedata')).frames[0]
    expect((await run(drawnFrame(64, 48, 'RGBA'), 'videoframe')).frames[0]).toEqual(want)
    frames.mockClear()
    for (const layout of ['BGRX', 'I420', null]) {
      const canvas = drawnFrame(64, 48, layout)
      const got = await run(canvas, 'videoframe', 2)
      expect(got.frames[0]).toEqual(want)
      expect(got.frames[1]).toEqual(want)
      // One try, then getImageData for the rest of the export.
      expect(frames).toHaveBeenCalledTimes(1)
      frames.mockClear()
    }
  })

  it('reads through a VideoFrame on a GPU canvas and with getImageData on a CPU one (willReadFrequently), unless told', async () => {
    const canvas = drawnFrame()
    await run(canvas, undefined)
    expect(frames).toHaveBeenCalledTimes(1)
    frames.mockClear()
    await run(canvas, undefined, 1, true)
    expect(frames).not.toHaveBeenCalled()
    await run(canvas, 'videoframe', 1, true)
    expect(frames).toHaveBeenCalledTimes(1)
  })

  it('stops at a failed send with the reason, without the IPC wrapper', async () => {
    const canvas = drawnFrame()
    api.exportFrame.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'export:frame': Error: The disk is full")
    })
    const sink = alphaRawSink(canvas, contextOf(canvas), async () => undefined, 'videoframe')
    await sink.push(0)
    await expect(sink.finish()).rejects.toThrow(/^The disk is full$/)
  })
})

/* ---------- test 29: the frames through ffmpeg ---------- */

describe('transparent files with the Linux ffmpeg (test 29)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssw-alpha-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const ff = ffmpegPath()
  const W = 64
  const H = 48
  const FPS = 30

  /** One second of the drawn frame, as alphaRawSink sends it. */
  async function second(): Promise<Buffer> {
    const { frames: out } = await run(drawnFrame(W, H), 'videoframe', FPS)
    return Buffer.concat(out)
  }

  /** Frame 15 of `file`, decoded to straight RGBA (`decoder` before -i: FFmpeg's own VP9 decoder drops alpha). */
  function decoded(file: string, decoder: string[] = []): Uint8Array {
    const r = spawnSync(ff, ['-v', 'error', ...decoder, '-i', file, '-vf', 'select=eq(n\\,15)', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 })
    expect(r.status, r.stderr.toString()).toBe(0)
    expect(r.stdout.length).toBe(W * H * 4)
    return new Uint8Array(r.stdout)
  }

  const alphaAt = (rgba: Uint8Array, x: number, y: number): number => rgba[(y * W + x) * 4 + 3]
  const raw = ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0']

  it('a 1 s VP9 WebM decoded with libvpx has alpha 0 in the corner and 255 in the card', async () => {
    const input = await second()
    const file = path.join(dir, 'clear.webm')
    // §5.4: VP9 with alpha, today's realtime VP9 arguments.
    execFileSync(ff, ['-v', 'error', '-y', ...raw, '-filter_complex', '[0:v]scale=out_color_matrix=bt601:out_range=tv,format=yuva420p[vout]', '-map', '[vout]', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '7', '-crf', '30', '-b:v', '0', '-g', String(FPS * 2), file], { input })
    const frame = decoded(file, ['-c:v', 'libvpx-vp9'])
    expect(alphaAt(frame, 0, H - 1)).toBe(0)
    expect(alphaAt(frame, W - 1, 0)).toBe(0)
    expect(alphaAt(frame, 30, 24)).toBe(255)
    // The card's blue picture keeps its colour (no dark fringe from premultiplied input).
    const at = (30 + 24 * W) * 4
    expect(Math.abs(frame[at] - 40)).toBeLessThanOrEqual(12)
    expect(Math.abs(frame[at + 2] - 230)).toBeLessThanOrEqual(12)
    // FFmpeg's own decoder shows the same file opaque: why every reader names libvpx.
    expect(alphaAt(decoded(file), 0, H - 1)).toBe(255)
  })

  // CineForm is lossy (12-bit wavelets): clear decodes to a level or so above 0, opaque to 255.
  it("a CineForm RGBA MOV keeps both within its 12-bit loss, and the shadow's partial alpha", async () => {
    const input = await second()
    const file = path.join(dir, 'clear.mov')
    // §5.4: CineForm with alpha, 12-bit RGBA.
    execFileSync(ff, ['-v', 'error', '-y', ...raw, '-vf', 'format=gbrap12le', '-c:v', 'cfhd', '-quality', 'high', '-color_primaries', 'bt709', '-color_trc', 'bt709', file], { input })
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv=p=0', file]).toString()
    expect(probe.trim()).toBe('cfhd,gbrap12le')
    const frame = decoded(file)
    expect(alphaAt(frame, 0, H - 1)).toBeLessThanOrEqual(4)
    expect(alphaAt(frame, 30, 24)).toBeGreaterThanOrEqual(251)
    const sent = (await run(drawnFrame(W, H), 'videoframe')).frames[0]
    const shadow = sent[(20 * W + 9) * 4 + 3]
    expect(Math.abs(alphaAt(frame, 9, 20) - shadow)).toBeLessThanOrEqual(3)
    // The card's blue keeps its colour.
    const at = (30 + 24 * W) * 4
    expect(Math.abs(frame[at] - 40)).toBeLessThanOrEqual(6)
    expect(Math.abs(frame[at + 2] - 230)).toBeLessThanOrEqual(6)
  })
})
