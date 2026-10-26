// Real OS input while recording (XTest): the cursor track follows the pointer, clicks
// land where they happened with their release times, mouse-wheel scrolling is stored in
// notches where it happened, only shortcut keystrokes are kept, and clicks and wheel input
// on the floating toolbar (Pause, Resume, Stop) or while paused never become input.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

;(async () => {
await h.run('real input: cursor, clicks, releases, scrolling and shortcuts are captured; toolbar input is not content', async (ctx) => {
  const home = h.tempHome('rec-input')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = r.closable(app)
  ctx.logs = logs
  await r.waitForSources(win)
  const tb = await r.startRecording(app, win)

  await r.xinput('g 200 200 1700 900 1.0; s 0.3; c 400 300; s 0.6; g 400 300 1500 800 0.6; c 1500 800; s 0.5')
  // Six notches down, then three up, in the middle of the screen; then a drag.
  await r.xinput('w 960 540 6; s 0.4; w 960 540 -3; s 0.5; d 600 400 1200 600 0.6; s 0.5')
  // Shortcuts are kept; plain typing ("a", "A", space) is not.
  await r.xinput('k ctrl+shift+s; s 0.2; k a; k shift+a; k space; s 0.2; k Return; s 0.2; k ctrl+c; s 0.2; k ctrl+space; s 0.2; k F5; s 0.2; k Delete; s 0.3')

  // Drive the toolbar with real clicks, like a user would.
  const pause = await r.toolbarPoint(app, tb, 'button.pause')
  // Scrolling over the toolbar is not content either.
  await r.xinput(`m ${pause.x} ${pause.y}; s 0.2; w ${pause.x} ${pause.y} 2; s 0.3; c ${pause.x} ${pause.y}`)
  await tb.waitForSelector('.rec-dot.paused', { timeout: 5000 })
  await r.xinput('s 0.3; c 900 500; k ctrl+v; w 900 500 -4; s 0.5') // while paused: not recorded
  await r.xinput(`c ${pause.x} ${pause.y}`)
  await tb.waitForSelector('.rec-dot:not(.paused)', { timeout: 5000 })
  await h.sleep(1500)
  const stop = await r.toolbarPoint(app, tb, 'button.stop')
  await r.xinput(`m ${stop.x} ${stop.y}; s 0.2; c ${stop.x} ${stop.y}`)
  await win.waitForSelector('.editor canvas', { timeout: 120000 })

  const [id] = h.listProjects(home)
  const project = h.readProject(home, id)
  const cursor = JSON.parse(fs.readFileSync(path.join(h.projectsRoot(home), id, 'cursor.json'), 'utf8'))
  const distinct = new Set(cursor.samples.map((s) => `${s.x.toFixed(3)},${s.y.toFixed(3)}`))
  h.assert(cursor.valid && distinct.size > 30, `cursor samples follow the pointer (${distinct.size} distinct positions)`)

  const near = (c, x, y) => Math.abs(c.x - x / 1920) < 0.01 && Math.abs(c.y - y / 1080) < 0.01
  h.assert(cursor.clicks.length === 3, `exactly the three content clicks (two clicks and the drag): ${JSON.stringify(cursor.clicks)}`)
  const [first, second, drag] = cursor.clicks
  h.assert(near(first, 400, 300) && near(second, 1500, 800) && near(drag, 600, 400), `click positions ${JSON.stringify(cursor.clicks)}`)
  h.assert(cursor.clicks.every((c) => c.t > 0.3 && c.t < project.duration - 2), 'click times inside the recording, none at Stop')

  // Releases: a click is held 60 ms; the drag until the end of its 0.6 s glide.
  console.log(`  held ${cursor.clicks.map((c) => (c.up - c.t).toFixed(3)).join(', ')} s`)
  for (const c of [first, second]) h.assert(Number.isFinite(c.up) && c.up - c.t > 0.03 && c.up - c.t < 0.3, `click released 0.03-0.3 s after its press: ${JSON.stringify(c)}`)
  h.assert(Number.isFinite(drag.up) && drag.up - drag.t >= 0.6 && drag.up - drag.t < 1.5, `the drag is held through its glide: ${JSON.stringify(drag)}`)
  const sampleAt = (t) => cursor.samples.filter((s) => s.t <= t).pop()
  h.assert(near(sampleAt(drag.t + 0.01), 600, 400) && near(sampleAt(drag.up), 1200, 600), `pressed at the drag's start and released at its end: ${JSON.stringify([sampleAt(drag.t + 0.01), sampleAt(drag.up)])}`)

  // Scrolling: notches where they happened, down then up; none from the toolbar or while paused.
  const scrolls = cursor.scrolls
  console.log(`  scrolls ${JSON.stringify(scrolls)}`)
  h.assert(Array.isArray(scrolls), 'scrolling was recorded')
  const down = scrolls.filter((s) => s.dy > 0)
  const up = scrolls.filter((s) => s.dy < 0)
  const sum = (list) => list.reduce((a, s) => a + s.dy, 0)
  h.assert(sum(down) === 6 && sum(up) === -3 && down.length + up.length === scrolls.length, `six notches down, then three up: ${JSON.stringify(scrolls)}`)
  h.assert(scrolls.every((s) => s.dx === 0), 'vertical scrolling only')
  h.assert(Math.max(...down.map((s) => s.t)) < Math.min(...up.map((s) => s.t)), 'down before up')
  h.assert(scrolls.every((s) => near(s, 960, 540)), `every scroll at the centre (none at the toolbar or while paused): ${JSON.stringify(scrolls)}`)
  h.assert(scrolls.every((s, i) => s.t > second.t && s.t < drag.t && (i === 0 || s.t >= scrolls[i - 1].t)), 'scroll times ordered, between the clicks and the drag')

  const labels = cursor.keys.map((k) => k.label)
  const expected = ['Ctrl + Shift + S', 'Enter', 'Ctrl + C', 'Ctrl + Space', 'F5', 'Delete']
  h.assert(JSON.stringify(labels) === JSON.stringify(expected), `keystrokes ${JSON.stringify(labels)}`)
  h.assert(cursor.keys.every((k, i) => k.t >= 0 && k.t <= project.duration && (i === 0 || k.t >= cursor.keys[i - 1].t)), 'keystroke times ordered and in range')

  h.assert(project.zooms.length > 0, 'auto zooms generated from the clicks')
  for (const z of project.zooms) {
    h.assert(cursor.clicks.some((c) => c.t >= z.start && c.t <= z.end), `zoom ${z.start.toFixed(2)}-${z.end.toFixed(2)} comes from a content click`)
  }
})

// An area recording: scrolling and releases are remapped into the area like clicks, and a
// wheel outside the area is dropped.
await h.run('real input in an area recording: scrolls and releases remapped into the area, outside input dropped', async (ctx) => {
  const home = h.tempHome('rec-input-area')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = r.closable(app)
  ctx.logs = logs
  await r.waitForSources(win)
  await win.click('.segmented button:has-text("Area")')
  await win.waitForSelector('button.record[disabled]')
  await win.click('.source')
  // The area (400, 300) to (1200, 750), picked in the overlay.
  const overlay = await r.until(() => app.windows().find((w) => w.url().includes('#/region')), { what: 'region overlay' })
  await overlay.waitForSelector('.region-root')
  await overlay.mouse.move(400, 300)
  await overlay.mouse.down()
  await overlay.mouse.move(1200, 750, { steps: 12 })
  await overlay.mouse.up()
  await overlay.waitForSelector('.region-actions')
  await overlay.keyboard.press('Enter').catch(() => undefined)
  await r.until(() => r.mainVisible(app), { what: 'main window back' })
  await win.waitForSelector('.region-summary')

  const tb = await r.startRecording(app, win)
  // In the area: 3 notches down at (1000, 400); outside it: 2 notches up at (100, 100), a click
  // there; then a drag inside the area and a click.
  await r.xinput('g 500 400 1000 400 0.4; s 0.3; w 1000 400 3; s 0.4; w 100 100 -2; s 0.2; c 100 100; s 0.4; d 500 400 1100 700 0.5; s 0.4; c 600 400; s 1.0')
  await tb.click('button.stop')
  await win.waitForSelector('.editor canvas', { timeout: 120000 })

  const [id] = h.listProjects(home)
  const project = h.readProject(home, id)
  const cursor = JSON.parse(fs.readFileSync(path.join(h.projectsRoot(home), id, 'cursor.json'), 'utf8'))
  h.assert(project.width === 800 && project.height === 450 && project.capture.target === 'area', `an 800x450 area: ${project.width}x${project.height} ${JSON.stringify(project.capture)}`)
  const inArea = (p, x, y) => Math.abs(p.x - (x - 400) / 800) < 0.01 && Math.abs(p.y - (y - 300) / 450) < 0.01
  console.log(`  clicks ${JSON.stringify(cursor.clicks)}`)
  console.log(`  scrolls ${JSON.stringify(cursor.scrolls)}`)
  h.assert(cursor.clicks.length === 2, `the drag and the click inside the area, not the one outside: ${JSON.stringify(cursor.clicks)}`)
  const [drag, click] = cursor.clicks
  h.assert(inArea(drag, 500, 400) && inArea(click, 600, 400), `clicks remapped into the area: ${JSON.stringify(cursor.clicks)}`)
  h.assert(Number.isFinite(click.up) && click.up - click.t > 0.03 && click.up - click.t < 0.3, `click released 0.03-0.3 s after its press: ${JSON.stringify(click)}`)
  h.assert(Number.isFinite(drag.up) && drag.up - drag.t >= 0.5 && drag.up - drag.t < 1.4, `the drag is held through its glide: ${JSON.stringify(drag)}`)
  const sampleAt = (t) => cursor.samples.filter((s) => s.t <= t).pop()
  h.assert(inArea(sampleAt(drag.up), 1100, 700), `released at the drag's end: ${JSON.stringify(sampleAt(drag.up))}`)
  const scrolls = cursor.scrolls
  h.assert(Array.isArray(scrolls) && scrolls.length > 0, 'scrolling was recorded')
  h.assert(scrolls.reduce((n, s) => n + s.dy, 0) === 3 && scrolls.every((s) => s.dy > 0 && s.dx === 0), `3 notches down inside the area, none from outside it: ${JSON.stringify(scrolls)}`)
  h.assert(scrolls.every((s) => inArea(s, 1000, 400) && s.t > 0 && s.t < drag.t), `scrolls remapped into the area, before the drag: ${JSON.stringify(scrolls)}`)
})
})()
