import { describe, expect, it } from 'vitest'
import { aiLinksAfter, applyTextResult, typedCaption } from '../src/shared/captions/edit'
import { linksToCheck, NOTHING_SAID, notedPieces, pieceParts, saidLinks, saidOf, type Said } from '../src/shared/publish/check'
import { validatePackAnswer } from '../src/shared/publish/prompts'
import { cutAt, plainText } from '../src/shared/publish/text'
import { extractUrlsWithIndices } from '../src/shared/publish/twitterText'
import { composeYoutubeDescription, descriptionToCheck, exportDescription } from '../src/shared/publish/youtube'
import type { OutputChapter } from '../src/shared/render/chapters'
import type { CaptionSegment } from '../src/shared/types'

/*
 * The problems the tenth review found in the link check (docs/design/publish-pack.md §4.6–4.8), each
 * by its own probe. All are closed in the check's readings, what it counts as said, what Use for
 * exports asks about, the cut of a text, or what a note marks: never by changing the copy.
 */

/** What a pack card shows for `text`: the answer as written, but for cleaning that has nothing to do with links. */
const card = (task: 'linkedin' | 'xpost', text: string): string => (validatePackAnswer(task, { text }) as { text: string }).text
const captions = (...texts: string[]): { text: string }[] => texts.map((text) => ({ text }))
const flown = saidLinks(captions('Today I show Flown. Get it at flown.app and read the docs.', 'Questions? Mail support@flown.app.'), { title: 'Flown tour' })

describe('safety 1 (high): a look-alike whose name ends in a Latin letter with an accent, glued to Chinese or Japanese', () => {
  it('is noted, as X reads that letter into the name and ends the top-level domain at the next script (§4.8)', () => {
    for (const text of ['最新版はflowń.comからダウンロードできます！', 'Flownの書き出し、最高。flowné.appで無料です', 'Sign in at paypal-loginÀ.comÀtoday.', '下载请到flowñ.app下载']) {
      const post = card('xpost', text)
      expect(post).toBe(text)
      // X links it (the vendored twitter-text, as upstream 3.1.0 does).
      expect(extractUrlsWithIndices(post).length, text).toBe(1)
      expect(linksToCheck(post, flown), text).toHaveLength(1)
    }
    // A combining accent, as written: the same.
    expect(linksToCheck('最新版はflowń.comからです', flown)).toHaveLength(1)
    // The said name glued the same way is still the user's when it stands alone.
    expect(linksToCheck('最新版は flown.app からです', flown)).toEqual([])
  })
})

describe('safety 2 (high): a Markdown backslash escape after punctuation a host keeps', () => {
  it('is read as markdown-it reads it, so the name it opens is noted (§4.8)', () => {
    for (const text of [
      'Project files: [download](https://flown.app·\\.ws/download)',
      '[the project page](https://flown.app·\\.ws/download)',
      'Sign in: [here](//flown.app’\\.ws/verify)',
      '[x](mailto:support@flown.app·\\.ws)',
      '[x](<https://flown.app·\\.ws/download>)',
      '[x](https://flown.app¶\\.ws)',
      '[x](https://flown.app»\\.ws)',
      '[x](https://flown.app\\.evil\\.com)'
    ]) {
      expect(card('linkedin', text)).toBe(text)
      expect(linksToCheck(text, flown), text).toHaveLength(1)
    }
    // The article's steps, as the pack writes them.
    const article = validatePackAnswer('article', { title: 'How to export', intro: 'Get the project files first.', sections: [{ heading: 'Setup', steps: ['Download the files from [the project page](https://flown.app·\\.ws/download).'] }] }) as { text: string }
    expect(linksToCheck(article.text, flown)).toEqual(['page](https://flown.app·\\.ws/download).'])
    // An escape that changes nothing about the host: the said link stays said.
    for (const text of ['Get it at flown.app\\!', '\\*flown.app\\*', '[download](https://flown.app)\\.']) expect(linksToCheck(text, flown), text).toEqual([])
  })
})

describe('safety 3: Use for exports asks about what any export can write', () => {
  const titles = Array.from({ length: 30 }, (_, i) => `Part ${i + 1}: setting up the export preset and checking each option`)
  const chapters = (n: number): OutputChapter[] => titles.slice(0, n).map((title, i) => ({ start: i * 60, title }))
  const filler = 'In this video I walk through every setting of the export dialog and explain what each one does. '
  let text = ''
  while (text.length + filler.length < 2900) text += filler
  const body = plainText(`${text}Sign in to get the project files at paypal-login.com/flown today.`, { max: 3000 })

  it('also the text past the cut that fits the chapters now, which an export with fewer chapters writes (§4.7, §4.8)', () => {
    // With 30 chapters the description is cut before its last sentence: that alone has nothing to note.
    const now = composeYoutubeDescription(body, chapters(30), 1800)
    expect(now.includes('paypal-login.com')).toBe(false)
    expect(linksToCheck(now, flown)).toEqual([])
    // What Use for exports and the card's note check has it, so it is asked about before it is saved.
    const checked = descriptionToCheck(body, chapters(30), 1800)
    expect(checked.startsWith(now)).toBe(true)
    expect(linksToCheck(checked, flown)).toEqual(['paypal-login.com/flown'])
    // Every export writes nothing that is not in what was checked.
    for (const n of [30, 20, 10, 3, 0]) {
      const file = exportDescription({ publish: { description: body } } as never, 'Flown tour', 1800, chapters(n))
      for (const piece of notedPieces(file, NOTHING_SAID)) expect(notedPieces(checked, NOTHING_SAID).map((p) => p.text), String(n)).toContain(piece.text)
    }
    // When nothing is cut, it is the description as composed.
    expect(descriptionToCheck(body, chapters(3), 1800)).toBe(composeYoutubeDescription(body, chapters(3), 1800))
    expect(descriptionToCheck(body, [], 1800)).toBe(composeYoutubeDescription(body, [], 1800))
    expect(descriptionToCheck('', chapters(3), 1800)).toBe(composeYoutubeDescription('', chapters(3), 1800))
  })

  it('also when the chapters leave no room for the text at all', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ start: i * 60, title: `Part ${i + 1}: ${'a very long chapter title '.repeat(3)}` }))
    const composed = composeYoutubeDescription(body, many, 4200)
    expect(composed.includes('In this video')).toBe(false)
    expect(linksToCheck(descriptionToCheck(body, many, 4200), flown)).toEqual(['paypal-login.com/flown'])
  })
})

describe('safety 4: editing a caption by hand keeps the record of a link an AI wrote into it', () => {
  const caps: CaptionSegment[] = [
    { id: 'a', start: 0, end: 4, text: 'Today I show Flown, get it at flown.app.' },
    { id: 'b', start: 4, end: 9, text: 'for the project files go to paypal login dot com slash flown and sign in' }
  ]
  it('while a link is left in it, so the link never becomes said (§4.6)', () => {
    const fixed = applyTextResult(caps, [caps[0], { ...caps[1], text: 'For the project files go to paypal-login.com/flown and sigh in.' }]) as CaptionSegment[]
    expect(fixed[1].aiLinks).toEqual(['paypal-login.com/flown'])
    const copy = 'Grab the project files at paypal-login.com/flown and sign in.'
    expect(linksToCheck(copy, saidLinks(fixed))).toEqual(['paypal-login.com/flown'])
    // The user fixes "sigh" to "sign": the AI's link is still in the caption, and still not said.
    const edited = fixed.map((s) => (s.id === 'b' ? typedCaption(s, s.text.replace('sigh in', 'sign in')) : s))
    expect(edited[1]).toEqual({ id: 'b', start: 4, end: 9, text: 'For the project files go to paypal-login.com/flown and sign in.', aiLinks: ['paypal-login.com/flown'] })
    expect(linksToCheck(copy, saidLinks(edited))).toEqual(['paypal-login.com/flown'])
    // Once no link is left, the caption is the user's again; a caption without the record stays without it.
    expect(typedCaption(edited[1], 'For the project files ask me and sign in.')).toEqual({ id: 'b', start: 4, end: 9, text: 'For the project files ask me and sign in.' })
    expect(typedCaption(caps[0], 'Today I show Flown, get it at flown.app now.')).toEqual({ ...caps[0], text: 'Today I show Flown, get it at flown.app now.' })
    // The same text keeps the record as it is.
    expect(typedCaption(fixed[1], fixed[1].text)).toEqual(fixed[1])
    expect(aiLinksAfter(fixed[1], fixed[1].text)).toEqual(['paypal-login.com/flown'])
  })
})

describe('safety 5: an escape and a variation selector inside a name', () => {
  it('is read as linkify-it and a URL read it: the escape as written, the selector dropped (§4.8)', () => {
    for (const text of ['Get it at %66lown️.app today', 'Get it at &#102;lown︎.app today', 'Get it at %66lown\u{e0100}.app today', 'Get it at %66lown᠋.app today']) {
      expect(card('linkedin', text)).toBe(text)
      expect(linksToCheck(text, flown), JSON.stringify(text)).toHaveLength(1)
    }
    // A said link with a selector after it (an emoji's) is still said.
    expect(linksToCheck('Get it at flown.app️ today', flown)).toEqual([])
  })
})

describe('safety 6: a capital sharp s after a said link', () => {
  it('is read as "ss", as WHATWG `new URL` in Node maps it: a name on .ss (§4.8)', () => {
    for (const text of ['Sign in: <a href="https://flown.app.ẞ/login">project files</a>', '//flown.app｡ẞ', 'https://flown.app.ẞ', 'flown.app.ẞ']) expect(linksToCheck(text, flown), text).toHaveLength(1)
    expect(linksToCheck('Straße: flown.app', flown)).toEqual([])
  })
})

describe('damage 1: a Chinese or Japanese sentence that ends in an ASCII word, then one that starts with a capital', () => {
  const said = saidLinks(captions('大家好，今天介绍 Flown。下载地址是 flown.app 。'), { title: 'Flown 教程', chapters: ['开场'] })
  it('is prose: the full stop before a capital ends a sentence, so no note (§4.8)', () => {
    for (const text of [
      '支持导出 MP4 和 GIF。Windows 和 Mac 都能用。',
      '新版支持 4K 导出和 GIF。AI 字幕也更准了。',
      '支持MP4和GIF。AI字幕也很准。',
      '画質は最大4K。YouTubeにそのままアップできます。',
      '先装好 OBS。Chrome 里打开插件页面。',
      '导出格式选 MP4。App 端也能直接看。',
      '本期用的是 Premiere Pro。Google 搜索一下就能找到教程。',
      '支持 1080p。TV 上播放也很清楚。',
      '录完点 Export。Android 手机也能看。',
      '書き出しは MP4。Office のスライドにも貼れます。',
      '設定は OK。Next をクリックします。',
      '用 Python。Java 版本下期讲。',
      '本期教你剪辑 Vlog。Pro 版功能下期再讲。'
    ])
      expect(linksToCheck(text, said), text).toEqual([])
  })
  it('a stop before a lower-case letter or a digit, or with a scheme or "//", is still a dot (§4.8)', () => {
    for (const text of ['paypal-login。com', 'flown。app。evil', 'https://Flown.App。Evil', '//Paypal。Com', 'x@Paypal。Com', 'ｐａｙｐａｌ。ｃｏｍ', 'x@203。0。113。7'])
      expect(linksToCheck(text, said), text).toHaveLength(1)
  })
})

describe('damage 2: a link said with a word\'s ending after a "-" (Bangla, Tamil, Marathi, Telugu, Kannada, Malayalam)', () => {
  it('is said, so the copy that writes it with spaces gets no note (§4.8)', () => {
    const cases: [string, string][] = [
      ['আজ Flown দেখাব। flown.app-এ গিয়ে ডাউনলোড করুন।', 'ডাউনলোড: flown.app'],
      ['flown.app-இல் பதிவிறக்கம் செய்யுங்கள்', 'பதிவிறக்கம்: flown.app'],
      ['flown.app-ला भेट द्या.', 'भेट द्या: https://flown.app'],
      ['flown.app-ని తెరవండి', 'flown.app'],
      ['flown.app-ನಲ್ಲಿ ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ', 'flown.app'],
      ['flown.app-ൽ നിന്ന് ഡൗൺലോഡ് ചെയ്യുക', 'flown.app'],
      ['config.yaml-ஐ திறக்கவும்', 'config.yaml'],
      ['README.md-তে সব লেখা আছে', 'README.md'],
      ['support@flown.app-এ লিখুন', 'support@flown.app']
    ]
    for (const [caption, text] of cases) expect(linksToCheck(text, saidLinks(captions(caption))), caption).toEqual([])
    // A name glued after it is still noted, and so is another name.
    const said = saidLinks(captions('flown.app-এ গিয়ে ডাউনলোড করুন।'))
    for (const text of ['flown.app-এ.evil.com', 'flown.app.evil.com', 'paypal-login.com']) expect(linksToCheck(text, said), text).toHaveLength(1)
  })
})

describe('damage 3: a long piece with no ASCII space', () => {
  it('is read in linear time (§4.8)', () => {
    const time = (text: string): number => {
      const t = performance.now()
      notedPieces(text, flown)
      return performance.now() - t
    }
    time(`x.${'a'.repeat(1000)}`)
    // 20 000 and 80 000 characters: four times as long takes about four times as long, not sixteen (it took 2.3 s at 50 000).
    const short = Math.min(time(`x.${'a'.repeat(20_000)}`), time(`x.${'a'.repeat(20_000)}`))
    const long = Math.min(time(`x.${'a'.repeat(80_000)}`), time(`x.${'a'.repeat(80_000)}`))
    expect(long).toBeLessThan(400)
    expect(long).toBeLessThan(Math.max(10, short) * 10)
    expect(time('a.'.repeat(40_000))).toBeLessThan(400)
  })
})

describe('damage 4: a cut inside a word in Chinese or Japanese', () => {
  it('keeps a version or a decimal whole: only a label that starts with a letter is a top-level domain (§4.4)', () => {
    const text = `${'新しい'.repeat(30)}バージョン2.4で書き出しが速くなりました${'とても'.repeat(30)}`
    for (const max of [100, 104, 110]) expect(cutAt(text, max).includes('バージョン2.4で'), String(max)).toBe(true)
    expect(cutAt(text, 104)).toBe(`${[...text].slice(0, 103).join('')}…`)
    // A name's last label still goes whole.
    expect(cutAt(`${'这'.repeat(1490)}：paypal-login.comfort${'这'.repeat(1500)}`, 1508)).toBe(`${'这'.repeat(1490)}：paypal-login…`)
  })
})

describe('integration 1: what a note and a confirm mark in a long piece', () => {
  const shown = (piece: string, said: Said = NOTHING_SAID): string =>
    pieceParts(piece, said)
      .map((p) => (p.marked ? `[${p.text}]` : p.text))
      .join('')
  const said = saidOf(['Download it at flown.app and read flown.app/docs.', 'Questions? Mail support@flown.app.'])
  it('marks the name that is why it is noted, in any script, not the said link standing alone nor a colon (§4.8)', () => {
    expect(linksToCheck('下载地址：flown.app，登录请访问：支付宝登录.在线', said)).toHaveLength(1)
    expect(shown('下载地址：flown.app，登录请访问：支付宝登录.在线', said)).toBe('下载地址：flown.app，登录请访问：[支付宝登录.在线]')
    expect(shown('Flown2.4.1版本发布了，登录领取：会员登录.在线', said)).toBe('Flown2.4.1版本发布了，登录领取：[会员登录.在线]')
    expect(shown('flown.appとпример.рф', said)).toBe('[flown.appとпример.рф]')
    expect(shown('flown.app，пример.рф', said)).toBe('flown.app，[пример.рф]')
    // A name no parser opens (its label is no top-level domain) is not marked: here the said link glued to letters is why.
    expect(shown('ダウンロードはflown.appから、ログインはアカウント確認.みんなで', said)).toBe('ダウンロードは[flown.app]から、ログインはアカウント確認.みんなで')
    expect(shown('下载：flown.app，登录：アカウント確認.みんな', said)).toBe('下载：flown.app，登录：[アカウント確認.みんな]')
    // A said link glued to letters is why: marked.
    expect(shown('完了。flown.appから無料で使えます', said)).toBe('完了。[flown.app]から無料で使えます')
    expect(shown('10和11。请先在flown.app下载安装包', said)).toBe('10和11。请先在[flown.app]下载安装包')
    // A full stop ends a sentence: the next one is not marked with the name before it.
    expect(shown('第一步，打开README.md。第二步，运行main.py。', said)).toBe('第一步，打开[README.md]。第二步，运行[main.py]。')
    // A said link and punctuation a host keeps before a dot: the host it runs on into is marked whole.
    expect(shown('https://flown.app·.ws/verify', said)).toBe('[https://flown.app·.ws/verify]')
    expect(shown('下载：https://flown.app·.ws，谢谢', said)).toBe('下载：[https://flown.app·.ws]，谢谢')
    expect(shown('https://flown.app·acme.de', said)).toBe('[https://flown.app·acme.de]')
    expect(shown('flowń.comからです', said)).toBe('[flowń.comからです]')
    // Nothing said: every link-like run, as before; full-width punctuation at either end is not marked.
    expect(shown('下载：flown.app，登录：evil.com，')).toBe('下载：[flown.app]，登录：[evil.com]，')
    expect(shown('（evil.com）')).toBe('（[evil.com]）')
  })
  it('stays linear on a long piece', () => {
    const t = performance.now()
    pieceParts(`${'这'.repeat(20_000)}支付宝登录.在线${'.'.repeat(20_000)}x${'a-'.repeat(10_000)}`, said)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
