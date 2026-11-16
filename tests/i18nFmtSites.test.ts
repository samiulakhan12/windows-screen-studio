import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * Test 73 (docs/design/output-and-languages.md §23.1; part X6, §10.5, §11.2): every formatter call
 * site in scripts/i18n/fmt-sites.json gives the same English as the helper it replaced, over the grids
 * of §11.2, and no call in our files formats with one of today's helpers without being in the list,
 * moved or kept with its reason.
 */

const { fmt } = await import('../src/shared/i18n/fmt')
const { formatTime } = await import('../src/shared/engine/project')
const { sizeText: jobSize } = await import('../src/shared/jobs/longJobs')
const { clockTime } = await import('../src/shared/search/moment')
const { lengthText: soundLength } = await import('../src/shared/audio/soundsCopy')
const { formatTick } = await import('../src/shared/editor/timelineScale')
const { formatLevel } = await import('../src/shared/editor/zoomEdit')
const { formatRate } = await import('../src/shared/editor/shuttle')
const { zoomText } = await import('../src/shared/editor/directorCopy')
const { versionTime } = await import('../src/shared/editor/versions')
const { formatBytes: storageBytes, usedAgo } = await import('../src/shared/storage/rules')
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const DIALOG = '../src/renderer/src/editor/ExportDialog'
const dialog = (await import(/* @vite-ignore */ DIALOG)) as { formatBytes(n: number): string; formatDuration(s: number): string; formatClock(s: number, tenths?: boolean): string }
const CLIPS = '../src/renderer/src/clips/clipsRun'
const clips = (await import(/* @vite-ignore */ CLIPS)) as { sizeText(n: number): string }

type Site = { file: string; line: number; was: string; now: string; as: string }
type Kept = { file: string; kind: string; helper: string; text: string; why: string; count?: number }
type FmtSites = { mappings: Record<string, { was: string; now: string; grid: string }>; sites: Site[]; kept: Kept[] }
type Found = { file: string; line: number; kind: string; helper: string; text: string }
const lib = require('../scripts/i18n/lib/fmtSites.cjs') as {
  sitesOf(file: string, text: string): Found[]
  compareSites(sites: Found[], list: Pick<FmtSites, 'kept'>): { unlisted: Found[]; stale: Kept[] }
  checkFmtSites(root?: string): { unlisted: Found[]; stale: Kept[]; missing: { file: string; now: string; listed: number; found: number }[] }
}
const ROOT = path.resolve(__dirname, '..')
const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/i18n/fmt-sites.json'), 'utf8')) as FmtSites

/* ---------- the helpers that are gone: their code at S2 (e825ddf), kept here as the reference ---------- */

/** formatBytes of Home.tsx (a local helper of the unfinished recordings' rows and question). */
function homeFormatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}
/** listPhrase of shortcuts.ts and of VersionsDialog.tsx (two local helpers, the same code). */
const listPhrase = (items: string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/* ---------- the grids (§11.2: 0, 0.4, 1, 59.99, 3,599.5, 1e9 bytes, dates around midnight and new year) ---------- */

const SECONDS = [0, 0.04, 0.049, 0.05, 0.4, 0.95, 0.96, 1, 2.25, 9.99, 59.94, 59.95, 59.99, 60, 61.5, 119.96, 599.5, 3599.5, 3600, 3661.7, 7322.49, 86399.99, 1e6, -0.04, -3, Number.NaN, Number.POSITIVE_INFINITY]
const BYTES = [0, -5, 1, 499, 500, 999, 1000, 1500, 499_499, 500_000, 999_999, 1e6, 1_049_000, 1_500_000, 12_345_678, 999_499_999, 999_999_999, 1e9, 1_049_999_999, 1.5e9, 1e12, Number.NaN]
const FACTORS = [0, 0.1, 0.25, 0.5, 1, 1.004, 1.005, 1.05, 1.1, 1.15, 1.25, 1.333333, 1.8, 2, 2.499, 3.999, 4, 10, 16, -1]
const TICKS = SECONDS.filter((s) => Number.isFinite(s) && s >= 0).flatMap((t) => [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].map((step) => [t, step] as const))
const COUNTS = [0, 1, 7, 999, 1000, 1234, 8200, 12_400, 100_000, 1_234_567, 1e9, 2 ** 31, 1234.5678, 0.5, -1234, Number.NaN]
const LISTS = [[], ['A'], ['A', 'B'], ['A', 'B', 'C'], ['1.5×', '2×', '3×', '4×'], ['Zooms', 'Captions and text', 'Sound']]
/** Around midnight and new year in the local time zone, and the guard tour's fixed clock. */
const LOCAL = [new Date(2025, 11, 31, 23, 59, 30), new Date(2026, 0, 1, 0, 0, 0), new Date(2026, 2, 12, 0, 0, 59), new Date(2026, 2, 12, 12, 0), new Date(2026, 2, 12, 23, 59, 59), new Date(2026, 6, 4, 9, 5)].map((d) => d.getTime())
const INSTANTS = [...LOCAL, ...['2025-12-31T23:59:30Z', '2026-01-01T00:00:00Z', '2026-03-12T14:02:00Z', '2026-07-04T12:00:00Z'].map((s) => Date.parse(s))]
const NOW = Date.parse('2026-03-12T14:02:00Z')
const AGES = [0, -5, NOW, NOW - 3_600_000, NOW - 86_400_000 + 1, NOW - 86_400_000, NOW - 86_400_000 * 1.5, NOW - 86_400_000 * 12.5, NOW - 86_400_000 * 400, NOW + 86_400_000, Number.NaN].map((t) => [t, NOW] as const)
/** Version times: today, yesterday, this year, last year, the start of the year, an hour ahead, and no date. */
const VERSIONS = ['2026-03-12T09:15:00', '2026-03-12T00:00:00', '2026-03-11T23:59:00', '2026-03-01T08:00:00', '2025-12-31T23:00:00', '2026-01-01T00:00:00', '2026-03-12T15:02:00', '2026-03-12T14:02:00.000Z', '', 'not a date']

type Pair = { grid: unknown[]; was: (x: never) => string; now: (x: never) => string; at?: Date }
const one = <T,>(grid: readonly T[], was: (x: T) => string, now: (x: T) => string): Pair => ({ grid: [...grid], was, now } as Pair)
const date = (ms: number): Date => new Date(ms)

/**
 * Each mapping of fmt-sites.json: the helper (or call) it replaced, and the fmt call now. The calls
 * that had no locale ran in the renderer, whose default locale is en-US with only en-US.pak (§11.2):
 * they are written with 'en-US' here. The day-and-year sites check the date first ('' for none), so
 * their grid holds dates only.
 */
const PAIRS: Record<string, Pair> = {
  formatTime: one(SECONDS, (s) => formatTime(s), (s) => fmt.clock(s)),
  'formatTime(whole)': one(SECONDS, (s) => formatTime(s, false), (s) => fmt.clock(s, 'whole')),
  formatClock: one(SECONDS, (s) => dialog.formatClock(s), (s) => fmt.clock(s, 'whole')),
  'formatClock(tenths)': one(SECONDS, (s) => dialog.formatClock(s, true), (s) => fmt.clock(s, 'rounded-tenths')),
  clockTime: one(SECONDS, (s) => clockTime(s), (s) => fmt.clock(s, 'hours')),
  formatTick: one(TICKS, ([t, step]) => formatTick(t, step), ([t, step]) => fmt.tick(t, step)),
  formatDuration: one(SECONDS, (s) => dialog.formatDuration(s), (s) => fmt.duration(s)),
  'lengthText(sounds)': one(SECONDS, (s) => soundLength(s), (s) => fmt.seconds(s)),
  'formatBytes(export)': one(BYTES, (n) => dialog.formatBytes(n), (n) => fmt.bytes(n)),
  'sizeText(longJobs)': one(BYTES, (n) => jobSize(n), (n) => fmt.bytes(n)),
  'formatBytes(storage)': one(BYTES, (n) => storageBytes(n), (n) => fmt.bytes(n, 'storage')),
  'formatBytes(home)': one(BYTES, (n) => homeFormatBytes(n), (n) => fmt.bytes(n, 'coarse')),
  'sizeText(clips)': one(BYTES, (n) => clips.sizeText(n), (n) => fmt.bytes(n, 'megabytes')),
  formatLevel: one(FACTORS, (x) => formatLevel(x), (x) => fmt.factor(x)),
  formatRate: one(FACTORS, (x) => formatRate(x), (x) => fmt.factor(x)),
  zoomText: one(FACTORS, (x) => zoomText(x), (x) => fmt.factor(x)),
  versionTime: { ...one(VERSIONS, (iso) => versionTime(iso), (iso) => fmt.date(Date.parse(iso), 'version')), at: new Date(2026, 2, 12, 14, 2) },
  usedAgo: one(AGES, ([t, now]) => usedAgo(t, now), ([t, now]) => fmt.relative(t, now)),
  listPhrase: one(LISTS, (items) => listPhrase(items), (items) => fmt.list(items)),
  'toLocaleTimeString(hour, minute)': one([...INSTANTS, Number.NaN], (ms) => date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }), (ms) => fmt.time(ms)),
  'toLocaleTimeString()': one([...INSTANTS, Number.NaN], (ms) => date(ms).toLocaleTimeString('en-US'), (ms) => fmt.time(ms, 'seconds')),
  'toLocaleDateString(day, month, year)': one(INSTANTS, (ms) => date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }), (ms) => fmt.date(ms, 'dayYear')),
  'toLocaleDateString(day, month)': one([...INSTANTS, Number.NaN], (ms) => date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' }), (ms) => fmt.date(ms, 'day')),
  'toLocaleString(dateStyle, timeStyle)': one([...INSTANTS, Number.NaN], (ms) => date(ms).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }), (ms) => fmt.date(ms, 'dayTime')),
  "toLocaleString('en-US')": one(COUNTS, (n) => n.toLocaleString('en-US'), (n) => fmt.count(n, { grouping: true }))
}

afterEach(() => vi.useRealTimers())

describe('formatter call sites moved to fmt (test 73)', () => {
  it('names the mappings this test compares, and every site one of them', () => {
    expect(Object.keys(list.mappings).sort()).toEqual(Object.keys(PAIRS).sort())
    expect(list.sites.length).toBeGreaterThan(0)
    for (const s of list.sites) expect(Object.keys(PAIRS), `${s.file}:${s.line} ${s.now}`).toContain(s.as)
    for (const [id, m] of Object.entries(list.mappings)) {
      // The site's call is the mapping's own call with its arguments (fmt.clock(o.start, 'whole') for fmt.clock(s, 'whole')).
      const fn = m.now.slice(0, m.now.indexOf('('))
      const style = /, ('[a-z-]+'|\{ grouping: true \})\)$/.exec(m.now)?.[1]
      for (const s of list.sites.filter((x) => x.as === id)) {
        // A function handed on by name (format={fmt.factor}) is the call without its arguments.
        expect(s.now === fn || s.now.startsWith(`${fn}(`), `${s.file}:${s.line} ${s.now}`).toBe(true)
        if (style) expect(s.now.endsWith(`, ${style})`), `${s.file}:${s.line} ${s.now}`).toBe(true)
        else expect(s.now, `${s.file}:${s.line} ${s.now}`).not.toMatch(/, '[a-z-]+'\)$/)
      }
    }
  })

  for (const [id, pair] of Object.entries(PAIRS)) {
    it(`${id}: the same English as before over its grid`, () => {
      if (pair.at) {
        vi.useFakeTimers()
        vi.setSystemTime(pair.at)
      }
      const sites = list.sites.filter((s) => s.as === id).length
      expect(sites, `no site uses ${id}`).toBeGreaterThan(0)
      for (const x of pair.grid) expect((pair.now as (v: unknown) => string)(x), `${id} ${JSON.stringify(x)}`).toBe((pair.was as (v: unknown) => string)(x))
    })
  }

  it('the styles that differ from one another do so where their helpers did', () => {
    expect([fmt.bytes(1_500_000), fmt.bytes(1_500_000, 'coarse'), fmt.bytes(1_500_000, 'megabytes')]).toEqual(['1.5 MB', '2 MB', '2 MB'])
    expect([fmt.bytes(0, 'coarse'), fmt.bytes(0, 'storage'), fmt.bytes(400_000, 'megabytes')]).toEqual(['1 KB', '0 KB', '1 MB'])
    expect([fmt.bytes(2.345e9), fmt.bytes(2.345e9, 'storage')]).toEqual(['2.35 GB', '2.3 GB'])
  })

  it('every moved call is in its file, every kept call is still there, and no formatter call is left out of the list', () => {
    const { unlisted, stale, missing } = lib.checkFmtSites(ROOT)
    expect(unlisted, 'formatter calls neither moved to fmt nor kept with a reason').toEqual([])
    expect(stale, 'kept entries that match no call').toEqual([])
    expect(missing, 'moved calls not found in their files').toEqual([])
    for (const k of list.kept) expect(k.why.length, `${k.file} ${k.text}`).toBeGreaterThan(40)
  })

  it('finds helper calls, helpers handed on by name and calls with no locale or an English one, but not definitions or other locales', () => {
    const src = [
      "import { formatTime } from '../engine/project'",
      "import { formatLevel } from './zoomEdit'",
      'export function sizeText(bytes: number): string { return `${bytes.toLocaleString(\'en-US\')} B` }',
      'export const at = (s: number): string => `at ${formatTime(s, false)}`',
      'export const slider = { format: formatLevel }',
      'export const day = (d: Date): string => d.toLocaleDateString(undefined, { day: \'numeric\' })',
      "export const n = (x: number): string => x.toLocaleString('en-US')",
      "export const de = (x: number): string => x.toLocaleString('de-DE')",
      'export const other = (o: { formatTime(s: number): string }): string => o.formatTime(1)'
    ].join('\n')
    const found = lib.sitesOf('src/shared/x.ts', src)
    expect(found.map((f) => [f.kind, f.helper, f.text])).toEqual([
      ['helper', 'formatTime', 'formatTime(s, false)'],
      ['helper', 'formatLevel', 'formatLevel'],
      ['locale', 'toLocaleDateString', "d.toLocaleDateString(undefined, { day: 'numeric' })"],
      ['locale', 'toLocaleString', "x.toLocaleString('en-US')"]
    ])
    const { unlisted, stale } = lib.compareSites(found, { kept: [{ file: 'src/shared/x.ts', kind: 'helper', helper: 'formatLevel', text: 'formatLevel', why: '' }, { file: 'src/shared/x.ts', kind: 'helper', helper: 'clockTime', text: 'clockTime(s)', why: '' }] })
    expect(unlisted.map((u) => u.text)).toEqual(['formatTime(s, false)', "d.toLocaleDateString(undefined, { day: 'numeric' })", "x.toLocaleString('en-US')"])
    expect(stale.map((k) => k.text)).toEqual(['clockTime(s)'])
  })
})
