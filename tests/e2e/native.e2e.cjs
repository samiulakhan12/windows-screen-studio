// Native capture client (src/main/nativeCapture.ts) inside the real Electron main process:
// display -> monitor matching with Electron's screen module, the helper protocol, pause/resume
// cutting, stop/kill and error reporting. The helper is the fake (tests/fixtures), recording the
// Xvfb screen with ffmpeg x11grab -draw_mouse 0. Single windows: openbox (started here when
// installed) and an xterm; the window source id comes from Electron's desktopCapturer, the window
// is moved and resized with XMoveWindow/XResizeWindow mid-recording, and its rectangle timeline,
// the fixed output size and the fit of the resized window are checked; watchWindow() follows it
// until it closes. A second xterm over part of the recorded one and real pointer motion (XTest)
// check cursorOver (the pointer over the recorded window, or over the one covering it). When wine
// is installed the real ssw-capture.exe (npm run build:native) is also driven through wine, where
// Windows.Graphics.Capture is absent, to check that the client and the real binary agree on
// arguments, JSON and errors (including record --window / watch-window).
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const h = require('./helpers.cjs')

const FAKE = path.join(h.APP_DIR, 'tests/fixtures/fake-capture-helper.cjs')
const EXE = path.join(h.APP_DIR, 'native/bin/ssw-capture.exe')
const XINPUT = path.join(__dirname, 'xinput.py')

/** Moves the pointer with XTest (a real motion event, as the user's mouse would). */
function pointer(x, y) {
  execFileSync('python3', ['-I', XINPUT, 'script', `m ${Math.round(x)} ${Math.round(y)}`])
}

/** nativeCapture.ts is only bundled once recordingIpc uses it; compile it on its own. */
function compileClient(dir) {
  const source = fs.readFileSync(path.join(h.APP_DIR, 'src/main/nativeCapture.ts'), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  const file = path.join(dir, 'nativeCapture.cjs')
  fs.writeFileSync(file, outputText)
  return file
}

function ffprobe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', file
  ]).toString()
  const j = JSON.parse(out)
  return { ...j.streams[0], duration: parseFloat(j.format.duration) }
}

// Every app (and so every helper) of this run carries this variable, so the leftover check
// ignores other processes that happen to mention the helper (another test run, a shell).
const RUN_MARK = `SSW_E2E_NATIVE_RUN=${process.pid}`

/** Helper processes of this run still running ("pid command line"). */
function helperProcesses() {
  const found = []
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      if (!/fake-capture-helper|ssw-capture\.exe/.test(cmd)) continue
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(RUN_MARK)) found.push(`${pid} ${cmd.slice(0, 160)}`)
    } catch {
      // Gone meanwhile, or not ours to read.
    }
  }
  return found
}

// X11 window operations for the window tests (python3 + libX11 through ctypes).
const XWIN = String.raw`
import ctypes, json, sys
from ctypes import POINTER, byref, c_char_p, c_int, c_uint, c_ulong, c_void_p
x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
x11.XOpenDisplay.argtypes = [c_char_p]
x11.XOpenDisplay.restype = c_void_p
x11.XDefaultRootWindow.argtypes = [c_void_p]
x11.XDefaultRootWindow.restype = c_ulong
x11.XMoveWindow.argtypes = [c_void_p, c_ulong, c_int, c_int]
x11.XResizeWindow.argtypes = [c_void_p, c_ulong, c_uint, c_uint]
x11.XSync.argtypes = [c_void_p, c_int]
x11.XTranslateCoordinates.argtypes = [c_void_p, c_ulong, c_ulong, c_int, c_int, POINTER(c_int), POINTER(c_int), POINTER(c_ulong)]
x11.XGetGeometry.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_int), POINTER(c_int), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint), POINTER(c_uint)]
d = x11.XOpenDisplay(None)
op, w = sys.argv[1], int(sys.argv[2])
if op == 'move':
    x11.XMoveWindow(d, w, int(sys.argv[3]), int(sys.argv[4]))
elif op == 'resize':
    x11.XResizeWindow(d, w, int(sys.argv[3]), int(sys.argv[4]))
elif op == 'geometry':
    root, x, y, child = c_ulong(), c_int(), c_int(), c_ulong()
    gx, gy, width, height, border, depth = c_int(), c_int(), c_uint(), c_uint(), c_uint(), c_uint()
    x11.XGetGeometry(d, w, byref(root), byref(gx), byref(gy), byref(width), byref(height), byref(border), byref(depth))
    x11.XTranslateCoordinates(d, w, x11.XDefaultRootWindow(d), 0, 0, byref(x), byref(y), byref(child))
    print(json.dumps({'x': x.value, 'y': y.value, 'width': width.value, 'height': height.value}))
x11.XSync(d, 0)
`

function xwin(...args) {
  return execFileSync('python3', ['-I', '-c', XWIN, ...args.map(String)]).toString()
}

const xgeometry = (xid) => JSON.parse(xwin('geometry', xid))

/** RGB of one pixel of the video frame at `at` seconds. */
function pixel(file, at, x, y) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [...raw.subarray(0, 3)]
}

const has = (cmd) => spawnSync('which', [cmd]).status === 0

/** Starts openbox on the test's display (desktopCapturer lists windows only with a window manager). */
function startWindowManager() {
  // Exits at once when a window manager already runs; harmless.
  const wm = spawn('openbox', [], { stdio: 'ignore' })
  wm.on('error', () => undefined)
  return wm
}

/** Starts an xterm titled `title` and resolves with it once it is mapped. */
async function startXterm(title, geometry) {
  const term = spawn('xterm', ['-T', title, '-geometry', geometry, '-e', 'sleep', '600'], { stdio: 'ignore' })
  term.on('error', () => undefined)
  await h.sleep(1500)
  return term
}

/** The desktopCapturer window source titled `title` (retries: the X11 capturer can be flaky under load). */
async function windowSource(app, title) {
  const end = Date.now() + 60000
  for (;;) {
    const found = await app.evaluate(async ({ desktopCapturer }, name) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
        const s = sources.find((x) => x.name === name)
        return s ? { id: s.id, name: s.name } : null
      } catch {
        return null
      }
    }, title)
    if (found) return found
    if (Date.now() > end) throw new Error(`desktopCapturer lists no window "${title}"`)
    await h.sleep(1000)
  }
}

/** Temporary folders to delete when the file is done. */
const scratch = []
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

async function setup(ctx, name, env) {
  const home = h.tempHome(name)
  scratch.push(home)
  const { app, win, logs } = await h.launch({ home, env: { ...env, SSW_E2E_NATIVE_RUN: String(process.pid) } })
  ctx.app = app
  ctx.logs = logs
  const client = compileClient(home)
  await app.evaluate((_e, file) => {
    globalThis.__nc = process.mainModule.require(file)
  }, client)
  return { app, win, home }
}

;(async () => {
  try {
    await main()
  } finally {
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
  }
})()

async function main() {
  await h.run('native: fake helper records the screen without the cursor, pause is cut out', async (ctx) => {
    const tmp = tempDir('ssw-native-')
    const log = path.join(tmp, 'helper.log')
    const { app, home } = await setup(ctx, 'native', {
      SSW_CAPTURE_HELPER: FAKE,
      FAKE_HELPER_VIDEO: 'x11grab',
      FAKE_HELPER_LOG: log
    })
    const env = await app.evaluate(async ({ screen }) => ({
      available: await globalThis.__nc.isNativeCaptureAvailable(),
      displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, nativeOrigin: d.nativeOrigin, scale: d.scaleFactor }))
    }))
    h.assert(env.available === true, 'helper probe reports native capture available')

    const out = path.join(home, 'native.mp4')
    const info = await app.evaluate(async ({ screen }, file) => {
      const s = globalThis.__nc.startNativeCapture({ displayId: String(screen.getPrimaryDisplay().id), output: file, fps: 30 })
      globalThis.__session = s
      return s.started
    }, out)
    h.assert(info.width === 1920 && info.height === 1080, `started ${JSON.stringify(info)}`)
    h.assert(Math.abs(info.startedAt - Date.now()) < 5000, `startedAt ${info.startedAt}`)

    await h.sleep(1500)
    const pauseAt = await app.evaluate(() => {
      const at = Date.now()
      globalThis.__session.pause(at)
      return at
    })
    await h.sleep(1500)
    const resumeAt = await app.evaluate(() => {
      const at = Date.now()
      globalThis.__session.resume(at)
      return at
    })
    await h.sleep(1500)
    const { stopAt, result } = await app.evaluate(async () => {
      const at = Date.now()
      return { stopAt: at, result: await globalThis.__session.stop(at) }
    })
    h.assert(result.frames > 0, `frames ${result.frames}`)
    h.assert(result.shapes.map((s) => s.shape).join() === 'arrow,text,pointer', `shapes ${JSON.stringify(result.shapes)}`)

    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const record = lines.find((l) => l.argv && l.argv[0] === 'record')
    h.assert(record && record.argv[2] === '\\\\.\\DISPLAY1' && record.argv[6] === '30', `record argv ${JSON.stringify(record)}`)
    const commands = lines.filter((l) => l.stdin && l.stdin !== '<eof>').map((l) => l.stdin.split(' ')[0])
    h.assert(commands.join() === 'pause,resume,stop', `commands ${commands}`)

    const probe = ffprobe(out)
    h.assert(probe.codec_name === 'h264' && probe.width === 1920 && probe.height === 1080, `video ${JSON.stringify(probe)}`)
    // The paused span is cut out; the fake loses a little more to ffmpeg start-up after resuming.
    const active = (pauseAt - info.startedAt + (stopAt - resumeAt)) / 1000
    h.assert(result.duration <= active + 0.05 && result.duration > active - 1, `reported duration ${result.duration} vs active ${active}`)
    h.assert(result.duration < (stopAt - info.startedAt) / 1000 - 1.2, `duration ${result.duration} excludes the 1.5 s pause`)
    h.assert(Math.abs(probe.duration - result.duration) < 0.15, `file duration ${probe.duration} vs reported ${result.duration}`)
    const frame = path.join(tmp, 'frame.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', out, '-frames:v', '1', frame])
    // Set SSW_E2E_KEEP to a folder to look at a frame of the recording.
    if (process.env.SSW_E2E_KEEP) fs.copyFileSync(frame, path.join(process.env.SSW_E2E_KEEP, 'native-frame.png'))
    console.log(`native: ${probe.nb_read_frames} frames, ${probe.duration.toFixed(2)} s`)
  })

  await h.run('native: failures reject cleanly and kill() leaves no helper process', async (ctx) => {
    const tmp = tempDir('ssw-native-fail-')
    const { app } = await setup(ctx, 'native-fail', { SSW_CAPTURE_HELPER: FAKE, FAKE_HELPER_LOG: path.join(tmp, 'helper.log') })
    const out = path.join(tmp, 'x.mp4')

    const crash = await app.evaluate(async ({ screen }, file) => {
      process.env.FAKE_HELPER_RECORD = 'crash'
      const s = globalThis.__nc.startNativeCapture({ displayId: String(screen.getPrimaryDisplay().id), output: file, fps: 60 })
      return s.started.then(
        () => 'started',
        (e) => e.message
      )
    }, out)
    h.assert(/exited with code 1: .*fake crash/.test(crash), `crash message: ${crash}`)

    const unmatched = await app.evaluate(async (_e, file) => {
      process.env.FAKE_HELPER_RECORD = 'ok'
      const s = globalThis.__nc.startNativeCapture({ displayId: 'no-such-display', output: file, fps: 60 })
      return s.started.then(
        () => 'started',
        (e) => e.message
      )
    }, out)
    h.assert(/No capture monitor matches display no-such-display/.test(unmatched), `unmatched message: ${unmatched}`)

    const killed = await app.evaluate(async ({ screen }, file) => {
      const s = globalThis.__nc.startNativeCapture({ displayId: String(screen.getPrimaryDisplay().id), output: file, fps: 60 })
      await s.started
      s.kill()
      return s.stop().then(
        () => 'stopped',
        (e) => e.message
      )
    }, out)
    h.assert(/was stopped/.test(killed), `kill message: ${killed}`)
    await h.sleep(300)
    h.assert(helperProcesses().length === 0, `no helper left running: ${helperProcesses()}`)
  })

  await h.run('native: a helper that ends on its own is reported through onEnded, with a readable fragmented MP4', async (ctx) => {
    const tmp = tempDir('ssw-native-ended-')
    const { app } = await setup(ctx, 'native-ended', { SSW_CAPTURE_HELPER: FAKE, FAKE_HELPER_VIDEO: 'testsrc', FAKE_HELPER_LOG: path.join(tmp, 'helper.log') })
    const run = (mode, file) =>
      app.evaluate(
        async ({ screen }, { mode, file }) => {
          process.env.FAKE_HELPER_RECORD = mode
          process.env.FAKE_HELPER_END_AFTER_MS = '2500'
          const s = globalThis.__nc.startNativeCapture({ displayId: String(screen.getPrimaryDisplay().id), output: file, fps: 30 })
          const ended = new Promise((resolve) => s.onEnded((info) => resolve({ reason: info.reason, error: info.error && info.error.message })))
          const info = await s.started
          const t0 = Date.now()
          const end = await Promise.race([ended, new Promise((r) => setTimeout(() => r('no onEnded within 20 s'), 20000))])
          const stop = await s.stop().then(
            (r) => ({ ok: true, duration: r.duration }),
            (e) => ({ ok: false, message: e.message })
          )
          return { started: info.startedAt, after: Date.now() - t0, end, stop }
        },
        { mode, file }
      )

    // Monitor unplugged: the helper finalises the MP4 and says "closed".
    const closedFile = path.join(tmp, 'closed.mp4')
    const closed = await run('close-early', closedFile)
    h.assert(closed.end && closed.end.reason === 'closed' && !closed.end.error, `closed: ${JSON.stringify(closed)}`)
    h.assert(closed.stop.ok && closed.stop.duration > 2, `stop after close: ${JSON.stringify(closed.stop)}`)
    const probe = ffprobe(closedFile)
    h.assert(probe.codec_name === 'h264' && Math.abs(probe.duration - closed.stop.duration) < 0.2, `closed video ${JSON.stringify(probe)}`)
    h.assert(fs.readFileSync(closedFile).includes('moof'), 'the video is a fragmented MP4')

    // Killed or crashed: no event, no finalising; complete fragments are still readable.
    const crashedFile = path.join(tmp, 'crashed.mp4')
    const crashed = await run('crash-early', crashedFile)
    h.assert(crashed.end && crashed.end.reason === 'crashed' && /terminated/.test(crashed.end.error), `crashed: ${JSON.stringify(crashed)}`)
    h.assert(!crashed.stop.ok, `stop after a crash rejects: ${JSON.stringify(crashed.stop)}`)
    const left = ffprobe(crashedFile)
    // 2.5 s recorded; at least the first full 1 s fragments survive.
    h.assert(left.codec_name === 'h264' && Number(left.nb_read_frames) >= 30, `crashed video ${JSON.stringify(left)}`)
    console.log(`native: closed after ${closed.after} ms (${probe.duration.toFixed(2)} s), crashed left ${left.nb_read_frames} frames`)
    await h.sleep(300)
    h.assert(helperProcesses().length === 0, `no helper left running: ${helperProcesses()}`)
  })

  await h.run('native: quitting the app finalises a running recording instead of killing it', async (ctx) => {
    const tmp = tempDir('ssw-native-quit-')
    const log = path.join(tmp, 'helper.log')
    const { app } = await setup(ctx, 'native-quit', { SSW_CAPTURE_HELPER: FAKE, FAKE_HELPER_VIDEO: 'testsrc', FAKE_HELPER_LOG: log })
    const out = path.join(tmp, 'quit.mp4')
    await app.evaluate(async ({ screen }, file) => {
      const s = globalThis.__nc.startNativeCapture({ displayId: String(screen.getPrimaryDisplay().id), output: file, fps: 30 })
      await s.started
    }, out)
    await h.sleep(2000)
    // Kept before quitting: once the app has exited Playwright disposes it, and app.process() throws.
    const proc = app.process()
    const exited = new Promise((resolve) => proc.once('exit', resolve))
    const t0 = Date.now()
    await app.evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    await Promise.race([exited, h.sleep(20000)])
    h.assert(proc.exitCode !== null || proc.signalCode !== null, 'the app quit')
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const commands = lines.filter((l) => l.stdin && l.stdin !== '<eof>').map((l) => l.stdin.split(' ')[0])
    h.assert(commands.join() === 'stop', `the helper was asked to stop: ${commands}`)
    // The fake writes the final file only when it finishes; a killed one leaves none.
    const probe = ffprobe(out)
    h.assert(probe.codec_name === 'h264' && probe.duration > 1.5, `finalised video ${JSON.stringify(probe)}`)
    console.log(`native: quit took ${Date.now() - t0} ms, ${probe.duration.toFixed(2)} s finalised`)
    h.assert(helperProcesses().length === 0, `no helper left running: ${helperProcesses()}`)
  })

  await windowTests()

  const wine = spawnSync('wine', ['--version'], { encoding: 'utf8' })
  if (wine.status !== 0 || !fs.existsSync(EXE)) {
    console.log('SKIP native: real ssw-capture.exe under wine (wine or native/bin/ssw-capture.exe missing)')
    return
  }
  await h.run('native: real ssw-capture.exe under wine reports unsupported capture through the client', async (ctx) => {
    const tmp = tempDir('ssw-native-wine-')
    const wrapper = path.join(tmp, 'wine-helper.cjs')
    fs.writeFileSync(
      wrapper,
      `const { spawn } = require('node:child_process')
const p = spawn('wine', [${JSON.stringify(EXE)}, ...process.argv.slice(2)], { stdio: 'inherit' })
p.on('exit', (code) => process.exit(code ?? 1))
`
    )
    const { app } = await setup(ctx, 'native-wine', {
      SSW_CAPTURE_HELPER: wrapper,
      WINEDEBUG: '-all',
      WINEPREFIX: process.env.WINEPREFIX || path.join(os.tmpdir(), 'ssw-e2e-wineprefix')
    })
    const r = await app.evaluate(async ({ screen }, file) => {
      const nc = globalThis.__nc
      // A fresh wine prefix takes a while to initialise.
      Object.assign(nc.nativeCaptureTimeouts, { probe: 120000, list: 120000, start: 120000 })
      const probe = await nc.probeNativeCapture()
      const s = nc.startNativeCapture({ displayId: String(screen.getPrimaryDisplay().id), output: file, fps: 60 })
      const start = await s.started.then(
        () => 'started',
        (e) => e.message
      )
      return { probe, start }
    }, path.join(tmp, 'wine.mp4'))
    console.log(`native (wine): probe ${JSON.stringify(r.probe)}; start: ${r.start}`)
    h.assert(r.probe.supported === false && /Windows.Graphics.Capture/.test(r.probe.reason), `probe ${JSON.stringify(r.probe)}`)
    h.assert(r.probe.windowCapture === false, `probe reports no window capture: ${JSON.stringify(r.probe)}`)
    // The monitor list from the real exe matched Electron's display, so `record` ran and failed there.
    h.assert(/exited with code 3: Windows.Graphics.Capture is not available on this system/.test(r.start), `start: ${r.start}`)

    // Windows: a handle that is no window is "not found" (exit 4) with a JSON error, for both modes.
    const w = await app.evaluate(async (_e, file) => {
      const nc = globalThis.__nc
      Object.assign(nc.nativeCaptureTimeouts, { watchReady: 120000 })
      const isAvailable = await nc.isNativeWindowCaptureAvailable()
      const watch = nc.watchWindow('window:12345:0')
      const watched = await watch.ready.then(
        () => 'ready',
        (e) => e.message
      )
      const left = await watch.stop()
      const s = nc.startNativeCapture({ windowId: 'window:12345:0', output: file, fps: 30 })
      const recorded = await s.started.then(
        () => 'started',
        (e) => e.message
      )
      // Wine's desktop window (0x10020) is a real window: watch-window reports it; record --window
      // gets past the window lookup and fails for want of Windows.Graphics.Capture.
      const desktop = nc.watchWindow('window:65568:0')
      const desktopReady = await desktop.ready.then(
        (rect) => rect,
        (e) => e.message
      )
      const desktopRects = await desktop.stop()
      const d = nc.startNativeCapture({ windowId: 'window:65568:0', output: file, fps: 30 })
      const desktopRecord = await d.started.then(
        () => 'started',
        (e) => e.message
      )
      return { isAvailable, watched, left, recorded, desktopReady, desktopRects, desktopRecord }
    }, path.join(tmp, 'wine-window.mp4'))
    console.log(`native (wine): window ${JSON.stringify(w)}`)
    h.assert(w.isAvailable === false, 'no native window capture under wine')
    h.assert(/exited with code 4.*Window 12345 not found/.test(w.watched) && w.left.length === 0, `watch-window of a missing window: ${w.watched}`)
    h.assert(/exited with code 4: Window 12345 not found/.test(w.recorded), `record --window of a missing window: ${w.recorded}`)
    if (typeof w.desktopReady === 'object') {
      h.assert(w.desktopReady.width > 0 && w.desktopReady.height > 0 && w.desktopReady.minimized === false, `desktop rect ${JSON.stringify(w.desktopReady)}`)
      // The real binary always reports cursorOver (WindowFromPoint + GA_ROOTOWNER), and the client keeps it.
      h.assert(typeof w.desktopReady.cursorOver === 'boolean', `desktop rect has cursorOver: ${JSON.stringify(w.desktopReady)}`)
      h.assert(w.desktopRects.length >= 1 && w.desktopRects[0].width === w.desktopReady.width, `desktop rects ${JSON.stringify(w.desktopRects)}`)
      h.assert(/exited with code 3: Windows.Graphics.Capture is not available/.test(w.desktopRecord), `record --window of the desktop: ${w.desktopRecord}`)
    } else {
      console.log(`SKIP native (wine): wine's desktop window is not 0x10020 here (${w.desktopReady})`)
    }
    h.assert(helperProcesses().length === 0, `no helper left running: ${helperProcesses()}`)
  })
}

async function windowTests() {
  if (!process.env.DISPLAY || !has('openbox') || !has('xterm') || !has('python3')) {
    console.log('SKIP native: window capture (needs an X display, openbox, xterm and python3)')
    return
  }
  const wm = startWindowManager()
  const terms = []
  // Park the pointer on the bare root window, so cursorOver changes only where a test moves it.
  pointer(1880, 1060)
  try {
    await h.run('native: recording a single window follows it as it moves and fits it when resized', async (ctx) => {
      const tmp = tempDir('ssw-native-window-')
      const log = path.join(tmp, 'helper.log')
      const title = `SSW-E2E-WINDOW-${process.pid}`
      terms.push(await startXterm(title, '80x24+200+150'))
      const { app } = await setup(ctx, 'native-window', { SSW_CAPTURE_HELPER: FAKE, FAKE_HELPER_VIDEO: 'x11grab', FAKE_HELPER_LOG: log })
      // Without a compositor the screen grab shows whatever is on top: keep the app's own windows away.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()))
      const source = await windowSource(app, title)
      const xid = Number(source.id.split(':')[1])
      const initial = xgeometry(xid)

      const out = path.join(tmp, 'window.mp4')
      const info = await app.evaluate(async (_e, { windowId, file }) => {
        const nc = globalThis.__nc
        if (!(await nc.isNativeWindowCaptureAvailable())) throw new Error('native window capture is not available')
        const s = nc.startNativeCapture({ windowId, output: file, fps: 30 })
        globalThis.__session = s
        return s.started
      }, { windowId: source.id, file: out })
      h.assert(info.width === (initial.width & ~1) && info.height === (initial.height & ~1), `started ${JSON.stringify(info)} for ${JSON.stringify(initial)}`)

      await h.sleep(1200)
      xwin('move', xid, initial.x + 300, initial.y + 150)
      await h.sleep(1200)
      const moved = xgeometry(xid)
      xwin('resize', xid, initial.width * 2, initial.height)
      // The fake starts a new ffmpeg segment for the new size; give it time to take over.
      await h.sleep(2500)
      const resized = xgeometry(xid)
      const { stopAt, result } = await app.evaluate(async () => {
        const at = Date.now()
        return { stopAt: at, result: await globalThis.__session.stop(at) }
      })

      const rects = result.windowRects
      console.log(`native: window ${source.id} rects ${JSON.stringify(rects.map((r) => [r.x, r.y, r.width, r.height]))}`)
      const same = (r, g) => r.x === g.x && r.y === g.y && r.width === g.width && r.height === g.height && !r.minimized
      h.assert(same(rects[0], initial), `first rect ${JSON.stringify(rects[0])} is where the window was ${JSON.stringify(initial)}`)
      h.assert(moved.x > initial.x + 250 && rects.some((r) => same(r, moved)), `a rect for the moved window ${JSON.stringify(moved)}`)
      h.assert(resized.width > initial.width * 1.5 && same(rects[rects.length - 1], resized), `the last rect is the resized window ${JSON.stringify(resized)}`)
      h.assert(rects.every((r, i) => i === 0 || r.at >= rects[i - 1].at), 'rects in time order')
      h.assert(rects[0].at >= info.startedAt - 50 && rects[rects.length - 1].at <= stopAt, 'rects within the recording')
      h.assert(rects.length <= 8, `only changes are reported (${rects.length} rects)`)

      const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const record = lines.find((l) => l.argv && l.argv[0] === 'record')
      h.assert(record.argv[1] === '--window' && record.argv[2] === String(xid), `record argv ${JSON.stringify(record.argv)}`)

      // The video keeps the initial size; the twice-as-wide window is fitted inside, centred,
      // with black bars above and below (xterm's background is white).
      const probe = ffprobe(out)
      h.assert(probe.width === info.width && probe.height === info.height, `video ${JSON.stringify(probe)}`)
      h.assert(Math.abs(probe.duration - result.duration) < 0.2, `file duration ${probe.duration} vs reported ${result.duration}`)
      const end = probe.duration - 0.3
      const bar = pixel(out, end, Math.round(info.width / 2), 3)
      const content = pixel(out, end, Math.round(info.width / 2), Math.round(info.height / 2))
      const before = pixel(out, 0.5, Math.round(info.width / 2), 3)
      h.assert(bar.every((c) => c < 40), `letterbox bar after the resize: ${bar}`)
      h.assert(content.every((c) => c > 200), `window content in the middle: ${content}`)
      h.assert(before.every((c) => c > 200), `no bar before the resize: ${before}`)
      if (process.env.SSW_E2E_KEEP) fs.copyFileSync(out, path.join(process.env.SSW_E2E_KEEP, 'native-window.mp4'))
    })

    await h.run('native: cursorOver says whether the pointer is over the recorded window or a window covering it', async (ctx) => {
      const tmp = tempDir('ssw-native-over-')
      const title = `SSW-E2E-OVER-${process.pid}`
      const coverTitle = `SSW-E2E-COVER-${process.pid}`
      terms.push(await startXterm(title, '80x24+100+100'))
      const { app } = await setup(ctx, 'native-over', { SSW_CAPTURE_HELPER: FAKE, FAKE_HELPER_LOG: path.join(tmp, 'helper.log') })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()))
      const source = await windowSource(app, title)
      const g = xgeometry(Number(source.id.split(':')[1]))
      // A second window over the recorded one's lower-right part; mapped later, so stacked above it.
      terms.push(await startXterm(coverTitle, `30x8+${g.x + Math.round(g.width / 2)}+${g.y + Math.round(g.height / 2)}`))
      const cover = xgeometry(Number((await windowSource(app, coverTitle)).id.split(':')[1]))
      const overlap = {
        x0: Math.max(g.x, cover.x),
        y0: Math.max(g.y, cover.y),
        x1: Math.min(g.x + g.width, cover.x + cover.width),
        y1: Math.min(g.y + g.height, cover.y + cover.height)
      }
      h.assert(overlap.x1 - overlap.x0 > 40 && overlap.y1 - overlap.y0 > 40, `the second window covers part of the first: ${JSON.stringify({ g, cover })}`)
      const onRecorded = { x: g.x + 40, y: g.y + 40 }
      const onCover = { x: (overlap.x0 + overlap.x1) / 2, y: (overlap.y0 + overlap.y1) / 2 }
      const away = { x: 1880, y: 1060 } // the bare root window
      h.assert(away.x > cover.x + cover.width && away.x > g.x + g.width, 'the far corner is on no window')

      pointer(onRecorded.x, onRecorded.y)
      await app.evaluate(async (_e, { windowId, file }) => {
        const s = globalThis.__nc.startNativeCapture({ windowId, output: file, fps: 30 })
        globalThis.__session = s
        await s.started
      }, { windowId: source.id, file: path.join(tmp, 'over.mp4') })
      const steps = [onCover, onRecorded, away]
      for (const p of steps) {
        await h.sleep(500)
        pointer(p.x, p.y)
      }
      await h.sleep(500)
      const rects = (await app.evaluate(() => globalThis.__session.stop())).windowRects
      console.log(`native: cursorOver ${JSON.stringify(rects.map((r) => [r.x, r.y, r.width, r.height, r.cursorOver]))}`)
      h.assert(rects.every((r) => typeof r.cursorOver === 'boolean'), 'every window event says whether the cursor is over the window')
      // Only cursorOver changed: one event per change, the rectangle the same throughout.
      h.assert(JSON.stringify(rects.map((r) => r.cursorOver)) === '[true,false,true,false]', `cursorOver over time: ${rects.map((r) => r.cursorOver)}`)
      h.assert(rects.every((r) => r.x === g.x && r.y === g.y && r.width === g.width && r.height === g.height && !r.minimized), 'the rectangle did not change')
      h.assert(rects.every((r, i) => i === 0 || r.at > rects[i - 1].at), 'in time order')

      // watch-window reports it the same way.
      const watched = await app.evaluate(async (_e, windowId) => {
        const w = globalThis.__nc.watchWindow(windowId)
        globalThis.__watch = w
        return w.ready
      }, source.id)
      h.assert(watched.cursorOver === false, `watch-window: the pointer is away: ${JSON.stringify(watched)}`)
      pointer(onRecorded.x, onRecorded.y)
      await h.sleep(500)
      pointer(onCover.x, onCover.y)
      await h.sleep(500)
      const watchedRects = await app.evaluate(() => globalThis.__watch.stop())
      h.assert(JSON.stringify(watchedRects.map((r) => r.cursorOver)) === '[false,true,false]', `watch-window cursorOver: ${watchedRects.map((r) => r.cursorOver)}`)
      await h.sleep(300)
      h.assert(helperProcesses().length === 0, `no helper left running: ${helperProcesses()}`)
    })

    await h.run('native: watchWindow follows a window until it closes; a recorded window closing ends the recording', async (ctx) => {
      const tmp = tempDir('ssw-native-watch-')
      const title = `SSW-E2E-WATCH-${process.pid}`
      const term = await startXterm(title, '60x20+100+100')
      terms.push(term)
      const { app } = await setup(ctx, 'native-watch', { SSW_CAPTURE_HELPER: FAKE, FAKE_HELPER_LOG: path.join(tmp, 'helper.log') })
      const source = await windowSource(app, title)
      const xid = Number(source.id.split(':')[1])
      const initial = xgeometry(xid)
      const first = await app.evaluate(async (_e, windowId) => {
        globalThis.__watch = globalThis.__nc.watchWindow(windowId)
        return globalThis.__watch.ready
      }, source.id)
      h.assert(first.x === initial.x && first.y === initial.y && first.width === initial.width, `ready ${JSON.stringify(first)} vs ${JSON.stringify(initial)}`)
      xwin('move', xid, initial.x + 200, initial.y + 50)
      await h.sleep(800)
      const moved = xgeometry(xid)
      const watched = await app.evaluate(() => globalThis.__watch.stop())
      h.assert(watched.length >= 2 && watched[watched.length - 1].x === moved.x && watched[watched.length - 1].y === moved.y, `watched ${JSON.stringify(watched)}`)

      // Recording it, then closing it: the helper finalises and says "closed" (onEnded).
      const ended = app.evaluate(async (_e, { windowId, file }) => {
        const nc = globalThis.__nc
        const s = nc.startNativeCapture({ windowId, output: file, fps: 30 })
        const end = new Promise((resolve) => s.onEnded((e) => resolve(e.reason)))
        const w = nc.watchWindow(windowId)
        await Promise.all([s.started, w.ready])
        globalThis.__recording = { s, w, end }
        return true
      }, { windowId: source.id, file: path.join(tmp, 'closed.mp4') })
      await ended
      await h.sleep(500)
      term.kill('SIGKILL')
      const r = await app.evaluate(async () => {
        const { s, w, end } = globalThis.__recording
        const reason = await Promise.race([end, new Promise((r) => setTimeout(() => r('no onEnded within 10 s'), 10000))])
        const result = await s.stop()
        const rects = await w.stop()
        return { reason, rects: result.windowRects, watched: rects }
      })
      h.assert(r.reason === 'closed', `onEnded: ${r.reason}`)
      h.assert(r.rects.length >= 1 && r.watched.length >= 1, `rects kept: ${JSON.stringify(r)}`)
      h.assert(fs.readFileSync(path.join(tmp, 'closed.mp4'), 'utf8') === 'fake video', 'the recording was finalised')
      await h.sleep(300)
      h.assert(helperProcesses().length === 0, `no helper left running: ${helperProcesses()}`)
    })
  } finally {
    for (const t of terms) t.kill('SIGKILL')
    wm.kill()
  }
}
