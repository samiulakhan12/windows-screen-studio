/**
 * Versions' words in the UI language (docs/design/output-and-languages.md §10.3 rule 1, part X4):
 * src/shared/editor/versionWords.ts gives the summary line, the comparison, the parts of the
 * edit that differ and the files' notices from shared/editor/versions.ts's data, and in English each
 * equals the English form versions.ts keeps for main and the tests, over a grid of summaries.
 */
import { describe, expect, it } from 'vitest'
import * as en from '../src/shared/editor/versions'
import { setCatalogue } from '../src/shared/i18n/t'
import * as words from '../src/shared/editor/versionWords'

const base: en.VersionSummary = { duration: 133.4, cuts: 3, zooms: 5, captions: 42, graphics: 0, texts: 0, shapes: 1, images: 0, chapters: 0, freezes: 0, trimmed: false }
const KEYS = ['cuts', 'zooms', 'captions', 'graphics', 'texts', 'shapes', 'images', 'chapters', 'freezes'] as const

/** Summaries with each count at 0, 1, 2 and 1000, and lengths around a minute and an hour. */
function grid(): en.VersionSummary[] {
  const out: en.VersionSummary[] = [base]
  for (const k of KEYS) for (const n of [0, 1, 2, 1000]) out.push({ ...base, [k]: n })
  for (const duration of [0, 0.04, 59.96, 60, 3599.5, 3725.4]) out.push({ ...base, duration })
  out.push({ ...base, cuts: 1, zooms: 1, captions: 1, graphics: 1, texts: 1, shapes: 1, images: 1, chapters: 1, freezes: 1, trimmed: true })
  out.push({ duration: 0, cuts: 0, zooms: 0, captions: 0, graphics: 0, texts: 0, shapes: 0, images: 0, chapters: 0, freezes: 0, trimmed: false })
  return out
}

describe('Versions in the UI language', () => {
  it('gives the English summary line and comparison of versions.ts for every summary of the grid', () => {
    const all = grid()
    for (const s of all) expect(words.summaryLine(s)).toBe(en.summaryLine(s))
    for (const a of all) for (const b of all) expect(words.compareSummaries(a, b)).toEqual(en.compareSummaries(a, b))
    expect(words.compareSummaries(base, { ...base, trimmed: true })).toEqual([{ label: 'Start or end trimmed', version: 'No', now: 'Yes' }])
  })

  it('names every part changedAreas can give, and the files main says changed, with today’s words', () => {
    for (const name of en.CHANGED_AREA_NAMES) {
      expect(words.areaName(name)).toBe(name)
      // A message, not the name passed through: in another language the key is looked up.
      setCatalogue({ language: 'bn', messages: {}, formatLocale: 'bn-BD', dir: 'ltr' })
      expect(words.areaName(name)).toBe(name)
      setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
    }
    expect(new Set(en.CHANGED_AREA_NAMES).size).toBe(en.CHANGED_AREA_NAMES.length)
    expect(words.areaName('background image')).toBe('background image')
    expect(words.areaName('cursor image')).toBe('cursor image')
    expect(words.areaName('something new')).toBe('something new')
  })

  it('says the files’ notices as versions.ts does', () => {
    const kinds = ['background image', 'cursor image', 'logo', 'music', 'image', 'font', 'colour LUT']
    for (const k of kinds) expect(words.fileKindName(k)).toBe(k)
    const cases: string[][] = [[], ['background image'], ['cursor image'], ['background image', 'cursor image'], ['cursor image', 'background image', 'cursor image']]
    for (const c of cases) expect(words.changedFilesNotice(c)).toBe(en.changedFilesNotice(c))
    const missing: string[][] = [[], ['music'], ['font'], ['image', 'image'], ['music', 'image'], ['music', 'image', 'font', 'colour LUT', 'logo']]
    for (const m of missing) expect(words.missingFilesNotice(m)).toBe(en.missingFilesNotice(m))
  })

  it('counts in the format locale’s digits outside English', () => {
    setCatalogue({ language: 'bn', messages: {}, formatLocale: 'bn-BD', dir: 'ltr' })
    try {
      expect(words.summaryLine({ ...base, shapes: 0 })).toBe('২:১৩ · ৩ cuts · ৫ zooms · ৪২ captions')
    } finally {
      setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
    }
  })
})
