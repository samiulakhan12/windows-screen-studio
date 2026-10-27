import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYMAP, normalizeShortcut } from '../src/shared/editor/shortcuts'

/*
 * The README's "Editor shortcuts" table says it lists the defaults (INT-2): every default
 * binding in DEFAULT_KEYMAP is named in its Key column, alternatives in brackets as
 * "`Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`)".
 */

const ROOT = path.resolve(__dirname, '..')
const ARROWS: Record<string, string> = { '←': 'Left', '→': 'Right', '↑': 'Up', '↓': 'Down' }

/** The keys the table's Key column names, as canonical accelerators ("`1`–`4`" is 1, 2, 3 and 4). */
function readmeKeys(): Set<string> {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const section = readme.split('### Editor shortcuts')[1]?.split(/\n#{2,3} /)[0] ?? ''
  const cells = section
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*(Key|-+)\s*\|/.test(line))
    .map((line) => line.split('|')[1])
  const keys = new Set<string>()
  for (const cell of cells) {
    const named = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    for (const m of cell.matchAll(/`(\d)`–`(\d)`/g)) for (let d = Number(m[1]) + 1; d < Number(m[2]); d++) named.push(String(d))
    for (const name of named) {
      const key = normalizeShortcut(name.replace(/[←→↑↓]/g, (a) => ARROWS[a]))
      if (key) keys.add(key)
    }
  }
  return keys
}

describe('README: Editor shortcuts', () => {
  it('names every default binding', () => {
    const keys = readmeKeys()
    const missing = Object.entries(DEFAULT_KEYMAP).flatMap(([id, bindings]) => bindings.filter((b) => !keys.has(b)).map((b) => `${id}: ${b}`))
    expect(missing).toEqual([])
  })
})
