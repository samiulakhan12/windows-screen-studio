import { describe, expect, it } from 'vitest'
import { aiLinksAfter, mergeWithNext } from '../src/shared/captions/edit'
import { linksToCheck, saidLinks, saidOf } from '../src/shared/publish/check'
import { validatePackAnswer } from '../src/shared/publish/prompts'
import type { CaptionSegment } from '../src/shared/types'

/*
 * The fourteen problems left open after the eighth review (docs/design/publish-pack.md §4.8, §12).
 * They are closed by the root fix, not by more readings: the copy is never changed because of a link,
 * one over-inclusive check notes every piece with anything link-like nobody said, and noted text is
 * confirmed before it leaves the app. Each test is the problem's own probe.
 */

const seg = (id: string, text: string, extra: Partial<CaptionSegment> = {}): CaptionSegment => ({ id, start: 0, end: 1, text, ...extra })
/** What the pack's LinkedIn card shows for `text`: the answer as written, but for cleaning that has nothing to do with links. */
const card = (text: string): string => (validatePackAnswer('linkedin', { text }) as { text: string }).text

describe('safety 1 (high): a space other than ASCII before "@" in a Markdown link, an autolink or an unquoted href', () => {
  it('is inside its piece, so the "@" and the host after it are noted (§4.8: split only at ASCII spaces)', () => {
    const said = saidOf(['Get it at flown.app'])
    const cases: [string, string][] = [
      ['Get it [here](https://flown.app\u00a0@paypal-login.com/verify).', '[here](https://flown.app\u00a0@paypal-login.com/verify).'],
      ['[here](//flown.app\u3000@paypal-login.com/verify)', '[here](//flown.app\u3000@paypal-login.com/verify)'],
      ['<https://flown.app\u2009@paypal-login.com/verify>', '<https://flown.app\u2009@paypal-login.com/verify>'],
      ['<a href=https://flown.app\u00a0@paypal-login.com/verify>here</a>', 'href=https://flown.app\u00a0@paypal-login.com/verify>here</a>'],
      ['[here]: https://flown.app\u202f@paypal-login.com/verify', 'https://flown.app\u202f@paypal-login.com/verify']
    ]
    for (const [text, piece] of cases) {
      expect(linksToCheck(text, said)).toEqual([piece])
      expect(card(text)).toBe(text)
    }
  })
})

describe('safety 2: an IPv4 host of two or three parts after a user name', () => {
  it('is a host-like run after "@" (§4.8)', () => {
    const said = saidOf(['Get it at flown.app'])
    for (const text of [
      '<a href="\\\\x@203.28935/verify">here</a>',
      '<a href="/\\x@203.28935/verify">',
      '<a href="\\\\x@1.1/verify">',
      '<a href="\\\\x@0xcb.0x7107/verify">',
      '<a href="\\\\x@203.0.29447/verify">',
      '[here](//x@203。28935/verify)',
      '[here](//x@203%2E28935/verify)',
      '//x@203．28935/verify',
      '//x@203｡0｡29447/verify'
    ]) {
      expect(linksToCheck(text, said), text).toHaveLength(1)
      expect(card(text)).toBe(text)
    }
  })
})

describe('safety 3: a Hebrew or Arabic prefix and "-" before a said host whose first label has no letter', () => {
  it('joins it: the "-" is noted with the host, and nothing is added to the copy (§4.8)', () => {
    for (const [captions, text] of [
      ['אפשר להוריד אותו מ-163.com', 'להורדה ב-163.com.'],
      ['Download it from 163.com today.', 'للتنزيل ب-163.com'],
      ['Download it from 163.com today.', 'להורדה ב-163.com.']
    ]) {
      expect(linksToCheck(text, saidOf([captions])), text).toEqual([text.split(' ').pop()])
      // No word joiner after the "-" any more: the copy is as written.
      expect(card(text)).toBe(text)
    }
  })
})

describe('damage 1 (high): a said link glued to Chinese or Japanese text and a dotted name later in it', () => {
  it('loses no character: the copy is as written, and the piece is noted (§4.4, §4.8)', () => {
    const said = saidOf(['https://flown.app', 'flown.app/docs', 'README.md', 'main.py', 'github.com/flown/recorder'])
    for (const text of [
      '官网https://flown.app，先打开README.md。',
      '可以在https://flown.app免费下载，然后运行main.py。',
      'ダウンロードはhttps://flown.appから。まずREADME.mdを開きます。',
      'https://flown.appからダウンロードして、README.mdを読んでください。',
      '新视频！Flown 2.4可以在https://flown.app免费下载，设置在config.yaml里修改，详细步骤见flown.app/docs。'
    ]) {
      expect(card(text)).toBe(text)
      expect(linksToCheck(text, said).length, text).toBeGreaterThan(0)
    }
  })
})

describe('damage 2: a said address followed by "，", "！", "（", "…"', () => {
  it('stands alone there: no note (§4.8)', () => {
    const said = saidLinks([seg('a', 'If you have questions, mail anna.li@acme.de or wei.wang@acme.com.')])
    for (const text of ['如有问题请联系 anna.li@acme.de，我们会尽快回复。', '有问题请发邮件到 wei.wang@acme.com！', 'お問い合わせは wei.wang@acme.com（平日のみ）', '문의: anna.li@acme.de（평일）', 'Write to anna.li@acme.de… we answer fast.']) {
      expect(linksToCheck(text, said), text).toEqual([])
    }
    // Where linkify-it reads the user name as a host instead, it is noted.
    for (const text of ['連絡先：anna.li@acme.de', '（anna.li@acme.de', "<a href='anna.li@acme.de'>", 'ダウンロードanna.li@acme.de']) expect(linksToCheck(text, said), text).toHaveLength(1)
  })
})

describe('damage 3: a said http(s) link after a letter of another script, or before "。" and more text', () => {
  it('is said where only its own scheme could join it, and before a sentence end (§4.8)', () => {
    const said = saidLinks([seg('a', 'アプリは https://flown.app からダウンロードできます。')])
    for (const text of ['官网https://flown.app，欢迎体验！', 'ダウンロード：https://flown.app。インストール後に起動してください。', '完成。https://flown.app 下载']) expect(linksToCheck(text, said), text).toEqual([])
    // Glued to the letters of another script after it, a said name is noted, as the prompts now ask for a space there (§4.1).
    for (const text of ['ダウンロードはhttps://flown.appから。次に設定を開きます。', '请访问https://flown.app下载，安装后打开即可。']) expect(linksToCheck(text, said), text).toEqual([text])
    // Still noted: another host after the dot.
    for (const text of ['https://flown.app。evil。com', 'https://flown.app。在线']) expect(linksToCheck(text, said), text).toEqual([text])
  })
})

describe('damage 4: a said address glued to Chinese, Japanese, Korean or Thai text', () => {
  it('is never broken: the copy is as written (§4.4); glued, it is noted, as linkify-it reads its user name as a host there', () => {
    const said = saidLinks([seg('a', 'Mail support@flown.app or anna.li@acme.de… wei.wang@acme.com or kim.do@acme.co.kr.')])
    for (const text of ['문의는 anna.li@acme.de로 보내주세요!', '문의: wei.wang@acme.com으로 연락 주세요.', '有问题请发邮件到wei.wang@acme.com。', 'ご質問はanna.li@acme.deまで！', 'แจ้งปัญหาได้ที่anna.li@acme.deครับ']) {
      expect(card(text)).toBe(text)
      expect(linksToCheck(text, said), text).toHaveLength(1)
    }
    // With a space, as the prompts ask (§4.1): no note.
    expect(linksToCheck('有问题请发邮件到 wei.wang@acme.com 。', said)).toEqual([])
    expect(linksToCheck('邮箱： wei.wang@acme.com', said)).toEqual([])
  })
})

describe('damage 5: a Markdown or HTML mailto link to a said address', () => {
  it('needs no note; an address nobody said does (§4.8)', () => {
    const said = saidLinks([seg('a', 'Mail support@flown.app or sam.lee@acme.io.')])
    for (const text of ['[Email support](mailto:support@flown.app)', '[Sam](mailto:sam.lee@acme.io).', '<a href="mailto:support@flown.app">support@flown.app</a>.', '邮箱：[support@flown.app](mailto:support@flown.app)', 'mailto:support@flown.app?subject=Hi']) {
      expect(linksToCheck(text, said), text).toEqual([])
    }
    for (const text of ['http:support@flown.app', '[Email](mailto:support.team@evil.de)', '[x](http:support.team@evil.de/login)']) expect(linksToCheck(text, said), text).toHaveLength(1)
  })
})

describe('damage 6: Thai, Lao, Khmer or Myanmar text ending in a mark before a said host', () => {
  it('is no rewrite any more, and glued text is noted, as the prompts ask for a space there (§4.1, §4.8)', () => {
    const said = saidLinks([seg('a', 'ดาวน์โหลดได้ที่ https://flown.app ครับ'), seg('b', 'คู่มืออยู่ที่ flown.app/docs')])
    for (const text of ['ส่วนตัวโปรแกรมโหลดได้ที่เว็บไซต์flown.appเลย', 'ดาวน์โหลดที่flown.appฟรี', 'ดาวน์โหลดได้ที่flown.appได้เลย']) {
      expect(card(text)).toBe(text)
      expect(linksToCheck(text, said), text).toEqual([text])
    }
    expect(linksToCheck('ดาวน์โหลดได้ที่ flown.app ได้เลย', said)).toEqual([])
  })
})

describe('damage 7: a dotted user name whose labels before the last are a top-level domain', () => {
  it('is noted (§4.8)', () => {
    const said = saidOf(['Get it at flown.app'])
    for (const text of ['Mail paypal-login.com.x@acme.de now', 'Mail login.paypal.com.team@acme.de now', 'Mail paypal.secure.team@acme.de now']) expect(linksToCheck(text, said), text).toHaveLength(1)
    // Said addresses are not.
    const addresses = saidOf(['Mail anna.li@acme.de or jane.doe.team@acme.de.'])
    for (const text of ['anna.li@acme.de', 'jane.doe.team@acme.de', '谢谢 anna.li@acme.de，谢谢']) expect(linksToCheck(text, addresses), text).toEqual([])
  })
})

describe('integration 1: what was said is read once per change of the captions, never per keystroke render', () => {
  it('is remembered for the caption list, and a caption is read once while its text stays (§4.8)', () => {
    const captions = Array.from({ length: 5000 }, (_, i) => seg(`c${i}`, `Caption ${i} names flown.app/docs/${i} and support@flown.app, then some more words to make it longer.`))
    let t = performance.now()
    const said = saidLinks(captions, { title: 'Demo', chapters: ['Intro'] })
    const first = performance.now() - t
    t = performance.now()
    expect(saidLinks(captions, { title: 'Demo', chapters: ['Intro'] })).toBe(said)
    expect(performance.now() - t).toBeLessThan(5)
    // A keystroke in one caption: a new list, read again, but each other caption's tokens are remembered.
    const edited = captions.map((c, i) => (i === 7 ? { ...c, text: `${c.text} x` } : c))
    t = performance.now()
    expect(saidLinks(edited, { title: 'Demo', chapters: ['Intro'] })).not.toBe(said)
    expect(performance.now() - t).toBeLessThan(Math.max(first, 50))
  })
})

describe('integration 2, 3 and 4: the note under a suggestion, and what it lists', () => {
  it('lists each noted piece exactly, one item per piece, whatever it holds ("%", "&"), as the confirm does (§4.8)', () => {
    const said = saidOf(['flown.jp/download'])
    // One piece with two names: one item (the heading counts items: tests/publishDialog.test.ts).
    expect(linksToCheck('第一步，打开README.md。第二步，在config.yaml里修改码率。第三步，运行main.py。整个导出大约需要2.5分钟。', said)).toHaveLength(1)
    // "%" and "&" change nothing in what is listed: the piece as written.
    const post = 'Flownの新しい書き出し機能を紹介します。書き出しが50%速くなりました。素材はログインflown.jp/downloadから。ぜひお試しください。質問はコメントでどうぞ。'
    expect(linksToCheck(post, said)).toEqual([post])
    expect(linksToCheck('今天介绍Flown的新导出功能。导出速度提升了50%。欢迎在评论区提问Q&A。', said)).toEqual([])
  })
})

describe('the record of what an AI wrote into the captions (aiLinks) stays: such a caption is never said', () => {
  it('records the pieces the check notes against what the caption said before, and keeps both records through a merge (§4.6)', () => {
    const before = seg('a', 'Download it from flown dot app.')
    expect(aiLinksAfter(before, 'Download it from flown.app.')).toEqual(['flown.app.'])
    expect(aiLinksAfter(seg('a', 'Get it at flown.app'), 'Get it at flown.app.')).toEqual([])
    // A caption an AI already wrote a link into says nothing: everything link-like in its new text is the AI's.
    expect(aiLinksAfter(seg('a', 'Get it at flown.app', { aiLinks: ['flown.app'] }), 'Get it at flown.app now')).toEqual(['flown.app'])
    const said = saidLinks([seg('a', 'Get it at flown.app.', { aiLinks: ['flown.app.'] })])
    expect(linksToCheck('Get it at flown.app', said)).toEqual(['flown.app'])
    const merged = mergeWithNext([seg('a', 'Get it at flown.app.'), seg('b', 'Or at paypal-login.com', { aiLinks: ['paypal-login.com'] })], 'a') as CaptionSegment[]
    expect(merged[0].aiLinks).toEqual(['paypal-login.com'])
    expect(linksToCheck('flown.app', saidLinks(merged))).toEqual(['flown.app'])
  })
})
