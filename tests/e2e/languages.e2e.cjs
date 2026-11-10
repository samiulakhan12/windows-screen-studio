// Flown in another language, in the real built app (docs/design/output-and-languages.md §23.4), with
// a test catalogue: tests/fixtures/i18n (marked texts approved by the fixture, not a translation) and
// a few more marked texts this file adds in its own temporary folder, selected with
// SSW_I18N_CATALOGUE_DIR in this unpackaged build. Every launch blocks and logs the network.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/languages.e2e.cjs
//
// Steps covered here: L1 (English by default), L2 (Settings › Language and restarting), L3 (a key the
// catalogue lacks shows English), L4 (fonts, ink and digit widths), L7 (main's save dialog in the UI
// language), L8 (the offer on Home), L11 (the recording bar stays English), L12 (exported file names
// stay English) and L13 (drawn frames do not follow the UI language).
//
// Not covered yet, because the code they check comes with the extraction (steps S3a and S3b, §10.4):
// L5 (durations and Target size through fmt and NumberField: parts X6 and X5), L6 (aria-keyshortcuts:
// X1), L9 (no plain ASCII text left: every X part), L10 (right to left: X7's logical properties and
// the ar-XB selection), L14 (confirmations through askConfirm: X4 and X5) and L15 (mixed digits: X6).
// The same goes for the notification half of L7. Each is added here as its part merges.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
const FIXTURES = path.join(__dirname, '../fixtures/i18n')
const BN_MODEL = 'ggml-bengaliai-whisper-medium-q5_0.bin'

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/**
 * The test catalogue folder in `home`: the fixture's files, plus a label with a candrabindu and a
 * reph (ঁ, র্) for L4. Every added text is marked ‹bn› like the fixture's.
 */
function catalogueDir(home) {
  const dir = path.join(home, 'i18n-fixture')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f))
  const bn = JSON.parse(fs.readFileSync(path.join(dir, 'bn.json'), 'utf8'))
  bn.messages['language.select.label'] = '‹bn› চাঁদ পূর্ণিমা · Language of Flown'
  fs.writeFileSync(path.join(dir, 'bn.json'), JSON.stringify(bn, null, 2))
  return dir
}

/** The `ui` preference written before a launch (absent: none). */
function setUiPref(home, ui) {
  const userData = path.join(home, '.config', 'Flown')
  fs.mkdirSync(userData, { recursive: true })
  const file = path.join(userData, 'editor-prefs.json')
  const prefs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  if (ui === undefined) delete prefs.ui
  else prefs.ui = ui
  fs.writeFileSync(file, JSON.stringify(prefs))
}
const readUiPref = (home) => {
  const file = path.join(home, '.config', 'Flown', 'editor-prefs.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).ui : undefined
}

async function launch(ctx, home, { env = {}, args = [] } = {}) {
  const { app, win, logs } = await h.launch({ home, env, args })
  ctx.app = app
  ctx.logs = logs
  await app.evaluate(({ session }) => {
    globalThis.__requests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
      globalThis.__requests.push(details.url)
      done({ cancel: true })
    })
  })
  await win.waitForSelector('.home, .editor', { timeout: 30000 })
  return { app, win }
}

async function offline(app) {
  const urls = await app.evaluate(() => globalThis.__requests)
  h.assert(urls.length === 0, `no request left the app (${urls.join(', ')})`)
}

const page = (win) => win.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }))

async function openSettings(win) {
  await win.click('.titlebar button[aria-label="Settings"]')
  await win.waitForSelector('.settings-modal')
  await h.sleep(300)
}
async function closeSettings(win) {
  await win.keyboard.press('Escape')
  await win.waitForSelector('.settings-modal', { state: 'detached' })
}

function seed(home, name = 'Langs') {
  const media = fx.indexedVideo({ seconds: 3, width: 1280, height: 720, beeps: true })
  return fx.seedProject(home, {
    id: 'rec-langs',
    name,
    media,
    seconds: 3,
    audio: true,
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.06, cornerRadius: 12, shadow: 0.5, aspectRatio: 'auto' },
    // Text in two scripts on the frame: the canvases keep their own language (L13).
    annotations: [{ id: 't1', start: 0, end: 3, text: 'Hello বাংলা ১২৩', x: 0.5, y: 0.8, size: 0.06, style: 'pill' }]
  })
}

async function main() {
  await test('languages: English by default, with no Language section and no catalogue loaded (L1)', fx.withHome('lang-l1', async (ctx, home) => {
    seed(home)
    const { app, win } = await launch(ctx, home)
    h.assert((await page(win)).lang === 'en', `<html lang="en"> (${JSON.stringify(await page(win))})`)
    const chunks = await win.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /built|\/bn[.-]|catalog/i.test(n)))
    h.assert(chunks.length === 0, `no catalogue chunk is requested (${chunks})`)
    await openSettings(win)
    h.assert(!(await win.$('.settings-modal .language-section')), 'Settings has no Language section while no language ships')
    await closeSettings(win)
    await fx.openProject(win, 'Langs')
    await win.click('button[aria-label="Command palette"]')
    await win.waitForSelector('.command-palette[role="dialog"]')
    await win.keyboard.type('Language')
    await h.sleep(300)
    const items = await win.$$eval('.command-palette [role="option"]', (els) => els.map((e) => e.textContent))
    h.assert(!items.some((t) => /Language…/.test(t)), `the palette has no Language… (${items.join(' | ')})`)
    await win.keyboard.press('Escape')
    await offline(app)
  }))

  await test('languages: Settings › Language, a restart refused while an export runs, then Bangla with the project open again (L2, L3, L4, L7, L11)', fx.withHome('lang-l2', async (ctx, home) => {
    const id = seed(home)
    const dir = catalogueDir(home)
    const relaunchLog = path.join(home, 'relaunch.json')
    const env = { SSW_I18N_CATALOGUE_DIR: dir, SSW_RELAUNCH_LOG: relaunchLog, SSW_PREFERRED_LANGUAGES: 'en-US' }
    const { app, win } = await launch(ctx, home, { env })
    h.assert((await page(win)).lang === 'en', 'Flown starts in English while the setting is absent')
    await fx.openProject(win, 'Langs')

    // L2: choose বাংলা; the restart notice appears as a status.
    await openSettings(win)
    await win.waitForSelector('.settings-modal .language-section')
    const select = win.locator('.settings-modal .language-section select')
    const options = await select.locator('option').evaluateAll((els) => els.map((e) => ({ value: e.value, text: e.textContent })))
    h.assert(options.some((o) => o.value === 'bn' && o.text === 'বাংলা (প্রিভিউ) · Bangla (preview)'), `the picker lists Bangla as a preview (${JSON.stringify(options)})`)
    await select.selectOption('bn')
    const status = win.locator('.settings-modal .language-section [role="status"]')
    h.assert((await status.textContent()).startsWith('Flown switches to '), `the restart notice is a status (${await status.textContent()})`)
    await shot(win, 'languages-settings')
    await closeSettings(win)
    h.assert(readUiPref(home)?.language === 'bn', `the choice is saved at once (${JSON.stringify(readUiPref(home))})`)

    // While an export runs, a restart is refused with its reason and nothing quits; the export finishes.
    await win.evaluate(() => localStorage.setItem('export-settings', JSON.stringify({ format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'software' })))
    await fx.openExportDialog(win)
    const out = path.join(home, 'during.mp4')
    await h.mockSaveDialog(app, out)
    await win.locator('.modal button.primary', { hasText: 'Export' }).click()
    // The settings give way to the running view as soon as the export starts.
    await win.waitForSelector('.modal .export-body', { state: 'detached', timeout: 30000 })
    await h.sleep(300)
    const refused = await win.evaluate((pid) => window.api.relaunch(pid), id)
    h.assert(refused.ok === false && refused.reason === 'Finish or stop the export first.', `a restart is refused while exporting (${JSON.stringify(refused)})`)
    h.assert(!fs.existsSync(relaunchLog), 'Flown did not restart')
    const r = await fx.waitForExport(win)
    h.assert(r.ok && fs.existsSync(out), `the export finished (${r.text.slice(0, 120)})`)
    await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()

    // Restart now from the editor: Flown restarts with the project to open again.
    await openSettings(win)
    await win.locator('.settings-modal .language-section button', { hasText: 'Restart now' }).click()
    const t0 = Date.now()
    while (!fs.existsSync(relaunchLog) && Date.now() - t0 < 15000) await h.sleep(100)
    const logged = JSON.parse(fs.readFileSync(relaunchLog, 'utf8'))
    const reopen = logged.args.find((a) => a.startsWith('--flown-open='))
    h.assert(reopen === `--flown-open=${id}`, `the restart reopens the project (${JSON.stringify(logged.args)})`)
    await app.waitForEvent('close', { timeout: 15000 }).catch(() => undefined)
    ctx.app = null

    // The new start: Bangla, left to right, the same project open, the fixture's texts.
    fs.rmSync(relaunchLog)
    const again = await launch(ctx, home, { env, args: [reopen] })
    await again.win.waitForSelector('.editor canvas', { timeout: 60000 })
    h.assert(JSON.stringify(await page(again.win)) === JSON.stringify({ lang: 'bn', dir: 'ltr' }), `<html lang="bn" dir="ltr"> (${JSON.stringify(await page(again.win))})`)
    h.assert((await again.win.inputValue('.titlebar input[aria-label="Recording name"]')) === 'Langs', 'the same project is open again')
    await openSettings(again.win)
    const heading = await again.win.textContent('.settings-modal .language-section h3')
    h.assert(heading === 'ভাষা · Language', `the Language heading comes from the fixture catalogue (${heading})`)
    // L3: a key the fixture lacks shows its English text.
    const notes = await again.win.$$eval('.settings-modal .language-section .hint', (els) => els.map((e) => e.textContent))
    h.assert(notes.includes('The recording controls are not translated yet.'), `a key the catalogue lacks is English (${notes.join(' | ')})`)
    await shot(again.win, 'languages-bangla-settings')

    // L4: the Bangla UI face is ready; a label with ঁ and র্ keeps its ink inside its line at 100% and 150%.
    h.assert(await again.win.evaluate(() => document.fonts.check('16px "Flown UI Bengali"')), 'the Flown UI Bengali face is loaded')
    for (const zoom of [1, 1.5]) {
      await again.app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.setZoomFactor(z)), zoom)
      await h.sleep(400)
      const fit = await again.win.evaluate(() => {
        const label = document.querySelector('.settings-modal .language-section label')
        const style = getComputedStyle(label)
        const ctx = document.createElement('canvas').getContext('2d')
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        const m = ctx.measureText(label.textContent)
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
        return { text: label.textContent, ink: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, line, box: label.getBoundingClientRect().height, family: style.fontFamily }
      })
      h.assert(fit.text.includes('চাঁদ') && fit.text.includes('পূর্ণিমা'), `the label holds ঁ and র্ (${fit.text})`)
      h.assert(fit.ink <= fit.line && fit.ink <= fit.box, `at ${zoom * 100}% the ink (${fit.ink.toFixed(1)} px) fits its line (${fit.line} px) and box (${fit.box.toFixed(1)} px)`)
    }
    await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.setZoomFactor(1)))
    await closeSettings(again.win)
    const timecode = await again.win.evaluate(() => {
      const el = document.querySelector('.timecode')
      const style = getComputedStyle(el)
      const ctx = document.createElement('canvas').getContext('2d')
      ctx.font = `${style.fontSize} ${style.fontFamily}`
      return { family: style.fontFamily, widths: [...'০১২৩৪৫৬৭৮৯'].map((d) => ctx.measureText(d).width) }
    })
    h.assert(/Flown UI Bengali/.test(timecode.family), `the timecode's fonts name Flown UI Bengali (${timecode.family})`)
    h.assert(new Set(timecode.widths.map((w) => w.toFixed(2))).size === 1, `the ten Bangla digits have one width (${timecode.widths})`)

    // L7: main's save dialog names its file types in the UI language.
    await again.win.evaluate(() => localStorage.setItem('export-settings', JSON.stringify({ format: 'wav', resolution: 720, fps: 30, quality: 'medium', encoder: 'auto' })))
    await again.app.evaluate(({ dialog }) => {
      globalThis.__saveOptions = null
      dialog.showSaveDialog = async (...a) => {
        globalThis.__saveOptions = a[a.length - 1]
        return { canceled: true }
      }
    })
    await fx.openExportDialog(again.win)
    await again.win.locator('.modal button.primary', { hasText: 'Export' }).click()
    await h.sleep(800)
    const saveOptions = await again.app.evaluate(() => globalThis.__saveOptions)
    h.assert(saveOptions && saveOptions.filters.some((f) => f.name === '‹bn› WAV অডিও'), `the save dialog's filter is in Bangla (${JSON.stringify(saveOptions)})`)
    await again.win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click().catch(() => undefined)

    // L11: in Bangla, the recording bar stays English, with lang="en" (a short recording, paused, then stopped).
    await again.win.click('button[aria-label="Back to recordings"]')
    await again.win.waitForSelector('.home', { timeout: 30000 })
    h.assert((await page(again.win)).lang === 'bn', 'Home is in Bangla')
    await h.waitForSources(again.win)
    await again.win.click('button.record')
    const t1 = Date.now()
    let toolbar = null
    while (!(toolbar = h.toolbarOf(again.app)) && Date.now() - t1 < 30000) await h.sleep(200)
    h.assert(toolbar, 'the recording bar opens')
    await toolbar.waitForSelector('.tb-btn.pause', { timeout: 60000 })
    h.assert((await toolbar.evaluate(() => document.documentElement.lang)) === 'en', 'the recording bar keeps lang="en"')
    const bar = await toolbar.evaluate(() => document.body.innerText)
    h.assert(!/[\u0980-\u09FF]/.test(bar), `the recording bar shows no Bangla (${bar})`)
    await toolbar.click('.tb-btn.stop')
    await again.win.waitForSelector('.editor canvas', { timeout: 120000 })
    await offline(again.app)
  }))

  await test('languages: the offer on Home, Not now for good, and Use Bangla while busy (L8)', fx.withHome('lang-l8', async (ctx, home) => {
    const dir = catalogueDir(home)
    const env = { SSW_I18N_CATALOGUE_DIR: dir, SSW_PREFERRED_LANGUAGES: 'bn-BD,en-US' }
    const { app, win } = await launch(ctx, home, { env })
    await win.waitForSelector('.language-offer', { timeout: 15000 })
    const text = await win.textContent('.language-offer')
    h.assert(text.includes('Flown is available in Bangla.'), `Home offers Bangla (${text})`)
    const langs = await win.$$eval('.language-offer [lang]', (els) => els.map((e) => e.getAttribute('lang')))
    h.assert(langs.length >= 3 && langs.every((l) => l === 'bn'), `its Bangla parts are lang="bn" (${langs})`)
    await shot(win, 'languages-offer')
    await win.locator('.language-offer button', { hasText: 'Not now' }).click()
    await win.waitForSelector('.language-offer', { state: 'detached' })
    await h.sleep(300)
    h.assert(JSON.stringify(readUiPref(home)?.offered) === '["bn"]', `Not now is recorded (${JSON.stringify(readUiPref(home))})`)
    await app.close()
    ctx.app = null
    const again = await launch(ctx, home, { env })
    await h.sleep(1500)
    h.assert(!(await again.win.$('.language-offer')), 'the offer never returns')
    await offline(again.app)
    await again.app.close()
    ctx.app = null

    // Windows lists only English, but a Bangla speech model is installed: the offer shows too.
    setUiPref(home, undefined)
    const models = path.join(home, '.config', 'Flown', 'speech-models')
    fs.mkdirSync(models, { recursive: true })
    fs.writeFileSync(path.join(models, BN_MODEL), 'model')
    const third = await launch(ctx, home, { env: { ...env, SSW_PREFERRED_LANGUAGES: 'en-US' } })
    await third.win.waitForSelector('.language-offer', { timeout: 15000 })
    // Use Bangla while main has something that would be lost: Flown says when it opens in Bangla, and keeps running.
    await third.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ui:relaunch')
      ipcMain.handle('ui:relaunch', () => ({ ok: false, reason: 'Finish or stop the export first.' }))
    })
    await third.win.locator('.language-offer button', { hasText: 'Use Bangla' }).click()
    await h.sleep(500)
    const later = await third.win.textContent('.language-offer')
    h.assert(later.includes('Flown opens in Bangla the next time it starts.'), `it says Flown opens in Bangla next time (${later})`)
    h.assert(readUiPref(home)?.language === 'bn', 'the choice is saved')
    h.assert(!third.app.process().killed && third.app.windows().length > 0, 'Flown keeps running')
    await offline(third.app)
  }))

  await test('languages: exported file names stay English and drawn frames do not follow the UI language (L12, L13)', fx.withHome('lang-l12', async (ctx, home) => {
    seed(home)
    const dir = catalogueDir(home)
    const env = { SSW_I18N_CATALOGUE_DIR: dir, SSW_PREFERRED_LANGUAGES: 'en-US' }
    const run = async (language) => {
      setUiPref(home, language ? { language } : undefined)
      const { app, win } = await launch(ctx, home, { env })
      h.assert((await page(win)).lang === (language ?? 'en'), `the session is in ${language ?? 'en'}`)
      await fx.openProject(win, 'Langs')
      // L13: the dialog's preview pixels and a thumbnail at the export size.
      await win.evaluate(() => {
        localStorage.setItem('export-mode', 'single')
        localStorage.setItem('export-settings', JSON.stringify({ format: 'mp4', resolution: 720, fps: 30, quality: 'medium', encoder: 'auto' }))
        localStorage.setItem('export-bundle', JSON.stringify({ chapters: true }))
        // Each session picks its own batch (the last one's choice is remembered).
        localStorage.removeItem('export-batch')
      })
      await fx.openExportDialog(win)
      await win.locator('.modal input[aria-label="Thumbnail frame"]').fill('1.5')
      await h.sleep(1500)
      const preview = await win.evaluate(() => {
        const c = document.querySelector('.modal canvas.export-preview-canvas')
        return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data)
      })
      const png = path.join(home, `thumb-${language ?? 'en'}.png`)
      await h.mockSaveDialog(app, png)
      await win.locator('.modal button', { hasText: 'Save thumbnail' }).click()
      const t0 = Date.now()
      while (!fs.existsSync(png) && Date.now() - t0 < 15000) await h.sleep(100)
      await h.sleep(300)
      // L12: a batch of two destinations with a chapters file.
      const folder = path.join(home, `batch-${language ?? 'en'}`)
      fs.mkdirSync(folder)
      await app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
      }, folder)
      await win.click('.modal .export-mode button:has-text("Batch")')
      for (const p of ['square', 'email']) await win.click(`.modal .preset-card[data-preset="${p}"]`)
      await shot(win, `languages-batch-${language ?? 'en'}`)
      await win.locator('.modal button.primary', { hasText: 'Export 2 files' }).click()
      await win.waitForSelector('.modal .success:has-text("Batch finished")', { timeout: 300000 })
      await offline(app)
      await app.close()
      ctx.app = null
      return { preview: crypto.createHash('sha256').update(Buffer.from(preview)).digest('hex'), png: crypto.createHash('sha256').update(fs.readFileSync(png)).digest('hex'), files: fs.readdirSync(folder).sort(), folder }
    }
    const en = await run(null)
    const bn = await run('bn')
    h.assert(en.files.length >= 2 && JSON.stringify(en.files) === JSON.stringify(bn.files), `the batch writes the same file names in Bangla (${en.files} / ${bn.files})`)
    for (const f of en.files.filter((n) => n.endsWith('.txt'))) h.assert(fs.readFileSync(path.join(en.folder, f), 'utf8') === fs.readFileSync(path.join(bn.folder, f), 'utf8'), `${f} says the same in both`)
    h.assert(en.png === bn.png, 'the thumbnail at the export size is byte for byte the same in Bangla')
    h.assert(en.preview === bn.preview, "the dialog preview's pixels are the same in Bangla")
    // The first frame of a batch file decodes to the same picture in both.
    const md5 = (f) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-frames:v', '10', '-f', 'md5', '-']).toString().trim()
    const square = en.files.find((f) => f.endsWith('.mp4'))
    h.assert(md5(path.join(en.folder, square)) === md5(path.join(bn.folder, square)), 'an exported video draws the same frames in Bangla')
  }))
}

main()
