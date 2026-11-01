import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { notedPieces, saidLinks } from '../src/shared/publish/check'
import { validatePackAnswer } from '../src/shared/publish/prompts'
import { plainText } from '../src/shared/publish/text'
import { extractUrlsWithIndices, isTopLevelDomain } from '../src/shared/publish/twitterText'
import type { CaptionSegment } from '../src/shared/types'

/*
 * The link check against a reference set of parsers (docs/design/publish-pack.md §4.8, §10). For
 * 2 500 seeded random texts built from the earlier review rounds' bypass corpus and tutorial copy,
 * tests/fixtures/check-oracle.json (scripts/build-check-oracle.mjs) holds every link that linkify-it
 * (fuzzy, every top-level domain), markdown-it (links, autolinks, its linkifier, raw HTML) and an
 * HTML parser's URL attributes open to a host the captions, name and chapters did not say, each host
 * read with WHATWG `new URL`; X's links (the vendored twitter-text) are added here. Every such link
 * must be in a noted piece, and the copy must be what the AI wrote but for the cleaning that has
 * nothing to do with links.
 */

interface OracleLink {
  by: string
  host: string
  /** Pieces that open it on their own: each must be noted. */
  alone: number[]
  /** Pieces it needs: one must be noted when no piece opens it alone. */
  needs: number[]
  /** When it is opened twice by two pieces each: the pairs it needs, both of one of which must be noted. */
  pairs?: [number, number][]
}
interface OracleContext {
  captions: string[]
  title: string
  chapters: string[]
}
interface OracleCase {
  /** What was said: its index in `contexts`, and the captions of it an AI wrote a link into (aiLinks). */
  context: number
  ai?: number[]
  /** The hosts the parsers open in what was said. */
  said: string[]
  text: string
  links: OracleLink[]
}

const { contexts, cases } = JSON.parse(readFileSync(new URL('./fixtures/check-oracle.json', import.meta.url), 'utf8')) as { contexts: OracleContext[]; cases: OracleCase[] }

const PIECE = /[^\t\n\f\r ]+/g

/** The host a registry or DNS can have that `url` opens (as the fixture's parsers count them), else null. */
function hostOf(url: string): string | null {
  let host: string
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).hostname
  } catch {
    return null
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return host
  const labels = host.split('.')
  return labels.length >= 2 && labels.every((l) => /^[a-z0-9-]+$/.test(l)) && isTopLevelDomain(labels[labels.length - 1]) ? host : null
}
const xLinks = (text: string): { host: string; start: number; end: number }[] =>
  extractUrlsWithIndices(text).flatMap((u) => {
    const host = hostOf(u.url)
    return host ? [{ host, start: u.indices[0], end: u.indices[1] }] : []
  })

const segmentsOf = (c: OracleCase): CaptionSegment[] =>
  contexts[c.context].captions.map((text, i) => ({ id: `c${i}`, start: i * 3, end: i * 3 + 2.9, text, ...(c.ai?.includes(i) ? { aiLinks: ['*'] } : {}) }))

describe('the link check against the reference parsers (§4.8, §10)', () => {
  it('has the fixture the script writes: every probe of the earlier rounds, every tutorial card and 2 000 random texts', () => {
    const probes = (JSON.parse(readFileSync(new URL('./fixtures/check-probes.json', import.meta.url), 'utf8')) as { probes: string[] }).probes
    const projects = (JSON.parse(readFileSync(new URL('./fixtures/tutorial-corpus.json', import.meta.url), 'utf8')) as { projects: { cards: unknown[] }[] }).projects
    expect(cases.length).toBe(probes.length + projects.reduce((n, p) => n + p.cards.length, 0) + 2000)
    expect(cases.reduce((n, c) => n + c.links.length, 0)).toBeGreaterThan(4500)
  })

  it('notes every link a parser opens to a host nobody said', () => {
    const missed: string[] = []
    let links = 0
    for (const c of cases) {
      const segments = segmentsOf(c)
      const { title, chapters } = contexts[c.context]
      const saidTexts = [...segments.filter((s) => !s.aiLinks).map((s) => s.text), title, ...chapters].filter(Boolean)
      const xSaid = new Set(saidTexts.flatMap((t) => [t, t.replace(/-?[^\x00-\x7f]+/g, ' ')]).flatMap((t) => xLinks(t).map((l) => l.host)))
      const said = new Set([...c.said, ...xSaid])
      const noted = notedPieces(c.text, saidLinks(segments, { title, chapters }))
      const pieces = [...c.text.matchAll(PIECE)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
      const isNoted = (start: number, end: number): boolean => noted.some((n) => n.start < end && start < n.end)
      const pieceNoted = (k: number): boolean => isNoted(pieces[k].start, pieces[k].end)
      for (const l of c.links) {
        if (xSaid.has(l.host)) continue
        links++
        const ok = l.alone.length ? l.alone.every(pieceNoted) : l.needs.length ? l.needs.some(pieceNoted) : !!l.pairs?.some((p) => p.every(pieceNoted))
        if (!ok) missed.push(`${l.by} ${l.host} in ${JSON.stringify(c.text)}`)
      }
      for (const l of xLinks(c.text)) {
        if (said.has(l.host)) continue
        links++
        if (!isNoted(l.start, l.end)) missed.push(`x ${l.host} in ${JSON.stringify(c.text)}`)
      }
    }
    expect(missed.slice(0, 10)).toEqual([])
    expect(links).toBeGreaterThan(4500)
  })

  it('leaves the copy as the AI wrote it but for the cleaning that has nothing to do with links', () => {
    // What the cleaning may change: controls and invisible characters, spaces at line ends and repeated ones, and Markdown
    // emphasis. It adds no space (as a no-break space after a dot once broke a name) and no word joiner.
    // eslint-disable-next-line no-control-regex
    const bare = (s: string): string => s.normalize().replace(/[\s\u0000-\u001f\u007f-\u009f\u00ad\u034f\u200b\u2060-\u2064\u202a-\u202e\u2066-\u2069\ufeff*_]/gu, '')
    const nbsp = (s: string): number => s.split('\u00a0').length
    const changed: string[] = []
    for (const c of cases) {
      const card = validatePackAnswer('linkedin', { text: c.text })
      expect(card).toEqual({ task: 'linkedin', text: plainText(c.text, { max: 3000 }) })
      const out = card.task === 'linkedin' ? card.text : ''
      if (bare(out) !== bare(c.text) || nbsp(out) > nbsp(c.text) || out.includes('\u2060')) changed.push(JSON.stringify(c.text))
    }
    expect(changed.slice(0, 10)).toEqual([])
  })
})
