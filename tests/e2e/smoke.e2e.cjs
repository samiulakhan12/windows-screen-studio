// Record a few seconds, stop from the floating toolbar, open the editor, export MP4.
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')

h.run('smoke: record -> edit -> export mp4', async (ctx) => {
  const home = h.tempHome('smoke')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await h.waitForSources(win)
  await win.click('button.record')
  await h.sleep(7000)
  const toolbar = h.toolbarOf(app)
  h.assert(toolbar, 'toolbar window exists')
  await toolbar.click('button.stop')
  await win.waitForSelector('.editor canvas', { timeout: 120000 })
  const [id] = h.listProjects(home)
  h.assert(id, 'project saved')
  const project = h.readProject(home, id)
  h.assert(project.version === 2, 'project schema v2')
  h.assert(project.duration > 1, `duration ${project.duration}`)

  const out = path.join(home, 'smoke.mp4')
  await h.mockSaveDialog(app, out)
  await win.click('button:has-text("Export")')
  await win.click('.chip:has-text("720p")')
  await win.click('.modal button:has-text("Export MP4")')
  await win.waitForSelector('text=Export finished', { timeout: 300000 })
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString()
  h.assert(Math.abs(parseFloat(probe) - project.duration) < 0.5, `export duration ${probe} vs ${project.duration}`)
})
