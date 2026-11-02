#!/usr/bin/env node
// Writes tests/fixtures/x-links.json: what twitter-text 3.1.0, the library X publishes for what it
// links and how it counts a post, answers for several thousand texts (docs/design/publish-pack.md
// §4.4–4.5). tests/publishLinks.test.ts checks that the port in src/shared/publish/twitterText.ts
// gives exactly the same, link for link and index for index, and the same weighted length.
//
// The answers come from the published packages themselves, never from the app's node_modules:
// twitter-text 3.1.0 and the two packages its code needs, twemoji-parser 11.0.2 (the emoji
// parseTweet counts) and punycode 1.4.1, each checked against the npm registry's integrity before it
// is unpacked into a new temporary folder. Its other requires (Babel's interop helper and core-js
// polyfills, which do nothing on current Node) are answered with stand-ins.
//
//   node scripts/build-link-oracle.mjs                      # download with `npm pack`, write the file
//   node scripts/build-link-oracle.mjs --tarballs <folder>  # use the three .tgz files in <folder>
//   node scripts/build-link-oracle.mjs --check [...]        # exit 1 when the committed file differs
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'tests', 'fixtures', 'x-links.json')
const SAMPLES = path.join(root, 'tests', 'fixtures', 'link-samples.json')

/** The packages and the integrity the npm registry gives for each (dist.integrity). */
const PACKAGES = {
  'twitter-text': { version: '3.1.0', integrity: 'sha512-nulfUi3FN6z0LUjYipJid+eiwXvOLb8Ass7Jy/6zsXmZK3URte043m8fL3FyDzrK+WLpyqhHuR/TcARTN/iuGQ==' },
  'twemoji-parser': { version: '11.0.2', integrity: 'sha512-5kO2XCcpAql6zjdLwRwJjYvAZyDy3+Uj7v1ipBzLthQmDL7Ce19bEqHr3ImSNeoSW2OA8u02XmARbXHaNO8GhA==' },
  punycode: { version: '1.4.1', integrity: 'sha512-jmYNElW7yvO7TV33CjSmvSiE2yco3bV2czu/OzDKdMNVZQWfxCblURLhf+47syQRBntjfLdd/H0egrzIG+oaFQ==' }
}

const args = process.argv.slice(2)
const check = args.includes('--check')
const from = args.includes('--tarballs') ? path.resolve(args[args.indexOf('--tarballs') + 1] ?? '') : null

const work = mkdtempSync(path.join(os.tmpdir(), 'flown-link-oracle-'))
try {
  const dirs = {}
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
    const dir = path.join(work, name)
    mkdirSync(dir)
    const r = spawnSync('tar', ['-xzf', tgz, '-C', dir], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`unpacking ${file} failed: ${(r.stderr || r.error?.message || '').trim()}`)
    dirs[name] = path.join(dir, 'package')
  }

  const tt = load(dirs)
  const cases = samples().map((text) => {
    let urls
    let weighted
    try {
      urls = tt.extractUrlsWithIndices(text).map((u) => [u.url, u.indices[0], u.indices[1]])
      weighted = tt.parseTweet(text).weightedLength
    } catch {
      return null
    }
    return { text, urls, weighted }
  })
  const kept = cases.filter(Boolean)
  const fixture = {
    about: 'twitter-text 3.1.0 answers, written by scripts/build-link-oracle.mjs; tests/publishLinks.test.ts checks the port against them.',
    packages: Object.fromEntries(Object.entries(PACKAGES).map(([name, p]) => [name, `${p.version} ${p.integrity}`])),
    patterns: {
      extractUrl: [tt.extractUrl.source, tt.extractUrl.flags],
      validAsciiDomain: [tt.validAsciiDomain.source, tt.validAsciiDomain.flags],
      validTcoUrl: [tt.validTcoUrl.source, tt.validTcoUrl.flags],
      invalidUrlWithoutProtocolPrecedingChars: [tt.invalidPre.source, tt.invalidPre.flags],
      twemoji: [tt.emoji.source, tt.emoji.flags]
    },
    cases: kept
  }
  // One case per line, so a change reads as a small diff; invisible characters, marks and direction
  // controls written as \\u escapes, so the file shows what it holds.
  const json = (v) => JSON.stringify(v).replace(/(?! )[\p{C}\p{Mn}\p{Me}\p{Z}]/gu, (c) => c.replace(/[^]/g, (u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`))
  const text =
    `{\n${['about', 'packages', 'patterns'].map((k) => `  ${JSON.stringify(k)}: ${json(fixture[k])},`).join('\n')}\n` +
    `  "cases": [\n${kept.map((c) => `    ${json(c)}`).join(',\n')}\n  ]\n}\n`
  if (check) {
    const committed = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (committed !== text) {
      console.error(`${path.relative(root, OUT)} is not what twitter-text 3.1.0 answers now: run node scripts/build-link-oracle.mjs`)
      process.exitCode = 1
    } else console.log(`${path.relative(root, OUT)}: ${kept.length} cases, as twitter-text 3.1.0 answers them.`)
  } else {
    writeFileSync(OUT, text)
    console.log(`Wrote ${path.relative(root, OUT)}: ${kept.length} cases (${cases.length - kept.length} left out: twitter-text threw).`)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}

/** twitter-text's functions and patterns, its requires answered from the unpacked packages and stand-ins. */
function load(dirs) {
  const shim = path.join(work, 'shim')
  mkdirSync(shim)
  writeFileSync(path.join(shim, 'empty.js'), '')
  writeFileSync(path.join(shim, 'interop.js'), 'function i(o) { return o && o.__esModule ? o : { default: o } }\nmodule.exports = i\nmodule.exports.default = i\nmodule.exports.__esModule = true\n')
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request.startsWith('core-js/')) return path.join(shim, 'empty.js')
    if (request === '@babel/runtime/helpers/interopRequireDefault') return path.join(shim, 'interop.js')
    if (request === 'twemoji-parser') return path.join(dirs['twemoji-parser'], 'dist', 'index.js')
    if (request === 'punycode') return path.join(dirs.punycode, 'punycode.js')
    return original.call(this, request, parent, ...rest)
  }
  try {
    const require = createRequire(path.join(dirs['twitter-text'], 'package.json'))
    const dist = (p) => require(path.join(dirs['twitter-text'], 'dist', p))
    return {
      extractUrlsWithIndices: dist('extractUrlsWithIndices.js'),
      parseTweet: dist('parseTweet.js'),
      extractUrl: dist('regexp/extractUrl.js'),
      validAsciiDomain: dist('regexp/validAsciiDomain.js'),
      validTcoUrl: dist('regexp/validTcoUrl.js'),
      invalidPre: dist('regexp/invalidUrlWithoutProtocolPrecedingChars.js'),
      emoji: require(path.join(dirs['twemoji-parser'], 'dist', 'lib', 'regex.js')).default
    }
  } finally {
    Module._resolveFilename = original
  }
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
 * The texts: every sample of tests/fixtures/link-samples.json (the review findings' examples, the
 * earlier tests' texts, a sentence or more in each caption language, code and file names, links of
 * every kind), each link between each kind of text before and after it, and seeded random texts
 * from pieces that matter to X's rules (scripts, dots, brackets, queries, "@", "#", "$", ports,
 * punycode, zero-width and combining marks, full-width dots, emoji).
 */
function samples() {
  const s = JSON.parse(readFileSync(SAMPLES, 'utf8'))
  const out = new Set()
  const add = (t) => {
    if (t) out.add(t)
  }
  for (const list of Object.values(s.findings)) for (const t of list) add(t)
  for (const t of s.earlierTests) add(t)
  for (const list of Object.values(s.languages)) for (const t of list) add(t)
  for (const t of [...s.code, ...s.links]) add(t)
  const words = [...Object.values(s.languages).flat(), ...s.code]
  const rnd = random(20261031)
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  // Each link after each kind of text before it, and before each kind of text after it.
  for (const link of s.links) for (const before of s.before) add(`${before}${link}${pick(s.after)}`)
  for (const link of s.links) for (const after of s.after) add(`${pick(s.before)}${link}${after}`)
  // Links inside sentences of every language, glued and spaced.
  for (let i = 0; i < 600; i++) {
    const w = pick(words)
    const at = Math.floor(rnd() * (w.length + 1))
    const glue = rnd() < 0.5 ? '' : ' '
    add(`${w.slice(0, at)}${glue}${pick(s.before)}${pick(s.links)}${pick(s.after)}${glue}${w.slice(at)}`)
  }
  // Links in brackets, queries and paths of other links.
  const wrap = [['(', ')'], ['[', ']'], ['((', '))'], ['?next=', ''], ['?a=1&u=', '&b=2'], ['/', '/'], ['#', ''], [':80/', ''], ['(see ', ' now)']]
  for (let i = 0; i < 500; i++) {
    const [open, close] = pick(wrap)
    add(`${pick(s.before)}${pick(s.links)}${open}${pick(s.links)}${close}${pick(s.after)}`)
  }
  const atoms = [
    'a', 'Z', 'evil', 'flown', 'TP', 'Th', 'ủ', 'é', '\u0301', 'ы', 'онлайн', 'сайт', 'рф', '在线', '嘉里', '大酒店', 'コム', 'คอม', '日本', '詳細は', 'で',
    '.', '.', '.', '.', '.com', '.de', '.app', '.co', '.uk', '.in', '.md', '.ai', 'com', 'co', 'xn--p1ai', 'xn--', '/', '//', '?', '=', '&', ':', ':8080',
    '#', '@', '$', '＠', '＃', '_', '-', '–', '+', '(', ')', '[', ']', '{', '}', '"', "'", '`', ',', ';', '!', '~', '%', '|', '*',
    'https://', 'http://', 'HTTP://', 'www.', 't.co/', ' ', ' ', '\n', '\u00a0', '\u3000', '\u200b', '\u200d', '\u200e', '\u202e', '\u2066', '\ufeff', '\ufe0f',
    '。', '．', '｡', '…', '\u017f', '\u212a', '😀', '👍🏽', '👨\u200d👩\u200d👧', '#\ufe0f\u20e3', '©', '™', '1', '42', '٢', '१'
  ]
  for (let i = 0; i < 2600; i++) {
    let t = ''
    const n = 1 + Math.floor(rnd() * 16)
    for (let j = 0; j < n; j++) t += pick(atoms)
    add(t)
  }
  // Longer texts: many links and dots in a row, as a long post has them.
  for (let i = 0; i < 150; i++) {
    let t = ''
    const n = 20 + Math.floor(rnd() * 60)
    for (let j = 0; j < n; j++) t += rnd() < 0.3 ? pick(s.links) : pick(atoms)
    add(t)
  }
  return [...out]
}
