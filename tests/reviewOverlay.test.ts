/**
 * Test 67 (docs/design/output-and-languages.md §15.4, §23.1): ReviewOverlay renders nothing in a
 * packaged build or without FLOWN_I18N_REVIEW. It shows only over a catalogue written for review,
 * whose messages carry marks; a packaged build ships only built catalogues, which the checks keep
 * free of marks, and the review build writes marks only with FLOWN_I18N_REVIEW=1. Also the review
 * catalogue's states and the review pack's page.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { setCatalogue } from '../src/shared/i18n/t'
import { ReviewOverlay, readMarks, reviewMode } from '../src/renderer/src/i18n/reviewOverlay'
import { englishTree, makeTree, removeTree, toolsTree } from './i18nFixtures'

type Entry = { text: string; state: string; sourceHash: string; reviewedBy?: string; approvedBy?: string }
const review = require('../scripts/i18n/lib/review.cjs') as {
  reviewMark(key: string, state: string, labels: boolean): string
  reviewCatalogue(o: { lang: string; english: Record<string, string>; meta: Record<string, object>; translations: Record<string, Entry>; marks?: 'hover' | 'labels' | null }): { catalogue: { messages: Record<string, string>; latn: string[]; user: object }; states: Record<string, string> }
  liveMarks(env: Record<string, string | undefined>): string | null
  keysOnScreen(text: string): string[]
  packPage(o: { lang: string; screens: { name: string; keys: string[] }[]; overflow?: string[]; english: Record<string, string>; translations: Record<string, Entry>; states: Record<string, string> }): string
}
const files = require('../scripts/i18n/lib/files.cjs') as { sourceHash(s: string): string; readEnglish(root?: string): { messages: Record<string, string>; meta: Record<string, object> } }
const catalogue = require('../scripts/i18n/lib/catalogue.cjs') as { checkMessage(lang: string, en: string, meta: object, e: Entry): { code: string }[] }
const build = require('../scripts/i18n/lib/build.cjs') as { buildCatalogues(root: string): { files: Record<string, string> } }

const ENGLISH = { language: 'en' as const, messages: {}, formatLocale: 'en-US', dir: 'ltr' as const }
afterEach(() => setCatalogue(ENGLISH))
const render = () => renderToStaticMarkup(React.createElement(ReviewOverlay))
const bangla = (messages: Record<string, string>) => setCatalogue({ language: 'bn', messages, formatLocale: 'bn-BD', dir: 'ltr' })
const draft = (en: string, text: string, more: Partial<Entry> = {}): Entry => ({ text, state: 'draft', sourceHash: files.sourceHash(en), ...more })

describe('test 67: the review overlay', () => {
  const en = files.readEnglish()

  it('renders nothing in English', () => {
    expect(reviewMode()).toBeNull()
    expect(render()).toBe('')
  })

  it('renders nothing over a built catalogue, the only kind a packaged build has', () => {
    bangla({ 'main.confirm.cancel': 'বাতিল', 'errors.feature.notReady': 'এই সেটিং এখনো নেই।' })
    expect(reviewMode()).toBeNull()
    expect(render()).toBe('')
  })

  it('renders nothing over a review catalogue written without FLOWN_I18N_REVIEW', () => {
    expect(review.liveMarks({})).toBeNull()
    expect(review.liveMarks({ FLOWN_I18N_REVIEW: '0' })).toBeNull()
    bangla(review.reviewCatalogue({ lang: 'bn', english: en.messages, meta: en.meta, translations: {}, marks: review.liveMarks({}) as null }).catalogue.messages)
    expect(render()).toBe('')
  })

  it('shows over a review catalogue written with FLOWN_I18N_REVIEW=1, and reads each text’s key and state', () => {
    expect(review.liveMarks({ FLOWN_I18N_REVIEW: '1' })).toBe('hover')
    const translations = { 'main.confirm.cancel': draft('Cancel', 'বাতিল') }
    bangla(review.reviewCatalogue({ lang: 'bn', english: en.messages, meta: en.meta, translations, marks: 'hover' }).catalogue.messages)
    expect(reviewMode()).toEqual({ key: 'main.confirm.cancel', state: 'draft', labels: false })
    expect(render()).toBe('<div class="i18n-review-overlay" aria-hidden="true" style="position:fixed;inset:0;pointer-events:none;z-index:2147483647"></div>')
    const shown = review.reviewMark('codecs.row.codec', 'approved', true) + 'কোডেক ' + review.reviewMark('errors.stems.failed', 'english', true) + 'The sound stems could not be written.'
    expect(readMarks(shown)).toEqual([
      { key: 'codecs.row.codec', state: 'approved', labels: true },
      { key: 'errors.stems.failed', state: 'english', labels: true }
    ])
    expect(review.keysOnScreen(shown)).toEqual(['codecs.row.codec', 'errors.stems.failed'])
  })

  it('keeps marks out of every built catalogue: the checks refuse them', () => {
    const marked = draft('Cancel', review.reviewMark('main.confirm.cancel', 'draft', false) + 'বাতিল')
    expect(catalogue.checkMessage('bn', 'Cancel', { description: 'x' }, marked).map((p) => p.code)).toContain('control')
    const reviewers = [
      { id: 'a', name: 'A', languages: ['bn'], agreement: 'licence', signed: '2026-11-01' },
      { id: 'b', name: 'B', languages: ['bn'], agreement: 'licence', signed: '2026-11-01' }
    ]
    const root = makeTree({
      ...englishTree({ main: { cancel: 'Cancel' }, common: {}, errors: {} }),
      ...toolsTree(),
      'translations/reviewers.json': { reviewers },
      'translations/bn/main.json': { cancel: { ...marked, state: 'approved', reviewedBy: 'a', approvedBy: 'b' } }
    })
    try {
      expect(Object.keys(build.buildCatalogues(root).files)).toEqual(['shipped.json'])
    } finally {
      removeTree(root)
    }
  })
})

describe('the review catalogue and the review pack', () => {
  const english = { 'export.a': 'Export {name}', 'export.b': 'Save', 'export.c': 'Copy', 'export.d': 'Close' }
  const meta = { 'export.a': { description: 'a', user: ['name'] }, 'export.b': { description: 'b', digits: 'latn' }, 'export.c': { description: 'c' }, 'export.d': { description: 'd' } }
  const translations = {
    'export.a': draft('Export {name}', '{name} এক্সপোর্ট', { state: 'approved' }),
    'export.b': draft('Save the file', 'সেভ'),
    'export.c': draft('Copy', 'কপি {oops}')
  }

  it('shows the language’s text where it fits English, English otherwise, with each state', () => {
    const r = review.reviewCatalogue({ lang: 'bn', english, meta, translations })
    expect(r.catalogue).toEqual({ messages: { 'export.a': '{name} এক্সপোর্ট', 'export.b': 'Save', 'export.c': 'Copy', 'export.d': 'Close' }, latn: ['export.b'], user: { 'export.a': ['name'] } })
    expect(r.states).toEqual({ 'export.a': 'approved', 'export.b': 'stale', 'export.c': 'english', 'export.d': 'english' })
    const marked = review.reviewCatalogue({ lang: 'bn', english, meta, translations, marks: 'labels' }).catalogue.messages
    expect(readMarks(marked['export.a'])).toEqual([{ key: 'export.a', state: 'approved', labels: true }])
    expect(marked['export.a'].endsWith('{name} এক্সপোর্ট')).toBe(true)
  })

  it('writes the pack’s page as plain HTML, escaping every text', () => {
    const page = review.packPage({ lang: 'bn', screens: [{ name: 'export-settings', keys: ['export.a', 'export.d'] }], overflow: ['home-empty'], english: { ...english, 'export.d': 'Close <script>alert(1)</script>' }, translations, states: { 'export.a': 'approved' } })
    expect(page).not.toMatch(/<script/i)
    expect(page).toContain('Close &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).toContain('<img src="screens/export-settings.png"')
    expect(page).toContain('<img src="bn-XA/home-empty.png"')
    expect(page).toContain('<td lang="bn">{name} এক্সপোর্ট</td><td>approved</td>')
  })
})
