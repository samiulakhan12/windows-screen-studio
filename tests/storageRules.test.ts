import { describe, expect, it } from 'vitest'
import { cleanupPlan, DAY_MS, DEFAULT_RULES, formatBytes, lastUsed, sanitizeRules, usedAgo, type RecordingUsage } from '../src/shared/storage/rules'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const ago = (days: number): number => NOW - days * DAY_MS
const rec = (id: string, patch: Partial<RecordingUsage>): RecordingUsage => ({
  id,
  name: id,
  createdAt: new Date(ago(400)).toISOString(),
  lastUsed: ago(1),
  bytes: 1000,
  cacheBytes: 0,
  finished: true,
  capped: false,
  ...patch
})

describe('rules', () => {
  it('keeps only the offered choices', () => {
    expect(sanitizeRules(undefined)).toEqual(DEFAULT_RULES)
    expect(sanitizeRules({ cacheDays: 31, removeDays: 90, autoCaches: true })).toEqual({ cacheDays: 30, removeDays: 90, autoCaches: true })
    expect(sanitizeRules({ cacheDays: null, removeDays: 'x', autoCaches: 'yes' })).toEqual({ cacheDays: null, removeDays: null, autoCaches: false })
  })

  it('takes the latest of the times known', () => {
    expect(lastUsed([ago(10), new Date(ago(3)).toISOString(), null, undefined, 'nonsense'])).toBe(ago(3))
    expect(lastUsed([])).toBe(0)
  })
})

describe('cleanupPlan', () => {
  const recordings = [
    rec('old', { lastUsed: ago(200), bytes: 5000, cacheBytes: 100 }),
    rec('stale-cache', { lastUsed: ago(40), cacheBytes: 300 }),
    rec('fresh', { lastUsed: ago(2), cacheBytes: 300 }),
    rec('new-but-unused', { createdAt: new Date(ago(10)).toISOString(), lastUsed: 0, cacheBytes: 50 }),
    rec('unfinished', { lastUsed: ago(500), finished: false, cacheBytes: 999 }),
    rec('open', { lastUsed: ago(500), cacheBytes: 999 })
  ]
  const open = new Set(['open'])

  it('clears old caches only, with the default rules', () => {
    expect(cleanupPlan(recordings, DEFAULT_RULES, NOW, open).map((i) => [i.action, i.id, i.bytes])).toEqual([
      ['caches', 'stale-cache', 300],
      ['caches', 'old', 100]
    ])
  })

  it('removes recordings not used and not recorded within the days, and their caches go with them', () => {
    const plan = cleanupPlan(recordings, { cacheDays: 30, autoCaches: false, removeDays: 180 }, NOW, open)
    expect(plan.map((i) => [i.action, i.id])).toEqual([
      ['remove', 'old'],
      ['caches', 'stale-cache']
    ])
    expect(plan[0].bytes).toBe(5000)
  })

  it('never offers unfinished or open recordings, nor anything with the rules off', () => {
    const plan = cleanupPlan(recordings, { cacheDays: 14, autoCaches: false, removeDays: 30 }, NOW, open)
    expect(plan.some((i) => i.id === 'unfinished' || i.id === 'open' || i.id === 'new-but-unused')).toBe(false)
    expect(cleanupPlan(recordings, { cacheDays: null, autoCaches: false, removeDays: null }, NOW)).toEqual([])
  })

  it('formats sizes and ages', () => {
    expect([formatBytes(0), formatBytes(1500), formatBytes(2_400_000), formatBytes(12_400_000_000)]).toEqual(['0 KB', '2 KB', '2 MB', '12.4 GB'])
    expect([usedAgo(NOW, NOW), usedAgo(ago(1), NOW), usedAgo(ago(12), NOW), usedAgo(0, NOW)]).toEqual(['today', 'yesterday', '12 days ago', 'never'])
  })
})
