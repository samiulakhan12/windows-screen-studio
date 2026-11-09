import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import { byTestId, contexts, descendants, key, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The colour controls of the Effects and Camera tabs (docs/design/editing-polish.md §2.5, §12;
 * §19.1 test 82) without a DOM (tests/studioHarness.ts): the screen offers None, Natural, Vivid and
 * Mono only, with Mono's hint; the camera all eight looks; the sliders' value texts and keys (Home
 * and End the ends, Page Up 10, Delete back to 0), each Reset, announced; a LUT imported through
 * main's pick; Compare; Auto colour; the note without WebGL2. Each change is one store update.
 */

const picks: unknown[] = []
let pickAnswer: () => Promise<unknown> = async () => null
vi.stubGlobal('document', { activeElement: null, body: {}, createElement: () => ({ getContext: () => null }) })
vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout: () => 0,
  api: {
    pickAsset: (id: string, kind: string) => {
      picks.push([id, kind])
      return pickAnswer()
    }
  }
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SCREEN = '../src/renderer/src/editor/panels/ScreenColourSection'
const CAMERA = '../src/renderer/src/editor/panels/CameraColourSection'
const LAYER = '../src/renderer/src/render/gradeLayer'
const { ScreenColourSection } = (await import(/* @vite-ignore */ SCREEN)) as { ScreenColourSection: (p: unknown) => unknown }
const { CameraColourSection } = (await import(/* @vite-ignore */ CAMERA)) as { CameraColourSection: (p: unknown) => unknown }
const { forceGradeBackend } = (await import(/* @vite-ignore */ LAYER)) as { forceGradeBackend(b: 'gl' | 'cpu' | null): void }
await useEditorContexts()
const { DEFAULT_KEYMAP } = await import('../src/shared/editor/shortcuts')
const { createProject } = await import('../src/shared/engine/project')

function project(over: Partial<Project> = {}): Project {
  const p = createProject({ id: 'rec-colour', name: 'p', duration: 20, width: 1920, height: 1080, hasWebcam: true, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } })
  return { ...p, ...over }
}

const notices: string[] = []
const commands: string[] = []
let store: ReturnType<typeof testStore<Project>>
/** The preview: Compare is its own (never saved). */
const player = { time: 0, comparing: false, setCompare: (on: boolean) => void (player.comparing = on), subscribe: () => () => undefined, getPlaying: () => false, screen: null, webcam: null }

beforeEach(() => {
  unmountAll()
  notices.length = 0
  commands.length = 0
  picks.length = 0
  pickAnswer = async () => null
  player.comparing = false
  forceGradeBackend(null)
  store = testStore(project())
  contexts.editor = { store, player }
  contexts.group = { group: { keys: [], anchor: null, stamp: 0 }, keys: new Set(), single: null, select: () => undefined, notice: (m: string) => notices.push(m), command: (id: string) => commands.push(id) }
  contexts.keymap = DEFAULT_KEYMAP
})

const screen = (): Promise<El[]> => settle({ type: ScreenColourSection, props: { project: store.state } })
const camera = (): Promise<El[]> => settle({ type: CameraColourSection, props: { project: store.state } })
const click = (el: El): void => (el.props.onClick as () => void)()
const press = (el: El, k: string): ReturnType<typeof key> => {
  const e = key(k)
  ;(el.props.onKeyDown as (e: unknown) => void)(e)
  return e
}
const status = (els: El[]): string => textOf(els.find((e) => e.props.role === 'status')!).trim()
const chips = (els: El[]): El[] => descendants(byTestId(els, 'colour-look')!).filter((e) => e.props.role === 'radio')

describe('the colour controls (test 82)', () => {
  it('the screen offers None, Natural, Vivid and Mono only, Mono with its hint', async () => {
    const els = await screen()
    expect(byTestId(els, 'screen-colour-section')).toBeDefined()
    const looks = chips(els)
    expect(looks.map((c) => c.props['data-look'])).toEqual(['none', 'natural', 'vivid', 'mono'])
    expect(looks.map((c) => textOf(c).trim())).toEqual(['None', 'Natural', 'Vivid', 'Mono'])
    expect(looks.map((c) => c.props['aria-checked'])).toEqual([true, false, false, false])
    const mono = looks[3]
    const hint = els.find((e) => e.props.id === mono.props['aria-describedby'])!
    expect(textOf(hint)).toBe('Coloured text may become harder to read.')
    expect(mono.props.title).toBe('Coloured text may become harder to read.')
    // Picking a look is one update; the arrow keys move through the group.
    click(mono)
    expect(store.state.grade).toEqual({ screen: { look: 'mono' } })
    expect(store.steps).toBe(1)
    unmountAll()
    const again = await screen()
    expect(chips(again)[3].props['aria-checked']).toBe(true)
    expect(chips(again)[3].props.tabIndex).toBe(0)
    // The group keeps its keys from the editor's step keys on the window (which would also move the
    // playhead, or nudge the selected items).
    expect(press(byTestId(again, 'colour-look')!, 'ArrowLeft')).toMatchObject({ prevented: true, stopped: true })
    expect(store.state.grade).toEqual({ screen: { look: 'vivid' } })
    expect(store.steps).toBe(2)
    unmountAll()
    expect(press(byTestId(await screen(), 'colour-look')!, 'End')).toMatchObject({ prevented: true, stopped: true })
    expect(store.state.grade).toEqual({ screen: { look: 'mono' } })
    unmountAll()
    expect(press(byTestId(await screen(), 'colour-look')!, 'Home')).toMatchObject({ prevented: true, stopped: true })
    expect(store.state.grade).toBeUndefined()
    expect(store.steps).toBe(4)
    // Other keys, and Ctrl or Alt with an arrow, stay the editor's.
    unmountAll()
    const look = byTestId(await screen(), 'colour-look')!
    for (const e of [key('ArrowRight', { ctrlKey: true }), key('ArrowLeft', { altKey: true }), key(' ')]) {
      ;(look.props.onKeyDown as (e: unknown) => void)(e)
      expect(e).toMatchObject({ prevented: false, stopped: false })
    }
    expect(store.steps).toBe(4)
    // No exposure on the screen.
    unmountAll()
    const more = await screen()
    click(byTestId(more, 'colour-more')!)
    const open = await screen()
    expect(byTestId(open, 'colour-slider-highlights')).toBeDefined()
    expect(byTestId(open, 'colour-slider-exposure')).toBeUndefined()
  })

  it('the camera offers every look, Exposure, and Auto colour', async () => {
    let els = await camera()
    expect(byTestId(els, 'camera-colour-section')).toBeDefined()
    expect(chips(els).map((c) => c.props['data-look'])).toEqual(['none', 'natural', 'warm', 'cool', 'vivid', 'soft', 'cinematic', 'mono', 'vintage'])
    click(byTestId(els, 'colour-more')!)
    els = await camera()
    const exposure = byTestId(els, 'colour-slider-exposure')!
    expect(exposure.props.min).toBe(-2)
    expect(exposure.props.max).toBe(2)
    press(exposure, 'PageUp')
    expect(store.state.grade).toEqual({ camera: { exposure: 0.5 } })
    els = await camera()
    expect(byTestId(els, 'colour-slider-exposure')!.props['aria-valuetext']).toBe('+0.5 stops')
    click(byTestId(els, 'auto-colour')!)
    expect(commands).toEqual(['autoColour'])
    expect(textOf(els.find((e) => e.props.id === byTestId(els, 'auto-colour')!.props['aria-describedby'])!)).toBe(
      'Balances the camera’s colour and brightness from a few frames, on this PC. Review mode lists it.'
    )
    // Without a camera, no section.
    store = testStore(project({ hasWebcam: false }))
    contexts.editor = { store, player }
    unmountAll()
    expect(byTestId(await camera(), 'camera-colour-section')).toBeUndefined()
  })

  it('Home and End move a slider to its ends; Page Up by 10; the value text says which way', async () => {
    let els = await screen()
    const temp = (): El => byTestId(els, 'colour-slider-temperature')!
    expect(temp().props['aria-valuetext']).toBe('No change')
    expect(temp().props.min).toBe(-100)
    expect(press(temp(), 'End').prevented).toBe(true)
    expect(store.state.grade).toEqual({ screen: { temperature: 1 } })
    els = await screen()
    expect(temp().props['aria-valuetext']).toBe('Warmer, +100')
    press(temp(), 'Home')
    expect(store.state.grade).toEqual({ screen: { temperature: -1 } })
    els = await screen()
    expect(temp().props['aria-valuetext']).toBe('Cooler, −100')
    press(temp(), 'PageUp')
    expect(store.state.grade!.screen!.temperature).toBeCloseTo(-0.9, 12)
    els = await screen()
    expect(temp().props['aria-valuetext']).toBe('Cooler, −90')
    // Each key is one update (the slider's merge key joins them into one undo step, as a drag).
    expect(store.updates).toHaveLength(3)
    expect(store.updates.every((u) => u.key === 'colour:screen:temperature')).toBe(true)
    // Tint says Greener and More magenta.
    press(byTestId(els, 'colour-slider-tint')!, 'Home')
    els = await screen()
    expect(byTestId(els, 'colour-slider-tint')!.props['aria-valuetext']).toBe('Greener, −100')
  })

  it('Delete and the Reset button set 0, in one update each, and are announced', async () => {
    store = testStore(project({ grade: { screen: { temperature: 0.2, contrast: -0.15 } } }))
    contexts.editor = { store, player }
    let els = await screen()
    expect(byTestId(els, 'colour-slider-contrast')!.props['aria-valuetext']).toBe('−15')
    expect(byTestId(els, 'colour-reset-brightness')).toBeUndefined()
    const reset = byTestId(els, 'colour-reset-temperature')!
    expect(reset.props['aria-label']).toBe('Reset Temperature')
    click(reset)
    expect(store.state.grade).toEqual({ screen: { contrast: -0.15 } })
    expect(store.steps).toBe(1)
    els = await screen()
    expect(status(els)).toBe('Temperature reset')
    expect(byTestId(els, 'colour-reset-temperature')).toBeUndefined()
    // The slider keeps Delete from the editor's own Delete (on the window), which would also remove the selected item.
    expect(press(byTestId(els, 'colour-slider-contrast')!, 'Delete')).toMatchObject({ prevented: true, stopped: true })
    // The last slider back at 0: no grade is left at all.
    expect(store.state.grade).toBeUndefined()
    expect(store.steps).toBe(2)
    els = await screen()
    expect(status(els)).toBe('Contrast reset')
    // At 0 already, Delete and Backspace do nothing, and still never reach the editor.
    expect(press(byTestId(els, 'colour-slider-tint')!, 'Backspace')).toMatchObject({ prevented: true, stopped: true })
    expect(store.steps).toBe(2)
    // Reset colour: everything at once, one update.
    store = testStore(project({ grade: { screen: { look: 'vivid', tint: 0.3 }, camera: { look: 'warm' } } }))
    contexts.editor = { store, player }
    unmountAll()
    els = await screen()
    click(byTestId(els, 'colour-reset')!)
    expect(store.state.grade).toEqual({ camera: { look: 'warm' } })
    expect(store.steps).toBe(1)
    els = await screen()
    expect(status(els)).toBe('Colour reset')
    expect(byTestId(els, 'colour-reset')!.props.disabled).toBe(true)
  })

  it('imports a LUT through main and shows its title and size; a refused file says why', async () => {
    pickAnswer = async () => ({ url: 'studio-media://project/rec-colour/lut-1.cube', path: 'lut-1.cube', name: 'teal.cube', lut: { sha256: 'f'.repeat(64), title: 'Teal ‮x', size: 33 } })
    let els = await screen()
    expect(textOf(byTestId(els, 'lut-import')!)).toBe('Import a LUT (.cube)…')
    click(byTestId(els, 'lut-import')!)
    // Main's answer comes, then the panel shows the project as it is now.
    await screen()
    els = await screen()
    expect(picks).toEqual([['rec-colour', 'lut']])
    expect(store.state.grade).toEqual({ screen: { lut: { file: 'lut-1.cube', sha256: 'f'.repeat(64), title: 'Teal x', size: 33 } } })
    expect(store.steps).toBe(1)
    expect(textOf(byTestId(els, 'lut-title')!)).toBe('Teal x')
    expect(byTestId(els, 'lut-title')!.props.dir).toBe('auto')
    expect(textOf(byTestId(els, 'lut-size')!)).toBe('33 × 33 × 33')
    click(byTestId(els, 'lut-remove')!)
    expect(store.state.grade).toBeUndefined()
    pickAnswer = async () => {
      throw new Error("Error invoking remote method 'projects:pickAsset': Error: This LUT could not be used: line 1,204 has 2 numbers, not 3.")
    }
    els = await screen()
    click(byTestId(els, 'lut-import')!)
    await screen()
    expect(notices).toEqual(['This LUT could not be used: line 1,204 has 2 numbers, not 3.'])
  })

  it('Compare is pressed while the preview shows the original; the note says when the CPU grades', async () => {
    let els = await screen()
    expect(byTestId(els, 'colour-compare')!.props['aria-pressed']).toBe(false)
    click(byTestId(els, 'colour-compare')!)
    expect(player.comparing).toBe(true)
    // Never an edit.
    expect(store.steps).toBe(0)
    els = await screen()
    expect(byTestId(els, 'colour-compare')!.props['aria-pressed']).toBe(true)
    expect(byTestId(els, 'colour-cpu-note')).toBeUndefined()
    forceGradeBackend('cpu')
    unmountAll()
    els = await screen()
    expect(textOf(byTestId(els, 'colour-cpu-note')!)).toBe('This PC grades colour without graphics acceleration, so the preview may play less smoothly. The export looks the same.')
  })
})

describe('Auto colour, the command (test 54, renderer side)', () => {
  const RUN = '../src/renderer/src/editor/autoColourRun'
  type Run = (deps: { project: Project; webcamUrl: string; signal: AbortSignal }) => Promise<unknown>
  const load = async () =>
    (await import(/* @vite-ignore */ RUN)) as {
      startAutoColour(deps: { store: unknown; webcamUrl: string | null; notice: (m: string) => void; run?: Run }): Promise<void>
      autoColourTimes(p: Pick<Project, 'clips' | 'webcamOffset'>, d: number): number[]
      autoColourBusy(): boolean
    }

  it('is one update with its record and notice; says so without a camera or when nothing needs balancing', async () => {
    const { startAutoColour, autoColourBusy } = await load()
    const said: string[] = []
    const run: Run = async () => ({ temperature: -0.3 })
    await startAutoColour({ store, webcamUrl: 'studio-media://project/rec-colour/webcam.mp4', notice: (m) => said.push(m), run })
    expect(store.state.grade).toEqual({ camera: { temperature: -0.3 }, auto: { camera: null } })
    expect(store.steps).toBe(1)
    expect(said).toEqual(['Balancing the camera’s colour…', 'Camera colour balanced · Ctrl + Z to undo'])
    expect(autoColourBusy()).toBe(false)
    said.length = 0
    await startAutoColour({ store, webcamUrl: null, notice: (m) => said.push(m), run })
    expect(said).toEqual(['This recording has no camera'])
    said.length = 0
    await startAutoColour({ store, webcamUrl: 'x', notice: (m) => said.push(m), run: async () => null })
    expect(said).toEqual(['Balancing the camera’s colour…', 'The camera’s colour already looks balanced'])
    expect(store.steps).toBe(1)
  })

  it('samples twelve frames over the kept clips, inside the camera file', async () => {
    const { autoColourTimes } = await load()
    const clips = [
      { id: 'a', start: 0, end: 6, speed: 1 },
      { id: 'b', start: 10, end: 16, speed: 1 }
    ]
    const times = autoColourTimes({ clips, webcamOffset: 0 }, 30)
    expect(times).toHaveLength(12)
    expect(times.every((t) => (t >= 0 && t <= 6) || (t >= 10 && t <= 16))).toBe(true)
    // The camera started 1 s late and ends at 12 s: frames outside it are skipped.
    const late = autoColourTimes({ clips, webcamOffset: 1 }, 12)
    expect(late.every((t) => t >= 0 && t <= 11.95)).toBe(true)
    expect(late.length).toBeLessThan(12)
  })
})
