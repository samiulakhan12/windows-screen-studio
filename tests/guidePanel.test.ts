import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorTrack, Project } from '../src/shared/types'
import { byTestId, allByTestId, contexts, mockReact, render, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The Guide panel (docs/design/smart-tools.md §2.1, §5.3, §5.4, §5.8) without a DOM: tests 107 and
 * 108, the renderer side of 110 and Adjust from the panel (112) of §22.1, with Esc, the edits' undo
 * steps, the questions before a Save, the fonts a PDF embeds and the contrast of the panel's chips.
 * The screenshots are faked (guideStills.ts draws them with the export's own path in the app;
 * tests/e2e/guides.e2e.cjs runs it).
 */

const calls = {
  aiText: [] as { id: string; request: { task: string; names?: { kind: string; items: { id: string; text: string; action?: string }[] } }; requestId?: string }[],
  cancelled: [] as string[],
  copied: [] as { html: string; text: string }[],
  saved: [] as Record<string, unknown>[],
  prefs: [] as unknown[],
  focused: [] as string[],
  encoded: [] as { mime: string; maxWidth: number }[],
  fonts: [] as string[],
  scenes: [] as { id: string; crop: unknown }[],
  /** The cost questions asked before a run (smart-tools.md §11.5), and the answer given. */
  asked: [] as string[]
}
let costAnswer = true
/** The provider's model: gpt-x has no price; gpt-6.1-sol is in the bundled price list. */
let providerModel = 'gpt-x'
/** The prefs main would answer (aiConfirm for the question before a run). */
const prefs = new Map<string, unknown>()
/** The document's click listeners (the cost line holds a click above the amount set). */
let clickListeners: ((e: unknown) => void)[] = []
/** What the AI answers: a name for each item sent. */
let answer = (items: { id: string }[]): { id: string; name: string }[] => items.map((i) => ({ id: i.id, name: `AI ${i.id}` }))

vi.stubGlobal('HTMLElement', class {})
vi.stubGlobal('document', {
  activeElement: null,
  body: {},
  getElementById: (id: string) => ({ focus: () => calls.focused.push(id) }),
  addEventListener: (type: string, fn: (e: unknown) => void) => void (type === 'click' && clickListeners.push(fn)),
  removeEventListener: (_type: string, fn: (e: unknown) => void) => {
    clickListeners = clickListeners.filter((l) => l !== fn)
  }
})
vi.stubGlobal('fetch', async (url: string) => {
  calls.fonts.push(url)
  return { ok: true, arrayBuffer: async () => new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer }
})
vi.stubGlobal('window', {
  api: {
    detectScenes: async (id: string, crop: unknown) => {
      calls.scenes.push({ id, crop })
      return Promise.reject(new Error('Reading the screen is not part of this build.'))
    },
    getPref: async (key: string) => prefs.get(key) ?? null,
    setPref: async (key: string, value: unknown) => void calls.prefs.push({ key, value }),
    listAiProviders: async () => [{ id: 'o1', kind: 'openai', label: '', model: providerModel }],
    aiText: async (id: string, request: (typeof calls.aiText)[number]['request'], requestId?: string) => {
      calls.aiText.push({ id, request, requestId })
      return { task: 'names', names: answer(request.names?.items ?? []) }
    },
    cancelAiText: async (id: string) => void calls.cancelled.push(id),
    copyGuide: async (clip: { html: string; text: string }) => void calls.copied.push(clip),
    copyGuideImage: async () => undefined,
    saveGuide: async (payload: Record<string, unknown>) => (calls.saved.push(payload), { path: `/out/${payload.name}.pdf`, bytes: 1000 }),
    showGuideFile: async () => undefined,
    getBrandKit: async () => ({ colors: [], fonts: [], autoApply: false }),
    brandFile: async () => null,
    localAiState: async () => null
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})

const PNG = (w: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, w & 255, w >> 8])
/** Why the faked screenshots cannot be made (null: they are). */
let stillsFail: string | null = null

mockReact()
// P5's question before a run, with its own logic; only the dialog is answered here (no DOM).
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
    if (stillsFail) throw new Error(stillsFail)
    for (const s of shots) {
      const w = Math.min(opts.maxWidth, Math.round(s.rect.w))
      yield { key: s.key, image: { bytes: PNG(w), mime: opts.mime, width: w, height: Math.round((w * s.rect.h) / s.rect.w) } }
    }
  },
  async encodeImage(image: { width: number; height: number }, mime: string, _q: number, maxWidth: number) {
    calls.encoded.push({ mime, maxWidth })
    const w = Math.min(maxWidth, image.width)
    return { bytes: PNG(w), mime, width: w, height: Math.round((w * image.height) / image.width) }
  },
  canvasBytes: async () => new Uint8Array(),
  drawMarks: () => undefined
}))
/** Each modal dialog's ref and what it closes with, as given to useModalFocus (which still runs). */
const modals = new Map<unknown, () => void>()
vi.doMock('../src/renderer/src/editor/modalFocus', async (importOriginal) => {
  const real = (await importOriginal()) as { useModalFocus: (ref: unknown, onClose: () => void) => void }
  return {
    ...real,
    useModalFocus: (ref: unknown, onClose: () => void) => {
      modals.set(ref, onClose)
      real.useModalFocus(ref, onClose)
    }
  }
})
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/guide/GuidePanel'
const { GuidePanel, stepsLine, checkQuestion, checkOrder, nextUntitled, defaultPage } = (await import(/* @vite-ignore */ PANEL)) as {
  GuidePanel: (p: unknown) => unknown
  stepsLine: (c: { steps: number; hidden: number; untitled: number; typed: number }) => string
  checkQuestion: (c: { unchecked: number; typed: number; whole: number }) => string | null
  checkOrder: (keys: string[], typed: Set<string>, whole: Set<string>) => string[]
  nextUntitled: (keys: string[], untitled: Set<string>, from: string | null) => string | null
  defaultPage: (locale?: string) => 'A4' | 'Letter'
}
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')
const { cropOf } = await import('../src/shared/engine/crop')

const words = (start: number, end: number, text: string): { text: string; start: number; end: number }[] => {
  const parts = text.split(' ')
  const d = (end - start) / parts.length
  return parts.map((w, i) => ({ text: w, start: start + i * d, end: start + (i + 1) * d - 0.01 }))
}

function project(withWords = true): Project {
  const p = createProject({
    id: 'p',
    name: 'Secret',
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

const cursor: CursorTrack = {
  samples: [
    { t: 0, x: 0.5, y: 0.5 },
    { t: 40, x: 0.5, y: 0.5 }
  ],
  clicks: [
    { t: 3, x: 0.5, y: 0.5, button: 'left' },
    { t: 12, x: 0.8, y: 0.2, button: 'left' },
    { t: 25, x: 0.2, y: 0.8, button: 'left' }
  ],
  keys: [],
  valid: true,
  scale: 1
}

let store: ReturnType<typeof testStore<Project>>
/** The recording's input the panel is opened with (a test may give its own). */
let panelCursor: CursorTrack = cursor
const player = { time: 7.5, seeks: [] as number[], seek: (t: number) => void player.seeks.push(t), subscribe: () => () => undefined }
const closed: number[] = []
const panel = (start: 'guide' | 'demo' | 'bug' = 'guide'): unknown => ({ type: GuidePanel, props: { project: store.state, cursor: panelCursor, start, onClose: () => closed.push(1), onNotice: () => undefined } })
const said = (els: El[]): string => textOf(byTestId(els, 'guide-said'))
const click = (el: El | undefined): unknown => (el!.props.onClick as () => unknown)()

/** Lets a run's answers arrive, then renders the panel with the project as it now is. */
async function after(): Promise<El[]> {
  await settle(panel())
  return render(panel())
}

/** Renders until the faked screenshots arrive (made after the plans stay still for 250 ms). */
async function ready(start: 'guide' | 'demo' | 'bug' = 'guide'): Promise<El[]> {
  await settle(panel(start))
  await new Promise((r) => setTimeout(r, 300))
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return settle(panel(start))
}

// Renderer code, by a path held in a constant as PANEL is, so the Node typecheck of tests/ does not follow it.
const COST_CONFIRM = '../src/renderer/src/ai/costConfirm'
const USE_COST = '../src/renderer/src/ai/useCost'
const { resetAskedCosts } = (await import(/* @vite-ignore */ COST_CONFIRM)) as { resetAskedCosts: () => void }
const { refreshCostData } = (await import(/* @vite-ignore */ USE_COST)) as { refreshCostData: () => Promise<void> }

beforeEach(() => {
  unmountAll()
  for (const list of Object.values(calls)) list.length = 0
  costAnswer = true
  stillsFail = null
  providerModel = 'gpt-x'
  resetAskedCosts()
  prefs.clear()
  clickListeners = []
  closed.length = 0
  player.seeks.length = 0
  answer = (items) => items.map((i) => ({ id: i.id, name: `AI ${i.id}` }))
  store = testStore(project())
  panelCursor = cursor
  contexts.editor = { store, player }
  contexts.group = { select: () => undefined, command: () => undefined, notice: () => undefined, keys: new Set(), single: null, group: { keys: [] } }
})

describe('the panel', () => {
  it('lists a row per step, named by its number, time and chips, with its screenshot', async () => {
    const els = await ready()
    const rows = allByTestId(els, 'guide-step')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.props['aria-label'])).toEqual(['Step 1, 0:03', 'Step 2, 0:12, needs a title', 'Step 3, 0:25, needs a title'])
    expect(allByTestId(els, 'guide-step-title').map((e) => e.props.value)).toEqual(['Click “Export”', 'Click near the top right', 'Click near the bottom left'])
    expect(allByTestId(els, 'guide-shot').every((e) => e.props.disabled === false)).toBe(true)
    expect(textOf(byTestId(els, 'guide-count'))).toBe('3 steps · 2 need a title')
  })

  it('Esc closes it', async () => {
    const els = await ready()
    const e = { key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined }
    ;(byTestId(els, 'guide-panel')!.props.onKeyDown as (e: unknown) => void)(e)
    expect(closed).toEqual([1])
  })

  it('Go to moves the playhead to the step’s shot time; a title edit is one step merged by its key', async () => {
    let els = await ready()
    click(allByTestId(els, 'guide-goto')[1])
    expect(player.seeks).toEqual([12 - 1 / 60])
    const title = allByTestId(els, 'guide-step-title')[1]
    ;(title.props.onChange as (e: unknown) => void)({ target: { value: 'Open s' } })
    els = render(panel())
    ;(allByTestId(els, 'guide-step-title')[1].props.onChange as (e: unknown) => void)({ target: { value: 'Open settings' } })
    expect(store.steps).toBe(1)
    expect(store.updates.map((u) => u.key)).toEqual(['guide-title:c12000', 'guide-title:c12000'])
    expect(store.state.guide!.steps).toEqual([{ key: 'c12000', title: 'Open settings' }])
  })
})

describe('typing no listed step holds (docs/design/smart-tools.md §5.5.7)', () => {
  it('the click and its typing cut from the video: the Log in shot is marked, and Blur the typed text blurs from the typing’s start', async () => {
    panelCursor = {
      ...cursor,
      clicks: [
        { t: 2, x: 0.4, y: 0.6, button: 'left' },
        { t: 8, x: 0.45, y: 0.6, button: 'left' }
      ],
      typing: [{ t: 2.5, end: 6 }]
    }
    store = testStore({
      ...project(),
      clips: [
        { id: 'a', start: 0, end: 1.5, speed: 1 },
        { id: 'b', start: 7, end: 40, speed: 1 }
      ]
    })
    contexts.editor = { store, player }
    let els = await ready()
    const row = allByTestId(els, 'guide-step')[0]
    expect(row.props['data-step']).toBe('c8000')
    expect(row.props['aria-label']).toMatch(/, may show what you typed$/)
    expect(textOf(byTestId(els, 'guide-count'))).toContain('1 may show typing')
    click(byTestId(els, 'guide-blur-typed'))
    els = render(panel())
    expect(said(els)).toBe('Blurred the typed text.')
    const blur = store.state.shapes!.at(-1)!
    expect([blur.kind, blur.start]).toEqual(['blur', 2.5])
    expect(blur.end).toBeGreaterThan(8)
  })
})

describe('the click-through demo’s own shots (docs/design/smart-tools.md §5.5.6, §5.5.7, §12 rule 2)', () => {
  it('the rows, the marks, Check screenshots and the question before a Save are about the whole-screen shots the demo saves', async () => {
    // Typing into a field at the top right, then a click at the bottom left: the guide's zoomed shot
    // of step 2 does not show the field; the demo's whole screen does.
    panelCursor = {
      ...cursor,
      clicks: [
        { t: 3, x: 0.9, y: 0.1, button: 'left' },
        { t: 8, x: 0.1, y: 0.9, button: 'left' }
      ],
      typing: [{ t: 3.5, end: 5 }]
    }
    let els = await ready()
    expect(allByTestId(els, 'guide-step')[1].props['aria-label']).toBe('Step 2, 0:08, needs a title')
    // Every zoomed guide shot seen at 100%.
    click(byTestId(els, 'guide-check'))
    els = await settle(panel())
    expect(byTestId(els, 'guide-viewer-image')!.props.width).toBe(950)
    click(byTestId(els, 'guide-viewer-next'))
    els = await settle(panel())
    expect(textOf(byTestId(els, 'guide-checked'))).toBe('Checked 2 of 2')
    // Back to the first before closing (this harness keeps a closed viewer's place for the next one).
    click(byTestId(els, 'guide-viewer-prev'))
    els = await settle(panel())
    click(byTestId(els, 'guide-viewer-close'))
    // The demo saves the whole screen: step 2 may show the typing, and nothing of it was checked.
    const demo = els.filter((e) => e.type === 'input' && String(e.props.name).endsWith('-format'))[3]
    ;(demo.props.onChange as () => void)()
    els = render(panel())
    // The progress is the demo's shots', which the rows now wait on.
    expect(els.find((e) => e.props.role === 'progressbar')!.props['aria-valuetext']).toBe('0 of 2')
    expect(allByTestId(els, 'guide-shot').every((e) => e.props.disabled === true)).toBe(true)
    els = await ready()
    expect(els.find((e) => e.props.role === 'progressbar')!.props['aria-valuetext']).toBe('2 of 2')
    expect(allByTestId(els, 'guide-step')[1].props['aria-label']).toBe('Step 2, 0:08, needs a title, may show what you typed in step 1, whole screen')
    expect(allByTestId(els, 'guide-blur-typed')).toHaveLength(1)
    expect(textOf(byTestId(els, 'guide-count'))).toContain('1 may show typing')
    click(byTestId(els, 'guide-save'))
    els = render(panel())
    expect(textOf(byTestId(els, 'guide-question'))).toContain('2 screenshots have not been checked at full size. 1 may show what you typed; 2 show the whole screen. Check them now?')
    click(byTestId(els, 'guide-check-now'))
    els = await settle(panel())
    // Check now opens on the demo's own picture of step 2 (it may show typing), 1600 px wide.
    expect(textOf(els.find((e) => e.props.id === 'guide-viewer-title'))).toBe('Screenshot for step 2 of 2')
    expect(byTestId(els, 'guide-viewer-image')!.props.width).toBe(1600)
    expect(calls.saved).toEqual([])
  })
})

describe('the demo’s end screen (docs/design/smart-tools.md §6.1)', () => {
  it('a link typed before the heading is saved with the heading', async () => {
    const type = (els: El[], id: string, value: string): void => (byTestId(els, id)!.props.onChange as (e: unknown) => void)({ target: { value } })
    let els = await settle(panel('demo'))
    click(byTestId(els, 'guide-end-toggle'))
    els = render(panel('demo'))
    type(els, 'guide-end-url', 'https://example.com/signup')
    els = render(panel('demo'))
    expect(byTestId(els, 'guide-end-url')!.props.value).toBe('https://example.com/signup')
    // No heading yet: no end screen.
    expect(store.state.guide?.end).toBeUndefined()
    type(els, 'guide-end-heading', 'You are ready')
    els = render(panel('demo'))
    type(els, 'guide-end-label', 'Sign up')
    expect(store.state.guide!.end).toEqual({ heading: 'You are ready', label: 'Sign up', url: 'https://example.com/signup' })
  })
})

describe('the bug report’s Actual screenshot (docs/design/smart-tools.md §2.1, §12 rule 2)', () => {
  it('is shown under Actual, counted by the question before a Save and walked first by Check screenshots, as a whole-screen shot', async () => {
    store = testStore({ ...project(), guide: { kind: 'bug', actualAt: 20 } })
    contexts.editor = { store, player }
    let els = await ready('bug')
    const thumb = byTestId(els, 'guide-actual-shot')!
    expect(thumb.props.disabled).toBe(false)
    expect(thumb.props['aria-label']).toBe('View the Actual screenshot full size, whole screen')
    click(byTestId(els, 'guide-save'))
    els = render(panel('bug'))
    expect(textOf(byTestId(els, 'guide-question'))).toContain('4 screenshots have not been checked at full size. 1 shows the whole screen. Check them now?')
    click(byTestId(els, 'guide-check-now'))
    els = await settle(panel('bug'))
    expect(textOf(els.find((e) => e.props.id === 'guide-viewer-title'))).toBe('The Actual screenshot')
    expect(byTestId(els, 'guide-viewer-image')!.props.width).toBe(1600)
    expect(textOf(byTestId(els, 'guide-checked'))).toBe('Checked 1 of 4')
    // Blur an area… on it: a blur box covering the Actual's frame.
    click(byTestId(els, 'guide-viewer-blur'))
    els = render(panel('bug'))
    expect(byTestId(els, 'guide-viewer')).toBeUndefined()
    const blur = store.state.shapes!.at(-1)!
    expect(blur.kind).toBe('blur')
    expect(blur.start).toBeCloseTo(20 - 1 / 60, 6)
    expect(calls.saved).toEqual([])
  })
})

describe('saving before the screenshots are made (docs/design/smart-tools.md §5.5.6)', () => {
  /** Lets a Save run to its end. */
  const saved = async (): Promise<El[]> => {
    for (let i = 0; i < 50 && !calls.saved.length; i++) await after()
    return after()
  }
  /** The panel with its guide shots made, then the demo chosen (its own shots not made yet: they wait 250 ms). */
  const demoChosen = async (): Promise<El[]> => {
    const els = await ready()
    const demo = els.filter((e) => e.type === 'input' && String(e.props.name).endsWith('-format'))[3]
    ;(demo.props.onChange as () => void)()
    return render(panel())
  }

  it('Save demo… straight after choosing the demo makes its whole-screen shots, so no step is saved without its picture', async () => {
    let els = await demoChosen()
    click(byTestId(els, 'guide-save'))
    els = render(panel())
    click(byTestId(els, 'guide-save-anyway'))
    els = await saved()
    expect(calls.saved).toHaveLength(1)
    expect(calls.saved[0]).toMatchObject({ format: 'demo' })
    const widths = [...String(calls.saved[0].html).matchAll(/<img src="data:image\/webp;base64,[^"]*" alt="[^"]*" width="(\d+)"/g)].map((m) => m[1])
    expect(widths).toEqual(['1600', '1600', '1600'])
    expect(said(els)).toBe('Saved “Secret demo.pdf”.')
  })

  it('shots that cannot be made: the guide is saved without them and says how many and why', async () => {
    let els = await demoChosen()
    stillsFail = 'The video could not be read.'
    click(byTestId(els, 'guide-save'))
    els = render(panel())
    click(byTestId(els, 'guide-save-anyway'))
    els = await saved()
    expect(calls.saved).toHaveLength(1)
    expect(String(calls.saved[0].html)).not.toContain('<img src=')
    expect(said(els)).toBe('Saved “Secret demo.pdf”. 3 screenshots could not be made: The video could not be read.')
  })
})

describe('the screen read (docs/design/smart-tools.md §7.1)', () => {
  it('asks for the scan with the crop Find chapters, Short clips and Polish send, so all four share the one kept scan', async () => {
    // A crop that is not on whole pixels: main keys its kept scans by the crop's filter, so the raw
    // fractions would read the screen a second time.
    store = testStore({ ...project(), crop: { x: 0.10001, y: 0.05003, w: 0.80007, h: 0.9 } })
    contexts.editor = { store, player }
    await ready()
    expect(calls.scenes.length).toBeGreaterThan(0)
    for (const call of calls.scenes) expect(call).toEqual({ id: 'p', crop: cropOf(store.state) })
    expect(cropOf(store.state)).not.toEqual(store.state.crop)
    // A crop that snaps to the whole frame reads the whole picture, as the others do.
    calls.scenes.length = 0
    unmountAll()
    store = testStore({ ...project(), crop: { x: 0, y: 0, w: 1, h: 1 } })
    contexts.editor = { store, player }
    await ready()
    expect(calls.scenes.length).toBeGreaterThan(0)
    for (const call of calls.scenes) expect(call.crop).toBeNull()
  })
})

describe('test 112: Adjust from the panel', () => {
  it('Done stores the crop and the ring in one update; Reset removes them in one more', async () => {
    let els = await ready()
    click(allByTestId(els, 'guide-shot')[0])
    // Adjust waits for its picture of the whole frame (the zoomed shot is 950 px of the 1920).
    els = await ready()
    click(byTestId(els, 'guide-viewer-adjust'))
    els = render(panel())
    const whole = els.find((e) => e.type === 'img' && e.props.alt === 'The whole screen for step 1')!
    expect([whole.props.width, whole.props.height]).toEqual([1600, 900])
    const before = store.steps
    const ringKey = { key: 'ArrowRight', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => undefined, stopPropagation: () => undefined }
    ;(byTestId(els, 'guide-adjust-ring')!.props.onKeyDown as (e: unknown) => void)(ringKey)
    els = render(panel())
    click(byTestId(els, 'guide-adjust-done'))
    els = render(panel())
    expect(store.steps - before).toBe(1)
    const edit = store.state.guide!.steps![0]
    expect(edit.key).toBe('c3000')
    expect(edit.ring).toEqual({ x: 0.6, y: 0.5 })
    expect(edit.rect!.w).toBeGreaterThanOrEqual(0.05)
    expect(said(els)).toBe('Adjusted the screenshot.')
    // The viewer stays on the step while its shot is made again.
    expect(textOf(els.find((e) => e.props.id === 'guide-viewer-title'))).toBe('Screenshot for step 1 of 3')
    expect(byTestId(els, 'guide-viewer-image')).toBeUndefined()
    els = await ready()
    expect(byTestId(els, 'guide-viewer-image')).toBeDefined()
    click(byTestId(els, 'guide-viewer-adjust'))
    els = render(panel())
    click(byTestId(els, 'guide-adjust-reset'))
    expect(store.steps - before).toBe(2)
    expect(store.state.guide).toBeUndefined()
  })

  it('with a crop, Adjust draws over the whole shown part and Done stores fractions of the recorded frame', async () => {
    // The video shows the right half of the recording; step 1's click is on its left edge.
    store = testStore({ ...project(), crop: { x: 0.5, y: 0, w: 0.5, h: 1 } })
    contexts.editor = { store, player }
    let els = await ready()
    click(allByTestId(els, 'guide-shot')[0])
    els = await ready()
    click(byTestId(els, 'guide-viewer-adjust'))
    els = render(panel())
    const whole = els.find((e) => e.type === 'img' && e.props.alt === 'The whole screen for step 1')!
    expect([whole.props.width, whole.props.height]).toEqual([960, 1080])
    // The zoomed shot (950 px from the crop's left edge) and the ring on the click, over the shown half.
    const crop = byTestId(els, 'guide-adjust-crop')!.props.style as Record<string, string>
    expect([crop.left, crop.width]).toEqual(['0.000%', '98.958%'])
    expect((byTestId(els, 'guide-adjust-ring')!.props.style as Record<string, string>).left).toBe('0.000%')
    const ringKey = { key: 'ArrowRight', shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => undefined, stopPropagation: () => undefined }
    ;(byTestId(els, 'guide-adjust-ring')!.props.onKeyDown as (e: unknown) => void)(ringKey)
    els = render(panel())
    click(byTestId(els, 'guide-adjust-done'))
    const edit = store.state.guide!.steps![0]
    // 10% of the shown half to the right is 5% of the recording.
    expect(edit.ring).toEqual({ x: 0.55, y: 0.5 })
    expect(edit.rect).toEqual({ x: 0.5, y: 0.005208, w: 0.494792, h: 0.989583 })
  })
})

describe('test 107: placeholders and Write titles', () => {
  it('the line counts the steps that need a title; Next step without a title wraps', async () => {
    let els = await ready()
    expect(stepsLine({ steps: 30, hidden: 4, untitled: 12, typed: 3 })).toBe('30 steps · 4 hidden · 12 need a title · 3 may show typing')
    expect(stepsLine({ steps: 1, hidden: 0, untitled: 1, typed: 0 })).toBe('1 step · 1 needs a title')
    click(byTestId(els, 'guide-next-untitled'))
    els = render(panel())
    expect(said(els)).toBe('Step 2 needs a title')
    click(byTestId(els, 'guide-next-untitled'))
    els = render(panel())
    expect(said(els)).toBe('Step 3 needs a title')
    click(byTestId(els, 'guide-next-untitled'))
    els = render(panel())
    expect(said(els)).toBe('Step 2 needs a title')
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.focused.at(-1)).toMatch(/-title-c12000$/)
    expect(nextUntitled(['a', 'b', 'c'], new Set(['a']), 'c')).toBe('a')
    expect(nextUntitled(['a'], new Set(), null)).toBeNull()
  })

  it('Write titles is disabled with "Nothing was said near these steps." when no step has words', async () => {
    store = testStore(project(false))
    contexts.editor = { store, player }
    let els = await ready()
    ;(byTestId(els, 'guide-titles-ai')!.props.onChange as () => void)()
    els = await settle(panel())
    const write = byTestId(els, 'guide-write-titles')!
    expect(write.props.disabled).toBe(true)
    const why = byTestId(els, 'guide-write-why')!
    expect(textOf(why)).toBe('Nothing was said near these steps.')
    expect(write.props['aria-describedby']).toBe(why.props.id)
  })

  it('a run sends only the steps with words, writes their titles in one update with `ai`; the others keep their offline titles', async () => {
    let els = await ready()
    ;(byTestId(els, 'guide-titles-ai')!.props.onChange as () => void)()
    els = await settle(panel())
    expect(byTestId(els, 'guide-write-titles')!.props.disabled).toBe(false)
    const before = store.steps
    click(byTestId(els, 'guide-write-titles'))
    els = await after()
    expect(calls.aiText).toHaveLength(1)
    const sent = calls.aiText[0]
    expect(sent.id).toBe('o1')
    expect(sent.request.task).toBe('names')
    expect(sent.request.names!.kind).toBe('step')
    expect(sent.request.names!.items.map((i) => i.id)).toEqual(['c3000'])
    expect(sent.requestId).toMatch(/^guide-titles-/)
    expect(store.steps - before).toBe(1)
    expect(allByTestId(els, 'guide-step-title').map((e) => e.props.value)).toEqual(['AI c3000', 'Click near the top right', 'Click near the bottom left'])
    expect(store.state.guide!.steps).toEqual([{ key: 'c3000', title: 'AI c3000', ai: 'openai' }])
    expect(allByTestId(els, 'guide-step')[0].props['aria-label']).toBe('Step 1, 0:03, written by AI')
    expect(said(els)).toBe('Wrote 1 title with OpenAI.')
    // Use offline titles: one update.
    click(byTestId(els, 'guide-offline-titles'))
    expect(store.state.guide).toBeUndefined()
  })
})

describe('the question before a run is asked once (smart-tools.md §11.5)', () => {
  /** A user's click as the page sees it: the document's listeners first (the cost line may hold it), then the button's own handler. */
  const userClick = (el: El): void => {
    const b = {
      id: el.props.id as string,
      isConnected: true,
      getAttribute: (n: string) => (n === 'aria-describedby' ? ((el.props['aria-describedby'] as string | undefined) ?? null) : null),
      closest: (sel: string) => (sel === 'button' ? b : null),
      click: () => (el.props.onClick as () => unknown)()
    }
    const e = { target: b, held: false, preventDefault: () => (e.held = true), stopImmediatePropagation: () => (e.held = true) }
    for (const l of [...clickListeners]) l(e)
    if (!e.held) (el.props.onClick as () => unknown)()
  }
  /** Lets the question, the run and its answer arrive. */
  const landed = async (): Promise<El[]> => {
    await after()
    await new Promise((r) => setTimeout(r, 0))
    return after()
  }
  /** The panel with the AI chosen for titles. */
  const withAiTitles = async (): Promise<El[]> => {
    await refreshCostData()
    const els = await ready()
    ;(byTestId(els, 'guide-titles-ai')!.props.onChange as () => void)()
    return settle(panel())
  }

  it('a model without a price: asked once for the provider and model; Cancel sends nothing, Run runs once', async () => {
    let els = await withAiTitles()
    expect(clickListeners.length).toBeGreaterThan(0)
    costAnswer = false
    userClick(byTestId(els, 'guide-write-titles')!)
    els = await landed()
    expect(calls.asked).toEqual(['Flown does not know what this costs with gpt-x. Run it?'])
    expect(calls.aiText).toHaveLength(0)
    expect(store.state.guide).toBeUndefined()
    costAnswer = true
    userClick(byTestId(els, 'guide-write-titles')!)
    els = await landed()
    expect(calls.asked).toHaveLength(2)
    expect(calls.aiText).toHaveLength(1)
    // The same provider and model again this session: not asked.
    userClick(byTestId(els, 'guide-tidy')!)
    await landed()
    expect(calls.asked).toHaveLength(2)
    expect(calls.aiText).toHaveLength(2)
  })

  it('Always ask with a priced model: Write titles and Tidy notes each ask one question, then run once', async () => {
    providerModel = 'gpt-6.1-sol'
    prefs.set('aiConfirm', 'always')
    let els = await withAiTitles()
    // Each button reads its own cost sentence, the one its cost line holds clicks by.
    for (const [testId, key] of [['guide-write-titles', 'titles'], ['guide-tidy', 'notes']] as const) {
      const button = byTestId(els, testId)!
      const sentence = els.find((e) => e.props.id === button.props['aria-describedby'])
      expect(sentence?.props.id, testId).toMatch(new RegExp(`-${key}-cost-${key}$`))
      expect(textOf(sentence), testId).toMatch(/US\$[\d.]+; sends the steps' narration to \S+\.$/)
    }
    userClick(byTestId(els, 'guide-write-titles')!)
    els = await landed()
    expect(calls.asked).toHaveLength(1)
    expect(calls.asked[0]).toMatch(/with gpt-6\.1-sol\. Run it\?$/)
    expect(calls.aiText).toHaveLength(1)
    userClick(byTestId(els, 'guide-tidy')!)
    await landed()
    expect(calls.asked).toHaveLength(2)
    expect(calls.aiText).toHaveLength(2)
    prefs.clear()
    await refreshCostData()
  })
})

describe('test 108: notes', () => {
  it('Use everything I said sets full', async () => {
    const els = await ready()
    click(allByTestId(els, 'guide-full')[0])
    expect(store.state.guide!.steps).toEqual([{ key: 'c3000', full: true }])
  })

  it('Tidy notes sends kind note with each step’s full words and title, writes textAi; a hand edit clears it', async () => {
    let els = await ready()
    click(byTestId(els, 'guide-tidy'))
    els = await after()
    expect(calls.aiText).toHaveLength(1)
    const names = calls.aiText[0].request.names!
    expect(names.kind).toBe('note')
    expect(names.items).toEqual([{ id: 'c3000', text: 'Now click the Export button', action: 'Click “Export”' }])
    expect(store.state.guide!.steps).toEqual([{ key: 'c3000', text: 'AI c3000', textAi: 'openai' }])
    const note = allByTestId(els, 'guide-step-note')[0]
    expect(note.props.value).toBe('AI c3000')
    ;(note.props.onChange as (e: unknown) => void)({ target: { value: 'Mine.' } })
    expect(store.state.guide!.steps).toEqual([{ key: 'c3000', text: 'Mine.' }])
  })
})

describe('test 110: Copy guide (renderer)', () => {
  it('asks first about unchecked screenshots, then copies HTML with one PNG at most 1200 px wide a step and the numbered titles', async () => {
    let els = await ready()
    click(byTestId(els, 'guide-copy'))
    els = render(panel())
    const q = byTestId(els, 'guide-question')!
    expect(textOf(q)).toContain('3 screenshots have not been checked at full size. Check them now?')
    click(byTestId(els, 'guide-save-anyway'))
    els = await after()
    expect(calls.copied).toHaveLength(1)
    const { html, text } = calls.copied[0]
    expect((html.match(/<img src="data:image\/png;base64,/g) ?? []).length).toBe(3)
    for (const w of html.matchAll(/width="(\d+)"/g)) expect(Number(w[1])).toBeLessThanOrEqual(1200)
    expect(calls.encoded.every((e) => e.mime === 'image/png' && e.maxWidth === 1200)).toBe(true)
    expect(html).not.toContain('<script')
    expect(text).toContain('1. Click “Export”\n')
    expect(text).toContain('2. Click near the top right\n')
    expect(said(els)).toBe('Copied the guide with 3 screenshots.')
    // The question is asked once a session.
    click(byTestId(els, 'guide-copy'))
    els = await after()
    expect(byTestId(els, 'guide-question')).toBeUndefined()
    expect(calls.copied).toHaveLength(2)
  })

  it('the question before a Save is a modal dialog: Tab stays in it, Esc closes it and the focus goes back (useModalFocus)', async () => {
    let els = await ready()
    click(byTestId(els, 'guide-save'))
    els = render(panel())
    const q = byTestId(els, 'guide-question')!
    expect(q.props.role).toBe('alertdialog')
    // The dialog box itself is the one useModalFocus keeps Tab in and closes on Esc.
    const close = modals.get(q.ref)
    expect(close).toBeTypeOf('function')
    close!()
    els = await after()
    expect(byTestId(els, 'guide-question')).toBeUndefined()
    expect(calls.saved).toEqual([])
  })

  it('Save anyway on the check question opens the link question as a new dialog (it opens on Go back)', async () => {
    store.update((p) => ({ ...p, guide: { steps: [{ key: 'c3000', title: 'Open example.com' }] } }))
    let els = await ready()
    click(byTestId(els, 'guide-save'))
    const keyOf = (): unknown => (render(panel(), ['GuideQuestion']).find((e) => typeof e.type === 'function' && (e.type as { name: string }).name === 'GuideQuestion') as { key?: unknown } | undefined)?.key
    const first = keyOf()
    els = render(panel())
    click(byTestId(els, 'guide-save-anyway'))
    els = render(panel())
    expect(textOf(byTestId(els, 'guide-question'))).toContain('This guide has a link, address or file name nobody said. Save anyway?')
    // React mounts a dialog with another key afresh: its own button, Go back, takes the focus.
    expect(keyOf()).not.toBe(first)
    expect(calls.saved).toEqual([])
  })

  it('a title with a link nobody said asks before saving: Go back sends nothing', async () => {
    store.update((p) => ({ ...p, guide: { steps: [{ key: 'c3000', title: 'Open example.com' }] } }))
    let els = await ready()
    click(byTestId(els, 'guide-save'))
    els = render(panel())
    click(byTestId(els, 'guide-save-anyway'))
    els = render(panel())
    expect(textOf(byTestId(els, 'guide-question'))).toContain('This guide has a link, address or file name nobody said. Save anyway?')
    click(byTestId(els, 'guide-go-back'))
    els = await after()
    expect(calls.saved).toEqual([])
    click(byTestId(els, 'guide-save'))
    els = render(panel())
    click(byTestId(els, 'guide-link-anyway'))
    await after()
    expect(calls.saved).toHaveLength(1)
    expect(calls.saved[0]).toMatchObject({ format: 'pdf', name: 'Secret guide' })
    // The PDF embeds the bundled Hind Siliguri, 400 and 600 (owner decision 7).
    expect(calls.fonts).toEqual(['/resources/fonts/hind-siliguri-400.woff2', '/resources/fonts/hind-siliguri-600.woff2'])
    expect((String(calls.saved[0].html).match(/@font-face/g) ?? []).length).toBe(2)
  })
})

describe('the helpers', () => {
  it('the check question counts unchecked, typing and whole-screen shots', () => {
    expect(checkQuestion({ unchecked: 18, typed: 3, whole: 5 })).toBe('18 screenshots have not been checked at full size. 3 may show what you typed; 5 show the whole screen. Check them now?')
    expect(checkQuestion({ unchecked: 0, typed: 0, whole: 0 })).toBeNull()
  })

  it('Check screenshots walks typing steps first, then whole-screen shots, then the rest', () => {
    expect(checkOrder(['a', 'b', 'c', 'd'], new Set(['c']), new Set(['b', 'c']))).toEqual(['c', 'b', 'a', 'd'])
  })

  it('A4 unless the region is the US, Canada, Mexico or the Philippines', () => {
    expect(defaultPage('en-GB')).toBe('A4')
    expect(defaultPage('bn-BD')).toBe('A4')
    for (const l of ['en-US', 'fr-CA', 'es-MX', 'fil-PH']) expect(defaultPage(l)).toBe('Letter')
  })
})

describe('contrast of the panel’s chips (WCAG AA)', () => {
  type RGB = [number, number, number]
  const css = (file: string): string => readFileSync(path.join(__dirname, '../src/renderer/src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const vars: Record<string, string> = {}
  for (const m of css('styles.css').matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] ??= m[2].trim()
  const resolve = (v: string): RGB => {
    const ref = /^var\((--[\w-]+)\)$/.exec(v)
    if (ref) return resolve(vars[ref[1]])
    return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB
  }
  const lum = (c: RGB): number => {
    const [r, g, b] = c.map((x) => (x / 255 <= 0.03928 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: RGB, b: RGB): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  const decl = (selector: string, prop: string): string => {
    let value = ''
    for (const m of css('guide/guide.css').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!m[1].split(',').some((s) => s.trim() === selector)) continue
      for (const d of m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))) value = d[1].trim()
    }
    return value
  }

  it('the chips’ words read at 4.5:1 on their fill', () => {
    expect(contrast(resolve(decl('.guide-chip', 'color')), resolve(decl('.guide-chip', 'background')))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(resolve(decl('.guide-chip.warn', 'color')), resolve(decl('.guide-chip.warn', 'background')))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(resolve(decl('.guide-count', 'color')), resolve('var(--surface-1)'))).toBeGreaterThanOrEqual(4.5)
  })
})
