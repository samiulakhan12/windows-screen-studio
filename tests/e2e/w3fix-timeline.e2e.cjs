// Wave-3 timeline fixes end to end in the built app: removing silences keeps a title card shown
// over a pause; a camera layout change "at the playhead" goes where the preview shows the
// playhead (in a cut, near a trimmed end) whether it comes from the camera track, the Camera
// panel or a command, and the playhead then moves to where the change shows; and scrubbing the
// camera layout and title tracks of a zoomed-in timeline keeps the view still with the playhead
// under the pointer, as on the other tracks. A change added while playing plays: the playhead
// does not jump past it.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')
const sp = require('./speech-fixtures.cjs')

const MEDIA_CACHE = path.join(os.tmpdir(), 'ssw-e2e-media')
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)
/** Seconds a layout change animates in (engine/layout.ts LAYOUT_TRANSITION). */
const LAYOUT_TRANSITION = 0.4

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** 12 s test pattern with a voice (a tone) from 0.3 s to 3.5 s and from 7.5 s to 11.9 s, silent in between (cached; as polish.e2e.cjs). */
function talkSilenceTalk() {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, 'talk-silence-talk-12s-640x360-30.mp4')
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', "sine=frequency=330:sample_rate=48000,volume='if(between(t,0.3,3.5)+between(t,7.5,11.9),1.5,0)':eval=frame",
    '-t', '12', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    tmp
  ], { stdio: 'inherit' })
  fs.renameSync(tmp, file)
  return file
}

/** Seeds a project, applies `patch` to its project.json, launches the app and opens it. */
async function openSeeded(ctx, tag, opts, patch = {}) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  const dir = path.join(h.projectsRoot(home), id)
  if (opts.video) {
    fs.unlinkSync(path.join(dir, 'screen.mp4'))
    fs.symlinkSync(opts.video, path.join(dir, 'screen.mp4'))
  }
  const file = path.join(dir, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 2))
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  // Keep handles on the editor's (detached) <video> elements (as editor.e2e.cjs).
  await win.evaluate(() => {
    const create = document.createElement.bind(document)
    window.__videos = []
    document.createElement = (tag, ...rest) => {
      const el = create(tag, ...rest)
      if (String(tag).toLowerCase() === 'video') window.__videos.push(el)
      return el
    }
  })
  await f.openProject(win, opts.name)
  return { home, id, win }
}

/* ---------- editor helpers ---------- */

const secs = (t) => t.split(':').reduce((a, v) => a * 60 + Number(v), 0)
const ranges = (win) =>
  win.$$eval('.smart-list .smart-range', (els) => els.map((e) => e.textContent)).then((list) => list.map((p) => p.split('–').map((t) => secs(t.trim()))))

/** Sets a range input to `value` the way the keyboard does (React sees an input event). */
async function setSlider(win, label, value) {
  await win.$eval(
    `input[aria-label="${label}"]`,
    (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    value
  )
}

async function boxOf(win, selector) {
  return win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.left, right: b.right, top: b.top }
  })
}

const xForTime = (win, t) =>
  win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])

/** Source time under client x on the timeline. */
const timeAtX = (win, x) => win.$eval('.tl-content', (el, [cx, gutter]) => (cx - el.getBoundingClientRect().left - gutter) / Number(el.dataset.pxPerSec), [x, GUTTER])

/** The playhead's source time, as the timeline draws it (it may sit in a cut, unlike the timecode). */
const playheadTime = (win) =>
  win.evaluate(() => {
    const m = /translateX\(([-\d.e]+)px\)/.exec(document.querySelector('.playhead').style.transform)
    return Number(m[1]) / Number(document.querySelector('.tl-content').dataset.pxPerSec)
  })

const scrollLeft = (win) => win.$eval('[data-testid="timeline-scroller"]', (el) => el.scrollLeft)

/** Moves the playhead to source time `t` with a click on the ruler, and clears the selection. */
async function clickRulerAt(win, t) {
  await win.mouse.click(await xForTime(win, t), (await boxOf(win, '.tl-ruler')).y)
  await h.sleep(300)
  await win.keyboard.press('Escape')
}

const paletteTitles = (win) => win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent))

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
  f.waitFor(() => {
    try {
      const p = h.readProject(home, id)
      return pred(p) ? p : null
    } catch {
      return null
    }
  }, what, 10000)

const near = (a, b, tol) => Math.abs(a - b) <= tol

const isPlaying = (win) => win.$eval('.transport .btn.round', (b) => b.dataset.playing === 'true')

/** Starts counting the seeks of the screen video: playing a project without cuts never seeks it, a jump does. */
const countSeeks = (win) =>
  win.evaluate(() => {
    const v = window.__videos.find((x) => /screen/.test(x.getAttribute('src') || ''))
    if (!v) throw new Error(`no screen video in ${JSON.stringify(window.__videos.map((x) => x.getAttribute('src')))}`)
    v.__seeks = 0
    if (!v.__counting) v.addEventListener('seeking', () => v.__seeks++)
    v.__counting = true
  })
const seeks = (win) => win.evaluate(() => window.__videos.find((x) => /screen/.test(x.getAttribute('src') || '')).__seeks)

async function main() {
  await test('silences: a title card over a pause is kept, and the panel says why', async (ctx) => {
    // The speech detector runs on this sound: it must be there, so nothing passes silently on the fallback.
    sp.requireSpeechAssets({ model: false })
    // The pause runs 3.5–7.5 s; a lower third covers 4–7 s of it.
    const card = { id: 'card', start: 4, end: 7, title: 'Part two', style: 'lower-third', background: 'blur' }
    const { home, id, win } = await openSeeded(ctx, 'w3fix-silences', { name: 'Talk', seconds: 12, width: 640, height: 360, fps: 30, audio: true, video: talkSilenceTalk() }, { titles: [card] })
    await win.click('.insp-tabs button:has-text("Clip")')
    await win.click('.chips[aria-label="Smart speed mode"] .chip:has-text("Silences")')
    // What is left of the pause next to the card (0.5 s each side) is under the 1 s minimum.
    // The mixed track goes through the union of the speech detector and the level (the tone is not speech: today's ranges).
    await win.waitForSelector('[data-testid="silence-detector"][data-detector="mixed"]', { timeout: 30000 })
    await f.waitFor(async () => (await win.$('.smart-summary')) && (await win.textContent('.smart-summary')).includes('No pauses of 1.0 s'), 'no pause listed over the card', 30000)
    await win.waitForSelector('[data-testid="smart-speed-titles"]')
    // A shorter minimum and less padding find the silence on each side of the card, never under it.
    await setSlider(win, 'Silent for at least', 0.5)
    await setSlider(win, 'Keep next to the sound', 0.15)
    await f.waitFor(async () => (await ranges(win)).length > 0, 'the silences next to the card', 3000)
    const found = await ranges(win)
    console.log(`  silences around the card: ${JSON.stringify(found)}`)
    h.assert(found.every(([a, b]) => b <= card.start + 0.05 || a >= card.end - 0.05), `nothing listed under the card: ${JSON.stringify(found)}`)
    await win.click('.smart-speed button.btn.primary')
    await win.waitForSelector('.notice:has-text("silence")', { timeout: 10000 })
    const p = await saved(home, id, (q) => q.clips.length > 1, 'the silences cut')
    const kept = p.clips.filter((c) => c.start <= card.start + 1e-6 && c.end >= card.end - 1e-6 && c.speed === 1)
    h.assert(kept.length === 1, `the card's time is kept whole: ${JSON.stringify(p.clips)}`)
  })

  await test('camera layouts at the playhead: in a cut and near a trimmed end, from the track, the panel and a command, then shown', async (ctx) => {
    // 20 s with a camera; 8–12 s is cut and the end is trimmed to 18 s.
    const clips = [{ id: 'a', start: 0, end: 8, speed: 1 }, { id: 'b', start: 12, end: 18, speed: 1 }]
    const { home, id, win } = await openSeeded(ctx, 'w3fix-layouts', { name: 'Camera', seconds: 20, webcam: true, clips })
    await win.waitForSelector('[data-testid="layout-track"]')

    // A double-click on the camera track inside the cut adds the change on the next kept frame,
    // and the playhead moves past its change in, so the paused preview shows it.
    const track = await boxOf(win, '[data-testid="layout-track"]')
    await win.mouse.dblclick(await xForTime(win, 10), track.y)
    let p = await saved(home, id, (q) => (q.layouts ?? []).length === 1, 'a layout change from the track')
    const side = p.layouts[0]
    console.log(`  track in the cut: ${side.layout} ${side.start.toFixed(2)}..${side.end.toFixed(2)}`)
    h.assert(side.layout === 'side-by-side' && near(side.start, 12, 0.01) && near(side.end, 17, 0.01), `on the frame shown after the cut: ${JSON.stringify(side)}`)
    let t = await playheadTime(win)
    h.assert(t > 12 + LAYOUT_TRANSITION - 0.01 && t < 12 + LAYOUT_TRANSITION + 0.1, `playhead past the change in (${t.toFixed(3)})`)

    // With the playhead in the cut, the Camera panel shows the change the preview shows there.
    await clickRulerAt(win, 9)
    t = await playheadTime(win)
    h.assert(t > 8 && t < 12, `playhead in the cut (${t.toFixed(2)})`)
    if (!(await win.$('.insp-tabs button[title="Camera"][aria-pressed="true"]'))) await win.click('.insp-tabs button[title="Camera"]')
    await win.waitForSelector('.layout-option.active:has-text("Side by side")')

    // Picking a layout in the panel just before the trimmed end: a change that ends with the
    // video and starts earlier, after the one before (not one that starts too late to play).
    await clickRulerAt(win, 17.95)
    if (!(await win.$('.insp-tabs button[title="Camera"][aria-pressed="true"]'))) await win.click('.insp-tabs button[title="Camera"]')
    await win.click('.layout-option:has-text("Camera only")')
    p = await saved(home, id, (q) => q.layouts.length === 2, 'a layout change from the panel')
    const cam = p.layouts.find((s) => s.layout === 'camera-only')
    console.log(`  panel at the trimmed end: ${cam.start.toFixed(2)}..${cam.end.toFixed(2)}`)
    h.assert(near(cam.start, 17, 0.01) && near(cam.end, 18, 0.01), `ends with the video, after the one before: ${JSON.stringify(cam)}`)

    // A command with the paused playhead on free time: the playhead moves past the change in.
    await clickRulerAt(win, 3)
    await runCommand(win, 'screen only', 'Camera layout: screen only')
    p = await saved(home, id, (q) => q.layouts.length === 3, 'a layout change from the command')
    const screen = p.layouts.find((s) => s.layout === 'screen-only')
    h.assert(near(screen.start, 3, 0.05) && near(screen.end, 8, 0.05), `from the playhead, 5 s long: ${JSON.stringify(screen)}`)
    await f.waitFor(async () => (await playheadTime(win)) > screen.start + LAYOUT_TRANSITION, 'the playhead past the change in', 3000)
    await win.waitForSelector(`.layout-seg.selected[data-layout="${screen.id}"]`)
  })

  await test('scrubbing the camera layout and title tracks of a zoomed-in timeline keeps the view still, the playhead under the pointer', async (ctx) => {
    const { win } = await openSeeded(ctx, 'w3fix-scrub', { name: 'Long', seconds: 60, webcam: true })
    await win.waitForSelector('[data-testid="layout-track"]')
    for (let i = 0; i < 8; i++) {
      const el = await win.$('[data-testid="timeline-scroller"]')
      if (await el.evaluate((s) => s.scrollWidth > s.clientWidth * 4)) break
      await win.click('button[aria-label="Zoom in timeline"]')
      await h.sleep(150)
    }
    const view = await boxOf(win, '[data-testid="timeline-scroller"]')
    h.assert((await win.$eval('[data-testid="timeline-scroller"]', (s) => s.scrollWidth)) > view.w * 3, 'the timeline scrolls')

    for (const [name, selector] of [['camera layout', '[data-testid="layout-track"]'], ['title', '.title-lane']]) {
      await win.keyboard.press('Home')
      await f.waitFor(async () => (await scrollLeft(win)) === 0, 'scrolled back to the start', 3000)
      const y = (await boxOf(win, selector)).y
      const from = view.left + 60
      const to = view.right - 8
      await win.mouse.move(from, y)
      await win.mouse.down()
      const before = await scrollLeft(win)
      // Small steps, as a hand does, right up to the edge of the timeline.
      for (let x = from; x <= to; x += 6) await win.mouse.move(x, y)
      await win.mouse.move(to, y)
      await h.sleep(200)
      const after = await scrollLeft(win)
      const t = await playheadTime(win)
      const under = await timeAtX(win, to)
      await win.mouse.up()
      console.log(`  ${name} track: scroll ${before} -> ${after}; playhead ${t.toFixed(2)} s, pointer at ${under.toFixed(2)} s`)
      h.assert(after === before, `${name} track: the timeline does not scroll while scrubbing (${before} -> ${after})`)
      h.assert(Math.abs(t - under) * Number(await win.$eval('.tl-content', (el) => el.dataset.pxPerSec)) < 3, `${name} track: the playhead is under the pointer (${t.toFixed(2)} vs ${under.toFixed(2)} s)`)
    }
  })

  await test('camera layouts added while playing play: the playhead does not jump past the change', async (ctx) => {
    const { home, id, win } = await openSeeded(ctx, 'w3fix-playing', { name: 'Camera', seconds: 20, webcam: true })
    await win.waitForSelector('[data-testid="layout-track"]')
    if (!(await win.$('.insp-tabs button[title="Camera"][aria-pressed="true"]'))) await win.click('.insp-tabs button[title="Camera"]')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Space')
    await f.waitFor(() => isPlaying(win), 'playing')
    await f.waitFor(async () => (await playheadTime(win)) > 1, 'played a second', 10000)

    // From the Camera panel: a change at the playhead, which then plays on through it.
    await countSeeks(win)
    const t0 = await playheadTime(win)
    await win.click('.layout-option:has-text("Side by side")')
    let p = await saved(home, id, (q) => (q.layouts ?? []).length === 1, 'a layout change from the panel')
    const side = p.layouts[0]
    await h.sleep(300)
    let t = await playheadTime(win)
    console.log(`  panel while playing at ${t0.toFixed(2)}: ${side.start.toFixed(2)}..${side.end.toFixed(2)}, playhead ${t.toFixed(2)}, seeks ${await seeks(win)}`)
    h.assert(side.layout === 'side-by-side' && side.start >= t0 - 0.01 && side.start < t0 + 1, `at the playhead: ${JSON.stringify(side)}`)
    h.assert((await seeks(win)) === 0, 'the panel did not move the playing playhead')
    h.assert(await isPlaying(win), 'still playing')

    // From the command palette (which does not pause) once past that change: the same.
    await f.waitFor(async () => (await playheadTime(win)) > side.end + 0.2, 'past the first change', 15000)
    await countSeeks(win)
    await runCommand(win, 'camera only', 'Camera layout: camera only')
    p = await saved(home, id, (q) => q.layouts.length === 2, 'a layout change from the command')
    const cam = p.layouts.find((s) => s.layout === 'camera-only')
    await h.sleep(300)
    t = await playheadTime(win)
    console.log(`  command while playing: ${cam.start.toFixed(2)}..${cam.end.toFixed(2)}, playhead ${t.toFixed(2)}, seeks ${await seeks(win)}`)
    h.assert(cam.start > side.end, `after the first: ${JSON.stringify(cam)}`)
    h.assert((await seeks(win)) === 0, 'the command did not move the playing playhead')
    h.assert(await isPlaying(win), 'still playing after the command')
  })
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
