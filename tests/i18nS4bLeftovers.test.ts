/**
 * Step S4b's integration (docs/design/output-and-languages.md §9.1, §9.5, §9.6, §10.6): the last
 * word tables the words rule found are shown through words files, and English reads as before. Each
 * case holds today's English and shows the same words change in a translated UI (the en-XA
 * pseudo-locale), where the old code showed the English table's text: the guide's save and copy
 * refusals made in the renderer, an image item's sticker name, the colour looks, the zoom easings
 * group edit offers, the tilt presets, the review rows' camera framing, the share folders' sources,
 * the versions' file notices and the Captions field's chips.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GUIDE_SAVE_LIMITS, guideCopyProblem, guidePayloadProblem } from '../src/shared/api/guide'
import { createProject } from '../src/shared/engine/project'
import { t } from '../src/shared/i18n/t'
import type { Project } from '../src/shared/types'
import { uiEnglish, uiPseudo } from './pseudoUi'

/** window.api as the preload gives it: the same limits, refused with the problem's id only. */
const sent = { copied: [] as unknown[], saved: [] as unknown[] }
vi.stubGlobal('window', {
  api: {
    copyGuide: (clip: unknown) => {
      const p = guideCopyProblem(clip)
      if (p) return Promise.reject(new Error(p))
      sent.copied.push(clip)
      return Promise.resolve()
    },
    saveGuide: (payload: unknown) => {
      const p = guidePayloadProblem(payload)
      if (p) return Promise.reject(new Error(p))
      sent.saved.push(payload)
      return Promise.resolve({ path: '/out/g.html', bytes: 1 })
    }
  }
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/guide/guideRun'
const NAMES = '../src/renderer/src/editor/exportNames'
const run = (await import(/* @vite-ignore */ RUN)) as {
  copyGuide(deps: { project: Project; steps: readonly never[]; images: ReadonlyMap<string, unknown> }): Promise<{ images: number }>
}
const exportNames = (await import(/* @vite-ignore */ NAMES)) as { sidecarLabel(k: 'srt' | 'vtt'): string; sidecarBlockedText(k: 'srt', f: 'gif' | 'mp4', has: { captions: boolean; chapters: boolean }): string | null }

afterEach(() => {
  uiEnglish()
  sent.copied.length = 0
  sent.saved.length = 0
})

function project(intro = ''): Project {
  const p = createProject({ id: 'g1', name: 'Billing', duration: 10, width: 1280, height: 720, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'chromium', cursorInVideo: false, region: null } })
  return { ...p, guide: { ...(p.guide ?? {}), intro } }
}

describe('Make a guide: the renderer says why a copy cannot go, in the UI language', () => {
  it('a guide too large to copy is refused before it is sent, with today’s English', async () => {
    const big = project('x'.repeat(GUIDE_SAVE_LIMITS.clipText + 1))
    await expect(run.copyGuide({ project: big, steps: [], images: new Map() })).rejects.toThrow(/^This guide is too large to copy\.$/)
    expect(sent.copied).toEqual([])
  })

  it('in a translated UI the refusal is that language’s message, never the preload’s id or English', async () => {
    uiPseudo('en-XA')
    const big = project('x'.repeat(GUIDE_SAVE_LIMITS.clipText + 1))
    const said = t('errors.guide.tooLargeToCopy')
    expect(said).not.toBe('This guide is too large to copy.')
    await expect(run.copyGuide({ project: big, steps: [], images: new Map() })).rejects.toThrow(said)
    expect(sent.copied).toEqual([])
    // A guide that fits still goes.
    await run.copyGuide({ project: project('Short.'), steps: [], images: new Map() })
    expect(sent.copied).toHaveLength(1)
  })
})

describe('the last word tables are named through words files', () => {
  it('names a sticker image by its message, in English as before', async () => {
    const { overlayLabel } = await import('../src/shared/editor/overlays')
    const { stickerName } = await import('../src/shared/editor/itemNames')
    const { STICKERS } = await import('../src/shared/render/stickers')
    for (const s of STICKERS) {
      expect(stickerName(s.id)).toBe(s.name)
      expect(overlayLabel({ sticker: s.id, name: '', file: '' })).toBe(`${s.name} sticker`)
    }
    expect(overlayLabel({ sticker: 'gone', name: '', file: '' })).toBe('Sticker sticker')
    expect(overlayLabel({ name: '', file: '' })).toBe('Image')
    uiPseudo('en-XA')
    expect(stickerName('heart')).toBe(t('text.sticker.heart'))
    expect(stickerName('heart')).not.toBe('Heart')
    expect(overlayLabel({ sticker: 'heart', name: '', file: '' })).toBe(t('text.overlay.sticker', { name: t('text.sticker.heart') }))
    expect(overlayLabel({ name: '', file: '' })).not.toBe('Image')
  })

  it('names the colour looks, the zoom easings group edit offers and the tilt presets by their messages', async () => {
    const { colourLookName, tiltPresetsShown, ZOOM_EASING_CHOICES } = await import('../src/shared/engine/lookNames')
    const { LOOKS } = await import('../src/shared/render/looks')
    const { ZOOM_EASINGS } = await import('../src/shared/engine/easing')
    const { TILT_PRESETS } = await import('../src/shared/engine/tilt')
    for (const l of LOOKS) expect(colourLookName(l.id)).toBe(l.label)
    expect(ZOOM_EASING_CHOICES.map((c) => ({ value: c.value, label: c.label, title: c.title }))).toEqual(ZOOM_EASINGS.map((e) => ({ value: e.value, label: e.label, title: e.title })))
    expect(tiltPresetsShown().map((p) => [p.id, p.label, p.title])).toEqual(TILT_PRESETS.map((p) => [p.id, p.label, p.title]))
    uiPseudo('en-XA')
    expect(colourLookName('cinematic')).not.toBe('Cinematic')
    // The chips are made when read, so a table built at load follows the UI language.
    expect(ZOOM_EASING_CHOICES[0].label).toBe(t('editor.look.easing.smooth.label'))
    expect(ZOOM_EASING_CHOICES[0].label).not.toBe('Smooth')
  })

  it('lists the camera framing row, the cloud folders’ sources and the versions’ file notices in the UI language', async () => {
    const { directorDetail, framingTitle } = await import('../src/shared/review/copy')
    const { folderSourceText } = await import('../src/shared/share/steps')
    const { changedFilesNotice, missingFilesNotice } = await import('../src/shared/editor/versionWords')
    expect([framingTitle(), directorDetail()]).toEqual(['Camera framed on your face', 'Camera director'])
    expect([folderSourceText('onedrive', 'app'), folderSourceText('dropbox', 'usual'), folderSourceText('folder', 'picked')]).toEqual(["Found in OneDrive's settings", 'Found at the usual place', 'Added by you'])
    expect(missingFilesNotice(['music'])).toBe('Its music file is no longer in the project folder.')
    expect(changedFilesNotice(['background image'])).toBe('Its background image has changed since it was kept.')
    uiPseudo('en-XA')
    expect(framingTitle()).not.toBe('Camera framed on your face')
    expect(folderSourceText('dropbox', 'usual')).not.toBe('Found at the usual place')
    expect(missingFilesNotice(['music'])).not.toBe('Its music file is no longer in the project folder.')
  })

  it('names the Captions field’s chips and why they are off through exportNames', () => {
    expect([exportNames.sidecarLabel('srt'), exportNames.sidecarLabel('vtt')]).toEqual(['Captions (SRT)', 'Captions (VTT)'])
    expect(exportNames.sidecarBlockedText('srt', 'gif', { captions: true, chapters: false })).toBe('GIFs are saved alone')
    expect(exportNames.sidecarBlockedText('srt', 'mp4', { captions: false, chapters: false })).toBe('This video has no captions yet')
    uiPseudo('en-XA')
    expect(exportNames.sidecarLabel('srt')).not.toBe('Captions (SRT)')
    expect(exportNames.sidecarBlockedText('srt', 'mp4', { captions: false, chapters: false })).toBe(t('export.sidecar.noCaptions'))
  })
})
