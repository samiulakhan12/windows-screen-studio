/**
 * The problems of the eighth review of the copy pack's links (docs/design/publish-pack.md §4.4, §4.6,
 * §4.8): one test each by its title, each failing at 6330ad8 on its own expectation. Where a link got
 * past both layers, the safety net (check.ts) is widened; the cleaning is changed only where it
 * damaged what was said. NB is the no-break space a broken name gets after its dot.
 */
import { describe, expect, it } from 'vitest'
import type { AiTextRequest, AiTextResult, AiTextTask } from '../src/shared/api/ai'
import { readCaptionSegments } from '../src/shared/captions/captionData'
import { applyTextResult, mergeWithNext } from '../src/shared/captions/edit'
import { runTextTask, validateTextRequest } from '../src/shared/captions/transcriptText'
import { createProject } from '../src/shared/engine/project'
import * as check from '../src/shared/publish/check'
import { publishSegments } from '../src/shared/publish/pack'
import { packTranscript, validatePackAnswer } from '../src/shared/publish/prompts'
import { plainText, unsaidLinks } from '../src/shared/publish/text'
import type { CaptionSegment, Project } from '../src/shared/types'

const { linksToCheck, saidLinks } = check

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PUBLISH_RUN = '../src/renderer/src/publish/publishRun'
const { cardText } = (await import(/* @vite-ignore */ PUBLISH_RUN)) as {
  cardText: (result: AiTextResult, segments: readonly Pick<CaptionSegment, 'text' | 'aiLinks'>[], context?: { title?: string; chapters?: string[] }) => { text: string; tags: string }
}

const NB = String.fromCharCode(0xa0)
const NONE = 'In this video I show how to export a clip with Flown.'
const notes = (text: string, said: string | CaptionSegment[] = NONE, context?: { title?: string; chapters?: string[] }): string[] =>
  linksToCheck(text, saidLinks(typeof said === 'string' ? [{ text: said }] : said, context))

/** A project of `captions` (one clip over all of them). */
function projectOf(captions: CaptionSegment[]): Project {
  const p = createProject({
    id: 'p',
    name: 'Demo',
    duration: 60,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  return { ...p, transcript: { provider: 'openai', model: 'm', createdAt: '', segments: captions } }
}

/** The LinkedIn card `answer` gives for `captions` as the app writes it: the request main checks, main's run, the dialog's cleaning. */
async function linkedin(answer: string, captions: CaptionSegment[]): Promise<string> {
  const segments = publishSegments(projectOf(captions))
  const request = validateTextRequest({ task: 'linkedin' as AiTextTask, segments, context: { title: 'Demo' } } satisfies Partial<AiTextRequest>)
  const result = await runTextTask(request, async () => ({ text: answer }))
  return cardText(result, segments, { title: 'Demo' }).text
}

/** The captions Fix captions stores for `texts`: main's check, then the Captions tab's apply. */
async function fixed(input: CaptionSegment[], texts: Record<string, string>): Promise<CaptionSegment[]> {
  const result = await runTextTask({ task: 'cleanup', segments: input }, async () => ({ segments: input.map((s) => ({ id: s.id, text: texts[s.id] ?? s.text })) }))
  const next = applyTextResult(input, (result as { segments: CaptionSegment[] }).segments)
  if (!next) throw new Error('not applied')
  return next
}

/** The captions after a save and a load of the project. */
const reloaded = (captions: CaptionSegment[]): CaptionSegment[] => readCaptionSegments(JSON.parse(JSON.stringify(captions)))

/** What the safety net notes in the `task` card main keeps from `answer`, with what it kept. */
function packNotes(task: 'article' | 'releaseNotes', answer: Record<string, unknown>, transcript: string): { text: string; notes: string[] } {
  const segments = [{ id: 'a', start: 0, end: 5, text: transcript }]
  const context = { title: 'Export a clip' }
  const { text } = validatePackAnswer(task, answer, packTranscript(segments).text, context, unsaidLinks(segments, context)) as { text: string }
  return { text, notes: linksToCheck(text, saidLinks(segments, context)) }
}

const SAID_SITE = 'Download Flown from flown.app, then open your recording and press export to share the clip.'

describe('the copy pack after the eighth review of its links', () => {
  it('Raw HTML: a line break, a space or a numeric reference without ";" in an href hides a link from both layers', () => {
    // A browser drops tabs and line breaks in a URL, reads a space before "@" as part of a user name, and decodes
    // "&#46" without ";": each of these opens paypal-login.com.
    for (const href of [
      'https://flown.app\n@paypal-login.com/verify',
      'https://flown.app\t@paypal-login.com/verify',
      'https://flown.app @paypal-login.com/verify',
      `https://flown.app${NB}@paypal-login.com/verify`,
      '//paypal-login.\ncom/verify',
      'https://flown.app\n.evil.com/x'
    ]) {
      const { text, notes: noted } = packNotes('releaseNotes', { title: 'Flown 1.4', summary: `Get the build <a href="${href}">here</a>.`, items: [{ kind: 'new', text: 'Export in one click' }] }, SAID_SITE)
      // Kept (a tab as a space, which a browser reads the same way there).
      const kept = href.replace(/\t/g, ' ')
      expect(text, href).toContain(kept)
      expect(noted, href).toEqual([kept])
    }
    for (const ref of ['&#46', '&#0000046;', '&#x2e;', '&#X02E;']) {
      const href = `//paypal-login${ref}com/verify`
      const { notes: noted } = packNotes('article', { title: 'Export', intro: `Get the sample <a href="${href}">here</a>.`, sections: [{ heading: 'Export', steps: ['Press Export'] }] }, SAID_SITE)
      expect(noted, href).toEqual([`href="${href}">here</a>.`])
    }
    // So does a space written as a reference or an escape there (the cleaning puts a space before it).
    for (const space of ['&nbsp;', '%20']) {
      const { notes: noted } = packNotes('article', { title: 'Export', intro: `Get it <a href="https://flown.app${space}@paypal-login.com/verify">here</a>.`, sections: [{ heading: 'Export', steps: ['Press Export'] }] }, SAID_SITE)
      expect(noted, space).toHaveLength(1)
      expect(noted[0], space).toContain(`${space}@paypal-login.com/verify`)
    }
    // A Markdown destination in "<…>" may hold a space, which markdown-it percent-encodes.
    expect(notes('Get it [here](<https://flown.app @paypal-login.com/verify>).', SAID_SITE)).toEqual(['https://flown.app @paypal-login.com/verify'])
    expect(notes('[here]: <https://flown.app @paypal-login.com/verify>', SAID_SITE)).toEqual(['https://flown.app @paypal-login.com/verify'])
    // A said link in an attribute, text with spaces in an attribute that takes none, and a name the cleaning broke in a
    // host (where a browser opens nothing), need no note.
    for (const ok of [
      'Get it <a href="https://flown.app" title="Download Flown from flown.app">here</a>.',
      '<img src="shot.png" alt="Download it from flown.app today">',
      'Get it [here](<https://flown.app/docs>).',
      `Get it <a href="//paypal-login.${NB}com/verify">here</a>.`,
      `Get it <a href="\\/x@paypal-login.${NB}com/verify">here</a>.`
    ]) {
      expect(notes(ok, SAID_SITE), ok).toEqual([])
    }
  })

  it("A '\\' read as '/' before a host, and an IPv6 host, are kept and not noted", () => {
    for (const href of ['\\/paypal-login.com/verify', '/\\203.28935/verify', '/\\3405803783/verify', '\\/203.0.113.7/verify', '//[2606:4700:4700::1111]/verify', '//x@[::ffff:cb00:7107]/verify', 'https:[2606:4700::1111]/x']) {
      const { text, notes: noted } = packNotes('article', { title: 'Export', intro: `Get it <a href="${href}">here</a>.`, sections: [{ heading: 'Export', steps: ['Press Export'] }] }, SAID_SITE)
      expect(text, href).toContain(href)
      expect(noted, href).toEqual([`href="${href}">here</a>.`])
    }
    // The cleaning breaks a name after "\\/" and "@"; the net notes it unbroken.
    expect(notes('Get it at \\/x@paypal-login.com/verify', SAID_SITE)).toEqual(['\\/x@paypal-login.com/verify'])
    for (const ok of ['Python: mid = (lo+hi)//2 and the ratio is 3//4.5.', 'a\\b c/\\d', 'C:\\Users\\me\\Videos\\clip.mp4']) expect(notes(ok, SAID_SITE), ok).toEqual([])
  })

  it("A full-width '＠', '／', '＿' or '…' before a mixed-script host loses the note: NFKC makes it what no site starts a link after", () => {
    const said = 'You can download it from flown.jp/download today.'
    for (const p of ['＠', '﹫', '／', '＿', '︳', '…', '‥', '﹒', '℅', '⒈']) {
      const card = `ダウンロードは${p}ログインflown.jp/downloadから。`
      expect(notes(card, said), p).toEqual([card])
    }
    // A said address or path written with them needs no note.
    for (const ok of ['Mail support＠flown.app', 'Tokyo／Osaka … see flown.app／docs', '午前…午後']) expect(notes(ok, SAID_SITE), ok).toEqual([])
  })

  it("Merging an AI-fixed caption with the user's caption that says the same link takes the AI's stretch for said", async () => {
    const captions: CaptionSegment[] = [
      { id: 'a', start: 0, end: 3, text: 'You can get the project from flown dot jp slash download.' },
      { id: 'b', start: 3, end: 6, text: 'Again, that is flown.jp/download for the files.' },
      { id: 'c', start: 6, end: 9, text: 'Then open it in Flown and press export to share your clip.' }
    ]
    const stored = await fixed(captions, { a: 'You can get the project from ログインflown.jp/download' })
    const merged = mergeWithNext(stored, 'a') as CaptionSegment[]
    expect(merged[0].aiLinks?.length).toBeGreaterThan(0)
    const answer = 'New video! Grab the project files at ログインflown.jp/download'
    for (const segments of [stored, merged, reloaded(merged)]) {
      const card = await linkedin(answer, segments)
      expect(card).toBe(answer)
      expect(linksToCheck(card, saidLinks(publishSegments(projectOf(segments)), { title: 'Demo' }))).toEqual(['ログインflown.jp/download'])
    }
    // The said link itself stays said.
    expect(linksToCheck('Grab them at flown.jp/download', saidLinks(merged))).toEqual([])
  })

  it('A said name between letters of Chinese or Japanese is noted, so suggested titles fail and chapters are dropped', async () => {
    const captions: CaptionSegment[] = [
      { id: 'a', start: 0, end: 100, text: '大家好，今天介绍Flown 2.4的用法。' },
      { id: 'b', start: 100, end: 200, text: '可以在 flown.app 下载，文档在 flown.app/docs。' },
      { id: 'c', start: 200, end: 300, text: '先打开 README.md 和 config.yaml，然后运行 main.py。' }
    ]
    for (const title of ['在flown.app下载Flown并导出片段', '無料のflown.appで画面録画を始める方法']) {
      await expect(runTextTask({ task: 'title', segments: captions }, async () => ({ text: title })), title).resolves.toEqual({ task: 'title', text: title })
      expect(notes(title, captions), title).toEqual([])
    }
    const result = await runTextTask({ task: 'chapters', segments: captions }, async () => ({
      chapters: [
        { start: 0, title: '在flown.app下载' },
        { start: 100, title: '打开README.md和config.yaml' },
        { start: 200, title: '用VS Code编辑README.md文件' }
      ]
    }))
    expect((result as { chapters: { title: string }[] }).chapters.map((c) => c.title)).toEqual(['在flown.app下载', '打开README.md和config.yaml', '用VS Code编辑README.md文件'])
    for (const card of ['请先访问flown.app下载安装包。', 'まずflown.appにアクセスしてください。']) expect(notes(card, captions), card).toEqual([])
    // A host some site reads is still noted: before punctuation, a path or nothing, and after a Latin letter or "→".
    for (const card of ['运行main.py。', '请访问flown.app/docs。', 'こちら→flown.app', '登录flown.app', 'éflown.appから', '在flown.app下载.com']) expect(notes(card, captions), card).toEqual([card])
  })

  it("The user's own e-mail address gets a note on every card after Fix captions writes it out", async () => {
    const captions: CaptionSegment[] = [{ id: 'a', start: 0, end: 8, text: 'if you have questions write to anna dot li at acme dot de or wei dot wang at acme dot com' }]
    const stored = await fixed(captions, { a: 'If you have questions, write to anna.li@acme.de or wei.wang@acme.com.' })
    expect(stored[0].aiLinks).toBeUndefined()
    const answer = 'Questions? Write to anna.li@acme.de or wei.wang@acme.com.'
    expect(linksToCheck(await linkedin(answer, stored), saidLinks(stored))).toEqual([])
    // A name a linkifier reads before "@" is still noted.
    for (const card of ['paypal-login.com@hi.zz', 'paypal-login.com@x.co:80', 'anna.li@flown.app', '//anna.li@acme.de', 'http:support.team@evil.de/x', '連絡先：anna.li@acme.de', '*paypal.com@acme.de']) {
      expect(notes(card, stored), card).toEqual([card])
    }
  })

  it("A Hebrew or Arabic prefix joined by '-' to a said name gets a note", () => {
    const said = 'אפשר להוריד אותו מ-flown.app'
    for (const card of ['להורדה ב-flown.app.', 'للتنزيل ب-flown.app', 'להורדה ב-\u2060flown.app.']) expect(notes(card, said), card).toEqual([])
    // A Cyrillic prefix makes a name linkify-it opens; an unsaid name is noted.
    for (const card of ['на-flown.app', 'ב-evil.com']) expect(notes(card, said), card).toEqual([card])
  })

  it('In Chinese and Japanese the note shows a whole unspaced paragraph as the link', () => {
    const shownPart = (check as unknown as { shownPart?: (run: string, said: check.SaidLinks) => string }).shownPart
    expect(typeof shownPart).toBe('function')
    const show = (card: string, transcript: string): string[] => {
      const said = saidLinks([{ text: transcript }])
      return linksToCheck(card, said).map((run) => (shownPart as (run: string, said: check.SaidLinks) => string)(run, said))
    }
    expect(show('第一步，打开README.md。第二步，在config.yaml里修改码率。第三步，运行main.py。整个导出大约需要2.5分钟。', NONE)).toEqual(['打开README.md。 … 运行main.py。'])
    const ja = 'Flownは画面を録画して、ズームやカーソルの動きをきれいに整えるアプリです。編集も書き出しもかんたんで、チュートリアル動画づくりにぴったりです。素材はログインflown.jp/downloadから。ぜひ試してみてください。'
    expect(show(ja, 'You can download it from flown.jp/download today.')).toEqual(['素材はログインflown.jp/downloadから。'])
    expect(show('教程很简单，下载请访问登录flown.app。欢迎试用。', 'Download Flown from flown.app today.')).toEqual(['下载请访问登录flown.app。'])
    // A short stretch, a host whose dots may be "。", and an escape are shown whole.
    expect(show('更多教程请访问flown.app/docs。', 'Download Flown from flown.app today.')).toEqual(['更多教程请访问flown.app/docs。'])
    for (const card of ['//paypal-login。com\\\\support@flown.app', '[here](https:paypal-login．com)。']) expect(show(card, NONE), card).toEqual([card])
    // When what is left without the noted clauses is noted too, the whole stretch is shown.
    expect(show('登录flown.app。&#47;&#47;paypal-login。com/verify', 'Download Flown from flown.app today.')).toEqual(['登录flown.app。&#47;&#47;paypal-login。com/verify'])
  })

  it("Suggest a title fails outright when the AI glues the user's said link to Chinese, Japanese, Korean or Hebrew text", async () => {
    const captions: CaptionSegment[] = [{ id: 'a', start: 0, end: 8, text: '大家好，今天介绍屏幕录制工具，可以从 flown.app 免费下载。代码在 github.com/flown/recorder。' }]
    for (const title of ['用flown.app轻松录制屏幕', '免费下载flown.app', '無料のflown.appで画面録画', '画面録画ならflown.app', 'はじめてのgithub.com/flown/recorder', 'מדריך ל-flown.app', '쉬운flown.app 사용법']) {
      // As written (a word joiner after a prefix's "-", the cleaning's).
      const result = (await runTextTask({ task: 'title', segments: captions }, async () => ({ text: title }))) as { task: string; text: string }
      expect({ task: result.task, text: result.text.replace(/\u2060/g, '') }, title).toEqual({ task: 'title', text: title })
      // As a chapter it is kept (or, noted, left out while the others are kept).
      const chapters = await runTextTask({ task: 'chapters', segments: captions }, async () => ({ chapters: [{ start: 0, title: 'Intro' }, { start: 6, title }] }))
      const titles = (chapters as { chapters: { title: string }[] }).chapters.map((c) => c.title.replace(/\u2060/g, ''))
      expect(titles, title).toEqual(notes(title, captions).length ? ['Intro'] : ['Intro', title])
    }
    // Those a site reads as a longer host are noted, and so not offered as the name (captionsPanel.test.ts, publishDialog.test.ts).
    expect(notes('はじめてのgithub.com/flown/recorder', captions)).toEqual(['はじめてのgithub.com/flown/recorder'])
    expect(notes('用flown.app轻松录制屏幕', captions)).toEqual([])
  })

  it("A said address after a said link with a path is broken in Chinese and Japanese when '。' is between them", () => {
    const said = 'Docs are at flown.app/docs and github.com/flown/flown, mail support@flown.app.'
    for (const card of ['ドキュメントはflown.app/docsです。質問はsupport@flown.appまで。', '文档在flown.app/docs。有问题请发邮件到support@flown.app。', '代码在github.com/flown/flown。邮箱support@flown.app']) {
      expect(plainText(card, { max: 3000, linksFrom: said }), card).toBe(card)
    }
    // A name before "@" is still read across "。".
    for (const [card, broken] of [
      ['//paypal-login。com@evil.com', `@evil.${NB}com`],
      ['flown.app/docs。paypal-login.com@flown.app', `paypal-login.${NB}com`],
      ['//paypal-login。com\\\\support@flown.app', `support@flown.${NB}app`],
      ['flown.app/docs。//evil。com@x.de', `@x.${NB}de`]
    ]) {
      expect(plainText(card, { max: 3000, linksFrom: said }), card).toContain(broken)
    }
  })
})
