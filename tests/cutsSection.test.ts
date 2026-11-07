import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip, LayoutSegment, Project, ProjectJoins } from '../src/shared/types'
import { byTestId, contexts, descendants, key, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The Clip tab's Cuts and Cut style sections (docs/design/editing-polish.md §2.1, §12; §19.1 test
 * 23) without a DOM (tests/studioHarness.ts): the count line, Every cut, Smooth all cuts and its
 * notice, Give them the same style, "Cut 5 of 37" with its buttons, the radio group, the Length
 * slider's value text and keys, what Smooth gives a camera-led cut, the flash rule's note, and no
 * Cut style for a trimmed start. Each change is one store update.
 */

vi.stubGlobal('document', { activeElement: null, body: {}, createElement: () => ({ getContext: () => null }) })
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: () => 0 })

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const CUTS = '../src/renderer/src/editor/panels/CutsSection'
const STYLE = '../src/renderer/src/editor/panels/CutStyleSection'
const { CutsSection } = (await import(/* @vite-ignore */ CUTS)) as { CutsSection: (p: unknown) => unknown }
const { CutStyleSection } = (await import(/* @vite-ignore */ STYLE)) as { CutStyleSection: (p: unknown) => unknown }
await useEditorContexts()
const { DEFAULT_KEYMAP } = await import('../src/shared/editor/shortcuts')
const { createProject } = await import('../src/shared/engine/project')

/** 38 clips of 2 s with 1 s cuts: 37 cuts; cut k is before clip c<k>, which starts at 3k. */
const CLIPS: Clip[] = Array.from({ length: 38 }, (_, i) => ({ id: `c${i}`, start: 3 * i, end: 3 * i + 2, speed: 1 }))
const OWN: ProjectJoins = { cuts: [{ clip: 'c3', kind: 'dip' }, { clip: 'c9', kind: 'slide' }, { clip: 'c20', kind: 'cut' }] }

function project(joins?: ProjectJoins, over: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 120, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } })
  return { ...p, clips: CLIPS, ...(joins ? { joins } : {}), ...over }
}

const notices: string[] = []
const commands: string[] = []
let store: ReturnType<typeof testStore<Project>>
const player = { time: 0, subscribe: () => () => undefined, getPlaying: () => false }

beforeEach(() => {
  unmountAll()
  notices.length = 0
  commands.length = 0
  store = testStore(project(OWN))
  contexts.editor = { store, player }
  contexts.group = { group: { keys: [], anchor: null, stamp: 0 }, keys: new Set(), single: null, select: () => undefined, notice: (m: string) => notices.push(m), command: (id: string) => commands.push(id) }
  contexts.keymap = DEFAULT_KEYMAP
})

const cuts = (): Promise<El[]> => settle({ type: CutsSection, props: { project: store.state } })
const style = (gap: { start: number; end: number }): Promise<El[]> => settle({ type: CutStyleSection, props: { project: store.state, gap } })
const click = (el: El): void => (el.props.onClick as () => void)()
/** The radio of `kind` in the Cut style group. */
const radio = (els: El[], kind: string): El => descendants(els.find((e) => e.props['data-kind'] === kind)!).find((e) => e.type === 'input')!

describe('the Cuts section (test 23)', () => {
  it('counts the cuts and smooths them all in one update, with its notice', async () => {
    let els = await cuts()
    expect(textOf(byTestId(els, 'cuts-section'))).toContain('37 cuts. A cut jumps from one moment of the recording to the next.')
    expect(byTestId(els, 'cut-every')!.props.value).toBe('cut')
    const smooth = byTestId(els, 'cut-smooth-all')!
    expect(smooth.props.disabled).toBe(false)
    click(smooth)
    expect(store.steps).toBe(1)
    expect(store.state.joins).toEqual({ ...OWN, all: { kind: 'smooth' } })
    expect(notices).toEqual(['Smoothed 34 cuts · 3 keep their own style · Ctrl + Z to undo'])
    // Every cut is smooth now: disabled, with its hint, and no change from a click.
    unmountAll()
    els = await cuts()
    const again = byTestId(els, 'cut-smooth-all')!
    expect(again.props.disabled).toBe(true)
    expect(again.props.title).toBe('Every cut is already smooth')
    expect(textOf(byTestId(els, 'cuts-section'))).toContain('Every cut is already smooth')
    expect(byTestId(els, 'cut-every')!.props.value).toBe('smooth')
  })

  it('gives the cuts with their own style the same style, in one update', async () => {
    const els = await cuts()
    expect(textOf(byTestId(els, 'cuts-section'))).toContain('3 cuts have their own style.')
    click(byTestId(els, 'cut-same-style')!)
    expect(store.steps).toBe(1)
    expect(store.state.joins).toBeUndefined()
    expect(notices[0]).toBe('Every cut has the same style · Ctrl + Z to undo')
  })

  it('sets every cut\'s style from the select, Hard cut stored so Polish keeps it', async () => {
    let els = await cuts()
    ;(byTestId(els, 'cut-every')!.props.onChange as (e: unknown) => void)({ target: { value: 'crossfade' } })
    expect(store.state.joins?.all).toEqual({ kind: 'crossfade' })
    unmountAll()
    els = await cuts()
    const length = byTestId(els, 'cut-length')!
    expect(length.props['aria-valuetext']).toBe('0.15 seconds')
    ;(byTestId(els, 'cut-every')!.props.onChange as (e: unknown) => void)({ target: { value: 'cut' } })
    expect(store.state.joins?.all).toEqual({ kind: 'cut' })
  })

  it('is not shown without cuts', async () => {
    store.state = { ...project(), clips: [{ id: 'one', start: 1, end: 100, speed: 1 }] }
    const els = await cuts()
    expect(byTestId(els, 'cuts-section')).toBeUndefined()
  })
})

describe('the Cut style section (test 23)', () => {
  const gap5 = { start: 14, end: 15 }

  it('says "Cut 5 of 37" and its buttons run the commands', async () => {
    const els = await style(gap5)
    expect(textOf(byTestId(els, 'cut-number'))).toBe('Cut 5 of 37')
    click(byTestId(els, 'cut-prev')!)
    click(byTestId(els, 'cut-next')!)
    click(byTestId(els, 'cut-play')!)
    expect(commands).toEqual(['previousCut', 'nextCut', 'playCut'])
  })

  it('is a radio group of the styles; a choice is one update, and its Length reads and moves by keys', async () => {
    let els = await style(gap5)
    const group = byTestId(els, 'cut-style')!
    expect(group.props.role).toBe('radiogroup')
    expect(group.props['aria-label']).toBe('Cut style')
    expect(els.filter((e) => e.props['data-kind'] !== undefined && e.type === 'label').map((e) => e.props['data-kind'])).toEqual(['same', 'cut', 'smooth', 'crossfade', 'dip', 'slide', 'punch'])
    expect(radio(els, 'same').props.checked).toBe(true)
    ;(radio(els, 'crossfade').props.onChange as () => void)()
    expect(store.steps).toBe(1)
    expect(store.state.joins?.cuts).toContainEqual({ clip: 'c5', kind: 'crossfade' })
    unmountAll()
    els = await style(gap5)
    const length = byTestId(els, 'cut-length')!
    expect(length.props['aria-valuetext']).toBe('0.15 seconds')
    const e = key('PageUp')
    ;(length.props.onKeyDown as (e: unknown) => void)(e)
    expect(e.prevented).toBe(true)
    expect(store.state.joins?.cuts?.find((c) => c.clip === 'c5')).toEqual({ clip: 'c5', kind: 'crossfade', duration: 0.25 })
    // Back to the same as every cut.
    unmountAll()
    els = await style(gap5)
    ;(radio(els, 'same').props.onChange as () => void)()
    expect(store.state.joins?.cuts?.some((c) => c.clip === 'c5')).toBe(false)
  })

  it('says what Smooth gives a camera-led cut', async () => {
    const layouts: LayoutSegment[] = [{ id: 'L', start: 0, end: 120, layout: 'camera-only' }]
    store.state = project({ all: { kind: 'smooth' } }, { hasWebcam: true, webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }, layouts })
    let els = await style(gap5)
    expect(textOf(byTestId(els, 'cut-here'))).toBe('Here: a punch-in (the camera fills most of the picture on both sides).')
    expect(textOf(els.find((e) => e.props['data-kind'] === 'same'))).toContain('Same as every cut (Smooth)')
    unmountAll()
    store.state = project({ all: { kind: 'smooth' } })
    els = await style(gap5)
    expect(textOf(byTestId(els, 'cut-here'))).toBe('Here: a crossfade (the screen fills the picture).')
  })

  it('notes a dip drawn as a crossfade by the flash rule', async () => {
    // Clips 1.2 s apart in video time: the second dip is within 1 s of the first.
    const close: Clip[] = Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, start: 3 * i, end: 3 * i + 0.6, speed: 1 }))
    store.state = { ...project({ all: { kind: 'dip', duration: 0.4 } }), clips: close }
    let els = await style({ start: 0.6, end: 3 })
    expect(byTestId(els, 'cut-note')).toBeUndefined()
    unmountAll()
    els = await style({ start: 3.6, end: 6 })
    expect(textOf(byTestId(els, 'cut-note'))).toBe("Shown as a crossfade so dips don't flash too often.")
  })

  it('is not shown for a trimmed start', async () => {
    store.state = { ...project(), clips: CLIPS.map((c, i) => (i === 0 ? { ...c, start: 1 } : c)) }
    const els = await style({ start: 0, end: 1 })
    expect(byTestId(els, 'cut-style-section')).toBeUndefined()
  })
})
