// Captions Studio (wave 9) end to end: docs/design/captions-studio.md §16.3, phase A (§0.4). Every
// project is seeded with a transcript (no network, no AI provider), drawn over a flat grey video, so
// whatever the export or the preview draws over it is easy to find:
//
//   1. An old project (0.8.0's boxed captions) opens and closes with project.json byte for byte
//      unchanged; its Classic tile is checked, first, "Your current style"; its export draws the
//      legacy box where the legacy layout puts it.
//   2. A tutorial look by keyboard: Tab reaches the gallery, the arrows reach Karaoke Fill, Enter
//      picks it (one undo step: Ctrl+Z, Ctrl+Y); the paused preview and the exported frame at the
//      same time have the same shares of spoken yellow and white in the caption band.
//   3. A Short look: Bold Pop on a 9:16 project pops in (its ink grows over the first 0.3 s) and
//      turns the spoken word green; Make my captions great (offline) adds emphasis and a 300 %
//      counter in one undo step.
//   4. Bangla: Bold Pop draws Bangla in Baloo Da 2 from the bundled files with no http(s) request;
//      the Digits choice writes ৩০০ (the preview's band changes) and the export draws the caption.
//   5. Pop-ups: a keyword, an emoji and a counter added from the Graphics tab's Add menu by
//      keyboard show in the export at their times, and nothing shows between them.
//   6. Keyboard and the hovered look: Tab reaches Make my captions great, its options, the gallery,
//      Play and Show all styles; the options popover keeps the focus and Esc returns it; hovering a
//      tile previews it on the video with its label, changing neither the project nor its undo.
//   7. The options left open as Shift+R opens the Review panel over the Inspector keep no keys: Tab
//      and Shift+Tab move in the panel, Esc closes only the panel, and the options then keep Tab
//      and close on Esc again.
//
// SSW_E2E_ONLY=<part of a test name> runs one test; SSW_E2E_DOC_SHOTS=1 also writes the pictures
// docs/screenshots/captions-studio-*.png.
//
// The data-testid values of §2 (frozen by the contracts commit; the UI parts use exactly these):
//
//   Captions › Look (§2.4, part P3)
//     caption-look              the section (shown with a transcript)
//     captions-show             toggle "Show captions"
//     captions-great            button "Make my captions great" (hint under it from the resolved options)
//     captions-great-options    icon button "Choose what Make my captions great does"
//     caption-gallery-filter    chips: Long videos, Short clips, Classic, Mine, Brand, All
//     caption-gallery           the tiles, role="radiogroup", aria-label "Caption style"
//     caption-gallery-more      "Show all styles" (aria-expanded)
//     caption-tile-play         "Play a preview of …", beside the grid (reduced motion)
//     caption-style-name        "Bold Pop" or "Bold Pop (edited)"
//     caption-style-reset       "Reset" while edited
//     caption-style-save        "Save as my style"
//     caption-text, caption-colours, caption-layout, caption-motion, caption-emphasis, caption-speakers
//                               the collapsible sub-sections (aria-expanded)
//   Text (§2.6)
//     caption-font, caption-weight, caption-size, caption-case, caption-tracking
//   Colours (§2.6, §7.3)
//     caption-theme, caption-color-text, caption-color-spoken, caption-color-emphasis,
//     caption-color-emphasis2, caption-outline, caption-shadow, caption-box, caption-box-alpha,
//     caption-glow, caption-gradient, caption-contrast, caption-contrast-fix
//   Layout (§2.6)
//     caption-chunk, caption-words, caption-lines, caption-line-length, caption-position,
//     caption-position-reset, caption-avoid
//   Motion (§2.6)
//     caption-enter, caption-exit, caption-word, caption-spoken, caption-upcoming, caption-strength,
//     caption-speed, caption-calm
//   Speakers (§2.6)
//     caption-speaker-colors    toggle "A colour for each speaker" (disabled while names are off)
//   Emphasis (§2.7)
//     caption-emphasis-find, caption-emphasis-clear, caption-emphasis-size, caption-emphasis-font,
//     caption-emphasis-mark, caption-emphasis-motion
//   Transcript tab (§2.7)
//     caption-row-position      a caption row's menu item "Position": Auto, Top, Bottom
//   Make my captions great's options (§2.8, part P4; role="dialog")
//     great-options, great-style, great-emphasis, great-emoji, great-keywords, great-counters,
//     great-lists, great-speakers, great-chapters, great-quotes, great-tidy, great-sound, great-provider
//   Clean up (§2.9, part P4)
//     caption-cleanup, cleanup-caps, cleanup-punct, cleanup-digits, cleanup-words, cleanup-bleep,
//     cleanup-bleep-sound, cleanup-ai, cleanup-ai-provider, cleanup-run
//   Languages (§2.10, part P4)
//     caption-languages, track-show, track-retranslate, track-remove, track-add, track-translate
//   Graphics (§2.11, part P3)
//     graphics                  the Inspector tab (after Captions, icon "burst")
//     graphics-generate         "Add pop-ups from captions"
//     graphics-sound            select "Sound on pop-ups"
//   Export dialog (§2.13, part P4)
//     export-subtitles          the Subtitles field
//     export-subtitle-streams   "Also inside the video (players can switch them)"
//
// localStorage keys (per window): captions-gallery-filter, captions-look-open, captions-calm-hint.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SECONDS = 10
const DOC_SHOTS = process.env.SSW_E2E_DOC_SHOTS ? path.join(h.APP_DIR, 'docs', 'screenshots') : null
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-captions-studio-mod-'))
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))
/** The legacy caption layout (layout.ts), bundled for Node: where the export draws a legacy caption. */
const layout = (() => {
  const outfile = path.join(scratch, 'layout.cjs')
  esbuild.buildSync({ stdin: { contents: "export * from './src/shared/captions/layout'\n", resolveDir: h.APP_DIR, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  return require(outfile)
})()

/* ---------- fixtures (§16.3) ---------- */

/** Words with their times: `step` s apart, each spoken for `len` s (a gap after each). */
const timed = (start, text, step = 0.5, len = 0.4) => text.split(' ').map((w, i) => ({ text: w, start: +(start + i * step).toFixed(3), end: +(start + i * step + len).toFixed(3) }))
const C1 = { id: 'c1', start: 0.5, end: 3.0, text: 'Make every word count today', words: timed(0.5, 'Make every word count today') }
const C2 = { id: 'c2', start: 3.5, end: 6.5, text: 'Sales grew 300 percent this year', words: timed(3.5, 'Sales grew 300 percent this year') }
const C3 = { id: 'c3', start: 7.0, end: 9.8, text: 'Three steps: first open settings, second click export, finally save', words: timed(7.0, 'Three steps: first open settings, second click export, finally save', 0.27, 0.24) }
const BN1 = { id: 'b1', start: 0.5, end: 3.0, text: 'আমরা আজ Flown শিখব', words: timed(0.5, 'আমরা আজ Flown শিখব', 0.6, 0.5) }
const BN2 = { id: 'b2', start: 3.5, end: 6.5, text: 'মোট 300 জন এসেছেন', words: timed(3.5, 'মোট 300 জন এসেছেন', 0.7, 0.6) }

const transcript = (segments, language = 'en') => ({ provider: 'openai', model: 'test-model', createdAt: '2026-10-01T09:00:00.000Z', language, segments })
/** The captions as 0.8.0 saved them (before Captions Studio). */
const OLD_CAPTIONS = { show: true, preset: 'boxed', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#facc15', background: 'box', maxLines: 2 }
const FLAT = { background: { type: 'color', color: '#808080' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }

const projectFile = (home, id) => path.join(h.projectsRoot(home), id, 'project.json')

/** A 10 s grey project (1280×720, or 720×1280 when `tall`) with `extra` merged into project.json. */
function seed(home, { id, name, tall = false, extra = {} }) {
  const width = tall ? 720 : 1280
  const height = tall ? 1280 : 720
  const media = fx.solidVideo({ seconds: SECONDS, width, height })
  fx.seedProject(home, { id, name, media, seconds: SECONDS, width, height, style: FLAT, effects: NO_FX })
  const file = projectFile(home, id)
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
  return id
}

/* ---------- the app ---------- */

async function launch(ctx, home, env = {}) {
  const { app, win, logs } = await h.launch({ home, env })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

/** Opens the project named exactly `name` and waits for its first frame. */
async function open(win, name) {
  const card = `.project-open:has(.project-name:text-is("${name}"))`
  await win.waitForSelector(card, { timeout: 30000 })
  await win.click(card)
  await win.waitForSelector('.editor .preview-canvas', { timeout: 60000 })
  await h.sleep(1000)
}

async function backHome(win) {
  await win.click('button[aria-label="Back to recordings"]')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

async function captionsTab(win) {
  await win.click('.insp-tabs button:has-text("Captions")')
  await win.waitForSelector('[data-testid="caption-look"]', { timeout: 10000 })
}

/** Waits until the saved project.json matches `pred`, and returns it. */
const saved = (home, id, pred, what, timeout = 10000) =>
  f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return pred(p) ? p : null
      } catch {
        return null
      }
    },
    what,
    timeout
  )

/** Moves the playhead to source time `t` by clicking the ruler (paused). */
async function seekTo(win, t) {
  const x = await win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
  const y = await win.$eval('.tl-ruler', (el) => {
    const b = el.getBoundingClientRect()
    return b.y + b.height / 2
  })
  await win.mouse.click(x, y)
  await h.sleep(700)
}

/** The playhead's source time, read from where the timeline draws it (the transport shows tenths only). */
const playhead = (win) =>
  win.$eval('.tl-content', (el) => {
    const m = /translateX\(([-\d.]+)px\)/.exec(el.querySelector('.playhead')?.style.transform ?? '')
    return m ? Number(m[1]) / Number(el.dataset.pxPerSec) : NaN
  })

/** Presses Tab from `from` until the focus is inside `selector`; returns the test ids passed on the way. */
async function tabTo(win, from, selector, max = 250) {
  await win.focus(from)
  const passed = new Set()
  for (let i = 0; i < max; i++) {
    await win.keyboard.press('Tab')
    const at = await win.evaluate((sel) => ({ inside: !!document.activeElement?.closest(sel), id: document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? null }), selector)
    if (at.id) passed.add(at.id)
    if (at.inside) return passed
  }
  throw new Error(`Tab never reached ${selector}`)
}

const focusedTile = (win) => win.evaluate(() => document.activeElement?.getAttribute('data-tile') ?? null)
const focusedTestId = (win) => win.evaluate(() => document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? null)
const noticeHas = (win, text, what) => f.waitFor(async () => ((await win.textContent('.notice-slot').catch(() => '')) || '').includes(text), what, 15000)

/** Exports the open project as MP4 at 720p and `fps` to `out`, and closes the dialog. */
async function exportOpen(app, win, out, fps = 30) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Format', 'MP4')
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', `${fps} fps`)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached' })
}

/* ---------- pixels ---------- */

const GREY = [128, 128, 128]
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
const near = (want, tol) => (p) => p.every((v, i) => Math.abs(v - want[i]) <= tol)
/** Anything not the grey video (the encoder moves grey by a few levels). */
const INK = (p) => !near(GREY, 24)(p)
const WHITE = (p) => p.every((v) => v >= 215)
/** Karaoke Fill's spoken yellow (#ffe14d). */
const YELLOW = (p) => p[0] >= 200 && p[1] >= 175 && p[2] <= 140
/** Bold Pop's spoken green (#39e508). */
const GREEN = (p) => p[1] >= 170 && p[0] <= 140 && p[2] <= 120
const BOX = (p) => p.every((v) => v <= 75)

/** An RGB picture with counters over rectangles. */
function picture(width, height, at) {
  const count = (r, pred, step = 1) => {
    let n = 0
    let all = 0
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let y = Math.max(0, Math.round(r.y)); y < Math.min(height, Math.round(r.y + r.h)); y += step) {
      for (let x = Math.max(0, Math.round(r.x)); x < Math.min(width, Math.round(r.x + r.w)); x += step) {
        all++
        if (!pred(at(x, y))) continue
        n++
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
    return { n, share: all ? n / all : 0, box: n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null }
  }
  return { width, height, px: at, count }
}

/** Frames `indices` of an export, as pictures. */
function framesOf(file, indices) {
  const { width, height, frames } = fx.framesAt(file, indices, 'rgb24')
  return frames.map((buf) =>
    picture(width, height, (x, y) => {
      const i = (y * width + x) * 3
      return [buf[i], buf[i + 1], buf[i + 2]]
    })
  )
}
const frameOf = (file, index) => framesOf(file, [index])[0]

/** The paused preview canvas, read whole. */
async function previewPicture(win) {
  const { width, height, data } = await win.evaluate(() => {
    const c = document.querySelector('.preview-canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    return { width: c.width, height: c.height, data: Array.from(d) }
  })
  return picture(width, height, (x, y) => {
    const i = (y * width + x) * 4
    return [data[i], data[i + 1], data[i + 2]]
  })
}

/** A fingerprint of the preview canvas inside the normalised rectangle `r`. */
const previewPrint = (win, r) =>
  win.evaluate((rr) => {
    const c = document.querySelector('.preview-canvas')
    const x = Math.round(rr.x * c.width)
    const y = Math.round(rr.y * c.height)
    const d = c.getContext('2d').getImageData(x, y, Math.max(1, Math.round(rr.w * c.width)), Math.max(1, Math.round(rr.h * c.height))).data
    let hash = 2166136261
    for (let i = 0; i < d.length; i++) hash = Math.imul(hash ^ d[i], 16777619)
    return hash >>> 0
  }, r)

/** The lower part of a picture, where these looks put their captions (bottom 35%). */
const lowBand = (p) => ({ x: 0, y: p.height * 0.65, w: p.width, h: p.height * 0.35 })

/* ---------- pictures for the docs ---------- */

/** Saves a PNG of `locator` (or the window) as docs/screenshots/captions-studio-<name>.png, under 300 KB. */
async function docShot(win, name, locator = null) {
  if (!DOC_SHOTS) return
  fs.mkdirSync(DOC_SHOTS, { recursive: true })
  const file = path.join(DOC_SHOTS, `captions-studio-${name}.png`)
  const raw = path.join(scratch, `${name}.png`)
  if (locator) await locator.screenshot({ path: raw })
  else await win.screenshot({ path: raw })
  // Scaled down until it fits (the pictures are for reading, not for pixels).
  for (const width of [0, 1400, 1100, 900, 700]) {
    if (width) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', `scale='min(${width},iw)':-1:flags=lanczos`, '-pix_fmt', 'rgb24', file])
    else fs.copyFileSync(raw, file)
    if (fs.statSync(file).size < 300 * 1024) return
  }
  throw new Error(`${file} is over 300 KB`)
}

/* ---------- the tests ---------- */

async function main() {
  await test('an old project opens and closes unchanged, shows its Classic tile first and exports the legacy box', fx.withHome('cs-old', async (ctx, home) => {
    seed(home, { id: 'rec-old', name: 'Old', extra: { transcript: transcript([C1, C2, C3]), captions: OLD_CAPTIONS } })
    const before = fs.readFileSync(projectFile(home, 'rec-old'))
    const { app, win } = await launch(ctx, home)
    await open(win, 'Old')
    await captionsTab(win)
    const first = await win.$eval('[data-testid="caption-gallery"] [role="radio"]', (el) => ({ tile: el.getAttribute('data-tile'), checked: el.getAttribute('aria-checked'), text: el.textContent }))
    h.assert(first.tile === 'legacy:boxed' && first.checked === 'true' && first.text.includes('Your current style'), `the first tile is the checked Classic Boxed, "Your current style" (got ${JSON.stringify(first)})`)
    await docShot(win, 'classic-current', win.locator('.inspector'))
    await backHome(win)
    await h.sleep(1500)
    h.assert(Buffer.compare(before, fs.readFileSync(projectFile(home, 'rec-old'))) === 0, 'project.json is byte for byte unchanged after opening and closing')

    await open(win, 'Old')
    const out = path.join(home, 'old.mp4')
    await exportOpen(app, win, out)
    const fr = frameOf(out, 48)
    // The legacy layout's band for this caption (layout.ts, measured as captions.e2e.cjs does).
    const measure = (s, px) => s.length * px * 0.5
    const l = layout.captionLayout({ start: 0, end: 1, text: 'x' }, OLD_CAPTIONS, fr.width, fr.height, measure)
    const placed = layout.placeChunk(l, l.chunks[0], 'bottom', fr.width, fr.height)
    const band = { x: 0, y: placed.top - 4, w: fr.width, h: placed.height + 8 }
    const inBand = fr.count(band, BOX)
    const above = fr.count({ x: 0, y: 0, w: fr.width, h: band.y - 2 }, BOX)
    h.assert(inBand.n > 2000 && above.n === 0, `the legacy box is in its band (${inBand.n} dark pixels) and nowhere above it (${above.n})`)
    h.assert(fr.count(band, WHITE).n > 200, 'white text on the box')
    await backHome(win)
    await h.sleep(1500)
    h.assert(Buffer.compare(before, fs.readFileSync(projectFile(home, 'rec-old'))) === 0, 'exporting does not rewrite project.json either')
  }))
  await wideTests()
  await shortTests()
  await banglaTests()
  await popupTests()
  await keyboardTests()
}


async function wideTests() {
  await test('a tutorial look by keyboard is one undo step, and the paused preview equals the export', fx.withHome('cs-wide', async (ctx, home) => {
    seed(home, { id: 'rec-wide', name: 'Wide', extra: { transcript: transcript([C1, C2, C3]) } })
    const { app, win } = await launch(ctx, home)
    await open(win, 'Wide')
    await captionsTab(win)
    // Tab from the Captions tab reaches the gallery; its tab stop is the checked tile.
    await tabTo(win, '.insp-tabs button:has-text("Captions")', '[data-testid="caption-gallery"]')
    h.assert((await focusedTile(win)) === 'legacy:clean', `the gallery's tab stop is the checked Classic Clean (got ${await focusedTile(win)})`)
    for (let i = 0; i < 12 && (await focusedTile(win)) !== 'karaoke-fill'; i++) await win.keyboard.press('ArrowRight')
    h.assert((await focusedTile(win)) === 'karaoke-fill', 'the arrows reach Karaoke Fill')
    await win.keyboard.press('Enter')
    let p = await saved(home, 'rec-wide', (q) => q.captions?.studio?.from === 'karaoke-fill', 'Karaoke Fill saved')
    h.assert(p.captions.preset === 'karaoke' && p.captions.picked === true, `picked by hand, with its Classic fallback (${p.captions.preset}, picked ${p.captions.picked})`)
    await win.locator('[data-testid="caption-gallery"]').scrollIntoViewIfNeeded()
    await h.sleep(800)
    await docShot(win, 'gallery', win.locator('.inspector'))
    await win.keyboard.press('Control+z')
    p = await saved(home, 'rec-wide', (q) => !q.captions?.studio, 'Ctrl+Z takes the look back in one step')
    h.assert(!p.captions?.picked, 'and picked with it')
    await win.keyboard.press('Control+y')
    await saved(home, 'rec-wide', (q) => q.captions?.studio?.from === 'karaoke-fill' && q.captions.picked === true, 'Ctrl+Y brings it back')

    // Preview equals export: paused between "word" (1.5..1.9 s) and "count" (2.0 s).
    await seekTo(win, 1.95)
    const t = await playhead(win)
    h.assert(t > 1.9 && t < 2.0, `the playhead is in the gap after "word" (at ${t})`)
    await h.sleep(800)
    const shown = await previewPicture(win)
    await docShot(win, 'karaoke-fill-preview', win.locator('.preview-canvas'))
    const out = path.join(home, 'wide.mp4')
    await exportOpen(app, win, out, 60)
    const fr = frameOf(out, Math.round(t * 60))
    const shares = (pic) => {
      const band = lowBand(pic)
      return { yellow: pic.count(band, YELLOW).share, white: pic.count(band, WHITE).share, ink: pic.count(band, INK).share }
    }
    const a = shares(shown)
    const b = shares(fr)
    console.log(`  preview ${shown.width}x${shown.height} yellow ${(a.yellow * 100).toFixed(2)}% white ${(a.white * 100).toFixed(2)}% ink ${(a.ink * 100).toFixed(2)}%; export ${fr.width}x${fr.height} yellow ${(b.yellow * 100).toFixed(2)}% white ${(b.white * 100).toFixed(2)}% ink ${(b.ink * 100).toFixed(2)}%`)
    h.assert(a.yellow > 0.002 && b.yellow > 0.002, 'the spoken words are yellow in both')
    h.assert(a.white > 0.002 && b.white > 0.002, 'the words still to come are white in both')
    for (const k of ['yellow', 'white', 'ink']) h.assert(Math.abs(a[k] - b[k]) <= 0.02 && Math.abs(a[k] - b[k]) <= 0.35 * Math.max(a[k], b[k]), `${k}: the preview's share ${(a[k] * 100).toFixed(2)}% and the export's ${(b[k] * 100).toFixed(2)}% agree`)
    // The yellow sits left of the white (spoken words come first), in both.
    const order = (pic) => {
      const band = lowBand(pic)
      const y = pic.count(band, YELLOW).box
      const w = pic.count(band, WHITE).box
      return y.x / pic.width < (w.x + w.w) / pic.width
    }
    h.assert(order(shown) && order(fr), 'spoken yellow before the white words to come, in both')
  }))
}


async function shortTests() {
  await test('a Short look: Bold Pop pops in and turns the spoken word green; Make my captions great is one undo step', fx.withHome('cs-tall', async (ctx, home) => {
    seed(home, { id: 'rec-tall', name: 'Tall', tall: true, extra: { transcript: transcript([C1, C2, C3]) } })
    const { app, win } = await launch(ctx, home)
    await open(win, 'Tall')
    await captionsTab(win)
    // A tall frame opens the gallery on Short clips.
    const filter = await win.$eval('[data-testid="caption-gallery-filter"] button[aria-pressed="true"]', (b) => b.textContent.trim())
    h.assert(filter === 'Short clips', `the gallery opens on Short clips in a 9:16 project (got ${filter})`)
    await win.click('[data-testid="caption-gallery"] [data-tile="bold-pop"]')
    await saved(home, 'rec-tall', (q) => q.captions?.studio?.from === 'bold-pop' && q.captions.picked === true, 'Bold Pop saved, picked by hand')
    const name = await win.textContent('[data-testid="caption-style-name"]')
    h.assert(name.includes('Bold Pop'), `the name line reads Bold Pop (got ${name})`)
    await seekTo(win, 1.15)
    await h.sleep(600)
    await docShot(win, 'bold-pop-tall', win.locator('.preview-canvas'))

    const out = path.join(home, 'tall.mp4')
    await exportOpen(app, win, out)
    const [early, settled, spoken] = framesOf(out, [16, 24, 33])
    h.assert(early.height > early.width, `a tall export (${early.width}x${early.height})`)
    const inkA = early.count(lowBand(early), INK)
    const inkB = settled.count(lowBand(settled), INK)
    h.assert(inkA.box && inkB.box, 'the first chunk shows from its start')
    console.log(`  ink at +0.033 s: ${inkA.box.w}x${inkA.box.h}; at +0.3 s: ${inkB.box.w}x${inkB.box.h}`)
    h.assert(inkA.box.w < inkB.box.w, `it pops in: narrower at +0.033 s (${inkA.box.w} px) than at +0.3 s (${inkB.box.w} px)`)
    const cA = inkA.box.x + inkA.box.w / 2
    const cB = inkB.box.x + inkB.box.w / 2
    // Growing about its centre. The spoken first word pops about its own centre too (APPROVED-LOOK.md:
    // from 0.70 to 1.28 of its size in 0.06 s, back to 1.18 by 0.2 s and held): at +0.3 s it widens the
    // ink on the left only, so the line's centre is right of the ink's by a quarter of that word's
    // growth (its green fill). At +0.033 s the word is within its pop (0.70 to 1.28), so the ink's
    // centre lies within a quarter of that range of the line's centre.
    const lit = settled.count(lowBand(settled), GREEN).box
    h.assert(lit && lit.x - inkB.box.x < 20, 'the spoken first word is green at +0.3 s, at the left of the line')
    const word = lit.w / 1.18
    const line = cB + (lit.w - word) / 4
    const [lo, hi] = [line - (0.28 * word) / 4, line + (0.3 * word) / 4]
    h.assert(cA >= lo - 3 && cA <= hi + 3, `growing about its centre (${cA.toFixed(1)}, between ${lo.toFixed(1)} and ${hi.toFixed(1)})`)
    h.assert(spoken.count(lowBand(spoken), GREEN).n > 150, 'the spoken word is green at 1.1 s')
    h.assert(settled.count({ x: 0, y: 0, w: settled.width, h: settled.height * 0.5 }, INK).n === 0, 'nothing drawn in the top half')

    // Make my captions great, offline: marks and a counter for "300 percent", in one undo step.
    await win.click('[data-testid="captions-great"]')
    const p = await saved(home, 'rec-tall', (q) => (q.graphics ?? []).some((g) => g.kind === 'counter'), 'Make my captions great adds a counter', 20000)
    const counter = p.graphics.find((g) => g.kind === 'counter')
    h.assert(counter.to === 300 && counter.suffix === '%', `the counter counts to 300 % (got ${counter.to} ${counter.suffix})`)
    h.assert((p.captionMarks ?? []).length > 0, 'it emphasised words')
    h.assert(p.captions.studio.from === 'bold-pop', 'the look picked by hand is kept')
    await win.keyboard.press('Control+z')
    await saved(home, 'rec-tall', (q) => !(q.graphics ?? []).length && !(q.captionMarks ?? []).length, 'one Ctrl+Z takes the whole run back')
  }))
}


async function banglaTests() {
  await test('Bangla captions: a Bangla look from the bundled fonts with no request, and Bangla digits', fx.withHome('cs-bangla', async (ctx, home) => {
    seed(home, { id: 'rec-bn', name: 'Bangla', extra: { transcript: transcript([BN1, BN2], 'bn') } })
    const { app, win } = await launch(ctx, home)
    const requests = []
    win.on('request', (r) => /^https?:/i.test(r.url()) && requests.push(r.url()))
    await open(win, 'Bangla')
    await captionsTab(win)
    await win.click('[data-testid="caption-gallery-filter"] button:has-text("Short clips")')
    await win.click('[data-testid="caption-gallery"] [data-tile="bold-pop"]')
    await saved(home, 'rec-bn', (q) => q.captions?.studio?.from === 'bold-pop', 'Bold Pop saved')
    // Bold Pop draws Bangla in Baloo Da 2 (§0.2), loaded from the app's own files.
    const loaded = () => win.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'FlownCat-baloo-da-2' && f.status === 'loaded'))
    await f.waitFor(loaded, 'Baloo Da 2 loaded', 15000)

    // The Digits choice: ৩০০ instead of 300 in "মোট 300 জন এসেছেন" (shown at 4.9 s).
    await seekTo(win, 4.95)
    await h.sleep(800)
    const band = { x: 0, y: 0.55, w: 1, h: 0.45 }
    const asWritten = await previewPrint(win, band)
    const bandInk = (await previewPicture(win)).count({ x: 0, y: 0, w: 99999, h: 99999 }, INK).n
    h.assert(bandInk > 500, `the Bangla caption is drawn on the preview (${bandInk} px)`)
    const digits = (label) => win.click(`[data-testid="caption-digits"] button:has-text("${label}")`)
    await digits('Bangla ০–৯')
    await saved(home, 'rec-bn', (q) => q.captions?.digits === 'native', 'digits: native saved')
    await h.sleep(800)
    const bangla = await previewPrint(win, band)
    await docShot(win, 'bangla-digits', win.locator('.preview-canvas'))
    await digits('Western 0–9')
    await saved(home, 'rec-bn', (q) => q.captions?.digits === 'western', 'digits: western saved')
    await h.sleep(800)
    const western = await previewPrint(win, band)
    h.assert(bangla !== asWritten, 'Bangla digits change the drawn caption')
    h.assert(western === asWritten, 'Western digits draw the caption as written (its digits were Western)')
    await digits('Bangla ০–৯')
    await saved(home, 'rec-bn', (q) => q.captions?.digits === 'native', 'digits: native again')
    await win.locator('[data-testid="caption-gallery"]').scrollIntoViewIfNeeded()
    await h.sleep(800)
    await docShot(win, 'bangla-look', win.locator('.inspector'))

    const out = path.join(home, 'bangla.mp4')
    await exportOpen(app, win, out)
    const [b1, b2] = framesOf(out, [45, 150])
    h.assert(b1.count(lowBand(b1), INK).n > 1500 && b2.count(lowBand(b2), INK).n > 1500, 'the export draws both Bangla captions')
    h.assert(requests.length === 0, `no http(s) request while drawing and exporting (${requests.slice(0, 3).join(', ')})`)
  }))
}

async function popupTests() {
  await test('pop-ups: a keyword, an emoji and a counter added by keyboard show in the export at their times', fx.withHome('cs-pops', async (ctx, home) => {
    seed(home, { id: 'rec-pops', name: 'Pops', extra: { transcript: transcript([C1]) } })
    const { app, win } = await launch(ctx, home)
    await open(win, 'Pops')
    await win.click('.insp-tabs [data-testid="graphics"]')
    await win.waitForSelector('[data-testid="graphics-panel"]', { timeout: 10000 })
    let at = 3.6
    for (const kind of ['keyword', 'emoji', 'counter']) {
      await seekTo(win, at)
      // Adding one selects it and the tab shows its fields; Escape clears the selection (the list again).
      for (let i = 0; i < 3 && !(await win.$('[data-testid="graphics-add"]')); i++) {
        await win.evaluate(() => document.activeElement?.blur())
        await win.keyboard.press('Escape')
        await h.sleep(300)
      }
      if (!(await win.$('[data-testid="graphics-add"]'))) await win.click('.insp-tabs [data-testid="graphics"]')
      await win.waitForSelector('[data-testid="graphics-add"]', { timeout: 5000 })
      await win.focus('[data-testid="graphics-add"]')
      await win.keyboard.press('Enter')
      await win.waitForSelector('[role="menu"][aria-label="Add a pop-up"]', { timeout: 5000 })
      for (let i = 0; i < 6 && (await focusedTestId(win)) !== `graphics-add-${kind}`; i++) await win.keyboard.press('ArrowDown')
      h.assert((await focusedTestId(win)) === `graphics-add-${kind}`, `the arrows reach ${kind} in the Add menu`)
      await win.keyboard.press('Enter')
      const p = await saved(home, 'rec-pops', (q) => (q.graphics ?? []).some((g) => g.kind === kind), `a ${kind} saved`)
      const g = p.graphics.find((x) => x.kind === kind)
      h.assert(Math.abs(g.start - at) < 0.1, `the ${kind} starts at the playhead (${g.start} vs ${at})`)
      at = g.end + 0.6
    }
    const p = h.readProject(home, 'rec-pops')
    h.assert(p.graphics.length === 3, `three pop-ups (${p.graphics.map((g) => g.kind).join(', ')})`)
    await seekTo(win, (p.graphics[2].start + p.graphics[2].end) / 2)
    await h.sleep(600)
    await docShot(win, 'graphics-panel', win.locator('.inspector'))

    const out = path.join(home, 'pops.mp4')
    await exportOpen(app, win, out)
    const empty = frameOf(out, Math.round(3.3 * 30))
    h.assert(empty.count({ x: 0, y: 0, w: empty.width, h: empty.height }, INK, 2).n === 0, 'nothing is drawn between the caption and the first pop-up')
    for (const g of p.graphics) {
      const fr = frameOf(out, Math.round(((g.start + g.end) / 2) * 30))
      const ink = fr.count({ x: 0, y: 0, w: fr.width, h: fr.height }, INK, 2).n
      h.assert(ink > 150, `the ${g.kind} shows in the export at its time (${ink} px)`)
    }
    // The emoji is drawn in colour (the bundled colour emoji font).
    const e = p.graphics.find((g) => g.kind === 'emoji')
    const fe = frameOf(out, Math.round(((e.start + e.end) / 2) * 30))
    const coloured = fe.count({ x: 0, y: 0, w: fe.width, h: fe.height }, (q) => Math.max(...q) - Math.min(...q) > 80, 2).n
    h.assert(coloured > 50, `the emoji is in colour (${coloured} px)`)
  }))
}

async function keyboardTests() {
  await test('keyboard and the hovered look: Tab reaches everything, the options keep the focus, a hovered tile previews without saving', fx.withHome('cs-keys', async (ctx, home) => {
    seed(home, { id: 'rec-keys', name: 'Keys', extra: { transcript: transcript([C1, C2]) } })
    const { win } = await launch(ctx, home)
    await open(win, 'Keys')
    await captionsTab(win)
    const passed = await tabTo(win, '.insp-tabs button:has-text("Captions")', '[data-testid="caption-tile-play"]')
    for (const id of ['captions-great', 'captions-great-options', 'caption-gallery-filter', 'caption-gallery', 'caption-gallery-more']) h.assert(passed.has(id), `Tab reaches ${id} (passed ${[...passed].join(', ')})`)

    // The options popover keeps the focus inside, and Esc returns it to its button.
    await win.focus('[data-testid="captions-great-options"]')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid="great-options"]', { timeout: 5000 })
    const inside = () => win.evaluate(() => !!document.activeElement?.closest('[data-testid="great-options"]'))
    await f.waitFor(inside, 'the focus moves into the options')
    await docShot(win, 'great-options', win.locator('[data-testid="great-options"]'))
    for (let i = 0; i < 40; i++) {
      await win.keyboard.press('Tab')
      h.assert(await inside(), `Tab ${i + 1} stays inside the options`)
    }
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="great-options"]', { state: 'detached', timeout: 5000 })
    h.assert((await focusedTestId(win)) === 'captions-great-options', `Esc returns the focus to its button (got ${await focusedTestId(win)})`)

    // Hovering a tile previews its look on the video, with its label; nothing is saved.
    await seekTo(win, 1.2)
    const before = fs.readFileSync(projectFile(home, 'rec-keys'))
    const plain = await previewPrint(win, { x: 0, y: 0.6, w: 1, h: 0.4 })
    await win.hover('[data-testid="caption-gallery"] [data-tile="karaoke-fill"]')
    await f.waitFor(async () => ((await win.textContent('[data-testid="preview-look-label"]').catch(() => '')) || '').includes('Previewing Karaoke Fill'), 'the label "Previewing Karaoke Fill"', 5000)
    await h.sleep(500)
    const previewed = await previewPrint(win, { x: 0, y: 0.6, w: 1, h: 0.4 })
    h.assert(previewed !== plain, 'the preview draws the hovered look')
    await docShot(win, 'hover-preview', win.locator('.canvas-box').first())
    await win.mouse.move(5, 5)
    await win.waitForSelector('[data-testid="preview-look-label"]', { state: 'detached', timeout: 5000 })
    await h.sleep(500)
    h.assert((await previewPrint(win, { x: 0, y: 0.6, w: 1, h: 0.4 })) === plain, 'leaving the tile restores the preview')
    await win.keyboard.press('Control+z')
    await h.sleep(1500)
    h.assert(Buffer.compare(before, fs.readFileSync(projectFile(home, 'rec-keys'))) === 0, 'the project is unchanged, and the preview left nothing to undo')

    // Clean up's bleep says plainly what it does in this version (the word's sound is muted in phase B).
    await win.locator('[data-testid="cleanup-bleep"] button', { hasText: 'Standard' }).click()
    const note = await win.textContent('[data-testid="cleanup-bleep-note"]')
    h.assert(/not muted yet/.test(note), `the bleep note says the word's sound is not muted yet (got ${note})`)
  }))

  await test('the options left open under the Review panel keep no keys: Tab moves in the panel, Esc closes only the panel', fx.withHome('cs-review', async (ctx, home) => {
    // Two automatic cuts, so the Review panel has rows, their buttons and a footer.
    const clips = [
      { id: 'k0', start: 0, end: 3.1, speed: 1 },
      { id: 'k1', start: 3.4, end: 6.8, speed: 1 },
      { id: 'k2', start: 7.2, end: 10, speed: 1 }
    ]
    const autoCuts = [
      { id: 'a1', by: 'silences', action: 'cut', start: 3.1, end: 3.4, was: [{ start: 3.1, end: 3.4, speed: 1 }] },
      { id: 'a2', by: 'silences', action: 'cut', start: 6.8, end: 7.2, was: [{ start: 6.8, end: 7.2, speed: 1 }] }
    ]
    seed(home, { id: 'rec-review', name: 'Review', extra: { transcript: transcript([C1, C2]), clips, autoCuts } })
    const { win } = await launch(ctx, home)
    await open(win, 'Review')
    await captionsTab(win)
    await win.focus('[data-testid="captions-great-options"]')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid="great-options"]', { timeout: 5000 })
    const inside = () => win.evaluate(() => !!document.activeElement?.closest('[data-testid="great-options"]'))
    await f.waitFor(inside, 'the focus moves into the options')

    // The panel makes the Inspector (and the options in it) inert: its own buttons take Tab.
    await win.keyboard.press('Shift+R')
    await win.waitForSelector('[data-testid="review-panel"]', { timeout: 5000 })
    await f.waitFor(() => win.evaluate(() => !!document.activeElement?.closest('.review-item')), 'the focus moves to the first row to review')
    const seen = []
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await win.keyboard.press(key)
      seen.push(await focusedTestId(win))
    }
    h.assert(seen.join() === 'review-keep,review-remove,review-keep-all,review-remove', `Tab and Shift+Tab move in the Review panel (got ${seen.join()})`)
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="review-panel"]', { state: 'detached', timeout: 5000 })
    h.assert(!!(await win.$('[data-testid="great-options"]')), 'Esc closes only the Review panel: the options are still open')

    // Back in reach, the options keep Tab again, and Esc closes them with the focus on their button.
    await win.keyboard.press('Tab')
    h.assert(await inside(), `Tab goes back into the options (got ${await focusedTestId(win)})`)
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="great-options"]', { state: 'detached', timeout: 5000 })
    h.assert((await focusedTestId(win)) === 'captions-great-options', `Esc returns the focus to its button (got ${await focusedTestId(win)})`)
  }))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
