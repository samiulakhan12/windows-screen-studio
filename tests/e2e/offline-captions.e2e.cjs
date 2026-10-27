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
  await win.click('button[aria-label="Back to recordings"]')
  await win.waitForSelector('.home', { timeout: 15000 })
}

const BASE = { file: 'ggml-base-q5_1.bin', sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' }
/** Whisper base for the "Make them now with Standard" case: from the test cache, fetched there once from its pinned address. */
function baseModel() {
  const file = path.join(sp.TEST_MODEL_DIR, BASE.file)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(sp.TEST_MODEL_DIR, { recursive: true })
    execFileSync('curl', ['-sSfL', '--retry', '3', '-o', `${file}.part`, `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/${BASE.file}`])
    h.assert(sha256(`${file}.part`) === BASE.sha256, 'Whisper base matches its pin')
    fs.renameSync(`${file}.part`, file)
  }
  return file
}

/** A wrapper of the real helper that logs its arguments to `log` (absolute paths: the helper's environment is minimal). */
function loggingHelper(dir, log) {
  const file = path.join(dir, 'logging-helper.sh')
  fs.writeFileSync(file, `#!/bin/bash\necho "$@" >> '${log}'\nexec '${sp.HELPER}' "$@"\n`, { mode: 0o755 })
  return file
}

/** Saves an OpenAI provider (the mock answers it). Xvfb has no keyring: the basic store is turned on from outside, as in ai.e2e.cjs. */
async function addProvider(app, win) {
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  await win.evaluate(() => window.api.saveAiProvider({ kind: 'openai', label: 'Mock OpenAI', apiKey: 'e2e-openai-key' }))
}

/* ---------- measuring sound ---------- */

const RATE = 48000
function pcm(file) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(out.buffer, out.byteOffset, out.length / 4)
}
/** Amplitude of the `freq` Hz component of [from, to) seconds (Goertzel). */
function amplitude(s, freq, from, to) {
  const a = Math.round(from * RATE)
  const b = Math.min(s.length, Math.round(to * RATE))
  const k = 2 * Math.cos((2 * Math.PI * freq) / RATE)
  let s1 = 0
  let s2 = 0
  for (let i = a; i < b; i++) {
    const s0 = s[i] + k * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2))) / (b - a)
}
const MUSIC_HZ = 9000
/** A steady 9 kHz tone (well above the speech and the clicks) as the music, cached. */
function musicFile() {
  const file = path.join(fx.MEDIA_CACHE, 'speech-music-9k-30s.m4a')
  if (!fs.existsSync(file)) {
    fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${MUSIC_HZ}:sample_rate=48000:d=30,volume=0.25`, '-c:a', 'aac', '-b:a', '192k', `${file}.part.m4a`])
    fs.renameSync(`${file}.part.m4a`, file)
  }
  return file
}
const MUSIC = { path: 'music.m4a', volume: 0.5, ducking: 0.8, loop: true, fadeIn: 0, fadeOut: 0 }

/** Records every gain automation call of the preview (Web Audio), to read the music's ducking back. */
const hookGains = (win) =>
  win.evaluate(() => {
    const ids = new WeakMap()
    let next = 0
    const id = (p) => (ids.has(p) ? ids.get(p) : (ids.set(p, ++next), next))
    window.__gains = []
    for (const name of ['setValueAtTime', 'linearRampToValueAtTime']) {
      const orig = AudioParam.prototype[name]
      AudioParam.prototype[name] = function (value, time) {
        window.__gains.push({ param: id(this), name, value, time })
        return orig.call(this, value, time)
      }
    }
  })

/**
 * The preview's ducking gain at output times `ts`, played from 0: the param whose ramps dip to
 * 1 − ducking, its keyframes at (time − the first setValueAtTime's time).
 */
async function previewDuck(win, ts) {
  const calls = await win.evaluate(() => window.__gains)
  const byParam = new Map()
  for (const c of calls) byParam.set(c.param, [...(byParam.get(c.param) || []), c])
  for (const list of byParam.values()) {
    const ramps = list.filter((c) => c.name === 'linearRampToValueAtTime')
    if (!ramps.some((c) => Math.abs(c.value - (1 - MUSIC.ducking)) < 0.01)) continue
    // The last schedule made while playing: a setValueAtTime followed by its ramps (a pause sets the value alone).
    const start = list
      .map((c, i) => [c, i])
      .filter(([c, i]) => c.name === 'setValueAtTime' && list[i + 1]?.name === 'linearRampToValueAtTime')
      .pop()
    if (!start) continue
    const keys = list.slice(start[1] + 1).filter((c) => c.name === 'linearRampToValueAtTime').map((c) => ({ t: c.time - start[0].time, g: c.value }))
    const at = (t) => {
      let prev = { t: 0, g: start[0].value }
      for (const k of keys) {
        if (k.t >= t) return prev.g + ((k.g - prev.g) * (t - prev.t)) / Math.max(1e-9, k.t - prev.t)
        prev = k
      }
      return prev.g
    }
    return ts.map(at)
  }
  return null
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

  await test('offline captions: a damaged download, 404, 403; Settings stops and continues a download; closing the editor lets it finish without starting captions', fx.withHome('oc-failures', async (ctx, home) => {
    sp.seedSpeechProject(home, { name: 'Failures' })
    const { app, win } = await launch(ctx, home, mock)
    const dir = await modelsDir(app)
    await f.openProject(win, 'Failures')
    await openTab(win, 'Captions')
    await waitState(win, 'needs-model')
    await win.click('[data-testid="local-model"] [role="radio"]:has-text("Fast")')
    // A flipped byte: the mismatch copy, nothing left on disk; a notice while another tab is open.
    mock.hf.faults.push({ flip: true, slow: true })
    await win.click('[data-testid="local-download"]')
    await waitState(win, 'downloading')
    await openTab(win, 'Clip')
    await win.waitForSelector('.notice:has-text("The speech model could not be downloaded: open the Captions tab for details.")', { timeout: 120000 })
    await openTab(win, 'Captions')
    await waitState(win, 'download-failed')
    h.assert((await win.textContent('[data-testid="local-captions"] [role="alert"]')).includes('The downloaded file was not the expected one, so it was deleted and not used.'), 'the mismatch copy')
    h.assert(!fs.readdirSync(dir).some((n) => n.startsWith(sp.TEST_MODEL.file)), `no .part or file left: ${fs.readdirSync(dir)}`)
    // 404: the missing copy and [Choose another tier].
    mock.hf.faults.push(404)
    await win.click('[data-testid="local-captions"] button:has-text("Try again")')
    await f.waitFor(async () => (await win.textContent('[data-testid="local-captions"]')).includes('is no longer where this version of Flown downloads it from'), 'the missing copy', 20000)
    h.assert(await win.isVisible('[data-testid="local-captions"] button:has-text("Choose another tier")'), '[Choose another tier]')
    await win.click('[data-testid="local-captions"] button:has-text("Choose another tier")')
    h.assert((await activeName(win)) === 'Fast, 44 megabyte download', `the chips get the focus: ${await activeName(win)}`)
    // 403 (another tier, as the 404 asked): refused.
    await win.click('[data-testid="local-model"] [role="radio"]:has-text("Standard")')
    await waitState(win, 'needs-model')
    mock.hf.faults.push(403)
    await win.click('[data-testid="local-download"]')
    await f.waitFor(async () => (await win.textContent('[data-testid="local-captions"]')).includes('Hugging Face or your network refused the download (HTTP 403)'), 'the refused copy', 20000)

    // Settings: a slow download, Cancel → "Stopped at …", Continue completes it.
    await win.click('[data-testid="local-captions"] ~ * button:has-text("Manage speech models…"), button:has-text("Manage speech models…")')
    const section = win.locator('[data-testid="speech-models"]')
    await section.waitFor()
    mock.hf.fault = 'slow'
    // The row still shows the 404 (Download failed: …) with Try again.
    h.assert((await section.locator('[data-model="whisper-tiny"]').textContent()).includes('Download failed: '), 'the row shows the failure')
    await section.locator('[data-model="whisper-tiny"] .speech-actions button:has-text("Try again")').click()
    await f.waitFor(async () => (await section.locator('[data-model="whisper-tiny"]').getAttribute('data-state')) === 'downloading', 'the row downloads')
    await h.sleep(1500)
    await section.locator('[data-model="whisper-tiny"] button:has-text("Cancel")').click()
    const row = section.locator('[data-model="whisper-tiny"]')
    await f.waitFor(async () => {
      const text = await row.textContent()
      return /Stopped at \d+ of 44 MB/.test(text) || `${await row.getAttribute('data-state')}: ${text.slice(-160)}`.startsWith('#')
    }, 'Settings shows "Stopped at …"', 15000).catch(async (err) => {
      throw new Error(`${err.message}; the row: ${await row.getAttribute('data-state')} ${await row.textContent()}`)
    })
    mock.hf.fault = null
    await section.locator('[data-model="whisper-tiny"] button:has-text("Continue")').click()
    await f.waitFor(async () => (await section.locator('[data-model="whisper-tiny"]').getAttribute('data-state')) === 'installed', 'Continue completes it', 60000)
    if (SHOTS) await section.screenshot({ path: path.join(SHOTS, 'offline-captions-settings.png') })
    await win.click('.settings-modal button:has-text("Done")')
    // Remove it again for the next case (no question: straight through the API).
    await win.evaluate(() => window.api.removeSpeechModel('whisper-tiny'))

    // Closed during a download: the download finishes, and reopening shows ready without starting captions.
    await waitState(win, 'needs-model')
    await win.click('[data-testid="local-model"] [role="radio"]:has-text("Fast")')
    mock.hf.fault = 'slow'
    await win.click('[data-testid="local-download"]')
    await waitState(win, 'downloading')
    await closeEditor(win)
    mock.hf.fault = null
    await f.waitFor(() => fs.existsSync(path.join(dir, sp.TEST_MODEL.file)), 'the download finishes after the editor closed', 120000)
    await h.sleep(1000)
    await f.openProject(win, 'Failures')
    await openTab(win, 'Captions')
    await waitState(win, 'ready')
    await h.sleep(2000)
    h.assert((await cardState(win)) === 'ready' && !h.readProject(home, 'rec-speech').transcript, 'no captions started by themselves')
  }))

  await test('offline captions: Generate makes captions with real word timings; badge and notice on another tab; one undo removes them', fx.withHome('oc-generate', async (ctx, home) => {
    sp.seedSpeechProject(home, { name: 'Generate' })
    const { app, win } = await launch(ctx, home, mock)
    installModel(await modelsDir(app))
    await f.openProject(win, 'Generate')
    await openTab(win, 'Captions')
    // The default (Standard) is not downloaded, Fast is: the card offers it.
    await waitState(win, 'needs-model')
    await win.click('[data-testid="local-use-installed"]:has-text("Make them now with Fast (downloaded)")')
    await openTab(win, 'Clip')
    await f.waitFor(async () => (await win.getAttribute('[data-testid="captions-job-badge"]', 'data-phase').catch(() => null)) === 'job', 'the badge shows the job', 15000)
    await win.waitForSelector('.notice:has-text("Captions ready: ")', { timeout: 120000 })
    h.assert(/Captions ready: \d+ captions? made on this PC in .+\. Undo removes them\./.test(await win.textContent('.notice')), `the notice: ${await win.textContent('.notice')}`)
    const saved = await f.waitFor(() => h.readProject(home, 'rec-speech').transcript, 'the transcript is saved', 15000)
    h.assert(saved.provider === 'local' && saved.model === 'whisper-tiny', `provider local, model whisper-tiny: ${saved.provider} ${saved.model}`)
    const words = wordsOf(saved)
    const said = new Set(words.map((w) => w.text))
    console.log(`  heard: ${saved.segments.map((s) => s.text).join(' | ')}`)
    h.assert(said.has('americans') && said.has('country'), 'JFK is heard')
    h.assert(['apostle', 'middle', 'classes', 'gospel'].filter((w) => said.has(w)).length >= 2, 'LibriSpeech is heard')
    for (const seg of saved.segments) h.assert(seg.words && seg.words.length === seg.text.split(/\s+/).filter(Boolean).length, `words match the text: "${seg.text}"`)
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      h.assert(w.end >= w.start && (i === 0 || w.start >= words[i - 1].end - 1e-6), `monotonic, not overlapping at ${w.text} ${w.start}`)
      const inside = (w.start >= 0.7 && w.end <= 12.3) || (w.start >= 15.7 && w.end <= 22.2)
      h.assert(inside, `"${w.text}" ${w.start}–${w.end} is in the speech, not in the noise`)
    }
    await openTab(win, 'Captions')
    const summary = await win.textContent('[data-testid="local-summary"]')
    h.assert(/made on this PC with Whisper tiny \(English, detected\) in .+\. Nothing was uploaded\./.test(summary), `the summary: ${summary}`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'offline-captions-done.png') })
    // One undo removes them.
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await win.keyboard.press('Control+z')
    await f.waitFor(() => !h.readProject(home, 'rec-speech').transcript, 'one undo removes the captions', 15000)
  }))

  await test('offline captions: cancel keeps the finished parts, a restart continues from them; offline works', fx.withHome('oc-resume', async (ctx, home) => {
    sp.seedSpeechProject(home, { name: 'Resume' })
    const env = { SSW_AI_MAX_PART_SECONDS: '8' }
    let { app, win } = await launch(ctx, home, mock, { ...env, SSW_SPEECH_HELPER: sp.HOLD_HELPER })
    installModel(await modelsDir(app))
    await win.evaluate(() => window.api.setDefaultSpeechModel('whisper-tiny').catch(() => undefined))
    await f.openProject(win, 'Resume')
    await openTab(win, 'Captions')
    await waitState(win, 'ready')
    await win.click('[data-testid="local-generate"]')
    await waitState(win, 'running')
    await f.waitFor(async () => (await card(win).getAttribute('data-part')) === '2', 'part 2 runs (held)', 60000)
    const parts = Number(await card(win).getAttribute('data-parts'))
    h.assert(parts >= 3, `at least 3 parts: ${parts}`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'offline-captions-running.png') })
    await win.click('[data-testid="local-captions"] button:has-text("Cancel")')
    await f.waitFor(() => processesWith(sp.HOLD_HELPER).length === 0 && processesWith(sp.HELPER).length === 0, 'no helper process remains', 3000)
    const tmp = require('node:os').tmpdir()
    await f.waitFor(() => !fs.readdirSync(tmp).some((n) => n.startsWith('ssw-transcribe-')), 'the temporary folder is gone', 5000)
    await f.waitFor(async () => (await win.textContent('[data-testid="local-captions"]')).includes(`Stopped. 1 of ${parts} parts are kept: Generate captions continues from there.`), 'the cancelled line', 10000)
    h.assert((await cardState(win)) === 'cancelled', 'cancelled state')
    await app.close()

    // Restarted without the wrapper (and offline: the model source is gone): Generate continues.
    ;({ app, win } = await launch(ctx, home, null, { ...env, SSW_SPEECH_MODEL_BASE_URL: 'http://127.0.0.1:9/hf/' }))
    await f.openProject(win, 'Resume')
    await openTab(win, 'Captions')
    await waitState(win, 'ready')
    await win.click('[data-testid="local-generate"]')
    await f.waitFor(async () => (await win.textContent('[data-testid="local-captions"]').catch(() => '')).includes(`Continuing: 1 of ${parts} parts were already done.`), 'it continues from the kept part', 60000)
    const resumed = await f.waitFor(() => h.readProject(home, 'rec-speech').transcript, 'the transcript is saved', 120000)
    const said = new Set(wordsOf(resumed).map((w) => w.text))
    h.assert(said.has('americans') && said.has('country'), `the resumed captions have the words: ${[...said].join(' ')}`)
  }))

  await test('offline captions: Settings at speech focuses its heading; Remove; "Make them now with Standard" uses base', fx.withHome('oc-settings', async (ctx, home) => {
    sp.seedSpeechProject(home, { name: 'Settings' })
    const { app, win } = await launch(ctx, home, mock)
    const dir = await modelsDir(app)
    installModel(dir)
    await f.openProject(win, 'Settings')
    await openTab(win, 'Captions')
    await waitState(win, 'needs-model')
    await win.click('button:has-text("Manage speech models…")')
    const section = win.locator('[data-testid="speech-models"]')
    await section.waitFor()
    await f.waitFor(async () => (await win.evaluate(() => document.activeElement && document.activeElement.id)) === 'settings-speech-title', 'the heading has the focus')
    const tiny = section.locator('[data-model="whisper-tiny"]')
    await f.waitFor(async () => (await tiny.getAttribute('data-state')) === 'installed', 'Fast shows Downloaded')
    h.assert(!(await tiny.locator('input[type="radio"]').isDisabled()), 'its radio is enabled')
    h.assert(await section.locator('[data-model="whisper-small"] input[type="radio"]').isDisabled(), "Accurate's is not")
    await tiny.locator('button:has-text("Remove")').click()
    await tiny.locator('.ai-remove-question').waitFor()
    h.assert((await tiny.textContent()).includes('Remove Whisper tiny? It frees 44 MB. Captions you already made stay.'), 'the question')
    await tiny.locator('.ai-remove-question button:has-text("Remove")').click()
    await f.waitFor(() => !fs.existsSync(path.join(dir, sp.TEST_MODEL.file)), 'the file is deleted', 10000)
    await win.click('.settings-modal button:has-text("Done")')
    await waitState(win, 'needs-model')
    h.assert(!(await win.$('[data-testid="local-use-installed"]')), 'back to the consent card')

    // Tiny and base downloaded, base the default; Accurate chosen: "Make them now with Standard (downloaded)".
    installModel(dir)
    fs.copyFileSync(baseModel(), path.join(dir, BASE.file))
    await win.evaluate(() => window.api.setDefaultSpeechModel('whisper-base'))
    await closeEditor(win)
    await f.openProject(win, 'Settings')
    await openTab(win, 'Captions')
    await f.waitFor(async () => (await chipTexts(win)).includes('Standard · Downloaded'), 'Standard is downloaded', 20000)
    await win.click('[data-testid="local-model"] [role="radio"]:has-text("Accurate")')
    await waitState(win, 'needs-model')
    await win.click('[data-testid="local-use-installed"]:has-text("Make them now with Standard (downloaded)")')
    const t = await f.waitFor(() => h.readProject(home, 'rec-speech').transcript, 'captions made with base', 120000)
    h.assert(t.model === 'whisper-base', `made with base: ${t.model}`)
  }))

  await test('offline captions: with the helper missing, On this PC is not offered and says why; a key provider still transcribes', fx.withHome('oc-missing', async (ctx, home) => {
    sp.seedSpeechProject(home, { name: 'Missing' })
    const { app, win } = await launch(ctx, home, mock, { SSW_SPEECH_HELPER: '/nonexistent' })
    await addProvider(app, win)
    await f.openProject(win, 'Missing')
    await openTab(win, 'Captions')
    await win.waitForSelector('select[aria-label="Transcription provider"]', { timeout: 20000 })
    const options = await win.$$eval('select[aria-label="Transcription provider"] option', (els) => els.map((e) => e.textContent))
    h.assert(!options.some((o) => o.includes('On this PC')), `On this PC is not offered: ${options}`)
    h.assert(await win.isVisible('p:has-text("Captions on this PC are not available here: ")'), 'the hint says why')
    await win.click('button:has-text("Generate captions")')
    const t = await f.waitFor(() => h.readProject(home, 'rec-speech').transcript, 'the key provider transcribes', 60000)
    h.assert(t.provider === 'openai', `by the provider: ${t.provider}`)
  }))

  for (const missing of [false, true]) {
    await test(`offline captions: the speech detector ${missing ? 'missing: the level decides, the clatter is sound' : 'in Remove silences and music ducking; a restart reuses .cache/speech.json'}`, fx.withHome(`oc-detector-${missing}`, async (ctx, home) => {
      const id = sp.seedSpeechProject(home, { name: 'Detector', extra: { audio: { volume: 1, muted: false, music: MUSIC } } })
      fs.symlinkSync(musicFile(), path.join(h.projectsRoot(home), id, 'music.m4a'))
      const log = path.join(home, 'helper-calls.log')
      const helper = missing ? '/nonexistent' : loggingHelper(home, log)
      let { app, win } = await launch(ctx, home, null, { SSW_SPEECH_HELPER: helper })
      await hookGains(win)
      await f.openProject(win, 'Detector')
      await openTab(win, 'Clip')
      await win.click('.chips[aria-label="Smart speed mode"] .chip:has-text("Silences")')
      await win.waitForSelector('[data-testid="silence-detector"]', { timeout: 60000 })
      const detector = await win.getAttribute('[data-testid="silence-detector"]', 'data-detector')
      h.assert(detector === (missing ? 'level' : 'speech'), `data-detector: ${detector}`)
      await win.waitForSelector('.smart-list li', { timeout: 30000 })
      const secs = (t) => t.split(':').reduce((a, v) => a * 60 + Number(v), 0)
      const found = (await win.$$eval('.smart-list .smart-range', (els) => els.map((e) => e.textContent))).map((p) => p.split('–').map((t) => secs(t.trim())))
      console.log(`  silences (${detector}): ${JSON.stringify(found)}`)
      const clatter = found.some(([a, b]) => a <= 12.6 && b >= 15.4)
      h.assert(missing ? !clatter : clatter, missing ? 'the clatter is not a silence' : `a silence covers the clatter (12.3–15.7 s): ${JSON.stringify(found)}`)
      if (!missing && SHOTS) await win.screenshot({ path: path.join(SHOTS, 'offline-captions-silences.png') })

      // Music ducking: the preview's gain and the export duck under the speech, and under the clatter only without the detector.
      await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      await win.keyboard.press('Home')
      await win.keyboard.press('Space')
      await h.sleep(1500)
      await win.keyboard.press('Space')
      const times = [6, 14, 19]
      const preview = await previewDuck(win, times)
      h.assert(preview, 'the preview ducks the music')
      const out = path.join(home, 'duck.m4a')
      await h.mockSaveDialog(app, out)
      await fx.openExportDialog(win)
      await fx.pickChip(win, 'Format', 'M4A')
      await win.locator('.modal button.primary', { hasText: 'Export' }).click()
      const r = await fx.waitForExport(win)
      h.assert(r.ok, `export: ${r.text}`)
      await win.click('.modal button:has-text("Done")')
      const s = pcm(out)
      const full = amplitude(s, MUSIC_HZ, 0.1, 0.6)
      const exported = times.map((t) => amplitude(s, MUSIC_HZ, t - 0.25, t + 0.25) / full)
      console.log(`  ducking at ${times}: preview ${preview.map((v) => v.toFixed(2))}, export ${exported.map((v) => v.toFixed(2))}`)
      const ducked = (v) => v < 0.5
      for (let i = 0; i < times.length; i++) h.assert(ducked(preview[i]) === ducked(exported[i]), `preview and export agree at ${times[i]} s`)
      h.assert(ducked(exported[0]) && ducked(exported[2]), 'ducks under the speech')
      h.assert(missing ? ducked(exported[1]) : !ducked(exported[1]), missing ? 'ducks under the clatter without the detector' : 'not under the clatter')
      if (missing) return

      // A restart reads .cache/speech.json: no vad run.
      h.assert(fs.existsSync(path.join(h.projectsRoot(home), id, '.cache', 'speech.json')), 'the detector result is kept in the project')
      const vadRuns = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('vad ')).length : 0)
      const before = vadRuns()
      h.assert(before >= 1, 'the detector ran on the first open')
      await app.close()
      ;({ app, win } = await launch(ctx, home, null, { SSW_SPEECH_HELPER: helper }))
      await f.openProject(win, 'Detector')
      await openTab(win, 'Clip')
      await win.click('.chips[aria-label="Smart speed mode"] .chip:has-text("Silences")')
      await win.waitForSelector('[data-testid="silence-detector"][data-detector="speech"]', { timeout: 60000 })
      h.assert(vadRuns() === before, `no vad process after the restart (${vadRuns()} runs, ${before} before)`)
    }))
  }

  await test('offline captions: the speech IPC takes catalog ids only, and only from the app page', fx.withHome('oc-security', async (ctx, home) => {
    const { app, win } = await launch(ctx, home, mock)
    for (const bad of ['../../x', 'https://example.com/ggml-tiny-q8_0.bin', 'whisper-huge', '']) {
      const r = await win.evaluate((id) => window.api.downloadSpeechModel(id).then(() => 'resolved', (e) => `rejected: ${e.message}`), bad)
      h.assert(r.startsWith('rejected'), `downloadSpeechModel(${JSON.stringify(bad)}) rejects: ${r}`)
    }
    h.assert(!hfRequests(mock).some((r) => /\.\.|example/.test(r.route)), 'no request was made for them')
    const evil = path.join(home, 'evil.html')
    fs.writeFileSync(evil, '<!doctype html><title>evil</title>')
    const preload = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().preload || null)
    const other = await app.evaluate(async ({ BrowserWindow }, { url, preload: p }) => {
      const w = new BrowserWindow({ show: false, webPreferences: { ...(p ? { preload: p } : {}), sandbox: true, contextIsolation: true } })
      try {
        await w.loadURL(url)
        return await w.webContents.executeJavaScript(`(window.api ? Promise.all(['getSpeechState', 'showSpeechModelsFolder'].map((n) => window.api[n]().then(() => 'ok', (e) => 'refused'))) : Promise.resolve(['refused', 'refused']))`)
      } finally {
        w.destroy()
      }
    }, { url: `file://${evil}`, preload })
    h.assert(other.every((r) => r === 'refused'), `another page cannot call speech:* (${other})`)
  }))

  await mock.close()
})().catch((err) => {
  console.error(`FAIL offline captions: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
})
