/**
 * Captions Studio test 37 (docs/design/captions-studio.md §11.3): emoji from the words, the
 * never-suggest list, sensitive topics, negations, names and density.
 */
import { describe, expect, it, vi } from 'vitest'
import { emojiForWord, emojiKey, isSensitive, suggestEmoji } from '../src/shared/captions/emoji'
import { EMOJI_TRIGGERS } from '../src/shared/captions/emojiData'
import { EMOJI_KEYS } from '../src/shared/captions/emojiList'
import { captions, studioProject } from './p4Fixtures'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))

const key = (e: string): string => emojiKey(e)
const suggested = (texts: string[], language = 'en', every = 4) => suggestEmoji(studioProject({ segments: captions(texts, 'c', every), language }))

describe('emoji (test 37)', () => {
  it('keys are code points without FE0F', () => {
    expect(emojiKey('🔥')).toBe('1f525')
    expect(emojiKey('⚙️')).toBe('2699')
    expect(emojiKey('🧑‍💻')).toBe('1f9d1-200d-1f4bb')
  })

  it('triggers by word, with the language’s endings', () => {
    expect(emojiForWord('idea')).toBe(key('💡'))
    expect(emojiForWord('Ideas!')).toBe(key('💡'))
    expect(emojiForWord('growth')).toBe(key('📈'))
    expect(emojiForWord('settings')).toBe(key('⚙️'))
    expect(emojiForWord('ideal')).toBeNull()
    expect(emojiForWord('table')).toBeNull()
  })

  it('every trigger points at an emoji the font draws, and none on the never list', () => {
    const never = ['🔪', '🔫', '💣', '🍆', '🍑', '💦', '🖕', '💩', '⚰️', '🩸', '💀', '☠️'].map(key)
    for (const [lang, words] of Object.entries(EMOJI_TRIGGERS)) {
      expect(Object.keys(words).length, lang).toBeGreaterThan(50)
      for (const k of Object.values(words)) {
        expect(EMOJI_KEYS.has(k)).toBe(true)
        expect(never).not.toContain(k)
      }
    }
  })

  it('suggests an emoji anchored to its word, 0.1 s before it', () => {
    const [g] = suggested(['Here is a great idea for you'])
    expect(g).toMatchObject({ kind: 'emoji', emoji: key('💡'), anchor: { caption: 'c0', from: 4, to: 4, text: 'idea' }, auto: { by: 'emoji', via: 'rules', caption: 'c0' }, place: 'auto' })
    expect(g.end - g.start).toBeCloseTo(1.2)
    expect(g.id).toMatch(/^g-[0-9a-f]{8}$/)
  })

  it('gives none with a negation: "We are not happy with the old price"', () => {
    expect(suggested(['We are not happy with the old price'])).toEqual([])
    expect(suggested(['আমরা দাম নিয়ে খুশি না'], 'bn')).toEqual([])
  })

  it('gives none on sensitive topics', () => {
    expect(isSensitive('Our CEO died last year, so this release is for him.')).toBe(true)
    expect(isSensitive('The war on bugs')).toBe(true)
    expect(isSensitive('The warning light')).toBe(false)
    expect(isSensitive('তিনি দুর্ঘটনায় আহত হন', 'bn')).toBe(true)
    expect(suggested(['Our CEO died last year, so this launch is for him.'])).toEqual([])
  })

  it('gives none on names: "Apple Notes", a speaker’s name', () => {
    expect(suggested(['Apple Notes keeps it'])).toEqual([])
    const p = studioProject({ segments: [{ id: 'a', start: 0, end: 3, text: 'Thanks Rocket for the help', speaker: 'Rocket' }] })
    expect(suggestEmoji(p)).toEqual([])
  })

  it('at most one per 8 s', () => {
    const out = suggested(['A great idea', 'Then a launch', 'Some money', 'More growth', 'A new idea'], 'en', 3)
    for (let i = 1; i < out.length; i++) expect(out[i].start - out[i - 1].start).toBeGreaterThanOrEqual(8)
    expect(out.length).toBe(2)
  })

  it('suggests from CLDR words in other languages', () => {
    const word = Object.keys(EMOJI_TRIGGERS.es).find((w) => EMOJI_TRIGGERS.es[w] === key('💡'))
    expect(word).toBeTruthy()
    expect(suggested([`Una ${word} para ti`], 'es')).toHaveLength(1)
  })
})
