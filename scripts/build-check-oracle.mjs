#!/usr/bin/env node
// Writes tests/fixtures/check-oracle.json: for seeded random texts built from the earlier review
// rounds' bypass corpus (tests/fixtures/check-probes.json) and tutorial copy
// (tests/fixtures/tutorial-corpus.json), every link a reference set of parsers opens to a host the
// captions, name and chapters did not say (docs/design/publish-pack.md §4.8, §10): linkify-it 5 with
// fuzzy links on every top-level domain, markdown-it 14 (links, images and autolinks, its linkifier
// on every top-level domain, and the raw HTML it passes through), and an HTML parser's URL attributes
// (parse5 7). Each host is read with WHATWG `new URL`, and only a host a registry or DNS can have
// counts (labels of letters, digits and "-" on a delegated top-level domain, or an IP address). For
// each such link it records the pieces of the text (between ASCII spaces) that open it on their own,
// and those without any one of which that parser no longer opens it. tests/publishCheckOracle.test.ts
// checks that the link check notes them, with X's own links (the vendored twitter-text) added there.
//
// The parsers come from the published packages, each checked against the npm registry's integrity
// before it is unpacked into a new temporary folder, never from the app's node_modules.
//
//   node scripts/build-check-oracle.mjs                      # download with `npm pack`, write the file
//   node scripts/build-check-oracle.mjs --tarballs <folder>  # use the .tgz files in <folder>
//   node scripts/build-check-oracle.mjs --check [...]        # exit 1 when the committed file differs
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { domainToASCII, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'tests', 'fixtures', 'check-oracle.json')
const PROBES = path.join(root, 'tests', 'fixtures', 'check-probes.json')
const CORPUS = path.join(root, 'tests', 'fixtures', 'tutorial-corpus.json')
const CASES = 2000
/** ASCII spaces: where the link check splits a text into pieces. */
const PIECE = /[^\t\n\f\r ]+/g

/** The packages and the integrity the npm registry gives for each (dist.integrity). */
const PACKAGES = {
  'linkify-it': { version: '5.0.0', integrity: 'sha512-5aHCbzQRADcdP+ATqnDuhhJ/MRIqDkZX5pyjFHRRysS8vZ5AbqGEoFIb6pYHPZ+L/OC2Lc+xT8uHVVR5CAK/wQ==' },
  'markdown-it': { version: '14.1.0', integrity: 'sha512-a54IwgWPaeBCAAsv13YgmALOF1elABB08FxO9i+r4VFk5Vl4pKokRPeX8u5TCgSsPi6ec1otfLjdOpVcgbpshg==' },
  mdurl: { version: '2.1.0', integrity: 'sha512-1+HBaOx0zi/dQWht8rNv9MYf9qqpqL/kxI0hXImU6Y547zM6Sni8BQibt7ifgMcYtQg41ao3Ivd6cnSM86inpg==' },
  'uc.micro': { version: '2.1.0', integrity: 'sha512-ARDJmphmdvUk6Glw7y9DQ2bFkKBHwQHLi2lsaH6PPmz/Ka9sFOBsBluozhDltWmnv9u/cF6Rt87znRTPV+yp/A==' },
  entities: { version: '4.5.0', integrity: 'sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==' },
  'punycode.js': { version: '2.3.1', integrity: 'sha512-uxFIHU0YlHYhDQtV4R9J6a52SLx28BCjT+4ieh7IGbgwVJWO+km431c4yRlREUAsAmt/uMjQUyQHNEPf0M39CA==' },
  argparse: { version: '2.0.1', integrity: 'sha512-8+9WqebbFzpX9OR+Wa6O29asIogeRMzcGtAINdpMHHyAg10f05aSFVBbcEqGf/PXw1EjAZ+q2/bEBg3DvurK3Q==' },
  parse5: { version: '7.1.2', integrity: 'sha512-Czj1WaSVpaoj0wbhMzLmWD69anp2WH7FXMB9n1Sy8/ZFF9jolSQVMu1Ij5WIyGmcBmhk7EOndpO4mIpihVqAXw==' }
}

const args = process.argv.slice(2)
const check = args.includes('--check')
const from = args.includes('--tarballs') ? path.resolve(args[args.indexOf('--tarballs') + 1] ?? '') : null

const work = mkdtempSync(path.join(os.tmpdir(), 'flown-check-oracle-'))
try {
  const modules = path.join(work, 'node_modules')
  for (const [name, { version, integrity }] of Object.entries(PACKAGES)) {
    const file = `${name}-${version}.tgz`
    let tgz
    if (from) tgz = path.join(from, file)
    else {
      const dl = path.join(work, 'download')
      mkdirSync(dl, { recursive: true })
      const r = spawnSync('npm', ['pack', `${name}@${version}`, '--pack-destination', dl, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' })
      if (r.status !== 0) throw new Error(`npm pack ${name}@${version} failed: ${(r.stderr || r.error?.message || '').trim()}`)
      tgz = path.join(dl, file)
    }
    if (!existsSync(tgz)) throw new Error(`${tgz} is missing`)
    const actual = `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}`
    if (actual !== integrity) throw new Error(`${file}: integrity ${actual} is not the registry's ${integrity}`)
    const dir = path.join(modules, name)
    mkdirSync(dir, { recursive: true })
    const r = spawnSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`unpacking ${file} failed: ${(r.stderr || r.error?.message || '').trim()}`)
  }
  const require = createRequire(path.join(work, 'index.cjs'))
  const oracle = parsers(require('linkify-it'), require('markdown-it'), require('parse5'))
  const { contexts, cases } = generate(oracle)
  const fixture = {
    about: 'Links a reference set of parsers opens to a host nobody said, written by scripts/build-check-oracle.mjs; tests/publishCheckOracle.test.ts checks the link check against them.',
    packages: Object.fromEntries(Object.entries(PACKAGES).map(([name, p]) => [name, `${p.version} ${p.integrity}`])),
    contexts,
    cases
  }
  // One case per line; invisible characters, marks and spaces other than " " written as \u escapes.
  const json = (v) => JSON.stringify(v).replace(/(?! )[\p{C}\p{Mn}\p{Me}\p{Z}]/gu, (c) => c.replace(/[^]/g, (u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`))
  const text =
    `{\n${['about', 'packages'].map((k) => `  ${JSON.stringify(k)}: ${json(fixture[k])},`).join('\n')}\n` +
    `  "contexts": [\n${contexts.map((c) => `    ${json(c)}`).join(',\n')}\n  ],\n` +
    `  "cases": [\n${cases.map((c) => `    ${json(c)}`).join(',\n')}\n  ]\n}\n`
  if (check) {
    const committed = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (committed !== text) {
      console.error(`${path.relative(root, OUT)} is not what the parsers answer now: run node scripts/build-check-oracle.mjs`)
      process.exitCode = 1
    } else console.log(`${path.relative(root, OUT)}: ${cases.length} cases, as the parsers answer them.`)
  } else {
    writeFileSync(OUT, text)
    const links = cases.reduce((n, c) => n + c.links.length, 0)
    console.log(`Wrote ${path.relative(root, OUT)}: ${cases.length} cases, ${links} links to a host nobody said.`)
  }
} catch (err) {
  console.error(err instanceof Error ? err.stack : err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}

/** Every top-level domain the app knows (src/shared/publish/tlds.ts and newerTlds.ts), in ASCII and as written. */
function topLevelDomains() {
  // Their strings: one per line, "export const X = 'a|b|…'" or "'a|b|' +" on lines of their own.
  const lines = ['tlds.ts', 'newerTlds.ts'].flatMap((f) => readFileSync(path.join(root, 'src', 'shared', 'publish', f), 'utf8').split('\n'))
  const lists = lines.map((l) => /^(?:export const \w+ = |\s+)'([^']*)'(?: \+)?$/.exec(l)?.[1]).filter(Boolean)
  const names = new Set(lists.flatMap((l) => l.split('|')).filter(Boolean))
  return { written: [...names], ascii: new Set([...names].map((n) => domainToASCII(`x.${n}`).slice(2)).filter(Boolean)) }
}

/** The parsers, each a function from a text to the hosts it opens there: [{ by, host }]. */
function parsers(LinkifyIt, MarkdownIt, parse5) {
  const tlds = topLevelDomains()
  const linkify = new LinkifyIt()
  linkify.tlds(tlds.written, true)
  const md = new MarkdownIt({ html: true, linkify: true })
  md.linkify.tlds(tlds.written, true)
  const BASE = 'https://base.invalid/'
  /** The host `url` opens, when a registry or DNS can have it. */
  const hostOf = (url) => {
    let host
    try {
      const u = new URL(url, BASE)
      if (u.protocol === 'mailto:') {
        const at = u.pathname.lastIndexOf('@')
        host = at < 0 ? '' : new URL(`http://${decodeURIComponent(u.pathname.slice(at + 1)).split('?')[0]}`).hostname
      } else host = u.hostname
    } catch {
      return null
    }
    if (!host || host === 'base.invalid') return null
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return host
    const labels = host.split('.')
    return labels.length >= 2 && labels.every((l) => /^[a-z0-9-]+$/.test(l)) && tlds.ascii.has(labels.at(-1)) ? host : null
  }
  const ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'background', 'data', 'ping', 'longdesc', 'lowsrc', 'dynsrc', 'codebase', 'icon', 'manifest', 'xlink:href', 'srcset'])
  const html = (text) => {
    const out = []
    const walk = (node) => {
      for (const a of node.attrs ?? []) {
        if (!ATTRS.has(a.name)) continue
        for (const v of a.name === 'srcset' ? a.value.split(',').map((s) => s.trim().split(/\s+/)[0]) : [a.value]) {
          const host = hostOf(v)
          if (host) out.push(host)
        }
      }
      for (const c of node.childNodes ?? []) walk(c)
      if (node.content) walk(node.content)
    }
    walk(parse5.parseFragment(text))
    return out
  }
  const markdown = (text) => {
    const out = []
    const walk = (tokens) => {
      for (const t of tokens) {
        for (const name of ['href', 'src']) {
          const v = t.attrGet ? t.attrGet(name) : null
          const host = v === null ? null : hostOf(v)
          if (host) out.push(host)
        }
        if (t.type === 'html_inline' || t.type === 'html_block') out.push(...html(t.content))
        if (t.children) walk(t.children)
      }
    }
    walk(md.parse(text, {}))
    return out
  }
  const fuzzy = (text) => (linkify.match(text) ?? []).map((m) => hostOf(m.url)).filter(Boolean)
  return { 'linkify-it': fuzzy, 'markdown-it': markdown, html }
}

/** A small seeded generator (mulberry32): the same texts on every machine. */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The contexts of what was said (each tutorial's captions, name and chapters, and one that says many
 * links), and the cases: each probe of the earlier rounds on its own, each tutorial card against its
 * own captions, and random texts against a context with some captions marked as an AI's (`ai`, as
 * with aiLinks), of one to four parts (a probe, a tutorial card, a link built from hosts, schemes,
 * paths and the glue around them, wrapped as Markdown, an autolink or an HTML attribute, or a said
 * link glued to text), joined by spaces, line breaks, other spaces or nothing.
 * Each keeps the links its parsers open to a host the context did not say, with the pieces that
 * open it on their own (`alone`: each must be noted) and those it needs (`needs`: without any one of
 * them, the parser no longer opens that host; one must be noted when no piece opens it alone), or,
 * when it is opened twice by two pieces each, the pairs it needs (`pairs`: both of one must be noted).
 */
function generate(oracle) {
  const probes = JSON.parse(readFileSync(PROBES, 'utf8')).probes
  const projects = JSON.parse(readFileSync(CORPUS, 'utf8')).projects
  const cards = projects.flatMap((p) => p.cards.map((c) => c.text))
  const rnd = random(20261101)
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const contexts = [
    ...projects.map((p) => ({ captions: p.captions, title: p.title, chapters: p.chapters })),
    {
      captions: ['Download it from flown.app or https://flown.app/download, mail support@flown.app.', 'The code is at github.com/flown/recorder, preview on http://localhost:3000.', 'Docs at flown.app/docs and www.flown.app, follow @flown, built with ASP.NET.', 'Open README.md and main.py, mail anna.li@acme.de.'],
      title: 'Flown tour',
      chapters: ['Intro', 'flown.app/docs']
    }
  ]
  const HOSTS = ['paypal-login.com', 'evil.de', 'evil.co.uk', '203.0.113.7', '3405803783', '0xcb.0x7107', '203.28935', 'evil.在线', 'evil.онлайн', 'evil.web', 'evil.amazon', 'xn--pypal-4ve.com', 'evil.app', 'EVIL.COM', 'login.evil.io', 'evil.рф', '163.com', 'ログインflown.jp', 'flown.app.evil.com', 'flown.app', 'flown.jp', 'github.com', 'acme.de']
  const SCHEMES = ['', '', '', 'https://', 'http://', 'HTTPS://', 'www.', '//', '\\\\', 'https:', 'https:\\\\', 'mailto:x@', 'x@', 'flown.app@', 'https://flown.app@', 'https://flown.app:443@', '//x@', 'https://flown.app\u00a0@', 'https://flown.app\u3000@']
  const PATHS = ['', '', '/verify', '/login?next=x', ':8443/x', '#frag', '/a(b)', '?q=1', '/', '\\x', '%2fx', '.', '。', '%2eevil.com', '．evil．com']
  const GLUE = ['', '', ' ', '.', '@', '//', '/', ':', '%2e', '&#46;', '&period;', '$', '#', '(', ')', '<', '>', '"', "'", '`', '!', '?', '*', ',', '=', '+', '&', '|', '~', '-', '_', '。', '．', '｡', '，', '：', '（', '「', '」', '…', '\u200b', '\u2060', '\ufe0f', '\u00ad', '\u0301', '日本', 'ログイン', '로그인', 'ที่', 'ב-', 'ب-', 'на', 'é', 'ｇｅｔ', '😀', '➡\ufe0f', '™', 'a', '1', '\u00a0', '\u3000']
  const WRAPS = [
    (u) => u,
    (u) => u,
    (u) => `[here](${u})`,
    (u) => `[here](<${u}>)`,
    (u) => `<${u}>`,
    (u) => `<a href="${u}">here</a>`,
    (u) => `<a href='${u}'>here</a>`,
    (u) => `<a href=${u}>here</a>`,
    (u) => `<img src="${u}">`,
    (u) => `[here]: ${u}`,
    (u) => `![x](${u})`
  ]
  const SEPS = [' ', ' ', ' ', '\n', '\n\n', '', '\u00a0', '\u3000', '。', '，', '\t', ' — ']
  const attack = () => `${pick(GLUE)}${pick(SCHEMES)}${pick(HOSTS)}${pick(PATHS)}${pick(GLUE)}`
  const cases = []
  /** One case: `text` against context `c` (its index), with captions `ai` marked as an AI's. */
  const add = (c, ai, text) => {
    const ctx = contexts[c]
    const saidTexts = [...ctx.captions.filter((_, k) => !ai.includes(k)), ctx.title, ...ctx.chapters].filter(Boolean)
    // What the parsers open in what was said, also with spaces around its links in text written without them
    // ("support@flown.appまで"), and before a word's ending written after a "-" ("flown.app-এ").
    const said = new Set(saidTexts.flatMap((t) => [t, t.replace(/-?[^\x00-\x7f]+/g, ' ')]).flatMap((t) => Object.values(oracle).flatMap((read) => read(t))))
    const pieces = [...text.matchAll(PIECE)]
    const links = []
    for (const [by, read] of Object.entries(oracle)) {
      for (const host of new Set(read(text))) {
        if (said.has(host)) continue
        // The pieces that open it on their own, and those it needs (taken out, it is gone; taken out, not blanked, so the
        // spaces left make no Markdown code block).
        const alone = []
        const needs = []
        pieces.forEach((m, k) => {
          if (read(m[0]).includes(host)) alone.push(k)
          if (!read(text.slice(0, m.index) + text.slice(m.index + m[0].length)).includes(host)) needs.push(k)
        })
        // Opened in two places by two pieces each (an attribute across a line break, twice): the pairs it needs.
        const pairs = []
        if (!alone.length && !needs.length) {
          const without = (ks) => text.replace(PIECE, (p, at) => (ks.some((k) => pieces[k].index === at) ? '' : p))
          for (let a = 0; a < pieces.length; a++) for (let b = a + 1; b < pieces.length; b++) if (!read(without([a, b])).includes(host)) pairs.push([a, b])
        }
        links.push({ by, host, alone, needs, ...(pairs.length ? { pairs } : {}) })
      }
    }
    cases.push({ context: c, ...(ai.length ? { ai } : {}), said: [...said].sort(), text, links })
  }
  // Each probe of the earlier rounds on its own, against the context that says the most.
  for (const probe of probes) add(contexts.length - 1, [], probe)
  // Each tutorial card against its own captions.
  projects.forEach((p, c) => p.cards.forEach((card) => add(c, [], card.text)))
  // Random texts.
  for (let i = 0; i < CASES; i++) {
    const c = Math.floor(rnd() * contexts.length)
    const ctx = contexts[c]
    // Some captions an AI wrote a link into: they are not said.
    const ai = ctx.captions.map((_, k) => k).filter(() => rnd() < 0.08)
    const parts = []
    const n = 1 + Math.floor(rnd() * 4)
    for (let j = 0; j < n; j++) {
      const r = rnd()
      if (r < 0.35) parts.push(pick(probes))
      else if (r < 0.5) parts.push(pick(cards))
      else if (r < 0.85) parts.push(pick(WRAPS)(attack()))
      else parts.push(`${pick(GLUE)}${pick(WRAPS)(pick(ctx.captions.join(' ').split(/\s+/)))}${pick(GLUE)}`)
    }
    add(c, ai, parts.reduce((t, p, k) => (k ? `${t}${pick(SEPS)}${p}` : p), '').slice(0, 1500))
  }
  return { contexts, cases }
}
