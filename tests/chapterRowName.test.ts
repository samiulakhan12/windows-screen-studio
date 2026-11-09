/**
 * The Text tab's chapter list (docs/design/smart-tools.md §2.3, §14): a found chapter's name field
 * says it was found and is not reviewed, read with "Rename?" when its name is weak; a chapter of the
 * user's says neither. React's hooks are swapped (studioHarness); the other sections are left out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chapter } from '../src/shared/types'
import { chapterProject } from './chapterFixtures'
import { contexts, mockReact, render, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

vi.stubGlobal('window', {
  api: { getPref: async () => null, setPref: async () => undefined, listAiProviders: async () => [], localAiState: async () => ({ active: null, speeds: {} }) },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})
mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/TextPanel'
const { TextPanel } = (await import(/* @vite-ignore */ PANEL)) as { TextPanel: (p: unknown) => unknown }
await useEditorContexts()

const SKIP = ['CalloutSection', 'BadgeSection', 'BubbleSection', 'TextSection', 'TitlesSection', 'ChapterBarSection', 'FindChapters', 'SelectAllButton', 'PressOr', 'ShortcutKeys']
const found = (name: NonNullable<Chapter['auto']>['name']): Chapter['auto'] => ({ by: 'find', from: ['screen'], name })

beforeEach(() => {
  unmountAll()
  contexts.group = { group: { keys: [] }, keys: new Set(), single: null, select: () => undefined, command: () => undefined }
  contexts.keymap = new Proxy({}, { get: () => [] })
})

describe('the chapter list (§14)', () => {
  it('a found chapter reads "found, not reviewed" in its name, with "Rename?" when weak; the user’s own reads neither', () => {
    const project = chapterProject({
      duration: 300,
      chapters: [
        { id: 'mine', t: 0, title: 'Welcome' },
        { id: 'good', t: 65, title: 'Set up billing', auto: found('sentence') },
        { id: 'weak', t: 130, title: 'Part 3', auto: found('number') }
      ]
    })
    contexts.editor = { store: { state: project, update: () => undefined }, player: { seek: () => undefined } }
    const out = render({ type: TextPanel, props: { project, selection: null, cursor: { samples: [], clicks: [], keys: [], valid: false }, onSelect: () => undefined, onNotice: () => undefined } }, SKIP)
    const field = (id: string): El => out.find((e) => e.type === 'input' && e.props.id === `chapter-name-${id}`)!
    const described = (e: El): string =>
      String(e.props['aria-describedby'] ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => textOf(out.find((d) => d.props.id === id)!).trim())
        .join(' ')
    expect(field('mine').props['aria-label']).toBe('Name of the chapter at 0:00')
    expect(described(field('mine'))).toBe('')
    expect(field('good').props['aria-label']).toBe('Name of the chapter at 1:05, found, not reviewed')
    expect(described(field('good'))).toBe('')
    expect(field('weak').props['aria-label']).toBe('Name of the chapter at 2:10, found, not reviewed')
    expect(described(field('weak'))).toBe('Rename?')
  })
})
