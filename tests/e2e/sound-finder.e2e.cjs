// The unwanted-sound finder in the real built app (docs/design/sound-finder.md): Find listens to the
// recording with YAMNet in a worker (progress), lists the ding and the background music on the
// system sound and nothing during speech, keeps the scores in .cache/sounds.json and shows them again
// without listening; Mute (keyboard) silences the ding in the export as one undo step, Duck lowers
// the music by about 14 dB, Cut is an ordinary cut, Ignore hides a row and Show ignored brings it
// back; Cancel stops a long one and keeps nothing; an old project opens and saves unchanged.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const sp = require('./speech-fixtures.cjs')
const fx = require('./render-fixtures.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const RATE = 48000
const SECONDS = 24
/** Where the sounds are in the fixture (source seconds). */
const DING = 13.0
const MUSIC = [15.0, 23.0]
const SHOTS = process.env.SSW_E2E_SHOTS || null

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const ff = (args) => execFileSync(FF, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] })

/**
 * The fixture (cached): mic.m4a with JFK speaking from 1 s to 12 s and silence after; system.m4a with
 * silence, a 1.3 kHz ding at 13 s and a synthesised arpeggio from 15 s to 23 s; screen.mp4 with both
 * mixed. `seconds` makes a longer one (the speech, the ding and the music again every 24 s).
 */
function media(seconds = SECONDS) {
  const dir = path.join(fx.MEDIA_CACHE, `sound-finder-v1-${seconds}`)
  const out = { mic: path.join(dir, 'mic.m4a'), system: path.join(dir, 'system.m4a'), screen: path.join(dir, 'screen.mp4') }
  if (Object.values(out).every((f) => fs.existsSync(f))) return out
  fs.mkdirSync(dir, { recursive: true })
  const loops = Math.ceil(seconds / SECONDS)
  const ding = `aevalsrc='if(between(t,${DING},${DING + 1.5}),0.4*exp(-6*(t-${DING}))*(sin(2*PI*1320*t)+0.5*sin(2*PI*2640*t)+0.25*sin(2*PI*3960*t)),0)':s=${RATE}:d=${SECONDS}`
  const music = `aevalsrc='if(between(t,${MUSIC[0]},${MUSIC[1]}),0.15*exp(-3*mod(t,0.25))*(sin(2*PI*(220*pow(2,floor(mod(t*4,8))*2/12))*t)+0.6*sin(2*PI*(330*pow(2,floor(mod(t*4,8))*2/12))*t)+0.5*sin(2*PI*110*t)),0)':s=${RATE}:d=${SECONDS}`
  const sys = path.join(dir, 'system.part.wav')
  ff(['-f', 'lavfi', '-i', ding, '-f', 'lavfi', '-i', music, '-filter_complex', `[0][1]amix=inputs=2:normalize=0,aloop=loop=${loops - 1}:size=${SECONDS * RATE},atrim=0:${seconds}`, '-c:a', 'pcm_s16le', sys])
  const mic = path.join(dir, 'mic.part.wav')
  ff(['-i', sp.JFK, '-filter_complex', `anullsrc=r=${RATE}:cl=mono,atrim=0:1[s];[0:a]aresample=${RATE},aformat=channel_layouts=mono,atrim=0:11[j];[s][j]concat=n=2:v=0:a=1,apad=whole_dur=${SECONDS},aloop=loop=${loops - 1}:size=${SECONDS * RATE},atrim=0:${seconds}`, '-c:a', 'pcm_s16le', mic])
  ff(['-i', mic, '-c:a', 'aac', '-b:a', '128k', `${out.mic}.part.m4a`])
  ff(['-i', sys, '-c:a', 'aac', '-b:a', '128k', `${out.system}.part.m4a`])
  ff(['-f', 'lavfi', '-i', 'color=c=gray:size=640x360:rate=30', '-i', mic, '-i', sys, '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `${out.screen}.part.mp4`])
  for (const f of [mic, sys]) fs.rmSync(f)
  for (const f of Object.values(out)) fs.renameSync(`${f}.part${path.extname(f)}`, f)
  return out
}

/** Seeds a project with the fixture (symlinked, so the files keep their times). */
function seed(home, { id = 'rec-sounds', name = 'Sounds demo', seconds = SECONDS, extra = {} } = {}) {
  const m = media(seconds)
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  for (const [k, f] of Object.entries({ 'mic.m4a': m.mic, 'system.m4a': m.system, 'screen.mp4': m.screen })) fs.symlinkSync(f, path.join(dir, k))
  const project = {
    version: 2,
    id,
    name,
    createdAt: new Date().toISOString(),
    duration: seconds,
    width: 640,
    height: 360,
    hasWebcam: false,
    hasAudio: true,
    audioStems: { mic: true, system: true },
    webcamOffset: 0,
    capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: [{ id: 'c0', start: 0, end: seconds, speed: 1 }],
    zooms: [],
    autoZoom: false,
    annotations: [],
    style: { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    ...extra
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify({ samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }))
  return { id, dir }
}

/** The first audio stream at 48 kHz as one signal (the mean of its channels). */
function pcm(file) {
  const n = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]).toString().trim())
  const out = execFileSync(FF, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  const all = new Float32Array(out.buffer, out.byteOffset, out.length / 4)
  const mono = new Float32Array(Math.floor(all.length / n))
  for (let i = 0; i < mono.length; i++) for (let c = 0; c < n; c++) mono[i] += all[i * n + c] / n
  return mono
}

/** RMS level of [from, to) seconds, dBFS. */
function level(s, from, to) {
  let sum = 0
  const a = Math.round(from * RATE)
  const b = Math.min(s.length, Math.round(to * RATE))
  for (let i = a; i < b; i++) sum += s[i] * s[i]
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-20)
}

const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const section = (win) => win.locator('section.insp-section:has(> h3:has-text("Unwanted sounds"))')
const rowOf = (win, kind) => win.locator(`.sound-row[data-kind="${kind}"]`).first()

async function shot(win, name) {
  if (!SHOTS) return
  const s = section(win)
  await s.scrollIntoViewIfNeeded()
  await h.sleep(200)
  await s.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function openEditor(ctx, home, name) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  // Record the gains the preview schedules (the curve of a muted or lowered stretch).
  await win.evaluate(() => {
    window.__ramps = []
    const ramp = AudioParam.prototype.linearRampToValueAtTime
    AudioParam.prototype.linearRampToValueAtTime = function (value, time) {
      window.__ramps.push(value)
      return ramp.call(this, value, time)
    }
  })
  await fx.openProject(win, name)
  await win.click('.insp-tabs button:has-text("Audio")')
  await section(win).waitFor({ timeout: 10000 })
  return { app, win, logs }
}

async function exportM4a(app, win, out) {
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Format', 'M4A')
  await h.mockSaveDialog(app, out)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const res = await fx.waitForExport(win)
  h.assert(res.ok, `export finished: ${res.text}`)
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** The rows as listed: [{ kind, key, state }]. */
const rows = (win) => win.$$eval('.sound-row', (els) => els.map((e) => ({ kind: e.dataset.kind, key: e.dataset.key, state: e.dataset.state })))
const startOf = (key) => Number(key.split('-')[1]) / 100

async function main() {
  await test('sound finder: finds the ding and the music, not speech; keeps the scores; Mute, Duck, Cut, Ignore, each one undo step, as exported', fx.withHome('sf-main', async (ctx, home) => {
    const { id, dir } = seed(home)
    const { app, win, logs } = await openEditor(ctx, home, 'Sounds demo')
    await win.waitForSelector('text=Finds coughs, sneezes, typing, notification sounds, phones, dogs, knocks and background music, on this PC. Speech is never listed.')
    await shot(win, 'sound-finder-start')
    // (The editor itself corrects the fixture's duration to its video's frames and saves that: not this feature.)
    await h.sleep(1500)
    const before = fs.readFileSync(path.join(dir, 'project.json'), 'utf8')
    h.assert(!('sounds' in JSON.parse(before)), 'opening the Audio tab adds nothing')

    const plain = path.join(home, 'plain.m4a')
    await exportM4a(app, win, plain)

    const t0 = Date.now()
    await win.click('[data-testid="sounds-find"]')
    await win.waitForSelector('[data-testid="sounds-status"][data-state="listening"], [data-testid="sounds-status"][data-state="done"]', { timeout: 10000 })
    await win.waitForSelector('[data-testid="sounds-status"][data-state="done"]', { timeout: 120000 }).catch(async (err) => {
      throw new Error(`${err.message}\n${await section(win).textContent()}\n${logs.join('')}`)
    })
    const took = (Date.now() - t0) / 1000
    h.assert((await win.getAttribute('[data-testid="sounds-status"]', 'data-from')) === 'scan', 'listened to the recording')
    let list = await rows(win)
    console.log(`    found in ${took.toFixed(1)} s: ${list.map((r) => r.key).join(', ')}`)
    const ding = list.find((r) => r.kind === 'ping')
    const music = list.find((r) => r.kind === 'music')
    h.assert(ding && Math.abs(startOf(ding.key) - DING) < 0.6, `the ding is listed near ${DING} s: ${JSON.stringify(list)}`)
    h.assert(music && startOf(music.key) >= MUSIC[0] - 0.6 && startOf(music.key) < MUSIC[0] + 1.5, `the music is listed from about ${MUSIC[0]} s: ${JSON.stringify(list)}`)
    h.assert(list.every((r) => startOf(r.key) >= 12 || startOf(r.key) < 0.9), `nothing is listed while JFK speaks: ${JSON.stringify(list)}`)
    h.assert(list.every((r) => r.state === 'open'), 'every row is open')
    h.assert(fs.readFileSync(path.join(dir, 'project.json'), 'utf8') === before, 'listening changes nothing in the project')
    const cache = JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'sounds.json'), 'utf8'))
    h.assert(cache.version === 1 && cache.entries.mic && cache.entries.system && cache.entries.mic.n > 40, `scores kept per source: ${Object.keys(cache.entries)}`)
    await shot(win, 'sound-finder-list')

    // Mute the ding with the keyboard: Tab to its Mute button, Enter.
    await rowOf(win, 'ping').locator('button.sound-play').focus()
    await win.keyboard.press('Tab')
    h.assert((await win.evaluate(() => document.activeElement?.textContent)) === 'Mute', 'Tab reaches Mute')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.sound-row[data-kind="ping"][data-state="muted"]')
    h.assert((await win.evaluate(() => document.activeElement?.textContent)) === 'Restore', 'the focus stays on the row (its Restore button)')
    await win.waitForSelector('text=Muted the notification sound at')
    await waitSaved(win)
    let saved = h.readProject(home, id)
    h.assert(saved.sounds?.spans?.length === 1 && saved.sounds.spans[0].action === 'mute' && saved.sounds.spans[0].key === ding.key, `saved one mute: ${JSON.stringify(saved.sounds)}`)
    const span = saved.sounds.spans[0]

    // The export is silent there and as before elsewhere.
    const muted = path.join(home, 'muted.m4a')
    await exportM4a(app, win, muted)
    const a = pcm(plain)
    const b = pcm(muted)
    const dingBefore = level(a, span.start, span.end)
    const dingAfter = level(b, span.start, span.end)
    console.log(`    ding ${dingBefore.toFixed(1)} dBFS -> ${dingAfter.toFixed(1)} dBFS muted; elsewhere ${level(a, 2, 11).toFixed(1)} / ${level(b, 2, 11).toFixed(1)}`)
    h.assert(dingBefore > -40 && dingAfter < -70, 'the ding is silent in the export')
    h.assert(Math.abs(level(a, 2, 11) - level(b, 2, 11)) < 0.5 && Math.abs(level(a, MUSIC[0] + 1, MUSIC[1] - 1) - level(b, MUSIC[0] + 1, MUSIC[1] - 1)) < 0.5, 'the speech and the music are unchanged')

    // The preview plays the same curve: Play schedules the stretch's gain (0) on the Web Audio graph.
    await win.evaluate(() => (window.__ramps = []))
    await rowOf(win, 'ping').locator('button.sound-play').click()
    await win.waitForFunction(() => window.__ramps.includes(0), null, { timeout: 10000 })

    // Undo: one step brings it back; Redo mutes it again.
    await rowOf(win, 'ping').locator('button.sound-play').focus()
    await win.keyboard.press('Control+z')
    await win.waitForSelector('.sound-row[data-kind="ping"][data-state="open"]')
    await waitSaved(win)
    h.assert(!('sounds' in h.readProject(home, id)), 'one undo step: no sounds left in the project')
    await rowOf(win, 'ping').locator('button.sound-play').focus()
    await win.keyboard.press('Control+y')
    await win.waitForSelector('.sound-row[data-kind="ping"][data-state="muted"]', { timeout: 5000 })

    // Duck the music: about 14 dB lower in the export.
    await rowOf(win, 'music').locator('button', { hasText: 'Duck' }).click()
    await win.waitForSelector('.sound-row[data-kind="music"][data-state="ducked"]')
    await waitSaved(win)
    saved = h.readProject(home, id)
    const duck = saved.sounds.spans.find((s) => s.action === 'duck')
    h.assert(duck, 'saved a duck')
    await win.evaluate(() => (window.__ramps = []))
    await rowOf(win, 'music').locator('button.sound-play').click()
    await win.waitForFunction(() => window.__ramps.some((v) => Math.abs(v - 0.2) < 1e-6), null, { timeout: 10000 })
    await shot(win, 'sound-finder-actions')
    const ducked = path.join(home, 'ducked.m4a')
    await exportM4a(app, win, ducked)
    const c = pcm(ducked)
    const drop = level(a, duck.start + 0.2, duck.end - 0.2) - level(c, duck.start + 0.2, duck.end - 0.2)
    console.log(`    music lowered by ${drop.toFixed(1)} dB`)
    h.assert(drop > 12.5 && drop < 15.5, `the music is about 14 dB lower: ${drop.toFixed(1)} dB`)

    // Restore the music; Cut the ding: an ordinary cut.
    await rowOf(win, 'music').locator('button', { hasText: 'Restore' }).click()
    await win.waitForSelector('.sound-row[data-kind="music"][data-state="open"]')
    await rowOf(win, 'ping').locator('button', { hasText: 'Restore' }).click()
    await win.waitForSelector('.sound-row[data-kind="ping"][data-state="open"]')
    await rowOf(win, 'ping').locator('button', { hasText: 'Cut' }).click()
    await win.waitForSelector('.sound-row[data-kind="ping"][data-state="cut"]')
    await waitSaved(win)
    saved = h.readProject(home, id)
    h.assert(saved.clips.length === 2 && Math.abs(saved.clips[0].end - span.start) < 1e-3 && Math.abs(saved.clips[1].start - span.end) < 1e-3, `cut out: ${JSON.stringify(saved.clips)}`)
    h.assert(!('sounds' in saved), 'a cut adds nothing else')
    await rowOf(win, 'ping').locator('button.sound-play').focus()
    await win.keyboard.press('Control+z')
    await win.waitForSelector('.sound-row[data-kind="ping"][data-state="open"]')

    // Ignore: off the list; Show ignored brings it back; undo too.
    await rowOf(win, 'music').locator('button', { hasText: 'Ignore' }).click()
    await win.waitForSelector('.sound-row[data-kind="music"]', { state: 'detached' })
    await waitSaved(win)
    h.assert(h.readProject(home, id).sounds?.ignored?.length === 1, 'saved as ignored')
    await win.locator('label.sound-show-ignored').click()
    await win.waitForSelector('.sound-row[data-kind="music"][data-state="ignored"]')
    await rowOf(win, 'music').locator('button', { hasText: 'Bring back' }).click()
    await win.waitForSelector('.sound-row[data-kind="music"][data-state="open"]')
    await waitSaved(win)
    h.assert(!('sounds' in h.readProject(home, id)), 'back to none')

    // Opened again: the list comes from the stored scores, without listening.
    await app.close()
    ctx.app = null
    const again = await openEditor(ctx, home, 'Sounds demo')
    await again.win.waitForSelector('[data-testid="sounds-status"][data-state="done"]', { timeout: 30000 })
    h.assert((await again.win.getAttribute('[data-testid="sounds-status"]', 'data-from')) === 'cache', 'shown from the stored scores')
    list = await rows(again.win)
    h.assert(list.some((r) => r.key === ding.key) && list.some((r) => r.key === music.key), 'the same rows')
  }))

  await test('sound finder: Cancel stops a long recording, keeps nothing, and the editor stays usable', fx.withHome('sf-cancel', async (ctx, home) => {
    const { dir } = seed(home, { id: 'rec-long', name: 'Long sounds', seconds: 24 * 25 })
    const { win } = await openEditor(ctx, home, 'Long sounds')
    await win.click('[data-testid="sounds-find"]')
    await win.waitForSelector('[data-testid="sounds-status"][data-state="listening"]', { timeout: 10000 })
    // Progress moves.
    await win.waitForFunction(() => Number(document.querySelector('.sounds-bar')?.getAttribute('aria-valuenow')) > 0, null, { timeout: 60000 })
    await shot(win, 'sound-finder-listening')
    await win.locator('[data-testid="sounds-status"] button', { hasText: 'Cancel' }).click()
    await win.waitForSelector('[data-testid="sounds-find"]', { timeout: 10000 })
    await h.sleep(1000)
    h.assert(!fs.existsSync(path.join(dir, '.cache', 'sounds.json')), 'nothing kept after Cancel')
    // The editor still responds: switch tabs and back.
    await win.click('.insp-tabs button:has-text("Style")')
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.waitForSelector('[data-testid="sounds-find"]')
  }))

  await test('sound finder: a recording without stems listens to its mixed track', fx.withHome('sf-mix', async (ctx, home) => {
    const { dir } = seed(home, { id: 'rec-mix', name: 'Mixed only', extra: { audioStems: undefined } })
    fs.rmSync(path.join(dir, 'mic.m4a'))
    fs.rmSync(path.join(dir, 'system.m4a'))
    const { win } = await openEditor(ctx, home, 'Mixed only')
    await win.click('[data-testid="sounds-find"]')
    await win.waitForSelector('[data-testid="sounds-status"][data-state="done"]', { timeout: 120000 })
    const list = await rows(win)
    h.assert(list.some((r) => r.kind === 'ping') && list.some((r) => r.kind === 'music'), `found on the mixed track: ${JSON.stringify(list)}`)
    const cache = JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'sounds.json'), 'utf8'))
    h.assert(Object.keys(cache.entries).join() === 'mix', 'kept for the mixed track')
  }))

  await test('sound finder: a recording without sound says so', fx.withHome('sf-silent', async (ctx, home) => {
    seed(home, { id: 'rec-silent', name: 'Silent one', extra: { hasAudio: false } })
    const { win } = await openEditor(ctx, home, 'Silent one')
    await section(win).locator('text=This recording has no sound.').waitFor()
    h.assert(!(await win.$('[data-testid="sounds-find"]')), 'no Find button')
  }))
}

main()
