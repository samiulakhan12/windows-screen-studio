// Real OS input while recording (XTest): the cursor track follows the pointer, clicks
// land where they happened, only shortcut keystrokes are kept, and clicks on the
// floating toolbar (Pause, Resume, Stop) never become clicks or auto zooms.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

h.run('real input: cursor, clicks and shortcuts are captured; toolbar clicks are not content', async (ctx) => {
  const home = h.tempHome('rec-input')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = r.closable(app)
  ctx.logs = logs
  await r.waitForSources(win)
  const tb = await r.startRecording(app, win)

  await r.xinput('g 200 200 1700 900 1.0; s 0.3; c 400 300; s 0.6; g 400 300 1500 800 0.6; c 1500 800; s 0.5')
  // Shortcuts are kept; plain typing ("a", "A", space) is not.
  await r.xinput('k ctrl+shift+s; s 0.2; k a; k shift+a; k space; s 0.2; k Return; s 0.2; k ctrl+c; s 0.2; k ctrl+space; s 0.2; k F5; s 0.2; k Delete; s 0.3')

  // Drive the toolbar with real clicks, like a user would.
  const pause = await r.toolbarPoint(app, tb, 'button.pause')
  await r.xinput(`m ${pause.x} ${pause.y}; s 0.2; c ${pause.x} ${pause.y}`)
  await tb.waitForSelector('.rec-dot.paused', { timeout: 5000 })
  await r.xinput('s 0.3; c 900 500; k ctrl+v; s 0.5') // while paused: not recorded
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
  h.assert(cursor.clicks.length === 2, `exactly the two content clicks: ${JSON.stringify(cursor.clicks)}`)
  h.assert(near(cursor.clicks[0], 400, 300) && near(cursor.clicks[1], 1500, 800), `click positions ${JSON.stringify(cursor.clicks)}`)
  h.assert(cursor.clicks.every((c) => c.t > 0.3 && c.t < project.duration - 2), 'click times inside the recording, none at Stop')

  const labels = cursor.keys.map((k) => k.label)
  const expected = ['Ctrl + Shift + S', 'Enter', 'Ctrl + C', 'Ctrl + Space', 'F5', 'Delete']
  h.assert(JSON.stringify(labels) === JSON.stringify(expected), `keystrokes ${JSON.stringify(labels)}`)
  h.assert(cursor.keys.every((k, i) => k.t >= 0 && k.t <= project.duration && (i === 0 || k.t >= cursor.keys[i - 1].t)), 'keystroke times ordered and in range')

  h.assert(project.zooms.length > 0, 'auto zooms generated from the clicks')
  for (const z of project.zooms) {
    h.assert(cursor.clicks.some((c) => c.t >= z.start && c.t <= z.end), `zoom ${z.start.toFixed(2)}-${z.end.toFixed(2)} comes from a content click`)
  }
})
