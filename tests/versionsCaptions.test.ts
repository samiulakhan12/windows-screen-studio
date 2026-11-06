/**
 * Captions Studio test 56 (docs/design/captions-studio.md §14.3, docs/design/versions.md §2.4):
 * versions name Captions Studio's own parts of the edit. `changedAreas` reports 'captions look'
 * for a new mark (and for captions placed by hand, a bleep, the record of what automation
 * replaced), 'caption languages' for a new track, and 'pop-ups' for pop-ups moved while they count
 * the same; the summary counts pop-ups; an old summary without the count reads 0. None of these is
 * "other settings" any more, and a version kept just now still reads "Same as your edit now".
 */
import { describe, expect, it } from 'vitest'
import { textHash } from '../src/shared/captions/captionTracks'
import { DEFAULT_CLEANUP } from '../src/shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, planCaptionsGreat } from '../src/shared/captions/great'
import { toggleEmphasis } from '../src/shared/captions/marks'
import { changedAreas, compareSummaries, sanitizeMeta, sanitizeSummary, summaryLine, versionSummary } from '../src/shared/editor/versions'
import { migrateProject } from '../src/shared/engine/project'
import type { CaptionTrack, Project } from '../src/shared/types'
import { captions, studioProject, TALL } from './p4Fixtures'

const TEXTS = [
  'today i will show you three ways to make reports faster',
  'First, open the Settings page and click Export.',
  'Second, turn on Auto Save so you never lose work.',
  'Finally, use the Search box to find any report.',
  'Last quarter our sign-ups grew 300% and revenue hit $1.2M.',
  'Click Save and you are done.'
]

/** Make my captions great on a tall screen recording (offline, the defaults): a look, emphasis, pop-ups and their records. */
const great = (): Project => planCaptionsGreat({ project: studioProject({ segments: captions(TEXTS) }), frame: TALL, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, DEFAULT_GREAT_OPTIONS).project

/** A Spanish track of the captions, made from their text as it is. */
const track = (p: Project, language = 'es'): CaptionTrack => ({
  language,
  by: 'gemini',
  model: 'gemini-2.5-flash',
  createdAt: '2026-11-06T10:00:00.000Z',
  segments: p.transcript!.segments.map((s) => ({ id: s.id, text: `[${language}] ${s.text}`, src: textHash(s.text) }))
})

/** An edit with every part of Captions Studio set. */
const full = (): Project => {
  const p = great()
  const [c0, c1] = p.transcript!.segments
  return {
    ...p,
    captionPlaces: [{ caption: c1.id, position: 'top' }],
    captionTracks: [track(p)],
    bleeps: [{ id: 'b1', start: c0.start + 0.4, end: c0.start + 0.8, word: 'darn', sound: 'tone' }]
  }
}

/** Every object's keys in the opposite order: the same edit, its fields set in another order. */
const reversed = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v

/** Kept as a version (saveVersion stores it migrated) and read back (readVersion migrates it again). */
const keptAndRead = (p: Project): Project => migrateProject(JSON.parse(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(p))))))
/** The edit now as Compare reads it (VersionsDialog: migrateProject of the store's state). */
const nowOf = (p: Project): Project => migrateProject(p)

describe('versions and Captions Studio (test 56)', () => {
  it('the edit made by Make my captions great has every part to compare', () => {
    const p = full()
    for (const k of ['captions', 'captionMarks', 'captionPlaces', 'graphics', 'captionTracks', 'bleeps', 'captionAuto'] as const) expect(p[k], k).toBeDefined()
    expect(p.graphics!.length).toBeGreaterThan(0)
    expect(p.captions?.studio).toBeDefined()
  })

  it('a version kept just now is the same as the edit, whatever order its fields were set in', () => {
    const p = full()
    const version = keptAndRead(p)
    for (const now of [nowOf(p), nowOf(reversed(p) as Project)]) {
      expect(compareSummaries(versionSummary(version), versionSummary(now))).toEqual([])
      expect(changedAreas(version, now)).toEqual([])
    }
    // And the other way round: a version kept from fields set in another order.
    expect(changedAreas(keptAndRead(reversed(p) as Project), nowOf(p))).toEqual([])
  })

  it("names a new mark, a caption placed by hand, a bleep and automation's records as the captions look", () => {
    const a = full()
    // A word of the fourth caption the run left plain, emphasised by hand.
    const c3 = a.transcript!.segments[3]
    const plain = [0, 1, 2, 3, 4, 5].find((w) => !a.captionMarks!.some((m) => m.caption === c3.id && m.from <= w && w <= m.to))!
    const marked = toggleEmphasis(a, [{ caption: c3.id, from: plain, to: plain }])
    expect(marked.captionMarks!.length).toBe(a.captionMarks!.length + 1)
    expect(changedAreas(a, marked)).toEqual(['captions look'])
    expect(changedAreas(a, { ...a, captionMarks: undefined })).toEqual(['captions look'])
    expect(changedAreas(a, { ...a, captionPlaces: [{ caption: a.captionPlaces![0].caption, position: 'bottom' }] })).toEqual(['captions look'])
    expect(changedAreas(a, { ...a, bleeps: undefined })).toEqual(['captions look'])
    expect(changedAreas(a, { ...a, captionAuto: undefined })).toEqual(['captions look'])
    // Through a version kept and read back as well.
    expect(changedAreas(keptAndRead(a), nowOf(marked))).toEqual(['captions look'])
    // An empty list and none are the same.
    expect(changedAreas({ ...a, captionPlaces: [], bleeps: [], captionMarks: [] }, { ...a, captionPlaces: undefined, bleeps: undefined, captionMarks: undefined })).toEqual([])
  })

  it('names a new track, or one translated again, as the caption languages', () => {
    const a = full()
    const more = { ...a, captionTracks: [...a.captionTracks!, track(a, 'bn')] }
    expect(changedAreas(a, more)).toEqual(['caption languages'])
    expect(changedAreas(keptAndRead(a), nowOf(more))).toEqual(['caption languages'])
    expect(changedAreas(a, { ...a, captionTracks: undefined })).toEqual(['caption languages'])
    const again = { ...a, captionTracks: [{ ...a.captionTracks![0], segments: a.captionTracks![0].segments.map((s) => ({ ...s, text: `${s.text}!` })) }] }
    expect(changedAreas(a, again)).toEqual(['caption languages'])
  })

  it('counts pop-ups in the summary and names them only when they moved while they count the same', () => {
    const a = full()
    const n = a.graphics!.length
    expect(versionSummary(a).graphics).toBe(n)
    expect(versionSummary(studioProject()).graphics).toBe(0)
    expect(summaryLine(versionSummary(a))).toContain(`${n} pop-up${n === 1 ? '' : 's'}`)
    expect(summaryLine({ ...versionSummary(studioProject()), graphics: 1 })).toBe('0:30 · 1 pop-up')
    // One fewer: the count says so in its row, and it is not named again.
    const fewer = { ...a, graphics: a.graphics!.slice(1) }
    expect(compareSummaries(versionSummary(a), versionSummary(fewer))).toEqual([{ label: 'Pop-ups', version: String(n), now: String(n - 1) }])
    expect(changedAreas(a, fewer)).toEqual([])
    // As many, one moved: named.
    const g = a.graphics![0]
    const moved = { ...a, graphics: [{ ...g, start: g.start + 0.5, end: g.end + 0.5 }, ...a.graphics!.slice(1)] }
    expect(compareSummaries(versionSummary(a), versionSummary(moved))).toEqual([])
    expect(changedAreas(a, moved)).toEqual(['pop-ups'])
    expect(changedAreas(keptAndRead(a), nowOf(moved))).toEqual(['pop-ups'])
  })

  it('never calls a Captions Studio part "other settings"', () => {
    const a = full()
    const none: Project = { ...a, captionMarks: undefined, captionPlaces: undefined, graphics: undefined, captionTracks: undefined, bleeps: undefined, captionAuto: undefined }
    const areas = changedAreas(a, none)
    expect(areas).not.toContain('other settings')
    expect(areas).toEqual(['captions look', 'caption languages'])
    expect(compareSummaries(versionSummary(a), versionSummary(none)).map((c) => c.label)).toEqual(['Pop-ups'])
  })

  it('reads an old summary without the count of pop-ups as 0', () => {
    const old = { duration: 12, cuts: 1, trimmed: false, zooms: 2, captions: 6, texts: 0, shapes: 0, images: 0, chapters: 0, freezes: 0 }
    expect(sanitizeSummary(old).graphics).toBe(0)
    expect(sanitizeSummary({ ...old, graphics: 'many' }).graphics).toBe(0)
    expect(sanitizeSummary({ ...old, graphics: -3 }).graphics).toBe(0)
    expect(sanitizeSummary({ ...old, graphics: 4.7 }).graphics).toBe(4)
    const meta = sanitizeMeta({ id: 'v-abc123-0123abcd', name: 'v1', auto: false, createdAt: '2026-11-01T10:00:00.000Z', bytes: 10, hash: 'a'.repeat(64), summary: old })
    expect(meta?.summary.graphics).toBe(0)
    expect(summaryLine(meta!.summary)).toBe('0:12 · 1 cut · 2 zooms · 6 captions')
  })
})
