/**
 * Smart tools end to end (docs/design/smart-tools.md §22.3), in the built app under xvfb-run:
 *
 *   1  an old project opens and closes byte for byte, with the Guide button and Find chapters there;
 *   10 Find chapters on *Secret* (three chapters named from what is said, Review's rows, Remove as
 *      one undo step, Keep); 11 on *Silent* (Intro, Part 2, Part 3, Rename?, the screen read once);
 *   12 Suggest chapters with a service on this PC (its titles, Review's detail, Find chapters
 *      replacing them); 17 adding that service (Save and check, Load models, an edited address
 *      without a key sends nothing), the cost line naming its place, a title arriving, the key never
 *      in the log; 18 the cost question over US$1.00, Cancel sending nothing, and Always ask;
 *   16 AI on this PC with a fake ssw-llm and a test model served on this PC (download, Automatic,
 *      Summarize on this PC with its progress line and "Written on this PC", Stop within 2 s);
 *   19 the title bar at the minimum window size;
 *   20 Bangla: the guide's steps, its PDF text and a found chapter's name in Bangla.
 *
 * Steps 2–9 (the Guide panel, its screenshots, PDF, Markdown, HTML, the demo and Copy guide) are
 * in guides.e2e.cjs and steps 13–15 (short clips and the shorter version) in short-clips.e2e.cjs,
 * on the same fixtures (smart-fixtures.cjs). SSW_E2E_ONLY=<substring> runs only matching tests.
 * Run after `npm run build`: xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/smart-tools.e2e.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')
const { seedSecret } = require('./smart-fixtures.cjs')

const { waitFor, openProject } = f

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const KEY = 'sk-e2e-service-key-7f3a9c'

/** Calls window.api in the page; resolves { ok, value } or { ok: false, error }. */
const api = (win, method, ...args) =>
  win.evaluate(
    async ({ method, args }) => {
      try {
        return { ok: true, value: await window.api[method](...args) }
      } catch (err) {
        return { ok: false, error: String(err && err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
      }
    },
    { method, args }
  )

/** Seeds a recording of `seconds` s with `count` narrated sentences, one every `every` s. */
function seedNarrated(home, { id, name, seconds, count, every }) {
  f.seedProject(home, { id, name, seconds, fps: 30 })
  const NOUNS = ['invoice', 'report', 'billing page', 'export', 'chart', 'customer list', 'refund', 'tax setting', 'payment', 'team folder']
  const VERBS = ['opens', 'shows', 'keeps', 'sorts', 'lists', 'checks', 'updates', 'sends', 'saves', 'names']
  const segments = []
  for (let n = 0; n < count; n++) {
    const text = `The ${NOUNS[n % NOUNS.length]} ${VERBS[(n * 3) % VERBS.length]} item ${n + 1} for every account in the side panel.`
    const start = 1 + n * every
    const words = text.split(' ').map((w, k) => ({ text: w, start: +(start + k * 0.2).toFixed(3), end: +(start + k * 0.2 + 0.18).toFixed(3) }))
    segments.push({ id: `s${n}`, start, end: words[words.length - 1].end, text, words })
  }
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  p.transcript = { language: 'en', provider: 'local', model: 'test', createdAt: '2026-11-07T12:00:00.000Z', segments }
  fs.writeFileSync(file, JSON.stringify(p, null, 2))
}

/**
 * An OpenAI-compatible service on this PC: GET /v1/models and POST /v1/chat/completions, answering
 * by the JSON schema's name (check, chapters, title, summary, names). Every request is kept with
 * its Authorization header.
 */
function startService(chapters) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (d) => chunks.push(d))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const rec = { method: req.method, url: req.url, auth: req.headers.authorization || null, json: null }
      try {
        rec.json = body ? JSON.parse(body) : null
      } catch {
        // not JSON
      }
      requests.push(rec)
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'mock-small', object: 'model' }, { id: 'mock-large', object: 'model' }] })
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const name = rec.json?.response_format?.json_schema?.name ?? 'text'
        rec.task = name
        let answer = {}
        if (name === 'check') answer = { ok: true }
        else if (name === 'chapters') answer = { chapters }
        else if (name === 'title') answer = { text: 'Mock title' }
        else if (name === 'summary') answer = { text: 'A mock summary.' }
        return send(200, {
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 0,
          model: rec.json?.model ?? 'mock-small',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
          usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 }
        })
      }
      send(404, { error: { message: `Unknown route ${req.method} ${req.url}` } })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) }))
  })
}

/** The editor's way back to the library. */
async function backToLibrary(win) {
  await win.click('button[aria-label="Back to recordings"]')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

const settings = (win) => win.locator('[role="dialog"][aria-labelledby="settings-title"]')

async function openSettings(win) {
  await win.getByRole('button', { name: 'Settings' }).click()
  await settings(win).waitFor()
}

async function closeSettings(win) {
  await settings(win).getByRole('button', { name: 'Done' }).click()
  await settings(win).waitFor({ state: 'detached' })
}

/** The editor's Inspector tab `name`. */
const tab = (win, name) => win.click(`.insp-tabs button:has-text("${name}")`)

/** The project's chapters in time order, as "t title". */
const chaptersOf = (home, id) =>
  [...(h.readProject(home, id).chapters || [])].sort((a, b) => a.t - b.t).map((c) => ({ t: c.t, title: c.title, auto: c.auto || null, id: c.id }))

/** Review's rows' accessible names. */
const reviewRows = (win) => win.locator('[data-testid="review-panel"] .review-item').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))

async function main() {
  await test('1 Old project: opens and closes byte for byte; the Guide button and Find chapters are there', async (ctx) => {
    const home = h.tempHome('smart-old')
    const raw = JSON.parse(fs.readFileSync(path.join(h.APP_DIR, 'tests/fixtures/wave8-old-projects.json'), 'utf8')).find((x) => x.name === 'review-mode').raw
    const id = raw.id
    const dir = path.join(h.projectsRoot(home), id)
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(f.makeVideo({ seconds: raw.duration, width: raw.width, height: raw.height, fps: 30 }), path.join(dir, 'screen.mp4'))
    fs.symlinkSync(f.makeVideo({ seconds: raw.duration, width: 320, height: 240, fps: 30 }), path.join(dir, 'webcam.mp4'))
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(raw, null, 2))
    fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify(f.cursorTrack(raw.duration)))
    const before = fs.readFileSync(path.join(dir, 'project.json'))
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)
    await openProject(win, raw.name)
    h.assert(await win.locator('[data-testid="guide-open"]').isVisible(), 'the Guide button')
    await tab(win, 'Text')
    await win.waitForSelector('[data-testid="find-chapters"]')
    await win.locator('[data-testid="review-open"]').click()
    await win.waitForSelector('[data-testid="review-panel"]')
    const rows = await reviewRows(win)
    console.log('old project review rows', JSON.stringify(rows))
    // What wave 10 listed for it: its zoom, silence cut, camera change and smart speed (the filler cut it kept is
    // reviewed); nothing found by this wave's tools.
    const expected = ['Zoom in on a click', 'Cut 1.0 s of silence', 'Large camera', 'Sped up 3.0 s of idle time 2×']
    h.assert(rows.length === expected.length && expected.every((e, i) => rows[i].startsWith(e)), `Review lists what it listed before: ${rows}`)
    h.assert(rows.every((r) => !/^Chapter “|shorter version/.test(r)), 'no found chapter or shorter-version row')
    await win.keyboard.press('Escape')
    await backToLibrary(win)
    await h.sleep(1000)
    h.assert(fs.readFileSync(path.join(dir, 'project.json')).equals(before), "project.json's bytes are unchanged")
    const errors = logs.filter((l) => l.startsWith('[pageerror]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })

  await test('10 11 Find chapters: three named chapters on Secret, Review, Remove as one undo step, Keep; Silent numbered, read once', async (ctx) => {
    const home = h.tempHome('smart-chapters')
    seedSecret(home, { id: 'rec-secret', name: 'Secret' })
    seedSecret(home, { id: 'rec-silent', name: 'Silent', language: null })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)

    // Step 10: Secret.
    await openProject(win, 'Secret')
    await tab(win, 'Text')
    await win.click('[data-testid="find-chapters"]')
    await waitFor(() => chaptersOf(home, 'rec-secret').length === 3, 'three chapters', 30000)
    const found = chaptersOf(home, 'rec-secret')
    console.log('Secret chapters', JSON.stringify(found.map((c) => `${c.t} ${c.title}`)))
    h.assert(Math.abs(found[0].t) < 0.05 && Math.abs(found[1].t - 12.4) < 0.5 && Math.abs(found[2].t - 26.4) < 0.5, `at 0:00, about 12.4 s and about 26.4 s: ${found.map((c) => c.t)}`)
    h.assert(found.map((c) => c.title).join('|') === 'Click the Export button|Open settings|Save it', `named from what is said: ${found.map((c) => c.title)}`)
    h.assert(found.every((c) => c.auto && c.auto.by === 'find'), 'found by Find chapters, waiting for review')
    const notice = await win.textContent('.notice-slot')
    h.assert(/Found 3 chapters/.test(notice), `the notice: ${notice}`)
    h.assert((await win.locator('.chapter-row .chapter-found').count()) === 3, 'three Found chips')

    await win.locator('[data-testid="review-open"]').click()
    await win.waitForSelector('[data-testid="review-panel"]')
    let rows = await reviewRows(win)
    console.log('review rows', JSON.stringify(rows))
    h.assert(rows.filter((r) => /^Chapter “/.test(r)).length === 3, `Review lists the three chapters: ${rows}`)
    // Remove the second: gone, in one undo step.
    const row = (title) => win.locator('[data-testid="review-row"]', { has: win.locator(`.review-item[aria-label^="Chapter “${title}”"]`) })
    await row('Open settings').locator('.review-item').click()
    await row('Open settings').locator('[data-testid="review-remove"]').click()
    await waitFor(() => chaptersOf(home, 'rec-secret').length === 2, 'the chapter removed', 10000)
    h.assert(!chaptersOf(home, 'rec-secret').some((c) => c.title === 'Open settings'), 'Open settings is gone')
    await win.locator('button[aria-label="Undo"]').click()
    await waitFor(() => chaptersOf(home, 'rec-secret').length === 3, 'one Undo brings it back', 10000)
    h.assert(chaptersOf(home, 'rec-secret').find((c) => c.title === 'Open settings')?.auto, 'back as a found chapter')
    // Keep the first: its Found chip goes.
    await row('Click the Export button').locator('.review-item').click()
    await row('Click the Export button').locator('[data-testid="review-keep"]').click()
    await waitFor(() => !chaptersOf(home, 'rec-secret').find((c) => c.title === 'Click the Export button').auto, 'kept: the chapter is the user’s', 10000)
    await win.keyboard.press('Escape')
    await waitFor(async () => (await win.locator('.chapter-row .chapter-found').count()) === 2, 'its Found chip gone', 10000)
    await backToLibrary(win)

    // Step 11: Silent.
    await openProject(win, 'Silent')
    await tab(win, 'Text')
    await win.click('[data-testid="find-chapters"]')
    await waitFor(() => chaptersOf(home, 'rec-silent').length === 3, 'three chapters on Silent', 30000)
    const silent = chaptersOf(home, 'rec-silent')
    console.log('Silent chapters', JSON.stringify(silent.map((c) => `${c.t} ${c.title}`)))
    h.assert(silent.map((c) => `${c.t.toFixed(1)} ${c.title}`).join('|') === '0.0 Intro|12.0 Part 2|26.0 Part 3', `numbered: ${silent.map((c) => `${c.t} ${c.title}`)}`)
    h.assert((await win.locator('.chapter-rename').count()) === 3, 'each with Rename?')
    await waitFor(() => win.evaluate((cid) => document.activeElement?.id === `chapter-name-${cid}`, silent[0].id), 'the focus on the first name', 5000)
    h.assert(fs.existsSync(path.join(h.projectsRoot(home), 'rec-silent', '.cache', 'scenes.json')), 'the screen read is kept')
    // Again: the screen is not read again (no "Reading the screen" progress), the same chapters.
    await win.evaluate(() => {
      window.__progressSeen = []
      new MutationObserver(() => {
        const p = document.querySelector('[data-testid="find-chapters-progress"]')
        if (p) window.__progressSeen.push(p.textContent)
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await win.click('[data-testid="find-chapters"]')
    await h.sleep(2000)
    const seen = await win.evaluate(() => window.__progressSeen)
    console.log('second run progress', JSON.stringify(seen))
    h.assert(!seen.some((t) => /screen/i.test(t) && /\d+\s*%|\d+ of \d+/.test(t)), `no screen reading progress the second time: ${seen}`)
    h.assert(JSON.stringify(chaptersOf(home, 'rec-silent')) === JSON.stringify(silent), 'the same chapters')
    const errors = logs.filter((l) => l.startsWith('[pageerror]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })

  await test('12 17 18 A service on this PC: Save and check, Load models, the cost line, Suggest chapters, a title, the cost question', async (ctx) => {
    const home = h.tempHome('smart-service')
    seedSecret(home, { id: 'rec-secret', name: 'Secret' })
    seedNarrated(home, { id: 'rec-talk', name: 'Talk', seconds: 180, count: 60, every: 3 })
    const mock = await startService([
      { start: 0, title: 'Mock opening' },
      { start: 12.3, title: 'Mock settings' },
      { start: 26.2, title: 'Mock saving' }
    ])
    const other = await startService([])
    try {
      const { app, win, logs } = await h.launch({ home })
      ctx.app = app
      ctx.logs = logs
      await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
      await win.waitForSelector('.home', { timeout: 30000 })
      await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)

      // Step 17: add Other address at the mock's address, load its models, Save and check.
      await openSettings(win)
      const d = settings(win)
      await d.getByRole('button', { name: '+ Add provider' }).click()
      await d.getByRole('radio', { name: 'More services' }).click()
      await d.locator('[data-testid="service-preset"]').selectOption('other')
      await d.getByLabel('Base URL').fill(`http://127.0.0.1:${mock.port}/v1`)
      await d.getByLabel('Name').fill('Mock service')
      await d.getByLabel('API key').fill(KEY)
      const goesTo = await d.locator('[data-testid="ai-goes-to"]').innerText()
      h.assert(goesTo.includes(`127.0.0.1:${mock.port}`), `the form says where the key goes: ${goesTo}`)
      await d.getByRole('button', { name: 'Load models' }).click()
      await waitFor(async () => (await d.locator('.model-list [role="option"]').count()) === 2 || (await d.locator('.model-combobox .hint').first().innerText()).length > 0, 'the models loaded', 10000)
      const options = await d.locator('.model-list [role="option"]').allInnerTexts()
      console.log('models', JSON.stringify(options), await d.locator('.model-combobox .hint').first().innerText())
      h.assert(options.length === 2 && options[0].startsWith('mock-small'), `Load models fills the combobox: ${options}`)
      await d.locator('.model-list [role="option"]').first().dispatchEvent('mousedown')
      h.assert((await d.getByLabel('Model', { exact: true }).inputValue()) === 'mock-small', 'the model picked')
      await d.locator('form button[type="submit"]').click()
      const svcRow = d.locator('.ai-providers .ai-provider', { hasText: 'Mock service' })
      await svcRow.waitFor({ timeout: 20000 })
      await waitFor(async () => /Works\./.test(await svcRow.innerText()), 'Save and check says Works.', 20000)
      h.assert(mock.requests.some((r) => r.task === 'check' && r.auth === `Bearer ${KEY}`), 'the check went to the service with its key')

      // The address edited to another port with no key: Load models says so and sends nothing there.
      await d.getByRole('button', { name: 'Edit Mock service' }).click()
      await d.getByLabel('Base URL').fill(`http://127.0.0.1:${other.port}/v1`)
      await d.getByRole('button', { name: 'Load models' }).click()
      await waitFor(async () => /Enter the API key for the new address\./.test(await d.locator('form').innerText()), 'the key asked for', 10000)
      h.assert(other.requests.length === 0, `the second address received nothing: ${JSON.stringify(other.requests)}`)
      await d.getByRole('button', { name: 'Cancel' }).click()
      await closeSettings(win)

      // Step 12: Suggest chapters with the service on Secret.
      await openProject(win, 'Secret')
      await tab(win, 'Captions')
      const select = win.locator('select[aria-label="AI provider for text"]')
      await select.waitFor()
      const choice = await select.locator('option', { hasText: 'Mock service' }).getAttribute('value')
      await select.selectOption(choice)
      const line = await win.locator('#captions-ai-cost').innerText()
      console.log('cost line', line)
      h.assert(line.includes('127.0.0.1') && !/OpenAI/.test(line), `the cost line names the service's place: ${line}`)
      h.assert(/cost unknown/i.test(line), `no price yet: ${line}`)
      const before = mock.requests.length
      await win.click('#captions-ai-chapters')
      // The question Flown asks once before running a model it has no price for.
      await win.waitForSelector('[data-testid="cost-confirm"]', { timeout: 10000 })
      await win.click('[data-testid="cost-confirm-run"]')
      await waitFor(() => chaptersOf(home, 'rec-secret').length === 3, 'three suggested chapters', 30000)
      const suggested = chaptersOf(home, 'rec-secret')
      console.log('suggested', JSON.stringify(suggested.map((c) => `${c.t} ${c.title} ${JSON.stringify(c.auto)}`)))
      // The chapters task keeps at most max(2, captions' end / 120 s) suggestions (as before this wave, test 5): for
      // Secret's 27 s of captions the first two, at 0:00 and 12.3 s, which name the chapters they merge with; the
      // third start (the page change and "Finally" at 26.4 s) is found offline and named from what is said.
      h.assert(suggested.map((c) => c.title).join('|') === 'Mock opening|Mock settings|Save it', `the service's titles: ${suggested.map((c) => c.title)}`)
      h.assert(suggested.slice(0, 2).every((c) => c.auto.name === 'ai' && c.auto.from.includes('ai') && c.auto.host === `127.0.0.1:${mock.port}`), 'named by the service, which Review names')
      h.assert(mock.requests.slice(before).some((r) => r.task === 'chapters'), 'the chapters task went to the service')
      await win.locator('[data-testid="review-open"]').click()
      await win.waitForSelector('[data-testid="review-panel"]')
      const details = await win.locator('[data-testid="review-panel"]').innerText()
      h.assert(/Suggest chapters with 127\.0\.0\.1/.test(details), `Review says who suggested them: ${details.slice(0, 400)}`)
      await win.keyboard.press('Escape')
      // Find chapters afterwards replaces them.
      await tab(win, 'Text')
      await win.click('[data-testid="find-chapters"]')
      await waitFor(() => chaptersOf(home, 'rec-secret').map((c) => c.title).join('|') === 'Click the Export button|Open settings|Save it', 'Find chapters replaced them', 30000)

      // Step 17: Suggest a title arrives; no question the second time for this model.
      await tab(win, 'Captions')
      const n = mock.requests.length
      await win.click('#captions-ai-title')
      await waitFor(async () => /Suggested title: Mock title/.test(await win.locator('.captions-suggestion').innerText().catch(() => '')), 'the title', 15000)
      h.assert(mock.requests.slice(n).filter((r) => r.task === 'title').length === 1, 'one title request')
      await backToLibrary(win)

      // Step 18: prices set high: a run on Talk passes US$1.00 and the click asks first; Cancel sends nothing.
      await openSettings(win)
      await d.getByRole('button', { name: 'Edit Mock service' }).click()
      await d.getByRole('button', { name: 'Prices (US$ per million tokens)' }).click()
      await d.getByLabel('Input').fill('1000')
      await d.getByLabel('Output').fill('1000')
      await d.getByLabel('API key').fill(KEY)
      await d.locator('form button[type="submit"]').click()
      await waitFor(async () => (await d.locator('form').count()) === 0, 'saved', 20000)
      await closeSettings(win)
      await openProject(win, 'Talk')
      await tab(win, 'Captions')
      await win.locator('select[aria-label="AI provider for text"]').selectOption(choice)
      const priced = await win.locator('#captions-ai-cost').innerText()
      console.log('priced line', priced)
      h.assert(/(about US\$\d|US\$\d+\.\d\d to US\$\d)/.test(priced) && !/cost unknown/i.test(priced), `with prices, the cost in US$: ${priced}`)
      const asked = mock.requests.length
      await win.click('#captions-ai-summary')
      await win.waitForSelector('[data-testid="cost-confirm"]', { timeout: 10000 })
      const question = await win.locator('[data-testid="cost-confirm"]').innerText()
      console.log('question', question)
      h.assert(await win.evaluate(() => document.activeElement?.textContent === 'Cancel'), 'Cancel has the focus')
      await win.locator('[data-testid="cost-confirm"]').getByRole('button', { name: 'Cancel' }).click()
      await win.waitForSelector('[data-testid="cost-confirm"]', { state: 'detached' })
      await h.sleep(500)
      h.assert(mock.requests.length === asked, `Cancel sent nothing (${mock.requests.length - asked})`)
      await backToLibrary(win)

      // Always ask: a cheap run asks too.
      await openSettings(win)
      await d.getByRole('button', { name: 'Edit Mock service' }).click()
      await d.getByRole('button', { name: 'Prices (US$ per million tokens)' }).click()
      await d.getByLabel('Input').fill('0.01')
      await d.getByLabel('Output').fill('0.01')
      await d.getByLabel('API key').fill(KEY)
      await d.locator('form button[type="submit"]').click()
      await waitFor(async () => (await d.locator('form').count()) === 0, 'saved', 20000)
      await d.getByLabel('Ask before a run that costs more than').selectOption('always')
      await closeSettings(win)
      await openProject(win, 'Secret')
      await tab(win, 'Captions')
      await win.locator('select[aria-label="AI provider for text"]').selectOption(choice)
      const cheap = mock.requests.length
      await win.click('#captions-ai-title')
      await win.waitForSelector('[data-testid="cost-confirm"]', { timeout: 10000 })
      await win.click('[data-testid="cost-confirm-run"]')
      await waitFor(() => mock.requests.length > cheap, 'the cheap run after Run', 10000)

      // The key never in the log; the service only by its origin.
      const userData = await app.evaluate(({ app }) => app.getPath('userData'))
      await app.close()
      ctx.app = null
      const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8')
      h.assert(!log.includes(KEY), 'the key is not in the log')
      console.log('log names the origin:', log.includes(`127.0.0.1:${mock.port}`))
      const errors = logs.filter((l) => l.startsWith('[pageerror]'))
      h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
    } finally {
      await mock.close()
      await other.close()
    }
  })

  await test('16 AI on this PC: download the test model, Summarize on this PC with its progress, Stop within 2 s', async (ctx) => {
    const home = h.tempHome('smart-local')
    seedSecret(home, { id: 'rec-secret', name: 'Secret' })
    // A tiny "model" served on this PC: GGUF's magic and padding, pinned by size and SHA-256.
    const bytes = Buffer.concat([Buffer.from('GGUF'), crypto.randomBytes(64 * 1024)])
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const served = []
    const server = http.createServer((req, res) => {
      served.push(req.url)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      res.end(bytes)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-local-'))
    const catalog = path.join(scratch, 'catalog.json')
    fs.writeFileSync(catalog, JSON.stringify([{ id: 'gemma4-e2b', file: 'test-model.gguf', bytes: bytes.length, sha256, url: `http://127.0.0.1:${server.address().port}/test-model.gguf`, peakMB: 64, minTotalMemGB: 1 }]))
    const helperLog = path.join(scratch, 'helper.log')
    try {
      const { app, win, logs } = await h.launch({
        home,
        env: { SSW_LLM_HELPER: path.join(h.APP_DIR, 'tests/fixtures/fake-llm-helper.cjs'), SSW_TEXT_MODEL_TEST_CATALOG: catalog, FAKE_LLM_STEP_MS: '150', FAKE_LLM_LOG: helperLog }
      })
      ctx.app = app
      ctx.logs = logs
      await win.waitForSelector('.home', { timeout: 30000 })
      await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)
      await openSettings(win)
      await win.evaluate(() => window.dispatchEvent(new CustomEvent('ssw:open-settings', { detail: { section: 'localAi' } })))
      const section = win.locator('[data-testid="local-ai"]')
      await section.waitFor()
      console.log('this PC:', await section.locator('[data-testid="local-ai-pc"]').innerText())
      await section.getByRole('button', { name: /^Download Recommended/ }).click()
      await waitFor(async () => (await section.getByRole('button', { name: 'Remove Recommended' }).count()) > 0, 'downloaded', 30000)
      h.assert(served.length >= 1, 'the model came from the address the catalogue names')
      const use = await section.locator('.local-ai-use').innerText()
      h.assert(/Automatic/.test(use), `Use shows Automatic: ${use}`)
      await closeSettings(win)

      await openProject(win, 'Secret')
      await tab(win, 'Captions')
      const select = win.locator('select[aria-label="AI provider for text"]')
      await select.waitFor()
      const local = await select.locator('option', { hasText: 'On this PC (good for drafts)' })
      h.assert((await local.count()) === 1, 'Captions offers On this PC (good for drafts)')
      await select.selectOption(await local.getAttribute('value'))
      const line = await win.locator('#captions-ai-cost').innerText()
      console.log('local line', line)
      // About how long it takes on this PC (seconds for Secret's few words, minutes for a long narration).
      h.assert(/^Stays on this PC/.test(line) && /Summary about \d+ (seconds?|minutes?)/.test(line), `the line says about how long: ${line}`)
      await win.click('#captions-ai-summary')
      // Starting on this PC may ask first (Start); the progress line sits beside the buttons.
      if (await win.locator('[data-testid="cost-confirm"]').isVisible().catch(() => false)) await win.click('[data-testid="cost-confirm-run"]')
      await win.waitForSelector('.captions-ai [data-testid="local-progress"]', { timeout: 15000 })
      await waitFor(async () => /A draft written on this PC\./.test(await win.locator('.captions-suggestion').innerText().catch(() => '')), 'the summary', 30000)
      h.assert(await win.locator('.captions-suggestion [data-testid="local-written"]').isVisible(), 'Written on this PC')

      // Stop during a run ends it within 2 s.
      await win.click('#captions-ai-title')
      await win.waitForSelector('.captions-ai [data-testid="local-progress"]', { timeout: 15000 })
      const t0 = Date.now()
      await win.getByRole('button', { name: 'Stop AI on this PC' }).click()
      await win.waitForSelector('.captions-ai [data-testid="local-progress"]', { state: 'detached', timeout: 2000 })
      console.log('stopped in', Date.now() - t0, 'ms')
      const lines = fs.readFileSync(helperLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      h.assert(lines.some((l) => l.line && l.line.op === 'cancel'), 'the helper was told to cancel')
      const errors = logs.filter((l) => l.startsWith('[pageerror]'))
      h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
    } finally {
      await new Promise((r) => server.close(r))
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })

  await test('19 The title bar at the minimum window size: every button reachable, Guide and Copies labels hide like the others', async (ctx) => {
    const home = h.tempHome('smart-titlebar')
    seedSecret(home, { id: 'rec-secret', name: 'Secret' })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await openProject(win, 'Secret')
    const min = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
    await app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0].setContentSize(w, hh), min)
    await waitFor(() => win.evaluate(([w, hh]) => innerWidth === w && innerHeight === hh, min), `a ${min[0]}x${min[1]} window`)
    await h.sleep(500)
    const bar = await win.evaluate(() => {
      const buttons = [...document.querySelectorAll('.titlebar button')].filter((b) => b.offsetParent !== null)
      return buttons.map((b) => {
        const r = b.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        const label = b.querySelector('.tb-label')
        return {
          name: b.getAttribute('aria-label') || b.textContent.trim(),
          inView: r.left >= 0 && r.right <= innerWidth && r.width > 0,
          reachable: !!hit && (hit === b || b.contains(hit)),
          label: label ? getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 1 : null
        }
      })
    })
    console.log(JSON.stringify(bar))
    const bad = bar.filter((b) => !b.inView || !b.reachable)
    h.assert(!bad.length, `every title bar button is reachable: ${JSON.stringify(bad)}`)
    const guide = bar.find((b) => /Guide/.test(b.name))
    const copies = bar.find((b) => /Cop(y|ies)/.test(b.name))
    const versions = bar.find((b) => /Versions/.test(b.name))
    h.assert(guide && copies && versions, 'the Guide, Copies and Versions buttons are there')
    h.assert(guide.label === versions.label && copies.label === versions.label, `the labels hide alike: ${JSON.stringify({ guide, copies, versions })}`)
    const errors = logs.filter((l) => l.startsWith('[pageerror]'))
    h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
  })

  await test('20 Bangla: the guide in Bangla words and digits, its PDF text, a found chapter named from a Bangla sentence', async (ctx) => {
    const home = h.tempHome('smart-bangla')
    seedSecret(home, { id: 'rec-bn', name: 'Bangla', language: 'bn' })
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-bangla-out-'))
    try {
      const { app, win, logs } = await h.launch({ home })
      ctx.app = app
      ctx.logs = logs
      await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)
      await openProject(win, 'Bangla')
      await win.locator('[data-testid="guide-open"]').click()
      await win.waitForSelector('[data-testid="guide-panel"]')
      await waitFor(async () => (await win.locator('[data-testid="guide-step"]').count()) === 7, 'seven steps', 20000)
      const titles = await win.locator('[data-testid="guide-step-title"]').evaluateAll((els) => els.map((e) => e.value))
      console.log('Bangla titles', JSON.stringify(titles))
      h.assert(titles.filter((t) => /[ঀ-৿]/.test(t)).length >= 5, `Bangla step words: ${titles}`)
      const panel = await win.locator('[data-testid="guide-panel"]').innerText()
      h.assert(/[০-৯]/.test(panel), 'Bangla digits in the panel')
      await waitFor(async () => {
        const bar = win.locator('[aria-label="Making screenshots"]')
        return (await bar.getAttribute('aria-valuenow')) === (await bar.getAttribute('aria-valuemax'))
      }, 'the screenshots', 90000)
      const pdf = path.join(out, 'Bangla guide.pdf')
      await h.mockSaveDialog(app, pdf)
      await win.locator('[data-testid="guide-format"] label', { hasText: 'PDF' }).click()
      await win.locator('[data-testid="guide-save"]').click()
      await h.sleep(300)
      for (const id of ['guide-save-anyway', 'guide-link-anyway']) if (await win.locator(`[data-testid="${id}"]`).isVisible().catch(() => false)) await win.locator(`[data-testid="${id}"]`).click()
      await waitFor(() => fs.existsSync(pdf) && fs.statSync(pdf).size > 1000, 'the PDF saved', 60000)
      await h.sleep(500)
      const text = execFileSync('pdftotext', [pdf, '-']).toString().normalize('NFC')
      const missing = titles.filter((t) => !text.replace(/\s+/g, ' ').includes(t.normalize('NFC').replace(/\s+/g, ' ')))
      console.log('PDF text starts:', text.slice(0, 300))
      h.assert(!missing.length, `the PDF text copies out as the same Bangla: missing ${JSON.stringify(missing)}`)
      await win.locator('[data-testid="guide-step-title"]').first().focus()
      await win.keyboard.press('Escape')
      await waitFor(async () => !(await win.locator('[data-testid="guide-panel"]').count()), 'the Guide panel closed')

      await tab(win, 'Text')
      await win.click('[data-testid="find-chapters"]')
      await waitFor(() => (h.readProject(home, 'rec-bn').chapters || []).length >= 2, 'found chapters', 30000)
      const names = chaptersOf(home, 'rec-bn').map((c) => c.title)
      console.log('Bangla chapters', JSON.stringify(names))
      h.assert(names.some((n) => /[ঀ-৿]/.test(n)), `a chapter named from a Bangla sentence: ${names}`)
      const errors = logs.filter((l) => l.startsWith('[pageerror]'))
      h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
