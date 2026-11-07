// Editing polish (wave 10), end to end in the built app (docs/design/editing-polish.md §19.3):
// smooth cuts, the magnifier, animated callouts and the progress bar, colour and looks, the music
// and sound-effects library, Polish's Smooth cuts step and Review mode, keyboard and versions.
// Steps E2 to E16 are written by the parts (P1 to P5, §17); E1, E17 and E18, which span the parts,
// are in editing-polish-whole.cjs.
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
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** Merges `extra` into a seeded project.json (the shared fixtures do not know wave 10's fields). */
function patchProject(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

/** Exports the open project's library entry `name` at `res` and `fps` to `out`, then goes back Home. */
async function exportMp4(app, win, name, out, res, fps) {
  await fx.openProject(win, name)
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', res)
  await fx.pickChip(win, 'Frame rate', fps)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${name}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

/** A 60 fps checkerboard of 8 px squares, 1280 x 720 unless said (cached like the shared fixtures). */
function checkerVideo(seconds, width = 1280, height = 720) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `checker8-${seconds}s-${width}x${height}.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  const lum = "if(mod(floor(X/8)+floor(Y/8)\\,2)\\,20\\,235)"
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}:r=60`, '-t', String(seconds), '-vf', `format=yuv444p,geq=lum='${lum}':cb=128:cr=128,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '15', tmp])
  fs.renameSync(tmp, file)
  return file
}

const luma = (buf, w, x, y) => {
  const i = (y * w + x) * 3
  return 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]
}

/** Light/dark changes along row `y` from x0 to x1 (threshold 128). */
function transitions(buf, w, y, x0, x1) {
  let n = 0
  let prev = luma(buf, w, x0, y) > 128
  for (let x = x0 + 1; x < x1; x++) {
    const v = luma(buf, w, x, y) > 128
    if (v !== prev) n++
    prev = v
  }
  return n
}

/** Mean gradient energy inside a box (px): a blur makes it much lower. */
function sharpness(buf, w, x0, y0, x1, y1) {
  let s = 0
  let n = 0
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const v = luma(buf, w, x, y)
      s += (luma(buf, w, x + 1, y) - v) ** 2 + (luma(buf, w, x, y + 1) - v) ** 2
      n++
    }
  }
  return s / n
}

/** Mean luma of the pixels whose distance from (cx, cy) is in [r0, r1). */
function annulus(buf, w, cx, cy, r0, r1) {
  let s = 0
  let n = 0
  for (let y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++) {
    for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d >= r0 && d < r1) {
        s += luma(buf, w, x, y)
        n++
      }
    }
  }
  return s / n
}

/* ---------- E7 Callouts (part P3, §2.3, §7) ---------- */

/** A 30 fps grey recording with a green "secret" square at (800, 200), 80 px across (cached like the shared fixtures). */
function squareVideo(seconds) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `green-square-${seconds}s-1280x720.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x404040:s=1280x720:r=30', '-t', String(seconds), '-vf', 'drawbox=x=800:y=200:w=80:h=80:color=0x00c000:t=fill', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '15', '-pix_fmt', 'yuv420p', tmp])
  fs.renameSync(tmp, file)
  return file
}

const px = (buf, w, x, y) => {
  const i = (y * w + x) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}

/** The centroid of the pixels of `buf` (w × h) that `test` picks, inside `box` [x0, y0, x1, y1] (the whole frame by default). */
function centroid(buf, w, h, test, box = [0, 0, w, h]) {
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = box[1]; y < box[3]; y++) {
    for (let x = box[0]; x < box[2]; x++) {
      if (!test(px(buf, w, x, y))) continue
      sx += x
      sy += y
      n++
    }
  }
  return n ? { x: sx / n, y: sy / n, n } : null
}
const isGreen = ([r, g, b]) => g > 140 && r < 90 && b < 90
const isBadgeBlue = ([r, g, b]) => b > 170 && r < 60 && g > 60 && g < 140
const isRed = ([r, g, b]) => r > 170 && g < 90 && b < 90

/** The label's light pixels in a square of side `d` around (cx, cy): a mask (1 light, 0 not). */
function labelMask(buf, w, cx, cy, d) {
  const out = []
  const r = Math.floor(d / 2)
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    const [R, G, B] = px(buf, w, Math.round(cx) + x, Math.round(cy) + y)
    // Inside the ring only (0.8 of the radius), so the white ring is left out.
    out.push(x * x + y * y < (0.8 * r) ** 2 && 0.299 * R + 0.587 * G + 0.114 * B > 170 ? 1 : 0)
  }
  return out
}
const iou = (a, b) => {
  let i = 0
  let u = 0
  for (let k = 0; k < a.length; k++) {
    if (a[k] && b[k]) i++
    if (a[k] || b[k]) u++
  }
  return u ? i / u : 0
}

/**
 * A badge drawn in the page with the callout font (the text font, then the bundled script fonts the
 * export loaded): its label's mask, the reference the exported glyphs are compared with.
 */
async function referenceMask(win, label, size) {
  const data = await win.evaluate(
    ({ label, size }) => {
      const d = Math.round(1.75 * size)
      const c = document.createElement('canvas')
      c.width = c.height = d + 1
      const g = c.getContext('2d')
      g.fillStyle = '#0060df'
      g.fillRect(0, 0, c.width, c.height)
      const ids = ['noto-sans-bengali', 'noto-sans-devanagari', 'noto-sans-arabic', 'noto-sans-hebrew', 'noto-sans-thai', 'noto-color-emoji']
      g.font = `700 ${size}px 'Segoe UI', system-ui, sans-serif, ${ids.map((id) => `"FlownCat-${id}"`).join(', ')}`
      g.fillStyle = '#ffffff'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(label, c.width / 2, c.height / 2)
      return Array.from(g.getImageData(0, 0, c.width, c.height).data)
    },
    { label, size }
  )
  const d = Math.round(1.75 * size) + 1
  const rgb = Buffer.alloc(d * d * 3)
  for (let i = 0; i < d * d; i++) {
    rgb[i * 3] = data[i * 4]
    rgb[i * 3 + 1] = data[i * 4 + 1]
    rgb[i * 3 + 2] = data[i * 4 + 2]
  }
  return labelMask(rgb, d, d / 2, d / 2, Math.round(1.75 * size))
}
/** The app's own ffmpeg (as the audio-pack test decodes with it). */
const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const RATE = 48000


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
  // E1 (old projects) first; E17 and E18 at the end (editing-polish-whole.cjs).
  const whole = require('./editing-polish-whole.cjs')
  await whole.oldProjectStep(test)

  // P1, smooth cuts: E2, E3, E4, E5, E15 and E16 (editing-polish-cuts.cjs).
  await require('./editing-polish-cuts.cjs').cutsSteps(test)

  /* ---------- E6 Magnifier (part P2, §2.2, §6) ---------- */

  await test('E6 magnifier: added on the cursor at 2 times from the Shapes tab; the Zoom tab offers it too', fx.withHome('ep-magnifier-ui', async (ctx, home) => {
    // A 1920 x 1080 recording in a 1080p frame without padding: shown 1:1, so the zoom picked is 2.
    const media = checkerVideo(4, 1920, 1080)
    const still = [{ t: 0, x: 0.5, y: 0.5 }, { t: 4, x: 0.5, y: 0.5 }]
    fx.seedProject(home, {
      id: 'rec-mag-ui',
      name: 'Magnifier UI',
      media,
      seconds: 4,
      width: 1920,
      height: 1080,
      capture: { method: 'native', cursorInVideo: false, region: null },
      cursorSettings: { show: true, size: 1.4, smoothing: 0.5, clickEffect: false, hideWhenIdle: false },
      cursor: { samples: still, clicks: [], keys: [], shapes: [], scale: 1, valid: true }
    })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Magnifier UI')
    await win.click('.insp-tabs button:has-text("Zoom")')
    await win.waitForSelector('[data-testid="zoom-add-magnifier"]')
    h.assert((await win.textContent('[data-testid="zoom-add-magnifier"]')).includes('Show a detail larger without zooming:'), 'the Zoom tab has the row')
    await win.click('.insp-tabs button:has-text("Shapes")')
    await win.click('[data-testid="magnifier-add-cursor"]')
    const p = await f.waitFor(
      () => {
        try {
          const q = h.readProject(home, 'rec-mag-ui')
          return q.spotlights && q.spotlights.length === 1 ? q : null
        } catch {
          return null
        }
      },
      'saved: the magnifier',
      10000
    )
    const s = p.spotlights[0]
    console.log(`  magnifier ${JSON.stringify(s)}`)
    h.assert(s.magnify === 2, `2 times on a recording shown 1:1 (${s.magnify})`)
    h.assert(s.mode === 'cursor' && s.dim === 0 && s.feather === 0 && s.shape === 'ellipse', 'round, on the cursor, no darkness')
    h.assert(Math.abs(s.x + s.w / 2 - 0.5) < 0.005 && Math.abs(s.y + s.h / 2 - 0.5) < 0.005, 'centred on the cursor')
    h.assert(Math.abs(s.end - s.start - 3) < 1e-6, '3 s long')
    h.assert(Math.abs(s.h - 0.3) < 1e-6 && Math.abs(s.w * 1920 - 0.3 * 1080) < 1e-3, `0.30 S across (${(s.h * 1080).toFixed(1)} px)`)
    await win.waitForSelector('[data-testid="magnifier-section"]')
    h.assert((await win.getAttribute('[data-testid="magnifier-zoom"]', 'aria-valuetext')) === '2 times', 'the Zoom slider says "2 times"')
    // The keyboard: Page Up is a whole step, and it is one undo step.
    await win.focus('[data-testid="magnifier-zoom"]')
    await win.keyboard.press('PageUp')
    await f.waitFor(() => (h.readProject(home, 'rec-mag-ui').spotlights[0].magnify === 3 ? true : null), 'saved: 3 times', 10000)
    h.assert((await win.getAttribute('[data-testid="magnifier-zoom"]', 'aria-valuetext')) === '3 times', 'Page Up: "3 times"')
    await f.waitFor(async () => (await win.$('[title^="Magnifier, 3 times"]')) !== null, 'the timeline block named "Magnifier, 3 times"', 10000)
  }))

  await test('E6 magnifier: larger squares in the lens, a blur under it stays blurred, no bright ring while it grows (export)', fx.withHome('ep-magnifier-export', async (ctx, home) => {
    const media = checkerVideo(4)
    const W = 1280
    const H = 720
    // A round lens on (0.25, 0.5), 0.30 S across, 2 times, Darkness 30 %, from 1 s to 3.5 s.
    const w = (0.3 * H) / W
    const lens = { id: 'm', mode: 'region', start: 1, end: 3.5, x: 0.25 - w / 2, y: 0.35, w, h: 0.3, shape: 'ellipse', dim: 0.3, feather: 0, magnify: 2 }
    const blur = { id: 'b', kind: 'blur', start: 0, end: 4, x: 0.22, y: 0.46, w: 0.06, h: 0.08, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 1 }
    const seed = (id, name, extra) => {
      fx.seedProject(home, { id, name, media, seconds: 4 })
      patchProject(home, id, extra)
    }
    seed('rec-lens-blur', 'Lens and blur', { spotlights: [lens], shapes: [blur] })
    seed('rec-lens', 'Lens', { spotlights: [lens] })
    seed('rec-plain', 'Plain checker', {})
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const outs = { blur: path.join(home, 'lens-blur.mp4'), lens: path.join(home, 'lens.mp4'), plain: path.join(home, 'plain.mp4') }
    await exportMp4(app, win, 'Lens and blur', outs.blur, '720p', '60 fps')
    await exportMp4(app, win, 'Lens', outs.lens, '720p', '60 fps')
    await exportMp4(app, win, 'Plain checker', outs.plain, '720p', '60 fps')
    const full = 120 // 2.0 s: fully grown
    const growing = 62 // 1.033 s: growing (r < 1)
    const read = (file) => fx.framesAt(file, [growing, full], 'rgb24')
    const B = read(outs.blur)
    const L = read(outs.lens)
    const P = read(outs.plain)
    if (SHOTS) for (const [k, file] of Object.entries(outs)) fx.savePng(file, full, path.join(SHOTS, `magnifier-${k}.png`))
    const cx = Math.round(0.25 * W)
    const cy = Math.round(0.5 * H)
    const R = (0.3 * H) / 2
    // The checker's period inside the lens is twice what it is outside it (8 px squares shown 16 px).
    const row = cy - 60
    const inside = transitions(L.frames[1], W, row, cx - 60, cx + 60)
    const outside = transitions(L.frames[1], W, row, 800, 920)
    console.log(`  transitions over 120 px: inside the lens ${inside}, outside ${outside}`)
    h.assert(inside / outside > 0.4 && inside / outside < 0.6, `larger squares inside the lens (${inside} vs ${outside})`)
    // The blur box, magnified: still blurred inside the lens.
    const box = [cx - 40, cy - 30, cx + 40, cy + 30]
    const sharpBlur = sharpness(B.frames[1], W, ...box)
    const sharpLens = sharpness(L.frames[1], W, ...box)
    console.log(`  sharpness in the magnified blur box: ${sharpBlur.toFixed(1)} (without the blur ${sharpLens.toFixed(1)})`)
    h.assert(sharpBlur < sharpLens * 0.35, 'the blurred area stays hidden inside the lens')
    // Darkness 30 % while the lens grows: just inside the full lens's edge (outside the growing lens) is dimmed like the rest.
    const ring = annulus(L.frames[0], W, cx, cy, R * 0.9, R * 0.97) / annulus(P.frames[0], W, cx, cy, R * 0.9, R * 0.97)
    const far = annulus(L.frames[0], W, cx, cy, R * 1.6, R * 1.9) / annulus(P.frames[0], W, cx, cy, R * 1.6, R * 1.9)
    console.log(`  growing: brightness near the full lens edge x${ring.toFixed(3)}, further out x${far.toFixed(3)}`)
    h.assert(far < 0.9, `the darkness is on while it grows (x${far.toFixed(3)})`)
    h.assert(Math.abs(ring - far) < 0.06, `no bright ring around the growing lens (x${ring.toFixed(3)} vs x${far.toFixed(3)})`)
  }))

  /* ---------- E8 Progress bar (part P2, §2.4, §8) ---------- */

  await test('E8 progress bar: at the top with bottom captions, fills linearly, hidden under the intro card, names readable on a phone (export)', fx.withHome('ep-progress-bar', async (ctx, home) => {
    const W = 1920
    const H = 1080
    const media = fx.solidVideo({ seconds: 8, width: W, height: H, color: '404040' })
    fx.seedProject(home, { id: 'rec-bar', name: 'Progress bar', media, seconds: 8, width: W, height: H })
    patchProject(home, 'rec-bar', {
      chapters: [
        { id: 'c1', t: 0, title: 'Intro' },
        { id: 'c2', t: 3, title: 'Middle chapter' },
        { id: 'c3', t: 5.5, title: 'অধ্যায় তিন' }
      ],
      titles: [{ id: 't1', start: 0, end: 1.2, title: 'Welcome', style: 'centered', background: 'solid', color: '#123456' }],
      transcript: { provider: 'openai', model: 'test-model', createdAt: '2026-10-01T09:00:00.000Z', language: 'en', segments: [{ id: 's1', start: 1.5, end: 7.5, text: 'Captions sit at the bottom' }] },
      captions: { show: true, preset: 'clean', position: 'bottom', size: 0.045, color: '#ffffff', highlightColor: '#facc15', background: 'box', maxLines: 2 },
      chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' }
    })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = path.join(home, 'bar.mp4')
    await exportMp4(app, win, 'Progress bar', out, '1080p', '30 fps')
    const at = (t) => Math.round(t * 30)
    const idx = [at(0.6), at(2), at(4)]
    const F = fx.framesAt(out, idx, 'rgb24')
    h.assert(F.width === W && F.height === H, `1080p export (${F.width}x${F.height})`)
    const S = 1080
    const i = 0.03 * S
    const th = 0.008 * S
    const x0 = i
    const L = W - 2 * i
    const barY = Math.round(i + th / 2)
    /** The played part's right end on the bar's middle row (the played part is white, the rest grey). */
    const playedEnd = (buf) => {
      let end = -1
      for (let x = Math.ceil(x0); x < W - i; x++) if (luma(buf, W, x, barY) > 200) end = x
      return end
    }
    const whiteIn = (buf, y0, y1) => {
      let n = 0
      for (let y = y0; y < y1; y++) for (let x = 0; x < W; x += 2) if (luma(buf, W, x, y) > 200) n++
      return n
    }
    // Under the full-frame intro card the bar is hidden.
    h.assert(whiteIn(F.frames[0], 0, Math.ceil(i + 2 * th)) < 10, 'hidden under the intro title card')
    // At the top (the captions are at the bottom): the played part ends where the video time puts it.
    const g = Math.max(2, 0.005 * S)
    const expect2 = x0 + (L * 2) / 8 // first segment [0, 3): no inner gap before 2 s
    const seg1x0 = x0 + (L * 3) / 8 + g / 2
    const seg1x1 = x0 + (L * 5.5) / 8 - g / 2
    const expect4 = seg1x0 + ((seg1x1 - seg1x0) * (4 - 3)) / 2.5
    const e2 = playedEnd(F.frames[1])
    const e4 = playedEnd(F.frames[2])
    console.log(`  played part ends at ${e2} px (2 s, expected ${expect2.toFixed(1)}) and ${e4} px (4 s, expected ${expect4.toFixed(1)})`)
    h.assert(Math.abs(e2 - expect2) < 6 && Math.abs(e4 - expect4) < 6, 'the fill is linear in video time, split at the chapters')
    h.assert(whiteIn(F.frames[1], H - Math.ceil(i + 2 * th), H) === 0 || whiteIn(F.frames[1], Math.ceil(i - 2), Math.ceil(i + 2 * th)) > 100, 'the bar is at the top')
    // The captions keep clear of the bar's band (they sit at the bottom, under the band's text area).
    const band = i + 1.5 * th + 0.01 * S + 1.4 * 0.042 * S
    h.assert(whiteIn(F.frames[1], Math.ceil(band), Math.floor(H / 2)) === 0, 'nothing else drawn between the bar and the middle')
    // On a phone held upright (390 px wide), the current chapter's name has a cap height of at least 6 px.
    const dir = SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-progress-bar-'))
    const phone = path.join(dir, 'progress-bar-390.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', `select=eq(n\\,${at(4)}),scale=390:-1:flags=area`, '-frames:v', '1', phone])
    console.log(`  saved for a person to look at: ${phone}`)
    const scale = 390 / W
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', `select=eq(n\\,${at(4)}),scale=390:-1:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
    const pw = 390
    // The name's pill starts at the current segment (clamped inside the bar); its first letter, "M", 0.5 em in.
    const px = 0.042 * S
    const pillY0 = i + 1.5 * th + 0.01 * S
    const mx0 = Math.floor((seg1x0 + 0.5 * px + 2) * scale)
    const mx1 = Math.ceil((seg1x0 + 0.5 * px + 0.7 * px) * scale)
    let top = Infinity
    let bottom = -1
    for (let y = Math.floor(pillY0 * scale); y < Math.ceil((pillY0 + 1.4 * px) * scale); y++) {
      for (let x = mx0; x < mx1; x++) {
        if (luma(raw, pw, x, y) > 120) {
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
        }
      }
    }
    const cap = bottom - top + 1
    console.log(`  cap height of the chapter name at 390 px wide: ${cap} px`)
    h.assert(cap >= 6, `the chapter name is readable on a phone (cap height ${cap} px)`)
  }))

  await test('E8 progress bar: keeps moving through a pause freeze (export, needs the export\'s video time)', fx.withHome('ep-progress-bar-hold', async (ctx, home) => {
    const W = 1280
    const H = 720
    const media = fx.solidVideo({ seconds: 4, width: W, height: H, color: '404040' })
    fx.seedProject(home, { id: 'rec-bar-hold', name: 'Bar hold', media, seconds: 4 })
    patchProject(home, 'rec-bar-hold', { freezes: [{ id: 'f', at: 2, length: 1, sound: 'pause' }], chapterBar: { show: true, place: 'top', style: 'float', labels: 'none' } })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = path.join(home, 'bar-hold.mp4')
    await exportMp4(app, win, 'Bar hold', out, '720p', '30 fps')
    // Video time 2.0..3.0 holds the frame of 2 s: the bar's fill still moves, linearly.
    const F = fx.framesAt(out, [66, 75, 84], 'rgb24')
    const S = 720
    const i = 0.03 * S
    const barY = Math.round(i + (0.008 * S) / 2)
    const ends = F.frames.map((buf) => {
      let end = -1
      for (let x = Math.ceil(i); x < W - i; x++) if (luma(buf, W, x, barY) > 200) end = x
      return end
    })
    const L = W - 2 * i
    const want = [66, 75, 84].map((n) => i + (L * (n / 30)) / 5)
    console.log(`  played part ends in the hold: ${ends.join(', ')} (expected ${want.map((v) => v.toFixed(1)).join(', ')})`)
    ends.forEach((e, k) => h.assert(Math.abs(e - want[k]) < 6, `the fill moves through the hold (${e} vs ${want[k].toFixed(1)})`))
  }))

  /* ---------- E7 Callouts (part P3, §2.3, §7) ---------- */

  await test('E7 callouts: badges count 1 2 (and ১ ২), a pinned badge stays on its spot through a moving zoom, an arrow draws itself, a Bangla bubble points at its spot (export)', fx.withHome('ep-callouts-export', async (ctx, home) => {
    const media = squareVideo(7)
    const W = 1280
    const H = 720
    const pop = { kind: 'pop', duration: 0.24, strength: 1 }
    const fade = { kind: 'fade', duration: 0.18, strength: 1 }
    const badge = (id, start, end, extra) => ({ id, start, end, text: '', x: 0.2, y: 0.8, size: 0.045, style: 'badge', number: 'auto', enter: pop, exit: fade, ...extra })
    const square = { x: 840 / W, y: 240 / H }
    const annotations = (numbering) => [
      // Pinned on the green square, through a zoom that moves in and out while it shows.
      badge('pinned', 0.5, 6.8, { pin: square, x: square.x, y: square.y, ...(numbering ? { numbering } : {}) }),
      badge('second', 1, 6.8, { x: 0.2, y: 0.8, ...(numbering ? { numbering } : {}) }),
      { id: 'bubble', start: 0.5, end: 6.8, text: 'এখানে ক্লিক করুন', x: 0.39, y: 0.5, size: 0.045, style: 'bubble', pin: { x: 0.3, y: 0.6 }, body: { dx: 0.12, dy: -0.1 }, enter: { kind: 'pop', duration: 0.26, strength: 1 }, exit: { kind: 'pop', duration: 0.18, strength: 0.25 } }
    ]
    const zooms = [{ id: 'z', start: 1.5, end: 4, scale: 1.8, focus: { mode: 'fixed', x: 0.62, y: 0.35 }, transition: 0.8, auto: false }]
    const arrow = { id: 'arrow', kind: 'arrow', start: 4.9, end: 6.8, x: 0.4, y: 0.5, w: 0.3, h: 0.1, color: '#ff0000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5, enter: { kind: 'draw', duration: 0.35, strength: 1 }, exit: fade }
    // Names that are not part of each other (the library is searched by text).
    fx.seedProject(home, { id: 'rec-callouts', name: 'Zoomed callouts', media, seconds: 7 })
    patchProject(home, 'rec-callouts', { annotations: annotations(null), zooms, shapes: [arrow] })
    fx.seedProject(home, { id: 'rec-callouts-bn', name: 'Bangla badges', media, seconds: 7 })
    patchProject(home, 'rec-callouts-bn', { annotations: annotations('bn') })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = path.join(home, 'callouts.mp4')
    const outBn = path.join(home, 'callouts-bn.mp4')
    await exportMp4(app, win, 'Zoomed callouts', out, '720p', '30 fps')
    await exportMp4(app, win, 'Bangla badges', outBn, '720p', '30 fps')
    const fps = 30
    const times = [1.0, 1.7, 1.95, 2.2, 3.0, 3.5, 3.85, 4.4, 5.0, 5.3]
    const F = fx.framesAt(out, times.map((t) => Math.round(t * fps)), 'rgb24')
    h.assert(F.width === W && F.height === H, `720p export (${F.width}x${F.height})`)
    if (SHOTS) for (const t of [1.0, 2.2, 5.0, 5.3]) fx.savePng(out, Math.round(t * fps), path.join(SHOTS, `callouts-${t}.png`))

    // The pinned badge on the green square through the zoom (within 2 px).
    times.forEach((t, i) => {
      const buf = F.frames[i]
      const green = centroid(buf, W, H, isGreen)
      h.assert(green, `the green square shows at ${t} s`)
      const r = 120
      const box = [Math.max(0, Math.round(green.x - r)), Math.max(0, Math.round(green.y - r)), Math.min(W, Math.round(green.x + r)), Math.min(H, Math.round(green.y + r))]
      const blue = centroid(buf, W, H, isBadgeBlue, box)
      h.assert(blue && blue.n > 200, `the pinned badge shows at ${t} s`)
      const off = Math.hypot(blue.x - green.x, blue.y - green.y)
      console.log(`  ${t.toFixed(2)} s: square (${green.x.toFixed(1)}, ${green.y.toFixed(1)}), badge (${blue.x.toFixed(1)}, ${blue.y.toFixed(1)}), ${off.toFixed(2)} px apart`)
      h.assert(off <= 2, `the pinned badge stays on the square at ${t} s (${off.toFixed(2)} px)`)
    })

    // The badges count 1 and 2 (and ১ and ২ with Bangla): their glyphs match a reference drawn in the page.
    const size = 0.045 * H
    const d = Math.round(1.75 * size)
    // Both at rest (the second popped in from 1 s), before the zoom starts.
    const at = 1.4
    const [E] = fx.framesAt(out, [Math.round(at * fps)], 'rgb24').frames
    const [B] = fx.framesAt(outBn, [Math.round(at * fps)], 'rgb24').frames
    const pinned = { x: square.x * W, y: square.y * H }
    const second = { x: 0.2 * W, y: 0.8 * H }
    /** The badge's centre: the middle of its blue disc's bounds (the label's own shape does not pull it). */
    const centre = (buf, p) => {
      let x0 = W
      let y0 = H
      let x1 = 0
      let y1 = 0
      for (let y = Math.round(p.y - d); y < Math.round(p.y + d); y++)
        for (let x = Math.round(p.x - d); x < Math.round(p.x + d); x++) {
          if (!isBadgeBlue(px(buf, W, x, y))) continue
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x)
          y1 = Math.max(y1, y)
        }
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
    }
    const ref = {}
    for (const label of ['1', '2', '১', '২']) ref[label] = await referenceMask(win, label, size)
    const score = (buf, p, label) => {
      const c = centre(buf, p)
      return iou(labelMask(buf, W, c.x, c.y, d), ref[label])
    }
    const s = {
      e1: [score(E, pinned, '1'), score(E, pinned, '2')],
      e2: [score(E, second, '2'), score(E, second, '1')],
      b1: [score(B, pinned, '১'), score(B, pinned, '1')],
      b2: [score(B, second, '২'), score(B, second, '2')]
    }
    console.log(`  glyph overlap with the reference (right, wrong): ${JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map((x) => x.toFixed(2))])))}`)
    for (const [k, [right, wrong]] of Object.entries(s)) {
      h.assert(right > 0.5, `${k}: the badge's glyph matches the reference (${right.toFixed(2)})`)
      h.assert(right > wrong + 0.15, `${k}: and not another (${right.toFixed(2)} vs ${wrong.toFixed(2)})`)
    }

    // The arrow draws itself: no tip 0.1 s in, a tip 0.4 s in.
    const [early, late] = fx.framesAt(out, [Math.round(5.0 * fps), Math.round(5.3 * fps)], 'rgb24').frames
    const tip = [Math.round(0.7 * W) - 24, Math.round(0.6 * H) - 16, Math.round(0.7 * W) + 2, Math.round(0.6 * H) + 6]
    // (Right of the bubble, which is drawn over the shapes.)
    const shaft = [Math.round(0.485 * W), Math.round(0.52 * H), Math.round(0.545 * W), Math.round(0.565 * H)]
    const redEarly = centroid(early, W, H, isRed, tip)
    const redLate = centroid(late, W, H, isRed, tip)
    console.log(`  arrow tip region: ${redEarly ? redEarly.n : 0} red px at 0.1 s, ${redLate ? redLate.n : 0} at 0.4 s`)
    h.assert(centroid(early, W, H, isRed, shaft), 'the shaft has started 0.1 s in')
    h.assert(!redEarly || redEarly.n < 5, 'no tip 0.1 s in')
    h.assert(redLate && redLate.n > 40, 'a tip 0.4 s in')

    // The Bangla bubble: its tail reaches the spot it points at, its text is drawn dark on white.
    const [bub] = fx.framesAt(out, [Math.round(1.0 * fps)], 'rgb24').frames
    const spot = { x: Math.round(0.3 * W), y: Math.round(0.6 * H) }
    const light = (x, y) => {
      const [r, g, b] = px(bub, W, x, y)
      return 0.299 * r + 0.587 * g + 0.114 * b
    }
    let near = 0
    for (let y = spot.y - 6; y <= spot.y - 1; y++) for (let x = spot.x - 2; x <= spot.x + 2; x++) near = Math.max(near, light(x, y))
    const beyond = light(spot.x, spot.y + 12)
    console.log(`  bubble tail: brightest just above the spot ${near.toFixed(0)}, below it ${beyond.toFixed(0)}`)
    h.assert(near > 200, 'the tail reaches the spot')
    h.assert(beyond < 100, 'and stops there')
    const body = { x: Math.round(spot.x + 0.12 * H), y: Math.round(spot.y - 0.1 * H) }
    let dark = 0
    for (let y = body.y - 12; y <= body.y + 12; y++) for (let x = body.x - 80; x <= body.x + 80; x++) if (light(x, y) < 60) dark++
    h.assert(dark > 60, `the Bangla text is drawn in the body (${dark} dark px)`)
  }))

  await test('E7 callouts: Add step badge and Add speech bubble by the cursor, the badge handle moves with the arrow keys, the bubble text takes focus (editor)', fx.withHome('ep-callouts-ui', async (ctx, home) => {
    const media = squareVideo(7)
    const still = [{ t: 0, x: 0.6, y: 0.5 }, { t: 7, x: 0.6, y: 0.5 }]
    fx.seedProject(home, {
      id: 'rec-callouts-ui',
      name: 'Callouts UI',
      media,
      seconds: 7,
      capture: { method: 'native', cursorInVideo: false, region: null },
      cursorSettings: { show: true, size: 1.4, smoothing: 0.5, clickEffect: false, hideWhenIdle: false },
      cursor: { samples: still, clicks: [], keys: [], shapes: [], scale: 1, valid: true }
    })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Callouts UI')
    await win.click('.insp-tabs button:has-text("Text")')
    await win.click('[data-testid="add-step-badge"]')
    await win.click('[data-testid="add-step-badge"]')
    const saved = await f.waitFor(
      () => {
        try {
          const q = h.readProject(home, 'rec-callouts-ui')
          return q.annotations && q.annotations.filter((a) => a.style === 'badge').length === 2 ? q : null
        } catch {
          return null
        }
      },
      'saved: two step badges',
      10000
    )
    const badges = saved.annotations.filter((a) => a.style === 'badge')
    for (const b of badges) {
      h.assert(b.number === 'auto', 'numbered automatically')
      h.assert(b.enter && b.enter.kind === 'pop' && Math.abs(b.enter.duration - 0.24) < 1e-9, 'pops in')
      h.assert(b.pin && b.pin.x < 0.6 && b.pin.y < 0.5, `beside the cursor, up and to the left (${JSON.stringify(b.pin)})`)
    }
    await win.waitForSelector('[data-testid="badge-section"]')
    const handle = await win.waitForSelector('[data-testid="badge-handle"]', { timeout: 10000 })
    const name = await handle.getAttribute('aria-label')
    console.log(`  handle: ${name}`)
    h.assert(/^Badge 2 on \d+ %, \d+ %$/.test(name), `the handle is named for its badge (${name})`)
    const before = badges[1]
    await handle.focus()
    await win.keyboard.press('ArrowRight')
    const moved = await f.waitFor(
      () => {
        const q = h.readProject(home, 'rec-callouts-ui').annotations.find((a) => a.id === before.id)
        return q && Math.abs(q.x - before.x) > 0.005 ? q : null
      },
      'saved: the badge moved',
      10000
    )
    h.assert(Math.abs(moved.x - before.x - 0.01) < 0.002, `ArrowRight moves it 1 % of the frame (${(moved.x - before.x).toFixed(4)})`)
    h.assert(moved.pin.x > before.pin.x, 'its pin moves with it')
    // A speech bubble: its tail on the cursor, its text field focused at once.
    await win.click('[data-testid="add-speech-bubble"]')
    const bubble = await f.waitFor(
      () => {
        const q = h.readProject(home, 'rec-callouts-ui').annotations.find((a) => a.style === 'bubble')
        return q || null
      },
      'saved: the speech bubble',
      10000
    )
    h.assert(Math.abs(bubble.pin.x - 0.6) < 1e-6 && Math.abs(bubble.pin.y - 0.5) < 1e-6, 'the tail points at the cursor')
    await f.waitFor(async () => ((await win.evaluate(() => document.activeElement && document.activeElement.getAttribute('placeholder'))) === "Type the bubble's text" ? true : null), "the bubble's text field takes focus", 10000)
    await win.keyboard.type('Click here')
    await f.waitFor(() => (h.readProject(home, 'rec-callouts-ui').annotations.find((a) => a.style === 'bubble').text === 'Click here' ? true : null), 'saved: the bubble text', 10000)
    await win.waitForSelector('[data-testid="tail-handle"]', { timeout: 10000 })
    await win.waitForSelector('[data-testid="bubble-section"]')
    h.assert(logs.every((l) => !l.includes('[pageerror]')), `no page errors:\n${logs.filter((l) => l.includes('[pageerror]')).join('\n')}`)
  }))

  // P4, colour: E9, E10, E11 and the colour sliders' keys of E16 (editing-polish-colour.cjs).
  await require('./editing-polish-colour.cjs').colourSteps(test)

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

  // E17 (Versions) and E18 (cost), across the parts.
  await whole.laterSteps(test)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
