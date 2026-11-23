import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Bleep, Cover, Project } from '../src/shared/types'
import { guideProject, planActual } from '../src/shared/guide/shots'
import { REVIEW_KINDS, KIND_WORDS } from '../src/shared/review/copy'
import { listKey } from '../src/shared/review/keys'
import { captionPendingCount, captionReviewItems } from '../src/shared/review/captionReview'
import { withinRange } from '../src/shared/clips/clipCopy'
import { CHANGED_AREA_NAMES, changedAreas } from '../src/shared/editor/versions'
import { DEFAULT_POLISH_OPTIONS, POLISH_STEPS, planPolish, readPolishOptions, type PolishInput } from '../src/shared/editor/polish'
import { GROUP_KINDS, KIND_WORDS as GROUP_WORDS, projectItems, trackOfKind } from '../src/shared/editor/multiSelect'
import { LOOK_CLASSES, LOOK_CLASS_WORDS, copyLook, deleteItems, pasteLook } from '../src/shared/editor/groupEdit'
import * as coverGroup from '../src/shared/editor/coverGroup'
import { DEFAULT_KEYMAP, shortcutIndex, type KeyInput } from '../src/shared/editor/shortcuts'
import { privateBleepWord } from '../src/shared/privacy/coverData'
import { t } from '../src/shared/i18n/t'
import type { PrivacyGathered } from '../src/shared/api/privacy'
import { base, coverOf, key, oldFixtures, words } from './autoBlurFixtures'
import { migrateProject } from '../src/shared/engine/project'

/*
 * The seams the contracts step completes (docs/design/auto-blur.md §14, §16.0; §17.1 tests 26 to 29,
 * 36 and 37): guide shots, Review, Versions, Polish, multi-select and the stubs.
 */

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const R = '../src/renderer/src'
const load = async <T,>(file: string): Promise<T> => (await import(/* @vite-ignore */ `${R}/${file}`)) as T
type Comp = (props: Record<string, unknown>) => unknown
const selection = await load<{ validSelection(sel: unknown, p: Project): unknown }>('editor/selection')

const covered = (id: string, covers: Cover[]): Project => ({ ...base(id, 20), covers })

describe('auto-blur contracts: seams', () => {
  it('26. Guide shots: shotSig and planActual change when a cover active at t changes its box or colour, not when a cover elsewhere in time changes; guideProject keeps covers', () => {
    const here = coverOf('a', 4, 6, [key(4, 0.1, 0.1, 0.2, 0.1)])
    const later = coverOf('b', 12, 14, [key(12, 0.5, 0.5, 0.2, 0.1)])
    const p = covered('g', [here, later])
    const sig = (q: Project): string => planActual(q, 5).sig
    const plain = base('g', 20)
    // Without covers the signature is today's (no covers field).
    expect(sig(plain)).not.toContain('covers')
    expect(sig(p)).toContain('covers')
    expect(sig({ ...p, covers: [coverOf('a', 4, 6, [key(4, 0.1, 0.1, 0.3, 0.1)]), later] })).not.toBe(sig(p))
    expect(sig({ ...p, covers: [{ ...here, color: '#ffffff' }, later] })).not.toBe(sig(p))
    expect(sig({ ...p, covers: [here, coverOf('b', 12, 14, [key(12, 0.6, 0.6, 0.2, 0.1)])] })).toBe(sig(p))
    expect(guideProject(p).covers).toEqual(p.covers)
  })

  it("27. Review wiring: 'private' before 'chapter' with slice(-2) unchanged; its four words; withinRange keeps every cover; captionReview skips private bleeps; V peeks only on a private row", () => {
    expect(REVIEW_KINDS.indexOf('private')).toBe(REVIEW_KINDS.indexOf('chapter') - 1)
    expect(REVIEW_KINDS.slice(-2)).toEqual(['chapter', 'short'])
    const w = KIND_WORDS.private
    for (const k of [w.chip, w.name, w.all]) expect(t(k)).not.toBe(k)
    expect(t(w.count, { count: 2, n: '2' })).not.toBe(w.count)
    expect([w.chip, w.name, w.all, w.count]).toEqual(['review.kind.private.chip', 'review.kind.private.name', 'review.kind.private.all', 'review.kind.private.count'])
    // A short clip's copy: covers outside its range stay (a widened clip still covers what comes back).
    const segments = [words('s1', 1, 'my email is ada at example dot com'), words('s2', 9, 'and that is all')]
    const said: Bleep = { id: 'p1', start: 2.2, end: 4, word: privateBleepWord('email', 'g1'), sound: 'tone', auto: true }
    const plain: Bleep = { id: 'b1', start: 9.4, end: 9.7, word: 'that', sound: 'tone', auto: true }
    const p: Project = {
      ...covered('r', [coverOf('c1', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'g1' }), coverOf('c2', 15, 18, [key(15, 0.4, 0.4, 0.2, 0.05)], { found: 'check', kind: 'key', group: 'g2' })]),
      transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments },
      bleeps: [said, plain]
    }
    const copy = withinRange(p, [{ start: 8, end: 12 }])
    expect(copy.covers).toEqual(p.covers)
    // Private bleeps are never Bleep rows.
    const rows = captionReviewItems(p).filter((i) => i.kind === 'bleep')
    expect(rows.map((i) => i.key)).toEqual(['bleep:b1'])
    expect(captionPendingCount(p)).toBe(captionPendingCount({ ...p, bleeps: [plain] }))
    const keys = shortcutIndex(DEFAULT_KEYMAP)
    const v: KeyInput = { key: 'v', code: 'KeyV', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
    expect(listKey(v, keys, { kind: 'private' })).toEqual({ action: 'peek', again: false })
    expect(listKey(v, keys, { kind: 'bleep' })).toBeNull()
    expect(listKey(v, keys, null)).toBeNull()
    expect(listKey(v, keys)).toBeNull()
  })

  it("28. Versions: changedAreas gives 'covers' for a changed covers or privacy; CHANGED_AREA_NAMES holds it; every old fixture pair gives what it gave before", () => {
    expect(CHANGED_AREA_NAMES).toContain('covers')
    const a = covered('v', [coverOf('c1', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)])])
    expect(changedAreas(a, { ...a, covers: [coverOf('c1', 1, 4, [key(1, 0.1, 0.1, 0.2, 0.05)])] })).toEqual(['covers'])
    expect(changedAreas(a, { ...a, privacy: { rejected: [] } })).toEqual(['covers'])
    expect(changedAreas(a, a)).toEqual([])
    // Old projects: no covers, no privacy, so never 'covers'.
    const old = oldFixtures().map((f) => migrateProject(structuredClone(f.raw)))
    for (let i = 0; i + 1 < old.length; i++) expect(changedAreas(old[i], old[i + 1])).not.toContain('covers')
  })

  it("29. Polish seam: POLISH_STEPS ends with 'privacy' after today's steps; on by default, off when saved without it; with privacy null planPolish plans today's project; a gathered result adds covers and bleeps in its one update", () => {
    expect(POLISH_STEPS).toEqual(['style', 'zoom', 'silences', 'smoothCuts', 'captions', 'chapters', 'captionLook', 'director', 'privacy'])
    expect(DEFAULT_POLISH_OPTIONS.privacy).toBe(true)
    expect(readPolishOptions({}).privacy).toBe(false)
    expect(readPolishOptions({ privacy: true }).privacy).toBe(true)
    const p = base('pol', 30)
    const input: PolishInput = { project: p, recorded: { samples: [], clicks: [], keys: [] } as never, sound: null, transcript: null, speech: null, framing: { status: 'skipped' } as never, preset: null }
    const options = { ...DEFAULT_POLISH_OPTIONS, zoom: false, silences: false, smoothCuts: false, captions: false, chapters: false, captionLook: false, director: false }
    const none = planPolish({ ...input, privacy: null }, options)
    expect(none.project).toBe(p)
    expect(none.summary.steps.at(-1)).toEqual({ step: 'privacy', status: 'skipped', reason: 'no-reader' })
    expect(none.summary).not.toHaveProperty('privacy')
    const off = planPolish(input, { ...options, privacy: false })
    expect(off.summary.steps.at(-1)).toEqual({ step: 'privacy', status: 'skipped', reason: 'off' })
    const found = coverOf('f1', 2, 5, [key(2, 0.2, 0.2, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'g1' })
    const said: Bleep = { id: 'pb', start: 6, end: 7, word: privateBleepWord('email', 'g1'), sound: 'tone', auto: true }
    const gathered: PrivacyGathered = { covers: [found], said: [said], privacy: { rejected: [] }, found: 2, check: 0, listenedOnly: false, unfinished: false }
    const r = planPolish({ ...input, privacy: gathered }, options)
    expect(r.project.covers).toEqual([found])
    expect(r.project.bleeps).toEqual([said])
    expect(r.project.privacy).toEqual({ rejected: [] })
    expect(r.summary.steps.at(-1)).toEqual({ step: 'privacy', status: 'changed' })
    expect(r.summary.privacy).toEqual({ found: 2, check: 0, listenedOnly: false, unfinished: false })
  })

  it("36. Multi-select seam: GROUP_KINDS ends with 'cover' and LookClass has 'cover'; their words read their messages; with part P1's coverGroup.ts covers are selectable, listed, deleted and restyled through it, and every other kind behaves as before", () => {
    expect(GROUP_KINDS.at(-1)).toBe('cover')
    expect(GROUP_KINDS.at(-2)).toBe('graphic')
    expect(trackOfKind('cover')).toBe('covers')
    expect(LOOK_CLASSES.at(-1)).toBe('cover')
    expect(GROUP_WORDS.cover).toBe('style.groupEdit.count.cover')
    expect(t(GROUP_WORDS.cover, { count: 2, n: '2' })).toBe('2 covers')
    expect(LOOK_CLASS_WORDS.cover).toEqual(['cover', 'covers'])
    const c = coverOf('c1', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)])
    const p: Project = { ...covered('m', [c]), zooms: [{ id: 'z1', start: 1, end: 3, scale: 2, x: 0.5, y: 0.5, auto: false } as never] }
    // Part P1 filled coverGroup.ts: a cover that is there is selectable, one that is gone is not.
    expect(selection.validSelection({ kind: 'cover', id: 'c1' }, p)).toEqual({ kind: 'cover', id: 'c1' })
    expect(selection.validSelection({ kind: 'cover', id: 'gone' }, p)).toBeNull()
    expect(selection.validSelection({ kind: 'zoom', id: 'z1' }, p)).toEqual({ kind: 'zoom', id: 'z1' })
    // Covers are items of the Covers row; deleting them through a group removes them; a look's colour restyles them.
    expect(projectItems(p).filter((x) => x.kind === 'cover')).toEqual([{ key: 'cover:c1', kind: 'cover', id: 'c1', track: 'covers', start: 1, end: 3 }])
    expect(deleteItems(p, ['cover:c1']).covers).toBeUndefined()
    expect(deleteItems(p, ['zoom:z1']).covers).toBe(p.covers)
    const ctx = { crop: null, cursorValid: true, style: {} as never, background: {} as never }
    const look = copyLook(p, 'cover:c1', ctx)
    expect(look?.cls).toBe('cover')
    expect(pasteLook(p, ['cover:c1'], look!, ctx).project).toBe(p)
    const white = { ...look!, values: { 'cover.color': '#ffffff' } }
    expect(pasteLook(p, ['cover:c1'], white, ctx).project.covers![0].color).toBe('#ffffff')
    expect(coverGroup.validCoverSelection(p, 'c1')).toBe(true)
    expect(coverGroup.validCoverSelection(p, 'gone')).toBe(false)
  })

  it('37. Stubs render nothing: every mounted stub returns null, every seam stub returns its input, useReaderState and useFindProgress return null, and confirmLeaveFind resolves true (part P1 filled its own: they now do their work, tests 41-75 and 201-215)', async () => {
    const p = covered('s', [coverOf('c1', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)])])
    const services = { store: { state: p }, player: {} }
    const view = { screen: { x: 0, y: 0, w: 100, h: 100 } }
    // Part P1's components (PrivacySection, CoverSection, WeakBlurNote, CoverShapeButton, CoverTrack,
    // CoverHandles, PeekBanner, PeekInset) render their UI now: tests 63-69 and 205-214 hold them.
    void view
    const stubs: [string, string, Record<string, unknown>][] = [
      ['privacy/PrivacyExportNote', 'PrivacyExportNote', { project: p, onReview: () => undefined, onFind: () => undefined, onWait: () => undefined, onStopAndExport: () => undefined }],
      ['privacy/TranscribeNote', 'TranscribeNote', { project: p, place: 'service' }],
      ['privacy/TranslatedNote', 'TranslatedNote', { project: p, language: 'es' }],
      ['privacy/NotCheckedNote', 'NotCheckedNote', { project: p, place: 'send' }],
      ['privacy/PublishMaskedNote', 'PublishMaskedNote', { project: p, text: 'x' }],
      ['privacy/CopiesOffer', 'CopiesOffer', { services }],
      ['privacy/PrivacySettings', 'PrivacySettings', { reveal: true }],
      ['privacy/readerState', 'FindProgressLine', { projectId: 's' }]
    ]
    for (const [file, name, props] of stubs) {
      const C = (await load<Record<string, Comp>>(file))[name]
      expect(C(props), name).toBeNull()
    }
    // The dialogs that are always mounted when asked for draw nothing yet.
    const { FindDialog } = await load<{ FindDialog: Comp }>('privacy/FindDialog')
    expect(renderToStaticMarkup(React.createElement(FindDialog as never, { services, onClose: () => undefined, mode: 'find' }))).toBe('')
    const reader = await load<{ useReaderState(): unknown; useFindProgress(id: string): unknown; confirmLeaveFind(s: unknown): Promise<boolean> }>('privacy/readerState')
    expect(reader.useReaderState()).toBeNull()
    expect(reader.useFindProgress('s')).toBeNull()
    await expect(reader.confirmLeaveFind(services)).resolves.toBe(true)
    const run = await load<{ gatherPrivacy(p: Project, c: unknown, s: AbortSignal): Promise<unknown> }>('privacy/privacyRun')
    await expect(run.gatherPrivacy(p, null, new AbortController().signal)).resolves.toBeNull()
    // Part P1's seams do their work: the cover is an item, moves (one key), is deleted, takes a look's colour and is its own group.
    expect(coverGroup.coverItems(p)).toEqual([{ key: 'cover:c1', kind: 'cover', id: 'c1', track: 'covers', start: 1, end: 3 }])
    const moved = coverGroup.moveCoversInTime(p, ['c1'], 1)
    expect(moved.refused).toEqual([])
    expect([moved.project.covers![0].start, moved.project.covers![0].end]).toEqual([2, 4])
    expect(coverGroup.deleteCoverItems(p, ['c1']).covers).toBeUndefined()
    expect(coverGroup.pasteCoverLook(p, ['c1'], coverGroup.coverLookOf(p.covers![0]))).toBe(p)
    expect(coverGroup.groupCoverIds(p, 'c1')).toEqual(['c1'])
    // Without a grade a cover keeps its colour; with one it is graded (test 54); with Compare it is the raw colour.
    const grade = await load<{ gradedCoverColour(c: string, g: unknown, l: unknown, compare?: boolean): string }>('render/coverGrade')
    expect(grade.gradedCoverColour('#1c1c22', undefined, null)).toBe('#1c1c22')
    expect(grade.gradedCoverColour('#1c1c22', { look: 'vivid' }, null, true)).toBe('#1c1c22')
    // Pixels with no cover active are untouched; an active cover is filled in Dark (tests 73, 210, 211).
    const strip = await load<{ fillCoverTiles(...a: unknown[]): void; fillCoverPixels(...a: unknown[]): void }>('privacy/filmstripCovers')
    const pixels = new Uint8ClampedArray(16).fill(7)
    strip.fillCoverPixels(pixels, 2, 2, p, 6)
    expect([...pixels]).toEqual(new Array(16).fill(7))
  })
})
