import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AiTextRequest, AiTextTask, PackTextTask } from '../src/shared/api/ai'
import type { TextPrompt } from '../src/shared/captions/transcriptText'
import type { Annotation, CaptionSegment, CursorTrack, Project } from '../src/shared/types'
import { digest, rng, sceneFixtures } from './verticalFixtures'

/*
 * The equivalence guard of smart tools (docs/design/smart-tools.md §22.2: tests 1, 3, 4, 5 and the
 * old-project case of 101), pinned against the code after wave 10 merged and before any shared file
 * of this wave changed (044018d). Wave 11 only adds optional fields (§4.4), and every new aggregator,
 * hook and step returns its input without them, so for an old project every value here stays the
 * same bit for bit after the contracts and after every part merges: what it loads to, what Review
 * lists and does, what Versions compares, every existing text task's prompts, and its step badges'
 * numbers and Captions Studio's options. Values are digests of their exact JSON
 * (tests/verticalFixtures.ts digest); a changed digest names the fixture and the function. The
 * snapshots are never regenerated to make a change pass.
 */

const { migrateProject, createProject } = await import('../src/shared/engine/project')
const { reviewItems, pendingCount, reviewStatus, keepItems, removeItems } = await import('../src/shared/review/review')
const { changedAreas } = await import('../src/shared/editor/versions')
const { textPrompt, runTextTask } = await import('../src/shared/captions/transcriptText')
const { packPrompt } = await import('../src/shared/publish/prompts')
const { AI_TEXT_TASKS } = await import('../src/shared/api/ai')
const { badgeLabels } = await import('../src/shared/render/callouts')
const { resolveGreatOptions, DEFAULT_GREAT_OPTIONS } = await import('../src/shared/captions/great')
const { planPolish, DEFAULT_POLISH_OPTIONS } = await import('../src/shared/editor/polish')

interface OldFixture {
  name: string
  raw: Record<string, unknown>
}
const load = (file: string): OldFixture[] => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))

/** Keys this wave adds; an old project never gets one by loading (§4.4). */
function noNewKeys(p: Project): void {
  for (const k of ['guide', 'clipOf']) expect(p, k).not.toHaveProperty(k)
  for (const c of p.chapters ?? []) expect(c, 'chapter auto').not.toHaveProperty('auto')
  for (const t of p.captionTracks ?? []) expect(t, 'track host').not.toHaveProperty('host')
  for (const t of p.titles ?? []) expect(t.auto ?? {}, 'title host').not.toHaveProperty('host')
  for (const g of p.graphics ?? []) expect((g as { auto?: object }).auto ?? {}, 'graphic host').not.toHaveProperty('host')
}

/* ---------- the fixtures ---------- */

const words = (text: string, start: number, end: number): { text: string; start: number; end: number }[] => {
  const list = text.split(' ')
  const step = (end - start) / list.length
  return list.map((w, i) => ({ text: w, start: +(start + i * step).toFixed(3), end: +(start + (i + 1) * step).toFixed(3) }))
}

const LINES = [
  'Now let us open the settings page and look at billing.',
  'So first we click the Export button in the top right corner.',
  'This report has 42 rows, which is about 15% more than last week.',
  'Moving on, the next step is to share the file with your team.',
  'এখন আমরা সেটিংস পাতাটি খুলব এবং বিলিং দেখব।',
  'Next we type the address and press Enter to save it.',
  'Finally, check that https://example.com/start opens in a new tab.',
  'Okay, that is how you export a report from the dashboard.'
]

/** A narrated transcript of `n` captions, 4 s each, seeded. */
function narration(n: number, seed: number, pad = ''): CaptionSegment[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const text = `${LINES[Math.floor(r() * LINES.length)]}${pad}`
    const start = i * 4
    return { id: `s${i}`, start, end: start + 3.6, text, words: words(text, start, start + 3.6) }
  })
}

/** Automatic step badges (wave 10) every `every` s. */
function badges(n: number, every: number): Annotation[] {
  return Array.from({ length: n }, (_, i) => ({ id: `b${i}`, start: 3 + i * every, end: 6 + i * every, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge' as const, number: 'auto' as const, pin: { x: 0.3, y: 0.4 } }))
}

/** A project saved by wave 10 with its fields: smooth cuts kept by Polish, colour, the progress bar, sounds, callouts, user chapters and automatic badges. */
function wave10Project(): Project {
  const p = createProject({
    id: 'w10',
    name: 'Wave 10',
    duration: 180,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [{ id: 'z1', start: 10, end: 14, scale: 2, focus: { mode: 'cursor' }, auto: true }],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  const segments = narration(40, 7)
  return {
    ...p,
    createdAt: '2026-10-01T10:00:00.000Z',
    clips: [
      { id: 'a', start: 0, end: 60, speed: 1 },
      { id: 'b', start: 64, end: 180, speed: 1 }
    ],
    chapters: [
      { id: 'ch1', t: 0, title: 'Intro' },
      { id: 'ch2', t: 70, title: 'Billing' },
      { id: 'ch3', t: 120, title: 'Sharing' }
    ],
    annotations: [...badges(12, 14), { id: 't1', start: 2, end: 5, text: 'Hello', x: 0.5, y: 0.2, size: 0.05, style: 'pill', enter: { kind: 'rise', duration: 0.35, strength: 1 }, exit: { kind: 'fade', duration: 0.2, strength: 1 } }],
    transcript: { provider: 'openai', model: 'whisper-1', createdAt: '2026-10-01T00:00:00.000Z', language: 'en', segments },
    joins: { all: { kind: 'smooth', duration: 0.15, scale: 1.1 }, auto: { by: 'polish', was: null } },
    grade: { screen: { look: 'vivid', contrast: 0.1 } },
    chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' },
    soundFx: { zoomIn: 'sfx:whoosh-soft', volume: 0.35 },
    effects: { ...p.effects, badgesByChapter: true }
  } as Project
}

/** An old project with automatic step badges and captions, 3 minutes, no chapters (test 101's Polish case). */
function badgedProject(): Project {
  const p = createProject({
    id: 'badged',
    name: 'Badged',
    duration: 180,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  const segments = narration(44, 11)
  return {
    ...p,
    createdAt: '2026-10-02T10:00:00.000Z',
    clips: [{ id: 'c0', start: 0, end: 180, speed: 1 }],
    annotations: badges(10, 16),
    transcript: { provider: 'local', model: 'base', createdAt: '2026-10-01T00:00:00.000Z', language: 'en', segments }
  } as Project
}

interface Fixture {
  name: string
  project: Project
}

/** Every old project the guard reads, loaded as today's code loads it (stable ids for files without clips). */
function fixtures(): Fixture[] {
  const out: Fixture[] = []
  for (const f of load('vertical-old-projects.json')) {
    const p = migrateProject(structuredClone(f.raw))
    if (!Array.isArray(f.raw.clips)) p.clips = [{ ...p.clips[0], id: '(generated)' }]
    out.push({ name: `vertical ${f.name}`, project: p })
  }
  for (const f of [...load('wave8-old-projects.json'), ...load('captions-old-projects.json')]) out.push({ name: f.name, project: migrateProject(structuredClone(f.raw)) })
  for (const s of sceneFixtures()) out.push({ name: `scene ${s.name}`, project: migrateProject(JSON.parse(JSON.stringify(s.project))) })
  out.push({ name: 'wave 10', project: migrateProject(JSON.parse(JSON.stringify(wave10Project()))) })
  out.push({ name: 'badged', project: migrateProject(JSON.parse(JSON.stringify(badgedProject()))) })
  return out
}

/** A value per fixture, compared with SNAPSHOT[section][name]. */
function pinned(section: string, name: string, value: unknown): void {
  expect(digest(value), `${section} of ${name}`).toBe(SNAPSHOT[section]?.[name])
}

/* ---------- test 1 ---------- */

describe('old projects load to the same bytes, with no new key (test 1)', () => {
  for (const f of fixtures()) {
    it(`${f.name}: the same JSON, and a load of its save gives the same bytes`, () => {
      noNewKeys(f.project)
      const saved = JSON.stringify(f.project)
      pinned('json', f.name, saved)
      // Saved and opened again: the same project (a partial hand-edited file may list its keys in another order).
      expect(migrateProject(JSON.parse(saved))).toEqual(f.project)
    })
  }
})

/* ---------- test 3 ---------- */

describe('Review lists and does the same for old projects (test 3)', () => {
  for (const f of fixtures()) {
    it(`${f.name}: reviewItems, pendingCount, reviewStatus, keepItems and removeItems`, () => {
      const p = f.project
      const items = reviewItems(p)
      pinned('reviewItems', f.name, items)
      pinned('pendingCount', f.name, pendingCount(p))
      pinned('reviewStatus', f.name, items.map((i) => reviewStatus(p, i)))
      pinned('keepItems', f.name, keepItems(p, items))
      pinned('removeItems', f.name, removeItems(p, items))
      // Each item alone too: Keep and Remove of one row.
      pinned('keepOne', f.name, items.map((i) => digest(keepItems(p, [i]))))
      pinned('removeOne', f.name, items.map((i) => digest(removeItems(p, [i]))))
    })
  }
})

/* ---------- test 4 ---------- */

describe('Versions compares old projects the same way (test 4)', () => {
  it('changedAreas of every pair of fixtures', () => {
    const list = fixtures()
    const out: string[][] = []
    for (const a of list) for (const b of list) out.push(changedAreas(a.project, b.project))
    pinned('changedAreas', 'pairs', out)
  })

  it('changedAreas of each fixture against an edit of each kind', () => {
    const out: Record<string, string[][]> = {}
    for (const f of fixtures()) {
      const p = f.project
      const edits: Project[] = [
        { ...p, chapters: [...(p.chapters ?? []), { id: 'new', t: 1, title: 'New' }] },
        { ...p, name: `${p.name} 2` },
        { ...p, clips: p.clips.slice(0, 1) },
        { ...p, copyOf: { id: 'other', name: 'Other', shape: 'vertical' } } as Project
      ]
      out[f.name] = edits.map((e) => changedAreas(p, e))
    }
    pinned('changedAreas', 'edits', out)
  })
})

/* ---------- test 5 ---------- */

/** A valid answer to `prompt` (by its schema's name), so runTextTask goes through every batch. */
function answerFor(prompt: TextPrompt): unknown {
  const data = (): { segments: { id: string; text: string }[] } => JSON.parse(prompt.user.slice(prompt.user.indexOf('\n') + 1))
  switch (prompt.name) {
    case 'cleaned_captions':
    case 'translated_captions':
      return { segments: data().segments.map((s) => ({ id: s.id, text: s.text })) }
    case 'chapters': {
      const segs = data().segments as unknown as { start: number }[]
      return { chapters: [{ start: segs[0].start, title: 'Intro' }, { start: segs[Math.floor(segs.length / 2)].start, title: 'Middle' }] }
    }
    case 'title':
    case 'summary':
      return { text: 'A short answer' }
    case 'caption_marks':
      return { captions: [], numbers: [], lists: [], quotes: [] }
    default:
      return {
        description: 'A description.',
        tags: ['one', 'two'],
        text: 'A post.',
        title: 'Title',
        intro: 'Intro.',
        sections: [{ heading: 'Part', steps: ['Do this.'] }],
        summary: 'Summary.',
        items: [{ kind: 'new', text: 'A thing.' }]
      }
  }
}

const PACK_TASKS: readonly PackTextTask[] = ['youtube', 'linkedin', 'xpost', 'article', 'releaseNotes']

/** The requests of every existing task over `segments`, with the pack's choices. */
function requests(segments: CaptionSegment[]): { key: string; request: AiTextRequest }[] {
  const out: { key: string; request: AiTextRequest }[] = []
  for (const task of AI_TEXT_TASKS as readonly AiTextTask[]) {
    if ((PACK_TASKS as readonly string[]).includes(task)) {
      for (const tone of ['friendly', 'formal', 'excited'] as const)
        for (const length of ['short', 'normal'] as const) out.push({ key: `${task} ${tone} ${length}`, request: { task, segments, tone, length, context: { title: 'Billing demo', chapters: ['Intro', 'Billing'] } } as AiTextRequest })
    } else if (task === 'translate') out.push({ key: task, request: { task, segments, targetLanguage: 'Bangla' } })
    else if (task === 'marks') out.push({ key: task, request: { task, segments, marks: { language: 'en', captions: [] } } })
    else out.push({ key: task, request: { task, segments } })
  }
  return out
}

describe('every existing text task sends the same prompts (test 5)', () => {
  const sets: { name: string; segments: CaptionSegment[] }[] = [
    { name: 'short', segments: narration(12, 3) },
    { name: 'long', segments: narration(420, 5, ' And then we keep going with more words to make this longer than usual for a caption here.') },
    ...fixtures()
      .filter((f) => f.project.transcript?.segments.length)
      .map((f) => ({ name: `fixture ${f.name}`, segments: f.project.transcript!.segments }))
  ]
  for (const s of sets) {
    it(`${s.name}: textPrompt and packPrompt of each task`, () => {
      const out: Record<string, string> = {}
      for (const { key, request } of requests(s.segments)) {
        out[key] = digest(textPrompt(request))
        if ((PACK_TASKS as readonly string[]).includes(request.task)) out[`pack ${key}`] = digest(packPrompt(request as AiTextRequest & { task: PackTextTask }))
      }
      pinned('textPrompt', s.name, out)
    })

    it(`${s.name}: the prompts runTextTask sends, batches included`, async () => {
      const out: Record<string, string> = {}
      for (const { key, request } of requests(s.segments)) {
        const sent: TextPrompt[] = []
        const result = await runTextTask(request, async (prompt) => {
          sent.push(prompt)
          return answerFor(prompt)
        })
        out[key] = digest({ sent, result })
      }
      pinned('runTextTask', s.name, out)
    })
  }
})

/* ---------- test 101, the old-project case ---------- */

const NO_TRACK: CursorTrack = { samples: [], clicks: [], keys: [], valid: false }

describe('an old project keeps its badge numbers and Captions Studio options (test 101)', () => {
  for (const f of fixtures()) {
    it(`${f.name}: badgeLabels and resolveGreatOptions`, () => {
      pinned('badgeLabels', f.name, [...badgeLabels(f.project)])
      pinned('great', f.name, [resolveGreatOptions(DEFAULT_GREAT_OPTIONS, f.project, { w: 1920, h: 1080 }), resolveGreatOptions(DEFAULT_GREAT_OPTIONS, f.project, { w: 1080, h: 1920 })])
    })
  }

  it('Polish with default options on an old project with step badges leaves every badge label and makes no chapter-title card', () => {
    const project = fixtures().find((f) => f.name === 'badged')!.project
    const before = [...badgeLabels(project)]
    const r = planPolish(
      { project, recorded: NO_TRACK, sound: [{ start: 0, end: 180 }], transcript: null, speech: null, framing: { status: 'skipped' }, preset: null, newId: (() => { let n = 0; return () => `n${++n}` })() },
      DEFAULT_POLISH_OPTIONS
    )
    expect([...badgeLabels(r.project)]).toEqual(before)
    pinned('badgeLabels', 'badged after Polish', [...badgeLabels(r.project)])
    expect((r.project.titles ?? []).filter((t) => t.auto?.by === 'chapter')).toEqual([])
  })
})

/** The digests of today's outputs (044018d), by section and fixture. */
const SNAPSHOT: Record<string, Record<string, string>> = {
  json: {
    'vertical 16:9': '04b202012f7718e8ee675a5bf76d677b',
    'vertical 9:16': '5f6e141d4b9771e0eaf9074cd136338b',
    'vertical 1:1': '8b12516ba08f5c5a8cb867bfb624b221',
    'publish-pack': '0734ea033ee5306563158006e66c1b97',
    'review-mode': 'ee713de7cd94ad7e484552efd63474ea',
    'sound-finder': '225c27befc771ad0ddac4c8abc6fded9',
    'nw09-speakers': 'c916adb2a35c7a9f2232a4ebca799caf',
    'tall-karaoke': 'ca521dc07dd91400f2b8b8157436ff8a',
    'caption-data': 'bb317e748ce8c53c8f0c0e8bb23ec7a5',
    'default-look': '3f1ba14773b81d08932983cfd1f63bda',
    'minimal-hidden': 'fcccf73646eb246353c0f0ff7c6020cc',
    'scene wide-auto': '6b6d58ac74510f1e9150bc35a7e51277',
    'scene tall-fitted': '04ff985e8d44efab64f631672dfa4532',
    'scene square-fitted': 'fdc340cc52f31181b199bd88380c88e0',
    'scene wide-corners': 'fe5ab934806d903bee37223bb59e9862',
    'scene wide-side': '4ee95d9d8258ff343b16fee9b01e4096',
    'scene tall-layouts': '014a178c1c45ab6a377abb7fc7d91001',
    'scene square-corners': '0f906d89fc4c254c914f5981927b64ad',
    'scene crop-wide': '6eb28683da948de4a12324ed2bb15451',
    'scene crop-tall': '158bda87accd2aecee3cd10e1d0ca636',
    'scene frame-browser': '6bb4eee7103b85316f5de6f3326ee3b9',
    'scene frame-laptop-tall': '94db5862837f660e40358a3a1ee5caca',
    'scene window-43': 'be30ba1cf9e01eadaf8c88b5f5fb6049',
    'wave 10': 'e66feec27095de009153c007cce35a02',
    badged: 'd1af4eee223fcd0d2e7438b3370efb27'
  },
  reviewItems: {
    'vertical 16:9': '59d0f210b334703a293304716f679475',
    'vertical 9:16': '506b0e26746981cef4c14644daf3a53b',
    'vertical 1:1': '0a0f8646afda1a6d654ee6d4af40a816',
    'publish-pack': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'review-mode': '3a7976d76c43d45b1c6f421ce623a198',
    'sound-finder': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'nw09-speakers': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'tall-karaoke': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'caption-data': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'default-look': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'minimal-hidden': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene wide-auto': 'ebd0a80e92db838f2c1c030568785b74',
    'scene tall-fitted': 'fa5bd29a19f6605f4ab9a6858b5b3bef',
    'scene square-fitted': '919c93c48962ae071e2fc5798c973e22',
    'scene wide-corners': '5ab7145697f226b4fa9462b5b4a89d7e',
    'scene wide-side': '9ab36bf2d7fac10b1204e1c78012bea5',
    'scene tall-layouts': '624636331eb14760c285cf0be2ef91b9',
    'scene square-corners': 'b2795e6a3cfc12f3e4a400eb6d42b919',
    'scene crop-wide': 'f11f165da6b4f5d7f4ae2c217038d73d',
    'scene crop-tall': 'aeb4b639018ef51c42ce3d2b3253249b',
    'scene frame-browser': '0edd256abad893951466b9aef45854f6',
    'scene frame-laptop-tall': '8a886cf8aa09221a109c4ec56328f5b0',
    'scene window-43': 'ca39caaac969e5c1709599990f026304',
    'wave 10': 'd4fcb9af36237fe24518a6e25b77dfb8',
    badged: '4f53cda18c2baa0c0354bb5f9a3ecbe5'
  },
  pendingCount: {
    'vertical 16:9': '4b227777d4dd1fc61c6f884f48641d02',
    'vertical 9:16': '6b86b273ff34fce19d6b804eff5a3f57',
    'vertical 1:1': '6b86b273ff34fce19d6b804eff5a3f57',
    'publish-pack': '5feceb66ffc86f38d952786c6d696c79',
    'review-mode': '4b227777d4dd1fc61c6f884f48641d02',
    'sound-finder': '5feceb66ffc86f38d952786c6d696c79',
    'nw09-speakers': '5feceb66ffc86f38d952786c6d696c79',
    'tall-karaoke': '5feceb66ffc86f38d952786c6d696c79',
    'caption-data': '5feceb66ffc86f38d952786c6d696c79',
    'default-look': '5feceb66ffc86f38d952786c6d696c79',
    'minimal-hidden': '5feceb66ffc86f38d952786c6d696c79',
    'scene wide-auto': '4b227777d4dd1fc61c6f884f48641d02',
    'scene tall-fitted': '4b227777d4dd1fc61c6f884f48641d02',
    'scene square-fitted': 'd4735e3a265e16eee03f59718b9b5d03',
    'scene wide-corners': 'e7f6c011776e8db7cd330b54174fd76f',
    'scene wide-side': 'ef2d127de37b942baad06145e54b0c61',
    'scene tall-layouts': '4e07408562bedb8b60ce05c1decfe3ad',
    'scene square-corners': 'ef2d127de37b942baad06145e54b0c61',
    'scene crop-wide': 'ef2d127de37b942baad06145e54b0c61',
    'scene crop-tall': '4b227777d4dd1fc61c6f884f48641d02',
    'scene frame-browser': '4e07408562bedb8b60ce05c1decfe3ad',
    'scene frame-laptop-tall': 'ef2d127de37b942baad06145e54b0c61',
    'scene window-43': 'd4735e3a265e16eee03f59718b9b5d03',
    'wave 10': 'd4735e3a265e16eee03f59718b9b5d03',
    badged: '5feceb66ffc86f38d952786c6d696c79'
  },
  reviewStatus: {
    'vertical 16:9': '3a60ff1532f0450d92fa6f89b4d40bb0',
    'vertical 9:16': 'de31a0f6b907a7db6859bd871365639f',
    'vertical 1:1': 'de31a0f6b907a7db6859bd871365639f',
    'publish-pack': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'review-mode': '3a60ff1532f0450d92fa6f89b4d40bb0',
    'sound-finder': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'nw09-speakers': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'tall-karaoke': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'caption-data': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'default-look': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'minimal-hidden': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene wide-auto': '3a60ff1532f0450d92fa6f89b4d40bb0',
    'scene tall-fitted': '3a60ff1532f0450d92fa6f89b4d40bb0',
    'scene square-fitted': '85231b87b6ddc6340b619dad295f0b20',
    'scene wide-corners': '87c13cc31cf6a81bca2449545555019a',
    'scene wide-side': '9c8cd7dcf4ad1b96c84eec8a0ea41851',
    'scene tall-layouts': '22c1c52c3bf678b1b428d9e0eec1067e',
    'scene square-corners': '9c8cd7dcf4ad1b96c84eec8a0ea41851',
    'scene crop-wide': '9c8cd7dcf4ad1b96c84eec8a0ea41851',
    'scene crop-tall': '3a60ff1532f0450d92fa6f89b4d40bb0',
    'scene frame-browser': '22c1c52c3bf678b1b428d9e0eec1067e',
    'scene frame-laptop-tall': '9c8cd7dcf4ad1b96c84eec8a0ea41851',
    'scene window-43': '85231b87b6ddc6340b619dad295f0b20',
    'wave 10': '85231b87b6ddc6340b619dad295f0b20',
    badged: '4f53cda18c2baa0c0354bb5f9a3ecbe5'
  },
  keepItems: {
    'vertical 16:9': 'ba9c05a969be4cdcbfb7ce54fc6ed023',
    'vertical 9:16': 'ade8977edbe2311a7a45dcb9150b44e7',
    'vertical 1:1': 'e6121d27e3911167cb559a868f4516c6',
    'publish-pack': '877c45120f330aa66ddd427418d40e54',
    'review-mode': '0be6950a210c47850c7a6f78444906df',
    'sound-finder': '0f88fadc2232b94dca447a9381d1ad59',
    'nw09-speakers': '36e47ac491a4223fd27dd7adf5c9438f',
    'tall-karaoke': 'ccabbb824de1f396ec4092d96f1732c4',
    'caption-data': 'b53005d939e7372c50979fd78e274149',
    'default-look': 'fe4041be06d69711b3dc1892d4420ac5',
    'minimal-hidden': '156b4f3debd951060966f3415d92533f',
    'scene wide-auto': '3f57273045839a9e1870e5db55a0e18a',
    'scene tall-fitted': '4f38fe5dde369f5ea5646ec5ec78f2e2',
    'scene square-fitted': '4119cbd93994daabb69681a4ad438211',
    'scene wide-corners': '17aac2c057bfe86f1a772ee99a9a7f68',
    'scene wide-side': 'fb884c72040a423930361db0ad54e45d',
    'scene tall-layouts': '385e55d9644e19fd44a06dca915d881f',
    'scene square-corners': '89c79b1a1f0b15526e3a25b2865d072d',
    'scene crop-wide': '47071656e8363b076d48624051f99ca3',
    'scene crop-tall': 'f8036aae5c85886ea00c5b946cd73e4e',
    'scene frame-browser': 'b6badef739d1ddaf28b7f916ccbff65d',
    'scene frame-laptop-tall': 'e74da2dacda740927db40d6a7ce01a18',
    'scene window-43': 'cf2a7b808f1f646367414399f76268db',
    'wave 10': 'f46db1fcb760342633f7f09d04ae04fa',
    badged: '2d10ae6e7261c145b231ab011a10ea41'
  },
  removeItems: {
    'vertical 16:9': 'ec75ce39cf8154fb8227d381e31163ca',
    'vertical 9:16': 'ee61e7689d39e2dfa5910d9324cb0a19',
    'vertical 1:1': '298cdbfd9a10dbc0c0f4faf120a08fe2',
    'publish-pack': '877c45120f330aa66ddd427418d40e54',
    'review-mode': '6ee0006659cc83739b2e45facb681026',
    'sound-finder': '0f88fadc2232b94dca447a9381d1ad59',
    'nw09-speakers': '36e47ac491a4223fd27dd7adf5c9438f',
    'tall-karaoke': 'ccabbb824de1f396ec4092d96f1732c4',
    'caption-data': 'b53005d939e7372c50979fd78e274149',
    'default-look': 'fe4041be06d69711b3dc1892d4420ac5',
    'minimal-hidden': '156b4f3debd951060966f3415d92533f',
    'scene wide-auto': '9b2c31e2a3507d3b313ecc9c32d83a59',
    'scene tall-fitted': '834ee4ad0a6657aa25059fa438774a66',
    'scene square-fitted': '4c44bfda19315ec51d354cdecc5cea54',
    'scene wide-corners': '154d4da159596a5bd1c608d9ce0eef04',
    'scene wide-side': 'f2508de1e4a0df130597c345ccbb5e70',
    'scene tall-layouts': '58a1b8a4b9ebcf23675fff76cbb3dab7',
    'scene square-corners': 'b01435e7a2a111322cf3698349869e8f',
    'scene crop-wide': '0c7342d5b16caff698789433ea904901',
    'scene crop-tall': '88dcd56b57ef92c479d319727a9574cf',
    'scene frame-browser': '04d4b726a8b4fed3fa21d8df8e64852b',
    'scene frame-laptop-tall': 'c762d86efd704f52a02b77d328f6d55a',
    'scene window-43': '051ce0402762a0f8fd243f340451a2d7',
    'wave 10': '5da70c8a3c5b1ed0e45226e66492cfbe',
    badged: '2d10ae6e7261c145b231ab011a10ea41'
  },
  keepOne: {
    'vertical 16:9': '45f11ec3a86adf5a3ce3fff574e4b9b5',
    'vertical 9:16': 'cc5df087087309e937ede0d8d19c5390',
    'vertical 1:1': '032a4b248e8610d6abd0619b1bad4e30',
    'publish-pack': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'review-mode': '8902d5debc59500ad6b255ac81c2456e',
    'sound-finder': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'nw09-speakers': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'tall-karaoke': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'caption-data': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'default-look': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'minimal-hidden': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene wide-auto': 'a588b494bf2f7ada23ef25c7e8be8a7b',
    'scene tall-fitted': '8e887ae8ae04d168a92ab67c0672d607',
    'scene square-fitted': '0fdb1d9d059b975a248ea57f4a41995f',
    'scene wide-corners': '2b20cf1a8d734ae87577296538ddbd58',
    'scene wide-side': '3235dc811e06e83500231fd16775004c',
    'scene tall-layouts': '7f4e6ee477457d01ffc2db8c17ec19d4',
    'scene square-corners': 'd11022a0058cccf9594d073e456faff2',
    'scene crop-wide': 'b1fbfc161afadd7f3f339298f5448d91',
    'scene crop-tall': 'ce133675f47af7541892766e2de98cb2',
    'scene frame-browser': 'f5a405fe98c8a63e49aa4d22d668d3fc',
    'scene frame-laptop-tall': 'f692737808afc4b32ffa5d3ec0b79d0c',
    'scene window-43': 'cd418678f56bfa1ba56db9c585aa4b29',
    'wave 10': 'b28741673b5f6651866a463693fc320e',
    badged: '4f53cda18c2baa0c0354bb5f9a3ecbe5'
  },
  removeOne: {
    'vertical 16:9': 'deb64d599c71f2533b68d8cb0d5cf032',
    'vertical 9:16': 'b324eded96e29827435fd4cfacc343b2',
    'vertical 1:1': '78d0c12c4d25876c47f7fd0bbeb5f036',
    'publish-pack': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'review-mode': '20bc9d32644bac88fb7a766bf842ba6a',
    'sound-finder': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'nw09-speakers': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'tall-karaoke': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'caption-data': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'default-look': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'minimal-hidden': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene wide-auto': '8c2e1d16e9921b43d895506cb18a5e8d',
    'scene tall-fitted': '5a849936de4fc329c110e86da7b6cff6',
    'scene square-fitted': 'b3cb08ba8bd8c2c677e19f564e0c304a',
    'scene wide-corners': '1486ed12de422450843c4cd3c8b97eaa',
    'scene wide-side': '6852e36c1805404625eb418d5e35833a',
    'scene tall-layouts': '819a0aa0ea88e9c57b89fac0754cefa9',
    'scene square-corners': 'c02e42be826411a131438c0888565821',
    'scene crop-wide': '55e3cc96e6b274554851aa66b391b248',
    'scene crop-tall': 'b8060e97ff2192ba1471265f5348b51f',
    'scene frame-browser': '69da0cebbaabb395cb283a469f5b5291',
    'scene frame-laptop-tall': '3af7ee4588c9df94f5e8642eb719eb75',
    'scene window-43': 'd696515e78b6811abce37f0c9666dea1',
    'wave 10': '15c1f5c11445fe3e6dcea2b639c97c21',
    badged: '4f53cda18c2baa0c0354bb5f9a3ecbe5'
  },
  changedAreas: {
    pairs: '5a3c8ef049c16c7d77fc6a0ac87760c2',
    edits: 'd556969dab4808fddd9832c661a5744b'
  },
  textPrompt: {
    short: '9413ec08e28872487ff03c682428ce1d',
    long: 'dd14becd73d66759ad94b9d60d6f5563',
    'fixture vertical 16:9': 'd5ab50a1f888eb27697e2ffdb22b38f7',
    'fixture publish-pack': '28aa5982563b69c42ab946f7bec1e00f',
    'fixture review-mode': '87591d8680ad400b01a09d9fdb6c3a81',
    'fixture sound-finder': '03eefa08298748b4448fd0c102284d45',
    'fixture nw09-speakers': '28aa5982563b69c42ab946f7bec1e00f',
    'fixture tall-karaoke': '03eefa08298748b4448fd0c102284d45',
    'fixture caption-data': '10f1c5a45a6b87966f4c1ef75592b5fc',
    'fixture default-look': '87591d8680ad400b01a09d9fdb6c3a81',
    'fixture minimal-hidden': '6d631900fc8e86fa9e92c46bab07968b',
    'fixture wave 10': 'ce09f4e452afad9c1103e0d33a6059f4',
    'fixture badged': '02f8eb0b0fc8ce5159faddfa4a224e23'
  },
  runTextTask: {
    short: '3ba22866d379ad58bf8c9191b150486a',
    long: 'fc43bc50302badb190f6cbe56e11c026',
    'fixture vertical 16:9': 'ddf0433c664721844806fb502844a592',
    'fixture publish-pack': '70d357e52fe911a817576113398751f7',
    'fixture review-mode': '984c2a37894865b76c5d5ed4d67a0783',
    'fixture sound-finder': '8ef926dfcab42e4eab7189d43854a0ae',
    'fixture nw09-speakers': '70d357e52fe911a817576113398751f7',
    'fixture tall-karaoke': '8ef926dfcab42e4eab7189d43854a0ae',
    'fixture caption-data': 'bd724f2e8d0b68eed153dc66de15699d',
    'fixture default-look': '984c2a37894865b76c5d5ed4d67a0783',
    'fixture minimal-hidden': 'a2920712a7ead9c3b3d2883be3581deb',
    'fixture wave 10': '930cb60ddebb7a3f410ccf3fed94ebc6',
    'fixture badged': '450e814099beca7cd5065c20e4ad6c36'
  },
  badgeLabels: {
    'vertical 16:9': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'vertical 9:16': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'vertical 1:1': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'publish-pack': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'review-mode': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'sound-finder': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'nw09-speakers': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'tall-karaoke': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'caption-data': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'default-look': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'minimal-hidden': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene wide-auto': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene tall-fitted': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene square-fitted': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene wide-corners': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene wide-side': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene tall-layouts': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene square-corners': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene crop-wide': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene crop-tall': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene frame-browser': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene frame-laptop-tall': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'scene window-43': '4f53cda18c2baa0c0354bb5f9a3ecbe5',
    'wave 10': 'de7d072f6081d3691150967937b82f29',
    badged: 'f3a2471ee80bc44da500eac7507c3860',
    'badged after Polish': 'f3a2471ee80bc44da500eac7507c3860'
  },
  great: {
    'vertical 16:9': 'a2242eb91e19871c0994e0ea5e9f4037',
    'vertical 9:16': 'ce43c65239cf5a475088dcf1769aaa2a',
    'vertical 1:1': 'ce43c65239cf5a475088dcf1769aaa2a',
    'publish-pack': 'a2242eb91e19871c0994e0ea5e9f4037',
    'review-mode': 'ce43c65239cf5a475088dcf1769aaa2a',
    'sound-finder': 'ce43c65239cf5a475088dcf1769aaa2a',
    'nw09-speakers': 'a2242eb91e19871c0994e0ea5e9f4037',
    'tall-karaoke': 'ce43c65239cf5a475088dcf1769aaa2a',
    'caption-data': 'ce43c65239cf5a475088dcf1769aaa2a',
    'default-look': 'ce43c65239cf5a475088dcf1769aaa2a',
    'minimal-hidden': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene wide-auto': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene tall-fitted': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene square-fitted': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene wide-corners': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene wide-side': 'f3fb5b868673c54b4f1ff3fc53e2a844',
    'scene tall-layouts': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene square-corners': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene crop-wide': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene crop-tall': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene frame-browser': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene frame-laptop-tall': 'ce43c65239cf5a475088dcf1769aaa2a',
    'scene window-43': 'f3fb5b868673c54b4f1ff3fc53e2a844',
    'wave 10': 'a2242eb91e19871c0994e0ea5e9f4037',
    badged: 'ce43c65239cf5a475088dcf1769aaa2a'
  }
}
