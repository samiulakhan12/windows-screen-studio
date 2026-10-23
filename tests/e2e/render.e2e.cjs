// Compositor features in real exports: motion blur only while the camera moves,
// text annotations, keystroke overlay, cursor shapes and click ripples.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const FPS = 60

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

async function exportMp4(app, win, project, out) {
  await fx.openProject(win, project)
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', '60 fps')
  if (SHOTS && project.includes('blur')) await win.screenshot({ path: path.join(SHOTS, 'export-settings.png') })
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${project}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

const meanAbsDiff = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}

/** Mean gradient magnitude: drops when an image is blurred. */
function sharpness(buf, w, h) {
  let s = 0
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x
      s += Math.abs(buf[i + 1] - buf[i - 1]) + Math.abs(buf[i + w] - buf[i - w])
    }
  }
  return s / (((w - 2) * (h - 2)) / 4)
}

/** Counts pixels in a rectangle (fractions of the frame) brighter than `hi` and darker than `lo` (gray frames). */
function census(buf, w, h, r, lo = 60, hi = 200) {
  let bright = 0
  let dark = 0
  for (let y = Math.floor(r.y * h); y < Math.floor((r.y + r.h) * h); y++) {
    for (let x = Math.floor(r.x * w); x < Math.floor((r.x + r.w) * w); x++) {
      const v = buf[y * w + x]
      if (v > hi) bright++
      else if (v < lo) dark++
    }
  }
  return { bright, dark }
}

async function main() {
  await test('render: motion blur appears only while the zoom camera moves', fx.withHome('render-blur', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: 1280, height: 720 })
    // Zoom in over 0.8-1.5 s, hold until 2.5 s, zoom out until 3.2 s; a fixed focus, so the hold is still.
    const zooms = [{ id: 'z', start: 0.8, end: 3.2, scale: 2.2, focus: { mode: 'fixed', x: 0.35, y: 0.4 }, auto: false }]
    const style = { background: { type: 'gradient', preset: 'ocean' }, padding: 0.06, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }
    for (const [name, blur] of [['Render blur', 1], ['Render sharp', 0]]) {
      fx.seedProject(home, { id: `rec-${blur}`, name, media, seconds: 4, zooms, style, effects: { motionBlur: blur, keystrokes: { show: false, position: 'bottom', size: 0.035 } } })
    }
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    win.on('console', (m) => /^export:/.test(m.text()) && console.log(`  ${m.text()}`))
    const blurred = path.join(home, 'blur.mp4')
    const sharp = path.join(home, 'sharp.mp4')
    await exportMp4(app, win, 'Render blur', blurred)
    await exportMp4(app, win, 'Render sharp', sharp)

    const at = (t) => Math.round(t * FPS)
    const still = [at(0.3), at(0.7), at(1.6), at(2.0), at(2.4), at(3.4), at(3.8)]
    const moving = [at(1.1), at(1.2), at(2.8), at(2.9)]
    const idx = [...still, ...moving]
    const A = fx.framesAt(blurred, idx)
    const B = fx.framesAt(sharp, idx)
    const rows = idx.map((f, k) => ({
      t: (f / FPS).toFixed(2),
      diff: meanAbsDiff(A.frames[k], B.frames[k]),
      sharpBlur: sharpness(A.frames[k], A.width, A.height),
      sharpSharp: sharpness(B.frames[k], B.width, B.height)
    }))
    for (const r of rows) console.log(`  t=${r.t}s diff ${r.diff.toFixed(2)} sharpness blur/sharp ${r.sharpBlur.toFixed(1)}/${r.sharpSharp.toFixed(1)}`)
    // Still frames match the unblurred export up to encoder noise; moving ones differ ~10x more and are softer.
    rows.slice(0, still.length).forEach((r) => h.assert(r.diff < 0.6, `no blur while the camera is still (t=${r.t}: diff ${r.diff.toFixed(2)})`))
    rows.slice(still.length).forEach((r) => {
      h.assert(r.diff > 1.5, `blur while zooming (t=${r.t}: diff ${r.diff.toFixed(2)})`)
      h.assert(r.sharpBlur < r.sharpSharp * 0.92, `blurred frame is softer (t=${r.t})`)
    })
    if (SHOTS) {
      fx.savePng(blurred, at(1.15), path.join(SHOTS, 'blur-on-1.15s.png'))
      fx.savePng(sharp, at(1.15), path.join(SHOTS, 'blur-off-1.15s.png'))
      fx.savePng(blurred, at(2.0), path.join(SHOTS, 'blur-on-2.0s-hold.png'))
    }
  }))

  await test('render: raw-frame route at 1080p with motion blur (per-frame cost)', fx.withHome('render-raw-cost', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: 1920, height: 1080 })
    const zooms = [{ id: 'z', start: 0.5, end: 3.5, scale: 2, focus: { mode: 'fixed', x: 0.4, y: 0.4 }, auto: false }]
    const style = { background: { type: 'gradient', preset: 'ocean' }, padding: 0.06, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }
    fx.seedProject(home, { name: 'Raw cost', media, seconds: 4, width: 1920, height: 1080, zooms, style, effects: { motionBlur: 1, keystrokes: { show: false, position: 'bottom', size: 0.035 } } })
    // Xvfb has no GPU: by default Chromium rasterises canvases on the CPU. With the
    // blocklist ignored it uses an accelerated canvas (on SwiftShader), the path a
    // Windows machine with a GPU takes; its frames read back as RGBX instead of BGRX.
    const outs = []
    for (const [mode, args] of [['software', []], ['accelerated', ['--ignore-gpu-blocklist']]]) {
      // Raw frames to ffmpeg (the GIF / x264 / ffmpeg GPU encoder route).
      const { app, win, logs } = await h.launch({ home, args, env: { SSW_EXPORT_VIDEO_ENCODER: 'ffmpeg' } })
      ctx.app = app
      ctx.logs = logs
      const canvas = await app.evaluate(({ app: a }) => a.getGPUFeatureStatus()['2d_canvas'])
      const timing = fx.exportTimings(win)
      const out = path.join(home, `raw-${mode}.mp4`)
      await fx.openProject(win, 'Raw cost')
      await h.mockSaveDialog(app, out)
      await fx.openExportDialog(win)
      await fx.pickChip(win, 'Resolution', '1080p')
      await fx.pickChip(win, 'Frame rate', '60 fps')
      await win.locator('.modal button.primary', { hasText: 'Export' }).click()
      const r = await fx.waitForExport(win)
      h.assert(r.ok, `export (${mode} canvas): ${r.text}`)
      const t = timing.last()
      console.log(`  ${mode} canvas (2d_canvas: ${canvas}): ${t.line}; draw + readback ${(t.draw + t.encode).toFixed(1)} ms per frame`)
      h.assert(/via Software \(x264\)/.test(t.line), 'raw-frame route')
      const video = fx.probe(out).streams.find((s) => s.codec_type === 'video')
      h.assert(video.width === 1920 && video.height === 1080 && Number(video.nb_frames) === 240, `1080p, 240 frames (got ${video.width}x${video.height}, ${video.nb_frames})`)
      outs.push(out)
      await app.close()
      ctx.app = null
    }
    // Both canvases render the same picture (same colours: the byte order of each is mapped right).
    const idx = [30, 60, 100, 150, 200]
    const [A, B] = outs.map((f) => fx.framesAt(f, idx, 'rgb24'))
    idx.forEach((f, k) => {
      const d = meanAbsDiff(A.frames[k], B.frames[k])
      h.assert(d < 3, `frame ${f}: software and accelerated canvases differ by ${d.toFixed(2)}`)
    })
  }))

  await test('render: annotations, keystrokes, cursor shapes and click ripples', fx.withHome('render-overlays', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 4 })
    const style = { background: { type: 'color', color: '#808080' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
    const still = (x, y) => [{ t: 0, x, y }, { t: 4, x, y }]
    const keys = [
      { t: 0.2, label: 'Ctrl + C' },
      { t: 0.45, label: 'Ctrl + V' },
      { t: 0.6, label: 'Ctrl + V' },
      { t: 2.0, label: 'Ctrl + Shift + S' }
    ]
    const shapes = [
      { t: 0, shape: 'arrow' },
      { t: 1.0, shape: 'text' },
      { t: 1.5, shape: 'pointer' },
      { t: 2.6, shape: 'crosshair' },
      { t: 3.0, shape: 'resize-ew' },
      { t: 3.4, shape: 'wait' }
    ]
    const annotations = [
      { id: 'a1', start: 0.1, end: 1.4, text: 'Click Export\nto save your video', x: 0.5, y: 0.2, size: 0.05, style: 'pill' },
      { id: 'a2', start: 3.0, end: 4, text: "That's it!", x: 0.5, y: 0.5, size: 0.1, style: 'title' }
    ]
    fx.seedProject(home, {
      id: 'rec-overlays',
      name: 'Overlays',
      media,
      seconds: 4,
      style,
      annotations,
      // Cursor shapes come from native capture, which leaves the OS cursor out of the video.
      capture: { method: 'native', cursorInVideo: false, region: null },
      cursorSettings: { show: true, size: 1.4, smoothing: 0.5, clickEffect: true, hideWhenIdle: false },
      effects: { motionBlur: 0, keystrokes: { show: true, position: 'bottom', size: 0.035 } },
      cursor: { samples: still(0.75, 0.6), clicks: [{ t: 1.8, x: 0.75, y: 0.6, button: 'left' }], keys, shapes, scale: 1.5, valid: true }
    })
    // F03: ripples with the synthetic cursor OFF (the OS cursor is in the video).
    fx.seedProject(home, {
      id: 'rec-ripples',
      name: 'Ripples',
      media,
      seconds: 2,
      style,
      cursorSettings: { show: false, size: 1.4, smoothing: 0.5, clickEffect: true, hideWhenIdle: true },
      cursor: { samples: still(0.5, 0.5), clicks: [{ t: 1, x: 0.5, y: 0.5, button: 'left' }], keys: [], shapes: [], scale: 1, valid: true }
    })
    // The OS cursor is in the video (Chromium capture): even with the smooth cursor
    // switched on, no second cursor is drawn, and ripples still are.
    fx.seedProject(home, {
      id: 'rec-os-cursor',
      name: 'OS cursor',
      media,
      seconds: 2,
      style,
      capture: { method: 'chromium', cursorInVideo: true, region: null },
      cursorSettings: { show: true, size: 1.4, smoothing: 0.5, clickEffect: true, hideWhenIdle: true },
      cursor: { samples: still(0.5, 0.5), clicks: [{ t: 1, x: 0.5, y: 0.5, button: 'left' }], keys: [], shapes: [], scale: 1, valid: true }
    })
    const { app, win, logs } = await h.launch({ home, env: process.env.SSW_EXPORT_VIDEO_ENCODER ? { SSW_EXPORT_VIDEO_ENCODER: process.env.SSW_EXPORT_VIDEO_ENCODER } : {} })
    ctx.app = app
    ctx.logs = logs
    const overlays = path.join(home, 'overlays.mp4')
    const ripples = path.join(home, 'ripples.mp4')
    await exportMp4(app, win, 'Overlays', overlays)
    await exportMp4(app, win, 'Ripples', ripples)
    const osCursor = path.join(home, 'os-cursor.mp4')
    await exportMp4(app, win, 'OS cursor', osCursor)

    const at = (t) => Math.round(t * FPS)
    const times = [0.05, 0.7, 1.2, 1.9, 2.2, 2.8, 3.2, 3.7]
    const F = fx.framesAt(overlays, times.map(at))
    const frame = (t) => F.frames[times.indexOf(t)]
    const { width: W, height: H } = F
    const pill = { x: 0.3, y: 0.08, w: 0.4, h: 0.24 }
    const keyRow = { x: 0.3, y: 0.82, w: 0.4, h: 0.16 }
    const title = { x: 0.3, y: 0.4, w: 0.4, h: 0.2 }
    const cursorBox = { x: 0.72, y: 0.57, w: 0.08, h: 0.12 }
    const c = (t, r) => census(frame(t), W, H, r)
    // Before anything appears the frame is flat gray (only the cursor).
    h.assert(c(0.05, pill).bright === 0 && c(0.05, keyRow).dark === 0, 'nothing at 0.05 s')
    // 0.7 s: the pill annotation (dark box + white text) and the stacked keystrokes.
    h.assert(c(0.7, pill).dark > 2000 && c(0.7, pill).bright > 300, `pill annotation at 0.7 s ${JSON.stringify(c(0.7, pill))}`)
    h.assert(c(0.7, keyRow).dark > 1500 && c(0.7, keyRow).bright > 100, `keystroke row at 0.7 s ${JSON.stringify(c(0.7, keyRow))}`)
    // 1.9 s: 1.3 s after the last press the row has faded out; 2.2 s: the next shortcut; 3.7 s: gone again.
    h.assert(c(1.2, keyRow).dark > 1500, 'keystrokes still shown at 1.2 s')
    h.assert(c(1.9, keyRow).dark === 0, 'keystrokes gone at 1.9 s')
    h.assert(c(2.2, keyRow).dark > 1500, 'Ctrl + Shift + S at 2.2 s')
    h.assert(c(3.7, keyRow).dark === 0, 'keystrokes gone at 3.7 s')
    // 3.7 s: title text (white with shadow), no pill box.
    h.assert(c(3.7, title).bright > 1000 && c(3.7, pill).dark === 0, `title at 3.7 s ${JSON.stringify(c(3.7, title))}`)
    // The cursor is drawn at the recorded spot in every frame, and its shape changes the pixels there.
    const sig = times.map((t) => c(t, cursorBox))
    sig.forEach((s, i) => h.assert(s.bright + s.dark > 40, `cursor visible at ${times[i]} s`))
    const distinct = new Set(sig.map((s) => `${Math.round(s.bright / 20)}:${Math.round(s.dark / 20)}`))
    h.assert(distinct.size >= 4, `cursor shapes differ over time (${[...distinct].join(' ')})`)

    // Ripple: brighter ring around the click shortly after it, nothing before.
    const R = fx.framesAt(ripples, [at(0.9), at(1.1)])
    const ring = { x: 0.44, y: 0.4, w: 0.12, h: 0.2 }
    const before = census(R.frames[0], R.width, R.height, ring, 60, 150)
    const after = census(R.frames[1], R.width, R.height, ring, 60, 150)
    console.log(`  ripple pixels before/after click: ${before.bright}/${after.bright}`)
    h.assert(before.bright === 0 && after.bright > 200, 'click ripple drawn although the smooth cursor is off (F03)')
    const O = fx.framesAt(osCursor, [at(0.9), at(1.1)])
    const osBefore = census(O.frames[0], O.width, O.height, ring, 60, 150)
    const osAfter = census(O.frames[1], O.width, O.height, ring, 60, 150)
    console.log(`  OS cursor in video: cursor pixels ${osBefore.bright + osBefore.dark}, ripple pixels ${osAfter.bright}`)
    h.assert(osBefore.bright === 0 && osBefore.dark === 0, 'no synthetic cursor over a video with the OS cursor in it')
    h.assert(osAfter.bright > 200, 'click ripple drawn over a video with the OS cursor in it')

    if (SHOTS) {
      for (const t of [0.7, 1.2, 1.9, 2.2, 3.2, 3.7]) fx.savePng(overlays, at(t), path.join(SHOTS, `overlays-${t}s.png`))
      fx.savePng(ripples, at(1.1), path.join(SHOTS, 'ripple-1.1s.png'))
    }
  }))
}

main()
