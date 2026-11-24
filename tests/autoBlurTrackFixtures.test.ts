import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import ffmpegStatic from 'ffmpeg-static'
import { detectFrame } from '../src/shared/privacy/detect/detect'
import { compileNames } from '../src/shared/privacy/detect/names'
import { DEFAULT_KINDS } from '../src/shared/privacy/kinds'
import { line } from './autoBlurRulesFixtures'

/*
 * scripts/privacy/make-track-fixtures.mjs (docs/design/auto-blur.md §16.0 item 13, A16; §17.1 test
 * 196): a short list scroll, rendered losslessly, whose truth boxes hold each planted item's ink in
 * every decoded frame.
 */

const ROOT = path.join(__dirname, '..')
const out = mkdtempSync(path.join(tmpdir(), 'flown-track-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))
const ffmpeg = (ffmpegStatic as unknown as string | null) ?? 'ffmpeg'

interface Truth {
  fps: number
  width: number
  height: number
  frames: { n: number; items: { id: string; kind: string; on: boolean; text: string; box: [number, number, number, number] }[] }[]
}

describe('auto-blur contracts: tracking fixtures', () => {
  it("196. Tracking fixtures: make-track-fixtures.mjs renders a 2 s list scroll; its truth file has a box for every planted item in every one of the 120 frames, and each box holds that item's ink in the decoded frame (no ink outside the box within its line)", () => {
    const W = 480
    const H = 300
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/privacy/make-track-fixtures.mjs'), out, '--case', 'list-scroll', '--seconds', '2', '--size', `${W}x${H}`], { env: { ...process.env, FFMPEG: ffmpeg }, stdio: 'pipe' })
    const truth = JSON.parse(readFileSync(path.join(out, 'list-scroll.truth.json'), 'utf8')) as Truth
    expect(truth.fps).toBe(60)
    expect(truth.frames.map((f) => f.n)).toEqual(Array.from({ length: 120 }, (_v, i) => i))
    // Lossless, 60 frames a second, 120 frames.
    let info = ''
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-i', path.join(out, 'list-scroll.mp4')], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      info = String((e as { stderr?: Buffer }).stderr ?? '')
    }
    expect(info).toMatch(/Video: h264 \(High 4:4:4 Predictive\)[^\n]*gbrp/)
    expect(info).toMatch(/ 60 fps/)
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', path.join(out, 'list-scroll.mp4'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 })
    expect(raw.length).toBe(W * H * 3 * 120)
    const bg = [raw[0], raw[1], raw[2]]
    const ink = (f: number, x: number, y: number): boolean => {
      const i = ((f * H + y) * W + x) * 3
      return Math.abs(raw[i] - bg[0]) + Math.abs(raw[i + 1] - bg[1]) + Math.abs(raw[i + 2] - bg[2]) > 90
    }
    let boxes = 0
    for (const frame of truth.frames) {
      // Every planted row on screen has its box: each fully visible planted line is listed.
      expect(frame.items.length, `frame ${frame.n}`).toBeGreaterThanOrEqual(4)
      for (const it of frame.items) {
        const [x, y, w, h] = it.box
        expect(w > 0 && h > 0, `${it.id} in frame ${frame.n}`).toBe(true)
        let inside = 0
        let outside = 0
        for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++)
          for (let xx = 0; xx < W; xx++) {
            if (!ink(frame.n, xx, yy)) continue
            if (xx >= x - 1 && xx < x + w + 1) inside++
            else outside++
          }
        // A box cut by the frame's edge may hold only the space above or below the glyphs; any other holds ink.
        const cut = y <= 0 || y + h >= H
        if (!cut) expect(inside, `${it.id} (${it.text}) in frame ${frame.n}: ink in its box`).toBeGreaterThan(0)
        expect(outside, `${it.id} (${it.text}) in frame ${frame.n}: ink beside its box on its line`).toBe(0)
        boxes++
      }
    }
    expect(boxes).toBeGreaterThan(400)
  }, 120_000)

  it('The tracking set plants what Find finds: in every case drawn as rows of text, each on-by-default planted item is found by the default rules from the page\'s own lines (a password by its label, §6.7 and decision 2; planted unlabelled, A16 counted it uncovered in every frame)', async () => {
    type Case = (v: unknown) => { html: string }
    const { CASES, plantValues } = (await import('../scripts/privacy/make-track-fixtures.mjs')) as unknown as { CASES: Record<string, Case>; plantValues: (tok: unknown) => unknown }
    const { KINDS, makeTokens } = (await import('../scripts/privacy/eval-lib.mjs')) as unknown as { KINDS: Record<string, { on: boolean }>; makeTokens: (seed: number) => unknown }
    const values = plantValues(makeTokens(7000))
    const unescape = (t: string): string => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    for (const id of ['list-scroll', 'flick-scroll', 'browser-zoom', 'select-text', 'sticky-header', 'window-drag']) {
      // Each row is one line of the page: its spans' texts in order, the planted ones marked.
      const rows = [...CASES[id](values).html.matchAll(/<div class="(?:row|head)">(.*?)<\/div>/g)].map((m) => [...m[1].matchAll(/<span data-k="([a-zA-Z]+)" data-t="[^"]*">([^<]*)<\/span>/g)].map((x) => ({ kind: x[1], text: unescape(x[2]) })))
      expect(rows.length, id).toBeGreaterThan(2)
      const lines = rows.map((r, i) => line(r.map((x) => x.text).join(' '), 16, 20 + i * 28, { charW: 8, h: 17 }))
      const hits = detectFrame(lines, [], { kinds: [...DEFAULT_KINDS], regions: ['US'], names: compileNames([], []), frame: { width: 1280, height: 40 + rows.length * 28 } })
      const planted = rows.flatMap((r, i) => r.filter((x) => x.kind !== 'ordinary' && KINDS[x.kind]?.on).map((x) => ({ ...x, line: i })))
      expect(planted.length, id).toBeGreaterThan(0)
      for (const p of planted) {
        const at = lines[p.line].variants[0].text.indexOf(p.text)
        const found = hits.some((h) => h.spans.some((sp) => sp.line === p.line && sp.start < at + p.text.length && sp.end > at))
        expect(found, `${id}: ${p.kind} "${p.text}" on line ${p.line}`).toBe(true)
      }
    }
  })
})
