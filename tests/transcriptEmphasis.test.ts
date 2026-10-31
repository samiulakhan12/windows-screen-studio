import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionMark, CaptionSegment, Project } from '../src/shared/types'
import { byTestId, contexts, key, mockReact, settle, testStore, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Emphasis and one caption's place in the Transcript tab (docs/design/captions-studio.md §2.7,
 * test 34) without a DOM. Toggling marks and places is part P1's (marks.ts): stand-ins here that
 * record the spans they were given and write marks as toggleEmphasis does.
 */

const p1 = vi.hoisted(() => ({ toggles: [] as unknown[][], places: [] as unknown[][] }))
vi.mock('../src/shared/captions/marks', () => ({
  toggleEmphasis: (p: Project, spans: { caption: string; from: number; to: number }[], tone?: 2) => {
    p1.toggles.push([spans, tone])
    const marks = p.captionMarks ?? []
    const all = spans.every((s) => marks.some((m) => m.caption === s.caption && m.from <= s.from && m.to >= s.to && (m.tone === 2) === (tone === 2)))
    const next: CaptionMark[] = all
      ? marks.filter((m) => !spans.some((s) => s.caption === m.caption))
      : [...marks, ...spans.map((s, i) => ({ id: `m${marks.length + i}`, caption: s.caption, from: s.from, to: s.to, text: 'x', ...(tone ? { tone } : {}) }))]
    const studio = p.captions?.studio ?? ({ from: p.captions?.preset ?? 'clean' } as never)
    return { ...p, captionMarks: next.length ? next : undefined, captions: { ...p.captions!, studio } }
  },
  withCaptionPlace: (p: Project, caption: string, position: 'top' | 'bottom' | null) => {
    p1.places.push([caption, position])
    const rest = (p.captionPlaces ?? []).filter((c) => c.caption !== caption)
    const places = position ? [...rest, { caption, position }] : rest
    return { ...p, captionPlaces: places.length ? places : undefined }
  }
}))

vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: () => 0 })
vi.stubGlobal('document', { activeElement: null, body: {}, elementFromPoint: () => null })

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/TranscriptPanel'
const MARKS = '../src/renderer/src/editor/panels/transcriptMarks'
const { TranscriptPanel } = (await import(/* @vite-ignore */ PANEL)) as { TranscriptPanel: (p: unknown) => unknown }
const marks = (await import(/* @vite-ignore */ MARKS)) as {
  pieceWords(text: string, language?: string): [number, number][]
  selectionSpans(words: unknown[], a: number, b: number, segments: CaptionSegment[], language?: string): { caption: string; from: number; to: number }[]
  wordEmphasis(words: unknown[], marks: CaptionMark[] | undefined, segments: CaptionSegment[], language?: string): number[]
  removesEmphasis(spans: { caption: string; from: number; to: number }[], marks: CaptionMark[] | undefined, tone?: 2): boolean
  emphasisNotice(n: number, removed: boolean, twinOf: string | null): string
}
const { transcriptWords } = await import('../src/shared/editor/transcript')
const { createProject } = await import('../src/shared/engine/project')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
await useEditorContexts()

const segments: CaptionSegment[] = [
  { id: 'c1', start: 0, end: 3, text: 'Turn on Auto Save now' },
  { id: 'c2', start: 3, end: 6, text: 'then press Export' }
]
const base = createProject({
  id: 'p',
  name: 'p',
  duration: 10,
  width: 1920,
  height: 1080,
  hasWebcam: false,
  hasAudio: true,
  webcamOffset: 0,
  zooms: [],
  cursorValid: true,
  capture: { method: 'native', cursorInVideo: false, region: null }
})

let store: ReturnType<typeof testStore<Project>>
const notices: string[] = []
const player = { time: 0, subscribe: () => () => undefined, getPlaying: () => false, seek: () => undefined }
const view = (): unknown => ({ type: TranscriptPanel, props: { project: store.state, onNotice: (m: string) => notices.push(m), onSelect: () => undefined, onOpenCaptions: () => undefined } })
const SKIP = ['ReviewSection']

beforeEach(() => {
  unmountAll()
  store = testStore<Project>({ ...base, transcript: { language: 'en', segments } as Project['transcript'], captions: { ...DEFAULT_CAPTIONS } })
  contexts.editor = { store, player }
  notices.length = 0
  p1.toggles.length = 0
  p1.places.length = 0
})

/** Selects words `a..b` with the keys (Home, then Shift+→), as a keyboard user does. */
async function selectWords(a: number, b: number): Promise<El[]> {
  let els = await settle(view(), SKIP)
  const list = (): El => byTestId(els, 'transcript-words')!
  ;(list().props.onKeyDown as (e: unknown) => void)(key('Home'))
  els = await settle(view(), SKIP)
  for (let i = 0; i < a; i++) {
    ;(list().props.onKeyDown as (e: unknown) => void)(key('ArrowRight'))
    els = await settle(view(), SKIP)
  }
  for (let i = a; i < b; i++) {
    ;(list().props.onKeyDown as (e: unknown) => void)(key('ArrowRight', { shiftKey: true }))
    els = await settle(view(), SKIP)
  }
  return els
}
const wordEls = (els: El[]): El[] => els.filter((e) => e.props.role === 'option')

describe('Ctrl+B and Emphasise', () => {
  it('Ctrl+B in the word list emphasises the selected words, as marks of their caption, in one undo step', async () => {
    let els = await selectWords(2, 3)
    const e = key('b', { ctrlKey: true })
    ;(byTestId(els, 'transcript-words')!.props.onKeyDown as (e: unknown) => void)(e)
    expect(e.prevented).toBe(true)
    expect(p1.toggles).toEqual([[[{ caption: 'c1', from: 2, to: 3 }], undefined]])
    expect(store.steps).toBe(1)
    els = await settle(view(), SKIP)
    expect(wordEls(els).map((w) => w.props['aria-label'])).toEqual(['Turn', 'on', 'Auto, emphasised', 'Save, emphasised', 'now', 'then', 'press', 'Export'])
    expect(String(wordEls(els)[2].props.className)).toContain('emphasis')
  })

  it('says the Classic look became its own version on the first emphasis', async () => {
    const els = await selectWords(2, 3)
    ;(byTestId(els, 'transcript-emphasise')!.props.onClick as () => void)()
    expect(notices).toEqual(['Emphasised 2 words. Your captions are now your own version of Clean, which can show emphasis.'])
  })

  it('removes emphasis when every selected word has it', async () => {
    store.state = { ...store.state, captions: { ...DEFAULT_CAPTIONS, studio: { from: 'subtitle' } as never }, captionMarks: [{ id: 'm', caption: 'c1', from: 2, to: 3, text: 'Auto Save' }] }
    const els = await selectWords(2, 3)
    ;(byTestId(els, 'transcript-words')!.props.onKeyDown as (e: unknown) => void)(key('B', { ctrlKey: true }))
    expect(notices).toEqual(['Removed emphasis from 2 words'])
    expect(store.state.captionMarks).toBeUndefined()
  })

  it('Ctrl+Shift+B emphasises in the second colour, shown bold and underlined and named so', async () => {
    store.state = { ...store.state, captions: { ...DEFAULT_CAPTIONS, studio: { from: 'subtitle' } as never } }
    let els = await selectWords(7, 7)
    ;(byTestId(els, 'transcript-words')!.props.onKeyDown as (e: unknown) => void)(key('B', { ctrlKey: true, shiftKey: true }))
    expect(p1.toggles).toEqual([[[{ caption: 'c2', from: 2, to: 2 }], 2]])
    expect(notices).toEqual(['Emphasised 1 word'])
    els = await settle(view(), SKIP)
    const exportWord = wordEls(els)[7]
    expect(exportWord.props['aria-label']).toBe('Export, emphasised in the second colour')
    expect(String(exportWord.props.className)).toContain('emphasis2')
  })

  it('a selection over two captions emphasises the words of each', async () => {
    const els = await selectWords(4, 6)
    ;(byTestId(els, 'transcript-emphasise')!.props.onClick as () => void)()
    expect(p1.toggles[0][0]).toEqual([
      { caption: 'c1', from: 4, to: 4 },
      { caption: 'c2', from: 0, to: 1 }
    ])
  })

  it('the menu next to Emphasise has the second colour', async () => {
    let els = await selectWords(0, 0)
    const more = els.find((e) => e.props['aria-label'] === 'More emphasis' && e.type === 'button')!
    expect(more.props['aria-haspopup']).toBe('menu')
    ;(more.props.onClick as () => void)()
    els = await settle(view(), SKIP)
    ;(byTestId(els, 'transcript-emphasise-second')!.props.onClick as () => void)()
    expect(p1.toggles[0][1]).toBe(2)
  })
})

describe('one caption’s position', () => {
  it('writes and removes the caption’s place in one undo step each', async () => {
    let els = await selectWords(6, 6)
    const select = (): El => byTestId(els, 'caption-row-position')!
    expect(select().props.value).toBe('auto')
    ;(select().props.onChange as (e: unknown) => void)({ target: { value: 'top' } })
    expect(store.state.captionPlaces).toEqual([{ caption: 'c2', position: 'top' }])
    els = await settle(view(), SKIP)
    expect(select().props.value).toBe('top')
    ;(select().props.onChange as (e: unknown) => void)({ target: { value: 'auto' } })
    expect(store.state.captionPlaces).toBeUndefined()
    expect(p1.places).toEqual([
      ['c2', 'top'],
      ['c2', null]
    ])
    expect(store.steps).toBe(2)
  })

  it('is off without a selection', async () => {
    const els = await settle(view(), SKIP)
    expect(byTestId(els, 'caption-row-position')!.props.disabled).toBe(true)
    expect(byTestId(els, 'transcript-emphasise')!.props.disabled).toBe(true)
  })
})

describe('the tab’s words and the marks’ words', () => {
  it('maps a long piece of Chinese onto the words studioWordTexts counts', () => {
    expect(marks.pieceWords('我们今天学习如何导出视频 OK', 'zh').length).toBe(2)
    const [first] = marks.pieceWords('我们今天学习如何导出视频 OK', 'zh')
    expect(first[0]).toBe(0)
    expect(first[1]).toBeGreaterThan(0)
    const seg: CaptionSegment = { id: 'z', start: 0, end: 2, text: '我们今天学习如何导出视频 OK' }
    const words = transcriptWords({ language: 'zh', segments: [seg] } as never)
    const [span] = marks.selectionSpans(words, 1, 1, [seg], 'zh')
    expect(span.from).toBe(first[1] + 1)
    const shown = marks.wordEmphasis(words, [{ id: 'm', caption: 'z', from: 1, to: 1, text: '们' }], [seg], 'zh')
    expect(shown).toEqual([1, 0])
  })

  it('decides removal per tone, as toggleEmphasis does, and words the notices', () => {
    const m: CaptionMark[] = [{ id: 'm', caption: 'c1', from: 0, to: 2, text: 'a b c' }]
    expect(marks.removesEmphasis([{ caption: 'c1', from: 1, to: 2 }], m)).toBe(true)
    expect(marks.removesEmphasis([{ caption: 'c1', from: 1, to: 3 }], m)).toBe(false)
    expect(marks.removesEmphasis([{ caption: 'c1', from: 1, to: 2 }], m, 2)).toBe(false)
    expect(marks.emphasisNotice(1, true, null)).toBe('Removed emphasis from 1 word')
    expect(marks.emphasisNotice(2, false, null)).toBe('Emphasised 2 words')
  })
})
