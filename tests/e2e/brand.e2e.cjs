// Flown branding end to end: the window title and Home's logo, Settings › About (version, Qbexel,
// the website link that only opens qbexel.com through the main process), "About Flown" in the
// command palette, and the first start after the rename from "Screen Studio for Windows" (settings
// and recordings moved, no recording missing from the library).
// SSW_BRAND_SHOTS=<dir> saves brand-home.png and brand-about.png there.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_BRAND_SHOTS || null
const LEGACY = 'Screen Studio for Windows'
const pkg = JSON.parse(fs.readFileSync(path.join(h.APP_DIR, 'package.json'), 'utf8'))

/** Replaces shell.openExternal in the main process so links are recorded instead of opening a browser. */
async function recordOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => {
      globalThis.__opened.push(url)
    }
  })
}
const openedUrls = (app) => app.evaluate(() => globalThis.__opened)

/** Moves a project seeded into Videos\Flown to the old Videos\Screen Studio for Windows. */
function seedLegacyProject(home, opts) {
  const id = f.seedProject(home, opts)
  const legacy = path.join(home, 'Videos', LEGACY)
  fs.mkdirSync(legacy, { recursive: true })
  fs.renameSync(path.join(h.projectsRoot(home), id), path.join(legacy, id))
  return id
}

const libraryNames = (win) => win.$$eval('.project-card .project-name', (els) => els.map((e) => e.textContent))

async function main() {
  await h.run('brand: the window title and Home show Flown', async (ctx) => {
    const home = h.tempHome('brand-home')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.waitForSelector('.titlebar .flown-logo', { timeout: 30000 })
    h.assert((await win.title()) === 'Flown', `page title ${await win.title()}`)
    const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))
    h.assert(titles.length && titles.every((t) => t === 'Flown'), `window titles ${JSON.stringify(titles)}`)
    const logo = await win.$eval('.titlebar .flown-logo', (el) => ({
      label: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      images: [...el.querySelectorAll('img')].map((img) => ({ loaded: img.complete && img.naturalWidth > 0, w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height }))
    }))
    h.assert(logo.label === 'Flown' && logo.role === 'img', `logo label ${JSON.stringify(logo)}`)
    h.assert(logo.images.length === 2 && logo.images.every((i) => i.loaded), `mark and wordmark load ${JSON.stringify(logo.images)}`)
    h.assert(Math.round(logo.images[0].w) === 22 && Math.round(logo.images[0].h) === 22, `22 px mark ${JSON.stringify(logo.images[0])}`)
    const text = await win.evaluate(() => document.body.innerText)
    h.assert(!/screen studio/i.test(text), 'Home never says Screen Studio')
    // The mark is vector art: at 2x it is drawn from the SVG, not scaled up from a bitmap.
    const svgs = await win.$$eval('.titlebar .flown-logo img', (imgs) => imgs.map((i) => i.src.startsWith('data:image/svg+xml') || /\.svg$/.test(i.src)))
    h.assert(svgs.every(Boolean), `logo images are SVG (${JSON.stringify(svgs)})`)
    if (SHOTS) {
      await h.waitForSources(win).catch(() => undefined)
      await h.sleep(500)
      await win.screenshot({ path: path.join(SHOTS, 'brand-home.png') })
    }
  })

  await h.run('brand: Settings › About shows the version, Built by Qbexel and opens only qbexel.com', async (ctx) => {
    const home = h.tempHome('brand-about')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await recordOpenExternal(app)
    await win.click('.titlebar button[aria-label="Settings"]')
    await win.waitForSelector('.settings-modal .about-section', { timeout: 10000 })
    const version = await app.evaluate(({ app }) => app.getVersion())
    h.assert(version === pkg.version, `app version ${version}`)
    await f.waitFor(async () => (await win.textContent('.about-section'))?.includes(`Version ${version}`), 'version shown', 5000)
    const about = await win.textContent('.about-section')
    for (const want of ['About', 'Flown', 'Built by Qbexel', 'qbexel.com', '© 2026 Qbexel']) h.assert(about.includes(want), `About shows "${want}": ${about}`)
    const link = await win.$eval('.about-section a', (a) => ({ text: a.textContent, href: a.getAttribute('href') }))
    h.assert(link.text === 'qbexel.com' && link.href === 'https://qbexel.com', `link ${JSON.stringify(link)}`)

    if (SHOTS) {
      await win.$eval('.about-section', (el) => el.scrollIntoView({ block: 'nearest' }))
      await h.sleep(300)
      await win.screenshot({ path: path.join(SHOTS, 'brand-about.png') })
    }

    const url = win.url()
    await win.click('.about-section a')
    await f.waitFor(async () => (await openedUrls(app)).length === 1, 'the website is opened', 5000)
    h.assert(JSON.stringify(await openedUrls(app)) === JSON.stringify(['https://qbexel.com']), `opened ${JSON.stringify(await openedUrls(app))}`)
    h.assert(win.url() === url, `the window did not navigate (${win.url()})`)
    // The IPC takes no address: whatever the page passes, only the fixed URL is opened.
    await win.evaluate(() => window.api.openCompanyWebsite('https://example.com/evil'))
    h.assert(JSON.stringify(await openedUrls(app)) === JSON.stringify(['https://qbexel.com', 'https://qbexel.com']), `opened ${JSON.stringify(await openedUrls(app))}`)
  })

  await h.run('brand: "About Flown" in the command palette opens About', async (ctx) => {
    const home = h.tempHome('brand-palette')
    f.seedProject(home, { id: 'rec-about', name: 'AboutPalette', seconds: 4 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await f.openProject(win, 'AboutPalette')
    await win.keyboard.press('Control+k')
    await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
    await win.keyboard.type('about')
    await f.waitFor(async () => (await win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent)))[0] === 'About Flown', '"About Flown" listed first', 3000)
    await win.keyboard.press('Enter')
    await win.waitForSelector('.settings-modal[data-section="about"] .about-section', { timeout: 5000 })
    h.assert((await win.textContent('.about-section')).includes('Built by Qbexel'), 'About opened from the palette')
  })

  await h.run('brand: the first start as Flown moves the old settings and recordings, and lists every recording', async (ctx) => {
    const home = h.tempHome('brand-migrate')
    // An install of the old name: its userData (AI keys file, editor prefs) and recordings.
    const oldUserData = path.join(home, '.config', LEGACY)
    fs.mkdirSync(oldUserData, { recursive: true })
    const prefs = { shortcuts: { split: ['Ctrl+Shift+S'] } }
    fs.writeFileSync(path.join(oldUserData, 'editor-prefs.json'), JSON.stringify(prefs))
    seedLegacyProject(home, { id: 'rec-20250101-090000', name: 'Old recording', seconds: 3 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    h.assert(userData === path.join(home, '.config', 'Flown'), `userData ${userData}`)
    h.assert(!fs.existsSync(oldUserData), 'the old userData folder was moved')
    h.assert(JSON.stringify(JSON.parse(fs.readFileSync(path.join(userData, 'editor-prefs.json'), 'utf8'))) === JSON.stringify(prefs), 'settings kept')
    await win.waitForSelector('.project-card .project-name:has-text("Old recording")', { timeout: 30000 })
    h.assert(fs.existsSync(path.join(h.projectsRoot(home), 'rec-20250101-090000', 'project.json')), 'the recording is in Videos/Flown')
    h.assert(!fs.existsSync(path.join(home, 'Videos', LEGACY)), 'the old recordings folder is gone')
    // It opens from its new place.
    await f.openProject(win, 'Old recording')
  })

  await h.run('brand: recordings in both the old and the new folder all stay in the library', async (ctx) => {
    const home = h.tempHome('brand-merge')
    seedLegacyProject(home, { id: 'rec-a', name: 'Old A', seconds: 3, ageMs: 3000 })
    seedLegacyProject(home, { id: 'rec-b', name: 'Old B', seconds: 3, ageMs: 2000 })
    f.seedProject(home, { id: 'rec-a', name: 'New A', seconds: 3, ageMs: 1000 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await f.waitFor(async () => (await libraryNames(win)).length === 3, 'three recordings listed', 30000)
    const names = (await libraryNames(win)).sort()
    h.assert(JSON.stringify(names) === JSON.stringify(['New A', 'Old A', 'Old B']), `library ${JSON.stringify(names)}`)
    h.assert(JSON.stringify(fs.readdirSync(h.projectsRoot(home)).sort()) === JSON.stringify(['rec-a', 'rec-a-2', 'rec-b']), 'the clashing id was renamed')
    await f.openProject(win, 'Old A')
  })
}

main()
