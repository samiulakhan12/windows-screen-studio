// Share without a server in the real built app (docs/design/share.md §9): a fake Windows profile
// (SSW_SHARE_FAKE_CLOUD) with OneDrive and Dropbox folders found through the registry and
// Dropbox's info.json; Settings › Share listing them with where they were found, a folder added
// with the folder dialog, a Slack webhook added (and a foreign URL refused) and tested against a
// local mock (SSW_SHARE_WEBHOOK_ORIGIN, never a real service); an export with "Copy to OneDrive"
// and "Post to #demos" chosen, the copy in OneDrive/Flown and the message with no local path;
// the choices remembered per preset; the notification offering the destinations; no webhook
// secret in share.json or the log.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const ef = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const SLACK = 'https://hooks.slack.com/services/T0E2E/B0E2E/e2eSecretTokenPart'
const trace = (app) => app.evaluate(() => globalThis.__sswJobsTrace || [])

/** A local stand-in for Slack: records every post, answers "ok". */
function mockChat() {
  const posts = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      posts.push({ method: req.method, path: req.url, type: req.headers['content-type'], body })
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posts, origin: `http://127.0.0.1:${server.address().port}` })))
}

/** A Windows-shaped profile: OneDrive from the registry, Dropbox from its info.json. */
function fakeProfile(home) {
  const profile = path.join(home, 'winprofile')
  const roaming = path.join(profile, 'AppData', 'Roaming')
  const onedrive = path.join(profile, 'OneDrive')
  const dropbox = path.join(profile, 'Dropbox (Personal)')
  for (const d of [onedrive, dropbox, path.join(roaming, 'Dropbox')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(roaming, 'Dropbox', 'info.json'), JSON.stringify({ personal: { path: dropbox, host: 1, is_team: false } }))
  const reg = ['HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal', `    UserFolder    REG_SZ    ${onedrive}`, '    cid    REG_SZ    1234', ''].join('\r\n')
  const file = path.join(home, 'fake-cloud.json')
  fs.writeFileSync(file, JSON.stringify({ env: { USERPROFILE: profile, APPDATA: roaming }, registry: { 'HKCU\\Software\\Microsoft\\OneDrive\\Accounts': reg } }))
  return { file, onedrive, dropbox }
}

async function chosen(win) {
  return win.$$eval('.modal [data-share-target]', (els) => els.filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.textContent.trim()))
}

const run = async () => {
  const chat = await mockChat()
  try {
    await test(
      'share: cloud folders found and added, a Slack webhook, copy and post after export, remembered per preset',
      fx.withHome('share-flow', async (ctx, home) => {
        const cloud = fakeProfile(home)
        const team = path.join(home, 'Team share')
        fs.mkdirSync(team)
        fx.seedProject(home, { id: 'rec-share', name: 'Demo', seconds: 3, media: fx.indexedVideo({ seconds: 3 }) })
        const { app, win } = await h.launch({
          home,
          env: { SSW_SHARE_FAKE_CLOUD: cloud.file, SSW_SHARE_WEBHOOK_ORIGIN: chat.origin, SSW_JOBS_TRACE: '1', SSW_JOBS_UNFOCUSED: '1' }
        })
        ctx.app = app
        await win.waitForSelector('.home', { timeout: 30000 })

        // Settings › Share: the folders found, with where they came from.
        await win.click('button[aria-label="Settings"]')
        await win.waitForSelector('.share-settings')
        const items = await win.locator('.share-settings [data-share-folder]').allTextContents()
        h.assert(items.length === 2, `two folders found: ${items}`)
        h.assert(items[0].includes('OneDrive') && items[0].includes(cloud.onedrive) && items[0].includes("Found in OneDrive's settings"), `OneDrive from the registry: ${items[0]}`)
        h.assert(items[1].includes('Dropbox') && items[1].includes(cloud.dropbox) && items[1].includes("Found in Dropbox's settings"), `Dropbox from info.json: ${items[1]}`)

        // A folder of the user's own, with the folder dialog.
        await app.evaluate(({ dialog }, target) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
        }, team)
        await win.click('.share-settings button:has-text("Add a folder")')
        await win.waitForSelector('.share-settings [data-share-folder]:has-text("Added by you")')

        // A chat: without a keyring nothing is stored; a URL of another site is refused; Slack's is
        // kept, shown masked, and tested.
        await win.click('.share-settings button:has-text("Add a chat")')
        await win.fill('#share-hook-url', SLACK)
        await win.click('.share-form button[type="submit"]')
        await win.waitForSelector('.share-form .error')
        h.assert(/cannot be stored safely/.test(await win.textContent('.share-form .error')), 'refused without a keyring')
        await win.click('.share-form button:has-text("Cancel")')
        // Xvfb has no keyring; the test turns on Chromium's basic store from outside (as ai.e2e.cjs).
        await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
        await win.click('.share-settings button:has-text("Add a chat")')
        await win.fill('.share-form input[maxlength="60"]', '#demos')
        await win.fill('#share-hook-url', 'https://example.com/services/T/B/x')
        await win.click('.share-form button[type="submit"]')
        await win.waitForSelector('.share-form .error')
        h.assert(/incoming webhook from Slack, Discord or Microsoft Teams/.test(await win.textContent('.share-form .error')), 'a foreign URL is refused')
        await win.fill('#share-hook-url', SLACK)
        await win.click('.share-form button[type="submit"]')
        await win.waitForSelector('.share-settings [data-share-hook]')
        const hook = await win.textContent('.share-settings [data-share-hook]')
        h.assert(hook.includes('#demos') && hook.includes('hooks.slack.com/…/Part') && !hook.includes('e2eSecret'), `masked: ${hook}`)
        await win.click('.share-settings button[aria-label="Test #demos"]')
        await win.waitForSelector('.share-settings .ai-test.ok')
        h.assert(chat.posts.length === 1 && chat.posts[0].path === '/services/T0E2E/B0E2E/e2eSecretTokenPart', `test posted to the webhook path: ${JSON.stringify(chat.posts)}`)
        h.assert(JSON.parse(chat.posts[0].body).text.startsWith('Flown is connected.'), `test message: ${chat.posts[0].body}`)
        await win.locator('.share-settings').scrollIntoViewIfNeeded()
        await shot(win, 'share-settings')
        await win.click('.settings-modal .modal-foot button:has-text("Done")')

        // After export: OneDrive and the chat, for this preset.
        await fx.openProject(win, 'Demo')
        await fx.openExportDialog(win)
        await fx.pickChip(win, 'Resolution', '720p')
        await fx.pickChip(win, 'Frame rate', '30 fps')
        const offered = await win.locator('.modal [data-share-target]').allTextContents()
        h.assert(offered.join('|') === 'Copy to OneDrive|Copy to Dropbox|Copy to Team share|Post to #demos', `offered: ${offered}`)
        await win.click('.modal [data-share-target]:has-text("Copy to OneDrive")')
        await win.click('.modal [data-share-target]:has-text("Post to #demos")')
        await win.locator('.modal .export-share').scrollIntoViewIfNeeded()
        await shot(win, 'share-after-export')
        const out = fs.mkdtempSync(path.join(home, 'out-'))
        await h.mockSaveDialog(app, path.join(out, 'Demo.mp4'))
        await win.locator('.modal button.primary', { hasText: 'Export' }).click()
        h.assert((await fx.waitForExport(win)).ok, 'export finished')
        await ef.waitFor(async () => (await win.locator('.share-done [data-state="done"]').count()) === 2, 'both share steps done', 30000)
        const steps = await win.locator('.share-done .share-step-text').allTextContents()
        h.assert(steps.join('|') === 'Saved to OneDrive › Flown|Posted to #demos', `steps: ${steps}`)
        const copy = path.join(cloud.onedrive, 'Flown', 'Demo.mp4')
        h.assert(fs.existsSync(copy) && fs.statSync(copy).size === fs.statSync(path.join(out, 'Demo.mp4')).size, 'the copy is in OneDrive/Flown, complete')
        h.assert(fs.readdirSync(path.join(cloud.onedrive, 'Flown')).every((f) => !f.includes('.partial-')), 'no partial file left')
        const message = JSON.parse(chat.posts[1].body).text
        h.assert(message === 'New video: Demo (0:03)\nSaved to OneDrive › Flown', `message: ${JSON.stringify(message)}`)
        h.assert(!chat.posts[1].body.includes(home), 'no local path in the message')
        h.assert(/right-click the file and choose Share/.test(await win.textContent('.share-done')), 'says how to get a link')
        // The page shared it itself: the notification adds no buttons.
        const note = (await trace(app)).find((e) => e.call === 'notify')
        h.assert(note && !note.value.extras, `no share buttons when shared already: ${JSON.stringify(note)}`)

        // A destination not chosen is offered in the done view; a second copy never replaces.
        await win.click('.share-done [data-share-offer]:has-text("Copy to Dropbox")')
        await ef.waitFor(async () => fs.existsSync(path.join(cloud.dropbox, 'Flown', 'Demo.mp4')), 'the Dropbox copy')
        await win.waitForSelector('.share-done [data-share-step] >> text=Saved to Dropbox › Flown')
        await shot(win, 'share-done')

        // Remembered for this preset, not for another one.
        await win.locator('.modal button.primary', { hasText: 'Done' }).click()
        await fx.openExportDialog(win)
        h.assert((await chosen(win)).join('|') === 'Copy to OneDrive|Post to #demos', `remembered: ${await chosen(win)}`)
        await win.click('.modal [data-preset="email"]')
        h.assert((await chosen(win)).length === 0, 'nothing chosen for another preset')
        // Without choices, the "Export finished" notification offers them.
        await h.mockSaveDialog(app, path.join(out, 'Mail.mp4'))
        await win.locator('.modal button.primary', { hasText: 'Export' }).click()
        h.assert((await fx.waitForExport(win)).ok, 'second export finished')
        await ef.waitFor(async () => (await trace(app)).filter((e) => e.call === 'notify').length >= 2, 'the second notification')
        const second = (await trace(app)).filter((e) => e.call === 'notify')[1]
        h.assert(JSON.stringify(second.value.extras) === JSON.stringify(['Copy to OneDrive', 'Copy to Dropbox', 'Copy to Team share']), `notification buttons: ${JSON.stringify(second.value)}`)
        h.assert(!fs.existsSync(path.join(cloud.onedrive, 'Flown', 'Mail.mp4')), 'nothing copied without a choice')

        // Main refuses what the page must not ask for.
        const refused = await win.evaluate(async (dir) => {
          const out = []
          out.push(await window.api.shareStart(`${dir}/not-exported.mp4`, ['whk1'], { title: 'x', seconds: 1 }).then(() => 'started', (e) => String(e)))
          out.push(await window.api.shareAddHook('evil', 'https://evil.example/api/webhooks/1/x').then(() => 'added', (e) => String(e)))
          return out
        }, out)
        h.assert(refused[0].includes('Only files exported') && refused[1].includes('incoming webhook'), `refused: ${refused}`)

        // The webhook's secret is nowhere on disk in plain text.
        const shareJson = fs.readFileSync(path.join(home, '.config', 'Flown', 'share.json'), 'utf8')
        h.assert(!shareJson.includes('hooks.slack.com') && !shareJson.includes('e2eSecret'), 'share.json holds no plain webhook')
        await h.sleep(800)
        const log = fs.readFileSync(path.join(home, '.config', 'Flown', 'logs', 'main.log'), 'utf8')
        h.assert(!log.includes('e2eSecret'), 'the log holds no webhook secret')
        h.assert(/Share: copied 1 file to onedrive/.test(log) && /Share: posted to slack/.test(log), 'the log says what was shared')
      })
    )
  } finally {
    chat.server.close()
  }
}

run()
