// Select several items and edit them together (E-06, docs/design/multi-select.md §10.2), in the
// built app: Ctrl+click and Shift+click on the timeline, the box, Ctrl+A, the Selection view with
// Mixed values, group drags (limits, freeze frames, snapping), delete, cut, copy, paste,
// duplicate, copy look / paste look, the preview, a crop, the keyboard-only path and refusals.
// Every group action is one undo step.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

/** Seeds a project, applies `patch` to its project.json, launches the app and opens it (as snapping.e2e.cjs). */
async function openSeeded(ctx, tag, opts, patch = {}, { snapping = false } = {}) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 2))
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  // Snapping is off unless a scenario is about it (snapping.md §10).
  await win.evaluate((on) => localStorage.setItem('editor-snapping', on ? '1' : '0'), snapping)
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

const rectOf = (win, selector) =>
  win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  })

/** The playhead's source time, as the timeline draws it. */
const playheadTime = (win) =>
  win.evaluate(() => {
    const m = /translateX\(([-\d.e]+)px\)/.exec(document.querySelector('.playhead').style.transform)
    return Number(m[1]) / Number(document.querySelector('.tl-content').dataset.pxPerSec)
  })

/** Presses at `from` and moves to `to` in steps, without releasing. */
async function dragHold(win, from, to, steps = 10) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  for (let i = 1; i <= steps; i++) await win.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
  await h.sleep(120)
}

async function release(win) {
  await win.mouse.up()
  await h.sleep(200)
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

/** The keys of the timeline blocks shown as members of the group. */
const members = (win) =>
  win.$$eval('.in-group', (els) =>
    els
      .map((el) => {
        const d = el.dataset
        for (const k of ['zoom', 'annotation', 'shape', 'spotlight', 'title', 'chapter', 'freeze']) if (d[k]) return `${k}:${d[k]}`
        return '?'
      })
      .filter((k, i, all) => all.indexOf(k) === i)
      .sort()
  )
const count = (win) => win.$eval('.tl-selcount', (e) => e.textContent).catch(() => null)
const notice = (win) => win.$eval('.notice', (e) => e.textContent).catch(() => '')
const waitNotice = (win, text, what) => f.waitFor(async () => (await notice(win)).includes(text), `${what} (notice "${text}")`)
const waitCount = (win, n, what) => f.waitFor(async () => (n === null ? (await count(win)) === null : (await count(win)) === `${n} selected`), what)

const ctrlClick = (win, selector) => win.click(selector, { modifiers: ['Control'] })

/** A click at a point with a modifier held (mouse.click has no modifiers option). */
async function modClick(win, x, y, key) {
  await win.keyboard.down(key)
  await win.mouse.click(x, y)
  await win.keyboard.up(key)
}

/** The seed of §10.2: 20 s with a cut at 8-10, and an item of every groupable kind. */
const SEED = {
  name: 'MultiTest',
  seconds: 20,
  clips: [
    { id: 'c0', start: 0, end: 8, speed: 1 },
    { id: 'c1', start: 10, end: 20, speed: 1 }
  ],
  zooms: [
    { id: 'z1', start: 1, end: 2, scale: 2, focus: { mode: 'cursor' }, auto: false },
    { id: 'z2', start: 4, end: 5, scale: 2, focus: { mode: 'cursor' }, auto: true },
    { id: 'z3', start: 12, end: 14, scale: 2, focus: { mode: 'cursor' }, auto: false }
  ],
  annotations: [
    { id: 'a1', start: 1, end: 3, text: 'First', x: 0.5, y: 0.3, size: 0.05, style: 'pill' },
    { id: 'a2', start: 6, end: 7.5, text: 'Second', x: 0.5, y: 0.5, size: 0.08, style: 'pill' }
  ]
}
const shape = (id, kind, x, y, w, h) => ({ id, kind, start: 2, end: 4, x, y, w, h, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 })
const PATCH = {
  shapes: [shape('s1', 'rect', 0.05, 0.6, 0.2, 0.2), shape('s2', 'arrow', 0.7, 0.1, 0.1, 0.1), shape('s3', 'blur', 0.7, 0.6, 0.2, 0.2)],
  titles: [{ id: 't1', start: 15, end: 17, title: 'Card', style: 'centered', background: 'blur' }],
  chapters: [{ id: 'h1', t: 6, title: 'Middle' }],
  freezes: [{ id: 'f1', at: 5, length: 2, sound: 'pause' }]
}
const ALL = ['annotation:a1', 'annotation:a2', 'chapter:h1', 'freeze:f1', 'shape:s1', 'shape:s2', 'shape:s3', 'title:t1', 'zoom:z1', 'zoom:z2', 'zoom:z3']

const anno = (p, id) => p.annotations.find((a) => a.id === id)
const zoomOf = (p, id) => p.zooms.find((z) => z.id === id)

async function main() {
  await h.run('multi-select: Ctrl+click, Shift+click, the Selection view, group drags, limits, freeze frames, refusals', async (ctx) => {
    const { home, id, win } = await openSeeded(ctx, 'ms-click', SEED, PATCH)
    const px = await win.$eval('.tl-content', (el) => Number(el.dataset.pxPerSec))
    h.assert(px > 20, `timeline scale ${px}`)

    // 1. Ctrl+click: z1, then Ctrl+click z2 and a1.
    await win.click('[data-zoom="z1"]')
    await ctrlClick(win, '[data-zoom="z2"]')
    await ctrlClick(win, '[data-annotation="a1"]')
    await waitCount(win, 3, '3 selected')
    h.assert(JSON.stringify(await members(win)) === JSON.stringify(['annotation:a1', 'zoom:z1', 'zoom:z2']), `members ${await members(win)}`)
    await win.waitForSelector('[data-testid="selection-panel"] h3:has-text("3 items selected")')
    await win.waitForSelector('[data-testid="selection-panel"] h3:has-text("Zooms (2)")')
    await win.waitForSelector('[data-testid="selection-panel"] h3:has-text("Text (1)")')
    h.assert((await win.$$('.in-group.anchor')).length === 1, 'one anchor')
    await ctrlClick(win, '[data-annotation="a1"]')
    await waitCount(win, 2, 'Ctrl+click again leaves a1 out')
    await win.keyboard.press('Escape')
    await waitCount(win, null, 'Esc clears the chip')
    h.assert((await members(win)).length === 0, 'Esc clears the group')

    // 2. Shift+click: a run on one track, by start (the three shapes sit in three lanes).
    await win.click('[data-shape="s1"]')
    await win.click('[data-shape="s3"]', { modifiers: ['Shift'] })
    await waitCount(win, 3, 'Shift+click selects the run')
    h.assert(JSON.stringify(await members(win)) === JSON.stringify(['shape:s1', 'shape:s2', 'shape:s3']), `run ${await members(win)}`)
    await win.keyboard.press('Escape')

    // 15. Refusal: with 3 items selected, Ctrl+click a clip keeps them; without a group it selects the clip.
    await win.click('[data-zoom="z1"]')
    await ctrlClick(win, '[data-zoom="z3"]')
    await ctrlClick(win, '[data-title="t1"]')
    await waitCount(win, 3, 'three for the refusal')
    const clip = await rectOf(win, '[data-clip="c1"]')
    await modClick(win, clip.x + clip.w * 0.6, clip.y + clip.h - 4, 'Control')
    await waitNotice(win, 'Clips and cuts are selected one at a time', 'refused clip')
    await waitCount(win, 3, 'the group stays')
    await win.keyboard.press('Escape')
    await modClick(win, clip.x + clip.w * 0.6, clip.y + clip.h - 4, 'Control')
    await win.waitForSelector('.clip-block.selected[data-clip="c1"]')

    // 3. Group drag: z1, a1 and h1 moved by +1 s of pixels; one undo step; the playhead stays.
    await win.click('[data-zoom="z1"]')
    await ctrlClick(win, '[data-annotation="a1"]')
    await ctrlClick(win, '[data-chapter="h1"]')
    await waitCount(win, 3, 'z1, a1, h1')
    const playheadBefore = await playheadTime(win)
    const z1 = await centerOf(win, '[data-zoom="z1"]')
    await dragHold(win, z1, { x: z1.x + px, y: z1.y })
    await release(win)
    const p3 = await saved(home, id, (p) => zoomOf(p, 'z1').start !== 1, 'the group moved')
    const d = zoomOf(p3, 'z1').start - 1
    h.assert(Math.abs(d - 1) < 0.05, `moved about 1 s (${d})`)
    h.assert(Math.abs(anno(p3, 'a1').start - 1 - d) < 1e-9 && Math.abs(p3.chapters[0].t - 6 - d) < 1e-9, `same delta (${JSON.stringify([anno(p3, 'a1'), p3.chapters[0]])})`)
    h.assert(zoomOf(p3, 'z1').auto === false, 'z1 is yours')
    h.assert(Math.abs((await playheadTime(win)) - playheadBefore) < 1e-9, 'the playhead did not move')
    h.assert((await count(win)) === '3 selected', 'the group stays after a drag')
    await win.keyboard.press('Control+z')
    const back = await saved(home, id, (p) => zoomOf(p, 'z1').start === 1, 'one undo restores all three')
    h.assert(anno(back, 'a1').start === 1 && back.chapters[0].t === 6, 'all three back')
    await win.keyboard.press('Control+y')
    await saved(home, id, (p) => Math.abs(zoomOf(p, 'z1').start - 1 - d) < 1e-9 && Math.abs(p.chapters[0].t - 6 - d) < 1e-9, 'redo moves all three again')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => zoomOf(p, 'z1').start === 1, 'undo again')
    await win.keyboard.press('Escape')

    // 4. Block limit: z1 and z2 dragged far later stop at z3, exactly.
    await win.click('[data-zoom="z1"]')
    await ctrlClick(win, '[data-zoom="z2"]')
    await waitCount(win, 2, 'z1 and z2')
    const z1b = await centerOf(win, '[data-zoom="z1"]')
    await dragHold(win, z1b, { x: z1b.x + 10 * px, y: z1b.y }, 20)
    await waitNotice(win, 'stops here', 'the limit notice')
    await release(win)
    const p4 = await saved(home, id, (p) => zoomOf(p, 'z2').end === 12, 'z2 ends exactly where z3 starts')
    h.assert(zoomOf(p4, 'z2').start - zoomOf(p4, 'z1').start === 3, `spacing kept (${zoomOf(p4, 'z1').start}, ${zoomOf(p4, 'z2').start})`)
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => zoomOf(p, 'z2').end === 5, 'undo the limited drag')
    await win.keyboard.press('Escape')

    // 5. A freeze frame in a group stays in its clip (0-8).
    await win.click('[data-freeze="f1"]')
    await ctrlClick(win, '[data-annotation="a2"]')
    await waitCount(win, 2, 'f1 and a2')
    const a2 = await centerOf(win, '[data-annotation="a2"]')
    await dragHold(win, a2, { x: a2.x + 6 * px, y: a2.y }, 20)
    await waitNotice(win, 'a freeze frame stays in its clip', 'the freeze notice')
    await release(win)
    const p5 = await saved(home, id, (p) => p.freezes[0].at !== 5, 'the freeze moved')
    const fat = p5.freezes[0].at
    h.assert(fat <= 7.999 && fat > 7.9, `the freeze stays in its clip (${fat})`)
    h.assert(Math.abs(anno(p5, 'a2').start - 6 - (fat - 5)) < 1 / 60, `a2 moved by the same delta within a frame (${anno(p5, 'a2').start})`)
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => p.freezes[0].at === 5 && anno(p, 'a2').start === 6, 'undo the freeze move')
    await win.keyboard.press('Escape')

    // 16. Ctrl+A selects no page text.
    await win.click('[data-zoom="z1"]')
    await win.keyboard.press('Control+a')
    await waitCount(win, 3, 'Ctrl+A selects the track')
    h.assert((await win.evaluate(() => window.getSelection().toString())) === '', 'no page text selected')
    await win.keyboard.press('Escape')

    // 17. No errors.
    const errors = ctx.logs.filter((l) => l.includes('[pageerror]') || l.includes('[console.error]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })

  await h.run('multi-select: the box, Ctrl+A, delete, cut, copy, paste, duplicate', async (ctx) => {
    const { home, id, win } = await openSeeded(ctx, 'ms-box', SEED, PATCH)
    const px = await win.$eval('.tl-content', (el) => Number(el.dataset.pxPerSec))

    // 6. Shift+drag from empty zoom-track space at 0.5 s to the bottom of the shape track at 4.5 s.
    const zoomTrack = await rectOf(win, '.zoom-track')
    const shapeTrack = await rectOf(win, '.shape-track')
    const from = { x: await xForTime(win, 0.5), y: zoomTrack.y + zoomTrack.h / 2 }
    const to = { x: await xForTime(win, 4.5), y: shapeTrack.y + shapeTrack.h - 2 }
    await win.keyboard.down('Shift')
    await dragHold(win, from, to)
    h.assert(!(await win.$eval('[data-testid="timeline-marquee"]', (e) => e.hidden)), 'the box shows while drawing')
    await release(win)
    await win.keyboard.up('Shift')
    h.assert(await win.$eval('[data-testid="timeline-marquee"]', (e) => e.hidden), 'the box hides on release')
    await waitCount(win, 6, 'the box selects six items')
    h.assert(
      JSON.stringify(await members(win)) === JSON.stringify(['annotation:a1', 'shape:s1', 'shape:s2', 'shape:s3', 'zoom:z1', 'zoom:z2']),
      `box members ${await members(win)}`
    )
    h.assert((await win.$$('.clip-block.selected, .click-marker.selected')).length === 0, 'no clip or click in the box')
    // Ctrl+drag a second box over t1 adds it.
    const titleLane = await rectOf(win, '.title-lane')
    await win.keyboard.down('Control')
    await dragHold(win, { x: await xForTime(win, 14.5), y: titleLane.y + titleLane.h / 2 }, { x: await xForTime(win, 15.5), y: titleLane.y + titleLane.h / 2 + 2 })
    await release(win)
    await win.keyboard.up('Control')
    await waitCount(win, 7, 'Ctrl+box adds t1')
    // A Shift+click without moving on empty space keeps the selection and the playhead.
    const ph = await playheadTime(win)
    await modClick(win, await xForTime(win, 9), zoomTrack.y + zoomTrack.h / 2, 'Shift')
    await h.sleep(200)
    h.assert((await count(win)) === '7 selected' && Math.abs((await playheadTime(win)) - ph) < 1e-9, 'a Shift+click on empty space changes nothing')
    // Esc during a box puts the selection back.
    await win.keyboard.down('Shift')
    await dragHold(win, { x: await xForTime(win, 11.5), y: zoomTrack.y + zoomTrack.h / 2 }, { x: await xForTime(win, 13), y: zoomTrack.y + zoomTrack.h / 2 })
    h.assert(JSON.stringify(await members(win)) === JSON.stringify([]) || (await count(win)) === null, 'the box replaced the selection with z3 alone')
    await win.keyboard.press('Escape')
    await release(win)
    await win.keyboard.up('Shift')
    await waitCount(win, 7, 'Esc during the box restores the seven')
    await win.keyboard.press('Escape')

    // 7. Ctrl+A on the track, again for every item; Delete; one undo.
    await win.click('[data-zoom="z1"]')
    await win.keyboard.press('Control+a')
    await waitCount(win, 3, 'Ctrl+A: the zoom track')
    await waitNotice(win, 'again selects every item', 'the Ctrl+A notice')
    await win.keyboard.press('Control+a')
    await waitCount(win, 11, 'Ctrl+A again: every item')
    h.assert(JSON.stringify(await members(win)) === JSON.stringify(ALL), `every item ${await members(win)}`)
    await win.keyboard.press('Escape')
    await win.click('[data-zoom="z1"]')
    await win.keyboard.press('Control+a')
    await waitCount(win, 3, 'the zooms again')
    await win.keyboard.press('Delete')
    await saved(home, id, (p) => p.zooms.length === 0, 'Delete removes the three zooms')
    await waitNotice(win, 'Deleted 3 items', 'the delete notice')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => p.zooms.length === 3, 'one undo brings them back')

    // 8. Copy and paste at the playhead.
    await win.click('[data-annotation="a1"]')
    await ctrlClick(win, '[data-shape="s1"]')
    await waitCount(win, 2, 'a1 and s1')
    await win.keyboard.press('Control+c')
    await waitNotice(win, 'Copied 2 items', 'copied')
    const ruler = await rectOf(win, '.tl-ruler')
    await win.mouse.click(await xForTime(win, 15), ruler.y + ruler.h / 2)
    const at = await playheadTime(win)
    h.assert(Math.abs(at - 15) < 0.05, `the playhead near 15 s (${at})`)
    await win.keyboard.press('Control+v')
    const p8 = await saved(home, id, (p) => p.annotations.length === 3 && p.shapes.length === 4, 'two items pasted')
    const na = p8.annotations.find((a) => !['a1', 'a2'].includes(a.id))
    const ns = p8.shapes.find((s) => !['s1', 's2', 's3'].includes(s.id))
    h.assert(Math.abs(na.start - at) < 1e-6 && Math.abs(ns.start - (at + 1)) < 1e-6, `pasted at the playhead with the spacing kept (${na.start}, ${ns.start})`)
    await waitCount(win, 2, 'the pasted items are the selection')
    h.assert(JSON.stringify(await members(win)) === JSON.stringify([`annotation:${na.id}`, `shape:${ns.id}`].sort()), 'the new items are selected')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => p.annotations.length === 2 && p.shapes.length === 3, 'one undo removes both')
    await win.keyboard.press('Escape')

    // Duplicate z1: right after itself.
    await win.click('[data-zoom="z1"]')
    await win.keyboard.press('Control+d')
    const pd = await saved(home, id, (p) => p.zooms.length === 4, 'Ctrl+D duplicates z1')
    h.assert(pd.zooms.some((z) => z.start === 2 && z.end === 3 && !z.auto), `a zoom at 2-3 (${JSON.stringify(pd.zooms)})`)
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => p.zooms.length === 3, 'undo the duplicate')

    // Copy z1 and z2, paste at 12.5: z1's copy would start inside z3.
    await win.click('[data-zoom="z1"]')
    await ctrlClick(win, '[data-zoom="z2"]')
    await win.keyboard.press('Control+c')
    await win.mouse.click(await xForTime(win, 12.5), ruler.y + ruler.h / 2)
    await win.keyboard.press('Control+v')
    await waitNotice(win, 'zoom is already there', 'a pasted zoom in the way of another')
    await saved(home, id, (p) => p.zooms.length === 4, 'one of the two zooms pasted')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => p.zooms.length === 3, 'undo that paste')
    await win.keyboard.press('Escape')

    // Cut a2, paste it at 0.
    await win.click('[data-annotation="a2"]')
    await win.keyboard.press('Control+x')
    await saved(home, id, (p) => !anno(p, 'a2') && p.annotations.length === 1, 'Ctrl+X removes a2')
    await win.keyboard.press('Home')
    await win.keyboard.press('Control+v')
    const pc = await saved(home, id, (p) => p.annotations.length === 2, 'Ctrl+V brings a2 back')
    const back = pc.annotations.find((a) => a.id !== 'a1')
    h.assert(back.start === 0 && back.end === 1.5 && back.text === 'Second', `at 0 (${JSON.stringify(back)})`)

    // Ctrl+V in a text field is the field's own paste, not items.
    await win.click('input[aria-label="Recording name"]')
    await win.keyboard.press('Control+v')
    await h.sleep(400)
    h.assert(h.readProject(home, id).annotations.length === 2, 'no items pasted into a text field')
    await win.keyboard.press('Escape')

    const errors = ctx.logs.filter((l) => l.includes('[pageerror]') || l.includes('[console.error]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })

  await h.run('multi-select: snapping, Mixed values, looks, the preview', async (ctx) => {
    const { home, id, win } = await openSeeded(ctx, 'ms-edit', SEED, PATCH, { snapping: true })
    const px = await win.$eval('.tl-content', (el) => Number(el.dataset.pxPerSec))

    // 9. Snapping: a1 and s2 dragged so a1's end comes 3 px past the cut at 8.
    await win.click('[data-annotation="a1"]')
    await ctrlClick(win, '[data-shape="s2"]')
    await waitCount(win, 2, 'a1 and s2')
    const a1 = await centerOf(win, '[data-annotation="a1"]')
    await dragHold(win, a1, { x: a1.x + 5 * px + 3, y: a1.y })
    const g = await win.$eval('[data-testid="snap-guide"]', (el) => ({ hidden: el.hidden, kind: el.dataset.kind ?? null, t: el.dataset.t ?? null }))
    h.assert(!g.hidden && g.kind === 'clip', `the guide shows on the cut (${JSON.stringify(g)})`)
    await release(win)
    const p9 = await saved(home, id, (p) => anno(p, 'a1').start !== 1, 'the snapped group drag saved')
    h.assert(anno(p9, 'a1').end === 8 || anno(p9, 'a1').end === 10, `a1 ends exactly on the cut (${anno(p9, 'a1').end})`)
    const s2 = p9.shapes.find((s) => s.id === 's2')
    h.assert(Math.abs(s2.start - 2 - (anno(p9, 'a1').start - 1)) < 1e-9, 's2 moved by the same delta')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => anno(p, 'a1').start === 1, 'undo the snapped drag')
    await win.keyboard.press('Escape')
    await win.evaluate(() => localStorage.setItem('editor-snapping', '0'))

    // 10. Mixed sizes; arrow keys on the group slider set both; one undo.
    await win.click('[data-annotation="a1"]')
    await ctrlClick(win, '[data-annotation="a2"]')
    await win.waitForSelector('[data-testid="selection-panel"]')
    const readout = () => win.$eval('[data-testid="selection-panel"] label.slider:has(input[aria-label="Size"]) [data-testid="mixed-readout"]', (e) => e.textContent)
    h.assert((await readout()) === 'Mixed', `Size reads Mixed (${await readout()})`)
    h.assert((await win.$eval('[data-testid="selection-panel"] input[aria-label="Size"]', (e) => e.getAttribute('aria-valuetext'))) === 'Mixed', 'aria-valuetext Mixed')
    await win.focus('[data-testid="selection-panel"] input[aria-label="Size"]')
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight')
    const p10 = await saved(home, id, (p) => anno(p, 'a1').size === anno(p, 'a2').size, 'both sizes equal')
    h.assert(Math.abs(anno(p10, 'a1').size - 0.056) < 1e-9, `the first item's size plus three steps (${anno(p10, 'a1').size})`)
    h.assert((await readout()) !== 'Mixed', 'no longer Mixed')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => anno(p, 'a1').size === 0.05 && anno(p, 'a2').size === 0.08, 'one undo restores both sizes')
    await win.keyboard.press('Escape')

    // 11. Copy look / paste look.
    await win.click('[data-shape="s1"]')
    await win.click('button[aria-label="Colour #0a84ff"]')
    await saved(home, id, (p) => p.shapes[0].color === '#0a84ff', 's1 is blue')
    await win.keyboard.press('Control+Shift+C')
    await waitNotice(win, 'Copied the box look', 'look copied')
    await win.click('[data-shape="s2"]')
    await ctrlClick(win, '[data-shape="s3"]')
    await waitCount(win, 2, 's2 and s3')
    await win.keyboard.press('Control+Shift+V')
    const p11 = await saved(home, id, (p) => p.shapes[1].color === '#0a84ff', 's2 has the look')
    h.assert(p11.shapes[2].color === PATCH.shapes[2].color, 's3 (blur) is left as it was')
    await waitNotice(win, '1 item is not', 'the other item is named')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => p.shapes[1].color === '#ff3b30', 'one undo')
    await win.keyboard.press('Escape')
    await win.click('[data-title="t1"]')
    await win.waitForSelector('[data-testid="paste-look"]')
    const paste = await win.$eval('[data-testid="paste-look"]', (b) => ({ disabled: b.disabled, title: b.title }))
    h.assert(paste.disabled && paste.title === 'The copied look is for shapes', `Paste look on a title card (${JSON.stringify(paste)})`)
    await win.keyboard.press('Escape')

    // 12. The preview, paused at 2.5 s: Ctrl+click s1 and a1, outlines, a miss does nothing, a plain click edits one.
    const ruler = await rectOf(win, '.tl-ruler')
    await win.mouse.click(await xForTime(win, 2.5), ruler.y + ruler.h / 2)
    await win.click('[data-shape="s1"]')
    await win.waitForSelector('[data-testid="shape-box"]')
    const s1 = await centerOf(win, '[data-testid="shape-box"]')
    await win.click('[data-annotation="a1"]')
    await win.waitForSelector('.annotation-handle')
    const t1 = await centerOf(win, '.annotation-handle')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.annotation-handle')), 'no handle')
    await modClick(win, s1.x, s1.y, 'Control')
    await win.waitForSelector('[data-testid="shape-box"]')
    await modClick(win, t1.x, t1.y, 'Control')
    await f.waitFor(async () => (await win.$$('[data-testid="group-outline"]')).length === 2, 'two outlines on the preview')
    await waitCount(win, 2, 's1 and a1 from the preview')
    await win.waitForSelector('[data-testid="group-hint"]:has-text("2 selected items on screen")')
    const overlay = await rectOf(win, '[data-testid="preview-overlay"]')
    await modClick(win, overlay.x + 4, overlay.y + 4, 'Control')
    await h.sleep(300)
    h.assert((await win.$eval('.transport button[data-playing]', (b) => b.dataset.playing)) === 'false', 'a Ctrl+click on nothing does not play')
    await waitCount(win, 2, 'and keeps the selection')
    await win.click('[data-testid="group-outline"][data-key="annotation:a1"]')
    await win.waitForSelector('.annotation-handle')
    await waitCount(win, null, 'a plain click on an outline edits that item alone')

    const errors = ctx.logs.filter((l) => l.includes('[pageerror]') || l.includes('[console.error]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })

  await h.run('multi-select: a crop and the zoom level keys on a group', async (ctx) => {
    const crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }
    const zooms = [
      { id: 'z1', start: 1, end: 2, scale: 1.5, focus: { mode: 'cursor' }, auto: false },
      { id: 'z2', start: 4, end: 5, scale: 3, focus: { mode: 'region', x: 0.3, y: 0.3, w: 0.25, h: 0.25 }, auto: true },
      { id: 'z3', start: 12, end: 14, scale: 1.25, focus: { mode: 'fixed', x: 0.4, y: 0.4 }, auto: false }
    ]
    const { home, id, win } = await openSeeded(ctx, 'ms-crop', { ...SEED, name: 'CropTest', zooms }, { crop })
    // 13. With a crop, 2× on the group: every selected block's level (as seen) is 2.
    await win.click('[data-zoom="z1"]')
    await win.keyboard.press('Control+a')
    await waitCount(win, 3, 'the three zooms')
    await win.keyboard.press('3')
    await waitNotice(win, 'Zoom level 2× for 3 zooms', 'the level notice')
    const scales = await win.$$eval('[data-zoom]', (els) => els.map((e) => Number(e.dataset.scale)))
    h.assert(scales.length === 3 && scales.every((s) => Math.abs(s - 2) < 1e-6), `every level 2× (${scales})`)
    const p = await saved(home, id, (q) => q.zooms.every((z) => !z.auto), 'the automatic zoom is yours now')
    h.assert(p.crop && p.crop.x === 0.1, 'the crop is kept')
    await win.keyboard.press('Control+z')
    await saved(home, id, (q) => q.zooms.find((z) => z.id === 'z1').scale === 1.5 && q.zooms.find((z) => z.id === 'z2').auto, 'one undo')
  })

  await h.run('multi-select: the keyboard-only path', async (ctx) => {
    const { home, id, win } = await openSeeded(ctx, 'ms-keys', SEED, PATCH)
    // 14. Palette "Open Text settings", then Ctrl+A: the text items, with the Selection view open.
    await win.keyboard.press('Control+k')
    await win.waitForSelector('.command-palette')
    await win.keyboard.type('Open Text settings')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.insp-body[data-tab="text"]')
    await win.keyboard.press('Control+a')
    await waitCount(win, 2, 'Ctrl+A: the text items')
    h.assert(JSON.stringify(await members(win)) === JSON.stringify(['annotation:a1', 'annotation:a2']), `text items ${await members(win)}`)
    await win.waitForSelector('[data-testid="selection-panel"]')
    await win.keyboard.press('Control+a')
    await waitCount(win, 11, 'Ctrl+A again: every item')
    // Leave out z1 from the Selection view; the keyboard moves to the next row's button.
    await win.focus('button[aria-label^="Leave out Zoom 2× at 0:01.0"]')
    await win.keyboard.press('Enter')
    await waitCount(win, 10, 'z1 left out')
    const focused = await win.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
    h.assert(focused.startsWith('Leave out First at 0:01.0'), `focus on the next row (${focused})`)
    // The Shapes tab from the rail, then Ctrl+Space on s1's row leaves it out; focus stays there.
    await win.focus('.insp-tabs button[title="Shapes"]')
    await win.keyboard.press('Enter')
    await win.waitForSelector('[data-shape-item="s1"][aria-pressed="true"]')
    await win.focus('[data-shape-item="s1"]')
    await win.keyboard.press('Control+Space')
    await waitCount(win, 9, 's1 left out with Ctrl+Space')
    h.assert((await win.evaluate(() => document.activeElement?.dataset?.shapeItem)) === 's1', 'focus stays on the row')
    h.assert((await win.$eval('[data-shape-item="s1"]', (b) => b.getAttribute('aria-pressed'))) === 'false', 'the row is no longer pressed')
    // Delete, one undo, Esc.
    await win.keyboard.press('Delete')
    const gone = await saved(home, id, (p) => p.annotations.length === 0 && p.zooms.length === 1 && p.shapes.length === 1, 'nine items deleted')
    h.assert(gone.zooms[0].id === 'z1' && gone.shapes[0].id === 's1' && !gone.freezes && !gone.titles.length && !gone.chapters.length, 'z1 and s1 stay')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => p.annotations.length === 2 && p.zooms.length === 3 && p.shapes.length === 3 && p.freezes.length === 1, 'one undo brings them back')
    await win.keyboard.press('Escape')
    await waitCount(win, null, 'Esc clears')
    const errors = ctx.logs.filter((l) => l.includes('[pageerror]') || l.includes('[console.error]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })
}

main()
