// The search results' stylesheet (docs/design/search.md §5), read as text.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../src/renderer/src')
const css = readFileSync(path.join(SRC, 'search/search.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const component = readFileSync(path.join(SRC, 'search/LibrarySearch.tsx'), 'utf8')

/** The values of `prop` on `selector`, in source order. */
const values = (selector: string, prop: string): string[] =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector))
    .flatMap((m) => [...m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))].map((d) => d[1].trim()))

describe('the results list with no rows', () => {
  it('is hidden by its own rule, which a class that sets `display` would otherwise beat', () => {
    // The list box is marked `hidden` when it has no rows (a query that finds nothing, or before the first answer).
    expect(component).toMatch(/role="listbox"[^>]*className="search-list"[^>]*hidden=\{rows\.length === 0\}/)
    // Its class lays it out, which overrides the browser's `[hidden] { display: none }`...
    expect(values('.search-list', 'display')).toEqual(['flex'])
    // ...so an empty "Search results" list box stays on the page and in the accessibility tree unless this hides it.
    expect(values('.search-list[hidden]', 'display')).toEqual(['none'])
  })
})
