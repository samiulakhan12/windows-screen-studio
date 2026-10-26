// Cropping the recording in the editor (docs/design/crop-in-editor.md): the crop tool hides a
// taskbar (a red band along the bottom of a grey recording) with one preset and one undo step;
// the preview and an Auto export show none of it, with no red bleeding in at the cut edge, and
// take the cropped shape; the tool shows the whole recording again while it is open; Undo, Esc
// (also in the middle of a drag) and the C shortcut behave; items stay where they were stored;
// without cursor data, zooms look at the centre of the part shown; the panel's Reset while the
// tool is open resets its draft.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const W = 1280
const H = 720
const BAND = 48

/**
 * Grey 1280×720 with a red 48 px band at the bottom (a taskbar), lossless: no encoder deblocking
 * pulls red above row 672, so red seen above the cut can only come from the crop.
 */
function taskbarVideo() {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `taskbar-${W}x${H}.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=60,drawbox=x=0:y=${H - BAND}:w=${W}:h=${BAND}:color=0xff0000:t=fill`,
    '-t', '4',
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
    tmp
  ])
  fs.renameSync(tmp, file)
  return file
}

const isRed = (r, g, b) => r > 200 && g < 60 && b < 60

/** Counts strongly red and red-tinted pixels of the preview canvas. */
function previewRed(win) {
  return win.evaluate(() => {
    const c = document.querySelector('.preview-canvas')
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height)
    let red = 0
    let tinted = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++
      if (data[i] - data[i + 1] > 60) tinted++
    }
    return { red, tinted }
  })
}

h.run(
  'crop: hide the taskbar, preview and export it, undo, and the keyboard',
  fx.withHome('crop', async (ctx, home) => {
    const shape = { id: 's1', start: 0, end: 4, kind: 'rect', x: 0.2, y: 0.5, w: 0.3, h: 0.2, color: '#00ff00', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }
    // Follows the cursor, but the recording has no cursor data (after the exported frames).
    const follow = { id: 'zc', start: 3.2, end: 3.9, scale: 2, focus: { mode: 'cursor' }, auto: false }
    const id = fx.seedProject(home, {
      id: 'rec-crop',
      name: 'Crop test',
      seconds: 4,
      media: taskbarVideo(),
      capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' },
      cursor: { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
    })
    const file = path.join(h.projectsRoot(home), id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({ ...h.readProject(home, id), shapes: [shape], zooms: [follow] }, null, 2))

    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Crop test')
    h.assert((await previewRed(win)).red > 0, 'the taskbar shows before cropping')

    // 1. Style › Frame › Crop recording…, Hide taskbar, Done (clicked: a focused button would take Enter).
    await win.click('[data-testid=crop-open]')
    await win.waitForSelector('[data-testid=crop-editor]')
    await win.click('[data-testid=crop-taskbar]')
    const size = await win.textContent('[data-testid=crop-size]')
    h.assert(size.trim() === '1280 × 672 px', `the tool shows the cropped size (got ${size})`)
    // While the tool is open the whole recording shows, the cut-away part dimmed.
    h.assert((await previewRed(win)).tinted > 0, 'the tool shows the part it cuts away')
    await win.click('[data-testid=crop-done]')
    await win.waitForSelector('[data-testid=crop-editor]', { state: 'detached' })
    const saved = await f.waitFor(() => {
      const c = h.readProject(home, id).crop
      return c && c.x === 0 && c.y === 0 && c.w === 1 && Math.abs(c.h - 0.933333) < 1e-4 ? c : null
    }, 'the crop in project.json')
    const stored = h.readProject(home, id)
    h.assert(['x', 'y', 'w', 'h'].every((k) => stored.shapes[0][k] === shape[k]), 'the shape is stored where it was (relative to the whole frame)')
    h.assert(/Cropped to 1280 × 672\./.test(await win.textContent('.notice-slot')), 'the notice names the new size')
    const row = await win.textContent('[data-testid=crop-row]')
    h.assert(/1280 × 672\s*of 1280 × 720/.test(row), `the Style panel shows the crop (got ${row})`)

    // 2. The preview shows none of the taskbar.
    await h.sleep(300)
    const shown = await previewRed(win)
    h.assert(shown.red === 0, `no red in the preview (${shown.red} red pixels)`)

    // 3. Export: the cropped shape (Auto aspect), no red anywhere, no red bleeding in at the cut.
    const out = path.join(home, 'cropped.mp4')
    await h.mockSaveDialog(app, out)
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Format', 'MP4')
    await fx.pickChip(win, 'Resolution', '720p')
    await fx.pickChip(win, 'Frame rate', '60 fps')
    await win.locator('.modal button.primary', { hasText: 'Export' }).click()
    const r = await fx.waitForExport(win)
    h.assert(r.ok, `export: ${r.text}`)
    const video = fx.probe(out).streams.find((s) => s.codec_type === 'video')
    h.assert(video.width === 1372 && video.height === 720, `export is 1372×720 (got ${video.width}×${video.height})`)
    const frames = fx.framesAt(out, [0, 120], 'rgb24')
    for (const [k, buf] of frames.frames.entries()) {
      let red = 0
      let bleed = 0
      for (let y = 0; y < frames.height; y++) {
        for (let x = 0; x < frames.width; x++) {
          const i = (y * frames.width + x) * 3
          if (isRed(buf[i], buf[i + 1], buf[i + 2])) red++
          // The bottom rows, away from the card's left and right edges: grey, not pinkish.
          if (y >= frames.height - 4 && x >= 8 && x < frames.width - 8 && buf[i] - buf[i + 1] >= 30) bleed++
        }
      }
      h.assert(red === 0, `exported frame ${k}: no red (${red} red pixels)`)
      h.assert(bleed === 0, `exported frame ${k}: no red at the cut edge (${bleed} pixels)`)
    }

    // 4. Undo removes the crop (one step).
    await win.keyboard.press('Escape')
    await win.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
    await win.keyboard.press('Control+z')
    await f.waitFor(() => !('crop' in h.readProject(home, id)), 'the crop gone after undo')
    await h.sleep(300)
    h.assert((await previewRed(win)).red > 0, 'the taskbar shows again after undo')

    // 5. C opens the tool, Esc closes it without changing anything.
    const before = fs.readFileSync(file, 'utf8')
    await win.keyboard.press('c')
    await win.waitForSelector('[data-testid=crop-editor]', { timeout: 5000 })
    await win.click('[data-testid=crop-taskbar]')
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid=crop-editor]', { state: 'detached', timeout: 5000 })
    await h.sleep(1000)
    h.assert(fs.readFileSync(file, 'utf8') === before, 'Esc applies nothing')

    // 6. C, the preset, then Enter applies (no button focused: the bar hands focus back).
    await win.keyboard.press('c')
    await win.waitForSelector('[data-testid=crop-editor]', { timeout: 5000 })
    await win.click('[data-testid=crop-taskbar]')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid=crop-editor]', { state: 'detached', timeout: 5000 })
    await f.waitFor(() => h.readProject(home, id).crop, 'the crop applied with Enter')
    h.assert(JSON.stringify(h.readProject(home, id).crop) === JSON.stringify(saved), 'Enter applies the same crop')

    // 7. A shape moved on the cropped preview is stored in the whole frame: moved by the drag, not resized.
    await win.click(`.shape-seg[data-shape="${shape.id}"]`)
    await win.waitForSelector('[data-testid="shape-box"]', { timeout: 5000 })
    const b = await win.$eval('[data-testid="shape-box"]', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
    })
    await win.mouse.move(b.x, b.y)
    await win.mouse.down()
    await win.mouse.move(b.x + 40, b.y + 30, { steps: 6 })
    await win.mouse.up()
    const moved = await f.waitFor(() => {
      const s = h.readProject(home, id).shapes[0]
      return s.y !== shape.y ? s : null
    }, 'the moved shape')
    const near = (a, want, tol) => Math.abs(a - want) <= tol
    h.assert(near(moved.w, shape.w, 1e-9) && near(moved.h, shape.h, 1e-9), `the shape keeps its size (${moved.w} × ${moved.h})`)
    h.assert(near(moved.x - shape.x, (40 * shape.w) / b.w, 0.004) && near(moved.y - shape.y, (30 * shape.h) / b.h, 0.004), `moved by the drag (${moved.x - shape.x}, ${moved.y - shape.y})`)

    // 8. Esc while a handle is still held closes the tool for good: moving on does not open it again.
    await win.keyboard.press('c')
    await win.waitForSelector('[data-testid=crop-editor]', { timeout: 5000 })
    const grip = await win.$eval('[data-testid=crop-handle-n]', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await win.mouse.move(grip.x, grip.y)
    await win.mouse.down()
    await win.mouse.move(grip.x, grip.y + 30, { steps: 4 })
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid=crop-editor]', { state: 'detached', timeout: 5000 })
    await win.mouse.move(grip.x, grip.y + 60, { steps: 4 })
    await win.mouse.up()
    await h.sleep(300)
    h.assert((await win.$('[data-testid=crop-editor]')) === null, 'the tool stays closed after Esc in the middle of a drag')
    h.assert(JSON.stringify(h.readProject(home, id).crop) === JSON.stringify(saved), 'Esc in the middle of a drag applies nothing')

    // 9. Without cursor data, zooms look at the centre of the part shown (stored in the whole frame:
    // y = 0.5 × 672/720), not at the whole frame's centre: a new zoom (Z), and a cursor zoom set to
    // a fixed point.
    const centred = (focus) => focus.mode === 'fixed' && Math.abs(focus.x - 0.5) < 1e-9 && Math.abs(focus.y - 336 / 720) < 1e-9
    await win.keyboard.press('Home')
    await win.keyboard.press('z')
    const added = await f.waitFor(() => h.readProject(home, id).zooms.find((z) => z.id !== follow.id) ?? null, 'the new zoom')
    h.assert(centred(added.focus), `a new zoom looks at the centre of the crop (got ${JSON.stringify(added.focus)})`)
    await win.click(`.zoom-seg[data-zoom="${follow.id}"]`)
    await win.click('[aria-label="Zoom focus"] .chip:has-text("Fixed point")')
    const fixed = await f.waitFor(() => {
      const z = h.readProject(home, id).zooms.find((x) => x.id === follow.id)
      return z.focus.mode === 'fixed' ? z : null
    }, 'the cursor zoom set to a fixed point')
    h.assert(centred(fixed.focus), `a cursor zoom set to a fixed point looks at the centre of the crop (got ${JSON.stringify(fixed.focus)})`)

    // 10. Reset in Style › Frame while the tool is open resets its draft, as the bar's Reset does; Done applies it.
    await win.click('.insp-tabs button[title="Style"]')
    await win.click('[data-testid=crop-edit]')
    await win.waitForSelector('[data-testid=crop-editor]', { timeout: 5000 })
    await win.click('[data-testid=crop-row-reset]')
    const whole = await win.textContent('[data-testid=crop-size]')
    h.assert(whole.trim() === '1280 × 720 px', `Reset in the panel resets the open tool's draft (got ${whole})`)
    await win.click('[data-testid=crop-done]')
    await win.waitForSelector('[data-testid=crop-editor]', { state: 'detached', timeout: 5000 })
    await f.waitFor(() => !('crop' in h.readProject(home, id)), 'the crop reset by Done')
    await h.sleep(1000)
    h.assert(!('crop' in h.readProject(home, id)), 'the reset stays')
  })
)
