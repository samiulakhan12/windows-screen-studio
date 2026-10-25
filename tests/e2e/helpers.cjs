/**
 * Shared helpers for end-to-end tests that drive the BUILT app (out/) with
 * Playwright's Electron support. Run under a virtual display on Linux:
 *   npm run build && xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e
 * Each test file is a standalone script: it exits non-zero on failure.
 */
const { _electron: electron } = require('playwright-core')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_DIR = path.resolve(__dirname, '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fresh HOME so recordings land in a throwaway Videos folder. */
function tempHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssw-e2e-${name}-`))
  return dir
}

/** Videos folder used by the app for a given HOME (Linux XDG default). */
function projectsRoot(home) {
  return path.join(home, 'Videos', 'Flown')
}

async function launch({ home, args = [], env = {} } = {}) {
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
    args: [APP_DIR, '--no-sandbox', ...args],
    env: { ...process.env, HOME: home, ...env },
    timeout: 60000
  })
  const logs = []
  app.process().stdout.on('data', (d) => logs.push(`[main] ${d}`))
  app.process().stderr.on('data', (d) => logs.push(`[main:err] ${d}`))
  const win = await app.firstWindow()
  // firstWindow() can resolve while the initial navigation is still in flight; queries
  // made then fail with "Execution context was destroyed".
  await win.waitForLoadState('domcontentloaded')
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  win.on('console', (m) => m.type() === 'error' && logs.push(`[console.error] ${m.text()}`))
  return { app, win, logs }
}

/**
 * Waits until a screen source is listed. Under load Xvfb's X11 capturer can fail
 * ("Failed to initialize pixel buffer") and list no screens for half a minute or more.
 */
async function waitForSources(win, timeout = 90000) {
  const end = Date.now() + timeout
  while (!(await win.$('.source'))) {
    if (Date.now() > end) throw new Error('No capture sources listed (Xvfb screen capturer unavailable)')
    const refresh = await win.$('button[title="Refresh"]')
    if (refresh) await refresh.click().catch(() => undefined)
    await sleep(2000)
  }
}

function toolbarOf(app) {
  return app.windows().find((w) => w.url().includes('#/toolbar')) || null
}

/** Replaces the main-process save dialog so exports go to `file`. */
async function mockSaveDialog(app, file) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, file)
}

function listProjects(home) {
  const root = projectsRoot(home)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'project.json')))
}

function readProject(home, id) {
  return JSON.parse(fs.readFileSync(path.join(projectsRoot(home), id, 'project.json'), 'utf8'))
}

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`)
}

/** Wraps a test body: prints PASS/FAIL, dumps logs on failure, always closes the app. */
async function run(name, body) {
  const ctx = { app: null, logs: [] }
  try {
    await body(ctx)
    console.log(`PASS ${name}`)
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.stack ? err.stack : err}`)
    if (ctx.logs.length) console.error(ctx.logs.slice(-60).join(''))
    process.exitCode = 1
  } finally {
    if (ctx.app) await ctx.app.close().catch(() => undefined)
  }
}

module.exports = { APP_DIR, sleep, tempHome, projectsRoot, launch, waitForSources, toolbarOf, mockSaveDialog, listProjects, readProject, assert, run }
