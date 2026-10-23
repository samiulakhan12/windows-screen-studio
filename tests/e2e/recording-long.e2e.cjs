// A 65 s recording of a busy screen: media is streamed to disk the whole time and the
// recorder renderer's memory stays flat (nothing accumulates until Stop).
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

const SECONDS = 65

const BUSY_PAGE = `<body style="margin:0;background:#000;overflow:hidden">
<canvas id="c" width="960" height="540" style="width:100vw;height:100vh"></canvas>
<script>
const c = document.getElementById('c').getContext('2d')
let f = 0
function draw() {
  f++
  for (let i = 0; i < 60; i++) {
    c.fillStyle = 'hsl(' + ((f * 7 + i * 37) % 360) + ',80%,50%)'
    c.fillRect(Math.random() * 960, Math.random() * 540, 80, 60)
  }
  c.fillStyle = '#fff'
  c.font = '48px sans-serif'
  c.fillText(String(f), 20, 60)
  requestAnimationFrame(draw)
}
draw()
</script></body>`

h.run(`a ${SECONDS} s recording streams to disk and keeps renderer memory flat`, async (ctx) => {
  const home = h.tempHome('rec-long')
  // No fake media devices here: they would replace the real screen with a test pattern.
  const { app, win, logs } = await h.launch({ home })
  ctx.app = r.closable(app)
  ctx.logs = logs
  // Motion everywhere, so the encoder produces a realistic amount of data.
  await app.evaluate(({ BrowserWindow }, html) => {
    const w = new BrowserWindow({ x: 0, y: 0, width: 1920, height: 1080, frame: false, show: false, focusable: false })
    w.loadURL(`data:text/html,${encodeURIComponent(html)}`)
    w.once('ready-to-show', () => w.showInactive())
  }, BUSY_PAGE)
  await r.waitForSources(win)
  const tb = await r.startRecording(app, win)
  const start = Date.now()
  const dir = r.activeDir(home)
  const samples = []
  for (let t = 10; t <= SECONDS; t += 11) {
    await h.sleep(start + t * 1000 - Date.now())
    samples.push({ t, rendererMB: await r.rendererMemoryMB(app), fileMB: +(r.fileSize(path.join(dir, 'screen.webm')) / 1e6).toFixed(1) })
  }
  await h.sleep(Math.max(0, start + SECONDS * 1000 - Date.now()))
  await tb.click('button.stop')
  console.log('memory/file samples', JSON.stringify(samples))

  const first = samples[0]
  const last = samples[samples.length - 1]
  h.assert(last.rendererMB - first.rendererMB < 40, `renderer memory flat: ${first.rendererMB} MB -> ${last.rendererMB} MB`)
  h.assert(samples.every((s, i) => i === 0 || s.fileMB > samples[i - 1].fileMB), 'screen.webm grows throughout the recording')
  h.assert(last.fileMB > 20, `realistic amount of media written (${last.fileMB} MB)`)

  await win.waitForSelector('.editor canvas', { timeout: 300000 })
  const project = h.readProject(home, h.listProjects(home)[0])
  h.assert(Math.abs(project.duration - SECONDS) < 2.5, `duration ${project.duration}`)
})
