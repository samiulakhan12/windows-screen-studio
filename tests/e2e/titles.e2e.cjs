// Title cards and chapters end to end: measured on exported frames (a centered card covers the
// frame with its background and shows its text in the middle, a lower third leaves the top of
// the video visible, cards fade in and out, the blurred-video background is soft and darker,
// the project's background fills a "background" card, with dark text on a light one), chapters in the exported file at the
// right output times after a cut (MP4 and M4A) and copied as YouTube timestamps, and edited in
// the app (palette and keys add titles and chapters, chapter keys move the playhead, flags drag
// on the timeline, the Text panel renames, camera layout commands on a recording with a camera).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const W = 1920
const H = 1080

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-titles-mod-'))
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))
/** The shared title layout code, to know where the export draws a lower third. */
const titleCards = (() => {
  const outfile = path.join(scratch, 'titleCards.cjs')
  esbuild.buildSync({ stdin: { contents: "export * from './src/shared/render/titleCards'\n", resolveDir: h.APP_DIR, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  return require(outfile)
})()

/** Adds title cards and chapters to a seeded project.json (the shared fixtures do not know them). */
function addItems(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

const title = (id, start, end, extra = {}) => ({ id, start, end, title: 'Title', style: 'centered', background: 'solid', color: '#2040c0', textColor: '#ffffff', ...extra })

async function launch(ctx, home) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

/** Exports the project open in the editor (an MP4 at `resolution` and 30 fps, or as `format`) to `out` and closes the dialog. */
async function exportOpen(app, win, out, { format = null, resolution = '1080p' } = {}) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  if (format) await fx.pickChip(win, 'Format', format)
  else {
    await fx.pickChip(win, 'Format', 'MP4')
    await fx.pickChip(win, 'Resolution', resolution)
    await fx.pickChip(win, 'Frame rate', '30 fps')
  }
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Frame `index` of a 1080p export with pixel readers. */
function frameOf(file, index) {
  const { width, height, frames } = fx.framesAt(file, [index], 'rgb24')
  h.assert(width === W && height === H, `export is ${W}x${H} (got ${width}x${height})`)
  const buf = frames[0]
  const px = (x, y) => {
    const i = (Math.round(y) * width + Math.round(x)) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
  const mean = (r) => {
    const s = [0, 0, 0]
    let n = 0
    for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y++) {
      for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x++) {
        const p = px(x, y)
        s[0] += p[0]
        s[1] += p[1]
        s[2] += p[2]
        n++
      }
    }
    return s.map((v) => v / n)
  }
  /** Pixels in `r` brighter than `min` on every channel (white text). */
  const bright = (r, min = 200) => {
    let n = 0
    for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y += 2) {
      for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x += 2) if (px(x, y).every((v) => v >= min)) n++
    }
    return n
  }
  /** Pixels in `r` darker than `max` on every channel (dark text). */
  const dark = (r, max = 60) => {
    let n = 0
    for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y += 2) {
      for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x += 2) if (px(x, y).every((v) => v <= max)) n++
    }
    return n
  }
  /** Mean squared luma step to the next pixel inside `r` (drops a lot when the picture is blurred). */
  const sharpness = (r) => {
    let s = 0
    let n = 0
    const lum = (x, y) => {
      const p = px(x, y)
      return p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114
    }
    for (let y = Math.round(r.y); y < Math.round(r.y + r.h) - 1; y += 2) {
      for (let x = Math.round(r.x); x < Math.round(r.x + r.w) - 1; x += 2) {
        const v = lum(x, y)
        s += (lum(x + 1, y) - v) ** 2 + (lum(x, y + 1) - v) ** 2
        n++
      }
    }
    return s / n
  }
  return { px, mean, bright, dark, sharpness }
}

const near = (p, want, tol = 18) => p.every((v, i) => Math.abs(v - want[i]) <= tol)
const fmt = (p) => `rgb(${p.map((v) => Math.round(v)).join(',')})`
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
const mix = (a, b, k) => a.map((v, i) => v * (1 - k) + b[i] * k)
const GRAY = [128, 128, 128]
const GREEN = hex('#00a040')
const BLUE = hex('#2040c0')
const RED = hex('#c02040')
const shot = (file, index, name) => SHOTS && fx.savePng(file, index, path.join(SHOTS, `${name}.png`))

const STYLE = { background: { type: 'color', color: '#00a040' }, padding: 0.08, cornerRadius: 12, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }

/* ---------- editor helpers ---------- */

const timecode = (win) => win.$eval('.timecode', (e) => e.textContent)
const outTime = (tc) => {
  const [m, s] = tc.split('/')[0].trim().split(':')
  return Number(m) * 60 + Number(s)
}
const isPlaying = (win) => win.$eval('.transport .btn.round', (b) => b.dataset.playing === 'true')
const paletteTitles = (win) => win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent))
const activeTab = (win) => win.$eval('.insp-tabs button.active', (b) => b.textContent.trim())

async function playheadAt(win, seconds) {
  // With an item selected the arrows move it (E-09, docs/design/versions.md §4.1): Esc clears the selection first.
  await win.keyboard.press('Escape')
  await win.keyboard.press('Home')
  for (let i = 0; i < seconds; i++) await win.keyboard.press('Shift+ArrowRight')
  await f.waitFor(async () => Math.abs(outTime(await timecode(win)) - seconds) < 0.05, `playhead at ${seconds} s`, 3000)
}

const playheadIs = (win, seconds, what) => f.waitFor(async () => Math.abs(outTime(await timecode(win)) - seconds) < 0.05, what, 3000)

async function runCommand(win, query, expectTitle) {
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type(query)
  await f.waitFor(async () => (await paletteTitles(win))[0] === expectTitle, `"${query}" lists ${expectTitle} first`, 3000)
  await win.keyboard.press('Enter')
  await f.waitFor(async () => !(await win.$('.command-palette')), 'palette closes after running', 3000)
}

/** Waits until the saved project.json matches `pred`, and returns it. */
const saved = (home, id, pred, what) => f.waitFor(() => {
  try {
    const p = h.readProject(home, id)
    return pred(p) ? p : null
  } catch {
    return null
  }
}, what, 10000)

async function main() {
  await test('titles: a centered card covers the frame, a lower third leaves the top visible, both fade (export)', fx.withHome('titles-pixels', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 6 })
    fx.seedProject(home, { id: 'rec-titles', name: 'Titles', media, seconds: 6, style: STYLE, effects: NO_FX })
    addItems(home, 'rec-titles', {
      titles: [
        title('a', 1, 2, { title: 'Hello world' }),
        title('b', 2.5, 3.5, { style: 'lower-third', title: 'Jane Doe', subtitle: 'Product designer', color: '#c02040' }),
        title('c', 4, 5, { title: 'Our background', background: 'style' }),
        title('d', 5.2, 6, { title: 'BIG', style: 'big' })
      ]
    })
    const { app, win } = await launch(ctx, home)
    await fx.openProject(win, 'Titles')
    const out = path.join(home, 'titles.mp4')
    await exportOpen(app, win, out)
    for (const [i, name] of [[15, 'none'], [33, 'fade-in'], [45, 'centered'], [57, 'fade-out'], [90, 'lower-third'], [135, 'style'], [170, 'big']]) shot(out, i, `titles-${name}`)

    // Before any card: the background around the recording, the recording in the middle.
    let fr = frameOf(out, 15)
    h.assert(near(fr.mean({ x: 4, y: 4, w: 30, h: 30 }), GREEN, 12), `no card at 0.5 s: background corner (${fmt(fr.mean({ x: 4, y: 4, w: 30, h: 30 }))})`)
    h.assert(near(fr.mean({ x: W * 0.45, y: H * 0.2, w: 60, h: 40 }), GRAY, 10), 'no card at 0.5 s: the recording')

    // Fully shown at 1.5 s: the card's colour everywhere but the text, white text in the middle.
    fr = frameOf(out, 45)
    for (const [x, y] of [[4, 4], [W - 34, 4], [4, H - 34], [W - 34, H - 34], [W * 0.45, H * 0.15], [W * 0.45, H * 0.85]]) {
      const c = fr.mean({ x, y, w: 30, h: 30 })
      h.assert(near(c, BLUE, 10), `the centered card covers the frame at (${Math.round(x)}, ${Math.round(y)}): ${fmt(c)}`)
    }
    const middle = { x: W * 0.25, y: H * 0.4, w: W * 0.5, h: H * 0.2 }
    h.assert(fr.bright(middle) > 800, `readable white text in the middle (${fr.bright(middle)} white pixels)`)
    h.assert(fr.bright({ x: 0, y: 0, w: W, h: H * 0.3 }) === 0 && fr.bright({ x: 0, y: H * 0.7, w: W, h: H * 0.3 }) === 0, 'and nowhere else')

    // Fading in (1.1 s) and out (1.9 s): between the background and the card's colour (ease-out cubic over 0.35 s).
    const k = 1 - (1 - 0.1 / 0.35) ** 3
    for (const [i, what] of [[33, 'fading in'], [57, 'fading out']]) {
      fr = frameOf(out, i)
      const c = fr.mean({ x: 4, y: 4, w: 30, h: 30 })
      h.assert(near(c, mix(GREEN, BLUE, k), 16) && !near(c, BLUE, 12) && !near(c, GREEN, 12), `${what}: corner ${fmt(c)} is part way (${fmt(mix(GREEN, BLUE, k))})`)
    }

    // A lower third at 3 s: the top of the video is untouched, the band sits at the bottom left.
    fr = frameOf(out, 90)
    h.assert(near(fr.mean({ x: W * 0.4, y: H * 0.15, w: 100, h: 60 }), GRAY, 10), `the recording shows above a lower third (${fmt(fr.mean({ x: W * 0.4, y: H * 0.15, w: 100, h: 60 }))})`)
    h.assert(near(fr.mean({ x: 4, y: 4, w: 30, h: 30 }), GREEN, 12), 'and the background around it')
    const measure = (s, px, weight) => s.length * px * (weight >= 700 ? 0.55 : 0.5)
    const l = titleCards.titleLayout({ title: 'Jane Doe', subtitle: 'Product designer', style: 'lower-third' }, W, H, measure)
    const band = l.band
    const inBand = fr.mean({ x: band.x + band.padX * 0.2, y: band.y + band.h * 0.4, w: Math.max(2, band.padX * 0.5), h: band.h * 0.2 })
    h.assert(near(inBand, RED, 14), `the band's colour at the bottom left (${fmt(inBand)} at ${Math.round(band.x)}, ${Math.round(band.y)})`)
    h.assert(fr.bright({ x: band.x, y: band.y, w: W * 0.5, h: band.h }) > 300, 'its text is in the band')
    h.assert(near(fr.mean({ x: W - 300, y: band.y + band.h / 2 - 10, w: 60, h: 20 }), GRAY, 10), 'the video goes on to the right of the band')

    // The project's background as the card's background: the recording is covered by it.
    fr = frameOf(out, 135)
    for (const [x, y] of [[4, 4], [W * 0.45, H * 0.2], [W * 0.45, H * 0.8]]) {
      h.assert(near(fr.mean({ x, y, w: 30, h: 30 }), GREEN, 12), `a "background" card covers the recording with the project's background at (${Math.round(x)}, ${Math.round(y)})`)
    }
    // Big: much larger letters than the centered title (white pixels per letter).
    const big = frameOf(out, 170).bright({ x: 0, y: H * 0.15, w: W, h: H * 0.7 }) / 'BIG'.length
    const centered = frameOf(out, 45).bright({ x: 0, y: H * 0.15, w: W, h: H * 0.7 }) / 'Helloworld'.length
    h.assert(big > centered * 2.5, `the big style's letters are large (${Math.round(big)} vs ${Math.round(centered)} white pixels per letter)`)
  }))

  await test('titles: a "background" card on a light project background has dark text (export)', fx.withHome('titles-light', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 2 })
    const LIGHT = hex('#f1f5f9')
    fx.seedProject(home, { id: 'rec-light', name: 'Light', media, seconds: 2, style: { ...STYLE, background: { type: 'color', color: '#f1f5f9' } }, effects: NO_FX })
    // No text colour of its own: the default follows the project's background.
    const card = title('a', 0.5, 2, { title: 'Light background', background: 'style' })
    delete card.textColor
    addItems(home, 'rec-light', { titles: [card] })
    const { app, win } = await launch(ctx, home)
    await fx.openProject(win, 'Light')
    const out = path.join(home, 'light.mp4')
    await exportOpen(app, win, out)
    shot(out, 40, 'titles-light')
    const fr = frameOf(out, 40)
    h.assert(near(fr.mean({ x: W * 0.45, y: H * 0.15, w: 30, h: 30 }), LIGHT, 10), `the light background covers the recording (${fmt(fr.mean({ x: W * 0.45, y: H * 0.15, w: 30, h: 30 }))})`)
    const middle = { x: W * 0.2, y: H * 0.4, w: W * 0.6, h: H * 0.2 }
    h.assert(fr.dark(middle) > 800, `dark text in the middle (${fr.dark(middle)} dark pixels)`)
    h.assert(fr.bright(middle, 252) < 50, `no white text (${fr.bright(middle, 252)} white pixels)`)
  }))

  await test('titles: the blurred-video background is soft and darker than the video', fx.withHome('titles-blur', async (ctx, home) => {
    const media = f.makeVideo({ seconds: 3, width: 1280, height: 720, fps: 60 })
    fx.seedProject(home, { id: 'rec-blur', name: 'Blur card', media, seconds: 3, style: { ...STYLE, padding: 0 }, effects: NO_FX })
    addItems(home, 'rec-blur', { titles: [title('a', 1, 3, { background: 'blur', title: '' })] })
    const { app, win } = await launch(ctx, home)
    await fx.openProject(win, 'Blur card')
    const out = path.join(home, 'blur.mp4')
    await exportOpen(app, win, out)
    shot(out, 15, 'blur-before')
    shot(out, 60, 'blur-card')
    const before = frameOf(out, 15)
    const card = frameOf(out, 60)
    const r = { x: W * 0.1, y: H * 0.1, w: W * 0.8, h: H * 0.8 }
    const sharp = before.sharpness(r)
    const soft = card.sharpness(r)
    h.assert(soft < sharp * 0.05, `the video under the card is blurred (sharpness ${soft.toFixed(1)} vs ${sharp.toFixed(1)})`)
    const lum = (p) => p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114
    h.assert(lum(card.mean(r)) < lum(before.mean(r)) * 0.8, `and darkened so text reads on it (${fmt(card.mean(r))} vs ${fmt(before.mean(r))})`)
    // Not a flat colour: the blurred picture still varies across the frame.
    const a = card.mean({ x: W * 0.1, y: H * 0.5, w: 40, h: 40 })
    const b = card.mean({ x: W * 0.8, y: H * 0.15, w: 40, h: 40 })
    h.assert(a.some((v, i) => Math.abs(v - b[i]) > 12), `the blurred video, not a flat fill (${fmt(a)} / ${fmt(b)})`)
  }))

  await test('chapters: written at their output times after a cut (MP4 and M4A), copied as YouTube timestamps', fx.withHome('titles-chapters', async (ctx, home) => {
    const id = f.seedProject(home, { id: 'rec-ch', name: 'Chapters', seconds: 20, width: 640, height: 360, fps: 30, audio: true, clips: [{ id: 'c0', start: 0, end: 5, speed: 1 }, { id: 'c1', start: 8, end: 20, speed: 1 }] })
    addItems(home, id, {
      chapters: [
        { id: 'h3', t: 12, title: 'Demo' },
        { id: 'h1', t: 0, title: 'Intro' },
        // Inside the cut (5-8 s): starts where the video goes on, at 5 s.
        { id: 'h2', t: 6, title: 'Setup; part = 1' }
      ]
    })
    const { app, win } = await launch(ctx, home)
    await fx.openProject(win, 'Chapters')
    const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', file]).toString()).chapters.map((c) => [+Number(c.start_time).toFixed(3), +Number(c.end_time).toFixed(2), c.tags.title])
    const want = [[0, 5, 'Intro'], [5, 9, 'Setup; part = 1'], [9, 17, 'Demo']]

    const mp4 = path.join(home, 'chapters.mp4')
    await exportOpen(app, win, mp4, { resolution: '720p' })
    h.assert(JSON.stringify(probe(mp4)) === JSON.stringify(want), `MP4 chapters ${JSON.stringify(probe(mp4))}`)
    const m4a = path.join(home, 'chapters.m4a')
    await exportOpen(app, win, m4a, { format: 'M4A' })
    h.assert(JSON.stringify(probe(m4a)) === JSON.stringify(want), `M4A chapters ${JSON.stringify(probe(m4a))}`)

    // Copy chapters: YouTube timestamps, and why YouTube would not use them (chapters under 10 s).
    await fx.openExportDialog(win)
    await win.waitForSelector('[data-testid="export-chapters"]')
    h.assert(/3 chapters/.test(await win.textContent('[data-testid="export-chapters"]')), 'the dialog says how many chapters go into the file')
    await app.evaluate(({ clipboard }) => clipboard.writeText('nothing yet'))
    await win.click('[data-testid="export-chapters"] button:has-text("Copy chapters")')
    await f.waitFor(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === '0:00 Intro\n0:05 Setup; part = 1\n0:09 Demo', 'the chapters on the clipboard', 5000)
    await win.waitForSelector('[data-testid="export-chapters"] button:has-text("Copied")')
    const warn = await win.textContent('[data-testid="export-chapters"] .hint.warn')
    h.assert(/at least 10 seconds/.test(warn), `says YouTube needs 10 s chapters: ${warn}`)
    await win.click('.modal button[title="Close"]')
  }))

  await test('titles: palette and keys add titles and chapters, chapter keys move the playhead, flags drag, the Text panel renames', fx.withHome('titles-edit', async (ctx, home) => {
    const id = f.seedProject(home, { name: 'TitleEdit', seconds: 12 })
    const { win } = await launch(ctx, home)
    await f.openProject(win, 'TitleEdit')
    h.assert(await win.$('.title-track'), 'the title track is on the timeline')
    h.assert((await win.textContent('.title-lane .tl-empty')) === 'Double-click to add a title card, or press Shift + T', `empty hint names the key: ${await win.textContent('.title-lane .tl-empty')}`)

    // A title card from the palette, at the playhead; the Text panel edits it.
    await playheadAt(win, 2)
    await runCommand(win, 'add title', 'Add title card at playhead')
    let p = await saved(home, id, (q) => q.titles?.length === 1, 'a title card')
    h.assert(Math.abs(p.titles[0].start - 2) < 0.02 && Math.abs(p.titles[0].end - 5) < 0.02, `starts at the playhead: ${p.titles[0].start}..${p.titles[0].end}`)
    await win.waitForSelector(`.title-seg.selected[data-title="${p.titles[0].id}"]`)
    h.assert((await activeTab(win)) === 'Text', 'the Text panel shows it')
    await win.fill('textarea[aria-label="Title"]', 'Chapter one')
    await win.fill('input[aria-label="Subtitle"]', 'Getting started')
    await win.click('.title-style:has-text("Lower third")')
    p = await saved(home, id, (q) => q.titles[0].title === 'Chapter one' && q.titles[0].subtitle === 'Getting started' && q.titles[0].style === 'lower-third', 'the edited card')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.title-seg.selected')), 'Esc clears the selection')

    // Shift+T adds another.
    await playheadAt(win, 7)
    await win.keyboard.press('Shift+T')
    await saved(home, id, (q) => q.titles?.length === 2, 'Shift+T adds a title card')

    // Chapters: palette at 4 s, M at 8 s; flags on the timeline.
    await playheadAt(win, 4)
    await runCommand(win, 'add chapter', 'Add chapter at playhead')
    await playheadAt(win, 8)
    await win.keyboard.press('m')
    p = await saved(home, id, (q) => q.chapters?.length === 2, 'two chapters')
    const byT = [...p.chapters].sort((a, b) => a.t - b.t)
    h.assert(Math.abs(byT[0].t - 4) < 0.02 && Math.abs(byT[1].t - 8) < 0.02, `at the playhead: ${byT.map((c) => c.t)}`)
    h.assert(byT[0].title === 'Chapter 1' && byT[1].title === 'Chapter 2', `numbered names: ${byT.map((c) => c.title)}`)
    await f.waitFor(async () => (await win.$$('.chapter-flag')).length === 2, 'two flags on the timeline')
    // M again on the same place selects that chapter instead of adding one.
    await win.keyboard.press('m')
    await win.waitForSelector('.notice:has-text("already starts here")')

    // Next / previous chapter.
    await win.keyboard.press('Home')
    await win.keyboard.press('Shift+PageDown')
    await playheadIs(win, 4, 'Shift+Page Down goes to the first chapter')
    await win.keyboard.press('Shift+PageDown')
    await playheadIs(win, 8, 'and on to the next')
    await win.keyboard.press('Shift+PageUp')
    await playheadIs(win, 4, 'Shift+Page Up goes back')
    // While playing: well into a chapter it goes to that chapter's start, and pressed again right
    // after (the video playing on) to the one before, not back to the same one.
    await playheadAt(win, 10)
    await win.keyboard.press('Space')
    await f.waitFor(() => isPlaying(win), 'Space plays')
    await win.keyboard.press('Shift+PageUp')
    await f.waitFor(async () => {
      const t = outTime(await timecode(win))
      return t >= 7.95 && t < 9
    }, 'playing: Shift+Page Up goes to the start of the chapter', 3000)
    await h.sleep(250)
    await win.keyboard.press('Shift+PageUp')
    await f.waitFor(async () => {
      const t = outTime(await timecode(win))
      return t >= 3.95 && t < 5.5
    }, 'and again, while it plays on, to the chapter before', 3000)
    await win.keyboard.press('Space')
    await f.waitFor(async () => !(await isPlaying(win)), 'Space pauses')
    await win.keyboard.press('End')
    await win.keyboard.press('Shift+PageDown')
    await win.waitForSelector('.notice:has-text("no chapter after the playhead")')

    // Rename in the Text panel.
    await runCommand(win, 'open text', 'Open Text settings')
    const nameField = `[data-chapter-item="${byT[0].id}"] input`
    await win.fill(nameField, 'Intro')
    await saved(home, id, (q) => q.chapters.find((c) => c.id === byT[0].id)?.title === 'Intro', 'the renamed chapter')
    await win.keyboard.press('Escape')

    // Drag the second flag one second to the right.
    const pxPerSec = Number(await win.$eval('.tl-content', (e) => e.dataset.pxPerSec))
    const flag = await win.$(`.chapter-flag[data-chapter="${byT[1].id}"]`)
    const box = await flag.boundingBox()
    await win.mouse.move(box.x + 4, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + 4 + pxPerSec * 0.5, box.y + box.height / 2, { steps: 4 })
    await win.mouse.move(box.x + 4 + pxPerSec, box.y + box.height / 2, { steps: 4 })
    await win.mouse.up()
    p = await saved(home, id, (q) => Math.abs(q.chapters.find((c) => c.id === byT[1].id).t - 9) < 0.1, 'the dragged chapter at about 9 s')
    await win.waitForSelector(`.chapter-flag.selected[data-chapter="${byT[1].id}"]`)
    // Delete removes the selected chapter; undo brings it back.
    await win.keyboard.press('Delete')
    await saved(home, id, (q) => q.chapters.length === 1, 'Delete removes the chapter')
    await win.keyboard.press('Control+z')
    await saved(home, id, (q) => q.chapters.length === 2, 'undo brings it back')
  }))

  await test('titles: camera layout commands set the layout at the playhead on a recording with a camera', fx.withHome('titles-layout', async (ctx, home) => {
    const id = f.seedProject(home, { name: 'WithCamera', seconds: 12, webcam: true })
    f.seedProject(home, { id: 'rec-nocam', name: 'NoCamera', seconds: 12 })
    const { win } = await launch(ctx, home)
    await f.openProject(win, 'WithCamera')
    await playheadAt(win, 3)
    await runCommand(win, 'side by side', 'Camera layout: side by side')
    let p = await saved(home, id, (q) => q.layouts?.length === 1, 'a layout segment')
    h.assert(p.layouts[0].layout === 'side-by-side' && Math.abs(p.layouts[0].start - 3) < 0.02 && p.layouts[0].end > 3.5, `side by side from the playhead: ${JSON.stringify(p.layouts[0])}`)
    // Again inside it: the segment changes instead of another being stacked.
    await runCommand(win, 'camera only', 'Camera layout: camera only')
    p = await saved(home, id, (q) => q.layouts?.[0]?.layout === 'camera-only', 'the segment under the playhead changes')
    h.assert(p.layouts.length === 1, 'still one segment')
    // At the very end of the video: a segment ending with it, after the one before.
    await win.keyboard.press('End')
    await runCommand(win, 'side by side', 'Camera layout: side by side')
    p = await saved(home, id, (q) => q.layouts?.length === 2, 'a layout segment at the end')
    const last = p.layouts.find((s) => s.id !== p.layouts[0].id)
    h.assert(last.layout === 'side-by-side' && Math.abs(last.end - p.duration) < 0.02 && Math.abs(last.start - p.layouts[0].end) < 0.02, `ends with the video: ${JSON.stringify(last)}`)
    await win.click('header .btn.ghost >> nth=0')
    await f.openProject(win, 'NoCamera')
    await win.keyboard.press('Control+k')
    await win.keyboard.type('camera layout')
    await win.waitForSelector('.command-palette [data-command="layoutSideBySide"][aria-disabled="true"][title="This recording has no camera"]')
    await win.keyboard.press('Escape')
  }))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
