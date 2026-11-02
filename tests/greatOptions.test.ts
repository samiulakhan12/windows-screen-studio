import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import { byTestId, focused, key, mockReact, render, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Make my captions great's options popover (docs/design/captions-studio.md §2.8) without a DOM:
 * Esc closes it and gives the focus back to its button, from any control inside, before the
 * editor's own keys see it (they blur a select and clear the selection).
 */

vi.mock('../src/renderer/src/editor/greatRun', async () => {
  const { DEFAULT_GREAT_OPTIONS } = await import('../src/shared/captions/great')
  return {
    currentGreatOptions: () => DEFAULT_GREAT_OPTIONS,
    loadGreatOptions: async () => DEFAULT_GREAT_OPTIONS,
    onGreatOptions: () => () => undefined,
    saveGreatOptions: async () => undefined
  }
})
vi.mock('../src/renderer/src/editor/panels/LanguagesSection', () => ({ providerName: (p: { label: string }) => p.label, useTextProviders: () => [] }))

vi.stubGlobal('document', { activeElement: null, body: {} })
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
vi.stubGlobal('HTMLElement', class {})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const OPTIONS = '../src/renderer/src/editor/panels/GreatOptions'
const { GreatOptionsPopover } = (await import(/* @vite-ignore */ OPTIONS)) as { GreatOptionsPopover: (p: unknown) => unknown }
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')

const project: Project = createProject({ id: 'p', name: 'p', duration: 10, width: 1080, height: 1920, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } })
const view = (): El[] => render({ type: GreatOptionsPopover, props: { project } }, ['EditorIcon'])
/** A key press on an element, recording whether it was stopped from going on to the window. */
const press = (el: El, k: string): { prevented: boolean; stopped: boolean } => {
  const e = { ...key(k), stopped: false }
  e.preventDefault = () => void (e.prevented = true)
  e.stopPropagation = () => void (e.stopped = true)
  ;(el.props.onKeyDown as (ev: unknown) => void)(e)
  return { prevented: e.prevented, stopped: e.stopped }
}

beforeEach(() => unmountAll())

describe('Make my captions great options (§2.8)', () => {
  it('Esc closes the popover and gives the focus back to its button, before the editor sees it', () => {
    let els = view()
    ;(byTestId(els, 'captions-great-options')!.props.onClick as () => void)()
    els = view()
    const dialog = byTestId(els, 'great-options')!
    expect(dialog.props.role).toBe('dialog')
    // Another key goes on as usual.
    expect(press(dialog, 'a')).toEqual({ prevented: false, stopped: false })
    expect(byTestId(view(), 'great-options')).toBeDefined()
    // Esc on any control inside, a select too: the dialog's own handler takes it.
    expect(byTestId(els, 'great-sound')!.type).toBe('select')
    expect(press(dialog, 'Escape')).toEqual({ prevented: true, stopped: true })
    els = view()
    expect(byTestId(els, 'great-options')).toBeUndefined()
    expect(byTestId(els, 'captions-great-options')!.props['aria-expanded']).toBe(false)
    expect(focused.at(-1)?.props['data-testid']).toBe('captions-great-options')
  })
})
