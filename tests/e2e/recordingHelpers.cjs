// Helpers shared by the recording e2e tests (built on helpers.cjs).
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')

/** Chromium's fake camera and microphones, granted without prompts. */
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

async function until(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await h.sleep(interval)
  }
}

/** The toolbar page (created hidden before the countdown). */
const toolbar = (app) => until(() => h.toolbarOf(app), { what: 'toolbar window' })

/** Visibility of the app's windows, by route. */
async function windowsState(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
      .map((w) => ({ route: w.webContents.getURL().replace(/^.*#/, '#'), visible: w.isVisible(), bounds: w.getBounds() }))
  )
}

async function mainVisible(app) {
  return (await windowsState(app)).some((w) => w.route === '#/' && w.visible)
}

/**
 * Like helpers.waitForSources, but more patient: under load Xvfb's screen capturer
 * can fail ("Failed to initialize pixel buffer") for half a minute.
 */
async function waitForSources(win, timeout = 90000) {
  const end = Date.now() + timeout
  while (!(await win.$('.source'))) {
    if (Date.now() > end) throw new Error('No capture sources listed (Xvfb screen capturer unavailable)')
    await win.click('button[title="Refresh"]').catch(() => undefined)
    await h.sleep(2000)
  }
}

/** Waits for an enabled Start button, refreshing sources if Xvfb listed no screens. */
async function readyToRecord(win) {
  for (let i = 0; i < 10; i++) {
    if (await win.$('button.record:not([disabled])')) return
    if (!(await win.$('.source'))) await win.click('button[title="Refresh"]').catch(() => undefined)
    await h.sleep(1000)
  }
  await win.waitForSelector('button.record:not([disabled])', { timeout: 10000 })
}

/** Clicks Start and waits until the recorder runs (toolbar shows the stop button). */
async function startRecording(app, win, { click = (w) => w.click('button.record') } = {}) {
  await readyToRecord(win)
  await click(win)
  const tb = await toolbar(app)
  await tb.waitForSelector('button.stop', { timeout: 20000 })
  return tb
}

/** Folders in the projects root (finished or not). */
function projectDirs(home) {
  const root = h.projectsRoot(home)
  return fs.existsSync(root) ? fs.readdirSync(root) : []
}

/** The folder of the recording in progress (it has recording.json and no project.json). */
function activeDir(home) {
  const root = h.projectsRoot(home)
  const id = projectDirs(home).find((d) => fs.existsSync(path.join(root, d, 'recording.json')))
  return id ? path.join(root, id) : null
}

const fileSize = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0)

function probe(file) {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration:format=duration', '-of', 'json', file]).toString()
  )
}

/** Runs real X input (see xinput.py). */
function xinput(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-I', path.join(__dirname, 'xinput.py'), 'script', script], { stdio: 'inherit' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`xinput exited with ${code}`))))
  })
}

/** Screen coordinates of the centre of `selector` in the toolbar window. */
async function toolbarPoint(app, tb, selector) {
  const win = (await windowsState(app)).find((w) => w.route === '#/toolbar')
  const box = await (await tb.$(selector)).boundingBox()
  return { x: Math.round(win.bounds.x + box.x + box.width / 2), y: Math.round(win.bounds.y + box.y + box.height / 2) }
}

/** Working-set memory (MB) of the main window's renderer process. */
async function rendererMemoryMB(app) {
  return app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
    const pid = main.webContents.getOSProcessId()
    const m = electronApp.getAppMetrics().find((p) => p.pid === pid)
    return Math.round(m.memory.workingSetSize / 1024)
  })
}

/** Replaces dialog.showMessageBox; returns a getter for the messages shown. */
async function captureDialogs(app, response = 0) {
  await app.evaluate(({ dialog }, r) => {
    globalThis.__dialogs = []
    dialog.showMessageBox = async (...args) => {
      const opts = args[args.length - 1]
      globalThis.__dialogs.push(opts.message)
      return { response: r, checkboxChecked: false }
    }
  }, response)
  return () => app.evaluate(() => globalThis.__dialogs)
}

/**
 * What helpers.run() closes. While a recording is still being processed the app's
 * quit guard (rightly) refuses to close, which would hang a failed test: after a
 * grace period the whole process tree is killed instead.
 */
function closable(app) {
  return {
    close: async () => {
      const pid = app.process().pid
      const closed = await Promise.race([app.close().then(() => true), h.sleep(15000).then(() => false)])
      if (closed) return
      const rows = execFileSync('ps', ['-eo', 'pid=,ppid=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
      const tree = new Set([pid])
      for (let grew = true; grew; ) {
        grew = false
        for (const [p, pp] of rows) {
          if (tree.has(pp) && !tree.has(p)) {
            tree.add(p)
            grew = true
          }
        }
      }
      for (const p of tree) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  }
}

module.exports = { closable, waitForSources, FAKE_MEDIA, until, toolbar, readyToRecord, windowsState, mainVisible, startRecording, projectDirs, activeDir, fileSize, probe, xinput, toolbarPoint, rendererMemoryMB, captureDialogs }
