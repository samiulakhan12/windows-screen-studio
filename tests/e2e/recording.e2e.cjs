// Recording flows in the real built app: fake mic + camera, pause/resume, streaming
// to disk, countdown cancel/stop, double-click start, discard confirmation, and
// friendly errors for vanished sources.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

;(async () => {
  await h.run('record with fake mic + camera, pause/resume, media streamed while recording', async (ctx) => {
    const home = h.tempHome('rec-av')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    const selects = await win.$$('.record-panel select')
    await selects[0].selectOption({ index: 1 })
    await selects[1].selectOption({ index: 1 })

    await r.readyToRecord(win)
    await win.click('button.record')
    const tb = await r.toolbar(app)
    // First recording after launch: the toolbar shows the countdown, not live controls.
    await tb.waitForSelector('.countdown-number', { timeout: 10000 })
    h.assert(!(await tb.$('button.stop')), 'no live Stop button during the countdown')
    await tb.waitForSelector('button.stop', { timeout: 10000 })
    const t0 = Date.now()
    await h.sleep(2500)

    const dir = r.activeDir(home)
    h.assert(dir, 'recording folder exists while recording')
    const early = r.fileSize(path.join(dir, 'screen.webm'))
    h.assert(early > 0, `screen.webm is written during recording (${early} bytes)`)
    h.assert(r.fileSize(path.join(dir, 'webcam.webm')) > 0, 'webcam.webm is written during recording')

    await tb.click('button.pause')
    await tb.waitForSelector('.rec-dot.paused')
    await h.sleep(3000)
    await tb.click('button.pause')
    await tb.waitForSelector('.rec-dot:not(.paused)')
    await h.sleep(2500)
    h.assert(r.fileSize(path.join(dir, 'screen.webm')) > early, 'screen.webm keeps growing')

    await win.evaluate(() => {
      // Did Home show "Saving…" right after Stop?
      window.__sawSaving = false
      new MutationObserver(() => {
        if (document.querySelector('.overlay')) window.__sawSaving = true
      }).observe(document.body, { childList: true, subtree: true })
    })
    await tb.click('button.stop')
    const wall = (Date.now() - t0) / 1000
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    h.assert(await win.evaluate(() => window.__sawSaving), 'Home showed the saving overlay')

    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    const pdir = path.join(h.projectsRoot(home), id)
    // ~5 s recorded, ~3 s paused.
    h.assert(project.duration > 4 && project.duration < wall - 2, `duration ${project.duration} excludes the pause (wall ${wall})`)
    h.assert(project.hasAudio && project.hasWebcam, 'audio and webcam recorded')
    h.assert(Number.isFinite(project.webcamOffset) && Math.abs(project.webcamOffset) < 1, `webcam offset ${project.webcamOffset}`)
    h.assert(project.capture.method === 'chromium' && project.capture.cursorInVideo === true, 'Chromium capture keeps the OS cursor in the video')

    const screen = r.probe(path.join(pdir, 'screen.mp4'))
    const v = screen.streams.find((s) => s.codec_type === 'video')
    h.assert(v && v.codec_name === 'h264' && v.r_frame_rate === '60/1', `screen proxy is 60 fps H.264 (${JSON.stringify(v)})`)
    h.assert(screen.streams.some((s) => s.codec_type === 'audio'), 'screen proxy has audio')
    const cam = r.probe(path.join(pdir, 'webcam.mp4')).streams[0]
    h.assert(cam.r_frame_rate !== '60/1', `camera proxy keeps its own rate (${cam.r_frame_rate})`)
    for (const f of ['screen.webm', 'webcam.webm', 'recording.json']) h.assert(!fs.existsSync(path.join(pdir, f)), `${f} removed after processing`)
    const cursor = JSON.parse(fs.readFileSync(path.join(pdir, 'cursor.json'), 'utf8'))
    h.assert(cursor.valid === true && cursor.scale === 1, 'cursor track valid with display scale')
  })

  await h.run('cancel during the countdown leaves nothing behind', async (ctx) => {
    const home = h.tempHome('rec-cancel')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await r.readyToRecord(win)
    await win.click('button.record')
    const tb = await r.toolbar(app)
    await tb.waitForSelector('.countdown-number')
    await tb.click('button.cancel')
    await r.until(() => r.mainVisible(app), { what: 'main window shown again' })
    await win.waitForSelector('button.record:not([disabled])')
    await h.sleep(500)
    h.assert(r.projectDirs(home).length === 0, `no folders left: ${r.projectDirs(home)}`)
    h.assert(!(await win.$('.home-error')), 'no error shown')
  })

  await h.run('stop during the countdown cancels instead of saving an empty recording', async (ctx) => {
    const home = h.tempHome('rec-stopcd')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await r.readyToRecord(win)
    await win.click('button.record')
    const tb = await r.toolbar(app)
    await tb.waitForSelector('.countdown-number')
    // What the Stop shortcut sends.
    await tb.evaluate(() => window.api.sendRecorderCommand('stop'))
    await r.until(() => r.mainVisible(app), { what: 'main window shown again' })
    await win.waitForSelector('button.record:not([disabled])')
    await h.sleep(1000)
    h.assert(r.projectDirs(home).length === 0, 'no folder created')
    h.assert(!(await win.$('.home-error')), 'no error shown')
    h.assert(!logs.join('').includes('ffmpeg'), 'ffmpeg never ran')
  })

  await h.run('double-clicking Start runs a single recording', async (ctx) => {
    const home = h.tempHome('rec-dbl')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    const tb = await r.startRecording(app, win, { click: (w) => w.dblclick('button.record') })
    await h.sleep(2000)
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    h.assert(r.projectDirs(home).length === 1, `exactly one recording folder: ${r.projectDirs(home)}`)
    const project = h.readProject(home, h.listProjects(home)[0])
    h.assert(project.duration > 1, `duration ${project.duration}`)
    h.assert(!logs.join('').includes('already in progress'), 'no second session was attempted')
  })

  await h.run('discard asks for confirmation; Keep continues the recording', async (ctx) => {
    const home = h.tempHome('rec-discard')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    const tb = await r.startRecording(app, win)
    await tb.click('button.discard')
    await tb.waitForSelector('.toolbar.confirm')
    await tb.click('button:has-text("Keep")')
    await tb.waitForSelector('button.stop')
    h.assert(!(await r.mainVisible(app)), 'still recording after Keep')
    await tb.click('button.discard')
    await tb.click('button:has-text("Discard")')
    await r.until(() => r.mainVisible(app), { what: 'main window shown again' })
    await h.sleep(500)
    h.assert(r.projectDirs(home).length === 0, 'discarded recording removed')
  })

  await h.run('vanished sources give friendly errors; unexpected capture requests are denied once', async (ctx) => {
    const home = h.tempHome('rec-gone')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    const result = await win.evaluate(async () => {
      const out = {}
      try {
        await window.api.prepareCapture({ sourceId: 'window:4242:0', region: null, systemAudio: false, captureKeys: false })
        out.prepare = 'ok'
      } catch (e) {
        out.prepare = e.message
      }
      try {
        await navigator.mediaDevices.getDisplayMedia({ video: true })
        out.gdm = 'granted'
      } catch (e) {
        out.gdm = e.name
      }
      return out
    })
    h.assert(/no longer available/.test(result.prepare), `friendly prepare error: ${result.prepare}`)
    h.assert(result.gdm !== 'granted', `ungranted capture denied (${result.gdm})`)
    await h.sleep(500)
    h.assert(!logs.join('').includes('more than once'), 'display-media callback called once')
    h.assert(r.projectDirs(home).length === 0, 'no folder for a failed prepare')
    // The UI still works afterwards.
    const tb = await r.startRecording(app, win)
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
  })

  await h.run('a second launch hands over to the running instance', async (ctx) => {
    const home = h.tempHome('rec-single')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await win.waitForSelector('button.record')
    // Hidden rather than minimised: Xvfb has no window manager to minimise with.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()))
    const second = spawn(path.join(h.APP_DIR, 'node_modules/electron/dist/electron'), [h.APP_DIR, '--no-sandbox'], {
      env: { ...process.env, HOME: home },
      stdio: 'ignore'
    })
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        second.kill('SIGKILL')
        resolve('still running')
      }, 20000)
      second.on('exit', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
    h.assert(code === 0, `second instance exits at once (${code})`)
    await r.until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() && !w.isMinimized())), {
      what: 'first instance brought forward'
    })
  })

  await h.run('a stop shortcut owned by another app is reported on the toolbar', async (ctx) => {
    const home = h.tempHome('rec-shortcut')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    // As if another application had registered Ctrl+Shift+2 first.
    await app.evaluate(({ globalShortcut }) => {
      globalShortcut.register = () => false
    })
    await r.waitForSources(win)
    const tb = await r.startRecording(app, win)
    await tb.waitForSelector('.tb-warn')
    h.assert((await tb.getAttribute('button.stop', 'title')).includes('used by another app'), 'Stop explains the shortcut is unavailable')
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
  })
  await h.run('Home: light per-tab thumbnails, honest window hint, live microphone level', async (ctx) => {
    const home = h.tempHome('rec-home')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    // perf-7: small JPEG thumbnails, and only the kind the tab shows is listed.
    const src = await win.getAttribute('.source img', 'src')
    h.assert(src.startsWith('data:image/jpeg;base64,'), `JPEG thumbnail (${src.slice(0, 30)}…)`)
    const kinds = await win.evaluate(async () => [...new Set((await window.api.getSources(['screen'])).map((s) => s.kind))])
    h.assert(JSON.stringify(kinds) === '["screen"]', `screens only: ${kinds}`)

    // audit-B-2: the Windows tab says plainly what window recordings lack, and offers Area.
    await win.click('.segmented button:has-text("Windows")')
    const hint = await win.textContent('.window-hint')
    h.assert(/no auto zoom, click highlights or smooth cursor/.test(hint), `window hint: ${hint}`)
    await win.click('.window-hint button')
    await win.waitForSelector('.segmented button.active:has-text("Area")')

    // audit-C-2: the selected microphone shows a live level (the fake device beeps).
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    const peak = await r.until(
      async () => {
        const t = await win.evaluate(() => document.querySelector('.mic-meter-fill')?.style.transform ?? '')
        const v = Number(/scaleX\(([\d.]+)\)/.exec(t)?.[1] ?? 0)
        return v > 0.05 ? v : 0
      },
      { timeout: 10000, what: 'microphone level' }
    )
    h.assert(peak > 0.05, `meter moves (${peak})`)
    h.assert(!(await win.$('.device-problem')), 'no device problem shown')
  })
})()
