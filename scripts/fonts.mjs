#!/usr/bin/env node
// The caption fonts of Captions Studio (docs/design/captions-studio.md §6, §0.3): downloads each
// pinned TTF from its pinned commit, checks its size and SHA-256, and turns it into the WOFF2
// committed in resources/fonts/. The catalogue (src/shared/captions/fontCatalog.ts) pins both
// files; this script reads it directly (Node 22.18 or later strips its types).
//
//   node scripts/fonts.mjs download   # the bundled TTFs into .cache/caption-fonts/ (checked)
//   node scripts/fonts.mjs build      # resources/fonts/*.woff2 from them, then `check`
//   node scripts/fonts.mjs check      # every WOFF2 against its pin; with the TTFs downloaded,
//                                     # also that each WOFF2 holds exactly its TTF's tables
//   node scripts/fonts.mjs download --all   # the downloadable CJK fonts too (checks their pins)
//
// The WOFF2 files keep every table of the upstream TTF byte for byte: each table is stored with
// the null transform (glyf and loca too) and the whole stream is one brotli stream (quality 11,
// font mode), as the WOFF2 2.0 format allows. So `check` can prove a WOFF2 is its pinned TTF by
// decoding it, whatever brotli version made it.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FONT_DIR = path.join(root, 'resources', 'fonts')

/** The folder the downloaded TTFs live in (SSW_CAPTION_FONT_CACHE overrides). */
export function cacheDir(env = process.env) {
  return path.resolve(root, env.SSW_CAPTION_FONT_CACHE || path.join('.cache', 'caption-fonts'))
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/* ---------- WOFF2 (https://www.w3.org/TR/WOFF2/) with null transforms ---------- */

/** The 63 known table tags of WOFF2 §5.2, by index. */
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
]

/** The tables of an sfnt (TrueType or CFF) font: its version tag and each table's bytes, in tag order. */
export function sfntTables(buf) {
  const flavor = buf.readUInt32BE(0)
  if (flavor !== 0x00010000 && flavor !== 0x4f54544f) throw new Error('not a TrueType or OpenType font')
  const n = buf.readUInt16BE(4)
  const tables = []
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16
    const tag = buf.toString('latin1', at, at + 4)
    const offset = buf.readUInt32BE(at + 8)
    const length = buf.readUInt32BE(at + 12)
    if (offset + length > buf.length) throw new Error(`table ${tag} runs past the end of the file`)
    tables.push({ tag, data: buf.subarray(offset, offset + length) })
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  return { flavor, tables }
}

function base128(n) {
  const out = []
  do {
    out.unshift(n & 0x7f)
    n = Math.floor(n / 128)
  } while (n > 0)
  return Buffer.from(out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b)))
}

function readBase128(buf, at) {
  let n = 0
  for (let i = 0; i < 5; i++) {
    const b = buf[at + i]
    if (i === 0 && b === 0x80) throw new Error('UIntBase128 with a leading zero')
    n = n * 128 + (b & 0x7f)
    if (!(b & 0x80)) return { value: n, next: at + i + 1 }
  }
  throw new Error('UIntBase128 longer than 5 bytes')
}

const round4 = (n) => (n + 3) & ~3

/** A WOFF2 file holding exactly the tables of the sfnt `ttf`, each with the null transform. */
export function toWoff2(ttf) {
  const { flavor, tables } = sfntTables(ttf)
  const dir = []
  for (const t of tables) {
    const known = KNOWN_TAGS.indexOf(t.tag)
    // Transform version 3 is the null transform for glyf and loca; 0 is the null transform for the rest.
    const version = t.tag === 'glyf' || t.tag === 'loca' ? 3 : 0
    const flags = Buffer.from([(known >= 0 ? known : 63) | (version << 6)])
    dir.push(flags, known >= 0 ? Buffer.alloc(0) : Buffer.from(t.tag, 'latin1'), base128(t.data.length))
  }
  const directory = Buffer.concat(dir)
  const stream = Buffer.concat(tables.map((t) => t.data))
  const compressed = zlib.brotliCompressSync(stream, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_FONT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stream.length
    }
  })
  const totalSfntSize = 12 + 16 * tables.length + tables.reduce((n, t) => n + round4(t.data.length), 0)
  const length = round4(48 + directory.length + compressed.length)
  const header = Buffer.alloc(48)
  header.write('wOF2', 0, 'latin1')
  header.writeUInt32BE(flavor, 4)
  header.writeUInt32BE(length, 8)
  header.writeUInt16BE(tables.length, 12)
  header.writeUInt16BE(0, 14)
  header.writeUInt32BE(totalSfntSize, 16)
  header.writeUInt32BE(compressed.length, 20)
  // majorVersion and minorVersion: the font's own (head.fontRevision), as encoders do.
  const head = tables.find((t) => t.tag === 'head')
  if (head) {
    header.writeUInt16BE(head.data.readUInt16BE(4), 24)
    header.writeUInt16BE(head.data.readUInt16BE(6), 26)
  }
  // No metadata and no private data: offsets and lengths 0.
  const out = Buffer.alloc(length)
  header.copy(out, 0)
  directory.copy(out, 48)
  compressed.copy(out, 48 + directory.length)
  return out
}

/** The tables of a WOFF2 file made with null transforms (as toWoff2 makes them), in tag order. */
export function woff2Tables(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file')
  if (buf.readUInt32BE(8) !== buf.length) throw new Error('the WOFF2 length field does not match the file')
  const flavor = buf.readUInt32BE(4)
  const n = buf.readUInt16BE(12)
  const compressedLength = buf.readUInt32BE(20)
  let at = 48
  const entries = []
  for (let i = 0; i < n; i++) {
    const flags = buf[at++]
    const known = flags & 0x3f
    const version = flags >> 6
    let tag
    if (known === 63) {
      tag = buf.toString('latin1', at, at + 4)
      at += 4
    } else tag = KNOWN_TAGS[known]
    const orig = readBase128(buf, at)
    at = orig.next
    const nullTransform = tag === 'glyf' || tag === 'loca' ? version === 3 : version === 0
    if (!nullTransform) throw new Error(`table ${tag} is transformed (only null transforms are expected)`)
    entries.push({ tag, length: orig.value })
  }
  const stream = zlib.brotliDecompressSync(buf.subarray(at, at + compressedLength))
  const tables = []
  let offset = 0
  for (const e of entries) {
    tables.push({ tag: e.tag, data: stream.subarray(offset, offset + e.length) })
    offset += e.length
  }
  if (offset !== stream.length) throw new Error('the WOFF2 stream is longer than its tables')
  return { flavor, tables }
}

/** Why `woff2` does not hold exactly the tables of `ttf` (empty: it does). */
export function sameFont(woff2, ttf) {
  const a = woff2Tables(woff2)
  const b = sfntTables(ttf)
  const problems = []
  if (a.flavor !== b.flavor) problems.push('a different sfnt version')
  const tags = (x) => x.tables.map((t) => t.tag).join(' ')
  if (tags(a) !== tags(b)) problems.push(`tables ${tags(a)} instead of ${tags(b)}`)
  else a.tables.forEach((t, i) => void (t.data.equals(b.tables[i].data) || problems.push(`table ${t.tag} differs`)))
  return problems
}

/* ---------- the catalogue ---------- */

/** The catalogue module (TypeScript without runtime imports, so Node strips its types). */
export async function loadCatalog() {
  return import(pathToFileURL(path.join(root, 'src', 'shared', 'captions', 'fontCatalog.ts')).href)
}

/** Every file of the catalogue: bundled ones with their WOFF2, downloaded ones (with `all`) without. */
function filesOf(catalog, all) {
  const out = []
  for (const font of catalog.CATALOG_FONTS) {
    if (!font.bundled && !all) continue
    for (const file of font.files) out.push({ font, file, ttf: path.join(cacheDir(), path.basename(file.path)) })
  }
  return out
}

async function download(catalog, entry) {
  const { font, file, ttf } = entry
  if (existsSync(ttf) && statSync(ttf).size === file.bytes && sha256(readFileSync(ttf)) === file.sha256) return 'cached'
  let last = ''
  for (const url of catalog.fontSources(font, file)) {
    const res = await fetch(url, { redirect: 'error' })
    if (!res.ok) {
      last = `HTTP ${res.status} from ${url}`
      continue
    }
    const chunks = []
    let got = 0
    for await (const chunk of res.body) {
      got += chunk.length
      // Never more bytes than pinned.
      if (got > file.bytes) throw new Error(`${file.path}: more than the pinned ${file.bytes} bytes`)
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`${file.path}: the download did not match its pin (${bytes.length} bytes, SHA-256 ${sha256(bytes)})`)
    mkdirSync(path.dirname(ttf), { recursive: true })
    writeFileSync(ttf + '.part', bytes)
    renameSync(ttf + '.part', ttf)
    return 'downloaded'
  }
  throw new Error(`${file.path}: ${last || 'no source'}`)
}

/** Problems with resources/fonts against the catalogue (empty: every WOFF2 is its pin). */
export function checkFonts(catalog, { decode = true } = {}) {
  const problems = []
  const expected = new Set()
  for (const { font, file, ttf } of filesOf(catalog, false)) {
    if (!file.woff2) {
      problems.push(`${font.id}: ${file.path} has no WOFF2 pin`)
      continue
    }
    expected.add(file.woff2.file)
    const at = path.join(FONT_DIR, file.woff2.file)
    if (!existsSync(at)) {
      problems.push(`${file.woff2.file} is missing`)
      continue
    }
    const bytes = readFileSync(at)
    if (bytes.length !== file.woff2.bytes || sha256(bytes) !== file.woff2.sha256) problems.push(`${file.woff2.file}: ${bytes.length} bytes, SHA-256 ${sha256(bytes)} (pinned ${file.woff2.bytes}, ${file.woff2.sha256})`)
    if (decode && existsSync(ttf)) {
      const source = readFileSync(ttf)
      if (sha256(source) === file.sha256) for (const p of sameFont(bytes, source)) problems.push(`${file.woff2.file}: ${p}`)
    }
  }
  for (const f of existsSync(FONT_DIR) ? readdirSync(FONT_DIR) : []) if (f.endsWith('.woff2') && !expected.has(f)) problems.push(`${f} is not in the catalogue`)
  return problems
}

async function main(args) {
  const catalog = await loadCatalog()
  const command = args[0] ?? 'check'
  if (command === 'download') {
    for (const entry of filesOf(catalog, args.includes('--all'))) console.log(`fonts: ${entry.file.path}: ${await download(catalog, entry)}`)
    return 0
  }
  if (command === 'build') {
    mkdirSync(FONT_DIR, { recursive: true })
    for (const { font, file, ttf } of filesOf(catalog, false)) {
      if (!file.woff2) throw new Error(`${font.id}: ${file.path} has no WOFF2 entry in the catalogue`)
      const source = readFileSync(ttf)
      if (source.length !== file.bytes || sha256(source) !== file.sha256) throw new Error(`${ttf} is not the pinned file: run "node scripts/fonts.mjs download"`)
      const woff2 = toWoff2(source)
      writeFileSync(path.join(FONT_DIR, file.woff2.file), woff2)
      console.log(`${file.woff2.file}\t${woff2.length}\t${sha256(woff2)}`)
    }
  } else if (command !== 'check') {
    console.error('usage: node scripts/fonts.mjs [download [--all] | build | check]')
    return 2
  }
  const problems = checkFonts(catalog)
  for (const p of problems) console.error(`fonts: ${p}`)
  if (!problems.length) console.log(`fonts: ${filesOf(catalog, false).length} WOFF2 files match their pins`)
  return problems.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`fonts: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
  )
}
