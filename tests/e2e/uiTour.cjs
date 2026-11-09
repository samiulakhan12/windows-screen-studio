/**
 * The English guard's tour (docs/design/output-and-languages.md §10.6, tests 9 and 10): a fixed walk
 * through the app in English with no `ui` preference, the same on every run, that records for each
 * screen its title, text, every element's text attributes and accessible names, the main process's
 * strings (dialog titles and filters, message boxes, confirmations, notifications, taskbar buttons),
 * the box, font, colour, direction and alignment of every element with text, and a screenshot.
 *
 * Deterministic set-up, so a difference means the app's English changed:
 * - the clock: SSW_FIXED_NOW fixes Date in main before its modules load (src/main/fixedNow.ts), every
 *   window gets Playwright's clock.install at the same instant, and the process runs with TZ=UTC;
 * - the data: a fresh copy of a fixed home (projects, no preferences) at a fixed path for every run,
 *   the network blocked and logged, update checks answered by SSW_UPDATES_FAKE;
 * - motion: a stylesheet turns off animations, transitions and the caret;
 * - settling: before each capture the page waits for its fonts and images, a quiet DOM, and two equal
 *   screenshots in a row (filmstrips, waveforms and thumbnails drawn);
 * - masks: what changes by nature (MASKS below) is replaced by a placeholder in the text and painted
 *   over in the screenshots, in the baseline and in every run alike. No source file changes for it.
 *
 * The tour runs with no language shipped, so Settings has no Language section and the palette no
 * Language… command, as in an English install before a language ships.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

/** The tour's fixed instant (Home's dates, the update-check time). */
const FIXED_NOW = '2026-03-12T14:02:00Z'
/** The tour's home: a fixed path, so the paths the app shows are the same on every run. */
const TOUR_HOME = path.join(os.tmpdir(), 'flown-english-guard-home')

/**
 * What changes by nature, as selectors: replaced by MASK_TEXT in the text and names, painted over in
 * screenshots, left out of the layout. The running view's speed and time left, the done view's
 * seconds and size, Storage's sizes and free space, the version number, capture thumbnails.
 */
const MASKS = [
  // Capture sources: thumbnails of the live screen.
  '.source img',
  '.source canvas',
  // The running view's progress bar, and the done view's size, seconds and encoder line.
  '.modal .progress',
  '.modal p.hint.path + p.hint',
  // The recording bar's time and level meter.
  '.tb-time',
  '.rb-meter',
  // Storage's sizes and free space, and the version number.
  '.storage-total',
  '.storage-size',
  '.about-version',
  'video'
]
const MASK_TEXT = '‹masked›'

/** Turns off motion and the caret in every window. */
const MOTION_CSS = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }`

/** Installed in every page: the motion stylesheet and window.__guardSettled. */
const PAGE_SCRIPT = `(() => {
  const css = ${JSON.stringify(MOTION_CSS)}
  const add = () => {
    if (document.getElementById('english-guard-motion')) return
    const s = document.createElement('style')
    s.id = 'english-guard-motion'
    s.textContent = css
    ;(document.head || document.documentElement).appendChild(s)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add)
  else add()
  /** Resolves once fonts and images have loaded and the DOM has been quiet for quietMs. */
  window.__guardSettled = async (quietMs = 400, timeoutMs = 15000) => {
    add()
    const end = performance.now() + timeoutMs
    await document.fonts.ready
    while (performance.now() < end) {
      const pending = [...document.images].filter((i) => !i.complete).length
      if (!pending) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((resolve) => {
      let timer = setTimeout(done, quietMs)
      const obs = new MutationObserver(() => {
        clearTimeout(timer)
        if (performance.now() > end) return done()
        timer = setTimeout(done, quietMs)
      })
      function done() {
        obs.disconnect()
        resolve()
      }
      obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    })
  }
})()`

/** In the page: title, text, attributes and layout, leaving out what MASKS cover. */
function collectPage(masks) {
  const masked = new Set()
  for (const sel of masks) for (const el of document.querySelectorAll(sel)) masked.add(el)
  const isMasked = (el) => {
    for (let e = el; e; e = e.parentElement) if (masked.has(e)) return true
    return false
  }
  const pathOf = (el) => {
    const parts = []
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const parent = e.parentElement
      const same = parent ? [...parent.children].filter((c) => c.tagName === e.tagName) : [e]
      parts.unshift(`${e.tagName.toLowerCase()}${same.length > 1 ? `:${same.indexOf(e) + 1}` : ''}`)
    }
    return parts.join('>')
  }
  const maskTexts = [...masked].map((el) => el.innerText || '').filter((t) => t.trim()).sort((a, b) => b.length - a.length)
  const unmask = (s) => maskTexts.reduce((acc, t) => acc.split(t).join('‹masked›'), s)
  const text = unmask(document.body.innerText)
  const attrs = []
  const NAMES = ['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext', 'aria-roledescription', 'role', 'label']
  for (const el of document.body.querySelectorAll('*')) {
    if (isMasked(el)) continue
    const a = {}
    for (const n of NAMES) {
      const v = el.getAttribute(n)
      if (v !== null) a[n] = unmask(v)
    }
    const described = el.getAttribute('aria-describedby')
    if (described) a.describedby = unmask(described.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
    if (Object.keys(a).length) attrs.push({ path: pathOf(el), ...a })
  }
  const boxes = []
  const half = (v) => Math.round(v * 2) / 2
  for (const el of document.body.querySelectorAll('*')) {
    if (isMasked(el)) continue
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) continue
    const cs = getComputedStyle(el)
    const rtl = cs.direction === 'rtl'
    // Logical keywords compared through the direction: X7 turns left into start without moving anything.
    const align = cs.textAlign === 'start' ? (rtl ? 'right' : 'left') : cs.textAlign === 'end' ? (rtl ? 'left' : 'right') : cs.textAlign
    boxes.push({
      path: pathOf(el),
      tag: el.tagName.toLowerCase(),
      box: [half(r.x), half(r.y), half(r.width), half(r.height)],
      font: [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.lineHeight],
      color: cs.color,
      direction: cs.direction,
      align
    })
  }
  return { title: document.title, text, attrs, boxes, maskTexts }
}

/** Main-process hooks: dialogs and notifications are recorded instead of shown, the network is blocked and logged. */
async function installMainHooks(app) {
  await app.evaluate(({ dialog, Notification, session }) => {
    const g = globalThis
    g.__guardMain = []
    g.__guardBlocked = []
    const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : undefined)
    const rec = (kind, a, b) => {
      const o = (b && typeof b === 'object' ? b : a) || {}
      g.__guardMain.push({
        kind,
        title: o.title,
        message: o.message,
        detail: o.detail,
        buttons: o.buttons,
        buttonLabel: o.buttonLabel,
        filters: Array.isArray(o.filters) ? o.filters.map((x) => `${x.name}: ${x.extensions.join(',')}`) : undefined,
        defaultName: base(o.defaultPath)
      })
    }
    dialog.showSaveDialog = async (a, b) => {
      rec('save', a, b)
      const file = g.__guardSavePath
      return file ? { canceled: false, filePath: file } : { canceled: true, filePath: undefined }
    }
    dialog.showOpenDialog = async (a, b) => {
      rec('open', a, b)
      return { canceled: true, filePaths: [] }
    }
    dialog.showMessageBox = async (a, b) => {
      rec('message', a, b)
      return { response: 0, checkboxChecked: false }
    }
    dialog.showMessageBoxSync = (a, b) => {
      rec('message', a, b)
      return 0
    }
    dialog.showErrorBox = (title, content) => rec('error', { title, message: content })
    Notification.prototype.show = function show() {
      g.__guardMain.push({ kind: 'notification', title: this.title, body: this.body })
    }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
      g.__guardBlocked.push(d.url)
      cb({ cancel: true })
    })
  })
}

/** The main-process strings recorded since the last call (and the taskbar trace's notifications and buttons). */
async function takeMainStrings(app) {
  return app.evaluate(() => {
    const g = globalThis
    const out = g.__guardMain.splice(0)
    for (const t of (g.__sswJobsTrace || []).splice(0)) {
      if (t.call === 'notify') out.push({ kind: 'notify', ...t.value })
      if (t.call === 'buttons') out.push({ kind: 'taskbar', tooltips: t.value.map((b) => b.tooltip) })
    }
    return out
  })
}

/** A file size inside a main-process string (a notification's "Demo.mp4 · 2.8 MB") changes by nature: masked. */
const SIZE_IN_TEXT = /\b\d+(?:\.\d+)? (?:bytes|KB|MB|GB)\b/g

function maskMain(entry) {
  const out = {}
  for (const [k, v] of Object.entries(entry)) out[k] = typeof v === 'string' ? v.replace(SIZE_IN_TEXT, MASK_TEXT) : v
  return out
}

/** Prepares a window: the motion stylesheet, the settled helper and the fixed clock. */
async function prepareWindow(win) {
  await win.clock.install({ time: new Date(FIXED_NOW) })
  await win.addInitScript(PAGE_SCRIPT)
  await win.evaluate(PAGE_SCRIPT)
}

/** Waits until the page is settled: its own signal, then two equal screenshots in a row. */
async function settle(win) {
  await win.evaluate(() => window.__guardSettled())
  let last = null
  for (let k = 0; k < 20; k++) {
    const shot = await win.screenshot({ animations: 'disabled', caret: 'hide', mask: MASKS.map((s) => win.locator(s)), maskColor: '#FF00FF' })
    if (last && shot.equals(last)) return shot
    last = shot
    await h.sleep(250)
  }
  return last
}

/* ---------- fixtures ---------- */

/** A sine tone as music (cached like the other e2e media). */
function makeMusic(seconds) {
  const dir = path.join(os.tmpdir(), 'ssw-e2e-media')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `music-${seconds}s.mp3`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp3`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '96k', tmp])
  fs.renameSync(tmp, file)
  return file
}

const words = (id, start, text) => {
  const list = text.split(' ')
  return { id, start, end: start + list.length * 0.4, text, words: list.map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.35 })) }
}

/** The two fixture projects, with fixed dates: one 16:9 with camera, captions, chapters and music; one 9:16. */
function seedProjects(home) {
  const wide = f.seedProject(home, {
    id: 'guard-wide',
    name: 'Product tour',
    seconds: 6,
    audio: true,
    webcam: true,
    zooms: [
      { id: 'z1', start: 0.5, end: 2, scale: 2, focus: { mode: 'cursor' }, auto: false },
      { id: 'z2', start: 3, end: 4.5, scale: 1.6, focus: { mode: 'cursor' }, auto: true }
    ],
    annotations: [{ id: 'a1', start: 1, end: 3, text: 'Click Save', x: 0.5, y: 0.2, size: 0.05, style: 'pill' }]
  })
  const tall = f.seedProject(home, { id: 'guard-tall', name: 'Phone demo', seconds: 4, width: 720, height: 1280 })
  const edit = (id, patch) => {
    const file = path.join(h.projectsRoot(home), id, 'project.json')
    const p = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...p, ...patch(p) }, null, 2))
  }
  fs.copyFileSync(makeMusic(6), path.join(h.projectsRoot(home), wide, 'music-1.mp3'))
  edit(wide, (p) => ({
    createdAt: '2026-03-10T09:30:00.000Z',
    chapters: [
      { id: 'ch1', t: 0, title: 'Intro' },
      { id: 'ch2', t: 3, title: 'Saving' }
    ],
    transcript: {
      language: 'en',
      provider: 'local',
      model: 'speech-small',
      createdAt: '2026-03-10T09:40:00.000Z',
      segments: [words('k1', 0.5, 'Here is the product tour'), words('k2', 3.2, 'Now we save the file')]
    },
    audio: { ...p.audio, music: { path: 'music-1.mp3', volume: 0.4, ducking: 0.6, loop: true, fadeIn: 1, fadeOut: 1 } }
  }))
  edit(tall, (p) => ({ createdAt: '2026-03-11T16:45:00.000Z', style: { ...p.style, aspectRatio: '9:16' } }))
  return { wide, tall }
}

/** A fresh tour home at the fixed path: no preferences, no projects yet. */
function freshHome() {
  fs.rmSync(TOUR_HOME, { recursive: true, force: true })
  fs.mkdirSync(path.join(TOUR_HOME, 'Videos'), { recursive: true })
  return TOUR_HOME
}

/* ---------- the tour ---------- */

/**
 * Walks the tour once and returns its screens. `out` is a folder for the screenshots. Every step
 * waits for what it opens; a screen that cannot be reached fails the tour.
 */
async function runTour({ out, appDir = h.APP_DIR, log = () => undefined }) {
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const home = freshHome()
  const screens = []
  const { app, win, logs } = await h.launch({
    home,
    appDir,
    env: { TZ: 'UTC', SSW_FIXED_NOW: FIXED_NOW, SSW_UPDATES_FAKE: 'none', SSW_JOBS_TRACE: '1', SSW_JOBS_UNFOCUSED: '1', LANG: 'en_US.UTF-8' }
  })
  const pageDialogs = []
  const onDialog = (d) => {
    pageDialogs.push({ kind: `page-${d.type()}`, message: d.message() })
    void d.dismiss().catch(() => undefined)
  }
  win.on('dialog', onDialog)
  try {
    await installMainHooks(app)
    await prepareWindow(win)
    await win.reload()
    await win.waitForSelector('.home', { timeout: 30000 })

    const capture = async (name, page = win) => {
      log(`screen ${name}`)
      // The pointer rests in the same corner for every capture, so no hover depends on the step before.
      await page.mouse.move(0, 0)
      const shot = await settle(page)
      const data = await page.evaluate(collectPage, MASKS)
      let aria = await page.locator('body').ariaSnapshot()
      for (const t of data.maskTexts) aria = aria.split(t).join(MASK_TEXT)
      delete data.maskTexts
      const main = [...(await takeMainStrings(app)), ...pageDialogs.splice(0)].map(maskMain)
      fs.writeFileSync(path.join(out, `${name}.png`), shot)
      screens.push({ name, ...data, aria, main })
    }
    const press = async (key) => {
      await win.keyboard.press(key)
      await h.sleep(150)
    }

    // Home without projects, then with the two fixture projects.
    await capture('home-empty')
    const { wide, tall } = seedProjects(home)
    await win.reload()
    await win.waitForSelector('.project-open', { timeout: 30000 })
    await capture('home-projects')

    // Settings, every section.
    await win.click('.titlebar button[aria-label="Settings"]')
    await win.waitForSelector('.settings-modal')
    await capture('settings')
    const sections = await win.$$eval('.settings-body > *', (els) => els.length)
    for (let i = 0; i < sections; i++) {
      const shown = await win.evaluate((k) => {
        const el = document.querySelectorAll('.settings-body > *')[k]
        if (!el || !el.getBoundingClientRect().height) return false
        el.scrollIntoView({ block: 'start' })
        return true
      }, i)
      if (shown) await capture(`settings-${String(i + 1).padStart(2, '0')}`)
    }
    await press('Escape')
    await win.waitForSelector('.settings-modal', { state: 'detached' })

    // The recording side on Home: the Windows and Area tabs, the area picker, then Screens again.
    await h.waitForSources(win)
    const homeTab = (tab) => win.locator('.home .segmented button', { hasText: new RegExp(`^\\s*${tab}\\s*$`) }).first()
    await homeTab('Windows').click()
    await capture('home-tab-windows')
    await homeTab('Area').click()
    await win.waitForSelector('button.record[disabled]')
    await capture('home-tab-area')
    await h.waitForSources(win)
    await win.click('.source')
    const overlay = await f.waitFor(() => app.windows().find((w) => w.url().includes('#/region')) || null, 'the area picker opens', 15000)
    await overlay.waitForSelector('.region-root')
    await prepareWindow(overlay)
    await capture('region-picker', overlay)
    await overlay.keyboard.press('Escape').catch(() => undefined)
    await f.waitFor(() => !app.windows().some((w) => w.url().includes('#/region')), 'the area picker closes', 15000)
    await homeTab('Screens').click()
    await h.waitForSources(win)
    await capture('home-tab-screens')

    // The editor on the 16:9 project: every panel tab.
    await f.openProject(win, 'Product tour')
    await capture('editor')
    const tabs = await win.$$eval('.insp-tabs button[title]', (els) => els.map((e) => e.getAttribute('title')))
    for (const t of tabs) {
      await win.click(`.insp-tabs button[title="${t}"]`)
      await f.waitFor(() => win.evaluate((name) => document.querySelector('.insp-tabs button.active')?.getAttribute('title') === name, t), `${t} opens`, 5000)
      await capture(`tab-${t.toLowerCase().replace(/\W+/g, '-')}`)
    }
    await win.click('.insp-tabs button[title="Style"]')

    // The timeline with a selection, then a notice.
    const zoom = win.locator('.zoom-seg, [data-testid="zoom-seg"]').first()
    if (await zoom.count()) {
      await zoom.click()
      await capture('timeline-selection')
      await press('Escape')
    }
    await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await press('Control+z')
    await win.waitForSelector('text=Nothing to undo', { timeout: 5000 })
    await capture('notice')

    // The command palette, empty and with a query.
    await win.click('button[aria-label="Command palette"]')
    await win.waitForSelector('.command-palette[role="dialog"]')
    await capture('palette-empty')
    await win.keyboard.type('zoom')
    await capture('palette-typed')
    await press('Escape')
    await win.waitForSelector('.command-palette', { state: 'detached' })

    // The shortcuts editor.
    await win.click('button[aria-label="Keyboard shortcuts"]')
    await win.waitForSelector('.shortcuts-modal')
    await capture('shortcuts')
    await press('Escape')
    await win.waitForSelector('.shortcuts-modal', { state: 'detached' })

    // Review mode, Versions and Polish.
    await win.click('[data-testid="review-open"]')
    await win.waitForSelector('[data-testid="review-panel"]')
    await capture('review')
    await win.click('[data-testid="review-open"]')
    await win.waitForSelector('[data-testid="review-panel"]', { state: 'detached' })
    await win.click('[data-testid="versions-open"]')
    await win.waitForSelector('.modal')
    await capture('versions')
    await press('Escape')
    await win.waitForSelector('.modal', { state: 'detached' })
    await win.click('[data-testid="polish-open"]')
    await win.waitForSelector('.polish-dialog')
    await capture('polish')
    await press('Escape')
    await win.waitForSelector('.polish-dialog', { state: 'detached' })

    // The export dialog: every format with Settings open, both modes, Also save all on.
    await win.click('header button.primary:has-text("Export")')
    await win.waitForSelector('.modal[aria-label="Export"]')
    const chip = (row, label) => win.locator(`.modal .form-row:has(> span:text-is("${row}")) .chip`, { hasText: label }).first()
    const open = await win.$('.modal .export-settings')
    if (!open) await win.click('.modal button:has-text("Settings")')
    for (const format of ['MP4', 'MOV', 'WebM', 'GIF', 'M4A']) {
      await chip('Format', format).click()
      await capture(`export-${format.toLowerCase()}`)
    }
    await chip('Format', 'MP4').click()
    const also = win.locator('.modal [role="group"][aria-label="Also save"] button:not([disabled])')
    for (let i = 0; i < (await also.count()); i++) if ((await also.nth(i).getAttribute('aria-pressed')) !== 'true') await also.nth(i).click()
    await capture('export-also-save')
    for (let i = 0; i < (await also.count()); i++) if ((await also.nth(i).getAttribute('aria-pressed')) === 'true') await also.nth(i).click()
    await win.click('.modal [role="tab"]:has-text("Batch")')
    await capture('export-batch')
    await win.click('.modal [role="tab"]:has-text("One file")')

    // A short export: the running and done views, and the save dialog's title and filters.
    await chip('Resolution', '720p').click()
    const outDir = path.join(TOUR_HOME, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    await app.evaluate((_e, file) => {
      globalThis.__guardSavePath = file
    }, path.join(outDir, 'Product tour.mp4'))
    await win.click('.modal .btn.primary')
    // Paused while frames are drawn, so the running view holds still for its capture.
    await win.waitForSelector('.modal .export-pause[aria-disabled="false"]', { timeout: 60000 })
    await win.click('.modal .export-pause')
    await win.waitForSelector('.modal .export-status:text-is("Paused · Resume to carry on")', { timeout: 10000 })
    await capture('export-running')
    await win.click('.modal .export-pause')
    await f.waitFor(async () => /Export finished/.test((await win.textContent('.modal').catch(() => '')) || ''), 'the export finishes', 600000)
    await capture('export-done')
    await press('Escape')
    await win.waitForSelector('.modal[aria-label="Export"]', { state: 'detached' }).catch(() => undefined)

    // An export that fails: the error view.
    await win.click('header button.primary:has-text("Export")')
    await win.waitForSelector('.modal[aria-label="Export"]')
    await app.evaluate((_e, file) => {
      globalThis.__guardSavePath = file
    }, path.join(TOUR_HOME, 'no such folder', 'Product tour.mp4'))
    await win.click('.modal .btn.primary')
    await f.waitFor(async () => /Export failed|Could not/.test((await win.textContent('.modal').catch(() => '')) || ''), 'the export fails', 60000)
    await capture('export-error')
    await app.evaluate(() => {
      globalThis.__guardSavePath = null
    })
    await press('Escape')
    await win.waitForSelector('.modal[aria-label="Export"]', { state: 'detached' }).catch(() => undefined)

    // The 9:16 project, then a confirmation question on Home.
    await win.click('button[aria-label="Back to recordings"]')
    await win.waitForSelector('.home', { timeout: 30000 })
    await f.openProject(win, 'Phone demo')
    await capture('editor-tall')
    await win.click('button[aria-label="Back to recordings"]')
    await win.waitForSelector('.home', { timeout: 30000 })
    await win.click('button[aria-label="Delete Phone demo"]')
    await h.sleep(300)
    await capture('home-confirm')
    void wide
    void tall

    // The recording bar, paused so it holds still, then stopped.
    await h.waitForSources(win)
    await win.click('button.record')
    const toolbar = await f.waitFor(() => h.toolbarOf(app), 'the recording bar opens', 30000)
    await toolbar.waitForSelector('.tb-btn.pause', { timeout: 60000 })
    await prepareWindow(toolbar)
    await toolbar.click('.tb-btn.pause')
    await toolbar.waitForSelector('.tb-btn.pause[aria-label="Resume"]', { timeout: 10000 })
    await capture('recording-bar', toolbar)
    await toolbar.click('.tb-btn.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })

    const blocked = await app.evaluate(() => globalThis.__guardBlocked)
    return { screens, blocked }
  } catch (err) {
    if (logs.length) console.error(logs.slice(-40).join(''))
    throw err
  } finally {
    win.off('dialog', onDialog)
    await app.close().catch(() => undefined)
  }
}

module.exports = { FIXED_NOW, TOUR_HOME, MASKS, MASK_TEXT, MOTION_CSS, runTour, collectPage, maskMain }
