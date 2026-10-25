// Smarter auto zoom (NW-03, docs/design/smarter-auto-zoom.md) end to end, on seeded projects:
// ignoring stray clicks (timeline markers, Delete, the Selected click section, "Find stray
// clicks", "Ignore this click", undo) with the effect and the sound checked in a real export;
// straightened cursor moves (the option, a range kept as recorded, undo) measured in exported
// frames and on the preview; and auto zoom following scrolling, with the camera measured from
// the pixels of a gradient recording. Set SSW_E2E_SHOTS=<dir> to save screenshots of the new UI.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const FPS = 60
const W = 1280
const H = 720
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)
const at = (t) => Math.round(t * FPS)
const NATIVE = { method: 'native', cursorInVideo: false, region: null }
const GRAY_STYLE = { background: { type: 'color', color: '#808080' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
// The gradient recording sits on a green card with 10% padding (the camera is measured inside it).
const STYLE = { background: { type: 'color', color: '#00ff00' }, padding: 0.1, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }
const near = (a, b, eps) => Math.abs(a - b) <= eps

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const track = (samples, clicks = [], extra = {}) => ({ samples, clicks, keys: [], shapes: [], scale: 1, valid: true, ...extra })

/** 60 fps recording whose pixel (x, y) is rgb(255 x, 255 y, 128) in normalised coordinates (as zoom.e2e.cjs). */
function gradientVideo(seconds) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `grad-${seconds}s-${W}x${H}.mp4`)
  if (fs.existsSync(file)) return file
  const png = `${file}.png`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=${W}x${H},format=rgb24,geq=r='X*255/(W-1)':g='Y*255/(H-1)':b=128`, '-frames:v', '1', png])
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-framerate', String(FPS), '-i', png, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-g', '15', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp])
  fs.renameSync(tmp, file)
  fs.rmSync(png)
  return file
}

/* ---------- the camera, measured from the pixels of the gradient (as zoom.e2e.cjs) ---------- */

function fit(points) {
  const n = points.length
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  return { m, q: (sy - m * sx) / n }
}

const isContent = (b) => b > 90 && b < 170
const unclipped = (r, g) => r > 8 && r < 247 && g > 8 && g < 247

function fitPlane(pts) {
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  const b = [0, 0, 0]
  for (const [u, v, z] of pts) {
    const row = [1, u, v]
    for (let i = 0; i < 3; i++) {
      b[i] += row[i] * z
      for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]
    }
  }
  for (let i = 0; i < 3; i++) {
    for (let k = i + 1; k < 3; k++) {
      const q = A[k][i] / A[i][i]
      for (let j = i; j < 3; j++) A[k][j] -= q * A[i][j]
      b[k] -= q * b[i]
    }
  }
  const c = [0, 0, 0]
  for (let i = 2; i >= 0; i--) c[i] = (b[i] - A[i].slice(i + 1).reduce((s, a, j) => s + a * c[i + 1 + j], 0)) / A[i][i]
  return c
}

function line(buf, w, hgt, { row, col, inset = 6 }) {
  const pts = []
  const n = row !== undefined ? w : hgt
  for (let i = 0; i < n; i++) {
    const p = row !== undefined ? (row * w + i) * 3 : (i * w + col) * 3
    if (isContent(buf[p + 2])) pts.push([i, buf[p], buf[p + 1]])
  }
  if (pts.length === 0) return { pts }
  const lo = pts[0][0]
  const hi = pts[pts.length - 1][0]
  return { pts: pts.filter(([i, r, g]) => i >= lo + inset && i <= hi - inset && unclipped(r, g)) }
}

function measure(frame, w, hgt, cal, card) {
  const rowLine = line(frame, w, hgt, { row: Math.round(card.y + card.h / 2) })
  const colLine = line(frame, w, hgt, { col: Math.round(card.x + card.w / 2) })
  const fxLine = fit(rowLine.pts.map(([i, r, g]) => [i, cal.toSource(r, g).u]))
  const fyLine = fit(colLine.pts.map(([i, r, g]) => [i, cal.toSource(r, g).v]))
  const srcAt = (l, p) => l.m * (p - 0.5) + l.q
  return { scale: 1 / (fxLine.m * card.w), cx: srcAt(fxLine, card.x + card.w / 2), cy: srcAt(fyLine, card.y + card.h / 2) }
}

function calibrate(frame, w, hgt, card) {
  const reds = []
  const greens = []
  for (let y = Math.ceil(card.y + 8); y < card.y + card.h - 8; y += 4) {
    for (let x = Math.ceil(card.x + 8); x < card.x + card.w - 8; x += 4) {
      const p = (y * w + x) * 3
      const [r, g, b] = [frame[p], frame[p + 1], frame[p + 2]]
      if (!isContent(b) || !unclipped(r, g)) continue
      const u = (x + 0.5 - card.x) / card.w
      const v = (y + 0.5 - card.y) / card.h
      reds.push([u, v, r])
      greens.push([u, v, g])
    }
  }
  const [r0, ru, rv] = fitPlane(reds)
  const [g0, gu, gv] = fitPlane(greens)
  const det = ru * gv - rv * gu
  return {
    toSource(r, g) {
      const dr = r - r0
      const dg = g - g0
      return { u: (dr * gv - rv * dg) / det, v: (ru * dg - dr * gu) / det }
    }
  }
}

/** The preview canvas as an RGB buffer. */
async function previewFrame(win) {
  return win.evaluate(() => {
    const c = document.querySelector('.preview-canvas')
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    const rgb = new Array(c.width * c.height * 3)
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]
      rgb[j + 1] = data[i + 1]
      rgb[j + 2] = data[i + 2]
    }
    return { w: c.width, h: c.height, rgb }
  })
}

function previewCard(w, hgt, padding = 0.1) {
  const pad = Math.min(w, hgt) * padding
  const s = Math.min((w - 2 * pad) / W, (hgt - 2 * pad) / H)
  return { x: (w - W * s) / 2, y: (hgt - H * s) / 2, w: W * s, h: H * s }
}

async function previewCalibration(win) {
  const p = await previewFrame(win)
  return calibrate(p.rgb, p.w, p.h, previewCard(p.w, p.h))
}

async function previewCamera(win, cal) {
  const p = await previewFrame(win)
  return measure(p.rgb, p.w, p.h, cal, previewCard(p.w, p.h))
}

/* ---------- the drawn cursor ---------- */

/** Centroid of the white cursor's bright pixels in an RGB buffer (null when none). */
function cursorCentroid(rgb, w, hgt) {
  let n = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3
      if (rgb[p] > 225 && rgb[p + 1] > 225 && rgb[p + 2] > 225) {
        n++
        sx += x
        sy += y
      }
    }
  }
  return n ? { x: sx / n + 0.5, y: sy / n + 0.5, n } : null
}

/** Reddish pixels of an RGB frame (the red click ring over grey). */
function reddish(rgb) {
  let n = 0
  for (let p = 0; p < rgb.length; p += 3) if (rgb[p] > 170 && rgb[p + 1] < 110 && rgb[p + 2] < 110) n++
  return n
}

/* ---------- editor helpers ---------- */

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

async function boxOf(win, selector) {
  return win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.left, top: b.top }
  })
}

async function seekTo(win, t) {
  const x = await xForTime(win, t)
  const { y } = await boxOf(win, '.tl-ruler')
  await win.mouse.click(x, y)
  await h.sleep(350)
}

/** Puts the playhead exactly on `t` (a multiple of 1/30 s): Home, then one frame step (1/30 s) at a time. */
async function seekExact(win, t) {
  await win.keyboard.press('Home')
  for (let i = 0; i < Math.round(t * 30); i++) await win.keyboard.press('ArrowRight')
  await h.sleep(400)
}

/** Waits until autosave has written a project.json for which `pred` holds; returns it. */
function saved(home, id, pred, message) {
  return f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return pred(p) ? p : null
      } catch {
        return null // mid-write
      }
    },
    `saved: ${message}`,
    10000
  )
}

const paletteTitles = (win) => win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent))

/** Runs a command from the palette: type `query`, Enter on the first result, which must be `title`. */
async function runCommand(win, query, title) {
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type(query)
  await f.waitFor(async () => (await paletteTitles(win))[0] === title, `"${query}" lists ${title} first`, 3000)
  await win.keyboard.press('Enter')
  await f.waitFor(async () => !(await win.$('.command-palette')), 'palette closes after running', 3000)
}

async function exportMp4(app, win, name, out) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', '60 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${name}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
}

/** A PNG screenshot of an element, kept under 300 KB (docs/screenshots). */
async function shot(win, selector, name) {
  if (!SHOTS) return
  const file = path.join(SHOTS, name)
  await win.locator(selector).first().screenshot({ path: file })
  console.log(`  screenshot ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`)
}

const autoOf = (p) => p.zooms.filter((z) => z.auto)
const range = (z) => `[${z.start.toFixed(2)}, ${z.end.toFixed(2)}]`

async function main() {
  await test('ignoring a stray click removes its zoom, effect and sound; undo restores it', fx.withHome('smart-zoom-ignore', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 16 })
    // The cursor rests at each click (moving between them well away from the clicks).
    const C = [
      { t: 0.3, x: 0.2, y: 0.2 },
      { t: 4.0, x: 0.7, y: 0.3 },
      { t: 9.0, x: 0.3, y: 0.7 }
    ]
    const samples = [
      { t: 0, x: 0.2, y: 0.2 },
      { t: 2.0, x: 0.2, y: 0.2 },
      { t: 3.0, x: 0.7, y: 0.3 },
      { t: 6.5, x: 0.7, y: 0.3 },
      { t: 7.5, x: 0.3, y: 0.7 },
      { t: 16, x: 0.3, y: 0.7 }
    ]
    const cursor = track(samples, C.map((c) => ({ ...c, button: 'left' })), { scrolls: [] })
    const zooms = [{ id: 'm', start: 12, end: 15, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }]
    const cursorSettings = { show: false, size: 1.4, smoothing: 0.5, clickEffect: true, clickStyle: 'ring', clickColor: '#ff0000', clickSound: true, clickSoundVolume: 1, hideWhenIdle: false }
    const id = fx.seedProject(home, { id: 'rec-ignore', name: 'Ignore clicks', media, seconds: 16, style: GRAY_STYLE, capture: NATIVE, zooms, cursor, cursorSettings })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Ignore clicks')

    // Regenerate: one automatic zoom per click, the manual zoom kept.
    await win.click('.insp-tabs button:has-text("Zoom")')
    await win.click('button:has-text("Regenerate")')
    let p = await saved(home, id, (q) => autoOf(q).length === 3, 'three automatic zooms')
    const want = [[0, 2.2], [3.1, 5.8], [8.1, 10.8]]
    const autos = autoOf(p).sort((a, b) => a.start - b.start)
    h.assert(autos.every((z, i) => near(z.start, want[i][0], 1e-6) && near(z.end, want[i][1], 1e-6)), `auto zooms ${autos.map(range)}`)
    const zoom4 = autos[1]
    const zoom9 = autos[2]
    for (const ms of [300, 4000, 9000]) h.assert(await win.$(`.click-marker[data-click-ms="${ms}"][data-state="used"][data-button="left"]`), `marker for the click at ${ms} ms`)

    // Selecting the 4 s marker shows "Selected click"; Delete ignores it.
    await win.click('.click-marker[data-click-ms="4000"]')
    await win.waitForSelector('[data-testid="selected-click"][data-state="used"]', { timeout: 5000 })
    h.assert((await win.textContent('.insp-section:has([data-testid="selected-click"]) h3')).includes('Left click · 0:04.0'), 'the section names the click')
    h.assert(await win.$('.click-marker[data-click-ms="4000"].selected'), 'the marker shows as selected')
    await shot(win, '.insp-section:has([data-testid="selected-click"])', 'smart-zoom-selected-click.png')
    await win.keyboard.press('Delete')
    p = await saved(home, id, (q) => JSON.stringify(q.inputEdits?.ignoredClicks) === JSON.stringify([{ ms: 4000 }]), 'the click at 4 s is ignored')
    h.assert(!p.zooms.some((z) => z.auto && z.anchor && near(z.anchor.t, 4, 1e-6)), `no auto zoom for the ignored click: ${p.zooms.map(range)}`)
    h.assert(p.zooms.some((z) => z.id === zoom9.id && z.start === zoom9.start && z.end === zoom9.end), 'the 9 s zoom keeps its id')
    h.assert(p.zooms.some((z) => z.id === 'm' && z.start === 12 && z.end === 15), 'the manual zoom is kept')
    await win.waitForSelector('.click-marker[data-click-ms="4000"][data-state="ignored"]', { timeout: 5000 })
    await win.waitForSelector('[data-testid="selected-click"][data-state="ignored"]', { timeout: 5000 })
    await win.waitForSelector('.notice:has-text("Click at 0:04.0 ignored: no zoom, effect or sound")', { timeout: 5000 })

    // One undo step restores the click and its zoom.
    await win.keyboard.press('Control+z')
    p = await saved(home, id, (q) => !q.inputEdits && autoOf(q).length === 3, 'undo uses the click again')
    h.assert(p.zooms.some((z) => z.auto && z.start === zoom4.start && z.end === zoom4.end), `the 4 s zoom is back with its range: ${p.zooms.map(range)}`)
    await win.waitForSelector('.click-marker[data-click-ms="4000"][data-state="used"]', { timeout: 5000 })

    // Find stray clicks (palette): the click at 0.3 s is the first moment of the recording.
    await runCommand(win, 'stray', 'Find stray clicks')
    p = await saved(home, id, (q) => JSON.stringify(q.inputEdits?.ignoredClicks) === JSON.stringify([{ ms: 300, stray: 'start' }]), 'the 0.3 s click is ignored as stray')
    h.assert(!p.zooms.some((z) => z.auto && near(z.start, 0, 1e-6) && near(z.end, 2.2, 1e-6)), `its [0, 2.2] zoom is gone: ${p.zooms.map(range)}`)
    await win.waitForSelector('.click-marker[data-click-ms="300"][data-state="stray"]', { timeout: 5000 })
    await win.waitForSelector('.notice:has-text("Ignored 1 stray click")', { timeout: 5000 })
    const tip = await win.getAttribute('.click-marker[data-click-ms="300"]', 'title')
    h.assert(tip === 'Ignored automatically at 0:00.3: the first moment of the recording, usually the click that focuses the app · select it to use it again', `stray tooltip: ${tip}`)

    // The recorded clicks list shows all three, one ignored.
    await win.click('[data-testid="recorded-clicks"] > summary')
    const summary = await win.textContent('[data-testid="recorded-clicks"] > summary')
    h.assert(summary.trim() === 'Recorded clicks · 3 · 1 ignored', `list summary: ${summary}`)
    h.assert((await win.textContent('[data-testid="auto-zoom-summary"]')).startsWith('3 left clicks (1 ignored)'), 'the auto zoom summary counts the ignored click')
    await shot(win, '.insp-section:has([data-testid="recorded-clicks"])', 'smart-zoom-recorded-clicks.png')

    // A selected auto zoom says what it was made for; "Ignore this click" removes it.
    await win.click(`.zoom-seg[data-zoom="${zoom9.id}"]`)
    await win.waitForSelector('[data-testid="zoom-cause"][data-kind="click"]:has-text("Made for the click at 0:09.0")', { timeout: 5000 })
    await shot(win, '.insp-section:has([data-testid="zoom-cause"])', 'smart-zoom-made-for.png')
    await win.click('[data-testid="zoom-cause"] button:has-text("Ignore this click")')
    p = await saved(home, id, (q) => (q.inputEdits?.ignoredClicks ?? []).some((e) => e.ms === 9000), 'the 9 s click is ignored')
    h.assert(!p.zooms.some((z) => z.id === zoom9.id), 'its zoom is gone')
    h.assert(p.zooms.some((z) => z.id === 'm'), 'the manual zoom is still there')
    await shot(win, '.timeline', 'smart-zoom-timeline-clicks.png')

    // Export: only the click at 4 s shows its ring and plays its sound.
    const out = path.join(home, 'ignore.mp4')
    await exportMp4(app, win, 'Ignore clicks', out)
    const { frames } = fx.framesAt(out, [at(0.45), at(4.15), at(9.15)], 'rgb24')
    const reds = frames.map(reddish)
    console.log(`  reddish pixels at 0.45 / 4.15 / 9.15 s: ${reds.join(' / ')}`)
    h.assert(reds[1] > 100, 'the used click at 4 s shows its ring')
    h.assert(reds[0] === 0 && reds[2] === 0, 'the ignored clicks show nothing')
    const { onsets } = fx.beepOnsets(out, 0.05)
    console.log(`  click sound onsets ${JSON.stringify(onsets)}`)
    h.assert(onsets.length === 1 && near(onsets[0], 4.0, 0.03), 'exactly one click sound, at 4 s')
  }))

  await test('straightened moves: straight in preview and export, ranges override, undo', fx.withHome('smart-zoom-straighten', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 3 })
    // The design's worked example (§5.6) with a 0.05 wobble: rest at A, a wavy move, rest at B.
    const samples = [{ t: 0, x: 0.2, y: 0.5 }, { t: 0.5, x: 0.2, y: 0.5 }, { t: 1.0, x: 0.2, y: 0.5 }]
    for (let k = 1; k < 36; k++) {
      const t = 1 + k / 60
      const u = (t - 1) / 0.6
      samples.push({ t, x: 0.2 + 0.4 * u, y: 0.5 + 0.05 * Math.sin(3 * Math.PI * u) })
    }
    samples.push({ t: 1.6, x: 0.6, y: 0.5 }, { t: 2.0, x: 0.6, y: 0.5 }, { t: 3.0, x: 0.6, y: 0.5 })
    const cursor = track(samples, [], { scrolls: [] })
    const look = { show: true, style: 'white', size: 2, smoothing: 0, clickEffect: false, hideWhenIdle: false, tilt: false, trail: false, loopHome: false, highlight: { enabled: false, color: '#facc15', size: 1, opacity: 0.5 } }
    const id = fx.seedProject(home, { id: 'rec-straight', name: 'Straighten', media, seconds: 3, style: GRAY_STYLE, capture: NATIVE, cursor, cursorSettings: look })
    // The same path followed by a 2x follow-cursor zoom on the gradient (cursor hidden, so only the camera moves the pixels).
    const grad = gradientVideo(5)
    const followSamples = [...samples.slice(0, -1), { t: 5, x: 0.6, y: 0.5 }]
    const followId = fx.seedProject(home, {
      id: 'rec-follow',
      name: 'Follow path',
      media: grad,
      seconds: 5,
      style: STYLE,
      capture: NATIVE,
      cursor: track(followSamples, [], { scrolls: [] }),
      cursorSettings: { ...look, show: false },
      zooms: [{ id: 'f', start: 0, end: 3, scale: 2, focus: { mode: 'cursor' }, auto: false }]
    })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Straighten')

    const times = [0.9, 1.15, 1.3, 1.45, 1.8]
    const centroids = (file) => {
      const { frames } = fx.framesAt(file, times.map(at), 'rgb24')
      return frames.map((fr) => cursorCentroid(fr, W, H))
    }
    const off = path.join(home, 'off.mp4')
    await exportMp4(app, win, 'recorded path', off)
    const recorded = centroids(off)

    await win.click('.insp-tabs button:has-text("Cursor")')
    await win.click('label.toggle:has-text("Straighten moves")')
    await saved(home, id, (q) => q.inputEdits?.straighten === true, 'the option is on')
    await win.waitForSelector('[data-testid="straighten-summary"]:has-text("1 of 1 move straightened")', { timeout: 5000 })
    await shot(win, '.insp-section:has(label.toggle:has-text("Straighten moves"))', 'smart-zoom-straighten.png')
    await win.waitForSelector('[data-testid="path-bar"]', { state: 'attached', timeout: 5000 })
    const on = path.join(home, 'on.mp4')
    await exportMp4(app, win, 'straightened', on)
    const straight = centroids(on)
    h.assert(recorded.every(Boolean) && straight.every(Boolean), 'the cursor is found in every frame')

    // The sprite's centroid sits at a fixed offset from its tip: measured at rest on A (0.9 s).
    const offset = { x: straight[0].x - 0.2 * W, y: straight[0].y - 0.5 * H }
    const tipY = (c) => c.y - offset.y
    console.log(`  tip y (px) as recorded ${recorded.map((c) => tipY(c).toFixed(1)).join(' ')}; straightened ${straight.map((c) => tipY(c).toFixed(1)).join(' ')}`)
    for (const i of [1, 2, 3]) h.assert(near(tipY(straight[i]), 0.5 * H, 3), `straightened: on the A–B line at ${times[i]} s`)
    h.assert(Math.abs(tipY(recorded[2]) - 0.5 * H) >= 15, 'as recorded: at least 15 px off the line at 1.3 s')
    for (const i of [0, 4]) h.assert(near(straight[i].x, recorded[i].x, 1) && near(straight[i].y, recorded[i].y, 1), `the rests are unchanged (${times[i]} s)`)

    // The preview draws the same cursor as the export.
    await seekExact(win, 1.3)
    const pv = await previewFrame(win)
    const pc = cursorCentroid(pv.rgb, pv.w, pv.h)
    h.assert(pc, 'the cursor is on the preview')
    const pxOut = { x: (pc.x / pv.w) * W, y: (pc.y / pv.h) * H }
    console.log(`  preview centroid at 1.3 s (export px) ${pxOut.x.toFixed(1)}, ${pxOut.y.toFixed(1)}; export ${straight[2].x.toFixed(1)}, ${straight[2].y.toFixed(1)}`)
    h.assert(near(pxOut.x, straight[2].x, 4) && near(pxOut.y, straight[2].y, 4), 'preview within 4 px of the export')

    // A range kept as recorded brings the wobble back; one undo step removes it.
    const { y: clipY, h: clipH } = await boxOf(win, '.clip-track')
    const x0 = await xForTime(win, 0.8)
    const x1 = await xForTime(win, 1.8)
    await win.keyboard.down('Shift')
    await win.mouse.move(x0, clipY - clipH / 4)
    await win.mouse.down()
    await win.mouse.move(x1, clipY - clipH / 4, { steps: 8 })
    await win.mouse.up()
    await win.keyboard.up('Shift')
    await win.waitForSelector('[data-testid="cursor-path"]', { timeout: 5000 })
    await win.waitForSelector('[data-testid="cursor-path-summary"]:has-text("1 move here · 1 straightened")', { timeout: 5000 })
    await win.click('[data-testid="cursor-path"] button:has-text("As recorded")')
    let p = await saved(home, id, (q) => (q.inputEdits?.paths ?? []).length === 1, 'a recorded range')
    const r = p.inputEdits.paths[0]
    h.assert(r.mode === 'recorded' && near(r.start, 0.8, 0.05) && near(r.end, 1.8, 0.05), `the range ${JSON.stringify(r)}`)
    h.assert(await win.$('[data-testid="range-selection"]'), 'the range stays selected')
    await win.waitForSelector('[data-testid="cursor-path"] button:has-text("Reset")', { timeout: 5000 })
    await shot(win, '.insp-section:has([data-testid="cursor-path"])', 'smart-zoom-cursor-path.png')
    await seekExact(win, 1.3)
    const pr = await previewFrame(win)
    const c = cursorCentroid(pr.rgb, pr.w, pr.h)
    h.assert(c && Math.abs((c.y / pr.h) * H - offset.y - 0.5 * H) >= 15, 'the wobble is back in the range')
    await win.keyboard.press('Control+z')
    p = await saved(home, id, (q) => q.inputEdits?.straighten === true && !q.inputEdits.paths, 'undo removes the range')

    // Following the cursor: a straightened move keeps the camera's height steady.
    await win.click('header .btn.ghost >> nth=0')
    await win.waitForSelector('.project-open', { timeout: 30000 })
    await fx.openProject(win, 'Follow path')
    await seekTo(win, 4.6)
    const cal = await previewCalibration(win)
    const spread = async () => {
      const ys = []
      for (const t of [1.0, 1.15, 1.3, 1.45, 1.6]) {
        await seekTo(win, t)
        ys.push((await previewCamera(win, cal)).cy)
      }
      return Math.max(...ys) - Math.min(...ys)
    }
    const asRecorded = await spread()
    await runCommand(win, 'straighten cursor moves', 'Straighten cursor moves')
    await saved(home, followId, (q) => q.inputEdits?.straighten === true, 'straightened via the palette')
    await h.sleep(300)
    const straightened = await spread()
    console.log(`  follow-cursor camera cy spread over 1.0-1.6 s: as recorded ${asRecorded.toFixed(4)}, straightened ${straightened.toFixed(4)}`)
    h.assert(straightened <= 0.005, 'the camera stays level along a straightened move')
    h.assert(asRecorded >= 0.01, 'and follows the wobble as recorded')
  }))

  await test('follow scrolling: zooms out during a long scroll and back in where it stops', fx.withHome('smart-zoom-scroll', async (ctx, home) => {
    const media = gradientVideo(20)
    // Click A at 2 s at (0.3, 0.3); a wheel event every 0.1 s from 3 to 7 s at the centre; click B at 12 s.
    const samples = [{ t: 0, x: 0.3, y: 0.3 }, { t: 2.2, x: 0.3, y: 0.3 }, { t: 2.5, x: 0.5, y: 0.5 }, { t: 20, x: 0.5, y: 0.5 }]
    const clicks = [{ t: 2, x: 0.3, y: 0.3, button: 'left' }, { t: 12, x: 0.5, y: 0.5, button: 'left' }]
    const scrolls = []
    for (let k = 0; k <= 40; k++) scrolls.push({ t: +(3 + k / 10).toFixed(2), x: 0.5, y: 0.5, dx: 0, dy: 1 })
    const look = { show: false, size: 1.4, smoothing: 0.5, clickEffect: false, hideWhenIdle: false }
    const id = fx.seedProject(home, { id: 'rec-scroll', name: 'Scrolling', media, seconds: 20, style: STYLE, capture: NATIVE, cursor: track(samples, clicks, { scrolls }), cursorSettings: look })
    const oldId = fx.seedProject(home, { id: 'rec-noscroll', name: 'Before scrolling', media, seconds: 20, style: STYLE, capture: NATIVE, cursor: track(samples, clicks), cursorSettings: look })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Scrolling')
    await seekTo(win, 0.5)
    const cal = await previewCalibration(win)

    await win.click('.insp-tabs button:has-text("Zoom")')
    await win.click('button:has-text("Regenerate")')
    let p = await saved(home, id, (q) => autoOf(q).length === 3, 'three automatic zooms')
    const autos = autoOf(p).sort((a, b) => a.start - b.start)
    const want = [[1.1, 3.35], [7.2, 9.9], [11.1, 13.8]]
    h.assert(autos.every((z, i) => near(z.start, want[i][0], 1e-6) && near(z.end, want[i][1], 1e-6)), `zoom-out ranges ${autos.map(range)}`)
    h.assert(autos[1].anchor && near(autos[1].anchor.x, 0.5, 1e-9) && near(autos[1].anchor.y, 0.5, 1e-9) && near(autos[1].anchor.t, 8.1, 1e-6), `the landing anchor ${JSON.stringify(autos[1].anchor)}`)
    await win.waitForSelector('[data-testid="scroll-band"]', { timeout: 5000 })
    const band = await win.$eval('[data-testid="scroll-band"]', (el) => ({ start: Number(el.dataset.start), end: Number(el.dataset.end), title: el.title }))
    h.assert(near(band.start, 3, 1e-6) && near(band.end, 7, 1e-6) && band.title === 'Scrolling 0:03.0 – 0:07.0: auto zoom shows the whole page while it moves', `scroll band ${JSON.stringify(band)}`)
    h.assert((await win.textContent('[data-testid="auto-zoom-summary"]')).includes('1 long scroll'), 'the summary counts the long scroll')

    await seekTo(win, 5.0)
    const out5 = await previewCamera(win, cal)
    await seekTo(win, 8.5)
    const in85 = await previewCamera(win, cal)
    console.log(`  zoom-out: ${out5.scale.toFixed(3)}x at 5.0 s; ${in85.scale.toFixed(3)}x at 8.5 s around (${in85.cx.toFixed(3)}, ${in85.cy.toFixed(3)})`)
    h.assert(near(out5.scale, 1, 0.03), 'the whole frame while scrolling')
    h.assert(in85.scale >= 1.75 && near(in85.cx, 0.5, 0.05) && near(in85.cy, 0.5, 0.05), 'zoomed back in where scrolling stopped')
    await win.click(`.zoom-seg[data-zoom="${autos[1].id}"]`)
    await win.waitForSelector('[data-testid="zoom-cause"][data-kind="scroll"]', { timeout: 5000 })
    await shot(win, '.insp-section:has(.auto-zoom-options)', 'smart-zoom-scrolling.png')

    await win.click('[aria-label="While scrolling"] .chip:has-text("Hold")')
    p = await saved(home, id, (q) => q.zoomSettings?.auto.scrolling === 'hold', 'hold saved')
    await seekTo(win, 5.0)
    const held = await previewCamera(win, cal)
    console.log(`  hold: ${held.scale.toFixed(3)}x at 5.0 s; zooms ${autoOf(p).map(range)}`)
    h.assert(held.scale > 1.5, 'zoomed in while scrolling')
    await win.keyboard.press('Control+z')
    await saved(home, id, (q) => q.zoomSettings?.auto.scrolling === 'zoom-out' && autoOf(q).length === 3, 'undo restores zoom-out')

    // A recording made before scrolling was captured.
    await win.click('header .btn.ghost >> nth=0')
    await win.waitForSelector('.project-open', { timeout: 30000 })
    await fx.openProject(win, 'Before scrolling')
    await win.click('.insp-tabs button:has-text("Zoom")')
    await win.click('button:has-text("Regenerate")')
    p = await saved(home, oldId, (q) => autoOf(q).length === 2, 'two automatic zooms')
    const old = autoOf(p).sort((a, b) => a.start - b.start)
    h.assert(near(old[0].start, 1.1, 1e-6) && near(old[0].end, 3.8, 1e-6) && near(old[1].start, 11.1, 1e-6) && near(old[1].end, 13.8, 1e-6), `zooms as before ${old.map(range)}`)
    h.assert(await win.$$eval('[aria-label="While scrolling"] .chip', (els) => els.length === 3 && els.every((e) => e.disabled)), 'the chips are disabled')
    await win.waitForSelector('[data-testid="scroll-not-recorded"]:has-text("Scrolling was not recorded in this video (it was made before Flown recorded scrolling).")', { timeout: 5000 })
    h.assert(!(await win.$('[data-testid="scroll-band"]')), 'no scroll bands')
  }))
}

main()
