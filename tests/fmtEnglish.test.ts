import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The English profile of fmt (docs/design/output-and-languages.md §11.2; test 8): in English every
 * fmt function gives exactly what the helper it replaces gives today, over grids of values, so the
 * call sites X6 moves to fmt keep their English byte for byte.
 */

const { fmt } = await import('../src/shared/i18n/fmt')
const { formatTime } = await import('../src/shared/engine/project')
const { sizeText } = await import('../src/shared/jobs/longJobs')
const { clockTime } = await import('../src/shared/search/moment')
const { lengthText: shareLength } = await import('../src/shared/share/webhooks')
const { lengthText: soundLength } = await import('../src/shared/audio/soundsCopy')
const { formatTick } = await import('../src/shared/editor/timelineScale')
const { formatLevel } = await import('../src/shared/editor/zoomEdit')
const { formatRate } = await import('../src/shared/editor/shuttle')
const { zoomText } = await import('../src/shared/editor/directorCopy')
const { versionTime } = await import('../src/shared/editor/versions')
const { usedAgo } = await import('../src/shared/storage/rules')
// The export dialog's helpers (renderer code: imported at run time so the Node typecheck does not follow it).
const DIALOG = '../src/renderer/src/editor/ExportDialog'
const dialog = (await import(/* @vite-ignore */ DIALOG)) as { formatBytes(n: number): string; formatDuration(s: number): string; formatClock(s: number, tenths?: boolean): string }

afterEach(() => vi.useRealTimers())

const SECONDS = [0, 0.04, 0.4, 0.95, 0.96, 1, 9.99, 59.94, 59.95, 59.99, 60, 61.5, 119.96, 599.5, 3599.5, 3600, 3661.7, 7322.49, 86399.99, -3, Number.NaN, Number.POSITIVE_INFINITY]
const BYTES = [0, 1, 499, 500, 999, 1000, 1500, 999_999, 1e6, 1_049_000, 12_345_678, 999_999_999, 1e9, 1.5e9, 1e12]
const FACTORS = [0.25, 0.5, 1, 1.004, 1.005, 1.25, 1.333333, 1.8, 2, 2.499, 4]

describe('the English profile of fmt (test 8)', () => {
  it('bytes equals the export dialog’s formatBytes and long jobs’ sizeText', () => {
    for (const b of BYTES) {
      expect(fmt.bytes(b), String(b)).toBe(dialog.formatBytes(b))
      expect(fmt.bytes(b), String(b)).toBe(sizeText(b))
    }
  })

  it('duration equals formatDuration', () => {
    for (const s of SECONDS) expect(fmt.duration(s), String(s)).toBe(dialog.formatDuration(s))
  })

  it('clock equals formatTime, formatClock, clockTime and the share lengthText, each in its style', () => {
    for (const s of SECONDS.filter(Number.isFinite)) {
      expect(fmt.clock(s), `tenths ${s}`).toBe(formatTime(s))
      expect(fmt.clock(s, 'whole'), `whole ${s}`).toBe(formatTime(s, false))
      expect(fmt.clock(s, 'whole'), `formatClock ${s}`).toBe(dialog.formatClock(s))
      expect(fmt.clock(s, 'rounded-tenths'), `formatClock tenths ${s}`).toBe(dialog.formatClock(s, true))
    }
    for (const s of SECONDS) {
      expect(fmt.clock(s, 'hours'), `hours ${s}`).toBe(clockTime(s))
      expect(fmt.clock(s, 'hours-rounded'), `hours-rounded ${s}`).toBe(shareLength(s))
    }
  })

  it('tick equals formatTick and seconds equals the sounds list’s lengthText', () => {
    for (const s of SECONDS.filter((v) => Number.isFinite(v) && v >= 0)) for (const step of [0.1, 0.5, 1, 5]) expect(fmt.tick(s, step), `${s} ${step}`).toBe(formatTick(s, step))
    for (const s of SECONDS.filter(Number.isFinite)) expect(fmt.seconds(s), String(s)).toBe(soundLength(s))
  })

  it('factor equals formatLevel, formatRate and zoomText', () => {
    for (const x of FACTORS) {
      expect(fmt.factor(x)).toBe(formatLevel(x))
      expect(fmt.factor(x)).toBe(formatRate(x))
      expect(fmt.factor(x)).toBe(zoomText(x))
    }
  })

  it('dates and times are today’s locale-less calls with en-US named, around midnight and new year', () => {
    const instants = ['2025-12-31T23:59:30Z', '2026-01-01T00:00:00Z', '2026-03-12T14:02:00Z', '2026-03-12T00:00:59Z', '2026-07-04T12:00:00Z'].map((s) => Date.parse(s))
    for (const ms of instants) {
      const d = new Date(ms)
      expect(fmt.date(ms, 'dayYear')).toBe(d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }))
      expect(fmt.date(ms, 'day')).toBe(d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }))
      expect(fmt.date(ms, 'dayTime')).toBe(d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }))
      expect(fmt.time(ms)).toBe(d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }))
      expect(fmt.time(ms, 'seconds')).toBe(d.toLocaleTimeString('en-US'))
    }
    expect(fmt.date(Date.parse('2026-03-12T14:02:00Z'), 'dayYear')).toBe('Mar 12, 2026')
    expect(fmt.date(Number.NaN, 'dayYear')).toBe('')
  })

  it('version dates equal versionTime (en-GB months) at a fixed now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 12, 14, 2))
    for (const iso of ['2026-03-12T09:15:00', '2026-03-11T23:59:00', '2026-03-01T08:00:00', '2025-12-31T23:00:00', '2026-01-01T00:00:00']) {
      const ms = new Date(iso).getTime()
      expect(fmt.date(ms, 'version'), iso).toBe(versionTime(new Date(ms).toISOString()))
    }
    expect(fmt.date(new Date(2026, 2, 12, 9, 15).getTime(), 'version')).toBe('Today 09:15')
  })

  it('lists read "A, B and C" as listPhrase does, counts as String(n) or en-US grouping, ages as usedAgo', () => {
    expect(fmt.list([])).toBe('')
    expect(fmt.list(['A'])).toBe('A')
    expect(fmt.list(['A', 'B'])).toBe('A and B')
    expect(fmt.list(['A', 'B', 'C'])).toBe('A, B and C')
    expect(fmt.list(['A', 'B', 'C'], 'or')).toBe('A, B or C')
    for (const n of [0, 1, 999, 1000, 1234, 1_234_567]) {
      expect(fmt.count(n)).toBe(String(n))
      expect(fmt.count(n, { grouping: true })).toBe(n.toLocaleString('en-US'))
    }
    const now = Date.parse('2026-03-12T14:02:00Z')
    for (const t of [0, -5, now, now - 3_600_000, now - 86_400_000, now - 86_400_000 * 12.5]) expect(fmt.relative(t, now)).toBe(usedAgo(t, now))
  })

  it('numbers, percents, sentences and typed digits', () => {
    expect(fmt.number(1.25)).toBe('1.25')
    expect(fmt.number(1.25, { min: 1, max: 1 })).toBe((1.25).toFixed(1))
    expect(fmt.number(2, { max: 2 })).toBe('2.00')
    expect(fmt.number(1.5, { min: 0, max: 2 })).toBe('1.5')
    expect(fmt.number(12345.678, { min: 0, max: 1 })).toBe('12345.7')
    expect(fmt.percent(0.5)).toBe('50%')
    expect(fmt.inSentence('Encoding to the size target (two passes)')).toBe('encoding to the size target (two passes)')
    expect(fmt.parseNumber('২৫')).toBe(25)
    expect(fmt.parseNumber('२५.५')).toBe(25.5)
    expect(fmt.parseNumber(' 12 ')).toBe(12)
    for (const bad of ['', 'abc', '1,5', '1e3', '--1']) expect(fmt.parseNumber(bad), bad).toBeNaN()
  })
})
