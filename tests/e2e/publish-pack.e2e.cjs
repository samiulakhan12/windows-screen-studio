// Publishing copy pack (NW-13, docs/design/publish-pack.md §10) in the real built app, against the
// local mock of the AI providers (ai-mock-server.cjs; no real API calls):
//  1. Nothing to write from: no provider (Add an AI provider), no sound, no captions (Generate
//     captions opens the Captions tab and starts it).
//  2. Write all with a slow key: seven cards, at most two requests at once, progress; tone and length
//     reach the prompts; markup in an answer is text, a link the transcript lacks is dropped; X fits
//     280; Copy gives the exact text (the YouTube one with the timeline's chapters); edits are copied;
//     Regenerate sends one request; Stop cancels one.
//  3. Use for exports: one undo step; the export's description file is what Copy gives.
//  4. Tone and length are remembered after a restart.
//  5. The palette: "Write an X post" writes that item only; "Summarize with AI" runs the Captions
//     tab's summary; the AI tools are greyed out without captions.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')
const fx = require('./render-fixtures.cjs')
const { startMockAi, mockAiEnv } = require('./ai-mock-server.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
/** Screenshots of the dialog when set to a folder (docs/screenshots). */
const SHOTS = process.env.SSW_E2E_SHOTS || null

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const seg = (id, start, end, text) => ({ id, start, end, text })
const transcript = (segments) => ({ provider: 'openai', model: 'test-model', createdAt: new Date().toISOString(), language: 'en', segments })
const SEGMENTS = [
  seg('s1', 0.5, 1.5, 'Hello and welcome to the admin tour.'),
  seg('s2', 2.5, 3.5, 'Today we open Settings and add a user.'),
  seg('s3', 4.5, 5.5, 'Then we press Save and we are done.')
]
const WORDS = SEGMENTS.map((s) => s.text).join(' ').split(/\s+/).length

function addItems(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

/** A 6 s project with three chapters and captions (no sound track: the captions are what counts). */
function seedChaptered(home, id, name) {
  fx.seedProject(home, { id, name, seconds: 6, media: fx.indexedVideo({ seconds: 6 }) })
  addItems(home, id, {
    chapters: [
      { id: 'k1', t: 0, title: 'Intro' },
      { id: 'k2', t: 2, title: 'Settings' },
      { id: 'k3', t: 4, title: 'Save' }
    ],
    transcript: transcript(SEGMENTS),
    captions: { show: false, preset: 'boxed', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#facc15', background: 'box', maxLines: 2 }
  })
  return id
}

/** Calls window.api in the page: { ok, value } or { ok: false, error }. */
const api = (win, method, ...args) =>
  win.evaluate(
    async ({ method, args }) => {
      try {
        return { ok: true, value: await window.api[method](...args) }
      } catch (err) {
        return { ok: false, error: String(err && err.message) }
      }
    },
    { method, args }
  )

async function launch(ctx, home, mock) {
  const { app, win, logs } = await h.launch({ home, env: mockAiEnv(mock.url) })
  ctx.app = app
  ctx.logs = logs
  // Xvfb has no keyring: the test turns on Chromium's basic store from outside (as ai.e2e.cjs does).
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

async function addProvider(win, apiKey) {
  const saved = await api(win, 'saveAiProvider', { kind: 'openai', label: 'OpenAI', apiKey })
  h.assert(saved.ok, `provider saved: ${saved.error}`)
}

const dialog = (win) => win.locator('[data-testid="publish-dialog"]')
const card = (win, kind) => win.locator(`[data-publish-card="${kind}"]`)
const cardText = (win, kind) => card(win, kind).locator('textarea.publish-text').inputValue()
const status = (win, kind) => card(win, kind).getAttribute('data-status')
const clipboard = (app) => app.evaluate(({ clipboard }) => clipboard.readText())
const KINDS = ['youtube', 'linkedin', 'xpost', 'article', 'releaseNotes', 'title', 'summary']

async function openDialog(win) {
  await win.click('[data-testid="publish-open"]')
  await dialog(win).waitFor({ timeout: 10000 })
}

async function closeDialog(win) {
  await dialog(win).locator('.modal-foot button', { hasText: 'Close' }).click()
  await f.waitFor(async () => !(await win.$('[data-testid="publish-dialog"]')), 'the dialog closes', 5000)
}

async function chip(win, group, label) {
  await dialog(win).locator(`.chips[aria-label="${group}"] button`, { hasText: label }).click()
}
const chipOn = (win, group, label) => dialog(win).locator(`.chips[aria-label="${group}"] button`, { hasText: label }).getAttribute('aria-pressed')

async function copyFrom(win, app, kind, label = 'Copy') {
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await card(win, kind).locator('.publish-actions button', { hasText: new RegExp(`^${label}$`) }).click()
  return f.waitFor(async () => {
    const t = await clipboard(app)
    return t !== 'before' ? t : null
  }, `${kind} copied`, 5000)
}

async function openPalette(win) {
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
}
const paletteRows = (win) =>
  win.$$eval('.command-palette [role="option"]', (els) => els.map((e) => ({ title: e.querySelector('.palette-title')?.textContent, disabled: e.getAttribute('aria-disabled') === 'true' })))

async function runCommand(win, query, title) {
  await openPalette(win)
  await win.keyboard.type(query)
  await f.waitFor(async () => (await paletteRows(win))[0]?.title === title, `"${query}" lists ${title} first`, 3000)
  await win.keyboard.press('Enter')
  await f.waitFor(async () => !(await win.$('.command-palette')), 'palette closes after running', 3000)
}

async function main() {
  const mock = await startMockAi({ ffmpeg: FF })
  try {
    await test(
      'publish: no provider, no sound and no captions each say what to do',
      fx.withHome('pub-blocked', async (ctx, home) => {
        fx.seedProject(home, { id: 'silent', name: 'Silent', seconds: 4, media: fx.indexedVideo({ seconds: 4 }) })
        f.seedProject(home, { id: 'talk', name: 'Talking', seconds: 4, audio: true })
        const { win } = await launch(ctx, home, mock)
        await fx.openProject(win, 'Silent')
        await openDialog(win)
        h.assert((await dialog(win).textContent()).includes('Add an AI provider to write the copy.'), 'no provider: says to add one')
        await closeDialog(win)
        await addProvider(win, 'sk-test-publish-key-0001')
        await openDialog(win)
        await win.waitForSelector('[data-testid="publish-blocked"][data-blocker="no-sound"]', { timeout: 10000 })
        h.assert((await dialog(win).textContent()).includes('This recording has no sound, so there is nothing to write from.'), 'no sound: says so')
        h.assert((await dialog(win).locator('button', { hasText: 'Generate captions' }).count()) === 0, 'no sound: nothing to generate')
        await win.keyboard.press('Escape')
        await f.waitFor(async () => !(await win.$('[data-testid="publish-dialog"]')), 'Esc closes the dialog', 5000)
        h.assert((await win.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-testid'))) === 'publish-open', 'focus goes back to the Publish button')

        await win.click('button[aria-label="Back to recordings"]')
        await fx.openProject(win, 'Talking')
        await openDialog(win)
        await win.waitForSelector('[data-testid="publish-blocked"][data-blocker="no-captions"]', { timeout: 10000 })
        h.assert((await dialog(win).textContent()).includes('No captions yet. The copy is written from what is said, so make the captions first.'), 'no captions: says so')
        if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'publish-pack-no-captions.png') })
        await dialog(win).locator('button', { hasText: 'Generate captions' }).click()
        await f.waitFor(async () => !(await win.$('[data-testid="publish-dialog"]')), 'Generate captions closes the dialog', 5000)
        await win.waitForSelector('.captions-panel', { timeout: 10000 })
        // The Captions tab took the request: its generate form or job is showing.
        await f.waitFor(async () => (await win.locator('.captions-panel').textContent()).length > 0, 'the Captions tab opens', 5000)

        // The palette greys out the Captions tab's AI tools without captions.
        await openPalette(win)
        await win.keyboard.type('fix captions with ai')
        const rows = await f.waitFor(async () => {
          const r = await paletteRows(win)
          return r[0]?.title === 'Fix captions with AI' ? r : null
        }, 'the AI tool is listed', 3000)
        h.assert(rows[0].disabled, `greyed out without captions: ${JSON.stringify(rows[0])}`)
        await win.keyboard.press('Escape')
      })
    )

    await test(
      'publish: write all, two at a time; copy, edit, regenerate, stop; use for exports and export; remembered choices',
      fx.withHome('pub-write', async (ctx, home) => {
        seedChaptered(home, 'rec-pub', 'Demo')
        let { app, win } = await launch(ctx, home, mock)
        await addProvider(win, 'slow-pack-test-key-0001')
        await fx.openProject(win, 'Demo')
        await openDialog(win)
        await win.waitForSelector('[data-testid="publish-write-all"]:not([disabled])', { timeout: 10000 })
        h.assert((await win.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-testid'))) === 'publish-write-all', 'Write all has the focus')
        for (const k of KINDS) h.assert((await status(win, k)) === 'idle', `${k} not written yet`)
        await chip(win, 'Tone', 'Professional')
        await chip(win, 'Length', 'Short')
        const before = { count: mock.pack.count, requests: mock.requests.length }
        mock.pack.max = 0
        await win.click('[data-testid="publish-write-all"]')
        await f.waitFor(async () => /Writing… \d of 7 done/.test(await win.textContent('[data-testid="publish-progress"]')), 'progress shows', 5000)
        const states = await Promise.all(KINDS.map((k) => status(win, k)))
        h.assert(states.filter((s) => s === 'writing').length <= 2, `at most two writing: ${states}`)
        h.assert(states.includes('waiting'), `the rest wait: ${states}`)
        if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'publish-pack-writing.png') })
        await f.waitFor(async () => (await Promise.all(KINDS.map((k) => status(win, k)))).every((s) => s === 'done'), 'every card written', 60000)
        h.assert(mock.pack.max === 2, `two pack requests at once at most, and two did run together: ${mock.pack.max}`)
        h.assert(mock.pack.count - before.count === 5, `five pack requests: ${mock.pack.count - before.count}`)
        const textRequests = mock.requests.slice(before.requests).filter((r) => r.route === '/responses')
        h.assert(textRequests.length === 7, `seven requests in all (title and summary too): ${textRequests.length}`)
        const sent = textRequests.find((r) => r.json && /^Video \(JSON/.test(r.json.input))
        h.assert(sent && !/Hello and welcome/.test(sent.json.instructions) && /Hello and welcome/.test(sent.json.input), 'the transcript is in the data, not the instructions')
        h.assert(sent.json.input.includes('"title":"Demo"') && sent.json.input.includes('"chapters":["Intro","Settings","Save"]'), `name and chapters sent as data: ${sent.json.input.slice(0, 200)}`)

        const yt = await cardText(win, 'youtube')
        h.assert(yt.startsWith(`Mock description (professional short, ${WORDS} words).`), `tone and length reach the prompt: ${yt}`)
        h.assert(yt.includes('<img src=x onerror="document.title=\'pwned\'">'), 'markup is shown as text')
        h.assert(!yt.includes('evil.example'), 'a link the transcript lacks is dropped')
        h.assert((await dialog(win).locator('img').count()) === 0 && (await win.title()) !== 'pwned', 'nothing from the answer became markup')
        h.assert((await card(win, 'youtube').locator('textarea.publish-tags').inputValue()) === 'mock, flown demo, btag/b', 'tags cleaned')
        h.assert((await win.textContent('[data-testid="publish-chapters"]')) === '0:00 Intro\n0:02 Settings\n0:04 Save', 'chapters from the timeline')
        h.assert((await card(win, 'youtube').textContent()).includes('YouTube needs every chapter to last at least 10 seconds'), "YouTube's rules are checked")
        const xCount = await card(win, 'xpost').locator('.publish-count').textContent()
        const n = parseInt(xCount, 10)
        h.assert(n <= 280 && n > 200 && xCount.endsWith('/ 280'), `X post fits 280: ${xCount}`)
        h.assert((await cardText(win, 'article')) === '# Mock article\n\nWritten professional short.\n\n## Get started\n1. Open Flown\n2. Press Record', 'article rendered')
        h.assert((await cardText(win, 'title')) === 'Mock title', 'title from the existing task')
        h.assert((await cardText(win, 'summary')) === 'A mock summary of the recording.', 'summary from the existing task')
        if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'publish-pack-written.png') })

        // Copy: the exact text, the YouTube one with the chapters; an edit is what gets copied.
        const copied = await copyFrom(win, app, 'youtube')
        h.assert(copied === `${yt}\n\nChapters\n0:00 Intro\n0:02 Settings\n0:04 Save`, `YouTube copy: ${JSON.stringify(copied)}`)
        h.assert((await copyFrom(win, app, 'youtube', 'Copy tags')) === 'mock, flown demo, btag/b', 'tags copied')
        await card(win, 'linkedin').locator('textarea.publish-text').fill('My own words <b>here</b>')
        h.assert((await copyFrom(win, app, 'linkedin')) === 'My own words <b>here</b>', 'the edit is copied')

        // Regenerate one item: one request.
        const r0 = mock.pack.count
        await card(win, 'xpost').locator('button', { hasText: 'Regenerate' }).click()
        await f.waitFor(async () => (await status(win, 'xpost')) === 'writing', 'X post rewriting', 5000)
        await f.waitFor(async () => (await status(win, 'xpost')) === 'done', 'X post rewritten', 15000)
        h.assert(mock.pack.count - r0 === 1, `one request: ${mock.pack.count - r0}`)
        // Stop: the request goes away, the card keeps its text.
        const article = await cardText(win, 'article')
        await card(win, 'article').locator('button', { hasText: 'Regenerate' }).click()
        await f.waitFor(async () => mock.pack.inFlight === 1, 'the article request is out', 5000)
        await card(win, 'article').locator('button', { hasText: 'Stop' }).click()
        await f.waitFor(async () => (await status(win, 'article')) === 'done', 'stopped: back to its text', 5000)
        await f.waitFor(async () => mock.pack.inFlight === 0, 'the request was cancelled', 5000)
        h.assert((await cardText(win, 'article')) === article, 'the text stays')

        // Use for exports: one undo step.
        await card(win, 'youtube').locator('button', { hasText: 'Use for exports' }).click()
        await f.waitFor(async () => (await card(win, 'youtube').locator('button', { hasText: 'Stop using for exports' }).count()) === 1, 'saved for exports', 5000)
        const saved = await f.waitFor(() => h.readProject(home, 'rec-pub').publish, 'the description is saved', 10000)
        h.assert(saved.description === yt, `saved text: ${JSON.stringify(saved)}`)
        await closeDialog(win)
        await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
        await win.keyboard.press('Control+z')
        await f.waitFor(() => !h.readProject(home, 'rec-pub').publish, 'one undo removes it', 10000)
        await win.keyboard.press('Control+Shift+z')
        await f.waitFor(() => h.readProject(home, 'rec-pub').publish, 'redo brings it back', 10000)

        // The export's description file is what Copy gives.
        const out = fs.mkdtempSync(path.join(home, 'out-'))
        await fx.openExportDialog(win)
        await fx.pickChip(win, 'Resolution', '720p')
        await fx.pickChip(win, 'Frame rate', '30 fps')
        const chipD = win.locator('.modal [data-sidecar="description"]')
        if ((await chipD.getAttribute('aria-pressed')) !== 'true') await chipD.click()
        await h.mockSaveDialog(app, path.join(out, 'Demo.mp4'))
        await win.locator('.modal button.primary', { hasText: 'Export' }).click()
        const r = await fx.waitForExport(win)
        h.assert(r.ok, `export finished: ${r.text}`)
        const desc = fs.readFileSync(path.join(out, 'Demo - description.txt'), 'utf8')
        h.assert(desc === `${copied}\n`, `description file = Copy: ${JSON.stringify(desc)}`)

        // Tone and length are remembered after a restart; the written items are for the session.
        await app.close()
        ;({ app, win } = await launch(ctx, home, mock))
        await fx.openProject(win, 'Demo')
        await openDialog(win)
        await win.waitForSelector('[data-testid="publish-write-all"]', { timeout: 10000 })
        h.assert((await chipOn(win, 'Tone', 'Professional')) === 'true' && (await chipOn(win, 'Length', 'Short')) === 'true', 'tone and length remembered')
        h.assert((await status(win, 'linkedin')) === 'idle', 'the session started afresh')
        h.assert((await cardText(win, 'youtube')) === yt, 'the description saved for exports shows in its card')
        h.assert((await card(win, 'youtube').locator('button', { hasText: 'Stop using for exports' }).count()) === 1, 'and says it is used for exports')
      })
    )

    await test(
      'publish: the palette writes one item, and runs the Captions tab’s summary',
      fx.withHome('pub-palette', async (ctx, home) => {
        seedChaptered(home, 'rec-pal', 'Palette')
        const { win } = await launch(ctx, home, mock)
        await addProvider(win, 'sk-test-publish-key-0001')
        await fx.openProject(win, 'Palette')
        const before = mock.pack.count
        await runCommand(win, 'x post', 'Write an X post')
        await dialog(win).waitFor({ timeout: 10000 })
        await f.waitFor(async () => (await status(win, 'xpost')) === 'done', 'the X post is written', 15000)
        for (const k of KINDS.filter((k) => k !== 'xpost')) h.assert((await status(win, k)) === 'idle', `${k} untouched`)
        h.assert(mock.pack.count - before === 1, 'one request')
        h.assert((await cardText(win, 'xpost')).startsWith('Mock X post (friendly normal)'), 'default tone and length')
        await closeDialog(win)

        await runCommand(win, 'summarize with ai', 'Summarize with AI')
        await win.waitForSelector('.captions-summary', { timeout: 15000 })
        h.assert((await win.textContent('.captions-summary')) === 'A mock summary of the recording.', 'the Captions tab shows the summary')
      })
    )
  } finally {
    await mock.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
