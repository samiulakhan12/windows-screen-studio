// Captions on this PC and the speech detector end to end (docs/design/offline-captions.md §10.3),
// with the host build of the speech helper (npm run build:speech-host) and the test model
// (npm run fetch:test-speech) served by the mock's /hf/ route: consent, download with a dropped
// connection and its resume, the download failures, Generate with real word timings, cancel and
// resume across a restart, offline, Settings, the helper missing, the speech detector in Remove
// silences and music ducking, and the IPC guards. A missing helper or model fails, never skips.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')
const sp = require('./speech-fixtures.cjs')
const { startMockAi, mockAiEnv } = require('./ai-mock-server.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const MODEL = path.join(sp.TEST_MODEL_DIR, sp.TEST_MODEL.file)

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** The app with the mock's /hf/ route as the model source (and its AI provider routes). */
async function launch(ctx, home, mock, env = {}) {
  const { app, win, logs } = await h.launch({
    home,
    env: { ...(mock ? { SSW_SPEECH_MODEL_BASE_URL: `${mock.url}/hf/`, ...mockAiEnv(mock.url) } : {}), ...env }
  })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

const userData = (app) => app.evaluate(({ app: a }) => a.getPath('userData'))
const modelsDir = async (app) => path.join(await userData(app), 'speech-models')
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const hfRequests = (mock) => mock.requests.filter((r) => r.provider === 'hf')

const openTab = (win, name) => win.click(`.insp-tabs button:has-text("${name}")`)
const card = (win) => win.locator('[data-testid="local-captions"]').first()
const cardState = (win) => card(win).getAttribute('data-state').catch(() => null)
const waitState = (win, state, timeout = 20000) => f.waitFor(async () => (await cardState(win)) === state, `the Captions tab in state "${state}"`, timeout)
const chipTexts = (win) => win.$$eval('[data-testid="local-model"] [role="radio"]', (els) => els.map((e) => e.textContent.trim()))
const activeName = (win) => win.evaluate(() => document.activeElement && (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim()))
const paletteTitles = (win) => win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent))

async function runCommand(win, query, expectTitle) {
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type(query)
  await f.waitFor(async () => (await paletteTitles(win))[0] === expectTitle, `"${query}" lists ${expectTitle} first`, 3000)
  await win.keyboard.press('Enter')
  await f.waitFor(async () => !(await win.$('.command-palette')), 'palette closes after running', 3000)
}

/** Goes back to the library (closes the editor). */
async function closeEditor(win) {
  await win.click('header button[aria-label="Back to library"], header button:has-text("Library"), header .back').catch(async () => win.keyboard.press('Escape'))
  await win.waitForSelector('.home', { timeout: 15000 })
}

/** Installs the test model straight into the models folder (as a finished download leaves it). */
function installModel(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(MODEL, path.join(dir, sp.TEST_MODEL.file))
}

/** Every word of a transcript, lowercased without punctuation, with its times. */
function wordsOf(transcript) {
  const out = []
  for (const s of transcript.segments) for (const w of s.words || []) for (const text of sp.plainWords(w.text)) out.push({ text, start: w.start, end: w.end })
  return out
}

/** Processes whose command line contains `needle`. */
function processesWith(needle) {
  const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' })
  return out.split('\n').filter((l) => l.includes(needle) && !l.includes('ps -eo'))
}

;(async () => {
  sp.requireSpeechAssets()
  const mock = await startMockAi({ ffmpeg: 'ffmpeg', hfFiles: { [sp.TEST_MODEL.file]: MODEL } })

  await test('offline captions: consent card for a user without keys; chips choose for the session; the command focuses the download and starts nothing', fx.withHome('oc-consent', async (ctx, home) => {
    sp.seedSpeechProject(home, { name: 'Consent' })
    const { app, win } = await launch(ctx, home, mock)
    const before = hfRequests(mock).length
    await f.openProject(win, 'Consent')
    await openTab(win, 'Captions')
    // "Checking this PC…" until both reads are done, then the consent card (and no key block).
    await waitState(win, 'needs-model')
    h.assert(!(await win.$('.captions-empty:has-text("Add an AI provider")')), 'no key block for a user without keys')
    const primaries = await win.$$eval('[data-testid="local-captions"] button.primary', (els) => els.map((e) => e.textContent.trim()))
    h.assert(JSON.stringify(primaries) === JSON.stringify(['Download 60 MB and make captions']), `one primary action: ${JSON.stringify(primaries)}`)
    const links = await win.$$eval('button', (els) => els.map((e) => e.textContent.trim()).filter((t) => t.startsWith('Prefer the cloud?')))
    h.assert(links.length === 1 && links[0] === 'Prefer the cloud? Use your own OpenAI or Gemini key…', `one cloud link: ${links}`)
    h.assert(JSON.stringify(await chipTexts(win)) === JSON.stringify(['Fast · 44 MB', 'Standard · 60 MB', 'Accurate · 190 MB']), `chips: ${await chipTexts(win)}`)
    const estimate = await win.textContent('[data-testid="local-estimate"]')
    await win.click('[data-testid="local-model"] [role="radio"]:has-text("Fast")')
    await f.waitFor(async () => (await win.textContent('[data-testid="local-download"]')).includes('Download 44 MB and make captions'), 'Fast changes the button')
    h.assert((await win.textContent('[data-testid="local-estimate"]')) !== estimate, 'and the estimate')
    const settings = readJson(path.join(await modelsDir(app), 'speech.json'))
    h.assert(!settings || settings.defaultModel === 'whisper-base', `the default is still base: ${JSON.stringify(settings)}`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'offline-captions-consent.png') })
    // The palette's Generate captions focuses the download button and downloads nothing.
    await openTab(win, 'Clip')
    await runCommand(win, 'generate captions', 'Generate captions')
    await waitState(win, 'needs-model')
    await f.waitFor(async () => (await activeName(win)) === 'Download Fast (Whisper tiny), 44 megabytes, and make captions', 'the download button has the focus')
    await h.sleep(500)
    h.assert(hfRequests(mock).length === before, 'no model request was made')
  }))

  await test('offline captions: a dropped download retries with Range, is verified, becomes the default; the badge shows meanwhile', fx.withHome('oc-download', async (ctx, home) => {
    sp.seedSpeechProject(home, { name: 'Download' })
    const { app, win } = await launch(ctx, home, mock)
    const dir = await modelsDir(app)
    await f.openProject(win, 'Download')
    await openTab(win, 'Captions')
    await waitState(win, 'needs-model')
    await win.click('[data-testid="local-model"] [role="radio"]:has-text("Fast")')
    const from = hfRequests(mock).length
    mock.hf.faults.push({ cut: 20000000 })
    mock.hf.fault = 'slow'
    await win.click('[data-testid="local-download"]')
    await f.waitFor(async () => (await win.textContent('[data-testid="local-captions"]').catch(() => '')).includes('trying again (1 of 3)'), 'the retry is shown', 30000)
    mock.hf.fault = null
    // The Clip tab: the ring on the Captions tab shows the download.
    await openTab(win, 'Clip')
    await f.waitFor(async () => (await win.getAttribute('[data-testid="captions-job-badge"]', 'data-phase').catch(() => null)) === 'download' || hfRequests(mock).length > from + 1, 'the badge shows the download', 15000)
    await openTab(win, 'Captions')
    await f.waitFor(async () => ['verifying', 'running', 'done'].includes(await cardState(win)) || !!(await win.$('[data-testid="local-summary"]')), 'the download completes', 120000)
    const reqs = hfRequests(mock).slice(from)
    h.assert(reqs.length >= 2 && reqs[0].range === null && reqs.some((r) => r.range === 'bytes=20000000-'), `resumed with Range: ${JSON.stringify(reqs.map((r) => r.range))}`)
    const file = path.join(dir, sp.TEST_MODEL.file)
    await f.waitFor(() => fs.existsSync(file), 'the model is installed', 30000)
    h.assert(sha256(file) === sp.TEST_MODEL.sha256, 'the installed file has the pinned SHA-256')
    await f.waitFor(() => readJson(path.join(dir, 'speech.json'))?.defaultModel === 'whisper-tiny', 'a download from the Captions tab becomes the default', 15000)
  }))

  await mock.close()
})().catch((err) => {
  console.error(`FAIL offline captions: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
})
