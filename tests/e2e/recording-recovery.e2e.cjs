// Nothing captured is ever lost: a recorder crash keeps what reached disk, and a
// failed conversion keeps the raw recording; both can be finished from Home.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8'))

;(async () => {
  await h.run('recorder crash mid-recording: UI recovers and the footage can be recovered', async (ctx) => {
    const home = h.tempHome('rec-crash')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    const dialogs = await r.captureDialogs(app)
    await r.waitForSources(win)
    await r.startRecording(app, win)
    await h.sleep(4000)
    const dir = r.activeDir(home)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
      main.webContents.forcefullyCrashRenderer()
    })
    await r.until(() => r.mainVisible(app), { what: 'main window shown after the crash' })
    await r.until(async () => (await dialogs()).length > 0, { what: 'crash message' })
    h.assert((await dialogs())[0] === 'The recorder stopped unexpectedly.', `message: ${await dialogs()}`)
    const toolbar = (await r.windowsState(app)).find((w) => w.route === '#/toolbar')
    h.assert(!toolbar || !toolbar.visible, 'toolbar hidden')
    const m = readManifest(dir)
    h.assert(m.status === 'interrupted' && m.duration > 2, `manifest ${JSON.stringify(m)}`)
    h.assert(r.fileSize(path.join(dir, 'screen.webm')) > 0, 'streamed footage is on disk')

    // Playwright's page object stays dead after a renderer crash: drive the reloaded page directly.
    const js = (code) =>
      app.evaluate(({ BrowserWindow }, c) => {
        const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
        return main.webContents.executeJavaScript(c)
      }, code)
    const item = await r.until(() => js(`document.querySelector('.unfinished')?.textContent ?? ''`), { timeout: 20000, what: 'unfinished recording on Home' })
    h.assert(item.includes('Interrupted'), `listed as interrupted: ${item}`)
    await js(`[...document.querySelectorAll('.unfinished button')].find((b) => b.textContent.includes('Recover')).click()`)
    await r.until(() => js(`!!document.querySelector('.editor canvas')`), { timeout: 120000, what: 'editor after recovery' })
    const project = h.readProject(home, h.listProjects(home)[0])
    h.assert(project.duration > 2.5 && project.duration < 6, `recovered duration ${project.duration}`)
    h.assert(!fs.existsSync(path.join(dir, 'recording.json')), 'manifest removed after recovery')
  })

  await h.run('failed conversion keeps the recording, explains where it is, and Retry finishes it', async (ctx) => {
    const home = h.tempHome('rec-fail')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    // Make every proxy encode fail as if ffmpeg could not read the input.
    await app.evaluate(() => {
      const cp = process.mainModule.require('node:child_process')
      globalThis.__realSpawn = cp.spawn
      cp.spawn = function (cmd, args, opts) {
        if (Array.isArray(args) && args.includes('-progress')) args = ['-hide_banner', '-i', '/nonexistent/broken.webm']
        return globalThis.__realSpawn.call(this, cmd, args, opts)
      }
    })
    await r.waitForSources(win)
    const tb = await r.startRecording(app, win)
    await h.sleep(2500)
    await tb.click('button.stop')
    await win.waitForSelector('.home-error', { timeout: 60000 })
    const message = await win.textContent('.home-error')
    const dir = path.join(h.projectsRoot(home), r.projectDirs(home)[0])
    h.assert(message.includes("Couldn't convert the recording") && message.includes(dir), `friendly error with the folder: ${message}`)
    h.assert(message.length < 400, 'no raw ffmpeg log in the UI')
    h.assert(r.fileSize(path.join(dir, 'screen.webm')) > 0, 'raw recording kept')
    h.assert(readManifest(dir).status === 'failed', 'manifest marked failed')
    await win.waitForSelector('.unfinished')
    h.assert((await win.textContent('.unfinished')).includes('Processing failed'), 'listed as failed')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'recovery-failed.png') })

    await app.evaluate(() => {
      process.mainModule.require('node:child_process').spawn = globalThis.__realSpawn
    })
    await win.click('.unfinished button:has-text("Retry")')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    const project = h.readProject(home, h.listProjects(home)[0])
    h.assert(project.duration > 1.5, `duration ${project.duration}`)
  })

  await h.run('Finish later stops a long conversion and keeps the recording for later', async (ctx) => {
    const home = h.tempHome('rec-later')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    // Convert at playback speed so there is time to press the button.
    await app.evaluate(() => {
      const cp = process.mainModule.require('node:child_process')
      globalThis.__realSpawn = cp.spawn
      cp.spawn = function (cmd, args, opts) {
        if (Array.isArray(args) && args.includes('-progress')) args = ['-re', ...args]
        return globalThis.__realSpawn.call(this, cmd, args, opts)
      }
    })
    await r.waitForSources(win)
    const tb = await r.startRecording(app, win)
    await h.sleep(4000)
    await tb.click('button.stop')
    await win.waitForSelector('.overlay .progress-track', { timeout: 30000 })
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'processing-progress.png') })
    await win.click('.overlay button:has-text("Finish later")')
    await win.waitForSelector('.notice', { timeout: 30000 })
    h.assert((await win.textContent('.notice')).includes('Processing was stopped'), 'explains the recording waits for later')
    h.assert(!(await win.$('.home-error')), 'not shown as an error')
    await win.waitForSelector('.unfinished')
    h.assert((await win.textContent('.unfinished')).includes('Interrupted'), 'listed as unfinished')
    h.assert(h.listProjects(home).length === 0, 'no project yet')

    await app.evaluate(() => {
      process.mainModule.require('node:child_process').spawn = globalThis.__realSpawn
    })
    await win.click('.unfinished button:has-text("Recover")')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    h.assert(h.readProject(home, h.listProjects(home)[0]).duration > 3, 'finished later with the full duration')
  })
})()
