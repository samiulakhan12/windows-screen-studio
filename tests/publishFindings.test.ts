/**
 * The 17 problems the second review of the copy pack's link filter confirmed, one test each, by its
 * title (docs/design/publish-pack.md §4.4, §12). Each failed with the hand-written filter (7a6b136).
 * Uses only what that version exports, so each fails there on its own expectation.
 */
import { describe, expect, it } from 'vitest'
import type { AiTextResult } from '../src/shared/api/ai'
import { runTextTask } from '../src/shared/captions/transcriptText'
import { cleanTags, packPrompt, PACK_DATA_START, readPackContext, validatePackAnswer } from '../src/shared/publish/prompts'
import { cutAt, fitX, plainText, xLength, X_LIMIT } from '../src/shared/publish/text'
import { composeYoutubeDescription } from '../src/shared/publish/youtube'
import type { CaptionSegment } from '../src/shared/types'

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PUBLISH_RUN = '../src/renderer/src/publish/publishRun'
const { cardText } = (await import(/* @vite-ignore */ PUBLISH_RUN)) as {
  cardText: (result: AiTextResult, segments: readonly Pick<CaptionSegment, 'text'>[], context?: { title?: string; chapters?: string[] }) => { text: string; tags: string }
}

const text = (r: AiTextResult): string => (r as { text: string }).text
const none = { max: 500, linksFrom: 'Today I show the new export flow.' }

describe('the copy pack after the second review of its link filter', () => {
  it('A link the transcript does not have survives inside the code, query or brackets after a domain or code name the transcript does say ("flown.app(evil.com/login)", "flown.app?next=https://evil.com/login", "e.target(evil.com/login)")', () => {
    const said = { max: 500, linksFrom: 'Today I show the new export flow. Get Flown at flown.app today.' }
    // A bare name is broken, with its path; a link with a scheme goes.
    expect(plainText('Get it at flown.app(evil.com/login) now.', said)).toBe('Get it at flown.app(evil.\u00a0com/login) now.')
    expect(plainText('flown.app(see evil.com/login for the deal)', said)).toBe('flown.app(see evil.\u00a0com/login for the deal)')
    expect(plainText('flown.app(https://evil.com/login)', said)).toBe('flown.app()')
    // X uses up a query after a bare domain, so it links nothing in it; YouTube and LinkedIn link the scheme's link.
    expect(plainText('flown.app?next=https://evil.com/login', said)).toBe('flown.app?next=')
    expect(plainText('flown.app.x(evil.com)', said)).toBe('flown.app.x(evil.\u00a0com)')
    const code = { max: 500, linksFrom: 'In the handler read e.target to get the value.' }
    expect(plainText('Read e.target(evil.com/login)', code)).toBe('Read e.target(evil.\u00a0com/login)')
    expect(plainText('e.target.value(https://evil.com/login)', code)).toBe('e.target.value()')
    expect(text(validatePackAnswer('xpost', { text: 'New export flow! Get it at flown.app(free mirror: evil.com/login)' }, said.linksFrom))).toBe('New export flow! Get it at flown.app(free mirror: evil.\u00a0com/login)')
  })

  it('Vietnamese place names and Spanish/Portuguese titles written without a space ("TP.Thủ Đức", "TP.Huế", "Sr.João") lose letters: the filter deletes "TP.Th" as a link', () => {
    const vi = 'Hôm nay tôi giới thiệu những quán cà phê ở thành phố Thủ Đức và thành phố Huế.'
    expect(text(validatePackAnswer('linkedin', { text: 'Những quán cà phê đẹp nhất TP.Thủ Đức và TP.Huế mà bạn nên ghé.' }, vi))).toBe('Những quán cà phê đẹp nhất TP.\u00a0Thủ Đức và TP.\u00a0Huế mà bạn nên ghé.')
    expect(validatePackAnswer('youtube', { description: 'Khám phá quán cà phê ở TP.Thủ Đức và TP.Huế.', tags: ['TP.Thủ Đức', 'cà phê TP.Huế'] }, vi)).toEqual({
      task: 'youtube',
      text: 'Khám phá quán cà phê ở TP.\u00a0Thủ Đức và TP.\u00a0Huế.',
      tags: ['TP. Thủ Đức', 'cà phê TP. Huế']
    })
    for (const [from, to] of [['TP.Châu Đốc', 'TP.\u00a0Châu Đốc'], ['TP.Phủ Lý', 'TP.\u00a0Phủ Lý'], ['Sr.João', 'Sr.\u00a0João'], ['Sra.Peña', 'Sra.\u00a0Peña']]) expect(plainText(from, none)).toBe(to)
  })

  it('A Latin name on a non-Latin top-level domain glued to a following letter ("evil.онлайны", "evil.コムé", "paypal-login.сайтом") is kept, and X links it', () => {
    expect(text(validatePackAnswer('xpost', { text: 'Скачайте на flown.онлайны сейчас' }, none.linksFrom))).toBe('Скачайте на flown.\u00a0онлайны сейчас')
    expect(plainText('Go evil.コムé now', none)).toBe('Go evil.\u00a0コムé now')
    expect(plainText('Visit evil.在线ы', none)).toBe('Visit evil.\u00a0在线ы')
    expect(plainText('Login paypal-login.сайтом', none)).toBe('Login paypal-login.\u00a0сайтом')
    expect(xLength('Go evil.\u00a0コムé now')).toBe(18)
  })

  it('A domain after a dot that follows a non-ASCII symbol, CJK text, a zero-width space or a quote is never removed, and X links it', () => {
    for (const before of ['…', '”', '"', '詳', '😀', '€']) expect(plainText(`More at ${before}.evil.com today`, none)).toBe(`More at ${before}.evil.\u00a0com today`)
    // A zero-width space is dropped (IDNA drops it from a host): then nothing links ".evil.com".
    expect(plainText('More at \u200b.evil.com today', none)).toBe('More at .evil.com today')
    expect(plainText('More at https://x詳.evil.com today', none)).toBe('More at today')
    expect(text(validatePackAnswer('linkedin', { text: 'More at ….evil.com today' }, none.linksFrom))).toBe('More at ….evil.\u00a0com today')
  })

  it('Removing a link joins the text around it into a new link (one pass, result never checked again)', () => {
    expect(plainText('Visit evil.comhttps://x.de', none)).toBe('Visit evil.\u00a0com')
    // "x.de" took ":80" as its port, hiding "80evil.com"; broken, it shows it, and the next round breaks it too.
    expect(plainText('More at x.de:80evil.com', none)).toBe('More at x.\u00a0de:80evil.\u00a0com')
    expect(plainText('More at evil.コhttps://x.deム', none)).toBe('More at evil.\u00a0コム')
    expect(plainText('evil.在x.de线', none)).toBe('evil.在x.\u00a0de线')
    // One bare name for X ("evil.comwww.x.de"): broken at each dot.
    expect(text(validatePackAnswer('xpost', { text: 'Visit evil.comwww.x.de today' }, none.linksFrom))).toBe('Visit evil.\u00a0comwww.\u00a0x.\u00a0de today')
    expect(text(validatePackAnswer('xpost', { text: 'Visit evil.c(https://x.de)om today' }, none.linksFrom))).toBe('Visit evil.c()om today')
  })

  it('A cut made after the filter turns a non-link word into a link (plainText caps, fitX, article and description cuts)', () => {
    // X counts "…check.com" as 23, so a cut there fits; broken, it does not, and the cut goes before it.
    const long = `New: ${'='.repeat(244)}secure-login-account-check.comfy`
    for (const post of [text(validatePackAnswer('xpost', { text: long }, none.linksFrom)), fitX(long)]) {
      expect(post).toBe(`New: ${'='.repeat(244)}secure-login-account-check.…`)
      expect(xLength(post)).toBeLessThanOrEqual(X_LIMIT)
    }
    const article = text(validatePackAnswer('article', { title: 'T', intro: '', sections: [{ heading: `H →${'='.repeat(108)}evil.comfy`, steps: ['Open it'] }] }, none.linksFrom))
    expect(article).toContain(`## H →${'='.repeat(108)}evil.\u00a0co…\n1. Open it`)
    const body = `${'='.repeat(2991)}evil.comfy`
    expect(text(validatePackAnswer('linkedin', { text: body }, none.linksFrom))).toBe(`${'='.repeat(2991)}evil.\u00a0co…`)
    expect(cutAt(body, 3000)).toBe(`${'='.repeat(2991)}evil.\u00a0co…`)
    const chapters = Array.from({ length: 80 }, (_, i) => ({ start: i * 30, title: `Chapter ${i}` }))
    const tail = composeYoutubeDescription('', chapters, 2400)
    const room = 5000 - [...tail].length - 2
    const copy = composeYoutubeDescription(`${'='.repeat(room - 9)}evil.comfy`, chapters, 2400)
    expect(copy).toBe(`${'='.repeat(room - 9)}evil.\u00a0co…\n\n${tail}`)
  })

  it('Combining marks (U+0300-U+036F) inside or before a domain hide it from LINK, and X links the mixed-script name', () => {
    expect(plainText('Log in at paypal\u0301.com', none)).toBe('Log in at paypaĺ.\u00a0com')
    expect(plainText('Get it at e\u0301flown.app', { max: 500, linksFrom: 'Get Flown at flown.app today.' })).toBe('Get it at éflown.\u00a0app')
    expect(plainText('Log in at evi\u0301l.xn--p1ai', none)).toBe('Log in at evi\u0301l.\u00a0xn--p1ai'.normalize())
  })

  it('A Latin top-level domain followed by \u017f (U+017F) or K (Kelvin sign, U+212A) is kept, and X links the domain', () => {
    expect(plainText('More at evil.com\u017f today', none)).toBe('More at evil.\u00a0com\u017f today')
    expect(plainText('evil.co\u017fm', none)).toBe('evil.\u00a0co\u017fm')
    // NFC turns the Kelvin sign into "K": then it continues the name, and X links nothing.
    expect(plainText('More at evil.com\u212a today', none)).toBe('More at evil.comK today')
  })

  it("'@' followed by a non-ASCII letter hides the domain after that letter from LINK, but not from X", () => {
    expect(plainText('Mail help@ñevil.com today', none)).toBe('Mail help@ñevil.\u00a0com today')
    expect(plainText('me@ыevil.com', none)).toBe('me@ыevil.\u00a0com')
  })

  it('Abbreviation glued to a following word that is itself a top-level domain is deleted: titles, honorifics, company forms, Polish "m.in." (a different class from TP.Thủ)', () => {
    const pl = 'W tym filmie pokażę między innymi szybszy eksport i napisy.'
    expect(text(validatePackAnswer('linkedin', { text: 'Nowa wersja Flown ma m.in. szybszy eksport i napisy.' }, pl))).toBe('Nowa wersja Flown ma m.\u00a0in. szybszy eksport i napisy.')
    expect(text(validatePackAnswer('xpost', { text: 'Thanks to Dr.Kim for the demo of Flown!' }, none.linksFrom))).toBe('Thanks to Dr.\u00a0Kim for the demo of Flown!')
    for (const [from, to] of [
      ['GmbH & Co.KG', 'GmbH & Co.\u00a0KG'],
      ['Gent.ma Sig.na Rossi', 'Gent.\u00a0ma Sig.\u00a0na Rossi'],
      ['Pvt.Ltd. and Co.Inc', 'Pvt.\u00a0Ltd. and Co.\u00a0Inc'],
      ['Mr.Li and Ms.Wang', 'Mr.\u00a0Li and Ms.\u00a0Wang'],
      ['1.Open Settings 2.Click Export 3.Save', '1.\u00a0Open Settings 2.\u00a0Click Export 3.\u00a0Save']
    ])
      expect(plainText(from, none)).toBe(to)
  })

  it('E-mail address loses its local part when that part ends in a TLD-like segment, although the spec says e-mail addresses are kept and X does not link it', () => {
    for (const t of ['Write to wei.wang@acme.com or anna.li@acme.de.', 'Contact sales.team@acme.com today.', 'hello.world@acme.com', 'me@flown.app']) expect(plainText(t, none)).toBe(t)
    // Where X does link a part of one ("wei.wang" in "wei.wang.li@acme.com"), that part is broken as any bare name.
    expect(plainText('wei.wang.li@acme.com', none)).toBe('wei.\u00a0wang.li@acme.com')
    const article = text(validatePackAnswer('article', { title: 'Contact', intro: '', sections: [{ heading: 'Write', steps: ['Email sales.team@acme.com'] }] }, none.linksFrom))
    expect(article).toContain('1. Email sales.team@acme.com')
  })

  it("A bare domain right after '_' or '/' (snake_case identifiers, paths) is cut out of the word, although X never links there", () => {
    for (const t of ['Train it with my_model.fit(X, y) now.', 'Start flask_app.run() here.', "train_df.to_csv('a.csv')", 'Edit src/main.rs and terraform/main.tf and config/application.properties.', '~/Movies/recording.mov'])
      expect(plainText(t, none)).toBe(t)
  })

  it("Markdown-marker removal deletes '__' and '**' that are not emphasis: Python dunder names, **kwargs, exponents, globs, even when the transcript has them", () => {
    for (const t of ['Create an empty __init__.py file.', "Check if __name__ == '__main__':", "path.join(__dirname, 'public')", 'Pass *args and **kwargs', '2**10 is 1024.', 'Include src/**/*.ts', 'snake__case'])
      expect(plainText(t, { max: 500, linksFrom: t })).toBe(t)
    // Emphasis around words still goes.
    expect(plainText('A **bold** word, **Note**: and __two words__.', none)).toBe('A bold word, Note: and two words.')
    expect(cardText({ task: 'summary', text: 'Create an empty __init__.py file.' }, [{ text: 'Create an empty __init__.py file.' }]).text).toBe('Create an empty __init__.py file.')
  })

  it("File names whose extension is a TLD missing from FILE_NAME are deleted whole (logo.ai, script.pl, main.tf, application.properties…)", () => {
    expect(plainText('Open logo.ai in Illustrator.', none)).toBe('Open logo.\u00a0ai in Illustrator.')
    expect(plainText('Run script.pl or edit main.tf and Makefile.in.', none)).toBe('Run script.\u00a0pl or edit main.\u00a0tf and Makefile.\u00a0in.')
    expect(plainText('Set spring.application.name in application.properties.', none)).toBe('Set spring.\u00a0application.\u00a0name in application.\u00a0properties.')
    expect(text(validatePackAnswer('article', { title: 'Logo', intro: '', sections: [{ heading: 'Open', steps: ['Open logo.ai in Illustrator'] }] }, none.linksFrom))).toContain('1. Open logo.\u00a0ai in Illustrator')
  })

  it("A code name on a TLD followed by a snake_case tail or a nested call leaves a piece, against the spec's 'so no piece is left'", () => {
    for (const [from, to] of [
      ['Check form.is_valid() first.', 'Check form.\u00a0is_valid() first.'],
      ['request.user.is_authenticated', 'request.\u00a0user.\u00a0is_authenticated'],
      ["df.to_csv('out.csv')", "df.\u00a0to_csv('out.csv')"],
      ["pd.read_csv('data.csv')", "pd.\u00a0read_csv('data.csv')"],
      ['scaler.fit_transform(X)', 'scaler.\u00a0fit_transform(X)'],
      ['torch.save(model.state_dict())', 'torch.\u00a0save(model.state_dict())']
    ])
      expect(plainText(from, none)).toBe(to)
  })

  it("A hashtag with a dot loses everything after '#' (#ASP.NET, #Socket.IO), although X never links after '#'", () => {
    // Said: as written. Not said: no letter is lost, but the name is broken, as a site such as
    // markdown-it's linkifier links a name right after "#" (the third review).
    const said = 'Follow the news on ASP.NET and Socket.IO with me.'
    expect(text(validatePackAnswer('xpost', { text: 'Follow #ASP.NET and #Socket.IO news.' }, said))).toBe('Follow #ASP.NET and #Socket.IO news.')
    expect(text(validatePackAnswer('linkedin', { text: 'Follow #ASP.NET and #Socket.IO news.' }, said))).toBe('Follow #ASP.NET and #Socket.IO news.')
    expect(text(validatePackAnswer('linkedin', { text: 'Follow #ASP.NET and #Socket.IO news.' }, none.linksFrom))).toBe('Follow #ASP.\u00a0NET and #Socket.\u00a0IO news.')
    // A tag loses its "#" first, and is then a name like any other.
    expect(cleanTags(['#ASP.NET', 'ASP.NET'], 'This is about ASP.NET Core.')).toEqual(['ASP.NET'])
  })

  it("The user's own project name and chapter titles lose every link-like word before they reach the AI, whatever the transcript says", async () => {
    const context = { title: 'Dr.Kim interview: ASP.NET basics', chapters: ['Using plt.show()', 'Install from flown.app', 'Edit README.md', 'Pvt.Ltd setup', '__init__.py and **kwargs'] }
    expect(readPackContext(context)).toEqual(context)
    const segments = [{ id: 'a', start: 0, end: 5, text: 'Today I show how to install the app and edit the readme.' }]
    const p = packPrompt({ task: 'youtube', segments, context })
    expect(JSON.parse(p.user.slice(PACK_DATA_START.length))).toMatchObject(context)
    // What the user typed may be in the answers: its links are kept.
    const r = await runTextTask({ task: 'linkedin', segments, context }, async () => ({ text: 'Install it from flown.app and edit README.md.' }))
    expect(text(r)).toBe('Install it from flown.app and edit README.md.')
  })
})
