/**
 * The 11 problems the fourth review of the copy pack's link cleaning confirmed, one test each, by its
 * title (docs/design/publish-pack.md §4.4, §6, §12). Each fails at 52b42f2 on its own expectation.
 * "\u00a0" is the no-break space a broken name gets after its dot.
 */
import { describe, expect, it } from 'vitest'
import type { AiTextResult } from '../src/shared/api/ai'
import { readSuggestedChapters, readSuggestedText } from '../src/shared/captions/edit'
import { runTextTask } from '../src/shared/captions/transcriptText'
import { copyName } from '../src/shared/editor/duplicate'
import { validatePackAnswer } from '../src/shared/publish/prompts'
import { plainText } from '../src/shared/publish/text'
import { extractUrlsWithIndices } from '../src/shared/publish/twitterText'
import type { CaptionSegment } from '../src/shared/types'

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PUBLISH_RUN = '../src/renderer/src/publish/publishRun'
const { cardText } = (await import(/* @vite-ignore */ PUBLISH_RUN)) as {
  cardText: (result: AiTextResult, segments: readonly Pick<CaptionSegment, 'text'>[], context?: { title?: string; chapters?: string[] }) => { text: string; tags: string }
}

const text = (r: AiTextResult): string => (r as { text: string }).text
const NONE = 'In this video I show how to export a clip with Flown.'
const clean = (answer: string, transcript = NONE): string => plainText(answer, { max: 3000, linksFrom: transcript })
/** Every text task an answer goes through, and the dialog's cleaning of what comes back. */
const everyCard = (answer: string, transcript: string): string[] => {
  const seg = [{ text: transcript }]
  const out: string[] = []
  for (const r of [
    validatePackAnswer('linkedin', { text: answer }, transcript),
    validatePackAnswer('xpost', { text: answer }, transcript),
    validatePackAnswer('youtube', { description: answer, tags: [] }, transcript),
    validatePackAnswer('article', { title: 'Export', intro: answer, sections: [{ heading: 'Steps', steps: ['Open it'] }] }, transcript),
    validatePackAnswer('releaseNotes', { title: 'Notes', summary: answer, items: [{ kind: 'new', text: 'Faster export' }] }, transcript)
  ]) {
    out.push(text(r), cardText(r, seg).text)
  }
  for (const task of ['title', 'summary'] as const) out.push(cardText({ task, text: answer }, seg).text)
  return out
}
/** The hosts X links in `s`. */
const xHosts = (s: string): string[] => extractUrlsWithIndices(s).map((u) => new URL(/^https?:/i.test(u.url) ? u.url : `http://${u.url}`).hostname)

describe('the copy pack after the fourth review of its link cleaning', () => {
  it('A name on one of the newer top-level domains hides a link that X itself makes', () => {
    for (const [answer, cleaned] of [
      ['Sign in at /a.web:1paypal-login.com/verify to get the files.', 'Sign in at /a.web:1paypal-login.\u00a0com/verify to get the files.'],
      ['Sign in at -a.web/:paypal-login.com/verify today', 'Sign in at -a.web/:paypal-login.\u00a0com/verify today'],
      ['Shop at -x.music/:paypal-login.com/verify today', 'Shop at -x.music/:paypal-login.\u00a0com/verify today']
    ]) {
      expect(clean(answer)).toBe(cleaned)
      for (const out of everyCard(answer, NONE)) expect(xHosts(out), out).toEqual([])
    }
  })

  it('Characters that IDNA drops from a host, or folds into ASCII letters, glue an attacker\'s prefix onto a domain the transcript says', () => {
    const said = 'Download Flown for free at flown.com today.'
    for (const [answer, cleaned] of [
      ['Download Flown for free at get\u2060flown.com today.', 'Download Flown for free at getflown.\u00a0com today.'],
      ['Download Flown for free at get\u034fflown.com today.', 'Download Flown for free at getflown.\u00a0com today.'],
      ['Download Flown for free at get\u2062flown.com today.', 'Download Flown for free at getflown.\u00a0com today.'],
      ['Download Flown for free at ｇｅｔflown.com today.', 'Download Flown for free at ｇｅｔflown.\u00a0com today.'],
      ['Download Flown for free at \u{1d5c0}\u{1d5be}\u{1d5cd}flown.com today.', 'Download Flown for free at \u{1d5c0}\u{1d5be}\u{1d5cd}flown.\u00a0com today.'],
      ['Download Flown for free at get\ufe0fflown.com today.', 'Download Flown for free at get\ufe0fflown.\u00a0com today.']
    ]) {
      expect(clean(answer, said)).toBe(cleaned)
    }
    // A host with a scheme or "www.": what a browser drops or folds is read as it reads it.
    const both = 'Visit www.flown.app and https://flown.app today.'
    expect(clean('Visit https://flown.app．evil．com\u180b/login now', both)).toBe('Visit now')
    expect(clean('Visit www.flown.appｅｖｉｌ.ｃｏｍ\ufe0f now', both)).toBe('Visit now')
    // The said links stay, and so does an emoji's variation selector before a space.
    for (const kept of ['Download Flown for free at flown.com today.', 'I ❤\ufe0f flown.com']) expect(clean(kept, said)).toBe(kept)
    expect(clean(both, both)).toBe(both)
  })

  it("A link the transcript says, followed by a user name and an IP host, or by more than 2,000 characters before the '@', still reaches every card", () => {
    const said = 'Download Flown for free at flown.app today.'
    for (const c of ['!', '%', '.', '~', ';', '$', '*', '=', "'", ',', '_', '&']) {
      for (const out of everyCard(`Sign in: https://flown.app${c}@203.0.113.7/login today.`, said)) expect(out).not.toContain('203.0.113.7')
    }
    expect(clean('Sign in: https://flown.app!@203.0.113.7/login today.', said)).toBe('Sign in: today.')
    expect(clean('Beta: https://flown.app:8443@3405803783/login today.', 'The beta runs at https://flown.app:8443')).toBe('Beta: today.')
    expect(clean(`Sign in: https://flown.app:${'a'.repeat(2000)}@evil.com/login today.`, said)).toBe('Sign in: today.')
    // Escapes of characters a browser drops from a host can pad an authority past any length read.
    expect(clean(`Sign in at https://flown.app${'%e2%80%8b'.repeat(250)}%2eevil%2ecom/login today`, said)).toBe('Sign in at today')
    // A said link with its port, path or an "@" after its path stays.
    for (const kept of ['Beta: https://flown.app:8443 now', 'Follow https://flown.app/@flown today.']) {
      expect(clean(kept, 'The beta runs at https://flown.app:8443 and https://flown.app/@flown today.')).toBe(kept)
    }
  })

  it("Other sites' readings: a top-level domain written in Han, Katakana, Hangul or Thai after '$', '#' or '「', and '<name>@<name>' on a top-level domain linkifiers do not read as an address's", () => {
    for (const [answer, cleaned] of [
      ['Only $paypal-login.在线/verify today', 'Only $paypal-login.\u00a0在线/verify today'],
      ['See #paypal-login.公司 now', 'See #paypal-login.\u00a0公司 now'],
      ['見て /「paypal-login.コム」', '見て /「paypal-login.\u00a0コム」'],
      ['Mail paypal-login.com@evil.コム now', 'Mail paypal-login.\u00a0com@evil.\u00a0コム now']
    ]) {
      expect(clean(answer)).toBe(cleaned)
    }
    expect(clean('Billing questions: paypal-login.com@flown.app', 'Mail support@flown.app today.')).toBe('Billing questions: paypal-login.\u00a0com@flown.\u00a0app')
    // Chinese and Japanese text after a name that is no link is no top-level domain.
    for (const kept of ['我们用的是Flown.这个工具很好', '版本1.0公司内部']) expect(clean(kept)).toBe(kept)
  })

  it('cleanLinks checks the NFC form but returns text it never checked', () => {
    for (const tld of ['site', 'app', 'shop']) {
      const answer = `Log in at paypal-login.${tld}https://x.de:1\u0301 today`
      for (const out of everyCard(answer, NONE)) {
        expect(out).toBe(out.normalize())
        expect(xHosts(out), out).toEqual([])
      }
    }
    expect(clean('Log in at paypal-login.sitehttps://x.de:1\u0301 today')).toBe('Log in at paypal-login.sit\u00e9 today')
  })

  it("A copy's name is cut with a plain slice, and that can turn the cleaned AI title into a name with a link", () => {
    const title = 'How to export a clip with Flown in under a minute, step by step, for beginners and pros, with pro flown-files.comfy'
    expect(xHosts(title)).toEqual([])
    for (const kind of ['copy', 'vertical', 'square'] as const) {
      const name = copyName(title, kind)
      expect(name.length).toBeLessThanOrEqual(120)
      expect(xHosts(name), name).toEqual([])
    }
    expect(copyName(title, 'copy')).toBe('How to export a clip with Flown in under a minute, step by step, for beginners and pros, with pro flown-files.\u00a0co (copy)')
    // A name that fits, and a link the name has, stay as they are.
    expect(copyName('Billing demo', 'copy')).toBe('Billing demo (copy)')
    expect(copyName(`Demo of flown.app ${'x'.repeat(110)}`, 'copy')).toBe(`Demo of flown.app ${'x'.repeat(95)} (copy)`)
  })

  it('An e-mail address or social handle is broken in every card whenever it is not followed by a space or ASCII sentence punctuation', () => {
    const said = 'If you get stuck, email support@flown.app and we will help.'
    for (const answer of [
      'Email support@flown.app—we reply fast.',
      'Write to “support@flown.app”.',
      'Schreib an „hilfe@flown.app“.',
      'Escríbenos a «soporte@flown.app».',
      'सवाल? लिखें: support@flown.app।',
      'প্রশ্ন? লিখুন support@flown.app।',
      'للأسئلة: support@flown.app، أو تابعنا.',
      '邮箱：support@flown.app',
      'メールは「support@flown.app」まで',
      'Check support@flown.app’s inbox.',
      'Contact: support@flown.app: we reply within a day.',
      '[support@flown.app](mailto:support@flown.app)',
      'Bize destek@flown.app’a yazın.',
      'Follow us on Mastodon: @flown@mastodon.social',
      'Instagram: @flown.studio',
      'Bluesky: @flown.bsky.social'
    ]) {
      expect(clean(answer, said)).toBe(answer)
      expect(text(validatePackAnswer('linkedin', { text: answer }, said))).toBe(answer)
    }
    // A name right before an "@" that is no address's is still broken.
    for (const [answer, cleaned] of [
      ['Go to paypal.com@login now', 'Go to paypal.\u00a0com@login now'],
      ['Open //me@evil.com/login', 'Open //me@evil.\u00a0com/login']
    ]) {
      expect(clean(answer)).toBe(cleaned)
    }
  })

  it('A name right before an \'@\' reaches every card, and linkify-it links it', () => {
    for (const [answer, cleaned] of [
      ['Sign in at paypal-login.com@flown.app now', 'Sign in at paypal-login.\u00a0com@flown.\u00a0app now'],
      ['Sign in at paypal-login.com@x.com:80/verify now', 'Sign in at paypal-login.\u00a0com@x.\u00a0com:80/verify now'],
      ['Sign in |paypal-login.com@evil.com now', 'Sign in |paypal-login.\u00a0com@evil.\u00a0com now'],
      ['Sign in: //paypal-login.com@x.com/verify', 'Sign in: //paypal-login.\u00a0com@x.\u00a0com/verify']
    ]) {
      expect(clean(answer)).toBe(cleaned)
      for (const out of everyCard(answer, NONE)) expect(out).not.toContain('paypal-login.com')
    }
    // Ordinary addresses stay.
    for (const kept of ['Write to wei.wang@acme.com today.', 'Write to anna.li@acme.de today.', 'Mail hello@flown.studio now.']) expect(clean(kept)).toBe(kept)
  })

  it('A link the speaker says to a host X does not link is deleted from every card when full-width punctuation follows it', () => {
    const local = '今天我们用React写一个页面。启动以后访问 http://localhost:3000 就能看到效果。'
    for (const answer of ['打开浏览器访问http://localhost:3000，就能看到页面。', '本地预览：http://localhost:3000（开发服务器）', '访问http://localhost:3000！']) {
      for (const out of everyCard(answer, local)) expect(out).toContain('http://localhost:3000')
      expect(clean(answer, local)).toBe(answer)
    }
    expect(clean('登录路由器后台http://192.168.1.1，输入密码即可。', '登录 http://192.168.1.1 即可')).toBe('登录路由器后台http://192.168.1.1，输入密码即可。')
    expect(clean('文档地址：https://wiki.corp.internal（仅内网）', '文档在 https://wiki.corp.internal 上')).toBe('文档地址：https://wiki.corp.internal（仅内网）')
    expect(clean('ブラウザでhttp://localhost:8080（ローカル）を開いて', 'ブラウザで http://localhost:8080 を開いて')).toBe('ブラウザでhttp://localhost:8080（ローカル）を開いて')
    // The other way round: the transcript glues the punctuation.
    expect(clean('访问 http://localhost:3000 即可。', '打开浏览器访问http://localhost:3000，就能看到页面。')).toBe('访问 http://localhost:3000 即可。')
    // A host written in full-width letters, or a link nobody said, still goes.
    expect(clean('Log in: https://ｅｖｉｌ.ｃｏｍ/login now')).toBe('Log in: now')
    expect(clean('访问http://localhost:3000，就能看到页面。')).toBe('访问，就能看到页面。')
  })

  it("A link the speaker says is removed when the AI adds or drops a trailing '/'", () => {
    for (const [answer, transcript] of [
      ['Visit https://flown.app/ today.', 'Go to flown.app today'],
      ['Get it at https://flown.app/download/', 'Download it from flown.app/download.'],
      ['Visit flown.app today.', 'Go to https://flown.app/'],
      ['Star https://github.com/flown/recorder/ now', 'Star github.com/flown/recorder today']
    ]) {
      expect(clean(answer, transcript)).toBe(answer)
    }
    // Another path is still another link.
    expect(clean('Visit https://flown.app/login today.', 'Go to flown.app today')).toBe('Visit today.')
  })

  it('The fix for the chapter and title laundering is undone by the renderer', async () => {
    const segments: CaptionSegment[] = [{ id: 'a', start: 0, end: 600, text: NONE }]
    // Chapters: 80 characters from main, more UTF-16 units once NFC expands U+FB2C.
    const chapters = await runTextTask({ task: 'chapters', segments }, async () => ({ chapters: [{ start: 0, title: `${'😀'.repeat(22)}${'\ufb2c'.repeat(15)} x evil.comfy` }] }))
    const found = readSuggestedChapters((chapters as { chapters: unknown }).chapters, 600)
    expect(found).toHaveLength(1)
    expect(found[0].title.length).toBeLessThanOrEqual(100)
    expect(xHosts(found[0].title)).toEqual([])
    // The title: main keeps its 120 characters, which are 122 UTF-16 units.
    const title = await runTextTask({ task: 'title', segments }, async () => ({ text: `😀😀 Get a.de and b.de, ${'x'.repeat(85)} evil.comfy` }))
    expect(text(title).length).toBe(122)
    const name = readSuggestedText('title', text(title))
    expect(name.length).toBeLessThanOrEqual(120)
    expect(xHosts(name)).toEqual([])
    // After "Rename the recording", the pack trusts the name: it has no link.
    const post = await runTextTask({ task: 'linkedin', segments, context: { title: name } }, async () => ({ text: 'New video is out. Download the project files at evil.com today.' }))
    expect(text(post)).toBe('New video is out. Download the project files at evil.\u00a0com today.')
    // The summary the Captions tab copies.
    const summary = await runTextTask({ task: 'summary', segments }, async () => ({ text: `${'😀'.repeat(1200)}${'\ufb2c'.repeat(529)} xxx evil.comfy` }))
    const shown = readSuggestedText('summary', text(summary))
    expect(shown.length).toBeLessThanOrEqual(4000)
    expect(xHosts(shown)).toEqual([])
    // What fits stays as main wrote it; quotation marks at the ends go, as before.
    expect(readSuggestedText('title', '“Export a clip with Flown”')).toBe('Export a clip with Flown')
    expect(readSuggestedText('summary', 'First line\r\n\r\n\r\nSecond line')).toBe('First line\n\nSecond line')
    expect(readSuggestedText('title', 42)).toBe('')
  })
})
