// AI providers in the real built app, against a local mock of the providers' HTTP APIs
// (ai-mock-server.cjs, pointed at with the SSW_AI_BASE_URL_* test hooks): adding, testing,
// editing and removing providers in Settings (keyboard and focus included), keys encrypted on
// disk and never in the renderer, transcribing a recording with OpenAI and Gemini in parts
// with correct source times after the merge (microphone stem and mixed sound), the text tasks
// with each kind, clear errors, and cancelling (ffmpeg stopped, temporary files removed),
// also by leaving the editor.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const { startMockAi, mockAiEnv, burstAudioArgs } = require('./ai-mock-server.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))

/** "Word k" bursts start here (seconds): parts of at most 8 s are cut in the pauses between them. */
const STARTS = [1, 3.6, 6.2, 8.8, 11.4, 14, 16.6]
const SECONDS = 19

const KEYS = { openai: 'sk-e2e-openai-key-0001', gemini: 'AIza-e2e-gemini-key-0002', anthropic: 'sk-ant-e2e-claude-key-0003' }

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** A cached media file made by ffmpeg from `args` (the output path is appended). */
function cached(name, args) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, name)
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/(\.\w+)$/, '.part$1')
  execFileSync(FF, ['-v', 'error', '-y', ...args, tmp])
  fs.renameSync(tmp, file)
  return file
}

/** A 60 fps video whose sound has the "Word k" bursts starting at `starts`. */
const wordsVideo = (name, starts) =>
  cached(`ai-${name}.mp4`, [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60', ...burstAudioArgs(starts, SECONDS),
    '-t', String(SECONDS), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'
  ])
const wordsAudio = (name, starts) => cached(`ai-${name}.m4a`, [...burstAudioArgs(starts, SECONDS), '-c:a', 'aac', '-b:a', '128k'])

/** Seeds a project (render-fixtures layout) with extra files and project fields. */
function seed(home, opts) {
  const id = fx.seedProject(home, opts)
  const dir = path.join(h.projectsRoot(home), id)
  for (const [name, file] of Object.entries(opts.files || {})) fs.symlinkSync(file, path.join(dir, name))
  const file = path.join(dir, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...(opts.extra || {}) }, null, 2))
  return id
}

/** Checks a transcript of `starts`: every word once, in order, at its source time. */
function checkWords(t, starts, what) {
  const texts = t.segments.map((s) => s.text)
  h.assert(JSON.stringify(texts) === JSON.stringify(starts.map((_, k) => `Word ${k}`)), `${what}: words ${JSON.stringify(texts)}`)
  t.segments.forEach((s, k) => {
    h.assert(Math.abs(s.start - starts[k]) < 0.15 && Math.abs(s.end - (starts[k] + 1.2)) < 0.15, `${what}: Word ${k} at ${s.start}-${s.end}, expected ${starts[k]}-${starts[k] + 1.2}`)
    h.assert(s.id === `t${k + 1}`, `${what}: id ${s.id}`)
  })
}

const transcribeTemps = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('ssw-transcribe-'))

/** Calls window.api in the page; resolves { ok, value } or { ok: false, error } (the message the renderer gets). */
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

async function launch(ctx, home, mock, extraEnv = {}) {
  const { app, win, logs } = await h.launch({ home, env: { ...mockAiEnv(mock.url), SSW_AI_MAX_PART_SECONDS: '8', ...extraEnv } })
  ctx.app = app
  ctx.logs = logs
  // Xvfb has no keyring, and the app refuses to store keys without one; the test turns on
  // Chromium's basic store from outside (the app itself never does).
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

const dialog = (win) => win.locator('[role="dialog"][aria-labelledby="settings-title"]')

/** Adds a provider through the Settings form (the dialog is open). */
async function addProvider(win, kind, name, key) {
  const d = dialog(win)
  await d.getByRole('button', { name: '+ Add provider' }).click()
  await d.getByRole('radio', { name: { openai: 'OpenAI', gemini: 'Google Gemini', anthropic: 'Anthropic Claude' }[kind] }).click()
  await d.getByLabel('Name').fill(name)
  await d.getByLabel('API key').fill(key)
  await d.locator('form button[type="submit"]').click()
  await d.locator('.ai-provider', { hasText: name }).waitFor({ timeout: 10000 })
}

/** Clicks Test on provider `name` and returns the result line. */
async function testProvider(win, name) {
  const row = dialog(win).locator('.ai-provider', { hasText: name })
  await row.getByRole('button', { name: `Test ${name}` }).click()
  const status = row.locator('.ai-test')
  await win.waitForFunction((el) => el && !/Testing/.test(el.textContent), await status.elementHandle(), { timeout: 20000 })
  return status.textContent()
}

async function main() {
  const mock = await startMockAi({ ffmpeg: FF })
  try {
    await test('No keyring: keys are refused, not stored', fx.withHome('ai-nokeyring', async (ctx, home) => {
      const { app, win } = await h.launch({ home, env: mockAiEnv(mock.url) })
      ctx.app = app
      ctx.logs = []
      await win.waitForSelector('.home', { timeout: 30000 })
      const r = await api(win, 'saveAiProvider', { kind: 'openai', label: 'OpenAI', apiKey: KEYS.openai })
      h.assert(!r.ok && /cannot be stored safely on this PC/.test(r.error), `refused: ${r.error}`)
      const userData = await app.evaluate(({ app }) => app.getPath('userData'))
      h.assert(!fs.existsSync(path.join(userData, 'ai-providers.json')), 'nothing written')
    }))

    await test('Settings: add, test, edit and remove providers; keys encrypted and never in the page', fx.withHome('ai-settings', async (ctx, home) => {
      const { app, win } = await launch(ctx, home, mock)
      // Other parts of the app (the Captions tab) re-read their provider lists on this event.
      await win.evaluate(() => {
        window.__providersChanged = 0
        window.addEventListener('ssw:ai-providers-changed', () => window.__providersChanged++)
      })
      const changes = () => win.evaluate(() => window.__providersChanged)
      const gear = win.getByRole('button', { name: 'Settings' })
      await gear.click()
      const d = dialog(win)
      await d.waitFor()
      const intro = await d.textContent()
      h.assert(/Keys are stored encrypted on this PC and are only sent to the provider you pick\./.test(intro), 'privacy note shown')
      h.assert(/Claude cannot\s+transcribe \(the Claude API does not accept sound\)/.test(intro), 'explains why Claude cannot transcribe')
      h.assert(intro.includes('No key? Captions can also be made on this PC, free and offline (see Captions on this PC below).'), 'points to captions on this PC')
      h.assert(await win.evaluate(() => document.activeElement?.textContent === '+ Add provider'), 'focus starts inside the dialog')

      // The form: OpenAI by default, key hidden until shown, default models.
      await d.getByRole('button', { name: '+ Add provider' }).click()
      h.assert((await d.getByRole('radio', { name: 'OpenAI' }).getAttribute('aria-checked')) === 'true', 'OpenAI picked by default')
      h.assert((await d.getByLabel('Transcription model').inputValue()) === 'gpt-transcribe', 'gpt-transcribe by default (whisper-1 retires on 26 February 2027)')
      const key = d.getByLabel('API key')
      h.assert((await key.getAttribute('type')) === 'password', 'key hidden')
      await key.fill(KEYS.openai)
      await d.getByRole('button', { name: 'Show the key' }).click()
      h.assert((await key.getAttribute('type')) === 'text', 'key shown')
      await d.getByRole('button', { name: 'Hide the key' }).click()
      h.assert((await key.getAttribute('type')) === 'password', 'key hidden again')
      // Claude: no transcription model, and it says why.
      await d.getByRole('radio', { name: 'Anthropic Claude' }).click()
      h.assert((await d.getByLabel('Transcription model').count()) === 0, 'Claude has no transcription model')
      h.assert(/It cannot transcribe/.test(await d.locator('form').textContent()), 'Claude form says it cannot transcribe')
      // Esc closes the form first (back to the Add button), not the dialog.
      await win.keyboard.press('Escape')
      await d.getByRole('button', { name: '+ Add provider' }).waitFor()
      h.assert(await d.isVisible(), 'dialog still open after Esc in the form')

      h.assert((await changes()) === 0, 'no providers-changed event before a change')
      await addProvider(win, 'openai', 'My OpenAI', KEYS.openai)
      h.assert((await changes()) === 1, 'providers-changed event after adding, while Settings is still open')
      await addProvider(win, 'gemini', 'My Gemini', KEYS.gemini)
      await addProvider(win, 'anthropic', 'My Claude', KEYS.anthropic)
      await addProvider(win, 'openai', 'Wrong key', 'bad-e2e-openai-key')
      const rows = await d.locator('.ai-provider').allTextContents()
      h.assert(rows.length === 4 && /…0001/.test(rows[0]) && /…0002/.test(rows[1]) && /…0003/.test(rows[2]), `masked keys listed: ${rows.join(' | ')}`)
      h.assert(/gpt-transcribe/.test(rows[0]) && /gemini-3\.8-flash/.test(rows[1]) && /claude-opus-5-5/.test(rows[2]) && !/Transcription/.test(rows[2]), 'models listed')

      for (const name of ['My OpenAI', 'My Gemini', 'My Claude']) {
        const r = await testProvider(win, name)
        h.assert(/^✓ The key works/.test(r), `${name} test: ${r}`)
      }
      const wrong = await testProvider(win, 'Wrong key')
      h.assert(/✕ OpenAI did not accept the API key/.test(wrong), `wrong key test: ${wrong}`)

      // Edit: rename and change the model, keeping the stored key.
      await d.getByRole('button', { name: 'Edit My Claude' }).click()
      h.assert(/Leave empty to keep the current key \(…0003\)/.test(await d.locator('form').textContent()), 'edit keeps the key unless one is typed')
      await d.getByLabel('Name').fill('Claude (work)')
      await d.getByLabel('Model for text tasks').fill('claude-sonnet-5-5')
      const beforeEdit = await changes()
      await d.locator('form button[type="submit"]').click()
      await d.locator('.ai-provider', { hasText: 'Claude (work)' }).waitFor()
      h.assert((await changes()) === beforeEdit + 1, 'providers-changed event after editing')
      h.assert(/claude-sonnet-5-5/.test(await d.locator('.ai-provider', { hasText: 'Claude (work)' }).textContent()), 'model changed')
      h.assert(/^✓/.test(await testProvider(win, 'Claude (work)')), 'edited provider still has its key')

      // Remove asks first; Cancel keeps it, Remove deletes it.
      await d.getByRole('button', { name: 'Remove Wrong key' }).click()
      await d.locator('.ai-remove-question').waitFor()
      await win.keyboard.press('Escape')
      await d.locator('.ai-remove-question').waitFor({ state: 'detached' })
      h.assert(await win.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Remove Wrong key'), 'focus back on Remove after cancelling')
      const beforeRemove = await changes()
      await d.getByRole('button', { name: 'Remove Wrong key' }).click()
      await d.locator('.ai-remove-question').getByRole('button', { name: 'Remove' }).click()
      await d.locator('.ai-provider', { hasText: 'Wrong key' }).waitFor({ state: 'detached' })
      h.assert((await changes()) === beforeRemove + 1, 'providers-changed event after removing')

      // Tab stays in the dialog; Esc closes it and focus goes back to the gear.
      for (let i = 0; i < 25; i++) await win.keyboard.press('Tab')
      h.assert(await win.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'Tab stays inside the dialog')
      const beforeClose = await changes()
      await win.keyboard.press('Escape')
      await d.waitFor({ state: 'detached' })
      h.assert(await win.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Settings'), 'focus back on the Settings button')
      h.assert((await changes()) === beforeClose + 1, 'providers-changed event when Settings closes')

      // Other parts of the app open it with the event.
      await win.evaluate(() => window.dispatchEvent(new CustomEvent('ssw:open-settings', { detail: { section: 'ai' } })))
      await d.waitFor()
      h.assert((await d.locator('.ai-provider').count()) === 3, 'providers listed again')
      await d.getByRole('button', { name: 'Done' }).click()
      await d.waitFor({ state: 'detached' })

      // Keys: encrypted on disk, never in the page (DOM, API answers, storage).
      const userData = await app.evaluate(({ app }) => app.getPath('userData'))
      const disk = fs.readFileSync(path.join(userData, 'ai-providers.json'), 'utf8')
      const listed = await api(win, 'listAiProviders')
      const page = await win.evaluate(() => document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
      for (const k of Object.values(KEYS)) {
        h.assert(!disk.includes(k), `key ${k.slice(0, 6)}… not in plain text on disk`)
        h.assert(!JSON.stringify(listed.value).includes(k), 'key not sent to the renderer')
        h.assert(!page.includes(k), 'key not left in the page')
      }
      h.assert(JSON.parse(disk).providers.every((p) => typeof p.key === 'string' && p.key.length > 20 && !('apiKey' in p)), 'stored keys are ciphertext')
      // Each key went to its own provider only.
      for (const r of mock.requests) {
        if (r.key && r.provider === 'openai') h.assert(r.key === KEYS.openai || r.key === 'bad-e2e-openai-key', 'OpenAI got only its key')
        if (r.key && r.provider === 'gemini') h.assert(r.key === KEYS.gemini, 'Gemini got only its key')
        if (r.key && r.provider === 'anthropic') h.assert(r.key === KEYS.anthropic, 'Claude got only its key')
      }
    }))

    await test('Transcription in parts with OpenAI and Gemini: source times after the merge, stems, text tasks with each kind', fx.withHome('ai-transcribe', async (ctx, home) => {
      // Cut from 5 s to 9 s: the transcript stays in source seconds (the editor maps it through cuts).
      const id = seed(home, {
        id: 'rec-ai-words', name: 'AI words', seconds: SECONDS, media: wordsVideo('words', STARTS), audio: true,
        clips: [{ id: 'c0', start: 0, end: 5, speed: 1 }, { id: 'c1', start: 9, end: SECONDS, speed: 1 }]
      })
      // The mixed sound has two words; the microphone stem has all of them.
      const stems = seed(home, {
        id: 'rec-ai-stems', name: 'AI stems', seconds: SECONDS, media: wordsVideo('mixed', STARTS.slice(0, 2)), audio: true,
        files: { 'mic.m4a': wordsAudio('mic', STARTS) }, extra: { audioStems: { mic: true, system: false } }
      })
      const { win } = await launch(ctx, home, mock)
      const providers = {}
      for (const [kind, label] of [['openai', 'OpenAI'], ['gemini', 'Gemini'], ['anthropic', 'Claude']]) {
        // OpenAI with whisper-1 (until it retires): word times from the provider (gpt-transcribe: transcription.e2e.cjs).
        const r = await api(win, 'saveAiProvider', { kind, label, apiKey: KEYS[kind], ...(kind === 'openai' ? { transcriptionModel: 'whisper-1' } : {}) })
        h.assert(r.ok, `saved ${label}: ${r.error}`)
        providers[kind] = r.value.id
      }
      await win.evaluate(() => {
        window.__progress = []
        window.api.onTranscribeProgress((p) => window.__progress.push(p))
      })

      const before = mock.requests.length
      const openai = await api(win, 'transcribe', id, { providerId: providers.openai })
      h.assert(openai.ok, `OpenAI transcription: ${openai.error}`)
      checkWords(openai.value, STARTS, 'OpenAI')
      h.assert(openai.value.provider === 'openai' && openai.value.model === 'whisper-1' && openai.value.language === 'en', 'transcript metadata')
      h.assert(JSON.stringify(openai.value.segments[2].words.map((w) => w.text)) === '["Word","2"]', 'word timings kept')
      const parts = mock.requests.slice(before).filter((r) => r.route === '/audio/transcriptions')
      h.assert(parts.length === 3, `sent in 3 parts (${parts.length})`)
      h.assert(parts.every((p) => p.fields.model === 'whisper-1' && p.fields.response_format === 'verbose_json' && /audio\/mpeg/.test(p.fields.file)), 'OpenAI request fields')
      const progress = await win.evaluate(() => window.__progress.map((p) => `${p.phase} ${p.done}/${p.total}`))
      h.assert(JSON.stringify(progress) === JSON.stringify(['extracting 0/1', 'transcribing 0/3', 'transcribing 1/3', 'transcribing 2/3', 'finishing 3/3']), `progress ${progress}`)

      const gemini = await api(win, 'transcribe', id, { providerId: providers.gemini, language: 'en' })
      h.assert(gemini.ok, `Gemini transcription: ${gemini.error}`)
      checkWords(gemini.value, STARTS, 'Gemini')

      const auto = await api(win, 'transcribe', stems, { providerId: providers.openai, source: 'auto' })
      checkWords(auto.value, STARTS, 'microphone stem')
      const mixed = await api(win, 'transcribe', stems, { providerId: providers.openai, source: 'mixed' })
      checkWords(mixed.value, STARTS.slice(0, 2), 'mixed sound')

      const claude = await api(win, 'transcribe', id, { providerId: providers.anthropic })
      h.assert(!claude.ok && /Claude cannot transcribe: the Claude API does not accept sound/.test(claude.error), `Claude transcription refused: ${claude.error}`)

      // Text tasks on the transcript, through each kind.
      const segments = openai.value.segments
      for (const kind of ['openai', 'gemini', 'anthropic']) {
        const cleanup = await api(win, 'aiText', providers[kind], { task: 'cleanup', segments })
        h.assert(cleanup.ok, `${kind} cleanup: ${cleanup.error}`)
        h.assert(cleanup.value.segments.every((s, i) => s.id === segments[i].id && s.start === segments[i].start && s.end === segments[i].end && s.text === `${segments[i].text}.`), `${kind} cleanup keeps ids and times`)
        const tr = await api(win, 'aiText', providers[kind], { task: 'translate', segments, targetLanguage: 'Bengali' })
        h.assert(tr.ok && tr.value.segments.every((s, i) => s.id === segments[i].id && s.start === segments[i].start && s.text === `[Bengali] ${segments[i].text}`), `${kind} translation: ${tr.error}`)
        const ch = await api(win, 'aiText', providers[kind], { task: 'chapters', segments })
        h.assert(ch.ok && ch.value.chapters.length === 2 && ch.value.chapters[0].t === segments[0].start && ch.value.chapters[1].t === segments[3].start, `${kind} chapters: ${JSON.stringify(ch)}`)
        const title = await api(win, 'aiText', providers[kind], { task: 'title', segments })
        h.assert(title.ok && title.value.text === 'Mock title', `${kind} title: ${JSON.stringify(title)}`)
        const summary = await api(win, 'aiText', providers[kind], { task: 'summary', segments })
        h.assert(summary.ok && /mock summary/.test(summary.value.text), `${kind} summary`)
      }
      const claudeCall = [...mock.requests].reverse().find((r) => r.provider === 'anthropic' && r.route === '/v1/messages')
      h.assert(claudeCall.json.thinking?.type === 'adaptive' && claudeCall.json.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(claudeCall.beta), 'Claude request settings')
      h.assert(transcribeTemps().length === 0, 'no temporary files left')
    }))

    await test('Errors, retries and cancelling (also by leaving the editor)', fx.withHome('ai-cancel', async (ctx, home) => {
      seed(home, { id: 'rec-ai-cancel', name: 'AI cancel', seconds: SECONDS, media: wordsVideo('words', STARTS), audio: true })
      const { app, win } = await launch(ctx, home, mock)
      const add = async (kind, label, apiKey, extra = {}) => (await api(win, 'saveAiProvider', { kind, label, apiKey, ...extra })).value.id
      const quota = await add('openai', 'Broke', 'quota-e2e-openai-key')
      const flaky = await add('openai', 'Flaky', 'flaky-e2e-openai-key', { transcriptionModel: 'whisper-1' })
      const slow = await add('openai', 'Slow', 'slow-e2e-openai-key')
      const slowGemini = await add('gemini', 'Slow Gemini', 'slow-e2e-gemini-key')

      const q = await api(win, 'transcribe', 'rec-ai-cancel', { providerId: quota })
      h.assert(!q.ok && /no credits or quota left/.test(q.error), `quota error: ${q.error}`)
      const f = await api(win, 'transcribe', 'rec-ai-cancel', { providerId: flaky })
      h.assert(f.ok, `retried after server errors: ${f.error}`)
      checkWords(f.value, STARTS, 'after retries')

      const pid = app.process().pid
      const waitTranscribing = () =>
        win.evaluate(
          () =>
            new Promise((resolve) => {
              const off = window.api.onTranscribeProgress((p) => {
                if (p.phase === 'transcribing') {
                  off()
                  resolve()
                }
              })
            })
        )
      // Cancel from the API.
      await win.evaluate((providerId) => {
        window.__run = window.api.transcribe('rec-ai-cancel', { providerId }).then(
          () => 'finished',
          (err) => String(err.message)
        )
      }, slow)
      await waitTranscribing()
      h.assert(transcribeTemps().length === 1, 'temporary folder while running')
      await api(win, 'cancelTranscription', 'rec-ai-cancel')
      const cancelled = await win.evaluate(() => window.__run)
      h.assert(/Cancelled\.$/.test(cancelled), `cancelled: ${cancelled}`)
      h.assert(transcribeTemps().length === 0, 'temporary files removed')
      h.assert(fx.ffmpegChildren(pid).length === 0, 'no ffmpeg left')

      // Leaving the editor stops it too (the editor stops its project's analyses).
      await fx.openProject(win, 'AI cancel')
      await win.evaluate((providerId) => {
        window.__run = window.api.transcribe('rec-ai-cancel', { providerId }).then(
          () => 'finished',
          (err) => String(err.message)
        )
      }, slowGemini)
      await waitTranscribing()
      await win.click('button[aria-label="Back to recordings"]')
      await win.waitForSelector('.home', { timeout: 30000 })
      const left = await win.evaluate(() => Promise.race([window.__run, new Promise((r) => setTimeout(() => r('still running'), 10000))]))
      h.assert(/Cancelled\.$/.test(left), `stopped when leaving the editor: ${left}`)
      h.assert(transcribeTemps().length === 0, 'temporary files removed after leaving')
    }))
  } finally {
    await mock.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
