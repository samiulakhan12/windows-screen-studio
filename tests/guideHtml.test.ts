/**
 * The guide's HTML (docs/design/smart-tools.md §5.6, §6, §16 rule 9): tests 24, 25, 26 and the
 * page side of 109 and 114 of §22.1. Every page is read with a strict parser (tests/strictHtml.ts).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../src/shared/captions/colors'
import type { GuideDoc, GuideImage } from '../src/shared/guide/guideDoc'
import { DEMO_SCRIPT, DEMO_SCRIPT_HASH, escapeHtml, GUIDE_COLOURS, guideFontWeights, guideHtml, guidePalette, guideText, PRINT_FONTS } from '../src/shared/guide/guideHtml'
import { GUIDE_WORDS } from '../src/shared/guide/guideWords'
import { readLinkUrl } from '../src/shared/smart/privateText'
import { elements, hasClass, parseStrict, textOf, type Element } from './strictHtml'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const image = (w = 960, h = 540, mime: GuideImage['mime'] = 'image/webp'): GuideImage => ({ bytes: PNG, mime, width: w, height: h })

function doc(titles: string[], patch: Partial<GuideDoc> = {}, lang: 'en' | 'bn' = 'en'): GuideDoc {
  const words = GUIDE_WORDS[lang]
  return {
    title: 'Billing demo',
    lang,
    words,
    digits: 'western',
    steps: titles.map((title, i) => ({
      n: String(i + 1),
      label: `Step ${i + 1}`,
      title,
      text: `Note ${i + 1}`,
      image: image(),
      alt: `Step ${i + 1}: ${title}`,
      hotspot: { x: 0.3, y: 0.4 }
    })),
    ...patch
  }
}

const NASTY = [
  '</script><script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  'a\u2028b\u2029c',
  '\u202eevil\u202c \u2066x\u2069',
  'nul\u0000here',
  "it's & <b>bold</b>",
  '</style><style>*{background:url(https://evil.example/x)}</style>'
]

/** Attributes that hold a URL. */
const URL_ATTRS = new Set(['src', 'href', 'action', 'formaction', 'poster', 'background', 'xlink:href', 'srcset', 'cite', 'data'])

function checkSafe(html: string, opts: { demo: boolean; link: string | null }): Element {
  const root = parseStrict(html)
  const all = elements(root)
  for (const el of all) {
    for (const [k, v] of Object.entries(el.attrs)) {
      expect(k.startsWith('on'), `${el.name} ${k}`).toBe(false)
      if (URL_ATTRS.has(k)) {
        const ok = v.startsWith('data:') || (opts.link !== null && v === opts.link && el.name === 'a')
        expect(ok, `${el.name} ${k}=${v.slice(0, 60)}`).toBe(true)
      }
      if (k === 'style') expect(/url\(/i.test(v)).toBe(false)
    }
  }
  // CSS urls are data: only.
  for (const style of all.filter((e) => e.name === 'style')) {
    for (const m of textOf(style).matchAll(/url\(([^)]*)\)/gi)) expect(m[1].startsWith('data:'), m[1].slice(0, 40)).toBe(true)
  }
  const links = all.filter((e) => e.name === 'a')
  expect(links.length).toBe(opts.link ? 1 : 0)
  if (opts.link) {
    expect(links[0].attrs.href).toBe(opts.link)
    expect(links[0].attrs.rel).toBe('noopener noreferrer')
  }
  const scripts = all.filter((e) => e.name === 'script')
  expect(scripts.length).toBe(opts.demo ? 1 : 0)
  const csp = all.find((e) => e.name === 'meta' && e.attrs['http-equiv'] === 'Content-Security-Policy')!.attrs.content
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("base-uri 'none'")
  expect(csp).toContain("form-action 'none'")
  if (opts.demo) {
    const text = textOf(scripts[0])
    const hash = `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
    expect(hash).toBe(DEMO_SCRIPT_HASH)
    expect(csp).toContain(`script-src '${hash}'`)
  } else expect(csp).not.toContain('script-src')
  expect(all.some((e) => e.name === 'meta' && e.attrs.name === 'referrer' && e.attrs.content === 'no-referrer')).toBe(true)
  return root
}

describe('test 24: HTML safety', () => {
  const clean = (t: string): string => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

  it('DEMO_SCRIPT_HASH is the script’s SHA-256, and the script holds no text and no < or &', () => {
    expect(DEMO_SCRIPT_HASH).toBe(`sha256-${createHash('sha256').update(DEMO_SCRIPT, 'utf8').digest('base64')}`)
    expect(/[<&]/.test(DEMO_SCRIPT)).toBe(false)
  })

  for (const demo of [false, true]) {
    it(`nasty titles, notes, Type lines and end screen stay text (${demo ? 'demo' : 'guide'})`, () => {
      const link = readLinkUrl('https://example.com/start?a=1&b="2"')
      const d = doc(NASTY, {
        intro: NASTY.join(' '),
        end: { heading: NASTY[0], label: NASTY[1], url: link ?? undefined }
      })
      d.steps.forEach((s, i) => {
        s.type = NASTY[(i + 1) % NASTY.length]
        s.text = NASTY[(i + 2) % NASTY.length]
        s.section = i === 0 ? NASTY[3] : undefined
      })
      const html = guideHtml(d, { demo, print: false, fonts: [] })
      const root = checkSafe(html, { demo, link: demo ? link : null })
      const titles = elements(root).filter((e) => hasClass(e, 'title'))
      expect(titles.map(textOf)).toEqual(NASTY.map(clean))
      for (const t of titles) expect(t.children.every((c) => typeof c === 'string')).toBe(true)
      const types = elements(root).filter((e) => hasClass(e, 'type'))
      expect(types.map(textOf)).toEqual(d.steps.map((s) => clean(`Type: ${s.type}`)))
    })
  }

  it('an end-screen link readLinkUrl refuses is left out', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:pw@host/']) {
      const html = guideHtml(doc(['A'], { end: { heading: 'Done', label: 'Go', url } }), { demo: true, print: false, fonts: [] })
      checkSafe(html, { demo: true, link: null })
    }
  })

  it('the print form and the clipboard form have no script', () => {
    const d = doc(NASTY)
    checkSafe(guideHtml(d, { demo: true, print: true, fonts: [] }), { demo: false, link: null })
    const clip = guideHtml(d, { demo: false, print: false, clipboard: true, fonts: [{ family: 'Hind Siliguri', weight: 400, woff2: PNG }] })
    const root = parseStrict(clip)
    expect(elements(root).some((e) => e.name === 'script')).toBe(false)
    expect(clip).not.toContain('@font-face')
    for (const el of elements(root)) for (const k of Object.keys(el.attrs)) expect(k.startsWith('on')).toBe(false)
  })

  it('escapeHtml escapes & < > " \' and drops NUL', () => {
    expect(escapeHtml(`a&b<c>d"e'f\u0000g`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;fg')
  })
})

describe('test 25: HTML structure', () => {
  const html = guideHtml(doc(['Click “Export”', 'Press Ctrl + S', 'Type your text']), { demo: false, print: false, fonts: [] })
  const root = parseStrict(html)
  const all = elements(root)

  it('lang on <html>, a <title> equal to the guide’s title, one <h1>, an <h2> per step, alt on every image', () => {
    expect(all.find((e) => e.name === 'html')!.attrs.lang).toBe('en')
    expect(textOf(all.find((e) => e.name === 'title')!)).toBe('Billing demo')
    expect(all.filter((e) => e.name === 'h1')).toHaveLength(1)
    expect(all.filter((e) => e.name === 'h2')).toHaveLength(3)
    const imgs = all.filter((e) => e.name === 'img')
    expect(imgs).toHaveLength(3)
    for (const img of imgs) {
      expect(img.attrs.alt).toMatch(/^Step \d: /)
      expect(img.attrs.width).toBe('960')
      expect(img.attrs.height).toBe('540')
    }
  })

  it('dir="auto" on titles, notes and callouts; the hotspot is named', () => {
    for (const e of all.filter((x) => x.name === 'h2' || hasClass(x, 'note') || x.name === 'h1')) expect(e.attrs.dir, e.name).toBe('auto')
    const demo = elements(parseStrict(guideHtml(doc(['Click “Export”']), { demo: true, print: false, fonts: [] })))
    const callout = demo.find((e) => hasClass(e, 'callout'))!
    expect(callout.attrs.dir).toBe('auto')
    expect(demo.find((e) => hasClass(e, 'hotspot'))!.attrs['aria-label']).toBe('Click “Export”. Next step')
    expect(demo.find((e) => hasClass(e, 'live'))!.attrs['aria-live']).toBe('polite')
  })

  it('both colour schemes’ text pairs at 4.5:1 or more, the hotspot ring at 3:1', () => {
    for (const c of [GUIDE_COLOURS.light, GUIDE_COLOURS.dark]) {
      for (const fg of [c.text, c.muted, c.heading, c.accent]) expect(contrastRatio(fg, c.page), fg).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c.text, c.panel)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c.muted, c.panel)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c.buttonText, c.button)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c.button, c.page)).toBeGreaterThanOrEqual(3)
    }
    expect(html).toContain(`--text: ${GUIDE_COLOURS.light.text}`)
    expect(html).toContain('@media (prefers-color-scheme: dark)')
  })

  it('the PDF form has page numbers, the page size, the static fonts and no dark scheme', () => {
    const print = guideHtml(doc(['A']), { demo: false, print: true, fonts: [], page: 'Letter' })
    expect(print).toContain('@page { size: Letter; margin: 16mm 14mm;')
    expect(print).toContain('counter(page) " / " counter(pages)')
    expect(print).toContain(PRINT_FONTS)
    expect(print).not.toContain('prefers-color-scheme')
    const bn = guideHtml(doc(['ক'], {}, 'bn'), { demo: false, print: true, fonts: [] })
    expect(bn).toContain('"পৃষ্ঠা " counter(page, bengali) " / " counter(pages, bengali)')
    expect(bn).toContain('size: A4')
  })

  it('a bug report adds Steps to reproduce, Expected, Actual with its screenshot and Details', () => {
    const d = doc(['Click “Export”'], { bug: { expected: 'A report', actual: 'An error', actualImage: image(), details: ['Recorded on 7 November 2026', 'Length 4:12'] } })
    const r = elements(parseStrict(guideHtml(d, { demo: false, print: false, fonts: [] })))
    expect(r.filter((e) => e.name === 'h2').map(textOf)).toEqual(['Steps to reproduce', 'Click “Export”'.replace(/^/, '1. '), 'Expected', 'Actual', 'Details'].map((t) => t))
    expect(r.filter((e) => e.name === 'img').map((e) => e.attrs.alt)).toEqual(['Step 1: Click “Export”', 'Actual'])
    expect(r.filter((e) => e.name === 'li' && !hasClass(e, 'step')).map(textOf)).toEqual(['Recorded on 7 November 2026', 'Length 4:12'])
  })
})

describe('test 26: fonts', () => {
  const font = (weight: number) => ({ family: 'Hind Siliguri', weight, woff2: new Uint8Array([0x77, 0x4f, 0x46, 0x32, weight & 255]) })

  it('Bangla text embeds Hind Siliguri 400 and 600 with the OFL notice; without Bangla, none', () => {
    const bn = doc(['“রপ্তানি”-এ ক্লিক করুন'], {}, 'bn')
    expect(guideFontWeights(bn, false)).toEqual([400, 600])
    expect(guideFontWeights(doc(['Click']), false)).toEqual([])
    const html = guideHtml(bn, { demo: false, print: false, fonts: guideFontWeights(bn, false).map(font) })
    expect(html.match(/@font-face/g)).toHaveLength(2)
    expect(html).toContain('font-weight: 400')
    expect(html).toContain('font-weight: 600')
    expect(html).toContain('SIL Open Font License')
    expect(html).toContain('url(data:font/woff2;base64,')
    expect(guideHtml(doc(['Click']), { demo: false, print: false, fonts: [] })).not.toContain('@font-face')
  })

  it('the print HTML names only static families', () => {
    const print = guideHtml(doc(['Click']), { demo: false, print: true, fonts: guideFontWeights(doc(['Click']), true).map(font) })
    const families = [...print.matchAll(/font-family: ([^;]+);/g)].flatMap((m) => m[1].split(',').map((f) => f.trim().replace(/"/g, '')))
    const allowed = new Set(['Hind Siliguri', 'Segoe UI', 'Nirmala UI', 'Leelawadee UI', 'Yu Gothic UI', 'Malgun Gothic', 'Microsoft YaHei UI', 'sans-serif'])
    for (const f of families) expect(allowed.has(f), f).toBe(true)
    expect(print).not.toMatch(/Noto|Variable|system-ui/)
  })

  it('the clipboard HTML embeds no font', () => {
    const bn = doc(['ক'], {}, 'bn')
    expect(guideHtml(bn, { demo: false, print: false, clipboard: true, fonts: [font(400), font(600)] })).not.toContain('@font-face')
  })
})

describe('test 109: the demo page', () => {
  it('the end screen renders its heading, label and one link, and Start again', () => {
    const d = doc(['A', 'B'], { end: { heading: 'You are ready', label: 'Open the app', url: 'https://example.com/start' } })
    const r = elements(checkSafe(guideHtml(d, { demo: true, print: false, fonts: [] }), { demo: true, link: 'https://example.com/start' }))
    const end = r.find((e) => hasClass(e, 'end'))!
    expect(textOf(elements(end).find((e) => e.name === 'h2')!)).toBe('You are ready')
    expect(textOf(elements(end).find((e) => e.name === 'a')!)).toBe('Open the app')
    expect(elements(end).find((e) => e.name === 'a')!.attrs.target).toBe('_blank')
    expect(textOf(r.find((e) => hasClass(e, 'again'))!)).toBe('Start again')
    expect(r.filter((e) => e.name === 'button').map(textOf).filter(Boolean)).toEqual(['Back', 'Next', 'Start again'])
  })

  it('callouts sit beside the hotspot: right of one at x 0.3, left of one at x 0.7, the corner without one', () => {
    const d = doc(['A', 'B', 'C'])
    d.steps[1].hotspot = { x: 0.7, y: 0.4 }
    d.steps[2].hotspot = undefined
    const r = elements(parseStrict(guideHtml(d, { demo: true, print: false, fonts: [] })))
    expect(r.filter((e) => hasClass(e, 'callout')).map((e) => e.attrs['data-side'])).toEqual(['right', 'left', 'corner'])
    const spots = r.filter((e) => hasClass(e, 'hotspot'))
    expect(spots).toHaveLength(2)
    expect(spots[0].attrs.style).toBe('left: 30.0000%; top: 40.0000%;')
    expect(r.filter((e) => hasClass(e, 'count')).map(textOf)).toEqual(['Step 1 of 3', 'Step 2 of 3', 'Step 3 of 3'])
  })

  it('in Bangla the demo’s words are Bangla', () => {
    const d = doc(['ক', 'খ'], {}, 'bn')
    d.steps.forEach((s, i) => (s.n = ['১', '২'][i]))
    const r = elements(parseStrict(guideHtml(d, { demo: true, print: false, fonts: [] })))
    expect(r.filter((e) => e.name === 'button' && !hasClass(e, 'hotspot')).map(textOf)).toEqual(['আগের ধাপ', 'পরের ধাপ', 'আবার শুরু'])
    expect(r.filter((e) => hasClass(e, 'count')).map(textOf)).toEqual(['ধাপ ১ / ২', 'ধাপ ২ / ২'])
    expect(r.filter((e) => e.name === 'summary').map(textOf)).toEqual(['আরও', 'আরও'])
  })
})

describe('test 114: the brand kit in the page', () => {
  it('the logo is in the header and the heading colour is the kit’s first colour where it has 4.5:1', () => {
    const d = doc(['A'], { brand: { logo: image(120, 40, 'image/png'), colour: '#b00020' } })
    const r = elements(parseStrict(guideHtml(d, { demo: false, print: false, fonts: [] })))
    const logo = r.find((e) => hasClass(e, 'logo'))!
    expect(logo.attrs.alt).toBe('')
    expect(logo.attrs.src.startsWith('data:image/png;base64,')).toBe(true)
    const p = guidePalette('#b00020')
    expect(p.light.heading).toBe('#b00020')
    expect(p.dark.heading).toBe(GUIDE_COLOURS.dark.heading)
    expect(p.light.button).toBe('#b00020')
    const pale = guidePalette('#ffd400')
    expect(pale.light.heading).toBe(GUIDE_COLOURS.light.heading)
    expect(pale.dark.heading).toBe('#ffd400')
    expect(pale.light.button).toBe(GUIDE_COLOURS.light.button)
    expect(guideHtml(d, { demo: false, print: false, fonts: [] })).toContain('--heading: #b00020')
  })

  it('without a brand, neither', () => {
    const html = guideHtml(doc(['A']), { demo: false, print: false, fonts: [] })
    expect(html).not.toContain('class="logo"')
    expect(html).toContain(`--heading: ${GUIDE_COLOURS.light.heading}`)
  })
})

describe('guideText', () => {
  it('numbered titles, Type lines and notes', () => {
    const d = doc(['Click “Export”', 'Press Ctrl + S'])
    d.steps[0].type = 'billing@example.com'
    expect(guideText(d)).toBe('Billing demo\n\n1. Click “Export”\nType: billing@example.com\nNote 1\n\n2. Press Ctrl + S\nNote 2\n')
  })
})
