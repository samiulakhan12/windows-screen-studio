import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A private row in Review (docs/design/auto-blur.md §2.7) holds its title, Keep covered and Uncover,
 * and under them its places and badges and Select, Peek and Listen, each line taking the whole row
 * (`flex-basis: 100%`). Found end to end (A3): a row that did not wrap squeezed its title into a
 * column one letter wide. The row wraps, as a group row does.
 */
const css = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'privacy', 'privacyPanel.css'), 'utf8')

/** The declarations of the rules whose selector list holds `selector`. */
function declarationsFor(selector: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim())
    if (selectors.includes(selector)) out.push(m[2])
  }
  return out
}

describe("Review's private rows", () => {
  it('wrap, so their info and action lines go under the title', () => {
    for (const sel of ['.review-row:has(> .review-private-info)', '.review-row:has(> .review-private-actions)']) {
      expect(declarationsFor(sel).some((d) => /flex-wrap:\s*wrap/.test(d)), sel).toBe(true)
    }
  })

  it('give those lines the whole row', () => {
    for (const sel of ['.review-private-info', '.review-private-actions']) {
      expect(declarationsFor(sel).some((d) => /flex-basis:\s*100%/.test(d)), sel).toBe(true)
    }
  })
})
