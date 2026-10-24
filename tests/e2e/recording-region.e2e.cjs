// Region recording: pick an area in the overlay, record, and check the proxy is
// cropped to exactly that area (size and content) with the cursor remapped into it.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null

/** Opens a solid-colour window at a fixed screen position (something known to look for in the video). */
async function colourWindow(app, bounds, colour) {
  await app.evaluate(
    ({ BrowserWindow }, { bounds, colour }) => {
      const w = new BrowserWindow({ ...bounds, frame: false, show: false, focusable: false, backgroundColor: colour })
      w.loadURL(`data:text/html,<body style="margin:0;background:${colour}"></body>`)
      w.once('ready-to-show', () => w.showInactive())
    },
    { bounds, colour }
  )
}

/** RGB of one pixel of the frame at `t` seconds. */
function pixel(file, t, x, y) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [...buf.subarray(0, 3)]
}

;(async () => {
await h.run('region recording: overlay selection, exact crop, cursor remapped', async (ctx) => {
  const home = h.tempHome('rec-region')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = r.closable(app)
  ctx.logs = logs
  await r.waitForSources(win)
  await win.click('.segmented button:has-text("Area")')
  await win.waitForSelector('button.record[disabled]')
  await win.click('.source')

  const overlay = await r.until(() => app.windows().find((w) => w.url().includes('#/region')), { what: 'region overlay' })
  await overlay.waitForSelector('.region-root')
  h.assert(!(await r.mainVisible(app)), 'main window hidden while selecting')
  await overlay.mouse.move(400, 300)
  await overlay.mouse.down()
  await overlay.mouse.move(1200, 750, { steps: 12 })
  await overlay.mouse.up()
  await overlay.waitForSelector('.region-actions')
  const size = await overlay.textContent('.region-size')
  h.assert(size.replace(/\s/g, '') === '800×450', `size readout ${size}`)
  if (SHOTS) await overlay.screenshot({ path: path.join(SHOTS, 'region-overlay.png') })
  // Enter confirms; the overlay closes before Playwright's key-up, so ignore that error.
  await overlay.keyboard.press('Enter').catch(() => undefined)

  await r.until(() => r.mainVisible(app), { what: 'main window back' })
  await win.waitForSelector('.region-summary')
  h.assert((await win.textContent('.region-dims')).includes('800 × 450'), 'Home shows the picked area')
  if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'region-home.png') })

  // Known content: red in the area's top-left quarter, blue in its bottom-right quarter.
  await colourWindow(app, { x: 400, y: 300, width: 400, height: 225 }, '#ff0000')
  await colourWindow(app, { x: 800, y: 525, width: 400, height: 225 }, '#0000ff')
  await h.sleep(800)

  const tb = await r.startRecording(app, win)
  const tbBounds = (await r.windowsState(app)).find((w) => w.route === '#/toolbar').bounds
  h.assert(tbBounds.y >= 750 || tbBounds.y + tbBounds.height <= 300, `toolbar placed outside the area (${JSON.stringify(tbBounds)})`)
  await r.xinput('g 1000 350 1150 450 0.8; c 1000 400; s 0.3; c 100 100; s 0.3; c 600 400; s 0.5')
  await h.sleep(1000)
  await tb.click('button.stop')
  await win.waitForSelector('.editor canvas', { timeout: 120000 })

  const [id] = h.listProjects(home)
  const project = h.readProject(home, id)
  const dir = path.join(h.projectsRoot(home), id)
  h.assert(project.width === 800 && project.height === 450, `project size ${project.width}x${project.height}`)
  const reg = project.capture.region
  const close = (a, b) => Math.abs(a - b) < 0.002
  h.assert(reg && close(reg.x, 400 / 1920) && close(reg.y, 300 / 1080) && close(reg.w, 800 / 1920) && close(reg.h, 450 / 1080), `capture.region ${JSON.stringify(reg)}`)
  const v = r.probe(path.join(dir, 'screen.mp4')).streams.find((s) => s.codec_type === 'video')
  h.assert(v.width === 800 && v.height === 450, `proxy is ${v.width}x${v.height}`)

  const t = Math.max(0.2, project.duration - 0.5)
  // Sample away from (200, 100), where the OS cursor rests after the last click.
  const red = pixel(path.join(dir, 'screen.mp4'), t, 60, 180)
  const blue = pixel(path.join(dir, 'screen.mp4'), t, 740, 420)
  const black = pixel(path.join(dir, 'screen.mp4'), t, 600, 100)
  h.assert(red[0] > 200 && red[1] < 60 && red[2] < 60, `top-left of the crop is red: ${red}`)
  h.assert(blue[2] > 200 && blue[0] < 60 && blue[1] < 60, `bottom-right of the crop is blue: ${blue}`)
  h.assert(black.every((c) => c < 40), `outside the coloured windows is the desktop: ${black}`)

  const cursor = JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8'))
  // (1000, 400) on screen is (0.75, 0.222) in the area; (100, 100) is outside it and
  // (600, 400) is on one of the app's own windows: both dropped.
  h.assert(cursor.clicks.length === 1, `one click inside the area: ${JSON.stringify(cursor.clicks)}`)
  h.assert(Math.abs(cursor.clicks[0].x - 0.75) < 0.01 && Math.abs(cursor.clicks[0].y - 100 / 450) < 0.01, `click remapped ${JSON.stringify(cursor.clicks[0])}`)
  h.assert(cursor.samples.some((s) => s.x > 0.7 && s.x < 0.95 && s.y > 0 && s.y < 0.4), 'cursor samples remapped into the area')
})

await h.run('region minimum size: main accepts what the picker offers and explains a rejection (seams-6)', async (ctx) => {
  const home = h.tempHome('rec-region-min')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = r.closable(app)
  ctx.logs = logs
  await r.waitForSources(win)
  await win.click('.segmented button:has-text("Area")')
  const overlayOf = () => r.until(() => app.windows().find((w) => w.url().includes('#/region')), { what: 'region overlay' })

  // A narrow area the overlay accepts (35 DIP wide is under the old 2 % of 1920 DIP).
  await win.click('.source')
  let overlay = await overlayOf()
  await overlay.waitForSelector('.region-root')
  await overlay.mouse.move(500, 300)
  await overlay.mouse.down()
  await overlay.mouse.move(535, 500, { steps: 6 })
  await overlay.mouse.up()
  await overlay.waitForSelector('.region-actions')
  await overlay.keyboard.press('Enter').catch(() => undefined)
  await r.until(() => r.mainVisible(app), { what: 'main window back' })
  await win.waitForSelector('.region-summary')
  h.assert((await win.textContent('.region-dims')).includes('35 × 200'), `narrow area kept: ${await win.textContent('.region-dims')}`)
  h.assert(!(await win.$('.home-error')), 'no error for an area the picker allowed')

  // An area below the minimum (sent directly, as a stale or tampered overlay could) is
  // rejected with a message instead of silently disappearing.
  await win.click('.region-summary button:has-text("Change area")')
  overlay = await overlayOf()
  await overlay.waitForSelector('.region-root')
  await overlay.evaluate(() => window.api.finishRegion({ x: 0.1, y: 0.1, w: 10 / 1920, h: 0.3 })).catch(() => undefined)
  await r.until(() => r.mainVisible(app), { what: 'main window back' })
  await win.waitForSelector('.home-error')
  h.assert(/too small/.test(await win.textContent('.home-error')), `explains the rejection: ${await win.textContent('.home-error')}`)
  h.assert((await win.textContent('.region-dims')).includes('35 × 200'), 'the previous area is still selected')
})
})()
