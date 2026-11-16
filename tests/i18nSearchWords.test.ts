/**
 * Home's search in the UI language (docs/design/output-and-languages.md §10.3 rule 1, part X4): the
 * renderer's rows.ts says the kinds, the spoken times and the results' sentence through messages,
 * and in English each equals the English form shared/search/moment.ts keeps for main, over grids.
 */
import { describe, expect, it } from 'vitest'
import { KIND_LABEL, resultsSummary, spokenTime } from '../src/shared/search/moment'
import { SEARCH_KINDS } from '../src/shared/search/types'

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const ROWS = '../src/renderer/src/search/rows'
const rows = (await import(/* @vite-ignore */ ROWS)) as {
  kindLabel: (kind: string) => string
  spokenTime: (seconds: number) => string
  resultsSummary: (count: number, query: string, limit?: number) => string
}

describe('the search words in the UI language', () => {
  it('give the English of moment.ts', () => {
    for (const k of SEARCH_KINDS) expect(rows.kindLabel(k)).toBe(KIND_LABEL[k])
    for (const s of [-1, 0, 0.9, 1, 2, 59, 60, 61, 62, 119, 120, 3599, 3600, 3601, 3661, 7322, 86400, NaN, Infinity]) expect(rows.spokenTime(s)).toBe(spokenTime(s))
    for (const [count, limit] of [[0, Infinity], [1, Infinity], [2, Infinity], [1000, Infinity], [50, 50], [51, 50], [1, 1]] as const) {
      expect(rows.resultsSummary(count, 'intro "x"', limit)).toBe(resultsSummary(count, 'intro "x"', limit))
    }
  })
})
