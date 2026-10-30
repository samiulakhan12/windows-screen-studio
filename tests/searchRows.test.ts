import { describe, expect, it } from 'vitest'
import type { SearchHit, SearchMoment } from '../src/shared/search/types'

// Renderer modules, outside this project's TypeScript program (like tests/brandNewText.test.ts).
const OPEN_AT = '../src/renderer/src/search/openAt'
const ROWS = '../src/renderer/src/search/rows'

interface Row {
  kind: 'open' | 'moment' | 'more'
  key: string
  hit: SearchHit
  count?: number
}
const { clearPendingMoment, PENDING_MS, setPendingMoment, takePendingMoment } = (await import(/* @vite-ignore */ OPEN_AT)) as {
  clearPendingMoment: () => void
  PENDING_MS: number
  setPendingMoment: (projectId: string, t: number, now?: number) => void
  takePendingMoment: (projectId: string, now?: number) => number | null
}
const { MOMENTS_SHOWN, resultRows, rowLabel } = (await import(/* @vite-ignore */ ROWS)) as {
  MOMENTS_SHOWN: number
  resultRows: (hits: readonly SearchHit[], expanded: ReadonlySet<string>) => Row[]
  rowLabel: (row: Row) => string
}

const moment = (start: number | null, text: string, over: Partial<SearchMoment> = {}): SearchMoment => ({
  kind: 'said',
  start,
  end: start,
  snippet: [{ text: 'open ', hit: false }, { text, hit: true }],
  terms: 1,
  cut: false,
  ...over
})
const hit = (id: string, moments: SearchMoment[], over: Partial<SearchHit> = {}): SearchHit => ({
  id,
  name: `Name ${id}`,
  createdAt: '2026-10-01T10:00:00.000Z',
  duration: 312,
  title: [{ text: `Name ${id}`, hit: false }],
  score: 1,
  moments,
  more: 0,
  nameOnly: moments.length === 0,
  ...over
})

describe('resultRows', () => {
  const six = Array.from({ length: 6 }, (_, i) => moment(i * 10, `w${i}`))

  it('lists each recording, its first moments and a "more" row', () => {
    const rows = resultRows([hit('a', six), hit('b', [])], new Set())
    expect(rows.map((r) => r.kind)).toEqual(['open', ...Array(MOMENTS_SHOWN).fill('moment'), 'more', 'open'])
    expect(rows.find((r) => r.kind === 'more')).toMatchObject({ count: 2 })
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it('shows every moment of an expanded recording', () => {
    const rows = resultRows([hit('a', six)], new Set(['a']))
    expect(rows.filter((r) => r.kind === 'moment')).toHaveLength(6)
    expect(rows.some((r) => r.kind === 'more')).toBe(false)
  })
})

describe('rowLabel', () => {
  it('reads a moment as one sentence with its time in words', () => {
    const [, m] = resultRows([hit('a', [moment(83, 'settings')])], new Set())
    expect(rowLabel(m)).toMatch(/^Said at 1 minute 23 seconds: open settings\. In Name a, /)
  })

  it('says when a moment was cut, and reads notes without a time', () => {
    const rows = resultRows([hit('a', [moment(5, 'x', { cut: true }), moment(null, 'y', { kind: 'notes' })])], new Set())
    expect(rowLabel(rows[1])).toMatch(/^Said at 5 seconds, cut from the video: /)
    expect(rowLabel(rows[2])).toMatch(/^Notes: open y\. /)
  })

  it('reads the heading and "more"', () => {
    const rows = resultRows([hit('a', Array.from({ length: 5 }, (_, i) => moment(i, 'w')))], new Set())
    expect(rowLabel(rows[0])).toMatch(/^Open Name a\. .*, 5 minutes 12 seconds long\.$/)
    expect(rowLabel(rows[rows.length - 1])).toMatch(/^Show 1 more moment\. In Name a/)
    expect(rowLabel(resultRows([hit('b', [])], new Set())[0])).toMatch(/^Open Name b, found in the name\./)
  })
})

describe('pending moment', () => {
  it('is taken once, by its own project, within 30 s', () => {
    setPendingMoment('rec-a', 12.5, 1000)
    expect(takePendingMoment('rec-a', 2000)).toBe(12.5)
    expect(takePendingMoment('rec-a', 2000)).toBeNull()
    setPendingMoment('rec-a', 3, 1000)
    expect(takePendingMoment('rec-b', 1000)).toBeNull()
    expect(takePendingMoment('rec-a', 1000)).toBeNull() // another editor took (cleared) it
    setPendingMoment('rec-a', 3, 1000)
    expect(takePendingMoment('rec-a', 1000 + PENDING_MS + 1)).toBeNull()
    setPendingMoment('rec-a', 3, 1000)
    clearPendingMoment()
    expect(takePendingMoment('rec-a', 1000)).toBeNull()
    setPendingMoment('rec-a', Number.NaN, 1000)
    expect(takePendingMoment('rec-a', 1000)).toBeNull()
  })
})
