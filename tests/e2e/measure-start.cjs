// The size and start-up measurements of docs/design/output-and-languages.md §19.4, taken at step S0
// (before any extraction) and again at S2 on the merged build, against these budgets: the renderer's
// JavaScript at most 250 KB larger, the main window's first render at most 30 ms later, and the
// recording bar's first render at most 20 ms later.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/measure-start.cjs --step S0
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/measure-start.cjs --step S2 --baseline <dir>
//
// Each run starts the built app with a fresh home and reads the first contentful paint of the main
// window (Home) and of a recording-bar window (the toolbar route, opened from main with the bar's
// own window options and told that a recording is paused, since an idle bar draws nothing). The
// medians of the runs, with the bundle sizes, are written under the step's name in
// docs/design/output-and-languages-measurements.json; with S0 and S2 both there, the script prints
// the differences against the budgets.
//
// The times of a shared machine drift by some 30 ms from one hour to the next, as much as the budgets
// allow. With --baseline <dir>, a checkout of S0's commit built in <dir>, the runs alternate between
// that build and this one, and both are written: S0 again and the step, measured side by side.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const h = require('./helpers.cjs')

const RECORD = path.join(h.APP_DIR, 'docs/design/output-and-languages-measurements.json')
const RUNS = 7
const BUDGET = { rendererJsBytes: 250 * 1024, mainFirstRenderMs: 30, toolbarFirstRenderMs: 20 }

function files(dir, ext) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    if (fs.statSync(file).isDirectory()) out.push(...files(file, ext))
    else if (name.endsWith(ext)) out.push(file)
  }
  return out
}

/** Raw and gzip bytes of the built JavaScript of each process of the build in `appDir`. */
function bundleSizes(appDir = h.APP_DIR) {
  const sum = (list) => list.reduce((acc, f) => {
    const data = fs.readFileSync(f)
    return { bytes: acc.bytes + data.length, gzip: acc.gzip + zlib.gzipSync(data, { level: 9 }).length }
  }, { bytes: 0, gzip: 0 })
  const out = path.join(appDir, 'out')
  // The renderer's own code: every chunk but the wasm loaders and workers of MediaPipe and the sounds host.
  const renderer = files(path.join(out, 'renderer/assets'), '.js').filter((f) => !/wasm_module|\.worker-/.test(path.basename(f)))
  return {
    renderer: sum(renderer),
    rendererChunks: renderer.length,
    main: sum(files(path.join(out, 'main'), '.js')),
    preload: sum(files(path.join(out, 'preload'), '.js'))
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * The first contentful paint of a page, in ms from its navigation start: Home with its text, the
 * paused recording bar with its time and buttons. (A first paint can come earlier from the page's
 * background alone: while the renderer loaded its views at once, as on the build S0 measured, the
 * bar's page painted its background some 120 ms before the bar itself.)
 */
const paintAt = (page, name) =>
  page.evaluate(
    (entry) =>
      new Promise((resolve, reject) => {
        const hit = performance.getEntriesByName(entry)[0]
        if (hit) return resolve(hit.startTime)
        const timer = setTimeout(() => reject(new Error(`no ${entry} within 20 s`)), 20000)
        new PerformanceObserver((list, obs) => {
          const e = list.getEntriesByName(entry)[0]
          if (e) {
            clearTimeout(timer)
            obs.disconnect()
            resolve(e.startTime)
          }
        }).observe({ type: 'paint', buffered: true })
      }),
    name
  )

async function once(n, appDir = h.APP_DIR) {
  const home = h.tempHome(`measure-${n}`)
  const { app, win } = await h.launch({ home, appDir, env: { SSW_UPDATES_FAKE: 'none' } })
  try {
    await win.waitForSelector('.home', { timeout: 30000 })
    const main = await paintAt(win, 'first-contentful-paint')
    // The recording bar's own window options (src/main/recording/toolbarWindow.ts), shown at once. The
    // preload is named outright: getLastWebPreferences() no longer reports it, and without it the bar
    // finds no window.api, fails before it draws, and paints nothing. An idle bar draws nothing either,
    // so the bar is told that a recording is paused: its first paint is the bar itself.
    const preload = path.join(appDir, 'out', 'preload', 'index.js')
    await app.evaluate(({ BrowserWindow, ipcMain }, preloadPath) => {
      ipcMain.removeHandler('recording:getStatus')
      ipcMain.handle('recording:getStatus', () => ({ state: 'paused', elapsed: 0 }))
      const owner = BrowserWindow.getAllWindows()[0]
      const w = new BrowserWindow({ width: 640, height: 64, show: true, frame: false, transparent: true, resizable: false, hasShadow: false, webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      const url = new URL(owner.webContents.getURL())
      url.hash = '#/toolbar'
      void w.loadURL(url.toString())
    }, preload)
    let toolbar = null
    for (const end = Date.now() + 30000; !toolbar; await h.sleep(50)) {
      toolbar = app.windows().find((p) => p.url().includes('#/toolbar')) || null
      if (!toolbar && Date.now() > end) throw new Error('The recording bar window did not open')
    }
    await toolbar.waitForLoadState('domcontentloaded')
    const bar = await paintAt(toolbar, 'first-contentful-paint')
    return { main, toolbar: bar }
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** The measurements of the build in `appDir` from its runs. */
function resultOf(appDir, runs, extra = {}) {
  return {
    at: new Date().toISOString(),
    commit: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appDir }).toString().trim(),
    ...extra,
    sizes: bundleSizes(appDir),
    mainFirstRenderMs: Math.round(median(runs.map((r) => r.main)) * 10) / 10,
    toolbarFirstRenderMs: Math.round(median(runs.map((r) => r.toolbar)) * 10) / 10,
    runs
  }
}

const argOf = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : null
}

async function main() {
  const step = argOf('--step')
  const baseline = argOf('--baseline') && path.resolve(argOf('--baseline'))
  await h.run(`start-up measurements${step ? ` (${step})` : ''}`, async () => {
    if (baseline && !step) throw new Error('--baseline needs --step')
    const runs = []
    const baseRuns = []
    for (let n = 0; n < RUNS; n++) {
      if (!baseline) {
        runs.push(await once(n))
        continue
      }
      // Alternating, so a drift of the machine's speed weighs on both builds alike.
      if (n % 2) {
        runs.push(await once(n))
        baseRuns.push(await once(n, baseline))
      } else {
        baseRuns.push(await once(n, baseline))
        runs.push(await once(n))
      }
    }
    const result = resultOf(h.APP_DIR, runs)
    console.log(JSON.stringify(result, null, 1))
    if (!step) return
    const record = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : {}
    record[step] = result
    if (baseline) record.S0 = resultOf(baseline, baseRuns, { note: `Taken again beside ${step}, with the runs alternating between the two builds.` })
    fs.writeFileSync(RECORD, `${JSON.stringify(record, null, 1)}\n`)
    if (record.S0 && record.S2) {
      const d = {
        rendererJsBytes: record.S2.sizes.renderer.bytes - record.S0.sizes.renderer.bytes,
        mainFirstRenderMs: record.S2.mainFirstRenderMs - record.S0.mainFirstRenderMs,
        toolbarFirstRenderMs: record.S2.toolbarFirstRenderMs - record.S0.toolbarFirstRenderMs
      }
      for (const [k, v] of Object.entries(d)) console.log(`${k}: ${v > 0 ? '+' : ''}${v} (budget ${BUDGET[k]})${v > BUDGET[k] ? ' OVER BUDGET' : ''}`)
    }
  })
}

void main()
