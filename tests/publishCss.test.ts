// The Publish dialog's text fields reach WCAG AA (4.5:1 for their 12px text), read from the stylesheets.
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

/** The value of `prop` on `selector`: the last rule that lists the selector wins, as in the cascade. */
function declared(text: string, selector: string, prop: string): string {
  let value = ''
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!m[1].split(',').some((s) => s.trim() === selector)) continue
    for (const d of m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))) value = d[1].trim()
  }
  // No background of its own: Chromium's dark field colour shows (#3b3b3b with color-scheme: dark).
  if (!value) throw new Error(`no ${prop} on ${selector}`)
  return value
}

function resolve(value: string, vars: Record<string, string>): RGB {
  const ref = value.match(/^var\((--[\w-]+)\)$/)
  if (ref) return resolve(vars[ref[1]], vars)
  if (/^#[0-9a-f]{6}$/i.test(value)) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB
  throw new Error(`unparsed colour ${value}`)
}

const lum = (c: RGB): number => {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: RGB, b: RGB): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

describe('Publish dialog text fields (publish-pack §5.4)', () => {
  const publish = css('publish/publish.css')
  const vars = tokens(css('styles.css'))
  const colour = (selector: string, prop: string): RGB => resolve(declared(publish, selector, prop), vars)

  it('the text, the greyed text while a card is written again and "Not written yet." on the field', () => {
    for (const field of ['.publish-text', '.publish-tags']) {
      const fill = colour(field, 'background')
      expect(contrast(colour(field, 'color'), fill), field).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colour(`${field}::placeholder`, 'color'), fill), `${field}::placeholder`).toBeGreaterThanOrEqual(4.5)
    }
    // The safety net's note (§4.8): its title, its text and the links in it.
    const note = colour('.publish-check', 'background')
    for (const sel of ['.publish-check', '.publish-check-title', '.publish-check code']) expect(contrast(colour(sel, 'color'), note), sel).toBeGreaterThanOrEqual(4.5)
    const fill = colour('.publish-text', 'background')
    for (const status of ['waiting', 'writing']) {
      const sel = `.publish-card[data-status='${status}'] .publish-text`
      expect(contrast(colour(sel, 'color'), fill), sel).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("a card's notice wraps a long link inside the card (the safety net's, with Copy)", () => {
    expect(declared(publish, '.publish-said', 'overflow-wrap')).toBe('anywhere')
  })
})
