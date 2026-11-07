import { describe, expect, it } from 'vitest'
import type { Chapter, Project } from '../src/shared/types'

/*
 * The contracts step of smart tools (docs/design/smart-tools.md §20.0, §22.1 tests 1 to 8 and 101 to
 * 104): the readers of the new fields keep what is valid and drop the rest without touching the
 * project around them; the found chapters change nothing until kept; the text pipeline's limits and
 * the names task; the key store and the routing of On this PC and services; every text tool sends a
 * request id; the hints name the place; and the test hooks are read only unpackaged. The
 * equivalence guard (tests 1, 3, 4, 5 and 101 for old projects) is tests/smartEquivalence.test.ts.
 */

const { migrateProject, createProject } = await import('../src/shared/engine/project')
const { readChapter, readChapterOrigin } = await import('../src/shared/engine/titleData')
const { GUIDE_LIMITS, readGuideSettings, readClipOrigin } = await import('../src/shared/guide/guideData')
const { pathLike, privateLike, readLinkUrl } = await import('../src/shared/smart/privateText')
const { readAutoCuts } = await import('../src/shared/review/autoCutData')
const { readJoins } = await import('../src/shared/engine/joinData')
const { readAutoOrigin, readCaptionTracks, readHost } = await import('../src/shared/captions/studioData')
const { pendingChapters, userChapters } = await import('../src/shared/chapters/pending')

function base(): Project {
  const p = createProject({
    id: 'w11',
    name: 'Smart',
    duration: 120,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return { ...p, createdAt: '2026-11-01T00:00:00.000Z' }
}

/* ---------- test 1: the new readers ---------- */

describe('the new fields load and save to the same bytes (test 1)', () => {
  it('every new reader returns undefined for absent input and is idempotent', () => {
    for (const absent of [undefined, null, 1, 'x', [], {}]) {
      expect(readGuideSettings(absent, 100)).toBeUndefined()
      expect(readClipOrigin(absent)).toBeUndefined()
      expect(readChapterOrigin(absent)).toBeUndefined()
    }
    for (const absent of [undefined, null, 1, '', [], {}]) expect(readHost(absent)).toBeUndefined()
    const guide = {
      title: 'Billing demo',
      intro: 'Line one\nLine two',
      kind: 'bug',
      expected: 'Works',
      actual: 'Fails',
      actualAt: 12,
      details: [{ text: 'Recorded on 7 November 2026' }, { text: 'Length 4:12', off: true }],
      language: 'bn',
      from: 'badges',
      brand: false,
      end: { heading: 'Done', label: 'Start', url: 'https://example.com/start' },
      steps: [{ key: 'c1200', title: 'Click “Export”', ai: 'local', rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, ring: { x: 0.3, y: 0.3 }, whole: true }],
      added: [{ key: 'a5000', t: 5, title: 'Step', text: 'note' }]
    }
    const once = readGuideSettings(guide, 100)
    expect(once).toEqual(guide)
    expect(readGuideSettings(JSON.parse(JSON.stringify(once)), 100)).toEqual(once)
    const clip = { kind: 'moment', start: 1, end: 40, why: 'Opens with a question' }
    expect(readClipOrigin(clip)).toEqual(clip)
    expect(readClipOrigin(readClipOrigin(clip))).toEqual(clip)
    const origin = { by: 'find', from: ['page', 'pause'], name: 'sentence', via: 'openai', host: 'api.groq.com' }
    expect(readChapterOrigin(origin)).toEqual(origin)
    expect(readChapterOrigin(readChapterOrigin(origin))).toEqual(origin)
  })

  it('a project with every new field saved by this version loads to the same bytes', () => {
    const p = base()
    const segments = [{ id: 's1', start: 1, end: 3, text: 'Hello there' }]
    const withNew = {
      ...p,
      copyOf: { id: 'p-orig-1', name: 'Original' },
      clipOf: { kind: 'short', start: 0, end: 60 },
      chapters: [
        { id: 'c1', t: 0, title: 'Intro' },
        { id: 'c2', t: 30, title: 'Set up billing', auto: { by: 'polish', from: ['page'], name: 'sentence' } }
      ],
      transcript: { provider: 'openai', model: 'whisper-1', createdAt: '', language: 'en', segments },
      captionTracks: [{ language: 'bn', by: 'openai', model: 'llama', createdAt: '', segments: [{ id: 's1', text: 'হ্যালো', src: 'x' }], host: 'api.groq.com' }],
      titles: [{ id: 't1', start: 30, end: 33, title: 'Set up billing', style: 'lower-third', background: 'blur', auto: { by: 'chapter', via: 'openai', chapter: 'c2', host: 'api.groq.com' } }],
      publish: { description: 'A description.' },
      guide: { title: 'Billing', steps: [{ key: 'k3000', hidden: true }] },
      autoCuts: [{ id: 'cut1', by: 'short', action: 'cut', start: 10, end: 12, was: [{ start: 10, end: 12, speed: 1 }] }],
      joins: { all: { kind: 'smooth' }, auto: { by: 'short', was: null } }
    }
    const saved = JSON.stringify(migrateProject(JSON.parse(JSON.stringify(withNew))))
    expect(saved).toBe(JSON.stringify(migrateProject(JSON.parse(saved))))
    const again = JSON.parse(saved) as Project
    expect(again.clipOf).toEqual(withNew.clipOf)
    expect(again.guide).toEqual(withNew.guide)
    expect(again.chapters![1].auto).toEqual(withNew.chapters[1].auto)
    expect(again.captionTracks![0].host).toBe('api.groq.com')
    expect(again.titles![0].auto!.host).toBe('api.groq.com')
    expect(again.autoCuts![0].by).toBe('short')
    expect(again.joins!.auto).toEqual({ by: 'short', was: null })
    // Where the keys sit: clipOf after copyOf, guide after publish.
    const keys = Object.keys(again)
    expect(keys.indexOf('clipOf')).toBe(keys.indexOf('copyOf') + 1)
    expect(keys.indexOf('guide')).toBe(keys.indexOf('publish') + 1)
  })

  it('damaged new fields are dropped on load, never stored as empty objects', () => {
    const p = migrateProject({ ...base(), guide: { steps: [{ key: 'x1' }], title: 5 }, clipOf: { kind: 'moment', start: 5, end: 5 } })
    expect(p).not.toHaveProperty('guide')
    expect(p).not.toHaveProperty('clipOf')
  })
})

/* ---------- test 2: the readers ---------- */

describe('the readers keep what is valid and drop the rest (test 2)', () => {
  it('readChapterOrigin keeps each name and from with section and ai; drops a bad by, from or host, keeping the chapter', () => {
    for (const name of ['card', 'sentence', 'phrase', 'cut', 'number', 'ai']) expect(readChapterOrigin({ by: 'find', from: ['start'], name })?.name).toBe(name)
    expect(readChapterOrigin({ by: 'polish', from: ['section', 'ai'], name: 'ai', via: 'local' })).toEqual({ by: 'polish', from: ['section', 'ai'], name: 'ai', via: 'local' })
    // Unknown signals dropped, at most 3 kept in order; none known drops the origin.
    expect(readChapterOrigin({ by: 'find', from: ['nope', 'page', 'pause', 'cue', 'topic'], name: 'phrase' })?.from).toEqual(['page', 'pause', 'cue'])
    expect(readChapterOrigin({ by: 'find', from: ['nope'], name: 'phrase' })).toBeUndefined()
    expect(readChapterOrigin({ by: 'find', from: [], name: 'phrase' })).toBeUndefined()
    expect(readChapterOrigin({ by: 'auto', from: ['page'], name: 'phrase' })).toBeUndefined()
    expect(readChapterOrigin({ by: 'find', from: ['page'], name: 'title' })).toBeUndefined()
    expect(readChapterOrigin({ by: 'find', from: ['page'], name: 'ai', via: 'groq' })).toBeUndefined()
    for (const host of ['a b', 'x'.repeat(254), 'x/y', 'API.groq.com', '', 7]) {
      expect(readChapterOrigin({ by: 'find', from: ['ai'], name: 'ai', via: 'openai', host }), String(host)).toBeUndefined()
      const c = readChapter({ id: 'c', t: 4, title: 'Found', auto: { by: 'find', from: ['ai'], name: 'ai', via: 'openai', host } } as Partial<Chapter>, 10)
      expect(c).toEqual({ id: 'c', t: 4, title: 'Found' })
    }
    expect(readHost('x'.repeat(253))).toBe('x'.repeat(253))
    expect(readHost('[::1]')).toBe('[::1]')
    expect(readHost('xn--bcher-kva.example')).toBe('xn--bcher-kva.example')
  })

  it('readAutoOrigin and the track reader keep a valid host with openai only', () => {
    expect(readAutoOrigin({ by: 'chapter', via: 'openai', chapter: 'c', host: 'api.groq.com' })).toEqual({ by: 'chapter', via: 'openai', chapter: 'c', host: 'api.groq.com' })
    expect(readAutoOrigin({ by: 'chapter', via: 'openai', host: 'a b' })).toEqual({ by: 'chapter', via: 'openai' })
    expect(readAutoOrigin({ by: 'chapter', via: 'gemini', host: 'api.groq.com' })).toEqual({ by: 'chapter', via: 'gemini' })
    const transcript = { provider: 'openai' as const, model: 'w', createdAt: '', segments: [{ id: 's1', start: 0, end: 1, text: 'Hi' }] }
    const track = (by: string, host: unknown) => readCaptionTracks([{ language: 'bn', by, model: 'm', createdAt: '', segments: [{ id: 's1', text: 'হাই', src: 'x' }], host }], transcript)![0]
    expect(track('openai', 'api.groq.com').host).toBe('api.groq.com')
    expect(track('openai', 'x/y')).not.toHaveProperty('host')
    expect(track('local', 'api.groq.com')).not.toHaveProperty('host')
  })

  it('readGuideSettings cuts every string to GUIDE_LIMITS', () => {
    const long = (n: number) => 'x'.repeat(n + 5)
    const g = readGuideSettings(
      {
        title: long(GUIDE_LIMITS.title),
        intro: long(GUIDE_LIMITS.intro),
        expected: long(GUIDE_LIMITS.expected),
        actual: long(GUIDE_LIMITS.actual),
        details: Array.from({ length: 10 }, () => ({ text: long(GUIDE_LIMITS.detail) })),
        end: { heading: long(GUIDE_LIMITS.endHeading), label: long(GUIDE_LIMITS.endLabel) },
        steps: [{ key: 'c1', title: long(GUIDE_LIMITS.stepTitle), text: long(GUIDE_LIMITS.stepText), type: long(GUIDE_LIMITS.stepType) }],
        added: [{ key: 'a1', t: 1, title: long(GUIDE_LIMITS.stepTitle), text: long(GUIDE_LIMITS.stepText) }]
      },
      100
    )!
    expect(g.title).toHaveLength(120)
    expect(g.intro).toHaveLength(2000)
    expect(g.expected).toHaveLength(2000)
    expect(g.actual).toHaveLength(2000)
    expect(g.details).toHaveLength(8)
    expect(g.details![0].text).toHaveLength(120)
    expect(g.end).toEqual({ heading: 'x'.repeat(120), label: 'x'.repeat(40) })
    expect(g.steps![0].title).toHaveLength(120)
    expect(g.steps![0].text).toHaveLength(1000)
    expect(g.steps![0].type).toHaveLength(200)
    expect(g.added![0].title).toHaveLength(120)
    expect(g.added![0].text).toHaveLength(1000)
    // Control characters become spaces; notes keep their line breaks.
    expect(readGuideSettings({ title: 'a\nb\u0000c', intro: 'a\r\nb\tc' })).toEqual({ title: 'a b c', intro: 'a\nb c' })
    // A cut never splits a surrogate pair.
    expect(readGuideSettings({ title: '😀'.repeat(130) })!.title).toBe('😀'.repeat(120))
  })

  it('readGuideSettings keeps the last edit of a key, drops bad keys, boxes and rings, and clamps times', () => {
    const g = readGuideSettings(
      {
        steps: [
          { key: 'c1', title: 'First' },
          { key: 'x12', title: 'bad key' },
          { key: 'c-1', title: 'bad key' },
          { key: 'b123', title: 'Badge' },
          { key: 'c1', title: 'Second' },
          { key: 'k2', rect: { x: 0.5, y: 0, w: 0.04, h: 0.5 }, ring: { x: 1.2, y: 0.5 }, title: 'Keys' },
          { key: 's3', rect: { x: 0.6, y: 0, w: 0.5, h: 0.5 }, title: 'Past the frame' },
          { key: 't4', rect: { x: 0, y: 0, w: 1, h: 1 }, ring: { x: 0, y: 1 } },
          { key: 'k5', hidden: 'yes' }
        ],
        added: [
          { key: 'a1', t: -4, title: 'Before' },
          { key: 'a2', t: 400, title: 'After' },
          { key: 'b1', t: 2, title: 'bad key' },
          { key: 'a3', t: Number.NaN, title: 'no time' }
        ],
        actualAt: 999
      },
      100
    )!
    expect(g.steps).toEqual([
      { key: 'b123', title: 'Badge' },
      { key: 'c1', title: 'Second' },
      { key: 'k2', title: 'Keys' },
      { key: 's3', title: 'Past the frame' },
      { key: 't4', rect: { x: 0, y: 0, w: 1, h: 1 }, ring: { x: 0, y: 1 } }
    ])
    expect(g.added).toEqual([
      { key: 'a1', t: 0, title: 'Before' },
      { key: 'a2', t: 100, title: 'After' }
    ])
    expect(g.actualAt).toBe(100)
    expect(readGuideSettings({ actualAt: -3 }, 100)).toEqual({ actualAt: 0 })
    expect(readGuideSettings({})).toBeUndefined()
    expect(readGuideSettings({ steps: [], added: [], details: [], kind: 'guide', language: 'fr', brand: true })).toBeUndefined()
  })

  it('readGuideSettings keeps an end link only when readLinkUrl takes it', () => {
    expect(readGuideSettings({ end: { heading: 'Done', url: 'javascript:alert(1)' } })).toEqual({ end: { heading: 'Done' } })
    expect(readGuideSettings({ end: { heading: 'Done', url: 'https://example.com/start' } })!.end!.url).toBe('https://example.com/start')
  })

  it('readLinkUrl takes https only, without credentials, at most 300 characters', () => {
    expect(readLinkUrl('https://example.com/start')).toBe('https://example.com/start')
    expect(readLinkUrl('https://EXAMPLE.com')).toBe('https://example.com/')
    for (const bad of ['http://example.com/start', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'https://user:pw@host/', 'https://user@host/', `https://example.com/${'x'.repeat(281)}`, 'data:text/html,hi', 'https://exa mple.com', 'https://example.com/\n', 'https://ex\u200bample.com', '//example.com', 'example.com', 7, null]) {
      expect(readLinkUrl(bad), String(bad)).toBeNull()
    }
    expect(readLinkUrl(`https://example.com/${'x'.repeat(280)}`)).not.toBeNull()
  })

  it('readClipOrigin refuses start ≥ end, an unknown kind and non-finite times; cuts why', () => {
    expect(readClipOrigin({ kind: 'moment', start: 5, end: 5 })).toBeUndefined()
    expect(readClipOrigin({ kind: 'moment', start: 6, end: 5 })).toBeUndefined()
    expect(readClipOrigin({ kind: 'clip', start: 1, end: 5 })).toBeUndefined()
    expect(readClipOrigin({ kind: 'short', start: 1, end: Infinity })).toBeUndefined()
    expect(readClipOrigin({ kind: 'short', start: 1, end: 5, why: 'w'.repeat(200) })!.why).toHaveLength(120)
  })

  it("'short' cut records survive readAutoCuts; readJoins keeps by 'short'", () => {
    const cuts = readAutoCuts([{ id: 'x', by: 'short', action: 'cut', start: 1, end: 2, was: [{ start: 1, end: 2, speed: 1 }] }], 10)
    expect(cuts?.[0].by).toBe('short')
    expect(readJoins({ all: { kind: 'smooth' }, auto: { by: 'short', was: null } })?.auto).toEqual({ by: 'short', was: null })
    expect(readJoins({ all: { kind: 'smooth' }, auto: { by: 'other', was: null } })).not.toHaveProperty('auto')
  })

  it('pathLike finds Windows and home paths, not fractions or slashes between words', () => {
    for (const p of ['C:\\Users\\sam', 'see d:/notes/x', '\\\\nas\\share', '~/notes', '/Users/sam', '/home/sam', 'open C:\\', 'Ｃ：＼Ｕｓｅｒｓ']) expect(pathLike(p), p).toBe(true)
    for (const p of ['1/2', 'and/or', 'Save/Export', 'TCP/IP', 'home/sam', 'a:b', 'http://x']) expect(pathLike(p), p).toBe(false)
  })

  it('privateLike is the link check on each piece, or a path', () => {
    for (const p of ['see example.com', 'mail sam@example.org', 'https://x.y', 'C:\\Users\\sam', 'www.flown']) expect(privateLike(p), p).toBe(true)
    for (const p of ['Set up billing', 'Open the settings page', 'Version 2.0 notes', 'রপ্তানি']) expect(privateLike(p), p).toBe(false)
  })

  it('pendingChapters and userChapters split by auto; a list without found chapters is returned as it is', () => {
    const chapters: Chapter[] = [
      { id: 'a', t: 0, title: 'Intro' },
      { id: 'b', t: 30, title: 'Found', auto: { by: 'find', from: ['page'], name: 'sentence' } }
    ]
    expect(pendingChapters({ chapters }).map((c) => c.id)).toEqual(['b'])
    expect(userChapters({ chapters }).map((c) => c.id)).toEqual(['a'])
    const old = [{ id: 'a', t: 0, title: 'Intro' }]
    expect(userChapters({ chapters: old })).toBe(old)
    expect(pendingChapters({ chapters: old })).toEqual([])
  })
})
