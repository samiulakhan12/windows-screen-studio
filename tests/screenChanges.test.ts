import { describe, expect, it } from 'vitest'
import type { SceneScan } from '../src/shared/api/projects'
import { SCREEN_RULES, screenChanges } from '../src/shared/smart/screenChanges'
import type { ScrollEvent } from '../src/shared/types'

/*
 * Test 33 of docs/design/smart-tools.md §22.1 (contracts): screen changes read from a scene scan
 * (§7.2). The fixture follows the research recording's shares: a page of another app 62%, a dialog
 * 17%, a menu 7%, another panel 6%, scrolling 23-53% at each sample (never settling), a page after
 * the scroll 73%; the cursor moving 1% between them.
 */

/** A scan at `step` s over `seconds`, 1% everywhere but `at` (time → share). */
function scan(step: number, seconds: number, at: Record<number, number>): SceneScan {
  const t: number[] = []
  const changed: number[] = []
  for (let i = 0; i * step <= seconds + 1e-9; i++) {
    const time = +(i * step).toFixed(3)
    t.push(time)
    changed.push(at[time] ?? 1)
  }
  return { step, t, changed, stills: [] }
}

const SCROLL_SHARES = [23, 41, 53, 37, 29, 48, 35, 44, 26]
const fixture = (): { scan: SceneScan; scrolls: ScrollEvent[] } => {
  const at: Record<number, number> = { 3: 62, 5: 17, 7: 7, 8: 6, 15: 73 }
  SCROLL_SHARES.forEach((share, k) => (at[+(10 + k * 0.25).toFixed(2)] = share))
  const scrolls: ScrollEvent[] = []
  for (let t = 9.9; t <= 12.05; t += 0.1) scrolls.push({ t: +t.toFixed(2), x: 0.5, y: 0.5, dx: 0, dy: -1 })
  return { scan: scan(0.25, 20, at), scrolls }
}

describe('screenChanges (test 33)', () => {
  it('finds the page change and the dialog, never the menu, the panel or a scroll sample', () => {
    const { scan: s, scrolls } = fixture()
    const found = screenChanges(s, scrolls)
    expect(found).toEqual([
      { t: 3, share: 62, page: true },
      { t: 5, share: 17, page: false },
      { t: 15, share: 73, page: true }
    ])
    // Without the scroll events, the samples followed by more scrolling still never settle; the last
    // one, followed by a still screen, is what the scroll guard keeps out.
    expect(screenChanges(s).filter((c) => c.t >= 10 && c.t < 12.5)).toEqual([{ t: 11.75, share: 44, page: true }])
  })

  it('a change that settles right after a scroll is not one (the scroll guard)', () => {
    const s = scan(0.25, 10, { 4: 40 })
    expect(screenChanges(s, [{ t: 3.6, x: 0, y: 0, dx: 0, dy: 1 }])).toEqual([])
    expect(screenChanges(s, [{ t: 3.4, x: 0, y: 0, dx: 0, dy: 1 }])).toEqual([{ t: 4, share: 40, page: true }])
  })

  it('30% or more is a page, 10% or more a change', () => {
    expect(screenChanges(scan(0.25, 10, { 2: 30, 5: 29, 7: 10, 8.5: 9 }))).toEqual([
      { t: 2, share: 30, page: true },
      { t: 5, share: 29, page: false },
      { t: 7, share: 10, page: false }
    ])
  })

  it('the settle window is 1.0 s whatever the step: 4 samples at 0.25 s, 2 at 0.5 s', () => {
    expect(SCREEN_RULES.settleS).toBe(1)
    // At 0.25 s: the 4 samples after it decide; a 5th (1.25 s later) does not.
    expect(screenChanges(scan(0.25, 10, { 2: 20, 2.25: 9, 2.5: 9 })).map((c) => c.t)).toEqual([])
    expect(screenChanges(scan(0.25, 10, { 2: 20, 3.25: 9, 3.5: 9 })).map((c) => c.t)).toEqual([2])
    expect(screenChanges(scan(0.25, 10, { 2: 20, 2.5: 9 })).map((c) => c.t)).toEqual([2])
    // At 0.5 s: 2 samples.
    expect(screenChanges(scan(0.5, 10, { 2: 20, 2.5: 9 })).map((c) => c.t)).toEqual([])
    expect(screenChanges(scan(0.5, 10, { 2: 20, 3.5: 9 })).map((c) => c.t)).toEqual([2])
  })

  it('a change over two samples in a row is one, with the larger share; none without a full window after it', () => {
    expect(screenChanges(scan(0.25, 10, { 2: 12, 2.25: 45 }))).toEqual([{ t: 2, share: 45, page: true }])
    expect(screenChanges(scan(0.25, 10, { 9.5: 50 }))).toEqual([])
  })
})
