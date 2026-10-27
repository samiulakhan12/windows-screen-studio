// Snapping (E-05) end to end in the built app: a zoom moved by its middle snaps its end onto a
// cut, exactly, with a labelled guide while dragging and one undo step; Alt places it freely; N
// (and the magnet button's state) turns snapping off and on, remembered in localStorage;
// scrubbing the ruler catches a chapter flag; the trim handle snaps to a cut's end.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

/** Seeds a project, applies `patch` to its project.json, launches the app and opens it (as w3fix-timeline.e2e.cjs). */
async function openSeeded(ctx, tag, opts, patch = {}) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 2))
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  await f.openProject(win, opts.name)
  return { home, id, win }
}

const xForTime = (win, t) =>
  win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])

async function centerOf(win, selector) {
  return win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
}

/** The playhead's source time, as the timeline draws it. */
const playheadTime = (win) =>
  win.evaluate(() => {
    const m = /translateX\(([-\d.e]+)px\)/.exec(document.querySelector('.playhead').style.transform)
    return Number(m[1]) / Number(document.querySelector('.tl-content').dataset.pxPerSec)
  })

/** Presses at `from` and moves to `to` in steps, without releasing (the shared drag helper releases). */
async function dragHold(win, from, to, steps = 8) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  for (let i = 1; i <= steps; i++) await win.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
  await h.sleep(100)
}

async function release(win) {
  await win.mouse.up()
  await h.sleep(150)
}

const guide = (win) =>
  win.$eval('[data-testid="snap-guide"]', (el) => ({ hidden: el.hidden, kind: el.dataset.kind ?? null, t: el.dataset.t ?? null, text: el.textContent }))
const pressed = (win) => win.$eval('[data-testid="snap-toggle"]', (b) => b.getAttribute('aria-pressed'))
const zoomTimes = (win) => win.$eval('[data-zoom="z1"]', (el) => ({ start: Number(el.dataset.start), end: Number(el.dataset.end) }))

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

/** Moves zoom z1 by its middle `dx` px, holding; returns the press point. */
async function holdZoomMove(win, dx) {
  const c = await centerOf(win, '.zoom-seg[data-zoom="z1"]')
  await dragHold(win, c, { x: c.x + dx, y: c.y })
}

async function main() {
  await h.run('snapping: snaps to a cut exactly, Alt frees, N toggles, scrub and trim snap', async (ctx) => {
    const { home, id, win } = await openSeeded(
      ctx,
      'snap',
      {
        name: 'SnapTest',
        seconds: 12,
        clips: [
          { id: 'c0', start: 0, end: 4, speed: 1 },
          { id: 'c1', start: 6, end: 12, speed: 1 }
        ],
        zooms: [{ id: 'z1', start: 1, end: 2, scale: 2, focus: { mode: 'cursor' }, auto: false }]
      },
      { chapters: [{ id: 'h1', t: 9, title: 'Demo' }] }
    )
    const px = await win.$eval('.tl-content', (el) => Number(el.dataset.pxPerSec))
    h.assert(px > 20, `timeline scale ${px}`)
    h.assert((await pressed(win)) === 'true', 'snapping is on by default')
    h.assert((await guide(win)).hidden, 'no guide before a drag')

    // 1. The zoom's end catches the cut at 4 s, 4 px away, and is written exactly there.
    await holdZoomMove(win, 2 * px + 4)
    let g = await guide(win)
    h.assert(!g.hidden, 'the guide shows while the edge sits on the cut')
    h.assert(g.kind === 'clip' && g.t === '4', `guide on the cut (${JSON.stringify(g)})`)
    h.assert(g.text.startsWith('Cut · 0:04.0'), `guide label (${g.text})`)
    await release(win)
    h.assert((await guide(win)).hidden, 'the guide hides on release')
    const p1 = await saved(home, id, (p) => p.zooms[0].end === 4, 'the zoom saved snapped to the cut')
    h.assert(Math.abs(p1.zooms[0].start - 3) < 1e-9, `zoom keeps its length (${p1.zooms[0].start})`)

    // 2. One undo step.
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => {
      const z = await zoomTimes(win)
      return z.start === 1 && z.end === 2
    }, 'undo puts the zoom back')

    // 3. Alt places it freely.
    await win.keyboard.down('Alt')
    await holdZoomMove(win, 2 * px + 4)
    h.assert((await guide(win)).hidden, 'no guide while Alt is held')
    await release(win)
    await win.keyboard.up('Alt')
    let z = await zoomTimes(win)
    h.assert(z.end > 4 + 2 / px && z.start > 3 + 2 / px, `Alt: placed freely (${JSON.stringify(z)})`)
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await zoomTimes(win)).start === 1, 'undo after the Alt drag')

    // 4. N turns snapping off (remembered), and on again.
    await win.keyboard.press('n')
    await f.waitFor(async () => (await pressed(win)) === 'false', 'N turns snapping off')
    h.assert((await win.evaluate(() => localStorage.getItem('editor-snapping'))) === '0', 'off is remembered')
    await holdZoomMove(win, 2 * px + 4)
    h.assert((await guide(win)).hidden, 'no guide with snapping off')
    await release(win)
    z = await zoomTimes(win)
    h.assert(z.end > 4 + 2 / px, `snapping off: placed freely (${JSON.stringify(z)})`)
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await zoomTimes(win)).start === 1, 'undo after the free drag')
    await win.keyboard.press('n')
    await f.waitFor(async () => (await pressed(win)) === 'true', 'N turns snapping on again')

    // 5. Scrubbing the ruler catches the chapter flag; the press itself goes where it is.
    const ruler = await centerOf(win, '.tl-ruler')
    await dragHold(win, { x: await xForTime(win, 8.5), y: ruler.y }, { x: (await xForTime(win, 9)) + 5, y: ruler.y })
    const t = await playheadTime(win)
    h.assert(Math.abs(t - 9) < 1e-6, `the playhead snaps to the chapter (${t})`)
    g = await guide(win)
    h.assert(!g.hidden && g.kind === 'chapter' && g.text === 'Chapter · Demo · 0:09.0', `guide on the chapter (${JSON.stringify(g)})`)
    await release(win)
    h.assert((await guide(win)).hidden, 'the guide hides after the scrub')

    // 6. The trim handle, dropped 5 px before the cut's end, starts the edit there exactly.
    const handle = await centerOf(win, '.trim-handle.start')
    const dx = (await xForTime(win, 6)) - (await xForTime(win, 0)) - 5
    await dragHold(win, handle, { x: handle.x + dx, y: handle.y })
    await release(win)
    const p2 = await saved(home, id, (p) => p.clips.length === 1, 'the trim saved')
    h.assert(p2.clips[0].start === 6 && p2.clips[0].end === 12, `trimmed to the cut's end (${JSON.stringify(p2.clips)})`)

    const errors = ctx.logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[console.error]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })
}

main()
