// Labels on coloured fills reach WCAG AA (4.5:1 for text this small), read from the stylesheets.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

type RGB = [number, number, number]
const SRC = path.resolve(__dirname, '../src/renderer/src')
const WHITE: RGB = [255, 255, 255]

const css = (file: string): string => readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties declared in `text` (the first declaration of each). */
function tokens(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] ??= m[2].trim()
  return out
}

/** The value of `prop` on `selector`: the last rule that lists the selector wins, as in the cascade. */
function declared(text: string, selector: string, prop: string): string {
  let value = ''
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!m[1].split(',').some((s) => s.trim() === selector)) continue
    for (const d of m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))) value = d[1].trim()
  }
  if (!value) throw new Error(`no ${prop} on ${selector}`)
  return value
}

function resolve(value: string, vars: Record<string, string>): RGB {
  const ref = value.match(/^var\((--[\w-]+)\)$/)
  if (ref) return resolve(vars[ref[1]], vars)
  if (/^#[0-9a-f]{6}$/i.test(value)) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB
  if (value === 'white') return WHITE
  throw new Error(`unparsed colour ${value}`)
}

/** The colours of a background: each `color-mix(in srgb, A p%, B [q%])` in it, or its one colour. */
function fills(value: string, vars: Record<string, string>): RGB[] {
  const mixes = [...value.matchAll(/color-mix\(in srgb, (var\(--[\w-]+\)|#[0-9a-f]{6}) (\d+)%, (var\(--[\w-]+\)|#[0-9a-f]{6})(?: (\d+)%)?\)/gi)]
  if (!mixes.length) return [resolve(value, vars)]
  return mixes.map(([, a, p, b, q]) => {
    const wa = Number(p) / 100
    const wb = q === undefined ? 1 - wa : Number(q) / 100
    const ca = resolve(a, vars)
    const cb = resolve(b, vars)
    return ca.map((x, i) => (x * wa + cb[i] * wb) / (wa + wb)) as RGB
  })
}

const lum = (c: RGB): number => {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: RGB, b: RGB): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

describe('label contrast on coloured fills', () => {
  const toolbar = css('views/Toolbar.css')
  const presets = css('editor/panels/stylePanel.css')
  const vars = { ...tokens(css('styles.css')), ...tokens(toolbar) }

  it('white labels on the red fills: Stop, the Discard / Restart confirm and the preset delete confirm', () => {
    const rules: [string, string][] = [
      [toolbar, '.rec-bar .tb-btn.stop'],
      [toolbar, '.rec-bar .tb-btn.stop:hover'],
      [toolbar, '.rec-bar .tb-text-btn.danger'],
      [presets, '.preset-tool.confirm']
    ]
    // The reds as they are, and a lighter one (the brand's #ff4757).
    for (const red of [null, '#ff4757']) {
      const v = red ? { ...vars, '--record': red, '--danger-500': red } : vars
      for (const [text, sel] of rules) {
        for (const fill of fills(declared(text, sel, 'background'), v)) {
          expect(contrast(WHITE, fill), `${sel} (${red ?? 'tokens'})`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('the caption block label at every stop of its gradient, also under the hover brightness(1.1)', () => {
    const captions = css('editor/captions.css')
    const label = resolve(declared(captions, '.seg.caption-seg', 'color'), vars)
    const stops = fills(declared(captions, '.seg.caption-seg', 'background'), vars)
    expect(stops).toHaveLength(2)
    for (const s of stops) {
      expect(contrast(label, s)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(label, s.map((x) => Math.min(255, x * 1.1)) as RGB)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
