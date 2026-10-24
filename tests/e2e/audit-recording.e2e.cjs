// Audit fixes of the recording pipeline, in the real built app:
// - R-1: the cursor track is saved while recording, so a crash of the whole app, End task or a
//   forced quit keeps it (a recovered recording has its cursor, clicks and keystrokes);
// - R-2: quitting during a native recording lets the capture helper finalise its video (the
//   app's own will-quit cleanup no longer kills it first);
// - R-4: the camera offset is kept in the manifest while recording, so a recording recovered
//   after a recorder crash has its camera in sync;
// - E6: an emptied recording name is never saved, even while the name field keeps focus.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')
const f = require('./editor-fixtures.cjs')

const HELPER = path.join(h.APP_DIR, 'tests/fixtures/fake-capture-helper.cjs')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
/** Moves the real (XTest) pointer around: what the cursor tracker records. */
const wiggle = (n) => r.xinput(Array.from({ length: n }, (_, i) => `m ${300 + ((i * 137) % 900)} ${250 + ((i * 89) % 500)}; s 0.15`).join('; '))

;(async () => {
  await h.run('R-1/R-2: quitting during a native recording finalises the video and keeps the cursor track', async (ctx) => {
    const home = h.tempHome('audit-quit')
    const helperLog = path.join(home, 'helper.log')
    const env = { SSW_CAPTURE_HELPER: HELPER, FAKE_HELPER_VIDEO: 'testsrc', FAKE_HELPER_LOG: helperLog }
    const { app, win, logs } = await h.launch({ home, env })
    ctx.app = r.closable(app)
    ctx.logs = logs
    // "Quit anyway" when the main window asks.
    await r.captureDialogs(app, 1)
    await r.waitForSources(win)
    await r.startRecording(app, win)
    const dir = r.activeDir(home)
    h.assert(readJson(path.join(dir, 'recording.json')).method === 'native', 'recorded by the helper')
    await wiggle(12)
    const exited = new Promise((resolve) => app.process().once('exit', resolve))
    await app.evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    await Promise.race([exited, h.sleep(30000)])
    h.assert(app.process().exitCode !== null || app.process().signalCode !== null, 'the app quit')

    const commands = fs
      .readFileSync(helperLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((l) => l.stdin && l.stdin !== '<eof>')
      .map((l) => String(l.stdin).split(' ')[0])
    h.assert(commands.includes('stop'), `the helper was asked to stop, not killed: ${commands}`)
    // The fake writes the final video only when it finishes; a killed one leaves none.
    const video = r.probe(path.join(dir, 'native.mp4'))
    h.assert(parseFloat(video.format.duration) > 1, `finalised video ${JSON.stringify(video.format)}`)
    const cursor = readJson(path.join(dir, 'cursor.json'))
    h.assert(cursor.valid === true && cursor.samples.length >= 3, `cursor track kept: valid ${cursor.valid}, ${cursor.samples.length} samples`)

    // Next start: Recover gives a project with its cursor.
    const again = await h.launch({ home })
    ctx.app = r.closable(again.app)
    ctx.logs = again.logs
    await again.win.waitForSelector('.unfinished', { timeout: 30000 })
    await again.win.click('.unfinished button:has-text("Recover")')
    await again.win.waitForSelector('.editor canvas', { timeout: 120000 })
    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    const recovered = readJson(path.join(h.projectsRoot(home), id, 'cursor.json'))
    h.assert(project.capture.method === 'native' && project.capture.cursorInVideo === false, `capture ${JSON.stringify(project.capture)}`)
    h.assert(recovered.valid === true && recovered.samples.length >= 3, `recovered cursor: valid ${recovered.valid}, ${recovered.samples.length} samples`)
  })

  await h.run('R-1: when the whole app dies, the cursor track recorded until the last checkpoint is on disk', async (ctx) => {
    const home = h.tempHome('audit-kill')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await r.startRecording(app, win)
    const dir = r.activeDir(home)
    const t0 = Date.now()
    await wiggle(30)
    while (Date.now() - t0 < 7000) await h.sleep(200)
    // Power loss, End task or a crash of the main process: nothing runs any more.
    process.kill(app.process().pid, 'SIGKILL')
    await h.sleep(500)
    const file = path.join(dir, 'cursor.json')
    h.assert(fs.existsSync(file), 'cursor.json written while recording')
    const cursor = readJson(file)
    h.assert(cursor.valid === true && cursor.samples.length >= 3, `cursor track: valid ${cursor.valid}, ${cursor.samples.length} samples`)
    h.assert(cursor.samples.every((s) => s.t >= 0 && s.t < 9), `sample times ${cursor.samples[0].t}..${cursor.samples[cursor.samples.length - 1].t}`)
  })

  await h.run('R-4: the camera offset is saved while recording and kept by a recorder crash', async (ctx) => {
    const home = h.tempHome('audit-offsets')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.captureDialogs(app)
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[1].selectOption({ index: 1 })
    await r.startRecording(app, win)
    const dir = r.activeDir(home)
    const manifest = await r.until(
      () => {
        const m = readJson(path.join(dir, 'recording.json'))
        return m.hasWebcam && m.webcamOffset !== 0 ? m : null
      },
      { what: 'the measured camera offset in recording.json' }
    )
    h.assert(Math.abs(manifest.webcamOffset) < 1, `camera offset ${manifest.webcamOffset}`)
    await h.sleep(1500)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
      main.webContents.forcefullyCrashRenderer()
    })
    const after = await r.until(
      () => {
        const m = readJson(path.join(dir, 'recording.json'))
        return m.status === 'interrupted' ? m : null
      },
      { what: 'interrupted manifest' }
    )
    h.assert(after.webcamOffset === manifest.webcamOffset, `offset kept after the crash: ${after.webcamOffset} (was ${manifest.webcamOffset})`)
  })

  await h.run('E6: an emptied recording name is saved as "Untitled recording", even while the field keeps focus', async (ctx) => {
    const home = h.tempHome('audit-name')
    const id = f.seedProject(home, { name: 'NameTest', seconds: 4 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await f.openProject(win, 'NameTest')
    await win.fill('input.title-input', '')
    const saved = await f.waitFor(() => {
      const name = h.readProject(home, id).name
      return name !== 'NameTest' ? { name } : null
    }, 'the autosave of the emptied name')
    h.assert(saved.name === 'Untitled recording', `saved name ${JSON.stringify(saved.name)}`)
    h.assert((await win.inputValue('input.title-input')) === '', 'the field still shows what is typed')
    h.assert(await win.evaluate(() => document.activeElement?.classList.contains('title-input')), 'the field kept focus')
  })
})()
