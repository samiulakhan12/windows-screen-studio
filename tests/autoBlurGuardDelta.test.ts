import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'

/*
 * scripts/i18n/guard-delta.mjs (docs/design/auto-blur.md §12.2; §17.1 test 39) on synthetic baseline
 * and run pairs: additions pass, every change to the baseline fails.
 */

type Box = { path: string; tag: string; box: number[]; font: string[]; color: string; direction: string; align: string }
type Screen = { name: string; title: string; text: string; attrs: Record<string, string>[]; boxes: Box[]; aria: string; main: unknown[] }
type Delta = { ok: boolean; problems: string[]; captures: { base: string; run: string; added: string[]; pushed: { element: string; by: string }[] }[]; added: string[] }
const GUARD = '../scripts/i18n/guard-delta.mjs'
const { guardDelta, decodePng } = (await import(/* @vite-ignore */ GUARD)) as { guardDelta(b: unknown, r: unknown, shots?: unknown): Delta; decodePng(b: Buffer): { width: number; height: number; data: Buffer } | null }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-guard-delta-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const FONT = ['Segoe UI', '12px', '400', '16px']
const el = (p: string, tag: string, y: number, x = 0, over: Partial<Box> = {}): Box => ({ path: p, tag, box: [x, y, 100, 20], font: FONT, color: 'rgb(1, 2, 3)', direction: 'ltr', align: 'left', ...over })

function home(): Screen {
  return {
    name: 'home',
    title: 'Flown',
    text: 'What to record\nPick the screen\nNew recording',
    attrs: [{ path: 'div>button:1', 'aria-label': 'Settings' }],
    boxes: [el('div>h2', 'h2', 10), el('div>p', 'p', 40), el('div>button:2', 'button', 80)],
    aria: '- heading "What to record" [level=2]\n- paragraph: Pick the screen\n- button "New recording"\n- button "Settings"',
    main: []
  }
}

/** A settings capture scrolled to section `at` of `sections`: that section's heading just below the dialog's own. */
function settings(name: string, sections: string[], at: number): Screen {
  return {
    name,
    title: 'Flown',
    text: ['Settings', ...sections].join('\n'),
    attrs: [],
    boxes: [el('div>h2', 'h2', 20, 0, { box: [0, 20, 100, 30] }), ...sections.map((_s, j) => el(`div>section:${j + 1}>h3`, 'h3', 60 + (j - at) * 300))],
    aria: ['- dialog "Settings":', '  - heading "Settings" [level=2]', ...sections.map((s) => `  - region "${s}":\n    - heading "${s}" [level=3]`)].join('\n'),
    main: []
  }
}

const tour = (screens: Screen[]): { screens: Screen[]; blocked: string[] } => ({ screens, blocked: [] })

/** An RGBA PNG, every pixel `rgba` except the first `odd` ones, which are `rgba` + `by` in red. */
function png(file: string, w: number, h: number, odd = 0, by = 0): void {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  let n = 0
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const at = y * (w * 4 + 1) + 1 + x * 4
      raw[at] = 120 + (n++ < odd ? by : 0)
      raw[at + 1] = 130
      raw[at + 2] = 140
      raw[at + 3] = 255
    }
  }
  const table = Array.from({ length: 256 }, (_v, i) => {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (kind: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(kind, 4, 'latin1')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

function shots(name: string, runOdd: number, by: number): { base: string; run: string } {
  const base = path.join(dir, `${name}-base`)
  const run = path.join(dir, `${name}-run`)
  fs.mkdirSync(base, { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  png(path.join(base, 'home.png'), 100, 100)
  png(path.join(run, 'home.png'), 100, 100, runOdd, by)
  return { base, run }
}

describe('auto-blur contracts: guard-delta.mjs', () => {
  it('39. guard-delta.mjs passes an added element and the box it pushed; fails a changed text, a changed accessible name, a removed element, a restyled element and a box moved with no added element; aligns settings-NN by heading and reports the added capture; holds the screenshot rule where nothing was added', () => {
    const base = tour([home()])
    // An added element (a section above the button) and the button it pushed down: additions only.
    const grown = home()
    grown.text = 'What to record\nPick the screen\nPrivate info\nNew recording'
    grown.aria = grown.aria.replace('- button "New recording"', '- heading "Private info" [level=3]\n- button "New recording"')
    grown.boxes = [el('div>h2', 'h2', 10), el('div>p', 'p', 40), el('div>h3', 'h3', 70, 0, { font: ['Segoe UI', '14px', '600', '18px'] }), el('div>button:2', 'button', 110)]
    const ok = guardDelta(base, tour([grown]))
    expect(ok.problems).toEqual([])
    expect(ok.ok).toBe(true)
    expect(ok.captures).toHaveLength(1)
    expect(ok.captures[0].added).toEqual(['div>h3'])
    expect(ok.captures[0].pushed).toEqual([expect.objectContaining({ element: 'div>button:2', by: 'div>h3' })])
    // The same run against itself: nothing added, nothing changed.
    expect(guardDelta(base, base)).toMatchObject({ ok: true, captures: [], added: [] })

    const changed = (edit: (s: Screen) => void): Delta => {
      const s = home()
      edit(s)
      return guardDelta(base, tour([s]))
    }
    const text = changed((s) => (s.text = s.text.replace('Pick the screen', 'Pick a screen')))
    expect(text.ok).toBe(false)
    expect(text.problems.join('\n')).toContain('text changed or removed: "Pick the screen"')
    const name = changed((s) => (s.aria = s.aria.replace('button "Settings"', 'button "Preferences"')))
    expect(name.ok).toBe(false)
    expect(name.problems.join('\n')).toContain('accessible name')
    const attr = changed((s) => (s.attrs = [{ path: 'div>button:1', 'aria-label': 'Preferences' }]))
    expect(attr.ok).toBe(false)
    const removed = changed((s) => (s.boxes = s.boxes.slice(0, 2)))
    expect(removed.ok).toBe(false)
    expect(removed.problems.join('\n')).toContain('removed: div>button:2')
    const restyled = changed((s) => (s.boxes[1] = { ...s.boxes[1], color: 'rgb(9, 9, 9)' }))
    expect(restyled.ok).toBe(false)
    expect(restyled.problems.join('\n')).toContain('restyled: div>p')
    const moved = changed((s) => (s.boxes[2] = { ...s.boxes[2], box: [0, 84, 100, 20] }))
    expect(moved.ok).toBe(false)
    expect(moved.problems.join('\n')).toContain('moved with no added element: div>button:2')
    expect(guardDelta(base, tour([])).problems).toEqual(['home: missing from the run'])

    // Settings: a section inserted after "Captions on this PC"; the later captures shift by one and align by heading.
    const before = ['AI providers', 'Captions on this PC', 'AI on this PC', 'Brand kit']
    const after = ['AI providers', 'Captions on this PC', 'Private info', 'AI on this PC', 'Brand kit']
    const numbered = (i: number): string => `settings-${String(i + 1).padStart(2, '0')}`
    const sBase = tour([settings('settings', before, 0), ...before.map((_s, i) => settings(numbered(i), before, i))])
    const sRun = tour([settings('settings', after, 0), ...after.map((_s, i) => settings(numbered(i), after, i))])
    const aligned = guardDelta(sBase, sRun)
    expect(aligned.problems).toEqual([])
    expect(aligned.ok).toBe(true)
    expect(aligned.added).toEqual(['settings-03'])
    expect(aligned.captures.find((c) => c.base === 'settings-03')?.run).toBe('settings-04')
    expect(aligned.captures.find((c) => c.base === 'settings-04')?.run).toBe('settings-05')

    // The screenshot rule, for a capture with no addition: 0.05% of pixels off by 2 passes; 1% off by 3 fails.
    expect(decodePng(fs.readFileSync((png(path.join(dir, 'probe.png'), 3, 2, 1, 5), path.join(dir, 'probe.png'))))?.data.subarray(0, 8)).toEqual(Buffer.from([125, 130, 140, 255, 120, 130, 140, 255]))
    expect(guardDelta(base, base, shots('near', 5, 2)).ok).toBe(true)
    const off = guardDelta(base, base, shots('off', 100, 3))
    expect(off.ok).toBe(false)
    expect(off.problems).toEqual(['home: screenshot: 100 pixels differ, by up to 3 levels'])
    expect(guardDelta(base, base, shots('many', 20, 1)).problems).toEqual(['home: screenshot: 20 pixels differ (more than 0.1% of 10000)'])
    // A capture with additions is listed for a look, not held to the rule.
    expect(guardDelta(base, tour([grown]), shots('grown', 100, 3)).ok).toBe(true)
  })
})
