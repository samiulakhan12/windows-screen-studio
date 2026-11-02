// Review mode end to end (docs/design/review-mode.md §9): a 20 s recording with a camera, an auto
// zoom at 2 s, a camera director segment at 5 s and a silence cut Remove silences made at 8-10.4 s
// (with its record), and a zoom of yours. The Review button counts 3; Shift+R opens the panel with
// the focus on the first item; N and P move (the playhead jumps); Space on the row stops the
// stretch where it is; K keeps the zoom (saved with auto false); Delete removes the silence cut
// (the footage comes back, the record goes, the choice is saved); Ctrl+Z brings the cut back and
// its row back to "not reviewed", and takes the choice away; a mouse click on a row then Delete removes the camera change (the same message as
// before is announced again); Keep all, pressed from the keyboard, reviews the rest and leaves the
// focus in the list, and undone and redone (from the keys and from the palette) under a row's Keep
// button leaves it on that row; Escape closes and gives the focus back to the button; the palette opens it
// again, now empty; a palette command that shows an Inspector tab closes it, the focus going to the
// button when it was in the panel and staying where it was when it was outside. Then, against the
// local mock of the AI providers: with the panel open, Polish cuts the silences of a recording with
// spoken "words", Ctrl+Z takes them back (the rows read removed), and the same Polish again lists
// its new rows to review while the first run's rows still read removed, with no choice saved;
// Ctrl+Z from Keep all, which it disables, leaves the focus on a row, and so does Undo run from the
// palette with the focus on Keep all (N then moves in the list). A long list (399 cut records)
// draws only the rows near the view: the focus starts on the first row, End, P, Home and a held
// arrow move it with its accessible name and place in the list (aria-posinset, aria-setsize), each
// in view; K keeps and moves on; scrolled away, N brings the next row into view; Remove all says it
// is working, then what it did, and one Ctrl+Z takes it back; Escape closes. Long lists of rows of
// different heights (400, 2,000 and 6,000 rows, retakes whose words wrap): End, End again, End once
// scrolled away, K, Home, P and a held arrow each leave the focused row fully in view; Remove all
// from the last row moves the focus to the first row to review, not drawn until then, where N moves
// in the list; Ctrl+Z pressed while Remove all works waits and undoes it, the Keep before it stays
// and Ctrl+Y brings it back; and on 6,000 rows, K, Delete and a click on a row's Keep pressed while
// it works each say they wait, move the focus on, and are done after it in order, each its own undo
// step, while Keep all pressed meanwhile says it is still working.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')
const fx = require('./render-fixtures.cjs')
const { startMockAi, mockAiEnv, burstAudioArgs } = require('./ai-mock-server.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))

/** Screenshots of the panel when set to a folder (docs/screenshots/review-mode-*.png). */
const SHOTS = process.env.SSW_E2E_SHOTS || null
const SECONDS = 20
const NAME = 'Review me'

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

function seed(home) {
  const id = f.seedProject(home, {
    id: 'rec-review',
    name: NAME,
    seconds: SECONDS,
    width: 640,
    height: 360,
    fps: 30,
    webcam: true,
    clips: [
      { id: 'c0', start: 0, end: 8, speed: 1 },
      { id: 'c1', start: 10.4, end: SECONDS, speed: 1 }
    ],
    zooms: [
      { id: 'z1', start: 2, end: 4, scale: 2, focus: { mode: 'cursor' }, auto: true, anchor: { t: 2.5, x: 0.9, y: 0.1 } },
      { id: 'mine', start: 14, end: 16, scale: 1.5, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }
    ]
  })
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  p.layouts = [{ id: 'l1', start: 5, end: 7, layout: 'default', corner: 'top-left', auto: true }]
  p.autoCuts = [{ id: 's1', by: 'silences', action: 'cut', start: 8, end: 10.4, was: [{ start: 8, end: 10.4, speed: 1 }] }]
  fs.writeFileSync(file, JSON.stringify(p, null, 2))
  return id
}

/** A 12 s test pattern whose sound is four "Word k" bursts, 0.5-3.2 s and 8.0-10.7 s (cached, as one-click-polish.e2e.cjs makes it). */
const WORDS_SECONDS = 12
const WORDS_NAME = 'Polish twice'
function wordsVideo() {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `polish-words-${WORDS_SECONDS}s-640x360-30.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/\.mp4$/, '.part.mp4')
  execFileSync(FF, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', ...burstAudioArgs([0.5, 2.0, 8.0, 9.5], WORDS_SECONDS),
    '-t', String(WORDS_SECONDS), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    tmp
  ])
  fs.renameSync(tmp, file)
  return file
}

function seedWords(home) {
  const id = f.seedProject(home, {
    id: 'rec-review-polish',
    name: WORDS_NAME,
    seconds: WORDS_SECONDS,
    width: 640,
    height: 360,
    fps: 30,
    audio: true,
    webcam: false,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  const dir = path.join(h.projectsRoot(home), id)
  fs.unlinkSync(path.join(dir, 'screen.mp4'))
  fs.symlinkSync(wordsVideo(), path.join(dir, 'screen.mp4'))
  return id
}

/** Polish with only Remove silences ticked, through its dialog (Shift+P), to Done. */
async function polishSilences(win) {
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await win.keyboard.press('Shift+P')
  const dialog = win.locator('.polish-dialog[role="dialog"]')
  await dialog.waitFor({ timeout: 10000 })
  await win.waitForSelector('.polish-dialog .modal-foot button.primary:not([disabled])', { timeout: 10000 })
  for (const step of ['zoom', 'captions', 'director']) {
    const box = win.locator(`[data-testid="polish-row-${step}"] input[type="checkbox"]`)
    if ((await box.count()) && (await box.isChecked().catch(() => false))) await box.uncheck()
  }
  await win.click('.polish-dialog .modal-foot button.primary:has-text("Polish")')
  await win.waitForSelector('[data-testid="polish-summary"]', { timeout: 60000 })
  await win.click('.polish-dialog .modal-foot button:has-text("Done")')
  await dialog.waitFor({ state: 'detached' })
}

/**
 * A 20-minute recording with a second cut every 3 s by Remove silences: 400 clips of 2 s and
 * LONG_ROWS cut records, more than the panel draws at once. Row k starts at 3k + 2 s of the
 * recording, so at 2(k + 1) s of the video.
 */
const LONG_NAME = 'Review a long one'
const LONG_ROWS = 399
function seedLong(home) {
  const clips = Array.from({ length: LONG_ROWS + 1 }, (_, k) => ({ id: `c${k}`, start: 3 * k, end: 3 * k + 2, speed: 1 }))
  const id = f.seedProject(home, { id: 'rec-review-long', name: LONG_NAME, seconds: 1200, width: 128, height: 72, fps: 1, clips, cursor: f.cursorTrack(2) })
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  p.autoCuts = Array.from({ length: LONG_ROWS }, (_, k) => ({ id: `s${k}`, by: 'silences', action: 'cut', start: 3 * k + 2, end: 3 * k + 3, was: [{ start: 3 * k + 2, end: 3 * k + 3, speed: 1 }] }))
  fs.writeFileSync(file, JSON.stringify(p))
  return id
}
/** Row k's accessible name. */
const longName = (k, status) => {
  const t = 2 * (k + 1)
  return `Cut 1.0 s of silence, silence, at ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}.0, Remove silences, ${status}`
}
/** Where the focused row is in the list (aria-posinset, aria-setsize) and whether it is in view. */
const place = (win) =>
  win.evaluate(() => {
    const row = document.activeElement?.closest('[data-testid="review-row"]')
    if (!row) return null
    const r = row.querySelector('.review-item').getBoundingClientRect()
    const box = row.parentElement.getBoundingClientRect()
    return { pos: Number(row.getAttribute('aria-posinset')), size: Number(row.getAttribute('aria-setsize')), inView: r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 }
  })

/**
 * A long list whose rows differ in height (docs/design/review-mode.md §4.3): three auto zooms at the
 * start, then `cuts` cut records 3 s apart, the first MIXED_SILENCES silences and the rest retakes,
 * a third of whose words are long enough to wrap the title over two or three lines.
 */
const MIXED_SILENCES = 30
const LONG_WORDS = 'so what I was trying to say before is that the thing we need to do here is honestly'
function seedMixed(home, name, cuts) {
  const clips = Array.from({ length: cuts + 1 }, (_, k) => ({ id: `c${k}`, start: 3 * k, end: 3 * k + 2, speed: 1 }))
  const zooms = [0, 1, 2].map((j) => ({ id: `z${j}`, start: 0.1 + 0.5 * j, end: 0.5 + 0.5 * j, scale: 2, focus: { mode: 'cursor' }, auto: true, anchor: { t: 0.2 + 0.5 * j, x: 0.2, y: 0.8 } }))
  const id = f.seedProject(home, { id: `rec-mixed-${cuts}`, name, seconds: 3 * cuts + 3, width: 128, height: 72, fps: 1, clips, zooms, cursor: f.cursorTrack(2) })
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  p.autoCuts = Array.from({ length: cuts }, (_, k) => {
    const was = [{ start: 3 * k + 2, end: 3 * k + 3, speed: 1 }]
    if (k < MIXED_SILENCES) return { id: `s${k}`, by: 'silences', action: 'cut', start: 3 * k + 2, end: 3 * k + 3, was }
    return { id: `s${k}`, by: 'retake', action: 'cut', start: 3 * k + 2, end: 3 * k + 3, was, words: k % 3 === 0 ? LONG_WORDS : 'um so' }
  })
  fs.writeFileSync(file, JSON.stringify(p))
  return id
}
/** The focused row's key and whether it is fully in view, once the list has stopped measuring and scrolling. */
async function settled(win) {
  let last = null
  for (let i = 0; i < 40; i++) {
    await h.sleep(60)
    const now = await win.evaluate(() => {
      const ul = document.querySelector('.review-list')
      const row = document.activeElement?.closest('[data-testid="review-row"]')
      if (!ul || !row) return { key: null, inView: false, top: ul?.scrollTop ?? -1 }
      const r = row.getBoundingClientRect()
      const b = ul.getBoundingClientRect()
      return { key: row.dataset.key, pos: Number(row.getAttribute('aria-posinset')), inView: r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5, top: ul.scrollTop }
    })
    if (last && JSON.stringify(now) === JSON.stringify(last)) return now
    last = now
  }
  return last
}
/** What the focus is on: a row's key, else the element's test id or name. */
const focusOn = (win) =>
  win.evaluate(() => {
    const a = document.activeElement
    const row = a?.closest?.('[data-testid="review-row"]')
    if (row && a.classList.contains('review-item')) return row.dataset.key
    return a?.dataset?.testid ?? a?.getAttribute?.('aria-label') ?? a?.tagName ?? ''
  })
/** Records, on every key press, whether Keep all or Remove all was working then (window.__busyAt). */
async function watchBusy(win) {
  await win.evaluate(() => {
    window.__busyAt = []
    window.__said = []
    if (window.__watching) return
    window.__watching = true
    window.addEventListener('keydown', (e) => window.__busyAt.push(`${e.key}:${!!document.querySelector('[data-testid="review-panel"] [aria-busy="true"]')}`), true)
    const said = document.querySelector('[data-testid="review-said"]')
    new MutationObserver(() => window.__said.push(said.textContent)).observe(said, { childList: true, subtree: true, characterData: true })
  })
}
/** What watchBusy recorded after the first press (Enter on Remove all), without the modifier keys. */
const pressedAfter = (win) => win.evaluate(() => window.__busyAt.slice(1).filter((k) => !/^(Shift|Control):/.test(k)))
const idle = (win, timeout = 30000) => f.waitFor(async () => !(await win.$('[data-testid="review-panel"] [aria-busy="true"]')), 'Keep all or Remove all done', timeout)
const progressOf = (win) => win.textContent('[data-testid="review-progress"]')

const rows = (win) => win.$$eval('[data-testid="review-row"]', (els) => els.map((e) => `${e.dataset.key}=${e.dataset.status}`))
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const focused = (win) => win.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '')
const timecode = (win) => win.$eval('.timecode', (e) => e.textContent ?? '')
const playing = (win) => win.$eval('.transport .btn.round', (e) => e.dataset.playing === 'true')
/** The playhead in seconds of the video (the timecode's first half). */
const seconds = (win) =>
  win.$eval('.timecode', (e) => {
    const m = /^(\d+):(\d+\.\d)/.exec(e.textContent ?? '')
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  })

/** The saved project once `pred` holds. */
function savedWhen(home, id, pred, what) {
  return f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return pred(p) ? p : null
      } catch {
        return null
      }
    },
    what,
    15000
  )
}

async function main() {
  await test('review mode: keyboard review, keep, remove, undo, keep all', async (ctx) => {
    const home = h.tempHome('review')
    const id = seed(home)
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await f.openProject(win, NAME)

    h.assert((await win.textContent('[data-testid="review-count"]')) === '3', 'the button counts 3 changes')
    h.assert((await win.getAttribute('[data-testid="review-open"]', 'aria-label')) === 'Review automatic changes, 3 to review', 'the button says how many')

    await win.click('.timecode').catch(() => undefined)
    await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await win.keyboard.press('Shift+R')
    await win.waitForSelector('[data-testid="review-panel"]', { timeout: 5000 })
    h.assert(JSON.stringify(await rows(win)) === JSON.stringify(['zoom:z1=pending', 'camera:l1=pending', 'cut:s1=pending']), `rows in time order: ${await rows(win)}`)
    h.assert((await win.textContent('[data-testid="review-progress"]')) === '0 of 3 reviewed', 'progress starts at 0')
    const first = await focused(win)
    h.assert(first === 'Zoom in on a click, top right, zoom, at 0:02.0, 2×, not reviewed', `the focus starts on the first item: ${first}`)

    // N moves to the camera change and plays around it: the playhead goes to 1.5 s before it.
    await win.keyboard.press('n')
    h.assert((await focused(win)).startsWith('Camera to the top left corner, camera, at 0:05.0'), `N moves: ${await focused(win)}`)
    await f.waitFor(async () => /^0:0[3-6]/.test(await timecode(win)), 'the playhead at the camera change', 5000)
    // Space on the row stops the stretch where it is, not back at its start playing again.
    await f.waitFor(async () => (await playing(win)) && (await seconds(win)) >= 3.8, 'the stretch playing', 5000)
    await win.keyboard.press('Space')
    await f.waitFor(async () => !(await playing(win)), 'Space stops the stretch', 5000)
    const stopped = await seconds(win)
    await h.sleep(500)
    h.assert(!(await playing(win)) && (await seconds(win)) === stopped && stopped >= 3.8, `stopped where it was: ${stopped}, now ${await timecode(win)}`)
    h.assert((await focused(win)).startsWith('Camera to the top left corner'), `the focus stays on the row: ${await focused(win)}`)
    await win.keyboard.press('p')
    h.assert((await focused(win)).startsWith('Zoom in on a click'), 'P moves back')

    // K keeps the zoom: it stays, no longer automatic; the focus goes to the next one to review.
    await win.keyboard.press('k')
    await f.waitFor(async () => (await rows(win)).includes('zoom:z1=kept'), 'the zoom kept')
    h.assert((await win.textContent('[data-testid="review-said"]')) === 'Kept. 1 of 3 reviewed.', 'the keep is announced')
    h.assert((await focused(win)).startsWith('Camera to the top left corner'), `the focus moves on: ${await focused(win)}`)
    await savedWhen(home, id, (p) => p.zooms.find((z) => z.id === 'z1')?.auto === false, 'the kept zoom saved as yours')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'review-mode-panel.png') })

    // Delete on the silence cut takes it back: the footage returns and the record goes.
    await win.keyboard.press('ArrowDown')
    h.assert((await focused(win)).startsWith('Cut 2.4 s of silence, silence, at 0:08.0'), `on the cut: ${await focused(win)}`)
    await win.keyboard.press('Delete')
    await f.waitFor(async () => (await rows(win)).includes('cut:s1=removed'), 'the cut removed')
    const restored = await savedWhen(home, id, (p) => p.clips.length === 1, 'the footage back')
    h.assert(restored.clips[0].start === 0 && restored.clips[0].end === SECONDS, `the whole recording: ${JSON.stringify(restored.clips)}`)
    h.assert(!('autoCuts' in restored), 'the record is gone')
    h.assert(JSON.stringify(restored.autoCutOutcomes) === JSON.stringify([{ id: 's1', outcome: 'removed' }]), `the choice saved: ${JSON.stringify(restored.autoCutOutcomes)}`)
    h.assert(restored.zooms.some((z) => z.id === 'mine'), 'your zoom is untouched')

    // Ctrl+Z (one undo step) brings the cut and its row back.
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await rows(win)).includes('cut:s1=pending'), 'the cut pending again')
    const back = await savedWhen(home, id, (p) => p.clips.length === 2 && Array.isArray(p.autoCuts), 'the cut back')
    h.assert(back.zooms.find((z) => z.id === 'z1')?.auto === false, 'the keep before it stays')
    h.assert(!('autoCutOutcomes' in back), 'the undo takes the choice away with the cut')
    h.assert((await win.textContent('[data-testid="review-progress"]')) === '1 of 3 reviewed', 'progress follows the undo')

    // A mouse click on a row keeps the list's keys in the list: Delete removes that camera change
    // (it must not reach the editor, where Delete would remove the selected timeline item).
    await win.click('[data-testid="review-row"][data-key="camera:l1"] .review-item')
    await h.sleep(150)
    h.assert((await focused(win)).startsWith('Camera to the top left corner'), `the focus stays on the clicked row: ${await focused(win)}`)
    // The same words as the last message are a change in the live region, so they are read out again.
    h.assert((await win.textContent('[data-testid="review-said"]')) === 'Removed. 2 of 3 reviewed.', 'the last message')
    await win.evaluate(() => {
      window.__saidChanges = 0
      new MutationObserver((m) => (window.__saidChanges += m.length)).observe(document.querySelector('[data-testid="review-said"]'), { childList: true, subtree: true, characterData: true })
    })
    await win.keyboard.press('Delete')
    await f.waitFor(async () => (await rows(win)).includes('camera:l1=removed'), 'the camera change removed')
    h.assert((await win.textContent('[data-testid="review-said"]')) === 'Removed. 2 of 3 reviewed.', 'the remove is announced')
    h.assert((await win.evaluate(() => window.__saidChanges)) > 0, 'the same words are announced again')
    await savedWhen(home, id, (p) => (p.layouts ?? []).length === 0, 'the camera change gone')
    h.assert((await win.getAttribute('.editor-body > .inspector', 'inert')) !== null, 'the Inspector under the panel is out of reach')

    // Keep all, pressed from the keyboard, reviews the rest in one go; the button turns disabled and
    // the focus goes back to the row, so the panel's keys keep working.
    await win.focus('[data-testid="review-keep-all"]')
    await win.keyboard.press('Enter')
    await f.waitFor(async () => (await win.textContent('[data-testid="review-progress"]')) === '3 of 3 reviewed', 'all reviewed')
    h.assert((await win.textContent('[data-testid="review-said"]')) === 'Kept 1 change.', 'keep all is announced')
    await h.sleep(100)
    h.assert((await focused(win)).startsWith('Cut 2.4 s of silence'), `the focus back on the row: ${await focused(win)}`)
    const kept = await savedWhen(home, id, (p) => !('autoCuts' in p), 'everything kept')
    h.assert(kept.clips.length === 2, 'the cut stays, as a plain cut')
    h.assert(JSON.stringify(kept.autoCutOutcomes) === JSON.stringify([{ id: 's1', outcome: 'kept' }]), `the choice saved: ${JSON.stringify(kept.autoCutOutcomes)}`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'review-mode-reviewed.png') })

    // Undo and redo take a row in and out of review under the focus: Ctrl+Z gives the cut its Keep
    // and Remove buttons back, Tab moves to Keep, and Ctrl+Y takes that button away. The focus goes
    // back to the row, not to the page, so the panel's keys (Escape below) still work.
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await rows(win)).includes('cut:s1=pending'), 'Keep all undone')
    await win.keyboard.press('Tab')
    h.assert((await focused(win)) === 'Keep: Cut 2.4 s of silence', `Tab moves to the row's Keep: ${await focused(win)}`)
    await win.keyboard.press('Control+y')
    await f.waitFor(async () => (await rows(win)).includes('cut:s1=kept'), 'Keep all redone')
    await h.sleep(100)
    h.assert((await focused(win)).startsWith('Cut 2.4 s of silence, silence, at 0:08.0, Remove silences, kept'), `the focus back on the row after the redo: ${await focused(win)}`)

    // The same redo run from the palette: the palette gives the focus back as it closes, but the
    // Keep button that had it is gone, so it goes to that button's row.
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await rows(win)).includes('cut:s1=pending'), 'Keep all undone again')
    await win.keyboard.press('Tab')
    h.assert((await focused(win)) === 'Keep: Cut 2.4 s of silence', `Tab moves to the row's Keep again: ${await focused(win)}`)
    await win.keyboard.press('Control+k')
    await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
    await win.keyboard.type('redo')
    await f.waitFor(async () => (await win.$eval('.command-palette [role="option"] .palette-title', (e) => e.textContent).catch(() => '')) === 'Redo', '"Redo" listed first', 3000)
    await win.keyboard.press('Enter')
    await f.waitFor(async () => (await rows(win)).includes('cut:s1=kept'), 'Keep all redone from the palette')
    await h.sleep(100)
    h.assert((await focused(win)).startsWith('Cut 2.4 s of silence, silence, at 0:08.0, Remove silences, kept'), `the focus on the row after Redo from the palette: ${await focused(win)}`)

    // Escape closes and gives the focus back to the button, which has nothing left to count.
    h.assert((await win.getAttribute('.editor-body > .inspector', 'inert')) !== null, 'still out of reach')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('[data-testid="review-panel"]')), 'the panel closed')
    h.assert((await focused(win)) === 'Review automatic changes, nothing to review', `the focus back on the button: ${await focused(win)}`)
    h.assert(!(await win.$('[data-testid="review-count"]')), 'no count left')

    // The palette opens it too; there is nothing left to review.
    await win.keyboard.press('Control+k')
    await win.waitForSelector('.palette input, [role="dialog"] input', { timeout: 5000 })
    await win.keyboard.type('review automatic')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-testid="review-panel"]', { timeout: 5000 })
    h.assert((await win.textContent('.review-empty')).startsWith('Nothing to review.'), 'the empty panel says so')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'review-mode-empty.png') })

    // A command that shows an Inspector tab closes the panel over it, the focus going to the button.
    await win.keyboard.press('Control+k')
    await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
    await win.keyboard.type('open clip settings')
    await f.waitFor(async () => (await win.$eval('.command-palette [role="option"] .palette-title', (e) => e.textContent).catch(() => '')) === 'Open Clip settings', '"Open Clip settings" listed first', 3000)
    await win.keyboard.press('Enter')
    await f.waitFor(async () => !(await win.$('[data-testid="review-panel"]')), 'the panel closed for the Clip tab')
    h.assert((await win.getAttribute('.editor-body > .inspector', 'inert')) === null, 'the Inspector in reach again')
    h.assert((await win.getAttribute('.insp-tabs button.active', 'title')) === 'Clip', 'the Clip tab shows')
    await h.sleep(100)
    h.assert((await focused(win)) === 'Review automatic changes, nothing to review', `the focus on the Review button: ${await focused(win)}`)

    // From outside the panel (Review is not modal), the same kind of command leaves the focus where it was.
    await win.keyboard.press('Shift+R')
    await win.waitForSelector('[data-testid="review-panel"]', { timeout: 5000 })
    await win.focus('[aria-label="Keyboard shortcuts"]')
    await win.keyboard.press('Control+k')
    await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
    await win.keyboard.type('open style settings')
    await f.waitFor(async () => (await win.$eval('.command-palette [role="option"] .palette-title', (e) => e.textContent).catch(() => '')) === 'Open Style settings', '"Open Style settings" listed first', 3000)
    await win.keyboard.press('Enter')
    await f.waitFor(async () => !(await win.$('[data-testid="review-panel"]')), 'the panel closed for the Style tab')
    h.assert((await win.getAttribute('.insp-tabs button.active', 'title')) === 'Style', 'the Style tab shows')
    await h.sleep(100)
    h.assert((await focused(win)) === 'Keyboard shortcuts', `the focus back where it was: ${await focused(win)}`)
    h.assert(!logs.some((l) => l.includes('[pageerror]')), `no page errors: ${logs.filter((l) => l.includes('pageerror'))}`)
  })

  await test('review mode: a long list draws the rows in view; keys, names, place and Escape as before', async (ctx) => {
    const home = h.tempHome('review-long')
    seedLong(home)
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await f.openProject(win, LONG_NAME)
    await win.click('.timecode').catch(() => undefined)
    await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await win.keyboard.press('Shift+R')
    await win.waitForSelector('[data-testid="review-panel"] [data-testid="review-row"]', { timeout: 10000 })
    h.assert((await win.textContent('[data-testid="review-progress"]')) === `0 of ${LONG_ROWS} reviewed`, 'every record listed')
    const drawn = await win.$$eval('[data-testid="review-row"]', (els) => els.length)
    h.assert(drawn > 0 && drawn < 60, `only the rows near the view are drawn: ${drawn}`)
    h.assert((await focused(win)) === longName(0, 'not reviewed'), `the focus starts on the first row: ${await focused(win)}`)
    h.assert(same(await place(win), { pos: 1, size: LONG_ROWS, inView: true }), `the first row's place: ${JSON.stringify(await place(win))}`)

    // End goes to the last row, not drawn until then: it gets the focus, in view, with its place.
    await win.keyboard.press('End')
    await f.waitFor(async () => (await focused(win)) === longName(LONG_ROWS - 1, 'not reviewed'), 'End on the last row', 3000)
    h.assert(same(await place(win), { pos: LONG_ROWS, size: LONG_ROWS, inView: true }), `the last row's place: ${JSON.stringify(await place(win))}`)
    await win.keyboard.press('p')
    h.assert((await focused(win)) === longName(LONG_ROWS - 2, 'not reviewed'), `P moves back: ${await focused(win)}`)
    await win.keyboard.press('Home')
    await f.waitFor(async () => (await focused(win)) === longName(0, 'not reviewed'), 'Home on the first row', 3000)
    // A held arrow walks down the list, each row scrolled into view.
    for (let i = 0; i < 30; i++) await win.keyboard.press('ArrowDown')
    h.assert((await focused(win)) === longName(30, 'not reviewed'), `30 rows down: ${await focused(win)}`)
    h.assert(same(await place(win), { pos: 31, size: LONG_ROWS, inView: true }), `row 31's place: ${JSON.stringify(await place(win))}`)
    h.assert((await win.$$eval('[data-testid="review-row"]', (els) => els.length)) < 60, 'still only the rows near the view')

    // K keeps the row and the focus moves on to the next one, announced as on a short list.
    await win.keyboard.press('k')
    await f.waitFor(async () => (await focused(win)) === longName(31, 'not reviewed'), 'the focus on the next row', 3000)
    h.assert((await win.getAttribute('[data-testid="review-row"][data-key="cut:s30"]', 'data-status')) === 'kept', 'row 31 kept')
    h.assert((await win.textContent('[data-testid="review-said"]')) === `Kept. 1 of ${LONG_ROWS} reviewed.`, 'the keep is announced')

    // Scrolled far away with the wheel, the focused row stays (drawn, focused); N brings the next into view.
    const box = await win.$eval('.review-list', (e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await win.mouse.move(box.x, box.y)
    for (let i = 0; i < 10; i++) await win.mouse.wheel(0, 2000)
    await h.sleep(200)
    h.assert((await focused(win)) === longName(31, 'not reviewed'), `the focus stays on its row: ${await focused(win)}`)
    h.assert(!(await place(win)).inView, 'scrolled away from it')
    await win.keyboard.press('n')
    await f.waitFor(async () => (await place(win)).pos === 33, 'N moves on', 3000)
    h.assert(same(await place(win), { pos: 33, size: LONG_ROWS, inView: true }), `the next row scrolled into view: ${JSON.stringify(await place(win))}`)

    // Remove all over this many rows says it is working before it works, and is one undo step.
    await win.evaluate(() => {
      window.__said = []
      window.__busy = false
      const said = document.querySelector('[data-testid="review-said"]')
      new MutationObserver(() => window.__said.push(said.textContent)).observe(said, { childList: true, subtree: true, characterData: true })
      const button = document.querySelector('[data-testid="review-remove-kind"]')
      new MutationObserver(() => (window.__busy ||= button.getAttribute('aria-busy') === 'true')).observe(button, { attributes: true, childList: true, subtree: true })
    })
    await win.focus('[data-testid="review-remove-kind"]')
    await win.keyboard.press('Enter')
    const pending = LONG_ROWS - 1
    await f.waitFor(async () => (await win.textContent('[data-testid="review-progress"]')) === `${LONG_ROWS} of ${LONG_ROWS} reviewed`, 'all removed or kept', 15000)
    const said = await win.evaluate(() => window.__said)
    h.assert(same(said, [`Removing ${pending} silence cuts… Keep, Remove, Undo and Redo wait until it is done.`, `Removed ${pending} silence cuts.`]), `said what it does and what waits, then what it did: ${JSON.stringify(said)}`)
    h.assert(await win.evaluate(() => window.__busy), 'the button said it was working')
    h.assert((await win.textContent('[data-testid="review-remove-kind"]')) === 'Remove all silence cuts', 'the button back')
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.textContent('[data-testid="review-progress"]')) === `1 of ${LONG_ROWS} reviewed`, 'one Ctrl+Z brings them all back', 5000)

    // Escape closes and gives the focus back to the button.
    await win.focus('[data-testid="review-row"] .review-item[tabindex="0"]')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('[data-testid="review-panel"]')), 'the panel closed')
    h.assert((await focused(win)) === `Review automatic changes, ${pending} to review`, `the focus back on the button: ${await focused(win)}`)
    h.assert(!logs.some((l) => l.includes('[pageerror]')), `no page errors: ${logs.filter((l) => l.includes('pageerror'))}`)
  })

  // 400 and 2,000 rows for the moves; 6,000 for what is done while Remove all works (over a second).
  for (const cuts of [397, 1997, 5997]) {
    const total = cuts + 3
    const retakes = cuts - MIXED_SILENCES
    const long = total > 5000
    await test(`review mode: ${total} rows of different heights: moves end in view; after Remove all the focus moves on; what is done while it works waits`, async (ctx) => {
      const home = h.tempHome(`review-mixed-${total}`)
      const name = `Mixed rows ${total}`
      seedMixed(home, name, cuts)
      const { app, win, logs } = await h.launch({ home })
      ctx.app = app
      ctx.logs = logs
      await f.openProject(win, name)
      await win.click('.timecode').catch(() => undefined)
      await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
      await win.keyboard.press('Shift+R')
      await win.waitForSelector('[data-testid="review-panel"] [data-testid="review-row"]', { timeout: 20000 })
      h.assert((await progressOf(win)) === `0 of ${total} reviewed`, 'every row listed')
      const last = `cut:s${cuts - 1}`

      // A move from the keyboard ends with the row fully in view once the rows drawn are measured:
      // End, End again on the row that has the focus, K (on to the first row), Home, End then P,
      // and an arrow held from the end.
      const inView = async (what, key) => {
        const at = await settled(win)
        h.assert(at.inView && (!key || at.key === key), `${what}: ${JSON.stringify(at)}`)
        return at
      }
      await settled(win)
      if (!long) {
        await win.keyboard.press('End')
        await inView('End', last)
        const heights = await win.$$eval('[data-testid="review-row"]', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().height)))])
        h.assert(heights.length >= 2, `rows of different heights: ${heights}`)
        await win.keyboard.press('End')
        await inView('End again', last)
        // Scrolled away with the wheel, End on the row that has the focus brings it back.
        const box = await win.$eval('.review-list', (e) => {
          const r = e.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
        await win.mouse.move(box.x, box.y)
        await win.mouse.wheel(0, -3000)
        await h.sleep(200)
        h.assert(!(await settled(win)).inView, 'scrolled away from the last row')
        await win.keyboard.press('End')
        await inView('End once scrolled away', last)
        await win.keyboard.press('k')
        await inView('K (on to the first row to review)', 'zoom:z0')
        await win.keyboard.press('End')
        await inView('End after K', last)
        await win.keyboard.press('Home')
        await inView('Home', 'zoom:z0')
        await win.keyboard.press('End')
        for (let k = 0; k < 3; k++) await win.keyboard.press('p')
        await inView('End then P three times', `cut:s${cuts - 4}`)
        await win.keyboard.press('End')
        await win.keyboard.down('ArrowUp')
        for (let k = 0; k < 149; k++) await win.keyboard.down('ArrowUp')
        await win.keyboard.up('ArrowUp')
        await inView('ArrowUp held from the end', `cut:s${cuts - 151}`)
        await win.keyboard.press('ArrowUp')
        await inView('ArrowUp once more', `cut:s${cuts - 152}`)
        await win.keyboard.press('Control+z') // the Keep back: nothing reviewed
        await f.waitFor(async () => (await progressOf(win)) === `0 of ${total} reviewed`, 'the Keep undone', 5000)
      }

      // Remove all from the last row, whose next row to review is the first, not drawn: the focus
      // goes to it, in view, and N then moves in the list (it would switch Snapping in the editor).
      await win.keyboard.press('End')
      await settled(win)
      await watchBusy(win)
      await win.focus('[data-testid="review-remove-kind"]')
      h.assert((await win.textContent('[data-testid="review-remove-kind"]')) === 'Remove all word cuts', 'Remove all word cuts')
      await win.keyboard.press('Enter')
      await idle(win, 60000)
      await f.waitFor(async () => (await focusOn(win)) === 'zoom:z0', 'the focus on to the first row to review', 3000).catch(() => undefined)
      h.assert((await focusOn(win)) === 'zoom:z0', `the focus moved on to the first row to review: ${await focusOn(win)}`)
      h.assert((await settled(win)).inView, 'in view')
      h.assert((await progressOf(win)) === `${retakes} of ${total} reviewed`, `all word cuts removed: ${await progressOf(win)}`)
      h.assert(
        same(await win.evaluate(() => window.__said), [`Removing ${retakes} word cuts… Keep, Remove, Undo and Redo wait until it is done.`, `Removed ${retakes} word cuts.`]),
        `said what it does and what waits, then what it did: ${JSON.stringify(await win.evaluate(() => window.__said))}`
      )
      const snap = await win.getAttribute('[data-testid="snap-toggle"]', 'aria-pressed')
      await win.keyboard.press('n')
      await f.waitFor(async () => (await focusOn(win)) === 'zoom:z1', 'N moves on in the list', 3000)
      h.assert((await win.getAttribute('[data-testid="snap-toggle"]', 'aria-pressed')) === snap, 'Snapping untouched')
      await win.keyboard.press('Control+z')
      await f.waitFor(async () => (await progressOf(win)) === `0 of ${total} reviewed`, 'Remove all undone', 10000)

      // Keep the first zoom (the user's last step), then Remove all, and Ctrl+Z while it works: the
      // Ctrl+Z waits and undoes the Remove all once it is done; the Keep stays, and Ctrl+Y brings
      // the Remove all back.
      await win.keyboard.press('Home')
      await settled(win)
      await win.keyboard.press('k')
      await f.waitFor(async () => (await progressOf(win)) === `1 of ${total} reviewed`, 'z0 kept', 3000)
      await win.keyboard.press('End')
      await settled(win)
      await watchBusy(win)
      await win.focus('[data-testid="review-remove-kind"]')
      await win.keyboard.press('Enter')
      await win.keyboard.press('Control+z')
      const zAt = (await win.evaluate(() => window.__busyAt)).filter((k) => k.startsWith('z:'))
      await idle(win, 60000)
      h.assert(!long || same(zAt, ['z:true']), `Ctrl+Z pressed while Remove all worked: ${JSON.stringify(zAt)}`)
      if (same(zAt, ['z:true'])) {
        await f.waitFor(async () => (await progressOf(win)) === `1 of ${total} reviewed`, 'the Ctrl+Z undid the Remove all once done', 5000).catch(() => undefined)
        h.assert((await progressOf(win)) === `1 of ${total} reviewed`, `the Ctrl+Z that waited undid the Remove all, not the Keep: ${await progressOf(win)}`)
        h.assert((await win.getAttribute('[data-key="zoom:z0"]', 'data-status').catch(() => 'not drawn')) === 'kept', 'the Keep stays')
        await win.keyboard.press('Control+y')
        await f.waitFor(async () => (await progressOf(win)) === `${retakes + 1} of ${total} reviewed`, 'Ctrl+Y brings the Remove all back (redo kept)', 10000)
        await win.keyboard.press('Control+z')
        await f.waitFor(async () => (await progressOf(win)) === `1 of ${total} reviewed`, 'and Ctrl+Z takes it back again', 10000)
      } else console.log(`  (Remove all was done before Ctrl+Z reached the page: ${JSON.stringify(zAt)}; the wait not exercised on ${total} rows)`)

      // While Remove all works: N to the second zoom, K (waits; the focus moves on to the third
      // zoom), Delete (waits; on to the first silence), a click on that row's Keep (waits), and Keep
      // all (still working). Once done, each is done in order, its own undo step, said after it.
      if (long) {
        await win.keyboard.press('End')
        await settled(win)
        await watchBusy(win)
        await win.focus('[data-testid="review-remove-kind"]')
        const t0 = Date.now()
        await win.keyboard.press('Enter')
        await win.focus('[data-testid="review-row"] .review-item[tabindex="0"]')
        await win.keyboard.press('Home')
        await win.keyboard.press('n')
        await win.keyboard.press('k')
        await win.keyboard.press('Delete')
        await win.click('[data-key="cut:s0"] [data-testid="review-keep"]')
        await win.click('[data-testid="review-keep-all"]', { force: true }) // aria-disabled, which Playwright would wait out
        const meanwhile = await win.evaluate(() => ({
          busy: !!document.querySelector('[data-testid="review-panel"] [aria-busy="true"]'),
          rows: ['zoom:z1', 'zoom:z2', 'cut:s0'].map((k) => document.querySelector(`[data-key="${k}"]`)?.dataset.status)
        }))
        const pressed = Date.now() - t0
        await idle(win, 60000)
        console.log(`  pressed in ${pressed} ms; Remove all done ${Date.now() - t0} ms after Enter`)
        const keys = await win.evaluate(() => window.__busyAt)
        h.assert(meanwhile.busy && keys.every((k) => k.endsWith(':true') || k === 'Enter:false'), `all pressed while it worked: ${JSON.stringify(keys)} ${meanwhile.busy}`)
        h.assert(same(meanwhile.rows, ['pending', 'pending', 'pending']), `nothing done while it worked: ${meanwhile.rows}`)
        await f.waitFor(async () => (await progressOf(win)) === `${retakes + 4} of ${total} reviewed`, 'the Remove all, then the Keep, Delete and click that waited', 5000).catch(() => undefined)
        h.assert((await progressOf(win)) === `${retakes + 4} of ${total} reviewed`, `each done: ${await progressOf(win)}`)
        const status = (key) => win.getAttribute(`[data-key="${key}"]`, 'data-status')
        h.assert((await status('zoom:z1')) === 'kept' && (await status('zoom:z2')) === 'removed' && (await status('cut:s0')) === 'kept', 'z1 kept, z2 removed, s0 kept')
        h.assert((await focusOn(win)) === 'cut:s1', `the focus where the waiting moves left it: ${await focusOn(win)}`)
        const said = await win.evaluate(() => window.__said)
        h.assert(
          same(said, [
            `Removing ${retakes} word cuts… Keep, Remove, Undo and Redo wait until it is done.`,
            'Keep waits until Remove all is done.',
            'Remove waits until Remove all is done.',
            'Keep waits until Remove all is done.',
            `Still removing ${retakes} word cuts…`,
            `Removed ${retakes} word cuts. Kept. ${retakes + 2} of ${total} reviewed. Removed. ${retakes + 3} of ${total} reviewed. Kept. ${retakes + 4} of ${total} reviewed.`
          ]),
          `said: ${JSON.stringify(said)}`
        )
        // Each its own undo step, after the Remove all's.
        for (const [key, was] of [
          ['cut:s0', `${retakes + 3}`],
          ['zoom:z2', `${retakes + 2}`],
          ['zoom:z1', `${retakes + 1}`]
        ]) {
          await win.keyboard.press('Control+z')
          await f.waitFor(async () => (await progressOf(win)) === `${was} of ${total} reviewed`, `Ctrl+Z takes back ${key}`, 5000)
          h.assert((await status(key)) === 'pending', `${key} back to review`)
        }
        await win.keyboard.press('Control+z')
        await f.waitFor(async () => (await progressOf(win)) === `1 of ${total} reviewed`, 'then the Remove all', 5000)

        // Shift+Tab back to the last row's Remove while Remove all works: once done, that row is
        // removed and the focus moves on to the next row to review (the second zoom, not drawn),
        // not left on the removed row.
        await win.keyboard.press('End')
        await settled(win)
        await watchBusy(win)
        await win.focus('[data-testid="review-remove-kind"]')
        await win.keyboard.press('Enter')
        await win.keyboard.press('Shift+Tab')
        await win.keyboard.press('Shift+Tab')
        const backOn = await focused(win)
        await idle(win, 60000)
        const backKeys = await pressedAfter(win)
        h.assert(same(backKeys, ['Tab:true', 'Tab:true']) && backOn.startsWith('Remove: '), `Shift+Tab twice to the row's Remove while it worked: ${JSON.stringify(backKeys)} ${backOn}`)
        await f.waitFor(async () => (await focusOn(win)) === 'zoom:z1', 'the focus on to the next row to review', 3000).catch(() => undefined)
        h.assert((await focusOn(win)) === 'zoom:z1', `from the removed row's Remove, the focus moved on to the next row to review: ${await focusOn(win)}`)
        h.assert((await settled(win)).inView, 'in view')
        const snapped = await win.getAttribute('[data-testid="snap-toggle"]', 'aria-pressed')
        await win.keyboard.press('n')
        await f.waitFor(async () => (await focusOn(win)) === 'zoom:z2', 'N moves on in the list', 3000)
        h.assert((await win.getAttribute('[data-testid="snap-toggle"]', 'aria-pressed')) === snapped, 'Snapping untouched')
        await win.keyboard.press('Control+z')
        await f.waitFor(async () => (await progressOf(win)) === `1 of ${total} reviewed`, 'Remove all undone', 10000)
      }
      await win.keyboard.press('Escape')
      await f.waitFor(async () => !(await win.$('[data-testid="review-panel"]')), 'the panel closed')
      h.assert(!logs.some((l) => l.includes('[pageerror]')), `no page errors: ${logs.filter((l) => l.includes('pageerror'))}`)
    })
  }

  const mock = await startMockAi({ ffmpeg: FF })
  try {
    await test('review mode: Polish undone and run again with the panel open', async (ctx) => {
      const home = h.tempHome('review-polish')
      const id = seedWords(home)
      const { app, win, logs } = await h.launch({ home, env: mockAiEnv(mock.url) })
      ctx.app = app
      ctx.logs = logs
      await f.openProject(win, WORDS_NAME)
      await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      await win.keyboard.press('Shift+R')
      await win.waitForSelector('[data-testid="review-panel"]', { timeout: 5000 })

      await polishSilences(win)
      const first = await savedWhen(home, id, (p) => Array.isArray(p.autoCuts), 'the first Polish saved')
      const ids = first.autoCuts.map((c) => `cut:${c.id}`)
      h.assert(ids.length >= 1, `Polish cut the silences: ${JSON.stringify(first.autoCuts)}`)
      await f.waitFor(async () => same(await rows(win), ids.map((k) => `${k}=pending`)), 'the first run listed to review', 5000)

      // Ctrl+Z takes the run back: its rows read removed. From the first row's Keep button, which the
      // undo takes away, the focus goes back to that row (not to the page, which would take the
      // panel's keys with it).
      await win.focus('[data-testid="review-row"] [data-testid="review-keep"]')
      h.assert((await focused(win)).startsWith('Keep: Cut '), `on the first row's Keep: ${await focused(win)}`)
      await win.keyboard.press('Control+z')
      await savedWhen(home, id, (p) => !('autoCuts' in p), 'the run undone')
      await f.waitFor(async () => same(await rows(win), ids.map((k) => `${k}=removed`)), 'the undone rows read removed', 5000)
      await h.sleep(100)
      const back = await focused(win)
      h.assert(back.startsWith('Cut ') && back.endsWith(', removed'), `the focus back on the row: ${back}`)

      // The same Polish again: new rows to review beside the first run's, which still read removed.
      await polishSilences(win)
      const second = await savedWhen(home, id, (p) => Array.isArray(p.autoCuts) && !p.autoCuts.some((c) => ids.includes(`cut:${c.id}`)), 'the second Polish saved')
      const again = second.autoCuts.map((c) => `cut:${c.id}`)
      h.assert(same(second.autoCuts.map(({ id: _id, ...c }) => c), first.autoCuts.map(({ id: _id, ...c }) => c)), 'the same cuts made again')
      await f.waitFor(async () => (await rows(win)).length === ids.length + again.length, 'both runs listed', 5000)
      const now = await rows(win)
      for (const k of ids) h.assert(now.includes(`${k}=removed`), `${k} still reads removed: ${now}`)
      for (const k of again) h.assert(now.includes(`${k}=pending`), `${k} to review: ${now}`)
      const names = await win.$$eval('[data-testid="review-row"] .review-item', (els) => els.map((e) => e.getAttribute('aria-label')))
      h.assert(names.filter((n) => n.endsWith(', kept')).length === 0, `no row read out as kept: ${names}`)
      const progress = await win.textContent('[data-testid="review-progress"]')
      h.assert(progress === `${ids.length} of ${ids.length + again.length} reviewed`, `progress: ${progress}`)
      h.assert(!('autoCutOutcomes' in second), 'no choice saved')

      // Ctrl+Z with the focus on Keep all takes the second run back and disables the button under
      // the focus, which Chromium drops to the page only after the panel has looked: the focus goes
      // back to a row, so the panel's keys (Escape below) still work.
      await win.focus('[data-testid="review-keep-all"]')
      h.assert(await win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'review-keep-all'), 'on Keep all')
      await win.keyboard.press('Control+z')
      await f.waitFor(async () => (await rows(win)).every((r) => r.endsWith('=removed')), 'the second run undone', 5000)
      h.assert(await win.$eval('[data-testid="review-keep-all"]', (e) => e.disabled), 'Keep all disabled')
      await h.sleep(100)
      const row = await focused(win)
      h.assert(row.startsWith('Cut ') && row.endsWith(', removed'), `the focus back on a row from the disabled Keep all: ${row}`)

      // The same undo run from the palette: the palette gives the focus back to Keep all as it
      // closes, but the undo disabled it, so it goes to the focused item's row, not to the panel's
      // Close button (the first control of the panel, where N and Delete would reach the editor).
      await win.keyboard.press('Control+y')
      await f.waitFor(async () => {
        const r = await rows(win)
        return again.every((k) => r.includes(`${k}=pending`))
      }, 'the second run redone', 5000)
      await win.focus('[data-testid="review-keep-all"]')
      h.assert(await win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'review-keep-all'), 'on Keep all again')
      await win.keyboard.press('Control+k')
      await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
      await win.keyboard.type('undo')
      await f.waitFor(async () => (await win.$eval('.command-palette [role="option"] .palette-title', (e) => e.textContent).catch(() => '')) === 'Undo', '"Undo" listed first', 3000)
      await win.keyboard.press('Enter')
      await f.waitFor(async () => (await rows(win)).every((r) => r.endsWith('=removed')), 'the second run undone from the palette', 5000)
      h.assert(await win.$eval('[data-testid="review-keep-all"]', (e) => e.disabled), 'Keep all disabled again')
      await h.sleep(100)
      const fromPalette = await focused(win)
      h.assert(fromPalette.startsWith('Cut ') && fromPalette.endsWith(', removed'), `the focus on a row after Undo from the palette: ${fromPalette}`)
      // N stays in the list (it would switch Snapping off in the editor).
      await win.keyboard.press('n')
      await h.sleep(100)
      const moved = await focused(win)
      h.assert(moved.startsWith('Cut ') && moved.endsWith(', removed'), `N moves in the list: ${moved}`)
      await win.keyboard.press('Escape')
      await f.waitFor(async () => !(await win.$('[data-testid="review-panel"]')), 'Escape closes the panel', 3000)
      h.assert(!logs.some((l) => l.includes('[pageerror]')), `no page errors: ${logs.filter((l) => l.includes('pageerror'))}`)
    })
  } finally {
    await mock.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
