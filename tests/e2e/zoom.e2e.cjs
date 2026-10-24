// Zoom and camera features end to end, on a recording whose pixels encode their own source
// position (red = x, green = y): region zooms drawn on the preview, pull-back zooms, connected
// zooms that pan without zooming out, easing and auto zoom settings. The camera is measured
// from real exported frames (and from the preview canvas), not taken from the app's state.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const FPS = 60
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)
const W = 1280
const H = 720
// contentRect for a 1280x720 recording in a 1280x720 frame with 10% padding.
const CARD = { x: 128, y: 72, w: 1024, h: 576 }
const STYLE = { background: { type: 'color', color: '#00ff00' }, padding: 0.1, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** 60 fps recording whose pixel (x, y) is rgb(255 x, 255 y, 128) in normalised coordinates. */
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

/* ---------- measuring the camera from pixels ---------- */

/** Least-squares line through points: { m, q } with y = m x + q. */
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
/** Channel values near 0 or 255 may be clipped by the colour conversions: not used. */
const unclipped = (r, g) => r > 8 && r < 247 && g > 8 && g < 247

/** Least squares z = c0 + c1 u + c2 v over [u, v, z] triples. */
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
  // Gaussian elimination.
  for (let i = 0; i < 3; i++) {
    for (let k = i + 1; k < 3; k++) {
      const f = A[k][i] / A[i][i]
      for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j]
      b[k] -= f * b[i]
    }
  }
  const c = [0, 0, 0]
  for (let i = 2; i >= 0; i--) c[i] = (b[i] - A[i].slice(i + 1).reduce((s, a, j) => s + a * c[i + 1 + j], 0)) / A[i][i]
  return c
}

/**
 * Pixels of one row (or column) of an RGB buffer: [position, red, green] for the recording's
 * pixels (not background or shadow), skipping `inset` px at the card's edges.
 */
function line(buf, w, h, { row, col, inset = 6 }) {
  const pts = []
  const n = row !== undefined ? w : h
  for (let i = 0; i < n; i++) {
    const p = row !== undefined ? (row * w + i) * 3 : (i * w + col) * 3
    if (isContent(buf[p + 2])) pts.push([i, buf[p], buf[p + 1]])
  }
  if (pts.length === 0) return { pts, lo: NaN, hi: NaN }
  const lo = pts[0][0]
  const hi = pts[pts.length - 1][0]
  return { pts: pts.filter(([i, r, g]) => i >= lo + inset && i <= hi - inset && unclipped(r, g)), lo, hi: hi + 1 }
}

/**
 * Camera of a frame: scale, centre and the visible source range, from how the colour ramps
 * map onto output pixels. `cal` maps (red, green) back to source coordinates; it is measured
 * on an unzoomed frame of the same video, so colour shifts and channel cross-talk from the
 * encoders and colour conversions cancel out.
 */
function measure(frame, w, h, cal, card = CARD) {
  const cy = Math.round(card.y + card.h / 2)
  const cx = Math.round(card.x + card.w / 2)
  const rowLine = line(frame, w, h, { row: cy })
  const colLine = line(frame, w, h, { col: cx })
  // source x (and y) as a function of the output pixel index
  const fxLine = fit(rowLine.pts.map(([i, r, g]) => [i, cal.toSource(r, g).u]))
  const fyLine = fit(colLine.pts.map(([i, r, g]) => [i, cal.toSource(r, g).v]))
  const scale = 1 / (fxLine.m * card.w)
  const scaleY = 1 / (fyLine.m * card.h)
  // Fitted against pixel indices; pixel i covers [i, i + 1], so position p is index p - 0.5.
  const srcAt = (l, p) => l.m * (p - 0.5) + l.q
  return {
    scale,
    scaleY,
    cx: srcAt(fxLine, card.x + card.w / 2),
    cy: srcAt(fyLine, card.y + card.h / 2),
    x0: srcAt(fxLine, card.x),
    x1: srcAt(fxLine, card.x + card.w),
    y0: srcAt(fyLine, card.y),
    y1: srcAt(fyLine, card.y + card.h),
    // Where the recording's pixels are on screen (output px).
    left: rowLine.lo,
    right: rowLine.hi,
    top: colLine.lo,
    bottom: colLine.hi
  }
}

/**
 * (red, green) -> source coordinate calibration from an unzoomed frame (card = CARD): both
 * channels are fitted as planes over the card, then the 2x2 system is inverted per pixel.
 */
function calibrate(frame, w, h, card = CARD) {
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
    },
    describe: () => `R = ${r0.toFixed(1)} + ${ru.toFixed(1)}u + ${rv.toFixed(1)}v; G = ${g0.toFixed(1)} + ${gu.toFixed(1)}u + ${gv.toFixed(1)}v`
  }
}

const px = (buf, w, x, y) => {
  const p = (y * w + x) * 3
  return { r: buf[p], g: buf[p + 1], b: buf[p + 2] }
}
const isBackground = (c) => c.g > 100 && c.b < 60 && c.r < 60

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
  await h.sleep(250)
}

const disk = (home, id) => h.readProject(home, id)
/** Waits until autosave has written a project.json for which `pred` holds; returns it. */
function saved(home, id, pred, message) {
  return f.waitFor(
    () => {
      try {
        const p = disk(home, id)
        return pred(p) ? p : null
      } catch {
        return null // mid-write
      }
    },
    `saved: ${message}`,
    10000
  )
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

/** The preview canvas's middle row (red) and middle column (green), as an RGB "frame" of the canvas size. */
async function previewFrame(win) {
  return win.evaluate(() => {
    const c = document.querySelector('.preview-canvas')
    const g = c.getContext('2d')
    const data = g.getImageData(0, 0, c.width, c.height).data
    const rgb = new Array(c.width * c.height * 3)
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]
      rgb[j + 1] = data[i + 1]
      rgb[j + 2] = data[i + 2]
    }
    return { w: c.width, h: c.height, rgb }
  })
}

/** The card rectangle of the preview canvas (same layout rule as the compositor). */
function previewCard(w, h, padding = 0.1) {
  const pad = Math.min(w, h) * padding
  const s = Math.min((w - 2 * pad) / W, (h - 2 * pad) / H)
  return { x: (w - W * s) / 2, y: (h - H * s) / 2, w: W * s, h: H * s }
}

async function previewCamera(win, cal) {
  const p = await previewFrame(win)
  const card = previewCard(p.w, p.h)
  return measure(p.rgb, p.w, p.h, cal, card)
}

async function previewCalibration(win) {
  const p = await previewFrame(win)
  return calibrate(p.rgb, p.w, p.h, previewCard(p.w, p.h))
}

const near = (a, b, eps) => Math.abs(a - b) <= eps
const fmt = (c) => `${c.scale.toFixed(3)}x at (${c.cx.toFixed(3)}, ${c.cy.toFixed(3)}) view x ${c.x0.toFixed(3)}..${c.x1.toFixed(3)} y ${c.y0.toFixed(3)}..${c.y1.toFixed(3)}`

async function main() {
  await test('zoom: a region drawn on the preview frames exactly that box in the export', fx.withHome('zoom-region', async (ctx, home) => {
    const media = gradientVideo(6)
    fx.seedProject(home, { id: 'rec-region', name: 'Region zoom', media, seconds: 6, style: STYLE, capture: { method: 'native', cursorInVideo: false, region: null } })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Region zoom')
    await seekTo(win, 3)
    await win.keyboard.press('z')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'zoom added')
    await win.click('.chip:has-text("Region")')
    await win.waitForSelector('[data-testid="region-box"]')
    h.assert(await win.$('.preview-overlay.picking'), 'drawing mode on the preview')
    // Drag a box from (0.15, 0.25) to (0.45, 0.55) of the recording on the preview.
    const box = await boxOf(win, '.canvas-box')
    const card = previewCard(box.w, box.h)
    const at = (x, y) => ({ x: box.left + card.x + x * card.w, y: box.top + card.y + y * card.h })
    const a = at(0.15, 0.25)
    const b = at(0.45, 0.55)
    await win.mouse.move(a.x, a.y)
    await win.mouse.down()
    for (let i = 1; i <= 10; i++) await win.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10)
    await win.mouse.up()
    await h.sleep(200)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'zoom-region-editor.png') })
    await win.click('.pick-hint button:has-text("Done")')
    await f.waitFor(async () => !(await win.$('.preview-overlay.picking')), 'drawing mode closed')
    const z = (await saved(home, 'rec-region', (p) => p.zooms[0]?.focus.mode === 'region' && p.zooms[0].focus.w < 0.45, 'the drawn region')).zooms[0]
    const r = z.focus
    console.log(`  drawn region ${JSON.stringify(r)}, level ${z.scale.toFixed(3)}`)
    h.assert(near(r.x, 0.15, 0.01) && near(r.y, 0.25, 0.01) && near(r.w, 0.3, 0.01) && near(r.h, 0.3, 0.01), `region follows the drag: ${JSON.stringify(r)}`)
    h.assert(near(z.scale, 1 / r.w, 0.01), 'level follows from the region')
    // The timeline labels it.
    h.assert(/region/.test(await win.textContent('.zoom-seg .seg-label')), 'timeline shows a region zoom')

    // Undo restores the previous focus in one step; redo brings the region back.
    await win.keyboard.press('Control+z')
    await saved(home, 'rec-region', (p) => p.zooms[0].focus.w !== r.w, 'undo reverts the drawn box in one step')
    await win.keyboard.press('Control+Shift+z')
    await saved(home, 'rec-region', (p) => JSON.stringify(p.zooms[0].focus) === JSON.stringify(r), 'redo restores the drawn box')

    const out = path.join(home, 'region.mp4')
    await exportMp4(app, win, 'region', out)
    const idx = [Math.round(0.2 * FPS), Math.round(3 * FPS)]
    const F = fx.framesAt(out, idx, 'rgb24')
    const cal = calibrate(F.frames[0], F.width, F.height)
    const cam = measure(F.frames[1], F.width, F.height, cal)
    console.log(`  export at 3 s: ${fmt(cam)}`)
    h.assert(near(cam.x0, r.x, 0.008) && near(cam.x1, r.x + r.w, 0.008), `frames the box horizontally: ${fmt(cam)}`)
    h.assert(near(cam.y0, r.y, 0.008) && near(cam.y1, r.y + r.h, 0.008), `frames the box vertically: ${fmt(cam)}`)
    h.assert(Math.abs(cam.scale / cam.scaleY - 1) < 0.02, `same scale on both axes, no stretching (${cam.scale.toFixed(3)} / ${cam.scaleY.toFixed(3)})`)
    if (SHOTS) fx.savePng(out, idx[1], path.join(SHOTS, 'zoom-region-3s.png'))
  }))

  await test('zoom: pull back shows background around a smaller card; connected zooms pan without returning to 1x', fx.withHome('zoom-pull', async (ctx, home) => {
    const media = gradientVideo(10)
    const zooms = [
      { id: 'a', start: 0.8, end: 2.6, scale: 2, focus: { mode: 'fixed', x: 0.3, y: 0.35 }, auto: false },
      { id: 'b', start: 3.4, end: 5.2, scale: 2, focus: { mode: 'fixed', x: 0.7, y: 0.6 }, auto: false },
      { id: 'c', start: 6.2, end: 8.8, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }
    ]
    fx.seedProject(home, { id: 'rec-pull', name: 'Pull back', media, seconds: 10, zooms, style: STYLE, effects: { motionBlur: 0.5, keystrokes: { show: false, position: 'bottom', size: 0.035 } } })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Pull back')
    h.assert((await win.$$('.zoom-link')).length === 0, 'no linked zooms yet (0.8 s apart)')

    // "Pan to next zoom" on the first zoom makes the two touch.
    await win.click('.zoom-seg[data-zoom="a"]')
    await win.click('label.toggle:has-text("Pan to next zoom")')
    await saved(home, 'rec-pull', (p) => p.zooms.find((z) => z.id === 'a').end === 3.4, 'zoom a now ends where b starts')
    await f.waitFor(async () => (await win.$$('.zoom-link[data-zoom-link="a>b"]')).length === 1, 'the timeline links the two zooms')
    h.assert(await win.$('.zoom-seg[data-zoom="a"][data-linked-next="true"]'), 'zoom a is marked as panning on')
    h.assert(await win.$eval('input[aria-label="Pan to next zoom"]', (i) => i.checked), 'toggle shows connected')

    // 0 pulls the third zoom back to 0.75x.
    await win.click('.zoom-seg[data-zoom="c"]')
    await win.keyboard.press('0')
    await saved(home, 'rec-pull', (p) => p.zooms.find((z) => z.id === 'c').scale === 0.75, 'key 0 pulls back to 0.75x')
    h.assert(await win.$('.zoom-seg.pullback[data-zoom="c"]'), 'the timeline shows a pull-back zoom')
    // 1-4 set levels too (and Ctrl+Z undoes it).
    await win.keyboard.press('4')
    await saved(home, 'rec-pull', (p) => p.zooms.find((z) => z.id === 'c').scale === 3, 'key 4 sets 3x')
    await win.keyboard.press('Control+z')
    await saved(home, 'rec-pull', (p) => p.zooms.find((z) => z.id === 'c').scale === 0.75, 'undo restores 0.75x')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'zoom-timeline-linked.png') })

    // Preview == export: the paused preview at 7.5 s shows the pulled-back card.
    await seekTo(win, 0.3)
    const pcal = await previewCalibration(win)
    await seekTo(win, 7.5)
    const pv = await previewCamera(win, pcal)
    console.log(`  preview at 7.5 s: ${fmt(pv)}`)
    h.assert(near(pv.scale, 0.75, 0.02), `preview pulled back to 0.75x: ${fmt(pv)}`)

    const out = path.join(home, 'pull.mp4')
    const timing = fx.exportTimings(win)
    await exportMp4(app, win, 'pull', out)
    console.log(`  ${timing.last().line}`)
    const at = (t) => Math.round(t * FPS)
    // Every third frame across the pair (decoded frames are 2.7 MB each).
    const times = []
    for (let t = 0.8 + 0.75; t <= 5.2 - 0.75; t += 3 / FPS) times.push(at(t))
    const idx = [at(0.3), at(2.0), at(4.4), at(7.5), ...times]
    const F = fx.framesAt(out, idx, 'rgb24')
    const frame = (i) => F.frames[idx.indexOf(i)]
    const cal = calibrate(frame(at(0.3)), F.width, F.height)
    console.log(`  colour calibration: ${cal.describe()}`)
    const first = measure(frame(at(2.0)), F.width, F.height, cal)
    const second = measure(frame(at(4.4)), F.width, F.height, cal)
    console.log(`  2.0 s: ${fmt(first)}; 4.4 s: ${fmt(second)}`)
    h.assert(near(first.cx, 0.3, 0.01) && near(second.cx, 0.7, 0.01), 'each zoom looks at its own point')
    // Across the whole connected pair the camera never zooms out: it only pans.
    let minScale = Infinity
    let worst = null
    for (const i of times) {
      const c = measure(frame(i), F.width, F.height, cal)
      if (c.scale < minScale) {
        minScale = c.scale
        worst = { t: i / FPS, c }
      }
    }
    console.log(`  lowest zoom between the connected zooms: ${minScale.toFixed(3)}x at ${worst.t.toFixed(2)} s`)
    // The camera is exactly 2x throughout; the encoder's error on a fast-panning gradient is ~2%.
    // Zooming out in between (separate zooms) would measure 1x.
    h.assert(minScale > 1.9, `connected zooms stay at 2x (lowest ${minScale.toFixed(3)} at ${worst.t.toFixed(2)} s)`)

    // Pull back: the whole recording on a 0.75x card, background all around it.
    const pull = measure(frame(at(7.5)), F.width, F.height, cal)
    console.log(`  7.5 s: ${fmt(pull)}; card ${pull.left}..${pull.right} x ${pull.top}..${pull.bottom}`)
    h.assert(near(pull.scale, 0.75, 0.015), `pulled back to 0.75x: ${fmt(pull)}`)
    h.assert(near(pull.right - pull.left, CARD.w * 0.75, 6) && near(pull.bottom - pull.top, CARD.h * 0.75, 6), 'card is 75% of its size')
    h.assert(near((pull.left + pull.right) / 2, W / 2, 3) && near((pull.top + pull.bottom) / 2, H / 2, 3), 'card shrinks around its centre')
    // The card's frame spans 1/0.75 of the recording: all of it is inside the smaller card.
    h.assert(near(pull.x0, -1 / 6, 0.01) && near(pull.x1, 7 / 6, 0.01) && near(pull.y0, -1 / 6, 0.01) && near(pull.y1, 7 / 6, 0.01), `the whole recording is visible: ${fmt(pull)}`)
    const pf = frame(at(7.5))
    for (const [x, y] of [[CARD.x + 20, H / 2], [CARD.x + CARD.w - 20, H / 2], [W / 2, CARD.y + 12], [CARD.x + 30, CARD.y + 30]]) {
      h.assert(isBackground(px(pf, F.width, x, y)), `background shows at (${x}, ${y}) where the full card was: ${JSON.stringify(px(pf, F.width, x, y))}`)
    }
    // Preview and export agree.
    h.assert(near(pv.scale, pull.scale, 0.02), `preview ${pv.scale.toFixed(3)}x = export ${pull.scale.toFixed(3)}x`)
    if (SHOTS) {
      fx.savePng(out, at(7.5), path.join(SHOTS, 'zoom-pullback-7.5s.png'))
      fx.savePng(out, at(6.5), path.join(SHOTS, 'zoom-pullback-6.5s-moving.png'))
      fx.savePng(out, at(3.6), path.join(SHOTS, 'zoom-pan-3.6s.png'))
    }
  }))

  await test('zoom: easing persists and changes the motion; auto zoom settings regenerate', fx.withHome('zoom-easing', async (ctx, home) => {
    const media = gradientVideo(16)
    const zooms = [{ id: 'm', start: 1, end: 5, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }]
    const samples = []
    for (let t = 0; t <= 16; t += 0.1) samples.push({ t: +t.toFixed(2), x: 0.6, y: 0.4 })
    const cursor = {
      samples,
      clicks: [
        { t: 8, x: 0.6, y: 0.4, button: 'left' },
        { t: 13, x: 0.3, y: 0.7, button: 'right' }
      ],
      keys: [],
      shapes: [],
      scale: 1,
      valid: true
    }
    fx.seedProject(home, { id: 'rec-ease', name: 'Easing', media, seconds: 16, zooms, style: STYLE, cursor, capture: { method: 'native', cursorInVideo: false, region: null } })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Easing')
    await seekTo(win, 0.4)
    const cal = await previewCalibration(win)
    // A quarter of the way into the zoom-in transition.
    await seekTo(win, 1.2)
    const smooth = await previewCamera(win, cal)
    await win.click('.insp-tabs button:has-text("Zoom")')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'zoom-panel-style.png') })
    await win.click('[aria-label="Default zoom easing"] .chip:has-text("Snappy")')
    await saved(home, 'rec-ease', (p) => p.zoomSettings?.easing === 'snappy', 'project zoom easing')
    await h.sleep(300)
    const snappy = await previewCamera(win, cal)
    console.log(`  at the playhead: smooth ${smooth.scale.toFixed(3)}x, snappy ${snappy.scale.toFixed(3)}x`)
    h.assert(snappy.scale > smooth.scale + 0.15, `snappy is further along than smooth (${smooth.scale.toFixed(3)} -> ${snappy.scale.toFixed(3)})`)
    await win.keyboard.press('Control+z')
    await saved(home, 'rec-ease', (p) => (p.zoomSettings?.easing ?? 'smooth') === 'smooth', 'undo restores the easing')
    await h.sleep(300)
    h.assert(near((await previewCamera(win, cal)).scale, smooth.scale, 0.02), 'and the motion')

    // A zoom's own easing overrides the style.
    await win.click('.zoom-seg[data-zoom="m"]')
    await win.click('[aria-label="Zoom easing"] .chip:has-text("Linear")')
    await saved(home, 'rec-ease', (p) => p.zooms.find((z) => z.id === 'm').easing === 'linear', 'zoom easing')
    await h.sleep(300)
    const linear = await previewCamera(win, cal)
    console.log(`  linear: ${linear.scale.toFixed(3)}x`)
    h.assert(linear.scale > smooth.scale + 0.1 && linear.scale < snappy.scale, 'linear lies between smooth and snappy here')
    // "Apply to all zooms" hands the zoom back to the project style.
    await win.click('button:has-text("Apply to all zooms")')
    await saved(home, 'rec-ease', (p) => p.zooms.find((z) => z.id === 'm').easing === undefined, 'apply to all clears the zoom easing')

    // Auto zoom settings: right clicks add a zoom, live; the level applies to auto zooms.
    const autoOf = (p) => p.zooms.filter((z) => z.auto)
    await win.click('button:has-text("Regenerate")')
    await saved(home, 'rec-ease', (p) => autoOf(p).length === 1, 'one auto zoom from the left click')
    await win.click('label.toggle:has-text("Right clicks")')
    let p = await saved(home, 'rec-ease', (q) => q.zoomSettings?.auto.rightClicks === true, 'right clicks setting')
    h.assert(autoOf(p).length === 2 && autoOf(p).some((z) => z.anchor && z.anchor.t === 13), `the right click got a zoom: ${JSON.stringify(autoOf(p))}`)
    await win.focus('.auto-zoom-options .slider:has-text("Level") input')
    await win.keyboard.press('End')
    p = await saved(home, 'rec-ease', (q) => autoOf(q).length === 2 && autoOf(q).every((z) => z.scale === 4), 'auto zooms follow the level')
    h.assert(p.zooms.find((z) => z.id === 'm'), 'the edited zoom is kept')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'zoom-panel-auto.png') })
    await win.click('label.toggle:has-text("Auto zoom")')
    await saved(home, 'rec-ease', (q) => autoOf(q).length === 0 && q.autoZoom === false, 'turning auto zoom off removes the automatic zooms')
    await win.keyboard.press('Control+z')
    await saved(home, 'rec-ease', (q) => autoOf(q).length === 2 && q.autoZoom === true, 'undo brings them back')
  }))
}

main()
