// Window security (src/main/security.ts): a window cannot be navigated away from the app's page
// (a page that loaded would keep the preload's window.api), opens no new windows, swallows
// dropped files, runs sandboxed, and only the app's page gets the camera, microphone and clipboard.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const h = require('./helpers.cjs')

/** A local page that reports what it can reach in its title. */
function evilPage(home) {
  const file = path.join(home, 'evil.html')
  fs.writeFileSync(file, `<!doctype html><title>evil</title><script>document.title = 'evil:' + typeof window.api</script>`)
  return pathToFileURL(file).href
}

const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

h.run('security: no navigation away from the app, no new windows, dropped files ignored, sandboxed', async (ctx) => {
  const home = h.tempHome('security-nav')
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('button.record')
  const appUrl = win.url()
  h.assert(appUrl.includes('/out/renderer/index.html'), `the app page is loaded (${appUrl})`)
  const evil = evilPage(home)

  // A renderer-started navigation (what a dropped file or a link does) is cancelled.
  await win.evaluate((u) => {
    location.href = u
  }, evil).catch(() => undefined)
  await h.sleep(1500)
  h.assert(win.url() === appUrl, `still on the app page (${win.url()})`)
  h.assert((await win.title()) === 'Flown', `title ${await win.title()}`)
  h.assert(await win.isVisible('button.record'), 'Home is still shown')

  // window.open() of any page is refused.
  const before = await windowCount(app)
  const opened = await win.evaluate((u) => window.open(u) === null, evil)
  await h.sleep(500)
  h.assert(opened, 'window.open returns null')
  h.assert((await windowCount(app)) === before, 'no window was opened')

  // A file dropped on the page is not opened in place of the app.
  const dropPrevented = await win.evaluate(() => {
    for (const type of ['dragover', 'drop']) {
      const e = new Event(type, { bubbles: true, cancelable: true })
      document.querySelector('#root').dispatchEvent(e)
      if (!e.defaultPrevented) return false
    }
    return true
  })
  h.assert(dropPrevented, 'dragover and drop are cancelled')

  const sandboxed = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getLastWebPreferences().sandbox))
  h.assert(sandboxed.length > 0 && sandboxed.every((s) => s === true), `every window is sandboxed (${JSON.stringify(sandboxed)})`)
  h.assert((await win.evaluate(() => typeof window.api.listProjects)) === 'function', 'the sandboxed preload still exposes window.api')
})

h.run('security: only the app page gets the camera, microphone and clipboard', async (ctx) => {
  const home = h.tempHome('security-perm')
  // Fake devices but no fake prompt UI: the app's permission handler alone decides.
  const { app, win, logs } = await h.launch({ home, args: ['--use-fake-device-for-media-stream'] })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('button.record')

  // Any other page (loaded here by main, which navigation guards do not stop) gets nothing.
  const evil = evilPage(home)
  const other = await app.evaluate(async ({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ show: false })
    try {
      await w.loadURL(url)
      return await w.webContents.executeJavaScript(`Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'ok', (e) => e.name),
        navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'ok', (e) => e.name)
      ])`)
    } finally {
      w.destroy()
    }
  }, evil)
  h.assert(other.every((r) => r === 'NotAllowedError'), `another page is refused the microphone and camera (${other})`)

  const appMedia = await win.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      s.getTracks().forEach((t) => t.stop())
      return 'ok'
    } catch (e) {
      return `${e.name}: ${e.message}`
    }
  })
  h.assert(appMedia === 'ok', `the app page opens the camera and microphone (${appMedia})`)

  await win.bringToFront()
  const copied = await win.evaluate(async () => {
    try {
      await navigator.clipboard.writeText('00:00 Intro')
      return 'ok'
    } catch (e) {
      return `${e.name}: ${e.message}`
    }
  })
  h.assert(copied === 'ok', `the app page writes the clipboard (${copied})`)
  h.assert((await app.evaluate(({ clipboard }) => clipboard.readText())) === '00:00 Intro', 'clipboard holds the text')
})
