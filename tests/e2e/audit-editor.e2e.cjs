// Editor audit fixes, end to end on seeded projects: the Export dialog keeps keyboard focus inside
// it, also while an export runs (E1); text and zooms added with the playhead in a cut go on the
// next kept frame (E2); "Range speed" on a range that changes nothing keeps the selection and adds
// no undo step (E5).
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)
// Clips [0,5] and [12,20]: a 7 s cut in the middle.
const CUT_CLIPS = [
  { id: 'c0', start: 0, end: 5, speed: 1 },
  { id: 'c1', start: 12, end: 20, speed: 1 }
]

async function setup(ctx, tag, opts) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  await f.openProject(win, opts.name)
  return { home, id, app, win }
}

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

const centerY = (win, selector) => win.$eval(selector, (el) => el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2)

/** Clicks the ruler at source time `t` (moves the playhead; inside a cut it stays there). */
async function seekTo(win, t) {
  await win.mouse.click(await xForTime(win, t), await centerY(win, '.tl-ruler'))
  await h.sleep(150)
}

const segTimes = (win, selector) => win.$$eval(selector, (els) => els.map((e) => ({ start: Number(e.dataset.start), end: Number(e.dataset.end) })))
const focusInDialog = (win) => win.evaluate(() => !!document.activeElement?.closest('.export-modal'))
const focusName = (win) =>
  win.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName.toLowerCase()}.${el.className} ${el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || ''}` : 'none'
  })

/** Tabs `n` times each way; focus must never leave the Export dialog. */
async function tabAround(win, n, where) {
  for (const key of ['Shift+Tab', 'Tab']) {
    for (let i = 0; i < n; i++) {
      await win.keyboard.press(key)
      h.assert(await focusInDialog(win), `${where}: ${key} #${i + 1} keeps focus in the dialog (focus: ${await focusName(win)})`)
    }
  }
}

async function main() {
  await h.run('audit E2: text and zooms added at a playhead in a cut go on the next kept frame', async (ctx) => {
    const { win } = await setup(ctx, 'audit-e2', { name: 'CutAddTest', seconds: 20, clips: CUT_CLIPS })
    await seekTo(win, 7)
    await win.keyboard.press('t')
    await f.waitFor(async () => (await segTimes(win, '.text-seg')).length === 1, 'text added')
    const [text] = await segTimes(win, '.text-seg')
    h.assert(text.start >= 12 - 1e-6 && text.start < 12.1, `text starts on the first kept frame after the cut: ${JSON.stringify(text)}`)

    await seekTo(win, 7)
    await win.keyboard.press('z')
    await f.waitFor(async () => (await segTimes(win, '.zoom-seg')).length === 1, 'zoom added')
    const [zoom] = await segTimes(win, '.zoom-seg')
    h.assert(zoom.end > 13 && zoom.start >= 11, `zoom covers the first kept frame after the cut: ${JSON.stringify(zoom)}`)
  })

  await h.run('audit E5: range speed on a range inside a cut keeps the selection and adds no undo step', async (ctx) => {
    const { win } = await setup(ctx, 'audit-e5', { name: 'RangeSpeedTest', seconds: 20, clips: CUT_CLIPS })
    h.assert(await win.$eval('button[aria-label="Undo"]', (b) => b.disabled), 'nothing to undo at first')
    const y = await centerY(win, '.clip-track')
    await win.keyboard.down('Shift')
    await win.mouse.move(await xForTime(win, 5.4), y)
    await win.mouse.down()
    for (let i = 1; i <= 6; i++) await win.mouse.move(await xForTime(win, 5.4 + i * 0.25), y)
    await win.mouse.up()
    await win.keyboard.up('Shift')
    await win.waitForSelector('[data-testid="range-selection"]')
    await win.click('.chips[aria-label="Range speed"] .chip:has-text("2×")')
    await win.waitForSelector('.notice:has-text("Nothing to change")', { timeout: 5000 })
    h.assert(await win.$('[data-testid="range-selection"]'), 'the range stays selected')
    h.assert(await win.$eval('button[aria-label="Undo"]', (b) => b.disabled), 'no undo step was added')
  })

  await h.run('audit E1: the Export dialog keeps keyboard focus inside it, also while exporting', async (ctx) => {
    const { home, app, win } = await setup(ctx, 'audit-e1', { name: 'ExportFocusTest', seconds: 20 })
    await win.click('button:has-text("Export")')
    await win.waitForSelector('.export-modal')
    await f.waitFor(() => focusInDialog(win), 'the dialog takes focus')
    await tabAround(win, 4, 'settings')

    await h.mockSaveDialog(app, require('node:path').join(home, 'focus.mp4'))
    await win.click('.modal button:has-text("Export MP4")')
    await win.waitForSelector('.modal button:has-text("Cancel export")', { timeout: 30000 })
    await tabAround(win, 4, 'exporting')
    h.assert(await win.$('.editor'), 'still in the editor')
    h.assert(await win.$('.modal button:has-text("Cancel export")'), 'the export is still running')
    await win.click('.modal button:has-text("Cancel export")')
    await f.waitFor(async () => !(await win.$('.modal button:has-text("Cancel export")')), 'export cancelled', 30000)
  })
}

main()
