/**
 * Auto-blur private information end to end (docs/design/auto-blur.md §17.3, A1-A21): the host text
 * reader helper (`node scripts/build-native.mjs --ocr-host`, or SSW_OCR_HELPER) and the pinned models
 * (SSW_OCR_MODELS, a folder holding them as <repository>/<file>, checked by size and SHA-256) in a
 * fixed userData under each test HOME; fixture recordings made from the evaluation PNGs. An output is
 * shown to cover by making it twice, from two recordings that differ only under the covers, and
 * comparing the two (§17.3); found covers are checked against every planted item's ink in every
 * source frame.
 *
 *   npm run build && SSW_OCR_MODELS=<folder> xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/auto-blur.e2e.cjs
 *   SSW_E2E_ONLY=A2 ...   runs only the cases whose name holds A2
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const af = require('./auto-blur-fixtures.cjs')

/** Runs one case; SSW_E2E_ONLY=<substring> runs only matching ones. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !only.split(',').some((o) => name.includes(o))) return Promise.resolve()
  return h.run(name, async (ctx) => {
    try {
      await body(ctx)
    } catch (err) {
      // A picture of the window as it failed, for a look (kept in the system temp folder).
      const win = ctx.app?.windows?.()[0]
      if (win) {
        const file = path.join(os.tmpdir(), `ssw-e2e-auto-blur-fail-${name.slice(0, 3).replace(/[^A-Za-z0-9]/g, '')}-${Date.now()}.png`)
        await win.screenshot({ path: file }).then(() => console.error(`  screenshot: ${file}`), () => undefined)
      }
      throw err
    }
  })
}

/* ---------- the app ---------- */

/** A test HOME with the reader installed in its userData. */
function readerHome(name) {
  const home = h.tempHome(name)
  af.installReader(home)
  return home
}

/** Launches the app on `home` with the fixed userData, the host helper and the network blocked and counted. */
async function start(ctx, home, env = {}) {
  const { app, win, logs } = await h.launch({ home, env: af.appEnv(home, env) })
  ctx.app = app
  ctx.logs = logs
  await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)
  await app.evaluate(({ session }) => {
    globalThis.__requests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
      globalThis.__requests.push(details.url)
      done({ cancel: true })
    })
  })
  return { app, win, logs }
}

/** Closes the app of `ctx`. */
async function stop(ctx) {
  if (ctx.app) await ctx.app.close().catch(() => undefined)
  ctx.app = null
}

/** Nothing left the PC (§10.1) but what the update check asks, which the app has always done. */
async function offline(app, allow = []) {
  const urls = (await app.evaluate(() => globalThis.__requests)).filter((u) => !/github\.com|githubusercontent\.com/.test(u) && !allow.some((a) => u.startsWith(a)))
  h.assert(urls.length === 0, `no request left the app (${urls.join(', ')})`)
}

/** Opens the project named exactly `name` from Home. */
async function openProject(win, name) {
  const tile = win.locator('.project-open').filter({ has: win.locator('.project-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
  await tile.first().waitFor({ timeout: 30000 })
  await tile.first().click()
  await win.waitForSelector('.editor canvas', { timeout: 60000 })
  await h.sleep(800)
}

async function goHome(win) {
  await win.click('button[aria-label="Back to recordings"]')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

/**
 * Find private info from the Shapes tab with the defaults (plus `names`, Names you list): waits until
 * the results are applied and saved. Returns the saved project and the run's line from main's log.
 */
async function runFind(ctx, win, home, id, { names = [], timeout = 40 * 60 * 1000 } = {}) {
  await af.openShapes(win)
  await win.click('[data-testid="privacy-find"]')
  await win.waitForSelector('[data-testid="find-dialog"]')
  if (names.length) await win.fill('[data-testid="find-names"]', names.join('\n'))
  await af.until(() => win.isEnabled('[data-testid="find-start"]'), 'Find is enabled (the reader is ready)', 60000)
  const before = h.readProject(home, id).privacy?.find?.at ?? null
  const t0 = Date.now()
  await win.click('[data-testid="find-start"]')
  const project = await af.savedProject(home, id, (p) => !!p.privacy?.find && p.privacy.find.at !== before, 'Find finished and its results were saved', timeout)
  const line = ctx.logs.join('').split('\n').reverse().find((l) => l.includes('privacy: find read')) || ''
  return { project, seconds: (Date.now() - t0) / 1000, line: line.replace(/^.*privacy: /, 'privacy: ').trim() }
}

/** The single-file export of the open project with `settings`, to `out`. */
async function exportVideo(app, win, out, settings) {
  await win.evaluate((s) => {
    localStorage.setItem('export-mode', 'single')
    localStorage.setItem('export-settings', JSON.stringify(s))
    localStorage.setItem('export-bundle', JSON.stringify({}))
  }, settings)
  await h.mockSaveDialog(app, out)
  await win.click('header button.primary:has-text("Export")')
  await win.waitForSelector('.modal[aria-label="Export"]')
  await h.sleep(500)
  await clickExport(win)
  const t0 = Date.now()
  for (;;) {
    const text = (await win.textContent('.modal').catch(() => '')) || ''
    if (/Export finished/.test(text)) break
    h.assert(!/Export failed/.test(text), `export to ${path.basename(out)} failed: ${text.slice(0, 300)}`)
    h.assert(Date.now() - t0 < 20 * 60 * 1000, 'export timed out')
    await h.sleep(300)
  }
  await closeModal(win)
  h.assert(fs.existsSync(out), `${path.basename(out)} was written`)
}

async function closeModal(win) {
  const back = win.locator('.modal button', { hasText: /^Back$/ })
  if (await back.count()) await back.click()
  await win.locator('.modal button', { hasText: /^(Done|Cancel|Close)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/* ---------- A1's recording: eight evaluation frames with scrolls between them ---------- */

const A1_FRAMES = ['01-editor-0-dark-100.png', '06-terminal-1-light-125.png', '09-dashboard-0-light-100.png', '12-crm-1-dark-100.png', '14-inbox-1-dark-150.png', '17-twofa-0-light-100.png', '20-checkout-1-dark-100.png', '22-chat-1-light-125.png']
const A1_FPS = 30

/**
 * A recording of evaluation frames at 30 fps: each held for `holds[i]` frames, then a 1 s scroll down
 * to the next one (it comes up from below), and the same recording with every on-by-default planted
 * item's ink mirrored (other secrets in the same places). Returns both files, every frame's items and
 * the names to list.
 */
async function plantedRecordings(tag, files, holds) {
  const truth = af.evalTruth()
  const frames = files.map((file) => {
    const img = af.decodePng(path.join(af.EVAL, file))
    const t = truth.frames.find((f) => f.file === file)
    const items = af.plantedInk(img, t)
    return { file, img, other: af.mirrored(img, items.map((it) => it.ink)), items }
  })
  const W = 1920
  const H = 1080
  const scroll = A1_FPS
  const segments = []
  let n0 = 0
  holds.forEach((len, i) => {
    segments.push({ kind: 'hold', i, n0, len })
    n0 += len
    if (i < holds.length - 1) {
      segments.push({ kind: 'scroll', i, n0, len: scroll })
      n0 += scroll
    }
  })
  const total = n0
  const segOf = (n) => segments.find((s) => n >= s.n0 && n < s.n0 + s.len)
  const offsetOf = (s, n) => Math.round((H * (n - s.n0 + 1)) / (s.len + 1))
  const build = (pick) => (n) => {
    const s = segOf(n)
    if (s.kind === 'hold') return pick(frames[s.i]).data
    const off = offsetOf(s, n)
    const top = pick(frames[s.i]).data
    const bottom = pick(frames[s.i + 1]).data
    const buf = Buffer.alloc(W * H * 3)
    top.copy(buf, 0, off * W * 3, H * W * 3)
    bottom.copy(buf, (H - off) * W * 3, 0, off * W * 3)
    return buf
  }
  /** The planted items on frame n, with their ink where it shows. */
  const itemsAt = (n) => {
    const s = segOf(n)
    if (s.kind === 'hold') return frames[s.i].items.map((it) => ({ ...it, frame: frames[s.i].file }))
    const off = offsetOf(s, n)
    const moved = (f, dy) =>
      f.items
        .map((it) => ({ ...it, frame: f.file, ink: [it.ink[0], Math.max(0, it.ink[1] + dy), it.ink[2], Math.min(H, it.ink[3] + dy)] }))
        .filter((it) => it.ink[3] > it.ink[1])
    return [...moved(frames[s.i], -off), ...moved(frames[s.i + 1], H - off)]
  }
  const a = await af.encodeVideo(`${tag}-secrets`, { width: W, height: H, fps: A1_FPS, frames: total, frameAt: build((f) => f.img) })
  const b = await af.encodeVideo(`${tag}-other-secrets`, { width: W, height: H, fps: A1_FPS, frames: total, frameAt: build((f) => f.other) })
  return { a, b, total, itemsAt, names: truth.listedNames, width: W, height: H, seconds: total / A1_FPS, fps: A1_FPS }
}

/** A1's 60 s recording of eight frames with scrolls between them. */
const a1Recordings = () => plantedRecordings('a1', A1_FRAMES, [199, 199, 199, 199, 198, 198, 199, 199])
/** A short recording for the cases that only need a Find: two frames, 3 s each, a scroll between. */
const smallRecordings = () => plantedRecordings('small', ['13-inbox-0-light-100.png', '05-terminal-0-dark-100.png'], [90, 90])

/**
 * Whether an export (1:1 with the recording, no padding) shows a solid box over every rectangle
 * `rectsAt(n)` gives on the sampled frames: each rectangle's pixels within `levels` of each other in
 * every channel. Returns the failures.
 */
function solidIn(file, { width, height, fps }, rectsAt, every = 15, levels = 24) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=not(mod(n\\,${every}))`, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 2 ** 31 })
  const size = width * height * 3
  const failures = []
  for (let k = 0; k * size < raw.length; k++) {
    const n = k * every
    const img = raw.subarray(k * size, (k + 1) * size)
    for (const [x0, y0, x1, y1, what] of rectsAt(n)) {
      const lo = [255, 255, 255]
      const hi = [0, 0, 0]
      for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
          const i = (y * width + x) * 3
          for (let c = 0; c < 3; c++) {
            if (img[i + c] < lo[c]) lo[c] = img[i + c]
            if (img[i + c] > hi[c]) hi[c] = img[i + c]
          }
        }
      }
      const spread = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
      if (spread > levels) failures.push(`${what ?? 'box'} at frame ${n} (${(n / fps).toFixed(2)} s): pixels spread over ${spread} levels`)
    }
  }
  return failures
}

/**
 * Every planted item's ink inside a cover in every source frame (§17.3): the failures, at most `max`
 * listed, with the item, the frame and the uncovered pixels.
 */
function coverageFailures(covers, { total, itemsAt, fps, width, height }, max = 25) {
  const failures = []
  let count = 0
  let checked = 0
  for (let n = 0; n < total; n++) {
    const rects = af.drawnRects(covers, n / fps, fps, width, height)
    for (const it of itemsAt(n)) {
      checked++
      const missing = af.uncovered(it.ink, rects)
      if (missing > 0) {
        count++
        if (failures.length < max) failures.push(`${it.id} (${it.kind}, "${String(it.text).slice(0, 24)}") frame ${n}: ${missing} px uncovered of [${it.ink.join(', ')}]`)
      }
    }
  }
  return { count, checked, failures }
}

/* ---------- A2's recordings: three secrets, one of them moving, under three covers ---------- */

const A2 = { width: 1280, height: 720, fps: 30, seconds: 6 }
const PAD = 6

/** Where the three secrets are on source frame n: two still, one moving down-right then up. */
function a2Secrets(n) {
  const t = n / A2.fps
  return [
    { x: 100, y: 96, w: 240, h: 36 },
    { x: 820, y: 520, w: 220, h: 36 },
    { x: Math.round(120 + (760 * t) / A2.seconds), y: Math.round(380 - (220 * Math.abs(t - 3)) / 3), w: 180, h: 36 }
  ]
}

/** A recording of a dashboard with the three secrets drawn as seeded noise (`seeds`: one per secret). */
async function a2Recording(tag, seeds, base) {
  const { width, height, fps, seconds } = A2
  const patches = seeds.map((s, i) => af.noise(s, a2Secrets(0)[i].w * a2Secrets(0)[i].h * 3))
  return af.encodeVideo(`a2-${tag}`, {
    width,
    height,
    fps,
    frames: seconds * fps,
    frameAt: (n) => {
      const buf = Buffer.from(base.data)
      a2Secrets(n).forEach((r, i) => {
        for (let y = 0; y < r.h; y++) patches[i].copy(buf, ((r.y + y) * width + r.x) * 3, y * r.w * 3, (y + 1) * r.w * 3)
      })
      return buf
    }
  })
}

/** Both recordings and the project's three covers (the moving one keyed on every source frame, as stepKeys keys a walk). */
async function a2Fixture() {
  const base = af.scaled(af.decodePng(path.join(af.EVAL, '09-dashboard-0-light-100.png')), A2.width, A2.height)
  const a = await a2Recording('secrets', [11, 12, 13], base)
  const b = await a2Recording('other-secrets', [21, 22, 23], base)
  const padded = (r) => ({ x: r.x - PAD, y: r.y - PAD, w: r.w + 2 * PAD, h: r.h + 2 * PAD })
  const frames = A2.seconds * A2.fps
  const still = (i) => ({ id: `cov${i + 1}`, start: 0, end: A2.seconds, color: '#1c1c22', path: af.pathOf([{ t: 0, ...padded(a2Secrets(0)[i]) }], A2.width, A2.height) })
  const moving = { id: 'cov3', start: 0, end: A2.seconds, color: '#2a4d7a', path: af.pathOf(Array.from({ length: frames }, (_, n) => ({ t: n / A2.fps, ...padded(a2Secrets(n)[2]) })), A2.width, A2.height) }
  return { a, b, covers: [still(0), still(1), moving] }
}

/** The guide's three clicks in three places, inside the secrets' time, the cursor moving between them. */
const A2_CLICKS = [
  { t: 0.8, x: 0.15, y: 0.15 },
  { t: 2.6, x: 0.72, y: 0.78 },
  { t: 4.4, x: 0.35, y: 0.5 }
]
function a2Cursor() {
  const samples = []
  for (let t = 0; t <= A2.seconds; t += 1 / 30) {
    const next = A2_CLICKS.find((c) => c.t >= t) || A2_CLICKS[A2_CLICKS.length - 1]
    const prev = [...A2_CLICKS].reverse().find((c) => c.t < t) || { t: 0, x: 0.5, y: 0.5 }
    const k = next.t > prev.t ? Math.min(1, Math.max(0, (t - prev.t) / Math.min(0.6, next.t - prev.t))) : 1
    samples.push({ t: +t.toFixed(4), x: +(prev.x + (next.x - prev.x) * k).toFixed(4), y: +(prev.y + (next.y - prev.y) * k).toFixed(4) })
  }
  return { samples, clicks: A2_CLICKS.map((c) => ({ ...c, button: 'left' })), keys: [], shapes: [], scale: 1, valid: true }
}

/** Seeds the pair of projects of one A2 case: the same project.json over each recording. */
function seedPair(home, fixture, name, extra = {}) {
  const slug = name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()
  const ids = { a: `rec-${slug}-a`, b: `rec-${slug}-b` }
  for (const side of ['a', 'b']) {
    af.seed(home, { id: ids[side], name: `${name} ${side === 'a' ? 'one' : 'two'}`, media: fixture[side], seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, cursor: a2Cursor(), extra: { covers: fixture.covers, ...extra } })
  }
  return { ids, names: { a: `${name} one`, b: `${name} two` } }
}

async function mockFolderDialog(app, dir) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, dir)
}

/** Reads the export dialog's preview canvas once it shows the same frame twice. */
async function dialogPreview(win, timeout = 60000) {
  const read = () =>
    win.evaluate(() => {
      const c = document.querySelector('.modal canvas.export-preview-canvas[data-settled]')
      if (!c) return null
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height)
      return { width: c.width, height: c.height, data: Array.from(d.data) }
    })
  const t0 = Date.now()
  let last = null
  for (;;) {
    const now = await read()
    const drawn = now !== null && now.data.some((v, i) => i % 4 !== 3 && v !== 0)
    if (drawn && last && last.data.length === now.data.length && now.data.every((v, i) => v === last.data[i])) return { width: now.width, height: now.height, data: Buffer.from(now.data) }
    last = drawn ? now : null
    h.assert(Date.now() - t0 < timeout, 'the export dialog\'s preview settles')
    await h.sleep(300)
  }
}

/** The pictures of the guide panel's steps, as RGBA pixels. */
async function guidePictures(win) {
  return win.evaluate(async () => {
    const out = []
    for (const img of document.querySelectorAll('[data-testid="guide-shot"] img')) {
      await img.decode().catch(() => undefined)
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      out.push({ width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) })
    }
    return out
  })
}

/** Decodes every picture in a guide's PDF (pdfimages) or one-file HTML (its data: URLs), as PNG files. */
function guideFileImages(file, dir) {
  fs.mkdirSync(dir, { recursive: true })
  if (file.endsWith('.pdf')) {
    execFileSync('pdfimages', ['-png', file, path.join(dir, 'img')])
  } else {
    const page = fs.readFileSync(file, 'utf8')
    let i = 0
    for (const m of page.matchAll(/data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=]+)/g)) {
      const src = path.join(dir, `img-${String(i).padStart(3, '0')}.${m[1]}`)
      fs.writeFileSync(src, Buffer.from(m[2], 'base64'))
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, path.join(dir, `img-${String(i).padStart(3, '0')}.png`)])
      fs.rmSync(src)
      i++
    }
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(dir, f))
}

/** Opens the guide panel and waits for every step's picture; returns the number of steps. */
async function openGuide(win) {
  await win.locator('[data-testid="guide-open"]').click()
  await win.waitForSelector('[data-testid="guide-panel"]')
  await af.until(async () => (await win.locator('[data-testid="guide-step"]').count()) > 0, 'the guide\'s steps', 60000)
  await af.until(async () => {
    const bar = win.locator('[aria-label="Making screenshots"]')
    if (!(await bar.count())) return true
    return (await bar.getAttribute('aria-valuenow')) === (await bar.getAttribute('aria-valuemax'))
  }, 'the guide\'s screenshots made', 120000)
  const steps = await win.locator('[data-testid="guide-step"]').count()
  await af.until(async () => (await win.locator('[data-testid="guide-shot"] img').count()) === steps, `${steps} guide pictures`, 60000)
  await h.sleep(500)
  return steps
}

async function guideSave(win, app, format, file) {
  if (format === 'Markdown') await mockFolderDialog(app, file)
  else await h.mockSaveDialog(app, file)
  await win.locator('[data-testid="guide-format"] label', { hasText: format }).click()
  await win.locator('[data-testid="guide-save"]').click()
  for (let i = 0; i < 3; i++) {
    await h.sleep(300)
    for (const id of ['guide-save-anyway', 'guide-link-anyway']) {
      const b = win.locator(`[data-testid="${id}"]`)
      if (await b.isVisible().catch(() => false)) await b.click()
    }
  }
  await af.until(async () => new RegExp(`Saved “${path.basename(file).replace(/[.()]/g, '\\$&')}”`).test(await win.locator('[data-testid="guide-said"]').innerText()), `the guide saved as ${format}`, 90000)
}

/**
 * The output routes of A2 (§17.3). Each makes its outputs from the open project into `dir` and
 * returns them as { label, file } (compared frame by frame) or { label, pixels } (compared exactly).
 */
const MP4 = { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'auto' }
const A2_ROUTES = [
  { name: 'MP4', run: async ({ app, win, dir }) => [{ label: 'mp4', file: await exportTo(app, win, dir, 'out.mp4', MP4) }] },
  { name: 'WebM', run: async ({ app, win, dir }) => [{ label: 'webm', file: await exportTo(app, win, dir, 'out.webm', { ...MP4, format: 'webm' }) }] },
  { name: 'MOV CineForm', run: async ({ app, win, dir }) => [{ label: 'cineform', file: await exportTo(app, win, dir, 'out.mov', { ...MP4, format: 'mov', codec: 'cineform' }) }] },
  { name: 'GIF', run: async ({ app, win, dir }) => [{ label: 'gif', file: await exportTo(app, win, dir, 'out.gif', { ...MP4, format: 'gif' }) }] },
  { name: 'transparent background', run: async ({ app, win, dir }) => [{ label: 'alpha', alpha: true, file: await exportTo(app, win, dir, 'alpha.webm', { ...MP4, format: 'webm', alpha: 'background' }) }] },
  { name: '120 fps', run: async ({ app, win, dir }) => [{ label: '120fps', file: await exportTo(app, win, dir, 'out120.mp4', { ...MP4, fps: 120 }) }] },
  {
    name: 'batch',
    run: async ({ app, win, dir }) => {
      fs.mkdirSync(dir, { recursive: true })
      await mockFolderDialog(app, dir)
      await win.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({})))
      await win.click('header button.primary:has-text("Export")')
      await win.waitForSelector('.modal[aria-label="Export"]')
      await win.click('.modal .export-mode button:has-text("Batch")')
      await h.sleep(500)
      for (const id of ['youtube-1080', 'slack-gif']) {
        const card = win.locator(`.modal .preset-card[data-preset="${id}"]`)
        await af.until(async () => {
          if ((await card.getAttribute('aria-checked')) === 'true') return true
          await card.click()
          await h.sleep(400)
          return (await card.getAttribute('aria-checked')) === 'true'
        }, `${id} ticked for the batch`, 15000)
      }
      await clickExport(win, 'Export 2 files')
      await win.waitForSelector('.modal .success:has-text("Batch finished")', { timeout: 600000 })
      await win.click('.modal .export-mode button:has-text("Single")').catch(() => undefined)
      await closeModal(win)
      return fs.readdirSync(dir).sort().map((f) => ({ label: `batch ${f.replace(/^.* - /, '')}`, file: path.join(dir, f) }))
    }
  },
  {
    name: 'per-chapter parts and the thumbnail beside the export',
    run: async ({ app, win, dir }) => {
      fs.mkdirSync(dir, { recursive: true })
      await mockFolderDialog(app, dir)
      await win.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({ srt: false, vtt: false, chapters: false, thumbnail: true, description: false, perChapter: true })))
      await win.evaluate((s) => localStorage.setItem('export-settings', JSON.stringify(s)), MP4)
      await win.click('header button.primary:has-text("Export")')
      await win.waitForSelector('.modal[aria-label="Export"]')
      await h.sleep(500)
      await clickExport(win)
      await af.until(async () => /Export finished|finished/i.test((await win.textContent('.modal')) || '') && fs.readdirSync(dir).some((f) => f.endsWith('.mp4')), 'the parts written', 600000, 500)
      await h.sleep(1500)
      await closeModal(win)
      const files = fs.readdirSync(dir).sort()
      return files.filter((f) => /\.(mp4|png)$/.test(f)).map((f) => ({ label: `part ${f}`, file: path.join(dir, f), still: f.endsWith('.png') }))
    }
  },
  {
    name: 'thumbnail PNG and the export dialog\'s preview',
    run: async ({ app, win, dir }) => {
      fs.mkdirSync(dir, { recursive: true })
      await win.evaluate((s) => {
        localStorage.setItem('export-mode', 'single')
        localStorage.setItem('export-settings', JSON.stringify(s))
      }, MP4)
      await win.click('header button.primary:has-text("Export")')
      await win.waitForSelector('.modal[aria-label="Export"]')
      await win.locator('.modal input[aria-label="Thumbnail frame"]').fill('3')
      await h.sleep(800)
      const preview = await dialogPreview(win)
      const png = path.join(dir, 'thumb.png')
      await h.mockSaveDialog(app, png)
      await win.click('.modal button:has-text("Save thumbnail")')
      await af.until(async () => fs.existsSync(png) && fs.statSync(png).size > 0, 'the thumbnail saved', 30000)
      await h.sleep(500)
      await closeModal(win)
      return [
        { label: 'thumbnail', file: png, still: true },
        { label: 'dialog preview', pixels: preview }
      ]
    }
  },
  {
    name: 'the guide\'s shots, PDF and HTML pictures (A2e)',
    run: async ({ app, win, dir }) => {
      fs.mkdirSync(dir, { recursive: true })
      const steps = await openGuide(win)
      const shots = await guidePictures(win)
      const pdf = path.join(dir, 'guide.pdf')
      await guideSave(win, app, 'PDF', pdf)
      const html = path.join(dir, 'guide.html')
      await guideSave(win, app, 'HTML', html)
      await win.keyboard.press('Escape')
      const out = shots.map((s, i) => ({ label: `guide shot ${i + 1}`, pixels: { width: s.width, height: s.height, data: Buffer.from(s.data) } }))
      guideFileImages(pdf, path.join(dir, 'pdf')).forEach((f, i) => out.push({ label: `guide PDF picture ${i + 1}`, file: f, still: true }))
      guideFileImages(html, path.join(dir, 'html')).forEach((f, i) => out.push({ label: `guide HTML picture ${i + 1}`, file: f, still: true }))
      console.log(`    the guide: ${steps} steps, ${out.length} pictures in all`)
      h.assert(steps >= 2 && out.length >= 3 * steps, `the guide's shots and its PDF and HTML pictures (${steps} steps, ${out.length} pictures)`)
      return out
    }
  },
  {
    name: 'timeline\'s This export mode',
    run: async ({ app, win, dir }) => {
      fs.mkdirSync(dir, { recursive: true })
      await win.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({ srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, timelines: ['resolve', 'edl'] })))
      const file = await exportTo(app, win, dir, 'Timeline.mp4', MP4, { keepBundle: true })
      const listed = fs.readdirSync(dir)
      h.assert(listed.includes('Timeline.fcpxml') && listed.includes('Timeline.edl'), `the timelines beside the export (${listed.join(', ')})`)
      h.assert(!listed.some((f) => f.endsWith(' media')), 'no folder of the original recordings')
      h.assert(fs.readFileSync(path.join(dir, 'Timeline.fcpxml'), 'utf8').includes('Timeline.mp4'), 'the timeline uses this export')
      return [{ label: 'timeline video', file }]
    }
  }
]

/** Presses the export dialog's Export button (its label can carry a count or a format). */
async function clickExport(win, text = 'Export') {
  const button = win.locator('.modal button.primary', { hasText: text })
  try {
    await button.click({ timeout: 15000 })
  } catch (err) {
    const debug = path.join(os.tmpdir(), `ssw-e2e-auto-blur-export-${Date.now()}.png`)
    await win.screenshot({ path: debug }).catch(() => undefined)
    const labels = await win.$$eval('.modal button', (els) => els.map((e) => `${e.className}:${e.textContent.trim().slice(0, 40)}${e.disabled ? ' (disabled)' : ''}`))
    throw new Error(`no Export button to press (${labels.join(' | ')}); screenshot ${debug}: ${err.message}`)
  }
}

/** Runs a command from the palette (Ctrl+K): types `query`, waits for `title` first, presses Enter. */
async function runCommand(win, query, title) {
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type(query)
  await af.until(async () => (await win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent)))[0] === title, `the palette lists ${title} first`, 5000)
  await win.keyboard.press('Enter')
  await af.until(async () => !(await win.$('.command-palette')), 'the palette closes', 5000)
}

/** Every private row's title reads on lines of words, its badges and buttons on lines of their own under it (§2.7). */
async function privateRowsReadable(win) {
  const narrow = await win.$$eval('[data-testid="review-row"]', (rows) =>
    rows
      .filter((r) => r.querySelector('[data-testid="review-private-info"], .review-private-actions'))
      .map((r) => ({ title: r.querySelector('.review-title')?.textContent ?? '', width: r.querySelector('.review-title')?.getBoundingClientRect().width ?? 0 }))
      .filter((x) => x.width < 60)
  )
  h.assert(narrow.length === 0, `private rows' titles have room to read (${narrow.map((x) => `${x.title.slice(0, 30)}: ${Math.round(x.width)} px`).join('; ')})`)
}

/** A single export of the open project to dir/name with `settings`; returns the file. */
async function exportTo(app, win, dir, name, settings, { keepBundle = false } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, name)
  if (!keepBundle) await win.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({})))
  await win.evaluate((s) => {
    localStorage.setItem('export-mode', 'single')
    localStorage.setItem('export-settings', JSON.stringify(s))
  }, settings)
  await h.mockSaveDialog(app, out)
  await win.click('header button.primary:has-text("Export")')
  await win.waitForSelector('.modal[aria-label="Export"]')
  await h.sleep(500)
  await clickExport(win)
  const t0 = Date.now()
  for (;;) {
    const text = (await win.textContent('.modal').catch(() => '')) || ''
    if (/Export finished/.test(text)) break
    h.assert(!/Export failed/.test(text), `export to ${name} failed: ${text.slice(0, 300)}`)
    h.assert(Date.now() - t0 < 20 * 60 * 1000, `export to ${name} timed out`)
    await h.sleep(300)
  }
  await closeModal(win)
  return out
}

/** Compares the outputs of the two recordings, label by label (§17.3); `differ`: the control, where every output must differ. */
async function compareSides(outA, outB, name, { lossy = [], differ = false } = {}) {
  if (differ) {
    for (const a of outA) {
      const b = outB.find((o) => o.label === a.label)
      h.assert(b, `${name}: ${a.label} made from both recordings`)
      const same = a.pixels ? a.pixels.data.equals(b.pixels.data) : af.frameMd5s(a.file, { alpha: !!a.alpha }).join() === af.frameMd5s(b.file, { alpha: !!b.alpha }).join()
      h.assert(!same, `${a.label}: without covers the two recordings' outputs differ (the comparison sees what is under the covers)`)
      console.log(`    ${a.label}: differs without covers`)
    }
    return
  }
  h.assert(outA.length === outB.length && outA.length > 0, `${name}: both recordings gave the same outputs (${outA.map((o) => o.label)} / ${outB.map((o) => o.label)})`)
  for (const a of outA) {
    const b = outB.find((o) => o.label === a.label)
    h.assert(b, `${name}: ${a.label} made from both recordings`)
    if (a.pixels) {
      h.assert(a.pixels.width === b.pixels.width && a.pixels.height === b.pixels.height, `${a.label}: same size`)
      const differ = a.pixels.data.findIndex((v, i) => v !== b.pixels.data[i])
      h.assert(differ < 0, `${a.label}: identical pixels (first difference at pixel ${Math.floor(differ / 4)})`)
      console.log(`    ${a.label}: ${a.pixels.width}x${a.pixels.height}, identical pixels`)
      continue
    }
    const exact = !lossy.some((l) => a.label.includes(l))
    // A lossy route whose encoder is not repeatable (WebCodecs: the same recording exported twice
    // differs by up to about 0.2% of a frame's pixels): the whole frame within 2 levels on 99.5%, and
    // where the secrets are, no more than 2% (the planted noise showing would make nearly all differ).
    const lossyOpts = exact ? {} : { share: 0.005, regions: (n) => a2Secrets(Math.min(A2.seconds * A2.fps - 1, n)).map((r) => [r.x, r.y, r.x + r.w, r.y + r.h]), regionShare: 0.02 }
    const cmp = await af.compareOutputs(a.file, b.file, { exact, alpha: !!a.alpha, label: a.label, ...lossyOpts })
    console.log(`    ${a.label}: ${cmp.frames} frame(s), ${cmp.same} identical${cmp.bytes ? ', files byte-identical' : ''}${cmp.worst.frame >= 0 ? `, worst frame ${(cmp.worst.share * 100).toFixed(4)}% over 2 levels` : ''}${cmp.worstRegion ? `, where the secrets are at most ${(cmp.worstRegion.share * 100).toFixed(3)}%` : ''}`)
  }
}

/**
 * One A2 case: the pair of projects, `route` run on each, and the outputs compared. `env` picks an
 * export route (SSW_EXPORT_VIDEO_ENCODER).
 */
async function a2Case(ctx, { name, extra = {}, routes, env = {}, lossy = [], prepare, differ = false }) {
  const home = h.tempHome(`a2-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`)
  const fixture = await a2Fixture()
  if (differ) fixture.covers = []
  const pair = seedPair(home, fixture, name.replace(/[^A-Za-z0-9 ]+/g, ''), extra)
  if (prepare) prepare(home, pair)
  const { app, win } = await start(ctx, home, env)
  const results = {}
  for (const side of ['a', 'b']) {
    await openProject(win, pair.names[side])
    results[side] = []
    for (const route of routes) results[side].push(await route.run({ app, win, home, dir: path.join(home, `out-${side}`, route.name.replace(/[^a-z0-9]+/gi, '-')) }))
    await goHome(win)
  }
  for (let i = 0; i < routes.length; i++) console.log(`  ${routes[i].name}:`), await compareSides(results.a[i], results.b[i], routes[i].name, { lossy, differ })
  await offline(app)
  return { home, pair }
}

/* ---------- A16: the rendered tracking set ---------- */

const TRACK_CASES = ['list-scroll', 'flick-scroll', 'browser-zoom', 'select-text', 'sticky-header', 'window-drag', 'toasts', 'tooltip', 'type-email', 'type-key']

/** Renders the tracking set once (scripts/privacy/make-track-fixtures.mjs, 2 s a case at 1280x720, seed 7000). */
function trackDir() {
  const dir = path.join(af.CACHE, 'track')
  if (!TRACK_CASES.every((id) => fs.existsSync(path.join(dir, `${id}.truth.json`)))) execFileSync(process.execPath, [path.join(af.ROOT, 'scripts', 'privacy', 'make-track-fixtures.mjs'), dir], { stdio: 'inherit' })
  return dir
}

/** Every frame of a lossless recording as RGB. */
function decodeAll(file, width, height) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 2 ** 31 })
  const size = width * height * 3
  return Array.from({ length: Math.floor(raw.length / size) }, (_, n) => ({ width, height, data: raw.subarray(n * size, (n + 1) * size) }))
}

/** One case of the tracking set: the app's recording (4:4:4, as the others) and every on-by-default item's ink on every frame. */
function trackCase(id) {
  const dir = trackDir()
  const truth = JSON.parse(fs.readFileSync(path.join(dir, `${id}.truth.json`), 'utf8'))
  const src = path.join(dir, `${id}.mp4`)
  const media = path.join(af.CACHE, `track-${id}.mp4`)
  if (!fs.existsSync(media)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', '-g', String(truth.fps), media])
  const frames = decodeAll(src, truth.width, truth.height)
  const items = truth.frames.map((f) => f.items.filter((it) => it.on).map((it) => ({ ...it, ink: af.inkRect(frames[f.n], it.box) })).filter((it) => it.ink))
  return { media, total: truth.frames.length, fps: truth.fps, width: truth.width, height: truth.height, seconds: truth.frames.length / truth.fps, itemsAt: (n) => items[n] ?? [] }
}

/** An evaluation set rendered at a display scale or with another seed (make-eval-set.mjs), each frame held 0.5 s. */
async function evalSetCase(tag, args, scale) {
  const dir = path.join(af.CACHE, `eval-${tag}`)
  if (!fs.existsSync(path.join(dir, 'truth.json'))) execFileSync(process.execPath, [path.join(af.ROOT, 'scripts', 'privacy', 'make-eval-set.mjs'), dir, ...args], { stdio: 'inherit' })
  const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'))
  const pages = truth.frames.map((f) => {
    const img = af.decodePng(path.join(dir, f.file))
    return { img, items: af.plantedInk(img, f) }
  })
  const { width, height } = pages[0].img
  const hold = A1_FPS / 2
  const media = await af.encodeVideo(`eval-${tag}`, { width, height, fps: A1_FPS, frames: pages.length * hold, frameAt: (n) => pages[Math.floor(n / hold)].img.data })
  return { media, total: pages.length * hold, fps: A1_FPS, width, height, seconds: (pages.length * hold) / A1_FPS, names: truth.listedNames, scale, itemsAt: (n) => pages[Math.floor(n / hold)].items }
}

/** Find with the defaults on one A16 recording, then every planted item's ink checked in every frame. */
async function trackFind(ctx, name, c) {
  const home = readerHome(`a16-${name}`)
  const id = `rec-a16-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  af.seed(home, { id, name: `Track ${name}`, media: c.media, seconds: c.seconds, width: c.width, height: c.height, fps: c.fps, cursor: { samples: [], clicks: [], keys: [], shapes: [], scale: c.scale ?? 1, valid: true } })
  const { app, win } = await start(ctx, home)
  await openProject(win, `Track ${name}`)
  const found = await runFind(ctx, win, home, id, { names: c.names ?? [] })
  const units = /\((\d+) units/.exec(found.line)?.[1] ?? '?'
  notBlackedOut(found.project.covers ?? [], c, name)
  const cov = coverageFailures(found.project.covers ?? [], c, 40)
  console.log(`  ${name}: ${c.total} frames, plan ${units} units, ${(found.project.covers ?? []).length} covers, Find ${found.seconds.toFixed(0)} s; ${cov.checked - cov.count} of ${cov.checked} item-frames covered`)
  for (const f of cov.failures) console.log(`    UNCOVERED ${f}`)
  h.assert(cov.count === 0, `${name}: every planted item covered in every frame (${cov.count} item-frames are not)`)
  await offline(app)
  await stop(ctx)
}

/**
 * How much of each frame the covers hide (their union on a grid an eighth of the frame's size), over
 * every `every`-th frame: the mean, the 90th percentile and the most. Covering everything would hide
 * every secret too; this keeps a Find that blacks out the video from passing.
 */
function coveredShare(covers, { total, fps, width, height }, every = 5) {
  const W = Math.ceil(width / 8)
  const H = Math.ceil(height / 8)
  const shares = []
  for (let n = 0; n < total; n += every) {
    const grid = new Uint8Array(W * H)
    for (const [x0, y0, x1, y1] of af.drawnRects(covers, n / fps, fps, width, height)) {
      for (let y = Math.max(0, Math.floor(y0 / 8)); y < Math.min(H, Math.ceil(y1 / 8)); y++) grid.fill(1, y * W + Math.max(0, Math.floor(x0 / 8)), y * W + Math.min(W, Math.ceil(x1 / 8)))
    }
    shares.push(grid.reduce((a, b) => a + b, 0) / grid.length)
  }
  const sorted = [...shares].sort((a, b) => a - b)
  return { mean: shares.reduce((a, b) => a + b, 0) / shares.length, p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted[sorted.length - 1] }
}

/** The covers hide at most a quarter of the frame on average: what Find found, not the whole video. */
function notBlackedOut(covers, rec, label) {
  const share = coveredShare(covers, rec)
  console.log(`  ${label}: covers hide ${(share.mean * 100).toFixed(1)}% of a frame on average (90th percentile ${(share.p90 * 100).toFixed(1)}%, most ${(share.max * 100).toFixed(1)}%)`)
  h.assert(share.mean <= 0.25, `${label}: the covers do not hide the video (${(share.mean * 100).toFixed(1)}% of a frame on average)`)
}

async function main() {
  await test('A1:Find on a recorded fixture covers every planted item in every frame and the export shows none of them', async (ctx) => {
    const home = readerHome('a1')
    const rec = await a1Recordings()
    af.seed(home, { id: 'rec-a1', name: 'Planted', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS })
    let { app, win } = await start(ctx, home)
    await openProject(win, 'Planted')
    const found = await runFind(ctx, win, home, 'rec-a1', { names: rec.names })
    console.log(`  Find took ${found.seconds.toFixed(0)} s: ${found.line}`)
    const covers = found.project.covers ?? []
    h.assert(covers.length > 0, 'Find made covers')
    const check = covers.filter((c) => c.found === 'check').length
    console.log(`  ${covers.length} covers (${covers.filter((c) => c.found === 'auto').length} auto, ${check} to check), ${new Set(covers.map((c) => c.group)).size} groups`)

    // Review lists the rows, Check rows first; Done reviewing keeps them.
    await win.click('[data-testid="privacy-review"]')
    await win.waitForSelector('[data-testid="review-row"]')
    const rows = await win.$$eval('[data-testid="review-row"]', (els) => els.map((e) => ({ status: e.getAttribute('data-status'), check: [...e.querySelectorAll('[data-testid="review-badge"]')].some((b) => b.textContent === 'Check') })))
    console.log(`  Review: ${rows.length} rows, ${rows.filter((r) => r.check).length} to check`)
    h.assert(rows.length > 0, 'Review lists the private rows')
    await privateRowsReadable(win)
    const firstPlain = rows.findIndex((r) => !r.check)
    h.assert(firstPlain < 0 || rows.slice(firstPlain).every((r) => !r.check), 'the Check rows come first')
    await af.docShot(win, 'review')
    await win.click('[data-testid="review-done"]')
    const go = win.locator('[data-testid="review-confirm-go"]')
    if (await go.isVisible().catch(() => false)) await go.click()
    const kept = await af.savedProject(home, 'rec-a1', (p) => (p.covers ?? []).length === covers.length && (p.covers ?? []).every((c) => !c.found), 'Done reviewing keeps every cover as the user\'s')
    await offline(app)

    // Every planted item's ink inside a cover in every source frame, and not the whole video covered.
    notBlackedOut(kept.covers, { ...rec, fps: A1_FPS }, 'A1')
    const cov = coverageFailures(kept.covers, { ...rec, fps: A1_FPS })
    console.log(`  coverage: ${cov.checked - cov.count} of ${cov.checked} item-frames covered`)
    for (const f of cov.failures) console.log(`    UNCOVERED ${f}`)
    h.assert(cov.count === 0, `every planted item covered in every frame (${cov.count} item-frames are not)`)

    // The export, against the same video with other secrets planted.
    const outA = path.join(home, 'a1-a.mp4')
    const outB = path.join(home, 'a1-b.mp4')
    const settings = { format: 'mp4', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto' }
    await exportVideo(app, win, outA, settings)
    await stop(ctx)
    af.relink(home, 'rec-a1', rec.b)
    ;({ app, win } = await start(ctx, home))
    await openProject(win, 'Planted')
    await exportVideo(app, win, outB, settings)
    const cmp = await af.compareOutputs(outA, outB, { exact: false, label: 'A1 export' })
    console.log(`  export: ${cmp.frames} frames, ${cmp.same} identical, files ${cmp.bytes ? 'byte-identical' : 'differ'}, worst frame ${(cmp.worst.share * 100).toFixed(4)}%`)
  })

  await test('A3: Peek and Listen never reach an output', async (ctx) => {
    const home = h.tempHome('a3')
    const fixture = await a2Fixture()
    // The recordings with a 440 Hz tone, and a private bleep at 2-3 s.
    const withTone = (file, tag) => {
      const out = path.join(af.CACHE, `a3-${tag}.mp4`)
      if (!fs.existsSync(out)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(A2.seconds), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', out])
      return out
    }
    const media = { a: withTone(fixture.a, 'a'), b: withTone(fixture.b, 'b') }
    const bleeps = [{ id: 'pb1', start: 2, end: 3, word: ':card:abcdefghij', sound: 'tone', auto: true }]
    for (const side of ['a', 'b']) af.seed(home, { id: `rec-a3-${side}`, name: `Peek ${side}`, media: media[side], seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, extra: { covers: fixture.covers, bleeps, hasAudio: true } })
    const { app, win } = await start(ctx, home)
    const outs = {}
    for (const side of ['a', 'b']) {
      await openProject(win, `Peek ${side}`)
      // Peek under the selected cover (the palette's command), and Listen on the bleep's Review row.
      await af.openShapes(win)
      await win.locator('[data-testid="cover-track"] [data-cover]').first().click({ force: true })
      await runCommand(win, 'peek under', 'Peek under covers')
      await win.waitForSelector('[data-testid="peek-banner"]')
      await win.click('[data-testid="privacy-review"]')
      await win.waitForSelector('[data-testid="review-row"]')
      await privateRowsReadable(win)
      await win.locator('[data-testid="review-listen"]').first().click()
      h.assert((await win.locator('[data-testid="review-listen"][aria-pressed="true"]').count()) === 1, 'Listen is on')
      await af.docShot(win, 'peek')
      const dir = path.join(home, `out-${side}`)
      outs[side] = [{ label: 'mp4 with Peek and Listen on', file: await exportTo(app, win, dir, 'peek.mp4', MP4) }]
      h.assert(!(await win.locator('[data-testid="peek-banner"]').count()), 'an export ends Peek')
      outs[side].push(...(await A2_ROUTES.find((r) => r.name === "thumbnail PNG and the export dialog's preview").run({ app, win, dir: path.join(dir, 'thumb') })))
      await goHome(win)
    }
    await compareSides(outs.a, outs.b, 'Peek')
    // The sound under the private bleep: the recording's tone is gone there, and plays around it.
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', outs.a[0].file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 })
    const tone = (from, to) => {
      // Goertzel at 440 Hz over [from, to) seconds: the tone's share of the signal's power.
      const k = 2 * Math.cos((2 * Math.PI * 440) / 48000)
      let s1 = 0
      let s2 = 0
      let power = 0
      const a = Math.floor(from * 48000)
      const b = Math.floor(to * 48000)
      for (let i = a; i < b; i++) {
        const x = pcm.readInt16LE(i * 2) / 32768
        power += x * x
        const s0 = x + k * s1 - s2
        s2 = s1
        s1 = s0
      }
      const g = s1 * s1 + s2 * s2 - k * s1 * s2
      return { tone: g / ((b - a) / 2), power: power / (b - a) }
    }
    const under = tone(2.1, 2.9)
    const around = tone(0.5, 1.5)
    console.log(`  440 Hz share: under the bleep ${under.tone.toFixed(5)}, before it ${around.tone.toFixed(5)}`)
    h.assert(around.tone > 0.01 && under.tone < around.tone / 100, 'the recording\'s sound is muted under the private bleep in the export with Listen on')
    await offline(app)
  })

  await test('A4: the original recordings are refused while the project hides something (chip, stored choice, forged request)', async (ctx) => {
    const home = h.tempHome('a4')
    const fixture = await a2Fixture()
    af.seed(home, { id: 'rec-a4-plain', name: 'Plain', media: fixture.a, seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps })
    af.seed(home, { id: 'rec-a4-hides', name: 'Hides', media: fixture.a, seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, extra: { covers: fixture.covers } })
    const { app, win } = await start(ctx, home)
    // Capture a real request for the original recordings from a project that hides nothing.
    await app.evaluate(({ ipcMain }) => {
      const orig = ipcMain._invokeHandlers.get('export:writeTimeline')
      ipcMain.removeHandler('export:writeTimeline')
      ipcMain.handle('export:writeTimeline', (e, r) => {
        globalThis.__timeline = r
        return orig(e, r)
      })
    })
    const recordings = { srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, timelines: ['resolve'], timelineMedia: 'recordings' }
    await openProject(win, 'Plain')
    await win.evaluate((b) => localStorage.setItem('export-bundle', JSON.stringify(b)), recordings)
    const plainDir = path.join(home, 'plain')
    await exportTo(app, win, plainDir, 'Plain.mp4', MP4, { keepBundle: true })
    const captured = await app.evaluate(() => globalThis.__timeline)
    h.assert(captured && captured.media === 'recordings', 'a request for the original recordings was made for the plain project')
    h.assert(fs.readdirSync(plainDir).some((f) => f.endsWith(' media')), 'the plain project\'s recordings were copied')
    await goHome(win)

    // With a cover: the chip is disabled with its reason.
    await openProject(win, 'Hides')
    await win.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({ srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, timelines: ['resolve'] })))
    await win.click('header button.primary:has-text("Export")')
    await win.waitForSelector('.modal[aria-label="Export"]')
    const head = win.locator('.modal button.toggle-head')
    if ((await head.count()) && (await head.getAttribute('aria-expanded')) !== 'true') await head.click()
    const chip = win.locator('.modal input[data-media="recordings"]')
    await chip.scrollIntoViewIfNeeded()
    h.assert(await chip.isDisabled(), 'The original recordings is disabled')
    h.assert((await win.locator('[data-testid="export-recordings-off"]').innerText()) === 'The original recordings are not saved while this video hides something.', 'and says why')
    await closeModal(win)
    // A stored choice of the original recordings exports with the notice and no media folder.
    await win.evaluate((b) => localStorage.setItem('export-bundle', JSON.stringify(b)), recordings)
    const hidesDir = path.join(home, 'hides')
    fs.mkdirSync(hidesDir, { recursive: true })
    await win.evaluate((s) => localStorage.setItem('export-settings', JSON.stringify(s)), MP4)
    await h.mockSaveDialog(app, path.join(hidesDir, 'Hides.mp4'))
    await win.click('header button.primary:has-text("Export")')
    await win.waitForSelector('.modal[aria-label="Export"]')
    await h.sleep(500)
    await clickExport(win)
    await af.until(async () => /Export finished/.test((await win.textContent('.modal')) || ''), 'the export finished', 300000)
    const done = (await win.textContent('.modal')) || ''
    h.assert(done.includes('The timeline was not saved: it used the original recordings, and this video hides parts of them.'), `the done view says the timeline was not saved (${done.slice(0, 300)})`)
    h.assert(!fs.readdirSync(hidesDir).some((f) => f.endsWith(' media') || f.endsWith('.fcpxml')), `no media folder and no timeline (${fs.readdirSync(hidesDir)})`)
    await closeModal(win)
    // Main refuses a forged request: the plain project's request, sent again once it hides something.
    const plain = h.readProject(home, 'rec-a4-plain')
    fs.writeFileSync(path.join(h.projectsRoot(home), 'rec-a4-plain', 'project.json'), JSON.stringify({ ...plain, covers: fixture.covers }, null, 2))
    const forged = await win.evaluate((r) => window.api.writeTimeline(r), captured)
    console.log(`  forged request: ${JSON.stringify(forged)}`)
    h.assert(forged.files.length === 0 && forged.problem === 'This video hides parts of its recordings, so they were not copied.', 'main refuses the original recordings of a project that hides something')
    await offline(app)
  })

  await test('A5: a Home thumbnail shows a Dark box where a cover is at its time, drawn through the crop', async (ctx) => {
    const home = h.tempHome('a5')
    const fixture = await a2Fixture()
    const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }
    const cover = { id: 'c1', start: 0, end: A2.seconds, color: '#1c1c22', path: `0.000 ${box.x} ${box.y} ${box.w} ${box.h}` }
    af.seed(home, { id: 'rec-a5', name: 'Thumb', media: fixture.a, seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, extra: { covers: [cover] } })
    af.seed(home, { id: 'rec-a5-crop', name: 'Cropped', media: fixture.a, seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, extra: { covers: [cover], crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } })
    const { app, win } = await start(ctx, home)
    const thumb = (name) =>
      af.until(
        () =>
          win.evaluate(async (n) => {
            const card = [...document.querySelectorAll('.project-open')].find((b) => b.querySelector('.project-name')?.textContent === n)
            const img = card?.querySelector('.project-thumb img')
            if (!img) return null
            await img.decode().catch(() => undefined)
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const g = c.getContext('2d')
            g.drawImage(img, 0, 0)
            return { w: c.width, h: c.height, at: (x, y) => null, data: Array.from(g.getImageData(0, 0, c.width, c.height).data) }
          }, name),
        `the thumbnail of ${name}`,
        30000
      )
    const px = (t, fx, fy) => {
      const i = (Math.floor(fy * t.h) * t.w + Math.floor(fx * t.w)) * 4
      return t.data.slice(i, i + 3)
    }
    const plain = await thumb('Thumb')
    const inside = px(plain, box.x + box.w / 2, box.y + box.h / 2)
    console.log(`  thumbnail ${plain.w}x${plain.h}; the cover's place ${inside}`)
    h.assert(inside.every((v, c) => Math.abs(v - [0x1c, 0x1c, 0x22][c]) <= 10), `a Dark box where the cover is (${inside})`)
    const cropped = await thumb('Cropped')
    console.log(`  cropped thumbnail ${cropped.w}x${cropped.h}`)
    h.assert(Math.abs(cropped.w / cropped.h - A2.width / A2.height) < 0.05, 'the crop keeps the frame\'s shape here')
    const cIn = px(cropped, (box.x + box.w / 2) / 0.5, (box.y + box.h / 2) / 0.5)
    h.assert(cIn.every((v, c) => Math.abs(v - [0x1c, 0x1c, 0x22][c]) <= 10), `drawn through the crop, the cover is where the crop puts it (${cIn})`)
    await af.docShot(win, 'home')
    await offline(app)
  })

  await test('A6: old projects open and save as the build of 37f9355 does; covers reach an older Flown as opaque boxes', async (ctx) => {
    const OLD = process.env.SSW_E2E_OLD_APP || '/home/user/windows-screen-studio'
    h.assert(fs.existsSync(path.join(OLD, 'out', 'main', 'index.js')), `a build of 37f9355 at ${OLD} (SSW_E2E_OLD_APP)`)
    const fixture = await a2Fixture()
    const olds = []
    for (const f of ['vertical-old-projects.json', 'wave8-old-projects.json', 'captions-old-projects.json']) {
      for (const x of JSON.parse(fs.readFileSync(path.join(af.ROOT, 'tests', 'fixtures', f), 'utf8'))) if (x.raw && Array.isArray(x.raw.clips) && x.raw.name) olds.push(x)
    }
    const homes = {}
    for (const side of ['new', 'old']) {
      const home = h.tempHome(`a6-${side}`)
      homes[side] = home
      olds.forEach((x, i) => {
        const raw = { ...x.raw, id: `rec-old-${i}`, name: `Old ${i}` }
        const dir = af.seed(home, { id: raw.id, name: raw.name, media: fixture.a, seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps })
        fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(raw, null, 2))
      })
    }
    const before = olds.map((_, i) => fs.readFileSync(path.join(h.projectsRoot(homes.new), `rec-old-${i}`, 'project.json')))
    for (const side of ['new', 'old']) {
      const { app, logs, win } = await h.launch({ home: homes[side], env: af.appEnv(homes[side]), appDir: side === 'old' ? OLD : af.ROOT })
      ctx.app = app
      ctx.logs = logs
      for (let i = 0; i < olds.length; i++) {
        await openProject(win, `Old ${i}`)
        await win.keyboard.press('Control+s')
        await h.sleep(1200)
        await goHome(win)
      }
      await stop(ctx)
    }
    let unchanged = 0
    olds.forEach((x, i) => {
      const n = fs.readFileSync(path.join(h.projectsRoot(homes.new), `rec-old-${i}`, 'project.json'))
      const o = fs.readFileSync(path.join(h.projectsRoot(homes.old), `rec-old-${i}`, 'project.json'))
      h.assert(n.equals(o), `${x.name}: this build writes the bytes the build of 37f9355 writes`)
      if (n.equals(before[i])) unchanged++
    })
    console.log(`  ${olds.length} old projects: the same bytes as 37f9355 writes (${unchanged} not written at all)`)

    // A project with covers saved by this build holds the legacy shapes; 37f9355 draws them as opaque boxes.
    const home = h.tempHome('a6-legacy')
    for (const side of ['a', 'b']) af.seed(home, { id: `rec-legacy-${side}`, name: `Legacy ${side}`, media: fixture[side], seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, extra: { covers: fixture.covers } })
    const { app, win } = await start(ctx, home)
    for (const side of ['a', 'b']) {
      await openProject(win, `Legacy ${side}`)
      // A change the editor saves: the covers' colour, through the Cover section.
      await af.openShapes(win)
      await win.locator('[data-testid="cover-track"] [data-cover]').first().click({ force: true })
      await win.click('[data-testid="cover-colours"] [data-colour="black"]')
      await af.savedProject(home, `rec-legacy-${side}`, (p) => (p.shapes ?? []).some((s) => String(s.id).startsWith('~cover:')), 'the save holds the legacy shapes', 15000)
      await goHome(win)
    }
    await stop(ctx)
    void app
    const saved = h.readProject(home, 'rec-legacy-a')
    const legacy = (saved.shapes ?? []).filter((s) => String(s.id).startsWith('~cover:'))
    console.log(`  legacy shapes: ${legacy.length} (${[...new Set(legacy.map((s) => s.kind))].join(', ')})`)
    h.assert(legacy.length >= 2 * saved.covers.length && legacy.some((s) => s.kind === 'pixelate') && legacy.some((s) => s.fill && s.opacity === 1), 'two legacy shapes a cover piece: a pixelate and an opaque box')
    // The build of 37f9355 exports both recordings the same between the boxes' fades.
    const outs = {}
    const old = await h.launch({ home, env: af.appEnv(home), appDir: OLD })
    ctx.app = old.app
    ctx.logs = old.logs
    for (const side of ['a', 'b']) {
      await openProject(old.win, `Legacy ${side}`)
      outs[side] = await exportTo(old.app, old.win, path.join(home, `old-${side}`), 'old.mp4', MP4)
      await goHome(old.win)
    }
    // Away from the boxes' fades (0.15 s at each piece's ends), the secrets do not show: the two
    // recordings give the same pixels where they are, and each box is drawn solid. Only the boxes'
    // anti-aliased edges carry the mosaic under them.
    const clean = (n) => n / A2.fps >= 0.9 && n / A2.fps <= A2.seconds - 0.2
    const secrets = (n) => (clean(n) ? a2Secrets(Math.min(A2.seconds * A2.fps - 1, n)).map((r) => [r.x, r.y, r.x + r.w, r.y + r.h]) : [])
    // The boxes' anti-aliased edges differ, so the encoder's own choices move a few levels everywhere
    // near them; the planted noise showing would differ by up to 255.
    const cmp = await af.compareOutputs(outs.a, outs.b, { exact: false, share: 1, levels: 8, regions: secrets, regionShare: 0, label: "37f9355's export" })
    console.log(`  37f9355's export: where the secrets are, no pixel differs by more than 8 levels over the two recordings (worst ${(cmp.worstRegion.share * 100).toFixed(3)}%)`)
    const boxes = legacy.filter((s) => s.kind === 'rect')
    const solid = solidIn(outs.a, { width: A2.width, height: A2.height, fps: A2.fps }, (n) => (clean(n) ? boxes.filter((b) => b.start + 0.2 <= n / A2.fps && n / A2.fps <= b.end - 0.2).map((b) => [Math.ceil(b.x * A2.width) + 3, Math.ceil(b.y * A2.height) + 3, Math.floor((b.x + b.w) * A2.width) - 3, Math.floor((b.y + b.h) * A2.height) - 3, b.id]) : []), 10, 12)
    h.assert(solid.length === 0, `37f9355 draws each legacy box solid (${solid.slice(0, 3).join('; ')})`)
  })

  await test('A8: Find\'s results are one undo step, and a timeline edit made during Find is kept with them', async (ctx) => {
    const home = readerHome('a8')
    const rec = await smallRecordings()
    af.seed(home, { id: 'rec-a8', name: 'Undo', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Undo')
    await af.openShapes(win)
    await win.click('[data-testid="privacy-find"]')
    await win.waitForSelector('[data-testid="find-dialog"]')
    await af.until(() => win.isEnabled('[data-testid="find-start"]'), 'Find is enabled', 60000)
    await win.click('[data-testid="find-start"]')
    await win.waitForSelector('[data-testid="find-progress"]')
    // While Find runs: a zoom added at the playhead (Z).
    await win.locator('.timeline').first().click({ position: { x: 300, y: 10 } }).catch(() => undefined)
    await win.keyboard.press('z')
    const found = await af.savedProject(home, 'rec-a8', (p) => !!p.privacy?.find && (p.covers ?? []).length > 0, 'Find\'s results saved', 30 * 60 * 1000)
    h.assert(found.zooms.length === 1, `the zoom made during Find is kept (${found.zooms.length})`)
    const covers = found.covers.length
    await win.keyboard.press('Control+z')
    const undone = await af.savedProject(home, 'rec-a8', (p) => !(p.covers ?? []).length, 'one undo takes Find\'s results away', 15000)
    h.assert(undone.zooms.length === 1, 'and only them: the zoom stays')
    await win.keyboard.press('Control+Shift+z')
    await af.savedProject(home, 'rec-a8', (p) => (p.covers ?? []).length === covers, 'redo brings them back', 15000)
    console.log(`  ${covers} covers: one undo, one redo; the zoom made during Find kept`)
    await offline(app)
  })

  await test('A12: several covers selected: count, reasons, colour, nudge, delete, undo, copy and paste; three blurs turned into covers', async (ctx) => {
    const home = h.tempHome('a12')
    const fixture = await a2Fixture()
    const covers = [0, 1, 2].map((i) => ({ id: `u${i}`, start: i * 1.5, end: i * 1.5 + 1.2, color: '#1c1c22', path: `0.000 ${0.1 + i * 0.25} 0.2 0.15 0.1` }))
    const shapes = [0, 1, 2].map((i) => ({ id: `b${i}`, kind: 'blur', start: i * 1.5, end: i * 1.5 + 1.2, x: 0.1 + i * 0.25, y: 0.6, w: 0.15, h: 0.1, color: '#000000', strokeWidth: 0, fill: true, opacity: 1, strength: 0.6 }))
    af.seed(home, { id: 'rec-a12', name: 'Several', media: fixture.a, seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, extra: { covers, shapes } })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Several')
    await af.openShapes(win)
    const bars = win.locator('[data-testid="cover-track"] [data-cover]')
    h.assert((await bars.count()) === 3, 'three cover bars')
    await bars.nth(0).click()
    await bars.nth(1).click({ modifiers: ['Control'] })
    await bars.nth(2).click({ modifiers: ['Control'] })
    // Several items open the Selection view; the Shapes tab shows the Cover section for the three.
    await win.waitForSelector('.insp-tabs button:has-text("Selection")')
    await win.click('.insp-tabs button:has-text("Shapes")')
    await win.waitForSelector('[data-testid="cover-section"]')
    const title = await win.locator('[data-testid="cover-section"] h3').innerText()
    h.assert(/^3 covers/i.test(title), `the section counts them (${title})`)
    h.assert(await win.$eval('[data-testid="cover-box"]', (e) => e.disabled && [...e.querySelectorAll('input')].every((i) => i.matches(':disabled'))), 'the box fields are disabled')
    const reason = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="cover-box"]')
      const id = el?.getAttribute('aria-describedby')
      return id ? document.getElementById(id)?.textContent ?? '' : ''
    })
    h.assert(reason.length > 0, `with its reason as its description (${reason})`)
    await af.docShot(win, 'several-covers')
    // Colour, one undo step for all three.
    await win.click('[data-testid="cover-colours"] [data-colour="white"]')
    await af.savedProject(home, 'rec-a12', (p) => p.covers.every((c) => c.color === '#ffffff'), 'all three white')
    await win.keyboard.press('Control+z')
    await af.savedProject(home, 'rec-a12', (p) => p.covers.every((c) => c.color === '#1c1c22'), 'one undo gives all three their colour back')
    // Delete, undo.
    await bars.nth(0).click()
    await bars.nth(1).click({ modifiers: ['Control'] })
    await bars.nth(2).click({ modifiers: ['Control'] })
    await win.keyboard.press('Delete')
    await af.savedProject(home, 'rec-a12', (p) => !(p.covers ?? []).length, 'Delete uncovers all three')
    await win.keyboard.press('Control+z')
    await af.savedProject(home, 'rec-a12', (p) => (p.covers ?? []).length === 3, 'one undo brings the three back')
    // Copy and paste.
    await bars.nth(0).click()
    await bars.nth(1).click({ modifiers: ['Control'] })
    await win.keyboard.press('Control+c')
    await win.keyboard.press('Control+v')
    await af.savedProject(home, 'rec-a12', (p) => (p.covers ?? []).length === 5, 'paste adds the two copied covers')
    // Three blur shapes turned into covers.
    await win.click('[data-testid="privacy-weak-turn"]')
    const turned = await af.savedProject(home, 'rec-a12', (p) => !(p.shapes ?? []).some((s) => s.kind === 'blur') && (p.covers ?? []).length === 8, 'the three blurs are covers')
    console.log(`  ${turned.covers.length} covers after turning the blurs into covers`)
    await offline(app)
  })

  await test('A14: the guide\'s Blur an area adds a cover coloured from the step\'s own shot frame', async (ctx) => {
    const home = h.tempHome('a14')
    const file = path.join(af.CACHE, 'a14-pages.mp4')
    if (!fs.existsSync(file)) {
      fs.mkdirSync(af.CACHE, { recursive: true })
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x2040c0:s=${A2.width}x${A2.height}:r=30:d=2`, '-f', 'lavfi', '-i', `color=c=0xc02020:s=${A2.width}x${A2.height}:r=30:d=2`, '-f', 'lavfi', '-i', `color=c=0x20a040:s=${A2.width}x${A2.height}:r=30:d=2`, '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', '-g', '30', file])
    }
    const clicks = [1, 3, 5].map((t, i) => ({ t, x: 0.3 + 0.2 * i, y: 0.5, button: 'left' }))
    const samples = []
    for (let t = 0; t <= 6; t += 1 / 30) samples.push({ t: +t.toFixed(4), x: 0.3 + 0.2 * Math.min(2, Math.floor(t / 2)), y: 0.5 })
    af.seed(home, { id: 'rec-a14', name: 'Pages', media: file, seconds: 6, width: A2.width, height: A2.height, fps: 30, cursor: { samples, clicks, keys: [], shapes: [], scale: 1, valid: true } })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Pages')
    await win.keyboard.press('Home')
    await openGuide(win)
    // The playhead is on the blue page; step 2's shot is on the red one.
    await win.locator('[data-testid="guide-step"]').nth(1).locator('[data-testid="guide-blur"]').click()
    const p = await af.savedProject(home, 'rec-a14', (q) => (q.covers ?? []).length === 1, 'one cover added')
    const c = p.covers[0]
    const rgb = [1, 3, 5].map((i) => parseInt(c.color.slice(i, i + 2), 16))
    console.log(`  the cover's colour ${c.color} at ${c.start.toFixed(2)}-${c.end.toFixed(2)} s`)
    h.assert(rgb[0] > 150 && rgb[1] < 80 && rgb[2] < 80, `coloured from step 2's shot frame (red), not the paused frame (blue): ${c.color}`)
    h.assert(c.start < 3 && c.end > 2.5, 'over step 2\'s time')
    await offline(app)
  })

  await test('A18: export during Find: the note, Wait for Find, and Stop Find and export, each covering what was found', async (ctx) => {
    const home = readerHome('a18')
    const rec = await smallRecordings()
    for (const id of ['wait', 'stop']) af.seed(home, { id: `rec-a18-${id}`, name: `During ${id}`, media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS })
    const { app, win } = await start(ctx, home)
    const settings = { format: 'mp4', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto' }
    const startFind = async () => {
      await af.openShapes(win)
      await win.click('[data-testid="privacy-find"]')
      await win.waitForSelector('[data-testid="find-dialog"]')
      await af.until(() => win.isEnabled('[data-testid="find-start"]'), 'Find is enabled', 60000)
      await win.click('[data-testid="find-start"]')
      await win.waitForSelector('[data-testid="find-progress"]')
    }
    const openExport = async (out) => {
      await win.evaluate((s) => {
        localStorage.setItem('export-mode', 'single')
        localStorage.setItem('export-settings', JSON.stringify(s))
        localStorage.setItem('export-bundle', JSON.stringify({}))
      }, settings)
      await h.mockSaveDialog(app, out)
      await win.click('header button.primary:has-text("Export")')
      await win.waitForSelector('.modal[aria-label="Export"]')
      await win.waitForSelector('[data-testid="export-note-running"]')
    }
    const waitDone = async () => {
      await af.until(async () => /Export finished/.test((await win.textContent('.modal')) || ''), 'the export finished', 20 * 60 * 1000, 500)
      await closeModal(win)
    }
    const coveredBy = (covers, out) => solidIn(out, rec, (n) => af.drawnRects(covers, n / A1_FPS, A1_FPS, rec.width, rec.height).filter((r) => r[2] - r[0] > 8 && r[3] - r[1] > 8).map((r) => [r[0] + 3, r[1] + 3, r[2] - 3, r[3] - 3, 'a cover']), 30)

    // Wait for Find: Export stays disabled until the results are in, then the export covers them.
    await openProject(win, 'During wait')
    const outWait = path.join(home, 'wait.mp4')
    await startFind()
    await openExport(outWait)
    await af.docShot(win, 'export-running', win.locator('.modal'))
    await win.click('[data-testid="export-note-wait"]')
    h.assert(await win.locator('.modal button.primary', { hasText: 'Export' }).isDisabled(), 'Export is disabled while waiting')
    const found = await af.savedProject(home, 'rec-a18-wait', (p) => !!p.privacy?.find, 'Find finished', 30 * 60 * 1000)
    await af.until(() => win.locator('.modal button.primary', { hasText: 'Export' }).isEnabled(), 'Export enabled once the results are in', 30000)
    await clickExport(win)
    await waitDone()
    const cov = coverageFailures(found.covers, { ...rec, fps: A1_FPS })
    h.assert(cov.count === 0, `Find covered every planted item (${cov.count} item-frames not)`)
    const waitFail = coveredBy(found.covers, outWait)
    h.assert(waitFail.length === 0, `the export after waiting shows every cover (${waitFail.slice(0, 5).join('; ')})`)
    await goHome(win)

    // Stop Find and export: what was found so far is applied and covered.
    await openProject(win, 'During stop')
    const outStop = path.join(home, 'stop.mp4')
    await startFind()
    await af.until(async () => {
      const t = await win.locator('[data-testid="find-progress"]').getAttribute('data-phase')
      return t && t !== 'look'
    }, 'Find reading', 120000).catch(() => undefined)
    await openExport(outStop)
    await win.click('[data-testid="export-note-stop"]')
    await waitDone()
    const stopped = h.readProject(home, 'rec-a18-stop')
    h.assert(!!stopped.privacy?.find, 'Find\'s record is saved')
    console.log(`  stopped Find: ${stopped.covers?.length ?? 0} covers, stopped ${!!stopped.privacy.find.stopped}`)
    const stopFail = coveredBy(stopped.covers ?? [], outStop)
    h.assert(stopFail.length === 0, `the export after Stop Find and export shows every cover found (${stopFail.slice(0, 5).join('; ')})`)
    await offline(app)
  })

  await test('A19: leaving during Find asks first; leaving applies what was found before saving, and it is there when reopened', async (ctx) => {
    const home = readerHome('a19')
    const rec = await smallRecordings()
    af.seed(home, { id: 'rec-a19', name: 'Leave', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Leave')
    await af.openShapes(win)
    await win.click('[data-testid="privacy-find"]')
    await win.waitForSelector('[data-testid="find-dialog"]')
    await af.until(() => win.isEnabled('[data-testid="find-start"]'), 'Find is enabled', 60000)
    await win.click('[data-testid="find-start"]')
    await win.waitForSelector('[data-testid="find-progress"]')
    await h.sleep(4000)
    // First the question is answered No: the editor stays.
    let asked = null
    win.once('dialog', (d) => {
      asked = d.message()
      void d.dismiss()
    })
    await win.click('button[aria-label="Back to recordings"]')
    await af.until(async () => asked !== null, 'leaving asks first', 10000)
    h.assert(asked === 'Find private info is still running. Leave and stop it? What it found so far is kept.', `the question (${asked})`)
    h.assert(await win.locator('.editor').count(), 'No keeps the editor open')
    win.once('dialog', (d) => void d.accept())
    await win.click('button[aria-label="Back to recordings"]')
    await win.waitForSelector('.project-open', { timeout: 60000 })
    const saved = h.readProject(home, 'rec-a19')
    console.log(`  left during Find: ${saved.covers?.length ?? 0} covers saved, stopped ${!!saved.privacy?.find?.stopped}`)
    h.assert(!!saved.privacy?.find?.stopped && (saved.covers ?? []).length > 0, 'what was found is applied and saved before Home shows')
    await openProject(win, 'Leave')
    await af.openShapes(win)
    const count = await win.locator('[data-testid="privacy-count"]').innerText()
    h.assert(/private item/.test(count), `reopened, the covers are there (${count})`)
    await offline(app)
  })

  await test('A21: 200 private rows reviewed by keyboard with Peek while reviewing; the magnified view shows the text; outputs meanwhile have neither', async (ctx) => {
    const home = h.tempHome('a21')
    const fixture = await a2Fixture()
    const covers = []
    for (let i = 0; i < 200; i++) {
      const x = 0.02 + ((i * 37) % 90) / 100
      const y = 0.03 + ((i * 53) % 85) / 100
      const start = +((i * 0.029) % 5.5).toFixed(3)
      covers.push({ id: `f${i}`, start, end: +(start + 0.4).toFixed(3), color: '#1c1c22', path: `0.000 ${x.toFixed(4)} ${y.toFixed(4)} 0.05 0.04`, found: i % 3 ? 'auto' : 'check', kind: 'email', group: `g${String(i).padStart(4, '0')}` })
    }
    // Over the moving secret: one more row whose magnified view must show the noise under it.
    covers.push(fixture.covers[2] && { ...fixture.covers[2], id: 'f200', found: 'check', kind: 'key', group: 'gsecret' })
    for (const side of ['a', 'b']) af.seed(home, { id: `rec-a21-${side}`, name: `Many ${side}`, media: fixture[side], seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps, extra: { covers } })
    const { app, win } = await start(ctx, home)
    const outs = {}
    for (const side of ['a', 'b']) {
      await openProject(win, `Many ${side}`)
      await af.openShapes(win)
      await win.click('[data-testid="privacy-review"]')
      await win.waitForSelector('[data-testid="review-row"]')
      const rows = await win.locator('[data-testid="review-row"]').count()
      h.assert(rows >= 50, `Review lists the private rows (${rows} drawn)`)
      await privateRowsReadable(win)
      await win.locator('[data-testid="review-row"] .review-item').first().focus()
      await win.keyboard.press('v')
      await af.until(async () => (await win.locator('[data-testid="review-peek-all"]').getAttribute('aria-pressed')) === 'true', 'V turns Peek while reviewing on', 5000)
      await win.waitForSelector('[data-testid="peek-inset"]')
      if (side === 'a') await af.docShot(win, 'review-peek')
      const t0 = Date.now()
      for (let i = 0; i < 100; i++) await win.keyboard.press('k')
      console.log(`  100 rows kept by keyboard in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
      h.assert(await win.locator('[data-testid="peek-inset"]').count(), 'the magnified view is still shown')
      const dir = path.join(home, `out-${side}`)
      outs[side] = [{ label: 'mp4 made while reviewing', file: await exportTo(app, win, dir, 'many.mp4', MP4) }]
      outs[side].push(...(await A2_ROUTES.find((r) => r.name === "thumbnail PNG and the export dialog's preview").run({ app, win, dir: path.join(dir, 'thumb') })))
      await goHome(win)
    }
    await compareSides(outs.a, outs.b, 'review at speed')
    await offline(app)
  })

  await test('A7: spoken secrets: private bleeps; captions, a Spanish translation, the SRT, chapter names and the AI requests hold no digit of them; the sound is muted there', async (ctx) => {
    const home = readerHome('a7')
    const rec = await smallRecordings()
    const media = path.join(af.CACHE, 'a7-spoken.mp4')
    if (!fs.existsSync(media)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', rec.a, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(rec.seconds), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', media])
    const words = (start, text) => text.split(' ').map((w, k) => ({ text: w, start: +(start + k * 0.3).toFixed(3), end: +(start + k * 0.3 + 0.25).toFixed(3) }))
    const seg = (id, start, text) => {
      const w = words(start, text)
      return { id, start, end: w[w.length - 1].end, text, words: w }
    }
    const segments = [seg('s0', 0.5, 'My card is 4111 1111 1111 1111.'), seg('s1', 3.5, 'The code is 629153.')]
    const transcript = { language: 'en', provider: 'local', model: 'test', createdAt: '2026-11-20T12:00:00.000Z', segments }
    const src = (t) => require('node:crypto').createHash('sha256').update(t).digest('hex').slice(0, 16)
    const captionTracks = [{ language: 'es', by: 'anthropic', model: 'm', createdAt: '2026-11-20T12:00:00.000Z', segments: [{ id: 's0', text: 'Mi tarjeta es 4111 1111 1111 1111.', src: src(segments[0].text) }, { id: 's1', text: 'El código es 629153.', src: src(segments[1].text) }] }]
    const chapters = [{ id: 'ch1', t: 0, title: 'Intro' }, { id: 'ch2', t: 3.5, title: 'Code 629153' }]
    af.seed(home, { id: 'rec-a7', name: 'Spoken', media, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS, extra: { hasAudio: true, transcript, captionTracks, chapters } })
    const { app, win } = await start(ctx, home)
    // A fake AI service in main, recording every request.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:listProviders')
      ipcMain.handle('ai:listProviders', () => [{ id: 'p-fake', kind: 'anthropic', label: 'Fake', model: 'fake-model', maskedKey: '…abcd', createdAt: '' }])
      ipcMain.removeHandler('ai:text')
      ipcMain.handle('ai:text', (_e, providerId, request) => {
        globalThis.__aiRequests = [...(globalThis.__aiRequests || []), { providerId, request }]
        if (request.task === 'translate') return { task: 'translate', segments: request.segments.map((x) => ({ ...x, text: `[es] ${x.text}` })) }
        if (request.task === 'title') return { task: 'title', text: 'A title' }
        return null
      })
    })
    await openProject(win, 'Spoken')
    const found = await runFind(ctx, win, home, 'rec-a7')
    const priv = (found.project.bleeps ?? []).filter((b) => b.word.startsWith(':'))
    console.log(`  ${priv.length} private bleeps: ${priv.map((b) => `${b.word.split(':')[1]} ${b.start}-${b.end}`).join(', ')}`)
    h.assert(priv.some((b) => b.word.startsWith(':card')) && priv.some((b) => b.word.startsWith(':code')), 'the card number and the code are bleeped')
    // A new Spanish translation through the AI service, and a title asked for: both sent masked.
    await win.evaluate(() => window.dispatchEvent(new Event('ssw:ai-providers-changed')))
    await win.click('.insp-tabs button:has-text("Captions")')
    const languages = '[data-testid="caption-languages"]'
    await win.waitForSelector(`${languages} [data-testid="track-translate"]`, { timeout: 15000 }).catch(async () => {
      await win.click(`${languages} [data-testid="track-add"]`)
    })
    await win.selectOption(`${languages} select`, 'es').catch(() => undefined)
    await win.click(`${languages} [data-testid="track-translate"]`)
    const confirm = win.locator('[data-testid="cost-confirm-run"]')
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click()
    await af.until(async () => (await app.evaluate(() => (globalThis.__aiRequests || []).length)) > 0, 'the translation request sent', 20000)
    const requests = await app.evaluate(() => globalThis.__aiRequests)
    const sent = JSON.stringify(requests)
    console.log(`  AI requests: ${requests.map((r) => r.request.task).join(', ')}`)
    for (const d of ['4111', '1111', '629153', '629', '153']) h.assert(!sent.includes(d), `no AI request holds ${d}`)
    await af.savedProject(home, 'rec-a7', (p) => (p.captionTracks ?? []).some((t) => t.language === 'es' && t.segments.every((x) => x.text.startsWith('[es]'))), 'the new Spanish track saved')
    // The export: SRT in both languages, chapters, and the sound.
    const dir = path.join(home, 'out')
    fs.mkdirSync(dir, { recursive: true })
    await win.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({ srt: true, vtt: true, chapters: true, thumbnail: false, description: false, perChapter: false, languages: ['en', 'es'] })))
    const out = await exportTo(app, win, dir, 'Spoken.mp4', { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'auto' }, { keepBundle: true })
    const texts = fs.readdirSync(dir).filter((f) => /\.(srt|vtt|txt)$/.test(f))
    console.log(`  sidecars: ${texts.join(', ')}`)
    h.assert(texts.some((f) => f.endsWith('.srt')), 'an SRT was written')
    for (const f of texts) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter((l) => l && !/-->/.test(l) && !/^\d+$/.test(l) && !/^WEBVTT/.test(l) && !/^\d+:\d\d/.test(l))
      for (const l of lines) h.assert(!/\d/.test(l), `${f} holds no digit of the secrets ("${l}")`)
    }
    const chaptersMeta = execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', out]).toString()
    const titles = JSON.parse(chaptersMeta).chapters.map((c) => c.tags?.title ?? '')
    console.log(`  chapter titles in the video: ${JSON.stringify(titles)}`)
    h.assert(titles.length === 2 && titles.every((t) => !/629153|629|153/.test(t)), 'the chapter names hold no digit of the code')
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 })
    const tone440 = (from, to) => {
      const k = 2 * Math.cos((2 * Math.PI * 440) / 48000)
      let s1 = 0
      let s2 = 0
      const a = Math.floor(from * 48000)
      const b = Math.floor(to * 48000)
      for (let i = a; i < b; i++) {
        const s0 = pcm.readInt16LE(i * 2) / 32768 + k * s1 - s2
        s2 = s1
        s1 = s0
      }
      return (s1 * s1 + s2 * s2 - k * s1 * s2) / ((b - a) / 2)
    }
    for (const b of priv) {
      const under = tone440(b.start + 0.02, b.end - 0.02)
      h.assert(under < tone440(6.2, 6.8) / 100, `the sound is muted under ${b.word.split(':')[1]} (${b.start}-${b.end} s)`)
    }
    await offline(app)
  })

  await test("A9: the reader's download from a local mirror: download, resume after a cut, a wrong hash refused, Remove", async (ctx) => {
    const http = require('node:http')
    const models = af.modelsDir()
    const files = af.readerFiles()
    const state = { cut: 'PP-OCRv6_small_rec_onnx/inference.onnx', cutDone: false, flip: null, ranges: [] }
    const server = http.createServer((req, res) => {
      const file = decodeURIComponent(req.url.replace(/^\//, ''))
      const f = files.find((x) => x.file === file)
      if (!f) return res.writeHead(404).end()
      let body = fs.readFileSync(path.join(models, ...file.split('/')))
      if (state.flip === file) {
        body = Buffer.from(body)
        body[100] ^= 0xff
      }
      const m = /bytes=(\d+)-/.exec(req.headers.range || '')
      const from = m ? Number(m[1]) : 0
      if (m) state.ranges.push({ file, from })
      res.writeHead(m ? 206 : 200, { 'content-length': body.length - from, ...(m ? { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}), 'accept-ranges': 'bytes' })
      if (file === state.cut && !state.cutDone) {
        state.cutDone = true
        res.write(body.subarray(from, from + 5 * 1024 * 1024))
        setTimeout(() => res.destroy(), 50)
        return
      }
      res.end(body.subarray(from))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}/`
    try {
      const home = h.tempHome('a9')
      const fixture = await a2Fixture()
      af.seed(home, { id: 'rec-a9', name: 'Download', media: fixture.a, seconds: A2.seconds, width: A2.width, height: A2.height, fps: A2.fps })
      const { app, win } = await start(ctx, home, { SSW_READER_BASE_URL: base })
      await openProject(win, 'Download')
      await af.openShapes(win)
      await win.click('[data-testid="privacy-find"]')
      await win.waitForSelector('[data-testid="find-dialog"]')
      await win.click('[data-testid="find-download"]')
      await af.until(() => win.isEnabled('[data-testid="find-start"]'), 'the reader downloaded and ready', 5 * 60 * 1000)
      console.log(`  resumed with Range: ${JSON.stringify(state.ranges)}`)
      h.assert(state.ranges.some((r) => r.file === state.cut && r.from > 0), 'the cut file was resumed from where it stopped')
      const dir = path.join(af.userDataOf(home), 'reader-models')
      for (const f of files) h.assert(af.sha256File(path.join(dir, ...f.file.split('/'))) === f.sha256, `${f.file} is the pinned file`)
      await win.click('[data-testid="find-cancel"]')
      await goHome(win)
      // Remove, from Settings › Private info.
      await win.click('.titlebar button[aria-label="Settings"]')
      await win.waitForSelector('[data-testid="privacy-settings"]')
      await win.locator('[data-testid="privacy-settings-remove"]').scrollIntoViewIfNeeded()
      await af.docShot(win, 'settings', win.locator('[data-testid="privacy-settings"]'))
      await win.click('[data-testid="privacy-settings-remove"]')
      await af.until(async () => !fs.existsSync(dir), 'Remove deletes the files', 15000)
      await win.waitForSelector('[data-testid="privacy-settings-download"]')
      // A file that is not the pinned one is refused, and the reason is shown.
      state.flip = 'PP-OCRv6_tiny_rec_onnx/inference.yml'
      await win.click('[data-testid="privacy-settings-download"]')
      await af.until(async () => /could not|failed|not the file|SHA|check/i.test(await win.locator('[data-testid="privacy-settings-reader"]').innerText()), 'the wrong file is refused and said', 5 * 60 * 1000)
      const line = await win.locator('[data-testid="privacy-settings-reader"]').innerText()
      console.log(`  refused: ${line.replace(/\s+/g, ' ')}`)
      h.assert(!fs.existsSync(path.join(dir, 'PP-OCRv6_tiny_rec_onnx', 'inference.yml')), 'the wrong file is not kept')
      await offline(app, [base.replace(/\/$/, '')])
    } finally {
      server.close()
    }
  })

  await test('A10: a crash in one read: Find ends with the failed-reads line and a lost area over that part', async (ctx) => {
    const home = readerHome('a10')
    const rec = await smallRecordings()
    af.seed(home, { id: 'rec-a10', name: 'Crash', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS })
    const log = path.join(home, 'helper.log')
    const { app, win } = await start(ctx, home, { SSW_OCR_HELPER: path.join(af.ROOT, 'tests', 'fixtures', 'crash-once-ocr-helper.cjs'), SSW_OCR_REAL: af.helperBinary(), SSW_OCR_LOG: log, SSW_OCR_CRASH_READ: '2' })
    await openProject(win, 'Crash')
    const found = await runFind(ctx, win, home, 'rec-a10', { names: rec.names })
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    console.log(`  helper processes: ${lines.filter((l) => l.start).length}; ${found.line}`)
    h.assert(lines.some((l) => l.crashed) && lines.filter((l) => l.start).length === 2, 'the helper crashed in one read and was started once more')
    const rec2 = found.project.privacy.find
    h.assert((rec2.failed ?? 0) >= 1, `Find records the failed read (${rec2.failed})`)
    const lost = (found.project.covers ?? []).filter((c) => c.lost)
    h.assert(lost.length >= 1, `a lost area covers the part that was not read (${lost.length})`)
    await win.click('[data-testid="privacy-review"]')
    await win.waitForSelector('[data-testid="find-result"]')
    const result = await win.locator('[data-testid="find-result"]').innerText()
    console.log(`  result line: ${result.replace(/\s+/g, ' ')}`)
    h.assert(/could not be read|not read/i.test(result), 'the result says areas could not be read')
    notBlackedOut(found.project.covers, { ...rec, fps: A1_FPS }, 'A10')
    const cov = coverageFailures(found.project.covers, { ...rec, fps: A1_FPS })
    h.assert(cov.count === 0, `with the lost area, every planted item is still covered (${cov.count} item-frames not; ${cov.failures.slice(0, 3).join('; ')})`)
    await offline(app)
  })

  await test('A11: the whole flow by keyboard; the dialog, the section, the Covers row and Review pass an accessibility audit', async (ctx) => {
    const home = readerHome('a11')
    const rec = await smallRecordings()
    af.seed(home, { id: 'rec-a11', name: 'Keys', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Keys')
    await af.openShapes(win)
    const audit = (root) =>
      win.evaluate((sel) => {
        const out = []
        const scope = document.querySelector(sel)
        if (!scope) return [`${sel} is not shown`]
        const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')?.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ') || el.textContent || el.getAttribute('title') || (el.labels && el.labels[0]?.textContent) || el.closest('label')?.textContent || '').trim()
        for (const el of scope.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="menuitemradio"], [role="option"], [tabindex]')) {
          if (el.closest('[hidden], [aria-hidden="true"]') && el.tabIndex >= 0 && !el.disabled) out.push(`focusable inside aria-hidden: ${el.outerHTML.slice(0, 80)}`)
          if (el.getAttribute('tabindex') === '-1' && !el.matches('button, input, select, textarea, a[href], [role]')) continue
          if (!name(el) && el.type !== 'hidden') out.push(`no accessible name: ${el.outerHTML.slice(0, 100)}`)
        }
        for (const attr of ['aria-describedby', 'aria-labelledby', 'aria-controls']) {
          for (const el of scope.querySelectorAll(`[${attr}]`)) for (const id of el.getAttribute(attr).split(/\s+/)) if (id && !document.getElementById(id) && !(attr === 'aria-controls' && el.getAttribute('aria-expanded') === 'false')) out.push(`${attr} names a missing id ${id}`)
        }
        const ids = [...scope.querySelectorAll('[id]')].map((e) => e.id)
        for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) out.push(`duplicate id ${id}`)
        for (const d of scope.querySelectorAll('[role="dialog"]')) if (!d.getAttribute('aria-labelledby') && !d.getAttribute('aria-label')) out.push('a dialog without a name')
        for (const m of scope.querySelectorAll('[role="menu"]')) if (!m.querySelector('[role^="menuitem"]')) out.push('a menu without items')
        return out
      }, root)
    const problems = []
    // The section, reached and used by keyboard: Find private info… opens the dialog with Enter.
    problems.push(...(await audit('[data-testid="privacy-section"]')).map((p) => `section: ${p}`))
    await win.focus('[data-testid="privacy-find"]')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid="find-dialog"]')
    const firstFocus = await win.evaluate(() => document.activeElement?.closest('[data-testid="find-dialog"]') !== null && document.activeElement?.tagName)
    h.assert(firstFocus === 'INPUT', `the dialog puts the focus on its first checkbox (${firstFocus})`)
    problems.push(...(await audit('[data-testid="find-dialog"]')).map((p) => `dialog: ${p}`))
    await af.docShot(win, 'find-dialog', win.locator('[data-testid="find-dialog"]'))
    await af.until(() => win.isEnabled('[data-testid="find-start"]'), 'Find is enabled', 60000)
    // Tab to Find and press Enter.
    for (let i = 0; i < 60; i++) {
      if ((await win.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'find-start') break
      await win.keyboard.press('Tab')
    }
    h.assert((await win.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'find-start', 'Tab reaches Find')
    await win.keyboard.press('Enter')
    await af.until(async () => (await win.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'find-progress', 'the focus goes to the progress line', 10000).catch(() => problems.push('focus did not go to the progress line'))
    await af.docShot(win, 'find-running', win.locator('[data-testid="privacy-section"]'))
    await af.savedProject(home, 'rec-a11', (p) => !!p.privacy?.find, 'Find finished', 10 * 60 * 1000)
    // The Covers row: one tab stop, arrows move, selection follows focus.
    await win.waitForSelector('[data-testid="cover-track"]')
    problems.push(...(await audit('[data-testid="cover-track"]')).map((p) => `Covers row: ${p}`))
    const stops = await win.$$eval('[data-testid="cover-track"] [tabindex="0"]', (els) => els.length)
    h.assert(stops === 1, `the Covers row is one tab stop (${stops})`)
    await win.focus('[data-testid="cover-track"] [tabindex="0"]')
    await win.keyboard.press('ArrowRight')
    await af.until(async () => (await win.locator('[data-testid="cover-section"]').count()) > 0, 'selection follows the focus into the Cover section', 5000)
    await af.docShot(win, 'covers-row', win.locator('[data-testid="cover-track"]'))
    // Review by keyboard: K keeps, the list says so.
    await win.click('[data-testid="privacy-review"]')
    await win.waitForSelector('[data-testid="review-row"]')
    problems.push(...(await audit('.review-panel, [data-testid="review-private"]')).map((p) => `Review: ${p}`))
    await win.locator('[data-testid="review-row"] .review-item').first().focus()
    await win.keyboard.press('k')
    await af.until(async () => (await win.locator('[data-testid="review-row"][data-status="kept"]').count()) >= 1, 'K keeps the row', 5000)
    for (const p of problems) console.log(`    a11y: ${p}`)
    h.assert(problems.length === 0, `no accessibility problem (${problems.length})`)
    console.log('  audited: the section, Find\'s dialog, the Covers row and Review (axe-core is not installed here; the audit checks names, references, ids, dialogs and menus)')
    await offline(app)
  })

  await test('A13: Polish with Find private info on a recording with captions', async (ctx) => {
    const home = readerHome('a13')
    const rec = await smallRecordings()
    const words = (start, text) => text.split(' ').map((w, k) => ({ text: w, start: +(start + k * 0.3).toFixed(3), end: +(start + k * 0.3 + 0.25).toFixed(3) }))
    const w0 = words(0.5, 'The code is 629153.')
    const transcript = { language: 'en', provider: 'local', model: 'test', createdAt: '2026-11-20T12:00:00.000Z', segments: [{ id: 's0', start: 0.5, end: w0[w0.length - 1].end, text: 'The code is 629153.', words: w0 }] }
    af.seed(home, { id: 'rec-a13', name: 'Polished', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS, extra: { transcript } })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Polished')
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await win.keyboard.press('Shift+P')
    await win.locator('.polish-dialog[role="dialog"]').waitFor({ timeout: 10000 })
    const row = win.locator('[data-testid="polish-row-privacy"]')
    await row.waitFor({ timeout: 15000 })
    // Only Find private info: every other step off.
    for (const r of await win.locator('[data-testid^="polish-row-"]').all()) {
      const box = r.locator('input[type="checkbox"]').first()
      if (!(await box.count())) continue
      const id = await r.getAttribute('data-testid')
      const want = id === 'polish-row-privacy'
      if ((await box.isChecked()) !== want && (await box.isEnabled())) await box.click()
    }
    h.assert(await row.locator('input[type="checkbox"]').first().isChecked(), 'Find private info is on')
    await af.docShot(win, 'polish', win.locator('.polish-dialog[role="dialog"]'))
    await win.click('.polish-dialog .modal-foot button.primary:has-text("Polish")')
    await win.waitForSelector('[data-testid="polish-summary"]', { timeout: 10 * 60 * 1000 })
    const line = await win.locator('[data-testid="polish-line-privacy"]').innerText().catch(() => '')
    const p = await af.savedProject(home, 'rec-a13', (q) => (q.covers ?? []).length > 0, 'Polish applied the covers', 60000)
    const priv = (p.bleeps ?? []).filter((b) => b.word.startsWith(':'))
    console.log(`  Polish: ${p.covers.length} covers, ${priv.length} private bleeps; "${line.replace(/\s+/g, ' ')}"`)
    h.assert(priv.length >= 1, 'the code said aloud is bleeped')
    notBlackedOut(p.covers, { ...rec, fps: A1_FPS }, 'A13')
    const cov = coverageFailures(p.covers, { ...rec, fps: A1_FPS })
    h.assert(cov.count === 0, `every planted item covered (${cov.count} item-frames not; ${cov.failures.slice(0, 3).join('; ')})`)
    await offline(app)
  })

  await test('A15: Follow what is under it keeps a cover on a scrolled email; Cover this text everywhere covers its other places', async (ctx) => {
    const home = readerHome('a15')
    const rec = await smallRecordings()
    const first = rec.itemsAt(0)
    const counts = new Map()
    for (const it of [...first, ...rec.itemsAt(rec.total - 1)]) counts.set(it.text, (counts.get(it.text) || 0) + 1)
    const email = first.find((it) => it.kind === 'email' && counts.get(it.text) >= 2) || first.find((it) => it.kind === 'email')
    h.assert(email, 'an email on the first page')
    const pad = 6
    const [x0, y0, x1, y1] = email.ink
    const cover = { id: 'mine', start: 0.5, end: 4.5, color: '#1c1c22', path: af.pathOf([{ t: 0.5, x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }], rec.width, rec.height) }
    af.seed(home, { id: 'rec-a15', name: 'Follow', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS, extra: { covers: [cover] } })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Follow')
    await af.openShapes(win)
    await win.locator('[data-testid="cover-track"] [data-cover]').first().click({ force: true })
    await win.waitForSelector('[data-testid="cover-section"]')
    await win.click('[data-testid="cover-follow"]')
    const followed = await af.savedProject(home, 'rec-a15', (p) => af.parsePath(p.covers.find((c) => c.id === 'mine')?.path ?? '0').length > 3, 'Follow wrote a moving path', 5 * 60 * 1000)
    const mine = followed.covers.find((c) => c.id === 'mine')
    console.log(`  followed: ${af.parsePath(mine.path).length} keys, ${mine.start}-${mine.end} s`)
    const only = (pred) => ({ ...rec, fps: A1_FPS, itemsAt: (n) => rec.itemsAt(n).filter(pred) })
    const span = (n) => n / A1_FPS >= cover.start && n / A1_FPS < cover.end
    const fcov = coverageFailures([mine], { ...only((it) => it.id === email.id), itemsAt: (n) => (span(n) ? rec.itemsAt(n).filter((it) => it.id === email.id && it.frame === email.frame) : []) })
    h.assert(fcov.count === 0, `the email stays covered while it scrolls (${fcov.count} frames not; ${fcov.failures.slice(0, 3).join('; ')})`)
    // Cover this text everywhere.
    await win.click('[data-testid="cover-everywhere"]')
    await win.waitForSelector('[data-testid="everywhere-dialog"]')
    await af.docShot(win, 'everywhere', win.locator('[data-testid="everywhere-dialog"]'))
    await win.click('[data-testid="everywhere-start"]')
    await win.waitForSelector('[data-testid="everywhere-done"]', { timeout: 10 * 60 * 1000 })
    const done = await win.locator('[data-testid="everywhere-done"]').innerText()
    await win.click('[data-testid="everywhere-close"]')
    const all = await af.savedProject(home, 'rec-a15', (p) => p.covers.length > 1 || /no other/i.test(done), 'the other places covered', 30000)
    console.log(`  everywhere: "${done.replace(/\s+/g, ' ')}"; ${all.covers.length} covers`)
    const ecov = coverageFailures(all.covers, only((it) => it.text === email.text))
    h.assert(ecov.count === 0, `every place of "${email.text}" covered (${ecov.count} item-frames not; ${ecov.failures.slice(0, 3).join('; ')})`)
    await offline(app)
  })

  // A16: the rendered tracking set, every planted item covered in every source frame.
  for (const id of TRACK_CASES) await test(`A16: the tracking set, ${id}`, (ctx) => trackFind(ctx, id, trackCase(id)))
  await test('A16: the evaluation frames at 150% display scale', async (ctx) => trackFind(ctx, 'scale 150%', await evalSetCase('s15', ['--scale', '1.5'], 1.5)))
  await test('A16: the evaluation frames at 200% display scale', async (ctx) => trackFind(ctx, 'scale 200%', await evalSetCase('s2', ['--scale', '2'], 2)))
  await test('A16: the held-out frames of a new seed (9000)', async (ctx) => trackFind(ctx, 'held-out 9000', await evalSetCase('h9000', ['--holdout', '--seed', '9000'], 1)))

  await test('A17: the English guard passes on the merged tree (guard-delta first, the baseline re-recorded only then)', async () => {
    const r = require('node:child_process').spawnSync(process.execPath, [path.join(af.ROOT, 'tests', 'e2e', 'english-guard.e2e.cjs')], { stdio: 'inherit', env: { ...process.env, SSW_E2E_ONLY: '' } })
    if (r.status !== 0) {
      const d = require('node:child_process').spawnSync(process.execPath, [path.join(af.ROOT, 'scripts', 'i18n', 'guard-delta.mjs')], { encoding: 'utf8' })
      console.log(d.stdout.split('\n').slice(-12).join('\n'))
    }
    h.assert(r.status === 0, 'the English guard passes in compare mode')
  })

  await test('A20: copies made before Find: Also cover the copies, and Bring them over, each covering the planted items', async (ctx) => {
    const home = readerHome('a20')
    const rec = await a1Recordings()
    const NOUNS = ['invoice', 'report', 'billing page', 'export', 'chart', 'customer list', 'refund', 'tax setting', 'payment', 'team folder']
    const segments = []
    for (let n = 0; n < 18; n++) {
      const text = `${n % 7 === 0 ? 'How does the' : 'The'} ${NOUNS[n % NOUNS.length]} work for item ${['one', 'two', 'three', 'four', 'five', 'six'][n % 6]}${n % 7 === 0 ? '?' : '.'}`
      const start = 1 + n * 3
      const w = text.split(' ').map((x, k) => ({ text: x, start: +(start + k * 0.3).toFixed(3), end: +(start + k * 0.3 + 0.25).toFixed(3) }))
      segments.push({ id: `s${n}`, start, end: w[w.length - 1].end, text, words: w })
    }
    const transcript = { language: 'en', provider: 'local', model: 'test', createdAt: '2026-11-20T12:00:00.000Z', segments }
    af.seed(home, { id: 'rec-a20', name: 'Original', media: rec.a, seconds: rec.seconds, width: rec.width, height: rec.height, fps: A1_FPS, extra: { transcript } })
    const { app, win } = await start(ctx, home)
    await openProject(win, 'Original')
    // Before Find: a short clip, then a duplicate.
    let before = h.listProjects(home)
    await win.click('[data-testid=copy-menu]')
    await win.click('[data-testid=copy-clips]')
    await win.waitForSelector('[data-testid="clips-panel"]')
    await af.until(async () => (await win.locator('[data-testid="clips-row"]').count()) > 0, 'moments for short clips', 60000)
    await win.locator('input[aria-label="Make clip 1"]').check()
    await win.locator('[data-testid="clips-make"]').click()
    const clipId = await af.until(async () => h.listProjects(home).find((p) => !before.includes(p) && !fs.existsSync(path.join(h.projectsRoot(home), p, '.copying'))), 'the short clip made', 60000)
    await win.keyboard.press('Escape')
    before = h.listProjects(home)
    await win.click('[data-testid=copy-menu]')
    await win.click('[data-testid=copy-duplicate]')
    const dupId = await af.until(async () => h.listProjects(home).find((p) => !before.includes(p) && !fs.existsSync(path.join(h.projectsRoot(home), p, '.copying'))), 'the duplicate made', 60000)
    await af.until(async () => (await win.inputValue('input.title-input').catch(() => '')) === h.readProject(home, dupId).name, 'the duplicate opens', 30000)
    await goHome(win)
    await openProject(win, 'Original')
    await runFind(ctx, win, home, 'rec-a20', { names: rec.names })
    // The duplicate first: its export dialog says the original has covers it does not, and Bring them over brings them.
    await goHome(win)
    const dupName = h.readProject(home, dupId).name
    await openProject(win, dupName)
    await win.click('header button.primary:has-text("Export")')
    await win.waitForSelector('[data-testid="export-note-from-original"]', { timeout: 30000 })
    await win.click('[data-testid="export-note-bring-over"]')
    await af.savedProject(home, dupId, (p) => (p.covers ?? []).length > 0, 'Bring them over adds the covers', 30000)
    await win.keyboard.press('Escape').catch(() => undefined)
    if (await win.locator('.modal').count()) await closeModal(win).catch(() => undefined)
    await goHome(win)
    // The original's Review: Also cover the copies.
    await openProject(win, 'Original')
    await af.openShapes(win)
    await win.click('[data-testid="privacy-review"]')
    await win.waitForSelector('[data-testid="copies-offer"]')
    await win.click('[data-testid="copies-offer"]')
    await win.waitForSelector('[data-testid="copies-done"]')
    console.log(`  ${(await win.locator('[data-testid="copies-done"]').innerText()).trim()}`)
    await af.savedProject(home, clipId, (p) => (p.covers ?? []).length > 0, 'the clip has the covers', 30000)
    await goHome(win)
    // Each copy's export, from the recording and from the one with other secrets: the same.
    const outs = { a: {}, b: {} }
    for (const side of ['a', 'b']) {
      if (side === 'b') for (const id of [clipId, dupId]) af.relink(home, id, rec.b)
      for (const id of [clipId, dupId]) {
        await openProject(win, h.readProject(home, id).name)
        outs[side][id] = await exportTo(app, win, path.join(home, `out-${side}`), `${id}.mp4`, { format: 'mp4', resolution: 720, fps: 30, quality: 'high', encoder: 'auto' })
        await goHome(win)
      }
    }
    for (const [id, label] of [[clipId, 'the short clip'], [dupId, 'the duplicate']]) {
      const cmp = await af.compareOutputs(outs.a[id], outs.b[id], { label })
      console.log(`  ${label}: ${cmp.frames} frames, ${cmp.same} identical${cmp.bytes ? ', byte-identical' : ''}`)
    }
    await offline(app)
  })

  // A2: every output covers; each route its own case, made from both recordings and compared.
  const route = (name) => A2_ROUTES.find((r) => r.name === name)
  for (const r of A2_ROUTES) {
    await test(`A2: ${r.name} covers (made from two recordings with other secrets under the covers, compared)`, async (ctx) => {
      const chapters = r.name.startsWith('per-chapter') ? { chapters: [{ id: 'ch1', t: 0, title: 'Start' }, { id: 'ch2', t: 3, title: 'Billing' }] } : {}
      await a2Case(ctx, { name: r.name, routes: [r], extra: chapters })
    })
  }
  await test('A2 control: without covers the same routes differ, so the comparison sees what is under the covers', async (ctx) => {
    await a2Case(ctx, { name: 'control', differ: true, routes: [route('MP4'), route('thumbnail PNG and the export dialog\'s preview'), route('the guide\'s shots, PDF and HTML pictures (A2e)')] })
  })
  await test('A2a: joins, a crossfade and a slide over cuts inside the covers\' time, cover', async (ctx) => {
    const clips = [
      { id: 'c0', start: 0, end: 2, speed: 1 },
      { id: 'c1', start: 2.4, end: 4.2, speed: 1 },
      { id: 'c2', start: 4.5, end: 6, speed: 1 }
    ]
    const joins = { cuts: [{ clip: 'c1', kind: 'crossfade', duration: 0.3 }, { clip: 'c2', kind: 'slide', duration: 0.4, from: 'right' }] }
    await a2Case(ctx, { name: 'A2a joins', extra: { clips, joins }, routes: [route('MP4')] })
  })
  await test('A2b: the 9:16 copy with the follow camera, made from the Copies menu, covers', async (ctx) => {
    const vertical = {
      name: 'vertical copy',
      run: async ({ app, win, home, dir }) => {
        const before = h.listProjects(home)
        await win.click('[data-testid=copy-menu]')
        await win.waitForSelector('[role=menu]', { timeout: 5000 })
        await win.click('[data-testid=copy-vertical]')
        const id = await af.until(async () => h.listProjects(home).find((p) => !before.includes(p) && !fs.existsSync(path.join(h.projectsRoot(home), p, '.copying'))), 'the vertical copy made', 60000)
        const copy = h.readProject(home, id)
        h.assert(copy.style.aspectRatio === '9:16' && copy.reframe?.mode === 'follow', `the copy is 9:16 and follows (${copy.style.aspectRatio}, ${JSON.stringify(copy.reframe)})`)
        h.assert((copy.covers ?? []).length === 3, `the copy keeps the three covers (${(copy.covers ?? []).length})`)
        await af.until(async () => (await win.inputValue('input.title-input').catch(() => '')) === copy.name, 'the copy opens', 30000)
        await h.sleep(800)
        return [{ label: 'vertical copy', file: await exportTo(app, win, dir, 'vertical.mp4', MP4) }]
      }
    }
    await a2Case(ctx, { name: 'A2b vertical', routes: [vertical] })
  })
  await test('A2c: a title card with the blurred-frame background over a cover covers', async (ctx) => {
    const titles = [{ id: 't1', start: 1.5, end: 4, title: 'Billing', subtitle: 'Where the invoices are', style: 'centered', background: 'blur' }]
    await a2Case(ctx, { name: 'A2c title', extra: { titles }, routes: [route('MP4'), route('thumbnail PNG and the export dialog\'s preview')] })
  })
  await test('A2d: the raw-frame route to ffmpeg covers (MP4 and WebM)', async (ctx) => {
    await a2Case(ctx, { name: 'A2d raw', env: { SSW_EXPORT_VIDEO_ENCODER: 'ffmpeg' }, routes: [route('MP4'), route('WebM')] })
  })
  await test('A2d: the WebCodecs route covers', async (ctx) => {
    await a2Case(ctx, { name: 'A2d webcodecs', env: { SSW_EXPORT_VIDEO_ENCODER: 'webcodecs-software' }, routes: [route('MP4')], lossy: ['mp4'] })
  })
  await test('A2f: motion blur, a magnifier and a blur shape beside covers: the whole frame is the same', async (ctx) => {
    const extra = {
      effects: { motionBlur: 0.8, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
      zooms: [{ id: 'z1', start: 1, end: 4.5, scale: 1.8, focus: { mode: 'fixed', x: 0.4, y: 0.35 }, auto: false }],
      spotlights: [{ id: 'm1', start: 0, end: 6, mode: 'region', x: 0.06, y: 0.1, w: 0.25, h: 0.12, shape: 'rect', dim: 0.2, feather: 0.2, magnify: 2 }],
      shapes: [{ id: 'bl1', kind: 'blur', start: 0, end: 6, x: 0.6, y: 0.69, w: 0.16, h: 0.12, color: '#000000', strokeWidth: 0, fill: true, opacity: 1, strength: 0.9 }]
    }
    await a2Case(ctx, { name: 'A2f effects', extra, routes: [route('MP4'), route('thumbnail PNG and the export dialog\'s preview')] })
  })
  for (const graded of [false, true]) {
    await test(`A2g: a cropped project${graded ? ' with a grade and a LUT' : ''}, a moving cover 10 px inside the crop's edge, covers`, async (ctx) => {
      const crop = { x: 110 / A2.width, y: 150 / A2.height, w: 1000 / A2.width, h: 500 / A2.height }
      const lut = ['TITLE "Warm"', 'LUT_3D_SIZE 2']
      for (const b of [0, 1]) for (const g of [0, 1]) for (const r of [0, 1]) lut.push(`${(r * 0.9 + 0.06).toFixed(4)} ${(g * 0.93 + 0.02).toFixed(4)} ${(b * 0.8 + 0.03).toFixed(4)}`)
      const text = `${lut.join('\n')}\n`
      const sha = require('node:crypto').createHash('sha256').update(text).digest('hex')
      const grade = graded ? { grade: { screen: { contrast: 0.25, saturation: -0.3, lut: { file: 'lut-1.cube', sha256: sha, title: 'Warm', size: 2 } } } } : {}
      await a2Case(ctx, {
        name: graded ? 'A2g graded' : 'A2g cropped',
        extra: { crop, ...grade },
        prepare: (home, pair) => {
          if (graded) for (const id of Object.values(pair.ids)) fs.writeFileSync(path.join(h.projectsRoot(home), id, 'lut-1.cube'), text)
        },
        routes: [route('MP4'), route('thumbnail PNG and the export dialog\'s preview')]
      })
    })
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
