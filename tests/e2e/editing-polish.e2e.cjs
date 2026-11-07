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

/** Exports the library entry `name` at `res` and `fps` to `out`, then goes back Home. */
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

async function main() {
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
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
