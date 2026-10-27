// Captions end to end, with transcripts seeded into the projects (no network): measured on exported
// frames (a caption shows at its times, at the bottom or the top, in a box or with a shadow; the
// karaoke style lights the spoken word in the highlight colour; a cut removes a caption's time;
// text edited in the Captions tab changes the render), the caption track (blocks, selecting,
// edge and middle drags, double-click to edit, Delete), subtitle files in output time after a
// cut and a speed change (SRT from the tab, VTT from the command palette), the show/hide command,
// and the Generate section with no providers, a Claude-only provider and the stub's error.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')
const sp = require('./speech-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const W = 1920
const H = 1080
const FPS = 30

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-captions-mod-'))
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))
/** The shared caption layout code, to know where the export draws a caption's lines. */
const layout = (() => {
  const outfile = path.join(scratch, 'layout.cjs')
  esbuild.buildSync({ stdin: { contents: "export * from './src/shared/captions/layout'\n", resolveDir: h.APP_DIR, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  return require(outfile)
})()

/** Adds fields to a seeded project.json (the shared fixtures do not know captions). */
function addItems(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

const seg = (id, start, end, text, words) => ({ id, start, end, text, ...(words ? { words } : {}) })
const transcript = (segments, extra = {}) => ({ provider: 'openai', model: 'test-model', createdAt: new Date().toISOString(), language: 'en', segments, ...extra })
const captions = (extra = {}) => ({ show: true, preset: 'boxed', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#facc15', background: 'box', maxLines: 2, ...extra })

const STYLE = { background: { type: 'color', color: '#00a040' }, padding: 0.08, cornerRadius: 12, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }

async function launch(ctx, home, env = {}) {
  const { app, win, logs } = await h.launch({ home, env })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

/** Exports the project open in the editor as a 1080p 30 fps MP4 to `out` and closes the dialog. */
async function exportOpen(app, win, out) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Format', 'MP4')
  await fx.pickChip(win, 'Resolution', '1080p')
  await fx.pickChip(win, 'Frame rate', '30 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Frame `index` of a 1080p export with pixel counters. */
function frameOf(file, index) {
  const { width, height, frames } = fx.framesAt(file, [index], 'rgb24')
  h.assert(width === W && height === H, `export is ${W}x${H} (got ${width}x${height})`)
  const buf = frames[0]
  const px = (x, y) => {
    const i = (Math.round(y) * width + Math.round(x)) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
  /** Pixels in `r` (every other one) for which `pred` holds; with their mean x. */
  const count = (r, pred) => {
    let n = 0
    let sx = 0
    let minX = Infinity
    let maxX = -Infinity
    for (let y = Math.max(0, Math.round(r.y)); y < Math.min(H, Math.round(r.y + r.h)); y += 2) {
      for (let x = Math.max(0, Math.round(r.x)); x < Math.min(W, Math.round(r.x + r.w)); x += 2) {
        if (!pred(px(x, y))) continue
        n++
        sx += x
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
      }
    }
    return { n, x: n ? sx / n : NaN, minX, maxX }
  }
  return { px, count }
}

const WHITE = (p) => p.every((v) => v >= 200)
/** The box behind the text: dark on every channel (the gray video is 128, the green background has G 160). */
const BOX = (p) => p.every((v) => v <= 75)
const near = (want, tol = 45) => (p) => p.every((v, i) => Math.abs(v - want[i]) <= tol)
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
const shot = (file, index, name) => SHOTS && fx.savePng(file, index, path.join(SHOTS, `${name}.png`))

/** The rows a one-line caption covers (its band), from the shared layout: height does not depend on the text. */
function band(settings) {
  const measure = (s, px) => s.length * px * 0.5
  const l = layout.captionLayout({ start: 0, end: 1, text: 'x' }, settings, W, H, measure)
  const p = layout.placeChunk(l, l.chunks[0], settings.position, W, H)
  return { x: 0, y: p.top - 4, w: W, h: p.height + 8 }
}

/* ---------- editor helpers ---------- */

const timecode = (win) => win.$eval('.timecode', (e) => e.textContent)
const outTime = (tc) => {
  const [m, s] = tc.split('/')[0].trim().split(':')
  return Number(m) * 60 + Number(s)
}
const paletteTitles = (win) => win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent))
const activeTab = (win) => win.$eval('.insp-tabs button.active', (b) => b.textContent.trim())

async function runCommand(win, query, expectTitle) {
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type(query)
  await f.waitFor(async () => (await paletteTitles(win))[0] === expectTitle, `"${query}" lists ${expectTitle} first`, 3000)
  await win.keyboard.press('Enter')
  await f.waitFor(async () => !(await win.$('.command-palette')), 'palette closes after running', 3000)
}

/** Waits until the saved project.json matches `pred`, and returns it. */
const saved = (home, id, pred, what) =>
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
    10000
  )

/** Drags from (x, y) by dx pixels with the mouse. */
async function dragBy(win, x, y, dx) {
  await win.mouse.move(x, y)
  await win.mouse.down()
  await win.mouse.move(x + dx / 2, y, { steps: 4 })
  await win.mouse.move(x + dx, y, { steps: 4 })
  await win.mouse.up()
}

async function main() {
  await test('captions: shown at their times and place, boxed or shadowed, karaoke lights the spoken word, a cut removes one (export)', fx.withHome('captions-pixels', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 6 })
    // A: boxed at the bottom, with a cut (3.8 .. 5.2 s) that removes the third caption entirely.
    fx.seedProject(home, { id: 'rec-a', name: 'Boxed', media, seconds: 6, style: STYLE, effects: NO_FX, clips: [{ id: 'c0', start: 0, end: 3.8, speed: 1 }, { id: 'c1', start: 5.2, end: 6, speed: 1 }] })
    addItems(home, 'rec-a', {
      transcript: transcript([seg('s1', 0.5, 1.5, 'Hello there'), seg('s2', 2, 3, 'A middle caption'), seg('s3', 4, 5, 'Gone with the cut'), seg('s4', 5.3, 5.95, 'After the cut')]),
      captions: captions()
    })
    // B: the clean look (shadow, no box) at the top.
    fx.seedProject(home, { id: 'rec-b', name: 'Shadowed', media, seconds: 6, style: STYLE, effects: NO_FX })
    addItems(home, 'rec-b', { transcript: transcript([seg('s1', 0.5, 1.5, 'Hello there')]), captions: captions({ preset: 'clean', background: 'shadow', position: 'top' }) })
    // C: karaoke with word timings.
    const words = [
      { text: 'one', start: 1, end: 1.5 },
      { text: 'two', start: 1.6, end: 2.1 },
      { text: 'three', start: 2.2, end: 2.9 }
    ]
    fx.seedProject(home, { id: 'rec-c', name: 'Karaoke', media, seconds: 6, style: STYLE, effects: NO_FX })
    addItems(home, 'rec-c', { transcript: transcript([seg('s1', 1, 3, 'one two three', words)]), captions: captions({ preset: 'karaoke', highlightColor: '#22d3ee' }) })

    const { app, win } = await launch(ctx, home)
    const outs = {}
    for (const [name, file] of [['Boxed', 'a'], ['Shadowed', 'b'], ['Karaoke', 'c']]) {
      await fx.openProject(win, name)
      outs[file] = path.join(home, `${file}.mp4`)
      await exportOpen(app, win, outs[file])
      await win.click('button[aria-label="Back to recordings"]')
      await win.waitForSelector('.home', { timeout: 30000 })
    }
    for (const [i, name] of [[30, 'boxed'], [52, 'gap'], [125, 'after-cut']]) shot(outs.a, i, `captions-a-${name}`)
    shot(outs.b, 30, 'captions-b-top')
    for (const i of [39, 54, 75]) shot(outs.c, i, `captions-c-${i}`)

    const bottom = band(captions())
    const top = band(captions({ preset: 'clean', background: 'shadow', position: 'top' }))
    h.assert(bottom.y > H * 0.7 && top.y + top.h < H * 0.3, `bands: bottom at ${Math.round(bottom.y)}, top ending at ${Math.round(top.y + top.h)}`)

    // A at 1.0 s: a dark box with white text in the bottom band, nothing above it.
    let fr = frameOf(outs.a, 30)
    let box = fr.count(bottom, BOX)
    let white = fr.count(bottom, WHITE)
    h.assert(box.n > 2000 && white.n > 300, `a boxed caption at the bottom at 1.0 s (${box.n} box, ${white.n} white pixels)`)
    h.assert(Math.abs((box.minX + box.maxX) / 2 - W / 2) < 40, `centred (box from ${box.minX} to ${box.maxX})`)
    h.assert(fr.count({ x: 0, y: 0, w: W, h: bottom.y - 10 }, (p) => BOX(p) || WHITE(p)).n === 0, 'nothing above the caption band')
    // Before it starts, and between two captions: nothing.
    for (const [i, what] of [[10, 'before the first caption (0.33 s)'], [52, 'between captions (1.73 s)']]) {
      fr = frameOf(outs.a, i)
      const n = fr.count(bottom, (p) => BOX(p) || WHITE(p)).n
      h.assert(n === 0, `no caption ${what}: ${n} pixels`)
    }
    // The second caption at 2.5 s.
    h.assert(frameOf(outs.a, 75).count(bottom, WHITE).n > 300, 'the second caption at 2.5 s')
    // The cut (3.8 .. 5.2 s) removes the third caption: the video goes on at 3.8 s output with the fourth (from 5.3 s source = 3.9 s output).
    for (const i of [114, 116]) {
      const n = frameOf(outs.a, i).count(bottom, (p) => BOX(p) || WHITE(p)).n
      h.assert(n === 0, `no caption right after the cut (frame ${i}): ${n} pixels`)
    }
    fr = frameOf(outs.a, 125)
    h.assert(fr.count(bottom, BOX).n > 2000, `the caption after the cut at output ${(125 / FPS).toFixed(2)} s`)

    // B: shadow, at the top: white text there, no box, nothing at the bottom.
    fr = frameOf(outs.b, 30)
    white = fr.count(top, WHITE)
    box = fr.count(top, BOX)
    h.assert(white.n > 300, `the clean caption is at the top (${white.n} white pixels)`)
    h.assert(fr.count(bottom, WHITE).n === 0, 'and nothing at the bottom')
    // The two looks differ: a box darkens a wide area around the text, a shadow and outline only the letters' edges.
    const a = frameOf(outs.a, 30)
    const boxedRatio = a.count(bottom, BOX).n / a.count(bottom, WHITE).n
    const shadowRatio = box.n / white.n
    h.assert(boxedRatio > shadowRatio * 2, `boxed (${boxedRatio.toFixed(2)} dark per white pixel) and shadowed (${shadowRatio.toFixed(2)}) look different`)

    // C: the spoken word in cyan, moving left to right with the words.
    const CYAN = near(hex('#22d3ee'), 50)
    const centres = []
    for (const [i, word] of [[39, 'one'], [54, 'two'], [75, 'three']]) {
      const c = frameOf(outs.c, i).count(bottom, CYAN)
      h.assert(c.n > 300, `the spoken word "${word}" is lit at ${(i / FPS).toFixed(2)} s (${c.n} cyan pixels)`)
      centres.push(c.x)
    }
    h.assert(centres[0] < centres[1] - 40 && centres[1] < centres[2] - 40, `the light moves along the words: ${centres.map(Math.round).join(' < ')}`)
    h.assert(Math.abs(centres[1] - W / 2) < 120, `the middle word is in the middle (${Math.round(centres[1])})`)
  }))

  await test('captions: a caption without spaces shows chunk by chunk, Arabic reads from the right, the keys keep clear of a caption (export)', fx.withHome('captions-scripts', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 6 })
    // D: Chinese has no spaces: one long word, two one-line chunks.
    const chinese = '我们今天来看一下如何在这个应用程序里面录制屏幕并且添加字幕然后把视频导出成为一个文件'
    fx.seedProject(home, { id: 'rec-d', name: 'Chinese', media, seconds: 6, style: STYLE, effects: NO_FX })
    addItems(home, 'rec-d', { transcript: transcript([seg('s1', 0.5, 4.5, chinese)], { language: 'zh' }), captions: captions({ maxLines: 1 }) })
    // E: Arabic, karaoke: the first word is lit first, and it is the rightmost.
    const arabic = 'مرحبا بكم في البرنامج'
    const words = arabic.split(' ').map((text, i) => ({ text, start: 1 + i * 0.5, end: 1.4 + i * 0.5 }))
    fx.seedProject(home, { id: 'rec-e', name: 'Arabic', media, seconds: 6, style: STYLE, effects: NO_FX })
    addItems(home, 'rec-e', { transcript: transcript([seg('s1', 1, 3, arabic, words)], { language: 'ar' }), captions: captions({ preset: 'karaoke', highlightColor: '#22d3ee' }) })
    // F: the default look of both (clean caption, keys at the bottom); a shortcut during the caption and one after it.
    const keys = { motionBlur: 0, keystrokes: { show: true, position: 'bottom', size: 0.035 } }
    const cursor = { samples: [], clicks: [], keys: [{ t: 1, label: 'Ctrl+S' }, { t: 4, label: 'Ctrl+S' }], shapes: [], scale: 1, valid: false }
    fx.seedProject(home, { id: 'rec-f', name: 'Keys', media, seconds: 6, style: STYLE, effects: keys, cursor })
    addItems(home, 'rec-f', { transcript: transcript([seg('s1', 0.5, 3, 'Saving the project with the keyboard')]), captions: captions({ preset: 'clean', background: 'shadow', size: 0.045 }) })

    const { app, win } = await launch(ctx, home)
    const outs = {}
    for (const [name, file] of [['Chinese', 'd'], ['Arabic', 'e'], ['Keys', 'f']]) {
      await fx.openProject(win, name)
      outs[file] = path.join(home, `${file}.mp4`)
      await exportOpen(app, win, outs[file])
      await win.click('button[aria-label="Back to recordings"]')
      await win.waitForSelector('.home', { timeout: 30000 })
    }
    for (const i of [30, 126]) shot(outs.d, i, `captions-d-${i}`)
    shot(outs.e, 36, 'captions-e-36')
    for (const i of [36, 126]) shot(outs.f, i, `captions-f-${i}`)

    // D: the start of the sentence (a full line) at 1.0 s, its end (a shorter line) at 4.2 s.
    const bottom = band(captions())
    const first = frameOf(outs.d, 30).count(bottom, BOX)
    const last = frameOf(outs.d, 126).count(bottom, BOX)
    h.assert(first.n > 2000 && last.n > 2000, `a caption at 1.0 s and at 4.2 s (${first.n}, ${last.n} box pixels)`)
    h.assert(first.maxX - first.minX > last.maxX - last.minX + 150, `the first chunk (${first.maxX - first.minX} px wide) shows before the last (${last.maxX - last.minX} px)`)

    // E: at 1.2 s the first word's pill is right of the centre.
    const cyan = near(hex('#22d3ee'), 40)
    const pill = frameOf(outs.e, 36).count(bottom, cyan)
    h.assert(pill.n > 200 && pill.x > W / 2 + 40, `the first Arabic word is lit on the right (${pill.n} pixels at x ${Math.round(pill.x)})`)

    // F: during the caption the keys sit just above it, the caption keeps its place; after it, the keys are back at the bottom.
    const clean = band(captions({ preset: 'clean', background: 'shadow', size: 0.045 }))
    const above = { x: 0, y: clean.y - 120, w: W, h: 96 }
    let fr = frameOf(outs.f, 36)
    h.assert(fr.count(clean, WHITE).n > 300, 'the caption is in its place')
    const keysAbove = fr.count(above, BOX)
    h.assert(keysAbove.n > 2000 && Math.abs((keysAbove.minX + keysAbove.maxX) / 2 - W / 2) < 40, `the keys show just above the caption (${keysAbove.n} pixels)`)
    fr = frameOf(outs.f, 126)
    h.assert(fr.count(above, BOX).n < 100 && fr.count({ x: 0, y: H - 160, w: W, h: 140 }, BOX).n > 2000, 'without a caption the keys are at the bottom')
  }))

  await test('captions: editing the text in the Captions tab changes the render (export)', fx.withHome('captions-edit', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 2 })
    fx.seedProject(home, { id: 'rec-edit', name: 'Edit', media, seconds: 2, style: STYLE, effects: NO_FX })
    addItems(home, 'rec-edit', { transcript: transcript([seg('s1', 0.1, 1.9, 'Hi')]), captions: captions() })
    const { app, win } = await launch(ctx, home)
    await fx.openProject(win, 'Edit')
    await win.click('.insp-tabs button:has-text("Captions")')
    const field = '[data-caption-row="s1"] textarea'
    await win.waitForSelector(field)
    await win.fill(field, 'Hello there, this caption is much wider now')
    await saved(home, 'rec-edit', (p) => p.transcript.segments[0].text === 'Hello there, this caption is much wider now', 'the edited caption is saved')
    await win.keyboard.press('Escape')
    const out = path.join(home, 'edit.mp4')
    await exportOpen(app, win, out)
    shot(out, 30, 'captions-edited')
    const b = frameOf(out, 30).count(band(captions()), BOX)
    h.assert(b.n > 0 && b.maxX - b.minX > 900, `the box fits the new, longer text (${b.minX}..${b.maxX})`)
  }))

  await test('captions: the caption track shows blocks; click selects, edges and middle drag, double-click edits, Delete removes', fx.withHome('captions-track', async (ctx, home) => {
    const id = f.seedProject(home, { id: 'rec-track', name: 'Track', seconds: 10 })
    f.seedProject(home, { id: 'rec-none', name: 'NoTranscript', seconds: 4 })
    addItems(home, id, { transcript: transcript([seg('a', 1, 3, 'First caption'), seg('b', 4, 6, 'Second caption'), seg('c', 7, 9, 'Third caption')]) })
    const { win } = await launch(ctx, home)

    // No transcript: no caption track and no label.
    await f.openProject(win, 'NoTranscript')
    h.assert(!(await win.$('[data-testid="caption-track"]')) && !(await win.$('.tl-label[title="Captions"]')), 'no caption track without a transcript')
    await win.click('button[aria-label="Back to recordings"]')
    await win.waitForSelector('.home', { timeout: 30000 })

    await f.openProject(win, 'Track')
    await win.waitForSelector('.tl-label[title="Captions"]')
    const blocks = await win.$$eval('.caption-seg', (els) => els.map((e) => e.dataset.caption))
    h.assert(blocks.join() === 'a,b,c', `a block per caption: ${blocks}`)
    h.assert((await win.textContent('.caption-seg[data-caption="b"] .seg-label')) === 'Second caption', 'labelled with its text')

    // A click selects it, opens the Captions tab and moves the playhead into it.
    await win.click('.caption-seg[data-caption="b"]')
    await win.waitForSelector('.caption-seg.selected[data-caption="b"]')
    await f.waitFor(async () => (await activeTab(win)) === 'Captions', 'the Captions tab opens')
    await f.waitFor(async () => {
      const t = outTime(await timecode(win))
      return t >= 4 && t < 4.5
    }, 'the playhead moves into the caption')
    await win.waitForSelector('[data-caption-row="b"].selected')

    const pxPerSec = Number(await win.$eval('.tl-content', (e) => e.dataset.pxPerSec))
    const rect = async (cid) => (await win.$(`.caption-seg[data-caption="${cid}"]`)).boundingBox()
    // Right edge +0.5 s.
    let r = await rect('b')
    await dragBy(win, r.x + r.width - 2, r.y + r.height / 2, pxPerSec * 0.5)
    let p = await saved(home, id, (q) => Math.abs(q.transcript.segments[1].end - 6.5) < 0.08, 'the end dragged to about 6.5 s')
    h.assert(Math.abs(p.transcript.segments[1].start - 4) < 1e-6, 'the start stays')
    // Left edge -3 s stops at the caption before (3 s).
    r = await rect('b')
    await dragBy(win, r.x + 2, r.y + r.height / 2, -pxPerSec * 3)
    p = await saved(home, id, (q) => Math.abs(q.transcript.segments[1].start - 3) < 1e-6, 'the start stops at the previous caption')
    // The middle +5 s: moved as far as the next caption allows, keeping its length.
    r = await rect('b')
    const len = p.transcript.segments[1].end - p.transcript.segments[1].start
    await dragBy(win, r.x + r.width / 2, r.y + r.height / 2, pxPerSec * 5)
    p = await saved(home, id, (q) => Math.abs(q.transcript.segments[1].end - 7) < 1e-6, 'moved up to the next caption')
    h.assert(Math.abs(p.transcript.segments[1].end - p.transcript.segments[1].start - len) < 1e-6, 'its length kept')
    // One undo per drag.
    await win.keyboard.press('Control+z')
    await saved(home, id, (q) => Math.abs(q.transcript.segments[1].start - 3) < 1e-6, 'undo takes the move back')

    // A double-click puts the cursor in its text.
    r = await rect('c')
    await win.mouse.dblclick(r.x + r.width / 2, r.y + r.height / 2)
    await f.waitFor(() => win.evaluate(() => document.activeElement?.closest('[data-caption-row]')?.dataset.captionRow === 'c'), 'the text of the double-clicked caption is focused')
    await win.keyboard.press('Escape')
    // Delete removes the selected caption.
    await win.keyboard.press('Delete')
    await saved(home, id, (q) => q.transcript.segments.length === 2 && !q.transcript.segments.some((s) => s.id === 'c'), 'Delete removes the caption')
    await f.waitFor(async () => (await win.$$('.caption-seg')).length === 2, 'and its block')
  }))

  await test('captions: subtitle files in output time after a cut and a speed change; show/hide command', fx.withHome('captions-subtitles', async (ctx, home) => {
    const id = f.seedProject(home, {
      id: 'rec-subs',
      name: 'Subtitles',
      seconds: 8,
      clips: [
        { id: 'c0', start: 0, end: 2, speed: 1 },
        { id: 'c1', start: 4, end: 8, speed: 2 }
      ]
    })
    addItems(home, id, { transcript: transcript([seg('a', 0.5, 1.5, 'First words'), seg('b', 2.5, 3.5, 'Cut away'), seg('c', 5, 7, 'A fast part')]) })
    const { app, win } = await launch(ctx, home)
    await f.openProject(win, 'Subtitles')
    await win.click('.insp-tabs button:has-text("Captions")')

    const srt = path.join(home, 'subs.srt')
    await h.mockSaveDialog(app, srt)
    await win.click('.chips[aria-label="Subtitle format"] .chip:has-text("SRT")')
    await win.click('button:has-text("Export captions…")')
    await f.waitFor(() => fs.existsSync(srt), 'the SRT file is written')
    const srtText = fs.readFileSync(srt, 'utf8').replace(/^﻿/, '')
    const wantSrt = '1\n00:00:00,500 --> 00:00:01,500\nFirst words\n\n2\n00:00:02,500 --> 00:00:03,500\nA fast part\n'
    h.assert(srtText === wantSrt, `SRT in output time:\n${srtText}`)

    // VTT from the command palette (the format picked in the tab).
    await win.click('.chips[aria-label="Subtitle format"] .chip:has-text("VTT")')
    const vtt = path.join(home, 'subs.vtt')
    await h.mockSaveDialog(app, vtt)
    await runCommand(win, 'export captions', 'Export captions…')
    await f.waitFor(() => fs.existsSync(vtt), 'the VTT file is written')
    const vttText = fs.readFileSync(vtt, 'utf8')
    h.assert(vttText === 'WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nFirst words\n\n00:00:02.500 --> 00:00:03.500\nA fast part\n', `VTT in output time:\n${vttText}`)

    // Show or hide captions.
    await runCommand(win, 'hide captions', 'Show or hide captions')
    await saved(home, id, (q) => q.captions?.show === false, 'the command hides the captions')
    await win.waitForSelector('.caption-track.captions-off')
    await runCommand(win, 'hide captions', 'Show or hide captions')
    await saved(home, id, (q) => q.captions?.show === true, 'and shows them again')
  }))

  // Without the speech helper (SSW_SPEECH_HELPER=/nonexistent) the key block and its text are exactly as before captions on this PC.
  await test('captions: Generate with no provider, with only Claude, and the error from a provider that fails', fx.withHome('captions-generate', async (ctx, home) => {
    f.seedProject(home, { id: 'rec-gen', name: 'Generate', seconds: 4, audio: true })
    const { app, win } = await launch(ctx, home, { SSW_SPEECH_HELPER: '/nonexistent' })
    await f.openProject(win, 'Generate')
    await win.evaluate(() => {
      window.__settingsOpened = []
      window.addEventListener('ssw:open-settings', (e) => window.__settingsOpened.push(e.detail))
    })
    // The command opens the Captions tab; there is no provider yet.
    await runCommand(win, 'generate captions', 'Generate captions')
    await f.waitFor(async () => (await activeTab(win)) === 'Captions', 'the command opens the Captions tab')
    await win.waitForSelector('.captions-intro')
    await win.waitForSelector('.captions-empty:has-text("Add an AI provider with your own API key")')
    await win.click('.captions-empty button:has-text("Add an AI provider")')
    const opened = await win.evaluate(() => window.__settingsOpened)
    h.assert(opened.length === 1 && opened[0].section === 'ai', `"Add an AI provider" opens the AI settings: ${JSON.stringify(opened)}`)
    const settings = win.locator('[role="dialog"][aria-labelledby="settings-title"]')
    await settings.waitFor()
    h.assert((await settings.getAttribute('data-section')) === 'ai', 'the Settings dialog opens at the AI providers')

    const provide = (list) =>
      app.evaluate(({ ipcMain }, providers) => {
        ipcMain.removeHandler('ai:listProviders')
        ipcMain.handle('ai:listProviders', () => providers)
      }, list)
    const claude = { id: 'p-claude', kind: 'anthropic', label: 'My Claude', model: 'claude-model', maskedKey: '…abcd', createdAt: '' }
    // A Claude provider is added while the dialog is open: closing the dialog updates the tab (no "Check again" needed).
    // Only Claude: it cannot listen to audio.
    await provide([claude])
    await settings.getByRole('button', { name: 'Done' }).click()
    await settings.waitFor({ state: 'detached' })
    await win.waitForSelector('.captions-empty:has-text("Claude cannot listen to audio")', { timeout: 5000 })
    // The settings saying the providers changed updates the tab too.
    await provide([])
    await win.evaluate(() => window.dispatchEvent(new Event('ssw:ai-providers-changed')))
    await win.waitForSelector('.captions-empty:has-text("Add an AI provider with your own API key")', { timeout: 5000 })
    await provide([claude])
    await win.click('.captions-empty button:has-text("Check again")')
    await win.waitForSelector('.captions-empty:has-text("Claude cannot listen to audio")')

    // A provider that can transcribe: the stub (or the real provider with a made-up key) fails with a clear message.
    await provide([claude, { id: 'p-openai', kind: 'openai', label: 'My OpenAI', model: 'text-model', transcriptionModel: 'speech-model', maskedKey: '…wxyz', createdAt: '' }])
    await win.click('.captions-empty button:has-text("Check again")')
    await win.waitForSelector('select[aria-label="Transcription provider"]')
    const options = await win.$$eval('select[aria-label="Transcription provider"] option', (els) => els.map((e) => e.textContent))
    h.assert(options.length === 1 && options[0].includes('My OpenAI'), `only providers that can transcribe are offered: ${options}`)
    const languages = await win.$$eval('select[aria-label="Spoken language"] option', (els) => els.map((e) => e.textContent))
    for (const l of ['Detect automatically', 'English', 'Bengali', 'Hindi', 'Spanish']) h.assert(languages.includes(l), `the language list has ${l}`)
    await win.selectOption('select[aria-label="Spoken language"]', 'bn')
    await win.click('button:has-text("Generate captions")')
    await win.waitForSelector('.captions-error', { timeout: 15000 })
    const message = (await win.textContent('.captions-error')).trim()
    h.assert(/^Captions could not be made: \S/.test(message) && !/Error invoking remote method|^Captions could not be made: \w*Error: /.test(message), `a clear error: "${message}"`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'captions-generate-error.png') })
    h.assert(!h.readProject(home, 'rec-gen').transcript, 'nothing is stored')

    // A recording sent in one part: the bar moves (it does not sit at 0 of 1) until the part is done.
    // Cancel then shows "Stopping…" until the main process has stopped, and leaves no error.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:transcribe')
      ipcMain.handle('ai:transcribe', (e, projectId) => {
        e.sender.send('ai:transcribeProgress', { projectId, phase: 'transcribing', done: 0, total: 1 })
        return new Promise((resolve, reject) => {
          globalThis.__stopTranscription = () => reject(Object.assign(new Error('Cancelled.'), { name: 'AiError' }))
        })
      })
      ipcMain.removeHandler('ai:cancelTranscription')
      ipcMain.handle('ai:cancelTranscription', () => new Promise((resolve) => (globalThis.__cancelled = resolve)))
    })
    await win.click('.captions-error button:has-text("Dismiss")')
    await win.click('button:has-text("Generate captions")')
    await win.waitForSelector('.captions-phase:has-text("Transcribing")')
    h.assert(await win.isVisible('.captions-bar.busy'), 'the bar moves while the only part is under way')
    await win.click('.captions-progress ~ button:has-text("Cancel")')
    await win.waitForSelector('.captions-phase:has-text("Stopping")')
    h.assert(await win.isDisabled('.captions-progress ~ button:has-text("Cancel")'), 'Cancel is done once')
    await app.evaluate(() => {
      globalThis.__stopTranscription()
      globalThis.__cancelled()
    })
    await win.waitForSelector('button:has-text("Generate captions")')
    await new Promise((r) => setTimeout(r, 300))
    h.assert(!(await win.isVisible('.captions-error')), 'a cancel is not shown as an error')
  }))

  await test('captions: with the speech helper built, no provider means the consent card and one cloud link; On this PC is listed first', fx.withHome('captions-local', async (ctx, home) => {
    sp.requireSpeechAssets({ model: false })
    f.seedProject(home, { id: 'rec-local', name: 'Local', seconds: 4, audio: true })
    const { app, win } = await launch(ctx, home)
    await f.openProject(win, 'Local')
    await win.evaluate(() => {
      window.__settingsOpened = []
      window.addEventListener('ssw:open-settings', (e) => window.__settingsOpened.push(e.detail))
    })
    await runCommand(win, 'generate captions', 'Generate captions')
    await win.waitForSelector('[data-testid="local-captions"][data-state="needs-model"]', { timeout: 20000 })
    h.assert(!(await win.$('.captions-empty:has-text("Add an AI provider")')), 'no key block when the providers were read')
    await win.click('button:has-text("Prefer the cloud? Use your own OpenAI or Gemini key…")')
    const opened = await win.evaluate(() => window.__settingsOpened)
    h.assert(opened.length === 1 && opened[0].section === 'ai', `the cloud link opens the AI settings: ${JSON.stringify(opened)}`)
    await win.click('.settings-modal button:has-text("Done")')
    // A provider that can transcribe: the list offers On this PC first; the key provider stays chosen.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:listProviders')
      ipcMain.handle('ai:listProviders', () => [{ id: 'p-openai', kind: 'openai', label: 'My OpenAI', model: 'text-model', transcriptionModel: 'speech-model', maskedKey: '…wxyz', createdAt: '' }])
    })
    await win.evaluate(() => window.dispatchEvent(new Event('ssw:ai-providers-changed')))
    await win.waitForSelector('select[aria-label="Transcription provider"]')
    const options = await win.$$eval('select[aria-label="Transcription provider"] option', (els) => els.map((e) => e.textContent))
    h.assert(options[0] === 'On this PC (free, private)' && options.length === 2 && options[1].includes('My OpenAI'), `On this PC first: ${options}`)
    h.assert((await win.$eval('select[aria-label="Transcription provider"]', (e) => e.value)) === 'p-openai', 'the key provider stays chosen')
  }))

  await test('captions: AI tools apply a result only when it matches the captions, in one undo step', fx.withHome('captions-ai', async (ctx, home) => {
    const id = f.seedProject(home, { id: 'rec-ai', name: 'AiTools', seconds: 6 })
    addItems(home, id, { transcript: transcript([seg('a', 0.5, 2, 'helo wrld'), seg('b', 3, 5, 'secnd one')]) })
    const { app, win } = await launch(ctx, home)
    // A provider and a text task answering `answer` (set per step below).
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:listProviders')
      ipcMain.handle('ai:listProviders', () => [{ id: 'p-claude', kind: 'anthropic', label: 'My Claude', model: 'claude-model', maskedKey: '…abcd', createdAt: '' }])
      ipcMain.removeHandler('ai:text')
      ipcMain.handle('ai:text', (_e, providerId, request) => {
        globalThis.__aiRequests = [...(globalThis.__aiRequests || []), { providerId, request }]
        return globalThis.__aiAnswer(request)
      })
    })
    const answer = (fn) => app.evaluate((_electron, src) => {
      globalThis.__aiAnswer = new Function('request', src)
    }, fn)
    await f.openProject(win, 'AiTools')
    await win.click('.insp-tabs button:has-text("Captions")')
    await win.waitForSelector('select[aria-label="AI provider for text"]')

    // The tab's dropdowns show the global chevron; the caption lane and its label use the timeline's look and the caption hue.
    for (const label of ['AI provider for text', 'Translate to']) {
      const bg = await win.$eval(`select[aria-label="${label}"]`, (e) => getComputedStyle(e).backgroundImage)
      h.assert(/svg/.test(bg), `the "${label}" dropdown has its arrow: ${bg}`)
    }
    const look = await win.evaluate(() => {
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel)).getPropertyValue(prop).trim()
      return {
        lane: css('.tl-track.caption-track', 'background-color'),
        zoomLane: css('.tl-track.zoom-track', 'background-color'),
        captionSeg: css('.seg.caption-seg', 'border-top-color'),
        label: css('.tl-label[title="Captions"]', '--kind')
      }
    })
    h.assert(look.lane === look.zoomLane, `the caption lane looks like the other lanes: ${JSON.stringify(look)}`)
    h.assert(look.captionSeg !== 'rgb(94, 234, 212)' && /^#86efac$/i.test(look.label), `captions have their own hue, not the shapes' teal: ${JSON.stringify(look)}`)

    // A caption whose text is all deleted goes when the field is left (it would make every AI answer unusable).
    await win.fill('textarea[aria-label^="Caption at"] >> nth=1', '')
    await win.click('.caption-time >> nth=0')
    await saved(home, id, (q) => q.transcript.segments.length === 1, 'the emptied caption is removed')
    await win.keyboard.press('Control+z')
    await saved(home, id, (q) => q.transcript.segments.length === 2 && q.transcript.segments[1].text === 'secnd one', 'one undo brings it back')

    // Times changed: refused, nothing replaced.
    await answer("return { task: 'cleanup', segments: request.segments.map((s) => ({ ...s, start: s.start + 0.5, text: 'x' })) }")
    await win.click('button:has-text("Fix captions")')
    await win.waitForSelector('.hint.warn:has-text("timing")')
    h.assert(h.readProject(home, id).transcript.segments[0].text === 'helo wrld', 'a result with other times is not applied')
    const warn = await win.$eval('.hint.warn', (e) => [getComputedStyle(e).color, getComputedStyle(e.nextElementSibling).color])
    h.assert(warn[0] !== warn[1], `the error stands out from the hint under it: ${warn}`)

    // Matching ids and times: the texts are replaced, once.
    await answer("return { task: 'cleanup', segments: request.segments.map((s) => ({ ...s, text: s.id === 'a' ? 'Hello world' : 'Second one' })) }")
    await win.click('button:has-text("Fix captions")')
    await saved(home, id, (q) => q.transcript.segments.map((s) => s.text).join('|') === 'Hello world|Second one', 'the fixed captions')
    const req = await app.evaluate(() => globalThis.__aiRequests)
    h.assert(req[req.length - 1].providerId === 'p-claude' && req[req.length - 1].request.task === 'cleanup' && req[req.length - 1].request.segments.length === 2, 'the request names the provider and sends the captions')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Control+z')
    await saved(home, id, (q) => q.transcript.segments[0].text === 'helo wrld', 'one undo brings the original back')

    // Translation to Bengali (the provider is told the language's name) keeps the times and sets the language.
    await win.selectOption('select[aria-label="Translate to"]', 'bn')
    await answer("return request.targetLanguage === 'Bengali' ? { task: 'translate', segments: request.segments.map((s) => ({ ...s, text: 'হ্যালো ' + s.id })) } : null")
    await win.click('button:has-text("Translate to…")')
    let p = await saved(home, id, (q) => q.transcript.segments[0].text === 'হ্যালো a', 'the translated captions')
    h.assert(p.transcript.language === 'bn' && p.transcript.segments[1].start === 3, 'the language is set and the times kept')

    // Chapters are added in one step; a title is offered and renames the recording.
    await answer("return { task: 'chapters', chapters: [{ t: 0, title: 'Intro' }, { t: 3, title: 'Second part' }] }")
    await win.click('button:has-text("Suggest chapters")')
    p = await saved(home, id, (q) => (q.chapters || []).length === 2, 'the suggested chapters')
    h.assert(p.chapters.map((c) => c.title).join() === 'Intro,Second part', `chapter names: ${p.chapters.map((c) => c.title)}`)
    await answer("return { task: 'title', text: '\"A Better Name\"' }")
    await win.click('button:has-text("Suggest a title")')
    await win.waitForSelector('.captions-suggestion:has-text("A Better Name")')
    await win.click('.captions-suggestion button:has-text("Rename the recording")')
    await saved(home, id, (q) => q.name === 'A Better Name', 'the recording is renamed')

    // A summary is shown with its paragraphs, and Copy puts it on the clipboard.
    const summary = 'A short tour of the editor.\n\nIt ends with the export.'
    await answer(`return { task: 'summary', text: ${JSON.stringify(summary)} }`)
    await win.click('button:has-text("Summarize")')
    await win.waitForSelector('.captions-summary')
    h.assert((await win.$eval('.captions-summary', (e) => e.innerText)) === summary, 'the summary is shown as it came, paragraphs kept')
    const asked = await app.evaluate(() => globalThis.__aiRequests)
    h.assert(asked[asked.length - 1].request.task === 'summary', 'Summarize asks for a summary')
    await win.click('.captions-suggestion button:has-text("Copy")')
    await f.waitFor(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === summary, 'the summary is copied', 5000)
    await win.click('.captions-suggestion button:has-text("Dismiss")')
    await win.waitForSelector('.captions-summary', { state: 'detached' })

    // A provider error is shown as it is.
    await answer("throw new Error('The key was refused')")
    await win.click('button:has-text("Fix captions")')
    await win.waitForSelector('.hint.warn:has-text("The key was refused")')
  }))
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
