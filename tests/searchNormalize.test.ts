import { describe, expect, it } from 'vitest'
import { editDistance, prefixDistance } from '../src/shared/search/distance'
import { normalizeText, queryTerms, tokenize } from '../src/shared/search/normalize'

const terms = (s: string): string[] => tokenize(s).map((t) => t.term)

describe('normalizeText', () => {
  it('folds case and Latin, Greek and Cyrillic accents', () => {
    expect(normalizeText('Café Crème')).toBe('cafe creme')
    expect(normalizeText('ÉLAN Ñandú')).toBe('elan nandu')
    expect(normalizeText('Ἀθῆναι')).toBe('αθηναι')
    expect(normalizeText('Ёлка')).toBe('елка')
  })

  it('keeps Bangla vowel signs and hasanta (letters there, not accents)', () => {
    // কাল (time) and কল (call) differ only by the vowel sign া.
    expect(normalizeText('কাল')).not.toBe(normalizeText('কল'))
    expect(normalizeText('ক্ষমা')).toBe('ক্ষমা'.normalize('NFC'))
    expect(normalizeText('हिन्दी')).toBe('हिन्दी')
  })

  it('treats the precomposed and nukta forms of Bangla letters alike', () => {
    expect(normalizeText('য়')).toBe(normalizeText('য়')) // য়
    expect(normalizeText('ড়')).toBe(normalizeText('ড়')) // ড়
  })

  it('drops joiners, soft hyphens and apostrophes; folds compatibility forms', () => {
    expect(normalizeText('র‍্যাব')).toBe(normalizeText('র্যাব'))
    expect(normalizeText('ক্‌ষ')).toBe('ক্ষ'.normalize('NFC'))
    expect(normalizeText('don’t')).toBe('dont')
    expect(normalizeText('ＦＬＯＷＮ')).toBe('flown')
    expect(normalizeText('ﬁle')).toBe('file')
  })
})

describe('tokenize', () => {
  it('splits words and keeps their range in the original text', () => {
    const text = 'Open the  Settings, then click “Save”.'
    const tokens = tokenize(text)
    expect(tokens.map((t) => t.term)).toEqual(['open', 'the', 'settings', 'then', 'click', 'save'])
    for (const t of tokens) expect(normalizeText(text.slice(t.start, t.end))).toBe(t.term)
  })

  it('keeps apostrophes inside a word as one term', () => {
    expect(terms("Don't stop, it's l’été")).toEqual(['dont', 'stop', 'its', 'lete'])
  })

  it('keeps Bangla words whole, joiners included', () => {
    expect(terms('আমি বাংলায় কথা বলি।')).toEqual(['আমি', normalizeText('বাংলায়'), 'কথা', 'বলি'])
    expect(terms('র‍্যাব')).toEqual([normalizeText('র্যাব')])
  })

  it('splits Chinese, Japanese and Thai with the word breaker', () => {
    const zh = terms('我喜欢录屏')
    expect(zh.length).toBeGreaterThan(1)
    expect(zh.join('')).toBe('我喜欢录屏')
    const th = terms('ภาษาไทยง่าย')
    expect(th.length).toBeGreaterThan(1)
    expect(th.join('')).toBe('ภาษาไทยง่าย')
    // Mixed text: the Latin word stays whole.
    expect(terms('Flown 很好')).toContain('flown')
  })

  it('caps very long terms at 40 code points', () => {
    const long = 'a'.repeat(60)
    expect(terms(long)[0]).toHaveLength(40)
    const bn = 'ক'.repeat(50)
    expect(Array.from(terms(bn)[0])).toHaveLength(40)
  })

  it('splits what compatibility folding turns into separate words', () => {
    expect(terms('½')).toEqual(['1', '2'])
  })

  it('returns nothing for empty or non-text input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('  ,. — ')).toEqual([])
    expect(tokenize(undefined as unknown as string)).toEqual([])
  })
})

describe('queryTerms', () => {
  it('keeps each word once, in order, at most 8', () => {
    expect(queryTerms('the Settings the page')).toEqual(['the', 'settings', 'page'])
    expect(queryTerms('a b c d e f g h i j')).toHaveLength(8)
  })

  it('reads at most 200 characters', () => {
    expect(queryTerms(`${'x'.repeat(199)} later`)).toEqual(['x'.repeat(40)])
  })
})

describe('editDistance and prefixDistance', () => {
  it('counts insertions, deletions, substitutions and swaps as one', () => {
    expect(editDistance('settings', 'setings', 2)).toBe(1)
    expect(editDistance('record', 'recrod', 2)).toBe(1)
    expect(editDistance('record', 'rekord', 2)).toBe(1)
    expect(editDistance('record', 'recordx', 2)).toBe(1)
    expect(editDistance('abc', 'abc', 1)).toBe(0)
  })

  it('stops at max + 1', () => {
    expect(editDistance('settings', 'banana', 1)).toBe(2)
    expect(editDistance('a', 'abcdef', 2)).toBe(3)
  })

  it('works on code points (a Bangla vowel sign is one character)', () => {
    expect(editDistance('কাল', 'কল', 2)).toBe(1)
    expect(editDistance('😀a', '😀b', 1)).toBe(1)
  })

  it('measures against the closest prefix of the term', () => {
    expect(prefixDistance('setin', 'settings', 1)).toBe(1)
    expect(prefixDistance('recrod', 'recording', 1)).toBe(1)
    expect(prefixDistance('settings', 'settings', 1)).toBe(0)
    expect(prefixDistance('xyzw', 'settings', 1)).toBe(2)
    expect(prefixDistance('settings', 'set', 1)).toBe(2)
  })
})
