// The camera end to end, measured on real exported frames: border colour, square vs circle,
// mirroring, zoom and crop into the picture; each camera layout puts the screen and the camera
// where they belong and animates between them; background blur removes detail behind the person
// (a synthetic person the bundled model recognises) but not on the person, and without WebGL it
// says so and draws the camera unblurred; and the layout track in the app (add, move, trim,
// change, delete, undo; hidden without a camera), the framing pad, and a recording whose camera
// file went missing (its layouts leave the screen where it is, and are kept for when it is back).
//
// Background blur needs WebGL in a worker; Xvfb has no GPU, so the blur tests launch the app with
// SwiftShader (--enable-unsafe-swiftshader), and the "unavailable" test with --disable-webgl.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const FPS = 60
const W = 1280
const H = 720
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)
const WEBGL = ['--enable-unsafe-swiftshader']
const NO_WEBGL = ['--disable-webgl']

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/* ---------- the camera fixture: a person the segmentation model recognises ---------- */

/**
 * Draws a person (hair, face with eyes, brows, nose and mouth, neck, shoulders in a shirt) in
 * front of a detailed background of fine stripes, with a red marker left of the person and a
 * blue one right of it (mirroring swaps them). Runs in the app's page; returns a PNG data URL.
 */
function drawPerson(W, H) {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  for (let x = 0; x < W; x += 4) {
    g.fillStyle = (x / 4) % 2 ? '#e8e2d0' : '#4a5a78'
    g.fillRect(x, 0, 4, H)
  }
  for (let y = 0; y < H; y += H / 6) {
    g.fillStyle = '#3b2a1a'
    g.fillRect(0, y, W, H * 0.02)
  }
  g.fillStyle = '#ff0000'
  g.fillRect(W * 0.25, H * 0.4, W * 0.11, H * 0.16)
  g.fillStyle = '#0000ff'
  g.fillRect(W * 0.64, H * 0.4, W * 0.11, H * 0.16)
  const cx = W / 2
  const S = H
  const ellipse = (x, y, rx, ry, color, a0 = 0, a1 = Math.PI * 2) => {
    g.fillStyle = color
    g.beginPath()
    g.ellipse(x, y, rx, ry, 0, a0, a1)
    g.fill()
  }
  g.save()
  g.beginPath()
  g.moveTo(cx - S * 0.42, H)
  g.quadraticCurveTo(cx - S * 0.4, H * 0.68, cx - S * 0.12, H * 0.64)
  g.lineTo(cx + S * 0.12, H * 0.64)
  g.quadraticCurveTo(cx + S * 0.4, H * 0.68, cx + S * 0.42, H)
  g.closePath()
  g.fillStyle = '#2d6a4f'
  g.fill()
  g.clip()
  g.fillStyle = '#f1f5f9'
  g.beginPath()
  g.moveTo(cx - S * 0.08, H * 0.64)
  g.lineTo(cx, H * 0.74)
  g.lineTo(cx + S * 0.08, H * 0.64)
  g.closePath()
  g.fill()
  for (let i = 0; i < 3; i++) ellipse(cx, H * (0.79 + i * 0.07), S * 0.012, S * 0.012, '#1b4332')
  g.restore()
  g.fillStyle = '#d9a37e'
  g.fillRect(cx - S * 0.06, H * 0.5, S * 0.12, H * 0.16)
  ellipse(cx, H * 0.33, S * 0.17, H * 0.21, '#2b1a10')
  ellipse(cx, H * 0.37, S * 0.14, H * 0.18, '#e8b896')
  ellipse(cx, H * 0.22, S * 0.15, H * 0.08, '#2b1a10', Math.PI, 0)
  for (const s of [-1, 1]) {
    ellipse(cx + s * S * 0.055, H * 0.34, S * 0.025, H * 0.014, '#ffffff')
    ellipse(cx + s * S * 0.055, H * 0.34, S * 0.011, S * 0.011, '#3a2412')
    ellipse(cx + s * S * 0.14, H * 0.37, S * 0.02, H * 0.035, '#dca582')
  }
  g.strokeStyle = '#2b1a10'
  g.lineWidth = S * 0.012
  for (const s of [-1, 1]) {
    g.beginPath()
    g.moveTo(cx + s * S * 0.03, H * 0.305)
    g.lineTo(cx + s * S * 0.085, H * 0.3)
    g.stroke()
  }
  g.strokeStyle = '#b07a5a'
  g.lineWidth = S * 0.008
  g.beginPath()
  g.moveTo(cx, H * 0.35)
  g.lineTo(cx - S * 0.012, H * 0.41)
  g.lineTo(cx + S * 0.01, H * 0.415)
  g.stroke()
  g.strokeStyle = '#a0464a'
  g.lineWidth = S * 0.012
  g.beginPath()
  g.arc(cx, H * 0.43, S * 0.04, 0.2, Math.PI - 0.2)
  g.stroke()
  return c.toDataURL('image/png')
}

/** A 640x360 30 fps camera video of the person (drawn once by the app, then cached). */
async function personVideo(seconds) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `person-v3-640x360-30-${seconds}s.mp4`)
  if (fs.existsSync(file)) return file
  const png = path.join(fx.MEDIA_CACHE, 'person-v3.png')
  if (!fs.existsSync(png)) {
    const home = h.tempHome('camera-fixture')
    const { app, win } = await h.launch({ home })
    try {
      const url = await win.evaluate(`(${drawPerson.toString()})(640, 360)`)
      fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'))
    } finally {
      await app.close().catch(() => undefined)
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', png, '-t', String(seconds), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '15', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp])
  fs.renameSync(tmp, file)
  return file
}

/* ---------- projects and exports ---------- */

const BLACK = { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }

/** Seeds a project with the person camera, then sets its camera, layouts and style. */
function seedCamera(home, { id, name, seconds, camera, webcam = {}, layouts = [], style = BLACK }) {
  fx.seedProject(home, { id, name, media: fx.solidVideo({ seconds }), seconds, webcam: camera, style })
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  p.webcam = { ...p.webcam, ...webcam }
  p.layouts = layouts
  fs.writeFileSync(file, JSON.stringify(p, null, 2))
}

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
  await backHome(win)
}

async function backHome(win) {
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

/** Frames of `file` at the given seconds: { at(t) -> rgb24 buffer }. */
function framesAtTimes(file, times) {
  const idx = times.map((t) => Math.round(t * FPS))
  const F = fx.framesAt(file, idx, 'rgb24')
  h.assert(F.width === W && F.height === H, `720p export (${F.width}x${F.height})`)
  return { at: (t) => F.frames[idx.indexOf(Math.round(t * FPS))] }
}

/* ---------- measuring pixels (output px) ---------- */

const rgb = (buf, x, y) => {
  const i = (Math.round(y) * W + Math.round(x)) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}
const isGray = ([r, g, b]) => Math.abs(r - 128) < 14 && Math.abs(g - 128) < 14 && Math.abs(b - 128) < 14
const isBlack = ([r, g, b]) => r < 24 && g < 24 && b < 24
const isMagenta = ([r, g, b]) => r > 190 && g < 80 && b > 190
const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80
const isBlue = ([r, g, b]) => b > 180 && r < 80 && g < 80
const isSkin = ([r, g, b]) => r > 200 && g > 150 && g < 215 && b > 110 && b < 180 && r - b > 50
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b

/** Pixels of `buf` in the rectangle (output px) passing `pred`, and how many there are. */
function countIn(buf, r, pred) {
  let n = 0
  let all = 0
  let sx = 0
  for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y++) {
    for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x++) {
      all++
      if (pred(rgb(buf, x, y))) {
        n++
        sx += x
      }
    }
  }
  return { n, all, share: n / Math.max(1, all), cx: n ? sx / n : NaN }
}

/** Mean squared luma step to the next pixel (right and down) inside `r`: blurring lowers it a lot. */
function sharpness(buf, r) {
  let s = 0
  let n = 0
  for (let y = Math.round(r.y); y < Math.round(r.y + r.h) - 1; y++) {
    for (let x = Math.round(r.x); x < Math.round(r.x + r.w) - 1; x++) {
      const v = luma(rgb(buf, x, y))
      s += (luma(rgb(buf, x + 1, y)) - v) ** 2 + (luma(rgb(buf, x, y + 1)) - v) ** 2
      n++
    }
  }
  return s / n
}

/** Regions of a camera-only frame (fractions): the striped room left of the person, and the face. */
const BLUR_BACKGROUND = { x: 0.02, y: 0.22, w: 0.14, h: 0.36 }
const BLUR_FACE = { x: 0.44, y: 0.29, w: 0.12, h: 0.16 }
const scaled = (r) => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H })

/** sharpness() of a region (fractions) of the editor's preview canvas. */
function previewSharpness(win, r) {
  return win.evaluate((box) => {
    const c = document.querySelector('.preview-canvas')
    const x0 = Math.round(box.x * c.width)
    const y0 = Math.round(box.y * c.height)
    const w = Math.round(box.w * c.width)
    const h = Math.round(box.h * c.height)
    const d = c.getContext('2d').getImageData(x0, y0, w, h).data
    const l = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    let s = 0
    let n = 0
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = (y * w + x) * 4
        s += (l(i + 4) - l(i)) ** 2 + (l(i + w * 4) - l(i)) ** 2
        n++
      }
    }
    return s / n
  }, r)
}

/** The camera bubble of size `size` in the bottom-right corner (layout.ts webcamRect), output px. */
function bubble(size) {
  const s = Math.min(W, H) * size
  const m = Math.min(W, H) * 0.04
  return { x: W - m - s, y: H - m - s, w: s, h: s }
}
/** A point at (fx, fy) of the bubble. */
const inBubble = (b, fxr, fyr) => ({ x: b.x + b.w * fxr, y: b.y + b.h * fyr })
const sub = (b, x0, y0, x1, y1) => ({ x: b.x + b.w * x0, y: b.y + b.h * y0, w: b.w * (x1 - x0), h: b.h * (y1 - y0) })

/* ---------- editor helpers ---------- */

async function boxOf(win, selector) {
  return win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.left, right: b.right, top: b.top }
  })
}

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

async function drag(win, from, to, steps = 10) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  for (let i = 1; i <= steps; i++) await win.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
  await win.mouse.up()
  await h.sleep(200)
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

/* ---------- tests ---------- */

async function main() {
  await test('camera look: border colour, square vs circle, mirror, zoom and crop', fx.withHome('camera-look', async (ctx, home) => {
    const camera = await personVideo(2)
    const base = { show: true, corner: 'bottom-right', size: 0.4, shadow: 0 }
    seedCamera(home, { id: 'look-a', name: 'Look A', seconds: 2, camera, webcam: { ...base, shape: 'square', border: { width: 12, color: '#ff00ff' }, mirror: false } })
    seedCamera(home, { id: 'look-b', name: 'Look B', seconds: 2, camera, webcam: { ...base, shape: 'circle', border: { width: 0, color: '#ff00ff' }, mirror: true } })
    seedCamera(home, { id: 'look-c', name: 'Look C', seconds: 2, camera, webcam: { ...base, shape: 'square', border: { width: 0, color: '#ffffff' }, mirror: false, zoom: 2, cropX: 0.45, cropY: 0.37 } })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = { a: path.join(home, 'a.mp4'), b: path.join(home, 'b.mp4'), c: path.join(home, 'c.mp4') }
    await exportMp4(app, win, 'Look A', out.a)
    await exportMp4(app, win, 'Look B', out.b)
    await exportMp4(app, win, 'Look C', out.c)
    if (SHOTS) for (const k of ['a', 'b', 'c']) fx.savePng(out[k], 30, path.join(SHOTS, `camera-look-${k}.png`))
    const A = framesAtTimes(out.a, [0.5]).at(0.5)
    const B = framesAtTimes(out.b, [0.5]).at(0.5)
    const C = framesAtTimes(out.c, [0.5]).at(0.5)
    const bb = bubble(0.4)

    // A: a 12 px (8 px at 720p) magenta ring along the square's edges, corners included.
    for (const [fxr, fyr] of [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [0, 0], [1, 1]]) {
      const p = inBubble(bb, fxr, fyr)
      h.assert(isMagenta(rgb(A, p.x, p.y)), `magenta border at (${fxr}, ${fyr}) of the camera: ${rgb(A, p.x, p.y)}`)
    }
    // Square: just inside the box's corner is the picture; a circle leaves the screen showing there.
    const corner = inBubble(bb, 0.05, 0.05)
    h.assert(!isGray(rgb(A, corner.x, corner.y)), `square: the picture fills the corner (${rgb(A, corner.x, corner.y)})`)
    h.assert(isGray(rgb(B, corner.x, corner.y)), `circle: the screen shows in the corner (${rgb(B, corner.x, corner.y)})`)
    // Not mirrored: red left of the person, blue right; mirrored: swapped.
    const left = inBubble(bb, 0.15, 0.48)
    const right = inBubble(bb, 0.85, 0.48)
    console.log(`  left/right markers: plain ${rgb(A, left.x, left.y)} / ${rgb(A, right.x, right.y)}, mirrored ${rgb(B, left.x, left.y)} / ${rgb(B, right.x, right.y)}`)
    h.assert(isRed(rgb(A, left.x, left.y)) && isBlue(rgb(A, right.x, right.y)), 'unmirrored: red on the left, blue on the right')
    h.assert(isBlue(rgb(B, left.x, left.y)) && isRed(rgb(B, right.x, right.y)), 'mirrored: blue on the left, red on the right')

    // C: zoomed 2x on the face, looking a little left of the picture's middle.
    const inner = sub(bb, 0.05, 0.05, 0.95, 0.95)
    const skinA = countIn(A, inner, isSkin)
    const skinC = countIn(C, inner, isSkin)
    const centre = (skinC.cx - bb.x) / bb.w
    console.log(`  skin share 1x ${(skinA.share * 100).toFixed(1)}%, 2x ${(skinC.share * 100).toFixed(1)}%; face centre at ${centre.toFixed(3)} of the camera`)
    h.assert(skinC.share > skinA.share * 2.5, `zooming in enlarges the face (${(skinA.share * 100).toFixed(1)}% -> ${(skinC.share * 100).toFixed(1)}%)`)
    // cropX 0.45 at 2x on a 16:9 picture in a square: the face (picture centre) lands at ~0.68 across.
    h.assert(centre > 0.6 && centre < 0.76, `the crop moves the face right of the middle (${centre.toFixed(3)})`)
  }))

  await test('camera layouts: each layout places the screen and the camera, and changes animate', fx.withHome('camera-layouts', async (ctx, home) => {
    const camera = await personVideo(5)
    const style = { ...BLACK, padding: 0.05 }
    const layouts = [
      { id: 'large', start: 0, end: 1, layout: 'camera-large' },
      { id: 'side', start: 1.4, end: 2.6, layout: 'side-by-side' },
      { id: 'cam', start: 3, end: 3.8, layout: 'camera-only' },
      { id: 'screen', start: 4.2, end: 5, layout: 'screen-only' }
    ]
    seedCamera(home, { id: 'layouts', name: 'Layouts', seconds: 5, camera, style, webcam: { mirror: false }, layouts })
    // The same edit whose camera file has gone missing.
    seedCamera(home, { id: 'gone', name: 'Camera gone', seconds: 5, camera, style, webcam: { mirror: false }, layouts })
    fs.rmSync(path.join(h.projectsRoot(home), 'gone', 'webcam.mp4'))
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = path.join(home, 'layouts.mp4')
    const gone = path.join(home, 'gone.mp4')
    await exportMp4(app, win, 'Layouts', out)
    await exportMp4(app, win, 'Camera gone', gone)
    const times = [0.3, 1.2, 1.5, 1.6, 1.7, 2, 3.4, 4.8]
    if (SHOTS) for (const t of times) fx.savePng(out, Math.round(t * FPS), path.join(SHOTS, `camera-layout-${t}s.png`))
    const F = framesAtTimes(out, times)
    const at = (t, x, y) => rgb(F.at(t), x, y)
    const small = bubble(0.24)
    const large = bubble(0.56)
    const smallC = inBubble(small, 0.5, 0.5)
    const largeC = inBubble(large, 0.3, 0.3)
    const camera_ = (p) => !isGray(p) && !isBlack(p)

    // 0.3 s, large camera (instant at the start of the edit): a big bubble over the screen.
    h.assert(camera_(at(0.3, largeC.x, largeC.y)), `large camera: the camera reaches (${largeC.x.toFixed(0)}, ${largeC.y.toFixed(0)}): ${at(0.3, largeC.x, largeC.y)}`)
    h.assert(isGray(at(0.3, 300, 300)), 'large camera: the screen is still there')
    // 1.2 s, default: the small bubble; where the large one was is the screen.
    h.assert(camera_(at(1.2, smallC.x, smallC.y)), 'default: the bubble')
    h.assert(isGray(at(1.2, largeC.x, largeC.y)), `default: the screen where the large camera was (${at(1.2, largeC.x, largeC.y)})`)
    // 2 s, side by side: the screen card on the left, a tall camera card on the right, inside the padding.
    h.assert(isGray(at(2, 450, 360)), 'side by side: the screen on the left')
    h.assert(camera_(at(2, 1068, 360)), `side by side: the camera card on the right (${at(2, 1068, 360)})`)
    h.assert(isBlack(at(2, 1068, 80)) && isBlack(at(2, 1165, 650)), 'side by side: background above the card and where the bubble was')
    h.assert(camera_(at(2, 1238, 360)) && isBlack(at(2, 1252, 360)), 'side by side: the card ends at the padding')
    // 1.5 .. 1.7 s: the change animates; the screen's right edge (row 200, walking right from
    // inside the solid grey screen) moves left step by step.
    const edge = (t) => {
      let x = 300
      while (x < W - 1 && isGray(at(t, x + 1, 200))) x++
      return x
    }
    const e = [edge(1.2), edge(1.5), edge(1.6), edge(1.7), edge(2)]
    console.log(`  screen right edge at 1.2/1.5/1.6/1.7/2 s: ${e.join(' / ')}`)
    h.assert(e[0] > e[1] && e[1] > e[2] && e[2] > e[3] && e[3] > e[4], 'the screen slides aside smoothly')
    h.assert(e[1] < e[0] - 2 && e[3] > e[4] + 2, 'mid-change frames are between the two layouts')
    h.assert(near(e[2], (e[0] + e[4]) / 2, 40), `halfway through, halfway there (${e[2]} vs ${((e[0] + e[4]) / 2).toFixed(0)})`)
    // 3.4 s, camera only: the camera fills the padded frame, the screen is hidden.
    const pad = 36
    // The screen is flat grey: a pixel whose neighbours 3 px away are grey too is screen (the
    // camera's scaled-down stripes only pass for grey here and there).
    const flat = (buf, x, y) => [[0, 0], [-3, 0], [3, 0], [0, -3], [0, 3]].every(([dx, dy]) => isGray(rgb(buf, x + dx, y + dy)))
    let screenPx = 0
    let samples = 0
    for (let y = pad + 6; y < H - pad - 6; y += 4) {
      for (let x = pad + 6; x < W - pad - 6; x += 4, samples++) if (flat(F.at(3.4), x, y)) screenPx++
    }
    console.log(`  camera only: ${((screenPx / samples) * 100).toFixed(2)}% of the frame is screen (at 2 s: ${(countIn(F.at(2), { x: 100, y: 200, w: 600, h: 300 }, isGray).share * 100).toFixed(0)}% of its middle)`)
    h.assert(screenPx / samples < 0.002, 'camera only: no screen visible')
    h.assert(isBlack(at(3.4, 15, 360)) && camera_(at(3.4, 60, 360)), 'camera only: the camera card ends at the padding')
    // 4.8 s, screen only: no camera.
    h.assert(isGray(at(4.8, smallC.x, smallC.y)), `screen only: the camera is gone (${at(4.8, smallC.x, smallC.y)})`)

    // Without its camera file the layouts do not apply: the screen stays where it is, whole.
    const G = framesAtTimes(gone, [2, 3.4])
    for (const [t, x, y] of [[2, 450, 360], [2, 1068, 360], [2, 1205, 360], [3.4, 100, 100], [3.4, 1180, 620]]) {
      h.assert(isGray(rgb(G.at(t), x, y)), `camera file missing: the screen at (${x}, ${y}) at ${t} s (${rgb(G.at(t), x, y)})`)
    }
  }))

  await test('camera background blur: detail behind the person goes, the person stays sharp (in the preview too)', fx.withHome('camera-blur', async (ctx, home) => {
    const camera = await personVideo(2)
    const all = [{ id: 'cam', start: 0, end: 2, layout: 'camera-only' }]
    seedCamera(home, { id: 'blur', name: 'Blurred', seconds: 2, camera, webcam: { mirror: false, backgroundBlur: 1 }, layouts: all })
    seedCamera(home, { id: 'sharp', name: 'Sharp', seconds: 2, camera, webcam: { mirror: false }, layouts: all })
    const { app, win, logs } = await h.launch({ home, args: WEBGL })
    ctx.app = app
    ctx.logs = logs
    // The Camera panel loads person detection and reports no problem.
    await fx.openProject(win, 'Blurred')
    await win.click('.insp-tabs button[title="Camera"]')
    await win.waitForSelector('[data-testid="blur-status"][data-state="ready"]', { timeout: 30000 })
    h.assert(!(await win.$('[data-testid="blur-unavailable"]')), 'no "unavailable" notice')
    // The preview blurs too, once the frame's mask has arrived: the striped room loses its detail, the face keeps it.
    const preview = await f.waitFor(
      async () => {
        const bgP = await previewSharpness(win, BLUR_BACKGROUND)
        const faceP = await previewSharpness(win, BLUR_FACE)
        return bgP < faceP * 0.3 ? { bgP, faceP } : null
      },
      'the preview blurs the background',
      15000
    )
    console.log(`  preview detail: background ${preview.bgP.toFixed(1)}, face ${preview.faceP.toFixed(1)}`)
    await backHome(win)

    const out = { blur: path.join(home, 'blur.mp4'), sharp: path.join(home, 'sharp.mp4') }
    await exportMp4(app, win, 'Blurred', out.blur)
    await exportMp4(app, win, 'Sharp', out.sharp)
    if (SHOTS) for (const k of ['blur', 'sharp']) fx.savePng(out[k], 30, path.join(SHOTS, `camera-${k}.png`))
    const B = framesAtTimes(out.blur, [0.5, 1.5])
    const S = framesAtTimes(out.sharp, [0.5])
    // Camera only, no padding: the 16:9 picture fills the 16:9 frame (2x).
    const background = scaled(BLUR_BACKGROUND)
    const face = scaled(BLUR_FACE)
    const bg = { sharp: sharpness(S.at(0.5), background), blur: sharpness(B.at(0.5), background) }
    const fc = { sharp: sharpness(S.at(0.5), face), blur: sharpness(B.at(0.5), face) }
    console.log(`  background detail ${bg.sharp.toFixed(1)} -> ${bg.blur.toFixed(1)}, face detail ${fc.sharp.toFixed(1)} -> ${fc.blur.toFixed(1)}`)
    h.assert(bg.blur < bg.sharp * 0.2, `the background behind the person is blurred (${bg.sharp.toFixed(1)} -> ${bg.blur.toFixed(1)})`)
    h.assert(fc.blur > fc.sharp * 0.75, `the person stays sharp (${fc.sharp.toFixed(1)} -> ${fc.blur.toFixed(1)})`)
    // Every frame is blurred alike (each camera frame gets its mask before it is drawn).
    const later = sharpness(B.at(1.5), background)
    h.assert(near(later, bg.blur, Math.max(2, bg.blur * 0.3)), `a later frame is blurred alike (${bg.blur.toFixed(1)} vs ${later.toFixed(1)})`)
  }))

  await test('camera background blur without WebGL: the panel says why, the camera is drawn unblurred', fx.withHome('camera-blur-off', async (ctx, home) => {
    const camera = await personVideo(2)
    const all = [{ id: 'cam', start: 0, end: 2, layout: 'camera-only' }]
    seedCamera(home, { id: 'blur', name: 'Blurred', seconds: 2, camera, webcam: { mirror: false, backgroundBlur: 1 }, layouts: all })
    const { app, win, logs } = await h.launch({ home, args: NO_WEBGL })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Blurred')
    await win.click('.insp-tabs button[title="Camera"]')
    const notice = await f.waitFor(async () => win.textContent('[data-testid="blur-unavailable"]').catch(() => null), 'the unavailable notice', 30000)
    console.log(`  notice: ${notice}`)
    h.assert(/WebGL/.test(notice), 'it names the reason')
    // The preview keeps drawing: the camera fills the frame.
    const drawn = await win.evaluate(() => {
      const c = document.querySelector('.preview-canvas')
      const d = c.getContext('2d').getImageData(Math.floor(c.width * 0.53), Math.floor(c.height * 0.4), 1, 1).data
      return [d[0], d[1], d[2]]
    })
    h.assert(isSkin(drawn), `the preview still shows the camera (${drawn})`)
    await backHome(win)
    const out = path.join(home, 'unblurred.mp4')
    await exportMp4(app, win, 'Blurred', out)
    const F = framesAtTimes(out, [0.5])
    const detail = sharpness(F.at(0.5), scaled(BLUR_BACKGROUND))
    console.log(`  background detail without segmentation ${detail.toFixed(1)}`)
    h.assert(detail > 500, `the export is drawn unblurred (${detail.toFixed(1)})`)
  }))

  await test('camera layout track: hidden without a camera; add, move, trim, change, delete, undo', async (ctx) => {
    const home = h.tempHome('camera-track')
    f.seedProject(home, { id: 'rec-cam', name: 'With camera', seconds: 12, webcam: true })
    f.seedProject(home, { id: 'rec-nocam', name: 'No camera', seconds: 12, ageMs: 1000 })
    f.seedProject(home, { id: 'rec-gone', name: 'Camera gone', seconds: 12, webcam: true, ageMs: 2000 })
    const goneFile = path.join(h.projectsRoot(home), 'rec-gone', 'project.json')
    fs.writeFileSync(goneFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(goneFile, 'utf8')), layouts: [{ id: 'side', start: 0, end: 12, layout: 'side-by-side' }] }, null, 2))
    fs.rmSync(path.join(h.projectsRoot(home), 'rec-gone', 'webcam.mp4'))
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await f.openProject(win, 'No camera')
    h.assert(!(await win.$('[data-testid="layout-track"]')), 'no layout track without a camera')
    await backHome(win)

    // A camera file gone missing: opened as without a camera; saves keep the camera and its layouts.
    await f.openProject(win, 'Camera gone')
    h.assert(!(await win.$('[data-testid="layout-track"]')), 'no layout track without the camera file')
    await win.mouse.click(await xForTime(win, 3), (await boxOf(win, '.tl-ruler')).y)
    await h.sleep(300)
    await win.keyboard.press('z')
    const kept = await saved(home, 'rec-gone', (q) => (q.zooms ?? []).length === 1, 'an edit saved')
    h.assert(kept.hasWebcam === true && kept.layouts.length === 1 && kept.layouts[0].layout === 'side-by-side', `saved with its camera and layouts (hasWebcam ${kept.hasWebcam}, ${kept.layouts.length} layouts)`)
    await backHome(win)

    await f.openProject(win, 'With camera')
    await win.waitForSelector('[data-testid="layout-track"]')
    const track = await boxOf(win, '[data-testid="layout-track"]')
    // Double-click at 3 s adds a side-by-side change there, selected, with its settings shown.
    await win.mouse.dblclick(await xForTime(win, 3), track.y)
    let p = await saved(home, 'rec-cam', (q) => (q.layouts ?? []).length === 1, 'a layout change added')
    let seg = p.layouts[0]
    console.log(`  added ${seg.layout} ${seg.start.toFixed(2)}..${seg.end.toFixed(2)}`)
    h.assert(seg.layout === 'side-by-side' && near(seg.start, 3, 0.1) && near(seg.end - seg.start, 5, 0.01), 'side by side from 3 s for 5 s')
    await win.waitForSelector(`.layout-seg.selected[data-layout="${seg.id}"]`)
    await win.waitForSelector('.insp-tabs button[title="Camera"][aria-pressed="true"]')
    await win.waitForSelector('.layout-option.active:has-text("Side by side")')
    // A double-click inside it adds nothing.
    await win.mouse.dblclick(await xForTime(win, 5), track.y)
    await h.sleep(500)
    h.assert(h.readProject(home, 'rec-cam').layouts.length === 1, 'no change added over another one')

    // Drag it 2 s later.
    const pxPerSec = Number(await win.$eval('.tl-content', (el) => el.dataset.pxPerSec))
    const block = await boxOf(win, `[data-layout="${seg.id}"]`)
    await drag(win, { x: block.x, y: block.y }, { x: block.x + 2 * pxPerSec, y: block.y })
    p = await saved(home, 'rec-cam', (q) => q.layouts[0].start > 4, 'the change moved')
    seg = p.layouts[0]
    h.assert(near(seg.start, 5, 0.15) && near(seg.end, 10, 0.15), `moved to 5..10 s (${seg.start.toFixed(2)}..${seg.end.toFixed(2)})`)
    // Trim its end 1 s earlier.
    const moved = await boxOf(win, `[data-layout="${seg.id}"]`)
    await drag(win, { x: moved.right - 2, y: moved.y }, { x: moved.right - 2 - pxPerSec, y: moved.y })
    p = await saved(home, 'rec-cam', (q) => q.layouts[0].end < 9.6, 'the change trimmed')
    h.assert(near(p.layouts[0].end, 9, 0.15) && near(p.layouts[0].start, seg.start, 1e-6), `ends at 9 s (${p.layouts[0].end.toFixed(2)})`)
    // Change it to camera only from the panel.
    await win.click('.layout-option:has-text("Camera only")')
    p = await saved(home, 'rec-cam', (q) => q.layouts[0].layout === 'camera-only', 'the layout changed')
    await win.waitForSelector(`.layout-seg.camera-only[data-layout="${seg.id}"]`)
    // Delete it, then undo.
    await win.keyboard.press('Delete')
    await saved(home, 'rec-cam', (q) => q.layouts.length === 0, 'the change deleted')
    h.assert(!(await win.$('.layout-seg')), 'gone from the timeline')
    await win.keyboard.press('Control+z')
    p = await saved(home, 'rec-cam', (q) => q.layouts.length === 1, 'the change restored')
    h.assert(p.layouts[0].layout === 'camera-only' && near(p.layouts[0].end, 9, 0.15), 'undo brings it back as it was')

    // Picking a layout with the playhead outside any change adds one there.
    await win.mouse.click(await xForTime(win, 1), (await boxOf(win, '.tl-ruler')).y)
    await h.sleep(300)
    await win.keyboard.press('Escape')
    await win.click('.layout-option:has-text("Large camera")')
    p = await saved(home, 'rec-cam', (q) => q.layouts.length === 2, 'a change added from the panel')
    const large = p.layouts.find((s) => s.layout === 'camera-large')
    h.assert(large && near(large.start, 1, 0.1) && large.end <= p.layouts.find((s) => s.layout === 'camera-only').start + 1e-6, `large camera from the playhead, before the next change (${large && large.start.toFixed(2)}..${large && large.end.toFixed(2)})`)

    // The framing pad keeps the point pressed (the 4:3 camera mirrored in the round bubble shows
    // 3/4 of its width) ...
    const pressPad = async (t, fxr, fyr) => {
      await win.mouse.click(await xForTime(win, t), (await boxOf(win, '.tl-ruler')).y)
      await h.sleep(300)
      await win.keyboard.press('Escape')
      await win.locator('[data-testid="camera-framing"]').scrollIntoViewIfNeeded()
      const pad = await boxOf(win, '[data-testid="camera-framing"]')
      await win.mouse.click(pad.left + pad.w * fxr, pad.top + pad.h * fyr)
    }
    await pressPad(0.5, 0.1, 0.5)
    p = await saved(home, 'rec-cam', (q) => q.webcam.cropX !== undefined, 'the framing set')
    console.log(`  framing in the bubble: ${p.webcam.cropX}, ${p.webcam.cropY}`)
    h.assert(near(p.webcam.cropX, 0.9, 0.02), `the point pressed, also past what the bubble can centre on (${p.webcam.cropX})`)
    // ... and a press where the camera fills the frame (its whole width shows) moves only the height.
    await pressPad(6, 0.5, 0.15)
    p = await saved(home, 'rec-cam', (q) => q.webcam.cropY < 0.4, 'the framing moved')
    console.log(`  framing after a press in camera only: ${p.webcam.cropX}, ${p.webcam.cropY}`)
    h.assert(near(p.webcam.cropX, 0.9, 0.02) && near(p.webcam.cropY, 0.15, 0.02), `the bubble's framing across is kept (${p.webcam.cropX}, ${p.webcam.cropY})`)
    if (!process.env.SSW_E2E_KEEP) fs.rmSync(home, { recursive: true, force: true })
  })
}

main()
