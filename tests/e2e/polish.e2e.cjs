// Polish features end to end in the built app: removing silences from a recording with
// talk / silence / talk (the pause is cut, keeping a little silence next to the sound, and one
// undo restores it); a real recording that clicks into a place and types gets one auto zoom
// spanning the typing, aimed at the click; recording presets saved on Home survive a restart
// and set everything up again, a missing device falls back to the default with a notice, and
// a recording with the countdown turned off starts without one.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')
const r = require('./recordingHelpers.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const MEDIA_CACHE = path.join(os.tmpdir(), 'ssw-e2e-media')

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** 12 s test pattern with a voice (a tone) from 0.3 s to 3.5 s and from 7.5 s to 11.9 s, silent in between (cached). */
function talkSilenceTalk() {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, 'talk-silence-talk-12s-640x360-30.mp4')
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', "sine=frequency=330:sample_rate=48000,volume='if(between(t,0.3,3.5)+between(t,7.5,11.9),1.5,0)':eval=frame",
    '-t', '12', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    tmp
  ], { stdio: 'inherit' })
  fs.renameSync(tmp, file)
  return file
}

async function openSeeded(ctx, tag, opts) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  if (opts.video) {
    const media = path.join(h.projectsRoot(home), id, 'screen.mp4')
    fs.unlinkSync(media)
    fs.symlinkSync(opts.video, media)
  }
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  await f.openProject(win, opts.name)
  return { home, id, app, win }
}

const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const secs = (t) => t.split(':').reduce((a, v) => a * 60 + Number(v), 0)
const ranges = (win) =>
  win.$$eval('.smart-list .smart-range', (els) => els.map((e) => e.textContent)).then((list) => list.map((p) => p.split('–').map((t) => secs(t.trim()))))

/** Sets a range input to `value` the way the keyboard does (React sees an input event). */
async function setSlider(win, label, value) {
  await win.$eval(
    `input[aria-label="${label}"]`,
    (el, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, String(v))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    value
  )
}

/** userData/app-settings.json of a test HOME (Linux: ~/.config/<app name>). */
function settingsFile(home) {
  const config = path.join(home, '.config')
  for (const d of fs.existsSync(config) ? fs.readdirSync(config) : []) {
    const file = path.join(config, d, 'app-settings.json')
    if (fs.existsSync(file)) return file
  }
  return null
}

const readSettings = (home) => {
  const file = settingsFile(home)
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

/** Types `word` like a person (about 8 keys a second), so it is one typing burst. */
const typeSlowly = (word) => word.split('').map((c) => `k ${c === ' ' ? 'space' : c}; s 0.12`).join('; ')

async function main() {
  await test('silences: the pause between talk is cut with padding, one undo restores it; no sound explains instead', async (ctx) => {
    const { home, id, win } = await openSeeded(ctx, 'silences', { name: 'Talk', seconds: 12, width: 640, height: 360, fps: 30, audio: true, video: talkSilenceTalk() })
    await win.click('.insp-tabs button:has-text("Clip")')
    // Idle parts stay the default mode.
    await win.waitForSelector('.chips[aria-label="Smart speed mode"] .chip.active:has-text("Idle parts")')
    await win.click('.chips[aria-label="Smart speed mode"] .chip:has-text("Silences")')
    // The sound is measured at once; one pause of 4 s, less 0.25 s kept next to the voice at each end.
    await win.waitForSelector('.smart-list li', { timeout: 30000 })
    const found = await ranges(win)
    console.log(`silences: ${JSON.stringify(found)}; summary "${await win.textContent('.smart-summary')}"`)
    h.assert(found.length === 1, `one pause: ${JSON.stringify(found)}`)
    const [[a, b]] = found
    h.assert(Math.abs(a - 3.75) < 0.15 && Math.abs(b - 7.25) < 0.15, `cut 3.75–7.25 s, padded inside the 3.5–7.5 s pause: ${a}–${b}`)
    h.assert(/1 silence · saves 3\.\d s/.test(await win.textContent('.smart-summary')), `shows the saving: ${await win.textContent('.smart-summary')}`)
    h.assert((await win.textContent('.chips[aria-label="Silence action"] .chip.active')) === 'Cut', 'cut is the default for silences')

    // More padding keeps more of the pause.
    await setSlider(win, 'Keep next to the sound', 0.5)
    await f.waitFor(async () => {
      const [[x, y]] = await ranges(win)
      return Math.abs(x - 4) < 0.15 && Math.abs(y - 7) < 0.15
    }, 'padding of 0.5 s', 3000)
    // A minimum above the pause finds nothing.
    await setSlider(win, 'Silent for at least', 5)
    await f.waitFor(async () => (await win.textContent('.smart-summary')).includes('No pauses of 5.0 s'), 'no pause of 5 s', 3000)
    await setSlider(win, 'Silent for at least', 1)
    await setSlider(win, 'Keep next to the sound', 0.25)
    await win.waitForSelector('.smart-list li')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'silences.png') })

    const before = h.readProject(home, id).clips
    await win.click('.smart-speed button.btn.primary:has-text("Cut 1 silence")')
    await win.waitForSelector('.notice:has-text("Cut 1 silence: the video is 3.")', { timeout: 10000 })
    await waitSaved(win)
    const cut = h.readProject(home, id).clips
    console.log(`after cut: ${JSON.stringify(cut)}`)
    h.assert(cut.length === 2, `two clips around the pause: ${JSON.stringify(cut)}`)
    h.assert(Math.abs(cut[0].end - 3.75) < 0.15 && Math.abs(cut[1].start - 7.25) < 0.15, `cut with padding: ${JSON.stringify(cut)}`)
    h.assert(cut[0].start === 0 && cut[1].end === 12, 'the talk is kept whole')
    // What is left of the pause is the padding: nothing more to find.
    await f.waitFor(async () => (await win.textContent('.smart-summary')).includes('No pauses of 1.0 s'), 'nothing left to cut', 3000)
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 1, 'cut shown on the timeline', 3000)

    await win.keyboard.press('Control+z')
    await waitSaved(win)
    h.assert(JSON.stringify(h.readProject(home, id).clips) === JSON.stringify(before), 'one Ctrl+Z restores the clips')
    await win.waitForSelector('.smart-list li')

    // Sped up instead: the pause plays 4x, one undo step too.
    await win.click('.chips[aria-label="Silence action"] .chip:has-text("4×")')
    await win.click('.smart-speed button.btn.primary:has-text("Speed up 1 silence 4×")')
    await win.waitForSelector('.notice:has-text("Sped up 1 silence 4×")', { timeout: 10000 })
    await waitSaved(win)
    const sped = h.readProject(home, id).clips
    h.assert(sped.length === 3 && sped[1].speed === 4 && Math.abs(sped[1].start - 3.75) < 0.15, `pause sped up: ${JSON.stringify(sped)}`)
    await win.keyboard.press('Control+z')
    await waitSaved(win)
    h.assert(JSON.stringify(h.readProject(home, id).clips) === JSON.stringify(before), 'undo restores')

    // Muted: nothing can be told apart from silence; it says so and offers nothing to cut.
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.click('label.toggle:has-text("Mute")')
    await win.click('.insp-tabs button:has-text("Clip")')
    await win.waitForSelector('[data-testid="silence-unavailable"]:has-text("muted")')
    h.assert(!(await win.$('.smart-speed button.btn.primary')), 'nothing to apply while muted')
  })

  await test('silences: a recording without sound explains, and points to idle parts', async (ctx) => {
    const { win } = await openSeeded(ctx, 'silences-none', { name: 'Silent', seconds: 8, width: 640, height: 360, fps: 30 })
    await win.click('.insp-tabs button:has-text("Clip")')
    await win.click('.chips[aria-label="Smart speed mode"] .chip:has-text("Silences")')
    const text = await win.textContent('[data-testid="silence-unavailable"]')
    h.assert(/no sound/.test(text), `explains: ${text}`)
    h.assert(!(await win.$('.smart-speed button.btn.primary')), 'nothing to apply')
    await win.click('[data-testid="silence-unavailable"] button.link:has-text("Find idle parts")')
    await win.waitForSelector('.chips[aria-label="Smart speed mode"] .chip.active:has-text("Idle parts")')
  })

  await test('auto zoom on typing: a recording that clicks a place and types gets one zoom spanning the typing, aimed at the click', async (ctx) => {
    const home = h.tempHome('typing-zoom')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    const tb = await r.startRecording(app, win)
    // Click a field, type, think for 2.5 s (the mouse is pushed aside), type more, then rest.
    await r.xinput(`m 300 300; s 0.6; c 1400 760; s 0.5; ${typeSlowly('hello there')}; s 0.4; g 1400 760 500 250 0.5; s 3.6; ${typeSlowly('again')}; s 3.2`)
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    const cursor = JSON.parse(fs.readFileSync(path.join(h.projectsRoot(home), id, 'cursor.json'), 'utf8'))
    const zooms = project.zooms.filter((z) => z.auto)
    console.log(`typing zoom: clicks ${JSON.stringify(cursor.clicks)}; typing ${JSON.stringify(cursor.typing)}; zooms ${JSON.stringify(zooms)}`)
    h.assert(cursor.clicks.length === 1, `one click recorded: ${JSON.stringify(cursor.clicks)}`)
    h.assert(cursor.typing.length === 2, `two typing bursts (the pause splits them): ${JSON.stringify(cursor.typing)}`)
    // A pause long enough that each burst would get its own zoom, zooming out and in between.
    h.assert(cursor.typing[1].t - cursor.typing[0].end > 4, `a pause of over 4 s: ${JSON.stringify(cursor.typing)}`)
    const [click] = cursor.clicks
    const last = cursor.typing[cursor.typing.length - 1]
    h.assert(zooms.length === 1, `one zoom for the click and both bursts: ${JSON.stringify(zooms)}`)
    const [z] = zooms
    h.assert(z.start < click.t && z.end > last.end, `the zoom spans the click and all the typing: ${z.start}–${z.end}`)
    h.assert(Math.abs(z.anchor.x - click.x) < 1e-6 && Math.abs(z.anchor.y - click.y) < 1e-6, `aimed at the click: ${JSON.stringify(z.anchor)} vs ${JSON.stringify(click)}`)
    // The aim spans the click and the typing, so the whole zoom (however its edges are edited later) looks at the field.
    h.assert(Math.abs(z.anchor.t - click.t) < 1e-6 && Math.abs(z.anchor.until - last.end) < 1e-6, `aims from the click to the last key: ${JSON.stringify(z.anchor)}`)
    h.assert(Math.abs(z.scale - 2.16) < 1e-6, `a step closer than click zooms: ${z.scale}`)
    // The Zoom panel lists it as one automatic zoom.
    await win.click('.insp-tabs button:has-text("Zoom")')
    await win.waitForSelector('.insp-section:has-text("1 automatic zoom")')
  })

  await test('recording presets: saved on Home, kept across a restart, applied in one pick; a missing device falls back with a notice', async (ctx) => {
    const home = h.tempHome('presets')
    let { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    h.assert((await win.textContent('select[aria-label="Recording preset"] option:checked')) === 'No presets saved', 'no presets at first')

    // A setup: an area, a microphone and the camera, no keyboard activity, 30 fps, a 5 s countdown, auto-pause.
    await win.click('.segmented button:has-text("Area")')
    const selects = await win.$$('.record-panel .field select')
    const mic = await win.$eval('.record-panel label.field:has-text("Microphone") select', (s) => s.options[1]?.value ?? '')
    const cam = await win.$eval('.record-panel label.field:has-text("Camera") select', (s) => s.options[1]?.value ?? '')
    h.assert(mic && cam && selects.length >= 3, 'fake devices listed')
    await win.selectOption('.record-panel label.field:has-text("Microphone") select', mic)
    await win.selectOption('.record-panel label.field:has-text("Camera") select', cam)
    await win.click('.record-panel input[aria-label="Record keyboard activity"]')
    if (!(await win.$('.rec-options.open'))) await win.click('.rec-options-head')
    await win.click('.rec-options .chip:has-text("30 fps")')
    await win.click('.chips[aria-label="Countdown"] .chip:has-text("5 s")')
    await win.click('.rec-options .toggle:has-text("Auto-pause") input')
    await win.waitForSelector('.chips[aria-label="Countdown"] .chip.active:has-text("5 s")')

    await win.click('button[aria-label="Save as preset"]')
    await win.fill('input[aria-label="Preset name"]', 'Tutorial')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'home-preset-name.png') })
    await win.keyboard.press('Enter')
    await f.waitFor(async () => (await win.textContent('select[aria-label="Recording preset"] option:checked')) === 'Tutorial', 'the saved preset is in use')
    h.assert(!(await win.$('input[aria-label="Preset name"]')), 'the name field closes')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'home-presets.png') })
    const saved = readSettings(home).presets
    console.log(`presets saved: ${JSON.stringify(saved)}`)
    h.assert(saved.length === 1, 'one preset on disk')
    const p = saved[0]
    h.assert(
      p.name === 'Tutorial' && p.source === 'area' && p.fps === 30 && p.countdown === 5 && p.autoPause === true && p.captureKeys === false && p.mic.id === mic && p.camera.id === cam,
      `the setup is saved: ${JSON.stringify(p)}`
    )
    h.assert(typeof p.mic.label === 'string' && p.mic.label.length > 0, 'the device name is kept too')

    // Change everything back: the picker shows a custom setup.
    await win.click('.segmented button:has-text("Screens")')
    await win.selectOption('.record-panel label.field:has-text("Microphone") select', '')
    await win.selectOption('.record-panel label.field:has-text("Camera") select', '')
    await win.click('.record-panel input[aria-label="Record keyboard activity"]')
    await win.click('.rec-options .chip:has-text("60 fps")')
    await win.click('.chips[aria-label="Countdown"] .chip:has-text("3 s")')
    await win.click('.rec-options .toggle:has-text("Auto-pause") input')
    await f.waitFor(async () => (await win.textContent('select[aria-label="Recording preset"] option:checked')) === 'Custom setup', 'custom setup once changed')
    await f.waitFor(() => readSettings(home).recording.fps === 60 && readSettings(home).recording.countdown === 3, 'options saved')

    // Restart, then pick the preset: everything comes back at once.
    await app.close()
    ;({ app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA }))
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await f.waitFor(async () => (await win.$$eval('select[aria-label="Recording preset"] option', (os) => os.map((o) => o.textContent))).includes('Tutorial'), 'the preset is listed after a restart', 15000)
    h.assert((await win.textContent('select[aria-label="Recording preset"] option:checked')) === 'Custom setup', 'the current setup is not the preset')
    await win.selectOption('select[aria-label="Recording preset"]', { label: 'Tutorial' })
    await win.waitForSelector('.segmented button.active:has-text("Area")')
    h.assert((await win.$eval('.record-panel label.field:has-text("Microphone") select', (s) => s.value)) === mic, 'microphone set')
    h.assert((await win.$eval('.record-panel label.field:has-text("Camera") select', (s) => s.value)) === cam, 'camera set')
    h.assert(!(await win.$eval('.record-panel input[aria-label="Record keyboard activity"]', (i) => i.checked)), 'keyboard activity off')
    if (!(await win.$('.rec-options.open'))) await win.click('.rec-options-head')
    await win.waitForSelector('.rec-options .chip.active:has-text("30 fps")')
    await win.waitForSelector('.chips[aria-label="Countdown"] .chip.active:has-text("5 s")')
    h.assert(await win.$eval('.rec-options input[aria-label="Auto-pause when idle"]', (i) => i.checked), 'auto-pause on')
    await f.waitFor(() => {
      const s = readSettings(home).recording
      return s.fps === 30 && s.countdown === 5 && s.autoPause === true
    }, 'the recording options are saved')
    h.assert((await win.textContent('select[aria-label="Recording preset"] option:checked')) === 'Tutorial', 'the preset shows as in use')
    h.assert(!(await win.$('.record-panel .notice')), 'no notice: every device is there')

    // A preset whose microphone is gone: the default one is used, and Home says so.
    await app.close()
    const file = settingsFile(home)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    stored.presets[0].mic = { id: 'gone-mic', label: 'USB Podcast Mic' }
    fs.writeFileSync(file, JSON.stringify(stored))
    ;({ app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA }))
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await win.selectOption('.record-panel label.field:has-text("Microphone") select', '')
    await f.waitFor(async () => (await win.textContent('select[aria-label="Recording preset"] option:checked')) === 'Custom setup', 'custom setup')
    await win.selectOption('select[aria-label="Recording preset"]', { label: 'Tutorial' })
    const notice = await win.waitForSelector('.record-panel .notice:has-text("USB Podcast Mic")', { timeout: 5000 })
    const text = await notice.textContent()
    console.log(`missing device: ${text}`)
    h.assert(/microphone “USB Podcast Mic” is not connected, so the default microphone/.test(text), `explains the fallback: ${text}`)
    const used = await win.$eval('.record-panel label.field:has-text("Microphone") select', (s) => s.value)
    h.assert(used !== '' && used !== 'gone-mic', `a connected microphone is used: ${used}`)
    h.assert((await win.textContent('select[aria-label="Recording preset"] option:checked')) === 'Tutorial', 'the preset, as it can be used here, is in use')

    // A second preset that comes to the same setup here (its microphone is the one Tutorial falls
    // back to): the picker shows, deletes and offers to replace the one picked, not the first.
    const pickedName = async () => win.textContent('select[aria-label="Recording preset"] option:checked')
    await win.click('button[aria-label="Save as preset"]')
    await win.fill('input[aria-label="Preset name"]', 'Twin')
    await win.keyboard.press('Enter')
    await f.waitFor(async () => (await pickedName()) === 'Twin', 'the preset just saved is in use')
    await win.selectOption('select[aria-label="Recording preset"]', { label: 'Tutorial' })
    await f.waitFor(async () => (await pickedName()) === 'Tutorial', 'the preset picked is in use')
    h.assert(!!(await win.$('button[aria-label="Delete preset Tutorial"]')), 'delete offers the preset picked')
    await win.click('button[aria-label="Save as preset"]')
    h.assert((await win.inputValue('input[aria-label="Preset name"]')) === 'Tutorial', 'saving offers to update the preset picked')
    await win.press('input[aria-label="Preset name"]', 'Escape')
    await win.selectOption('select[aria-label="Recording preset"]', { label: 'Twin' })
    await f.waitFor(async () => (await pickedName()) === 'Twin', 'the other twin, once picked')
    await win.click('button[aria-label="Delete preset Twin"]')
    await f.waitFor(async () => (await pickedName()) === 'Tutorial', 'the twin deleted, the setup is still Tutorial')
    h.assert(readSettings(home).presets.map((x) => x.name).join() === 'Tutorial', 'only the picked twin was deleted')

    // Deleting the preset in use.
    await win.click('button[aria-label="Delete preset Tutorial"]')
    await f.waitFor(async () => (await pickedName()) === 'No presets saved', 'deleted')
    await f.waitFor(() => !readSettings(home).presets, 'deleted on disk')
  })

  await test('countdown off: the recording starts without counting down', async (ctx) => {
    const home = h.tempHome('no-countdown')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    if (!(await win.$('.rec-options.open'))) await win.click('.rec-options-head')
    await win.click('.chips[aria-label="Countdown"] .chip:has-text("Off")')
    await f.waitFor(() => readSettings(home)?.recording.countdown === 0, 'countdown off saved')
    h.assert((await win.textContent('.rec-options-head')).includes('no countdown') || (await win.$('.rec-options.open')), 'summarised')
    await r.readyToRecord(win)
    await win.click('button.record')
    const tb = await r.toolbar(app)
    let counted = false
    const t0 = Date.now()
    while (!(await tb.$('button.stop'))) {
      if (await tb.$('.countdown-number')) counted = true
      if (Date.now() - t0 > 20000) throw new Error('the recording did not start')
      await h.sleep(50)
    }
    console.log(`countdown off: recording after ${Date.now() - t0} ms`)
    h.assert(!counted, 'no countdown number was shown')
    h.assert(!(await r.mainVisible(app)), 'the app window is out of the way while recording')
    await r.xinput('g 300 300 900 600 1.0; s 0.5')
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    h.assert(h.listProjects(home).length === 1, 'recorded')
  })
}

main()
