/**
 * The problems of the seventh review of the copy pack's links (docs/design/publish-pack.md §4.4, §4.6,
 * §4.8): one test each by its title, each failing at b185f38 on its own expectation. The safety net
 * (check.ts) is widened where a link got past it; the cleaning is changed only where it damaged what
 * was said. NB is the no-break space a broken name gets after its dot.
 */
import { describe, expect, it } from 'vitest'
import type { AiTextRequest, AiTextResult, AiTextTask } from '../src/shared/api/ai'
import { MAX_AI_LINKS, readCaptionSegments } from '../src/shared/captions/captionData'
import { aiLinksAfter, applyTextResult, mergeWithNext, splitCaption } from '../src/shared/captions/edit'
import { runTextTask, validateTextRequest } from '../src/shared/captions/transcriptText'
import { createProject } from '../src/shared/engine/project'
import { linksToCheck, saidLinks } from '../src/shared/publish/check'
import { publishSegments } from '../src/shared/publish/pack'
import { packTranscript, validatePackAnswer } from '../src/shared/publish/prompts'
import { plainText, unsaidLinks } from '../src/shared/publish/text'
import type { CaptionSegment, Project } from '../src/shared/types'

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PUBLISH_RUN = '../src/renderer/src/publish/publishRun'
const { cardText } = (await import(/* @vite-ignore */ PUBLISH_RUN)) as {
  cardText: (result: AiTextResult, segments: readonly Pick<CaptionSegment, 'text' | 'aiLinks'>[], context?: { title?: string; chapters?: string[] }) => { text: string; tags: string }
}

const NB = String.fromCharCode(0xa0)
const NONE = 'In this video I show how to export a clip with Flown.'
const SAID_SITE = 'Download Flown from flown.app. Questions? Mail support@flown.app.'
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

describe('the copy pack after the seventh review of its links', () => {
  it('Laundering through the aiLinks cap: more than 100 links an AI wrote into one caption let the last one count as said', async () => {
    const captions: CaptionSegment[] = [{ id: 'a', start: 0, end: 8, text: 'So that is how you export a clip, and next time I will show you how to fix your captions.' }]
    const junk = [...'abcdefghijklmnopqrstuvwxyz'].flatMap((l) => [`${l}.de/x's`, `${l}.at/x's`]).join(' ')
    for (const attack of ['paypal-login.com/verify', '//203.28935/login']) {
      const stored = await fixed(captions, { a: `${junk} ${attack}` })
      // Recorded whole, or as every link of the caption: never cut short.
      const recorded = stored[0].aiLinks ?? []
      expect(recorded.length > MAX_AI_LINKS ? 'cut short' : recorded.length).not.toBe('cut short')
      for (const segments of [stored, reloaded(stored)]) {
        expect(validateTextRequest({ task: 'linkedin', segments }).segments[0].aiLinks).toEqual(segments[0].aiLinks)
        expect(unsaidLinks(publishSegments(projectOf(segments)))).toContain(attack.replace(/^\/\//, ''))
        const card = await linkedin(`New video is up! Grab the project files at ${attack} today.`, segments)
        expect(card).not.toContain(attack)
        // Written by hand into a card, the net notes it.
        expect(notes(`Grab the project files at ${attack} today.`, publishSegments(projectOf(segments)), { title: 'Demo' })).toEqual([attack])
      }
    }
  })

  it("A Markdown link's destination written with backslash escapes or character references is neither rewritten nor noted", () => {
    for (const answer of [
      'Download the project files [here](https\\://paypal-login\\.com/verify).',
      '[here](https&#58;//paypal-login&#46;com/verify)',
      '[here](http:flown@paypal-login.com/verify)',
      '[here](//paypal-login&period;com/verify)',
      'Grab them at paypal-login&#x2E;com/verify'
    ]) {
      // The cleaning keeps it as written (it is not a link to X or linkify-it), so only the net can say it.
      const card = validatePackAnswer('linkedin', { text: answer }, packTranscript([{ text: SAID_SITE }]).text)
      expect((card as { text: string }).text, answer).toBe(answer)
      expect(notes(answer, SAID_SITE), answer).toEqual([answer.replace(/^.* /, '')])
    }
    // A name this does not know may be any letter: "&rcy;&fcy;" is "рф".
    expect(notes('Sign in at госуслуги.&rcy;&fcy;', SAID_SITE)).toEqual(['госуслуги.&rcy;&fcy;'])
    // A said link in a Markdown link, and text with "&" or "\" in it, need no note.
    for (const ok of ['Get Flown [here](https://flown.app).', 'R&D, AT&T; and C:\\Users\\me\\Videos; a \\* b &amp; c.', 'Mail support&#64;flown.app.']) expect(notes(ok, SAID_SITE), ok).toEqual([])
  })

  it("The safety net's said stretches and addresses come from text an AI wrote: a translated caption, a chapter title or a suggested title", async () => {
    const captions: CaptionSegment[] = [{ id: 'a', start: 0, end: 8, text: 'You can download it from flown.jp/download today.' }]
    const card = 'ダウンロードはログインflown.jp/downloadから。'
    expect(notes(card, captions)).toEqual([card])
    // Translated so, the caption is one an AI wrote a link into, and the card keeps its note.
    const result = await runTextTask({ task: 'translate', segments: captions, targetLanguage: 'Japanese' }, async () => ({ segments: [{ id: 'a', text: card }] }))
    const stored = applyTextResult(captions, (result as { segments: CaptionSegment[] }).segments) as CaptionSegment[]
    expect(stored[0].text).toBe(card)
    expect(stored[0].aiLinks?.length).toBeGreaterThan(0)
    expect(notes(card, stored)).toEqual([card])
    expect(notes(card, reloaded(stored))).toEqual([card])
    // The said link itself stays said.
    expect(notes('Get it at flown.jp/download', stored)).toEqual([])
    // A suggested title that the net notes comes back with its note, and is not offered as the name, which is trusted as
    // typed (the Captions tab and the Publish dialog: captionsPanel.test.ts, publishDialog.test.ts).
    const source: CaptionSegment[] = [{ id: 'b', start: 0, end: 8, text: 'You can download it from github.com/flown/recorder.' }]
    const noted = await runTextTask({ task: 'title', segments: source }, async () => ({ text: 'Get it at 登录github.com/flown/recorder' }))
    expect(notes((noted as { text: string }).text, source)).toEqual(['登录github.com/flown/recorder'])
    await expect(runTextTask({ task: 'title', segments: source }, async () => ({ text: 'Get it at github.com/flown/recorder' }))).resolves.toEqual({ task: 'title', text: 'Get it at github.com/flown/recorder' })
  })

  it("An IPv4 host of two or three parts after '//' is not noted, although linkify-it links it and a browser opens it", () => {
    for (const answer of ['//203.28935/login', '//203.0.28935/login', '//0xcb.28935/x', '//1.1/x', 'Files: //1.1.']) expect(notes(answer), answer).toEqual([answer.replace(/^.* /, '')])
    for (const ok of ['Python: mid = (lo+hi)//2 and the ratio is 3//4.5.', 'Version 1.2 // 3.4 and v2//1.5']) expect(notes(ok), ok).toEqual([])
  })

  it('A symbol or emoji other than ASCII glued before a said name is neither rewritten nor noted, although linkify-it reads it into the host', () => {
    for (const [answer, said] of [
      ['Get it at 😀flown.to', 'Get it at flown.to today.'],
      ['Get it at ➡github.com/flown/recorder', 'Get it at github.com/flown/recorder today.'],
      ['Get it at ©flown.app', SAID_SITE],
      ['Get it at ★flown.app/docs', 'The docs are at flown.app/docs.']
    ]) {
      expect(notes(answer, said), answer).toEqual([answer.replace(/^.* /, '')])
    }
    // Not with a space between, nor before a scheme.
    for (const ok of ['Get it at 👉 flown.app', '👉https://flown.app', 'Done ✅ flown.app']) expect(notes(ok, SAID_SITE), ok).toEqual([])
  })

  it('The safety net notes plain Chinese and Japanese text with no link in it, reading every "。" as a dot', () => {
    for (const ok of [
      '动画导出很简单。在线编辑也很方便。',
      '書き出しはとても簡単です。クラウドに保存することもできます。',
      '设置完成。网站上有更多教程。',
      '紹介します。YouTubeやTikTok向けの設定も解説します。',
      '在线课程老师特别需要这个功能。录好的视频可以直接上传。中国大陆用户也能正常使用。',
      'みんなからよく質問をいただきます。ストアから無料でダウンロードできます。セール期間中はさらにお得です。',
      'ポイントは三つあります．クラウドに保存できます．'
    ]) {
      expect(notes(ok), ok).toEqual([])
    }
    // In a host a browser is given ("//" or a scheme), they are dots.
    for (const answer of ['//paypal-login。com\\support@flown.app', 'https://paypal-login｡com/verify', '[here](https:paypal-login．com)']) expect(notes(answer, SAID_SITE), answer).toEqual([answer])
  })

  it("A said link gets a note when a Korean or Japanese particle follows it, or when ':line' follows a said file name", () => {
    const said = 'Download Flown from flown.app, open README.md and run main.py.'
    for (const ok of ['flown.app에서 다운로드하세요.', 'README.md를 열고 main.py를 실행합니다.', 'flown.appからダウンロードできます。', 'The error is in main.py:42.', 'See main.py:42:7 and flown.app:443.']) {
      expect(notes(ok, said), ok).toEqual([])
    }
    // A longer name, a port before "@" and a user name are still noted.
    for (const answer of ['flown.appログイン.com', 'flown.app:8443@3405803783', 'https://flown.app@evil.com', 'paypal-flown.app', 'flown.app.evil.com']) expect(notes(answer, said), answer).toEqual([answer])
  })

  it("A bare name said with a Bangla, Hindi or Tamil hyphen ending is not counted as said, so every card breaks the user's own URL", () => {
    for (const [said, card] of [
      ['flown.app-இல் பதிவிறக்கவும்', 'பதிவிறக்கம்: flown.app'],
      ['flown.app-এ যান', 'ডাউনলোড: flown.app'],
      ['flown.app-पर जाएँ', 'डाउनलोड: flown.app'],
      ['flown.app-এর ওয়েবসাইট', 'ওয়েবসাইট: https://flown.app']
    ]) {
      expect(plainText(card, { max: 3000, linksFrom: said }), card).toBe(card)
    }
    // An unsaid one is still broken, and an AI that writes one with an ending has written it.
    expect(plainText('ডাউনলোড: evil.com', { max: 3000, linksFrom: 'flown.app-এ যান' })).toBe(`ডাউনলোড: evil.${NB}com`)
    expect(aiLinksAfter({ text: 'ওয়েবসাইটে যান' }, 'evil.com-এ যান')).toEqual(['evil.com'])
  })

  it('A said e-mail address after a said link with a path, in one unspaced Chinese or Japanese run, is broken', () => {
    const said = 'Docs are at flown.app/docs and github.com/flown/flown, mail support@flown.app.'
    for (const card of ['文档：flown.app/docs，邮箱：support@flown.app', '代码在github.com/flown/flown，也可以写信给support@flown.app。', 'ドキュメントはflown.app/docs、お問い合わせはsupport@flown.appまで。']) {
      expect(plainText(card, { max: 3000, linksFrom: said }), card).toBe(card)
    }
    // A name before "@" is still read.
    expect(plainText('文档：flown.app/docs，paypal-login.com@flown.app', { max: 3000, linksFrom: said })).toContain(`paypal-login.${NB}com`)
  })

  it('Chapters suggested by the AI get past both the rewriter and the safety net', async () => {
    const captions: CaptionSegment[] = [
      { id: 'a', start: 0, end: 5, text: 'Download Flown at acme.com today, it is free.' },
      { id: 'b', start: 5, end: 10, text: 'Then open the export dialog and pick a preset.' }
    ]
    const result = await runTextTask({ task: 'chapters', segments: captions }, async () => ({
      chapters: [
        { start: 0, title: 'Intro' },
        { start: 6, title: 'Sign in at 登录acme.com' }
      ]
    }))
    expect((result as { chapters: { title: string }[] }).chapters.map((c) => c.title)).toEqual(['Intro'])
    // A chapter with the said link is kept.
    const said = await runTextTask({ task: 'chapters', segments: captions }, async () => ({ chapters: [{ start: 0, title: 'Get it at acme.com' }] }))
    expect((said as { chapters: { title: string }[] }).chapters.map((c) => c.title)).toEqual(['Get it at acme.com'])
  })

  it("Merging a caption the user said with one the AI fixed makes the said link untrusted, and the pack breaks the user's own link", () => {
    const captions: CaptionSegment[] = [
      { id: 'a', start: 0, end: 4, text: 'Get it at flown.app.' },
      { id: 'b', start: 4, end: 8, text: 'Again flown.app for you.', aiLinks: ['flown.app'] },
      { id: 'c', start: 8, end: 12, text: 'And the files at paypal-login.com/verify.', aiLinks: ['paypal-login.com/verify'] }
    ]
    expect(unsaidLinks(captions)).toEqual(['paypal-login.com/verify'])
    const merged = mergeWithNext(captions, 'a') as CaptionSegment[]
    expect(merged[0].aiLinks).toBeUndefined()
    expect(unsaidLinks(merged)).toEqual(['paypal-login.com/verify'])
    // Split again, the link is still said; what the AI wrote and nobody says stays the AI's.
    expect(unsaidLinks(splitCaption(merged, 'a', 3) as CaptionSegment[])).toEqual(['paypal-login.com/verify'])
    expect((mergeWithNext(merged, 'a') as CaptionSegment[])[0].aiLinks).toEqual(['paypal-login.com/verify'])
  })
})
