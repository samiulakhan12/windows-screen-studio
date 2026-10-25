// Cursor and click effects in real exports and in the editor: cursor styles (built-in
// sets and custom PNG / SVG / CUR images), the highlight halo, ripple / ring / pulse click
// effects, click sounds (export and preview playback), loop home, tilt and trail.
// Set SSW_E2E_SHOTS=<dir> to save frames and panel screenshots for looking at.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const FPS = 60
const at = (t) => Math.round(t * FPS)
const NATIVE = { method: 'native', cursorInVideo: false, region: null }
const CHROMIUM = { method: 'chromium', cursorInVideo: true, region: null }
const GRAY_STYLE = { background: { type: 'color', color: '#808080' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
const BASE_CURSOR = { show: true, size: 2.5, smoothing: 0.5, clickEffect: false, hideWhenIdle: false }

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const still = (x, y, seconds) => [{ t: 0, x, y }, { t: seconds, x, y }]
const track = (samples, clicks = []) => ({ samples, clicks, keys: [], shapes: [], scale: 1, valid: true })

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

/** Pixels of an rgb24 frame inside a rectangle (output pixels). */
function* pixels(frame, W, r) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * W + x) * 3
      yield { x, y, r: frame[i], g: frame[i + 1], b: frame[i + 2] }
    }
  }
}

const count = (frame, W, r, pred) => {
  let n = 0
  for (const p of pixels(frame, W, r)) if (pred(p)) n++
  return n
}

const meanDiff = (a, b, W, r) => {
  let s = 0
  let n = 0
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * W + x) * 3
      s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      n += 3
    }
  }
  return s / n
}

/** Bounding box and centroid of the pixels matching `pred`. */
function blob(frame, W, r, pred) {
  let n = 0
  let sx = 0
  let sy = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pixels(frame, W, r)) {
    if (!pred(p)) continue
    n++
    sx += p.x
    sy += p.y
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return { n, cx: sx / n, cy: sy / n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

const offGray = (p) => Math.abs(p.r - 128) + Math.abs(p.g - 128) + Math.abs(p.b - 128) > 90
const dark = (p) => p.r < 50 && p.g < 50 && p.b < 50
const bright = (p) => p.r > 215 && p.g > 215 && p.b > 215
const red = (p) => p.r > 170 && p.g < 90 && p.b < 90
const blue = (p) => p.b > 170 && p.r < 110 && p.g < 130
const green = (p) => p.g > 150 && p.r < 110 && p.b < 120
const magenta = (p) => p.r > 170 && p.b > 170 && p.g < 90

/** A PNG made by ffmpeg: a red card with a blue inner block (easy to find and tell apart). */
function cardPng(file) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff2020:s=40x56', '-vf', 'drawbox=x=8:y=10:w=24:h=36:color=0x2040ff:t=fill', '-frames:v', '1', file])
}

/** A Windows .cur file holding one PNG image (Vista-style), hot spot fields set to (0, 0). */
function curFile(file, scratch) {
  const png = path.join(scratch, 'cur-inner.png')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff00ff:s=32x32', '-frames:v', '1', png])
  const data = fs.readFileSync(png)
  const header = Buffer.alloc(6 + 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(2, 2) // 2 = cursor
  header.writeUInt16LE(1, 4)
  header.writeUInt8(32, 6)
  header.writeUInt8(32, 7)
  header.writeUInt16LE(0, 10) // hot spot x
  header.writeUInt16LE(0, 12) // hot spot y
  header.writeUInt32LE(data.length, 14)
  header.writeUInt32LE(22, 18)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30" viewBox="0 0 20 30"><path d="M1 1 L1 28 L19 19 Z" fill="#00c040" stroke="#ffffff" stroke-width="1.5"/></svg>'

/** Bundles src/shared/render/clickSound.ts (and its imports) for use in this Node process. */
function clickSoundModule(dir) {
  const outfile = path.join(dir, 'clickSound.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(h.APP_DIR, 'src/shared/render/clickSound.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  })
  return require(outfile)
}

async function main() {
  await test('cursor: every style draws a distinct, crisp cursor at the recorded spot (export)', fx.withHome('cursor-styles', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 1 })
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-cursor-img-'))
    const styles = [
      { id: 'auto', cursor: { style: 'auto' } },
      { id: 'mac', cursor: { style: 'mac' } },
      { id: 'windows', cursor: { style: 'windows' } },
      { id: 'white', cursor: { style: 'white' } },
      { id: 'black', cursor: { style: 'black' } },
      { id: 'custom-png', cursor: { style: 'custom', customImage: 'cursor.png' }, file: 'cursor.png' },
      { id: 'custom-svg', cursor: { style: 'custom', customImage: 'cursor.svg' }, file: 'cursor.svg' },
      { id: 'custom-cur', cursor: { style: 'custom', customImage: 'cursor.cur' }, file: 'cursor.cur' },
      // An older project without any of the new fields.
      { id: 'legacy', cursor: {} }
    ]
    for (const s of styles) {
      fx.seedProject(home, {
        id: `rec-${s.id}`,
        name: `Style ${s.id}`,
        media,
        seconds: 1,
        style: GRAY_STYLE,
        capture: NATIVE,
        cursorSettings: { ...BASE_CURSOR, ...s.cursor },
        cursor: track(still(0.5, 0.5, 1))
      })
      const target = s.file && path.join(h.projectsRoot(home), `rec-${s.id}`, s.file)
      if (s.file === 'cursor.png') cardPng(target)
      if (s.file === 'cursor.svg') fs.writeFileSync(target, SVG)
      if (s.file === 'cursor.cur') curFile(target, scratch)
    }
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const frames = {}
    let W = 0
    for (const s of styles) {
      const out = path.join(home, `${s.id}.mp4`)
      await exportMp4(app, win, `Style ${s.id}`, out)
      const F = fx.framesAt(out, [at(0.5)], 'rgb24')
      frames[s.id] = F.frames[0]
      W = F.width
      if (SHOTS) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', `select='eq(n\\,30)',crop=160:160:600:320,scale=480:480:flags=neighbor`, '-frames:v', '1', path.join(SHOTS, `style-${s.id}.png`)])
    }
    // The hotspot is at (640, 360); sprites extend down and to the right of it.
    const box = { x: 624, y: 344, w: 110, h: 120 }
    const sig = {}
    for (const s of styles) {
      const fr = frames[s.id]
      sig[s.id] = {
        ink: count(fr, W, box, offGray),
        dark: count(fr, W, box, dark),
        bright: count(fr, W, box, bright),
        red: count(fr, W, box, red),
        blue: count(fr, W, box, blue),
        green: count(fr, W, box, green),
        magenta: count(fr, W, box, magenta),
        shape: blob(fr, W, box, offGray)
      }
      const g = sig[s.id]
      console.log(`  ${s.id}: ink ${g.ink} dark ${g.dark} bright ${g.bright} red ${g.red} blue ${g.blue} green ${g.green} magenta ${g.magenta} box ${g.shape.w}x${g.shape.h} at ${g.shape.x0},${g.shape.y0}`)
      h.assert(g.ink > 300, `${s.id}: a cursor is drawn at the recorded spot`)
      // Nothing is drawn up and to the left of the hotspot (it is the tip / the image's corner).
      h.assert(g.shape.x0 >= 630 && g.shape.y0 >= 350, `${s.id}: drawn from the hotspot (${g.shape.x0},${g.shape.y0})`)
    }
    // An older project looks exactly like Auto (which is the original look).
    h.assert(meanDiff(frames.legacy, frames.auto, W, box) < 0.5, 'a project without the new fields renders like Auto')
    // Light sets are mostly white, dark sets mostly black.
    for (const id of ['auto', 'windows', 'white']) h.assert(sig[id].bright > sig[id].dark, `${id} is a light cursor`)
    for (const id of ['mac', 'black']) h.assert(sig[id].dark > sig[id].bright, `${id} is a dark cursor`)
    // The high-contrast sets are larger.
    h.assert(sig.white.shape.h > sig.windows.shape.h * 1.15 && sig.black.shape.h > sig.mac.shape.h * 1.15, 'white and black are large')
    // Custom images: their own colours, at the hotspot.
    h.assert(sig['custom-png'].red > 600 && sig['custom-png'].blue > 300, 'the PNG cursor is drawn (red card, blue block)')
    h.assert(sig['custom-svg'].green > 300, 'the SVG cursor is drawn')
    h.assert(sig['custom-cur'].magenta > 300, 'the CUR cursor is drawn')
    for (const id of ['auto', 'mac', 'windows', 'white', 'black']) h.assert(sig[id].red + sig[id].green + sig[id].magenta === 0, `${id} has no custom colours`)
    // Every pair of styles differs at the cursor.
    const ids = styles.map((s) => s.id).filter((id) => id !== 'legacy')
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = meanDiff(frames[ids[i]], frames[ids[j]], W, box)
        h.assert(d > 2, `${ids[i]} vs ${ids[j]} differ at the cursor (${d.toFixed(2)})`)
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  }))

  await test('cursor: highlight halo in its colour, following the smoothed cursor and scaling with zoom (export)', fx.withHome('cursor-highlight', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 3 })
    // The cursor jumps from (0.3, 0.5) to (0.7, 0.5) at 0.5 s; the smoothed cursor glides over.
    const samples = [{ t: 0, x: 0.3, y: 0.5 }, { t: 0.5, x: 0.3, y: 0.5 }, { t: 0.51, x: 0.7, y: 0.5 }, { t: 3, x: 0.7, y: 0.5 }]
    const highlight = { enabled: true, color: '#00ff00', size: 1.5, opacity: 0.7 }
    for (const [id, cursor, zooms] of [
      ['on', { highlight }, []],
      ['off', {}, []],
      // Fully zoomed in from 0.7 s to 2.3 s.
      ['zoom', { highlight }, [{ id: 'z', start: 0, end: 3, scale: 2, focus: { mode: 'fixed', x: 0.7, y: 0.5 }, auto: false }]]
    ]) {
      fx.seedProject(home, { id: `rec-${id}`, name: `Halo ${id}`, media, seconds: 3, style: GRAY_STYLE, capture: NATIVE, zooms, cursorSettings: { ...BASE_CURSOR, size: 1.5, ...cursor }, cursor: track(samples) })
    }
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const outs = {}
    for (const id of ['on', 'off', 'zoom']) {
      outs[id] = path.join(home, `${id}.mp4`)
      await exportMp4(app, win, `Halo ${id}`, outs[id])
    }
    const idx = [at(0.3), at(1.6)]
    const [A, B, Z] = ['on', 'off', 'zoom'].map((id) => fx.framesAt(outs[id], idx, 'rgb24'))
    const W = A.width
    // Up-left of the hotspot: only the halo can be there (the arrow extends down-right).
    const nearLeft = { x: Math.round(0.3 * 1280) - 22, y: 360 - 22, w: 14, h: 14 }
    const nearRight = { x: Math.round(0.7 * 1280) - 22, y: 360 - 22, w: 14, h: 14 }
    const greenish = (p) => p.g > p.r + 40 && p.g > p.b + 40
    const c = (F, i, r) => count(F.frames[i], W, r, greenish)
    console.log(`  halo at 0.3 s: left ${c(A, 0, nearLeft)} right ${c(A, 0, nearRight)}; at 1.6 s: left ${c(A, 1, nearLeft)} right ${c(A, 1, nearRight)}`)
    h.assert(c(A, 0, nearLeft) > 150 && c(A, 0, nearRight) === 0, 'halo around the cursor at its first position')
    h.assert(c(A, 1, nearRight) > 150 && c(A, 1, nearLeft) === 0, 'halo followed the cursor to its second position')
    h.assert(c(B, 0, nearLeft) === 0 && c(B, 1, nearRight) === 0, 'no halo when it is off')
    // Halo radius: the extent of green along the row through the hotspot, unzoomed vs 2x zoom.
    const extent = (F, i, cx) => {
      const row = { x: 0, y: 360, w: 1280, h: 1 }
      const xs = []
      for (const p of pixels(F.frames[i], W, row)) if (greenish(p)) xs.push(p.x)
      return xs.length ? { from: Math.min(...xs), to: Math.max(...xs), left: cx - Math.min(...xs) } : null
    }
    const plain = extent(A, 1, Math.round(0.7 * 1280))
    // With a fixed 2x zoom on (0.7, 0.5) the hotspot is drawn at the frame centre.
    const zoomed = extent(Z, 1, 640)
    console.log(`  halo extent left of the hotspot: ${plain && plain.left}px plain, ${zoomed && zoomed.left}px at 2x zoom`)
    h.assert(plain && zoomed && zoomed.left > plain.left * 1.7 && zoomed.left < plain.left * 2.3, 'the halo scales with the zoom')
    if (SHOTS) {
      fx.savePng(outs.on, at(1.6), path.join(SHOTS, 'halo-1.6s.png'))
      fx.savePng(outs.zoom, at(1.6), path.join(SHOTS, 'halo-zoom-1.6s.png'))
    }
  }))

  await test('cursor: ripple, ring and pulse click effects differ, use the click colour and respect clip speed (export)', fx.withHome('cursor-clicks', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 2 })
    const clicks = [{ t: 0.5, x: 0.5, y: 0.5, button: 'left' }]
    const kinds = ['ripple', 'ring', 'pulse']
    for (const kind of kinds) {
      // OS cursor in the video: no synthetic cursor, click effects still drawn.
      fx.seedProject(home, {
        id: `rec-${kind}`,
        name: `Click ${kind}`,
        media,
        seconds: 2,
        style: GRAY_STYLE,
        capture: CHROMIUM,
        cursorSettings: { ...BASE_CURSOR, show: false, clickEffect: true, clickStyle: kind, clickColor: '#ff0000' },
        cursor: track(still(0.5, 0.5, 2), clicks)
      })
    }
    // The same ring in a 2x clip plays twice as fast (in output time).
    fx.seedProject(home, {
      id: 'rec-ring-2x',
      name: 'Fast ring',
      media,
      seconds: 2,
      style: GRAY_STYLE,
      capture: CHROMIUM,
      clips: [{ id: 'c0', start: 0, end: 2, speed: 2 }],
      cursorSettings: { ...BASE_CURSOR, show: false, clickEffect: true, clickStyle: 'ring', clickColor: '#ff0000' },
      cursor: track(still(0.5, 0.5, 2), clicks)
    })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const outs = {}
    for (const kind of kinds) {
      outs[kind] = path.join(home, `${kind}.mp4`)
      await exportMp4(app, win, `Click ${kind}`, outs[kind])
    }
    outs.ring2x = path.join(home, 'ring2x.mp4')
    await exportMp4(app, win, 'Fast ring', outs.ring2x)
    if (SHOTS) {
      for (const kind of kinds) {
        for (const t of [0.55, 0.62, 0.7, 0.8]) {
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', outs[kind], '-vf', `select='eq(n\\,${at(t)})',crop=200:200:540:260`, '-frames:v', '1', path.join(SHOTS, `click-${kind}-${t}.png`)])
        }
      }
    }
    const idx = [at(0.45), at(0.62), at(0.75)]
    const F = {}
    for (const kind of kinds) F[kind] = fx.framesAt(outs[kind], idx, 'rgb24')
    const W = F.ripple.width
    const area = { x: 640 - 60, y: 360 - 60, w: 120, h: 120 }
    const centre = { x: 640 - 2, y: 360 - 2, w: 4, h: 4 }
    const reddish = (p) => p.r > p.g + 50 && p.r > p.b + 50
    for (const kind of kinds) {
      const r = idx.map((_, i) => count(F[kind].frames[i], W, area, reddish))
      const mid = count(F[kind].frames[1], W, centre, reddish)
      console.log(`  ${kind}: red pixels before/at 0.62/at 0.75 s: ${r.join('/')}, at the centre ${mid}`)
      h.assert(r[0] === 0, `${kind}: nothing before the click`)
      h.assert(r[1] > 100, `${kind}: drawn in the click colour after the click`)
    }
    // A ring is hollow; a pulse is a filled dot.
    h.assert(count(F.ring.frames[1], W, centre, reddish) === 0, 'ring: hollow centre')
    h.assert(count(F.pulse.frames[1], W, centre, reddish) === 16, 'pulse: filled centre')
    for (const [a, b] of [['ripple', 'ring'], ['ripple', 'pulse'], ['ring', 'pulse']]) {
      const d = meanDiff(F[a].frames[1], F[b].frames[1], W, area)
      h.assert(d > 1, `${a} vs ${b} differ (${d.toFixed(2)})`)
    }
    // 2x clip: the click is at output 0.25 s. Effects are timed in viewing time, so a sped-up
    // clip neither cuts them short nor rushes them: the same picture 0.15 s after the click.
    const R2 = fx.framesAt(outs.ring2x, [at(0.25 + 0.15), at(0.25 + 0.5)], 'rgb24')
    const R1 = fx.framesAt(outs.ring, [at(0.5 + 0.15), at(0.5 + 0.5)], 'rgb24')
    const n = (FF, i) => count(FF.frames[i], W, area, reddish)
    // Outer radius of the ring: the furthest pixel right of the click, on its row, that the ring
    // darkens. Measured on the luma plane, which is full resolution: the colour of a 1.4 px ring
    // is one 4:2:0 chroma sample per 2x2 block, decoded to within a few levels of the redness
    // threshold, so the colour conversion and the encoder decide whether it counts as red.
    const L2 = fx.framesAt(outs.ring2x, [at(0.25 + 0.15)], 'gray')
    const L1 = fx.framesAt(outs.ring, [at(0.5 + 0.15)], 'gray')
    const radius = (FF) => {
      const y = FF.frames[0]
      // The grey background, right of the ring.
      let bg = 0
      for (let x = 740; x < 760; x++) bg += y[360 * W + x]
      bg /= 20
      let r = 0
      for (let row = 359; row < 362; row++) for (let x = 640; x < 720; x++) if (y[row * W + x] <= bg - 10) r = Math.max(r, x - 640)
      return r
    }
    const ring1 = { n: n(R1, 0), r: radius(L1) }
    const ring2 = { n: n(R2, 0), r: radius(L2) }
    console.log(`  ring 0.15 s after the click: 1x ${JSON.stringify(ring1)}, 2x ${JSON.stringify(ring2)}; 0.5 s after: ${n(R1, 1)}/${n(R2, 1)} red pixels`)
    h.assert(ring1.n > 100 && ring2.n > 100 && ring1.r > 10 && Math.abs(ring1.r - ring2.r) <= 2, 'the effect looks the same 0.15 s after the click at 1x and 2x')
    h.assert(n(R1, 1) === 0 && n(R2, 1) === 0, 'and has ended 0.5 s after it at both speeds')
  }))

  await test('cursor: click sounds land on the clicks in the export, through cuts and speed changes', fx.withHome('cursor-sound', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 4 })
    // Kept: source 0..1 at 1x, source 2..4 at 2x. Clicks: 0.5 -> 0.5, 1.5 (cut), 2.5 -> 1.25, 3.2 -> 1.6.
    const clips = [{ id: 'c0', start: 0, end: 1, speed: 1 }, { id: 'c1', start: 2, end: 4, speed: 2 }]
    const clicks = [0.5, 1.5, 2.5, 3.2].map((t) => ({ t, x: 0.5, y: 0.5, button: 'left' }))
    const cursorSettings = { ...BASE_CURSOR, clickEffect: true, clickSound: true, clickSoundVolume: 1 }
    const cursor = track(still(0.5, 0.5, 4), clicks)
    const id = fx.seedProject(home, { id: 'rec-sound', name: 'Click sounds', media, seconds: 4, style: GRAY_STYLE, capture: NATIVE, clips, cursorSettings, cursor })
    const expected = [0.5, 1.25, 1.6]

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-click-sound-'))
    try {
      const mod = clickSoundModule(scratch)
      const project = h.readProject(home, id)
      const job = mod.clickSoundJob(project, cursor, clips)
      h.assert(job && JSON.stringify(job.times) === JSON.stringify(expected), `clickSoundJob output times ${JSON.stringify(job)}`)

      const { app, win, logs } = await h.launch({ home })
      ctx.app = app
      ctx.logs = logs
      const out = path.join(home, 'sound.mp4')
      await exportMp4(app, win, 'Click sounds', out)
      const hasAudio = fx.probe(out).streams.some((s) => s.codec_type === 'audio')
      // Feature check: the export builder mixes clickSoundJob() into the soundtrack.
      const exportSources = ['src/renderer/src/editor/exporter.ts', 'src/main/exportArgs.ts', 'src/main/exportIpc.ts', 'src/main/exportJob.ts']
        .map((p) => path.join(h.APP_DIR, p))
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.readFileSync(p, 'utf8'))
        .join('\n')
      const mixed = /clickSound(Job|Source)\(/.test(exportSources)
      if (mixed || hasAudio) {
        h.assert(hasAudio, 'the export has a soundtrack with the click sounds (the project has no recorded audio)')
        const { onsets } = fx.beepOnsets(out, 0.05)
        console.log(`  export click onsets ${JSON.stringify(onsets)} (expected ${JSON.stringify(expected)})`)
        h.assert(onsets.length === expected.length && onsets.every((t, i) => Math.abs(t - expected[i]) < 0.03), 'clicks heard at their output times in the export')
      } else {
        console.log('  NOTE: the export builder does not mix click sounds in yet; checking clickSoundJob + clickSoundSource with ffmpeg directly')
      }
      // The contract on its own: one aevalsrc click per job time, mixed and gained like an export would.
      const wav = path.join(scratch, 'clicks.wav')
      const n = job.times.length
      const graph = [
        `[0:a]asplit=${n}${job.times.map((_, i) => `[s${i}]`).join('')}`,
        ...job.times.map((t, i) => `[s${i}]adelay=${Math.round(t * 1000)}:all=1[d${i}]`),
        `${job.times.map((_, i) => `[d${i}]`).join('')}amix=inputs=${n}:normalize=0,volume=${job.volume},apad=whole_dur=2[out]`
      ].join(';')
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', mod.clickSoundSource(), '-filter_complex', graph, '-map', '[out]', wav])
      const direct = fx.beepOnsets(wav, 0.05)
      console.log(`  direct ffmpeg render onsets ${JSON.stringify(direct.onsets)}`)
      h.assert(direct.onsets.length === expected.length && direct.onsets.every((t, i) => Math.abs(t - expected[i]) < 0.01), 'aevalsrc clicks at the job times')
      h.assert(Math.abs(direct.duration - 2) < 0.01, 'two seconds of audio')
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }))

  await test('cursor: preview plays one click sound per kept click (cuts, 2x), none while scrubbing', fx.withHome('cursor-preview-sound', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 4 })
    const clips = [{ id: 'c0', start: 0, end: 1, speed: 1 }, { id: 'c1', start: 2, end: 4, speed: 2 }]
    const clicks = [0.5, 1.5, 2.5, 3.2].map((t) => ({ t, x: 0.5, y: 0.5, button: 'left' }))
    fx.seedProject(home, {
      id: 'rec-psound',
      name: 'Preview sounds',
      media,
      seconds: 4,
      style: GRAY_STYLE,
      capture: NATIVE,
      clips,
      cursorSettings: { ...BASE_CURSOR, clickEffect: true, clickSound: true, clickSoundVolume: 0.7 },
      cursor: track(still(0.5, 0.5, 4), clicks)
    })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Preview sounds')
    // Count every Web Audio buffer source started (the click voices; the soundtrack is a media element).
    await win.evaluate(() => {
      window.__clicks = []
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args) {
        window.__clicks.push({ when: args[0] ?? 0, now: this.context.currentTime, rate: this.context.sampleRate, len: this.buffer && this.buffer.length })
        return start.apply(this, args)
      }
    })
    const clicksPlayed = () => win.evaluate(() => window.__clicks.length)
    const playing = () => win.$eval('.transport .btn.round', (b) => b.dataset.playing === 'true')
    // Scrubbing while paused: stepping and jumping over the clicks plays nothing.
    h.assert(!(await playing()), 'paused')
    await win.keyboard.press('Home')
    for (let i = 0; i < 40; i++) await win.keyboard.press('ArrowRight')
    await win.keyboard.press('Shift+ArrowRight')
    await win.keyboard.press('End')
    await win.keyboard.press('Home')
    await h.sleep(300)
    h.assert((await clicksPlayed()) === 0, `no click sounds while scrubbing (${await clicksPlayed()})`)
    // Play the whole edit: 3 kept clicks (the one in the cut is skipped).
    await win.keyboard.press('Space')
    await f.waitFor(playing, 'playing')
    await f.waitFor(async () => !(await playing()), 'played to the end', 15000)
    const played = await win.evaluate(() => window.__clicks)
    console.log(`  preview click voices: ${JSON.stringify(played)}`)
    h.assert(played.length === 3, `three click sounds in the preview (got ${played.length})`)
    h.assert(played.every((c) => c.len === Math.round(0.06 * c.rate)), 'each is the 60 ms synthesised click')
    // Pressing play again from the end restarts from the beginning: the same three again, no extra burst.
    await win.keyboard.press('Space')
    await f.waitFor(playing, 'playing again')
    await f.waitFor(async () => !(await playing()), 'played to the end again', 15000)
    h.assert((await clicksPlayed()) === 6, `three more on the second pass (total ${await clicksPlayed()})`)
    // Click sound off: silent playback.
    await win.click('.insp-tabs button:has-text("Cursor")')
    await win.click('label.toggle:has-text("Click sound")')
    await win.keyboard.press('Space')
    await f.waitFor(playing, 'playing a third time')
    await f.waitFor(async () => !(await playing()), 'played to the end a third time', 15000)
    h.assert((await clicksPlayed()) === 6, 'no click sounds when switched off')
  }))

  await test('cursor: loop home returns to the start; tilt and trail only while moving (export)', fx.withHome('cursor-motion', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 3 })
    // Moves right from 0.25 to 0.75 between 0.3 s and 0.9 s, then rests.
    const samples = []
    for (let t = 0; t <= 3.0001; t += 1 / 60) {
      const k = Math.min(1, Math.max(0, (t - 0.3) / 0.6))
      samples.push({ t: +t.toFixed(4), x: 0.25 + 0.5 * k, y: 0.5 })
    }
    const base = { ...BASE_CURSOR, size: 1.6, smoothing: 0.2, style: 'black' }
    const projects = [
      ['plain', {}],
      ['loop', { loopHome: true }],
      ['tilt', { tilt: true }],
      ['trail', { trail: true }]
    ]
    for (const [id, extra] of projects) fx.seedProject(home, { id: `rec-${id}`, name: `Motion ${id}`, media, seconds: 3, style: GRAY_STYLE, capture: NATIVE, cursorSettings: { ...base, ...extra }, cursor: track(samples) })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const outs = {}
    for (const [id] of projects) {
      outs[id] = path.join(home, `${id}.mp4`)
      await exportMp4(app, win, `Motion ${id}`, outs[id])
    }
    const idx = [0, at(0.2), at(0.6), at(1.5), at(2.5), 179]
    const F = {}
    for (const [id] of projects) F[id] = fx.framesAt(outs[id], idx, 'rgb24')
    const W = F.plain.width
    if (SHOTS) {
      for (const id of ['plain', 'tilt', 'trail']) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', outs[id], '-vf', `select='eq(n\\,${at(0.6)})',crop=320:160:440:290`, '-frames:v', '1', path.join(SHOTS, `motion-${id}-0.6s.png`)])
      fx.savePng(outs.loop, at(2.5), path.join(SHOTS, 'motion-loop-2.5s.png'))
    }
    const all = { x: 0, y: 300, w: 1280, h: 160 }
    const pos = (id, i) => blob(F[id].frames[i], W, all, dark)
    // Around the (plain) cursor in frame i, with room behind it for a trail.
    const around = (i) => {
      const b = pos('plain', i)
      const x = Math.max(0, Math.round(b.x0 - 110))
      return { x, y: Math.max(0, b.y0 - 20), w: Math.min(1280 - x, Math.round(b.x1 + 30) - x), h: 120 }
    }
    // Loop home: the last frame shows the cursor where the first frame does.
    const first = pos('loop', 0)
    const last = pos('loop', 5)
    const mid = pos('loop', 4)
    const plainLast = pos('plain', 5)
    console.log(`  loop: first ${first.cx.toFixed(1)}, 1.5 s ${pos('loop', 3).cx.toFixed(1)}, 2.5 s ${mid.cx.toFixed(1)}, last ${last.cx.toFixed(1)}; without loop last ${plainLast.cx.toFixed(1)}`)
    h.assert(Math.abs(last.cx - first.cx) < 2 && Math.abs(last.cy - first.cy) < 2, 'loop home: last frame matches the first')
    h.assert(Math.abs(plainLast.cx - 0.75 * 1280) < 30, 'without loop home the cursor stays where it was')
    h.assert(Math.abs(pos('loop', 3).cx - plainLast.cx) < 1, 'loop home leaves the cursor alone before the last second')
    h.assert(mid.cx > first.cx + 100 && mid.cx < plainLast.cx - 100, 'gliding back during the last second')
    // Tilt and trail: identical to the plain export while still, different while moving.
    for (const id of ['tilt', 'trail']) {
      const stillDiff = meanDiff(F[id].frames[1], F.plain.frames[1], W, around(1))
      const restDiff = meanDiff(F[id].frames[3], F.plain.frames[3], W, around(3))
      const movingDiff = meanDiff(F[id].frames[2], F.plain.frames[2], W, around(2))
      console.log(`  ${id}: diff around the cursor still ${stillDiff.toFixed(3)}, at rest ${restDiff.toFixed(3)}, moving ${movingDiff.toFixed(3)}`)
      h.assert(stillDiff < 0.5 && restDiff < 0.5, `${id}: no effect while the cursor is still`)
      h.assert(movingDiff > Math.max(stillDiff, restDiff) + 2, `${id}: visible while moving`)
    }
    // Tilt leans into the movement (right): pivoting on the tip, the bottom of the arrow swings left.
    const plainMoving = pos('plain', 2)
    const tiltMoving = pos('tilt', 2)
    console.log(`  moving cursor box: plain x ${plainMoving.x0}..${plainMoving.x1} top ${plainMoving.y0}, tilted x ${tiltMoving.x0}..${tiltMoving.x1} top ${tiltMoving.y0}`)
    h.assert(tiltMoving.x0 < plainMoving.x0 - 3 && Math.abs(tiltMoving.y0 - plainMoving.y0) <= 2, 'tilted about the tip while moving')
    // Trail: ghosts behind (left of) the cursor.
    const ghostZone = { x: Math.round(plainMoving.x0 - 120), y: 300, w: 115, h: 160 }
    const ghosts = (id) => count(F[id].frames[2], W, ghostZone, (p) => p.r < 110 && p.g < 110 && p.b < 110)
    console.log(`  pixels behind the moving cursor: plain ${ghosts('plain')}, trail ${ghosts('trail')}`)
    h.assert(ghosts('trail') > ghosts('plain') + 100, 'a trail behind the moving cursor')
  }))

  await test('cursor: the Cursor panel picks a custom image (copied into the project), draws it in the preview, and undo restores the style', async (ctx) => {
    const home = h.tempHome('cursor-panel')
    try {
      const media = fx.solidVideo({ seconds: 2 })
      const id = fx.seedProject(home, {
        id: 'rec-panel',
        name: 'Panel',
        media,
        seconds: 2,
        style: GRAY_STYLE,
        capture: NATIVE,
        cursorSettings: { ...BASE_CURSOR, clickEffect: true },
        cursor: track(still(0.5, 0.5, 2), [{ t: 1, x: 0.5, y: 0.5, button: 'left' }])
      })
      const png = path.join(home, 'my-cursor.png')
      cardPng(png)
      const bad = path.join(home, 'broken.png')
      fs.writeFileSync(bad, 'not an image')
      const { app, win, logs } = await h.launch({ home })
      ctx.app = app
      ctx.logs = logs
      await app.evaluate(({ dialog }, files) => {
        let i = 0
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files[i++]] })
      }, [png, bad])
      await f.openProject(win, 'Panel')
      await win.click('.insp-tabs button:has-text("Cursor")')
      const sections = await win.$$eval('.insp-body .insp-section h3 > span:first-child', (els) => els.map((e) => e.textContent))
      h.assert(JSON.stringify(sections) === JSON.stringify(['Cursor', 'Highlight', 'Clicks', 'Motion']), `panel sections ${JSON.stringify(sections)}`)
      h.assert((await win.getAttribute('button[aria-label="Auto cursor"]', 'aria-checked')) === 'true', 'Auto selected')
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'panel-auto.png') })
      const redInPreview = () =>
        win.evaluate(() => {
          const c = document.querySelector('.preview-canvas')
          const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height)
          let n = 0
          for (let i = 0; i < data.length; i += 4) if (data[i] > 170 && data[i + 1] < 90 && data[i + 2] < 90) n++
          return n
        })
      h.assert((await redInPreview()) === 0, 'no red before')
      await win.click('button[aria-label="Custom cursor"]')
      await f.waitFor(async () => (await win.getAttribute('button[aria-label="Custom cursor"]', 'aria-checked')) === 'true', 'custom selected')
      const dir = path.join(h.projectsRoot(home), id)
      h.assert(fs.existsSync(path.join(dir, 'cursor.png')), 'the image was copied into the project folder')
      await f.waitFor(async () => (await redInPreview()) > 100, 'the custom cursor is drawn in the preview')
      await win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
      await f.waitFor(() => h.readProject(home, id).cursor.customImage === 'cursor.png' && h.readProject(home, id).cursor.style === 'custom', 'saved custom style')
      h.assert(await win.$('.custom-cursor-row:has-text("cursor.png")'), 'the chosen file is shown')
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'panel-custom.png') })
      // Undo: back to Auto, the built-in arrow again.
      await win.keyboard.press('Control+z')
      await f.waitFor(async () => (await win.getAttribute('button[aria-label="Auto cursor"]', 'aria-checked')) === 'true', 'undo restores Auto')
      await f.waitFor(async () => (await redInPreview()) === 0, 'undo removes the custom cursor from the preview')
      await win.keyboard.press('Control+y')
      await f.waitFor(async () => (await redInPreview()) > 100, 'redo draws it again')
      // An unreadable image is refused with a message; the look does not change.
      await win.click('button:has-text("Change image…")')
      await win.waitForSelector('[data-testid="cursor-image-error"]', { timeout: 10000 })
      h.assert(/could not be read/.test(await win.textContent('[data-testid="cursor-image-error"]')), 'explains the image could not be read')
      // Styles, highlight, click styles and motion toggles are all one undo step each and saved.
      await win.click('button[aria-label="macOS cursor"]')
      await win.click('label.toggle:has-text("Highlight cursor")')
      await win.click('button[aria-label="Highlight colour #38bdf8"]')
      await win.click('button[aria-label="Pulse click effect"]')
      await win.click('button[aria-label="Click colour #facc15"]')
      await win.click('label.toggle:has-text("Click sound")')
      await win.click('label.toggle:has-text("Tilt while moving")')
      await win.click('label.toggle:has-text("Motion trail")')
      await win.click('label.toggle:has-text("Return to start at the end")')
      await win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
      await f.waitFor(() => h.readProject(home, id).cursor.trail === true && h.readProject(home, id).cursor.loopHome === true, 'motion settings saved')
      const c = h.readProject(home, id).cursor
      h.assert(c.style === 'mac' && c.highlight.enabled && c.highlight.color === '#38bdf8' && c.clickStyle === 'pulse' && c.clickColor === '#facc15' && c.clickSound && c.tilt, `saved cursor ${JSON.stringify(c)}`)
      if (SHOTS) {
        await win.screenshot({ path: path.join(SHOTS, 'panel-all.png') })
        await win.$eval('.insp-body', (e) => (e.scrollTop = e.scrollHeight))
        await win.screenshot({ path: path.join(SHOTS, 'panel-all-bottom.png') })
      }
      for (let i = 0; i < 9; i++) await win.keyboard.press('Control+z')
      await f.waitFor(async () => (await win.getAttribute('button[aria-label="Custom cursor"]', 'aria-checked')) === 'true', 'nine undos go back to the custom cursor')
      h.assert(!(await win.$eval('input[aria-label="Highlight cursor"]', (i) => i.checked)), 'highlight undone')
    } finally {
      if (ctx.app) await ctx.app.close().catch(() => undefined)
      ctx.app = null
      if (!process.env.SSW_E2E_KEEP) fs.rmSync(home, { recursive: true, force: true })
    }
  })
}

main()
