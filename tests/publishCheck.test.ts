import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inContext, linkLike, linksToCheck, normalise, notedPieces, NOTHING_SAID, saidLinks, saidOf, shownRun } from '../src/shared/publish/check'

/*
 * The link check (docs/design/publish-pack.md §4.8): one over-inclusive detector, read on each piece
 * of a text between ASCII spaces. It never changes text.
 */

describe('normalise: a piece as the check reads it', () => {
  it('decodes escapes, drops what shows nothing, applies NFKC, reads IDNA dots as dots and "\\" as "/", in lower case', () => {
    expect(normalise('paypal-login&#46;com')).toBe('paypal-login.com')
    expect(normalise('paypal-login&#0000046com')).toBe('paypal-login.com')
    expect(normalise('paypal-login&period;com')).toBe('paypal-login.com')
    expect(normalise('paypal-login%2Ecom')).toBe('paypal-login.com')
    expect(normalise('%252e')).toBe('.')
    expect(normalise('evil\u200bflown.app')).toBe('evilflown.app')
    expect(normalise('ＥＶＩＬ。ｃｏｍ')).toBe('evil.com')
    expect(normalise('evil｡com．de')).toBe('evil.com.de')
    expect(normalise('https:\\\\evil.com')).toBe('https://evil.com')
    // A reference by a name this does not know may be any letter.
    expect(linkLike(normalise('paypal-login.&rcy;&fcy;'))).toBe(true)
  })
})

describe('linkLike: what is link-like', () => {
  it('a scheme, "www.", "//" or "@" before a host, or a dotted name on a top-level domain', () => {
    for (const n of ['https://x', 'mailto:a', 'javascript:alert(1)', 'www.evil', '//evil', '//203.0.113.7', '//[2606:4700::1111]', '@flown', 'x@203.28935', 'readme.md', 'socket.io', 'evil.在线', 'ログインflown.jp', 'flown.jpから', 'paypal-login.在线客服', 'df.to_csv', 'evil.co\u0301m']) {
      expect(linkLike(normalise(n)), n).toBe(true)
    }
    for (const n of ['config.json', 'v1.2', 'e.g', '2.5分', 'c:/users/you', 'note: this', 'hello', '設定完成.网站上有更多教程.', 'します.youtubeや', '...done']) expect(linkLike(normalise(n)), n).toBe(false)
  })
})

describe('what was said', () => {
  it('is the link-like tokens of the captions without aiLinks, the name and the chapter titles, each where it stands alone', () => {
    const said = saidLinks([{ text: 'Download it from flown.app or https://flown.app/download.' }, { text: 'Mail support@flown.app.', aiLinks: ['support@flown.app.'] }], { title: 'README.md tour', chapters: ['github.com/flown/recorder'] })
    for (const text of ['flown.app', 'https://flown.app', 'https://flown.app/download', 'flown.app/download.', '(flown.app)', 'README.md,', 'github.com/flown/recorder', '"flown.app"', '下载：flown.app', '完成。https://flown.app']) expect(linksToCheck(text, said), text).toEqual([])
    // Glued to more of a name, to letters of another script, a path or a user name: noted.
    for (const text of ['paypal-flown.app', 'evilflown.app', 'ログインflown.app', 'flown.appから', 'flown.app.evil.com', 'flown.app@evil.com', 'https://flown.app@evil.com', 'flown.app/evil', 'https://flown.app.evil.com', 'xhttps://flown.app', '😀flown.app', 'flown.app:8443@evil.com', 'support@flown.app'])
      expect(linksToCheck(text, said), text).toEqual([text])
  })

  it('a said piece needs no note, a link-like piece nothing said always does', () => {
    expect(linksToCheck('Get it at evil.com and README.md', NOTHING_SAID)).toEqual(['evil.com', 'README.md'])
    expect(linksToCheck('Ordinary words, a version 2.4 and 50% more: nothing link-like.', NOTHING_SAID)).toEqual([])
  })
})

describe('notedPieces', () => {
  it('splits at ASCII spaces only, and reads a quoted attribute across its line breaks as one piece', () => {
    const said = saidOf(['flown.app'])
    expect(notedPieces('Get flown.app\u00a0@evil.com now', said)).toEqual([{ start: 4, end: 23, text: 'flown.app\u00a0@evil.com' }])
    const html = '<a href="https://flown.app\n.com">x</a>'
    expect(notedPieces(html, said).map((p) => p.text)).toEqual(['https://flown.app\n.com'])
  })

  it('shows a piece exactly, with what is invisible by its code, and a few characters around it', () => {
    expect(shownRun('evil\u200bflown.app')).toBe('evil⟨U+200B⟩flown.app')
    const text = 'Short intro, then go to evil\u200b.com for the files.'
    const [p] = notedPieces(text, NOTHING_SAID)
    expect(inContext(text, p)).toEqual({ before: '… then go to ', piece: 'evil⟨U+200B⟩.com', after: ' for the fil…' })
  })

  it('is linear: a long text with many said links is read in a few tens of milliseconds', () => {
    const said = saidOf(Array.from({ length: 300 }, (_, i) => `See https://flown.app/docs/${i} and docs${i}.flown.app`))
    const text = Array.from({ length: 4000 }, (_, i) => `Read https://flown.app/docs/${i % 300} or docs${i % 300}.flown.app, then 打开README.md。`).join(' ')
    expect(text.length).toBeGreaterThan(200_000)
    const t = performance.now()
    const noted = notedPieces(text, said)
    expect(performance.now() - t).toBeLessThan(1500)
    expect(noted).toHaveLength(4000)
    // A text of one long run of name characters and dots.
    const run = `${'日本.'.repeat(30_000)}com`
    const t2 = performance.now()
    expect(linksToCheck(run, said)).toHaveLength(1)
    expect(performance.now() - t2).toBeLessThan(1500)
  })
})

interface Project {
  from: string
  lang: string
  title: string
  chapters: string[]
  captions: string[]
  cards: { kind: 'youtube' | 'linkedin' | 'xpost' | 'article' | 'releaseNotes'; text: string; tags?: string[] }[]
}
const { projects } = JSON.parse(readFileSync(new URL('./fixtures/tutorial-corpus.json', import.meta.url), 'utf8')) as { projects: Project[] }

describe('the realistic tutorial copy of the earlier rounds', () => {
  it('notes only pieces with a dot, scheme, "@" or "//", and few cards (each is kept as written: tests/publishCheckOracle.test.ts)', () => {
    let cards = 0
    let noted = 0
    for (const p of projects) {
      const said = saidLinks(
        p.captions.map((text, i) => ({ id: `c${i}`, start: i, end: i + 1, text })),
        { title: p.title, chapters: p.chapters }
      )
      for (const c of p.cards) {
        cards++
        const pieces = linksToCheck(c.text, said)
        if (pieces.length) noted++
        // Ordinary prose without a dot, scheme, "@" or "//" is never noted.
        for (const piece of pieces) expect(/[.。．｡@]|\/\/|[a-z]:/i.test(normalise(piece)), piece).toBe(true)
      }
    }
    expect(cards).toBe(262)
    // Measured: 67 of 262 cards (26%), most for a name glued to the letters of another script, which the prompts now
    // ask the model to write with a space on each side (§4.1); 30 of 262 at cf2a807, which rewrote 24 cards, 11 losing letters.
    expect(noted).toBeLessThanOrEqual(67)
  })
})
