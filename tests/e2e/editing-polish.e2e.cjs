// Editing polish (wave 10), end to end in the built app (docs/design/editing-polish.md §19.3):
// smooth cuts, the magnifier, animated callouts and the progress bar, colour and looks, the music
// and sound-effects library, Polish's Smooth cuts step and Review mode, keyboard and versions.
// Steps E1 to E18 are written by the parts (P1 to P5, §17) on this file.
//
// The data-testid values of §2 (frozen by the contracts commit; the UI parts use exactly these):
//
//   Clip tab, Cuts and Cut style (§2.1, part P1)
//     cuts-section            the section "Cuts" (shown when the video has a cut); its count line "37 cuts. …"
//     cut-every               select "Every cut": Hard cut, Smooth, Crossfade, Dip to colour, Slide, Punch-in
//     cut-smooth-all          button "Smooth all cuts" (disabled with its hint when nothing would change)
//     cut-same-style          button "Give them the same style" (with "3 cuts have their own style.")
//     cut-style-section       the section "Cut style" of a selected cut
//     cut-number              "Cut 5 of 37"
//     cut-prev / cut-next / cut-play   buttons Previous cut, Next cut, Play this cut
//     cut-style               radiogroup "Cut style"; each radio data-kind="same|cut|smooth|crossfade|dip|slide|punch"
//     cut-length              slider Length / Crossfade length ("0.15 seconds")
//     cut-punch-size          slider Punch-in size ("110 percent")
//     cut-dip-colour          radiogroup of swatches (Black, White, the brand colours, Other…)
//     cut-slide-from          radiogroup "Comes in from"
//     cut-here                the line "Here: a crossfade (…)" / "Here: a punch-in (…)"
//     cut-note                "(Crossfade while Calm motion is on)", "Shown as a crossfade so dips don't flash too often."
//   Timeline (§2.1, part P1)
//     cut-marker              each cut's 24 × 24 px button on the clip track; data-index, data-kind, aria-label "Cut 5 of 37: …"
//   Polish and Review (§2.7, part P1 and P4)
//     polish-row-smoothCuts   the Polish dialog's row (the dialog's polish-row-<step> pattern)
//     review chips            the Review panel's kinds 'join' ("Cuts") and 'colour' ("Colour")
//   Shapes and Zoom tabs, the magnifier (§2.2, part P2)
//     magnifier-add           button "Add magnifier"
//     magnifier-add-cursor    button "Add magnifier on the cursor"
//     zoom-add-magnifier      the Zoom tab's row "Show a detail larger without zooming:" with Add magnifier
//     magnifier-section       a selected magnifier's panel
//     magnifier-zoom          slider "Zoom" ("2 times")
//     magnifier-shape         chips Round, Rounded rectangle
//     magnifier-follows       chips A place on the screen, The cursor
//     magnifier-darkness      slider "Darkness"
//     magnifier-soft          the note "Shown larger than the recording's pixels: it may look soft."
//   Text tab, Chapters and Effects tab, the progress bar (§2.4, part P2)
//     progress-bar-toggle     switch "Progress bar on the video"
//     progress-bar-place      radiogroup Auto, Top, Bottom
//     progress-bar-look       radiogroup Floating, Edge
//     progress-bar-labels     radiogroup Current chapter, All chapters, None
//     progress-bar-colour     the colour swatches
//     progress-bar-only       switch "Show only when a chapter starts"
//     progress-bar-link       the Effects tab's row "Progress bar…"
//   Text and Shapes tabs, animated callouts (§2.3, part P3)
//     callout-section         the section "Animation"
//     callout-enter / callout-exit / callout-speed / callout-sound   Comes in, Goes out, Speed, Sound
//     callout-sound-play      the Sound row's Play toggle
//     add-step-badge          button "Add step badge"
//     add-speech-bubble       button "Add speech bubble"
//     badge-section           a selected badge's options
//     badge-number            radiogroup Automatic, Your own text; badge-text its field, badge-text-error its error
//     badge-count-with        radiogroup 1 2 3, A B C, ১ ২ ৩ (Bangla digits)…
//     badge-restart           switch "Restart at each chapter"; badge-start-from the number field
//     badge-colour            the swatches; badge-follows-zoom the switch "Follows the zoom"
//     bubble-section          a selected bubble's options; bubble-colour, bubble-tail
//     badge-handle / tail-handle   the preview's focusable handles ("Badge 3 on 52 %, 40 %", "Tail points to …")
//     calm-motion             the Effects tab's switch "Calm motion"
//   Effects and Camera tabs, colour (§2.5, part P4)
//     screen-colour-section   Effects tab "Screen colour"; camera-colour-section Camera tab "Colour"
//     colour-look             radiogroup of look chips; each chip data-look="none|natural|…"
//     colour-look-strength    slider Strength of the look
//     colour-slider-<key>     sliders temperature, tint, brightness, contrast, saturation, highlights, shadows, vibrance, exposure
//     colour-reset-<key>      each slider's Reset button ("Reset Temperature")
//     colour-more             the More disclosure
//     lut-import              button "Import a LUT (.cube)…"; lut-title, lut-size, lut-strength, lut-remove, lut-problem
//     colour-compare          toggle "Compare" (aria-pressed)
//     colour-reset            button "Reset colour"
//     auto-colour             button "Auto colour"
//     colour-cpu-note         the note shown without WebGL2
//   Audio tab and Settings › Downloads, music and effects (§2.6, part P5)
//     music-library           the Library list (role="list"); music-mood the mood radiogroup
//     music-row               each bed's row, data-bed=<catalogue id>; music-play, music-use, music-download, music-progress in it
//     music-credit            "Music: Sweet Sun by Loyalty Freak Music (CC0)"
//     music-own-file          button "Your own file…" (today's Choose music…)
//     sfx-section             the section "Sound effects"; sfx-volume its Volume slider
//     sfx-rule-<rule>         selects Zooming in, Zooming out, Title cards appear, Texts and shapes appear (zoomIn, zoomOut, titles, callouts)
//     sfx-play-<rule>, sfx-count-<rule>   each rule's Play button and "Plays 24 times"
//     sfx-soft-whoosh         the link "Soft whoosh when zooming in"
//     music-downloads         Settings › Downloads › More music; music-download-all, music-downloads-remove
//
// Commands (§2.8; no default keys): smoothAllCuts, hardCutsEverywhere, nextCut, previousCut, playCut,
// addMagnifier, addMagnifierCursor, addStepBadge, addSpeechBubble, toggleProgressBar, compareColour,
// autoColour, musicLibrary.

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

/** The app's own ffmpeg (as the audio-pack test decodes with it). */
const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const RATE = 48000

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/* ---------- part P5: music and sound effects (§2.6, §10) ---------- */

/** The catalogue's pins and loops, read from the source (the e2e runs as plain Node). */
function catalogue() {
  const src = fs.readFileSync(path.join(h.APP_DIR, 'src', 'shared', 'audio', 'soundLibrary.ts'), 'utf8')
  return JSON.parse(/\/\* prepared:begin \*\/([\s\S]*?)\/\* prepared:end \*\//.exec(src)[1])
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/** The first audio stream of `file` as mono float at 48 kHz (the mean of its channels). */
function pcm(file) {
  const out = execFileSync(FF, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length))
}
const rms = (s, from, to) => {
  let sum = 0
  const a = Math.round(from * RATE)
  const b = Math.round(to * RATE)
  for (let i = a; i < b; i++) sum += s[i] * s[i]
  return Math.sqrt(sum / Math.max(1, b - a))
}

async function openEditor(ctx, home, name, env = {}) {
  const { app, win, logs } = await h.launch({ home, env })
  ctx.app = app
  ctx.logs = logs
  await fx.openProject(win, name)
  await win.click('.insp-tabs button:has-text("Audio")')
  return { app, win }
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

const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const liveText = (win) => win.evaluate(() => document.querySelector('.music-library-section [role="status"]')?.textContent ?? '')

async function main() {
  /* ---------- E12 Music (part P5, §2.6, §10.4, §10.10) ---------- */

  await test('E12 music: Use Sweet Sun, the credit, a preview with Space and Esc, no step at the loop seam, and with Loop off it ends at 1:43.4', fx.withHome('ep-music', async (ctx, home) => {
    const pins = catalogue()
    const pin = pins['upbeat-sweet-sun']
    const E = pin.loopEnd
    fx.seedProject(home, { id: 'rec-music', name: 'Music library', media: fx.solidVideo({ seconds: 120, width: 640, height: 360 }), seconds: 120, width: 640, height: 360 })
    const { app, win } = await openEditor(ctx, home, 'Music library')
    const row = '[data-testid="music-row"][data-bed="upbeat-sweet-sun"]'
    await win.waitForSelector(row)
    // No download source yet (owner decision 1): the four bundled beds alone.
    h.assert((await win.locator('[data-testid="music-row"]').count()) === 4, 'the four bundled beds are listed, and no download row')
    // Space plays a preview, Esc in the list stops it; the live region says both.
    await win.focus(`${row} [data-testid="music-play"]`)
    await win.keyboard.press('Space')
    await win.waitForFunction(() => document.querySelector('.music-library-section [role="status"]')?.textContent === 'Playing preview: Sweet Sun, 1 minute 43 seconds', null, { timeout: 5000 })
    h.assert((await win.getAttribute(`${row} [data-testid="music-play"]`, 'aria-pressed')) === 'true', 'the Play toggle is pressed')
    await win.keyboard.press('Escape')
    await win.waitForFunction(() => document.querySelector('.music-library-section [role="status"]')?.textContent === 'Stopped', null, { timeout: 5000 })
    h.assert((await liveText(win)) === 'Stopped', 'Esc stopped the preview')
    // Use: the bed is copied in, checked, and is the music; the credit shows.
    await win.click(`${row} [data-testid="music-use"]`)
    await win.waitForSelector('[data-testid="music-credit"]')
    h.assert((await win.textContent('[data-testid="music-credit"]')) === 'Music: Sweet Sun by Loyalty Freak Music (CC0)', 'the credit names the bed')
    h.assert((await win.textContent(`${row} [data-testid="music-use"]`)) === 'In use', 'the row says In use')
    await waitSaved(win)
    const dir = path.join(h.projectsRoot(home), 'rec-music')
    const music = h.readProject(home, 'rec-music').audio.music
    h.assert(music.library?.id === 'upbeat-sweet-sun' && /^music-1\.ogg$/.test(music.path) && music.volume === 0.35 && music.loop === true, `the music is the bed: ${JSON.stringify(music)}`)
    h.assert(sha256(fs.readFileSync(path.join(dir, music.path))) === pin.sha256, 'the copy is the pinned file')
    // A 120 s export loops it from S with no step at the seam beyond 1.5 × the body's p99.9.
    const looped = path.join(home, 'looped.m4a')
    await exportM4a(app, win, looped)
    const s = pcm(looped)
    h.assert(Math.abs(s.length / RATE - 120) < 0.05, `the export is 120 s: ${s.length / RATE}`)
    const steps = []
    for (let i = Math.round(10 * RATE); i < Math.round(100 * RATE); i += 3) steps.push(Math.abs(s[i + 1] - s[i]))
    steps.sort((a, b) => a - b)
    const p999 = steps[Math.floor(steps.length * 0.999)]
    let seam = 0
    for (let i = E - 240; i < E + 240; i++) seam = Math.max(seam, Math.abs(s[i + 1] - s[i]))
    h.assert(seam <= 1.5 * p999, `the seam's step ${seam.toFixed(4)} is within 1.5 × the body's p99.9 ${p999.toFixed(4)}`)
    h.assert(rms(s, E / RATE + 1, E / RATE + 5) > 0.01, 'the music plays on after the seam')
    // Loop off: it ends at E / 48000 = 1:43.4, never the pad.
    await win.click('input[aria-label="Loop"]')
    await waitSaved(win)
    const once = path.join(home, 'once.m4a')
    await exportM4a(app, win, once)
    const t = pcm(once)
    h.assert(rms(t, 100, 103) > 0.01, 'the music plays to its end')
    h.assert(rms(t, E / RATE + 0.1, 119) < 1e-4, `silence after 1:43.4 (${rms(t, E / RATE + 0.1, 119)})`)
  }))

  /* ---------- E13 Downloads (part P5, §2.6, §10.3) ---------- */

  // The eight download beds' prepared files exist only outside the repository until their release
  // is made (owner decision 1): SSW_E2E_SOUND_RELEASE names the folder that holds them.
  const release = process.env.SSW_E2E_SOUND_RELEASE
  if (!release || !fs.existsSync(path.join(release, 'bed-upbeat-go-to-the-picnic.ogg'))) {
    console.log('SKIP E13 downloads: set SSW_E2E_SOUND_RELEASE to the folder of the prepared download beds')
  } else
    await test('E13 downloads: a bed downloads from the test server with progress through Download and use; a corrupted copy is refused and leaves no file', fx.withHome('ep-downloads', async (ctx, home) => {
      const good = fs.readFileSync(path.join(release, 'bed-upbeat-go-to-the-picnic.ogg'))
      const bad = Buffer.from(fs.readFileSync(path.join(release, 'bed-calm-old-key.ogg')))
      bad[bad.length >> 1] ^= 0xff
      const server = http.createServer((req, res) => {
        const name = decodeURIComponent((req.url ?? '').slice(1))
        const body = name === 'bed-upbeat-go-to-the-picnic.ogg' ? good : name === 'bed-calm-old-key.ogg' ? bad : null
        if (!body) {
          res.writeHead(404)
          return res.end()
        }
        // Slowly, in pieces, so the progress shows.
        res.writeHead(200, { 'content-length': String(body.length) })
        let at = 0
        const next = () => {
          if (at >= body.length) return res.end()
          res.write(body.subarray(at, at + 65536))
          at += 65536
          setTimeout(next, 30)
        }
        next()
      })
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      try {
        const base = `http://127.0.0.1:${server.address().port}`
        fx.seedProject(home, { id: 'rec-dl', name: 'Downloads', media: fx.solidVideo({ seconds: 4, width: 640, height: 360 }), seconds: 4, width: 640, height: 360 })
        const { win } = await openEditor(ctx, home, 'Downloads', { SSW_SOUND_BASE_URL: base })
        const row = '[data-testid="music-row"][data-bed="upbeat-go-to-the-picnic"]'
        await win.waitForSelector(row)
        h.assert((await win.locator('[data-testid="music-row"]').count()) === 12, 'with a source, all twelve beds are listed')
        h.assert((await win.getAttribute(`${row} [data-testid="music-play"]`, 'aria-disabled')) === 'true', 'Play is disabled before the download')
        h.assert((await win.textContent(row)).includes('Download to listen'), 'the row says Download to listen')
        await win.click(`${row} [data-testid="music-download"]`)
        await win.waitForSelector(`${row} [data-testid="music-progress"]`, { timeout: 10000 })
        await win.waitForFunction((sel) => document.querySelector(`${sel} [data-testid="music-use"]`)?.textContent === 'In use', row, { timeout: 60000 })
        await waitSaved(win)
        const music = h.readProject(home, 'rec-dl').audio.music
        h.assert(music.library?.id === 'upbeat-go-to-the-picnic', `the downloaded bed is in use: ${JSON.stringify(music)}`)
        const lib = path.join(home, '.config', 'Flown', 'sound-library')
        // A corrupted copy: the message, and no file left behind.
        const other = '[data-testid="music-row"][data-bed="calm-old-key"]'
        await win.click(`${other} [data-testid="music-download"]`)
        await win.waitForSelector('.music-library-section [role="alert"]', { timeout: 60000 })
        h.assert(/did not match the expected file/.test(await win.textContent('.music-library-section [role="alert"]')), 'the mismatch is explained')
        const left = fs.existsSync(lib) ? fs.readdirSync(lib).filter((f) => f.startsWith('bed-calm-old-key')) : []
        h.assert(left.length === 0, `no file of the corrupted bed is left: ${left.join(', ')}`)
      } finally {
        server.close()
      }
    }))

  /* ---------- E14 Effects (part P5, §2.6, §10.6) ---------- */

  await test('E14 effects: Soft whoosh when zooming in peaks at the zoom start + 0.35 s and nothing on zooming out; four zooms 1 s apart play 2 times', fx.withHome('ep-effects', async (ctx, home) => {
    const zoom = (id, start, end, extra = {}) => ({ id, start, end, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false, ...extra })
    fx.seedProject(home, { id: 'rec-fx', name: 'Effects', media: fx.solidVideo({ seconds: 8, width: 640, height: 360 }), seconds: 8, width: 640, height: 360, zooms: [zoom('z1', 2, 5)] })
    const { app, win } = await openEditor(ctx, home, 'Effects')
    await win.waitForSelector('[data-testid="sfx-section"]')
    await win.click('[data-testid="sfx-soft-whoosh"]')
    await win.waitForFunction(() => document.querySelector('[data-testid="sfx-rule-zoomIn"]')?.value === 'sfx:whoosh-soft')
    h.assert((await win.textContent('[data-testid="sfx-count-zoomIn"]')) === 'Plays once', 'the panel counts one whoosh')
    await waitSaved(win)
    h.assert(JSON.stringify(h.readProject(home, 'rec-fx').soundFx) === '{"zoomIn":"sfx:whoosh-soft"}', 'the rule is saved')
    // The silent recording exports with a soundtrack: the whoosh alone.
    const out = path.join(home, 'whoosh.m4a')
    await exportM4a(app, win, out)
    const s = pcm(out)
    let peak = 0
    let at = 0
    for (let i = 0; i < s.length; i++) {
      const w = Math.abs(s[i])
      if (w > peak) {
        peak = w
        at = i / RATE
      }
    }
    // Its loudest 10 ms, where the move in is fastest.
    let best = 0
    let centre = 0
    for (let i = Math.round(1.5 * RATE); i < Math.round(3 * RATE); i += 24) {
      const e = rms(s, i / RATE - 0.005, i / RATE + 0.005)
      if (e > best) {
        best = e
        centre = i / RATE
      }
    }
    h.assert(peak > 0.01, `the whoosh sounds (peak ${peak} at ${at})`)
    h.assert(Math.abs(centre - 2.35) <= 0.01, `the whoosh peaks at the zoom's start + 0.35 s: ${centre.toFixed(3)}`)
    h.assert(rms(s, 4, 8) < 1e-4, 'nothing on zooming out')
    // Four zooms 1 s apart: one whoosh every 3 s at most, so two.
    await ctx.app.close()
    ctx.app = null
    const file = path.join(h.projectsRoot(home), 'rec-fx', 'project.json')
    const p = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...p, zooms: [1, 2, 3, 4].map((k) => zoom(`q${k}`, k, k + 0.2, { transition: 0.4 })) }, null, 2))
    const again = await openEditor(ctx, home, 'Effects')
    await again.win.waitForSelector('[data-testid="sfx-count-zoomIn"]')
    h.assert((await again.win.textContent('[data-testid="sfx-count-zoomIn"]')) === 'Plays 2 times', 'four zooms 1 s apart play 2 times')
  }))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
