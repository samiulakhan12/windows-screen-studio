import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorTrack, Project } from '../src/shared/types'
import { allByTestId, byTestId, contexts, mockReact, render, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Titles from the screenshots in the renderer (docs/design/smart-tools.md §5.3.1, §20.6; §22.1
 * tests 138 and 141), without a DOM: the pictures that go are the guide's own shots at most 768 px on
 * the longer side as JPEG 0.8; steps marked *May show what you typed* start unticked and an unticked
 * picture is never sent; *Also send the screenshots* is off until ticked for each run and never
 * offered with On this PC; the send viewer shows exactly the pictures that go, and Cancel sends
 * nothing; a long guide is several requests of at most 50 pictures, written in one update. The
 * canvas, its JPEG encoder and the shots are faked (guideStills draws the shots in the app).
 */

const calls = {
  /** The cost questions asked before a run (smart-tools.md §11.5). */
  asked: [] as string[],
  aiText: [] as { id: string; request: { task: string; names?: { kind: string; items: { id: string; text: string; action?: string; image?: Uint8Array }[] } }; requestId?: string }[],
  encoded: [] as { w: number; h: number; mime: string; quality: number }[],
  drawn: [] as { w: number; h: number }[]
}
/** The bytes the fake encoder writes for a canvas of w × h at `quality` (default: small). */
let jpegBytes = (_w: number, _h: number, _q: number): number => 2000
let providerModel = 'gpt-x'
let costAnswer = true
const prefs = new Map<string, unknown>()

/** A JPEG's header with a baseline frame (SOF0) of `w` × `h`, padded to `size` bytes. */
function sofJpeg(w: number, h: number, size = 64): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]
  const b = new Uint8Array(Math.max(size, head.length + 2))
  b.set(head, 0)
  b.set([0xff, 0xd9], b.length - 2)
  return b
}
/** A fake PNG carrying its size: its 9th to 12th bytes are w and h (little-endian). */
const PNG = (w: number, h: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, w & 255, w >> 8, h & 255, h >> 8])

/** A canvas whose toBlob writes a JPEG of its size, as many bytes as jpegBytes says. */
function fakeCanvas(): Record<string, unknown> {
  const c = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => void calls.drawn.push({ w: c.width, h: c.height }), imageSmoothingEnabled: false, imageSmoothingQuality: 'low' }),
    toBlob: (cb: (b: Blob | null) => void, mime: string, quality: number) => {
      calls.encoded.push({ w: c.width, h: c.height, mime, quality })
      cb(new Blob([new Uint8Array(sofJpeg(c.width, c.height, jpegBytes(c.width, c.height, quality)))], { type: mime }))
    }
  }
  return c
}

let clickListeners: ((e: unknown) => void)[] = []
vi.stubGlobal('HTMLElement', class {})
vi.stubGlobal('document', {
  activeElement: null,
  body: {},
  getElementById: () => ({ focus: () => undefined }),
  createElement: (tag: string) => (tag === 'canvas' ? fakeCanvas() : {}),
  addEventListener: (type: string, fn: (e: unknown) => void) => void (type === 'click' && clickListeners.push(fn)),
  removeEventListener: (_type: string, fn: (e: unknown) => void) => {
    clickListeners = clickListeners.filter((l) => l !== fn)
  }
})
vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
  const b = new Uint8Array(await blob.arrayBuffer())
  return { width: b[8] | (b[9] << 8), height: b[10] | (b[11] << 8), close: () => undefined }
})
vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer }))
const READY_LOCAL = { models: [{ id: 'gemma4-e2b', state: 'ready', bytes: 1, block: null }], use: 'auto', active: null, pc: { totalMemBytes: 16e9, freeMemBytes: 8e9, avx2: true, helper: true }, speeds: {} }
vi.stubGlobal('window', {
  api: {
    detectScenes: async () => Promise.reject(new Error('Reading the screen is not part of this build.')),
    getPref: async (key: string) => prefs.get(key) ?? null,
    setPref: async () => undefined,
    listAiProviders: async () => [{ id: 'o1', kind: 'openai', label: '', model: providerModel }],
    aiText: async (id: string, request: (typeof calls.aiText)[number]['request'], requestId?: string) => {
      calls.aiText.push({ id, request, requestId })
      return { task: 'names', names: (request.names?.items ?? []).map((i) => ({ id: i.id, name: `AI ${i.id}` })) }
    },
    cancelAiText: async () => undefined,
    copyGuide: async () => undefined,
    copyGuideImage: async () => undefined,
    saveGuide: async () => null,
    showGuideFile: async () => undefined,
    getBrandKit: async () => ({ colors: [], fonts: [], autoApply: false }),
    brandFile: async () => null,
    localAiState: async () => READY_LOCAL,
    onLocalAiState: () => () => undefined
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:shot', revokeObjectURL: () => undefined }))

mockReact()
// The question before a run with its own logic; only the dialog is answered here (no DOM).
vi.doMock('../src/renderer/src/ai/costConfirm', async (importOriginal) => {
  const real = (await importOriginal()) as { confirmCost: (e: unknown, c: unknown, ask?: (q: { text: string }) => Promise<boolean>) => Promise<boolean> }
  return {
    ...real,
    confirmCost: (e: unknown, c: unknown) =>
      real.confirmCost(e, c, async (q) => {
        calls.asked.push(q.text)
        return costAnswer
      })
  }
})
vi.doMock('../src/renderer/src/guide/guideStills', () => ({
  async *renderGuideStills(_input: unknown, shots: { key: string; rect: { w: number; h: number } }[], opts: { maxWidth: number; mime: string }) {
    for (const s of shots) {
      const w = Math.min(opts.maxWidth, Math.round(s.rect.w))
      const h = Math.round((w * s.rect.h) / s.rect.w)
      yield { key: s.key, image: { bytes: PNG(w, h), mime: opts.mime, width: w, height: h } }
    }
  },
  async encodeImage(image: unknown) {
    return image
  },
  canvasBytes: async () => new Uint8Array(),
  drawMarks: () => undefined
}))

// Renderer code: imported at run time, by paths held in constants, so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/guide/GuidePanel'
const VISION = '../src/renderer/src/guide/visionTitles'
const RUN = '../src/renderer/src/guide/guideRun'
const CHOICES = '../src/renderer/src/ai/textChoices'
const LOCAL_STATE = '../src/renderer/src/ai/localAiState'
const USE_COST = '../src/renderer/src/ai/useCost'
const COST_CONFIRM = '../src/renderer/src/ai/costConfirm'
type Picture = { key: string; jpeg: Uint8Array; ticked: boolean }
type Step = { key: string; t: number; kind: string; x?: number; y?: number }
type Image = { bytes: Uint8Array; mime: string; width: number; height: number }
const { GuidePanel, SEND_SHOTS_LABEL } = (await import(/* @vite-ignore */ PANEL)) as { GuidePanel: (p: unknown) => unknown; SEND_SHOTS_LABEL: string }
const vision = (await import(/* @vite-ignore */ VISION)) as {
  picturesToSend: (steps: readonly Step[], images: ReadonlyMap<string, Image>, typed: ReadonlyMap<string, string>) => Promise<Picture[]>
  pictureSize: (w: number, h: number) => { w: number; h: number }
  namesWithPictures: (project: Project, steps: readonly Step[], pictures: ReadonlyMap<string, Uint8Array>) => { kind: string; items: { id: string; text: string; image?: Uint8Array }[] }
  pictureBatches: (names: { kind: string; items: { id: string; image?: Uint8Array }[] }) => { items: { id: string; image?: Uint8Array }[] }[]
  PICTURE: { mime: string; quality: number; longest: number }
}
const { writeStepTitles } = (await import(/* @vite-ignore */ RUN)) as {
  writeStepTitles: (deps: { store: unknown; steps: readonly Step[]; choice: unknown; pictures: ReadonlyMap<string, Uint8Array> | null; signal: AbortSignal; requestId: string }) => Promise<{ notice: string }>
}
const { textChoicesOf, LOCAL_CHOICE, choiceOf } = (await import(/* @vite-ignore */ CHOICES)) as {
  textChoicesOf: (providers: unknown[], task: string, localReady: boolean, opts?: { pictures?: boolean }) => { id: string; kind: string; pictures?: boolean }[]
  LOCAL_CHOICE: { id: string; kind: string; pictures?: boolean }
  choiceOf: (info: unknown) => { id: string; kind: string; place: string; pictures?: boolean }
}
const { setLocalAiState } = (await import(/* @vite-ignore */ LOCAL_STATE)) as { setLocalAiState: (s: unknown) => void }
const { refreshCostData } = (await import(/* @vite-ignore */ USE_COST)) as { refreshCostData: () => Promise<void> }
const { resetAskedCosts } = (await import(/* @vite-ignore */ COST_CONFIRM)) as { resetAskedCosts: () => void }
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')

const isJpeg = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
const jpegDims = (b: Uint8Array): { w: number; h: number } => ({ h: (b[13] << 8) | b[14], w: (b[15] << 8) | b[16] })

const words = (start: number, end: number, text: string): { text: string; start: number; end: number }[] => {
  const parts = text.split(' ')
  const d = (end - start) / parts.length
  return parts.map((w, i) => ({ text: w, start: start + i * d, end: start + (i + 1) * d - 0.01 }))
}

function project(withWords = true): Project {
  const p = createProject({
    id: 'p',
    name: 'Billing',
    duration: 40,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 }
  })
  return {
    ...p,
    transcript: {
      language: 'en',
      provider: 'local',
      model: 'test',
      createdAt: '2026-11-07T00:00:00Z',
      segments: withWords ? [{ id: 's1', start: 2.2, end: 3.4, text: 'Now click the Export button', words: words(2.2, 3.4, 'Now click the Export button') }] : []
    }
  }
}

// A click into a field at 3 s and typing at 3.5–5 s; a later click beside it (its shot holds the
// typing place: it may show what was typed); one far away; a shortcut.
const cursor: CursorTrack = {
  samples: [
    { t: 0, x: 0.5, y: 0.5 },
    { t: 40, x: 0.5, y: 0.5 }
  ],
  clicks: [
    { t: 3, x: 0.5, y: 0.5, button: 'left' },
    { t: 12, x: 0.52, y: 0.5, button: 'left' },
    { t: 25, x: 0.1, y: 0.9, button: 'left' }
  ],
  keys: [{ t: 30, label: 'Ctrl + S' }],
  typing: [{ t: 3.5, end: 5 }],
  valid: true,
  scale: 1
}

let store: ReturnType<typeof testStore<Project>>
const player = { time: 7.5, seeks: [] as number[], seek: (t: number) => void player.seeks.push(t), subscribe: () => () => undefined }
const panel = (): unknown => ({ type: GuidePanel, props: { project: store.state, cursor, start: 'guide', onClose: () => undefined, onNotice: () => undefined } })
const click = (el: El | undefined): unknown => (el!.props.onClick as () => unknown)()
const change = (el: El | undefined, target: Record<string, unknown>): unknown => (el!.props.onChange as (e: unknown) => unknown)({ target })

/** Renders until the faked screenshots arrive (made after the plans stay still for 250 ms) and the pictures are made. */
async function ready(): Promise<El[]> {
  await settle(panel())
  await new Promise((r) => setTimeout(r, 300))
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return settle(panel())
}
/** Lets the pictures be made and any run land, then renders again. */
async function later(): Promise<El[]> {
  await settle(panel())
  await new Promise((r) => setTimeout(r, 0))
  return settle(panel())
}
/** The panel with titles written by the provider. */
async function withAiTitles(): Promise<El[]> {
  const els = await ready()
  change(byTestId(els, 'guide-titles-ai'), {})
  return settle(panel())
}

beforeEach(() => {
  unmountAll()
  for (const list of Object.values(calls)) list.length = 0
  jpegBytes = () => 2000
  providerModel = 'gpt-x'
  costAnswer = true
  prefs.clear()
  resetAskedCosts()
  clickListeners = []
  setLocalAiState(READY_LOCAL)
  store = testStore(project())
  contexts.editor = { store, player }
  contexts.group = { select: () => undefined, command: () => undefined, notice: () => undefined, keys: new Set(), single: null, group: { keys: [] } }
})

describe('test 138: picturesToSend', () => {
  const step = (key: string): Step => ({ key, t: 1, kind: 'click', x: 0.5, y: 0.5 })
  const img = (w: number, h: number): Image => ({ bytes: PNG(w, h), mime: 'image/png', width: w, height: h })

  it('the guide’s shots, at most 768 px on the longer side, as JPEG at quality 0.8, in step order', async () => {
    const images = new Map([
      ['a', img(1600, 900)],
      ['b', img(600, 1000)],
      ['c', img(500, 300)]
    ])
    const out = await vision.picturesToSend([step('a'), step('b'), step('missing'), step('c')], images, new Map())
    expect(out.map((p) => p.key)).toEqual(['a', 'b', 'c'])
    for (const p of out) expect(isJpeg(p.jpeg)).toBe(true)
    expect(out.map((p) => jpegDims(p.jpeg))).toEqual([
      { w: 768, h: 432 },
      { w: 461, h: 768 },
      // Never made larger than the shot.
      { w: 500, h: 300 }
    ])
    expect(calls.encoded.every((e) => e.mime === 'image/jpeg' && e.quality === 0.8)).toBe(true)
    expect(vision.PICTURE).toEqual({ mime: 'image/jpeg', quality: 0.8, longest: 768 })
    expect(vision.pictureSize(1920, 1080)).toEqual({ w: 768, h: 432 })
  })

  it('steps marked May show what you typed start unticked; the rest ticked', async () => {
    const images = new Map([
      ['a', img(1600, 900)],
      ['b', img(1600, 900)]
    ])
    const out = await vision.picturesToSend([step('a'), step('b')], images, new Map([['b', 'a']]))
    expect(out.map((p) => [p.key, p.ticked])).toEqual([
      ['a', true],
      ['b', false]
    ])
  })

  it('a picture over 512 KB is encoded again at a lower quality; one that cannot get under it is left out', async () => {
    jpegBytes = (w, _h, q) => (w === 768 && q > 0.7 ? 600 * 1024 : w === 767 ? 600 * 1024 : 2000)
    const out = await vision.picturesToSend([step('a'), step('b')], new Map([['a', img(1536, 864)], ['b', img(767, 400)]]), new Map())
    expect(out.map((p) => p.key)).toEqual(['a'])
    expect(out[0].jpeg.byteLength).toBeLessThanOrEqual(512 * 1024)
    expect(calls.encoded.filter((e) => e.w === 768).map((e) => e.quality)).toEqual([0.8, 0.7])
  })

  it('at most 200 pictures in all', async () => {
    const many = Array.from({ length: 210 }, (_, i) => step(`s${i}`))
    const out = await vision.picturesToSend(many, new Map(many.map((s) => [s.key, img(100, 60)])), new Map())
    expect(out).toHaveLength(200)
  })

  it('unticked pictures are not sent: only the pictures given go, each beside its item; a step with a picture and no words goes with its action', () => {
    const p = project()
    const steps: Step[] = [
      { key: 'c3000', t: 3, kind: 'click', x: 0.5, y: 0.5 },
      { key: 'c12000', t: 12, kind: 'click', x: 0.8, y: 0.2 },
      { key: 'c25000', t: 25, kind: 'click', x: 0.2, y: 0.8 }
    ]
    const names = vision.namesWithPictures(p, steps, new Map([['c12000', sofJpeg(768, 432)]]))
    expect(names.items.map((i) => [i.id, i.text, !!i.image])).toEqual([
      ['c3000', expect.stringContaining('Export'), false],
      ['c12000', '', true]
    ])
  })
})

describe('a long guide: at most 50 pictures a request, one update', () => {
  it('120 pictures go as requests of 50, 50 and 20; the titles are written in one update', async () => {
    const p = project(false)
    const steps: Step[] = Array.from({ length: 120 }, (_, i) => ({ key: `c${i}`, t: i * 0.3, kind: 'click', x: 0.5, y: 0.5 }))
    const pictures = new Map(steps.map((s) => [s.key, sofJpeg(768, 432)]))
    expect(vision.pictureBatches(vision.namesWithPictures(p, steps, pictures)).map((b) => b.items.length)).toEqual([50, 50, 20])
    const s = testStore(p)
    const { notice } = await writeStepTitles({ store: s, steps, choice: choiceOf({ id: 'o1', kind: 'openai', label: '', model: 'gpt-x' }), pictures, signal: new AbortController().signal, requestId: 'guide-titles-1' })
    expect(calls.aiText.map((c) => c.request.names!.items.filter((i) => i.image).length)).toEqual([50, 50, 20])
    expect(s.steps).toBe(1)
    expect(s.state.guide!.steps).toHaveLength(120)
    expect(notice).toBe('Wrote 120 titles with OpenAI.')
  })
})

describe('the Guide panel: Also send the screenshots', () => {
  it('is off until ticked: Write titles sends no picture then', async () => {
    let els = await withAiTitles()
    const box = byTestId(els, 'guide-send-shots')!
    expect(box.props.checked).toBe(false)
    expect(textOf(els.find((e) => e.type === 'label' && textOf(e).includes(SEND_SHOTS_LABEL)))).toBe(SEND_SHOTS_LABEL)
    click(byTestId(els, 'guide-write-titles'))
    els = await later()
    expect(byTestId(els, 'guide-viewer')).toBeUndefined()
    expect(calls.aiText).toHaveLength(1)
    expect(calls.aiText[0].request.names!.items.some((i) => i.image)).toBe(false)
    // No picture is even made until the box is ticked.
    expect(calls.encoded).toHaveLength(0)
  })

  it('ticked: the cost line names the screenshots; Write titles opens the send viewer on Cancel, with typed steps unticked; Cancel sends nothing', async () => {
    let els = await withAiTitles()
    change(byTestId(els, 'guide-send-shots'), { checked: true })
    els = await later()
    expect(byTestId(els, 'guide-send-shots')!.props.checked).toBe(true)
    const write = byTestId(els, 'guide-write-titles')!
    expect(write.props.disabled).toBe(false)
    const line = els.find((e) => typeof e.props.id === 'string' && (e.props.id as string).endsWith('-titles-cost'))
    expect(textOf(line)).toMatch(/^Sends \d+ screenshots? and about \d+ words to OpenAI · /)
    const sentence = els.find((e) => e.props.id === write.props['aria-describedby'])
    expect(textOf(sentence)).toMatch(/; sends \d+ screenshots? and the steps' narration to OpenAI\.$/)
    // Which rows may show typing (§5.5.7): they start unticked.
    const typedRows = allByTestId(els, 'guide-step').filter((r) => String(r.props['aria-label']).includes('may show'))
    click(write)
    els = render(panel())
    const viewer = byTestId(els, 'guide-viewer')!
    expect(viewer).toBeDefined()
    expect(textOf(els.find((e) => e.props.id === 'guide-viewer-title'))).toBe('These screenshots go to OpenAI')
    const cancel = byTestId(els, 'guide-send-cancel')!
    expect(cancel.props.autoFocus).toBe(true)
    expect(textOf(byTestId(els, 'guide-send'))).toMatch(/^Send \d+ screenshots?$/)
    // The picture shown is the JPEG that goes.
    const shown = byTestId(els, 'guide-viewer-image')!
    expect(shown.props.width).toBeLessThanOrEqual(768)
    expect(calls.aiText).toHaveLength(0)
    // Walk the pictures: each typed step's checkbox starts unticked, with its note.
    const seen: { label: string; ticked: boolean; note: boolean }[] = []
    for (;;) {
      seen.push({ label: textOf(byTestId(els, 'guide-send-where')), ticked: byTestId(els, 'guide-send-tick')!.props.checked as boolean, note: !!byTestId(els, 'guide-send-note') })
      const next = byTestId(els, 'guide-viewer-next')!
      if (next.props.disabled) break
      click(next)
      els = render(panel())
    }
    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (const s of seen) expect(s.ticked).toBe(!s.note)
    // The notes are on exactly the rows marked in the panel (key presses send no picture).
    const typedNumbers = typedRows.map((r) => /^Step (\d+),/.exec(String(r.props['aria-label']))![1])
    const pictured = seen.map((s) => /step (\d+)$/.exec(s.label)![1])
    expect(seen.filter((s) => s.note).map((s) => /step (\d+)$/.exec(s.label)![1])).toEqual(typedNumbers.filter((n) => pictured.includes(n)))
    expect(seen.some((s) => s.note)).toBe(true)
    click(byTestId(els, 'guide-send-cancel'))
    els = await later()
    expect(byTestId(els, 'guide-viewer')).toBeUndefined()
    expect(calls.aiText).toHaveLength(0)
    expect(store.state.guide).toBeUndefined()
    // Still ticked: nothing ran.
    expect(byTestId(els, 'guide-send-shots')!.props.checked).toBe(true)
  })

  it('Send sends only the pictures still ticked, beside their items; the titles land in one update and the box is off again', async () => {
    let els = await withAiTitles()
    change(byTestId(els, 'guide-send-shots'), { checked: true })
    els = await later()
    click(byTestId(els, 'guide-write-titles'))
    els = render(panel())
    // Untick the first picture; tick every other one.
    const keys: string[] = []
    const want: string[] = []
    for (let i = 0; ; i++) {
      const tick = byTestId(els, 'guide-send-tick')!
      const on = i > 0
      change(tick, { checked: on })
      els = render(panel())
      const label = textOf(byTestId(els, 'guide-send-where'))
      keys.push(label)
      if (on) want.push(label)
      const next = byTestId(els, 'guide-viewer-next')!
      if (next.props.disabled) break
      click(next)
      els = render(panel())
    }
    expect(textOf(byTestId(els, 'guide-send'))).toBe(`Send ${want.length} ${want.length === 1 ? 'screenshot' : 'screenshots'}`)
    const before = store.steps
    click(byTestId(els, 'guide-send'))
    els = await later()
    expect(calls.aiText).toHaveLength(1)
    const items = calls.aiText[0].request.names!.items
    const withImages = items.filter((i) => i.image)
    expect(withImages).toHaveLength(want.length)
    for (const i of withImages) expect(isJpeg(i.image!)).toBe(true)
    // The first picture was unticked: its step goes without one (or not at all, when nothing was said there).
    const firstKey = items.find((i) => i.id === 'c3000')
    expect(firstKey?.image).toBeUndefined()
    expect(store.steps - before).toBe(1)
    expect(byTestId(els, 'guide-send-shots')!.props.checked).toBe(false)
    expect(textOf(byTestId(els, 'guide-said'))).toMatch(/^Wrote \d+ titles? with OpenAI\.$/)
  })

  it('with nothing said, the box makes Write titles usable again (the pictures alone)', async () => {
    store = testStore(project(false))
    contexts.editor = { store, player }
    let els = await withAiTitles()
    expect(byTestId(els, 'guide-write-titles')!.props.disabled).toBe(true)
    expect(textOf(byTestId(els, 'guide-write-why'))).toBe('Nothing was said near these steps.')
    change(byTestId(els, 'guide-send-shots'), { checked: true })
    els = await later()
    expect(byTestId(els, 'guide-write-titles')!.props.disabled).toBe(false)
    expect(byTestId(els, 'guide-write-why')).toBeUndefined()
    const line = els.find((e) => typeof e.props.id === 'string' && (e.props.id as string).endsWith('-titles-cost'))
    expect(textOf(line)).toMatch(/^Sends \d+ screenshots? to OpenAI · /)
  })
})

describe('test 141: never with On this PC; Cancel sends nothing', () => {
  it('On this PC is never a choice that sends pictures', () => {
    expect(LOCAL_CHOICE.pictures).toBe(false)
    const providers = [{ id: 'o1', kind: 'openai', label: '', model: 'gpt-x' }]
    expect(textChoicesOf(providers, 'names', true).map((c) => c.id)).toEqual(['o1', 'local'])
    expect(textChoicesOf(providers, 'names', true, { pictures: true }).map((c) => c.id)).toEqual(['o1'])
  })

  it('choosing On this PC takes the box away; back to the provider it is off again', async () => {
    let els = await withAiTitles()
    change(byTestId(els, 'guide-send-shots'), { checked: true })
    els = await later()
    const select = els.find((e) => e.type === 'select' && e.props['aria-label'] === 'Write titles with')!
    expect((select.props.children as El[]).map((o) => o.props.value)).toContain('local')
    change(select, { value: 'local' })
    els = await later()
    expect(byTestId(els, 'guide-send-shots')).toBeUndefined()
    // Write titles on this PC runs without the viewer and without a picture.
    click(byTestId(els, 'guide-write-titles'))
    els = await later()
    expect(byTestId(els, 'guide-viewer')).toBeUndefined()
    expect(calls.aiText).toHaveLength(1)
    expect(calls.aiText[0].id).toBe('local')
    expect(calls.aiText[0].request.names!.items.some((i) => i.image)).toBe(false)
    change(els.find((e) => e.type === 'select' && e.props['aria-label'] === 'Write titles with'), { value: 'o1' })
    els = await later()
    expect(byTestId(els, 'guide-send-shots')!.props.checked).toBe(false)
  })

  it('Cancel, or Esc, in the send viewer: the mock counts 0 requests', async () => {
    let els = await withAiTitles()
    change(byTestId(els, 'guide-send-shots'), { checked: true })
    els = await later()
    click(byTestId(els, 'guide-write-titles'))
    els = render(panel())
    click(byTestId(els, 'guide-send-cancel'))
    els = await later()
    expect(calls.aiText).toHaveLength(0)
    // Again, then Esc: the dialog closes itself with no result (useModalFocus calls onClose()).
    click(byTestId(els, 'guide-write-titles'))
    const viewer = render(panel(), ['ShotViewer']).find((e) => typeof e.type === 'function' && (e.type as { name: string }).name === 'ShotViewer')!
    expect(viewer.props.mode).toBe('send')
    ;(viewer.props.onClose as () => void)()
    els = await later()
    expect(byTestId(els, 'guide-viewer')).toBeUndefined()
    expect(calls.aiText).toHaveLength(0)
    expect(store.state.guide).toBeUndefined()
  })
})

describe('the cost in the send viewer (§5.3.1, §11.5)', () => {
  /** The send viewer open, with the box ticked; the pictures walked to the first marked one. */
  async function openViewer(): Promise<El[]> {
    await refreshCostData()
    let els = await withAiTitles()
    change(byTestId(els, 'guide-send-shots'), { checked: true })
    els = await later()
    click(byTestId(els, 'guide-write-titles'))
    return render(panel())
  }
  /** Walks to the first picture marked as maybe showing typing. */
  function toMarked(els: El[]): El[] {
    while (!byTestId(els, 'guide-send-note')) {
      click(byTestId(els, 'guide-viewer-next'))
      els = render(panel())
    }
    return els
  }

  it('the viewer’s line follows the ticks: what the pictures still ticked send, and the Send button reads it', async () => {
    let els = await openViewer()
    const first = textOf(byTestId(els, 'guide-send-cost'))
    const n = Number(/^Send (\d+)/.exec(textOf(byTestId(els, 'guide-send')))![1])
    expect(first).toMatch(new RegExp(`^Sends ${n} screenshots? and about \\d+ words to OpenAI · Cost unknown for gpt-x`))
    expect(byTestId(els, 'guide-send')!.props['aria-describedby']).toBe('guide-send-cost')
    els = toMarked(els)
    change(byTestId(els, 'guide-send-tick'), { checked: true })
    els = render(panel())
    expect(textOf(byTestId(els, 'guide-send-cost'))).toMatch(new RegExp(`^Sends ${n + 1} screenshots and about \\d+ words to OpenAI · `))
    expect(textOf(byTestId(els, 'guide-send'))).toBe(`Send ${n + 1} screenshots`)
  })

  it('ticking more than the line counted asks again for the larger cost; Cancel there sends nothing; the counted set is not asked again', async () => {
    providerModel = 'gpt-6.1-sol'
    prefs.set('aiConfirm', 'always')
    let els = await openViewer()
    els = toMarked(els)
    change(byTestId(els, 'guide-send-tick'), { checked: true })
    els = render(panel())
    costAnswer = false
    click(byTestId(els, 'guide-send'))
    els = await later()
    expect(calls.asked).toHaveLength(1)
    expect(calls.asked[0]).toMatch(/^This costs up to about US\$\d+\.\d{2} with gpt-6\.1-sol\. Run it\?$/)
    expect(calls.aiText).toHaveLength(0)
    expect(byTestId(els, 'guide-viewer')).toBeUndefined()
    // The pictures the line counted (the click asked about them): Send runs at once. (The marked
    // picture is unticked by hand: this harness keeps a closed dialog's state where React would not.)
    costAnswer = true
    click(byTestId(els, 'guide-write-titles'))
    els = toMarked(render(panel()))
    change(byTestId(els, 'guide-send-tick'), { checked: false })
    els = render(panel())
    click(byTestId(els, 'guide-send'))
    els = await later()
    expect(calls.asked).toHaveLength(1)
    expect(calls.aiText).toHaveLength(1)
    expect(calls.aiText[0].request.names!.items.some((i) => i.image)).toBe(true)
    prefs.clear()
    await refreshCostData()
  })
})
