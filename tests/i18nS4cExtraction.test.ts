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
import type { CaptionSettings, ChapterOrigin, Project, Spotlight } from '../src/shared/types'
import { SAFE_ZONES, type SafePlatform } from '../src/shared/render/safeZones'
import { IMPORTED_COPY, noCursorText } from '../src/shared/import/imported'
import { cutEndNotice, cutMomentNotice, momentOpening } from '../src/shared/search/moment'
import { momentTitle } from '../src/shared/clips/moments'
import { cloudCandidates } from '../src/shared/share/cloudFolders'
import { chapterDetail } from '../src/shared/review/chapterReview'
import { joinTitle } from '../src/shared/review/joinReview'
import { colourTitle, colourDetail } from '../src/shared/review/colourReview'

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

describe('the safe-zone chips', async () => {
  // Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
  const OVERLAY = '../src/renderer/src/editor/SafeZoneOverlay'
  const { zoneLabels, allLabel } = (await import(/* @vite-ignore */ OVERLAY)) as {
    zoneLabels: (choice: string, boxes: readonly { x: number; y: number; w: number; h: number; label: string }[]) => { text: string }[]
    allLabel: () => string
  }
  const platforms = Object.keys(SAFE_ZONES) as SafePlatform[]

  it('name every box as the table does in English, by its app and side', () => {
    for (const p of platforms) expect(zoneLabels(p, SAFE_ZONES[p].boxes).map((l) => l.text)).toEqual(SAFE_ZONES[p].boxes.map((b) => b.label))
    expect(allLabel()).toBe('Buttons and captions (all three)')
  })

  it('follow the UI language, while the table keeps its English as data', () => {
    enXA()
    for (const p of platforms) {
      const texts = zoneLabels(p, SAFE_ZONES[p].boxes).map((l) => l.text)
      SAFE_ZONES[p].boxes.forEach((b, i) => expect(texts[i], `${p} ${b.label}`).not.toBe(b.label))
    }
    expect(allLabel()).not.toBe('Buttons and captions (all three)')
  })
})

describe('texts of modules main loads too, in the UI language', () => {
  const imported = { source: { kind: 'import', fileName: 'a.mp4' } } as unknown as Pick<Project, 'source'>
  const kept = [{ start: 0, end: 5 }, { start: 12, end: 20 }]
  const cases: [string, () => string, string][] = [
    ['IMPORTED_COPY.camera', () => IMPORTED_COPY.camera, 'This video was imported, so it has no separate camera.'],
    ['IMPORTED_COPY.keystrokes', () => IMPORTED_COPY.keystrokes, 'This video was imported, so no keyboard shortcuts were recorded.'],
    ['noCursorText (recorded)', () => noCursorText(null), 'This recording has no cursor data'],
    ['noCursorText (imported)', () => noCursorText(imported), 'This video was imported, so it has no cursor data'],
    ['momentOpening (cut)', () => momentOpening(kept, { t: 9.5, end: 11.5 }).notice ?? '', 'That moment was cut from the video, so the editor is at the next part that is kept.'],
    ['momentOpening (cut at the end)', () => momentOpening(kept, { t: 25, end: 26 }).notice ?? '', 'That moment was cut from the end of the video, so the editor is at the end.'],
    ['cloud folder (work)', () => cloudCandidates({ env: { OneDriveCommercial: 'C:\\W' }, registry: {}, dropboxInfo: [], driveLetters: false, join: (...p) => p.join('\\') })[0]?.label ?? '', 'OneDrive (work or school)']
  ]
  it('read as today’s English in English and change under en-XA', () => {
    for (const [name, f, en] of cases) expect(f(), name).toBe(en)
    expect(cutMomentNotice()).toBe(cases[4][2])
    expect(cutEndNotice()).toBe(cases[5][2])
    enXA()
    for (const [name, f, en] of cases) expect(f(), name).not.toBe(en)
  })
})

describe('review rows and clip names made when listed', () => {
  const origin = (o: Partial<ChapterOrigin>): ChapterOrigin => ({ by: 'find', from: ['page'], name: 'words', ...o }) as ChapterOrigin
  const cases: [string, () => string, string][] = [
    ['chapterDetail (find)', () => chapterDetail(origin({ from: ['page', 'pause'] }), true), 'Find chapters · page change and pause · keeping it restarts step numbers here'],
    ['chapterDetail (AI)', () => chapterDetail(origin({ from: ['ai'], name: 'ai', via: 'local' }), false), 'Suggest chapters with this PC · named on this PC'],
    ['joinTitle (one)', () => joinTitle(1), 'Smooth cuts at 1 cut'],
    ['joinTitle (many)', () => joinTitle(37), 'Smooth cuts at 37 cuts'],
    ['colourTitle', colourTitle, 'Camera colour balanced'],
    ['colourDetail', colourDetail, 'Auto colour'],
    ['momentTitle', () => momentTitle('', 3), 'Clip 3']
  ]
  it('read as today’s English in English and change under en-XA', () => {
    for (const [name, f, en] of cases) expect(f(), name).toBe(en)
    enXA()
    for (const [name, f, en] of cases) expect(f(), name).not.toBe(en)
  })
})
