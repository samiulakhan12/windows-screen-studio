// Clean voice in the real built app (docs/design/clean-voice.md): the switch makes the cleaned
// stem once (progress, then ready), the preview plays it in place of the microphone (and plays
// the original with "Hear the original"), a strength is one undo step and comes back without a
// new render, the export is cleaner where there is only noise and keeps the voice, Cancel leaves
// nothing behind and Clean now finishes, a recording without stems cleans its mixed track, and a
// project without the setting opens unchanged. Keyboard only where it matters.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const sp = require('./speech-fixtures.cjs')
const fx = require('./render-fixtures.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const RATE = 48000
const SHOTS = process.env.SSW_E2E_SHOTS || null
/** A picture of the Audio panel's Voice section (docs/screenshots/clean-voice-*.png). */
async function shot(win, name) {
  if (!SHOTS) return
  const section = win.locator('section.insp-section:has(> h3:has-text("Voice"))')
  await section.scrollIntoViewIfNeeded()
  await h.sleep(200)
  await section.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const VOICE_RE = /^voice-[0-9a-f]{16}\.m4a$/
const voiceFiles = (dir) => fs.readdirSync(dir).filter((f) => VOICE_RE.test(f))
const partFiles = (dir) => fs.readdirSync(dir).filter((f) => /^voice-.*\.part\.m4a$/.test(f))
const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const status = (win) => win.getAttribute('[data-testid="voice-status"]', 'data-state').catch(() => null)
const waitStatus = (win, state, timeout = 60000) => win.waitForSelector(`[data-testid="voice-status"][data-state="${state}"]`, { timeout })
const toggle = (win) => win.locator('label.toggle:has-text("Clean voice") input')

/**
 * The first audio stream as one signal at 48 kHz: the mean of its channels, so a level reads as
 * heard on each side (a stereo export of mixed stems and a mono one of the mixed track compare
 * fairly; ffmpeg's -ac 1 would read the stereo one 3 dB louder).
 */
function pcm(file) {
  const n = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]).toString().trim())
  h.assert(n >= 1, `${file} has sound`)
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
  return 10 * Math.log10(sum / (b - a) + 1e-20)
}

async function openEditor(ctx, home, name) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  // Keep handles on the editor's (detached) media elements.
  await win.evaluate(() => {
    const create = document.createElement.bind(document)
    window.__media = []
    document.createElement = (tag, ...rest) => {
      const el = create(tag, ...rest)
      if (/^(video|audio)$/i.test(String(tag))) window.__media.push(el)
      return el
    }
  })
  await fx.openProject(win, name)
  await win.click('.insp-tabs button:has-text("Audio")')
  return { app, win }
}

/** The preview's audio elements with a file, by name: { src, paused, t }. */
const previewAudio = (win) =>
  win.evaluate(() =>
    window.__media
      .filter((m) => m.tagName === 'AUDIO' && m.getAttribute('src'))
      .map((m) => ({ file: decodeURIComponent(new URL(m.src).pathname.split('/').pop()), paused: m.paused, t: m.currentTime }))
  )

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

/** A long recording with stems (for Cancel): `seconds` of speech-like noise, a silent system stem, a small video. */
function longMedia(seconds) {
  const dir = path.join(fx.MEDIA_CACHE, `clean-voice-long-${seconds}`)
  const out = { mic: path.join(dir, 'mic.m4a'), system: path.join(dir, 'system.m4a'), screen: path.join(dir, 'screen.mp4') }
  if (Object.values(out).every((f) => fs.existsSync(f))) return out
  fs.mkdirSync(dir, { recursive: true })
  const ff = (args) => execFileSync(FF, ['-v', 'error', '-y', ...args])
  ff(['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:seed=2:d=${seconds}`, '-c:a', 'aac', '-b:a', '96k', `${out.mic}.part.m4a`])
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(seconds), '-c:a', 'aac', '-b:a', '32k', `${out.system}.part.m4a`])
  ff(['-f', 'lavfi', '-i', 'color=c=gray:size=320x180:rate=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', `${out.screen}.part.mp4`])
  for (const f of Object.values(out)) fs.renameSync(`${f}.part${path.extname(f)}`, f)
  return out
}

async function main() {
  await test('clean voice: the switch makes the stem, the preview plays it, A/B, a strength is one undo step, the export is cleaner', fx.withHome('cv-main', async (ctx, home) => {
    const id = sp.seedSpeechProject(home, { id: 'rec-voice', name: 'Voice demo' })
    const dir = path.join(h.projectsRoot(home), id)
    const { app, win } = await openEditor(ctx, home, 'Voice demo')

    // Before: the switch is off, nothing is made, and the plain export is the reference.
    await win.waitForSelector('text=Removes fan hum, keyboard and mouse clicks and room noise from your voice')
    h.assert(!(await toggle(win).isChecked()), 'Clean voice starts off')
    h.assert(!(await win.$('[data-testid="voice-status"]')), 'no status while it is off')
    await shot(win, 'clean-voice-off')
    const plain = path.join(home, 'plain.m4a')
    await exportM4a(app, win, plain)
    h.assert(voiceFiles(dir).length === 0, 'nothing is cleaned while the switch is off')

    // On: made once, ready, saved as one setting.
    await toggle(win).click()
    await waitStatus(win, 'ready')
    await waitSaved(win)
    h.assert(JSON.stringify(h.readProject(home, id).audio.voice) === JSON.stringify({ on: true, strength: 'normal' }), `saved: ${JSON.stringify(h.readProject(home, id).audio.voice)}`)
    const normal = voiceFiles(dir)
    h.assert(normal.length === 1 && partFiles(dir).length === 0, `one cleaned stem, no part file: ${fs.readdirSync(dir)}`)
    h.assert((await win.textContent('[data-testid="voice-status"]')).includes('Your voice is clean. The preview and the export use it.'), 'the panel says it is ready')
    await shot(win, 'clean-voice-ready')

    // The preview plays the cleaned stem, not the microphone stem.
    await win.keyboard.press('Home')
    await win.keyboard.press('Space')
    await h.sleep(1500)
    let els = await previewAudio(win)
    await win.keyboard.press('Space')
    const voiceEl = els.find((e) => e.file === normal[0])
    h.assert(voiceEl && !voiceEl.paused && voiceEl.t > 0.5, `the cleaned voice plays in the preview: ${JSON.stringify(els)}`)
    h.assert(!els.some((e) => e.file === 'mic.m4a' && !e.paused), `the original microphone does not play: ${JSON.stringify(els)}`)

    // Hear the original: the preview drops the cleaned stem; the setting is unchanged.
    const ab = win.locator('[data-testid="voice-status"] button', { hasText: 'Hear the original' })
    await ab.click()
    await win.waitForFunction(() => document.querySelector('[data-testid="voice-status"] button')?.getAttribute('aria-pressed') === 'true')
    h.assert((await win.textContent('[data-testid="voice-status"]')).includes('Playing the original voice. The export stays clean.'), 'the panel says the original plays')
    els = await previewAudio(win)
    h.assert(!els.some((e) => e.file === normal[0]), `the cleaned stem is not played while hearing the original: ${JSON.stringify(els)}`)
    await shot(win, 'clean-voice-original')
    // Enter on the focused button toggles it back (Space plays the video everywhere in the editor).
    await ab.focus()
    await win.keyboard.press('Enter')
    await win.waitForFunction(() => document.querySelector('[data-testid="voice-status"] button')?.getAttribute('aria-pressed') === 'false')
    h.assert(JSON.stringify(h.readProject(home, id).audio.voice) === JSON.stringify({ on: true, strength: 'normal' }), 'Hear the original is not an edit')

    // Strong: a second stem; undo returns to Normal at once (no new render), redo to Strong.
    // Strong, with the keyboard.
    await win.locator('.chips[aria-label="Strength"] .chip', { hasText: 'Strong' }).focus()
    await win.keyboard.press('Enter')
    await waitStatus(win, 'working', 5000).catch(() => undefined)
    await waitStatus(win, 'ready')
    await waitSaved(win)
    h.assert(h.readProject(home, id).audio.voice.strength === 'strong', 'Strong is saved')
    h.assert(voiceFiles(dir).length === 2, `a stem per strength: ${voiceFiles(dir)}`)
    const strongEx = path.join(home, 'strong.m4a')
    await exportM4a(app, win, strongEx)
    await win.locator('.chips[aria-label="Strength"] .chip', { hasText: 'Strong' }).focus()
    await win.keyboard.press('Control+z')
    await waitSaved(win)
    h.assert(h.readProject(home, id).audio.voice.strength === 'normal', `undo goes back to Normal: ${JSON.stringify(h.readProject(home, id).audio.voice)}`)
    await waitStatus(win, 'ready', 3000)
    h.assert(voiceFiles(dir).length === 2, 'undo needed no new stem')
    const cleanEx = path.join(home, 'clean.m4a')
    await exportM4a(app, win, cleanEx)

    // The export: the noise stretch (12-16 s: brown noise and key clicks) is much quieter, the speech keeps its level.
    const [p, c, s] = [plain, cleanEx, strongEx].map(pcm)
    const noise = (x) => level(x, 12.3, 15.7)
    const jfk = (x) => level(x, 2, 11)
    const ls = (x) => level(x, 16.5, 21.5)
    console.log(`  export levels (dBFS): plain noise ${noise(p).toFixed(1)}, Normal ${noise(c).toFixed(1)}, Strong ${noise(s).toFixed(1)}; speech JFK ${jfk(p).toFixed(1)} -> ${jfk(c).toFixed(1)} / ${jfk(s).toFixed(1)}, LibriSpeech ${ls(p).toFixed(1)} -> ${ls(c).toFixed(1)} / ${ls(s).toFixed(1)}`)
    h.assert(noise(p) - noise(c) >= 10, `Normal takes at least 10 dB off the noise (${noise(p).toFixed(1)} -> ${noise(c).toFixed(1)})`)
    h.assert(noise(p) - noise(s) >= 20, `Strong takes at least 20 dB off the noise (${noise(p).toFixed(1)} -> ${noise(s).toFixed(1)})`)
    for (const [name, x] of [['Normal', c], ['Strong', s]]) {
      h.assert(Math.abs(jfk(x) - jfk(p)) < 2 && Math.abs(ls(x) - ls(p)) < 2, `${name} keeps the speech's level`)
    }
    h.assert(Math.abs(p.length - c.length) <= 1, `the cleaned export is as long as the plain one (${p.length} / ${c.length})`)

    // Off: the export is the plain one again (the setting keeps the strength).
    await toggle(win).click()
    await waitSaved(win)
    h.assert(JSON.stringify(h.readProject(home, id).audio.voice) === JSON.stringify({ on: false, strength: 'normal' }), 'off keeps the strength')
    const offEx = path.join(home, 'off.m4a')
    await exportM4a(app, win, offEx)
    const o = pcm(offEx)
    h.assert(Math.abs(noise(o) - noise(p)) < 0.2, `switched off, the export has its noise back (${noise(o).toFixed(2)} / ${noise(p).toFixed(2)})`)
  }))

  await test('clean voice: Cancel stops the render and leaves nothing behind; Clean now finishes it', fx.withHome('cv-cancel', async (ctx, home) => {
    const media = longMedia(900)
    const id = 'rec-voice-long'
    const dir = path.join(h.projectsRoot(home), id)
    // A project saved with Clean voice on (Strong) whose stem was never made: opening it starts the render.
    sp.seedSpeechProject(home, { id, name: 'Long voice', extra: { duration: 900, clips: [{ id: 'c0', start: 0, end: 900, speed: 1 }], audio: { volume: 1, muted: false, voice: { on: true, strength: 'strong' } } } })
    for (const k of ['mic', 'system', 'screen']) {
      const file = path.join(dir, `${k}.${k === 'screen' ? 'mp4' : 'm4a'}`)
      fs.rmSync(file)
      fs.symlinkSync(media[k], file)
    }
    const { win } = await openEditor(ctx, home, 'Long voice')
    await waitStatus(win, 'working')
    await win.waitForFunction(() => /Cleaning your voice… [1-9]/.test(document.querySelector('[data-testid="voice-status"]')?.textContent ?? ''), null, { timeout: 30000 })
    h.assert(await win.$('[data-testid="voice-status"] [role="progressbar"]'), 'a progress bar shows')
    await shot(win, 'clean-voice-working')
    const action = win.locator('[data-testid="voice-status"] button')
    await action.focus()
    await win.keyboard.press('Enter')
    await waitStatus(win, 'stopped', 15000)
    h.assert((await win.textContent('[data-testid="voice-status"]')).includes('Cleaning stopped.'), 'the panel says it stopped')
    h.assert((await action.textContent()) === 'Clean now', 'Clean now is offered')
    h.assert(await win.evaluate(() => document.activeElement?.textContent === 'Clean now'), 'the focus stays on the button')
    h.assert(voiceFiles(dir).length === 0 && partFiles(dir).length === 0, `nothing is left behind: ${fs.readdirSync(dir)}`)
    // The preview does not start it again by itself.
    await h.sleep(1500)
    h.assert((await status(win)) === 'stopped', 'stopped stays stopped')
    await win.keyboard.press('Enter')
    await waitStatus(win, 'working', 5000)
    await waitStatus(win, 'ready', 180000)
    h.assert(voiceFiles(dir).length === 1 && partFiles(dir).length === 0, 'Clean now made the stem')
  }))

  await test('clean voice: a recording without stems cleans its mixed track; a muted microphone has nothing to clean; an older project opens unchanged', fx.withHome('cv-mixed', async (ctx, home) => {
    const id = sp.seedSpeechProject(home, { id: 'rec-mixed', name: 'Mixed voice', stems: false })
    const stems = sp.seedSpeechProject(home, { id: 'rec-muted', name: 'Muted mic', extra: { audio: { volume: 1, muted: false, mic: { volume: 1, muted: true } } } })
    const dir = path.join(h.projectsRoot(home), id)
    const mutedFile = path.join(h.projectsRoot(home), stems, 'project.json')
    const before = fs.readFileSync(mutedFile)
    const { app, win } = await openEditor(ctx, home, 'Mixed voice')
    await win.waitForSelector("text=This recording keeps your microphone and the PC's sound together, so both are cleaned.")
    await toggle(win).click()
    await waitStatus(win, 'ready')
    h.assert(voiceFiles(dir).length === 1, 'the mixed track is cleaned')
    await shot(win, 'clean-voice-mixed')
    // The preview plays the cleaned file instead of the video's own track.
    await win.keyboard.press('Home')
    await win.keyboard.press('Space')
    await h.sleep(1200)
    const els = await previewAudio(win)
    await win.keyboard.press('Space')
    h.assert(els.some((e) => e.file === voiceFiles(dir)[0] && !e.paused), `the cleaned mixed track plays: ${JSON.stringify(els)}`)
    const out = path.join(home, 'mixed.m4a')
    await exportM4a(app, win, out)
    const s = pcm(out)
    h.assert(level(s, 12.3, 15.7) < -40, `the exported noise stretch is quiet (${level(s, 12.3, 15.7).toFixed(1)} dBFS)`)
    await app.close()
    ctx.app = null

    // A project whose microphone is muted: nothing to clean, and opening it changes nothing.
    const again = await openEditor(ctx, home, 'Muted mic')
    await again.win.waitForSelector('text=The microphone is muted or was not recorded, so there is no voice to clean.')
    h.assert(await toggle(again.win).isDisabled(), 'the switch is off and disabled')
    await h.sleep(1500)
    // (The editor itself corrects the fixture's duration to its video's frames and saves that: not this feature.)
    const after = JSON.parse(fs.readFileSync(mutedFile, 'utf8'))
    h.assert(JSON.stringify(after.audio) === JSON.stringify(JSON.parse(before.toString()).audio), `the sound settings are unchanged: ${JSON.stringify(after.audio)}`)
    h.assert(voiceFiles(path.join(h.projectsRoot(home), stems)).length === 0, 'nothing is cleaned')
  }))
}

main()
