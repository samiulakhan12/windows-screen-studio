// Recording options chosen on Home, in the real built app: the live camera preview (fake camera)
// and its release when recording starts; 30 fps recordings; auto-pause after idle and resume on
// real input (XTest); custom hotkeys (XTest key combos) with conflict and "used by another app"
// checks, "zoom here" marks and typing bursts (never which keys); options saved across restarts.
// Desktop icons: the real ssw-capture.exe under wine against a stand-in for Explorer's desktop
// windows (native/examples/fake_desktop.rs), through the app's client and restore logic.
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

const OUT = process.env.SSW_E2E_SHOTS || null

/** userData/app-settings.json of a test HOME (Linux: ~/.config/<app name>). */
function settingsFile(home) {
  const config = path.join(home, '.config')
  for (const d of fs.existsSync(config) ? fs.readdirSync(config) : []) {
    const f = path.join(config, d, 'app-settings.json')
    if (fs.existsSync(f)) return f
  }
  return null
}

const readCursor = (home, id) => JSON.parse(fs.readFileSync(path.join(h.projectsRoot(home), id, 'cursor.json'), 'utf8'))

/** Video frame count and rate of a file. */
function frames(file) {
  const j = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_read_frames', '-of', 'json', file]).toString()
  )
  return { rate: j.streams[0].r_frame_rate, count: Number(j.streams[0].nb_read_frames) }
}

/** Holds a key grab like another app owning a hotkey (see xgrabkey.py); resolves once it holds it. */
async function grabKey(combo) {
  const p = spawn('python3', ['-I', path.join(__dirname, 'xgrabkey.py'), combo], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    p.on('error', reject)
    p.stdout.once('data', resolve)
  })
  return p
}

/** Opens the recording options on Home (once). */
async function openOptions(win) {
  if (!(await win.$('.rec-options.open'))) await win.click('.rec-options-head')
  await win.waitForSelector('.rec-options-body')
}

/** Sets a hotkey through the Home field the way a user does: click, then press the keys. */
async function pressHotkey(win, action, keys) {
  await win.click(`.hotkey[data-action="${action}"] .hotkey-field`)
  await win.waitForSelector(`.hotkey[data-action="${action}"] .hotkey-field.capturing`)
  await win.keyboard.press(keys)
  await r.until(async () => !(await win.$(`.hotkey[data-action="${action}"] .hotkey-field.capturing`)) && !(await win.$(`.hotkey[data-action="${action}"] .hotkey-field:disabled`)), {
    what: `${action} hotkey saved`
  })
}

const fieldText = (win, action) => win.textContent(`.hotkey[data-action="${action}"] .hotkey-field`)
const errorText = (win, action) => win.$eval(`.hotkey[data-action="${action}"]`, (el) => el.querySelector('.hotkey-error')?.textContent ?? '')

const typeWord = (word) => word.split('').map((c) => `k ${c}`).join('; ')

async function main() {
  await h.run('camera preview on Home: live, mirrored frames; released when recording starts; 30 fps recording', async (ctx) => {
    const home = h.tempHome('opt-camera')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    h.assert(!(await win.$('.camera-preview')), 'no preview (and no camera opened) without a camera selected')
    const selects = await win.$$('.record-panel select')
    await selects[1].selectOption({ index: 1 })
    await win.waitForSelector('.camera-preview.live', { timeout: 15000 })

    // Real frames arrive: count decoded frames for a second and look at the picture.
    const live = await win.evaluate(async () => {
      const v = document.querySelector('.camera-preview video')
      let count = 0
      const tick = () => {
        count++
        v.requestVideoFrameCallback(tick)
      }
      v.requestVideoFrameCallback(tick)
      await new Promise((r) => setTimeout(r, 1000))
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 36
      const g = c.getContext('2d')
      g.drawImage(v, 0, 0, 64, 36)
      const px = g.getImageData(0, 0, 64, 36).data
      let green = 0
      for (let i = 0; i < px.length; i += 4) if (px[i + 1] > 100 && px[i + 1] > px[i] + 40) green++
      window.__preview = v.srcObject
      return {
        count,
        width: v.videoWidth,
        height: v.videoHeight,
        green: green / (64 * 36),
        transform: getComputedStyle(v).transform,
        settings: v.srcObject.getVideoTracks()[0].getSettings()
      }
    })
    console.log(`camera preview: ${JSON.stringify(live)}`)
    h.assert(live.count >= 10, `preview shows live frames (${live.count} in 1 s)`)
    h.assert(live.width > 0 && live.width <= 640, `small preview stream (${live.width}x${live.height})`)
    h.assert(live.green > 0.5, `the fake camera's green picture is shown (${live.green})`)
    h.assert(/^matrix\(-1, 0, 0, 1/.test(live.transform), `mirrored (${live.transform})`)
    if (OUT) await win.screenshot({ path: path.join(OUT, 'home-camera.png') })

    // 30 fps, chosen on Home.
    await openOptions(win)
    await win.click('.fps-picker .chip:has-text("30 fps")')
    await win.waitForSelector('.fps-picker .chip.active:has-text("30 fps")')

    const tb = await r.startRecording(app, win)
    const recDir = r.activeDir(home)
    const released = await win.evaluate(() => ({
      gone: !document.querySelector('.camera-preview'),
      ended: window.__preview.getVideoTracks().every((t) => t.readyState === 'ended')
    }))
    h.assert(released.gone && released.ended, `preview released when recording starts: ${JSON.stringify(released)}`)
    await r.xinput('g 300 300 1500 800 2.5; s 1')
    const clicked = Date.now()
    await tb.click('button.stop')
    // Written once every recorder has stopped, with the recording's own start (its first frame,
    // on this machine's clock). The toolbar shows its stop button up to half a second after that
    // start, more under load, so time measured from the button is no measure of the recording.
    const stopped = await r.until(
      () => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(recDir, 'recording.json'), 'utf8'))
          return m.status === 'processing' ? { startedAt: m.startedAt, at: Date.now() } : null
        } catch {
          return null // mid-write
        }
      },
      { interval: 10, what: 'the stopped recording' }
    )
    await win.waitForSelector('.editor canvas', { timeout: 120000 })

    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    const pdir = path.join(h.projectsRoot(home), id)
    h.assert(project.hasWebcam, 'the camera was free for the recording')
    h.assert(project.capture.fps === 30, `project records 30 fps (${project.capture.fps})`)
    const screen = frames(path.join(pdir, 'screen.mp4'))
    // The recording ran from its start at least until the stop click began, and at most until its
    // stopped manifest was seen; the constant-rate video can differ from that by one frame.
    const atLeast = (clicked - stopped.startedAt) / 1000 - 1 / 30
    const atMost = (stopped.at - stopped.startedAt) / 1000 + 1 / 30
    console.log(`30 fps: proxy ${JSON.stringify(screen)}, duration ${project.duration.toFixed(3)} s (recorded ${atLeast.toFixed(3)}-${atMost.toFixed(3)} s)`)
    h.assert(screen.rate === '30/1', `screen proxy at 30 fps (${screen.rate})`)
    h.assert(Math.abs(screen.count / 30 - project.duration) < 0.05, `duration ${project.duration} matches ${screen.count} frames at 30 fps`)
    h.assert(project.duration >= atLeast && project.duration <= atMost, `duration ${project.duration} is the time recorded (${atLeast.toFixed(3)}-${atMost.toFixed(3)} s)`)
    const cursor = readCursor(home, id)
    h.assert(cursor.samples.length > 20, 'cursor recorded')

    // Saved in the app settings, and shown again on the next start.
    const file = settingsFile(home)
    h.assert(file && JSON.parse(fs.readFileSync(file, 'utf8')).recording.fps === 30, `fps saved in ${file}`)
    await app.close()
    const again = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(again.app)
    ctx.logs = again.logs
    // Home shows the saved frame rate again.
    await again.win.waitForSelector('.fps-picker .chip.active:has-text("30 fps")', { timeout: 15000 })
    // The preview comes back for the remembered camera.
    await again.win.waitForSelector('.camera-preview.live', { timeout: 15000 })
  })

  await h.run('auto-pause: pauses after the idle time, resumes on the next real input', async (ctx) => {
    const home = h.tempHome('opt-idle')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await openOptions(win)
    await win.click('.rec-options .toggle:has-text("Auto-pause") input')
    // The shortest idle time (3 s), with the keyboard on the slider.
    await win.focus('input[aria-label="Seconds without input before pausing"]')
    await win.keyboard.press('Home')
    await r.until(async () => (await win.textContent('.idle-slider .slider-head')).includes('3 s without input'), { what: 'idle time 3 s' })
    await r.until(() => {
      const f = settingsFile(home)
      const s = f && JSON.parse(fs.readFileSync(f, 'utf8')).recording
      return s && s.autoPause === true && s.idleSeconds === 3
    }, { what: 'auto-pause saved' })

    const tb = await r.startRecording(app, win)
    const t0 = Date.now()
    await r.xinput('g 200 200 900 600 1.0')
    const lastInput = Date.now()
    await tb.waitForSelector('.tb-state.idle', { timeout: 10000 })
    const tIdle = Date.now()
    h.assert((await tb.textContent('.tb-state')) === 'Paused (idle)', 'toolbar says Paused (idle)')
    h.assert(await tb.$('.rec-dot.paused'), 'the dot shows paused')
    const idleAfter = (tIdle - lastInput) / 1000
    h.assert(idleAfter > 2.8 && idleAfter < 4.5, `paused ${idleAfter.toFixed(2)} s after the last input`)
    if (OUT) await tb.screenshot({ path: path.join(OUT, 'toolbar-idle.png') })
    await h.sleep(3000)
    h.assert(await tb.$('.tb-state.idle'), 'stays paused without input')

    await r.xinput('m 700 500; s 0.05; m 720 510')
    await tb.waitForSelector('.rec-dot:not(.paused)', { timeout: 5000 })
    const tResume = Date.now()
    h.assert(!(await tb.$('.tb-state')), 'recording again')
    await r.xinput('g 720 510 1200 700 1.5')
    await tb.click('button.stop')
    const tStop = Date.now()
    await win.waitForSelector('.editor canvas', { timeout: 120000 })

    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    const expected = (tIdle - t0 + (tStop - tResume)) / 1000
    console.log(`auto-pause: duration ${project.duration.toFixed(2)} s, expected ≈ ${expected.toFixed(2)} s (wall ${((tStop - t0) / 1000).toFixed(2)} s)`)
    h.assert(Math.abs(project.duration - expected) < 0.8, `the idle pause is cut out like a manual pause (${project.duration} vs ${expected})`)
    // Cursor positions resume where the pointer went while paused.
    const cursor = readCursor(home, id)
    const resumeAt = (tIdle - t0) / 1000
    h.assert(cursor.samples.some((s) => s.t > resumeAt + 0.2), 'cursor recorded after resuming')
  })

  await h.run('custom hotkeys: conflicts and taken combos refused on Home; stop, pause and zoom marks by hotkey; typing bursts without keys', async (ctx) => {
    const other = await grabKey('ctrl+alt+k')
    try {
      const home = h.tempHome('opt-keys')
      const { app, win, logs } = await h.launch({ home })
      ctx.app = r.closable(app)
      ctx.logs = logs
      await r.waitForSources(win)
      await openOptions(win)
      h.assert((await fieldText(win, 'stop')).replace(/\s/g, '') === 'CtrlShift2', 'default stop hotkey shown')

      await pressHotkey(win, 'stop', 'Control+Alt+KeyS')
      h.assert((await fieldText(win, 'stop')).replace(/\s/g, '') === 'CtrlAltS', `stop is Ctrl+Alt+S (${await fieldText(win, 'stop')})`)
      await pressHotkey(win, 'pause', 'Control+Alt+KeyS')
      h.assert(/already the hotkey for Stop/.test(await errorText(win, 'pause')), `conflict refused: ${await errorText(win, 'pause')}`)
      await pressHotkey(win, 'mark', 'Control+Alt+KeyK')
      h.assert(/already used by another app/.test(await errorText(win, 'mark')), `taken combo refused: ${await errorText(win, 'mark')}`)
      await pressHotkey(win, 'mark', 'Control+KeyC')
      h.assert(/Copy in most apps/.test(await errorText(win, 'mark')), `Ctrl+C refused: ${await errorText(win, 'mark')}`)
      const hint = await win.textContent('.record-footer .hint')
      h.assert(hint.replace(/\s/g, '').includes('CtrlAltS'), `Home's stop hint follows the hotkey (${hint})`)
      if (OUT) await win.screenshot({ path: path.join(OUT, 'home-hotkeys.png') })
      const saved = JSON.parse(fs.readFileSync(settingsFile(home), 'utf8')).recording.hotkeys
      h.assert(JSON.stringify(saved) === JSON.stringify({ stop: 'Ctrl+Alt+S', pause: 'Ctrl+Shift+F9', mark: 'Ctrl+Shift+F10' }), `saved ${JSON.stringify(saved)}`)

      const tb = await r.startRecording(app, win)
      const t0 = Date.now()
      h.assert(!(await tb.$('.tb-warn')), 'every hotkey registered')
      h.assert((await tb.getAttribute('button.stop', 'title')) === 'Stop (Ctrl + Alt + S)', 'Stop names its hotkey')
      await r.xinput('m 400 300; s 0.6; k ctrl+shift+F10')
      const mark1 = (Date.now() - t0) / 1000
      await tb.waitForSelector('.tb-mark', { timeout: 3000 })
      if (OUT) await tb.screenshot({ path: path.join(OUT, 'toolbar-mark.png') })
      await r.xinput(`s 0.3; ${typeWord('hello')}; s 1.8`)
      // Pause and resume by hotkey; input while paused is not recorded.
      await r.xinput('k ctrl+shift+F9')
      await tb.waitForSelector('.rec-dot.paused', { timeout: 5000 })
      const pausedAt = Date.now()
      h.assert((await tb.textContent('.tb-state')) === 'Paused', 'paused by hand (not idle)')
      await r.xinput(`s 0.4; k ctrl+shift+F10; ${typeWord('abc')}; s 1.5`)
      await r.xinput('k ctrl+shift+F9')
      await tb.waitForSelector('.rec-dot:not(.paused)', { timeout: 5000 })
      const pausedFor = (Date.now() - pausedAt) / 1000
      // The old stop shortcut is an ordinary key combo now.
      await r.xinput('s 0.5; k ctrl+shift+2; s 0.8')
      h.assert(await tb.$('button.stop'), 'Ctrl+Shift+2 no longer stops')
      await r.xinput('k ctrl+shift+F10')
      const mark2 = (Date.now() - t0) / 1000
      await r.xinput(`s 0.3; ${typeWord('world')}; s 1.0; k ctrl+alt+s`)
      await win.waitForSelector('.editor canvas', { timeout: 120000 })

      const [id] = h.listProjects(home)
      const cursor = readCursor(home, id)
      console.log(`hotkeys: marks ${JSON.stringify(cursor.marks)} (wall ${mark1.toFixed(2)}, ${mark2.toFixed(2)}, paused ${pausedFor.toFixed(2)} s); typing ${JSON.stringify(cursor.typing)}; keys ${JSON.stringify(cursor.keys.map((k) => k.label))}`)
      h.assert(cursor.marks.length === 2, `two marks (the one while paused is dropped): ${JSON.stringify(cursor.marks)}`)
      h.assert(Math.abs(cursor.marks[0].t - mark1) < 0.6, `first mark at ${cursor.marks[0].t} (≈ ${mark1})`)
      h.assert(Math.abs(cursor.marks[1].t - (mark2 - pausedFor)) < 0.8, `second mark pause-adjusted: ${cursor.marks[1].t} (≈ ${mark2 - pausedFor})`)
      h.assert(cursor.typing.length === 2, `two typing bursts (not the one while paused): ${JSON.stringify(cursor.typing)}`)
      h.assert(cursor.typing.every((b) => Object.keys(b).sort().join() === 'end,t' && b.end > b.t && b.end - b.t < 1.5), 'bursts are only times')
      h.assert(cursor.typing[0].t > cursor.marks[0].t && cursor.typing[0].t < cursor.marks[0].t + 1, 'first burst right after the first mark')
      h.assert(cursor.typing[1].t > cursor.marks[1].t, 'second burst after the second mark')
      const labels = cursor.keys.map((k) => k.label)
      for (const own of ['Ctrl + Shift + F10', 'Ctrl + Shift + F9', 'Ctrl + Alt + S']) h.assert(!labels.includes(own), `the app's own ${own} is not a keystroke`)
      h.assert(labels.includes('Ctrl + Shift + 2'), `an ordinary shortcut is kept: ${labels}`)
      h.assert(labels.every((l) => l.length > 1 || !/[a-z]/i.test(l)), `no typed letters: ${labels}`)
      const raw = fs.readFileSync(path.join(h.projectsRoot(home), id, 'cursor.json'), 'utf8')
      h.assert(!/hello|world|"[hewrd]"/i.test(raw), 'nothing typed is stored')
    } finally {
      other.kill()
    }
  })

  await h.run('a hotkey another app took after it was set is reported when recording starts', async (ctx) => {
    const home = h.tempHome('opt-taken')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await openOptions(win)
    await pressHotkey(win, 'mark', 'Control+Alt+KeyM')
    h.assert(!(await errorText(win, 'mark')), 'free when set')
    const other = await grabKey('ctrl+alt+m')
    try {
      const tb = await r.startRecording(app, win)
      await tb.waitForSelector('.tb-warn')
      const title = await tb.getAttribute('.tb-warn', 'title')
      h.assert(/Ctrl \+ Alt \+ M \(zoom here\) is used by another app/.test(title), `toolbar explains: ${title}`)
      h.assert(!/used by another app/.test(await tb.getAttribute('button.stop', 'title')), 'stop still works')
      await r.xinput('s 1; k ctrl+shift+2')
      await win.waitForSelector('.editor canvas', { timeout: 120000 })
      h.assert(h.listProjects(home).length === 1, 'stopped by the stop hotkey')
    } finally {
      other.kill()
    }
  })

  await desktopIconsUnderWine()
}

const EXE = path.join(h.APP_DIR, 'native/bin/ssw-capture.exe')
const FAKE_DESKTOP = path.join(h.APP_DIR, 'native/target/x86_64-pc-windows-gnu/release/examples/fake_desktop.exe')

/** The fake desktop exe, built when cargo and the Windows target are there. */
function fakeDesktopExe() {
  if (fs.existsSync(FAKE_DESKTOP)) return FAKE_DESKTOP
  const b = spawnSync('cargo', ['build', '--release', '--example', 'fake_desktop', '--target', 'x86_64-pc-windows-gnu', '--manifest-path', path.join(h.APP_DIR, 'native/Cargo.toml')], {
    stdio: 'inherit'
  })
  return b.status === 0 && fs.existsSync(FAKE_DESKTOP) ? FAKE_DESKTOP : null
}

/** Compiles a main-process module on its own (it is only bundled into the app). */
function compile(dir, rel) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(h.APP_DIR, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.cjs'))
  fs.writeFileSync(file, outputText)
  return file
}

async function desktopIconsUnderWine() {
  const wine = spawnSync('wine', ['--version'], { encoding: 'utf8' })
  const fake = wine.status === 0 && fs.existsSync(EXE) ? fakeDesktopExe() : null
  if (!fake) {
    console.log('SKIP recording-options: desktop icons under wine (needs wine, native/bin/ssw-capture.exe and the fake_desktop example)')
    return
  }
  await h.run('desktop icons: the real helper under wine hides and restores them through the app client', async (ctx) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-icons-'))
    const env = { ...process.env, WINEDEBUG: '-all', WINEPREFIX: process.env.WINEPREFIX || path.join(os.tmpdir(), 'ssw-e2e-wineprefix') }
    // No desktop at all (wine has no Explorer shell): a clean "not found", nothing crashes.
    const none = spawnSync('wine', [EXE, 'desktop-icons', 'hide'], { env, encoding: 'utf8', timeout: 180000 })
    h.assert(none.status === 4 && /"event":"error"/.test(none.stdout), `no desktop: exit ${none.status} ${none.stdout}`)

    const desktop = spawn('wine', [fake, '120'], { env, stdio: ['pipe', 'pipe', 'inherit'] })
    try {
      await r.until(() => desktop.stdout.read()?.toString().includes('ready'), { timeout: 120000, what: 'fake desktop' })
      const wrapper = path.join(tmp, 'wine-helper.cjs')
      fs.writeFileSync(
        wrapper,
        `const { spawn } = require('node:child_process')
const p = spawn('wine', [${JSON.stringify(EXE)}, ...process.argv.slice(2)], { stdio: 'inherit' })
p.on('exit', (code) => process.exit(code ?? 1))
`
      )
      const home = h.tempHome('opt-icons')
      const { app, logs } = await h.launch({ home, env: { SSW_CAPTURE_HELPER: wrapper, WINEDEBUG: '-all', WINEPREFIX: env.WINEPREFIX } })
      ctx.app = app
      ctx.logs = logs
      const client = compile(tmp, 'src/main/nativeCapture.ts')
      const glue = compile(tmp, 'src/main/recording/desktopIcons.ts')
      const result = await app.evaluate(
        async (_e, files) => {
          const nc = process.mainModule.require(files.client)
          const { DesktopIcons } = process.mainModule.require(files.glue)
          Object.assign(nc.nativeCaptureTimeouts, { list: 120000 })
          const steps = {}
          steps.status = await nc.desktopIcons('status')
          // The app's restore logic as on Windows, with a saved flag like app-settings.json.
          const state = { hidden: false }
          const icons = new DesktopIcons({
            platform: 'win32',
            run: nc.desktopIcons,
            runSync: (a) => nc.desktopIconsSync(a, 60000),
            state: {
              get desktopIconsHidden() {
                return state.hidden
              },
              setDesktopIconsHidden: (v) => {
                state.hidden = v
              }
            }
          })
          steps.hid = await icons.hide()
          steps.flagWhileHidden = state.hidden
          steps.afterHide = await nc.desktopIcons('status')
          steps.hideAgain = await nc.desktopIcons('hide')
          await icons.restore()
          steps.flagAfterRestore = state.hidden
          steps.afterRestore = await nc.desktopIcons('status')
          // Quitting: the synchronous path.
          await icons.hide()
          icons.restoreSync()
          steps.afterQuit = nc.desktopIconsSync('status', 60000)
          return steps
        },
        { client, glue }
      )
      console.log(`desktop icons (wine): ${JSON.stringify(result)}`)
      h.assert(result.status.ok && result.status.visible === true, 'visible at first')
      h.assert(result.hid === true && result.flagWhileHidden === true, 'hidden by the app, and remembered')
      h.assert(result.afterHide.ok && result.afterHide.visible === false, 'hidden')
      h.assert(result.hideAgain.ok && result.hideAgain.changed === false, 'hiding hidden icons changes nothing')
      h.assert(result.flagAfterRestore === false && result.afterRestore.visible === true, 'restored')
      h.assert(result.afterQuit.ok && result.afterQuit.visible === true, 'restored synchronously on quit')
    } finally {
      desktop.stdin.end()
      desktop.kill()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}

main()
