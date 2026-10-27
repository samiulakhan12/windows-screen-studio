// The Captions tab's job ring stays visible on the compact inspector rail, read from the stylesheets.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../src/renderer/src')
const css = (file: string): string => readFileSync(path.join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The innermost rules of `text` (a rule inside @container or @media is listed on its own). */
const rules = (text: string): { selectors: string[]; body: string }[] =>
  [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }))

/** The values of `prop` on `selector`, in source order. */
const values = (text: string, selector: string, prop: string): string[] =>
  rules(text)
    .filter((r) => r.selectors.includes(selector))
    .flatMap((r) => [...r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))].map((d) => d[1].trim()))

/** A simple selector's specificity as one comparable number (ids, then classes and attributes, then elements). */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
  const elements = selector.split(/[\s>+~]+/).filter((part) => /^[a-z]/i.test(part)).length
  return ids * 10000 + classes * 100 + elements
}

describe('the captions job ring on the compact rail (UI-4)', () => {
  const HIDE = '.insp-tabs button span'
  const BADGE = '.insp-tabs button span.captions-job-badge'

  it('the compact rail hides the tab labels, which are spans like the ring', () => {
    expect(values(css('editor/editor.css'), HIDE, 'display')).toContain('none')
  })

  it("the ring's own rule shows it, and wins over the compact rail's", () => {
    const display = values(css('editor/captions.css'), BADGE, 'display')
    expect(display.length).toBeGreaterThan(0)
    expect(display).not.toContain('none')
    expect(specificity(BADGE)).toBeGreaterThan(specificity(HIDE))
  })
})
