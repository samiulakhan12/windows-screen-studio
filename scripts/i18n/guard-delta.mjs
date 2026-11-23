#!/usr/bin/env node
// What a part's English guard run adds to the baseline (docs/design/auto-blur.md §12.2). A part runs the
// guard in compare mode, which fails on any addition; this script reads that run's output and passes
// only when everything the baseline has is still there, unchanged:
//   - every screen of the baseline is in the run, the settings-NN captures aligned by their section's
//     heading rather than by number (a new section is an added capture);
//   - every text line, text attribute and accessible name of the baseline is in the run, in order;
//   - every element of the baseline keeps its tag, font, colour, direction and alignment, and every
//     box that moved was pushed by an added element (reported with it);
//   - every capture with no added element passes test 10's screenshot rule (at most 0.1% of pixels
//     differ, none by more than 2 levels).
// It prints the additions, and the captures with additions (baseline and run screenshots side by side)
// for the lead to look at before re-recording at integration.
//
//   node scripts/i18n/guard-delta.mjs [--base tests/e2e/english-guard] [--run <tmp>/flown-english-guard/run-1] [--json]
//
// Exits 1 when the run changed something of the baseline.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/* ---------- screenshots ---------- */

/** RGBA pixels of an 8-bit, non-interlaced PNG (greyscale, RGB, RGBA, grey and alpha); null for any other kind. */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let at = 8
  let width = 0
  let height = 0
  let depth = 0
  let type = 0
  let interlace = 0
  const data = []
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const kind = buf.toString('latin1', at + 4, at + 8)
    const body = buf.subarray(at + 8, at + 8 + len)
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      type = body[9]
      interlace = body[12]
    } else if (kind === 'IDAT') data.push(body)
    else if (kind === 'IEND') break
    at += 12 + len
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type]
  if (depth !== 8 || interlace !== 0 || !channels) return null
  const raw = zlib.inflateSync(Buffer.concat(data))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      if (channels === 1 || channels === 2) {
        out[d] = out[d + 1] = out[d + 2] = line[s]
        out[d + 3] = channels === 2 ? line[s + 1] : 255
      } else {
        out[d] = line[s]
        out[d + 1] = line[s + 1]
        out[d + 2] = line[s + 2]
        out[d + 3] = channels === 4 ? line[s + 3] : 255
      }
    }
    prev = line
  }
  return { width, height, data: out }
}

/** A screenshot's pixels: decoded here, or by ffmpeg for a kind of PNG the decoder does not read. */
function pixels(file) {
  const png = decodePng(fs.readFileSync(file))
  if (png) return png
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()
  const [width, height] = probe.split(',').map(Number)
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 })
  return { width, height, data }
}

/** Test 10's screenshot rule: at most 0.1% of pixels differ, none by more than 2 levels. Null when it holds. */
export function shotRule(runFile, baseFile) {
  const x = pixels(runFile)
  const y = pixels(baseFile)
  if (x.width !== y.width || x.height !== y.height) return `size ${x.width}×${x.height} against ${y.width}×${y.height}`
  let differ = 0
  let worst = 0
  for (let i = 0; i < x.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(x.data[i + c] - y.data[i + c]))
    if (d) {
      differ++
      worst = Math.max(worst, d)
    }
  }
  const total = x.width * x.height
  if (worst > 2) return `${differ} pixels differ, by up to ${worst} levels`
  if (differ > total * 0.001) return `${differ} pixels differ (more than 0.1% of ${total})`
  return null
}

/* ---------- aligning the captures ---------- */

const SETTINGS = /^settings-\d+$/
const headings = (aria, level) => [...String(aria ?? '').matchAll(new RegExp(`heading "((?:[^"\\\\]|\\\\.)*)" \\[level=${level}\\]`, 'g'))].map((m) => m[1])

/**
 * The heading of the settings section a settings-NN capture shows: the section heading (h3) nearest
 * below the dialog's own heading (h2 "Settings"), its words read from the accessibility tree, whose
 * headings come in the same document order as the boxes. Null when the two do not line up.
 */
export function sectionHeading(screen) {
  const h2 = screen.boxes.filter((b) => b.tag === 'h2')
  const h3 = screen.boxes.filter((b) => b.tag === 'h3')
  const names2 = headings(screen.aria, 2)
  const names3 = headings(screen.aria, 3)
  if (h3.length !== names3.length || h2.length !== names2.length) return null
  const title = h2[names2.lastIndexOf('Settings')]
  const top = title ? title.box[1] + title.box[3] : 0
  let best = -1
  for (let i = 0; i < h3.length; i++) if (h3[i].box[1] >= top - 1 && (best < 0 || h3[i].box[1] < h3[best].box[1])) best = i
  return best < 0 ? null : names3[best]
}

/** Pairs of [baseline screen, run screen]; the run's screens with no baseline are added captures. */
export function alignScreens(base, run) {
  const pairs = []
  const used = new Set()
  // A heading can top two captures (the last sections cannot scroll further): the k-th of the baseline's with it is the k-th of the run's.
  const runBySection = new Map()
  for (const s of run.screens) if (SETTINGS.test(s.name)) runBySection.set(sectionHeading(s), [...(runBySection.get(sectionHeading(s)) ?? []), s])
  const seen = new Map()
  for (const b of base.screens) {
    let r = null
    if (SETTINGS.test(b.name)) {
      const heading = sectionHeading(b)
      const k = seen.get(heading) ?? 0
      seen.set(heading, k + 1)
      if (heading !== null) r = runBySection.get(heading)?.[k] ?? null
    }
    r ??= run.screens.find((s) => s.name === b.name && !used.has(s)) ?? null
    if (r) used.add(r)
    pairs.push([b, r])
  }
  return { pairs, added: run.screens.filter((s) => !used.has(s)) }
}

/* ---------- comparing one capture ---------- */

/** Whether `inner` is `outer` with lines added: every line of `inner` in `outer`, in order. Returns the first missing line, or null. */
function missingLine(inner, outer) {
  const a = String(inner ?? '').split('\n')
  const b = String(outer ?? '').split('\n')
  let j = 0
  for (const line of a) {
    while (j < b.length && b[j] !== line) j++
    if (j === b.length) return line
    j++
  }
  return null
}

const STYLE = (x) => JSON.stringify([x.tag, x.font, x.color, x.direction, x.align])
const withoutPath = (o) => {
  const { path: _p, ...rest } = o
  return JSON.stringify(rest)
}

/**
 * One baseline capture against the run's: problems (each fails), the run's added elements, and the
 * moved boxes with the added element that pushed each.
 */
export function compareCapture(b, r) {
  const problems = []
  if (r.title !== b.title) problems.push(`title "${r.title}" against "${b.title}"`)
  const text = missingLine(b.text, r.text)
  if (text !== null) problems.push(`text changed or removed: "${text}"`)
  const aria = missingLine(b.aria, r.aria)
  if (aria !== null) problems.push(`accessible name or role changed or removed: "${aria.trim()}"`)
  if (JSON.stringify(r.main) !== JSON.stringify(b.main)) problems.push('main-process strings differ')
  // Text attributes: each of the baseline's, without its path (an added element renumbers paths), in order.
  const attrs = missingLine((b.attrs ?? []).map(withoutPath).join('\n'), (r.attrs ?? []).map(withoutPath).join('\n'))
  if ((b.attrs ?? []).length && attrs !== null) problems.push(`text attribute changed or removed: ${attrs}`)
  // Elements: the baseline's, in order, each matched with the next run element of the same tag and style.
  const matched = new Array(r.boxes.length).fill(false)
  const pairs = []
  let j = 0
  for (const x of b.boxes) {
    let k = j
    while (k < r.boxes.length && STYLE(r.boxes[k]) !== STYLE(x)) k++
    if (k === r.boxes.length) {
      const same = r.boxes.find((y) => y.path === x.path && y.tag === x.tag)
      problems.push(same ? `restyled: ${x.path} ${STYLE(same)} against ${STYLE(x)}` : `removed: ${x.path} ${STYLE(x)}`)
      continue
    }
    matched[k] = true
    pairs.push([x, r.boxes[k], k])
    j = k + 1
  }
  const added = r.boxes.map((y, k) => ({ ...y, index: k })).filter((y) => !matched[y.index])
  const pushed = []
  for (const [x, y, k] of pairs) {
    if (!x.box.some((v, i) => Math.abs(v - y.box[i]) > 0.5)) continue
    // Pushed: an added element before it in the document, or above or beside it on the screen.
    const by = [...added].reverse().find((a) => a.index < k || a.box[1] <= y.box[1] || a.box[0] <= y.box[0])
    if (by) pushed.push({ element: x.path, from: x.box, to: y.box, by: by.path })
    else problems.push(`moved with no added element: ${x.path} ${JSON.stringify(y.box)} against ${JSON.stringify(x.box)}`)
  }
  const grown = text === null && String(r.text) !== String(b.text)
  return { problems, added, pushed, additions: added.length > 0 || grown || String(r.aria) !== String(b.aria) }
}

/* ---------- the whole run ---------- */

/**
 * The run against the baseline. `shots`: { base, run } folders of the screenshots (the screenshot
 * rule is skipped without them). Returns { ok, problems, captures, added }.
 */
export function guardDelta(base, run, shots = null) {
  const problems = []
  const captures = []
  const { pairs, added } = alignScreens(base, run)
  for (const [b, r] of pairs) {
    if (!r) {
      problems.push(`${b.name}: missing from the run`)
      continue
    }
    const c = compareCapture(b, r)
    for (const p of c.problems) problems.push(`${b.name}${r.name !== b.name ? ` (run: ${r.name})` : ''}: ${p}`)
    if (c.additions) {
      captures.push({ base: b.name, run: r.name, added: c.added.map((a) => a.path), pushed: c.pushed, shots: shots ? [path.join(shots.base, `${b.name}.png`), path.join(shots.run, `${r.name}.png`)] : [] })
    } else if (shots) {
      const why = shotRule(path.join(shots.run, `${r.name}.png`), path.join(shots.base, `${b.name}.png`))
      if (why) problems.push(`${b.name}: screenshot: ${why}`)
    }
  }
  return { ok: problems.length === 0, problems, captures, added: added.map((s) => s.name) }
}

function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1] : fallback
  }
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const baseDir = arg('--base', path.join(root, 'tests', 'e2e', 'english-guard'))
  const runDir = arg('--run', path.join(os.tmpdir(), 'flown-english-guard', 'run-1'))
  const base = JSON.parse(fs.readFileSync(path.join(baseDir, 'baseline.json'), 'utf8'))
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'tour.json'), 'utf8'))
  const result = guardDelta(base, run, { base: path.join(baseDir, 'shots'), run: runDir })
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 1))
  else {
    for (const c of result.captures) {
      console.log(`${c.base}${c.run !== c.base ? ` (run: ${c.run})` : ''}: ${c.added.length} added element(s)`)
      for (const a of c.added) console.log(`  + ${a}`)
      for (const p of c.pushed) console.log(`  ~ ${p.element} pushed by ${p.by}`)
      if (c.shots.length) console.log(`  look at: ${c.shots.join('  ')}`)
    }
    for (const a of result.added) console.log(`added capture: ${a}`)
    for (const p of result.problems) console.log(`CHANGED ${p}`)
    console.log(result.ok ? 'guard-delta: only additions.' : `guard-delta: ${result.problems.length} change(s) to the baseline.`)
  }
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
