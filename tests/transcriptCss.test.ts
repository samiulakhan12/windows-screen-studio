// The Transcript tab's selected words (docs/design/edit-by-text.md §5), read from the stylesheets.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

type RGB = [number, number, number]
const SRC = path.resolve(__dirname, '../src/renderer/src')
const css = (file: string): string => readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties declared in `text` (the first declaration of each). */
function tokens(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] ??= m[2].trim()
  return out
}

/** The value of `prop` on `selector` (the last rule that lists it), or '' when none sets it. */
function declared(text: string, selector: string, prop: string): string {
  let value = ''
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!m[1].split(',').some((s) => s.trim() === selector)) continue
    for (const d of m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))) value = d[1].trim()
  }
  return value
}

/** A colour token as sRGB over `under` (rgba blended). */
function colour(value: string, vars: Record<string, string>, under: RGB = [0, 0, 0]): RGB {
  const ref = /^var\((--[\w-]+)\)$/.exec(value)
  if (ref) return colour(vars[ref[1]], vars, under)
  if (/^#[0-9a-f]{6}$/i.test(value)) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB
  const rgba = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(value)
  if (rgba) {
    const a = Number(rgba[4])
    return [1, 2, 3].map((i, k) => Number(rgba[i]) * a + under[k] * (1 - a)) as RGB
  }
  throw new Error(`unparsed colour ${value}`)
}

const lum = (c: RGB): number => {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: RGB, b: RGB): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

describe('selected words in the transcript', () => {
  const sheet = css('editor/panels/transcript.css')
  const vars = tokens(css('styles.css'))
  const list = colour(declared(sheet, '.transcript-words', 'background'), vars)

  it('carry an outline at 3:1 or more against the words around them (WCAG 1.4.11), which forced colours keep', () => {
    const outline = declared(sheet, '.tw.selected', 'outline')
    const m = /^(\d+(?:\.\d+)?)px solid (var\(--[\w-]+\))$/.exec(outline)
    expect(m, `outline: ${outline}`).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(1)
    const ring = colour(m![2], vars)
    const tint = colour(declared(sheet, '.tw.selected', 'background'), vars, list)
    expect(contrast(ring, list)).toBeGreaterThanOrEqual(3)
    expect(contrast(ring, tint)).toBeGreaterThanOrEqual(3)
  })

  it('the focused word stands out from the selected ones around it: a wider ring', () => {
    const width = (selector: string): number => {
      const outline = declared(sheet, selector, 'outline').replace(/^var\((--[\w-]+)\)/, (_, v: string) => vars[v])
      return Number(/^(\d+(?:\.\d+)?)px solid /.exec(outline)?.[1] ?? NaN)
    }
    expect(width('.transcript-words:focus-visible .tw.focus')).toBeGreaterThan(width('.tw.selected'))
  })
})
