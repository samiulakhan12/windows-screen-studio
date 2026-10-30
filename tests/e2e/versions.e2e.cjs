// Versions, filmstrip and frame nudge (E-12, E-07, E-09, docs/design/versions.md §7) in the built
// app: save a named version, change the edit, compare, open the version (the edit comes back, the
// edit before it is kept as an automatic version, Ctrl+Z goes back), rename and delete; frames on
// the clip track made once and cached, hidden by their toggle; ← / Shift+→ move a selected text one
// and ten frames, one undo step per run of presses, and ← steps the playhead again after Esc.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_VERSIONS_SHOTS || null
const FRAME = 1 / 30

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

async function openSeeded(ctx, tag, opts, patch = {}) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 2))
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  await win.evaluate(() => localStorage.setItem('editor-snapping', '0'))
  await f.openProject(win, opts.name)
  return { home, id, win, dir: path.join(h.projectsRoot(home), id) }
}

const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const notice = (win, text) => win.waitForSelector(`.notice-text:has-text("${text}")`, { timeout: 10000 })
const rows = (win) => win.$$eval('[data-testid="version-row"]', (els) => els.map((e) => ({ name: e.querySelector('.version-name')?.textContent ?? '', auto: e.dataset.auto === 'true' })))
const onDisk = (home, id) => h.readProject(home, id)

/** The playhead's source time, as the timeline draws it. */
const playheadTime = (win) =>
  win.evaluate(() => {
    const m = /translateX\(([-\d.e]+)px\)/.exec(document.querySelector('.playhead').style.transform)
    return Number(m[1]) / Number(document.querySelector('.tl-content').dataset.pxPerSec)
  })

async function shot(win, name, selector) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  const box = await win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: Math.max(0, b.x - 12), y: Math.max(0, b.y - 12), width: b.width + 24, height: b.height + 24 }
  })
  await win.screenshot({ path: path.join(SHOTS, name), clip: box })
}

async function main() {
  await test('versions: save, compare, open (one undo step, the edit before kept), rename, delete', async (ctx) => {
    const { home, id, win, dir } = await openSeeded(ctx, 'versions', { name: 'Versions demo', seconds: 12, zooms: [{ id: 'z1', start: 1, end: 3, scale: 2, focus: { mode: 'cursor' }, auto: false }] })
    await win.click('[data-testid="versions-open"]')
    await win.waitForSelector('[data-testid="versions-dialog"]')
    await win.waitForSelector('.versions-empty')
    await win.fill('[data-testid="version-name"]', 'v1 for client')
    await win.keyboard.press('Enter')
    await notice(win, 'Saved “v1 for client”')
    await f.waitFor(async () => (await rows(win)).length === 1, 'the saved version listed')
    h.assert((await rows(win))[0].name === 'v1 for client', 'named as typed')
    const files = fs.readdirSync(path.join(dir, 'versions')).sort()
    h.assert(files.length === 2 && files.includes('index.json'), `a version file and the index: ${files}`)
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="versions-dialog"]', { state: 'detached' })

    // Change the edit: a second zoom at the playhead (6 s).
    await win.click('.tl-ruler', { position: { x: 10 + 6 * Number(await win.$eval('.tl-content', (el) => el.dataset.pxPerSec)), y: 8 } })
    await win.keyboard.press('z')
    await waitSaved(win)
    await f.waitFor(() => onDisk(home, id).zooms.length === 2, 'two zooms saved')

    // Compare: one zoom then, two now.
    await win.keyboard.press('Control+Shift+s')
    await win.waitForSelector('[data-testid="versions-dialog"]')
    h.assert(await win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'version-name'), 'Save a version focuses the name field')
    await win.click('[data-testid="version-row"] button:has-text("Compare")')
    await win.waitForSelector('[data-testid="version-compare"]')
    const table = await win.$eval('[data-testid="version-compare"]', (el) => el.textContent)
    h.assert(/Zooms\s*1\s*2/.test(table), `compare shows the zooms: ${table}`)
    await shot(win, 'versions-dialog.png', '[data-testid="versions-dialog"]')

    // Open it: the edit comes back as one undo step, and the edit before is kept automatically.
    await win.click('[data-testid="version-row"] button:has-text("Open")')
    await win.waitForSelector('[data-testid="versions-dialog"]', { state: 'detached' })
    await notice(win, 'Opened “v1 for client”')
    await waitSaved(win)
    await f.waitFor(() => onDisk(home, id).zooms.length === 1, 'the version in place')
    await win.keyboard.press('Control+z')
    await waitSaved(win)
    await f.waitFor(() => onDisk(home, id).zooms.length === 2, 'Ctrl+Z goes back to the edit before')
    await win.click('[data-testid="versions-open"]')
    await f.waitFor(async () => (await rows(win)).length === 2, 'the automatic version listed')
    const list = await rows(win)
    h.assert(list[0].auto && list[0].name === 'Before opening “v1 for client”', `automatic version first: ${JSON.stringify(list)}`)

    // Rename the named one, then delete it.
    const named = '[data-testid="version-row"][data-auto="false"]'
    await win.click(`${named} button:has-text("Rename")`)
    await win.fill(`${named} .version-rename`, 'Final cut')
    await win.keyboard.press('Enter')
    await f.waitFor(async () => (await rows(win)).some((r) => r.name === 'Final cut'), 'renamed')
    await win.click(`${named} button:has-text("Delete")`)
    await win.click('[data-testid="version-delete-confirm"]')
    await f.waitFor(async () => (await rows(win)).length === 1, 'deleted')
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'versions', 'index.json'), 'utf8'))
    h.assert(index.items.length === 1 && index.items[0].auto, 'the index keeps the automatic version only')
    h.assert(!ctx.logs.some((l) => l.includes('[pageerror]')), 'no page errors')
  })

  await test('filmstrip: frames on the clip track, made once and cached, hidden by its toggle', async (ctx) => {
    const { win, dir } = await openSeeded(ctx, 'filmstrip', { name: 'Filmstrip demo', seconds: 12 })
    const strip = '[data-testid="clip-filmstrip"][data-state="ready"]'
    await win.waitForSelector(strip, { timeout: 20000 })
    h.assert(fs.existsSync(path.join(dir, '.cache', 'filmstrip.jpg')) && fs.existsSync(path.join(dir, '.cache', 'filmstrip.json')), 'the sheet is cached')
    const count = Number(await win.$eval(strip, (el) => el.dataset.count))
    h.assert(count >= 47 && count <= 49, `a frame every 0.25 s: ${count}`)
    // Something is drawn: the canvas has opaque pixels in its middle row.
    const drawn = await win.$eval(strip, (c) => {
      const ctx2 = c.getContext('2d')
      const row = ctx2.getImageData(0, Math.floor(c.height / 2), c.width, 1).data
      let n = 0
      for (let i = 3; i < row.length; i += 4) if (row[i] > 100) n++
      return n / (row.length / 4)
    })
    h.assert(drawn > 0.8, `frames cover the track: ${drawn}`)
    await shot(win, 'versions-filmstrip.png', '.timeline')
    // Playing does not redraw it.
    const draws = await win.$eval(strip, (el) => el.dataset.draws)
    await win.keyboard.press('Space')
    await h.sleep(800)
    await win.keyboard.press('Space')
    h.assert((await win.$eval(strip, (el) => el.dataset.draws)) === draws, 'no redraw while playing')
    // The palette's toggle hides it, and it stays hidden.
    await win.keyboard.press('Control+k')
    await win.waitForSelector('.command-palette[role="dialog"]')
    await win.keyboard.type('frames on the clip')
    await h.sleep(200)
    await win.keyboard.press('Enter')
    await notice(win, 'Frames on the clip track off')
    await win.waitForSelector('[data-testid="clip-filmstrip"]', { state: 'detached' })
    h.assert((await win.evaluate(() => localStorage.getItem('editor-filmstrip'))) === 'off', 'remembered')
  })

  await test('nudge: arrows move a selected text one and ten frames, one undo step per run, the playhead after Esc', async (ctx) => {
    const { home, id, win } = await openSeeded(
      ctx,
      'nudge',
      { name: 'Nudge demo', seconds: 12 },
      { annotations: [{ id: 'a1', start: 5, end: 6, text: 'Hello', x: 0.5, y: 0.3, size: 0.05, style: 'pill' }] }
    )
    await win.click('[data-annotation="a1"]')
    await win.mouse.move(5, 5)
    await win.keyboard.press('ArrowRight')
    await notice(win, 'Moved 1 item 1 frame later')
    await waitSaved(win)
    await f.waitFor(() => Math.abs(onDisk(home, id).annotations[0].start - (5 + FRAME)) < 1e-6, 'one frame later')
    await h.sleep(900)
    await win.keyboard.press('Shift+ArrowLeft')
    await win.keyboard.press('Shift+ArrowLeft')
    await notice(win, 'Moved 1 item 20 frames earlier')
    await waitSaved(win)
    await f.waitFor(() => Math.abs(onDisk(home, id).annotations[0].start - (5 + FRAME - 20 * FRAME)) < 1e-6, 'twenty frames earlier')
    // The second run is one undo step.
    await win.keyboard.press('Control+z')
    await waitSaved(win)
    await f.waitFor(() => Math.abs(onDisk(home, id).annotations[0].start - (5 + FRAME)) < 1e-6, 'undo takes back the run')
    // Without a selection, → steps the playhead as before.
    await win.keyboard.press('Escape')
    const before = await playheadTime(win)
    await win.keyboard.press('ArrowRight')
    await f.waitFor(async () => Math.abs((await playheadTime(win)) - before - FRAME) < 0.004, 'the playhead stepped one frame')
    h.assert(Math.abs(onDisk(home, id).annotations[0].start - (5 + FRAME)) < 1e-6, 'the text stayed')
  })
}

main()
