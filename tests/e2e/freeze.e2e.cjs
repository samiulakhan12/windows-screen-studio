// Freeze frames (E-11) end to end: F freezes the frame under the playhead (one undo step), the
// exported video holds it frame-exactly with the recording's sound paused and moved after it
// (chapters too), "Keep the sound playing" holds the picture without adding time, and Delete
// removes it. Preview holds are timing-sensitive under Xvfb and are checked by hand (design §12).
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/* ---------- from export.e2e.cjs ---------- */

/** Opens the export dialog, applies `opts` and starts the export to `out`. */
async function startExport(app, win, out, opts = {}) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  if (opts.format) await fx.pickChip(win, 'Format', opts.format)
  if (opts.res) await fx.pickChip(win, 'Resolution', opts.res)
  if (opts.fps) await fx.pickChip(win, 'Frame rate', opts.fps)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
}

async function exportTo(app, win, out, opts) {
  await startExport(app, win, out, opts)
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export finished: ${r.text}`)
  return r
}

async function closeDialog(win) {
  const back = win.locator('.modal button', { hasText: /^Back$/ })
  if (await back.count()) await back.click()
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Frame codes of an export whose content is the indexed source at 1:1 (no padding). */
function codes(file, width, height) {
  return fx.decodeIndices(file, { x: 0, y: 0, w: width, h: Math.floor(height / 4) })
}

/* ---------- from titles.e2e.cjs ---------- */

/** Adds items to a seeded project.json (the shared fixtures do not know them). */
function addItems(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

const timecode = (win) => win.$eval('.timecode', (e) => e.textContent)
const outTime = (tc) => {
  const [m, s] = tc.split('/')[0].trim().split(':')
  return Number(m) * 60 + Number(s)
}

async function playheadAt(win, seconds) {
  await win.keyboard.press('Home')
  for (let i = 0; i < seconds; i++) await win.keyboard.press('Shift+ArrowRight')
  await f.waitFor(async () => Math.abs(outTime(await timecode(win)) - seconds) < 0.05, `playhead at ${seconds} s`, 3000)
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

/* ---------- checks ---------- */

/** The export's codes are the source frames of `time(v)` at 60 fps, frame by frame. */
function expectCodes(got, count, time, label) {
  h.assert(got.length === count, `${label}: ${got.length} frames, expected ${count}`)
  const wrong = []
  for (let i = 0; i < count; i++) {
    const want = Math.round(time(i / 60) * 60)
    if (got[i] !== want) wrong.push(`#${i}: ${got[i]} != ${want}`)
  }
  h.assert(wrong.length === 0, `${label}: ${wrong.length} frames show the wrong source frame (${wrong.slice(0, 8).join(', ')})`)
}

function expectBeeps(file, want, label) {
  const { onsets } = fx.beepOnsets(file)
  h.assert(onsets.length === want.length && onsets.every((t, i) => Math.abs(t - want[i]) < 0.03), `${label}: beeps at ${onsets.map((t) => t.toFixed(3))}, expected ${want}`)
  return onsets
}

const chapterStarts = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', file]).toString()).chapters.map((c) => +Number(c.start_time).toFixed(3))

const totalTime = async (win) => (await timecode(win)).split('/')[1].trim()

async function main() {
  await test('freeze: F holds the frame (undo, redo), the export holds it with the sound paused, keep the sound, Delete', fx.withHome('freeze', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 6, width: 1280, height: 720, beeps: true })
    const id = fx.seedProject(home, { name: 'Freeze', media, seconds: 6, audio: true })
    addItems(home, id, {
      chapters: [
        { id: 'k0', t: 0, title: 'Intro' },
        { id: 'k1', t: 4, title: 'Later' }
      ]
    })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Freeze')

    // F at 2 s: a 3 s freeze with the sound paused; the video is 3 s longer.
    await playheadAt(win, 2)
    await win.keyboard.press('f')
    let p = await saved(home, id, (q) => q.freezes?.length === 1, 'a freeze frame')
    const [fr] = p.freezes
    h.assert(fr.at === 2 && fr.length === 3 && fr.sound === 'pause', `freezes the frame at the playhead: ${JSON.stringify(fr)}`)
    await win.waitForSelector('[data-testid="freeze-block"]', { state: 'visible' })
    await f.waitFor(async () => (await totalTime(win)) === '0:09.0', 'the video is 9 s long', 3000)
    // On its frame, F again selects it instead.
    await win.keyboard.press('f')
    await win.waitForSelector('.notice:has-text("already a freeze frame here")')

    // One undo step each way.
    await win.keyboard.press('Control+z')
    p = await saved(home, id, (q) => !('freezes' in q), 'undo removes it')
    await f.waitFor(async () => (await totalTime(win)) === '0:06.0', 'the video is 6 s long again', 3000)
    await win.keyboard.press('Control+Shift+z')
    p = await saved(home, id, (q) => q.freezes?.length === 1 && q.freezes[0].at === 2, 'redo brings it back')
    await f.waitFor(async () => (await totalTime(win)) === '0:09.0', 'and the 3 s', 3000)

    // The export: 3 s of the frame at 2 s, the recording's sound paused, everything after 3 s later.
    const paused = path.join(home, 'freeze-pause.mp4')
    await exportTo(app, win, paused, { res: '720p', fps: '60 fps' })
    await closeDialog(win)
    const info = fx.probe(paused)
    const video = info.streams.find((s) => s.codec_type === 'video')
    const audio = info.streams.find((s) => s.codec_type === 'audio')
    h.assert(Number(video.nb_frames) === 540, `540 video frames (got ${video.nb_frames})`)
    h.assert(Math.abs(Number(audio.duration) - 9) < 0.03, `audio is 9 s (got ${audio.duration})`)
    const frameCodes = codes(paused, 1280, 720)
    expectCodes(frameCodes, 540, (v) => (v < 2 ? v : v < 5 ? 2 : v - 3), 'pause freeze')
    const onsets = expectBeeps(paused, [0, 1, 5, 6, 7, 8], 'pause freeze')
    // Each beep with the frame of its source second (the beep at 2 s after the hold, with the video moving on).
    ;[0, 1, 2, 3, 4, 5].forEach((s, i) => {
      const shown = frameCodes.lastIndexOf(s * 60) / 60
      h.assert(Math.abs(shown - onsets[i]) < 0.03, `beep of ${s} s at ${onsets[i].toFixed(3)} s, its frame at ${shown.toFixed(3)} s`)
    })
    h.assert(JSON.stringify(chapterStarts(paused)) === '[0,7]', `chapters after the freeze move 3 s later: ${chapterStarts(paused)}`)
    console.log(`  pause: 540 frames, audio ${Number(audio.duration).toFixed(3)} s, beeps at ${onsets.map((t) => t.toFixed(3)).join(', ')} s`)

    // Keep the sound playing: no time added, the picture holds for 3 s while the sound goes on.
    await win.click('[data-testid="freeze-block"]')
    await win.waitForSelector('[data-testid="freeze-sound"]')
    await win.locator('[data-testid="freeze-sound"] .chip', { hasText: 'Keep the sound playing' }).click()
    p = await saved(home, id, (q) => q.freezes?.[0]?.sound === 'continue', 'the freeze keeps the sound')
    await f.waitFor(async () => (await totalTime(win)) === '0:06.0', 'adds no time', 3000)
    const kept = path.join(home, 'freeze-continue.mp4')
    await exportTo(app, win, kept, { res: '720p', fps: '60 fps' })
    await closeDialog(win)
    expectCodes(codes(kept, 1280, 720), 360, (v) => (v >= 2 && v < 5 ? 2 : v), 'continue freeze')
    expectBeeps(kept, [0, 1, 2, 3, 4, 5], 'continue freeze')
    h.assert(JSON.stringify(chapterStarts(kept)) === '[0,4]', `chapters stay: ${chapterStarts(kept)}`)

    // Delete removes it.
    await win.click('[data-testid="freeze-block"]')
    await win.keyboard.press('Delete')
    await saved(home, id, (q) => !('freezes' in q), 'Delete removes the freeze')
    await f.waitFor(async () => !(await win.$('[data-testid="freeze-block"]')), 'and its block')
  }))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
