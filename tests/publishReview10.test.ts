import { describe, expect, it } from 'vitest'
import { applyTextResult } from '../src/shared/captions/edit'
import { textPrompt } from '../src/shared/captions/transcriptText'
import { linksToCheck, NOTHING_SAID, notedPieces, pieceParts, saidLinks, saidOf } from '../src/shared/publish/check'
import { CAPTION_LINK_RULE, validatePackAnswer } from '../src/shared/publish/prompts'
import { cutAt } from '../src/shared/publish/text'
import { composeYoutubeDescription, exportDescription } from '../src/shared/publish/youtube'
import type { OutputChapter } from '../src/shared/render/chapters'

/*
 * The problems the ninth review found in the link check (docs/design/publish-pack.md §4.8), each by
 * its own probe. All are closed in the check, its reading of what was said, or the cut of a text:
 * never by changing the copy.
 */

/** What the pack's LinkedIn card shows for `text`: the answer as written, but for cleaning that has nothing to do with links. */
const card = (text: string): string => (validatePackAnswer('linkedin', { text }) as { text: string }).text
const captions = (...texts: string[]): { text: string }[] => texts.map((text) => ({ text }))

describe('safety 1 (high): an attribute split across lines after a stray =" or =\' in the prose', () => {
  it('is read whole: the stray quote cannot take the attribute\'s opening quote (§4.8)', () => {
    const said = saidLinks(captions('Get it at flown.app today.'))
    const cases: [string, string][] = [
      ['New release! The new config uses a=" style values.\n<a href="https://flown.app\n@\npaypal-login\n.\ncom/verify">Sign in to download</a>', 'https://flown.app\n@\npaypal-login\n.\ncom/verify'],
      ['Set width = "100% then <a href="https://flown.app\n.\nevil\n.\ncom">here</a>', 'https://flown.app\n.\nevil\n.\ncom'],
      ["set it='on Intro.\n<a href='//flown.app\nx@\n203.0.113.7'>here</a>", '//flown.app\nx@\n203.0.113.7']
    ]
    for (const [text, value] of cases) {
      expect(linksToCheck(text, said), text).toContain(value)
      expect(card(text)).toBe(text.replace(/[ \t]+\n/g, '\n'))
    }
  })
})

describe('safety 2 (high): punctuation of another script after (or before) a said host in a URL', () => {
  it('runs on into another name when a dot follows in the same host, so it is noted (§4.8)', () => {
    const said = saidLinks(captions('Download it from flown.app today.', 'Mail anna.li@acme.de with questions.'))
    for (const text of [
      'Sign in to get it: https://flown.app·.ws/verify',
      'https://flown.app、.ws/verify',
      '[Download](https://flown.app’.ws/download)',
      '<a href="//flown.app」.com">x</a>',
      'https://flown.app·acme.de',
      '[here](mailto:anna.li@acme.de·.ws)',
      // Before the host: "//·flown.app" is xn--flown-pja.app.
      '<a href="//·flown.app">x</a>',
      '[x](//·flown.app)'
    ]) {
      expect(linksToCheck(text, said), text).toHaveLength(1)
      expect(card(text)).toBe(text)
    }
    // No dot after it in the same host: no other top-level domain, no note; nor for a name without a scheme, which a
    // linkifier ends at the punctuation.
    for (const text of ['https://flown.app、请下载', 'https://flown.app·', 'https://flown.app」。', 'flown.app’ten', 'Get it at flown.app·'])
      expect(linksToCheck(text, said), text).toEqual([])
  })
})

describe('safety 3: punctuation outside the Basic Multilingual Plane next to a said name', () => {
  it('joins it, as linkify-it reads it as a letter of the host (§4.8)', () => {
    const said = saidLinks(captions('Download it from flown.app today.', 'Use 163.com mail.'))
    expect(linksToCheck('Sign in at flown.app\u{10100}.ws to update.', said)).toEqual(['flown.app\u{10100}.ws'])
    expect(linksToCheck('get \u{10100}163.com mail', said)).toEqual(['\u{10100}163.com'])
    expect(linksToCheck('get 163.com mail at flown.app', said)).toEqual([])
  })
})

describe('safety 4: what was said holds only the hosts a parser opens there', () => {
  it('not the user name of an address, a name in a query or a fragment, nor one in a path (§4.8)', () => {
    const said = saidLinks(captions('Mail anna.li@acme.de for access.', 'Get it at https://flown.app/?ref=paypal-login.com or flown.app/get/install.sh'))
    for (const text of ['Visit https://anna.li to sign in.', 'Sign in at https://paypal-login.com now', 'Go to paypal-login.com', 'Run https://install.sh', 'Open //anna.li'])
      expect(linksToCheck(text, said), text).toHaveLength(1)
    // What was said stays said: the address and its host, the links whole, and their hosts.
    for (const text of ['Mail anna.li@acme.de', 'acme.de', 'https://flown.app/?ref=paypal-login.com', 'flown.app/get/install.sh', 'flown.app', 'mailto:anna.li@acme.de'])
      expect(linksToCheck(text, said), text).toEqual([])
  })
})

describe('safety 5: the export composes the saved description again with the chapters it has then', () => {
  const chapters = (n: number): OutputChapter[] => Array.from({ length: n }, (_, i) => ({ start: i * 60, title: `第${i + 1}章：这一章讲的是导出设置里一个很长很长的选项说明` }))
  it('a cut inside a word never ends a name early, so no name the check did not see is made (§4.4, §4.7)', () => {
    const text = `${'这'.repeat(1490)}：paypal-login.comfort${'这'.repeat(1500)}`
    // As saved: nothing link-like ("comfort" is no top-level domain), so Use for exports asked nothing.
    expect(linksToCheck(text, NOTHING_SAID)).toEqual([])
    // Cut exactly after ".com" (1 490 + 1 + 16 characters, then "…"): before the name's last label instead.
    const cut = cutAt(text, 1508)
    expect(cut).toBe(`${'这'.repeat(1490)}：paypal-login…`)
    expect(linksToCheck(cut, NOTHING_SAID)).toEqual([])
    for (let max = 1490; max < 1515; max++) expect(linksToCheck(cutAt(text, max), NOTHING_SAID), String(max)).toEqual([])
    // The export's file with many more chapters than when it was saved: never a name the check did not note.
    for (let n = 3; n <= 60; n++) {
      const file = exportDescription({ publish: { description: text } } as never, 'T', 3600, chapters(n))
      expect(linksToCheck(file, NOTHING_SAID), String(n)).toEqual([])
      expect(file).toBe(`${composeYoutubeDescription(text, chapters(n), 3600)}\n`)
    }
    // A label of any script is kept whole too.
    expect(cutAt(`${'日'.repeat(20)}еvil.онлайнабв${'日'.repeat(20)}`, 32)).toBe(`${'日'.repeat(20)}еvil…`)
  })
})

describe('damage 1 and integration 2: Chinese and Japanese prose with no link', () => {
  it('a full-width colon or at sign, or 。 before a word that is a top-level domain, is prose: no note (§4.8)', () => {
    const said = saidLinks(captions('Today I show Flown, get it at flown.app'), { title: 'Flown tour' })
    for (const text of [
      'Windows：GPU导出更稳定',
      'macOS：减少内存占用',
      'PS：记得点赞关注！',
      'Node：20',
      'VS Code：按F5运行',
      'Steam：设置→游戏内',
      'Excel：数式タブ→関数の挿入',
      'Flown：Windows向けの画面録画ツール',
      'Flown：一款适用于 Windows 的录屏工具',
      'OBS：免费，但设置复杂',
      'Tip：use it',
      'Step１：Open',
      'GitHub：flown/recorder',
      '今日はありがとうございました。みんな、また次回！',
      '謝謝收看。中國、台灣、香港的朋友都可以用！',
      '分享一个游戏录屏的小技巧。手机、电脑都能看。',
      '这是Chrome。网络设置在右上角',
      '小技巧。Windows和Mac',
      '…紹介します。みんな、ぜひ…',
      '…第一步。在线，…',
      '勉強会＠渋谷',
      '下载：flown.app',
      'ダウンロード： flown.app 。'
    ])
      expect(linksToCheck(text, said), text).toEqual([])
  })

  it('where a parser reads them as a URL\'s, they still count: between ASCII names, or with a scheme or "//" (§4.8)', () => {
    const said = saidLinks(captions('Today I show Flown, get it at flown.app'))
    for (const text of ['paypal-login。com', 'ｐａｙｐａｌ。ｃｏｍ', 'https://flown.app。在线', '//x@203．28935/verify', 'https://flown.app：443@evil.com', 'x@evil.com', 'https：//evil.com'])
      expect(linksToCheck(text, said), text).toHaveLength(1)
  })
})

describe('damage 3: a Hebrew or Arabic prefix and "-" before the user\'s own link', () => {
  it('the link after the "-" is said too, so the copy that writes it with spaces gets no note (§4.8)', () => {
    const said = saidLinks(captions('אפשר להוריד מ-flown.app ואת התיעוד ב-flown.app/docs.', 'כתבו ל-support@flown.app.', 'حمّل التطبيق من ب-163.com'))
    for (const text of ['הורדה: flown.app', 'https://flown.app', 'תיעוד: flown.app/docs', 'תמיכה: support@flown.app', 'mailto:support@flown.app', 'למידע: 163.com', 'להורדה מ-flown.app'])
      expect(linksToCheck(text, said), text).toEqual([])
    // A name glued to it is still noted.
    expect(linksToCheck('להורדה מ-flown.app.evil.com', said)).toHaveLength(1)
  })
})

describe('integration 3: Translate to… and Fix captions keep the user\'s spoken links said', () => {
  const segments = [
    { id: 'a', start: 0, end: 2, text: 'Download it at flown.app and read the docs.' },
    { id: 'b', start: 2, end: 4, text: 'Questions? Mail support@flown.app.' }
  ]
  it('their prompts ask for each link with a space on each side (§4.1)', () => {
    for (const task of ['cleanup', 'translate'] as const) expect(textPrompt({ task, segments, targetLanguage: 'Japanese' }).system.endsWith(` ${CAPTION_LINK_RULE}`), task).toBe(true)
  })
  it('so the translated captions record no AI link, and a card naming them gets no note (§4.6, §4.8)', () => {
    const spaced = applyTextResult(segments, [
      { ...segments[0], text: 'flown.app からダウンロードして、ドキュメントを読んでください。' },
      { ...segments[1], text: '質問は support@flown.app まで。' }
    ])
    expect(spaced?.map((s) => s.aiLinks)).toEqual([undefined, undefined])
    const card = 'Flownは flown.app から無料でダウンロードできます。質問は support@flown.app まで。'
    expect(linksToCheck(card, saidLinks(spaced ?? []))).toEqual([])
    // Glued, as the prompt said nothing before: noted against what each caption said, and then never said again.
    const glued = applyTextResult(segments, [
      { ...segments[0], text: 'flown.appからダウンロードして、ドキュメントを読んでください。' },
      { ...segments[1], text: '質問はsupport@flown.appまで。' }
    ])
    expect(glued?.every((s) => s.aiLinks?.length)).toBe(true)
  })
})

describe('damage 4 and integration 5: what a note marks in a long piece', () => {
  const shown = (piece: string): string =>
    pieceParts(piece)
      .map((p) => (p.marked ? `[${p.text}]` : p.text))
      .join('')
  it('marks the link-like runs and shows the text glued to them as it is (§4.8)', () => {
    expect(shown('Flownの書き出しが簡単すぎる…Ctrl+Shift+E→MP4→完了。flown.appから無料で使えます')).toBe('Flownの書き出しが簡単すぎる…Ctrl+Shift+E→MP4→完了。[flown.app]から無料で使えます')
    expect(shown('2.4はhttps://flown.appから無料でダウンロードできます。設定はconfig.yamlで、詳しい手順はflown.app/docsにまとめました。')).toBe(
      '2.4は[https://flown.app]から無料でダウンロードできます。設定は[config.yaml]で、詳しい手順は[flown.app/docs]にまとめました。'
    )
    expect(shown('สอนส่งออกวิดีโอด้วยFlownแบบง่ายๆ ดาวน์โหลดได้ที่flown.appได้เลย')).toBe('สอนส่งออกวิดีโอด้วยFlownแบบง่ายๆ ดาวน์โหลดได้ที่[flown.app]ได้เลย')
    expect(shown('ログインflown.jp/download')).toBe('ログイン[flown.jp/download]')
    expect(shown('https://flown.app·.ws/verify')).toBe('[https://flown.app]·[.ws/verify]')
    expect(shown('evil.在线')).toBe('[evil.在线]')
    // Invisible characters by their code, inside the run; a piece without a link-like run is marked whole.
    expect(shown('evil​.com')).toBe('[evil⟨U+200B⟩.com]')
    expect(shown('ありがとう.みんな')).toBe('[ありがとう.みんな]')
    // Nothing is lost or added: the parts are the piece as shown.
    const piece = '完了。flown.appから​無料'
    expect(pieceParts(piece).map((p) => p.text).join('')).toBe('完了。flown.appから⟨U+200B⟩無料')
  })
})

describe('the ninth review\'s texts against what was said', () => {
  it('each bypass is a noted piece, the copy as written (§4.8)', () => {
    const said = saidOf(['Download it from flown.app or https://flown.app/download, mail support@flown.app.', 'Mail anna.li@acme.de and open README.md and main.py.'])
    expect(notedPieces('Go to https://flown.app·.ws now', said)).toEqual([{ start: 6, end: 27, text: 'https://flown.app·.ws' }])
  })
})
