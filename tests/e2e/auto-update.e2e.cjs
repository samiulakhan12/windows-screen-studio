// Flown's own updates in the real built app (docs/design/auto-update.md §6), with the scripted fake
// updater (SSW_UPDATES_FAKE, unpackaged builds only): a build that cannot update itself says so; the
// automatic path finds 9.9.9, downloads it and shows the Home notice; Later hides it; the release
// notes are plain text; Restart now is refused while an export runs and installs after; with
// automatic updates off nothing is checked on its own, and Check then Download keep the focus; a
// failed check and a failed download say so plainly.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const ef = require('./editor-fixtures.cjs')

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const userData = (home) => path.join(home, '.config', 'Flown')
const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

async function launch(ctx, home, env = {}) {
  const { app, win, logs } = await h.launch({ home, env })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

async function openAbout(win) {
  await win.click('.titlebar button[aria-label="Settings"]')
  await win.waitForSelector('.settings-modal [data-testid="updates"][data-phase]', { timeout: 10000 })
  await win.locator('.settings-modal [data-testid="updates"]').scrollIntoViewIfNeeded()
}

const status = (win) => win.textContent('[data-testid="updates-status"]')
const waitStatus = (win, re, timeout = 10000) => ef.waitFor(async () => re.test((await status(win)) || ''), `the update status matching ${re}`, timeout)

async function main() {
  await test('updates: a build that cannot update itself says so', fx.withHome('upd-off', async (ctx, home) => {
    const { win } = await launch(ctx, home)
    await openAbout(win)
    h.assert((await status(win)).includes('Updates are turned off in this build.'), 'the status says so')
    h.assert(await win.locator('[data-testid="updates-auto"]').isDisabled(), 'the switch is disabled')
    h.assert((await win.locator('[data-testid="updates-action"]').count()) === 0, 'no action button')
    h.assert((await win.locator('[data-testid="update-notice"]').count()) === 0, 'no Home notice')
  }))

  await test('updates: found, downloaded, Home notice, Later, plain notes, Restart now refused during an export, then installs', fx.withHome('upd-auto', async (ctx, home) => {
    const log = path.join(home, 'updater.log')
    const { app, win } = await launch(ctx, home, { SSW_UPDATES_FAKE: 'available', SSW_UPDATES_FAKE_LOG: log, SSW_UPDATES_FIRST_CHECK_MS: '400' })
    const notice = win.locator('[data-testid="update-notice"]')
    await notice.waitFor({ timeout: 15000 })
    h.assert((await notice.textContent()).includes('Flown 9.9.9 is ready. It installs when you close Flown.'), 'the notice names the version')
    h.assert(JSON.stringify(readLog(log)) === JSON.stringify(['check', 'download', 'install-on-quit true']), `checked, downloaded and armed: ${readLog(log)}`)
    const prefs = JSON.parse(fs.readFileSync(path.join(userData(home), 'updates.json'), 'utf8'))
    h.assert(prefs.auto === true && typeof prefs.lastCheck === 'string', `the last check is kept: ${JSON.stringify(prefs)}`)

    await notice.locator('button:has-text("Later")').click()
    await ef.waitFor(async () => (await notice.count()) === 0, 'Later hides the notice')

    await openAbout(win)
    await waitStatus(win, /Flown 9\.9\.9 is ready\. It installs when you close Flown\./)
    const action = win.locator('[data-testid="updates-action"]')
    h.assert((await action.textContent()) === 'Restart now', 'the action is Restart now')
    await win.click('.updates-notes summary')
    const notes = await win.textContent('[data-testid="updates-notes"]')
    h.assert(notes.includes("What's new") && notes.includes('• Faster exports & fixes'), `the notes as text: ${JSON.stringify(notes)}`)
    h.assert(!/script|pwned|<b>/.test(notes), 'no markup or script in the notes')
    h.assert((await win.evaluate(() => window.__pwned)) === undefined, 'the script in the notes never ran')

    const job = await win.evaluate(() => window.api.jobBegin('export', { pausable: false }))
    await action.click()
    await win.waitForSelector('[data-testid="updates-refused"]', { timeout: 5000 })
    h.assert((await win.textContent('[data-testid="updates-refused"]')) === 'Finish or stop the export first.', 'refused while the export runs')
    h.assert(!readLog(log).some((l) => l.startsWith('install ')), 'nothing installed during the export')
    await win.evaluate((id) => window.api.jobEnd(id, { kind: 'cancelled' }), job)

    // Kept before quitting: once the app has exited Playwright disposes it, and app.process() throws.
    const proc = app.process()
    const exited = new Promise((resolve) => proc.once('exit', resolve))
    await action.click()
    await Promise.race([exited, h.sleep(15000)])
    h.assert(readLog(log).includes('install 9.9.9'), `installed after the export: ${readLog(log)}`)
    h.assert(proc.exitCode !== null || proc.signalCode !== null, 'Flown quit to install')
    ctx.app = null
  }))

  await test('updates: off: no check on its own; Check, then Download keep the focus; the switch is saved', fx.withHome('upd-manual', async (ctx, home) => {
    const log = path.join(home, 'updater.log')
    fs.mkdirSync(userData(home), { recursive: true })
    fs.writeFileSync(path.join(userData(home), 'updates.json'), JSON.stringify({ version: 1, auto: false, lastCheck: null }))
    const { win } = await launch(ctx, home, { SSW_UPDATES_FAKE: 'available', SSW_UPDATES_FAKE_LOG: log, SSW_UPDATES_FIRST_CHECK_MS: '300' })
    await h.sleep(1500)
    h.assert(readLog(log).length === 0, `no automatic check: ${readLog(log)}`)
    await openAbout(win)
    h.assert(!(await win.locator('[data-testid="updates-auto"]').isChecked()), 'the switch is off')
    await waitStatus(win, /Flown has not looked for updates yet\./)
    const action = win.locator('[data-testid="updates-action"]')
    await action.focus()
    await win.keyboard.press('Enter')
    await waitStatus(win, /Flown 9\.9\.9 is available\./)
    h.assert((await action.textContent()) === 'Download Flown 9.9.9', 'the action offers the download')
    h.assert(readLog(log).join() === 'check', `only checked: ${readLog(log)}`)
    await win.keyboard.press('Enter')
    await waitStatus(win, /Downloading Flown 9\.9\.9…/)
    h.assert((await action.getAttribute('aria-disabled')) === 'true', 'waiting, not disabled')
    await waitStatus(win, /Flown 9\.9\.9 is ready/)
    h.assert(await win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'updates-action'), 'the focus stayed on the action')
    h.assert((await win.locator('[data-testid="update-notice"]').count()) === 1, 'the Home notice shows (behind Settings)')

    await win.locator('[data-testid="updates-auto"]').check()
    await ef.waitFor(() => JSON.parse(fs.readFileSync(path.join(userData(home), 'updates.json'), 'utf8')).auto === true, 'the switch is saved')
  }))

  await test('updates: a failed check says so plainly, with when it last tried', fx.withHome('upd-error', async (ctx, home) => {
    const { win } = await launch(ctx, home, { SSW_UPDATES_FAKE: 'error', SSW_UPDATES_FIRST_CHECK_MS: '200' })
    await openAbout(win)
    await waitStatus(win, /Couldn't check for updates\. Check your internet connection and try again\. Last checked/)
    h.assert(!(await status(win)).includes('ERR_'), 'no raw error')
    h.assert((await win.textContent('[data-testid="updates-action"]')) === 'Check for updates', 'Check for updates is offered again')
  }))

  await test('updates: a failed download says Flown tries again, and Download is offered', fx.withHome('upd-dlerr', async (ctx, home) => {
    const log = path.join(home, 'updater.log')
    const { win } = await launch(ctx, home, { SSW_UPDATES_FAKE: 'download-error', SSW_UPDATES_FAKE_LOG: log, SSW_UPDATES_FIRST_CHECK_MS: '200' })
    await openAbout(win)
    await waitStatus(win, /The update couldn't be downloaded\. Flown will try again later\./)
    h.assert((await win.textContent('[data-testid="updates-action"]')) === 'Download Flown 9.9.9', 'Download is offered again')
    h.assert((await win.locator('[data-testid="update-notice"]').count()) === 0, 'no Home notice')
  }))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
