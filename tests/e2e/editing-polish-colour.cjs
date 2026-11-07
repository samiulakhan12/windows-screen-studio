// Editing polish, part P4 (colour), end to end (docs/design/editing-polish.md §19.3): steps E9
// (Warm on the camera warms the camera and leaves the screen; Mono on the screen greys it; the
// preview and the export agree; the CPU path's export agrees with the WebGL one; Compare shows the
// original in the preview while the export stays graded), E10 (an identity LUT changes nothing, a
// red-blue swap swaps them from the first frame of an export started right after the import, a
// malformed file says its line, a missing file is said in the panel and asked about before an
// export) and E11 (Auto colour on a warm camera sets the camera's grade, Review lists "Camera
// colour balanced" and Remove puts it back), and the colour sliders' keys of E16. Run by
// editing-polish.e2e.cjs.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const W = 1280
const H = 720
/** Chromium blocklists WebGL on Xvfb's software GL; SwiftShader gives the grade a WebGL2 to draw with. */
const GL_ARGS = ['--enable-unsafe-swiftshader']
/** A black card filling the frame: the screen is the whole picture, the camera a bubble on it. */
const STYLE = { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }
/** The screen: a blue-grey; the camera: a grey under a warm light. */
const SCREEN = '5070a0'
const CAMERA = 'b08860'

/** Seeds a project with the screen and (unless `camera` is false) the camera, then merges `extra` into it. */
function seed(home, id, name, extra = {}, camera = true) {
  const media = fx.solidVideo({ seconds: 2, color: SCREEN })
  const webcam = camera ? fx.solidVideo({ seconds: 2, width: 640, height: 480, color: CAMERA }) : undefined
  fx.seedProject(home, { id, name, media, seconds: 2, webcam, style: STYLE, effects: NO_FX })
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra, webcam: { ...p.webcam, mirror: false } }, null, 2))
  return id
}

/** The app, with the console's warnings collected; `noGl`: the page gets no WebGL2 context (a PC without it). */
async function launch(ctx, home, { noGl = false } = {}) {
  const { app, win, logs } = await h.launch({ home, args: GL_ARGS })
  ctx.app = app
  ctx.logs = logs
  const warnings = []
  win.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()))
  await win.waitForSelector('.home', { timeout: 30000 })
  if (noGl) {
    await win.evaluate(() => {
      for (const proto of [HTMLCanvasElement.prototype, OffscreenCanvas.prototype]) {
        const getContext = proto.getContext
        proto.getContext = function (type, ...rest) {
          return /webgl/.test(type) ? null : getContext.call(this, type, ...rest)
        }
      }
    })
  }
  return { app, win, warnings }
}

/** Exports the open project at 720p, 30 fps to `out` (staying in the editor). */
async function exportOpen(app, win, out, { answer } = {}) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', '30 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  if (answer) await answer()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached' })
}

async function backHome(win) {
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

/** The mean colour of a 9 × 9 box at (x, y) of an rgb24 frame `w` wide. */
function colourAt(buf, w, x, y) {
  const s = [0, 0, 0]
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) for (let c = 0; c < 3; c++) s[c] += buf[((y + dy) * w + x + dx) * 3 + c]
  return s.map((v) => v / 81)
}

const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
const fmt = (c) => c.map((v) => v.toFixed(1)).join(', ')

/** Frame `n` of `file` as rgb24. */
const frame = (file, n = 15) => fx.framesAt(file, [n], 'rgb24').frames[0]

/** The camera bubble's centre in an export of the plain project: the centroid of what is not the screen's colour. */
function cameraCentre(buf) {
  const screen = colourAt(buf, W, W / 4, H / 4)
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = H / 2; y < H; y += 2) {
    for (let x = W / 2; x < W; x += 2) {
      const o = (y * W + x) * 3
      if (Math.abs(buf[o] - screen[0]) + Math.abs(buf[o + 1] - screen[1]) + Math.abs(buf[o + 2] - screen[2]) > 60) {
        sx += x
        sy += y
        n++
      }
    }
  }
  h.assert(n > 100, `the camera bubble is found (${n} samples)`)
  return { x: Math.round(sx / n), y: Math.round(sy / n) }
}

/** The preview canvas's colour at the fraction (fx, fy) of it (a 5 × 5 mean). */
async function previewAt(win, fxy) {
  return win.evaluate(([px, py]) => {
    const c = document.querySelector('.editor canvas')
    const ctx = c.getContext('2d')
    const x = Math.round(px * c.width)
    const y = Math.round(py * c.height)
    const d = ctx.getImageData(x - 2, y - 2, 5, 5).data
    const s = [0, 0, 0]
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k]
    return s.map((v) => v / 25)
  }, fxy)
}

/** Waits for the preview to settle after an edit (the player draws on the next frame). */
const settled = () => h.sleep(700)

const saved = (home, id, test, what, timeout = 10000) =>
  f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return test(p) ? p : null
      } catch {
        return null
      }
    },
    `saved: ${what}`,
    timeout
  )

/** A .cube of size n whose entry at grid (r, g, b) is `fn(r, g, b)`. */
function cube(n, fn, title) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`]
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(fn(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '))
  return lines.join('\n') + '\n'
}

async function colourSteps(test) {
  /* ---------- E9 Colour (§2.5, §9) ---------- */

  await test('editing polish E9: Warm warms the camera only, Mono greys the screen, preview and export agree, the CPU path matches WebGL, Compare is the preview’s', fx.withHome('colour-e9', async (ctx, home) => {
    seed(home, 'rec-plain', 'Plain')
    seed(home, 'rec-warm', 'Warm camera', { grade: { camera: { look: 'warm' } } })
    seed(home, 'rec-mono', 'Mono screen', { grade: { screen: { look: 'mono' } } })
    const out = (k) => path.join(home, `${k}.mp4`)
    let { app, win, warnings } = await launch(ctx, home)
    let timing = fx.exportTimings(win)
    const previews = {}
    for (const [name, key] of [['Plain', 'plain'], ['Warm camera', 'warm'], ['Mono screen', 'mono']]) {
      await fx.openProject(win, name)
      await settled()
      previews[key] = { screen: await previewAt(win, [0.25, 0.25]) }
      await exportOpen(app, win, out(key))
      // The cost of grading (§15): the export's per-frame times, WebGL2 under SwiftShader here.
      const t = timing.last()
      console.log(`  ${key} (WebGL2): draw ${t.draw} ms, decode ${t.decode} ms, encode ${t.encode} ms a frame`)
      h.assert(!(t.draw > 400), `a generous ceiling on the draw (${t.draw} ms)`)
      await backHome(win)
    }
    h.assert(!warnings.some((m) => m.includes('Colour grading uses the CPU')), `the shader grades under SwiftShader (${warnings.filter((m) => m.includes('Colour')).join(' | ')})`)
    const plain = frame(out('plain'))
    const cam = cameraCentre(plain)
    const at = (buf) => ({ screen: colourAt(buf, W, W / 4, H / 4), camera: colourAt(buf, W, cam.x, cam.y) })
    const P = at(plain)
    const Wm = at(frame(out('warm')))
    const M = at(frame(out('mono')))
    console.log(`  screen: plain ${fmt(P.screen)}, warm project ${fmt(Wm.screen)}, mono ${fmt(M.screen)}`)
    console.log(`  camera at ${cam.x},${cam.y}: plain ${fmt(P.camera)}, warm ${fmt(Wm.camera)}, mono project ${fmt(M.camera)}`)
    // Warm on the camera warms the camera and leaves the screen.
    h.assert(maxDiff(Wm.screen, P.screen) <= 2, 'Warm on the camera leaves the screen as it was')
    h.assert(Wm.camera[0] - Wm.camera[2] >= P.camera[0] - P.camera[2] + 8, 'Warm warms the camera (red up against blue)')
    // Mono on the screen greys it and leaves the camera.
    h.assert(Math.max(...M.screen) - Math.min(...M.screen) <= 4, 'Mono greys the screen')
    h.assert(maxDiff(M.camera, P.camera) <= 2, 'Mono on the screen leaves the camera')
    // The preview draws what the export draws (within 2 levels beyond the encoding's own difference on the plain project).
    const codec = previews.plain.screen.map((v, i) => v - P.screen[i])
    const mono = previews.mono.screen.map((v, i) => v - M.screen[i])
    console.log(`  preview minus export on the screen: plain ${fmt(codec)}, mono ${fmt(mono)}`)
    h.assert(maxDiff(mono, codec) <= 2, 'preview and export agree within 2 levels')

    // Compare: the preview shows the camera's original colour; the export stays graded.
    await fx.openProject(win, 'Warm camera')
    const camFrac = [cam.x / W, cam.y / H]
    await settled()
    const graded = await previewAt(win, camFrac)
    await win.click('.insp-tabs button:has-text("Camera")')
    await win.waitForSelector('[data-testid="camera-colour-section"]')
    await win.click('[data-testid="camera-colour-section"] [data-testid="colour-compare"]')
    h.assert((await win.getAttribute('[data-testid="camera-colour-section"] [data-testid="colour-compare"]', 'aria-pressed')) === 'true', 'Compare is pressed')
    await settled()
    const original = await previewAt(win, camFrac)
    await backHome(win)
    await fx.openProject(win, 'Plain')
    await settled()
    const plainPreview = await previewAt(win, camFrac)
    console.log(`  preview camera: graded ${fmt(graded)}, Compare ${fmt(original)}, plain ${fmt(plainPreview)}`)
    h.assert(maxDiff(original, plainPreview) <= 2, 'Compare shows the camera as recorded')
    h.assert(graded[0] - graded[2] > original[0] - original[2] + 8, 'without Compare the preview is warm')
    await backHome(win)
    await fx.openProject(win, 'Warm camera')
    await exportOpen(app, win, out('warm-compare'))
    const WC = at(frame(out('warm-compare')))
    h.assert(maxDiff(WC.camera, Wm.camera) <= 1, 'the export is still graded while Compare is on')
    h.assert(!JSON.stringify(h.readProject(home, 'rec-warm')).includes('compare'), 'Compare is never saved')
    await app.close()
    ctx.app = null

    // A PC without WebGL2: the CPU path, the panel's note, and the same export within one level.
    ;({ app, win, warnings } = await launch(ctx, home, { noGl: true }))
    timing = fx.exportTimings(win)
    for (const [name, key] of [['Warm camera', 'warm-cpu'], ['Mono screen', 'mono-cpu']]) {
      await fx.openProject(win, name)
      await exportOpen(app, win, out(key))
      const t = timing.last()
      console.log(`  ${key}: draw ${t.draw} ms, decode ${t.decode} ms, encode ${t.encode} ms a frame`)
      await backHome(win)
    }
    h.assert(warnings.some((m) => m === 'Colour grading uses the CPU: no WebGL2 context'), `the log says why (${warnings.join(' | ')})`)
    const WCpu = at(frame(out('warm-cpu')))
    const MCpu = at(frame(out('mono-cpu')))
    console.log(`  CPU path: warm camera ${fmt(WCpu.camera)} (WebGL ${fmt(Wm.camera)}), mono screen ${fmt(MCpu.screen)} (WebGL ${fmt(M.screen)})`)
    h.assert(maxDiff(WCpu.camera, Wm.camera) <= 1 && maxDiff(MCpu.screen, M.screen) <= 1, 'the CPU path exports what WebGL exports, within one level')
    await fx.openProject(win, 'Mono screen')
    await win.click('.insp-tabs button:has-text("Effects")')
    await win.waitForSelector('[data-testid="screen-colour-section"] [data-testid="colour-cpu-note"]', { timeout: 10000 })
  }))

  /* ---------- E10 LUTs (§9.5) ---------- */

  await test('editing polish E10: an identity LUT changes nothing, a swap LUT swaps from the first frame, a broken one says its line, a missing one is asked about', fx.withHome('colour-e10', async (ctx, home) => {
    const id = seed(home, 'rec-lut', 'Graded with a cube', {}, false)
    seed(home, 'rec-lut-plain', 'Plain colours', {}, false)
    const dir = path.join(home, 'luts')
    fs.mkdirSync(dir)
    const identity = path.join(dir, 'identity.cube')
    const swap = path.join(dir, 'swap.cube')
    const broken = path.join(dir, 'broken.cube')
    fs.writeFileSync(identity, cube(17, (r, g, b) => [r, g, b], 'Identity'))
    fs.writeFileSync(swap, cube(17, (r, g, b) => [b, g, r], 'Swap red and blue'))
    fs.writeFileSync(broken, cube(17, (r, g, b) => [r, g, b], 'Broken').replace(/\n0\.062500 0\.000000 0\.000000\n/, '\n0.0625 0\n'))
    const out = (k) => path.join(home, `${k}.mp4`)
    const { app, win } = await launch(ctx, home)
    const pick = (file) =>
      app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
      }, file)

    await fx.openProject(win, 'Plain colours')
    await exportOpen(app, win, out('plain'))
    await backHome(win)
    await fx.openProject(win, 'Graded with a cube')
    await win.click('.insp-tabs button:has-text("Effects")')
    const section = '[data-testid="screen-colour-section"]'
    await win.waitForSelector(section)
    // A malformed file: refused with its line, nothing changes.
    await pick(broken)
    await win.click(`${section} [data-testid="lut-import"]`)
    await f.waitFor(async () => /This LUT could not be used: line 4 /.test((await win.textContent('body')) || ''), 'the broken LUT names its line', 10000)
    h.assert(!h.readProject(home, id).grade, 'a broken LUT changes nothing')
    // The identity: nothing changes beyond a level.
    await win.waitForSelector(`${section} [data-testid="lut-import"]:not([disabled])`)
    await pick(identity)
    await win.click(`${section} [data-testid="lut-import"]`)
    await saved(home, id, (p) => p.grade?.screen?.lut?.title === 'Identity', 'the identity LUT', 20000)
    h.assert((await win.textContent(`${section} [data-testid="lut-size"]`)) === '17 × 17 × 17', 'its size is shown')
    await exportOpen(app, win, out('identity'))
    const plain = colourAt(frame(out('plain'), 0), W, W / 2, H / 2)
    const same = colourAt(frame(out('identity'), 0), W, W / 2, H / 2)
    console.log(`  plain ${fmt(plain)}, identity LUT ${fmt(same)}`)
    h.assert(maxDiff(plain, same) <= 1, 'an identity LUT changes nothing beyond one level')
    // The swap, imported and exported at once: swapped from frame 0.
    await win.waitForSelector(`${section} [data-testid="lut-import"]:not([disabled])`)
    await pick(swap)
    await win.click(`${section} [data-testid="lut-import"]`)
    await f.waitFor(async () => (await win.textContent(`${section} [data-testid="lut-title"]`).catch(() => '')) === 'Swap red and blue', 'the swap LUT is shown', 20000)
    await exportOpen(app, win, out('swap'))
    const p = h.readProject(home, id)
    h.assert(p.grade.screen.lut.title === 'Swap red and blue' && /^lut-\d+\.cube$/.test(p.grade.screen.lut.file), 'the swap LUT is in use')
    for (const n of [0, 30]) {
      const swapped = colourAt(frame(out('swap'), n), W, W / 2, H / 2)
      console.log(`  frame ${n} with the swap: ${fmt(swapped)}`)
      h.assert(Math.abs(swapped[0] - plain[2]) <= 3 && Math.abs(swapped[2] - plain[0]) <= 3, `red and blue are swapped on frame ${n}`)
    }
    await backHome(win)
    await app.close()
    ctx.app = null

    // The file gone: the panel says so, and the export asks first.
    fs.rmSync(path.join(h.projectsRoot(home), id, p.grade.screen.lut.file))
    const again = await launch(ctx, home)
    await fx.openProject(again.win, 'Graded with a cube')
    await again.win.click('.insp-tabs button:has-text("Effects")')
    await again.win.waitForSelector(`${section} [data-testid="lut-problem"]`, { timeout: 10000 })
    h.assert((await again.win.textContent(`${section} [data-testid="lut-problem"]`)) === 'The LUT file is missing or has changed. Import it again.', 'the panel says the file is missing')
    await exportOpen(again.app, again.win, out('without'), {
      answer: async () => {
        await again.win.waitForSelector('[data-testid="export-lut-ask"]', { timeout: 10000 })
        h.assert((await again.win.textContent('[data-testid="export-lut-ask"] p')) === "The screen's LUT is missing or has changed. Export without it?", 'the export asks first')
        await again.win.click('[data-testid="export-lut-go"]')
      }
    })
    h.assert(maxDiff(colourAt(frame(out('without'), 0), W, W / 2, H / 2), plain) <= 1, 'exported without the LUT')
  }))

  /* ---------- E11 Auto colour (§9.6, §11) and the sliders' keys (E16) ---------- */

  await test('editing polish E11: Auto colour balances the warm camera, Review lists it and Remove puts it back; the sliders’ keys', fx.withHome('colour-e11', async (ctx, home) => {
    const id = seed(home, 'rec-auto', 'Auto colour')
    const { win } = await launch(ctx, home)
    await fx.openProject(win, 'Auto colour')
    await win.click('.insp-tabs button:has-text("Camera")')
    const section = '[data-testid="camera-colour-section"]'
    await win.waitForSelector(section)
    await win.click(`${section} [data-testid="auto-colour"]`)
    const p = await saved(home, id, (q) => !!q.grade?.auto, 'Auto colour set the camera', 90000)
    console.log(`  Auto colour: ${JSON.stringify(p.grade)}`)
    h.assert(p.grade.camera.temperature < 0, 'the warm camera is cooled')
    h.assert(Math.abs(p.grade.camera.temperature) <= 0.6, 'at most 0.6')
    h.assert(p.grade.auto.camera === null, 'the record of the colour before')
    // Review mode lists it; Remove puts the colour back.
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await win.keyboard.press('Shift+R')
    await win.waitForSelector('[data-testid="review-panel"]', { timeout: 5000 })
    const row = '[data-testid="review-row"][data-key="colour:camera"]'
    await win.waitForSelector(row, { timeout: 5000 })
    h.assert((await win.textContent(row)).includes('Camera colour balanced'), 'Review lists "Camera colour balanced"')
    await win.click(`${row} [data-testid="review-remove"]`)
    await saved(home, id, (q) => !('grade' in q), 'Remove puts the camera’s colour back')
    await win.keyboard.press('Escape')

    // The sliders by the keyboard: End, Home, Delete; their value texts.
    await win.click('.insp-tabs button:has-text("Camera")')
    const temp = `${section} [data-testid="colour-slider-temperature"]`
    await win.waitForSelector(temp)
    await win.focus(temp)
    await win.keyboard.press('End')
    await saved(home, id, (q) => q.grade?.camera?.temperature === 1, 'End: the warmest')
    h.assert((await win.getAttribute(temp, 'aria-valuetext')) === 'Warmer, +100', 'the value text says Warmer, +100')
    await win.keyboard.press('Home')
    await saved(home, id, (q) => q.grade?.camera?.temperature === -1, 'Home: the coolest')
    await win.keyboard.press('Delete')
    await saved(home, id, (q) => !('grade' in q), 'Delete: back to no change, no grade left')
    await f.waitFor(async () => ((await win.textContent(`${section} [role="status"]`)) || '').includes('Temperature reset'), 'Delete is announced', 5000)
    h.assert((await win.getAttribute(temp, 'aria-valuetext')) === 'No change', 'No change')
  }))
}

module.exports = { colourSteps }
