// Shapes, privacy blur/pixelate and spotlights end to end: measured on real exported frames
// against the source video (blur and pixelate remove detail only inside their boxes, the
// arrow is drawn where it belongs, a shape stays on its content through a zoom, a spotlight
// dims only outside its area, the cursor stays sharp over a blur), and edited in the app
// (add from the panel, see it on the timeline and the preview, move it, also while zoomed,
// re-time it, delete it, undo).
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const FPS = 60
const W = 1280
const H = 720
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** Adds shapes and spotlights to a seeded project.json (the shared fixtures do not know them). */
function addItems(home, id, { shapes = [], spotlights = [] }) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, shapes, spotlights }, null, 2))
}

const shape = (id, kind, start, end, box, extra = {}) => ({
  id,
  kind,
  start,
  end,
  ...box,
  color: '#ff3b30',
  strokeWidth: 6,
  fill: false,
  opacity: 1,
  strength: 0.5,
  ...extra
})

async function exportMp4(app, win, name, out) {
  await fx.openProject(win, name)
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', '60 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${name}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

/* ---------- measuring frames (rgb24 buffers, rectangles in fractions of the frame) ---------- */

const px = (r) => ({ x0: Math.round(r.x * W), y0: Math.round(r.y * H), x1: Math.round((r.x + r.w) * W), y1: Math.round((r.y + r.h) * H) })
const luma = (buf, i) => 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]

/**
 * Mean gradient energy (squared luma differences to the next pixel) inside `r`. Blurring an
 * edge spreads its step over many pixels, which lowers this a lot (the mean absolute gradient
 * would not change: a blurred step still adds up to the same step).
 */
function sharpness(buf, r) {
  const { x0, y0, x1, y1 } = px(r)
  let s = 0
  let n = 0
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const i = (y * W + x) * 3
      const v = luma(buf, i)
      s += (luma(buf, i + 3) - v) ** 2 + (luma(buf, i + W * 3) - v) ** 2
      n++
    }
  }
  return s / n
}

function meanLuma(buf, r) {
  const { x0, y0, x1, y1 } = px(r)
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) s += luma(buf, (y * W + x) * 3)
  return s / n
}

function meanAbsDiff(a, b, r) {
  const { x0, y0, x1, y1 } = px(r)
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3
      s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      n += 3
    }
  }
  return s / n
}

/** Pixels in `r` matching `pred(r, g, b)`. */
function count(buf, r, pred) {
  const { x0, y0, x1, y1 } = px(r)
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3
      if (pred(buf[i], buf[i + 1], buf[i + 2])) n++
    }
  }
  return n
}

/**
 * Mean standard deviation of the luma inside the cells of a `cols` x `rows` grid laid over `r`
 * (3 px in from each cell's edges): about 0 for a mosaic with exactly these cells.
 */
function cellSpread(buf, r, cols, rows) {
  const { x0, y0, x1, y1 } = px(r)
  const cw = (x1 - x0) / cols
  const ch = (y1 - y0) / rows
  let total = 0
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0
      let s2 = 0
      let n = 0
      for (let y = Math.ceil(y0 + j * ch + 3); y < y0 + (j + 1) * ch - 3; y++) {
        for (let x = Math.ceil(x0 + i * cw + 3); x < x0 + (i + 1) * cw - 3; x++) {
          const v = luma(buf, (y * W + x) * 3)
          s += v
          s2 += v * v
          n++
        }
      }
      total += n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0
    }
  }
  return total / (cols * rows)
}

const isRed = (r, g, b) => r > 180 && g < 90 && b < 90
const isGreen = (r, g, b) => g > 190 && r < 100 && b < 100

/* ---------- editor helpers ---------- */

async function boxOf(win, selector) {
  return win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.left, top: b.top }
  })
}

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

async function seekTo(win, t) {
  const x = await xForTime(win, t)
  const { y } = await boxOf(win, '.tl-ruler')
  await win.mouse.click(x, y)
  await h.sleep(300)
}

async function drag(win, from, to, steps = 8) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  for (let i = 1; i <= steps; i++) await win.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
  await win.mouse.up()
  await h.sleep(150)
}

/** The recording's rectangle on the preview (same rule as the compositor's contentRect). */
function previewRect(w, hgt, padding) {
  const pad = Math.min(w, hgt) * padding
  const s = Math.min((w - 2 * pad) / W, (hgt - 2 * pad) / H)
  return { x: (w - W * s) / 2, y: (hgt - H * s) / 2, w: W * s, h: H * s }
}

/** Pixels of the preview canvas matching a colour test. */
async function previewCount(win, kind) {
  return win.evaluate((k) => {
    const c = document.querySelector('.preview-canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]]
      if (k === 'red' ? r > 200 && g < 90 && b < 90 : false) n++
    }
    return n
  }, kind)
}

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

const near = (a, b, eps) => Math.abs(a - b) <= eps

async function main() {
  await test('shapes: blur and pixelate hide detail only inside their boxes; arrow; spotlight; a shape follows a zoom', fx.withHome('shapes-export', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 6, width: W, height: H })
    const style = { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
    // The zoom frames (0.5..1, 0.15..0.65) of the recording from 4.8 s until it zooms out at 5.7 s.
    const zooms = [{ id: 'z', start: 4.5, end: 6, scale: 2, focus: { mode: 'fixed', x: 0.75, y: 0.4 }, auto: false, transition: 0.3 }]
    fx.seedProject(home, { id: 'rec-shapes', name: 'Shapes export', media, seconds: 6, style, zooms })
    // The same project without shapes: both go through the same decode, colour and encode path.
    fx.seedProject(home, { id: 'rec-plain', name: 'Shapes reference', media, seconds: 6, style, zooms })
    const blurBox = { x: 0.1, y: 0.35, w: 0.3, h: 0.3 }
    const pixBox = { x: 0.6, y: 0.35, w: 0.3, h: 0.3 }
    const lit = { x: 0.4, y: 0.4, w: 0.2, h: 0.25 }
    const greenBox = { x: 0.72, y: 0.3, w: 0.1, h: 0.1 }
    addItems(home, 'rec-shapes', {
      shapes: [
        shape('blur', 'blur', 0, 6, blurBox),
        shape('pix', 'pixelate', 0, 4.5, pixBox),
        shape('arrow', 'arrow', 1, 2.5, { x: 0.42, y: 0.75, w: 0.16, h: 0.15 }, { color: '#ff0000', strokeWidth: 10 }),
        shape('green', 'rect', 4.5, 6, greenBox, { color: '#00ff00', fill: true })
      ],
      spotlights: [{ id: 'spot', mode: 'region', start: 3, end: 4.5, ...lit, shape: 'rect', dim: 0.7, feather: 0 }]
    })

    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = path.join(home, 'shapes.mp4')
    const ref = path.join(home, 'reference.mp4')
    await exportMp4(app, win, 'Shapes export', out)
    await exportMp4(app, win, 'Shapes reference', ref)

    const at = (t) => Math.round(t * FPS)
    if (SHOTS) for (const t of [0.5, 1.8, 3.8, 5.5]) fx.savePng(out, at(t), path.join(SHOTS, `shapes-${t}s.png`))
    const idx = [at(0.5), at(1.8), at(3.8), at(5.5)]
    const E = fx.framesAt(out, idx, 'rgb24')
    const S = fx.framesAt(ref, idx, 'rgb24')
    h.assert(E.width === W && E.height === H, `720p export (${E.width}x${E.height})`)
    const e = (t) => E.frames[idx.indexOf(at(t))]
    const s = (t) => S.frames[idx.indexOf(at(t))]

    // 0.5 s: blur and pixelate active, nothing else.
    const sharpIn = { src: sharpness(s(0.5), blurBox), exp: sharpness(e(0.5), blurBox) }
    console.log(`  blur box sharpness without/with the blur ${sharpIn.src.toFixed(2)} -> ${sharpIn.exp.toFixed(2)}`)
    h.assert(sharpIn.exp < sharpIn.src * 0.35, `blur removes detail inside its box (${sharpIn.src.toFixed(2)} -> ${sharpIn.exp.toFixed(2)})`)
    // The mosaic grid of strength 0.5 on a 720 px recording (shared/render/shapes.ts pixelCell/pixelGrid).
    const cell = (0.01 + 0.04 * 0.5) * H
    const cols = Math.round((pixBox.w * W) / cell)
    const rows = Math.round((pixBox.h * H) / cell)
    const spread = { src: cellSpread(s(0.5), pixBox, cols, rows), exp: cellSpread(e(0.5), pixBox, cols, rows) }
    console.log(`  pixelate ${cols}x${rows} cells: spread inside cells without/with ${spread.src.toFixed(2)} -> ${spread.exp.toFixed(2)}`)
    h.assert(spread.exp < 3 && spread.exp < spread.src * 0.3, `pixelate makes flat cells (${spread.src.toFixed(2)} -> ${spread.exp.toFixed(2)})`)
    for (const r of [{ x: 0.42, y: 0.3, w: 0.16, h: 0.4 }, { x: 0, y: 0.7, w: 1, h: 0.3 }]) {
      const d = meanAbsDiff(e(0.5), s(0.5), r)
      console.log(`  outside the boxes: mean diff ${d.toFixed(2)} in ${JSON.stringify(r)}`)
      h.assert(d < 2, `outside the boxes the frame is unchanged (mean diff ${d.toFixed(2)} in ${JSON.stringify(r)})`)
    }
    // Detail right next to the blur box is kept (the blur does not spill out of it).
    const beside = { x: 0.4 + 2 / W, y: 0.36, w: 0.02, h: 0.28 }
    const besideDiff = meanAbsDiff(e(0.5), s(0.5), beside)
    h.assert(besideDiff < 3, `the blur stays inside its box (diff ${besideDiff.toFixed(2)} right beside it)`)

    // 1.8 s: the red arrow from (0.42, 0.75) to (0.58, 0.9).
    const shaft = { x: 0.47, y: 0.79, w: 0.06, h: 0.07 }
    const red = { exp: count(e(1.8), shaft, isRed), src: count(s(1.8), shaft, isRed) }
    console.log(`  red pixels on the arrow's shaft: without ${red.src}, with ${red.exp}`)
    h.assert(red.exp - red.src > 150, 'the arrow is drawn along its line')
    const mid = { x: 0.5 - 3 / W, y: 0.825 - 3 / H, w: 6 / W, h: 6 / H }
    h.assert(count(e(1.8), mid, isRed) >= 24, 'red at the middle of the arrow')
    // Around the arrowhead's centre: 10 px stroke at 1080p is 6.7 px here, so the head is ~23 px long.
    const head = { x: 725 / W, y: 637 / H, w: 8 / W, h: 8 / H }
    h.assert(count(e(1.8), head, isRed) >= 40, `the arrowhead is at the tip (${count(e(1.8), head, isRed)} red px)`)
    h.assert(count(e(0.5), shaft, isRed) - count(s(0.5), shaft, isRed) < 20, 'no arrow before it starts')

    // 3.8 s: the spotlight darkens outside its area by its dim (0.7) and leaves the area alone.
    const outside = { x: 0.65, y: 0.72, w: 0.3, h: 0.23 }
    const inside = { x: lit.x + 0.01, y: lit.y + 0.01, w: lit.w - 0.02, h: lit.h - 0.02 }
    const ratioOut = meanLuma(e(3.8), outside) / meanLuma(s(3.8), outside)
    const ratioIn = meanLuma(e(3.8), inside) / meanLuma(s(3.8), inside)
    console.log(`  spotlight: brightness outside x${ratioOut.toFixed(3)}, inside x${ratioIn.toFixed(3)}`)
    h.assert(near(ratioOut, 0.3, 0.06), `dimmed to ~30% outside (x${ratioOut.toFixed(3)})`)
    h.assert(near(ratioIn, 1, 0.05), `not dimmed inside (x${ratioIn.toFixed(3)})`)

    // 5.5 s: zoomed 2x on (0.75, 0.4): the green box moved with its content.
    const zoomedGreen = { x: (greenBox.x - 0.5) * 2 + 0.02, y: (greenBox.y - 0.15) * 2 + 0.03, w: greenBox.w * 2 - 0.04, h: greenBox.h * 2 - 0.06 }
    const area = px(zoomedGreen)
    const greenIn = count(e(5.5), zoomedGreen, isGreen) / ((area.x1 - area.x0) * (area.y1 - area.y0))
    const greenThere = count(e(5.5), { x: greenBox.x + 0.01, y: greenBox.y + 0.01, w: greenBox.w - 0.02, h: greenBox.h - 0.02 }, isGreen)
    console.log(`  zoomed: ${(greenIn * 100).toFixed(1)}% green where the box went, ${greenThere} green px where it was`)
    h.assert(greenIn > 0.95, `the box follows the zoom (${(greenIn * 100).toFixed(1)}% green)`)
    h.assert(greenThere < 15, 'nothing left where the box was before the zoom')
  }))

  await test('shapes: the cursor is drawn sharp over a blur', fx.withHome('shapes-cursor', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 2 })
    const style = { background: { type: 'color', color: '#808080' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
    const still = [{ t: 0, x: 0.5, y: 0.5 }, { t: 2, x: 0.5, y: 0.5 }]
    fx.seedProject(home, {
      id: 'rec-cursor-blur',
      name: 'Cursor over blur',
      media,
      seconds: 2,
      style,
      capture: { method: 'native', cursorInVideo: false, region: null },
      cursorSettings: { show: true, size: 1.6, smoothing: 0.5, clickEffect: false, hideWhenIdle: false },
      cursor: { samples: still, clicks: [], keys: [], shapes: [], scale: 1.5, valid: true }
    })
    // A strong blur over the cursor for the first second only.
    addItems(home, 'rec-cursor-blur', { shapes: [shape('b', 'blur', 0, 1, { x: 0.35, y: 0.3, w: 0.3, h: 0.4 }, { strength: 1 })] })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = path.join(home, 'cursor-blur.mp4')
    await exportMp4(app, win, 'Cursor over blur', out)
    const at = (t) => Math.round(t * FPS)
    const F = fx.framesAt(out, [at(0.5), at(1.5)], 'rgb24')
    const box = { x: 0.48, y: 0.48, w: 0.07, h: 0.12 }
    const extreme = (r, g, b) => (r > 200 && g > 200 && b > 200) || (r < 60 && g < 60 && b < 60)
    const blurred = count(F.frames[0], box, extreme)
    const plain = count(F.frames[1], box, extreme)
    console.log(`  cursor pixels over the blur ${blurred}, without it ${plain}`)
    h.assert(plain > 60, 'the cursor is drawn')
    h.assert(blurred > plain * 0.85 && blurred < plain * 1.15, 'over the blur the cursor is as crisp as without it')
    if (SHOTS) fx.savePng(out, at(0.5), path.join(SHOTS, 'shapes-cursor-over-blur.png'))
  }))

  await test('shapes: add from the panel, edit on the preview (also zoomed) and the timeline, delete, undo', async (ctx) => {
    const home = h.tempHome('shapes-editor')
    const zooms = [{ id: 'z', start: 6, end: 11, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }]
    f.seedProject(home, { id: 'rec-shapes-ed', name: 'Shapes editor', seconds: 12, zooms })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await f.openProject(win, 'Shapes editor')
    await seekTo(win, 2)
    await win.click('.insp-tabs button:has-text("Shapes")')
    h.assert((await win.$$('.shape-seg')).length === 0, 'no shapes yet')
    const redBefore = await previewCount(win, 'red')

    // Arrow from the panel: on the timeline, selected, on the preview with its handles.
    await win.click('button[aria-label="Add arrow"]')
    await f.waitFor(async () => (await win.$$('.shape-seg[data-shape]')).length === 1, 'arrow on the timeline')
    let p = await saved(home, 'rec-shapes-ed', (q) => q.shapes?.length === 1, 'the arrow')
    const arrow = p.shapes[0]
    h.assert(arrow.kind === 'arrow', 'an arrow')
    h.assert(arrow.start < 2 && arrow.end > 4, `it shows at the playhead (${arrow.start.toFixed(2)}..${arrow.end.toFixed(2)})`)
    await win.waitForSelector('[data-testid="shape-editor"] .shape-end')
    h.assert(await win.$('.shape-seg.selected'), 'selected on the timeline')
    h.assert(/Selected arrow/.test(await win.textContent('.insp-body')), 'its settings in the inspector')
    await h.sleep(300)
    const redAfter = await previewCount(win, 'red')
    console.log(`  red preview pixels before/after adding the arrow: ${redBefore}/${redAfter}`)
    h.assert(redAfter - redBefore > 100, 'the arrow is drawn on the preview')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'shapes-editor-arrow.png') })

    // Drag its head 40 px right on the (unzoomed) preview.
    const canvas = await boxOf(win, '.canvas-box')
    const rect = previewRect(canvas.w, canvas.h, 0.07)
    const end = await boxOf(win, '.shape-end[data-end="end"]')
    const tipX = canvas.left + rect.x + (arrow.x + arrow.w) * rect.w
    h.assert(near(end.x, tipX, 2), `the head handle sits on the arrowhead (${end.x.toFixed(1)} vs ${tipX.toFixed(1)})`)
    await drag(win, end, { x: end.x + 40, y: end.y })
    p = await saved(home, 'rec-shapes-ed', (q) => Math.abs(q.shapes[0].w - arrow.w) > 0.01, 'the moved arrowhead')
    console.log(`  arrow end moved by ${((p.shapes[0].w - arrow.w) * rect.w).toFixed(1)} px`)
    h.assert(near((p.shapes[0].w - arrow.w) * rect.w, 40, 2) && near(p.shapes[0].x, arrow.x, 1e-9), 'only the head moved, by the drag')

    // A blur at the same time: a second lane on the timeline.
    await win.click('button[aria-label="Add blur"]')
    await f.waitFor(async () => (await win.$$('.shape-seg[data-shape]')).length === 2, 'blur on the timeline')
    p = await saved(home, 'rec-shapes-ed', (q) => q.shapes?.length === 2, 'the blur')
    const blur = p.shapes.find((s) => s.kind === 'blur')
    const [laneA, laneB] = await Promise.all([boxOf(win, `.shape-seg[data-shape="${arrow.id}"]`), boxOf(win, `.shape-seg[data-shape="${blur.id}"]`)])
    h.assert(Math.abs(laneA.y - laneB.y) > 5, 'overlapping shapes get their own lanes')
    h.assert(await win.$(`.shape-seg.privacy[data-shape="${blur.id}"]`), 'privacy shapes look different on the timeline')

    // Re-time the blur by dragging its block one second to the right.
    const pxPerSec = await win.$eval('.tl-content', (el) => Number(el.dataset.pxPerSec))
    await drag(win, laneB, { x: laneB.x + pxPerSec, y: laneB.y })
    p = await saved(home, 'rec-shapes-ed', (q) => Math.abs(q.shapes.find((s) => s.id === blur.id).start - blur.start) > 0.5, 'the moved blur')
    const moved = p.shapes.find((s) => s.id === blur.id)
    h.assert(near(moved.start - blur.start, 1, 0.08) && near(moved.end - moved.start, blur.end - blur.start, 1e-6), `moved by 1 s (${(moved.start - blur.start).toFixed(3)})`)

    // Select the arrow on the timeline and delete it with the Delete key; undo brings it back.
    await win.click(`.shape-seg[data-shape="${arrow.id}"]`)
    await win.keyboard.press('Delete')
    await f.waitFor(async () => !(await win.$(`.shape-seg[data-shape="${arrow.id}"]`)), 'arrow gone from the timeline')
    await saved(home, 'rec-shapes-ed', (q) => q.shapes.length === 1 && q.shapes[0].id === blur.id, 'the arrow deleted')
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => !!(await win.$(`.shape-seg[data-shape="${arrow.id}"]`)), 'arrow back on the timeline')
    await saved(home, 'rec-shapes-ed', (q) => q.shapes.length === 2, 'undo restores the arrow')

    // Zoomed in (2x on the centre from 6.7 s): the handles sit where the compositor draws the shape,
    // and dragging moves it by half as much in the recording.
    await seekTo(win, 8.5)
    await win.click('button[aria-label="Add pixelate"]')
    p = await saved(home, 'rec-shapes-ed', (q) => q.shapes.some((s) => s.kind === 'pixelate'), 'the pixelate')
    const pix = p.shapes.find((s) => s.kind === 'pixelate')
    await win.waitForSelector('[data-testid="shape-box"]')
    const sb = await boxOf(win, '[data-testid="shape-box"]')
    const expect = { left: canvas.left + rect.x + (pix.x - 0.25) * 2 * rect.w, top: canvas.top + rect.y + (pix.y - 0.25) * 2 * rect.h, w: pix.w * 2 * rect.w, h: pix.h * 2 * rect.h }
    console.log(`  zoomed handle box ${sb.left.toFixed(1)},${sb.top.toFixed(1)} ${sb.w.toFixed(1)}x${sb.h.toFixed(1)}; expected ${expect.left.toFixed(1)},${expect.top.toFixed(1)} ${expect.w.toFixed(1)}x${expect.h.toFixed(1)}`)
    h.assert(near(sb.left, expect.left, 2) && near(sb.top, expect.top, 2) && near(sb.w, expect.w, 2) && near(sb.h, expect.h, 2), 'the box is mapped through the zoom camera')
    await drag(win, { x: sb.x, y: sb.y }, { x: sb.x + 50, y: sb.y + 20 })
    p = await saved(home, 'rec-shapes-ed', (q) => q.shapes.find((s) => s.id === pix.id).x !== pix.x, 'the moved pixelate')
    const pm = p.shapes.find((s) => s.id === pix.id)
    console.log(`  zoomed drag moved the box by ${((pm.x - pix.x) * rect.w).toFixed(2)} x ${((pm.y - pix.y) * rect.h).toFixed(2)} unzoomed px`)
    h.assert(near((pm.x - pix.x) * rect.w, 25, 1.5) && near((pm.y - pix.y) * rect.h, 10, 1.5), 'a zoomed drag moves the content by the drag / zoom')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'shapes-editor-zoomed.png') })

    // A spotlight from the panel goes on the shapes track too.
    await win.click('button[aria-label="Add region spotlight"]')
    await f.waitFor(async () => (await win.$$('.shape-seg.spotlight')).length === 1, 'spotlight on the timeline')
    await saved(home, 'rec-shapes-ed', (q) => q.spotlights?.length === 1, 'the spotlight')
    h.assert(/Selected spotlight/.test(await win.textContent('.insp-body')), 'spotlight settings')
    await win.click('.chip:has-text("Rectangle")')
    await saved(home, 'rec-shapes-ed', (q) => q.spotlights[0].shape === 'rect', 'rectangular spotlight')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'shapes-editor-spotlight.png') })
    await win.keyboard.press('Delete')
    await saved(home, 'rec-shapes-ed', (q) => q.spotlights.length === 0, 'the spotlight deleted')
    h.assert((await win.$$('.shape-seg.spotlight')).length === 0, 'and gone from the timeline')
    if (!process.env.SSW_E2E_KEEP) fs.rmSync(home, { recursive: true, force: true })
  })
}

main()
