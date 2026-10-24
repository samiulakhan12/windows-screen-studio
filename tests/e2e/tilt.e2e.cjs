// 3D tilt in the real built app: the tilted card's edges and corners in exported frames land
// where shared/engine/tilt.ts puts them (a light card on a dark background), perspective makes
// the far edge shorter, a tilt that is off exports the very same pixels as a project without
// one, 'Flatten on zoom' draws the flat frame while zoomed in, the preview is drawn flat while
// a shape is selected, the Effects panel edits the tilt (one undo step per change) and "Save as
// default" keeps it, and without WebGL the card is drawn flat with a warning.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const W = 1920
const H = 1080
const VW = 1280
const VH = 720
// Chromium blocklists WebGL on Xvfb's software GL; SwiftShader gives the tilt a WebGL to draw with.
const GL_ARGS = ['--enable-unsafe-swiftshader']

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-tilt-mod-'))
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))
/** The shared tilt and layout code, to know where the app draws the card. */
const geo = (() => {
  const outfile = path.join(scratch, 'tilt.cjs')
  const contents = "export * from './src/shared/engine/tilt'\nexport * from './src/shared/engine/layout'\n"
  esbuild.buildSync({ stdin: { contents, resolveDir: h.APP_DIR, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  return require(outfile)
})()

const STYLE = { background: { type: 'color', color: '#202020' }, padding: 0.12, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }
const TILT = { enabled: true, rotateX: 12, rotateY: 22, perspective: 0.8, animate: 'none' }
/** Luma of the card (a light grey recording) and of the background, and half way. */
const CARD = 235
const BG = 32
const MID = (CARD + BG) / 2

/** Seeds a project of a flat light-grey recording, with `extra` fields (tilt, zooms, shapes …) merged in. */
function seed(home, id, name, seconds, extra = {}) {
  const media = fx.solidVideo({ seconds, color: 'ebebeb' })
  fx.seedProject(home, { id, name, media, seconds, style: STYLE, effects: NO_FX, zooms: extra.zooms })
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

async function launch(ctx, home, args = GL_ARGS) {
  const { app, win, logs } = await h.launch({ home, args })
  ctx.app = app
  ctx.logs = logs
  const warnings = []
  win.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()))
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win, warnings }
}

/** Exports the project open in the editor at 1080p / 30 fps and closes the dialog. */
async function exportOpen(app, win, out) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '1080p')
  await fx.pickChip(win, 'Frame rate', '30 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached' })
}

async function exportProject(app, win, name, out) {
  await fx.openProject(win, name)
  await exportOpen(app, win, out)
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
  if (SHOTS) fx.savePng(out, 6, path.join(SHOTS, `${path.basename(out, '.mp4')}.png`))
}

/** A grey image (1 byte per pixel) with a reader. */
function grayImage(buf, width, height) {
  return { buf, width, height, at: (x, y) => buf[Math.min(height - 1, Math.max(0, Math.round(y))) * width + Math.min(width - 1, Math.max(0, Math.round(x)))] }
}

function exportFrame(file, index) {
  const { width, height, frames } = fx.framesAt(file, [index], 'gray')
  h.assert(width === W && height === H, `export is ${W}x${H} (got ${width}x${height})`)
  return grayImage(frames[0], width, height)
}

/** The preview canvas as a grey image. */
async function previewImage(win) {
  const r = await win.evaluate(() => {
    const c = document.querySelector('.preview-canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    const g = new Uint8Array(c.width * c.height)
    for (let i = 0; i < g.length; i++) g[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2])
    let s = ''
    for (let i = 0; i < g.length; i += 0x8000) s += String.fromCharCode.apply(null, g.subarray(i, i + 0x8000))
    return { w: c.width, h: c.height, data: btoa(s) }
  })
  return grayImage(Buffer.from(r.data, 'base64'), r.w, r.h)
}

/** Where the recording card is (corners: top-left, top-right, bottom-right, bottom-left) for `tilt` (or flat). */
function cardCorners(w, h, tilt) {
  const body = geo.styleContentRect(w, h, VW, VH, STYLE)
  const pose = tilt ? geo.tiltPoseAt(tilt, 0, { scale: 1, cx: 0.5, cy: 0.5 }, null) : { rotateX: 0, rotateY: 0, perspective: 0 }
  return geo.projectRect(geo.tiltView(pose, body, w, h, STYLE.padding * Math.min(w, h)), body)
}

/**
 * Where the card's edge really is near `p` (an edge point), scanning `dir` ('x' or 'y') from
 * the background side (`sign` = which way is inside) through the 50% crossing, sub-pixel.
 */
function edgeAt(img, p, dir, sign, reach = 14) {
  const at = (i) => (dir === 'x' ? img.at(i, p.y) : img.at(p.x, i))
  // Pixel i covers [i, i + 1): its value is the card's coverage at i + 0.5. Walk in from the background.
  const start = Math.round((dir === 'x' ? p.x : p.y) - 0.5) - sign * reach
  for (let k = 0; k < 2 * reach; k++) {
    const a = start + sign * k
    const va = at(a)
    const vb = at(a + sign)
    if (va < MID && vb >= MID) return a + 0.5 + (sign * (MID - va)) / (vb - va)
  }
  return NaN
}

/** Point `k` of the way along a → b. */
const along = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
const fmt = (p) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`

/**
 * Checks the card in `img` against `corners`: each edge crosses from background to card where
 * the line between its corners says (to `tol` px, at a quarter, half and three quarters of
 * its length), and just inside / outside every corner is card / background.
 */
function checkCard(img, corners, label, tol = 2) {
  const [tl, tr, br, bl] = corners
  const edges = [
    ['left', tl, bl, 'x', 1],
    ['right', tr, br, 'x', -1],
    ['top', tl, tr, 'y', 1],
    ['bottom', bl, br, 'y', -1]
  ]
  const worst = []
  for (const [name, a, b, dir, sign] of edges) {
    for (const k of [0.25, 0.5, 0.75]) {
      const p = along(a, b, k)
      const got = edgeAt(img, p, dir, sign)
      const want = dir === 'x' ? p.x : p.y
      worst.push(Math.abs(got - want))
      h.assert(Math.abs(got - want) <= tol, `${label}: ${name} edge at ${fmt(p)} is at ${got.toFixed(2)} (expected ${want.toFixed(2)} along ${dir})`)
    }
  }
  const cx = (tl.x + tr.x + br.x + bl.x) / 4
  const cy = (tl.y + tr.y + br.y + bl.y) / 4
  for (const c of corners) {
    const n = Math.hypot(cx - c.x, cy - c.y)
    const inside = img.at(c.x + ((cx - c.x) / n) * 6, c.y + ((cy - c.y) / n) * 6)
    const outside = img.at(c.x - ((cx - c.x) / n) * 6, c.y - ((cy - c.y) / n) * 6)
    h.assert(inside > MID + 40 && outside < MID - 40, `${label}: corner ${fmt(c)} has the card inside (${inside}) and background outside (${outside})`)
  }
  return Math.max(...worst)
}

/** True when the card in `img` is where `corners` say (no assertion). */
function cardIs(img, corners) {
  try {
    checkCard(img, corners, 'probe')
    return true
  } catch {
    return false
  }
}

async function main() {
  await test('tilt: exported card corners and edges land where tilt.ts puts them; the far edge is shorter', fx.withHome('tilt-export', async (ctx, home) => {
    seed(home, 'rec-tilt', 'Tilted', 1, { tilt: TILT })
    seed(home, 'rec-hero', 'Hero', 1, { tilt: { enabled: true, rotateX: 16, rotateY: -14, perspective: 0.7, animate: 'none' } })
    const { app, win, warnings } = await launch(ctx, home)
    const out = path.join(home, 'tilted.mp4')
    await exportProject(app, win, 'Tilted', out)
    const img = exportFrame(out, 10)
    const corners = cardCorners(W, H, TILT)
    const err = checkCard(img, corners, 'turned right')
    console.log(`  corners ${corners.map(fmt).join(' ')}; worst edge error ${err.toFixed(2)} px`)
    // Turned right with perspective: the right edge is further away, so shorter.
    const [tl, tr, br, bl] = corners
    const left = bl.y - tl.y
    const right = br.y - tr.y
    h.assert(right < left * 0.92, `the far (right) edge is shorter: ${right.toFixed(1)} vs ${left.toFixed(1)} px`)
    // Measured on the frame too: the card's height just inside its left and right edges.
    const heightAt = (x) => {
      let n = 0
      for (let y = 0; y < H; y++) if (img.at(x, y) > MID) n++
      return n
    }
    const hl = heightAt(Math.max(tl.x, bl.x) + 4)
    const hr = heightAt(Math.min(tr.x, br.x) - 4)
    h.assert(hr < hl * 0.92 && Math.abs(hl - left) < 12, `measured edge heights: left ${hl}, right ${hr} px`)
    // The flat card's top-right corner is background now.
    const flat = cardCorners(W, H, null)
    h.assert(img.at(flat[1].x - 3, flat[1].y + 3) < MID, 'where the flat card had its top-right corner is background now')

    const hero = path.join(home, 'hero.mp4')
    await exportProject(app, win, 'Hero', hero)
    checkCard(exportFrame(hero, 10), cardCorners(W, H, { enabled: true, rotateX: 16, rotateY: -14, perspective: 0.7, animate: 'none' }), 'hero')
    h.assert(!warnings.some((m) => m.includes('3D tilt')), `no fallback warning with WebGL (${warnings.join(' | ')})`)
  }))

  await test('tilt: a tilt that is off exports exactly the pixels of a project without one', fx.withHome('tilt-off', async (ctx, home) => {
    // A moving test picture, a zoom and a shadow: everything the card draws.
    const media = fx.indexedVideo({ seconds: 2 })
    const style = { ...STYLE, cornerRadius: 16, shadow: 0.6 }
    const zooms = [{ id: 'z', start: 0.5, end: 1.6, scale: 2, focus: { mode: 'fixed', x: 0.3, y: 0.4 }, auto: false }]
    for (const [id, name, tilt] of [
      ['rec-plain', 'Plain', undefined],
      ['rec-off', 'Tilt off', { ...TILT, enabled: false, rotateX: -25, animate: 'cursor' }]
    ]) {
      fx.seedProject(home, { id, name, media, seconds: 2, style, effects: { ...NO_FX, motionBlur: 0.6 }, zooms })
      if (tilt) {
        const file = path.join(h.projectsRoot(home), id, 'project.json')
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), tilt }, null, 2))
      }
    }
    const { app, win } = await launch(ctx, home)
    const a = path.join(home, 'plain.mp4')
    const b = path.join(home, 'off.mp4')
    await exportProject(app, win, 'Plain', a)
    await exportProject(app, win, 'Tilt off', b)
    const frames = [0, 20, 33, 59]
    const fa = fx.framesAt(a, frames, 'rgb24').frames
    const fb = fx.framesAt(b, frames, 'rgb24').frames
    frames.forEach((n, i) => h.assert(fa[i].length > 0 && fa[i].equals(fb[i]), `frame ${n} is identical`))
  }))

  await test("tilt: 'Flatten on zoom' draws the flat frame while zoomed in, tilted before", fx.withHome('tilt-zoom', async (ctx, home) => {
    const zooms = [{ id: 'z', start: 1, end: 3, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }]
    const tilt = { ...TILT, animate: 'zoom' }
    seed(home, 'rec-zoom', 'Zoom tilt', 3.5, { tilt, zooms })
    seed(home, 'rec-zoom-flat', 'Zoom flat', 3.5, { zooms })
    const { app, win } = await launch(ctx, home)
    const out = path.join(home, 'zoom-tilt.mp4')
    const flatOut = path.join(home, 'zoom-flat.mp4')
    await exportProject(app, win, 'Zoom tilt', out)
    await exportProject(app, win, 'Zoom flat', flatOut)
    if (SHOTS) fx.savePng(out, 60, path.join(SHOTS, 'zoom-tilt-zoomed.png'))
    // Before the zoom: tilted.
    checkCard(exportFrame(out, 6), cardCorners(W, H, tilt), 'before the zoom')
    // Zoomed in (t = 2 s): flat, the very frame of the project without a tilt.
    const zoomed = exportFrame(out, 60)
    checkCard(zoomed, cardCorners(W, H, null), 'zoomed in')
    h.assert(zoomed.buf.equals(exportFrame(flatOut, 60).buf), 'zoomed in, the frame is exactly the flat one')
    // Half way into the zoom the tilt is partly gone: between the two.
    const mid = exportFrame(out, 33)
    h.assert(!cardIs(mid, cardCorners(W, H, tilt)) || !cardIs(mid, cardCorners(W, H, null)), 'moving between the two during the transition')
  }))

  await test('tilt: the preview is tilted, and drawn flat while a shape is selected', fx.withHome('tilt-preview', async (ctx, home) => {
    const shape = { id: 's1', kind: 'rect', start: 0, end: 4, x: 0.4, y: 0.4, w: 0.2, h: 0.2, color: '#ebebeb', strokeWidth: 2, fill: false, opacity: 1, strength: 0.5 }
    seed(home, 'rec-prev', 'Preview tilt', 4, { tilt: TILT, shapes: [shape] })
    const { win } = await launch(ctx, home)
    await fx.openProject(win, 'Preview tilt')
    await f.waitFor(async () => (await win.$$('.shape-seg')).length === 1, 'the shape on the timeline')
    const first = await previewImage(win)
    console.log(`  preview canvas ${first.width}x${first.height}`)
    const tilted = cardCorners(first.width, first.height, TILT)
    const flat = cardCorners(first.width, first.height, null)
    checkCard(first, tilted, 'preview, nothing selected')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'tilt-preview.png') })

    await win.click('.shape-seg[data-shape="s1"]')
    await win.waitForSelector('[data-testid="shape-editor"] [data-testid="shape-box"]')
    await f.waitFor(async () => cardIs(await previewImage(win), flat), 'the preview drawn flat while the shape is selected', 5000)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'tilt-preview-selected.png') })
    // The handles sit on the flat frame.
    const canvas = await win.$eval('.preview-canvas', (el) => el.getBoundingClientRect().toJSON())
    const handles = await win.$eval('[data-testid="shape-editor"] [data-testid="shape-box"]', (el) => el.getBoundingClientRect().toJSON())
    const body = geo.styleContentRect(first.width, first.height, VW, VH, STYLE)
    const sx = canvas.width / first.width
    const want = { x: canvas.left + (body.x + 0.4 * body.w) * sx, w: 0.2 * body.w * sx }
    h.assert(Math.abs(handles.left - want.x) < 12 && Math.abs(handles.width - want.w) < 24, `shape handles on the flat frame (${handles.left.toFixed(0)}+${handles.width.toFixed(0)} vs ${want.x.toFixed(0)}+${want.w.toFixed(0)})`)

    await win.keyboard.press('Escape')
    await f.waitFor(async () => cardIs(await previewImage(win), tilted), 'tilted again once nothing is selected', 5000)
  }))

  await test('tilt: the Effects panel switches it on, applies presets and sliders as single undo steps; "Save as default" keeps it', fx.withHome('tilt-panel', async (ctx, home) => {
    seed(home, 'rec-ui', 'Tilt panel', 3)
    const { app, win } = await launch(ctx, home)
    const saved = (pred, what) =>
      f.waitFor(() => {
        const p = h.readProject(home, 'rec-ui')
        return pred(p.tilt) ? p.tilt : null
      }, what, 10000)
    await fx.openProject(win, 'Tilt panel')
    const flatImg = await previewImage(win)
    const flat = cardCorners(flatImg.width, flatImg.height, null)
    checkCard(flatImg, flat, 'flat before')
    await win.click('.insp-tabs button:has-text("Effects")')
    h.assert(!(await win.$('[data-testid="tilt-unsupported"]')), 'no WebGL warning in the panel')
    h.assert(await win.$eval('.slider:has-text("Turn") input', (el) => el.disabled), 'the angle sliders are off while the tilt is off')

    await win.click('label.toggle:has-text("Tilt the recording in 3D")')
    let tilt = await saved((t) => t?.enabled === true, 'the tilt switched on')
    h.assert(tilt.rotateX === 16 && tilt.rotateY === -14 && tilt.perspective === 0.7 && tilt.animate === 'none', `it starts as the Hero preset: ${JSON.stringify(tilt)}`)
    h.assert((await win.getAttribute('button[aria-label="Hero tilt"]', 'aria-pressed')) === 'true', 'the Hero tile is lit')
    await f.waitFor(async () => cardIs(await previewImage(win), cardCorners(flatImg.width, flatImg.height, tilt)), 'the preview shows the tilt', 5000)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'tilt-panel-hero.png') })

    await win.click('button[aria-label="Left tilt"]')
    tilt = await saved((t) => t?.rotateY === -20, 'the Left preset')
    h.assert(tilt.rotateX === 6 && tilt.perspective === 0.55, `Left preset angles: ${JSON.stringify(tilt)}`)
    await win.focus('.slider:has-text("Turn") input')
    await win.keyboard.press('End')
    await saved((t) => t?.rotateY === 30, 'turned all the way right')
    h.assert((await win.textContent('.slider:has-text("Turn")')).includes('30° right'), 'the slider reads 30° right')
    await win.keyboard.press('Control+z')
    await saved((t) => t?.rotateY === -20, 'undo: back to the Left preset')
    h.assert(h.readProject(home, 'rec-ui').tilt.enabled, 'one undo step: still tilted')
    h.assert(await win.$eval('.chip:has-text("Follow cursor")', (el) => el.disabled), 'no cursor data: Follow cursor is off')
    await win.click('.chip:has-text("Flatten on zoom")')
    tilt = await saved((t) => t?.animate === 'zoom', 'Flatten on zoom')
    await f.waitFor(async () => cardIs(await previewImage(win), cardCorners(flatImg.width, flatImg.height, tilt)), 'the preview shows the Left tilt', 5000)

    // Save as default: the saved look carries the tilt.
    await win.click('.insp-tabs button:has-text("Style")')
    await win.click('button:has-text("Save as default for new recordings")')
    await win.waitForSelector('.notice:has-text("Saved as default")', { timeout: 10000 })
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'style-defaults.json'), 'utf8'))
    h.assert(JSON.stringify(stored.tilt) === JSON.stringify({ enabled: true, rotateX: 6, rotateY: -20, perspective: 0.55, animate: 'zoom' }), `tilt saved with the default look: ${JSON.stringify(stored.tilt)}`)

    // A built-in preset with a tilt, then one without: the second switches it off.
    await win.click('.preset-summary')
    await win.click('button[aria-label="Laptop showcase preset"]')
    tilt = await saved((t) => t?.rotateX === 14, 'the Laptop showcase tilt')
    h.assert(tilt.enabled && tilt.rotateY === -12 && tilt.animate === 'zoom', `showcase tilt: ${JSON.stringify(tilt)}`)
    await win.click('button[aria-label="Studio preset"]')
    tilt = await saved((t) => t?.enabled === false, 'Studio switches the tilt off')
    h.assert(tilt.rotateX === 14, 'and keeps the angles for later')

    // Off again from the panel.
    await win.click('.insp-tabs button:has-text("Effects")')
    await win.click('button[aria-label="Top tilt"]')
    tilt = await saved((t) => t?.enabled === true && t.rotateX === 24, 'a preset turns the tilt back on')
    await win.click('label.toggle:has-text("Tilt the recording in 3D")')
    await saved((t) => t?.enabled === false, 'switched off')
  }))

  await test('tilt: without WebGL the card is drawn flat, with a warning, and the panel says so', fx.withHome('tilt-nogl', async (ctx, home) => {
    seed(home, 'rec-nogl', 'No WebGL', 1, { tilt: TILT })
    // A graphics driver without WebGL, whatever this machine has: the page gets no WebGL
    // context (before anything in it asked for one).
    const { app, win, warnings } = await launch(ctx, home)
    await win.evaluate(() => {
      const getContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/.test(type) ? null : getContext.call(this, type, ...rest)
      }
    })
    await fx.openProject(win, 'No WebGL')
    await win.click('.insp-tabs button:has-text("Effects")')
    await win.waitForSelector('[data-testid="tilt-unsupported"]')
    const img = await previewImage(win)
    checkCard(img, cardCorners(img.width, img.height, null), 'flat preview')
    const out = path.join(home, 'nogl.mp4')
    await exportOpen(app, win, out)
    checkCard(exportFrame(out, 10), cardCorners(W, H, null), 'flat export')
    const told = warnings.filter((m) => m.includes('3D tilt'))
    h.assert(told.length === 1 && /WebGL/.test(told[0]), `one warning: ${JSON.stringify(warnings)}`)
  }))
}

main()
