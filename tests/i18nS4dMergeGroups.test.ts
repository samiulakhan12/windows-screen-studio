/**
 * Step S4b's merge groups (docs/design/output-and-languages.md §9.3, §10.3 rule 4, test 85): each
 * sentence English still builds from pieces keeps its pieces as `merge: true` keys, and other
 * languages show the group's `.whole` message. In English nothing changes; the whole message says
 * the same sentence (checked here by running the other languages' path with the English catalogue);
 * in a translated UI the code says the whole message, never the pieces.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { autoTitle } from '../src/shared/editor/directorCopy'
import { DEFAULT_KEYMAP, shortcutLabel, undoHint } from '../src/shared/editor/shortcuts'
import { setCatalogue, t, tNodes, type MessageKey } from '../src/shared/i18n/t'
import { notificationFor } from '../src/shared/jobs/longJobs'
import { uiEnglish, uiPseudo } from './pseudoUi'

const files = require('../scripts/i18n/lib/files.cjs') as { readEnglish(): { messages: Record<string, string>; meta: Record<string, { merge?: boolean }> } }
const catalogue = require('../scripts/i18n/lib/catalogue.cjs') as { mergeGroups(meta: Record<string, unknown>): Map<string, { group: string; keys: string[]; whole: string }> }

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const ROWS = '../src/renderer/src/search/rows'
const { spokenTime } = (await import(/* @vite-ignore */ ROWS)) as { spokenTime(seconds: number): string }

afterEach(uiEnglish)

/** A UI language other than English whose catalogue has no messages: the other languages' code path, in English words. */
const otherPathInEnglish = (): void => setCatalogue({ language: 'es', messages: {}, formatLocale: 'en-US', dir: 'ltr' })

/** `key` formatted with its rich tags as plain text, as the page shows it. */
const shown = (key: MessageKey, values: Record<string, string | number> = {}): string => tNodes<string>(key, values, { link: (c) => c.join(''), em: (c) => c.join(''), b: (c) => c.join(''), kbd: (c) => c.join('') }).join('')

/** Runs `make` in English and on the other languages' path with English words. */
function bothPaths<T>(make: () => T): { english: T; whole: T } {
  uiEnglish()
  const english = make()
  otherPathInEnglish()
  const whole = make()
  uiEnglish()
  return { english, whole }
}

describe('S4b merge groups: the catalogue', () => {
  it('names every group S4b-d made, each with its whole message', () => {
    const { messages, meta } = files.readEnglish()
    const groups = catalogue.mergeGroups(meta)
    for (const group of [
      'export.resolution',
      'export.settings.batch',
      'style.freezeMarks.tip',
      'text.overlayEditor.dragToPlaceIt',
      'editor.preview.focusHint',
      'editor.preview.regionHint',
      'style.clipPanel.editHint',
      'style.selectionPanel.lookKeys',
      'zoom.zoomPanel.ignored',
      'style.stylePanel.defaultsLeft',
      'smart.guide.check',
      'smart.guide.tooBig',
      'review.search.time',
      'settings.about.builtBy',
      'settings.storage.line',
      'camera.director.autoTitleSuffix',
      'keys.undoHint',
      'main.jobs.more'
    ]) {
      expect(groups.get(group), group).toBeTruthy()
      expect(messages[`${group}.whole`], group).toBeTruthy()
      // The whole message is never a piece itself (§9.3).
      expect(messages[`${group}.whole`], group).not.toMatch(/^\s|\s$/)
    }
  })
})

describe('S4b merge groups: the whole message says what English builds', () => {
  it('the spoken time of a search result', () => {
    for (const s of [0, 1, 2, 59, 60, 61, 62, 119, 120, 3599, 3600, 3601, 3660, 3661, 7200, 7322, 86400]) {
      const { english, whole } = bothPaths(() => spokenTime(s))
      expect(whole, String(s)).toBe(english)
    }
  })

  it('the undo hint after a notice, with the default keys and with Undo on another key', () => {
    for (const keymap of [DEFAULT_KEYMAP, { ...DEFAULT_KEYMAP, undo: ['Ctrl+Alt+U'] }, { ...DEFAULT_KEYMAP, undo: [] }]) {
      const { english, whole } = bothPaths(() => undoHint(keymap))
      expect(whole).toBe(english)
    }
    expect(bothPaths(() => undoHint(DEFAULT_KEYMAP)).english).toBe(' · Ctrl + Z to undo')
  })

  it('the tooltip of a layout block the director made', () => {
    const { english, whole } = bothPaths(() => autoTitle('Screen and camera · 0:01 – 0:05'))
    expect(english).toBe('Screen and camera · 0:01 – 0:05 · automatic: change it to keep it when you direct again')
    expect(whole).toBe(english)
  })

  it('the notification after an export, every way a batch can end', () => {
    const one = [{ path: 'C:\\Videos\\Demo.mp4', bytes: 24_100_000 }]
    const many = [{ path: '/v/out/a.mp4', bytes: 1000 }, { path: '/v/out/b.mp4', bytes: 1000 }]
    for (const files of [one, many])
      for (const failed of [undefined, 0, 1, 2, 1000])
        for (const stopped of [undefined, false, true]) {
          const { english, whole } = bothPaths(() => notificationFor('export', { kind: 'done', failed, stopped }, files))
          expect(whole?.body).toBe(english?.body)
        }
  })

  it('the freeze block tooltips', () => {
    const length = '1.5 s'
    for (const keys of [shortcutLabel('Delete'), null])
      for (const group of ['selected', 'several', 'none'] as const) {
        const groupText = group === 'selected' ? t('style.freezeMarks.tip.groupSelected', { n: '3' }) : group === 'several' ? t('style.freezeMarks.tip.groupSelectSeveral') : ''
        const remove = keys ? t('style.freezeMarks.tip.removeHint', { keys }) : ''
        const values = { length, keys: keys ?? '', group, n: '3' }
        expect(t('style.freezeMarks.tip.whole', { ...values, kind: 'adds', remove: keys ? 'yes' : 'no' })).toBe(t('style.freezeMarks.freezeFrameAddsHere', { length, remove, group: groupText }))
        expect(t('style.freezeMarks.tip.whole', { ...values, kind: 'holds', remove: 'no' })).toBe(t('style.freezeMarks.freezeFrameThePicture', { length, group: groupText }))
      }
  })

  it('the export dialog’s resolution notes and batch heading', () => {
    const values = { size: '3840×2160', side: '4096', width: '1920', height: '1080' }
    for (const capped of [false, true])
      for (const upscaled of [false, true]) {
        const notes = [values.size, ...(capped ? [t('export.resolution.capped', values)] : []), ...(upscaled ? [t('export.resolution.upscaled', values)] : [])]
        expect(t('export.resolution.whole', { ...values, capped: capped ? 'yes' : 'no', upscaled: upscaled ? 'yes' : 'no' })).toBe(notes.join('; '))
      }
    expect(shown('export.settings.batch.whole')).toBe(`${t('common.label.settings')} · ${t('export.settings.batch.lead')}`)
  })

  it('the hints with a Done button, the About line and the guide’s too-big line', () => {
    expect(shown('editor.preview.focusHint.whole')).toBe(`${t('editor.preview.focusHint.lead')} ${t('common.action.done')}`)
    expect(shown('editor.preview.regionHint.whole')).toBe(`${t('editor.preview.regionHint.lead')} ${t('common.action.done')}`)
    expect(shown('text.overlayEditor.dragToPlaceIt.whole', { label: 'Logo' })).toBe(`${t('text.overlayEditor.dragToPlaceIt.lead', { label: 'Logo' })} ${t('common.action.done')}`)
    expect(shown('settings.about.builtBy.whole', { company: 'Qbexel', site: 'qbexel.com' })).toBe(`${shown('settings.about.builtBy.lead', { company: 'Qbexel' })} qbexel.com`)
    expect(shown('smart.guide.tooBig.whole', { size: '31' })).toBe(`${t('smart.guide.tooBig.lead', { size: '31' })}${t('smart.guide.smaller')}`)
  })

  it('the Clip tab’s edit hint, the Storage line, the ignored click and the saved look', () => {
    for (const split of [true, false])
      for (const del of [true, false]) {
        const english = [
          split ? shown('style.clipPanel.editHint.pressSplit', { split: 'S' }) : t('style.clipPanel.editHint.split'),
          t('style.clipPanel.editHint.selectClip'),
          del ? shown('style.clipPanel.editHint.pressDelete', { delete: 'Delete' }) : t('style.clipPanel.editHint.useDelete'),
          shown('style.clipPanel.editHint.toCut')
        ].join(' ')
        expect(shown('style.clipPanel.editHint.whole', { hasSplit: split ? 'yes' : 'no', split: 'S', hasDelete: del ? 'yes' : 'no', delete: 'Delete' })).toBe(english)
      }
    for (const free of [null, '12 GB'])
      expect(shown('settings.storage.line.whole', { size: '95 KB', hasFree: free ? 'yes' : 'no', free: free ?? '' })).toBe(`${shown('settings.storage.line.total', { size: '95 KB' })}${free ? t('settings.storage.line.free', { free }) : ''}`)
    for (const reason of [null, 'it was a double-click'])
      expect(t('zoom.zoomPanel.ignored.whole', { auto: reason ? 'yes' : 'no', reason: reason ?? '' })).toBe(`${t('zoom.zoomPanel.ignored.lead')}${reason ? t('zoom.zoomPanel.ignored.auto', { reason }) : ''}`)
    const image = t('style.stylePanel.defaultsLeft.image')
    const logo = t('style.stylePanel.defaultsLeft.logo')
    for (const [left, parts] of [['both', [image, logo]], ['image', [image]], ['logo', [logo]]] as const)
      expect(t('style.stylePanel.defaultsLeft.whole', { left })).toBe(t('style.stylePanel.savedAsDefaultLeft', { left: parts.join('; ') }))
  })

  it('the Selection tab’s hint when both look keys are set (the other cases are in english-changes.md)', () => {
    const english = `${t('style.selectionPanel.lookKeys.intro')}${t('style.selectionPanel.lookKeys.copy', { keys: 'Ctrl + Alt + C' })}${t('style.selectionPanel.lookKeys.paste', { keys: 'Ctrl + Alt + V' })}`
    expect(t('style.selectionPanel.lookKeys.whole', { keys: 'both', copy: 'Ctrl + Alt + C', paste: 'Ctrl + Alt + V' })).toBe(english)
  })
})

describe('S4b merge groups: a translated UI says the whole message', () => {
  it('spoken times, the undo hint, the director’s title and the export notification', () => {
    uiPseudo('bn-XA')
    expect(spokenTime(3661)).toBe(t('review.search.time.whole', { shape: 'hms', hours: 1, h: '১', minutes: 1, m: '১', seconds: 1, s: '১' }))
    expect(undoHint(DEFAULT_KEYMAP)).toBe(` · ${t('keys.undoHint.whole', { keys: 'Ctrl + Z' })}`)
    expect(autoTitle('x')).toBe(t('camera.director.autoTitleSuffix.whole', { title: 'x' }))
    const body = notificationFor('export', { kind: 'done', failed: 2, stopped: true }, [{ path: '/v/out/a.mp4', bytes: 1000 }, { path: '/v/out/b.mp4', bytes: 1000 }])?.body
    expect(body).toBe(t('main.jobs.more.whole', { lead: 'out', failed: 'yes', count: 2, n: '২', stopped: 'yes' }))
    // No English piece is left in what the translated UI says.
    for (const text of [spokenTime(3661), undoHint(DEFAULT_KEYMAP), autoTitle('x'), body ?? '']) expect(text).not.toMatch(/hour|undo|automatic|failed|stopped/)
  })
})
