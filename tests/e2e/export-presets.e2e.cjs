// The export dialog's wave 12 controls in the real built app (docs/design/output-and-languages.md
// §2.1-2.3, §2.8, §23.3 steps F2, F12, F13, F15 and F16): saved presets and their files, the
// keyboard, Also save's editors, and transparency, with nothing exported. Nothing here needs the
// codecs of part P1 or the stems and timelines of parts P3 and P4.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

async function launchWith(ctx, home, before) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  // Every request to the network is blocked and logged (F14), as the English guard's tour does.
  await app.evaluate(({ session }) => {
    globalThis.__requests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
      globalThis.__requests.push(details.url)
      done({ cancel: true })
    })
  })
  if (before) await before(app, win)
  await fx.openProject(win, 'Presets demo')
  return { app, win }
}

const outside = (app) => app.evaluate(() => globalThis.__requests)

async function openSettings(win) {
  await fx.openExportDialog(win)
  const head = win.locator('.modal button.toggle-head')
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  await win.waitForSelector('.modal [data-testid="export-codec"]')
}

async function closeDialog(win) {
  await win.locator('.modal button', { hasText: /^Cancel$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

const focused = (win) => win.evaluate(() => {
  const el = document.activeElement
  return el ? { text: el.textContent, label: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid'), value: el.getAttribute('data-value'), checked: el.getAttribute('aria-checked'), menu: el.getAttribute('data-menu') } : null
})
const checked = (win, group) => win.$$eval(`.modal [data-testid="${group}"] [aria-checked="true"]`, (els) => els.map((e) => e.textContent))
const presetNames = (win) => win.$$eval('.modal [data-testid="user-presets"] .preset-card .preset-label', (els) => els.map((e) => e.textContent))

/** Presses Tab until `pred(focused)` holds, at most `max` times. */
async function tabTo(win, pred, max = 40) {
  for (let i = 0; i < max; i++) {
    await win.keyboard.press('Tab')
    const f = await focused(win)
    if (f && pred(f)) return f
  }
  throw new Error('focus never reached the control')
}

function seed(home) {
  const media = fx.indexedVideo({ seconds: 4, width: 1280, height: 720, beeps: true })
  fx.seedProject(home, {
    name: 'Presets demo',
    media,
    seconds: 4,
    audio: true,
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 40, cornerRadius: 12, shadow: 0, aspectRatio: 'auto' }
  })
}

async function main() {
  await test('export presets: keyboard rows, Save as preset, the menu, Save to a file, Delete and Import (F12, F13)', fx.withHome('presets', async (ctx, home) => {
    seed(home)
    const { app, win } = await launchWith(ctx, home)
    await openSettings(win)
    await h.sleep(600)

    // F13: Save as preset is its own stop after the Settings header, then the rows take the arrows.
    await win.focus('.modal button.toggle-head')
    await win.keyboard.press('Tab')
    h.assert((await focused(win)).testid === 'save-preset', `Save as preset follows the header (${JSON.stringify(await focused(win))})`)
    const codec = await tabTo(win, (f) => f.value === 'h264')
    h.assert(codec.checked === 'true', 'the Codec row is one stop, on its checked chip')
    await win.keyboard.press('ArrowRight')
    h.assert((await checked(win, 'export-codec')).join() === 'AV1', `ArrowRight picks AV1 (${await checked(win, 'export-codec')})`)
    h.assert((await focused(win)).value === 'av1', 'the focus moves with the choice')
    await win.keyboard.press('Home')
    h.assert((await checked(win, 'export-codec')).join() === 'H.264', 'Home goes back to H.264')
    const fps = await tabTo(win, (f) => f.value === '60')
    h.assert(fps.checked === 'true', 'Frame rate is one stop, on 60 fps')
    await win.keyboard.press('ArrowLeft')
    h.assert((await checked(win, 'export-fps')).join() === '30 fps', `ArrowLeft picks 30 fps (${await checked(win, 'export-fps')})`)
    await win.keyboard.press('Tab')
    h.assert((await focused(win)).value !== '60', 'Tab leaves the Frame rate row')

    // F12: MOV, CineForm and stems, saved as "Client review".
    await fx.pickChip(win, 'Format', 'MOV')
    await win.click('.modal [data-testid="export-codec"] [data-value="cineform"]')
    const stems = win.locator('.modal [data-also="stems"]')
    await stems.scrollIntoViewIfNeeded()
    await stems.click()
    await win.click('.modal [data-testid="save-preset"]')
    const field = win.locator('.modal [data-testid="preset-name-field"] input')
    h.assert((await field.inputValue()) === 'MOV CineForm 1080p30', `the name is suggested from the settings (${await field.inputValue()})`)
    // Escape cancels the field, never the dialog.
    await win.keyboard.press('Escape')
    await h.sleep(200)
    h.assert(await win.isVisible('.modal[aria-label="Export"]'), 'Escape in the field keeps the dialog')
    h.assert((await focused(win)).testid === 'save-preset', 'the focus goes back to Save as preset')
    await win.click('.modal [data-testid="save-preset"]')
    await field.fill('Client review')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.modal [data-testid="user-presets"]')
    h.assert((await win.textContent('.modal button.toggle-head')).includes('Settings · Client review'), 'the header names the new preset')
    await closeDialog(win)

    // Reopened: the preset is there, above the destinations, and selected.
    await openSettings(win)
    h.assert(JSON.stringify(await presetNames(win)) === '["Client review"]', `the preset is kept (${await presetNames(win)})`)
    const above = await win.evaluate(() => {
      const mine = document.querySelector('.modal [data-testid="user-presets"]')
      const built = document.querySelector('.modal .preset-grid[aria-label="Destinations"]')
      return !!mine && !!built && !!(mine.compareDocumentPosition(built) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    h.assert(above, 'Your presets sit above the destinations')
    h.assert(await win.isVisible('.modal [data-testid="user-presets"] .preset-card[aria-checked="true"]'), 'the preset is selected')
    h.assert(await win.isVisible('.modal [data-also="stems"][aria-pressed="true"]'), 'its Also save choices came with it')
    await shot(win, 'presets-reopened')

    // F13: Shift+F10 opens the menu; Escape closes it and gives the focus back to its button.
    await win.focus('.modal [data-testid="user-presets"] .preset-card')
    await win.keyboard.press('Shift+F10')
    await win.waitForSelector('.modal [role="menu"]')
    h.assert((await focused(win)).menu === 'rename', `the menu takes the focus on its first item (${JSON.stringify(await focused(win))})`)
    await win.keyboard.press('Escape')
    await h.sleep(200)
    h.assert(!(await win.$('.modal [role="menu"]')), 'Escape closes the menu')
    h.assert(await win.isVisible('.modal[aria-label="Export"]'), 'and not the dialog')
    h.assert((await focused(win)).label === 'More for Client review', `the focus is back on its button (${JSON.stringify(await focused(win))})`)

    // Save to a file.
    const file = path.join(home, 'Client review.flownpreset')
    await h.mockSaveDialog(app, file)
    await win.keyboard.press('Enter')
    await win.click('.modal [role="menu"] [data-menu="save"]')
    const t0 = Date.now()
    while (!fs.existsSync(file) && Date.now() - t0 < 10000) await h.sleep(100)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    h.assert(saved.presets.length === 1 && saved.presets[0].name === 'Client review' && saved.presets[0].options.codec === 'cineform', `the file holds the preset (${JSON.stringify(saved)})`)

    // Delete, with its question; the focus moves to Import presets….
    await win.click('.modal [data-testid="preset-more"]')
    await win.click('.modal [role="menu"] [data-menu="delete"]')
    h.assert((await win.textContent('.modal .preset-delete p')) === 'Delete “Client review”?', 'Delete asks first')
    await win.click('.modal [data-testid="preset-delete-confirm"]')
    await h.sleep(300)
    h.assert(!(await win.$('.modal [data-testid="user-presets"]')), 'the preset is gone')
    h.assert((await focused(win)).testid === 'preset-import', `the focus moves to Import presets… (${JSON.stringify(await focused(win))})`)
    h.assert((await win.textContent('.modal button.toggle-head')).includes('Settings · Custom'), 'nothing names the settings any more')

    // Import brings it back.
    const importFile = async (p) => {
      await app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
      }, p)
      await win.click('.modal [data-testid="preset-import"]')
      await h.sleep(500)
      return win.textContent('.modal .preset-import-notices')
    }
    h.assert((await importFile(file)) === 'Imported 1 preset.', 'the import says what it did')
    h.assert(JSON.stringify(await presetNames(win)) === '["Client review"]', 'the preset is back')
    const big = path.join(home, 'big.flownpreset')
    fs.writeFileSync(big, `${fs.readFileSync(file, 'utf8')}${' '.repeat(70 * 1024)}`)
    h.assert((await importFile(big)) === 'This file is too large to be a Flown preset file.', 'a 70 KB file is refused')
    const prores = path.join(home, 'prores.flownpreset')
    fs.writeFileSync(prores, JSON.stringify({ flown: 'export-presets', version: 1, presets: [{ name: 'Apple', options: { format: 'mov', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', codec: 'prores-422' } }] }))
    const notice = await importFile(prores)
    h.assert(notice === 'Imported 1 preset.1 preset uses ProRes, which Flown does not make: it exports as MOV with CineForm.', `a ProRes preset imports as CineForm (${notice})`)
    h.assert(JSON.stringify(await presetNames(win)) === '["Client review","Apple"]', `the presets keep their order (${await presetNames(win)})`)
    await shot(win, 'presets-imported')
    h.assert((await outside(app)).length === 0, `no request left the app (${await outside(app)})`)
  }))

  await test('export presets: editors, MP4 and transparency, and a stored HEVC on a PC without one (F2, F15, F16)', fx.withHome('presets-rows', async (ctx, home) => {
    seed(home)
    // F2: the previous settings asked for HEVC; this PC (Linux, no GPU) cannot make it.
    const { app, win } = await launchWith(ctx, home, (_app, w) =>
      w.evaluate(() => localStorage.setItem('export-settings', JSON.stringify({ format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto', codec: 'hevc' })))
    )
    await openSettings(win)
    await win.waitForSelector('.modal [data-testid="export-codec-notice"]')
    h.assert((await win.textContent('.modal [data-testid="export-codec-notice"]')) === 'This PC cannot make HEVC, so this export uses H.264.', 'the stored HEVC exports as H.264 and says so')
    h.assert(!(await win.$('.modal [data-testid="export-codec"] [data-value="hevc"]')), 'no HEVC chip after the probe found nothing')
    h.assert((await checked(win, 'export-codec')).join() === 'H.264', 'H.264 is the codec shown')
    // F16: MP4 has no Background row; the Transparent overlay destination gives MOV, CineForm, Overlays only.
    h.assert(!(await win.$('.modal [data-testid="export-background"]')), 'MP4 shows no Background row')
    await win.click('.modal .preset-card[data-preset="overlay"]')
    await h.sleep(300)
    h.assert((await win.textContent('.modal .form-row:has(> span:text-is("Format")) .chip.active')) === 'MOV', 'the overlay is a MOV')
    h.assert((await checked(win, 'export-codec')).join() === 'CineForm (for editing)', 'with CineForm')
    h.assert((await checked(win, 'export-background')).join() === 'Overlays only', 'and Overlays only')
    // F15: WebM with a timeline: Final Cut Pro is blocked with its reason.
    await fx.pickChip(win, 'Format', 'WebM')
    const timeline = win.locator('.modal [data-also="timeline"]')
    await timeline.scrollIntoViewIfNeeded()
    await timeline.click()
    h.assert(await win.isDisabled('.modal [data-editor="finalcut"]'), 'Final Cut Pro is off for WebM')
    h.assert((await win.textContent('.modal [data-testid="editor-blocked-finalcut"]')) === 'Final Cut Pro cannot open VP9 files. Choose H.264 or HEVC.', 'with its reason')
    // MOV + Lossless + Premiere Pro: the line of a pair not checked yet.
    await fx.pickChip(win, 'Format', 'MOV')
    await win.click('.modal [data-testid="export-background"] [data-value="with"]')
    await win.click('.modal [data-testid="export-codec"] [data-value="animation"]')
    await win.click('.modal [data-editor="premiere"]')
    await h.sleep(200)
    h.assert((await win.textContent('.modal [data-testid="editor-warning-premiere"]')).startsWith('Not checked yet with Premiere Pro'), 'Premiere Pro with Lossless says it is not checked yet')
    // The editors are kept when Timeline is turned off and on again.
    await timeline.click()
    await timeline.click()
    h.assert(await win.isVisible('.modal [data-editor="premiere"][aria-pressed="true"]'), 'Open in keeps the editors chosen')
    await closeDialog(win)
    await app.close()
    ctx.app = null

    // F16 with a probe that found hevc_nvenc: MOV + HEVC, Transparent switches to CineForm, With background back to HEVC.
    // The last session's Also save asked for a Premiere Pro timeline.
    const again = await launchWith(ctx, home, async (a, w) => {
      await a.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('export:probeCodec')
        ipcMain.handle('export:probeCodec', (_e, codec) => (codec === 'hevc' ? ['hevc_nvenc'] : []))
      })
      await w.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({ srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, timelines: ['premiere'] })))
    })
    await openSettings(again.win)
    // Timeline off and on again keeps the stored editors, never the first-time DaVinci Resolve.
    const stored = again.win.locator('.modal [data-also="timeline"]')
    await stored.scrollIntoViewIfNeeded()
    await stored.click()
    await stored.click()
    const editors = await again.win.$$eval('.modal [data-editor][aria-pressed="true"]', (els) => els.map((e) => e.getAttribute('data-editor')))
    h.assert(editors.join() === 'premiere', `Open in keeps the stored editors (${editors})`)
    await fx.pickChip(again.win, 'Format', 'MOV')
    await again.win.waitForSelector('.modal [data-testid="export-codec"] [data-value="hevc"]:not([disabled])')
    await again.win.click('.modal [data-testid="export-codec"] [data-value="hevc"]')
    await again.win.click('.modal [data-testid="export-background"] [data-value="background"]')
    await h.sleep(200)
    h.assert((await checked(again.win, 'export-codec')).join() === 'CineForm (for editing)', 'Transparent switches HEVC to CineForm')
    h.assert((await again.win.textContent('.modal [data-testid="export-background-note"]')) === 'CineForm keeps the transparency.', 'and says so')
    await again.win.click('.modal [data-testid="export-background"] [data-value="with"]')
    await h.sleep(200)
    h.assert((await checked(again.win, 'export-codec')).join() === 'HEVC', 'With background gives HEVC back')
    h.assert((await again.win.textContent('.modal [data-testid="export-background-note"]')) === 'Back to HEVC.', 'and says so')
    await shot(again.win, 'presets-hevc')
    h.assert((await outside(again.app)).length === 0, `no request left the app (${await outside(again.app)})`)
  }))
}

main()
