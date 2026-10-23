// Full-stack native capture: the real app + the real src/main/nativeCapture.ts client +
// a helper PROCESS speaking the ssw-capture protocol (tests/fixtures/fake-capture-helper.cjs,
// recording Xvfb without the cursor). Covers the seam between the recording pipeline and
// the native client that the per-area tests exercise only with in-process fakes.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

const HELPER = path.join(h.APP_DIR, 'tests/fixtures/fake-capture-helper.cjs')

h.run('integration: real native client + helper process, pause cut out, shapes, audio', async (ctx) => {
  const home = h.tempHome('int-native')
  const helperLog = path.join(home, 'helper.log')
  const { app, win, logs } = await h.launch({
    home,
    args: r.FAKE_MEDIA,
    env: { SSW_CAPTURE_HELPER: HELPER, FAKE_HELPER_VIDEO: 'x11grab', FAKE_HELPER_LOG: helperLog, FAKE_HELPER_SHAPES: 'text,pointer' }
  })
  ctx.app = r.closable(app)
  ctx.logs = logs
  await r.waitForSources(win)
  await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
  const tb = await r.startRecording(app, win)
  await h.sleep(2500)
  h.assert(r.fileSize(path.join(r.activeDir(home), 'native.mp4')) >= 0, 'recording folder exists')
  await tb.click('button.pause')
  await tb.waitForSelector('.rec-dot.paused')
  await h.sleep(1500)
  await tb.click('button.pause')
  await tb.waitForSelector('.rec-dot:not(.paused)')
  await h.sleep(1500)
  await tb.click('button.stop')
  await win.waitForSelector('.editor canvas', { timeout: 120000 })

  const lines = fs.readFileSync(helperLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const commands = lines.filter((l) => l.stdin).map((l) => String(l.stdin).split(' ')[0])
  h.assert(lines.some((l) => Array.isArray(l.argv) && l.argv[0] === 'record'), 'helper was asked to record')
  h.assert(['pause', 'resume', 'stop'].every((c) => commands.includes(c)), `helper commands ${commands}`)

  const [id] = h.listProjects(home)
  const project = h.readProject(home, id)
  const pdir = path.join(h.projectsRoot(home), id)
  h.assert(project.capture.method === 'native' && project.capture.cursorInVideo === false, `capture ${JSON.stringify(project.capture)}`)
  h.assert(project.cursor.show === true, 'smooth cursor on for native capture')
  // ~4 s active (2.5 + 1.5), the 1.5 s pause excluded.
  h.assert(project.duration > 3.2 && project.duration < 5.2, `duration ${project.duration}`)
  const streams = r.probe(path.join(pdir, 'screen.mp4')).streams
  h.assert(streams.some((s) => s.codec_type === 'audio'), 'proxy has the Chromium audio')
  h.assert(streams.some((s) => s.codec_type === 'video'), 'proxy has the helper video')
  const cursor = JSON.parse(fs.readFileSync(path.join(pdir, 'cursor.json'), 'utf8'))
  h.assert(cursor.shapes.map((s) => s.shape).join(',') === 'text,pointer', `shapes ${JSON.stringify(cursor.shapes)}`)
})
