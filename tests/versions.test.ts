import { describe, expect, it } from 'vitest'
import {
  autoVersionName,
  changedAreas,
  changedFilesNotice,
  cleanVersionName,
  compareSummaries,
  defaultVersionName,
  missingFilesNotice,
  namedFiles,
  prunedAutos,
  replacedInPlace,
  restoreVersion,
  sanitizeMeta,
  summaryLine,
  versionSummary,
  versionTime,
  VERSION_ID_RE,
  type VersionMeta
} from '../src/shared/editor/versions'
import { applyBrandKit, EMPTY_BRAND_KIT, type BrandKit } from '../src/shared/editor/brandKit'
import { createTitleCard } from '../src/shared/editor/titles'
import { migrateProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'
import { chapter, freeze, p20, shape, spot, text, title, zoom } from './groupFixture'

const HASH = 'a'.repeat(64)

describe('version names', () => {
  it('trims, removes control characters and caps at 80 characters', () => {
    expect(cleanVersionName('  v1 for\tclient\n ', 'x')).toBe('v1 for client')
    expect(cleanVersionName('a\u0000b c', 'x')).toBe('a b c')
    expect([...cleanVersionName('é'.repeat(200), 'x')]).toHaveLength(80)
    // Characters outside the BMP count as one and are never cut in half.
    expect(cleanVersionName('😀'.repeat(100), 'x')).toBe('😀'.repeat(80))
  })
  it('uses the fallback for empty or non-text names', () => {
    expect(cleanVersionName('   ', 'Version 3')).toBe('Version 3')
    expect(cleanVersionName(42, 'Version 3')).toBe('Version 3')
    expect(defaultVersionName(2)).toBe('Version 3')
  })
  it('names automatic versions by their reason', () => {
    expect(autoVersionName('polish')).toBe('Before Polish in one click')
    expect(autoVersionName('fillers')).toBe('Before removing fillers and retakes')
    expect(autoVersionName('review')).toBe('Before removing automatic changes')
    expect(autoVersionName('captions')).toBe('Before Make my captions great')
    expect(autoVersionName('vertical')).toBe('Before making a vertical version')
    expect(autoVersionName('square')).toBe('Before making a square version')
    expect(autoVersionName('open', 'v1 for client')).toBe('Before opening “v1 for client”')
    expect([...autoVersionName('open', 'x'.repeat(200))]).toHaveLength(80)
  })
})

describe('versionSummary', () => {
  it('counts what the list shows', () => {
    const p: Project = {
      ...p20({
        zooms: [zoom('z1', 1, 2), zoom('z2', 3, 4)],
        annotations: [text('t1', 1, 2)],
        titles: [title('ti', 0, 2)],
        shapes: [shape('s1', 'arrow', 1, 2)],
        spotlights: [spot('sp', 1, 2)],
        chapters: [chapter('c', 1)],
        freezes: [freeze('f', 2, { length: 2, sound: 'pause' })]
      }),
      transcript: { segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] } as unknown as Project['transcript']
    }
    const s = versionSummary(p)
    // 18 s of clips (a cut at 8-10) plus a 2 s hold.
    expect(s.duration).toBeCloseTo(20)
    expect(s).toMatchObject({ cuts: 1, trimmed: false, zooms: 2, captions: 1, texts: 2, shapes: 2, images: 0, chapters: 1, freezes: 1 })
  })
  it('tells trims from cuts', () => {
    const p = { ...p20(), clips: [{ id: 'c', start: 2, end: 20, speed: 1 }] }
    expect(versionSummary(p)).toMatchObject({ cuts: 0, trimmed: true })
  })
  it('sums up in one line, zero counts left out, five parts at most', () => {
    const s = { duration: 133.4, cuts: 3, trimmed: false, zooms: 5, captions: 42, graphics: 0, texts: 0, shapes: 1, images: 2, chapters: 4, freezes: 0 }
    expect(summaryLine(s)).toBe('2:13 · 3 cuts · 5 zooms · 42 captions · 1 shape')
    expect(summaryLine({ ...s, cuts: 1, zooms: 0, captions: 0, shapes: 0, images: 0, chapters: 0 })).toBe('2:13 · 1 cut')
  })
})

describe('comparing', () => {
  const base = { duration: 133.4, cuts: 3, trimmed: false, zooms: 5, captions: 42, graphics: 0, texts: 0, shapes: 0, images: 0, chapters: 0, freezes: 0 }
  it('lists only the counts that differ, the length first', () => {
    expect(compareSummaries(base, { ...base, duration: 118.2, cuts: 5 })).toEqual([
      { label: 'Length', version: '2:13.4', now: '1:58.2' },
      { label: 'Cuts', version: '3', now: '5' }
    ])
    expect(compareSummaries(base, { ...base, duration: 133.41 })).toEqual([])
    expect(compareSummaries(base, { ...base, trimmed: true })).toEqual([{ label: 'Start or end trimmed', version: 'No', now: 'Yes' }])
  })
  it('names the other parts that differ', () => {
    const a = p20()
    expect(changedAreas(a, a)).toEqual([])
    const b: Project = { ...a, style: { ...a.style, padding: 0.2 }, webcam: { ...a.webcam, show: !a.webcam.show }, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }
    expect(changedAreas(a, b)).toEqual(['style', 'camera', 'crop'])
  })
  it('names items moved or changed while they count the same, and only then', () => {
    const version = p20({ zooms: [zoom('z', 1, 2)], annotations: [text('t', 1, 2, { text: 'Hello' })], titles: [title('ti', 0, 2, { title: 'Intro' })] })
    const now: Project = {
      ...p20({ zooms: [zoom('z', 10, 12)], annotations: [text('t', 1, 2, { text: 'Bye' })], titles: [title('ti', 0, 2, { title: 'Totally different' })] }),
      // The cut moved from 8-10 s to 4-6 s: as long, as many cuts.
      clips: [
        { id: 'c0', start: 0, end: 4, speed: 1 },
        { id: 'c1', start: 6, end: 20, speed: 1 }
      ]
    }
    expect(compareSummaries(versionSummary(version), versionSummary(now))).toEqual([])
    expect(changedAreas(version, now)).toEqual(['clips', 'zooms', 'texts and titles'])
    expect(changedAreas(version, structuredClone(version))).toEqual([])
    // A count that differs says so in its row: not named again.
    const more = { ...version, zooms: [zoom('z', 1, 2), zoom('y', 5, 6)], shapes: [shape('s', 'arrow', 3, 4)] }
    expect(changedAreas(version, more)).toEqual([])
    // An empty list and none are the same.
    expect(changedAreas({ ...version, chapters: [] }, { ...version, chapters: undefined })).toEqual([])
    expect(changedAreas({ ...version, chapters: [chapter('c', 1)] }, { ...version, chapters: [chapter('c', 2)] })).toEqual(['chapters'])
    expect(changedAreas({ ...version, freezes: [freeze('f', 2)] }, { ...version, freezes: [freeze('f', 3)] })).toEqual(['freeze frames'])
  })
  it('says "other settings" for a part of the edit no list names, never for the recording’s fields', () => {
    const a = p20()
    expect(changedAreas(a, { ...a, newerField: 1 } as unknown as Project)).toEqual(['other settings'])
    expect(changedAreas(a, { ...a, name: 'Renamed', createdAt: '2020-01-01T00:00:00.000Z' })).toEqual([])
  })
  it('does not count the order fields were set in: a version kept just now is the same as the edit', () => {
    // The file is read back through migrateProject, which rebuilds each title card in its own key order.
    const roundTrip = (p: Project): Project => ({ ...migrateProject(JSON.parse(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(p)))))), id: p.id })
    const kit = { ...EMPTY_BRAND_KIT, colors: ['#7c3aed'], intro: { title: 'Acme', subtitle: 'Weekly demo', style: 'centered', background: 'solid', length: 3 } } as BrandKit
    const branded = applyBrandKit(p20(), kit, { fonts: {} })
    expect(branded.titles).toHaveLength(1)
    expect(changedAreas(roundTrip(branded), branded)).toEqual([])
    // TextPanel: a colour picked, then a subtitle typed ({ ...card, ...patch }).
    const card = { ...{ ...createTitleCard(1, 20), color: '#7c3aed' }, subtitle: 'Part one' }
    const typed = p20({ titles: [card] })
    expect(changedAreas(roundTrip(typed), typed)).toEqual([])
    expect(changedAreas(roundTrip(typed), p20({ titles: [{ ...card, subtitle: 'Part two' }] }))).toEqual(['texts and titles'])
  })
  it('notices caption text that changed with the same count', () => {
    const seg = (t: string) => ({ segments: [{ id: 'a', start: 0, end: 1, text: t }] }) as unknown as Project['transcript']
    expect(changedAreas({ ...p20(), transcript: seg('hi') }, { ...p20(), transcript: seg('hello') })).toEqual(['caption text'])
  })

  /*
   * The parts of the edit added since versions were designed (review mode, the publishing pack,
   * speaker labels, the unwanted-sound finder, Captions Studio): each saved with the edit, so a
   * version kept just now is the same, and one that differs only there never reads "Same".
   */
  describe('the newer parts of the edit', () => {
    const transcript = (speakers: (string | undefined)[], texts = ['Hello there', 'Welcome back']): Project['transcript'] => ({
      provider: 'gemini',
      model: 'm',
      createdAt: '2026-11-01T10:00:00.000Z',
      language: 'en',
      segments: texts.map((text, i) => ({ id: `s${i}`, start: i * 4, end: i * 4 + 3, text, ...(speakers[i] ? { speaker: speakers[i] } : {}) }))
    })
    /** An edit with every newer part set. */
    const full = (): Project => ({
      ...p20(),
      transcript: transcript(['You', 'Speaker 2']),
      captions: { ...p20().captions!, showSpeaker: true },
      sounds: { spans: [{ start: 2, end: 2.5, action: 'mute', key: 'cough-20' }], ignored: ['typing-50'] },
      publish: { description: 'How billing works.' },
      autoCuts: [{ id: 'a1', by: 'silences', action: 'cut', start: 8, end: 10, was: [{ start: 8, end: 10, speed: 1 }] }],
      autoCutOutcomes: [{ id: 'a0', outcome: 'kept' }],
      captionMarks: [{ id: 'm1', caption: 's0', from: 0, to: 0, text: 'Hello' }],
      captionPlaces: [{ caption: 's1', position: 'top' }],
      bleeps: [{ id: 'b1', start: 4.2, end: 4.6, word: 'darn', sound: 'tone' }]
    })
    const roundTrip = (p: Project): Project => migrateProject(JSON.parse(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(p))))))

    it('keeps every newer part through a version kept and read back', () => {
      const p = migrateProject(full())
      for (const k of ['sounds', 'publish', 'autoCuts', 'autoCutOutcomes', 'captionMarks', 'captionPlaces', 'bleeps'] as const) expect(p[k], k).toBeDefined()
      expect(p.transcript?.segments.map((s) => s.speaker)).toEqual(['You', 'Speaker 2'])
      expect(changedAreas(roundTrip(full()), migrateProject(full()))).toEqual([])
    })

    it('names the unwanted sounds as the sound, the export description and the automatic changes to review', () => {
      const a = full()
      expect(changedAreas(a, { ...a, sounds: { spans: [], ignored: ['typing-50'] } })).toEqual(['sound'])
      // A sound the finder was told to ignore changes nothing heard: named apart, never "sound".
      expect(changedAreas(a, { ...a, sounds: { ...a.sounds!, ignored: ['typing-50', 'click-150'] } })).toEqual(['ignored sounds'])
      expect(changedAreas(p20(), { ...p20(), sounds: { spans: [], ignored: ['click-150'] } })).toEqual(['ignored sounds'])
      expect(changedAreas(a, { ...a, sounds: undefined })).toEqual(['sound', 'ignored sounds'])
      // The same sounds ignored in another order (Bring back, then Ignore again) are the same.
      const two = { ...a, sounds: { ...a.sounds!, ignored: ['click-150', 'typing-50'] } }
      expect(changedAreas(two, { ...a, sounds: { ...a.sounds!, ignored: ['typing-50', 'click-150'] } })).toEqual([])
      expect(changedAreas(a, { ...a, publish: { description: 'Another text.' } })).toEqual(['export description'])
      expect(changedAreas(a, { ...a, publish: undefined })).toEqual(['export description'])
      // Keep in Review mode: the record goes and the choice stays, the clips are the same.
      expect(changedAreas(a, { ...a, autoCuts: undefined, autoCutOutcomes: [...a.autoCutOutcomes!, { id: 'a1', outcome: 'kept' }] })).toEqual(['automatic changes to review'])
    })

    it('names speakers relabelled as speaker names, not as caption text, and both when both changed', () => {
      const a = full()
      expect(changedAreas(a, { ...a, transcript: transcript(['You', 'Maya']) })).toEqual(['speaker names'])
      expect(changedAreas(a, { ...a, transcript: transcript([undefined, undefined]) })).toEqual(['speaker names'])
      expect(changedAreas(a, { ...a, transcript: transcript(['You', 'Speaker 2'], ['Hello there', 'Welcome home']) })).toEqual(['caption text'])
      expect(changedAreas(a, { ...a, transcript: transcript(['You', 'Maya'], ['Hello there', 'Welcome home']) })).toEqual(['caption text', 'speaker names'])
      // Show speaker names on the video is part of the captions' look.
      expect(changedAreas(a, { ...a, captions: { ...a.captions!, showSpeaker: undefined } })).toEqual(['captions look'])
    })

    it('names Captions Studio’s own parts as the captions look, never "other settings" (test 56: tests/versionsCaptions.test.ts)', () => {
      const a = full()
      expect(changedAreas(a, { ...a, captionMarks: undefined })).toEqual(['captions look'])
      expect(changedAreas(a, { ...a, captionPlaces: [{ caption: 's1', position: 'bottom' }] })).toEqual(['captions look'])
      expect(changedAreas(a, { ...a, bleeps: undefined })).toEqual(['captions look'])
    })
  })
})

describe('restoreVersion', () => {
  it("keeps the recording's fields of the edit now and takes the rest from the version", () => {
    const now: Project = { ...p20(), name: 'Now', createdAt: '2026-01-01T00:00:00.000Z', copyOf: { id: 'src', name: 'Source' } }
    const old: Project = { ...p20({ zooms: [zoom('z', 1, 2)] }), id: 'other', name: 'Old', createdAt: '2020-01-01T00:00:00.000Z', duration: 99, hasAudio: false }
    const r = restoreVersion(now, old)
    expect(r.zooms).toEqual(old.zooms)
    expect(r).toMatchObject({ id: 'p20', name: 'Now', createdAt: '2026-01-01T00:00:00.000Z', duration: 20, hasAudio: true, copyOf: { id: 'src', name: 'Source' } })
  })
  it('drops a recording field the edit now does not have', () => {
    const now = p20()
    const old: Project = { ...p20(), copyOf: { id: 'x', name: 'X' }, source: { kind: 'import' } as Project['source'] }
    const r = restoreVersion(now, old)
    expect('copyOf' in r).toBe(false)
    expect('source' in r).toBe(false)
  })
})

describe('files a version names', () => {
  it('lists the background, cursor, logo, music, images and fonts', () => {
    const p = p20()
    const q: Project = {
      ...p,
      style: { ...p.style, background: { type: 'image', path: 'background.png' } },
      cursor: { ...p.cursor, style: 'custom', customImage: 'cursor.png' },
      watermark: { show: true, kind: 'image', path: 'watermark-2.png', position: 'top-left', size: 0.1, opacity: 1, margin: 0.02 } as Project['watermark'],
      audio: { ...p.audio, music: { path: 'music-3.mp3', volume: 1, ducking: 0, loop: true, fadeIn: 0, fadeOut: 0 } },
      overlays: [{ id: 'o', file: 'overlay-1.png' } as NonNullable<Project['overlays']>[number], { id: 'p', sticker: 'star' } as unknown as NonNullable<Project['overlays']>[number]],
      fonts: [{ id: 'f', name: 'F', file: 'font-1.ttf' }]
    }
    expect(namedFiles(q).map((f) => f.file)).toEqual(['background.png', 'cursor.png', 'watermark-2.png', 'music-3.mp3', 'overlay-1.png', 'font-1.ttf'])
    expect(namedFiles(p20())).toEqual([])
  })
  it('tells which a later pick writes over, and which changed since', () => {
    const p = p20()
    const q: Project = {
      ...p,
      style: { ...p.style, background: { type: 'image', path: 'background.png' } },
      cursor: { ...p.cursor, style: 'custom', customImage: 'cursor.png' },
      audio: { ...p.audio, music: { path: 'music-3.mp3', volume: 1, ducking: 0, loop: true, fadeIn: 0, fadeOut: 0 } }
    }
    expect(replacedInPlace(q)).toEqual([
      { file: 'background.png', what: 'background image' },
      { file: 'cursor.png', what: 'cursor image' }
    ])
    expect(changedFilesNotice([])).toBe('')
    expect(changedFilesNotice(['background image'])).toBe('Its background image has changed since it was kept.')
    expect(changedFilesNotice(['background image', 'cursor image'])).toBe('Its background image and cursor image have changed since it was kept.')
  })
  it('says which are missing', () => {
    expect(missingFilesNotice([])).toBe('')
    expect(missingFilesNotice(['music'])).toBe('Its music file is no longer in the project folder.')
    expect(missingFilesNotice(['music', 'logo'])).toBe('2 of its files (music, logo) are no longer in the project folder.')
  })
})

describe('metas read back', () => {
  const good = { id: 'v-lx3k9a2b-0123abcd', name: 'v1', auto: false, createdAt: '2026-10-30T10:00:00.000Z', bytes: 10, hash: HASH, summary: {} }
  it('accepts a valid meta and fills the summary', () => {
    const m = sanitizeMeta(good)!
    expect(m.name).toBe('v1')
    expect(m.summary.cuts).toBe(0)
  })
  it('refuses bad ids, times and hashes', () => {
    for (const id of ['../x', 'v-1-2', 'V-LX3K9A2B-0123ABCD', 'v-lx3k9a2b-0123abcd.json']) expect(sanitizeMeta({ ...good, id })).toBeNull()
    expect(sanitizeMeta({ ...good, createdAt: 'yesterday' })).toBeNull()
    expect(sanitizeMeta({ ...good, hash: 'x' })).toBeNull()
    expect(sanitizeMeta(null)).toBeNull()
    expect(VERSION_ID_RE.test('v-lx3k9a2b-0123abcd')).toBe(true)
  })
  it('keeps a reason only for automatic versions, and only a known one', () => {
    expect(sanitizeMeta({ ...good, auto: true, reason: 'polish' })?.reason).toBe('polish')
    expect(sanitizeMeta({ ...good, auto: true, reason: 'evil' })?.reason).toBeUndefined()
    expect(sanitizeMeta({ ...good, auto: false, reason: 'polish' })?.reason).toBeUndefined()
  })
  it('sanitises counts and names', () => {
    const m = sanitizeMeta({ ...good, name: '', bytes: -4, summary: { cuts: 2.7, zooms: 'x', duration: -1 } })!
    expect(m).toMatchObject({ name: 'Version', bytes: 0 })
    expect(m.summary).toMatchObject({ cuts: 2, zooms: 0, duration: 0 })
  })
})

describe('automatic versions kept', () => {
  const meta = (id: string, minute: number, auto: boolean): VersionMeta => ({
    id,
    name: id,
    auto,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    bytes: 1,
    hash: HASH,
    summary: versionSummary(p20())
  })
  it('drops the oldest automatic ones beyond five, never a named one', () => {
    const list = [meta('n1', 0, false), ...[1, 2, 3, 4, 5, 6, 7].map((m) => meta(`a${m}`, m, true)), meta('n2', 8, false)]
    expect(prunedAutos(list).sort()).toEqual(['a1', 'a2'])
    expect(prunedAutos(list.slice(0, 6))).toEqual([])
  })
})

describe('versionTime', () => {
  const now = new Date(2026, 9, 30, 15, 0)
  it('says today, yesterday, or the date', () => {
    expect(versionTime(new Date(2026, 9, 30, 14, 2).toISOString(), now)).toBe('Today 14:02')
    expect(versionTime(new Date(2026, 9, 29, 9, 5).toISOString(), now)).toBe('Yesterday 09:05')
    expect(versionTime(new Date(2026, 2, 12, 14, 2).toISOString(), now)).toBe('12 Mar 14:02')
    expect(versionTime(new Date(2025, 2, 12, 14, 2).toISOString(), now)).toBe('12 Mar 2025 14:02')
    expect(versionTime('nope', now)).toBe('')
  })
})
