/**
 * A seeded property test of the copy pack's cleaning (docs/design/publish-pack.md §4.4): thousands of
 * texts, ordinary and hostile, through every task's validatePackAnswer and the card's cleaning in the
 * dialog (publishRun's cardText). No output may hold a link X finds (the port, which the fixture
 * proves equal to twitter-text), an "http(s)://" or "www." glued to anything outside a link the
 * transcript, name and chapter titles have, or a "http(s)://" or "www." stretch (as a site reading to
 * the next space takes it) on whose host a browser opens another name; and ordinary text loses no
 * letter.
 */
import { readFileSync } from 'node:fs'
import { domainToUnicode } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AiTextResult, PackTextTask } from '../src/shared/api/ai'
import { validatePackAnswer } from '../src/shared/publish/prompts'
import { cutAt, fitX, plainText } from '../src/shared/publish/text'
import { extractUrlsWithIndices, findUrls } from '../src/shared/publish/twitterText'
import type { CaptionSegment } from '../src/shared/types'

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PUBLISH_RUN = '../src/renderer/src/publish/publishRun'
const { cardText } = (await import(/* @vite-ignore */ PUBLISH_RUN)) as {
  cardText: (result: AiTextResult, segments: readonly Pick<CaptionSegment, 'text'>[], context?: { title?: string; chapters?: string[] }) => { text: string; tags: string }
}

interface Samples {
  findings: Record<string, string[]>
  languages: Record<string, string[]>
  code: string[]
  links: string[]
  before: string[]
  after: string[]
  earlierTests: string[]
}
const samples = JSON.parse(readFileSync(new URL('./fixtures/link-samples.json', import.meta.url), 'utf8')) as Samples

/** mulberry32: the same texts on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const segments = [
  { text: 'Today I show how to export a video. Get Flown at flown.app, and read e.target in the handler.' },
  { text: 'Settings are at https://example.com/settings, built on ASP.NET Core.' }
]
const context = { title: 'Flown tour: flown.app/help', chapters: ['Intro', 'Edit README.md'] }
const transcript = segments.map((s) => s.text).join(' ')
const trusted = [transcript, context.title, ...context.chapters].join('\n')

/** A link without its scheme (it goes to the same place), its host in lower case (ASCII only), the rest as written. */
const key = (link: string): string => {
  const bare = link.replace(/^https?:\/\//i, '')
  const host = /^[^/?#:]*/.exec(bare)?.[0] ?? ''
  return host.replace(/[A-Z]/g, (c) => c.toLowerCase()) + bare.slice(host.length)
}
const allowed = new Set(extractUrlsWithIndices(trusted.normalize()).map((u) => key(trusted.normalize().slice(u.indices[0], u.indices[1]))))
for (const m of trusted.matchAll(/https?:\/\/\S+/g)) allowed.add(key(m[0].replace(/[.,]$/, '')))
/** The hosts of the allowed links, as a browser has them. */
const hostOf = (link: string): string | null => {
  try {
    return domainToUnicode(new URL(/^https?:/i.test(link) ? link : `http://${link}`).hostname)
  } catch {
    return null
  }
}
const allowedHosts = new Set([...allowed].map((k) => hostOf(k)))

/**
 * The links in `out` nobody said: X's (on the text and on its NFC form); "http(s)://" or "www." glued
 * to anything, unless inside an allowed link or starting one as X reads the text from there; and,
 * read to the next space as some sites do, a "http(s)://" or "www." stretch whose host (WHATWG's
 * URL: after a user name, percent-decoded, IDNA) is a name X links whole and none of the allowed
 * links has.
 */
function foreignLinks(out: string): string[] {
  const bad: string[] = []
  for (const t of new Set([out, out.normalize()])) {
    const links = extractUrlsWithIndices(t).map((u) => ({ start: u.indices[0], end: u.indices[1], text: t.slice(u.indices[0], u.indices[1]) }))
    for (const l of links) if (!allowed.has(key(l.text))) bad.push(l.text)
    for (const m of t.matchAll(/(?:https?:\/\/|www\.)\S/giu)) {
      if (links.some((l) => l.start <= m.index && m.index < l.end && allowed.has(key(l.text)))) continue
      const from = t.slice(m.index)
      const own = extractUrlsWithIndices(from).find((u) => u.indices[0] === 0)
      if (!own || !allowed.has(key(from.slice(0, own.indices[1])))) bad.push(t.slice(m.index, m.index + 30))
    }
    for (const m of t.matchAll(/(?:https?:\/\/|www\.)\S+/giu)) {
      const host = hostOf(m[0])
      if (!host || allowedHosts.has(host)) continue
      if (findUrls(host, true).some((u) => u.indices[0] === 0 && u.indices[1] === host.length)) bad.push(`${m[0]} (${host})`)
    }
  }
  return bad
}

/** Letters, marks and digits only, NFC: what ordinary text must keep. */
const letters = (s: string): string => s.normalize().replace(/[^\p{L}\p{M}\p{N}]/gu, '')

/** Text with no link that would go whole (no scheme, "www.", port, path or query): only names X links bare. */
const ordinary = (t: string): boolean => !/https?:\/\/|www\./i.test(t) && findUrls(t, true).every((u) => !t.slice(u.indices[0], u.indices[1]).includes('/'))

const words = [...Object.values(samples.languages).flat(), ...samples.code, ...Object.values(samples.findings).flat(), ...samples.earlierTests]
  .flatMap((t) => [t, ...t.split(/\s+/)])
  .filter((w) => w && ordinary(w))
/** What the third review found other sites link, or browsers open, where X does not. */
const thirdReview = [
  'https://flown.app%2eevil%2ecom/login',
  'https://flown.app:8443@evil.com/login',
  'https://flown.app．evil．com/x',
  'www.flown.app%2eevil%2ecom',
  'https://ｅｖｉｌ.ｃｏｍ/login',
  'www.ｅｖｉｌ.ｃｏｍ/x',
  'https://日%2eevil%2ecom/login',
  '$paypal-login.com/verify',
  '/．paypal-login.com/login',
  '「paypal-login.com」',
  '//paypal-login.com/login',
  'paypal.com@login',
  'paypal-secure.web/login',
  'evil.ישראל',
  "flown.app/help'dan",
  'flown.app/help-evil',
  'https://example.com/settings%2eevil%2ecom',
  '<https://evil.example/x>',
  '‹http://192.168.1.10:8080/admin›'
]
const hostile = [...samples.links, ...Object.values(samples.findings).flat(), ...samples.earlierTests, ...thirdReview]
const glue = [...samples.before, ...samples.after, '', '', ' ', '(', ')', '?next=', '/', '.', '**', '__', '\n', '$', '@', '//', '．', '「', '%2e', 'ht', 'tps://']
const separators = [' ', ' ', ' ', ', ', '. ', '! ', '? ', ': ', ' — ', '\n', '\n\n', ' **', '** ']

function texts(): { text: string; plain: boolean }[] {
  const rnd = random(31102026)
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  const out: { text: string; plain: boolean }[] = []
  // Ordinary text: words of every caption language, names, code, abbreviations, e-mail addresses.
  while (out.length < 1200) {
    let t = pick(words)
    while ([...t].length < 40 && rnd() < 0.8) t += pick(separators) + pick(words)
    if ([...t].length <= 110 && ordinary(t)) out.push({ text: t, plain: true })
  }
  // Hostile text: links glued to words, nested in brackets and queries, joined by anything.
  for (let i = 0; i < 1800; i++) {
    let t = ''
    const n = 1 + Math.floor(rnd() * 6)
    for (let j = 0; j < n; j++) t += pick(glue) + (rnd() < 0.5 ? pick(hostile) : pick(words)) + pick(glue)
    out.push({ text: t, plain: false })
  }
  return out
}

const answer = (task: PackTextTask, s: string): unknown => {
  switch (task) {
    case 'youtube':
      return { description: s, tags: [s.slice(0, 28), s] }
    case 'linkedin':
    case 'xpost':
      return { text: s }
    case 'article':
      return { title: s, intro: s, sections: [{ heading: s, steps: [s, `Then ${s}`] }] }
    case 'releaseNotes':
      return { title: s, summary: s, items: [{ kind: 'new', text: s }] }
  }
}

describe('the copy pack, on thousands of seeded texts', () => {
  it('lets no link through that the transcript, name and chapter titles do not have, and loses no letter of ordinary text', () => {
    const problems: string[] = []
    const check = (where: string, s: string, out: string): void => {
      const bad = foreignLinks(out)
      if (bad.length) problems.push(`${where}: ${JSON.stringify(s)} → ${JSON.stringify(out)} links ${JSON.stringify(bad)}`)
    }
    const all = texts()
    expect(all.length).toBeGreaterThan(2500)
    for (const { text: s, plain } of all) {
      for (const task of ['youtube', 'linkedin', 'xpost', 'article', 'releaseNotes'] as const) {
        let r: AiTextResult
        try {
          r = validatePackAnswer(task, answer(task, s), transcript, context)
        } catch {
          continue // Nothing usable in it (an empty post): nothing is shown.
        }
        const out = (r as { text: string }).text
        check(task, s, out)
        if (r.task === 'youtube') for (const tag of r.tags) check('tag', s, tag)
        // The dialog cleans again what it shows.
        const card = cardText(r, segments, context)
        check(`${task} card`, s, card.text)
        check(`${task} card tags`, s, card.tags)
        if (plain) {
          const kept = task === 'article' || task === 'releaseNotes' ? letters(out).includes(letters(s)) : letters(out) === letters(s)
          if (!kept) problems.push(`${task} lost letters: ${JSON.stringify(s)} → ${JSON.stringify(out)}`)
        }
      }
      for (const task of ['title', 'summary'] as const) {
        const out = cardText({ task, text: s }, segments, context).text
        check(task, s, out)
        if (plain && letters(out) !== letters(s)) problems.push(`${task} lost letters: ${JSON.stringify(s)} → ${JSON.stringify(out)}`)
      }
    }
    expect(problems.slice(0, 20)).toEqual([])
  }, 120_000)

  it('cleans the worst texts in tens of milliseconds: runs of dots, nested brackets, long queries, links in links', () => {
    const N = 10_000
    const ja = '今日は新しいエクスポート機能を紹介します設定を開いて保存を押すだけです'
    const worst = [
      '.'.repeat(N),
      'a.'.repeat(N / 2),
      'a.com'.repeat(N / 5),
      `https://a.com/${'('.repeat(N / 2)}${')'.repeat(N / 2)}`,
      '(evil.com('.repeat(N / 10),
      `https://a.com/?${'a=b&'.repeat(N / 4)}`,
      `flown.app?next=${'https://evil.com/?u='.repeat(N / 20)}`,
      'www.'.repeat(N / 4),
      'https://'.repeat(N / 8),
      `${ja}.`.repeat(N / (ja.length + 1)),
      '日本.com'.repeat(N / 7),
      'a_b.com.'.repeat(N / 8),
      `${'evil.c'.repeat(500)}https://x.de${'om'.repeat(500)}`,
      'TP.Thủ '.repeat(N / 7)
    ]
    for (const s of worst) {
      for (const max of [3000, 25_000]) {
        const start = performance.now()
        plainText(s, { max, linksFrom: transcript })
        expect(performance.now() - start, `plainText ${s.slice(0, 20)}`).toBeLessThan(150)
      }
      const start = performance.now()
      cutAt(s, 3000)
      fitX(s.slice(0, 2000))
      expect(performance.now() - start, `cutAt and fitX ${s.slice(0, 20)}`).toBeLessThan(300)
    }
  })

  it('checks every field of a long answer against an hour of transcript once, not once per field', () => {
    const hour = 'Today I show how to export a video and set up flown.app with e.target and ASP.NET Core. '.repeat(680)
    const sections = Array.from({ length: 12 }, (_, i) => ({ heading: `Part ${i}`, steps: Array.from({ length: 20 }, (_, j) => `Open settings ${j} and press Save on flown.app`) }))
    const start = performance.now()
    const r = validatePackAnswer('article', { title: 'Export', intro: 'How to export.', sections }, hour) as { text: string }
    expect(performance.now() - start).toBeLessThan(500)
    expect(r.text).toContain('1. Open settings 0 and press Save on flown.app')
  })
})

