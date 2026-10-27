// The Bangla model end to end (docs/design/offline-captions.md §14), with the host build of the
// speech helper and without downloading its 539 MB: the mock's /hf/ route serves a sparse stand-in
// of the pinned size, slowly, so the consent, the progress, Cancel and Delete are real, and the pin
// is never bypassed (a finished download of the stand-in would fail its SHA-256). Bengali shows the
// Bangla chip and the recommendation; other languages never do; the summary of captions detected
// as Bengali offers it; Settings lists it as "Bangla only" without a radio. The run path: a
// verified record for the stand-in (the state a finished download leaves in speech.json) makes the
// tab ready and Polish name the Bangla model; Generate runs the real helper through a logging
// wrapper with --lang bn --max-chunk 20, the helper refuses the stand-in as a damaged model, and
// the tab offers to download it again. The real model's accuracy is the opt-in benchmark
// (npm run bench:bangla). A missing helper fails, never skips.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')
const sp = require('./speech-fixtures.cjs')
const { startMockAi, mockAiEnv } = require('./ai-mock-server.cjs')

const PIN = { id: 'whisper-bn-medium', file: 'ggml-bengaliai-whisper-medium-q5_0.bin', bytes: 539_257_671 }
const BANGLA_FLAC = path.join(h.APP_DIR, 'tests/fixtures/speech/bn-fleurs-blog-18s.flac')
const SECONDS = 18.84

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** A sparse file of the pinned size (no disk used): the mock serves it, the pin refuses it. */
function standIn() {
  const dir = path.join(fx.MEDIA_CACHE, 'bangla-stand-in')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, PIN.file)
  if (!fs.existsSync(file) || fs.statSync(file).size !== PIN.bytes) {
    fs.writeFileSync(file, '')
    fs.truncateSync(file, PIN.bytes)
  }
  return file
}

/** screen.mp4 with the committed Bangla speech as its sound (cached). */
function banglaScreen() {
  const file = path.join(fx.MEDIA_CACHE, 'bangla-screen-v1.mp4')
  if (fs.existsSync(file)) return file
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-i', BANGLA_FLAC,
    '-t', String(SECONDS),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    `${file}.part.mp4`
  ])
  fs.renameSync(`${file}.part.mp4`, file)
  return file
}

/** A recording of Bangla speech (the mixed track only), with `extra` merged into project.json. */
function seedBangla(home, { id = 'rec-bangla', name = 'Bangla', extra = {} } = {}) {
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync(banglaScreen(), path.join(dir, 'screen.mp4'))
  const project = {
    version: 2,
    id,
    name,
    createdAt: new Date().toISOString(),
    duration: SECONDS,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: [{ id: 'c0', start: 0, end: SECONDS, speed: 1 }],
    zooms: [],
    autoZoom: false,
    annotations: [],
    style: { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    ...extra
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify({ samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }))
  return id
}

/** The app with the mock's /hf/ route as the model source. */
async function launch(ctx, home, mock, env = {}) {
  const { app, win, logs } = await h.launch({ home, env: { SSW_SPEECH_MODEL_BASE_URL: `${mock.url}/hf/`, ...mockAiEnv(mock.url), ...env } })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

const userData = (app) => app.evaluate(({ app: a }) => a.getPath('userData'))
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const hfRequests = (mock) => mock.requests.filter((r) => r.provider === 'hf')
const openTab = (win, name) => win.click(`.insp-tabs button:has-text("${name}")`)
const card = (win) => win.locator('[data-testid="local-captions"]').first()
const cardState = (win) => card(win).getAttribute('data-state').catch(() => null)
const waitState = (win, state, timeout = 20000) => f.waitFor(async () => (await cardState(win)) === state, `the Captions tab in state "${state}"`, timeout)
const chipTexts = (win) => win.$$eval('[data-testid="local-model"] [role="radio"]', (els) => els.map((e) => e.textContent.trim()))
const checkedChip = (win) => win.$eval('[data-testid="local-model"] [role="radio"][aria-checked="true"]', (e) => e.getAttribute('data-model')).catch(() => null)
const speak = (win, code) => win.selectOption('select[aria-label="Spoken language"]', code)

;(async () => {
  sp.requireSpeechAssets({ model: false })
  const mock = await startMockAi({ ffmpeg: 'ffmpeg', hfFiles: { [PIN.file]: standIn() } })

  await test('Bangla model: Bengali shows its chip and the recommendation with its size; the click downloads it, Cancel keeps the part, Delete removes it; other languages never see it', fx.withHome('bn-consent', async (ctx, home) => {
    seedBangla(home)
    const { app, win } = await launch(ctx, home, mock)
    const dir = path.join(await userData(app), 'speech-models')
    await f.openProject(win, 'Bangla')
    await openTab(win, 'Captions')
    await waitState(win, 'needs-model')
    h.assert(JSON.stringify(await chipTexts(win)) === JSON.stringify(['Fast · 44 MB', 'Standard · 60 MB', 'Accurate · 190 MB']), `no Bangla chip before Bengali: ${await chipTexts(win)}`)
    await speak(win, 'bn')
    await f.waitFor(async () => (await checkedChip(win)) === PIN.id, 'Bengali chooses the Bangla chip')
    h.assert((await chipTexts(win)).includes('Bangla · 539 MB'), `the Bangla chip with its size: ${await chipTexts(win)}`)
    await waitState(win, 'needs-model')
    const text = await card(win).textContent()
    for (const part of [
      'Make Bangla captions on this PC',
      'Recommended for Bangla: the Bangla model gets about 4 in 5 words right, where the other tiers get most Bangla words wrong.',
      'works offline once downloaded',
      '539 MB, from Hugging Face',
      'Bengali.AI Whisper medium, Apache-2.0 licence'
    ])
      h.assert(text.includes(part), `the recommendation says "${part}": ${text}`)
    const primaries = await win.$$eval('[data-testid="local-captions"] button.primary', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-label')]))
    h.assert(
      JSON.stringify(primaries) === JSON.stringify([['Download Bangla model (539 MB) and make captions', 'Download Bangla (Bengali.AI Whisper medium), 539 megabytes, and make captions']]),
      `one primary action: ${JSON.stringify(primaries)}`
    )
    h.assert(hfRequests(mock).length === 0, 'nothing is downloaded before the click')

    // Consent: the click downloads it (slowly); Cancel keeps the part; Delete removes it.
    mock.hf.fault = 'slow'
    try {
      await win.click('[data-testid="local-download"]')
      await waitState(win, 'downloading')
      await f.waitFor(async () => /Downloading Bangla \(Bengali\.AI Whisper medium\)… \d+ of 539 MB/.test(await card(win).textContent()), 'the progress names the Bangla model', 20000)
      h.assert(hfRequests(mock).some((r) => r.route === `/${PIN.file}`), `the pinned file was asked for: ${JSON.stringify(hfRequests(mock).map((r) => r.route))}`)
      await card(win).locator('button:has-text("Cancel")').click()
      await waitState(win, 'stopped')
    } finally {
      mock.hf.fault = null
    }
    h.assert(/Download stopped at \d+ of 539 MB\./.test(await card(win).textContent()), 'stopped, with the part kept')
    h.assert(fs.existsSync(path.join(dir, `${PIN.file}.part`)), 'the .part is kept')
    await card(win).locator('button:has-text("Delete the")').click()
    await waitState(win, 'needs-model')
    await f.waitFor(() => !fs.existsSync(path.join(dir, `${PIN.file}.part`)), 'Delete removes the part', 10000)
    const settings = readJson(path.join(dir, 'speech.json'))
    h.assert(!settings || settings.defaultModel === 'whisper-base', `the default is untouched: ${JSON.stringify(settings)}`)

    // Another language: no Bangla chip, the general tier, as before.
    for (const code of ['en', 'hi', '']) {
      await speak(win, code)
      await f.waitFor(async () => (await checkedChip(win)) === 'whisper-base', `${code || 'Detect automatically'} chooses Standard`)
      h.assert(!(await chipTexts(win)).some((t) => t.startsWith('Bangla')), `no Bangla chip for ${code || 'Detect automatically'}: ${await chipTexts(win)}`)
    }
  }))

  await test('Bangla model: the summary of captions detected as Bengali offers it; the click opens the form in Bengali and downloads it', fx.withHome('bn-offer', async (ctx, home) => {
    const transcript = { provider: 'local', model: 'whisper-base', language: 'bn', createdAt: new Date().toISOString(), segments: [{ id: 't1', start: 1, end: 3, text: 'আমি বাংলায় কথা বলি', words: [{ text: 'আমি', start: 1, end: 1.4 }, { text: 'বাংলায়', start: 1.4, end: 2 }, { text: 'কথা', start: 2, end: 2.4 }, { text: 'বলি', start: 2.4, end: 3 }] }] }
    seedBangla(home, { extra: { transcript } })
    const { app, win } = await launch(ctx, home, mock)
    const dir = path.join(await userData(app), 'speech-models')
    await f.openProject(win, 'Bangla')
    await openTab(win, 'Captions')
    const offer = win.locator('[data-testid="bangla-offer"]')
    await offer.waitFor({ timeout: 20000 })
    h.assert((await offer.textContent()).includes('Bangla captions: the Bangla model gets about 4 in 5 words right'), 'why, in plain words')
    h.assert(!(await win.$('text=Smaller models make more mistakes')), 'instead of the general line')
    // The replace question is asked and accepted.
    win.once('dialog', (d) => d.accept())
    mock.hf.fault = 'slow'
    try {
      await win.click('[data-testid="bangla-offer-button"]:has-text("Download Bangla model (539 MB) and make captions")')
      await waitState(win, 'downloading')
      h.assert((await win.$eval('select[aria-label="Spoken language"]', (s) => s.value)) === 'bn', 'Bengali is the spoken language')
      h.assert((await card(win).getAttribute('data-model')) === PIN.id, 'the Bangla model downloads')
      await card(win).locator('button:has-text("Cancel")').click()
      await waitState(win, 'stopped')
    } finally {
      mock.hf.fault = null
    }
    await card(win).locator('button:has-text("Delete the")').click()
    await waitState(win, 'needs-model')
    await f.waitFor(() => !fs.existsSync(path.join(dir, `${PIN.file}.part`)), 'the part is deleted', 10000)
  }))

  await test('Bangla model: Settings lists it as "Bangla only", with its size and licence, without a radio', fx.withHome('bn-settings', async (ctx, home) => {
    seedBangla(home)
    const { win } = await launch(ctx, home, mock)
    await f.openProject(win, 'Bangla')
    await openTab(win, 'Captions')
    await waitState(win, 'needs-model')
    await win.click('button:has-text("Manage speech models…")')
    const section = win.locator('[data-testid="speech-models"]')
    await section.waitFor()
    const ids = await section.locator('.speech-model').evaluateAll((els) => els.map((e) => e.getAttribute('data-model')))
    h.assert(JSON.stringify(ids) === JSON.stringify(['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-turbo', PIN.id]), `rows: ${ids}`)
    const row = section.locator(`[data-model="${PIN.id}"]`)
    const text = await row.textContent()
    for (const part of ['Bengali.AI Whisper medium · Bangla only', '539 MB download', 'Bangla only: used whenever the spoken language is Bengali, never for other languages.', 'Apache-2.0 licence', '(11cf5cb)'])
      h.assert(text.includes(part), `the row says "${part}": ${text}`)
    h.assert((await row.locator('input[type="radio"]').count()) === 0, 'no radio: never the model for new captions')
    h.assert((await section.locator('[data-model="whisper-base"] input[type="radio"]').count()) === 1, 'the general rows keep theirs')
    h.assert((await row.locator('button:has-text("Download 539 MB")').count()) === 1, 'its download names its size')
  }))

  await test('Bangla model: once verified, Bengali uses it (tab and Polish); Generate runs the helper with --lang bn --max-chunk 20, which refuses the stand-in as damaged', fx.withHome('bn-run', async (ctx, home) => {
    seedBangla(home)
    // The models folder as a finished download leaves it: the file and its verified record. The
    // stand-in is sparse, so it costs no disk; the engine will refuse it, as it should.
    const first = await launch(ctx, home, mock)
    const dir = path.join(await userData(first.app), 'speech-models')
    await first.app.close()
    ctx.app = null
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, PIN.file)
    fs.writeFileSync(file, '')
    fs.truncateSync(file, PIN.bytes)
    const stat = fs.statSync(file)
    fs.writeFileSync(path.join(dir, 'speech.json'), JSON.stringify({ version: 1, defaultModel: 'whisper-base', verified: { [PIN.id]: { bytes: stat.size, mtimeMs: stat.mtimeMs } }, measured: {} }))
    // The real helper, through a wrapper that logs its arguments (the helper's environment is minimal: absolute paths).
    const log = path.join(home, 'helper-args.log')
    const wrapper = path.join(home, 'logging-helper.sh')
    fs.writeFileSync(wrapper, `#!/bin/bash\necho "$@" >> '${log}'\nexec '${sp.HELPER}' "$@"\n`, { mode: 0o755 })
    const { win } = await launch(ctx, home, mock, { SSW_SPEECH_HELPER: wrapper })
    await f.openProject(win, 'Bangla')
    await openTab(win, 'Captions')

    // Detect automatically: the general tier, with the line that offers Bengali in one click.
    await waitState(win, 'needs-model')
    const hint = win.locator('[data-testid="bangla-hint"][data-kind="detect"]')
    await hint.waitFor({ timeout: 10000 })
    h.assert((await hint.textContent()).includes('Speaking Bangla? Choose Bengali to use the Bangla model.'), 'the detect line')
    await hint.locator('button:has-text("Choose Bengali")').click()
    await f.waitFor(async () => (await checkedChip(win)) === PIN.id, 'Bengali uses the Bangla model by default')
    h.assert((await chipTexts(win)).includes('Bangla · Downloaded'), `its chip reads Downloaded: ${await chipTexts(win)}`)
    await waitState(win, 'ready')

    // Polish in one click names it for the captions.
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await win.keyboard.press('Shift+P')
    const polishRow = win.locator('[data-testid="polish-row-captions"]')
    await f.waitFor(async () => ((await polishRow.textContent().catch(() => '')) || '').includes('Runs on this PC with the Bangla model'), 'Polish makes the captions with the Bangla model', 20000)
    await win.click('.polish-dialog button:has-text("Cancel")')
    await win.locator('.polish-dialog').waitFor({ state: 'detached', timeout: 10000 })

    // Generate: the real helper is started with the model's language and chunk length, and refuses the stand-in.
    await win.click('[data-testid="local-generate"]')
    await waitState(win, 'error', 120000)
    const error = await card(win).textContent()
    h.assert(error.includes('The speech model for Bangla (Bengali.AI Whisper medium) is damaged or missing, so it was not used. Download it again (539 MB).'), `the damaged copy: ${error}`)
    h.assert(await card(win).locator('button:has-text("Download again (539 MB)")').isVisible(), '[Download again (539 MB)]')
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('transcribe'))
    h.assert(calls.length >= 1, `the helper ran: ${calls}`)
    for (const args of calls) {
      h.assert(args.includes(`--model ${PIN.file}`), `the Bangla model: ${args}`)
      h.assert(args.includes('--lang bn'), `in Bengali: ${args}`)
      h.assert(args.includes('--max-chunk 20'), `with 20 s chunks: ${args}`)
    }
    // The engine could not load it: the verified record is cleared, so the next use hashes it again.
    await f.waitFor(() => !readJson(path.join(dir, 'speech.json'))?.verified?.[PIN.id], 'the verified record is cleared', 10000)
    h.assert(readJson(path.join(dir, 'speech.json')).defaultModel === 'whisper-base', 'the default is untouched')
  }))

  await mock.close()
})()
