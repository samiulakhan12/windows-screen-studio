// The Inspector's labelled tab rail is used only where it fits (editor.css), read from the stylesheets.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../src/renderer/src')
const read = (file: string): string => readFileSync(path.join(SRC, file), 'utf8')
const css = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties declared in `text` (the first declaration of each). */
function tokens(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] ??= m[2].trim()
  return out
}

describe('the Inspector tab rail', () => {
  const editor = css('editor/editor.css')
  const vars = tokens(css('styles.css'))
  // The rules outside the compact rail's container query (it is the file's only @container).
  const plain = editor.slice(0, editor.indexOf('@container inspector'))
  const value = (selector: string, prop: string): string => {
    let out = ''
    for (const m of plain.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!m[1].split(',').some((s) => s.trim() === selector)) continue
      for (const d of m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))) out = d[1].trim()
    }
    if (!out) throw new Error(`no ${prop} on ${selector}`)
    return out.replace(/var\((--[\w-]+)\)/g, (_, v: string) => vars[v])
  }
  const px = (v: string): number[] => v.split(/\s+/).map((x) => parseFloat(x))

  it('turns compact on any Inspector shorter than the labelled rail with every tab, the Selection tab included', () => {
    // Twelve tabs, and the Selection tab while several items are selected.
    const tabs = (read('editor/Inspector.tsx').match(/const TABS[\s\S]*?\n\]/)?.[0].match(/\{ id: '/g) ?? []).length + 1
    expect(tabs).toBe(13)
    const [padTop, , padBottom] = px(value('.insp-tabs button', 'padding'))
    const label = px(value('.insp-tabs button', 'font-size'))[0] * Number(value('.insp-tabs button', 'line-height'))
    const button = padTop + 17 + px(value('.insp-tabs button', 'gap'))[0] + label + padBottom
    const rail = px(value('.insp-tabs', 'padding'))[0] * 2 + (tabs - 1) * px(value('.insp-tabs', 'gap'))[0] + tabs * button
    const threshold = Number(/@container inspector \(max-height: (\d+)px\)/.exec(editor)?.[1])
    expect(threshold).toBeGreaterThanOrEqual(Math.ceil(rail))
  })
})
