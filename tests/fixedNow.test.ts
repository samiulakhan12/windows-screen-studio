import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))
const { fixedNowFromEnv, installFixedClock } = await import('../src/main/fixedNow')

/*
 * The English guard's fixed clock (docs/design/output-and-languages.md §10.6): SSW_FIXED_NOW fixes
 * Date.now() and new Date() in an unpackaged main process, and nothing else.
 */
describe('the fixed clock of the English guard', () => {
  it('reads SSW_FIXED_NOW only in an unpackaged app, and only a readable instant', () => {
    expect(fixedNowFromEnv({ SSW_FIXED_NOW: '2026-03-12T14:02:00Z' }, false)).toBe(Date.UTC(2026, 2, 12, 14, 2))
    expect(fixedNowFromEnv({ SSW_FIXED_NOW: '2026-03-12T14:02:00Z' }, true)).toBeNull()
    expect(fixedNowFromEnv({}, false)).toBeNull()
    expect(fixedNowFromEnv({ SSW_FIXED_NOW: 'soon' }, false)).toBeNull()
  })

  it('fixes Date.now() and new Date(), and leaves dates made from a value as they are', () => {
    const at = Date.UTC(2026, 2, 12, 14, 2)
    const target = { Date }
    installFixedClock(at, target)
    const D = target.Date
    expect(D.now()).toBe(at)
    expect(new D().getTime()).toBe(at)
    expect(new D(0).getTime()).toBe(0)
    expect(new D('2020-01-02T00:00:00Z').toISOString()).toBe('2020-01-02T00:00:00.000Z')
    expect(new D(2020, 0, 2).getFullYear()).toBe(2020)
    expect(new D() instanceof Date).toBe(true)
    expect(D.parse('2020-01-02T00:00:00Z')).toBe(Date.UTC(2020, 0, 2))
    expect(D.UTC(2020, 0, 2)).toBe(Date.UTC(2020, 0, 2))
    expect(typeof D()).toBe('string')
    // The process's own Date is untouched here: only the target's was replaced.
    expect(Date.now()).not.toBe(at)
  })
})
