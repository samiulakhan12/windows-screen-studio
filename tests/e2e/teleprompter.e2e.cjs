// Speaker notes (teleprompter, docs/design/teleprompter.md) in the real built app, under Xvfb with a
// window manager and real X input:
//  1. Home: notes typed in the Notes dialog, the count; a rehearsal window that is on top,
//     focusable, protected before its first show, absent from the window picker; Space scrolls,
//     Esc closes it and Home has the focus again.
//  2. Recording: the notes appear with the countdown (never focusable or focused, protected before
//     their first showInactive, shown before the bar, no animations), scroll once it starts with
//     at most 30 position writes a second.
//  3. Real input on the notes (buttons, text, wheel, hotkeys, dragging the strip) never becomes
//     recorded input; content clicks and the wheel elsewhere do, also where the notes were before
//     they were hidden; the bar's pause stops the writes; the script is kept with the recording.
//  4. Auto-pause counts scrolling notes as activity; 5. restart keeps the window, top of the text.
//  6. A notes hotkey another app holds is reported on the bar and the notes; the others work.
//  7. Older Windows (__SSW_CAPTURE_EXCLUSION__ = false): the Home warning, no notes in the
//     recording with the notice, rehearsal still works.
//  8. Draft script with the mock AI: no provider, a draft, Restore my notes, stale, Cancel.
//  9. The editor's "Your script": Copy script, Use as notes again (asking before replacing).
// 10. The recording bar fits its 600 DIP with every button and label.
// 11. Security: the bar's page cannot report or change the notes, the notes page cannot save
//     them, and text is never markup.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')
const { startMockAi, mockAiEnv } = require('./ai-mock-server.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))

/** Three short paragraphs, four bullets and a cue: 68 spoken words in 8 blocks. */
const FIXTURE = [
  'Welcome to this short tour of the dashboard. Today we add a new user and give them a role.',
  '',
  '[click Settings]',
  '- Open the Settings page',
  '- Choose Users in the menu',
  '- Click Add user and type their name',
  '- Pick a role and press Save',
  '',
  'That is all it takes. The new user gets an email with a link to sign in.',
  '',
  'Thanks for watching, and see you in the next video.'
].join('\n')
const FIXTURE_WORDS = 68
const FIXTURE_BLOCKS = 8

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** A window manager, so frameless windows move, stack and take focus as on a desktop. */
function startWindowManager() {
  const wm = spawn('openbox', [], { stdio: 'ignore' })
  wm.on('error', () => undefined)
  return wm
}

/** Holds a key grab like another app owning a hotkey (see xgrabkey.py); resolves once it holds it. */
async function grabKey(combo) {
  const p = spawn('python3', ['-I', path.join(__dirname, 'xgrabkey.py'), combo], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    p.on('error', reject)
    p.stdout.once('data', resolve)
  })
  return p
}

/** Logs setContentProtection, show and showInactive per window (main process), in order. */
function watchWindows(app) {
  return app.evaluate(({ BrowserWindow }) => {
    globalThis.__events = []
    const proto = BrowserWindow.prototype
    for (const name of ['setContentProtection', 'show', 'showInactive', 'focus', 'loadURL', 'loadFile']) {
      const original = proto[name]
      proto[name] = function (...args) {
        globalThis.__events.push({ id: this.id, name, on: name === 'setContentProtection' ? args[0] : undefined })
        return original.apply(this, args)
      }
    }
  })
}

const events = (app) => app.evaluate(() => globalThis.__events)

/** The notes window in the main process (null when there is none). */
function notesWindow(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('#/notes'))
    if (!w) return null
    return {
      id: w.id,
      url: w.webContents.getURL(),
      visible: w.isVisible(),
      onTop: w.isAlwaysOnTop(),
      focusable: w.isFocusable(),
      focused: w.isFocused(),
      bounds: w.getBounds(),
      sourceId: w.getMediaSourceId(),
      title: w.getTitle()
    }
  })
}

const toolbarId = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('#/toolbar'))?.id ?? null)

/** The notes window's page. */
const notesPage = (app) => r.until(() => app.windows().find((p) => p.url().endsWith('#/notes')), { what: 'notes window page' })

/** How far the text column has moved up (px). */
const columnY = (page) =>
  page.evaluate(() => {
    const m = /translate3d\(0px, (-?[\d.]+)px/.exec(document.querySelector('.nw-column').style.transform || '')
    return m ? -Number(m[1]) : 0
  })

const dataOf = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('.notes-window').dataset
    return { playing: d.playing === 'true', ended: d.ended === 'true', block: Number(d.block) }
  })

/** Counts writes to the column's style from now on (window.__writes). */
const countWrites = (page) =>
  page.evaluate(() => {
    window.__writes = 0
    window.__observer?.disconnect()
    window.__observer = new MutationObserver((list) => (window.__writes += list.length))
    window.__observer.observe(document.querySelector('.nw-column'), { attributes: true, attributeFilter: ['style'] })
  })
const writes = (page) => page.evaluate(() => window.__writes)

/** The notes window's box against the page's viewport (it should fill it exactly). */
const windowBox = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('.notes-window').getBoundingClientRect()
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: innerWidth, height: innerHeight }
  })
const fills = (b) => b.left === 0 && b.top === 0 && b.right === b.width && b.bottom === b.height

/** A keydown as another keyboard layout sends it (`key` the character, `code` the key's place). */
const keyDown = (page, init) => page.evaluate((i) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init)

const savedNotes = (win) => win.evaluate(() => window.api.getNotes()).then((s) => s.settings)

/** Screen coordinates of the centre of `selector` in the notes window. */
async function notesPoint(app, page, selector) {
  const w = await notesWindow(app)
  const box = await (await page.$(selector)).boundingBox()
  return { x: Math.round(w.bounds.x + box.x + box.width / 2), y: Math.round(w.bounds.y + box.y + box.height / 2) }
}

/** Types the fixture into the Notes dialog (opened from the card) and closes it. */
async function addNotes(win, text = FIXTURE) {
  await win.click('.notes-card button:has-text("Add notes"), .notes-card button:has-text("Edit notes")')
  await win.waitForSelector('.notes-modal textarea')
  await win.fill('.notes-modal textarea', text)
  await win.waitForSelector('.notes-saved.saved', { timeout: 5000 })
  await win.click('.notes-modal button:has-text("Done")')
  await win.waitForSelector('.notes-modal', { state: 'detached' })
}

async function launchApp(ctx, name, opts = {}) {
  const home = h.tempHome(name)
  const { app, win, logs } = await h.launch({ home, ...opts })
  ctx.app = r.closable(app)
  ctx.logs = logs
  await win.waitForSelector('.notes-card', { timeout: 30000 })
  return { home, app, win }
}

async function main() {
  const wm = startWindowManager()
  try {
    await test('notes: Home dialog and count, rehearsal window on top, focusable, protected, not pickable; Space scrolls, Esc closes', async (ctx) => {
      const { app, win } = await launchApp(ctx, 'tp-rehearse')
      await win.waitForSelector('.notes-card[data-has-notes="false"]')
      h.assert((await win.textContent('.notes-card')).includes('Only you see them'), 'the empty card explains the notes')
      await win.click('.notes-card button:has-text("Add notes")')
      await win.waitForSelector('.notes-modal textarea')
      h.assert(await win.evaluate(() => document.activeElement?.classList.contains('notes-textarea')), 'the dialog opens with the text field focused')
      await win.fill('.notes-modal textarea', FIXTURE)
      await win.waitForSelector('.notes-saved.saved', { timeout: 5000 })
      const count = await win.textContent('.notes-count')
      h.assert(count.startsWith(`${FIXTURE_WORDS} words · about `), `the count shows the fixture's words: ${count}`)
      h.assert((await win.getAttribute('.notes-count', 'aria-live')) === null, 'the count is not a live region (it changes with every word)')
      // Tab stays inside the dialog; Esc closes it and the focus goes back to the button.
      for (let i = 0; i < 40; i++) await win.keyboard.press('Tab')
      h.assert(await win.evaluate(() => !!document.activeElement?.closest('.notes-modal')), 'Tab stays inside the dialog')
      await win.keyboard.press('Escape')
      await win.waitForSelector('.notes-modal', { state: 'detached' })
      // The dialog was opened from "Add notes…", which became "Edit notes…" with the first word typed.
      const back = await win.evaluate(() => ({ opener: !!document.activeElement?.matches('.notes-card button[aria-haspopup="dialog"]'), text: document.activeElement?.textContent }))
      h.assert(back.opener && back.text === 'Edit notes…', `focus is back on the card's button: ${JSON.stringify(back)}`)
      const summary = await win.textContent('.notes-summary')
      h.assert(summary === `${FIXTURE_WORDS} words · about 31 s at 130 words a minute`, `the card's summary: ${summary}`)
      h.assert((await (await win.evaluate(() => window.api.getNotes())).settings.text) === FIXTURE, 'the text was saved')

      await watchWindows(app)
      await win.click('.notes-card button:has-text("Rehearse")')
      const page = await notesPage(app)
      await page.waitForSelector('.nw-block')
      const nw = await r.until(async () => {
        const w = await notesWindow(app)
        return w && w.visible ? w : null
      }, { what: 'rehearsal window shown' })
      const box = await windowBox(page)
      h.assert(fills(box), `the notes fill their window (the dialog's .notes-body rule does not reach the page's body): ${JSON.stringify(box)}`)
      h.assert(nw.url.endsWith('#/notes') && nw.onTop && nw.focusable === true, `rehearsal window: ${JSON.stringify(nw)}`)
      const ev = (await events(app)).filter((e) => e.id === nw.id)
      const protectedAt = ev.findIndex((e) => e.name === 'setContentProtection' && e.on === true)
      const firstShow = ev.findIndex((e) => e.name === 'show' || e.name === 'showInactive')
      const load = ev.findIndex((e) => e.name === 'loadURL' || e.name === 'loadFile')
      h.assert(protectedAt >= 0 && protectedAt < firstShow && (load < 0 || protectedAt < load), `protected before it loads and before its first show: ${JSON.stringify(ev)}`)
      h.assert(ev[firstShow].name === 'show', `a rehearsal window is shown with show(): ${JSON.stringify(ev)}`)
      await win.waitForSelector('.notes-card button[aria-pressed="true"]:has-text("Stop rehearsing")')
      h.assert((await page.textContent('.nw-status')) === 'Rehearsing: not recording', 'rehearsal status')
      h.assert((await page.$$('.nw-block')).length === FIXTURE_BLOCKS, 'one block per line')
      h.assert((await page.$$('.nw-block.bullet')).length === 4 && (await page.textContent('.nw-cue')) === '[click Settings]', 'bullets and the cue')

      // The window picker never offers it.
      const sources = await win.evaluate(() => window.api.getSources(['window']))
      h.assert(!sources.some((s) => s.id === nw.sourceId || s.name === nw.title || s.name === 'Speaker notes'), `not in the window picker: ${JSON.stringify(sources.map((s) => s.name))}`)

      // Keyboard: Space plays, the text moves within 1.5 s; ↓ goes forward a block.
      const y0 = await columnY(page)
      await page.keyboard.press('Space')
      await r.until(async () => (await columnY(page)) > y0 + 2, { what: 'text scrolling after Space', timeout: 1500 })
      h.assert((await dataOf(page)).playing, 'data-playing')
      h.assert((await page.textContent('.nw-status')) === 'Scrolling', 'status Scrolling')
      await page.keyboard.press('Space')
      await r.until(async () => !(await dataOf(page)).playing, { what: 'paused by Space' })
      await page.keyboard.press('ArrowDown')
      await r.until(async () => (await dataOf(page)).block === 1, { what: 'forward a block' })
      await page.keyboard.press('End')
      await r.until(async () => (await dataOf(page)).ended, { what: 'End goes to the end' })
      h.assert((await page.textContent('.nw-status')) === 'End of notes', 'status End of notes')
      await page.click('.nw-restart')
      await r.until(async () => (await dataOf(page)).block === 0 && (await columnY(page)) === 0, { what: 'Back to start' })
      // The end stops the scrolling: back at the top it stays still, and one Space plays again.
      await page.keyboard.press('Space')
      await r.until(async () => (await dataOf(page)).playing, { what: 'playing before the end' })
      await page.keyboard.press('End')
      await r.until(async () => (await dataOf(page)).ended && !(await dataOf(page)).playing, { what: 'the end reached while playing' })
      await page.keyboard.press('Home')
      await r.until(async () => !(await dataOf(page)).ended && (await columnY(page)) === 0, { what: 'Home from the end' })
      await h.sleep(1000)
      const still = { y: await columnY(page), ...(await dataOf(page)), status: await page.textContent('.nw-status') }
      h.assert(still.y === 0 && !still.playing && still.status === 'Rehearsing: not recording', `still at the top after the end: ${JSON.stringify(still)}`)
      await page.keyboard.press('Space')
      await r.until(async () => (await dataOf(page)).playing && (await columnY(page)) > 2, { what: 'one Space plays after the end', timeout: 1500 })
      await page.keyboard.press('Space')
      await r.until(async () => !(await dataOf(page)).playing, { what: 'paused after the end' })
      await page.keyboard.press('Home')
      await r.until(async () => (await columnY(page)) === 0, { what: 'back at the top' })
      // Speed and text size from the keyboard are saved.
      await page.keyboard.press('Equal')
      await r.until(async () => (await savedNotes(win)).wpm === 140, { what: 'speed +10 saved' })
      await page.keyboard.press('Control+Minus')
      await r.until(async () => (await savedNotes(win)).fontSize === 30, { what: 'text size -2 saved' })
      // The characters count, not the keys' places: + and - on a German keyboard (BracketRight,
      // Slash); its dead key in the place of the US = does nothing.
      await keyDown(page, { key: '+', code: 'BracketRight' })
      await r.until(async () => (await savedNotes(win)).wpm === 150, { what: 'speed +10 from a German +' })
      await keyDown(page, { key: 'Dead', code: 'Equal' })
      await keyDown(page, { key: '-', code: 'Slash', ctrlKey: true })
      await r.until(async () => (await savedNotes(win)).fontSize === 28, { what: 'text size -2 from a German Ctrl + -' })
      h.assert((await savedNotes(win)).wpm === 150, 'a dead key changes nothing')
      await keyDown(page, { key: '-', code: 'Slash' })
      await keyDown(page, { key: '+', code: 'BracketRight', ctrlKey: true })
      await r.until(async () => {
        const s = await savedNotes(win)
        return s.wpm === 140 && s.fontSize === 30
      }, { what: 'speed -10 and text size +2 from a German keyboard' })
      // A button clicked with the mouse gives the focus back (just after its click), so Space
      // still plays and pauses instead of pressing it again.
      await page.click('.nw-btn[aria-label="Larger text"]')
      await r.until(async () => (await savedNotes(win)).fontSize === 32, { what: 'text size +2 from its button' })
      await r.until(() => page.evaluate(() => !document.activeElement?.closest('button')), { what: 'the clicked button gives the focus back', timeout: 3000 })
      await page.keyboard.press('Space')
      await r.until(async () => (await dataOf(page)).playing, { what: 'Space plays after a click on a button' })
      h.assert((await savedNotes(win)).fontSize === 32, 'Space did not press the button again')
      await page.keyboard.press('Space')
      await r.until(async () => !(await dataOf(page)).playing, { what: 'Space pauses after a click on a button' })
      h.assert((await page.evaluate(() => document.getAnimations().length)) === 0, 'no animations in the notes page')

      // Dragging the strip moves the window and saves where it was left; the grip resizes it.
      const at = (await notesWindow(app)).bounds
      const grab = await notesPoint(app, page, '.nw-status')
      await r.xinput(`d ${grab.x} ${grab.y} ${grab.x + 300} ${grab.y + 100} 0.6; s 0.8`)
      const dragged = (await notesWindow(app)).bounds
      // The window manager starts a move after a few pixels, so it lags the pointer by those.
      h.assert(Math.abs(dragged.x - at.x - 300) <= 12 && Math.abs(dragged.y - at.y - 100) <= 12, `dragged by its strip: ${JSON.stringify(at)} -> ${JSON.stringify(dragged)}`)
      // (Electron emits 'moved', which saves the place, on Windows and macOS only: here the grip saves it.)
      const grip = await notesPoint(app, page, '.nw-grip')
      await r.xinput(`d ${grip.x} ${grip.y} ${grip.x + 100} ${grip.y + 60} 0.6; s 1`)
      await r.until(async () => {
        const s = (await win.evaluate(() => window.api.getNotes())).settings
        return s.width === 660 && s.height === 300
      }, { what: 'resized by the grip and saved' })
      h.assert(!!(await win.evaluate(() => window.api.getNotes())).settings.placement, 'where it was left is saved')
      const resized = (await notesWindow(app)).bounds
      h.assert(Math.abs(resized.x - dragged.x) <= 1 && Math.abs(resized.y - dragged.y) <= 1 && resized.width === 660 && resized.height === 300, `the grip keeps the top-left: ${JSON.stringify(resized)}`)
      // Wider than the dialog's two-column breakpoint (760), the notes still fill the window.
      await page.evaluate(() => window.api.setNotesLook({ width: 800 }))
      await r.until(() => page.evaluate(() => window.innerWidth === 800), { what: 'notes window 800 DIP wide' })
      const wide = await windowBox(page)
      h.assert(fills(wide), `the notes fill an 800 DIP window: ${JSON.stringify(wide)}`)

      // Esc closes the window (and so its page, before the key is released).
      await page.keyboard.press('Escape').catch(() => undefined)
      await r.until(async () => !(await notesWindow(app)), { what: 'rehearsal window closed' })
      await r.until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().endsWith('#/') ?? false), { what: 'main window focused', timeout: 5000 })
      await win.waitForSelector('.notes-card button[aria-pressed="false"]:has-text("Rehearse")')
    })

    await test('notes while recording: countdown, protected and never focused, at most 30 writes a second; real input never recorded; kept with the recording; editor "Your script"', async (ctx) => {
      const { home, app, win } = await launchApp(ctx, 'tp-record')
      await r.waitForSources(win)
      await addNotes(win)
      // Slow, so the text keeps scrolling through the whole test.
      await win.evaluate(() => window.api.updateNotes({ wpm: 60 }))
      await watchWindows(app)
      await r.readyToRecord(win)
      await win.click('button.record')
      const tb = await r.toolbar(app)
      await tb.waitForSelector('.countdown-number', { timeout: 15000 })

      // 2. With the countdown: visible, never focusable or focused, still at the top.
      const page = await notesPage(app)
      const nw = await r.until(async () => {
        const w = await notesWindow(app)
        return w && w.visible ? w : null
      }, { what: 'notes shown in the countdown' })
      h.assert(nw.focusable === false && nw.focused === false && nw.onTop, `the recording's notes window: ${JSON.stringify(nw)}`)
      await page.waitForSelector('.nw-block')
      h.assert((await page.textContent('.nw-status')) === 'Starts with the recording', 'countdown status')
      h.assert(await page.$('.nw-play[aria-pressed="true"][aria-label="Pause scrolling"]'), 'the play button shows that the text will start with the recording')
      h.assert((await dataOf(page)).block === 0 && !(await dataOf(page)).playing, 'still at the top during the countdown')
      h.assert((await page.evaluate(() => document.getAnimations().length)) === 0, 'no animations')
      const ev = await events(app)
      const mine = ev.filter((e) => e.id === nw.id)
      const prot = mine.findIndex((e) => e.name === 'setContentProtection' && e.on === true)
      const firstShow = mine.findIndex((e) => e.name === 'showInactive' || e.name === 'show')
      h.assert(prot >= 0 && prot < firstShow, `protected before its first show: ${JSON.stringify(mine)}`)
      h.assert(mine.every((e) => e.name !== 'show' && e.name !== 'focus'), `never show() or focus() while recording: ${JSON.stringify(mine)}`)
      // showNotes() is called before showToolbar() on every countdown status, but it waits for the
      // page's ready-to-show, so on the first status the bar is usually shown first (logged; the two
      // do not overlap in their default places). What must hold: shown inactive within the countdown.
      const barId = await toolbarId(app)
      const notesShownAt = ev.findIndex((e) => e.id === nw.id && e.name === 'showInactive')
      const barShownAt = ev.findIndex((e) => e.id === barId && (e.name === 'showInactive' || e.name === 'show'))
      h.assert(notesShownAt >= 0, `notes shown inactive in the countdown: ${JSON.stringify(ev)}`)
      console.log(`  first shown: ${barShownAt >= 0 && barShownAt < notesShownAt ? 'the bar, then the notes' : 'the notes, then the bar'}`)

      // Scrolling once the recording starts, at most 30 writes a second.
      await tb.waitForSelector('button.stop', { timeout: 20000 })
      await r.until(async () => (await dataOf(page)).playing && (await columnY(page)) > 0, { what: 'scrolling after the start' })
      await tb.waitForSelector('button.notes[aria-pressed="true"]')
      await countWrites(page)
      const yStart = await columnY(page)
      await h.sleep(3000)
      const n = await writes(page)
      h.assert(n > 0 && n <= 93, `style writes in 3 s: ${n}`)
      h.assert((await columnY(page)) > yStart, 'the text moved')
      h.assert((await page.evaluate(() => document.getAnimations().length)) === 0, 'no animations while recording')
      await tb.waitForSelector('button.notes .rb-notes-dot')

      // 3. Real input on the notes.
      const pauseBtn = await notesPoint(app, page, '.nw-play')
      await r.xinput(`m ${pauseBtn.x} ${pauseBtn.y}; s 0.2; c ${pauseBtn.x} ${pauseBtn.y}; s 0.4`)
      await r.until(async () => !(await dataOf(page)).playing, { what: 'paused by its button' })
      const body = await notesPoint(app, page, '.nw-text')
      await r.xinput(`c ${body.x} ${body.y}; s 0.4`)
      h.assert(!(await dataOf(page)).playing, 'clicking the text does nothing')
      const yWheel = await columnY(page)
      await r.xinput(`w ${body.x} ${body.y} 3; s 0.5`)
      h.assert((await columnY(page)) > yWheel, 'the wheel moved the text')
      h.assert(!(await notesWindow(app)).focused, 'still not focused after clicks')

      await r.xinput('k ctrl+shift+F7; s 0.3')
      await r.until(async () => (await dataOf(page)).playing, { what: 'played by the hotkey' })
      await r.xinput('k ctrl+shift+F7; s 0.2')
      await r.until(async () => !(await dataOf(page)).playing, { what: 'paused by the hotkey' })
      const yStill = await columnY(page)
      await h.sleep(1000)
      h.assert((await columnY(page)) === yStill, 'still for 1 s while paused')
      const b0 = (await dataOf(page)).block
      await r.xinput('k ctrl+shift+F8; s 0.5')
      await r.until(async () => (await dataOf(page)).block === b0 + 1, { what: 'forward by the hotkey' })
      await r.xinput('k ctrl+shift+F6; s 0.5')
      await r.until(async () => (await dataOf(page)).block === b0, { what: 'back by the hotkey' })

      // Drag the window by its strip (the status text is part of the drag area).
      const before = (await notesWindow(app)).bounds
      const grab = await notesPoint(app, page, '.nw-status')
      await r.xinput(`d ${grab.x} ${grab.y} ${grab.x + 300} ${grab.y} 0.6; s 0.8`)
      const moved = (await notesWindow(app)).bounds
      // A window that cannot take focus is not moved by -webkit-app-region under X11 (it is on
      // Windows, as the recording bar is): logged here, asserted in the rehearsal test.
      console.log(`  notes window dragged while recording: ${JSON.stringify(before)} -> ${JSON.stringify(moved)}`)

      // Content input, then a click where the notes were once they are hidden.
      await r.xinput('k ctrl+shift+F7; s 0.2; c 400 300; s 0.6; c 1500 800; s 0.4; w 960 540 2; s 0.5')
      await tb.click('button.notes')
      await r.until(async () => (await notesWindow(app))?.visible === false, { what: 'notes hidden from the bar' })
      await tb.waitForSelector('button.notes[aria-label="Show notes"]')
      await h.sleep(500)
      const former = { x: Math.round(moved.x + moved.width / 2), y: Math.round(moved.y + moved.height / 2) }
      await r.xinput(`c ${former.x} ${former.y}; s 0.5`)
      await tb.click('button.notes')
      await r.until(async () => (await notesWindow(app))?.visible === true, { what: 'notes shown again' })
      await r.until(async () => (await dataOf(page)).playing, { what: 'scrolling again once shown' })

      // The bar's pause stops every write; resuming starts them again.
      await tb.click('button.pause')
      await tb.waitForSelector('.rec-dot.paused')
      await r.until(async () => (await page.textContent('.nw-status')) === 'Recording paused', { what: 'Recording paused status' })
      await countWrites(page)
      await h.sleep(2000)
      h.assert((await writes(page)) === 0, 'no writes while the recording is paused')
      await tb.click('button.pause')
      await tb.waitForSelector('.rec-dot:not(.paused)')
      await r.until(async () => (await writes(page)) > 0, { what: 'writes again after resume', timeout: 3000 })
      await h.sleep(800)
      await tb.click('button.stop')
      await win.waitForSelector('.editor canvas', { timeout: 120000 })
      h.assert(!(await notesWindow(app)), 'the notes window is gone after the recording')

      const [id] = h.listProjects(home)
      const dir = path.join(h.projectsRoot(home), id)
      const project = h.readProject(home, id)
      const cursor = JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8'))
      const near = (c, x, y) => Math.abs(c.x - x / 1920) < 0.01 && Math.abs(c.y - y / 1080) < 0.01
      console.log(`  clicks ${JSON.stringify(cursor.clicks)}`)
      console.log(`  scrolls ${JSON.stringify(cursor.scrolls)}`)
      h.assert(cursor.clicks.length === 3, `exactly the three content clicks: ${JSON.stringify(cursor.clicks)}`)
      h.assert(near(cursor.clicks[0], 400, 300) && near(cursor.clicks[1], 1500, 800) && near(cursor.clicks[2], former.x, former.y), `click positions ${JSON.stringify(cursor.clicks)}`)
      h.assert((cursor.scrolls || []).length > 0 && cursor.scrolls.every((s) => near(s, 960, 540)), `every scroll at (960, 540): ${JSON.stringify(cursor.scrolls)}`)
      const labels = (cursor.keys || []).map((k) => k.label)
      h.assert(!labels.some((l) => /F6|F7|F8/.test(l)), `no notes hotkey recorded: ${JSON.stringify(labels)}`)
      for (const z of project.zooms) h.assert(cursor.clicks.some((c) => c.t >= z.start && c.t <= z.end), `zoom ${z.start}-${z.end} comes from a content click`)
      h.assert(project.script && project.script.text === FIXTURE, `project.script.text is the notes: ${JSON.stringify(project.script)}`)
      h.assert(fs.readFileSync(path.join(dir, 'script.txt'), 'utf8') === FIXTURE, 'script.txt kept in the recording folder')

      // 9. The editor's "Your script".
      await win.click('.insp-tabs button[title="Captions"]')
      await win.waitForSelector('.captions-script-head')
      h.assert((await win.getAttribute('.captions-script-head', 'aria-expanded')) === 'false', 'folded by default')
      await win.click('.captions-script-head')
      await win.click('button:has-text("Copy script")')
      await r.until(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === FIXTURE, { what: 'script on the clipboard' })
      await win.evaluate(() => window.api.updateNotes({ text: 'Something else' }))
      await win.click('button:has-text("Use as notes again")')
      await win.waitForSelector('text=Replace your current notes?')
      await win.click('.captions-script button:has-text("Replace")')
      await r.until(async () => (await win.evaluate(() => window.api.getNotes())).settings.text === FIXTURE, { what: 'the script is the notes again' })
    })

    await test('notes: auto-pause counts scrolling notes as activity; restart keeps the window at the top; the bar page cannot report or change the notes', async (ctx) => {
      const { app, win } = await launchApp(ctx, 'tp-idle')
      await r.waitForSources(win)
      await addNotes(win)
      await win.evaluate(() => Promise.all([window.api.updateNotes({ wpm: 60 }), window.api.updateRecordingSettings({ autoPause: true, idleSeconds: 3 })]))
      await win.reload()
      await win.waitForSelector('.notes-card')
      const tb = await r.startRecording(app, win)
      const page = await notesPage(app)
      await r.until(async () => (await dataOf(page)).playing, { what: 'notes scrolling' })

      // 11. The bar's page reports and looks nothing.
      await tb.evaluate(() => {
        window.api.reportNotes({ playing: false, ended: true, block: 5 })
        window.api.setNotesLook({ wpm: 220, fontSize: 72 })
      })
      await h.sleep(500)
      const state = await win.evaluate(() => window.api.getNotes())
      h.assert(state.window && state.window.playing === true, `the bar cannot report for the notes: ${JSON.stringify(state.window)}`)
      h.assert(state.settings.wpm === 60 && state.settings.fontSize === 32, `the bar cannot change the look: ${JSON.stringify(state.settings)}`)
      const rejected = await page.evaluate(() => window.api.updateNotes({ text: 'from the notes page' }).then(() => false, () => true))
      h.assert(rejected, 'updateNotes from the notes window is refused')

      // 4. Six seconds without input while the notes scroll: never paused.
      const end = Date.now() + 6000
      while (Date.now() < end) {
        h.assert(!(await tb.$('.tb-state.idle')), 'not paused (idle) while the notes scroll')
        await h.sleep(200)
      }
      await r.xinput('k ctrl+shift+F7')
      await r.until(async () => !(await dataOf(page)).playing, { what: 'notes paused by the hotkey' })
      await tb.waitForSelector('.tb-state.idle', { timeout: 8000 })

      // 5. Restart: the same window, and the next take starts at the top.
      await r.xinput('k ctrl+shift+F8; s 0.3; k ctrl+shift+F8; s 0.5')
      await r.until(async () => (await dataOf(page)).block >= 1, { what: 'moved forward' })
      const id = (await notesWindow(app)).id
      await tb.click('button.restart')
      await tb.waitForSelector('.toolbar.confirm.restart')
      await tb.click('.tb-text-btn.danger')
      await tb.waitForSelector('.countdown-number, .countdown-starting', { timeout: 20000 })
      await r.until(async () => (await notesWindow(app))?.visible === true, { what: 'notes shown for the next take' })
      h.assert((await notesWindow(app)).id === id, 'the same notes window for the next take')
      await r.until(async () => (await dataOf(page)).block === 0 && (await columnY(page)) === 0, { what: 'the next take at the top' })
      await tb.waitForSelector('button.stop', { timeout: 20000 })
      await tb.click('button.discard')
      await tb.waitForSelector('.toolbar.confirm.discard')
      await tb.click('.tb-text-btn.danger')
      await r.until(async () => !(await notesWindow(app)), { what: 'notes window closed after discarding' })
    })

    await test('notes: a hotkey another app holds is reported on the bar and the notes, the others work; the bar fits 600 DIP', async (ctx) => {
      const grab = await grabKey('ctrl+shift+F7')
      try {
        const { app, win } = await launchApp(ctx, 'tp-clash', { args: r.FAKE_MEDIA })
        await r.waitForSources(win)
        const selects = await win.$$('.record-panel select')
        await selects[0].selectOption({ index: 1 })
        await selects[1].selectOption({ index: 1 })
        await addNotes(win)
        await win.evaluate(() => Promise.all([window.api.updateNotes({ wpm: 60 }), window.api.updateRecordingSettings({ autoPause: true, idleSeconds: 3 })]))
        const tb = await r.startRecording(app, win)
        const page = await notesPage(app)
        await page.waitForSelector('.nw-warn', { timeout: 10000 })
        const notesProblem = await page.getAttribute('.nw-warn', 'title')
        h.assert(/Notes: play \/ pause/.test(notesProblem), `the notes' ! names the hotkey: ${notesProblem}`)
        await tb.waitForSelector('.tb-warn')
        const barProblem = await tb.getAttribute('.tb-warn', 'title')
        h.assert(/Notes: play \/ pause/.test(barProblem), `the bar's ! names the hotkey: ${barProblem}`)
        const b0 = (await dataOf(page)).block
        await r.xinput('k ctrl+shift+F8; s 0.5')
        await r.until(async () => (await dataOf(page)).block === b0 + 1, { what: 'F8 still works' })
        await r.xinput('k ctrl+shift+F6; s 0.5')
        await r.until(async () => (await dataOf(page)).block === b0, { what: 'F6 still works' })

        // 10. Every button and label in 600 DIP: notes, camera, mic, the problem, "Zoom marked".
        const fits = () => tb.evaluate(() => {
          const bar = document.querySelector('.rec-bar')
          return { fits: bar.scrollWidth <= bar.clientWidth, scroll: bar.scrollWidth, client: bar.clientWidth, window: window.innerWidth }
        })
        await tb.waitForSelector('button.notes')
        await tb.waitForSelector('button.camera')
        await tb.waitForSelector('button.mic')
        await r.xinput('k ctrl+shift+F10')
        await tb.waitForSelector('.tb-mark', { timeout: 3000 })
        let f = await fits()
        h.assert(f.fits && f.window === 600, `the bar fits with "Zoom marked": ${JSON.stringify(f)}`)
        // Paused (idle): the notes paused from their own button, then no input.
        await page.click('.nw-play')
        await tb.waitForSelector('.tb-state.idle', { timeout: 8000 })
        await r.xinput('k ctrl+shift+F10')
        f = await fits()
        h.assert(f.fits, `the bar fits with "Paused (idle)": ${JSON.stringify(f)}`)
        // The narrowest notes window keeps every control, the "!", × and the grip inside it.
        await page.evaluate(() => window.api.setNotesLook({ width: 320 }))
        await r.until(() => page.evaluate(() => window.innerWidth === 320), { what: 'notes window 320 DIP wide' })
        const strip = await page.evaluate(() =>
          ['.nw-warn', '.nw-close', '.nw-grip, .nw-lock', '.nw-btn[aria-label="Larger text"]'].map((sel) => {
            const el = document.querySelector(sel)
            const b = el.getBoundingClientRect()
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
            return { sel, left: Math.round(b.left), right: Math.round(b.right), inside: b.right <= innerWidth && !!hit && el.contains(hit) }
          })
        )
        h.assert(strip.every((x) => x.inside), `the strip fits 320 DIP: ${JSON.stringify(strip)}`)
        await tb.click('button.discard')
        await tb.waitForSelector('.toolbar.confirm.discard')
        await tb.click('.tb-text-btn.danger')
      } finally {
        grab.kill()
      }
    })

    await test('notes on older Windows: the Home warning, hidden in the recording with the notice, rehearsal still works; text is never markup', async (ctx) => {
      const { app, win } = await launchApp(ctx, 'tp-older')
      await r.waitForSources(win)
      await app.evaluate(() => {
        globalThis.__SSW_CAPTURE_EXCLUSION__ = false
      })
      await win.evaluate((t) => window.api.updateNotes({ text: t }), FIXTURE)
      await win.reload()
      await win.waitForSelector('.notes-card .notes-older[role="note"]')
      h.assert((await win.textContent('.notes-older')).includes('Windows 10 version 2004 or later keeps them out of the video'), 'the Home warning')
      const tb = await r.startRecording(app, win)
      await h.sleep(1000)
      h.assert(!(await notesWindow(app)), 'no notes window over the recorded screen')
      h.assert(!(await tb.$('button.notes')), 'no notes button on the bar')
      await tb.click('button.discard')
      await tb.waitForSelector('.toolbar.confirm.discard')
      await tb.click('.tb-text-btn.danger')
      await win.waitForSelector('.record-panel .notice', { timeout: 20000 })
      const notice = await win.textContent('.record-panel .notice')
      h.assert(notice.includes('Your notes stay hidden in this recording'), `the notice is listed: ${notice}`)

      // Rehearsal still opens; markup is shown as text.
      await win.evaluate(() => window.api.updateNotes({ text: 'Hello <img src=x onerror="window.__owned = 1"> <b>bold</b>' }))
      await win.click('.notes-card button:has-text("Rehearse")')
      const page = await notesPage(app)
      await page.waitForSelector('.nw-block')
      h.assert((await page.$$('.notes-window img, .notes-window b')).length === 0, 'no element from the text')
      h.assert((await page.textContent('.nw-block')).includes('<img src=x'), 'the markup shows as text')
      h.assert(!(await page.evaluate(() => window.__owned)), 'nothing ran')
      await win.click('.notes-card button:has-text("Stop rehearsing")')
      await r.until(async () => !(await notesWindow(app)), { what: 'rehearsal closed from Home' })
    })

    const ai = await startMockAi({ ffmpeg: FF })
    try {
      await test('draft script: no provider, a draft replaces the notes, Restore my notes, stale while typing, Cancel', async (ctx) => {
        const { app, win } = await launchApp(ctx, 'tp-draft', { env: mockAiEnv(ai.url) })
        // Xvfb has no keyring; Chromium's basic store is turned on from outside, as ai.e2e.cjs does.
        await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
        const bullets = '- Open Settings\n- Click Add user\n- Pick a role'
        await win.click('.notes-card button:has-text("Add notes")')
        await win.waitForSelector('.notes-modal textarea')
        h.assert(await win.isDisabled('.notes-draft-btn'), 'Draft script is disabled for empty notes')
        h.assert((await win.getAttribute('.notes-draft-btn', 'title')) === 'Write a few bullet points first.', 'empty notes title')
        await win.fill('.notes-modal textarea', bullets)

        // No provider: the explanation, and Add an AI provider opens the settings.
        await win.click('.notes-draft-btn')
        await win.waitForSelector('text=Draft script needs an AI provider with your own key')
        await win.click('.notes-draft button:has-text("Add an AI provider")')
        await win.waitForSelector('.settings-backdrop')
        await win.keyboard.press('Escape')
        await win.waitForSelector('.settings-backdrop', { state: 'detached' })
        h.assert(await win.$('.notes-modal'), 'the Notes dialog stays open behind the settings')

        await win.evaluate(() => window.api.saveAiProvider({ kind: 'anthropic', label: 'Claude', apiKey: 'sk-ant-e2e-notes-key-0001' }))
        await win.evaluate(() => window.dispatchEvent(new Event('ssw:ai-providers-changed')))
        await win.waitForSelector('text=Only these notes are sent to Claude, with your key.')
        await win.click('.notes-draft-btn')
        await win.waitForSelector('text=Script drafted from your notes. Read it through before you record.', { timeout: 20000 })
        const drafted = await win.inputValue('.notes-modal textarea')
        h.assert(drafted === 'Point: Open Settings.\n\nPoint: Click Add user.\n\nPoint: Pick a role.', `the draft replaced the notes in order: ${JSON.stringify(drafted)}`)
        const sent = ai.requests.filter((q) => q.provider === 'anthropic' && q.route === '/v1/messages').pop()
        h.assert(sent && JSON.stringify(sent.json).includes('Open Settings'), 'only on the click, with the notes')
        await win.click('button:has-text("Restore my notes")')
        h.assert((await win.inputValue('.notes-modal textarea')) === bullets, 'Restore my notes brings the bullets back')
        // The pressed button went away: the focus stays in the dialog, on Draft script.
        h.assert(await win.evaluate(() => document.activeElement?.classList.contains('notes-draft-btn')), 'focus on Draft script after Restore my notes')
        await r.until(async () => (await win.evaluate(() => window.api.getNotes())).settings.text === bullets, { what: 'the restored notes saved' })

        // Stale: a slow provider, and typing meanwhile.
        await win.evaluate(() => window.api.saveAiProvider({ kind: 'anthropic', label: 'Slow Claude', apiKey: 'slow-e2e-notes-key-0002' }))
        await win.evaluate(() => window.dispatchEvent(new Event('ssw:ai-providers-changed')))
        await win.waitForSelector('.notes-draft-provider')
        const slowId = await win.evaluate(async () => (await window.api.listAiProviders()).find((p) => p.label === 'Slow Claude').id)
        await win.selectOption('.notes-draft-provider', slowId)
        await win.click('.notes-draft-btn')
        await win.waitForSelector('.notes-draft-busy')
        h.assert(await win.evaluate(() => !!document.activeElement?.closest('.notes-draft') && document.activeElement.textContent === 'Cancel'), 'focus on Cancel while drafting')
        await win.focus('.notes-modal textarea')
        await win.keyboard.press('Control+End')
        await win.keyboard.type(' now')
        const typed = `${bullets} now`
        await win.waitForSelector('text=Your notes changed while the script was drafted, so the draft was not used. Try again.', { timeout: 20000 })
        h.assert((await win.inputValue('.notes-modal textarea')) === typed, 'the typed text stays')

        // Cancel: nothing changes.
        await win.click('.notes-draft-btn')
        await win.waitForSelector('.notes-draft-busy')
        await win.click('.notes-draft button:has-text("Cancel")')
        await win.waitForSelector('.notes-draft-busy', { state: 'detached' })
        await h.sleep(4500)
        h.assert((await win.inputValue('.notes-modal textarea')) === typed, 'Cancel leaves the notes unchanged')
        h.assert(!(await win.$('text=Script drafted from your notes')), 'no draft after Cancel')
        // Cancel went away with the focus on it: Esc still closes the dialog.
        h.assert(await win.evaluate(() => document.activeElement?.classList.contains('notes-draft-btn')), 'focus on Draft script after Cancel')
        await win.keyboard.press('Escape')
        await win.waitForSelector('.notes-modal', { state: 'detached', timeout: 3000 })
      })
    } finally {
      await ai.close()
    }
  } finally {
    wm.kill()
  }
}

main()
