/**
 * The guide as Markdown (docs/design/smart-tools.md §5.6): test 23 of §22.1.
 */
import { describe, expect, it } from 'vitest'
import type { GuideDoc, GuideImage } from '../src/shared/guide/guideDoc'
import { escapeMarkdown, guideMarkdown } from '../src/shared/guide/guideMarkdown'
import { GUIDE_WORDS } from '../src/shared/guide/guideWords'

const img: GuideImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', width: 10, height: 10 }

function doc(n: number, patch: Partial<GuideDoc> = {}): GuideDoc {
  return {
    title: 'Billing demo',
    lang: 'en',
    words: GUIDE_WORDS.en,
    digits: 'western',
    steps: Array.from({ length: n }, (_, i) => ({ n: String(i + 1), label: `Step ${i + 1}`, title: i ? `Step title ${i + 1}` : 'Click “Export”', image: img, alt: `Step ${i + 1}: ${i ? `Step title ${i + 1}` : 'Click “Export”'}`, ...(i === 0 ? { text: 'Now we export the report.' } : {}) })),
    ...patch
  }
}

describe('test 23: Markdown', () => {
  it('the guide’s layout: # title, ## n. title, the image, the note', () => {
    const { markdown, images } = guideMarkdown(doc(1))
    expect(markdown).toBe('# Billing demo\n\n## 1. Click “Export”\n\n![Step 1: Click “Export”](images/step-01.png)\n\nNow we export the report\\.\n')
    expect(images).toEqual(['step-01.png'])
  })

  it('every CommonMark punctuation character in a title, Type line and note is escaped', () => {
    const all = '\\ ` * _ { } [ ] < > ( ) # + - . ! |'
    expect(escapeMarkdown(all)).toBe('\\\\ \\` \\* \\_ \\{ \\} \\[ \\] \\< \\> \\( \\) \\# \\+ \\- \\. \\! \\|')
    const d = doc(1)
    d.steps[0].title = `T ${all}`
    d.steps[0].type = `billing@example.com ${all}`
    d.steps[0].text = `N ${all}`
    const { markdown } = guideMarkdown(d)
    const esc = escapeMarkdown(all)
    expect(markdown).toContain(`## 1. T ${esc}`)
    expect(markdown).toContain(`Type: billing@example\\.com ${esc}`)
    expect(markdown).toContain(`N ${esc}`)
  })

  it('<b> stays text; no raw HTML passes; a link is not a link', () => {
    const d = doc(1)
    d.steps[0].title = '<b>bold</b> [x](javascript:alert(1)) <img src=x onerror=alert(1)>'
    const { markdown } = guideMarkdown(d)
    expect(markdown).toContain('\\<b\\>bold\\</b\\> \\[x\\]\\(javascript:alert\\(1\\)\\) \\<img src=x onerror=alert\\(1\\)\\>')
    expect(markdown).not.toMatch(/(^|[^\\])<b>/)
  })

  it('image names step-01.png … step-12.png', () => {
    const { markdown, images } = guideMarkdown(doc(12))
    expect(images).toEqual(Array.from({ length: 12 }, (_, i) => `step-${String(i + 1).padStart(2, '0')}.png`))
    expect(markdown).toContain('](images/step-12.png)')
  })

  it('the bug report: Steps to reproduce, Expected, Actual with actual.png, Details', () => {
    const d = doc(2, { bug: { expected: 'What should happen', actual: 'What happens instead', actualImage: img, details: ['Recorded on 7 November 2026', 'Screen 1920 × 1080 at 150%'] } })
    const { markdown, images } = guideMarkdown(d)
    expect(markdown).toBe(
      [
        '# Billing demo',
        '',
        '## Steps to reproduce',
        '',
        '1. Click “Export”',
        '   ![Step 1: Click “Export”](images/step-01.png)',
        '   Now we export the report\\.',
        '2. Step title 2',
        '   ![Step 2: Step title 2](images/step-02.png)',
        '',
        '## Expected',
        '',
        'What should happen',
        '',
        '## Actual',
        '',
        'What happens instead',
        '',
        '![Actual](images/actual.png)',
        '',
        '## Details',
        '',
        '- Recorded on 7 November 2026',
        '- Screen 1920 × 1080 at 150%',
        ''
      ].join('\n')
    )
    expect(images).toEqual(['step-01.png', 'step-02.png', 'actual.png'])
  })

  it('sections as ## with steps as ###', () => {
    const d = doc(2)
    d.steps[0].section = 'Set up'
    d.steps[1].section = 'Billing'
    const { markdown } = guideMarkdown(d)
    expect(markdown).toContain('## Set up\n\n### 1. Click “Export”')
    expect(markdown).toContain('## Billing\n\n### 2. Step title 2')
  })

  it('Bangla text unchanged', () => {
    const d = doc(1, { lang: 'bn', words: GUIDE_WORDS.bn, title: 'বিলিং গাইড' })
    d.steps[0].n = '১'
    d.steps[0].title = '“রপ্তানি”-এ ক্লিক করুন'
    d.steps[0].text = 'এখন রিপোর্টটি রপ্তানি করুন।'
    const { markdown } = guideMarkdown(d)
    expect(markdown).toContain('# বিলিং গাইড')
    expect(markdown).toContain('## ১. “রপ্তানি”\\-এ ক্লিক করুন')
    expect(markdown).toContain('এখন রিপোর্টটি রপ্তানি করুন।')
  })
})
