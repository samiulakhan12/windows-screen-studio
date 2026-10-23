// Native capture client (src/main/nativeCapture.ts) inside the real Electron main process:
// display -> monitor matching with Electron's screen module, the helper protocol, pause/resume
// cutting, stop/kill and error reporting. The helper is the fake (tests/fixtures), recording the
// Xvfb screen with ffmpeg x11grab -draw_mouse 0; when wine is installed the real ssw-capture.exe
// (npm run build:native) is also driven through wine, where Windows.Graphics.Capture is absent,
// to check that the client and the real binary agree on arguments, JSON and errors.
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const h = require('./helpers.cjs')

const FAKE = path.join(h.APP_DIR, 'tests/fixtures/fake-capture-helper.cjs')
const EXE = path.join(h.APP_DIR, 'native/bin/ssw-capture.exe')

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

function helperProcesses() {
  const r = spawnSync('pgrep', ['-f', 'fake-capture-helper|ssw-capture.exe'], { encoding: 'utf8' })
  return (r.stdout || '').split('\n').filter(Boolean)
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
  const { app, win, logs } = await h.launch({ home, env })
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
    // The monitor list from the real exe matched Electron's display, so `record` ran and failed there.
    h.assert(/exited with code 3: Windows.Graphics.Capture is not available on this system/.test(r.start), `start: ${r.start}`)
  })
}
