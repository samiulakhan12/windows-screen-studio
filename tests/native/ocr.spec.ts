// The text reader helper (native/ocr) end to end on this machine, driven by main's own OcrHelper
// (src/main/privacy/readerHelper.ts, docs/design/auto-blur.md §5.5, §5.8, §16.2): the host build
// (SSW_OCR_HELPER_TEST, or native/bin/ssw-ocr from `node scripts/build-native.mjs --ocr-host`) and
// the five pinned model files (SSW_OCR_MODELS). Every line the helper writes goes through the
// strict parser main uses, so the real helper and the fake one of the unit tests answer alike.
// Missing prerequisites fail the suite with what provides them.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { READER_FILES } from '../../src/shared/privacy/readerCatalog'
import type { ModelPin } from '../../src/shared/privacy/protocol'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() } }))
vi.mock('../../src/main/recording/toolbarWindow', () => ({ isToolbarVisible: () => false }))

const require = createRequire(import.meta.url)
const ROOT = path.resolve(__dirname, '..', '..')
const HELPER = process.env.SSW_OCR_HELPER_TEST ?? path.join(ROOT, 'native', 'bin', process.platform === 'win32' ? 'ssw-ocr.exe' : 'ssw-ocr')
const MODELS = process.env.SSW_OCR_MODELS ?? ''
const FFMPEG: string = require('ffmpeg-static')
const FRAME = path.join(ROOT, 'tests', 'fixtures', 'privacy-eval', '01-editor-0-dark-100.png')

let tmp = ''
let video = ''
let pins: ModelPin[] = []

beforeAll(() => {
  const missing: string[] = []
  if (!existsSync(HELPER)) missing.push(`${path.relative(ROOT, HELPER)} (run node scripts/build-native.mjs --ocr-host)`)
  if (!MODELS || READER_FILES.some((f) => !existsSync(path.join(MODELS, f.file)))) missing.push('the five pinned model files in SSW_OCR_MODELS (native/ocr/README.md)')
  if (!FFMPEG || !existsSync(FFMPEG)) missing.push('ffmpeg-static (run npm ci)')
  if (missing.length) throw new Error(`The text reader's native tests need: ${missing.join('; ')}`)
  pins = READER_FILES.map((f) => ({ file: f.file, path: path.join(MODELS, f.file), bytes: f.bytes, sha256: f.sha256 }))
  for (const p of pins) expect(createHash('sha256').update(readFileSync(p.path)).digest('hex'), p.file).toBe(p.sha256)
  tmp = mkdtempSync(path.join(os.tmpdir(), 'flown-ocr-native-'))
  video = path.join(tmp, 'screen.mp4')
  // Two seconds at 30 fps of an evaluation frame scrolling up 6 px a frame, a key frame every 15.
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', FRAME, '-vf', "crop=1920:1000:0:'min(n*6\\,80)',pad=1920:1080", '-frames:v', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`)
})
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('ssw-ocr with main’s OcrHelper', () => {
  it('opens with the checked pins, looks, reads a frame by its key frame, re-reads carefully, and follows a line', async () => {
    const { OcrHelper } = await import('../../src/main/privacy/readerHelper')
    const helper = await OcrHelper.start({ path: HELPER, open: { pins, ffmpeg: FFMPEG } })
    try {
      const frames: { t: number; key: boolean; moves: { dy: number }[] }[] = []
      await helper.look({ video, k: 4, step: 1, from: 0, to: 10 }, (f) => frames.push(...f), new AbortController().signal)
      expect(frames).toHaveLength(60)
      expect(frames.filter((f) => f.key).map((f) => Math.round(f.t * 30))).toEqual([0, 15, 30, 45])
      expect(frames[5].moves.some((m) => Math.abs(m.dy + 6) <= 1)).toBe(true)
      const t = frames[20].t
      const { id, result } = await helper.read({ video, key: frames[15].t, t, areas: [[300, 60, 900, 300]] }, new AbortController().signal)
      expect(result.t).toBeCloseTo(t, 6)
      const texts = result.lines.map((l) => l.variants[0].text)
      expect(texts.join(' ')).toMatch(/DATABASE_URL/)
      expect(helper.refusedLines).toBe(0)
      const careful = await helper.careful(id, [0, 1])
      expect(careful.map((c) => c[0].model)).toEqual(['small', 'small'])
      const line = result.lines.find((l) => l.variants[0].text.includes('DATABASE'))!
      const session = await helper.followOpen({ video, key: frames[15].t, from: t, to: frames[30].t, dir: 1 }, new AbortController().signal)
      await session.track(1, t, [line.box])
      // The scroll stops at frame 14 (80 px): frame 21 shows the line where frame 20 did.
      const m = await session.match(frames[21].t, [{ track: 1, parts: [0], candidates: [{ dx: 0, dy: 0, scale: 1 }] }])
      expect(m[0].parts[0]).toBeGreaterThan(0.6)
      await session.close()
    } finally {
      await helper.stop()
    }
    expect(await helper.exited).toBe(0)
  }, 120_000)

  it('without the reader, as Follow starts it (findIpc readerStart): opened with no files it answers model, then still looks and follows by template', async () => {
    const { OcrHelper } = await import('../../src/main/privacy/readerHelper')
    const { readerStart } = await import('../../src/main/privacy/findIpc')
    const start = readerStart({ startReader: () => Promise.reject(new Error('no reader')), startHelper: () => OcrHelper.start({ path: HELPER }), ffmpeg: () => FFMPEG })
    await expect(start(true)).rejects.toMatchObject({ reason: 'helper' })
    const helper = await start(false)
    try {
      const frames: { t: number }[] = []
      await helper.look({ video, k: 4, step: 1, from: 0, to: 10 }, (f) => frames.push(...f), new AbortController().signal)
      expect(frames).toHaveLength(60)
      const t = frames[20].t
      const session = await helper.followOpen({ video, key: frames[15].t, from: t, to: frames[30].t, dir: 1 }, new AbortController().signal)
      await session.track(1, t, [[300, 60, 600, 40]])
      const m = await session.match(frames[21].t, [{ track: 1, parts: [0], candidates: [{ dx: 0, dy: 0, scale: 1 }] }])
      expect(m[0].parts[0]).toBeGreaterThan(0.6)
      await session.close()
    } finally {
      await helper.stop()
    }
    expect(await helper.exited).toBe(0)
  }, 120_000)
})
