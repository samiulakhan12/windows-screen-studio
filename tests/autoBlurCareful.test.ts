import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { detectFrame } from '../src/shared/privacy/detect/detect'
import { NO_NAMES } from '../src/shared/privacy/detect/names'
import { DEFAULT_KINDS } from '../src/shared/privacy/kinds'
import { loadReads } from './autoBlurRulesFixtures'

/*
 * The careful pass as main asks for it (docs/design/auto-blur.md §5.6, question 16; §17.1 test 97):
 * on the committed main-set tiny reads, served by the fake helper, main asks the helper to read
 * again exactly the lines P3's needsCareful picks, and each answer lands on its own line.
 */

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => tmpdir(), getPath: () => tmpdir() } }))
vi.mock('../src/main/recording/toolbarWindow', () => ({ isToolbarVisible: () => false }))

const { carefulLines, OcrHelper, withCareful } = await import('../src/main/privacy/readerHelper')
const { needsCareful } = await import('../src/shared/privacy/detect/detect')

const FAKE = path.resolve(__dirname, 'fixtures/fake-ocr-helper.cjs')
const dir = mkdtempSync(path.join(tmpdir(), 'flown-careful-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('auto-blur P2: the careful pass', () => {
  it("97. careful re-reads exactly the lines needsCareful picked on the committed main-set tiny reads (P3's function on reads/main-tiny.json.gz)", async () => {
    const frames = loadReads('main-tiny')
    expect(frames).toHaveLength(24)
    const scriptFile = path.join(dir, 'script.json')
    const logFile = path.join(dir, 'log.jsonl')
    writeFileSync(scriptFile, JSON.stringify({ reads: Object.fromEntries(frames.map((f, i) => [String(i + 1), { lines: f.lines }])) }))
    writeFileSync(logFile, '')
    process.env.SSW_OCR_SCRIPT = scriptFile
    process.env.SSW_OCR_LOG = logFile
    const helper = await OcrHelper.start({ path: FAKE, open: { pins: [], ffmpeg: 'ffmpeg' } })
    let lines = 0
    let picked = 0
    try {
      for (const [i, f] of frames.entries()) {
        const { id, result } = await helper.read({ video: 'screen.mp4', key: 0, t: i, areas: [] }, new AbortController().signal)
        expect(result.lines).toEqual(f.lines)
        const hits = detectFrame(result.lines, result.qr, { kinds: DEFAULT_KINDS, regions: ['US', 'GB', 'BD'], names: NO_NAMES, frame: { width: 1920, height: 1080 } })
        const pick = carefulLines(result, hits)
        expect(pick).toEqual(result.lines.flatMap((l, k) => (needsCareful(l, hits, k) ? [k] : [])))
        lines += result.lines.length
        picked += pick.length
        if (!pick.length) {
          helper.release(id)
          continue
        }
        const careful = await helper.careful(id, pick)
        const merged = withCareful(result, pick, careful)
        merged.lines.forEach((l, k) => {
          if (pick.includes(k)) expect(l.variants.at(-1)).toEqual({ model: 'small', text: `careful ${k}`, conf: 0.99, spans: [] })
          else expect(l.variants).toHaveLength(1)
        })
      }
    } finally {
      await helper.stop()
      delete process.env.SSW_OCR_SCRIPT
      delete process.env.SSW_OCR_LOG
    }
    // What went on the wire: one careful a frame with lines to read again, exactly those lines.
    const sent = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).line)
      .filter((l) => l && l.op === 'careful')
    expect(sent.reduce((s: number, c: { lines: number[] }) => s + c.lines.length, 0)).toBe(picked)
    // careful-long reads about 30% of lines again (§5.6).
    expect(picked / lines).toBeGreaterThan(0.15)
    expect(picked / lines).toBeLessThan(0.5)
  }, 60_000)
})
