// The size and start-up measurements of docs/design/output-and-languages.md §19.4, taken at step S0
// (before any extraction) and again at S2 on the merged build, against these budgets: the renderer's
// JavaScript at most 250 KB larger, the main window's first render at most 30 ms later, and the
// recording bar's first render at most 20 ms later.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/measure-start.cjs --step S0
//
// Each run starts the built app with a fresh home and reads the first contentful paint of the main
// window (Home) and the first paint of a recording-bar window (the toolbar route, opened from main
// with the main window's own web preferences). The medians of the runs, with the bundle sizes, are
// written under the step's name in docs/design/output-and-languages-measurements.json; with S0 and
// S2 both there, the script prints the differences against the budgets.
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

/** Raw and gzip bytes of the built JavaScript of each process. */
function bundleSizes() {
  const sum = (list) => list.reduce((acc, f) => {
    const data = fs.readFileSync(f)
    return { bytes: acc.bytes + data.length, gzip: acc.gzip + zlib.gzipSync(data, { level: 9 }).length }
  }, { bytes: 0, gzip: 0 })
  const out = path.join(h.APP_DIR, 'out')
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
 * A paint of a page, in ms from its navigation start: 'first-contentful-paint' for Home, which shows
 * text at once; 'first-paint' for the recording bar, whose idle state draws the bar with icons only
 * (no text, so Chromium records no contentful paint for it).
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

async function once(n) {
  const home = h.tempHome(`measure-${n}`)
  const { app, win } = await h.launch({ home, env: { SSW_UPDATES_FAKE: 'none' } })
  try {
    await win.waitForSelector('.home', { timeout: 30000 })
    const main = await paintAt(win, 'first-contentful-paint')
    await app.evaluate(({ BrowserWindow }) => {
      const owner = BrowserWindow.getAllWindows()[0]
      const prefs = owner.webContents.getLastWebPreferences()
      const w = new BrowserWindow({ width: 640, height: 64, show: true, frame: false, webPreferences: { preload: prefs.preload, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: false } })
      const url = new URL(owner.webContents.getURL())
      url.hash = '#/toolbar'
      void w.loadURL(url.toString())
    })
    let toolbar = null
    for (const end = Date.now() + 30000; !toolbar; await h.sleep(50)) {
      toolbar = app.windows().find((p) => p.url().includes('#/toolbar')) || null
      if (!toolbar && Date.now() > end) throw new Error('The recording bar window did not open')
    }
    await toolbar.waitForLoadState('domcontentloaded')
    const bar = await paintAt(toolbar, 'first-paint')
    return { main, toolbar: bar }
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(home, { recursive: true, force: true })
  }
}

async function main() {
  const i = process.argv.indexOf('--step')
  const step = i > 0 ? process.argv[i + 1] : null
  await h.run(`start-up measurements${step ? ` (${step})` : ''}`, async () => {
    const sizes = bundleSizes()
    const runs = []
    for (let n = 0; n < RUNS; n++) runs.push(await once(n))
    const result = {
      at: new Date().toISOString(),
      commit: require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: h.APP_DIR }).toString().trim(),
      sizes,
      mainFirstRenderMs: Math.round(median(runs.map((r) => r.main)) * 10) / 10,
      toolbarFirstRenderMs: Math.round(median(runs.map((r) => r.toolbar)) * 10) / 10,
      runs
    }
    console.log(JSON.stringify(result, null, 1))
    if (!step) return
    const record = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : {}
    record[step] = result
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
