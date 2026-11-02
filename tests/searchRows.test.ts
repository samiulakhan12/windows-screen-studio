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
  setPendingMoment: (projectId: string, t: number, end?: number, now?: number) => void
  takePendingMoment: (projectId: string, now?: number) => { t: number; end: number } | null
}
const { enterTarget, liveStatus, MOMENTS_SHOWN, resultRows, rowLabel } = (await import(/* @vite-ignore */ ROWS)) as {
  enterTarget: (rows: readonly Row[], activeKey: string | null, answered: string | null, text: string) => Row | 'wait' | null
  liveStatus: (summary: string, building: boolean) => string
  MOMENTS_SHOWN: number
  resultRows: (hits: readonly SearchHit[], expanded: ReadonlySet<string>) => Row[]
  rowLabel: (row: Row) => string
}

const moment = (start: number | null, text: string, over: Partial<SearchMoment> = {}): SearchMoment => ({
  kind: 'said',
  start,
  end: start,
  video: start,
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

  it('reads the time of the edited video, not of the recording', () => {
    const [, m] = resultRows([hit('a', [moment(300, 'settings', { video: 180 })])], new Set())
    expect(rowLabel(m)).toMatch(/^Said at 3 minutes: open settings\. /)
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

describe('enterTarget', () => {
  const rows = resultRows([hit('demo', [moment(3, 'demo')]), hit('other', [])], new Set())

  it('opens the first row of results that answer the text in the box', () => {
    expect(enterTarget(rows, null, 'demo', 'demo')).toBe(rows[0])
    // The box as main reads it: spaces around, and at most 200 characters.
    expect(enterTarget(rows, null, 'demo', '  demo ')).toBe(rows[0])
    const long = 'x'.repeat(200)
    expect(enterTarget(rows, null, long, `${long}yz`)).toBe(rows[0])
  })

  it('waits while the results are those of what was typed before (or none came yet)', () => {
    // "demo" was answered; "budget" was typed over it and its query is not sent yet.
    expect(enterTarget(rows, null, 'demo', 'budget')).toBe('wait')
    expect(enterTarget(rows, null, 'demo', 'demo budget')).toBe('wait')
    expect(enterTarget([], null, null, 'budget')).toBe('wait')
  })

  it('opens the row picked, or nothing when the results no longer hold it', () => {
    expect(enterTarget(rows, rows[1].key, 'demo', 'demo')).toBe(rows[1])
    expect(enterTarget(rows, 'gone:open', 'demo', 'demo')).toBeNull()
  })

  it('opens nothing for an empty box, or an answer with no rows', () => {
    expect(enterTarget([], null, 'demo', '   ')).toBeNull()
    expect(enterTarget([], null, 'budget', 'budget')).toBeNull()
  })
})

describe('liveStatus', () => {
  it('says the results, and while the index is built one sentence that the count does not change', () => {
    expect(liveStatus('2 recordings found', false)).toBe('2 recordings found')
    const building = [liveStatus('No recordings match "budget".', true), liveStatus('1 recording found', true), liveStatus('3 recordings found', true)]
    expect(building[0]).toMatch(/^Still indexing your recordings/)
    expect(new Set(building).size).toBe(1)
    // Nothing before the first answer, built or not (nothing is read when Home opens).
    expect(liveStatus('', true)).toBe('')
    expect(liveStatus('', false)).toBe('')
  })
})

describe('pending moment', () => {
  it('is taken once, by its own project, within 30 s', () => {
    setPendingMoment('rec-a', 12.5, 14, 1000)
    expect(takePendingMoment('rec-a', 2000)).toEqual({ t: 12.5, end: 14 })
    expect(takePendingMoment('rec-a', 2000)).toBeNull()
    setPendingMoment('rec-a', 3, 3, 1000)
    expect(takePendingMoment('rec-b', 1000)).toBeNull()
    expect(takePendingMoment('rec-a', 1000)).toBeNull() // another editor took (cleared) it
    setPendingMoment('rec-a', 3, 3, 1000)
    expect(takePendingMoment('rec-a', 1000 + PENDING_MS + 1)).toBeNull()
    setPendingMoment('rec-a', 3, 3, 1000)
    clearPendingMoment()
    expect(takePendingMoment('rec-a', 1000)).toBeNull()
    setPendingMoment('rec-a', Number.NaN, 3, 1000)
    expect(takePendingMoment('rec-a', 1000)).toBeNull()
    // An end that is not after the start is the start.
    setPendingMoment('rec-a', 3, Number.NaN, 1000)
    expect(takePendingMoment('rec-a', 1000)).toEqual({ t: 3, end: 3 })
    setPendingMoment('rec-a', 3, 1, 1000)
    expect(takePendingMoment('rec-a', 1000)).toEqual({ t: 3, end: 3 })
  })
})
