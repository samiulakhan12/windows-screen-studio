// Command palette, custom shortcuts and smart speed, end to end on seeded projects: Ctrl+K
// searches and runs commands, a rebound shortcut works and survives reopening the editor,
// the editor's original keys keep working, and smart speed finds a still, input-free stretch,
// speeds it up (or cuts it) in one undo step.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const MEDIA_CACHE = path.join(require('node:os').tmpdir(), 'ssw-e2e-media')

/** A 16 s test pattern whose picture freezes from 3 s to 9 s and from 11 s to the end (cached). */
function stillVideo() {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, 'still-16s-640x360-30.mp4')
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-t', '16',
    '-filter_complex', '[0:v]split[a][b];[a][b]freezeframes=first=90:last=270:replace=90[c];[c]split[d][e];[d][e]freezeframes=first=330:last=479:replace=330',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    tmp
  ], { stdio: 'inherit' })
  fs.renameSync(tmp, file)
  return file
}

/** The mouse moves all the time except from 3 s to 9 s; it also moves in the second still part. */
function restingTrack(seconds) {
  const samples = []
  for (let i = 0; i <= seconds * 30; i++) {
    const t = i / 30
    if (t > 3 && t < 9) continue
    samples.push({ t: +t.toFixed(4), x: 0.2 + 0.4 * (t / seconds), y: 0.5 + 0.2 * Math.sin(t) })
  }
  return { samples, clicks: [{ t: 1, x: 0.3, y: 0.5, button: 'left' }], keys: [], shapes: [], scale: 1, valid: true }
}

async function setup(ctx, tag, opts, home = h.tempHome(tag)) {
  const id = f.seedProject(home, opts)
  if (opts.video) {
    const media = path.join(h.projectsRoot(home), id, 'screen.mp4')
    fs.unlinkSync(media)
    fs.symlinkSync(opts.video, media)
  }
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  await f.openProject(win, opts.name)
  return { home, id, app, win }
}

const disk = (home, id) => h.readProject(home, id)
const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const activeTab = (win) => win.$eval('.insp-tabs button.active', (b) => b.textContent.trim())
const clipCount = (win) => win.$$eval('.clip-block', (els) => els.length)
const timecode = (win) => win.$eval('.timecode', (e) => e.textContent)
const outTime = (tc) => {
  const [m, s] = tc.split('/')[0].trim().split(':')
  return Number(m) * 60 + Number(s)
}
const isPlaying = (win) => win.$eval('.transport .btn.round', (b) => b.dataset.playing === 'true')
const focused = (win) =>
  win.evaluate(() => {
    const el = document.activeElement
    return el ? { tag: el.tagName, label: el.getAttribute('aria-label'), inPalette: !!el.closest('.command-palette'), inShortcuts: !!el.closest('.shortcuts-modal') } : null
  })
const paletteTitles = (win) => win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent))
const notice = (win, text) => win.waitForSelector(`.notice:has-text("${text}")`, { timeout: 10000 })

/** Puts the playhead at `seconds` (whole seconds) with Home and Shift+→. */
async function playheadAt(win, seconds) {
  await win.keyboard.press('Home')
  for (let i = 0; i < seconds; i++) await win.keyboard.press('Shift+ArrowRight')
  await f.waitFor(async () => Math.abs(outTime(await timecode(win)) - seconds) < 0.05, `playhead at ${seconds} s`, 3000)
}

async function openPalette(win, keys = 'Control+k') {
  await win.keyboard.press(keys)
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
}

/** Runs a command by typing `query` into the palette and pressing Enter on the first result. */
async function runCommand(win, query, expectTitle) {
  await openPalette(win)
  await win.keyboard.type(query)
  await f.waitFor(async () => (await paletteTitles(win))[0] === expectTitle, `"${query}" lists ${expectTitle} first`, 3000)
  await win.keyboard.press('Enter')
  await f.waitFor(async () => !(await win.$('.command-palette')), 'palette closes after running', 3000)
}

async function userDataPrefs(app) {
  const dir = await app.evaluate(({ app }) => app.getPath('userData'))
  const file = path.join(dir, 'editor-prefs.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

async function main() {
  await h.run('commands: Ctrl+K opens an accessible palette; typing filters; Enter runs split; recents, toggles, tabs, shapes', async (ctx) => {
    const { home, id, win } = await setup(ctx, 'palette', { name: 'PaletteTest', seconds: 12 })
    await playheadAt(win, 3)

    // Opening from the title field (Ctrl+K works while typing) and closing restores focus there.
    await win.click('.title-input')
    await openPalette(win)
    const a11y = await win.evaluate(() => {
      const dlg = document.querySelector('.command-palette')
      const input = dlg.querySelector('input')
      const list = document.getElementById(input.getAttribute('aria-controls'))
      const active = document.getElementById(input.getAttribute('aria-activedescendant'))
      return {
        modal: dlg.getAttribute('role') === 'dialog' && dlg.getAttribute('aria-modal') === 'true',
        focused: document.activeElement === input,
        combobox: input.getAttribute('role'),
        listbox: list && list.getAttribute('role'),
        options: list.querySelectorAll('[role="option"]').length,
        activeSelected: active && active.getAttribute('aria-selected')
      }
    })
    h.assert(a11y.modal && a11y.focused && a11y.combobox === 'combobox' && a11y.listbox === 'listbox', `dialog, focused combobox and listbox: ${JSON.stringify(a11y)}`)
    h.assert(a11y.options > 40 && a11y.activeSelected === 'true', `every command listed, first one active: ${JSON.stringify(a11y)}`)
    // Tab stays inside the dialog.
    await win.keyboard.press('Tab')
    h.assert((await focused(win)).inPalette, 'Tab keeps focus in the palette')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.command-palette')), 'Esc closes the palette')
    h.assert((await focused(win)).label === 'Recording name', `focus back on the title field: ${JSON.stringify(await focused(win))}`)
    await win.keyboard.press('Escape') // leave the title field

    // Fuzzy filtering, with the shortcut shown; arrows move the active option.
    await openPalette(win)
    await win.keyboard.type('splt')
    await f.waitFor(async () => (await paletteTitles(win))[0] === 'Split clip at playhead', 'fuzzy "splt" finds Split first', 3000)
    const shown = await win.$eval('.command-palette [role="option"]', (o) => ({ keys: o.querySelector('.shortcut-keys')?.textContent, html: o.querySelector('.palette-title').innerHTML }))
    h.assert(shown.keys === 'S' && shown.html.includes('<mark>'), `shortcut and highlight shown: ${JSON.stringify(shown)}`)
    const activeId = () => win.$eval('.command-palette input', (i) => i.getAttribute('aria-activedescendant'))
    const first = await activeId()
    const many = (await paletteTitles(win)).length
    if (many > 1) {
      await win.keyboard.press('ArrowDown')
      h.assert((await activeId()) !== first, 'ArrowDown moves the active option')
      await win.keyboard.press('ArrowUp')
    }
    h.assert((await activeId()) === first, 'ArrowUp moves back')
    await win.keyboard.press('Enter')
    await f.waitFor(async () => !(await win.$('.command-palette')), 'palette closes')
    await f.waitFor(async () => (await clipCount(win)) === 2, 'Enter ran split: two clips')
    await waitSaved(win)
    h.assert(Math.abs(disk(home, id).clips[0].end - 3) < 0.02, `split at the playhead: ${JSON.stringify(disk(home, id).clips)}`)

    // Ctrl+Shift+P opens it too; recently used commands come first.
    await openPalette(win, 'Control+Shift+P')
    const groups = await win.$$eval('.command-palette .palette-group', (els) => els.map((e) => e.textContent))
    h.assert(groups[0] === 'Recently used' && (await paletteTitles(win))[0] === 'Split clip at playhead', `recent first: ${groups.slice(0, 2)}`)
    // A command that cannot run says why and keeps the palette open.
    await win.keyboard.type('redo')
    await f.waitFor(async () => (await paletteTitles(win))[0] === 'Redo', 'Redo listed', 3000)
    await win.keyboard.press('Enter')
    await win.waitForSelector('.palette-status:has-text("Nothing to redo")', { timeout: 3000 })
    h.assert(await win.$('.command-palette'), 'palette stays open')
    await win.keyboard.press('Escape')

    // Toggles show their state and report the change.
    await openPalette(win)
    await win.keyboard.type('motion blur')
    await f.waitFor(async () => (await paletteTitles(win))[0] === 'Motion blur', 'Motion blur listed', 3000)
    h.assert((await win.$eval('.command-palette [role="option"] .palette-state', (e) => e.textContent)) === 'On', 'shows On')
    await win.keyboard.press('Enter')
    await notice(win, 'Motion blur off')
    await waitSaved(win)
    h.assert(disk(home, id).effects.motionBlur === 0, 'motion blur off on disk')
    await runCommand(win, 'motion blur', 'Motion blur')
    await waitSaved(win)
    h.assert(disk(home, id).effects.motionBlur === 0.5, 'turning it on again restores the strength')

    // Inspector tabs, export and shapes from the palette.
    await runCommand(win, 'audio settings', 'Open Audio settings')
    h.assert((await activeTab(win)) === 'Audio', 'Audio tab opened')
    await runCommand(win, 'add arrow', 'Add arrow')
    await waitSaved(win)
    const shapes = disk(home, id).shapes || []
    h.assert(shapes.length === 1 && shapes[0].kind === 'arrow' && Math.abs(shapes[0].start - 3) < 0.05, `arrow added at the playhead: ${JSON.stringify(shapes)}`)
    h.assert((await activeTab(win)) === 'Shapes', 'the new shape is selected (Shapes tab)')
    await win.keyboard.press('Control+z')
    await waitSaved(win)
    h.assert((disk(home, id).shapes || []).length === 0, 'one undo removes it')
    await runCommand(win, 'export', 'Export…')
    await win.waitForSelector('.export-modal', { timeout: 5000 })
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.export-modal')), 'export dialog closed')
    // The palette does not open behind the export dialog.
    await win.click('button:has-text("Export")')
    await win.waitForSelector('.export-modal')
    await win.keyboard.press('Control+k')
    await h.sleep(300)
    h.assert(!(await win.$('.command-palette')), 'no palette behind the export dialog')
    await win.keyboard.press('Escape')
  })

  await h.run('commands: a rebound shortcut works and persists after reopening; conflicts and reserved keys; old keys still work', async (ctx) => {
    const { home, id, app, win } = await setup(ctx, 'rebind', { name: 'RebindTest', seconds: 12 })
    h.assert((await win.$eval('.transport button[title^="Split"]', (b) => b.title)) === 'Split the clip at the playhead (S)', 'tooltip shows S')

    await win.click('button[aria-label="Keyboard shortcuts"]')
    await win.waitForSelector('.shortcuts-modal[role="dialog"]')
    h.assert((await focused(win)).label === 'Search shortcuts', 'search field focused')
    await win.keyboard.type('split')
    await win.waitForSelector('.shortcut-row[data-command="split"]')
    h.assert((await win.$$('.shortcut-row')).length <= 3, 'search filters the list')

    // Add X to split.
    await win.click('button[aria-label="Add shortcut for Split clip at playhead"]')
    await win.waitForSelector('.shortcut-capture')
    await win.keyboard.press('x')
    await f.waitFor(async () => (await win.$$eval('.shortcut-row[data-command="split"] .shortcut-chip kbd', (els) => els.map((e) => e.textContent))).join() === 'S,X', 'X added to split')

    // Z belongs to Add zoom: asked first; Cancel keeps it there.
    await win.click('button[aria-label="Add shortcut for Split clip at playhead"]')
    await win.keyboard.press('z')
    await win.waitForSelector('.shortcut-message.conflict:has-text("Add zoom at playhead")')
    await win.click('.shortcut-message.conflict button:has-text("Cancel")')
    h.assert(!(await win.$('.shortcut-message.conflict')), 'conflict dismissed')
    // Enter is reserved.
    await win.click('button[aria-label="Add shortcut for Split clip at playhead"]')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.shortcut-message.error:has-text("Enter")')
    // Modifiers alone wait for a key.
    await win.click('button[aria-label="Add shortcut for Split clip at playhead"]')
    await win.keyboard.down('Control')
    await f.waitFor(async () => (await win.textContent('.shortcut-capture')).includes('Ctrl + …'), 'shows the held modifier', 2000)
    await win.keyboard.up('Control')
    await win.keyboard.press('Escape')
    h.assert(await win.$('.shortcuts-modal'), 'Esc in the key field only cancels the recording')
    // Stored at once, only the change.
    await f.waitFor(async () => JSON.stringify((await userDataPrefs(app)).shortcuts) === JSON.stringify({ version: 1, bindings: { split: ['S', 'X'] } }), 'stored in editor-prefs.json', 3000)
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.shortcuts-modal')), 'Esc closes the dialog')
    h.assert((await win.$eval('.transport button[title^="Split"]', (b) => b.title)) === 'Split the clip at the playhead (S)', 'tooltip still shows the first key')

    // The new key splits.
    await playheadAt(win, 4)
    await win.keyboard.press('x')
    await f.waitFor(async () => (await clipCount(win)) === 2, 'X splits')

    // Every original key still works.
    await playheadAt(win, 8)
    await win.keyboard.press('s')
    await f.waitFor(async () => (await clipCount(win)) === 3, 'S splits')
    await win.keyboard.press('z')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'Z adds a zoom')
    await win.keyboard.press('3')
    await waitSaved(win)
    h.assert(disk(home, id).zooms[0].scale === 2, `3 sets the level to 2×: ${disk(home, id).zooms[0].scale}`)
    await win.keyboard.press('t')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 1, 'T adds text')
    await win.keyboard.press('Escape') // leaves the text field the new text focused, if any
    await win.click('.text-seg')
    await win.keyboard.press('Backspace')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 0, 'Backspace deletes the selected text')
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 1, 'Ctrl+Z undoes')
    await win.keyboard.press('Control+Shift+z')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 0, 'Ctrl+Shift+Z redoes')
    await win.keyboard.press('Control+z')
    await win.keyboard.press('Control+y')
    await f.waitFor(async () => (await win.$$('.text-seg')).length === 0, 'Ctrl+Y redoes')
    await win.keyboard.press('Home')
    await f.waitFor(async () => outTime(await timecode(win)) === 0, 'Home goes to the start', 2000)
    for (let i = 0; i < 6; i++) await win.keyboard.press('ArrowRight')
    await f.waitFor(async () => {
      const t = outTime(await timecode(win))
      return t >= 0.1 && t <= 0.2
    }, '→ steps a frame (1/30 s) at a time', 2000)
    await win.keyboard.press('End')
    await f.waitFor(async () => outTime(await timecode(win)) > 11.9, 'End goes to the end', 2000)
    const px = () => win.$eval('.tl-content', (e) => Number(e.dataset.pxPerSec))
    const px0 = await px()
    await win.keyboard.press('+')
    await f.waitFor(async () => (await px()) > px0, '+ zooms the timeline in', 2000)
    await win.keyboard.press('-')
    await f.waitFor(async () => Math.abs((await px()) - px0) < 1e-6, '- zooms it out', 2000)
    await win.keyboard.press('Home')
    await win.keyboard.press('Space')
    await f.waitFor(() => isPlaying(win), 'Space plays')
    await win.keyboard.press('Space')
    await f.waitFor(async () => !(await isPlaying(win)), 'Space pauses')
    // Ctrl+E opens the export dialog; shortcuts are off behind it.
    await win.keyboard.press('Control+e')
    await win.waitForSelector('.export-modal')
    await win.keyboard.press('s')
    await h.sleep(200)
    h.assert((await clipCount(win)) === 3, 'no split behind the export dialog')
    await win.keyboard.press('Escape')
    await f.waitFor(async () => !(await win.$('.export-modal')), 'export closed')

    // Reopen the editor: the shortcut is still there.
    await waitSaved(win)
    await win.click('button[aria-label="Back to recordings"]')
    await f.openProject(win, 'RebindTest')
    h.assert((await clipCount(win)) === 3, 'edits kept')
    await playheadAt(win, 10)
    await win.keyboard.press('x')
    await f.waitFor(async () => (await clipCount(win)) === 4, 'X still splits after reopening')

    // Moving a key from another command, then Reset all.
    await win.keyboard.press('Control+/')
    await win.waitForSelector('.shortcuts-modal')
    await win.click('button[aria-label="Add shortcut for Add text at playhead"]')
    await win.keyboard.press('x')
    await win.waitForSelector('.shortcut-message.conflict:has-text("Split clip at playhead")')
    await win.click('.shortcut-message.conflict button:has-text("Use it here")')
    await f.waitFor(async () => (await win.$$eval('.shortcut-row[data-command="addText"] .shortcut-chip kbd', (els) => els.map((e) => e.textContent))).join() === 'T,X', 'X moved to Add text')
    h.assert((await win.$$eval('.shortcut-row[data-command="split"] .shortcut-chip kbd', (els) => els.map((e) => e.textContent))).join() === 'S', 'and taken from split')
    await win.click('.shortcuts-modal button:has-text("Reset all")')
    await f.waitFor(async () => (await win.$$eval('.shortcut-row[data-command="addText"] .shortcut-chip kbd', (els) => els.map((e) => e.textContent))).join() === 'T', 'Reset all restores the defaults')
    await f.waitFor(async () => !('shortcuts' in (await userDataPrefs(app))), 'nothing stored once everything is default', 3000)
    await win.click('.shortcuts-modal button:has-text("Done")')
    await f.waitFor(async () => !(await win.$('.shortcuts-modal')), 'Done closes')
    await win.keyboard.press('x')
    await h.sleep(300)
    h.assert((await clipCount(win)) === 4 && (await win.$$('.text-seg')).length === 0, 'X does nothing after Reset all')
  })

  await h.run('commands: smart speed finds the still, input-free stretch, speeds it up or cuts it, one undo step each', async (ctx) => {
    const seconds = 16
    const { home, id, win } = await setup(ctx, 'smart', {
      name: 'SmartTest',
      seconds,
      width: 640,
      height: 360,
      fps: 30,
      video: stillVideo(),
      cursor: restingTrack(seconds)
    })
    // From the palette: opens the Clip panel and looks for idle parts (3 s, 4× by default).
    await runCommand(win, 'smart speed', 'Smart speed: find idle parts')
    h.assert((await activeTab(win)) === 'Clip', 'Clip panel opened')
    await win.waitForSelector('.smart-list li', { timeout: 30000 })
    const parts = await win.$$eval('.smart-list .smart-range', (els) => els.map((e) => e.textContent))
    // Only 3–9 s: the picture is also still from 11 s, but the mouse moves there.
    h.assert(parts.length === 1 && /^0:03\.\d – 0:08\.\d$/.test(parts[0]), `one idle part, padded inside 3–9 s: ${parts}`)
    h.assert((await win.textContent('.smart-summary')).includes('1 idle part'), 'summary')

    // Longer minimum: nothing; back to 2 s.
    await win.click('.chips[aria-label="Minimum idle length"] .chip:has-text("10 s")')
    await f.waitFor(async () => (await win.textContent('.smart-summary')).includes('No idle parts of 10 s'), 'no parts of 10 s', 2000)
    await win.click('.chips[aria-label="Minimum idle length"] .chip:has-text("2 s")')
    await win.waitForSelector('.smart-list li')

    // Clicking a part selects it on the timeline.
    await win.click('.smart-list .smart-range')
    await win.waitForSelector('[data-testid="range-selection"]')

    const before = disk(home, id).clips
    await win.click('.smart-speed button.btn.primary:has-text("Speed up")')
    await notice(win, 'Sped up 1 idle part 4×')
    await waitSaved(win)
    const sped = disk(home, id).clips
    const fast = sped.filter((c) => c.speed === 4)
    h.assert(sped.length === 3 && fast.length === 1, `one 4× clip: ${JSON.stringify(sped)}`)
    h.assert(fast[0].start > 3.3 && fast[0].start < 3.8 && fast[0].end > 8.2 && fast[0].end < 8.7, `4× over the idle part: ${JSON.stringify(fast[0])}`)
    await f.waitFor(async () => (await win.textContent('.smart-summary')).includes('No idle parts'), 'nothing left to speed up', 2000)
    const length = (clips) => clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0)
    h.assert(Math.abs(outTime((await timecode(win)).split('/')[1]) - length(sped)) < 0.11, 'transport shows the shorter length')

    await win.keyboard.press('Control+z')
    await waitSaved(win)
    h.assert(JSON.stringify(disk(home, id).clips) === JSON.stringify(before), 'one Ctrl+Z restores the clips')

    // Cut instead.
    await win.click('.chips[aria-label="Smart speed action"] .chip:has-text("Cut")')
    await win.waitForSelector('.smart-list li')
    await win.click('.smart-speed button.btn.primary:has-text("Cut")')
    await notice(win, 'Cut 1 idle part')
    await waitSaved(win)
    const cut = disk(home, id).clips
    h.assert(cut.length === 2 && cut[0].end > 3.3 && cut[0].end < 3.8 && cut[1].start > 8.2 && cut[1].start < 8.7, `idle part cut: ${JSON.stringify(cut)}`)
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 1, 'cut shown on the timeline', 2000)
    await win.keyboard.press('Control+z')
    await waitSaved(win)
    h.assert(JSON.stringify(disk(home, id).clips) === JSON.stringify(before), 'undo restores')

    // Unticking the only part disables Apply.
    await win.click('.smart-list input[type="checkbox"]')
    h.assert(await win.$eval('.smart-speed button.btn.primary', (b) => b.disabled), 'nothing chosen, nothing to apply')
  })
}

main()
