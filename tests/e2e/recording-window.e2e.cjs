// Single-window recordings with cursor effects and auto zoom, on Xvfb with openbox and an
// xterm as the recorded window. Real X input (XTest) moves and clicks; the window is moved
// mid-recording (XMoveWindow). The native helper is replaced by a fake NativeCaptureApi
// injected into the main process (like recording-native.e2e.cjs) that speaks the window
// contract with X11 tools: the window's rectangle from libX11 (xwindow.py watch) and whether
// the pointer is over it rather than over a window covering it (xpointer.py over: the
// helper's `cursorOver`), together the helper's 'window' events / watch-window, and its video
// from ffmpeg x11grab -window_id without the cursor (record --window).
//   (a) native window capture: helper video without the cursor, smooth cursor on
//   (b) Chromium window capture + watcher: cursor in the video, effects still work
//   (c) nothing can follow the window: no cursor data, and the user is told so
//   (d) another window covers part of the recorded one: a click on it is ignored and the
//       cursor is hidden there
// Every auto zoom must frame its click: the camera (the editor's own cameraAt) is checked at
// each click.
// Run: xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/recording-window.e2e.cjs
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

const XWINDOW = path.join(__dirname, 'xwindow.py')
const XPOINTER = path.join(__dirname, 'xpointer.py')
// SSW_E2E_REAL_HELPER=1 (tests/e2e/integration-window.e2e.cjs): instead of an in-process fake,
// the app's real nativeCapture client runs tests/fixtures/fake-capture-helper.cjs as the helper
// PROCESS (record --window / watch-window over the real stdin/stdout protocol).
const REAL_HELPER = process.env.SSW_E2E_REAL_HELPER === '1'
const HELPER_SCRIPT = path.join(__dirname, '..', 'fixtures', 'fake-capture-helper.cjs')
// Marks the helper processes of this run, so the test can tell that none was left running.
const RUN_MARK = `SSW_E2E_WINDOW_RUN=${process.pid}`
const helperEnv = (native) => ({
  SSW_CAPTURE_HELPER: HELPER_SCRIPT,
  FAKE_HELPER_VIDEO: 'x11grab',
  FAKE_HELPER_WINDOW_CAPTURE: native ? '1' : '0',
  SSW_E2E_WINDOW_RUN: String(process.pid)
})
// Scenario (d) needs the helper's cursorOver: the in-process fake reports it; with the real
// client it runs once the fake helper process reports it too.
const COVER_SUPPORTED = !REAL_HELPER || fs.readFileSync(HELPER_SCRIPT, 'utf8').includes('cursorOver')
const TITLE = 'SSW-TESTWIN'
const COVER_TITLE = 'SSW-COVER'
const START = { x: 300, y: 200 }

/** The editor's zoom camera (src/shared/engine/zoom.ts), bundled on its own for this process. */
const zoomEngine = (() => {
  let engine = null
  return () => {
    if (engine) return engine
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-zoom-')), 'zoom.cjs')
    esbuild.buildSync({ entryPoints: [path.join(h.APP_DIR, 'src/shared/engine/zoom.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
    engine = require(outfile)
    return engine
  }
})()

/** Helper processes of this run still alive (REAL_HELPER mode), from /proc. */
function helperProcesses() {
  const found = []
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      if (!cmd.includes('fake-capture-helper')) continue
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      // A zombie has exited (its parent reaps it); only running ones count.
      if (/^\d+ \(.*\) Z /.test(stat)) continue
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(RUN_MARK)) found.push(`${pid} ${cmd.slice(0, 160)}`)
    } catch {
      // Gone meanwhile, or not ours to read.
    }
  }
  return found
}

const xw = (...args) => execFileSync('python3', ['-I', XWINDOW, ...args.map(String)]).toString().trim()
const geometry = (xid) => JSON.parse(xw('geometry', xid))

function have(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A window manager (desktopCapturer lists windows only with one): openbox, unless one runs. */
async function startWindowManager() {
  if (xw('wm') === '1') return () => undefined
  const wm = spawn('openbox', [], { stdio: 'ignore' })
  await r.until(() => xw('wm') === '1', { timeout: 10000, what: 'openbox' })
  return () => wm.kill()
}

/** The window to record: an xterm (its X window id from $WINDOWID). */
async function startTestWindow({ title = TITLE, geometry: geo = `80x24+${START.x}+${START.y}` } = {}) {
  const idFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-xterm-')), 'id')
  const term = spawn('xterm', ['-T', title, '-geometry', geo, '-e', 'sh', '-c', `echo $WINDOWID > ${idFile}; exec sleep 3600`], { stdio: 'ignore' })
  const xid = await r.until(() => (fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : ''), { timeout: 10000, what: 'xterm window' })
  await r.until(() => geometry(xid)?.width > 0, { what: 'xterm mapped' })
  return { xid, kill: () => term.kill() }
}

/** Moves the window (the window manager may adjust the position) and waits until it moved. */
async function moveWindow(xid, x, y) {
  const before = geometry(xid)
  xw('move', xid, x, y)
  return r.until(
    () => {
      const g = geometry(xid)
      return g.x !== before.x || g.y !== before.y ? g : null
    },
    { timeout: 5000, what: 'window moved' }
  )
}

/** Puts the window back where every scenario starts. */
async function resetWindow(xid) {
  const g = geometry(xid)
  if (Math.abs(g.x - START.x) > 5 || Math.abs(g.y - START.y) > 30) await moveWindow(xid, START.x, START.y)
  return geometry(xid)
}

/**
 * Installs the fake helper client: `native` enables record --window, `watch` enables
 * watch-window. Returns a getter for what it was asked to do.
 */
async function installFakeHelper(app, { native, watch }) {
  await app.evaluate(
    (_electron, cfg) => {
      const { spawn } = process.mainModule.require('node:child_process')
      const log = (globalThis.__fakeWindow = { starts: [], watched: [], calls: [], pids: [] })
      const xidOf = (id) => {
        const m = /^window:(\d+):\d+$/.exec(id)
        if (!m) throw new Error(`malformed window id ${id}`)
        return m[1]
      }
      /** A python3 poller printing JSON lines, each handed to `onEvent`. */
      function poller(args, onEvent) {
        const proc = spawn('python3', ['-I', ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
        log.pids.push(proc.pid)
        let buffer = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => {
          buffer += d
          for (let i; (i = buffer.indexOf('\n')) >= 0; ) {
            const line = buffer.slice(0, i)
            buffer = buffer.slice(i + 1)
            let event
            try {
              event = JSON.parse(line)
            } catch {
              continue // Not JSON.
            }
            onEvent(event)
          }
        })
        return { proc, exited: new Promise((resolve) => proc.on('exit', resolve)) }
      }
      /**
       * The helper's 'window' events: the window's rectangle, and whether the pointer is over
       * it (cursorOver), once at the start and whenever either changes.
       */
      function rectWatcher(xid) {
        const rects = []
        let rect = null
        let over = true
        let settle
        const ready = new Promise((resolve, reject) => (settle = { resolve, reject }))
        ready.catch(() => undefined)
        const emit = (at) => rects.push({ at, ...rect, cursorOver: over })
        const geo = poller([cfg.xwindow, 'watch', xid, '60'], (e) => {
          rect = { x: e.x, y: e.y, width: e.width, height: e.height, minimized: e.minimized }
          emit(e.at)
          if (rects.length === 1) settle.resolve(rects[0])
        })
        const pointer = poller([cfg.xpointer, 'over', xid, '60'], (e) => {
          if (e.over === over) return
          over = e.over
          if (rect) emit(e.at)
        })
        const procs = [geo.proc, pointer.proc]
        void geo.exited.then(() => settle.reject(new Error('the window watcher exited')))
        geo.proc.on('error', (err) => settle.reject(err))
        return {
          ready,
          stop: () => {
            for (const p of procs) p.stdin.end()
            return Promise.all([geo.exited, pointer.exited]).then(() => rects.slice())
          },
          kill: () => procs.forEach((p) => p.kill('SIGKILL'))
        }
      }
      globalThis.__SSW_NATIVE_CAPTURE__ = {
        isNativeCaptureAvailable: async () => false,
        isNativeWindowCaptureAvailable: async () => cfg.native,
        watchWindow(windowId) {
          if (!cfg.watch) throw new Error('fake helper: watch-window unavailable')
          log.watched.push(windowId)
          const w = rectWatcher(xidOf(windowId))
          return {
            ready: w.ready,
            stop: () => {
              log.calls.push(`watch-stop ${windowId}`)
              return w.stop()
            },
            kill: () => {
              log.calls.push(`watch-kill ${windowId}`)
              w.kill()
            }
          }
        },
        startNativeCapture(opts) {
          log.starts.push(opts)
          const xid = xidOf(opts.windowId)
          const rects = rectWatcher(xid)
          const spawnedAt = Date.now()
          // prettier-ignore
          const proc = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'x11grab', '-window_id', xid, '-draw_mouse', '0', '-framerate', '60', '-i', process.env.DISPLAY,
            '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1', opts.output
          ], { stdio: ['pipe', 'pipe', 'inherit'] })
          log.pids.push(proc.pid)
          let stopRequested = false
          let onEnded = null
          const exit = new Promise((resolve) => proc.on('exit', resolve))
          const firstFrame = new Promise((resolve, reject) => {
            proc.on('error', reject)
            proc.on('exit', (code) => reject(new Error(`fake helper exited with ${code}`)))
            proc.stdout.on('data', (d) => /frame=[1-9]/.test(String(d)) && resolve())
          })
          const started = Promise.all([rects.ready, firstFrame]).then(([first]) => ({
            startedAt: spawnedAt,
            width: 2 * Math.floor(first.width / 2),
            height: 2 * Math.floor(first.height / 2)
          }))
          void exit.then(() => !stopRequested && onEnded?.({ reason: 'closed' }))
          return {
            started,
            pause: () => void log.calls.push('pause'),
            resume: () => void log.calls.push('resume'),
            async stop() {
              log.calls.push('stop')
              stopRequested = true
              proc.stdin.end('q')
              await exit
              return { frames: 0, shapes: [{ at: spawnedAt, shape: 'arrow' }], windowRects: await rects.stop() }
            },
            kill() {
              log.calls.push('kill')
              stopRequested = true
              proc.kill('SIGKILL')
              rects.kill()
            },
            onEnded(cb) {
              onEnded = cb
            }
          }
        }
      }
    },
    { native, watch, xwindow: XWINDOW, xpointer: XPOINTER }
  )
  return () => app.evaluate(() => globalThis.__fakeWindow)
}

/** Waits until the Windows tab lists the test window (the capturer can be slow under Xvfb). */
async function pickTestWindow(win) {
  await win.click('.segmented button:has-text("Windows")')
  const source = `.source:has-text("${TITLE}")`
  const end = Date.now() + 90000
  while (!(await win.$(source))) {
    if (Date.now() > end) throw new Error('The test window is not listed')
    await win.click('button[title="Refresh"]').catch(() => undefined)
    await h.sleep(1500)
  }
  await win.click(source)
  return win.$eval(source, (el) => el.textContent)
}

/** What the user was told: notices on Home and on the processing overlay. */
async function watchNotices(win) {
  await win.evaluate(() => {
    window.__notices = new Set()
    new MutationObserver(() => {
      for (const n of document.querySelectorAll('.notice span, .overlay-notices span')) window.__notices.add(n.textContent)
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  return () => win.evaluate(() => [...window.__notices])
}

const near = (c, x, y) => Math.abs(c.x - x) <= 0.02 && Math.abs(c.y - y) <= 0.02

/**
 * Records the test window: moves the cursor over it, clicks at a quarter across / half down,
 * clicks outside it, moves it, clicks at three quarters across / a quarter down, and stops.
 * `during` runs while the recording is still going (before the window is moved). The two
 * clicks are far enough apart to get an auto zoom each.
 */
async function recordWithInput(app, win, xid, { during } = {}) {
  const g0 = geometry(xid)
  const tb = await r.startRecording(app, win)
  const at = (g, fx, fy) => [Math.round(g.x + fx * g.width), Math.round(g.y + fy * g.height)]
  const [ax, ay] = at(g0, 0.25, 0.5)
  await r.xinput(`g ${g0.x + 20} ${g0.y + 20} ${ax} ${ay} 0.6; s 0.2; c ${ax} ${ay}; s 0.6; g ${ax} ${ay} 1800 100 0.4; c 1800 100; s 1.0`)
  if (during) await during()
  const g1 = await moveWindow(xid, g0.x + 260, g0.y + 140)
  await h.sleep(400)
  const [bx, by] = at(g1, 0.75, 0.25)
  await r.xinput(`g 1800 100 ${bx} ${by} 0.6; s 0.3; c ${bx} ${by}; s 1.2`)
  await tb.click('button.stop')
  await win.waitForSelector('.editor canvas', { timeout: 120000 })
  return { g0, g1 }
}

function readRecording(home) {
  const [id] = h.listProjects(home)
  const project = h.readProject(home, id)
  const cursor = JSON.parse(fs.readFileSync(path.join(h.projectsRoot(home), id, 'cursor.json'), 'utf8'))
  return { id, project, cursor, dir: path.join(h.projectsRoot(home), id) }
}

/** Cursor data mapped into the window: two clicks at the right spots, the outside one dropped, auto zooms there. */
function assertWindowCursor(project, cursor) {
  const distinct = new Set(cursor.samples.map((s) => `${s.x.toFixed(3)},${s.y.toFixed(3)}`))
  h.assert(cursor.valid && distinct.size > 20, `cursor samples follow the pointer (${distinct.size} positions)`)
  h.assert(cursor.clicks.length === 2, `the two clicks in the window, not the one outside it: ${JSON.stringify(cursor.clicks)}`)
  const [a, b] = cursor.clicks
  console.log(`  clicks at ${cursor.clicks.map((c) => `(${c.x.toFixed(3)}, ${c.y.toFixed(3)})`).join(', ')}; video ${project.width}x${project.height}`)
  h.assert(near(a, 0.25, 0.5), `first click at a quarter across, half down: ${JSON.stringify(a)}`)
  h.assert(near(b, 0.75, 0.25), `second click (window moved) at three quarters across, a quarter down: ${JSON.stringify(b)}`)
  h.assert(cursor.clicks.every((c) => c.t > 0 && c.t < project.duration), 'click times inside the recording')
  assertZoomsFrameClicks(project, cursor)
  // A sample on the outside click's spot exists, mapped outside the video (not drawn there).
  h.assert(cursor.samples.some((s) => s.x > 1 || s.y < 0), 'positions outside the window are kept, outside 0..1')
}

/**
 * Every click has an auto zoom, made for it (anchored to it), and at the click the camera,
 * computed as the editor and export do, is zoomed in with the click inside its viewport.
 */
function assertZoomsFrameClicks(project, cursor) {
  const auto = project.zooms.filter((z) => z.auto)
  h.assert(auto.length > 0, 'auto zooms generated from the clicks')
  const { cameraAt, focusPathFor } = zoomEngine()
  const focus = focusPathFor(cursor.samples, project.duration)
  for (const c of cursor.clicks) {
    h.assert(auto.some((z) => c.t >= z.start - 0.01 && c.t <= z.end), `an auto zoom at the click at ${c.t.toFixed(2)} s`)
    const cam = cameraAt(project.zooms, c.t, focus)
    const half = 0.5 / cam.scale
    console.log(`  click (${c.x.toFixed(3)}, ${c.y.toFixed(3)}) at ${c.t.toFixed(2)} s: camera ${cam.scale.toFixed(2)}x at (${cam.cx.toFixed(3)}, ${cam.cy.toFixed(3)})`)
    h.assert(cam.scale > 1.5, `zoomed in at the click at ${c.t.toFixed(2)} s: ${JSON.stringify(cam)}`)
    h.assert(Math.abs(c.x - cam.cx) <= half && Math.abs(c.y - cam.cy) <= half, `the zoom frames the click at ${c.t.toFixed(2)} s: ${JSON.stringify({ click: c, cam })}`)
  }
  // Each zoom was made for a click that is kept (none for an ignored click).
  for (const z of auto) h.assert(z.anchor && cursor.clicks.some((c) => Math.abs(c.t - z.anchor.t) < 1e-6 && near(c, z.anchor.x, z.anchor.y)), `zoom anchored to a click: ${JSON.stringify(z)}`)
}

/** Every helper process the fake started has exited and been reaped (no zombies). */
async function assertNoLeftovers(fake) {
  const { pids } = await fake()
  await r.until(
    () =>
      pids.every((pid) => {
        try {
          return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim() === ''
        } catch {
          return true
        }
      }),
    { timeout: 10000, what: `helper processes ${pids} gone` }
  )
}

/** REAL_HELPER: every helper process of this run (recording, watch-window, the Home probe's) has exited. */
async function assertNoHelperRunning() {
  await r.until(() => helperProcesses().length === 0, { timeout: 10000, what: `no helper process left running (${helperProcesses()})` })
}

/** Live checks of the files of the recording in progress in `home`. */
const liveDir = (home) => {
  const dir = r.activeDir(home)
  h.assert(dir, 'the recording has a folder while it runs')
  return dir
}
const nativeVideoSize = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('native.mp4'))
    .reduce((sum, f) => sum + r.fileSize(path.join(dir, f)), 0)

;(async () => {
  if (!process.env.DISPLAY || !have('openbox') || !have('xterm') || !have('python3') || !have('ffmpeg')) {
    console.log('SKIP recording-window: needs an X display, openbox, xterm, python3 and ffmpeg')
    return
  }
  const stopWm = await startWindowManager()
  const term = await startTestWindow()
  const { xid } = term
  const windowSource = `window:${xid}:0`
  const env = { SSW_CAPTURE_HELPER: '' }

  try {
    await h.run('window (a): native window capture, cursor and clicks mapped through the moving window, smooth cursor on', async (ctx) => {
      await resetWindow(xid)
      const home = h.tempHome('rec-window-native')
      const { app, win, logs } = await h.launch({ home, env: REAL_HELPER ? helperEnv(true) : env })
      ctx.app = r.closable(app)
      ctx.logs = logs
      const fake = REAL_HELPER ? null : await installFakeHelper(app, { native: true, watch: true })
      await pickTestWindow(win)
      await win.waitForSelector('.window-hint')
      h.assert((await win.getAttribute('.window-hint', 'data-support')) === 'full', 'Home: windows get every effect')
      h.assert(/auto zoom, click highlights and the smooth cursor/.test(await win.textContent('.window-hint')), 'the hint says so')
      const notices = await watchNotices(win)

      const { g0 } = await recordWithInput(app, win, xid, {
        during: async () => {
          const live = liveDir(home)
          await r.until(() => nativeVideoSize(live) > 0, { timeout: 10000, what: 'the helper writing the window video' })
          h.assert(!fs.existsSync(path.join(live, 'screen.webm')), 'Chromium does not record the window')
        }
      })
      if (fake) {
        const state = await fake()
        h.assert(state.starts.length === 1 && state.starts[0].windowId === windowSource && !state.starts[0].displayId && state.starts[0].fps === 60, `helper asked for the window: ${JSON.stringify(state.starts)}`)
        h.assert(state.calls.includes('stop') && !state.calls.includes('kill'), `helper stopped cleanly: ${state.calls}`)
        // The helper reports the rectangles itself: no separate watcher for the recording.
        h.assert(!state.watched.includes(windowSource), `no watch-window while recording natively: ${state.watched}`)
      }

      const { project, cursor, dir } = readRecording(home)
      h.assert(project.capture.method === 'native' && project.capture.cursorInVideo === false && project.capture.target === 'window', `capture ${JSON.stringify(project.capture)}`)
      h.assert(project.width === 2 * Math.floor(g0.width / 2) && project.height === 2 * Math.floor(g0.height / 2), `video is the window's size (${project.width}x${project.height})`)
      h.assert(fs.existsSync(path.join(dir, 'screen.mp4')) && !fs.existsSync(path.join(dir, 'native.mp4')), 'proxy built; the raw helper video removed after processing')
      assertWindowCursor(project, cursor)
      h.assert(cursor.shapes.length > 0, 'cursor shapes from the helper')
      h.assert(project.cursor.show === true, 'smooth cursor on (no OS cursor in the video)')
      await win.click('.insp-tabs button:has-text("Cursor")')
      h.assert(await win.$eval('input[aria-label="Show smooth cursor"]', (i) => i.checked && !i.disabled), 'the editor shows the smooth cursor on')
      h.assert(!(await win.$('[data-testid="cursor-in-video"]')) && !(await win.$('[data-testid="cursor-not-recorded"]')), 'no cursor warning')
      h.assert((await notices()).length === 0, `nothing to warn about: ${await notices()}`)
      if (fake) await assertNoLeftovers(fake)
      else await assertNoHelperRunning()
    })

    await h.run('window (b): Chromium window capture with a watcher keeps auto zoom and click highlights', async (ctx) => {
      await resetWindow(xid)
      const home = h.tempHome('rec-window-watch')
      const { app, win, logs } = await h.launch({ home, env: REAL_HELPER ? helperEnv(false) : env })
      ctx.app = r.closable(app)
      ctx.logs = logs
      const fake = REAL_HELPER ? null : await installFakeHelper(app, { native: false, watch: true })
      await pickTestWindow(win)
      await win.waitForSelector('.window-hint')
      h.assert((await win.getAttribute('.window-hint', 'data-support')) === 'effects', 'Home: effects, but no smooth cursor')
      const hint = await win.textContent('.window-hint')
      h.assert(/no smooth cursor: native window capture is not available on this PC/.test(hint), `the hint says why: ${hint}`)
      h.assert(!/2004|Windows 10/.test(hint), 'without guessing at the Windows version')

      const { g0 } = await recordWithInput(app, win, xid, {
        during: async () => {
          const live = liveDir(home)
          await r.until(() => r.fileSize(path.join(live, 'screen.webm')) > 0, { timeout: 10000, what: 'Chromium streaming the window video' })
          h.assert(nativeVideoSize(live) === 0 && !fs.readdirSync(live).some((f) => f.startsWith('native.mp4')), 'no helper video')
        }
      })
      if (fake) {
        const state = await fake()
        h.assert(state.starts.length === 0, 'no native capture')
        h.assert(state.watched.includes(windowSource) && state.calls.includes(`watch-stop ${windowSource}`), `the window was watched, then stopped: ${JSON.stringify(state)}`)
      }

      const { project, cursor, dir } = readRecording(home)
      h.assert(project.capture.method === 'chromium' && project.capture.cursorInVideo === true && project.capture.target === 'window', `capture ${JSON.stringify(project.capture)}`)
      h.assert(fs.existsSync(path.join(dir, 'screen.mp4')) && !fs.existsSync(path.join(dir, 'screen.webm')), 'proxy built; the raw Chromium video removed after processing')
      // The window's own size (its first frame), not a default one.
      h.assert(project.width === 2 * Math.floor(g0.width / 2) && project.height === 2 * Math.floor(g0.height / 2), `video is the window's size (${project.width}x${project.height})`)
      assertWindowCursor(project, cursor)
      h.assert(project.cursor.show === false, 'no smooth cursor over the recorded one')
      await win.click('.insp-tabs button:has-text("Cursor")')
      h.assert(/window was recorded with standard capture/.test(await win.textContent('[data-testid="cursor-in-video"]')), 'the editor explains the cursor is in the video')
      h.assert(!(await win.$eval('input[aria-label="Click effect"]', (i) => i.disabled)), 'click highlights available')
      if (fake) await assertNoLeftovers(fake)
      // The Home probe's watcher and the recording's watcher have both exited.
      else await assertNoHelperRunning()
    })

    if (!REAL_HELPER) await h.run('window (c): nothing follows the window: no cursor data, and the user is told so', async (ctx) => {
      await resetWindow(xid)
      const home = h.tempHome('rec-window-plain')
      // No helper at all (as on Linux, or a Windows install without ssw-capture.exe).
      const { app, win, logs } = await h.launch({ home, env })
      ctx.app = r.closable(app)
      ctx.logs = logs
      await pickTestWindow(win)
      await win.waitForSelector('.window-hint')
      h.assert((await win.getAttribute('.window-hint', 'data-support')) === 'none', 'Home: no effects for windows here')
      h.assert(/no auto zoom, click highlights or smooth cursor/.test(await win.textContent('.window-hint')), 'the hint says so')
      const notices = await watchNotices(win)

      const tb = await r.startRecording(app, win)
      const g = geometry(xid)
      await r.xinput(`g ${g.x + 10} ${g.y + 10} ${g.x + 200} ${g.y + 150} 0.5; c ${g.x + 200} ${g.y + 150}; s 1`)
      await tb.click('button.stop')
      await win.waitForSelector('.editor canvas', { timeout: 120000 })

      const { project, cursor } = readRecording(home)
      h.assert(project.capture.method === 'chromium' && project.capture.cursorInVideo === true && project.capture.target === 'window', `capture ${JSON.stringify(project.capture)}`)
      h.assert(!cursor.valid && cursor.samples.length === 0 && cursor.clicks.length === 0, 'no cursor data, as before')
      h.assert(project.zooms.length === 0, 'no auto zooms')
      const told = await notices()
      h.assert(told.some((n) => /could not be followed on screen.*auto zoom, click highlights and the smooth cursor are unavailable/.test(n)), `the user was told: ${JSON.stringify(told)}`)
      await win.click('.insp-tabs button:has-text("Cursor")')
      h.assert(/not recorded for this window/.test(await win.textContent('[data-testid="cursor-not-recorded"]')), 'the editor explains why')
    })

    if (!COVER_SUPPORTED) console.log('SKIP window (d): the fake helper process does not report cursorOver')
    else await h.run('window (d): another window covering the recorded one: a click on it is ignored, the cursor hidden there', async (ctx) => {
      await resetWindow(xid)
      const home = h.tempHome('rec-window-cover')
      const { app, win, logs } = await h.launch({ home, env: REAL_HELPER ? helperEnv(true) : env })
      ctx.app = r.closable(app)
      ctx.logs = logs
      const fake = REAL_HELPER ? null : await installFakeHelper(app, { native: true, watch: true })
      await pickTestWindow(win)
      const g = geometry(xid)
      // A second window over the recorded one's lower right part (opened last, so on top). The
      // capture shows the recorded window's own pixels there, not this one.
      const cover = await startTestWindow({ title: COVER_TITLE, geometry: `40x10+${Math.round(g.x + 0.6 * g.width)}+${Math.round(g.y + 0.6 * g.height)}` })
      try {
        const c = geometry(cover.xid)
        const x0 = Math.max(g.x, c.x)
        const x1 = Math.min(g.x + g.width, c.x + c.width)
        const y0 = Math.max(g.y, c.y)
        const y1 = Math.min(g.y + g.height, c.y + c.height)
        h.assert(x1 - x0 > 20 && y1 - y0 > 20, `the windows overlap: ${JSON.stringify({ g, c })}`)
        // On the covering window, inside the recorded window's rectangle.
        const [sx, sy] = [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)]
        const spot = { x: (sx - g.x) / g.width, y: (sy - g.y) / g.height }
        const [ax, ay] = [Math.round(g.x + 0.25 * g.width), Math.round(g.y + 0.5 * g.height)]

        const tb = await r.startRecording(app, win)
        // In over the covering window from the bottom right, click on it; then over to the
        // recorded window's visible part, click there.
        await r.xinput(`m 1800 1000; s 0.3; g 1800 1000 ${sx} ${sy} 0.5; s 0.5; c ${sx} ${sy}; s 0.6; g ${sx} ${sy} ${ax} ${ay} 0.5; s 0.3; c ${ax} ${ay}; s 1.5`)
        await tb.click('button.stop')
        await win.waitForSelector('.editor canvas', { timeout: 120000 })

        const { project, cursor } = readRecording(home)
        h.assert(project.capture.method === 'native' && project.capture.target === 'window', `capture ${JSON.stringify(project.capture)}`)
        console.log(`  covering window's spot at (${spot.x.toFixed(3)}, ${spot.y.toFixed(3)}); clicks ${JSON.stringify(cursor.clicks)}`)
        h.assert(cursor.clicks.length === 1 && near(cursor.clicks[0], 0.25, 0.5), `only the click on the recorded window is kept: ${JSON.stringify(cursor.clicks)}`)
        const onSpot = cursor.samples.filter((s) => Math.abs(s.x - spot.x) < 0.03 && Math.abs(s.y - spot.y) < 0.03)
        h.assert(onSpot.length === 0, `no cursor drawn on the recorded window where the other one covers it: ${JSON.stringify(onSpot.slice(0, 3))}`)
        h.assert(cursor.samples.some((s) => near(s, 0.25, 0.5)), 'the cursor is shown over the recorded window')
        // Hidden there: from arriving on the covering window (about 2.06 s before the kept click)
        // until leaving it (0.85 s before), positions inside the window's rectangle are mapped
        // outside the video.
        const t = cursor.clicks[0].t
        const hidden = cursor.samples.filter((s) => s.t > t - 2.2 && s.t < t - 0.9)
        h.assert(hidden.length > 0 && hidden.every((s) => s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1), `hidden while over the covering window: ${JSON.stringify(hidden.slice(0, 4))}`)
        h.assert(project.zooms.filter((z) => z.auto).length === 1, `one auto zoom, for the kept click: ${JSON.stringify(project.zooms)}`)
        assertZoomsFrameClicks(project, cursor)
        if (fake) await assertNoLeftovers(fake)
        else await assertNoHelperRunning()
      } finally {
        cover.kill()
      }
    })
  } finally {
    term.kill()
    stopWm()
  }
})()
