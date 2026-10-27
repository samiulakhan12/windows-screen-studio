// The automatic camera director end to end (docs/design/camera-director.md, section 8): on a
// 48 s recording with a microphone, a camera of a person standing right of the middle and a
// cursor that goes to the bottom-right corner to click, the Camera tab's "Auto director" shows
// the plan (intro, hidden, the bubble bottom left, hidden, outro) before it is applied; Direct
// writes it in one undo step, the preview and the export draw it alike, and the face is centred.
// Direct again keeps a block changed by hand; recorded camera positions are cut, not overwritten,
// and given back whole by "Remove automatic changes"; without sound only the bubble moves;
// without WebGL the face framing says it is unavailable and the rest is still directed; and the
// command palette directs from anywhere.
//
// Face framing needs person segmentation (WebGL in a worker); Xvfb has no GPU, so the app is
// launched with SwiftShader, and the no-WebGL test with --disable-webgl, as in camera.e2e.cjs.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')
const { personVideo } = require('./camera-fixtures.cjs')
const sp = require('./speech-fixtures.cjs')

/** Screenshots of the section and the directed timeline (docs/screenshots/director-*.png) when set to a folder. */
const SHOTS = process.env.SSW_DIRECTOR_SHOTS || null
const FPS = 60
const W = 1280
const H = 720
const SECONDS = 48
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)
const WEBGL = ['--enable-unsafe-swiftshader']
const NO_WEBGL = ['--disable-webgl']
const BLACK = { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/* ---------- fixtures ---------- */

/**
 * The microphone: real speech (the committed JFK and LibriSpeech clips, tests/fixtures/speech) over
 * about 0.5-6, 17-22 and 34-46.5 s, silent elsewhere. The speech detector hears it as speech (a
 * tone would not be), so the director plans from the voice (docs/design/offline-captions.md §10.4).
 */
function micAudio() {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `director-mic-speech-v2-${SECONDS}s.m4a`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.m4a`
  // [input, from, to (in the clip), at (in the recording)]: JFK speaks from 0.32 s, LibriSpeech from 0.58 s.
  const pieces = [
    [0, 0, 5.82, 0.18],
    [1, 0, 5.5, 16.42],
    [0, 0, 11, 33.68],
    [1, 0.58, 1.78, 45.3]
  ]
  const graph = [
    ...pieces.map(([i, a, b, at], k) => `[${i}:a]atrim=${a}:${b},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(at * 1000)}:all=1[p${k}]`),
    // Over 48 s of silence, so the track is as long as the video.
    `aevalsrc=0:s=48000:d=${SECONDS}[base]`,
    `[base]${pieces.map((_, k) => `[p${k}]`).join('')}amix=inputs=${pieces.length + 1}:normalize=0:duration=first[out]`
  ].join(';')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', sp.JFK, '-i', sp.LS, '-filter_complex', graph, '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', tmp])
  fs.renameSync(tmp, file)
  return file
}

/** The grey screen with the voice as its (mixed) sound, as a recording with sound always has it. */
function screenWithSound() {
  const file = path.join(fx.MEDIA_CACHE, `director-screen-speech-v2-${SECONDS}s.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx.solidVideo({ seconds: SECONDS }), '-i', micAudio(), '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', tmp])
  fs.renameSync(tmp, file)
  return file
}

/** cursor.json: a sample every 0.1 s at the middle until 8.0, then to (0.92, 0.9) by 8.5, held; left clicks there at 13-25 s. */
function directorCursor() {
  const samples = []
  for (let i = 0; i <= SECONDS * 10; i++) {
    const t = i / 10
    const k = Math.min(1, Math.max(0, (t - 8) / 0.5))
    samples.push({ t, x: +(0.5 + 0.42 * k).toFixed(4), y: +(0.5 + 0.4 * k).toFixed(4) })
  }
  const clicks = [13, 16, 19, 22, 25].map((t) => ({ t, x: 0.92, y: 0.9, button: 'left', up: t + 0.08 }))
  return { samples, clicks, keys: [], shapes: [], scale: 1, valid: true }
}

/** Seeds the director's recording; `sound: false` leaves out the sound, `camera: false` the camera. */
async function seedDirector(home, { id, name, sound = true, camera = true, layouts = [], webcam = {} }) {
  const cam = camera ? await personVideo(SECONDS, { cx: 0.62, markers: false }) : null
  fx.seedProject(home, { id, name, media: sound ? screenWithSound() : fx.solidVideo({ seconds: SECONDS }), seconds: SECONDS, webcam: cam, audio: sound, style: BLACK, cursor: directorCursor() })
  const dir = path.join(h.projectsRoot(home), id)
  const file = path.join(dir, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (sound) {
    fs.symlinkSync(micAudio(), path.join(dir, 'mic.m4a'))
    p.audioStems = { mic: true, system: false }
  }
  p.cursor = { show: true, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: false }
  p.webcam = { ...p.webcam, show: camera, corner: 'bottom-right', size: 0.24, shape: 'circle', ...webcam }
  p.layouts = layouts
  fs.writeFileSync(file, JSON.stringify(p, null, 2))
}

/* ---------- the app ---------- */

async function openCameraTab(win) {
  await win.click('.insp-tabs button[title="Camera"]')
  await win.waitForSelector('[data-testid="director"]', { timeout: 10000 })
}

/** Waits for the plan with `n` parts (the speech measured). */
async function planOf(win, n) {
  return f.waitFor(
    async () => {
      const parts = await win.$$eval('[data-testid="director-part"]', (els) => els.map((e) => ({ kind: e.dataset.kind, corner: e.dataset.corner || null, text: e.textContent })))
      const state = await win.$eval('[data-testid="director-summary"]', (e) => e.dataset.state).catch(() => null)
      return parts.length === n && state !== 'measuring' ? { parts, state } : null
    },
    `a plan of ${n} parts`,
    30000
  )
}

async function apply(win) {
  await win.locator('[data-testid="director"]').scrollIntoViewIfNeeded()
  await win.click('[data-testid="director-apply"]')
  // Measuring the face takes a few seconds (segmentation on the CPU).
  await f.waitFor(async () => (await win.$eval('[data-testid="director-apply"]', (b) => b.getAttribute('aria-busy'))) !== 'true', 'directing finished', 90000)
}

function saved(home, id, pred, message, timeout = 15000) {
  return f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return pred(p) ? p : null
      } catch {
        return null // mid-write
      }
    },
    `saved: ${message}`,
    timeout
  )
}

const near = (a, b, eps = 0.15) => Math.abs(a - b) <= eps
const fmt = (s) => `${s.layout}${s.corner ? ` ${s.corner}` : ''} [${s.start.toFixed(2)}, ${s.end.toFixed(2)}]${s.auto ? ' auto' : ''}${s.cutOut ? ' cutOut' : ''} ${s.id}`
const layoutsText = (ls) => ls.map(fmt).join('; ')

/** Checks saved layouts against [layout, corner|null, start, end, marks] rows, in order. */
function expectLayouts(layouts, rows, what) {
  h.assert(layouts.length === rows.length, `${what}: ${rows.length} segments (${layoutsText(layouts)})`)
  rows.forEach(([layout, corner, start, end, marks = {}], i) => {
    const s = layouts[i]
    h.assert(
      s.layout === layout && (s.corner ?? null) === corner && near(s.start, start) && near(s.end, end) && !!s.auto === !!marks.auto && !!s.cutOut === !!marks.cutOut && (!marks.id || s.id === marks.id),
      `${what}: segment ${i} is ${layout}${corner ? ` ${corner}` : ''} [${start}, ${end}] ${JSON.stringify(marks)} (got ${fmt(s)})`
    )
  })
  for (let i = 1; i < layouts.length; i++) h.assert(layouts[i].start >= layouts[i - 1].end - 1e-6, `${what}: no overlap at ${fmt(layouts[i])}`)
}

/** The layouts of test 1 (F1), all made by the director. */
const F1 = [
  ['camera-only', null, 0, 6.5, { auto: true }],
  ['screen-only', null, 6.5, 16.2, { auto: true }],
  ['default', 'bottom-left', 16.2, 23.0, { auto: true }],
  ['screen-only', null, 23.0, 33.7, { auto: true }],
  ['camera-only', null, 33.7, 48, { auto: true }]
]

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

async function boxOf(win, selector) {
  return win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.left, right: b.right, top: b.top }
  })
}

/** Moves the playhead to `t` (source seconds = output seconds here) with a click on the ruler. */
async function seek(win, t) {
  await win.mouse.click(await xForTime(win, t), (await boxOf(win, '.tl-ruler')).y)
  await h.sleep(900)
  await win.keyboard.press('Escape')
}

/** The preview canvas's colour at (fx, fy) of it. */
function previewAt(win, fxr, fyr) {
  return win.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.preview-canvas')
      const d = c.getContext('2d').getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data
      return [d[0], d[1], d[2]]
    },
    [fxr, fyr]
  )
}

async function backHome(win) {
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

async function exportMp4(app, win, name, out) {
  await fx.openProject(win, name)
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', '60 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${name}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await backHome(win)
}

function framesAtTimes(file, times) {
  const idx = times.map((t) => Math.round(t * FPS))
  const F = fx.framesAt(file, idx, 'rgb24')
  h.assert(F.width === W && F.height === H, `720p export (${F.width}x${F.height})`)
  return { at: (t) => F.frames[idx.indexOf(Math.round(t * FPS))] }
}

/* ---------- measuring pixels (output px) ---------- */

const rgb = (buf, x, y) => {
  const i = (Math.round(y) * W + Math.round(x)) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}
const isGray = ([r, g, b]) => Math.abs(r - 128) < 14 && Math.abs(g - 128) < 14 && Math.abs(b - 128) < 14
const isSkin = ([r, g, b]) => r > 200 && g > 150 && g < 215 && b > 110 && b < 180 && r - b > 50

function countIn(buf, r, pred) {
  let n = 0
  let all = 0
  let sx = 0
  for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y++) {
    for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x++) {
      all++
      if (pred(rgb(buf, x, y))) {
        n++
        sx += x
      }
    }
  }
  return { n, all, share: n / Math.max(1, all), cx: n ? sx / n : NaN }
}

const FRAME = { x: 0, y: 0, w: W, h: H }
/** The 0.24 bubble in each corner at 720p (layout.ts webcamRect): side 172.8, margin 28.8. */
const BUBBLE = {
  'bottom-left': { x: 28.8, y: 518.4, w: 172.8, h: 172.8 },
  'bottom-right': { x: W - 28.8 - 172.8, y: 518.4, w: 172.8, h: 172.8 },
  'top-left': { x: 28.8, y: 28.8, w: 172.8, h: 172.8 }
}

/** Saves a screenshot of `locator` to SHOTS/`name` (when SHOTS is set) and reports its size. */
async function shot(locator, name) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, name)
  await locator.screenshot({ path: file })
  console.log(`  screenshot ${name}: ${Math.round(fs.statSync(file).size / 1024)} KB`)
}

/* ---------- tests ---------- */

async function main() {
  await test('Direct: the plan before applying, preview equals export, the face centred, one undo step', fx.withHome('director-direct', async (ctx, home) => {
    // The plan comes from the speech detector: it must be there (never a silent fallback to the level).
    sp.requireSpeechAssets({ model: false })
    await seedDirector(home, { id: 'dir-a', name: 'Director A' })
    const { app, win, logs } = await h.launch({ home, args: WEBGL })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Director A')
    await openCameraTab(win)
    const plan = await planOf(win, 5)
    console.log(`  plan: ${plan.parts.map((p) => p.text).join(' | ')}`)
    h.assert(plan.parts.map((p) => p.kind).join(',') === 'intro,hidden,corner,hidden,outro', `the plan's parts (${plan.parts.map((p) => p.kind)})`)
    h.assert(plan.parts[2].corner === 'bottom-left', `the bubble goes bottom left (${plan.parts[2].corner})`)
    h.assert(plan.state === 'ready', `the summary is ready (${plan.state})`)
    h.assert((await win.$eval('[data-testid="director-source"]', (e) => e.dataset.source)) === 'mic', 'it listens to the microphone')
    h.assert(/Direct camera/.test(await win.textContent('[data-testid="director-apply"]')), 'the button reads Direct camera')
    if (SHOTS) {
      // Tall enough for the whole section (the inspector scrolls otherwise).
      const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1560))
      await h.sleep(600)
      await win.locator('[data-testid="director"]').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await shot(win.locator('[data-testid="director"]'), 'director-section.png')
      await app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0].setContentSize(w, hh), size)
      await h.sleep(600)
    }

    await apply(win)
    const p = await saved(home, 'dir-a', (q) => (q.layouts ?? []).length === 5 && !!q.director, 'the directed camera track')
    console.log(`  layouts: ${layoutsText(p.layouts)}; framing ${p.webcam.zoom} ${p.webcam.cropX} ${p.webcam.cropY}`)
    expectLayouts(p.layouts, F1, 'directed')
    const { zoom, cropX, cropY } = p.webcam
    // Checked at the end, so the preview, undo and export are measured whatever the framing came to.
    const framingOk = zoom >= 1.1 && zoom <= 1.3 && cropX >= 0.56 && cropX <= 0.68 && cropY >= 0.3 && cropY <= 0.5
    h.assert(JSON.stringify(p.director.framed) === JSON.stringify({ zoom, cropX, cropY }), `director.framed is the framing (${JSON.stringify(p.director.framed)})`)
    h.assert((await win.$$('.layout-seg[data-auto="true"]')).length === 5, 'five automatic blocks on the camera track')
    const status = await win.$eval('[data-testid="director-framing"]', (e) => e.dataset.status)
    h.assert(status === 'framed', `the framing line says framed (${status})`)
    h.assert(/Up to date/.test(await win.textContent('[data-testid="director-apply"]')), 'the button then reads Up to date')
    await shot(win.locator('.timeline'), 'director-timeline.png')

    // The preview at 19.5 s: the bubble bottom left, the screen where it used to be.
    await seek(win, 19.5)
    const bl = await previewAt(win, 0.09, 0.84)
    const br = await previewAt(win, 0.91, 0.84)
    console.log(`  preview at 19.5 s: bottom left ${bl}, bottom right ${br}`)
    h.assert(!isGray(bl) && isGray(br), `the preview shows the bubble bottom left (${bl}) and the screen bottom right (${br})`)

    // One undo step for everything; redo brings it back.
    await win.keyboard.press('Control+z')
    const undone = await saved(home, 'dir-a', (q) => (q.layouts ?? []).length === 0, 'undone')
    h.assert(!undone.director && undone.webcam.zoom === undefined && undone.webcam.cropX === undefined && undone.webcam.cropY === undefined, `undo removes the framing and the options: ${JSON.stringify(undone.webcam)} ${JSON.stringify(undone.director)}`)
    await win.keyboard.press('Control+y')
    await saved(home, 'dir-a', (q) => (q.layouts ?? []).length === 5 && !!q.director, 'redone')

    // The export draws what the preview showed.
    await backHome(win)
    const out = path.join(home, 'directed.mp4')
    await exportMp4(app, win, 'Director A', out)
    const F = framesAtTimes(out, [3, 11, 19.5, 28, 41])
    const intro = countIn(F.at(3), FRAME, isSkin)
    console.log(`  3 s: skin ${(intro.share * 100).toFixed(1)}% centred at x ${intro.cx.toFixed(0)}`)
    h.assert(intro.n > 500 && Math.abs(intro.cx - 640) <= 90, `the intro shows the face centred (x ${intro.cx.toFixed(0)}; 486 without framing)`)
    for (const t of [11, 28]) h.assert(countIn(F.at(t), FRAME, isSkin).n === 0, `${t} s: the camera is hidden`)
    const inBl = countIn(F.at(19.5), BUBBLE['bottom-left'], isSkin)
    const brGray = countIn(F.at(19.5), BUBBLE['bottom-right'], isGray)
    console.log(`  19.5 s: skin in the bottom-left bubble ${inBl.n} px, bottom right ${(brGray.share * 100).toFixed(1)}% grey`)
    h.assert(inBl.n > 50 && brGray.share > 0.98, 'the bubble is bottom left, the bottom right is the screen')
    const outro = F.at(41)
    h.assert(countIn(outro, FRAME, isGray).share < 0.02 && countIn(outro, FRAME, isSkin).n > 500, 'the outro shows the full camera')
    h.assert(framingOk, `the face is centred: zoom ${zoom} in [1.1, 1.3], cropX ${cropX} in [0.56, 0.68], cropY ${cropY} in [0.3, 0.5]`)
  }))

  await test('Direct again keeps a block changed by hand', fx.withHome('director-again', async (ctx, home) => {
    await seedDirector(home, { id: 'dir-b', name: 'Director B' })
    const { app, win, logs } = await h.launch({ home, args: WEBGL })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Director B')
    await openCameraTab(win)
    await planOf(win, 5)
    await apply(win)
    await saved(home, 'dir-b', (q) => (q.layouts ?? []).length === 5, 'directed')

    // Drag the bubble block's right edge 1 s to the left: it becomes the user's.
    const sel = '.layout-seg[data-corner="bottom-left"]'
    const b = await boxOf(win, sel)
    const pxPerSec = await win.$eval('.tl-content', (el) => Number(el.dataset.pxPerSec))
    await win.mouse.move(b.right - 2, b.y)
    await win.mouse.down()
    for (let i = 1; i <= 10; i++) await win.mouse.move(b.right - 2 - (pxPerSec * i) / 10, b.y)
    await win.mouse.up()
    await h.sleep(300)
    const edited = await saved(home, 'dir-b', (q) => q.layouts.some((s) => s.corner === 'bottom-left' && !s.auto), 'the block made the user\'s')
    const mine = edited.layouts.find((s) => s.corner === 'bottom-left')
    console.log(`  trimmed by hand: ${fmt(mine)}`)
    h.assert(near(mine.end, 22.0, 0.25), `trimmed about 1 s (${mine.end.toFixed(2)})`)
    h.assert((await win.$eval(sel, (e) => e.dataset.auto ?? null)) === null, 'its automatic mark is gone')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => /Direct again/.test(await win.textContent('[data-testid="director-apply"]')), 'the button reads Direct again', 5000)
    const summary = await win.textContent('[data-testid="director-summary"]')
    h.assert(/\+\d+ new · \d+ removed · \d+ unchanged/.test(summary), `the summary shows the diff (${summary})`)

    await apply(win)
    const p = await saved(home, 'dir-b', (q) => q.layouts.some((s) => s.layout === 'screen-only' && near(s.start, mine.end, 0.01)), 'directed again')
    console.log(`  again: ${layoutsText(p.layouts)}`)
    expectLayouts(
      p.layouts,
      [F1[0], F1[1], ['default', 'bottom-left', 16.2, mine.end, {}], ['screen-only', null, mine.end, 33.7, { auto: true }], F1[4]],
      'directed again'
    )
    const kept = p.layouts.find((s) => s.id === mine.id)
    h.assert(kept && kept.start === mine.start && kept.end === mine.end, 'the block changed by hand keeps its times and id')
  }))

  await test('Recorded camera positions are cut, kept, and given back whole', fx.withHome('director-positions', async (ctx, home) => {
    const seed = [
      { id: 'rec1', start: 10, end: 24, layout: 'default', corner: 'top-left' },
      { id: 'm1', start: 24, end: 27, layout: 'side-by-side', corner: 'top-left' },
      { id: 'rec1b', start: 27, end: 48, layout: 'default', corner: 'top-left' }
    ]
    await seedDirector(home, { id: 'dir-c', name: 'Director C', layouts: seed })
    const { app, win, logs } = await h.launch({ home, args: WEBGL })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Director C')
    await openCameraTab(win)
    h.assert(!(await win.isChecked('[data-testid="director-corners"] input')), 'Move the bubble away from the cursor starts off')
    h.assert(await win.isVisible('text=those positions are kept either way'), 'with the kept-positions hint')
    await f.waitFor(async () => (await win.$eval('[data-testid="director-summary"]', (e) => e.dataset.state).catch(() => null)) === 'ready', 'the plan', 30000)
    await apply(win)
    const p = await saved(home, 'dir-c', (q) => (q.layouts ?? []).some((s) => s.auto), 'directed')
    console.log(`  directed: ${layoutsText(p.layouts)}`)
    expectLayouts(
      p.layouts,
      [
        ['camera-only', null, 0, 6.5, { auto: true }],
        ['screen-only', null, 6.5, 10, { auto: true }],
        ['screen-only', 'top-left', 10, 16.2, { auto: true, cutOut: true }],
        ['default', 'top-left', 16.2, 24, { id: 'rec1' }],
        ['side-by-side', 'top-left', 24, 27, { id: 'm1' }],
        ['screen-only', 'top-left', 27, 33.7, { auto: true, cutOut: true, id: 'rec1b' }],
        ['camera-only', 'top-left', 33.7, 48, { auto: true, cutOut: true }]
      ],
      'with positions'
    )
    h.assert(p.layouts[4].start === 24 && p.layouts[4].end === 27, 'the layout change of the user is untouched')

    // Remove gives the positions back whole, ids included; undo brings the director's back for the export.
    await win.click('[data-testid="director-remove"]')
    const removed = await saved(home, 'dir-c', (q) => !(q.layouts ?? []).some((s) => s.auto), 'removed')
    const plain = (ls) => JSON.stringify(ls.map(({ id, start, end, layout, corner }) => ({ id, start, end, layout, corner })))
    h.assert(plain(removed.layouts) === plain(seed), `the seed again: ${layoutsText(removed.layouts)}`)
    await win.keyboard.press('Control+z')
    await saved(home, 'dir-c', (q) => (q.layouts ?? []).some((s) => s.auto), 'directed again by undo')
    await backHome(win)
    const out = path.join(home, 'positions.mp4')
    await exportMp4(app, win, 'Director C', out)
    const frame = framesAtTimes(out, [19.5]).at(19.5)
    const tl = countIn(frame, BUBBLE['top-left'], isSkin)
    console.log(`  19.5 s: skin in the top-left bubble ${tl.n} px`)
    h.assert(tl.n > 50 && countIn(frame, BUBBLE['bottom-right'], isGray).share > 0.98, 'the recorded position (top left) shows at 19.5 s')
  }))

  await test('No sound: only the bubble moves', fx.withHome('director-silent', async (ctx, home) => {
    await seedDirector(home, { id: 'dir-d', name: 'Director D', sound: false })
    const { app, win, logs } = await h.launch({ home, args: WEBGL })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Director D')
    await openCameraTab(win)
    await win.waitForSelector('[data-testid="director-note"][data-note="no-sound"]', { timeout: 30000 })
    h.assert((await win.$$('[data-testid="director-intro"] .chip:not([disabled])')).length === 0, 'the intro chips are disabled')
    h.assert((await win.$$('[data-testid="director-hide"] .chip:not([disabled])')).length === 0, 'the hide chips are disabled')
    await apply(win)
    const p = await saved(home, 'dir-d', (q) => (q.layouts ?? []).some((s) => s.auto), 'directed')
    console.log(`  directed: ${layoutsText(p.layouts)}`)
    h.assert(p.layouts.length === 1, `exactly one change (${layoutsText(p.layouts)})`)
    const s = p.layouts[0]
    h.assert(s.auto && s.layout === 'default' && s.corner === 'bottom-left' && near(s.start, 7.5, 0.5) && near(s.end, 48, 0.01), `the bubble bottom left from about 7.5 s to the end (${fmt(s)})`)
  }))

  await test('Without the speech detector the level decides, as before: the same plan from the microphone', fx.withHome('director-level', async (ctx, home) => {
    await seedDirector(home, { id: 'dir-l', name: 'Director L' })
    const { app, win, logs } = await h.launch({ home, args: WEBGL, env: { SSW_SPEECH_HELPER: '/nonexistent' } })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Director L')
    await openCameraTab(win)
    const plan = await planOf(win, 5)
    console.log(`  plan (level): ${plan.parts.map((p) => p.text).join(' | ')}`)
    h.assert(plan.parts.map((p) => p.kind).join(',') === 'intro,hidden,corner,hidden,outro', `the plan's parts (${plan.parts.map((p) => p.kind)})`)
    h.assert((await win.$eval('[data-testid="director-source"]', (e) => e.dataset.source)) === 'mic', 'it listens to the microphone')
  }))

  await test('No WebGL: face framing is unavailable, the rest is directed', fx.withHome('director-nowebgl', async (ctx, home) => {
    await seedDirector(home, { id: 'dir-e', name: 'Director E' })
    const { app, win, logs } = await h.launch({ home, args: NO_WEBGL })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Director E')
    await openCameraTab(win)
    await planOf(win, 5)
    await apply(win)
    const p = await saved(home, 'dir-e', (q) => (q.layouts ?? []).length === 5, 'directed')
    expectLayouts(p.layouts, F1, 'without WebGL')
    await win.waitForSelector('[data-testid="director-framing-unavailable"]', { timeout: 10000 })
    console.log(`  ${await win.textContent('[data-testid="director-framing-unavailable"]')}`)
    h.assert(p.webcam.zoom === undefined || p.webcam.zoom === 1, `the webcam zoom is unchanged (${p.webcam.zoom})`)
  }))

  await test('Command palette: directs from anywhere, and says when it cannot', fx.withHome('director-palette', async (ctx, home) => {
    await seedDirector(home, { id: 'dir-f', name: 'Director F' })
    await seedDirector(home, { id: 'dir-g', name: 'Director G no camera', camera: false })
    const { app, win, logs } = await h.launch({ home, args: WEBGL })
    ctx.app = app
    ctx.logs = logs
    const paletteRow = async (query) => {
      await win.keyboard.press('Control+k')
      await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
      await win.keyboard.type(query)
      return f.waitFor(
        () => win.$eval('.command-palette [role="option"]', (o) => ({ title: o.querySelector('.palette-title').textContent, why: o.getAttribute('title'), off: o.getAttribute('aria-disabled') })).catch(() => null),
        `"${query}" in the palette`,
        3000
      )
    }

    await fx.openProject(win, 'Director F')
    const row = await paletteRow('direct')
    h.assert(row.title === 'Direct the camera automatically' && !row.off, `the command is first and available (${JSON.stringify(row)})`)
    await win.keyboard.press('Enter')
    await win.waitForSelector('.insp-tabs button[title="Camera"][aria-pressed="true"]', { timeout: 5000 })
    const notice = await f.waitFor(async () => {
      const t = await win.textContent('.notice-slot').catch(() => '')
      return /Camera directed/.test(t || '') ? t : null
    }, 'the notice', 90000)
    console.log(`  notice: ${notice}`)
    h.assert(notice.trim().startsWith('Camera directed'), `the notice starts "Camera directed" (${notice})`)
    const p = await saved(home, 'dir-f', (q) => (q.layouts ?? []).filter((s) => s.auto).length === 5, 'five automatic segments')
    expectLayouts(p.layouts, F1, 'from the palette')

    // With the camera hidden, the palette says to show it first.
    await win.click('.toggle:has-text("Show camera") input')
    await saved(home, 'dir-f', (q) => q.webcam.show === false, 'the camera hidden')
    const hidden = await paletteRow('direct the camera')
    h.assert(hidden.off === 'true' && hidden.why === 'Show the camera first', `hidden camera: ${JSON.stringify(hidden)}`)
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="director-note"][data-note="camera-hidden"]')
    await backHome(win)

    await fx.openProject(win, 'Director G no camera')
    const none = await paletteRow('direct the camera')
    h.assert(none.off === 'true' && none.why === 'This recording has no camera', `no camera: ${JSON.stringify(none)}`)
    await win.keyboard.press('Escape')
  }))
}

main()
