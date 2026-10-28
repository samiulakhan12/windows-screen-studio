// Vertical video that follows the action (NW-05) and Duplicate (X-04), end to end in the built app
// (docs/design/vertical-video.md §11.3): an old 9:16 project opens, previews and exports exactly
// as before; turning following on (keyboard, undo, redo) crops in and follows the cursor in the
// preview and the export alike, with a calm, monotonic pan that starts with the cursor and arrives
// before the click; the safe zones are preview only; Make a vertical version makes a linked copy
// with the camera in a band on top and the caption in the text area, never touching the original;
// Hold the view here (R) and dragging the picture steer the view; a recording without cursor data
// rests where the slider puts it; Duplicate copies a project as it is; the copy menu and the
// Vertical framing section work from the keyboard.
//
// The data-testid values of §2 (frozen by the contracts commit; the UI parts use exactly these):
//
//   Title bar (§2.2, part P4: CopyMenu in the editor's title bar)
//     copy-menu              the copy button right of the name field (icon copy, title and aria-label
//                            "Duplicate or make a vertical version", aria-haspopup="menu"); its menu has role="menu"
//     copy-vertical          menu item "Make a vertical version" (aria-disabled with its reason when unavailable)
//     copy-square            menu item "Make a square version"
//     copy-duplicate         menu item "Duplicate"
//   Making the copy (§2.3, part P4)
//     copy-progress          the progress modal (role="dialog"), shown when a copy runs longer than 0.5 s
//   Style › Vertical framing (§2.2, §2.5, part P3)
//     framing-section        the section "Vertical framing"
//     vertical-callout       "Making a Short?" with the button Make a vertical version
//     follow-toggle          toggle "Follow the action"
//     follow-status          status line; data-state="following" or "no-input"
//     follow-level           slider "How close"
//     follow-pace            chips "Movement": Calm, Balanced, Lively
//     follow-camera          chips "Camera": Band on top, Band at the bottom, Bubble
//     follow-band            slider "Camera size"
//     follow-rest-x          slider "Where the view rests": Left to right
//     follow-rest-y          slider "Where the view rests": Top to bottom
//     follow-hold            button "Hold the view here" (R)
//     follow-view-x          slider "View at the playhead": Left to right
//     follow-view-y          slider "View at the playhead": Top to bottom
//     app-safe-toggle        toggle "Keep text clear of app buttons"
//   Safe-zone preview (§2.8, part P3)
//     safe-zones-toggle      the transport row's "Safe zones" toggle (aria-pressed; G)
//     safe-zones-platform    select: All three, TikTok, Instagram Reels, YouTube Shorts
//     safe-zones             the overlay over the preview (data-platform="all" | "tiktok" | "reels" | "shorts")
//     safe-zones-legend      the legend under the preview while the overlay is on
//   Export dialog (§2.2, §2.9, part P3)
//     export-follow-note     "Your whole screen is shrunk to fit 9:16 …" with Make a vertical version (or square)
//     export-follow-on       "The view follows the action: it crops in on your cursor, clicks and typing."
//     export-magnify         "Shows your 1920×1080 recording at 1.6× its size …"
//
// Pixels are classified by the nearest fixture colour (decoding, scaling and encoding shift them a
// little) and never compared by value, except where the design asks for an unchanged picture.
// "Shows stripe n" means at least 80% of the sampled pixels of that column are stripe n.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const W = 1280
const H = 720
const SECONDS = 8
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

/* ---------- fixtures ---------- */

/** The eight stripes, left to right (160 px each in the recording); none is white. */
const STRIPES = ['ff0000', 'ff8000', 'ffff00', '00ff00', '00ffff', '0000ff', '8000ff', 'ff00ff']
const CAMERA_GREEN = '00c000'
const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
/** Classes: the stripes 0..7, then the background, the camera and the caption. */
const CLASSES = [...STRIPES.map(rgbOf), [0, 0, 0], rgbOf(CAMERA_GREEN), [255, 255, 255]]
const BLACK = 8
const CAMERA = 9
const isStripe = (k) => k >= 0 && k < 8

/** The nearest class of a colour. */
function classOf(c) {
  let best = 0
  let bestD = Infinity
  CLASSES.forEach((k, i) => {
    const d = (c[0] - k[0]) ** 2 + (c[1] - k[1]) ** 2 + (c[2] - k[2]) ** 2
    if (d < bestD) {
      best = i
      bestD = d
    }
  })
  return best
}

/** The class at least 80% of `colours` have, or -1. */
function majority(colours) {
  const n = new Map()
  for (const c of colours) {
    const k = classOf(c)
    n.set(k, (n.get(k) || 0) + 1)
  }
  for (const [k, count] of n) if (count >= 0.8 * colours.length) return k
  return -1
}

/**
 * 1280×720, 8 s, 60 fps, lossless (4:2:0 with the stripe edges on even columns, so no colour
 * bleeds across them), eight vertical stripes of 160 px, converted and tagged as BT.709 so the
 * colours decode as drawn. Cached like crop.e2e.cjs taskbarVideo.
 */
function stripesVideo() {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `stripes-${W}x${H}-${SECONDS}s.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  const inputs = STRIPES.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=0x${c}:s=160x${H}:r=60,format=rgb24`])
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    ...inputs,
    '-filter_complex', `${STRIPES.map((_, i) => `[${i}]`).join('')}hstack=inputs=${STRIPES.length},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`,
    '-map', '[v]',
    '-t', String(SECONDS),
    '-c:v', 'libx264', '-qp', '0', '-g', '15',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart',
    tmp
  ])
  fs.renameSync(tmp, file)
  return file
}

/** At stripe 0 until 3.0 s, a straight move to stripe 6 by 3.3 s, held; a left click there at 5.0 s. */
function cursorTrack() {
  const samples = []
  for (let i = 0; i <= SECONDS * 60; i++) {
    const t = i / 60
    const p = Math.min(1, Math.max(0, (t - 3) / 0.3))
    samples.push({ t: +t.toFixed(4), x: 0.0625 + (0.8125 - 0.0625) * p, y: 0.5 })
  }
  return { samples, clicks: [{ t: 5, x: 0.8125, y: 0.5, button: 'left' }], keys: [], shapes: [], scale: 1, valid: true }
}

const STYLE = (aspectRatio) => ({ background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio })
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }
const CAPTURE = { method: 'native', cursorInVideo: false, region: null, target: 'screen' }

/**
 * A project folder with REAL media files: seedProject symlinks them (render-fixtures.cjs), and
 * Duplicate links or copies regular files only. Padding 0, black background, no cursor drawn, no
 * click effect, no motion blur, no zooms.
 */
function seed(home, { id, name, aspect, webcam = false, cursor = cursorTrack(), extra = {} }) {
  fx.seedProject(home, {
    id,
    name,
    seconds: SECONDS,
    media: stripesVideo(),
    webcam: webcam ? fx.solidVideo({ seconds: SECONDS, width: 640, height: 360, color: CAMERA_GREEN }) : undefined,
    capture: CAPTURE,
    style: STYLE(aspect),
    effects: NO_FX,
    cursor
  })
  const dir = path.join(h.projectsRoot(home), id)
  for (const file of ['screen.mp4', ...(webcam ? ['webcam.mp4'] : [])]) {
    const target = fs.readlinkSync(path.join(dir, file))
    fs.unlinkSync(path.join(dir, file))
    fs.copyFileSync(target, path.join(dir, file))
  }
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...p, ...extra }, null, 2))
  return id
}

const TRANSCRIPT = { provider: 'openai', model: 'test-model', createdAt: '2026-10-01T09:00:00.000Z', language: 'en', segments: [{ id: 's1', start: 1, end: 4, text: 'Hello vertical world' }] }
const CAPTIONS = { show: true, preset: 'clean', position: 'bottom', size: 0.045, color: '#ffffff', highlightColor: '#facc15', background: 'shadow', maxLines: 2 }

/* ---------- reading the app ---------- */

/** Colours of the preview canvas at normalised points. */
function previewColours(win, points) {
  return win.evaluate((pts) => {
    const c = document.querySelector('.preview-canvas')
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height)
    return pts.map(([nx, ny]) => {
      const x = Math.min(c.width - 1, Math.max(0, Math.round(nx * (c.width - 1))))
      const y = Math.min(c.height - 1, Math.max(0, Math.round(ny * (c.height - 1))))
      const i = (y * c.width + x) * 4
      return [data[i], data[i + 1], data[i + 2]]
    })
  }, points)
}

/** A fingerprint of every pixel of the preview canvas. */
const previewPrint = (win) =>
  win.evaluate(() => {
    const c = document.querySelector('.preview-canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let hash = 2166136261
    for (let i = 0; i < d.length; i++) hash = Math.imul(hash ^ d[i], 16777619)
    return `${c.width}x${c.height}:${hash >>> 0}`
  })

/** Normalised points down the column at `nx`, from `y0` to `y1`. */
const column = (nx, y0, y1, n = 40) => Array.from({ length: n }, (_, i) => [nx, y0 + ((y1 - y0) * (i + 0.5)) / n])
/** Normalised points along the row at `ny`. */
const row = (ny, n) => Array.from({ length: n }, (_, i) => [(i + 0.5) / n, ny])

/** The stripe the preview's centre column shows (between rows y0 and y1), or -1. */
const previewCentre = async (win, y0 = 0.05, y1 = 0.95) => majority(await previewColours(win, column(0.5, y0, y1)))

/** Waits until the preview's centre column shows stripe `k`. */
const previewShows = (win, k, what, y0, y1) => f.waitFor(async () => (await previewCentre(win, y0, y1)) === k, `${what}: the preview's centre column shows stripe ${k}`, 8000)

/** Moves the playhead to source time `t` by clicking the ruler. */
async function seekTo(win, t) {
  const x = await win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
  const y = await win.$eval('.tl-ruler', (el) => {
    const b = el.getBoundingClientRect()
    return b.y + b.height / 2
  })
  await win.mouse.click(x, y)
  await h.sleep(300)
}

const titleIs = (win, name, what) => f.waitFor(async () => (await win.inputValue('input.title-input').catch(() => '')) === name, what, 15000)

/** Opens the project named exactly `name` from the library. */
async function openByName(win, name) {
  const card = `.project-open:has(.project-name:text-is("${name}"))`
  await win.waitForSelector(card, { timeout: 30000 })
  await win.click(card)
  await win.waitForSelector('.editor .preview-canvas', { timeout: 60000 })
  await titleIs(win, name, `the editor of ${name}`)
  // First frame drawn and save state settled.
  await h.sleep(800)
}

async function backHome(win) {
  await win.click('button[aria-label="Back to recordings"]')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

async function styleTab(win) {
  await win.click('.insp-tabs button:has-text("Style")')
  await win.waitForSelector('[data-testid=framing-section]', { timeout: 5000 })
}

/** Presses Tab from the Style tab button until the focus is inside `selector` (at most 150 times). */
async function tabTo(win, selector) {
  await win.focus('.insp-tabs button:has-text("Style")')
  for (let i = 0; i < 150; i++) {
    await win.keyboard.press('Tab')
    if (await win.evaluate((sel) => !!document.activeElement?.closest(sel), selector)) return
  }
  throw new Error(`Tab never reached ${selector}`)
}

/** The focus on nothing in particular, so single-key shortcuts (G, R) reach the editor. */
const blur = (win) => win.evaluate(() => document.activeElement?.blur())
const focusedTestId = (win) => win.evaluate(() => document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? null)
const disk = (home, id) => h.readProject(home, id)
const projectFile = (home, id) => path.join(h.projectsRoot(home), id, 'project.json')
const folders = (home) => fs.readdirSync(h.projectsRoot(home)).sort()
const noticeHas = (win, text, what) => f.waitFor(async () => ((await win.textContent('.notice-slot').catch(() => '')) || '').includes(text), what, 10000)

/** Every file under a project folder: its bytes' digest, size, time and inode. */
function snapshot(dir) {
  const out = {}
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const p = path.join(rel, name)
      const st = fs.lstatSync(path.join(dir, p))
      if (st.isDirectory()) walk(p)
      else out[p] = `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, p))).digest('hex')} ${st.size} ${st.mtimeMs} ${st.ino}`
    }
  }
  walk('')
  return out
}

/** Waits for a project folder that was not in `before`, holding project.json; returns its id. */
const newProject = (home, before) =>
  f.waitFor(() => folders(home).find((d) => !before.includes(d) && fs.existsSync(projectFile(home, d))) || null, 'the new project folder', 30000)

/** Runs a palette command by its exact title. */
async function paletteRun(win, title) {
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type(title)
  await f.waitFor(async () => (await win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent)))[0] === title, `the palette lists "${title}" first`, 3000)
  await win.keyboard.press('Enter')
}

/** Exports the open project as a 720p MP4 at `fps`; returns how long it took. */
async function exportMp4(app, win, out, fps = 30) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Format', 'MP4')
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', `${fps} fps`)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${path.basename(out)}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached', timeout: 10000 })
  return r
}

/* A 9:16 export at 720p is 720×1280. */
const OW = 720
const OH = 1280

/** Frames of a 720×1280 export at the given seconds: { at(t) -> rgb24 buffer }. */
function exportFrames(file, times, fps = 30) {
  const idx = times.map((t) => Math.round(t * fps))
  const F = fx.framesAt(file, idx, 'rgb24')
  h.assert(F.width === OW && F.height === OH, `a 720×1280 export (${F.width}×${F.height})`)
  return { at: (t) => F.frames[idx.indexOf(Math.round(t * fps))] }
}
const px = (buf, x, y) => {
  const i = (Math.round(y) * OW + Math.round(x)) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}
/** The stripe an export frame's column at x shows between rows y0 and y1, or -1. */
const frameColumn = (buf, x, y0, y1, n = 60) => majority(Array.from({ length: n }, (_, i) => px(buf, x, y0 + ((y1 - y0) * (i + 0.5)) / n)))

/**
 * Where the view's left edge is in the recording (recorded px), from the stripe boundaries on the
 * frame's middle row: a boundary between stripes k and k+1 is recorded at (k+1)·160 and drawn at
 * x, so the left edge is (k+1)·160 − x / magnification. Null when no boundary shows.
 */
function leftEdge(buf, magnification) {
  const classes = Array.from({ length: OW }, (_, x) => classOf(px(buf, x, OH / 2)))
  // Runs of at least 3 px of one stripe; a boundary sits midway between runs of neighbouring stripes.
  const runs = []
  for (let x = 0; x < OW; ) {
    let e = x
    while (e < OW && classes[e] === classes[x]) e++
    if (e - x >= 3 && isStripe(classes[x])) runs.push({ k: classes[x], from: x, to: e })
    x = e
  }
  const edges = []
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].k === runs[i - 1].k + 1) edges.push(runs[i].k * 160 - (runs[i - 1].to + runs[i].from) / 2 / magnification)
  }
  return edges.length ? edges.reduce((a, b) => a + b, 0) / edges.length : null
}

/* ---------- the test ---------- */

h.run(
  'vertical video: old project unchanged, follow the action, safe zones, make a vertical version, steer, no cursor data, duplicate, keyboard',
  fx.withHome('vertical', async (ctx, home) => {
    seed(home, { id: 'rec-stripes', name: 'Stripes', aspect: 'auto' })
    const OLD = seed(home, { id: 'rec-old', name: 'Old', aspect: '9:16' })
    const CAM = seed(home, { id: 'rec-cam', name: 'Cam', aspect: 'auto', webcam: true, extra: { transcript: TRANSCRIPT, captions: CAPTIONS } })
    seed(home, { id: 'rec-nodata', name: 'NoData', aspect: 'auto', cursor: { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false } })

    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.waitForSelector('.home', { timeout: 30000 })

    // 1. An old 9:16 project: unchanged on disk, the toggle off with its hint, exported fitted as before.
    const oldBytes = fs.readFileSync(projectFile(home, OLD))
    await openByName(win, 'Old')
    await styleTab(win)
    h.assert(!(await win.isChecked('[data-testid=follow-toggle] input[type=checkbox]')), 'Follow the action is off in an old project')
    const section = await win.textContent('[data-testid=framing-section]')
    h.assert(section.includes('Your whole screen is shrunk to fit this shape. Turn this on to crop in and follow your cursor, clicks and typing.'), `the "shrunk to fit" hint (${section})`)
    await backHome(win)
    h.assert(fs.readFileSync(projectFile(home, OLD)).equals(oldBytes), 'project.json of an old project is unchanged after opening and closing it')

    await openByName(win, 'Old')
    const fitted = path.join(home, 'old-fitted.mp4')
    const fittedRun = await exportMp4(app, win, fitted)
    {
      const frame = exportFrames(fitted, [6]).at(6)
      // contentRect(720, 1280, 1280, 720, 0): 720 × 405 at y 437.5, black above and below.
      const across = Array.from({ length: 8 }, (_, k) => frameColumn(frame, ((k + 0.5) * OW) / 8, 450, 830))
      h.assert(across.join() === '0,1,2,3,4,5,6,7', `all eight stripes across the full width (${across})`)
      h.assert(frameColumn(frame, 1, 450, 830) === 0 && frameColumn(frame, OW - 2, 450, 830) === 7, 'the recording reaches both sides')
      for (let k = 0; k < 8; k++) {
        const x = ((k + 0.5) * OW) / 8
        let top = 0
        while (top < OH && !isStripe(classOf(px(frame, x, top)))) top++
        let bottom = OH - 1
        while (bottom > 0 && !isStripe(classOf(px(frame, x, bottom)))) bottom--
        h.assert(Math.abs(top - 437.5) <= 2 && Math.abs(bottom + 1 - 842.5) <= 2, `the recording fills y 437.5 to 842.5 (column ${k}: ${top} to ${bottom + 1})`)
        h.assert(classOf(px(frame, x, 200)) === BLACK && classOf(px(frame, x, 1080)) === BLACK, `black above and below (column ${k})`)
      }
    }

    // 2. Following on from the keyboard (Tab to the toggle, Space); undo and redo.
    await styleTab(win)
    await tabTo(win, '[data-testid=follow-toggle]')
    await win.keyboard.press('Space')
    await f.waitFor(() => disk(home, OLD).reframe?.mode === 'follow', 'reframe.mode "follow" in project.json')
    await blur(win)
    await seekTo(win, 1.5)
    await previewShows(win, 1, 'following at 1.5 s')
    await seekTo(win, 6)
    await previewShows(win, 6, 'following at 6.0 s')
    await blur(win)
    await win.keyboard.press('Control+z')
    await f.waitFor(() => !('reframe' in disk(home, OLD)), 'no reframe key after undo')
    await f.waitFor(async () => (await previewColours(win, row(0.5, 8))).map(classOf).join() === '0,1,2,3,4,5,6,7', 'the fitted view after undo (all eight stripes)')
    await win.keyboard.press('Control+y')
    await f.waitFor(() => disk(home, OLD).reframe?.mode === 'follow', 'following again after redo')
    await previewShows(win, 6, 'following after redo')

    // 3. The export follows as the preview does; the pan is calm, starts with the cursor and arrives before the click.
    await fx.openExportDialog(win)
    h.assert(await win.isVisible('[data-testid=export-follow-on]'), 'the Export dialog says the view follows the action')
    await win.click('.modal button[title="Close"]')
    await win.waitForSelector('.modal', { state: 'detached', timeout: 10000 })
    const followed = path.join(home, 'old-following.mp4')
    const followedRun = await exportMp4(app, win, followed)
    console.log(`timing: 720×1280 exports, fitted ${fittedRun.seconds.toFixed(1)} s, following ${followedRun.seconds.toFixed(1)} s`)
    const times = Array.from({ length: 91 }, (_, i) => (60 + i) / 30)
    const fr = exportFrames(followed, [1.5, 6, ...times])
    h.assert(frameColumn(fr.at(1.5), OW / 2, 64, 1216) === 1, 'the export shows stripe 1 at 1.5 s, as the preview did')
    h.assert(frameColumn(fr.at(6), OW / 2, 64, 1216) === 6, 'the export shows stripe 6 at 6.0 s, as the preview did')
    // The view shows 405 recorded px across 720 output px (base.w 0.3164 of 1280).
    const MAG = 720 / 405
    const edges = times.map((t) => leftEdge(fr.at(t), MAG))
    h.assert(edges.every((e) => e !== null), `a stripe boundary in every frame (${edges.map((e) => (e === null ? 'none' : e.toFixed(1)))})`)
    const outPx = edges.map((e) => e * MAG)
    const moved = outPx.findIndex((x) => Math.abs(x - outPx[0]) > 3)
    h.assert(moved > 0 && times[moved] >= 2.9, `the view starts moving no earlier than 2.9 s (at ${times[moved]})`)
    const arrived = times.findIndex((t) => t >= 4.6 - 1e-9)
    for (let i = arrived; i < times.length; i++) h.assert(Math.abs(outPx[i] - outPx.at(-1)) <= 2, `arrived by 4.6 s (at ${times[i].toFixed(2)} s: ${outPx[i].toFixed(1)} px, finally ${outPx.at(-1).toFixed(1)})`)
    const steps = outPx.slice(1).map((x, i) => x - outPx[i])
    h.assert(steps.every((d) => d >= -2), `monotonic (${steps.map((d) => d.toFixed(1))})`)
    const LIMIT = 3 * (1 / 30) * 720 * 1.15
    h.assert(Math.max(...steps) <= LIMIT, `per-frame displacement at most ${LIMIT.toFixed(1)} px (${Math.max(...steps).toFixed(1)})`)
    const changes = steps.slice(1).map((d, i) => Math.abs(d - steps[i]))
    h.assert(Math.max(...changes) <= 10, `the displacement changes by at most 10 px between frames (${Math.max(...changes).toFixed(1)})`)

    // 4. Safe zones: G shows them in the preview only; the choice is remembered.
    await blur(win)
    await win.keyboard.press('g')
    await win.waitForSelector('[data-testid=safe-zones][data-platform="all"]', { timeout: 5000 })
    h.assert((await win.$$('[data-testid=safe-zones] .safe-zone-box')).length === 9, 'All three: nine boxes')
    await win.selectOption('[data-testid=safe-zones-platform]', 'tiktok')
    await win.waitForSelector('[data-testid=safe-zones][data-platform="tiktok"]', { timeout: 5000 })
    h.assert((await win.$$('[data-testid=safe-zones] .safe-zone-box')).length === 3, 'TikTok: three boxes')
    const legend = await win.textContent('[data-testid=safe-zones-legend]')
    h.assert(legend.includes("Shaded parts are covered by the apps' buttons and captions. Shown only here, never exported."), `the legend (${legend})`)
    await blur(win)
    const zonesOn = path.join(home, 'old-zones.mp4')
    await exportMp4(app, win, zonesOn)
    {
      const a = fr.at(6)
      const b = exportFrames(zonesOn, [6]).at(6)
      // Under TikTok's button column, the top bar, and a grid over the whole frame.
      const points = [[0.93 * OW, 0.6 * OH]]
      for (let y = 2; y < 0.08 * OH; y += 6) for (let x = 2; x < OW; x += 12) points.push([x, y])
      for (let y = 4; y < OH; y += 24) for (let x = 4; x < OW; x += 24) points.push([x, y])
      const differ = points.filter(([x, y]) => classOf(px(a, x, y)) !== classOf(px(b, x, y)))
      h.assert(differ.length === 0, `the export with the safe zones shown is the same (${differ.length} points differ, e.g. ${JSON.stringify(differ.slice(0, 3))})`)
    }
    await backHome(win)
    await openByName(win, 'Old')
    await win.waitForSelector('[data-testid=safe-zones][data-platform="tiktok"]', { timeout: 5000 })
    await blur(win)
    await win.keyboard.press('g')
    await win.waitForSelector('[data-testid=safe-zones]', { state: 'detached', timeout: 5000 })
    await backHome(win)
    await openByName(win, 'Old')
    h.assert(!(await win.$('[data-testid=safe-zones]')), 'the safe zones stay off after reopening')

    // 10. The keyboard: the copy menu opens with Enter, moves with Down and Up, closes with Esc; Tab reaches the toggle.
    await win.focus('[data-testid=copy-menu]')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[role=menu]', { timeout: 5000 })
    await win.keyboard.press('ArrowDown')
    h.assert((await focusedTestId(win)) === 'copy-vertical', 'Down: Make a vertical version')
    await win.keyboard.press('ArrowDown')
    h.assert((await focusedTestId(win)) === 'copy-square', 'Down: Make a square version')
    await win.keyboard.press('ArrowUp')
    h.assert((await focusedTestId(win)) === 'copy-vertical', 'Up: Make a vertical version')
    await win.keyboard.press('Escape')
    await win.waitForSelector('[role=menu]', { state: 'detached', timeout: 5000 })
    h.assert((await focusedTestId(win)) === 'copy-menu', 'Esc gives the focus back to the button')
    await styleTab(win)
    await tabTo(win, '[data-testid=follow-toggle]')
    await backHome(win)

    // 5. Make a vertical version: a linked copy that opens; the original untouched.
    await openByName(win, 'Cam')
    const camDir = path.join(h.projectsRoot(home), CAM)
    const camBefore = snapshot(camDir)
    const before = folders(home)
    await win.click('[data-testid=copy-menu]')
    await win.waitForSelector('[role=menu]', { timeout: 5000 })
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('Enter')
    const COPY = await newProject(home, before)
    const copy = disk(home, COPY)
    h.assert(copy.style.aspectRatio === '9:16', `the copy is 9:16 (${copy.style.aspectRatio})`)
    h.assert(copy.reframe?.mode === 'follow' && copy.reframe.camera === 'top' && copy.reframe.appSafe === true, `the copy follows, the camera on top, text clear of the apps (${JSON.stringify(copy.reframe)})`)
    h.assert(copy.name === 'Cam (vertical)', `named "Cam (vertical)" (${copy.name})`)
    h.assert(copy.copyOf?.id === CAM, `made from Cam (${JSON.stringify(copy.copyOf)})`)
    const copyDir = path.join(h.projectsRoot(home), COPY)
    for (const file of ['screen.mp4', 'webcam.mp4']) {
      const linked = fs.statSync(path.join(camDir, file)).ino === fs.statSync(path.join(copyDir, file)).ino
      h.assert(linked || fs.readFileSync(path.join(camDir, file)).equals(fs.readFileSync(path.join(copyDir, file))), `${file} is linked (or the same bytes)`)
    }
    h.assert(fs.readFileSync(path.join(camDir, 'cursor.json')).equals(fs.readFileSync(path.join(copyDir, 'cursor.json'))), 'cursor.json is the same')
    h.assert(!fs.existsSync(path.join(copyDir, '.copying')), 'the copy is finished')
    h.assert(JSON.stringify(snapshot(camDir)) === JSON.stringify(camBefore), 'the original folder is byte for byte as it was, with no new file')
    await titleIs(win, 'Cam (vertical)', 'the copy opens')
    await noticeHas(win, 'Your original “Cam” is unchanged', 'the notice after the copy')
    await win.click('.notice-slot button:has-text("Open original")')
    await titleIs(win, 'Cam', 'Open original opens Cam')
    await backHome(win)
    await openByName(win, 'Cam (vertical)')

    // 6. The camera in a band on top, the screen below it, the caption in the text area.
    const vertical = path.join(home, 'cam-vertical.mp4')
    await exportMp4(app, win, vertical)
    {
      const frame = exportFrames(vertical, [2]).at(2)
      for (let y = 2; y <= 0.3 * OH; y += 16) {
        for (let x = 4; x < OW; x += 24) h.assert(classOf(px(frame, x, y)) === CAMERA, `the camera band at (${x}, ${y}): ${px(frame, x, y)}`)
      }
      let stripeAbove = 0
      let shown = 0
      let sampled = 0
      let white = 0
      const outside = []
      for (let y = 0; y < OH; y++) {
        for (let x = 0; x < OW; x++) {
          const c = px(frame, x, y)
          if (y < 0.31 * OH && isStripe(classOf(c))) stripeAbove++
          if (y >= 0.34 * OH && x % 8 === 0 && y % 8 === 0) {
            sampled++
            if (isStripe(classOf(c))) shown++
          }
          if (c[0] > 235 && c[1] > 235 && c[2] > 235) {
            white++
            if (y < 0.32 * OH || y > 0.76 * OH || x < 0.06 * OW || x > 0.86 * OW) outside.push([x, y])
          }
        }
      }
      h.assert(stripeAbove === 0, `no stripe colour above 0.31 H (${stripeAbove} pixels)`)
      h.assert(shown >= 0.8 * sampled, `the screen shows below the band (${shown} of ${sampled} samples are stripes)`)
      h.assert(white > 50, `the caption is drawn (${white} white pixels)`)
      h.assert(outside.length === 0, `the caption stays in the text area (${outside.length} white pixels outside, e.g. ${JSON.stringify(outside.slice(0, 3))})`)
    }

    // 7. Steering: R holds the view where it is; dragging the picture aims it; undo, step by step.
    await seekTo(win, 6)
    // The band view at padding 0 is 0.4653 of the recording wide, so the cursor at 0.8125 shows with the view at 0.767.
    await previewShows(win, 6, 'the copy at 6.0 s', 0.36, 0.98)
    const beforeHold = await previewPrint(win)
    await blur(win)
    await win.keyboard.press('r')
    const held = await f.waitFor(() => (disk(home, COPY).zooms.length === 1 ? disk(home, COPY).zooms[0] : null), 'the zoom R adds')
    h.assert(held.scale === 1 && held.focus.mode === 'fixed' && Math.abs(held.focus.x - 0.767) <= 0.01, `a 1× zoom with a fixed point at the view's centre (${JSON.stringify(held)})`)
    await h.sleep(500)
    h.assert((await previewPrint(win)) === beforeHold, 'Hold the view here leaves the preview as it was, pixel for pixel')
    await win.keyboard.press('Escape')
    const box = await win.$eval('.preview-canvas', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    // The card (the screen's slot) is the frame under the band: the whole width at padding 0.
    const from = { x: box.x + box.w / 2, y: box.y + box.h * 0.66 }
    await win.mouse.move(from.x, from.y)
    await win.mouse.down()
    await win.mouse.move(from.x + 0.2 * box.w, from.y, { steps: 10 })
    await win.mouse.up()
    const aimed = await f.waitFor(() => {
      const z = disk(home, COPY).zooms
      return z.length === 1 && z[0].focus.mode === 'fixed' && Math.abs(z[0].focus.x - held.focus.x) > 0.02 ? z[0] : null
    }, 'the dragged view')
    h.assert(Math.abs(aimed.focus.x - (0.767 - 0.2 * 0.4653)) <= 0.01, `the content moved with the pointer (focus.x ${aimed.focus.x}, want 0.674)`)
    await previewShows(win, 5, 'the dragged view', 0.36, 0.98)
    await blur(win)
    await win.keyboard.press('Control+z')
    await f.waitFor(() => {
      const z = disk(home, COPY).zooms
      return z.length === 1 && Math.abs(z[0].focus.x - held.focus.x) < 1e-9
    }, 'the point back after one undo')
    await win.keyboard.press('Control+z')
    await f.waitFor(() => disk(home, COPY).zooms.length === 0, 'no zoom after a second undo')
    await backHome(win)

    // 8. No cursor data: the view rests in the middle, or where the slider puts it.
    await openByName(win, 'NoData')
    const beforeNoData = folders(home)
    await paletteRun(win, 'Make a vertical version')
    const RESTING = await newProject(home, beforeNoData)
    await titleIs(win, 'NoData (vertical)', 'the copy of NoData opens')
    await win.waitForSelector('[data-testid=follow-status][data-state="no-input"]', { timeout: 10000 })
    await seekTo(win, 1.5)
    await f.waitFor(async () => [3, 4].includes(await previewCentre(win)), 'stripe 3 or 4 in the middle at 1.5 s')
    await seekTo(win, 6)
    await f.waitFor(async () => [3, 4].includes(await previewCentre(win)), 'stripe 3 or 4 in the middle at 6.0 s')
    await win.focus('[data-testid=follow-rest-x] input[type=range]')
    await win.keyboard.press('Home')
    await f.waitFor(() => disk(home, RESTING).reframe?.rest?.x === 0, 'reframe.rest.x 0 saved')
    await f.waitFor(async () => majority(await previewColours(win, column(0.01, 0.05, 0.95))) === 0, "the card's left edge shows stripe 0")
    await previewShows(win, 1, 'resting at the left')
    await blur(win)
    await win.keyboard.press('Control+z')
    await f.waitFor(() => disk(home, RESTING).reframe?.rest === undefined, 'one undo step takes the rest point back')
    await win.keyboard.press('Control+y')
    await f.waitFor(() => disk(home, RESTING).reframe?.rest?.x === 0, 'redo puts it back')
    const rested = path.join(home, 'nodata-rest.mp4')
    await exportMp4(app, win, rested)
    {
      const frame = exportFrames(rested, [1.5]).at(1.5)
      h.assert(frameColumn(frame, 3, 64, 1216) === 0 && frameColumn(frame, OW / 2, 64, 1216) === 1, 'the export rests at the left too')
    }
    await backHome(win)

    // 9. Duplicate: the same project under a new id and name.
    const seeded = fs.readFileSync(projectFile(home, 'rec-stripes'))
    await openByName(win, 'Stripes')
    // An edit and its reverse, so project.json is what the editor saves (the seed is not in that form).
    await win.click('input.title-input')
    await win.keyboard.press('End')
    await win.keyboard.type('x')
    await win.keyboard.press('Backspace')
    await blur(win)
    await f.waitFor(() => !fs.readFileSync(projectFile(home, 'rec-stripes')).equals(seeded) && disk(home, 'rec-stripes').name === 'Stripes', 'the project saved by the editor')
    await win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
    const original = disk(home, 'rec-stripes')
    const beforeDup = folders(home)
    await paletteRun(win, 'Duplicate this video')
    const DUP = await newProject(home, beforeDup)
    const dup = disk(home, DUP)
    const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v)
    const rest = ({ id: _i, name: _n, createdAt: _c, copyOf: _o, ...others }) => JSON.stringify(canonical(others))
    h.assert(rest(dup) === rest(original), `the copy equals the original but for its id, name, creation time and origin (${rest(dup)} vs ${rest(original)})`)
    h.assert(dup.id === DUP && dup.name === 'Stripes (copy)' && dup.copyOf?.id === 'rec-stripes' && dup.createdAt !== original.createdAt, `the copy's own fields (${JSON.stringify({ id: dup.id, name: dup.name, createdAt: dup.createdAt, copyOf: dup.copyOf })})`)
    await titleIs(win, 'Stripes (copy)', 'the copy opens')
    await noticeHas(win, 'Made a copy. Your original “Stripes” is unchanged.', 'the notice after Duplicate')
  })
)
