#!/usr/bin/env node
// Generates the emoji data of Captions Studio (docs/design/captions-studio.md §11.3):
//   src/shared/captions/emojiList.ts: the emoji the bundled colour emoji font draws, that is the
//   fully-qualified entries of Unicode's emoji-test.txt 18.0 whose code points the font
//   (resources/fonts/noto-color-emoji.woff2) maps. Readers, the emoji picker and generation use it.
//   src/shared/captions/numberData.ts: Bangla and Hindi number words (0–99, hundreds and the
//   scales), read from CLDR's spell-out rules, for spelled-out numbers (§11.4).
//   src/shared/captions/emojiData.ts: the emoji generation suggests, each with its words per
//   language: English by hand (scripts/data/emoji-triggers.txt), the other languages from CLDR's
//   emoji annotations, filtered (§11.3).
//   src/shared/captions/bleepWords.ts: the swear-word lists of bleeping (§11.7): obscenity's
//   English data set (Standard) and LDNOOBW per language (Strict).
//
//   node scripts/build-emoji-data.mjs           # write the files
//   node scripts/build-emoji-data.mjs --check   # exit 1 when a committed file is not what it would write
//
// Inputs, each pinned (the script refuses other bytes):
//   scripts/data/emoji-test-18.0.txt  https://www.unicode.org/Public/18.0.0/emoji/emoji-test.txt
//                                     (Unicode License v3, © 1991-2026 Unicode, Inc.)
//   resources/fonts/noto-color-emoji.woff2, against its pin in src/shared/captions/fontCatalog.ts
//   The npm tarballs of NPM_INPUTS (CLDR 49 annotations and spell-out rules, Unicode License v3;
//   obscenity 0.4.6, MIT; naughty-words 1.2.0, CC-BY-4.0), downloaded once into
//   .cache/caption-data/ (SSW_CAPTION_DATA_CACHE overrides) and checked by bytes and SHA-256.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, woff2Tables } from './fonts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const EMOJI_TEST = {
  file: path.join('scripts', 'data', 'emoji-test-18.0.txt'),
  url: 'https://www.unicode.org/Public/18.0.0/emoji/emoji-test.txt',
  version: '18.0',
  bytes: 671_655,
  sha256: '8f3735cda1f92a779d78af67cf86066bb1f07143dc22f2ac29394d9bc57ab21a'
}
const OUT_LIST = path.join('src', 'shared', 'captions', 'emojiList.ts')
const OUT_NUMBERS = path.join('src', 'shared', 'captions', 'numberData.ts')
const OUT_BLEEP = path.join('src', 'shared', 'captions', 'bleepWords.ts')

/** The npm packages the data comes from: tarball URL, bytes and SHA-256 (the registry's integrity is SHA-512 of the same bytes). */
export const NPM_INPUTS = {
  'cldr-annotations-full': {
    version: '49.0.0',
    url: 'https://registry.npmjs.org/cldr-annotations-full/-/cldr-annotations-full-49.0.0.tgz',
    bytes: 6_604_242,
    sha256: 'ce415a4898da7a4ca755437de2593863c05045fc6b1649d8da5ee05fa3bdc33b',
    licence: 'Unicode-3.0'
  },
  'cldr-rbnf': {
    version: '49.0.0',
    url: 'https://registry.npmjs.org/cldr-rbnf/-/cldr-rbnf-49.0.0.tgz',
    bytes: 96_174,
    sha256: '6dc753630b1a7ebb1900b026e9ea0779c4c5ca0a4306c7c69a3ff37a07b5313d',
    licence: 'Unicode-3.0'
  },
  obscenity: {
    version: '0.4.6',
    url: 'https://registry.npmjs.org/obscenity/-/obscenity-0.4.6.tgz',
    bytes: 43_792,
    sha256: '7b00239506036326205e6e42580b438b3458492a1845d8f15e53c263532b368b',
    licence: 'MIT'
  },
  'naughty-words': {
    version: '1.2.0',
    url: 'https://registry.npmjs.org/naughty-words/-/naughty-words-1.2.0.tgz',
    bytes: 24_337,
    sha256: 'c34b05e10a97ec7b9e0c3dd91d09888187c0f08d0812eaea79679795585b217e',
    licence: 'CC-BY-4.0'
  }
}

/** The folder the npm tarballs are kept in. */
export function dataCacheDir(env = process.env) {
  return path.resolve(root, env.SSW_CAPTION_DATA_CACHE || path.join('.cache', 'caption-data'))
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The bytes of a pinned input, or an error naming what differs. */
function pinned(file, bytes, hash) {
  const data = readFileSync(path.join(root, file))
  if (data.length !== bytes || sha256(data) !== hash) throw new Error(`${file} is not the pinned file (${data.length} bytes, SHA-256 ${sha256(data)}; pinned ${bytes}, ${hash})`)
  return data
}

/** The files of a gzipped tar (ustar; regular files only), by path. */
export function untar(gz) {
  const tar = gunzipSync(gz)
  const files = new Map()
  let at = 0
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512)
    if (header.every((b) => b === 0)) break
    const field = (from, len) => header.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '')
    const name = (field(345, 155) ? field(345, 155) + '/' : '') + field(0, 100)
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    if (type === '0' || type === '') files.set(name, tar.subarray(at + 512, at + 512 + size))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

/** The files of a pinned npm tarball, downloaded into the cache once (never more bytes than pinned). */
export async function npmInput(name) {
  const pin = NPM_INPUTS[name]
  const file = path.join(dataCacheDir(), path.basename(new URL(pin.url).pathname))
  const ok = (bytes) => bytes.length === pin.bytes && sha256(bytes) === pin.sha256
  let bytes = existsSync(file) ? readFileSync(file) : null
  if (!bytes || !ok(bytes)) {
    const res = await fetch(pin.url, { redirect: 'error' })
    if (!res.ok) throw new Error(`${pin.url}: HTTP ${res.status}`)
    const chunks = []
    let got = 0
    for await (const chunk of res.body) {
      got += chunk.length
      if (got > pin.bytes) throw new Error(`${pin.url}: more than the pinned ${pin.bytes} bytes`)
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
    if (!ok(bytes)) throw new Error(`${pin.url} did not match its pin (${bytes.length} bytes, SHA-256 ${sha256(bytes)})`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file + '.part', bytes)
    renameSync(file + '.part', file)
  }
  return untar(bytes)
}

/* ---------- number words (§11.4) ---------- */

/** Number words of CLDR spell-out rules: 0–99, the hundred (attached to its multiplier or not) and the scales. */
export function spelloutTable(rules) {
  const card = rules.split('%spellout-cardinal:')[1]?.split(/\n%/)[0] ?? ''
  const words = {}
  let hundred = null
  const scales = {}
  for (const line of card.split('\n')) {
    const plain = /^(\d+): ([^;<>=[\]]+);$/u.exec(line.trim())
    if (plain && Number(plain[1]) < 100) {
      words[plain[2].trim()] = Number(plain[1])
      continue
    }
    const scaled = /^(\d+): <<( ?)([^\s[;]+)\[/u.exec(line.trim())
    if (!scaled) continue
    const n = Number(scaled[1])
    if (n === 100) hundred = { word: scaled[3], attached: scaled[2] === '' }
    else if (n >= 1000 && n <= 1e12) scales[scaled[3]] = n
  }
  if (Object.keys(words).length !== 100 || !hundred) throw new Error('the spell-out rules did not give 0–99 and the hundred')
  return { words, hundred, scales }
}

export function numberDataSource(tables) {
  return `/**
 * GENERATED by scripts/build-emoji-data.mjs: do not edit; \`node scripts/build-emoji-data.mjs --check\` compares.
 *
 * Spelled-out Bangla and Hindi numbers (docs/design/captions-studio.md §11.4): the words for 0–99,
 * the hundred and the scales, read from CLDR ${NPM_INPUTS['cldr-rbnf'].version}'s spell-out rules
 * (cldr-rbnf, ${NPM_INPUTS['cldr-rbnf'].url}, SHA-256 ${NPM_INPUTS['cldr-rbnf'].sha256}; Unicode
 * License v3, © 1991-2026 Unicode, Inc., resources/notices/35-caption-data.txt).
 */

export interface SpelledNumbers {
  /** 0–99 by word. */
  words: Readonly<Record<string, number>>
  /** The word for a hundred, written onto its multiplier (Bangla তিনশো) or after it (Hindi तीन सौ). */
  hundred: { word: string; attached: boolean }
  /** Thousand and up, by word. */
  scales: Readonly<Record<string, number>>
}

export const NUMBER_WORDS: Readonly<Record<'bn' | 'hi', SpelledNumbers>> = ${JSON.stringify(tables, null, 2)}
`
}

/* ---------- bleep words (§11.7) ---------- */

/**
 * obscenity's English data set (dist/preset/english.js): per phrase its word, its patterns and its
 * whitelisted terms. A pattern's '|' marks a word boundary, '[x]' an optional part, '?' any letter.
 */
export function obscenityPhrases(js) {
  const out = []
  for (const chunk of js.split('.addPhrase(').slice(1)) {
    const word = /originalWord: '([^']+)'/.exec(chunk)?.[1]
    if (!word) continue
    const patterns = [...chunk.matchAll(/pattern\) `([^`]+)`/g)].map((m) => patternSource(m[1]))
    const safe = [...chunk.matchAll(/addWhitelistedTerm\('([^']+)'\)/g)].map((m) => m[1].replace(/\s+/g, ''))
    if (patterns.length) out.push({ word, patterns: [...new Set(patterns)], safe: [...new Set(safe)] })
  }
  if (out.length < 60) throw new Error(`obscenity's data set gave only ${out.length} words`)
  return out
}

/** A RegExp source (over a word lower-cased, punctuation removed, repeats collapsed) of an obscenity pattern. */
function patternSource(p) {
  let src = ''
  let i = 0
  const start = p.startsWith('|')
  const end = p.endsWith('|') && p.length > 1
  const body = p.slice(start ? 1 : 0, end ? -1 : undefined)
  for (i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '[') {
      const close = body.indexOf(']', i)
      src += `(?:${escapeRe(body.slice(i + 1, close)).replace(/\\\?/g, '.')})?`
      i = close
    } else if (ch === '?') src += '.'
    else src += escapeRe(ch)
  }
  return `${start ? '^' : ''}${src}${end ? '$' : ''}`
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** LDNOOBW (naughty-words) per language: its single words, lower case, sorted. */
export function ldnoobwWords(files) {
  const out = {}
  for (const [name, data] of files) {
    const m = /^package\/([a-z]{2,3})\.json$/.exec(name)
    if (!m || m[1] === 'tlh' || m[1] === 'kab') continue
    const list = JSON.parse(data.toString('utf8'))
    if (!Array.isArray(list)) continue
    out[m[1]] = [...new Set(list.filter((w) => typeof w === 'string' && !/\s/.test(w.trim())).map((w) => w.trim().toLowerCase()))].sort()
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

export function bleepWordsSource(standard, strict) {
  const o = NPM_INPUTS.obscenity
  const n = NPM_INPUTS['naughty-words']
  return `/**
 * GENERATED by scripts/build-emoji-data.mjs: do not edit; \`node scripts/build-emoji-data.mjs --check\` compares.
 *
 * The swear-word lists of bleeping (docs/design/captions-studio.md §11.7), matched against a word
 * lower-cased, without punctuation, with repeated letters collapsed (cleanup.ts):
 * - Standard: obscenity ${o.version}'s English data set (${o.url}, SHA-256 ${o.sha256}; MIT,
 *   Copyright (c) 2025 Joseph Liu; its words from cuss, MIT, © 2016 Titus Wormer), each word with its patterns and
 *   its safe look-alikes ("assassin").
 * - Strict adds LDNOOBW per language: "List of Dirty, Naughty, Obscene, and Otherwise Bad Words"
 *   (naughty-words ${n.version}, ${n.url}, SHA-256 ${n.sha256}), © 2012–2020 Shutterstock, Inc., licensed
 *   CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); single words only, lower-cased and
 *   de-duplicated, nothing else changed. Attribution: resources/notices/35-caption-data.txt.
 */

export interface StandardWord {
  /** The word as obscenity names it. */
  word: string
  /** RegExp sources over the normalised word ('^' and '$' where obscenity marks a word boundary). */
  patterns: readonly string[]
  /** Look-alikes that are not rude: a word holding one is never bleeped. */
  safe: readonly string[]
}

export const STANDARD_WORDS: readonly StandardWord[] = ${JSON.stringify(standard)}

/** LDNOOBW's single words per language. */
export const STRICT_WORDS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(strict)}
`
}

/** The code points a font's cmap maps (formats 4 and 12). */
export function cmapCodePoints(cmap) {
  const n = cmap.readUInt16BE(2)
  const subtables = []
  for (let i = 0; i < n; i++) {
    const platform = cmap.readUInt16BE(4 + i * 8)
    const encoding = cmap.readUInt16BE(6 + i * 8)
    const offset = cmap.readUInt32BE(8 + i * 8)
    subtables.push({ platform, encoding, offset, format: cmap.readUInt16BE(offset) })
  }
  const out = new Set()
  for (const t of subtables) {
    if (t.format === 12) {
      const groups = cmap.readUInt32BE(t.offset + 12)
      for (let g = 0; g < groups; g++) {
        const at = t.offset + 16 + g * 12
        const start = cmap.readUInt32BE(at)
        const end = cmap.readUInt32BE(at + 4)
        const glyph = cmap.readUInt32BE(at + 8)
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c)
      }
    } else if (t.format === 4) {
      const segX2 = cmap.readUInt16BE(t.offset + 6)
      const ends = t.offset + 14
      const starts = ends + segX2 + 2
      const deltas = starts + segX2
      const ranges = deltas + segX2
      for (let s = 0; s < segX2 / 2; s++) {
        const end = cmap.readUInt16BE(ends + s * 2)
        const start = cmap.readUInt16BE(starts + s * 2)
        const delta = cmap.readInt16BE(deltas + s * 2)
        const rangeOffset = cmap.readUInt16BE(ranges + s * 2)
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph
          if (rangeOffset === 0) glyph = (c + delta) & 0xffff
          else {
            const at = ranges + s * 2 + rangeOffset + (c - start) * 2
            glyph = cmap.readUInt16BE(at)
            if (glyph) glyph = (glyph + delta) & 0xffff
          }
          if (glyph) out.add(c)
        }
      }
    }
  }
  return out
}

/** The fully-qualified entries of emoji-test.txt, in its order, with their group. */
export function emojiTestEntries(text) {
  const out = []
  let group = ''
  for (const line of text.split('\n')) {
    const g = /^# group: (.+)$/.exec(line)
    if (g) {
      group = g[1].trim()
      continue
    }
    const m = /^([0-9A-F ]+?)\s*; fully-qualified\s*# \S+ E\d+\.\d+ (.+)$/.exec(line)
    if (m) out.push({ points: m[1].trim().split(' ').map((h) => parseInt(h, 16)), name: m[2].trim(), group })
  }
  return out
}

const hex = (cp) => cp.toString(16)

/** The text of emojiList.ts for the entries the font draws. */
export function emojiListSource(entries, fontPin) {
  const groups = [...new Set(entries.map((e) => e.group))]
  const lines = entries.map((e) => `${groups.indexOf(e.group)};${e.points.map(hex).join('-')};${e.name}`)
  return `/**
 * GENERATED by scripts/build-emoji-data.mjs: do not edit; \`node scripts/build-emoji-data.mjs --check\` compares.
 *
 * The emoji the bundled colour emoji font draws (docs/design/captions-studio.md §11.3): the
 * fully-qualified entries of Unicode's emoji-test.txt ${EMOJI_TEST.version} (${EMOJI_TEST.url},
 * SHA-256 ${EMOJI_TEST.sha256}) whose code points the font maps (Noto Color Emoji,
 * resources/fonts/${fontPin.file}, SHA-256 ${fontPin.sha256}). Emoji names and groups:
 * Unicode License v3, © 1991-2026 Unicode, Inc. (resources/notices/35-caption-data.txt).
 */

/** An emoji the picker and generation can offer. */
export interface EmojiEntry {
  /** Code points in hex joined by '-', without FE0F: EmojiGraphic.emoji. */
  key: string
  /** The fully-qualified sequence, as typed and drawn. */
  text: string
  /** Unicode's short name ("fire"). */
  name: string
  /** Unicode's group ("Smileys & Emotion"). */
  group: string
}

export const EMOJI_TEST_VERSION = '${EMOJI_TEST.version}'

/** Unicode's emoji groups, in their order. */
export const EMOJI_GROUPS: readonly string[] = ${JSON.stringify(groups)}

/** One line per emoji: group index; fully-qualified code points in hex; name. */
const DATA = ${JSON.stringify(lines.join('\n'))}

/** Every emoji the bundled font draws, in Unicode's order (${entries.length}). */
export const EMOJI_LIST: readonly EmojiEntry[] = DATA.split('\\n').map((line) => {
  const [group, points, name] = line.split(';')
  const cps = points.split('-').map((h) => parseInt(h, 16))
  return { key: cps.filter((c) => c !== 0xfe0f).map((c) => c.toString(16)).join('-'), text: String.fromCodePoint(...cps), name, group: EMOJI_GROUPS[Number(group)] }
})

const BY_KEY: ReadonlyMap<string, EmojiEntry> = new Map(EMOJI_LIST.map((e) => [e.key, e]))

/** The keys of EMOJI_LIST: a graphic's emoji is drawn only when it is one of them (§4.2 rule 5). */
export const EMOJI_KEYS: ReadonlySet<string> = new Set(BY_KEY.keys())

/** The listed emoji with key \`key\`, or undefined. */
export function emojiEntry(key: string): EmojiEntry | undefined {
  return BY_KEY.get(key)
}
`
}

/** What the script writes: path → text. */
export async function generate() {
  const catalog = await loadCatalog()
  const font = catalog.catalogFont('noto-color-emoji')
  const pin = font.files[0].woff2
  const woff2 = pinned(path.join('resources', 'fonts', pin.file), pin.bytes, pin.sha256)
  const cmap = woff2Tables(woff2).tables.find((t) => t.tag === 'cmap')
  if (!cmap) throw new Error('the emoji font has no cmap table')
  const drawn = cmapCodePoints(cmap.data)
  const test = pinned(EMOJI_TEST.file, EMOJI_TEST.bytes, EMOJI_TEST.sha256).toString('utf8')
  // An entry is drawn when the font maps each of its code points but the variation selector.
  const entries = emojiTestEntries(test).filter((e) => e.points.every((c) => c === 0xfe0f || drawn.has(c)))
  const rbnf = await npmInput('cldr-rbnf')
  const rules = (lang) => {
    const f = rbnf.get(`package/rbnf/${lang}-SpelloutRules.txt`)
    if (!f) throw new Error(`cldr-rbnf has no ${lang}-SpelloutRules.txt`)
    return spelloutTable(f.toString('utf8'))
  }
  const obscenity = (await npmInput('obscenity')).get('package/dist/preset/english.js')
  if (!obscenity) throw new Error('obscenity has no dist/preset/english.js')
  const naughty = await npmInput('naughty-words')
  return {
    [OUT_LIST]: emojiListSource(entries, pin),
    [OUT_NUMBERS]: numberDataSource({ bn: rules('bn'), hi: rules('hi') }),
    [OUT_BLEEP]: bleepWordsSource(obscenityPhrases(obscenity.toString('utf8')), ldnoobwWords(naughty))
  }
}

async function main(args) {
  const files = await generate()
  const check = args.includes('--check')
  let stale = 0
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(root, file)
    let now = ''
    try {
      now = readFileSync(at, 'utf8')
    } catch {
      // Missing: written below, or stale in --check.
    }
    if (now === text) continue
    if (check) {
      stale++
      console.error(`build-emoji-data: ${file} is not what the script generates; run "node scripts/build-emoji-data.mjs"`)
    } else {
      writeFileSync(at, text)
      console.log(`build-emoji-data: wrote ${file}`)
    }
  }
  if (check && !stale) console.log('build-emoji-data: the generated files are up to date')
  return stale ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`build-emoji-data: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
  )
}
