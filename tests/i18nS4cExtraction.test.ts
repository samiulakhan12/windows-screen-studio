/**
 * Step S4b, group c (docs/design/output-and-languages.md §10.3, §10.6): the editor, panel, review,
 * notes, share, search and title files say their words through messages that give back today's
 * English and follow the UI language when it changes (nothing is made when a module loads).
 *
 * - Code that recognised one of its own texts by its English now recognises it by its message, so
 *   it still works in a translated UI: a post held back by a failed copy (main's message) is tried
 *   again with that copy, and the clips list leaves out a moment's length reason.
 * - Captions Studio's review rows name a look as the Captions tab names it.
 * - Counted words, notices and names change under en-XA and read as today's English in English.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setCatalogue, t, type MessageKey } from '../src/shared/i18n/t'
import { retryTargets } from '../src/shared/share/steps'
import type { ShareRunView } from '../src/shared/api/share'
import { listedReasons } from '../src/shared/clips/moments'
import { LEGACY_TILES, STUDIO_PRESETS } from '../src/shared/captions/studioPresets'
import { lookName } from '../src/shared/review/captionReview'
import { countOf } from '../src/shared/editor/multiSelect'
import { shuttleHint, shuttleLabel } from '../src/shared/editor/shuttle'
import { spotlightName } from '../src/shared/render/magnifier'
import { imageSizeProblem } from '../src/shared/render/imageOverlays'
import { markerName } from '../src/shared/editor/timelineCuts'
import { saveErrorMessage } from '../src/shared/editor/autosave'
import type { CaptionSettings, Spotlight } from '../src/shared/types'

const files = require('../scripts/i18n/lib/files.cjs') as { readEnglish(): { messages: Record<string, string>; meta: Record<string, object> } }
const pseudo = require('../scripts/i18n/lib/pseudo.cjs') as {
  pseudoCatalogue(locale: string, english: Record<string, string>, meta: Record<string, object>): { dir: 'ltr' | 'rtl'; messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
}

const english = (): void => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
function enXA(): void {
  const { messages, meta } = files.readEnglish()
  const c = pseudo.pseudoCatalogue('en-XA', messages, meta)
  setCatalogue({ language: 'es', messages: c.messages, latn: c.latn, user: c.user, formatLocale: 'en-US', dir: c.dir })
}
afterEach(english)

describe('texts the code recognises are told by their messages', () => {
  const run = (heldBy: string): ShareRunView => ({
    id: 'r',
    file: 'C:\\x.mp4',
    finished: true,
    steps: [
      { target: 'cf0000000001', kind: 'copy', service: 'onedrive', label: 'OneDrive', state: 'failed', message: 'The drive of OneDrive is full.' },
      { target: 'whkchat', kind: 'post', service: 'slack', label: '#demos', state: 'failed', message: heldBy }
    ]
  })

  it('tries a post held back by a failed copy again with that copy, in a translated UI too', () => {
    enXA()
    // Main says why in the UI language: errors.shareService.notPostedTheCopy, not its English.
    const held = run(t('errors.shareService.notPostedTheCopy'))
    expect(held.steps[1].message).not.toBe('Not posted: the copy failed.')
    expect(retryTargets(held, held.steps[1])).toEqual(['cf0000000001', 'whkchat'])
    expect(retryTargets(held, { ...held.steps[1], message: 'Slack is busy.' })).toEqual(['whkchat'])
    english()
    const en = run('Not posted: the copy failed.')
    expect(retryTargets(en, en.steps[1])).toEqual(['cf0000000001', 'whkchat'])
  })

  it('leaves the length out of the reasons a clips row lists, in a translated UI too', () => {
    enXA()
    const reasons = [t('smart.clips.reason.opensQuestion'), t('smart.clips.reason.clicks', { count: 6, n: '6' }), t('smart.clips.reason.seconds', { n: '30' })]
    expect(reasons[2]).not.toBe('30 s')
    expect(listedReasons({ reasons, seconds: 30.2 })).toEqual(reasons.slice(0, 2))
    english()
    expect(listedReasons({ reasons: ['Opens with a question', '6 clicks', '30 s'], seconds: 29.6 })).toEqual(['Opens with a question', '6 clicks'])
  })
})

describe('caption looks in review rows', () => {
  it('name each look as the Captions tab does, today’s names in English', () => {
    for (const p of STUDIO_PRESETS) expect(t(`captions.look.preset.${p.id}.name` as MessageKey)).toBe(p.name)
    for (const tile of LEGACY_TILES) expect(t(`captions.look.classic.${tile.preset}.name` as MessageKey)).toBe(tile.name)
    const studio = (from: string): CaptionSettings => ({ preset: 'clean', studio: { from } }) as unknown as CaptionSettings
    for (const p of STUDIO_PRESETS) expect(lookName(studio(p.id))).toBe(LEGACY_TILES.find((x) => x.preset === p.id)?.name ?? p.name)
    expect(lookName(null)).toBe('Clean')
    expect(lookName(studio('brand'))).toBe('Brand')
    expect(lookName(studio('mine:abc'))).toBe('your style')
    expect(lookName(studio('no-such-look'))).toBe('your style')
  })

  it('follow the UI language', () => {
    enXA()
    expect(lookName(null)).not.toBe('Clean')
    expect(lookName(null)).toBe(t('captions.look.classic.clean.name'))
  })
})

describe('words made when read, in the UI language', () => {
  const magnifier = { id: 's', start: 0, end: 1, mode: 'area', magnify: 2 } as unknown as Spotlight
  const cases: [string, () => string][] = [
    ['countOf', () => countOf(2, 'zoom')],
    ['shuttleLabel', () => shuttleLabel({ dir: -1, level: 1 } as never, 1) ?? ''],
    ['shuttleHint', () => shuttleHint({ reverse: 'J', pause: 'K', forward: 'L' })],
    ['spotlightName', () => spotlightName(magnifier)],
    ['imageSizeProblem', () => imageSizeProblem(9000, 6000) ?? ''],
    ['markerName', () => markerName(5, 37, { start: 83.4, end: 85 }, 'cut', 3)],
    ['saveErrorMessage', () => saveErrorMessage('EBUSY: resource busy or locked')]
  ]
  it('read as today’s English in English and change under en-XA', () => {
    const before = cases.map(([, f]) => f())
    expect(before).toEqual([
      '2 zooms',
      before[1],
      'J plays backwards, K pauses, L plays forward; press again to go faster. Hold K and tap J or L to step one frame. No sound in reverse or above 4×.',
      'Magnifier, 2 times',
      'This image is too large to show (9000 × 6000 pixels; 8192 a side and 40 megapixels at most).',
      before[5],
      'The project file is locked by another program or is read-only. (EBUSY)'
    ])
    expect(before[1]).toMatch(/^Reverse \d/)
    expect(before[5]).toMatch(/^Cut 5 of 37: 1:23\.4 to 1:25\.0, .+, and 2 more cuts$/)
    enXA()
    cases.forEach(([name, f], i) => expect(f(), name).not.toBe(before[i]))
  })
})
