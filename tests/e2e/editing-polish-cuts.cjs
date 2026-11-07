// Editing polish, part P1 (smooth cuts), end to end (docs/design/editing-polish.md §19.3): steps E2
// (Smooth all cuts: notice, undo and redo, a crossfade in exports at 24 and 30 fps with no fall back
// to the seeking path, the length unchanged), E3 (two dips 0.6 s apart: the second never reaches
// black), E4 (Slide: B comes in from the right over A*), E5 (no frame of any window shows the
// secret cut out), E15 (Polish smooths the cut in one undo step, Review lists and removes it, and
// keeps a chosen hard cut) and E16 (the keyboard: Go to next cut from the palette, a cut marker by
// Tab and Enter, the Cut style radios by arrow keys, Length by Page Up). Run by editing-polish.e2e.cjs.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const W = 1280
const H = 720

/** 10 s at 60 fps like the proxies: red before 4 s, a green "secret" from 4 to 6 s, blue after. */
function secretVideo() {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `cuts-rgb-10s-${W}x${H}.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0xff0000:s=${W}x${H}:r=60:d=4`,
      '-f', 'lavfi', '-i', `color=c=0x00ff00:s=${W}x${H}:r=60:d=2`,
      '-f', 'lavfi', '-i', `color=c=0x0000ff:s=${W}x${H}:r=60:d=4`,
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[v]',
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '15', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tmp
    ],
    { stdio: 'inherit' }
  )
  fs.renameSync(tmp, file)
  return file
}

/** Every frame of `file` scaled down to 16 × 9, as [r, g, b] means of a few sample spots: { left, centre, right } per frame. */
function spots(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=16:9:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 })
  const size = 16 * 9 * 3
  const out = []
  const at = (buf, x, y) => {
    const o = (y * 16 + x) * 3
    return [buf[o], buf[o + 1], buf[o + 2]]
  }
  for (let o = 0; o + size <= raw.length; o += size) {
    const buf = raw.subarray(o, o + size)
    out.push({ left: at(buf, 1, 4), centre: at(buf, 8, 4), right: at(buf, 14, 4) })
  }
  return out
}

function seed(home, opts) {
  const media = secretVideo()
  return fx.seedProject(home, { name: opts.name, id: opts.id, media, seconds: 10, clips: opts.clips })
}

const CLIPS = [
  { id: 'a', start: 0, end: 4, speed: 1 },
  { id: 'b', start: 6, end: 10, speed: 1 }
]

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

async function exportTo(app, win, out, fps) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', `${fps} fps`)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export finished: ${r.text}`)
  const back = win.locator('.modal button', { hasText: /^Back$/ })
  if (await back.count()) await back.click()
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

async function openClipTab(win) {
  await win.click('.insp-tabs button:has-text("Clip")')
  await win.waitForSelector('[data-testid="cuts-section"]', { timeout: 10000 })
}

/** Runs a palette command by its title. */
async function command(win, title) {
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type(title)
  await f.waitFor(async () => ((await win.$$eval('.command-palette [role="option"]', (els) => els.map((e) => e.textContent || '')))[0] || '').includes(title), `the palette lists ${title}`, 3000)
  await win.keyboard.press('Enter')
  await f.waitFor(async () => !(await win.$('.command-palette')), 'the palette closes', 3000)
}

const isRed = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60
const isBlue = (c) => c[2] > 200 && c[0] < 60 && c[1] < 60
const isGreenish = (c) => c[1] > 90 && c[1] > c[0] + 40 && c[1] > c[2] + 40

async function cutsSteps(test) {
  await test('editing polish E2 E5: Smooth all cuts crossfades the cut in exports at 30 and 60 fps, the secret never shows', fx.withHome('polish-cuts-e2', async (ctx, home) => {
    const id = seed(home, { id: 'rec-cuts', name: 'Cuts', clips: CLIPS })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const said = []
    win.on('console', (m) => said.push(m.text()))
    await fx.openProject(win, 'Cuts')
    await openClipTab(win)
    h.assert((await win.textContent('[data-testid="cuts-section"]')).includes('1 cut. A cut jumps from one moment of the recording to the next.'), 'the Cuts section counts the cut')
    await win.click('[data-testid="cut-smooth-all"]')
    await win.waitForSelector('.notice:has-text("Smoothed 1 cut")', { timeout: 5000 })
    await saved(home, id, (p) => p.joins?.all?.kind === 'smooth', 'every cut is Smooth')
    await win.waitForSelector('[data-testid="cut-smooth-all"][disabled]')
    // One undo step each way.
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => !('joins' in p), 'undo takes it back')
    await win.keyboard.press('Control+Shift+z')
    await saved(home, id, (p) => p.joins?.all?.kind === 'smooth', 'redo brings it back')
    // The timeline's marker shows the cut's style.
    await win.waitForSelector('[data-testid="cut-marker"][data-kind="smooth"]', { timeout: 5000 })

    for (const fps of [30, 60]) {
      const out = path.join(home, `smooth-${fps}.mp4`)
      await exportTo(app, win, out, fps)
      const frames = spots(out)
      // The video keeps its length: 8 s.
      h.assert(frames.length === 8 * fps, `${fps} fps: ${frames.length} frames, expected ${8 * fps}`)
      // T = 4 s; the frame at T + 0.075 s mixes red and blue about half and half.
      const i = Math.round((4 + 0.075) * fps)
      const c = frames[i].centre
      const red = c[0] / 255
      const blue = c[2] / 255
      h.assert(Math.abs(red - 0.5) <= 0.12 && Math.abs(blue - 0.5) <= 0.12, `${fps} fps: frame ${i} mixes red and blue (${c})`)
      h.assert(isRed(frames[Math.round(3.9 * fps)].centre) && isBlue(frames[Math.round(4.3 * fps)].centre), `${fps} fps: red before the cut, blue after the window`)
      // E5: nothing from inside the cut, ever.
      const green = frames.findIndex((fr) => isGreenish(fr.left) || isGreenish(fr.centre) || isGreenish(fr.right))
      h.assert(green < 0, `${fps} fps: no frame shows the secret (frame ${green})`)
      console.log(`  ${fps} fps: ${frames.length} frames, frame ${i} = ${c}`)
    }
    // The decoder was fed in order: it never skipped a frame and fell back to seeking mid-export.
    const fellBack = said.find((l) => /skipped a frame|Decoding failed at frame/.test(l))
    h.assert(!fellBack, `the export never fell back to the seeking path: ${fellBack}`)
    console.log(`  ${said.filter((l) => l.startsWith('export:')).join(' | ')}`)
  }))

  await test('editing polish E3 E4: a dip within 1 s of another never reaches black; a slide pushes A* out to the left', fx.withHome('polish-cuts-e3', async (ctx, home) => {
    // Cuts at video 4 s and 4.6 s (the second 0.6 s after the first), both blue to blue at the second.
    const clips = [
      { id: 'a', start: 0, end: 4, speed: 1 },
      { id: 'b', start: 6, end: 6.6, speed: 1 },
      { id: 'c', start: 7, end: 10, speed: 1 }
    ]
    const id = seed(home, { id: 'rec-dips', name: 'Dips', clips })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Dips')
    await openClipTab(win)
    await win.selectOption('[data-testid="cut-every"]', 'dip')
    await saved(home, id, (p) => p.joins?.all?.kind === 'dip', 'every cut dips')
    let out = path.join(home, 'dips.mp4')
    await exportTo(app, win, out, 30)
    let frames = spots(out)
    const black = (c) => Math.max(...c) < 40
    // The first dip reaches black at its middle (4 s); the second (4.6 s) is a crossfade: never black.
    h.assert(black(frames[120].centre), `the first dip is black at its middle (${frames[120].centre})`)
    for (let i = Math.round(4.45 * 30); i <= Math.round(4.8 * 30); i++) h.assert(!black(frames[i].centre), `frame ${i} near the second cut is not black (${frames[i].centre})`)

    // A slide from the right (0.3 s here, half of B's 0.6 s): at T + 0.1 s of the first cut, A* (red) on the left, B (blue) on the right.
    await win.selectOption('[data-testid="cut-every"]', 'slide')
    await saved(home, id, (p) => p.joins?.all?.kind === 'slide', 'every cut slides')
    out = path.join(home, 'slide.mp4')
    await exportTo(app, win, out, 30)
    frames = spots(out)
    const s = frames[Math.round(4.1 * 30)]
    h.assert(isRed(s.left) && isBlue(s.right), `the slide's frame: red on the left (${s.left}), blue on the right (${s.right})`)
    h.assert(!frames.some((fr) => isGreenish(fr.left) || isGreenish(fr.centre) || isGreenish(fr.right)), 'no frame shows the secret')
  }))

  await test('editing polish E15: Polish smooths the cut in one undo step, Review lists and removes it, a chosen hard cut is kept', fx.withHome('polish-cuts-e15', async (ctx, home) => {
    const id = seed(home, { id: 'rec-polish-cuts', name: 'Polish cuts', clips: CLIPS })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Polish cuts')
    const before = h.readProject(home, id)
    const polish = async () => {
      await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      await win.keyboard.press('Shift+P')
      await win.locator('.polish-dialog[role="dialog"]').waitFor({ timeout: 10000 })
      await win.waitForSelector('[data-testid="polish-row-smoothCuts"]', { timeout: 10000 })
    }
    await polish()
    h.assert((await win.getAttribute('[data-testid="polish-row-smoothCuts"]', 'data-available')) === 'true', 'the Smooth cuts row is offered')
    const style = win.locator('[data-testid="polish-row-style"] select')
    if (await style.count()) await style.selectOption('')
    await win.waitForSelector('.polish-dialog .modal-foot button.primary:not([disabled])', { timeout: 10000 })
    await win.click('.polish-dialog .modal-foot button.primary:has-text("Polish")')
    await win.waitForSelector('[data-testid="polish-summary"]', { timeout: 60000 })
    h.assert((await win.textContent('[data-testid="polish-summary"]')).includes('Smooth cuts at 1 cut'), 'the summary counts the cut')
    await win.click('.polish-dialog .modal-foot button:has-text("Done")')
    await saved(home, id, (p) => p.joins?.all?.kind === 'smooth' && p.joins?.auto?.by === 'polish', 'Polish smoothed the cut with its record')
    // One undo step.
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => !('joins' in p) && JSON.stringify(p.style) === JSON.stringify(before.style), 'one undo takes the whole Polish back')
    await win.keyboard.press('Control+Shift+z')
    await saved(home, id, (p) => p.joins?.auto?.by === 'polish', 'redo')
    // Review mode lists it; Remove gives the hard cut back.
    await win.keyboard.press('Shift+R')
    await win.waitForSelector('[data-testid="review-panel"]', { timeout: 5000 })
    const row = '[data-testid="review-row"][data-key="join:all"]'
    await win.waitForSelector(row, { timeout: 5000 })
    h.assert((await win.textContent(row)).includes('Smooth cuts at 1 cut'), 'Review lists "Smooth cuts at 1 cut"')
    await win.click(`${row} [data-testid="review-remove"]`)
    await saved(home, id, (p) => !('joins' in p), 'Remove gives the hard cut back')
    await win.keyboard.press('Escape')
    // After Use hard cuts everywhere, Polish keeps them.
    await command(win, 'Use hard cuts everywhere')
    await saved(home, id, (p) => p.joins?.all?.kind === 'cut', 'hard cuts stored')
    await polish()
    h.assert((await win.textContent('[data-testid="polish-row-smoothCuts"]')).includes('Your cut style is kept'), 'Polish keeps a chosen cut style')
    await win.keyboard.press('Escape')
  }))

  await test('editing polish E16: the cut commands, a marker and the Cut style work from the keyboard', fx.withHome('polish-cuts-e16', async (ctx, home) => {
    const clips = [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 3, end: 5, speed: 1 },
      { id: 'c', start: 6, end: 10, speed: 1 }
    ]
    const id = seed(home, { id: 'rec-keys', name: 'Keys', clips })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Keys')
    await win.keyboard.press('Home')
    await command(win, 'Go to next cut')
    await win.waitForSelector('[data-testid="cut-style-section"]', { timeout: 5000 })
    h.assert((await win.textContent('[data-testid="cut-number"]')) === 'Cut 1 of 2', 'Go to next cut selects cut 1')
    await win.click('[data-testid="cut-next"]')
    await f.waitFor(async () => (await win.textContent('[data-testid="cut-number"]')) === 'Cut 2 of 2', 'Next cut goes to cut 2', 3000)
    await win.click('[data-testid="cut-prev"]')
    await f.waitFor(async () => (await win.textContent('[data-testid="cut-number"]')) === 'Cut 1 of 2', 'Previous cut goes back', 3000)
    // The radios by the arrow keys: from "Same as every cut" on to Hard cut, Smooth, Crossfade.
    await win.focus('[data-testid="cut-style"] [data-kind="same"] input')
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight')
    await saved(home, id, (p) => p.joins?.cuts?.[0]?.clip === 'b' && p.joins.cuts[0].kind === 'crossfade', 'Crossfade chosen with the arrow keys')
    await win.waitForSelector('[data-testid="cut-length"]', { timeout: 5000 })
    h.assert((await win.getAttribute('[data-testid="cut-length"]', 'aria-valuetext')) === '0.15 seconds', 'the Length reads 0.15 seconds')
    await win.focus('[data-testid="cut-length"]')
    await win.keyboard.press('PageUp')
    await saved(home, id, (p) => Math.abs((p.joins?.cuts?.[0]?.duration ?? 0) - 0.25) < 1e-9, 'Page Up adds 0.1 s')
    // A cut marker by the keyboard selects its cut.
    await win.keyboard.press('Escape')
    const marker = win.locator('[data-testid="cut-marker"][data-index="1"]')
    await marker.focus()
    h.assert((await marker.getAttribute('aria-label')).startsWith('Cut 2 of 2: 0:05.0 to 0:06.0, '), `the marker's name: ${await marker.getAttribute('aria-label')}`)
    await win.keyboard.press('Enter')
    await f.waitFor(async () => (await win.textContent('[data-testid="cut-number"]').catch(() => '')) === 'Cut 2 of 2', 'Enter on the marker selects cut 2', 3000)
    // Play this cut plays from 1 s before the cut and comes back.
    await win.click('[data-testid="cut-play"]')
    await h.sleep(2500)
    h.assert((await win.textContent('[data-testid="cut-number"]')) === 'Cut 2 of 2', 'still on cut 2 after Play this cut')
    // The Inspector still has 13 tabs.
    h.assert((await win.$$('.insp-tabs button')).length >= 13, 'the Inspector keeps its tabs')
  }))
}

module.exports = { cutsSteps }
