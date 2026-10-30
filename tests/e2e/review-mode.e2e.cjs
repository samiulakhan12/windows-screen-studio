// Review mode end to end (docs/design/review-mode.md §9): a 20 s recording with a camera, an auto
// zoom at 2 s, a camera director segment at 5 s and a silence cut Remove silences made at 8-10.4 s
// (with its record), and a zoom of yours. The Review button counts 3; Shift+R opens the panel with
// the focus on the first item; N and P move (the playhead jumps); K keeps the zoom (saved with
// auto false); Delete removes the silence cut (the footage comes back, the record goes); Ctrl+Z
// brings the cut back and its row back to "not reviewed"; Keep all reviews the rest; Escape closes
// and gives the focus back to the button; the palette opens it again, now empty.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

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

const rows = (win) => win.$$eval('[data-testid="review-row"]', (els) => els.map((e) => `${e.dataset.key}=${e.dataset.status}`))
const focused = (win) => win.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '')
const timecode = (win) => win.$eval('.timecode', (e) => e.textContent ?? '')

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
    h.assert(first === 'Zoom in on a click, top right, zoom, at 0:02.0, not reviewed', `the focus starts on the first item: ${first}`)

    // N moves to the camera change and plays around it: the playhead goes to 1.5 s before it.
    await win.keyboard.press('n')
    h.assert((await focused(win)).startsWith('Camera to the top left corner, camera, at 0:05.0'), `N moves: ${await focused(win)}`)
    await f.waitFor(async () => /^0:0[3-6]/.test(await timecode(win)), 'the playhead at the camera change', 5000)
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
    h.assert(restored.zooms.some((z) => z.id === 'mine'), 'your zoom is untouched')

    // Ctrl+Z (one undo step) brings the cut and its row back.
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await rows(win)).includes('cut:s1=pending'), 'the cut pending again')
    const back = await savedWhen(home, id, (p) => p.clips.length === 2 && Array.isArray(p.autoCuts), 'the cut back')
    h.assert(back.zooms.find((z) => z.id === 'z1')?.auto === false, 'the keep before it stays')
    h.assert((await win.textContent('[data-testid="review-progress"]')) === '1 of 3 reviewed', 'progress follows the undo')

    // Keep all reviews the rest in one go.
    await win.click('[data-testid="review-keep-all"]')
    await f.waitFor(async () => (await win.textContent('[data-testid="review-progress"]')) === '3 of 3 reviewed', 'all reviewed')
    h.assert((await win.textContent('[data-testid="review-said"]')) === 'Kept 2 changes.', 'keep all is announced')
    const kept = await savedWhen(home, id, (p) => !('autoCuts' in p) && p.layouts.every((s) => !s.auto), 'everything kept')
    h.assert(kept.clips.length === 2, 'the cut stays, as a plain cut')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'review-mode-reviewed.png') })

    // Escape closes and gives the focus back to the button, which has nothing left to count.
    await win.focus('[data-testid="review-row"] .review-item >> nth=0')
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
    h.assert(!logs.some((l) => l.includes('[pageerror]')), `no page errors: ${logs.filter((l) => l.includes('pageerror'))}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
