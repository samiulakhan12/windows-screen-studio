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
const os = require('node:os')
const path = require('node:path')
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

async function main() {
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
}

main()
