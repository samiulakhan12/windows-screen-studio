/**
 * Fixtures and checks for tests/e2e/auto-blur.e2e.cjs (docs/design/auto-blur.md §17.3): the host text
 * reader helper and the pinned models in a fixed userData, fixture recordings made from the evaluation
 * PNGs (and a second recording of each with other secrets under the same places), the drawn cover boxes
 * of a project at any frame (§4.2), and the comparison of two outputs.
 *
 * The recordings are lossless H.264 in 4:4:4 (`-c:v libx264 -qp 0 -pix_fmt yuv444p`). §17.3 names
 * libx264rgb; Chromium decodes that stream but shows its GBR planes as YUV (a pink page with green
 * text), so the app would preview and export other colours than the helper reads. 4:4:4 at qp 0 keeps
 * every change inside the pixels it was made in, which is what the two-recording comparison needs.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const h = require('./helpers.cjs')

const ROOT = h.APP_DIR
const EVAL = path.join(ROOT, 'tests', 'fixtures', 'privacy-eval')
/** Generated recordings, kept between runs (keyed by what made them). */
const CACHE = path.join(os.tmpdir(), 'ssw-e2e-auto-blur')

/* ---------- the reader ---------- */

/** The host helper: SSW_OCR_HELPER, else what `build-native --ocr-host` made. */
function helperBinary() {
  const candidates = [process.env.SSW_OCR_HELPER, path.join(ROOT, 'native', 'bin', 'ssw-ocr'), path.join(ROOT, 'native', 'ocr', 'target', 'host', 'release', 'ssw-ocr')].filter(Boolean)
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new Error('auto-blur e2e: no host text reader helper; run node scripts/build-native.mjs --ocr-host')
  return found
}

/** The pinned reader files, read from src/shared/privacy/readerCatalog.ts. */
function readerFiles() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'privacy', 'readerCatalog.ts'), 'utf8')
  const out = []
  for (const m of src.matchAll(/file: '([^']+)',\s*bytes: (\d+),\s*sha256: '([0-9a-f]{64})'/g)) out.push({ file: m[1], bytes: Number(m[2]), sha256: m[3] })
  if (out.length !== 5) throw new Error(`auto-blur e2e: expected 5 pinned reader files, read ${out.length}`)
  return out
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = (file) => sha256(fs.readFileSync(file))

let modelsChecked = null
/** SSW_OCR_MODELS: a folder holding the pinned files as <repository>/<file>, each checked by size and SHA-256 once. */
function modelsDir() {
  const dir = process.env.SSW_OCR_MODELS
  if (!dir) throw new Error('auto-blur e2e: set SSW_OCR_MODELS to the folder holding the pinned PP-OCRv6 files as <repository>/<file>')
  if (modelsChecked !== dir) {
    for (const f of readerFiles()) {
      const p = path.join(dir, ...f.file.split('/'))
      h.assert(fs.existsSync(p) && fs.statSync(p).size === f.bytes, `${f.file} is in SSW_OCR_MODELS with ${f.bytes} bytes`)
      h.assert(sha256File(p) === f.sha256, `${f.file} has its pinned SHA-256`)
    }
    modelsChecked = dir
  }
  return dir
}

/** The app's userData for a test HOME (XDG_CONFIG_HOME is set to HOME/.config by appEnv). */
const userDataOf = (home) => path.join(home, '.config', 'Flown')

/** Puts the reader's files where a download leaves them: userData/reader-models/<repository>/<file>. */
function installReader(home) {
  const src = modelsDir()
  const dest = path.join(userDataOf(home), 'reader-models')
  for (const f of readerFiles()) {
    const to = path.join(dest, ...f.file.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try {
      fs.linkSync(path.join(src, ...f.file.split('/')), to)
    } catch {
      fs.copyFileSync(path.join(src, ...f.file.split('/')), to)
    }
  }
  return dest
}

/** The environment every launch of this file gets: a fixed userData under HOME and the host helper. */
function appEnv(home, extra = {}) {
  return { XDG_CONFIG_HOME: path.join(home, '.config'), SSW_OCR_HELPER: helperBinary(), ...extra }
}

/* ---------- pictures ---------- */

/** A PNG's pixels as RGB (3 bytes a pixel). */
function decodePng(file) {
  const head = Buffer.alloc(24)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, head, 0, 24, 0)
  fs.closeSync(fd)
  const width = head.readUInt32BE(16)
  const height = head.readUInt32BE(20)
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: width * height * 3 + 1024 })
  h.assert(data.length === width * height * 3, `${path.basename(file)} decodes to ${width}x${height}`)
  return { width, height, data }
}

/** RGB pixels as a PNG file. */
function writePng(file, img) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${img.width}x${img.height}`, '-i', '-', '-frames:v', '1', file], { input: img.data })
}

const at = (img, x, y) => (y * img.width + x) * 3

/**
 * The ink of a planted item: the tight rectangle [x0, y0, x1, y1) of the pixels inside its box that
 * differ from the box's commonest edge colour by more than 48 levels in all. Null when it has none.
 */
function inkRect(img, [bx, by, bw, bh]) {
  const x0 = Math.max(0, Math.floor(bx))
  const y0 = Math.max(0, Math.floor(by))
  const x1 = Math.min(img.width, Math.ceil(bx + bw))
  const y1 = Math.min(img.height, Math.ceil(by + bh))
  if (x1 <= x0 || y1 <= y0) return null
  const counts = new Map()
  const edge = (x, y) => {
    const i = at(img, x, y)
    const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  for (let x = x0; x < x1; x++) {
    edge(x, y0)
    edge(x, y1 - 1)
  }
  for (let y = y0; y < y1; y++) {
    edge(x0, y)
    edge(x1 - 1, y)
  }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const br = bg >> 16
  const bgc = (bg >> 8) & 255
  const bb = bg & 255
  let ix0 = Infinity
  let iy0 = Infinity
  let ix1 = -1
  let iy1 = -1
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = at(img, x, y)
      if (Math.abs(img.data[i] - br) + Math.abs(img.data[i + 1] - bgc) + Math.abs(img.data[i + 2] - bb) > 48) {
        if (x < ix0) ix0 = x
        if (y < iy0) iy0 = y
        if (x + 1 > ix1) ix1 = x + 1
        if (y + 1 > iy1) iy1 = y + 1
      }
    }
  }
  return ix1 < 0 ? null : [ix0, iy0, ix1, iy1]
}

/** Other secrets in the same places: each rectangle's pixels mirrored left to right (a copy is returned). */
function mirrored(img, rects) {
  const data = Buffer.from(img.data)
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) {
      for (let a = x0, b = x1 - 1; a < b; a++, b--) {
        const i = at(img, a, y)
        const j = at(img, b, y)
        for (let c = 0; c < 3; c++) {
          const v = data[i + c]
          data[i + c] = data[j + c]
          data[j + c] = v
        }
      }
    }
  }
  return { ...img, data }
}

/** Seeded noise (a different secret for every seed). */
function noise(seed, length) {
  const out = Buffer.alloc(length)
  let s = seed >>> 0 || 1
  for (let i = 0; i < length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = s & 255
  }
  return out
}

/** Scales an RGB picture to `width` x `height` (lanczos), as ffmpeg does. */
function scaled(img, width, height) {
  const data = execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${img.width}x${img.height}`, '-i', '-', '-vf', `scale=${width}:${height}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input: img.data, maxBuffer: width * height * 3 + 1024 })
  return { width, height, data }
}

/* ---------- recordings ---------- */

/**
 * Encodes `frames` RGB frames from `frameAt(n)` as a lossless 4:4:4 H.264 recording (a key frame each
 * second), cached under `key`. Returns the file.
 */
async function encodeVideo(key, { width, height, fps, frames, frameAt }) {
  fs.mkdirSync(CACHE, { recursive: true })
  const out = path.join(CACHE, `${key}.mp4`)
  if (fs.existsSync(out)) return out
  const tmp = `${out}.part-${process.pid}.mp4`
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', '-g', String(fps), '-movflags', '+faststart', tmp], { stdio: ['pipe', 'ignore', 'inherit'] })
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject)
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} encoding ${key}`))))
  })
  for (let n = 0; n < frames; n++) {
    const buf = frameAt(n)
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
  }
  ff.stdin.end()
  await done
  fs.renameSync(tmp, out)
  return out
}

/** The evaluation set's truth (one entry a PNG). */
function evalTruth(file = 'truth.json.gz') {
  return JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(path.join(EVAL, file))).toString('utf8'))
}

/** Every on-by-default planted item of an evaluation frame with its ink, from the frame's own pixels. */
function plantedInk(img, frame) {
  return frame.items.filter((it) => it.on).map((it) => ({ id: it.id, kind: it.kind, text: it.text, ink: inkRect(img, it.box) })).filter((it) => it.ink)
}

/* ---------- projects ---------- */

/** Writes a project folder whose screen.mp4 links to `media`; `extra` is merged into project.json. */
function seed(home, { id, name, media, seconds, width, height, fps = 60, scale = 1, extra = {}, cursor }) {
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  const screen = path.join(dir, 'screen.mp4')
  fs.rmSync(screen, { force: true })
  linkMedia(media, screen)
  const project = {
    version: 2,
    id,
    name,
    createdAt: '2026-11-20T12:00:00.000Z',
    duration: seconds,
    width,
    height,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps },
    clips: [{ id: 'c0', start: 0, end: seconds, speed: 1 }],
    zooms: [],
    autoZoom: false,
    annotations: [],
    style: { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    ...extra
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify(cursor || { samples: [], clicks: [], keys: [], shapes: [], scale, valid: false }))
  return dir
}

/** A recording file in a project: a hard link to the cached file (a real file, as a recording is), else a copy. */
function linkMedia(media, screen) {
  try {
    fs.linkSync(media, screen)
  } catch {
    fs.copyFileSync(media, screen)
  }
}

/** Points a project's screen.mp4 at another recording (the second recording of a comparison). */
function relink(home, id, media) {
  const screen = path.join(h.projectsRoot(home), id, 'screen.mp4')
  fs.rmSync(screen, { force: true })
  linkMedia(media, screen)
  fs.rmSync(path.join(h.projectsRoot(home), id, '.cache'), { recursive: true, force: true })
}

/** A fixed box as a cover path key list (normalised, 4 decimals rounded outward). */
function pathOf(keys, width, height) {
  return keys
    .map(({ t, x, y, w, h: hh }) => {
      const nx = Math.floor((x / width) * 1e4) / 1e4
      const ny = Math.floor((y / height) * 1e4) / 1e4
      const nw = Math.ceil(((x + w) / width) * 1e4) / 1e4 - nx
      const nh = Math.ceil(((y + hh) / height) * 1e4) / 1e4 - ny
      return `${t.toFixed(3)} ${nx.toFixed(4)} ${ny.toFixed(4)} ${nw.toFixed(4)} ${nh.toFixed(4)}`
    })
    .join(';')
}

/* ---------- covers at a frame (§4.2) ---------- */

function parsePath(p) {
  return String(p)
    .split(';')
    .map((k) => k.trim().split(/\s+/).map(Number))
    .map(([t, x, y, w, hh]) => ({ t, x, y, w, h: hh }))
}

/**
 * The boxes drawn at picture time `t` (seconds) in a `width` x `height` recording: every cover active at
 * any time in [t - s, t + s] (s = 0.5 / fps + 0.001) with each of its boxes over that window, in pixels.
 * Each box is kept apart (not their bounding box), so a check against them is never looser than §4.2.
 */
function drawnRects(covers, t, fps, width, height) {
  const s = 0.5 / fps + 0.001
  const rects = []
  for (const c of covers) {
    const lo = Math.max(t - s, c.start)
    const hi = Math.min(t + s, c.end)
    if (!(lo < hi)) continue
    const keys = c.keys || (c.keys = parsePath(c.path))
    let first = 0
    for (let i = 0; i < keys.length; i++) if (keys[i].t <= lo) first = i
    for (let i = first; i < keys.length; i++) {
      if (i > first && keys[i].t >= hi) break
      const k = keys[i]
      rects.push([Math.floor(k.x * width), Math.floor(k.y * height), Math.ceil((k.x + k.w) * width), Math.ceil((k.y + k.h) * height)])
    }
  }
  return rects
}

/** Pixels of [x0, y0, x1, y1) outside every rectangle of `rects`. */
function uncovered([x0, y0, x1, y1], rects) {
  let missing = 0
  for (let y = y0; y < y1; y++) {
    const spans = rects.filter((r) => r[1] <= y && y < r[3] && r[2] > x0 && r[0] < x1).map((r) => [Math.max(x0, r[0]), Math.min(x1, r[2])]).sort((a, b) => a[0] - b[0])
    let x = x0
    for (const [a, b] of spans) {
      if (a > x) missing += a - x
      x = Math.max(x, b)
    }
    if (x < x1) missing += x1 - x
  }
  return missing
}

/* ---------- outputs ---------- */

/** One MD5 per decoded frame (rgb24, or rgba with `alpha`), and the frame count. */
function frameMd5s(file, { alpha = false } = {}) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-pix_fmt', alpha ? 'rgba' : 'rgb24', '-f', 'framemd5', '-'], { maxBuffer: 1 << 28 }).toString()
  return out
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop().trim())
}

/**
 * Compares two outputs frame by frame (§17.3): `exact` asks for every decoded frame to be the same;
 * otherwise every frame must match within `levels` on all but `share` of its pixels (whole frame).
 * Returns { frames, same, worst: { frame, share } } and throws with the first frame that fails.
 */
async function compareOutputs(a, b, { exact = true, levels = 2, share = 0.001, alpha = false, label = '', regions = null, regionShare = 0.02 } = {}) {
  const ma = frameMd5s(a, { alpha })
  const mb = frameMd5s(b, { alpha })
  h.assert(ma.length > 0 && ma.length === mb.length, `${label}: both outputs have the same frames (${ma.length} and ${mb.length})`)
  const sameFrames = ma.filter((m, i) => m === mb[i]).length
  const bytes = sha256File(a) === sha256File(b)
  if (sameFrames === ma.length) return { frames: ma.length, same: sameFrames, bytes, worst: { frame: -1, share: 0 } }
  h.assert(!exact, `${label}: every frame identical (${ma.length - sameFrames} of ${ma.length} differ, first #${ma.findIndex((m, i) => m !== mb[i])})`)
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', a]).toString()).streams[0]
  const { width, height } = probe
  const planes = alpha ? 4 : 3
  const size = width * height * planes
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-filter_complex', `[0:v]format=${alpha ? 'gbrap' : 'gbrp'}[x];[1:v]format=${alpha ? 'gbrap' : 'gbrp'}[y];[x][y]blend=all_mode=difference:shortest=1`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] })
  let pending = Buffer.alloc(0)
  let frame = 0
  let worst = { frame: -1, share: 0 }
  let worstRegion = { frame: -1, share: 0 }
  const plane = width * height
  const over = (buf, i) => {
    let m = buf[i]
    for (let p = 1; p < planes; p++) if (buf[i + p * plane] > m) m = buf[i + p * plane]
    return m > levels
  }
  const check = (buf) => {
    let bad = 0
    for (let i = 0; i < plane; i++) if (over(buf, i)) bad++
    const s = bad / plane
    if (s > worst.share) worst = { frame, share: s }
    if (regions) {
      let inBad = 0
      let inAll = 0
      for (const [x0, y0, x1, y1] of regions(frame)) {
        for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
          for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
            inAll++
            if (over(buf, y * width + x)) inBad++
          }
        }
      }
      const r = inAll ? inBad / inAll : 0
      if (r > worstRegion.share) worstRegion = { frame, share: r }
    }
    frame++
  }
  await new Promise((resolve, reject) => {
    ff.stdout.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d
      while (pending.length >= size) {
        check(pending.subarray(0, size))
        pending = pending.subarray(size)
      }
    })
    ff.on('error', reject)
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} comparing ${label}`))))
  })
  h.assert(worst.share <= share, `${label}: frame #${worst.frame} differs by more than ${levels} levels on ${(worst.share * 100).toFixed(3)}% of its pixels`)
  if (regions) h.assert(worstRegion.share <= regionShare, `${label}: frame #${worstRegion.frame} differs by more than ${levels} levels on ${(worstRegion.share * 100).toFixed(2)}% of the pixels where the secrets are`)
  return { frames: frame, same: sameFrames, bytes, worst, worstRegion }
}

/** The video stream's first decoded frame of `file` at `seconds`, as RGB. */
function frameAt(file, seconds, { width, height }) {
  const data = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: width * height * 3 + 1024 })
  return { width, height, data }
}

/* ---------- the editor ---------- */

/** Opens the Shapes tab of the inspector. */
async function openShapes(win) {
  await win.click('.insp-tabs button:has-text("Shapes")')
  await win.waitForSelector('[data-testid="privacy-section"]')
}

/** Polls `fn` until it returns a truthy value; throws `message` after `timeout` ms. */
async function until(fn, message, timeout = 30000, every = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timed out (${Math.round(timeout / 1000)} s): ${message}`)
    await h.sleep(every)
  }
}

/** The saved project.json once `pred(project)` holds. */
async function savedProject(home, id, pred, message, timeout = 30000) {
  return until(async () => {
    const p = h.readProject(home, id)
    return pred(p) ? p : null
  }, message, timeout)
}

/** With SSW_E2E_DOC_SHOTS set: docs/screenshots/auto-blur-<name>.png, scaled down until under 300 KB. */
async function docShot(win, name, locator = null) {
  if (!process.env.SSW_E2E_DOC_SHOTS) return
  const dir = path.join(ROOT, 'docs', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `auto-blur-${name}.png`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-shot-'))
  const raw = path.join(tmp, `${name}.png`)
  try {
    if (locator) await locator.screenshot({ path: raw })
    else await win.screenshot({ path: raw })
    for (const width of [0, 1400, 1100, 900, 700]) {
      if (width) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', `scale='min(${width},iw)':-1:flags=lanczos`, '-pix_fmt', 'rgb24', file])
      else fs.copyFileSync(raw, file)
      if (fs.statSync(file).size < 300 * 1024) return
    }
    throw new Error(`${file} is over 300 KB`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = {
  CACHE,
  EVAL,
  ROOT,
  appEnv,
  compareOutputs,
  decodePng,
  docShot,
  drawnRects,
  encodeVideo,
  evalTruth,
  frameAt,
  frameMd5s,
  helperBinary,
  inkRect,
  installReader,
  mirrored,
  modelsDir,
  noise,
  openShapes,
  parsePath,
  pathOf,
  plantedInk,
  readerFiles,
  relink,
  savedProject,
  scaled,
  seed,
  sha256File,
  uncovered,
  until,
  userDataOf,
  writePng
}
