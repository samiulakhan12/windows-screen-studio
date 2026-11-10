/**
 * Test 64 (docs/design/output-and-languages.md §16.3, §12.3, §13.4): en-XA adds brackets and at least
 * 40% length and keeps placeholders; bn-XA writes Bengali letters with reph, chandrabindu and
 * below-base forms, about 30% longer, and keeps placeholders; ar-XB keeps placeholders, reverses the
 * text inside right-to-left marks and sets the page right to left. Every English message of this
 * repository goes through each and still parses with the same placeholders and tags.
 */
import { describe, expect, it } from 'vitest'
import { parseIcu, argumentsOf, type IcuNode } from '../src/shared/i18n/icu'

const pseudo = require('../scripts/i18n/lib/pseudo.cjs') as {
  pseudoMessage(locale: string, english: string): string
  pseudoDir(locale: string): string
  pseudoCatalogue(locale: string, english: Record<string, string>, meta: Record<string, object>): { dir: string; messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
  printIcu(nodes: IcuNode[]): string
}
const files = require('../scripts/i18n/lib/files.cjs') as { readEnglish(): { messages: Record<string, string>; meta: Record<string, object> } }

/** Every text node's value, in order. */
function texts(nodes: IcuNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.kind === 'text') out.push(n.value)
    else if (n.kind === 'tag') out.push(...texts(n.children))
    else if (n.kind === 'plural' || n.kind === 'select') for (const o of Object.values(n.options)) out.push(...texts(o))
  }
  return out
}
const tags = (nodes: IcuNode[]): string[] => nodes.flatMap((n) => (n.kind === 'tag' ? [n.name, ...tags(n.children)] : n.kind === 'plural' || n.kind === 'select' ? Object.values(n.options).flatMap(tags) : []))
const graphemes = (s: string) => [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(s)].length
const args = (s: string) => [...argumentsOf(parseIcu(s))].sort()

const SENTENCE = 'Export {name} as a transparent overlay with <b>{codec}</b> quickly'

describe('test 64: pseudo-locales', () => {
  it('en-XA adds brackets and 40% and keeps placeholders, tags and plurals', () => {
    const out = pseudo.pseudoMessage('en-XA', SENTENCE)
    expect(out.startsWith('[') && out.endsWith(']')).toBe(true)
    expect(args(out)).toEqual(['codec', 'name'])
    expect(tags(parseIcu(out))).toEqual(['b'])
    const englishText = texts(parseIcu(SENTENCE)).join('')
    const pseudoText = texts(parseIcu(out)).join('')
    expect(graphemes(pseudoText)).toBeGreaterThanOrEqual(Math.ceil(graphemes(englishText) * 1.4))
    expect(pseudoText).not.toMatch(/[A-Za-z]/)
    expect(pseudo.pseudoMessage('en-XA', 'Export the video')).toBe('[Ēẋƥōŕţ ţĥĕ ṽĩďĕō ····]')
    const plural = pseudo.pseudoMessage('en-XA', '{count, plural, one {{n} file} other {{n} files}}')
    expect(plural).toBe('[{count, plural, one {{n} ƒĩĺĕ} other {{n} ƒĩĺĕš}} ·]')
  })

  it('bn-XA writes Bengali with reph, chandrabindu and below-base forms, about 30% longer, and keeps placeholders', () => {
    const out = pseudo.pseudoMessage('bn-XA', SENTENCE)
    expect(args(out)).toEqual(['codec', 'name'])
    const text = texts(parseIcu(out)).join('')
    expect(text).not.toMatch(/[A-Za-z]/)
    for (const mark of ['র্', 'ঁ', '্র', 'ু', 'ৃ']) expect(text, mark).toContain(mark)
    const letters = texts(parseIcu(SENTENCE)).join('').replace(/[^A-Za-z]/g, '').length
    const syllables = graphemes(text.replace(/[\s]/g, ''))
    expect(syllables).toBeGreaterThanOrEqual(Math.floor(letters * 1.3))
    expect(syllables).toBeLessThanOrEqual(Math.ceil(letters * 1.5))
    expect(pseudo.pseudoMessage('bn-XA', '{n} · 30 fps')).toMatch(/^\{n\} · 30 \S+$/)
  })

  it('ar-XB reverses the text inside right-to-left marks, keeps placeholders and sets rtl', () => {
    expect(pseudo.pseudoMessage('ar-XB', 'Save {name} now')).toBe('\u200f evaS{name}won \u200f')
    expect(args(pseudo.pseudoMessage('ar-XB', SENTENCE))).toEqual(['codec', 'name'])
    expect([pseudo.pseudoDir('ar-XB'), pseudo.pseudoDir('en-XA'), pseudo.pseudoDir('bn-XA')]).toEqual(['rtl', 'ltr', 'ltr'])
    expect(pseudo.pseudoCatalogue('ar-XB', { 'a.b': 'Hi' }, { 'a.b': { description: 'x', digits: 'latn', user: ['n'] } })).toEqual({ locale: 'ar-XB', dir: 'rtl', messages: { 'a.b': '\u200fiH\u200f' }, latn: ['a.b'], user: { 'a.b': ['n'] } })
  })

  it('keeps every English message of this repository whole in each pseudo-locale', () => {
    const { messages } = files.readEnglish()
    for (const [key, english] of Object.entries(messages)) {
      const nodes = parseIcu(english)
      expect(parseIcu(pseudo.printIcu(nodes)), key).toEqual(nodes)
      for (const locale of ['en-XA', 'bn-XA', 'ar-XB']) {
        const out = pseudo.pseudoMessage(locale, english)
        expect(args(out), `${locale} ${key}`).toEqual(args(english))
        expect(tags(parseIcu(out)), `${locale} ${key}`).toEqual(tags(nodes))
      }
    }
  })

  it('prints text that looks like syntax quoted, so it reads back the same', () => {
    const nodes: IcuNode[] = [{ kind: 'text', value: "It's {not} a <tag>, a'{b}" }, { kind: 'plural', name: 'n', offset: 0, options: { other: [{ kind: 'text', value: '# sign' }] } }]
    expect(parseIcu(pseudo.printIcu(nodes))).toEqual(nodes)
  })
})
