import { describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'
import { contexts, mockReact, render, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The Style tab's background blur slider without a DOM (as tests/captionLookSection.test.ts renders
 * the Captions tab): at 0 it shows the shared "Off", in the UI language, as the Camera and Audio
 * tabs' sliders do (docs/design/output-and-languages.md §9.1).
 */

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('document', { activeElement: null, body: {}, createElement: () => ({ getContext: () => null, toDataURL: () => '' }) })
vi.stubGlobal('window', { api: { getPref: async () => null, setPref: async () => undefined }, addEventListener: () => undefined, removeEventListener: () => undefined })

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/StylePanel'
const { StylePanel } = (await import(/* @vite-ignore */ PANEL)) as { StylePanel: (p: unknown) => unknown }
await useEditorContexts()
const { t } = await import('../src/shared/i18n/t')
const { uiEnglish, uiPseudo } = await import('./pseudoUi')

/** The panel's elements; the sections it holds and the controls are listed, not rendered. */
const SKIP = ['StyleDefaultsSection', 'PresetsSection', 'CropLink', 'CropRow', 'FollowSection', 'BrandKitBar', 'WatermarkSection', 'Chips', 'Toggle', 'Slider', 'Icon']

function panel(project: Project): El[] {
  contexts.editor = { store: { state: project, update: () => undefined }, player: { time: 0 } }
  contexts.group = { group: { keys: [], anchor: null, stamp: 0 }, keys: new Set(), single: null, select: () => undefined, notice: () => undefined, command: () => undefined }
  return render({ type: StylePanel, props: { project, onBackgroundImage: () => undefined, onNotice: () => undefined, onCrop: () => undefined } }, SKIP)
}

describe('the Style tab’s background blur', () => {
  it('shows Off at 0 in the UI language, and a percentage above it', () => {
    const base = createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' } })
    const project: Project = { ...base, style: { ...base.style, background: { type: 'wallpaper', id: 'aurora' } } }
    try {
      for (const set of [uiEnglish, () => uiPseudo('en-XA')]) {
        set()
        unmountAll()
        const blur = panel(project).find((e) => e.props.label === t('style.stylePanel.backgroundBlur'))
        const format = blur!.props.format as (v: number) => string
        expect(format(0)).toBe(t('common.state.off'))
        expect(format(0.5)).not.toBe(t('common.state.off'))
      }
      uiEnglish()
      expect(t('common.state.off')).toBe('Off')
    } finally {
      uiEnglish()
    }
  })
})
