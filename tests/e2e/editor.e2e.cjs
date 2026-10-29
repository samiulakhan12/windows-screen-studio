// Editor end-to-end tests on seeded projects: undo/redo, safe zoom insertion,
// shortcuts and focus, cuts + speed (preview and export), text overlays,
// long-timeline zoom, saving on close/Back/failure, focus picking and audio.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

/** Launches the app on a fresh HOME with one seeded project and opens it in the editor. */
async function setup(ctx, tag, opts) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  const { app, win, logs } = await h.launch({ home, args: opts.args || [] })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  // Keep handles on the editor's (detached) <video> elements.
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
  return { home, id, app, win, logs }
}

const disk = (home, id) => h.readProject(home, id)
const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

async function centerOf(win, selector) {
  const r = await win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.left, top: b.top }
  })
  return r
}

/** Clicks the ruler at source time `t` (moves the playhead). */
async function seekTo(win, t) {
  const x = await xForTime(win, t)
  const { y } = await centerOf(win, '.tl-ruler')
  await win.mouse.click(x, y)
  await h.sleep(150)
}

async function drag(win, from, to, { steps = 8, pauseMs = 0 } = {}) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await win.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    if (pauseMs && i === Math.floor(steps / 2)) await h.sleep(pauseMs)
  }
  await win.mouse.up()
  await h.sleep(150)
}

const segTimes = (win, selector) => win.$$eval(selector, (els) => els.map((e) => ({ id: e.dataset.zoom || e.dataset.annotation || e.dataset.clip, start: Number(e.dataset.start), end: Number(e.dataset.end), speed: Number(e.dataset.speed || 1) })))
const timecode = (win) => win.$eval('.timecode', (e) => e.textContent)
/** "1:02.3 / 2:00.0" -> 62.3 */
const outTime = (tc) => {
  const [m, s] = tc.split('/')[0].trim().split(':')
  return Number(m) * 60 + Number(s)
}
const isPlaying = (win) => win.$eval('.transport .btn.round', (b) => b.dataset.playing === 'true')
const activeTab = (win) => win.$eval('.insp-tabs button.active', (b) => b.textContent.trim())
const video = (win) => win.evaluate(() => {
  const v = window.__videos.find((x) => x.getAttribute('src'))
  return v ? { t: v.currentTime, rate: v.playbackRate, paused: v.paused, muted: v.muted, volume: v.volume } : null
})
const videos = (win) =>
  win.evaluate(() =>
    window.__videos.filter((x) => x.getAttribute('src')).map((v) => ({ t: v.currentTime, rate: v.playbackRate, paused: v.paused }))
  )
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

async function main() {
  await h.run('editor: undo/redo covers zoom add, move, delete and a slider drag', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'undo', { name: 'UndoTest', seconds: 12 })
    h.assert(await win.$eval('button[aria-label="Undo"]', (b) => b.disabled), 'undo starts disabled')

    // The preview fills the stage, with a DPR-aware backing store capped at the recording size (F47).
    const stage = await win.evaluate(() => {
      const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect()
      const c = document.querySelector('.preview-canvas')
      const r = c.getBoundingClientRect()
      return { wrapW: wrap.width, wrapH: wrap.height, w: r.width, h: r.height, bw: c.width, bh: c.height, dpr: devicePixelRatio }
    })
    h.assert(stage.w >= stage.wrapW - 2 || stage.h >= stage.wrapH - 2, `canvas fills the stage: ${JSON.stringify(stage)}`)
    const k = Math.min(1, 1280 / (stage.w * stage.dpr), 720 / (stage.h * stage.dpr))
    h.assert(stage.bw === Math.round(stage.w * stage.dpr * k) && stage.bw <= 1280, `backing store ${stage.bw}x${stage.bh} for ${JSON.stringify(stage)}`)
    h.assert(Math.abs(stage.bw / stage.bh - 1280 / 720) < 0.02, 'backing store keeps the aspect ratio')

    await seekTo(win, 4)
    await win.keyboard.press('z')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'zoom added with Z')
    await f.waitFor(async () => (await activeTab(win)) === 'Zoom', 'adding a zoom reveals the Zoom inspector (F45)', 2000)
    const [added] = await segTimes(win, '.zoom-seg')
    h.assert(added.start < 4 && added.end > 4, `new zoom covers the playhead: ${JSON.stringify(added)}`)

    // Z inside the zoom selects it instead of adding (F09).
    await win.keyboard.press('z')
    await h.sleep(200)
    h.assert((await win.$$('.zoom-seg')).length === 1, 'no second zoom inside the first')
    h.assert((await win.textContent('.notice-slot')).includes('already a zoom'), 'hint shown')

    // One drag, with a long pause in the middle, is one undo step.
    const c = await centerOf(win, '.zoom-seg')
    await drag(win, c, { x: c.x + 120, y: c.y }, { steps: 10, pauseMs: 1200 })
    const [moved] = await segTimes(win, '.zoom-seg')
    h.assert(moved.start > added.start + 0.5 && near(moved.end - moved.start, added.end - added.start, 1e-6), `dragged centre moves the zoom: ${JSON.stringify(moved)}`)
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => {
      const [now] = await segTimes(win, '.zoom-seg')
      return near(now.start, added.start) && near(now.end, added.end)
    }, 'Ctrl+Z restores the position in one step', 2000)
    await win.keyboard.press('Control+Shift+z')
    await f.waitFor(async () => near((await segTimes(win, '.zoom-seg'))[0].start, moved.start), 'Ctrl+Shift+Z redoes the move', 2000)

    await win.click('.zoom-seg')
    await win.keyboard.press('Delete')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 0, 'zoom deleted')
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'delete undone')
    await win.keyboard.press('Control+z') // move
    await win.keyboard.press('Control+z') // add
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 0, 'add undone')
    h.assert(await win.$eval('button[aria-label="Undo"]', (b) => b.disabled), 'undo disabled at the start of history')
    h.assert(!(await win.$eval('button[aria-label="Redo"]', (b) => b.disabled)), 'redo enabled')
    await win.keyboard.press('Control+y')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'Ctrl+Y redoes the add')

    // A slider drag is one undo step.
    await win.click('.insp-tabs button:has-text("Style")')
    // Under Frame and Vertical framing, Padding can be below the visible part of the tab.
    await (await win.$('.slider:has-text("Padding") input')).scrollIntoViewIfNeeded()
    const thumb = await win.$eval('.slider:has-text("Padding") input', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width * (Number(el.value) / Number(el.max)), y: r.top + r.height / 2, w: r.width }
    })
    await drag(win, thumb, { x: thumb.x + thumb.w * 0.4, y: thumb.y }, { steps: 12, pauseMs: 1000 })
    const changed = await win.textContent('.slider:has-text("Padding") .muted')
    h.assert(changed !== '7%', `padding changed by dragging (${changed})`)
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.textContent('.slider:has-text("Padding") .muted')) === '7%', 'one Ctrl+Z restores the padding', 2000)
    await waitSaved(win)
    const p = disk(home, id)
    h.assert(p.style.padding === 0.07 && p.zooms.length === 1, `autosave wrote the present state: ${JSON.stringify({ padding: p.style.padding, zooms: p.zooms.length })}`)
  })

  await h.run('editor: adding zooms never deletes or truncates existing ones (F09, F25)', async (ctx) => {
    const user = { id: 'user', start: 3, end: 4, scale: 3, focus: { mode: 'fixed', x: 0.2, y: 0.8 }, auto: false }
    const { home, id, win } = await setup(ctx, 'f09', { name: 'NoClobber', seconds: 12, zooms: [user] })
    await seekTo(win, 2)
    await win.keyboard.press('z')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 2, 'second zoom added')
    await waitSaved(win)
    let p = disk(home, id)
    h.assert(JSON.stringify(p.zooms.find((z) => z.id === 'user')) === JSON.stringify(user), 'the tuned zoom is untouched on disk')
    const added = p.zooms.find((z) => z.id !== 'user')
    h.assert(added.end <= 3 + 1e-9 && added.start <= 2, `new zoom fits before it: ${JSON.stringify(added)}`)

    // Double-clicking an existing zoom does not add one (F25).
    const c = await centerOf(win, '.zoom-seg[data-zoom="user"]')
    await win.mouse.dblclick(c.x, c.y)
    await h.sleep(300)
    h.assert((await win.$$('.zoom-seg')).length === 2, 'double-click on a zoom adds nothing')

    // Double-click on free track space adds a zoom starting there.
    const x = await xForTime(win, 8)
    const { y } = await centerOf(win, '.zoom-track')
    await win.mouse.dblclick(x, y)
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 3, 'zoom added by double-click')
    await waitSaved(win)
    p = disk(home, id)
    h.assert(p.zooms.some((z) => Math.abs(z.start - 8) < 0.1), 'double-clicked zoom starts at the click')
    h.assert(JSON.stringify(p.zooms.find((z) => z.id === 'user')) === JSON.stringify(user), 'still untouched')
  })

  await h.run('editor: shortcuts work after using controls; export modal blocks them (F10, F24, F26)', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'keys', {
      name: 'KeysTest',
      seconds: 12,
      zooms: [{ id: 'k1', start: 6, end: 8, scale: 2, focus: { mode: 'cursor' }, auto: false }]
    })
    // Cursor tab: the recorded cursor is in the video, so the smooth cursor is off (F03 UI).
    await win.click('.insp-tabs button:has-text("Cursor")')
    h.assert(await win.$('[data-testid="cursor-in-video"]'), 'explains that the Windows cursor is in the video')
    h.assert(await win.$eval('input[aria-label="Show smooth cursor"]', (i) => i.disabled), 'smooth cursor disabled')
    h.assert(!(await win.$eval('input[aria-label="Click effect"]', (i) => i.disabled)), 'click effect independent of the smooth cursor')

    await win.click('label.toggle:has-text("Click effect")')
    const toggled = await win.$eval('input[aria-label="Click effect"]', (i) => i.checked)
    await win.keyboard.press('Space')
    await f.waitFor(() => isPlaying(win), 'Space plays after clicking a toggle')
    h.assert((await win.$eval('input[aria-label="Click effect"]', (i) => i.checked)) === toggled, 'Space did not flip the toggle')
    await win.keyboard.press('Space')
    await f.waitFor(async () => !(await isPlaying(win)), 'Space pauses')

    // After clicking a slider and the ruler, arrows seek instead of moving the slider.
    await win.click('.insp-tabs button:has-text("Style")')
    await win.click('.slider:has-text("Shadow") input')
    const shadow = await win.textContent('.slider:has-text("Shadow") .muted')
    await seekTo(win, 2)
    const t0 = outTime(await timecode(win))
    h.assert(Math.abs(t0 - 2) < 0.15, `ruler click seeks (${await timecode(win)})`)
    await win.keyboard.press('Shift+ArrowRight')
    const t1 = outTime(await timecode(win))
    h.assert(Math.abs(t1 - t0 - 1) < 0.15, `Shift+→ steps one second (${t0} -> ${t1})`)
    h.assert((await win.textContent('.slider:has-text("Shadow") .muted')) === shadow, 'slider unchanged by the arrow key')

    // Clicking the timeline takes focus out of the title field (F24).
    await win.click('.title-input')
    await win.keyboard.press('End')
    await win.keyboard.type('X')
    await win.click('.zoom-seg')
    await win.keyboard.press('Backspace')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 0, 'Backspace deletes the selected zoom')
    h.assert((await win.inputValue('.title-input')).endsWith('X'), 'title kept its text')
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'zoom restored')

    // Export modal: shortcuts are off behind it and Escape closes it (F26).
    await win.keyboard.press('Space')
    await f.waitFor(() => isPlaying(win), 'playing before export')
    await win.click('button:has-text("Export")')
    await win.waitForSelector('.modal')
    await f.waitFor(async () => !(await isPlaying(win)), 'opening export pauses the preview')
    await win.keyboard.press('Space')
    await win.keyboard.press('Delete')
    await win.keyboard.press('z')
    await h.sleep(300)
    h.assert(!(await isPlaying(win)), 'Space does nothing behind the modal')
    h.assert((await win.$$('.zoom-seg')).length === 1, 'Delete/Z do nothing behind the modal')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.modal')), 'Escape closes the export dialog')

    // Effects: motion blur and keystroke overlay settings are saved.
    await win.click('.insp-tabs button:has-text("Effects")')
    await win.focus('.slider:has-text("Strength") input')
    await win.keyboard.press('Home')
    await f.waitFor(async () => (await win.textContent('.slider:has-text("Strength") .muted')) === 'Off', 'Home on a focused slider sets it (motion blur off)', 2000)
    await win.click('.chips[aria-label="Shortcut position"] .chip:has-text("Top")')
    await waitSaved(win)
    const p = disk(home, id)
    h.assert(p.effects.motionBlur === 0 && p.effects.keystrokes.position === 'top', `effects saved: ${JSON.stringify(p.effects)}`)
  })

  await h.run('editor: split, cut and 2x speed play correctly and export to the edited length', async (ctx) => {
    const { home, id, app, win } = await setup(ctx, 'cuts', { name: 'CutsTest', seconds: 12, webcam: true })
    // Exact positions: Home, then three 1 s steps.
    await win.keyboard.press('Home')
    for (let i = 0; i < 3; i++) await win.keyboard.press('Shift+ArrowRight')
    await win.keyboard.press('s')
    for (let i = 0; i < 3; i++) await win.keyboard.press('Shift+ArrowRight')
    await win.keyboard.press('s')
    await f.waitFor(async () => (await win.$$('.clip-block')).length === 3, 'two splits make three clips')

    // Select the middle clip by clicking it (also moves the playhead, F46) and cut it.
    const xMid = await xForTime(win, 4.5)
    const track = await centerOf(win, '.clip-track')
    await win.mouse.click(xMid, track.y)
    await f.waitFor(async () => (await activeTab(win)) === 'Clip', 'selecting a clip reveals the Clip inspector', 2000)
    h.assert(Math.abs(outTime(await timecode(win)) - 4.5) < 0.15, `clicking the clip track scrubs (${await timecode(win)})`)
    await win.keyboard.press('Delete')
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 1, 'cut gap shown')

    await win.mouse.click(await xForTime(win, 9), track.y)
    await win.click('.chips[aria-label="Clip speed"] .chip:has-text("2×")')
    await f.waitFor(async () => (await win.$$('.clip-block.fast')).length === 1, 'speed badge')
    await f.waitFor(async () => (await timecode(win)).endsWith('/ 0:06.0'), 'output length 3 + 6/2 = 6 s in the transport', 2000)

    // Scrubbing into the cut shows the next kept frame.
    await seekTo(win, 4.5)
    await f.waitFor(async () => Math.abs((await video(win)).t - 6) < 0.05, 'video shows the first frame after the cut')

    // Preview playback skips the cut, plays the last clip at 2x and stops at the end (F38).
    await win.keyboard.press('Home')
    await h.sleep(300)
    await win.keyboard.press('Space')
    const samples = []
    const started = Date.now()
    await f.waitFor(async () => {
      const [screen, cam] = await videos(win)
      samples.push({ ...screen, camT: cam.t, camRate: cam.rate })
      return !(await isPlaying(win)) && Date.now() - started > 500
    }, 'playback ends', 25000)
    const elapsed = (Date.now() - started) / 1000
    const inGap = samples.filter((s) => s.t > 3.1 && s.t < 5.9)
    h.assert(inGap.length === 0, `never plays the cut: ${JSON.stringify(inGap.slice(0, 3))}`)
    h.assert(samples.some((s) => s.t > 7 && s.rate === 2), 'last clip plays at 2x')
    h.assert(samples.filter((s) => s.t > 7 && !s.paused).every((s) => s.camRate === 2 && Math.abs(s.camT - s.t) < 0.5), 'camera follows speed and position')
    h.assert(elapsed > 4.5 && elapsed < 14, `took about the edited length (${elapsed.toFixed(1)} s)`)
    h.assert((await timecode(win)) === '0:06.0 / 0:06.0', `transport at the end (${await timecode(win)})`)
    h.assert(await win.$eval('.transport .btn.round', (b) => b.getAttribute('aria-label') === 'Play'), 'button shows Play at the end')

    await waitSaved(win)
    const p = disk(home, id)
    h.assert(p.clips.length === 2 && p.clips[1].speed === 2, `clips on disk: ${JSON.stringify(p.clips)}`)

    const out = path.join(home, 'cuts.mp4')
    await h.mockSaveDialog(app, out)
    await win.click('button:has-text("Export")')
    await win.click('.modal .chip:has-text("720p")')
    await win.click('.modal .chip:has-text("30 fps")')
    await win.click('.modal button:has-text("Export MP4")')
    await win.waitForSelector('text=Export finished', { timeout: 300000 })
    const duration = f.ffprobeDuration(out)
    const frames = f.ffprobeFrames(out)
    h.assert(Math.abs(duration - 6) < 0.1, `exported duration ${duration} equals the edited length 6 s`)
    h.assert(Math.abs(frames - 180) <= 1, `exported ${frames} frames at 30 fps`)
    await win.click('.modal button:has-text("Done")')

    // Restore the cut from its hatched gap, then undo.
    await win.click('.gap-block.cut .gap-restore')
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 0, 'cut restored')
    await f.waitFor(async () => (await timecode(win)).endsWith('/ 0:09.0'), 'restored footage plays at 1x', 2000)
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 1, 'restore undone')

    // Range cut: Shift+drag on the clip track, then Delete.
    const a = await xForTime(win, 1)
    const b = await xForTime(win, 2)
    await win.keyboard.down('Shift')
    await drag(win, { x: a, y: track.y }, { x: b, y: track.y })
    await win.keyboard.up('Shift')
    await win.waitForSelector('[data-testid="range-selection"]')
    await win.keyboard.press('Delete')
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 2, 'range cut')
    await f.waitFor(async () => Math.abs(outTime((await timecode(win)).split('/')[1]) - 5) < 0.1, 'range removed about 1 s', 2000)

    // Trim handle: drag the start in by about half a second.
    const handle = await centerOf(win, '.trim-handle.start')
    const half = (await xForTime(win, 0.5)) - (await xForTime(win, 0))
    await drag(win, handle, { x: handle.x + half, y: handle.y })
    const clipsNow = await segTimes(win, '.clip-block')
    h.assert(clipsNow[0].start > 0.3 && clipsNow[0].start < 0.7, `trimmed start ${clipsNow[0].start}`)
    await waitSaved(win)
    h.assert(disk(home, id).clips.length === 3, 'edits saved')
  })

  await h.run('editor: text overlays are added, edited, moved on the preview and persist', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'text', { name: 'TextTest', seconds: 12 })
    await seekTo(win, 2)
    await win.keyboard.press('t')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 1, 'text added with T')
    await f.waitFor(async () => (await activeTab(win)) === 'Text', 'Text inspector revealed', 2000)
    await win.fill('.text-field', 'Hello e2e')
    await win.keyboard.press('Escape')
    // Shortcuts work again once the field is left.
    await win.keyboard.press('t')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 2, 'overlapping second text')
    const tops = await win.$$eval('.text-seg', (els) => els.map((e) => e.style.top))
    h.assert(tops[0] !== tops[1], `overlapping texts get separate lanes (${tops})`)
    await win.keyboard.press('Delete')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 1, 'second text deleted')
    // Double-click on free text track space adds one there; undo removes it again.
    const tx = await xForTime(win, 9)
    const ty = (await centerOf(win, '.text-track')).y
    await win.mouse.dblclick(tx, ty)
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 2, 'text added by double-click')
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 1, 'undo removes it')

    await win.click('.text-seg')
    await win.waitForSelector('.annotation-handle')
    await waitSaved(win)
    const before = disk(home, id).annotations[0]
    const handle = await centerOf(win, '.annotation-handle')
    await drag(win, handle, { x: handle.x + 120, y: handle.y - 80 })
    await waitSaved(win)
    const after = disk(home, id).annotations[0]
    h.assert(after.text === 'Hello e2e', `text saved (${after.text})`)
    h.assert(after.x > before.x + 0.05 && after.y < before.y - 0.05, `dragged on the preview: ${JSON.stringify({ before, after })}`)

    await win.click('button[aria-label="Back to recordings"]')
    await f.openProject(win, 'TextTest')
    const segs = await win.$$eval('.text-seg', (els) => els.map((e) => e.getAttribute('title')))
    h.assert(segs.length === 1 && segs[0] === 'Hello e2e', `text persists after reopening (${segs})`)
  })

  await h.run('editor: 30-minute timeline zooms, scrolls, follows the playhead and keeps zooms movable (F11)', async (ctx) => {
    const seconds = 1800
    const zooms = []
    for (let t = 10, i = 0; t < seconds - 5; t += 12, i++) zooms.push({ id: `a${i}`, start: t - 0.9, end: t + 1.8, scale: 1.8, focus: { mode: 'cursor' }, auto: true })
    const { home, id, win } = await setup(ctx, 'long', { name: 'LongTest', seconds, width: 320, height: 180, fps: 10, zooms })
    const px0 = await win.$eval('.tl-content', (e) => Number(e.dataset.pxPerSec))
    h.assert(px0 < 1, `fit shows 30 minutes (${px0} px/s)`)
    h.assert(!(await win.$eval('[data-testid="timeline-scroller"]', (e) => e.scrollWidth > e.clientWidth + 1)), 'no scrollbar at fit')

    const sc = await centerOf(win, '[data-testid="timeline-scroller"]')
    await win.mouse.move(sc.x, sc.y)
    await win.keyboard.down('Control')
    for (let i = 0; i < 6; i++) await win.mouse.wheel(0, -300)
    await win.keyboard.up('Control')
    await h.sleep(300)
    const px1 = await win.$eval('.tl-content', (e) => Number(e.dataset.pxPerSec))
    h.assert(px1 > px0 * 5, `Ctrl+wheel zooms in (${px0} -> ${px1})`)
    while ((await win.$eval('.tl-content', (e) => Number(e.dataset.pxPerSec))) < 20) {
      await win.click('button[aria-label="Zoom in timeline"]')
      await h.sleep(100)
    }
    const rendered = (await win.$$('.zoom-seg')).length
    h.assert(rendered > 0 && rendered < zooms.length, `only nearby zooms are rendered (${rendered}/${zooms.length})`)

    // Drag the middle of a visible zoom: it moves rather than resizes.
    const target = await win.$$eval('.zoom-seg', (els, scrollerSel) => {
      const s = document.querySelector(scrollerSel).getBoundingClientRect()
      const el = els.find((e) => {
        const r = e.getBoundingClientRect()
        return r.left > s.left + 60 && r.right < s.right - 120
      })
      const r = el.getBoundingClientRect()
      return { id: el.dataset.zoom, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }
    }, '[data-testid="timeline-scroller"]')
    h.assert(target.w >= 40, `zoom is wide enough to grab (${target.w}px)`)
    const orig = zooms.find((z) => z.id === target.id)
    await drag(win, target, { x: target.x + 40, y: target.y })
    await waitSaved(win)
    const movedZoom = disk(home, id).zooms.find((z) => z.id === target.id)
    h.assert(movedZoom.start > orig.start + 0.5 && Math.abs(movedZoom.end - movedZoom.start - (orig.end - orig.start)) < 1e-6, `moved, not resized: ${JSON.stringify(movedZoom)}`)

    // End/Home scroll the playhead into view; playback follows it.
    await win.keyboard.press('End')
    await h.sleep(300)
    const atEnd = await win.$eval('[data-testid="timeline-scroller"]', (e) => ({ left: e.scrollLeft, max: e.scrollWidth - e.clientWidth }))
    h.assert(atEnd.left > atEnd.max * 0.9, `End scrolls to the end (${JSON.stringify(atEnd)})`)
    await win.keyboard.press('Home')
    await h.sleep(300)
    h.assert((await win.$eval('[data-testid="timeline-scroller"]', (e) => e.scrollLeft)) < 50, 'Home scrolls back')
    const viewSeconds = await win.$eval('[data-testid="timeline-scroller"]', (e) => e.clientWidth / Number(e.firstElementChild.dataset.pxPerSec))
    await seekTo(win, viewSeconds - 1)
    await win.keyboard.press('Space')
    await h.sleep(2500)
    await win.keyboard.press('Space')
    h.assert((await win.$eval('[data-testid="timeline-scroller"]', (e) => e.scrollLeft)) > 100, 'the view follows the playhead during playback')

    await win.click('.tl-zoom button:has-text("Fit")')
    await h.sleep(200)
    const pxFit = await win.$eval('.tl-content', (e) => Number(e.dataset.pxPerSec))
    h.assert(Math.abs(pxFit - px0) < 1e-6, 'Fit restores the whole view')
  })

  await h.run('editor: no edit is lost when the window closes right after a change (F13)', async (ctx) => {
    const { home, id, app, win } = await setup(ctx, 'close', { name: 'CloseTest', seconds: 6 })
    await win.click('.title-input')
    await win.keyboard.press('End')
    await win.keyboard.type(' final')
    await win.click('.chip:has-text("1:1")')
    await h.sleep(60)
    const exited = new Promise((resolve) => app.process().on('exit', resolve))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await Promise.race([exited, h.sleep(15000)])
    const p = disk(home, id)
    h.assert(p.name === 'CloseTest final' && p.style.aspectRatio === '1:1', `saved on close: ${JSON.stringify({ name: p.name, aspect: p.style.aspectRatio })}`)
  })

  await h.run('editor: Back saves first so the library shows the new name (F28)', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'back', { name: 'BackTest', seconds: 6 })
    await win.click('.title-input')
    await win.keyboard.press('End')
    await win.keyboard.type('XYZ')
    await win.click('button[aria-label="Back to recordings"]')
    await win.waitForSelector('.project-open:has-text("BackTestXYZ")', { timeout: 5000 })
    h.assert(disk(home, id).name === 'BackTestXYZ', 'on disk too')
  })

  await h.run('editor: a failed save is shown with Retry and recovers (F14)', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'savefail', { name: 'FailTest', seconds: 6 })
    const tmp = path.join(h.projectsRoot(home), id, 'project.json.tmp')
    fs.mkdirSync(tmp)
    await win.click('.title-input')
    await win.keyboard.press('End')
    await win.keyboard.type('Q')
    await win.waitForSelector('.save-state.error', { timeout: 5000 })
    h.assert((await win.textContent('.save-state.error')).includes('Not saved'), 'failure is visible')
    fs.rmdirSync(tmp)
    await win.click('.save-state.error button:has-text("Retry")')
    await waitSaved(win)
    h.assert(disk(home, id).name === 'FailTestQ', 'retry saved the edit')
  })

  await h.run('editor: window recordings get fixed-centre zooms whose focus is picked on the preview (F30)', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'pick', {
      name: 'PickTest',
      seconds: 10,
      cursor: { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }
    })
    await seekTo(win, 4)
    await win.keyboard.press('z')
    await waitSaved(win)
    let z = disk(home, id).zooms[0]
    h.assert(z.focus.mode === 'fixed' && z.focus.x === 0.5 && z.focus.y === 0.5, `fixed centre focus: ${JSON.stringify(z.focus)}`)
    h.assert(await win.$eval('.chip:has-text("Follow cursor")', (b) => b.disabled && !b.classList.contains('active')), 'follow cursor unavailable')
    await win.click('button:has-text("Pick on preview")')
    await win.waitForSelector('.preview-overlay.picking')
    const box = await centerOf(win, '.canvas-box')
    await win.mouse.click(box.left + box.w * 0.2, box.top + box.h * 0.25)
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.preview-overlay.picking')), 'Escape leaves pick mode')
    await waitSaved(win)
    z = disk(home, id).zooms[0]
    h.assert(z.focus.mode === 'fixed' && z.focus.x < 0.25 && z.focus.y < 0.3, `focus picked top-left: ${JSON.stringify(z.focus)}`)
    // "Fixed point" again keeps the picked point (F45).
    await win.click('.chip:has-text("Fixed point")')
    await waitSaved(win)
    h.assert(JSON.stringify(disk(home, id).zooms[0].focus) === JSON.stringify(z.focus), 'Fixed point does not reset the focus')
  })

  await h.run('editor: HiDPI preview renders at device pixels, capped at the recording size (F47)', async (ctx) => {
    const { win } = await setup(ctx, 'hidpi', { name: 'HiDpi', seconds: 3, width: 1920, height: 1080, args: ['--force-device-scale-factor=2'] })
    const s = await win.evaluate(() => {
      const c = document.querySelector('.preview-canvas')
      const r = c.getBoundingClientRect()
      return { dpr: devicePixelRatio, w: r.width, h: r.height, bw: c.width, bh: c.height }
    })
    h.assert(s.dpr === 2, `device pixel ratio forced to 2 (${s.dpr})`)
    const k = Math.min(1, 1920 / (s.w * 2), 1080 / (s.h * 2))
    h.assert(s.bw === Math.round(s.w * 2 * k) && s.bw <= 1920, `backing ${s.bw}x${s.bh} for ${s.w}x${s.h} css`)
    h.assert(s.bw > s.w, 'sharper than CSS pixels on a HiDPI screen')
  })

  await h.run('editor: background images follow undo and redo', async (ctx) => {
    const { home, id, app, win } = await setup(ctx, 'bg', { name: 'BgTest', seconds: 4 })
    const png = path.join(home, 'red.png')
    const jpg = path.join(home, 'blue.jpg')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', png])
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=64x64', '-frames:v', '1', jpg])
    await app.evaluate(({ dialog }, files) => {
      let i = 0
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files[i++]] })
    }, [png, jpg])
    // Top-left pixel of the preview is background (inside the padding).
    const corner = () =>
      win.evaluate(() => {
        const c = document.querySelector('.preview-canvas')
        const [r, g, b] = c.getContext('2d').getImageData(3, 3, 1, 1).data
        return { r, g, b }
      })
    const isRed = async () => {
      const p = await corner()
      return p.r > 180 && p.g < 80 && p.b < 80
    }
    const isBlue = async () => {
      const p = await corner()
      return p.b > 180 && p.r < 80 && p.g < 80
    }
    await win.click('.insp-body button:has-text("Image…")')
    await f.waitFor(isRed, 'red background drawn')
    await win.click('.insp-body button:has-text("Image…")')
    await f.waitFor(isBlue, 'blue background drawn')
    await win.keyboard.press('Control+z')
    await f.waitFor(isRed, 'undo shows the previous image again')
    await waitSaved(win)
    h.assert(disk(home, id).style.background.path === 'background.png', 'saved path follows undo')
    h.assert(fs.existsSync(path.join(h.projectsRoot(home), id, 'background.png')), 'previous image file kept')
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => !(await isRed()) && !(await isBlue()), 'undo back to the gradient')
    await win.keyboard.press('Control+Shift+z')
    await f.waitFor(isRed, 'redo')
  })

  await h.run('editor: audio mute and volume apply to the preview and are saved (F49)', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'audio', { name: 'AudioTest', seconds: 6, audio: true })
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.click('label.toggle:has-text("Mute")')
    await f.waitFor(async () => (await video(win)).muted, 'preview muted')
    await win.click('label.toggle:has-text("Mute")')
    await f.waitFor(async () => !(await video(win)).muted, 'preview unmuted')
    const s = await centerOf(win, '.slider:has-text("Volume") input')
    await win.mouse.click(s.left + s.w * 0.25, s.y)
    await f.waitFor(async () => Math.abs((await video(win)).volume - 0.5) < 0.1, 'preview volume follows the slider')
    await waitSaved(win)
    const a = disk(home, id).audio
    h.assert(a.muted === false && Math.abs(a.volume - 0.5) < 0.1, `audio settings saved: ${JSON.stringify(a)}`)
  })
}

main()
