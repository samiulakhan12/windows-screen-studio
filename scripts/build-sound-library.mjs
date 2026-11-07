#!/usr/bin/env node
// The music and sound-effects library (docs/design/editing-polish.md §10.2): downloads each pinned
// upstream file of the catalogue (src/shared/audio/soundLibrary.ts, read directly: Node 22.18 or
// later strips its types), checks its bytes and SHA-256 (any mismatch stops the build), takes the
// named members out of the archives, and prepares the files the app uses:
//
//   beds     48 kHz stereo, cut at the analysed loop end E with a 1.0 s equal-power crossfade baked
//            in (the file's end continues straight on at the loop start S), a 0.25 s pad of the
//            loop's continuation, −16 LUFS integrated over one pass plus one loop with the true
//            peak at most −1.5 dBTP (a gentle true-peak limiter where the catalogue says so),
//            Ogg Opus 64 kb/s constrained VBR, no header gain, no tags
//   effects  mono 48 kHz, silence trimmed at −60 dBFS, 2 ms fade in and 5 ms out, the loudest
//            400 ms at −20 LUFS unless the true peak would pass −1 dBTP (measured again after
//            encoding), 20 ms of silence after, Ogg Opus 48 kb/s VBR, no tags
//
// Bundled files go to resources/sound-library/, the beds that download to --release-dir (they
// are uploaded by hand to the release the catalogue names; this script never uploads anything).
//
// Pinned once: Opus output differs between encoder builds, so the catalogue's PREPARED block gets
// the pins of an id only when it has none; an id that has them is never encoded again, only its
// file is checked, and a run that would change one stops. A changed file needs a new id.
//
//   node scripts/build-sound-library.mjs            # download, prepare what has no pin, check
//   node scripts/build-sound-library.mjs --check    # the committed files against their pins, no network
//
// Options: --cache <dir> (downloads; SSW_SOUND_LIBRARY_CACHE, default .cache/sound-library),
// --release-dir <dir> (default dist/sound-library-release), --7zz <path> (SEVEN_ZIP).
//
// Archives are opened only after their own SHA-256 matched. The extractor is 7-Zip's console
// binary (7zz) when one is given or on the PATH, else the system's libarchive through Python's
// ctypes (scripts/sound-library/libarchive.py); SOUNDS.md records which one ran, its version and
// the SHA-256 of its file. Each archive is listed first, and one with an absolute member path, a
// `..` part or a link is refused; then only the named members are extracted, by exact path, each
// into a fresh temporary folder, and each member's bytes and SHA-256 are checked.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CATALOGUE_FILE = path.join(root, 'src', 'shared', 'audio', 'soundLibrary.ts')
export const BUNDLED_DIR = path.join(root, 'resources', 'sound-library')
export const NOTICE_FILE = path.join(root, 'resources', 'notices', '37-sound-library.txt')
export const EVIDENCE_DIR = path.join(root, 'scripts', 'sound-library', 'evidence')
const LIBARCHIVE_HELPER = path.join(root, 'scripts', 'sound-library', 'libarchive.py')

const RATE = 48000
const PAD = 12000
const CROSSFADE = RATE
/** Largest upstream file read (the biggest is 7.8 MB). */
const MAX_UPSTREAM = 16 * 1024 * 1024

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function loadCatalogue() {
  return import(pathToFileURL(CATALOGUE_FILE).href)
}

/* ---------- the PREPARED block of the catalogue ---------- */

const BLOCK = /\/\* prepared:begin \*\/([\s\S]*?)\/\* prepared:end \*\//

/** The pins written in the catalogue's source (by id). */
export function readPreparedBlock(source) {
  const m = BLOCK.exec(source)
  if (!m) throw new Error('soundLibrary.ts has no prepared:begin … prepared:end block')
  return JSON.parse(m[1])
}

/**
 * The catalogue's source with `next` pins written. Every pin already there must be in `next`
 * unchanged (pinned once): a changed or dropped one throws.
 */
export function writePreparedBlock(source, next) {
  const before = readPreparedBlock(source)
  for (const [id, pin] of Object.entries(before)) {
    if (JSON.stringify(next[id]) !== JSON.stringify(pin)) throw new Error(`${id} is pinned already and would change: an id never gets a new file (give the new file a new id)`)
  }
  const ids = Object.keys(next).sort()
  const body = ids.length ? `{\n${ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(next[id])}`).join(',\n')}\n}` : '{}'
  return source.replace(BLOCK, `/* prepared:begin */ ${body} /* prepared:end */`)
}

/* ---------- downloads ---------- */

/** Bytes of `url` (https only, redirects followed only to https), at most `max`. */
async function download(url, max) {
  let at = new URL(url)
  for (let hop = 0; hop < 6; hop++) {
    if (at.protocol !== 'https:' || at.username || at.password) throw new Error(`refusing ${at.href}: only plain https`)
    const res = await fetch(at, { redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) throw new Error(`${at.href}: a redirect without a location`)
      at = new URL(next, at)
      continue
    }
    if (!res.ok) throw new Error(`${at.href}: HTTP ${res.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > max) throw new Error(`${url}: more than the pinned ${max} bytes`)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  throw new Error(`${url}: too many redirects`)
}

/** The pinned upstream file, from the cache or downloaded (and kept) after its check. */
export async function upstreamFile(pin, cacheDir, fetchBytes = download) {
  const name = `${pin.sha256.slice(0, 16)}-${path.posix.basename(new URL(pin.url).pathname)}`
  const file = path.join(cacheDir, name)
  if (existsSync(file)) {
    const bytes = readFileSync(file)
    if (bytes.length === pin.bytes && sha256(bytes) === pin.sha256) return file
    rmSync(file)
  }
  const bytes = await fetchBytes(pin.url, Math.min(pin.bytes, MAX_UPSTREAM))
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error(`${pin.url} is not the pinned file (${bytes.length} bytes, SHA-256 ${sha256(bytes)})`)
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(`${file}.part`, bytes)
  renameSync(`${file}.part`, file)
  return file
}

/* ---------- archives ---------- */

/**
 * Why an archive listing is refused, or null: a member with an absolute path (also a drive or a
 * UNC path), a `..` part, or a link (symbolic or hard). `entries`: { path, type: 'file' | 'dir' |
 * 'link' }. The listing must also hold every wanted member as a file.
 */
export function listingProblem(entries, wanted = []) {
  for (const e of entries) {
    const p = String(e.path)
    if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return `absolute member path ${p}`
    if (p.split(/[\\/]/).includes('..')) return `member path with a .. part: ${p}`
    if (e.type === 'link') return `link member ${p}`
    if (e.type !== 'file' && e.type !== 'dir') return `member of an unknown kind: ${p}`
  }
  for (const w of wanted) if (!entries.some((e) => e.type === 'file' && e.path === w)) return `no member ${w}`
  return null
}

/** The entries of `7zz l -slt` output: { path, type }. */
export function parse7zzListing(text) {
  const out = []
  const blocks = text
    .split(/\r?\n----------\r?\n/)
    .slice(1)
    .join('\n')
    .split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const fields = {}
    for (const line of block.split(/\r?\n/)) {
      const m = /^([^=]+?) = (.*)$/.exec(line)
      if (m) fields[m[1]] = m[2]
    }
    if (fields.Path === undefined) continue
    const attributes = fields.Attributes ?? ''
    const mode = /\s([-dlcbps])[-rwxsStT]{9}/.exec(` ${attributes}`)?.[1]
    const link = !!fields['Symbolic Link'] || !!fields['Hard Link'] || mode === 'l' || /L/.test(attributes.split(' ')[0] ?? '')
    const dir = fields.Folder === '+' || mode === 'd' || (attributes.split(' ')[0] ?? '').includes('D')
    out.push({
      path: fields.Path,
      type: link ? 'link' : dir ? 'dir' : mode && mode !== '-' ? 'other' : 'file'
    })
  }
  return out
}

function which(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, name)
    if (dir && existsSync(file)) return file
  }
  return null
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 1024 * 1024 * 1024, ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')}… failed: ${String(r.stderr).slice(-2000)}`)
  return r
}

/** The extractor this run uses: 7-Zip's 7zz when there is one, else libarchive through Python. */
export function extractor(opt7zz) {
  const seven = opt7zz || process.env.SEVEN_ZIP || which('7zz')
  if (seven) {
    const version =
      String(run(seven, ['i']).stdout)
        .split(/\r?\n/)
        .find((l) => /7-Zip/.test(l))
        ?.trim() ?? '7-Zip'
    return {
      name: '7-Zip (7zz)',
      version,
      file: seven,
      sha256: sha256(readFileSync(seven)),
      list: (archive) => parse7zzListing(String(run(seven, ['l', '-slt', '--', archive]).stdout)),
      extract: (archive, member, dir) => {
        run(seven, ['x', '-y', `-o${dir}`, '--', archive, member])
        return path.join(dir, ...member.split('/'))
      }
    }
  }
  const python = which('python3')
  if (!python) throw new Error('No extractor: install 7-Zip (7zz) and pass --7zz <path>, or have python3 with the system libarchive')
  const info = JSON.parse(String(run(python, ['-I', LIBARCHIVE_HELPER, 'version']).stdout))
  return {
    name: 'libarchive (through Python ctypes)',
    version: info.version,
    file: info.library,
    sha256: sha256(readFileSync(info.library)),
    list: (archive) => JSON.parse(String(run(python, ['-I', LIBARCHIVE_HELPER, 'list', archive]).stdout)),
    extract: (archive, member, dir) => {
      const out = path.join(dir, 'member')
      run(python, ['-I', LIBARCHIVE_HELPER, 'extract', archive, member, out])
      return out
    }
  }
}

/** The members of an archive (pinned, checked first), each checked against its pin: id → file. */
export function extractMembers(archive, members, tool, workDir) {
  const entries = tool.list(archive)
  const problem = listingProblem(
    entries,
    members.map((m) => m.path)
  )
  if (problem) throw new Error(`${path.basename(archive)} is refused: ${problem}`)
  const out = new Map()
  for (const m of members) {
    const dir = mkdtempSync(path.join(workDir, 'member-'))
    const file = tool.extract(archive, m.path, dir)
    const bytes = readFileSync(file)
    if (bytes.length !== m.bytes || sha256(bytes) !== m.sha256) throw new Error(`${path.basename(archive)} › ${m.path} is not the pinned member (${bytes.length} bytes, SHA-256 ${sha256(bytes)})`)
    // Nothing but the named member was written.
    const written = readdirSync(dir, { recursive: true }).filter((f) => statSync(path.join(dir, f)).isFile())
    if (written.length !== 1) throw new Error(`${path.basename(archive)}: extracting ${m.path} wrote ${written.length} files`)
    out.set(m.path, file)
  }
  return out
}

/* ---------- audio ---------- */

function ffmpegPath() {
  const p = require('ffmpeg-static')
  if (!p || !existsSync(p)) throw new Error('ffmpeg-static has no ffmpeg binary here')
  return p
}

function decode(ff, file, channels) {
  const out = run(ff, ['-nostdin', '-v', 'error', '-i', file, '-ac', String(channels), '-ar', String(RATE), '-f', 'f32le', '-']).stdout
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength))
}

function writeF32(file, samples) {
  writeFileSync(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
}

/** Integrated loudness and true peak (EBU R128) of float samples. */
function loudness(ff, samples, channels, tmp) {
  const file = path.join(tmp, `measure-${process.pid}.f32`)
  writeF32(file, samples)
  const err = String(run(ff, ['-nostdin', '-hide_banner', '-nostats', '-f', 'f32le', '-ar', String(RATE), '-ac', String(channels), '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr)
  rmSync(file)
  const summary = err.split('Summary:').pop()
  return {
    integrated: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)[1]),
    truePeak: Number(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)/.exec(summary)[1])
  }
}

/** The loudest momentary loudness (400 ms) and the true peak of a mono sound (with 0.5 s of silence after it). */
function momentary(ff, samples, tmp) {
  const padded = new Float32Array(samples.length + 24000)
  padded.set(samples)
  const file = path.join(tmp, `moment-${process.pid}.f32`)
  writeF32(file, padded)
  const err = String(
    run(ff, [
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-f',
      'f32le',
      '-ar',
      String(RATE),
      '-ac',
      '1',
      '-i',
      file,
      '-af',
      'ebur128=metadata=1:peak=true,ametadata=print:key=lavfi.r128.M',
      '-f',
      'null',
      '-'
    ]).stderr
  )
  rmSync(file)
  const values = [...err.matchAll(/lavfi\.r128\.M=(-?[\d.]+)/g)].map((m) => Number(m[1]))
  const summary = err.split('Summary:').pop()
  return {
    momentary: Math.max(...values),
    truePeak: Number(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)/.exec(summary)[1])
  }
}

const OPUS_COMMON = ['-application', 'audio', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact']

function encodeOpus(ff, samples, channels, out, tmp, rate) {
  const file = path.join(tmp, `encode-${process.pid}.f32`)
  writeF32(file, samples)
  const vbr = channels === 2 ? ['-vbr', 'constrained'] : ['-vbr', 'on']
  run(ff, ['-nostdin', '-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', String(channels), '-i', file, '-c:a', 'libopus', '-b:a', rate, ...vbr, ...OPUS_COMMON, out])
  rmSync(file)
}

const gain = (db) => 10 ** (db / 20)

/** Interleaved stereo frames [from, to) of `x`. */
const frames = (x, from, to) => x.subarray(from * 2, to * 2)

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The step across a loop's seam and the 99.9th percentile step inside its body (channel 0 of decoded stereo `d`). */
export function seamCheck(d, S, E) {
  const at = (i) => (i < E ? d[i * 2] : d[(S + (i - E)) * 2])
  let seam = 0
  for (let i = E - 3; i < E + 2; i++) seam = Math.max(seam, Math.abs(at(i + 1) - at(i)))
  const steps = new Float32Array(E - S - 1)
  for (let i = S; i < E - 1; i++) steps[i - S] = Math.abs(d[(i + 1) * 2] - d[i * 2])
  steps.sort()
  const body = steps[Math.min(steps.length - 1, Math.floor(0.999 * (steps.length - 1)))]
  return { seam, body }
}

/** Prepares one bed (see the top of this file) into `out`. Returns its pins and measurements. */
export function prepareBed(ff, bed, mp3, out, tmp) {
  const S = bed.loop.start
  const E = bed.loop.end
  const y = decode(ff, mp3, 2)
  if (S < CROSSFADE || E * 2 > y.length || S >= E) throw new Error(`${bed.id}: the loop ${S}..${E} does not fit the decoded file (${y.length / 2} samples)`)
  const body = frames(y, 0, E).slice()
  for (let i = 0; i < CROSSFADE; i++) {
    const th = ((Math.PI / 2) * i) / CROSSFADE
    for (let c = 0; c < 2; c++) {
      const k = (E - CROSSFADE + i) * 2 + c
      body[k] = y[k] * Math.cos(th) + y[(S - CROSSFADE + i) * 2 + c] * Math.sin(th)
    }
  }
  const looped = concat([body, frames(body, S, E)])
  const m = loudness(ff, looped, 2, tmp)
  let file
  if (bed.limiter) {
    // To −16 LUFS, then a limiter on the bed as it loops (one pass, one more loop, the pad), so
    // the limiter's state at the seam is the state it has when the loop repeats.
    const g = gain(-16 - m.integrated)
    const scaled = looped.map((v) => v * g)
    const x = concat([scaled, frames(scaled, S, S + PAD)])
    let limit = -2.0
    for (let attempt = 0; ; attempt++) {
      const inFile = path.join(tmp, `limit-in-${process.pid}.f32`)
      const outFile = path.join(tmp, `limit-out-${process.pid}.f32`)
      writeF32(inFile, x)
      run(ff, [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'f32le',
        '-ar',
        String(RATE),
        '-ac',
        '2',
        '-i',
        inFile,
        '-af',
        `aresample=192000,alimiter=limit=${gain(limit).toFixed(6)}:attack=5:release=50:level=0,aresample=${RATE}`,
        '-f',
        'f32le',
        outFile
      ])
      const raw = readFileSync(outFile)
      rmSync(inFile)
      rmSync(outFile)
      const yl = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      if (yl.length < x.length) throw new Error(`${bed.id}: the limiter shortened the bed`)
      const second = E + (E - S)
      file = concat([frames(yl, 0, S), frames(yl, E, second), frames(yl, second, second + PAD)])
      const tp = loudness(ff, concat([file.subarray(0, E * 2), frames(file, S, E)]), 2, tmp).truePeak
      if (tp <= -1.5) break
      if (attempt >= 8) throw new Error(`${bed.id}: the limiter could not hold the true peak at −1.5 dBTP`)
      limit -= 0.25
    }
  } else {
    const g = gain(Math.min(-16 - m.integrated, -1.5 - m.truePeak))
    file = concat([body, frames(body, S, S + PAD)]).map((v) => v * g)
  }
  encodeOpus(ff, file, 2, out, tmp, '64k')
  const d = decode(ff, out, 2)
  if (d.length !== (E + PAD) * 2) throw new Error(`${bed.id}: the encoded file decodes to ${d.length / 2} samples, not ${E + PAD}`)
  const check = seamCheck(d, S, E)
  if (!(check.seam < check.body)) throw new Error(`${bed.id}: the seam step ${check.seam.toFixed(4)} is not below the body's 99.9th percentile step ${check.body.toFixed(4)}`)
  const heard = loudness(ff, concat([d.subarray(0, E * 2), frames(d, S, E)]), 2, tmp)
  const bytes = readFileSync(out)
  return {
    pin: {
      file: path.basename(out),
      bytes: bytes.length,
      sha256: sha256(bytes),
      samples: E + PAD,
      loopStart: S,
      loopEnd: E,
      pad: PAD
    },
    measured: {
      lufs: heard.integrated,
      truePeak: heard.truePeak,
      seamStep: check.seam,
      bodyStep: check.body
    }
  }
}

/** Prepares one effect (see the top of this file) into `out`. */
export function prepareEffect(ff, effect, source, out, tmp) {
  let x = decode(ff, source, 1)
  const threshold = gain(-60)
  let first = -1
  let last = -1
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > threshold) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) throw new Error(`${effect.id}: the sound is silent`)
  x = x.slice(Math.max(0, first - 48), last + 1)
  const fadeIn = 96
  const fadeOut = 240
  for (let i = 0; i < fadeIn; i++) x[i] *= i / (fadeIn - 1)
  for (let i = 0; i < fadeOut; i++) x[x.length - fadeOut + i] *= 1 - i / (fadeOut - 1)
  const m = momentary(ff, x, tmp)
  let g = Math.min(-20 - m.momentary, -1 - m.truePeak)
  // Where it is loudest: the centre of the loudest 10 ms.
  let peak = 0
  let best = -1
  let sum = 0
  const sq = (i) => (i >= 0 && i < x.length ? x[i] * x[i] : 0)
  for (let i = -240; i < 240; i++) sum += sq(i)
  for (let i = 0; i < x.length; i++) {
    if (sum > best) {
      best = sum
      peak = i
    }
    sum += sq(i + 240) - sq(i - 240)
  }
  let heard = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const y = new Float32Array(x.length + 960)
    for (let i = 0; i < x.length; i++) y[i] = x[i] * gain(g)
    encodeOpus(ff, y, 1, out, tmp, '48k')
    heard = momentary(ff, decode(ff, out, 1), tmp)
    if (heard.truePeak <= -1.0) break
    g -= heard.truePeak + 1.0 + 0.1
  }
  if (heard.truePeak > -1.0) throw new Error(`${effect.id}: the true peak stays above −1 dBTP`)
  const bytes = readFileSync(out)
  const round3 = (v) => Math.round(v * 1000) / 1000
  return {
    pin: {
      file: path.basename(out),
      bytes: bytes.length,
      sha256: sha256(bytes),
      seconds: round3(x.length / RATE),
      peakAt: round3(peak / RATE)
    },
    measured: { momentary: heard.momentary, truePeak: heard.truePeak, gain: g }
  }
}

/* ---------- SOUNDS.md and the notices ---------- */

const bedFile = (id) => `bed-${id}.ogg`
const effectFile = (id) => `sfx-${id}.ogg`
const mb = (n) => n.toLocaleString('en-US')

export function soundsMd(cat, pins, tools) {
  const lines = []
  const beds = cat.BED_SOURCES
  const effects = cat.EFFECT_SOURCES
  const bundledBytes = [...beds.filter((b) => b.bundled), ...effects].reduce((n, x) => n + (pins[x.id]?.bytes ?? 0), 0)
  lines.push('# Sound library', '')
  lines.push(
    'The music beds and sound effects of the library (docs/design/editing-polish.md §10), made by `scripts/build-sound-library.mjs` from the pinned upstream files below. Every file is CC0 1.0 (public domain): no credit is required, and this list is kept for provenance. The four beds and sixteen effects in this folder ship in the installer; the eight other beds download on request from the release the catalogue names (`SOUND_LIBRARY_RELEASE`), checked against the same pins.',
    ''
  )
  lines.push(`Bundled: ${mb(bundledBytes)} bytes.`, '')
  lines.push('## Music beds', '')
  lines.push(
    '48 kHz stereo Ogg Opus 64 kb/s, −16 LUFS over one pass plus one loop, true peak at most −1.5 dBTP. One pass is loop end / 48000 s; the loop repeats from loop start to loop end; the last 12,000 samples are a pad that is never played.',
    ''
  )
  lines.push('| File | Title — artist (album) | Mood | Licence | Where | Loop start | Loop end | Bytes | SHA-256 |', '|---|---|---|---|---|---|---|---|---|')
  for (const b of beds) {
    const p = pins[b.id]
    lines.push(
      `| ${p?.file ?? bedFile(b.id)} | ${b.title} — ${b.artist} (${b.album}) | ${b.mood} | CC0 1.0 | ${b.bundled ? 'installer' : 'download'} | ${p ? mb(p.loopStart) : '—'} | ${p ? mb(p.loopEnd) : '—'} | ${p ? mb(p.bytes) : '—'} | ${p?.sha256 ?? '—'} |`
    )
  }
  lines.push('', 'Upstream files (each track page says "<title> by <artist> is licensed under a CC0 1.0 Universal License"):', '')
  lines.push('| Id | Page | Upstream file | Bytes | SHA-256 |', '|---|---|---|---|---|')
  for (const b of beds) lines.push(`| ${b.id} | ${b.page} | ${b.upstream.url} | ${mb(b.upstream.bytes)} | ${b.upstream.sha256} |`)
  lines.push('', '## Sound effects', '')
  lines.push('48 kHz mono Ogg Opus 48 kb/s, the loudest 400 ms at −20 LUFS unless the true peak would pass −1 dBTP. Peak: the time from the start to the loudest moment.', '')
  lines.push('| File | Title | Source (CC0) | Page | Archive › member | Member bytes | Member SHA-256 | Seconds | Peak | Bytes | SHA-256 |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (const e of effects) {
    const p = pins[e.id]
    const member = e.member ? `${e.member.archive} › ${e.member.path}` : `${e.upstream} (the file itself)`
    lines.push(
      `| ${p?.file ?? effectFile(e.id)} | ${e.title} | ${e.source} | ${e.page} | ${member} | ${e.member ? mb(e.member.bytes) : '—'} | ${e.member?.sha256 ?? '—'} | ${p?.seconds ?? '—'} | ${p?.peakAt ?? '—'} | ${p ? mb(p.bytes) : '—'} | ${p?.sha256 ?? '—'} |`
    )
  }
  lines.push('', 'Upstream files:', '')
  lines.push('| File | URL | Bytes | SHA-256 | Page and licence |', '|---|---|---|---|---|')
  for (const [name, u] of Object.entries(cat.SFX_UPSTREAM)) lines.push(`| ${name} | ${u.url} | ${mb(u.bytes)} | ${u.sha256} | ${u.page}: ${u.terms} |`)
  lines.push('', "## The artists' own pages", '')
  lines.push(
    "A bed is allowed only when its own page says CC0 1.0, its tags say nothing else, and the artist's own site or biography agrees with CC0 (§10.1). The page text is kept in `scripts/sound-library/evidence/` (not shipped), pinned by its SHA-256.",
    ''
  )
  lines.push('| Artist | Page | Fetched | What it says | Evidence file | SHA-256 |', '|---|---|---|---|---|---|')
  for (const a of cat.ARTISTS) lines.push(`| ${a.name} | ${a.url} | ${a.fetched} | "${a.quote}" | ${a.evidence} | ${a.sha256} |`)
  lines.push('', 'Rejected:', '')
  for (const a of cat.REJECTED_EVIDENCE) lines.push(`- ${a.name}: ${a.url} (${a.fetched}): "${a.quote}"; evidence ${a.evidence}, SHA-256 ${a.sha256}.`)
  lines.push('', '## Tools', '')
  for (const t of tools) lines.push(`- ${t}`)
  lines.push('')
  return lines.join('\n')
}

export function noticeText(cat, pins) {
  const lines = []
  lines.push('Music beds and sound effects (the sound library)')
  lines.push('All of them are dedicated to the public domain under CC0 1.0 Universal')
  lines.push('(https://creativecommons.org/publicdomain/zero/1.0/): no credit is required. They are listed')
  lines.push('for provenance, each with its author and source page (resources/sound-library/SOUNDS.md has')
  lines.push("the files' sizes and SHA-256).", '')
  lines.push('Music beds:')
  for (const b of cat.BED_SOURCES) lines.push(`  ${pins[b.id]?.file ?? bedFile(b.id)}: "${b.title}" by ${b.artist} (${b.album}), CC0 1.0, ${b.page}`)
  lines.push('', 'Sound effects:')
  for (const e of cat.EFFECT_SOURCES) lines.push(`  ${pins[e.id]?.file ?? effectFile(e.id)}: "${e.title}", ${e.source}, CC0 1.0, ${e.page}`)
  lines.push('')
  return lines.join('\n')
}

/* ---------- check ---------- */

/** What is wrong with the committed library (empty: nothing). No network. */
export function checkLibrary(cat, pins, dirs = { bundled: BUNDLED_DIR, notice: NOTICE_FILE, evidence: EVIDENCE_DIR }) {
  const out = []
  const bundledFiles = new Set()
  const ids = new Set()
  for (const x of [...cat.BED_SOURCES, ...cat.EFFECT_SOURCES]) {
    if (ids.has(x.id)) out.push(`${x.id} is listed twice`)
    ids.add(x.id)
    const pin = pins[x.id]
    if (!pin) {
      out.push(`${x.id} has no prepared pin (run the build)`)
      continue
    }
    const bundled = !('bundled' in x) || x.bundled
    const file = path.join(dirs.bundled, pin.file)
    if (bundled) {
      bundledFiles.add(pin.file)
      if (!existsSync(file)) out.push(`${pin.file} is missing from resources/sound-library`)
      else {
        const bytes = readFileSync(file)
        if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) out.push(`${pin.file} is not its pinned file (${bytes.length} bytes, SHA-256 ${sha256(bytes)})`)
      }
    } else if (existsSync(file)) out.push(`${pin.file} downloads on request and must not be in resources/sound-library`)
  }
  for (const id of Object.keys(pins)) if (!ids.has(id)) out.push(`the pin ${id} is not in the catalogue`)
  if (existsSync(dirs.bundled)) {
    for (const f of readdirSync(dirs.bundled)) if (f !== 'SOUNDS.md' && !bundledFiles.has(f)) out.push(`${f} in resources/sound-library is not a bundled file of the catalogue`)
    const md = existsSync(path.join(dirs.bundled, 'SOUNDS.md')) ? readFileSync(path.join(dirs.bundled, 'SOUNDS.md'), 'utf8') : ''
    if (!md) out.push('resources/sound-library/SOUNDS.md is missing')
    for (const id of ids) {
      const pin = pins[id]
      if (pin && md && !(md.includes(pin.file) && md.includes(pin.sha256))) out.push(`SOUNDS.md does not list ${pin.file} with its SHA-256`)
    }
  }
  const notice = existsSync(dirs.notice) ? readFileSync(dirs.notice, 'utf8') : ''
  if (!notice) out.push('resources/notices/37-sound-library.txt is missing')
  else for (const id of ids) if (pins[id] && !notice.includes(pins[id].file)) out.push(`37-sound-library.txt does not list ${pins[id].file}`)
  for (const a of [...cat.ARTISTS, ...cat.REJECTED_EVIDENCE]) {
    const file = path.join(dirs.evidence, a.evidence)
    if (!existsSync(file)) out.push(`the evidence ${a.evidence} is missing`)
    else {
      const bytes = readFileSync(file)
      if (sha256(bytes) !== a.sha256) out.push(`the evidence ${a.evidence} is not its pinned file`)
      else if (!bytes.toString('utf8').replace(/\s+/g, ' ').includes(a.quote)) out.push(`the evidence ${a.evidence} does not hold its quote`)
    }
  }
  return out
}

/* ---------- build ---------- */

function argValue(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function build(args) {
  const cat = await loadCatalogue()
  const source = readFileSync(CATALOGUE_FILE, 'utf8')
  const pins = readPreparedBlock(source)
  const cacheDir = path.resolve(root, argValue(args, '--cache') ?? process.env.SSW_SOUND_LIBRARY_CACHE ?? path.join('.cache', 'sound-library'))
  const releaseDir = path.resolve(root, argValue(args, '--release-dir') ?? path.join('dist', 'sound-library-release'))
  const ff = ffmpegPath()
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sound-library-'))
  const next = { ...pins }
  const notes = []
  let tool = null
  try {
    mkdirSync(BUNDLED_DIR, { recursive: true })
    mkdirSync(releaseDir, { recursive: true })
    for (const bed of cat.BED_SOURCES) {
      const dir = bed.bundled ? BUNDLED_DIR : releaseDir
      const pin = pins[bed.id]
      if (pin) {
        const file = path.join(dir, pin.file)
        if (bed.bundled || existsSync(file)) {
          const bytes = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
          if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256)
            throw new Error(`${bed.id} is pinned and its file ${file} is not the pinned one: it is never encoded again (a new file needs a new id)`)
        } else notes.push(`${bed.id}: pinned; its file is not in ${releaseDir} (the release keeps it)`)
        continue
      }
      const mp3 = await upstreamFile(bed.upstream, cacheDir)
      const out = path.join(dir, bedFile(bed.id))
      const made = prepareBed(ff, bed, mp3, out, tmp)
      next[bed.id] = made.pin
      notes.push(
        `${bed.id}: ${made.pin.bytes} bytes, ${made.measured.lufs} LUFS, true peak ${made.measured.truePeak} dBTP, seam step ${made.measured.seamStep.toFixed(4)} under ${made.measured.bodyStep.toFixed(4)}`
      )
    }
    const archives = new Map()
    for (const effect of cat.EFFECT_SOURCES) {
      const pin = pins[effect.id]
      if (pin) {
        const file = path.join(BUNDLED_DIR, pin.file)
        const bytes = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
        if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256)
          throw new Error(`${effect.id} is pinned and its file ${file} is not the pinned one: it is never encoded again (a new file needs a new id)`)
        continue
      }
      const up = cat.SFX_UPSTREAM[effect.upstream]
      if (!up) throw new Error(`${effect.id}: no upstream ${effect.upstream}`)
      const file = await upstreamFile(up, cacheDir)
      let input = file
      if (effect.member) {
        tool ??= extractor(argValue(args, '--7zz'))
        const key = effect.member.archive
        if (!archives.has(key)) {
          const members = cat.EFFECT_SOURCES.filter((e) => e.member?.archive === key && !pins[e.id]).map((e) => e.member)
          archives.set(key, extractMembers(file, members, tool, tmp))
        }
        input = archives.get(key).get(effect.member.path)
      }
      const made = prepareEffect(ff, effect, input, path.join(BUNDLED_DIR, effectFile(effect.id)), tmp)
      next[effect.id] = made.pin
      notes.push(`${effect.id}: ${made.pin.bytes} bytes, ${made.pin.seconds} s, peak at ${made.pin.peakAt} s, momentary max ${made.measured.momentary} LUFS, true peak ${made.measured.truePeak} dBTP`)
    }
    const added = Object.keys(next).filter((id) => !pins[id])
    if (added.length) writeFileSync(CATALOGUE_FILE, writePreparedBlock(source, next))
    const version = String(run(ff, ['-version']).stdout)
      .split('\n')[0]
      .trim()
    const tools = [
      `Encoder: ${version}, the ffmpeg-static binary (node_modules/ffmpeg-static/${path.basename(ff)}), SHA-256 ${sha256(readFileSync(ff))}, with its built-in libopus.`,
      tool ? `Archives: ${tool.name}, ${tool.version} (${tool.file}), SHA-256 ${tool.sha256}.` : 'Archives: none opened in the last run (every effect was pinned already).',
      `Last run: ${new Date().toISOString().slice(0, 10)}, on ${process.platform} ${process.arch}, Node ${process.version}. Prepared in that run: ${added.length ? added.join(', ') : 'nothing (every id was pinned)'}.`
    ]
    const mdFile = path.join(BUNDLED_DIR, 'SOUNDS.md')
    // A run that prepared nothing keeps the record of the run that did.
    if (added.length || !existsSync(mdFile)) writeFileSync(mdFile, soundsMd(cat, next, tools))
    writeFileSync(NOTICE_FILE, noticeText(cat, next))
    for (const n of notes) console.log(n)
    if (added.length) console.log(`Pinned ${added.length} new id(s) in src/shared/audio/soundLibrary.ts.`)
    const downloads = cat.BED_SOURCES.filter((b) => !b.bundled).map((b) => next[b.id]?.file)
    console.log(
      `The beds that download are in ${releaseDir}: ${downloads.join(', ')}. Upload them, unchanged, to the release the catalogue names (by hand); then set SOUND_LIBRARY_SOURCE after the release check (docs/RELEASING.md).`
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function check() {
  const cat = await loadCatalogue()
  const pins = readPreparedBlock(readFileSync(CATALOGUE_FILE, 'utf8'))
  const problems = checkLibrary(cat, pins)
  if (problems.length) {
    for (const p of problems) console.error(p)
    process.exitCode = 1
  } else console.log(`The sound library matches its pins: ${Object.keys(pins).length} files.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const job = args.includes('--check') ? check() : build(args).then(check)
  job.catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
