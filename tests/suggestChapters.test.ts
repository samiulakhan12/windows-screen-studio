/**
 * The Captions tab's Suggest chapters runs Find chapters with a provider's suggestions
 * (docs/design/smart-tools.md §7.6.1; §22.1 test 119), the real run with a mock service: its
 * starts are AI candidates of 3.5 beside the offline signals, the plan keeps YouTube's rules and
 * the user's chapters, a chosen start takes the AI's title, a suggested title holding a link or a
 * path gives way to the offline name, and Find chapters and Suggest chapters replace each other's
 * pending chapters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { CHAPTER_RULES } from '../src/shared/chapters/signals'
import { chapterReviewItems } from '../src/shared/review/chapterReview'
import type { SceneScan } from '../src/shared/api/projects'
import type { Chapter, CursorTrack, Project } from '../src/shared/types'
import { chapterProject, scanOf, type Said } from './chapterFixtures'

const GROQ = { id: 'svc1', kind: 'openai', label: 'Groq', model: 'llama', maskedKey: '…', createdAt: '', service: { preset: 'other', baseUrl: 'https://127.0.0.1/v1', host: '127.0.0.1', loopback: true, json: 'schema' } }
const OPENAI = { id: 'o1', kind: 'openai', label: 'My OpenAI', model: 'gpt', maskedKey: '…', createdAt: '' }
const fake = vi.hoisted(() => ({
  scan: null as SceneScan | null,
  suggested: [] as { t: number; title: string }[],
  asked: [] as { provider: string; task: string; segments: { text: string }[] }[]
}))
vi.stubGlobal('window', {
  api: {
    detectScenes: async () => fake.scan ?? { step: 0.25, t: [], changed: [], stills: [] },
    onSceneProgress: () => () => undefined,
    analyzeAudio: async () => ({}),
    listAiProviders: async () => [OPENAI, GROQ],
    aiText: async (provider: string, request: { task: string; segments: { text: string }[] }) => {
      fake.asked.push({ provider, task: request.task, segments: request.segments })
      return { task: 'chapters', chapters: fake.suggested }
    },
    cancelAiText: async () => undefined
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/editor/chaptersRun'
type Run = (deps: { store: EditStore<Project>; recorded: CursorTrack; options: Record<string, unknown>; signal: AbortSignal; requestId: string; onProgress(text: string, fraction: number | null): void }) => Promise<{ notice: string; weak: string | null } | { needsCaptions: true }>
const { runFindChapters } = (await import(/* @vite-ignore */ RUN)) as { runFindChapters: Run }

const NO_INPUT: CursorTrack = { samples: [], clicks: [], keys: [], valid: false }
const ALL = { screen: true, pauses: true, words: true }
let ids = 0
const run = (store: EditStore<Project>, options: Record<string, unknown>) => runFindChapters({ store, recorded: NO_INPUT, options: { density: 'normal', use: ALL, names: 'offline', ...options }, signal: new AbortController().signal, requestId: `captions-chapters-${++ids}`, onProgress: () => undefined })

/** 3 minutes said in three parts; the screen still. */
const SAID: Said[] = [
  { t: 1, text: 'Welcome to the billing tour.' },
  { t: 61, text: 'Here we look at every invoice of the account and what it says.' },
  { t: 121, text: 'Finally we export the report.' }
]
const projectOf = (chapters: Chapter[] = []): Project => ({ ...chapterProject({ duration: 180, said: SAID, chapters }), id: `suggest-${++ids}` })

beforeEach(() => {
  fake.scan = scanOf(180)
  fake.suggested = []
  fake.asked.length = 0
})

describe('Suggest chapters through a service (test 119)', () => {
  it("its starts are AI candidates of 3.5: chosen ones take its titles, by the service", async () => {
    expect(CHAPTER_RULES.score.ai).toBe(3.5)
    fake.suggested = [
      { t: 0, title: 'Welcome' },
      { t: 60.5, title: 'Invoices' },
      { t: 120.6, title: 'Export' }
    ]
    const store = new EditStore<Project>(projectOf())
    const out = await run(store, { split: 'svc1' })
    expect(out).toMatchObject({ notice: 'Found 3 chapters. Review lists them: keep or remove each one.' })
    // The chapters task was asked with the captions as the subtitles say them.
    expect(fake.asked).toEqual([{ provider: 'svc1', task: 'chapters', segments: expect.arrayContaining([expect.objectContaining({ text: 'Welcome to the billing tour.' })]) }])
    const chapters = store.state.chapters!
    // Snapped to the sentence starts.
    expect(chapters.map((c) => [c.t, c.title])).toEqual([
      [0, 'Welcome'],
      [61, 'Invoices'],
      [121, 'Export']
    ])
    for (const c of chapters) expect(c.auto).toMatchObject({ by: 'find', name: 'ai', via: 'openai', host: '127.0.0.1' })
    expect(chapters[1].auto!.from).toContain('ai')
    expect(chapterReviewItems(store.state)[1].detail).toBe('Suggest chapters with 127.0.0.1 · pause · named by 127.0.0.1')
  })

  it("the plan keeps YouTube's rules and the user's chapters: a start too near another, or near the user's, is left out", async () => {
    fake.suggested = [
      { t: 0, title: 'Welcome' },
      { t: 5, title: 'Too soon' },
      { t: 60.5, title: 'Invoices' },
      { t: 118, title: 'Near yours' },
      { t: 175, title: 'Too late' }
    ]
    const mine: Chapter = { id: 'u', t: 121, title: 'My export' }
    const store = new EditStore<Project>(projectOf([mine]))
    await run(store, { split: 'o1' })
    const chapters = [...store.state.chapters!].sort((a, b) => a.t - b.t)
    expect(chapters.map((c) => [c.t, c.title, !!c.auto])).toEqual([
      [0, 'Welcome', true],
      [61, 'Invoices', true],
      [121, 'My export', false]
    ])
    // Every chapter at least 10 s: YouTube would use them.
    for (let i = 1; i < chapters.length; i++) expect(chapters[i].t - chapters[i - 1].t).toBeGreaterThanOrEqual(10)
    expect(chapters[1].auto).toMatchObject({ via: 'openai' })
    expect(chapters[1].auto!.host).toBeUndefined()
  })

  it('a suggested title holding a path or a link gives way to the offline name', async () => {
    fake.suggested = [
      { t: 0, title: 'Welcome' },
      { t: 60.5, title: 'Open C:\\Users\\sam\\invoices' },
      { t: 120.6, title: 'Get it at paypal-login.com' }
    ]
    const store = new EditStore<Project>(projectOf())
    await run(store, { split: 'svc1' })
    const chapters = store.state.chapters!
    expect(chapters[1].title).not.toMatch(/Users|sam/)
    expect(chapters[1].auto!.name).not.toBe('ai')
    expect(chapters[2]).toMatchObject({ title: 'Export the report', auto: { name: 'sentence', from: expect.arrayContaining(['ai']) } })
  })

  it('a later Find chapters replaces those pending chapters, and the reverse', async () => {
    fake.suggested = [
      { t: 0, title: 'Welcome' },
      { t: 60.5, title: 'Invoices' },
      { t: 120.6, title: 'Export' }
    ]
    const mine: Chapter = { id: 'u', t: 150, title: 'Mine' }
    const store = new EditStore<Project>(projectOf([mine]))
    await run(store, { split: 'svc1' })
    const suggested = store.state.chapters!.filter((c) => c.auto).map((c) => c.id)
    expect(suggested).toHaveLength(2)
    // Find chapters, offline: page changes at 1:00 and 2:00.
    fake.scan = scanOf(180, { 60.5: 62, 120.5: 70 })
    await run(store, {})
    const found = store.state.chapters!.filter((c) => c.auto)
    expect(found.some((c) => suggested.includes(c.id))).toBe(false)
    expect(found.every((c) => !c.auto!.from.includes('ai') && c.auto!.name !== 'ai')).toBe(true)
    expect(store.state.chapters!.find((c) => c.id === 'u')).toEqual(mine)
    // And Suggest chapters again replaces those.
    const offline = found.map((c) => c.id)
    await run(store, { split: 'svc1' })
    expect(store.state.chapters!.filter((c) => c.auto).some((c) => offline.includes(c.id))).toBe(false)
    expect(store.state.chapters!.filter((c) => c.auto).every((c) => c.auto!.from.includes('ai'))).toBe(true)
  })

  it('without captions, Suggest chapters asks for them and sends nothing', async () => {
    const store = new EditStore<Project>({ ...chapterProject({ duration: 180 }), id: 'suggest-none' })
    expect(await run(store, { split: 'svc1' })).toEqual({ needsCaptions: true })
    expect(fake.asked).toEqual([])
  })
})
