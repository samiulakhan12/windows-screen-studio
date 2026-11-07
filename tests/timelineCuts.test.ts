/**
 * The timeline's cut markers (docs/design/editing-polish.md §2.1, §12; §19.1 test 22): a marker of
 * fixed size on every cut whatever its block's width, markers closer than 12 px merged with a
 * count that selects the first, each style's glyph, the accessible name, and the markers' colours
 * from the tokens with enough contrast.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CUT_MARKER, cutMarkers, markerName } from '../src/shared/editor/timelineCuts'
import { createProject } from '../src/shared/engine/project'
import type { Clip, Project, ProjectJoins } from '../src/shared/types'

function project(clips: Clip[], joins?: ProjectJoins): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 600,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  return { ...p, clips, ...(joins ? { joins } : {}) }
}

/** 38 clips with a 1.6 s cut before each but the first; cut 5 is 83.4–85.0 s. */
function clips38(): Clip[] {
  const out: Clip[] = []
  let t = 0
  for (let i = 0; i < 38; i++) {
    const len = i === 4 ? 85 - 1.6 - t : 2
    out.push({ id: `c${i}`, start: t, end: t + len, speed: 1 })
    t += len + 1.6
  }
  return out
}

describe('cut markers (test 22)', () => {
  it('gives every cut a 12 px glyph in a 24 × 24 px target, a 1 px block included', () => {
    expect(CUT_MARKER).toEqual({ glyph: 12, target: 24, merge: 12 })
    const p = project(clips38())
    // At 20 px a second each 1.6 s cut block is 32 px wide; at 0.625 px a second it is 1 px.
    for (const px of [20, 1 / 1.6]) {
      const markers = cutMarkers(p, px)
      const blocks = p.clips.slice(1).map((c, i) => ({ start: p.clips[i].end, end: c.start }))
      if (px === 20) expect(markers).toHaveLength(37)
      for (const m of markers) {
        const b = blocks[m.index]
        expect(m.gap).toEqual(b)
        expect(m.x).toBeCloseTo(((b.start + b.end) / 2) * px, 9)
      }
    }
    // The stylesheet: the target is 24 × 24 px whatever the block, centred on it, with a 12 px glyph.
    const css = readFileSync(path.resolve(__dirname, '../src/renderer/src/editor/panels/cuts.css'), 'utf8')
    const rule = /\.cut-marker \{([^}]*)\}/.exec(css)![1]
    expect(rule).toMatch(/width: 24px/)
    expect(rule).toMatch(/height: 24px/)
    expect(rule).toMatch(/margin-left: -12px/)
    const glyphs = readFileSync(path.resolve(__dirname, '../src/renderer/src/editor/CutMarkers.tsx'), 'utf8')
    expect(glyphs).toMatch(/width: 12, height: 12/)
  })

  it('merges markers closer than 12 px into one with a count that selects the first', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 10, speed: 1 },
      { id: 'b', start: 10.25, end: 10.5, speed: 1 },
      { id: 'c', start: 10.7, end: 11, speed: 1 },
      { id: 'd', start: 11.2, end: 30, speed: 1 },
      { id: 'e', start: 31, end: 40, speed: 1 }
    ]
    const markers = cutMarkers(project(clips), 10)
    // Cuts at 10.1, 10.6 and 11.1 s are 5 px apart at 10 px a second: one marker; the cut at 30.5 s stands alone.
    expect(markers.map((m) => [m.index, m.count])).toEqual([
      [0, 3],
      [3, 1]
    ])
    expect(markers[0].gap).toEqual({ start: 10, end: 10.25 })
    expect(markers[0].name).toBe('Cut 1 of 4: 0:10.0 to 0:10.2, hard cut, and 2 more cuts')
    // Zoomed in far enough, they come apart.
    expect(cutMarkers(project(clips), 100).map((m) => m.count)).toEqual([1, 1, 1, 1])
  })

  it('shows each cut\'s own style, else every cut\'s, and names it', () => {
    const p = project(clips38(), { all: { kind: 'crossfade' }, cuts: [{ clip: 'c2', kind: 'dip' }, { clip: 'c3', kind: 'slide' }, { clip: 'c6', kind: 'punch' }, { clip: 'c7', kind: 'smooth' }, { clip: 'c8', kind: 'cut' }] })
    const kinds = cutMarkers(p, 20).slice(0, 8).map((m) => m.kind)
    expect(kinds).toEqual(['crossfade', 'dip', 'slide', 'crossfade', 'crossfade', 'punch', 'smooth', 'cut'])
    expect(cutMarkers(p, 20)[4].name).toBe('Cut 5 of 37: 1:23.4 to 1:25.0, crossfade')
    expect(cutMarkers(project(clips38()), 20)[0].kind).toBe('cut')
    expect(markerName(5, 37, { start: 83.4, end: 85 }, 'punch')).toBe('Cut 5 of 37: 1:23.4 to 1:25.0, punch-in')
    // Every style has a glyph of its own shape (never colour alone).
    const src = readFileSync(path.resolve(__dirname, '../src/renderer/src/editor/CutMarkers.tsx'), 'utf8')
    for (const k of ['smooth', 'crossfade', 'dip', 'slide', 'punch']) expect(src).toContain(`case '${k}':`)
  })

  it('lists only the markers in view', () => {
    const p = project(clips38())
    const all = cutMarkers(p, 20)
    const some = cutMarkers(p, 20, { start: 90, end: 110 })
    expect(some.length).toBeGreaterThan(0)
    expect(some.length).toBeLessThan(all.length)
    for (const m of some) {
      expect(m.x).toBeGreaterThanOrEqual(90 * 20 - 24)
      expect(m.x).toBeLessThanOrEqual(110 * 20 + 24)
    }
  })

  it('draws the glyphs and the count from the tokens with enough contrast', () => {
    const SRC = path.resolve(__dirname, '../src/renderer/src')
    const css = readFileSync(path.join(SRC, 'editor/panels/cuts.css'), 'utf8')
    const styles = readFileSync(path.join(SRC, 'styles.css'), 'utf8')
    const tokens: Record<string, string> = {}
    for (const m of styles.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) tokens[m[1]] ??= m[2].trim()
    const declared = (sel: string, prop: string): string => {
      const block = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)![1]
      return new RegExp(`${prop}: ([^;]+);`).exec(block)![1].trim()
    }
    const rgb = (v: string): number[] => {
      const ref = /^var\((--[\w-]+)\)$/.exec(v)
      if (ref) return rgb(tokens[ref[1]])
      return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16))
    }
    const lum = (c: number[]): number => {
      const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a: number[], b: number[]): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    // Every colour is a token.
    for (const m of css.matchAll(/(?:color|background): ([^;]+);/g)) expect(m[1].trim()).toMatch(/^(var\(--[\w-]+\)|transparent)$/)
    expect(contrast(rgb(declared('.cut-marker-count', 'color')), rgb(declared('.cut-marker-count', 'background')))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rgb(declared('.cut-marker-glyph', 'color')), rgb(declared('.cut-marker-glyph', 'background')))).toBeGreaterThanOrEqual(4.5)
    // The glyph against the clip track (the editor's darkest surface) is at least 3:1, as graphics need.
    expect(contrast(rgb(declared('.cut-marker-glyph', 'color')), rgb('var(--surface-0)'))).toBeGreaterThanOrEqual(3)
  })
})
