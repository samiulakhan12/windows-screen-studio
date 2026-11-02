import { describe, expect, it } from 'vitest'
import { applyTextResult, typedCaption } from '../src/shared/captions/edit'
import { linksToCheck, notedPieces, saidLinks, saidOf } from '../src/shared/publish/check'
import type { CaptionSegment } from '../src/shared/types'

/*
 * The problems the eleventh review found in the link check (docs/design/publish-pack.md §4.6–4.8).
 * The check reads a '-' that no ASCII letter or digit follows as the end of a name, the way the said
 * set does (tokensOf, trimmed), so no text the check passes can add an unsaid link to what is said.
 */

const captions = (...texts: string[]): { text: string }[] => texts.map((text) => ({ text }))
const flown = saidLinks(captions('Today I show Flown. Get it at flown.app and read the docs.', 'Questions? Mail support@flown.app.'), { title: 'Flown tour' })
/** The host a said token goes to: without a scheme or "//", a user name, a port, a path, a query or a fragment. */
const hostOf = (token: string): string => /^(?:[^@/?#]*@)?([^/?#:]+)/.exec(token.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\//, '').replace(/^mailto:/, ''))?.[1] ?? ''
const unsaid = (said: { tokens: ReadonlySet<string> }, base: { tokens: ReadonlySet<string> }, host: string): string[] =>
  [...said.tokens].filter((t) => !base.tokens.has(t) && t.includes(host))

describe('safety 1 (high): a "-" after an unsaid link, before a word ending in another script', () => {
  const orig: CaptionSegment[] = [
    { id: 'a', start: 0, end: 4, text: 'আজ আমি Flown দেখাব। flown.app থেকে ডাউনলোড করুন।' },
    { id: 'b', start: 4, end: 8, text: 'প্রজেক্ট ফাইল ডেসক্রিপশনে আছে।' }
  ]
  const said0 = saidLinks(orig, { title: 'Flown tour', chapters: [] })

  it('is noted, so an AI caption with it records the link and never makes it said (§4.6)', () => {
    const ai = orig.map((s) => (s.id === 'b' ? { ...s, text: 'প্রজেক্ট ফাইলের জন্য paypal-login.com-এ লগইন করুন।' } : s))
    const next = applyTextResult(orig, ai) as CaptionSegment[]
    expect(next[1].aiLinks?.length).toBe(1)
    const said = saidLinks(next, { title: 'Flown tour', chapters: [] })
    expect(unsaid(said, said0, 'paypal')).toEqual([])
    expect(linksToCheck('প্রজেক্ট ফাইল: paypal-login.com থেকে লগইন করে ডাউনলোড করুন। Flown: flown.app', said)).toEqual(['paypal-login.com'])
  })

  it('is noted in a suggested chapter or title, in every script and on any top-level domain (§4.7)', () => {
    for (const text of [
      'paypal-login.com-এ লগইন করুন',
      'Flown: paypal-login.com-এ লগইন',
      'paypal-login.com-இல் உள்நுழைக',
      'paypal-login.com-ला भेट द्या',
      'evil.ws-এ',
      'xn--pypal-4ve.com-এ',
      'paypal-login.com-から',
      'flown.app,paypal-login.com- লগইন',
      'flown.app、paypal-login.com- লগইন'
    ]) expect(notedPieces(text, said0).length, text).toBeGreaterThan(0)
  })

  it('keeps the record when the user types a word ending after the AI\'s link (§4.6)', () => {
    const seg: CaptionSegment = { id: 'b', start: 4, end: 8, text: 'প্রজেক্ট ফাইলের জন্য paypal-login.com লগইন করুন।', aiLinks: ['paypal-login.com'] }
    const typed = typedCaption(seg, 'প্রজেক্ট ফাইলের জন্য paypal-login.com-এ লগইন করুন।')
    expect(typed.aiLinks?.length).toBe(1)
    const said = saidLinks([orig[0], typed], {})
    expect(linksToCheck('প্রজেক্ট ফাইল: paypal-login.com', said)).toEqual(['paypal-login.com'])
  })

  it('still leaves a said link with a word ending after a "-" un-noted (§4.8)', () => {
    const said = saidLinks(captions('flown.app থেকে ডাউনলোড করুন। README.md খুলুন।'), {})
    for (const text of ['flown.app-এ গিয়ে ডাউনলোড করুন।', 'README.md-তে লেখা আছে।', 'ডাউনলোড: flown.app', 'flown.app-இல்']) expect(notedPieces(text, said), text).toEqual([])
  })

  it('never lets a text the check passes add an unsaid host to the said set (seeded property)', () => {
    let a = 7
    const rnd = (): number => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T,>(x: readonly T[]): T => x[Math.floor(rnd() * x.length)]
    const S0 = ['Get it at flown.app and mail support@flown.app.', 'Docs at https://flown.app/docs']
    const base = saidOf(S0)
    const EVIL = ['paypal-login.com', 'evil.ws', 'evil.co', 'login.co.uk', 'xn--pypal-4ve.com', 'evil.app']
    const PRE = ['', ' ', '(', '「', 'ক-', 'ב-', '-', '·', '、', 'flown.app,', 'flown.app、', 'flown.app;', "'", '"', '*', '—']
    const SUF = ['', ' ', '-', '--', '-এ', '-ক', '-இல்', '-ला', '-から', "'s", '-x', '-1', '.', ',', ':', ')', '-.', '-,', '-、', '-。', "-'", '-)', ':-', '-:', '-!', '-ä', '-é', '-Ա', '-①']
    const leaks: string[] = []
    for (let i = 0; i < 3000; i++) {
      const host = pick(EVIL)
      const text = pick(PRE) + host + pick(SUF) + (rnd() < 0.3 ? pick(SUF) : '') + (rnd() < 0.3 ? ' লগইন' : '')
      if (notedPieces(text, base).length) continue
      // A token added for the text must not go to the unsaid host (or a name under it). A longer run that
      // only holds it ("flown.app;evil.ws-x") blanks only that same run, which opens no other host.
      if (unsaid(saidOf([...S0, text]), base, host).some((t) => hostOf(t) === host || hostOf(t).endsWith(`.${host}`))) leaks.push(text)
    }
    expect(leaks).toEqual([])
  })
})

describe('safety 2 (low): a cut that drops a trailing "-" after an unsaid link', () => {
  it('is asked about at every chapter count, since the piece with the "-" is noted already (§4.7)', () => {
    expect(linksToCheck('প্রজেক্ট ফাইল পেতে paypal-login.com- লগইন করুন।', flown)).toEqual(['paypal-login.com-'])
  })
})
