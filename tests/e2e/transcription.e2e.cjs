// Captions that survive the OpenAI shutdown, with speaker labels (NW-09, docs/design/transcription.md),
// in the real built app against the local mock of the providers (ai-mock-server.cjs; no real API):
// - OpenAI's suggested gpt-transcribe answers text only: the Captions tab says word times will be
//   estimated, the request has no timestamp fields, every word is estimated and lands on its sound,
//   the summary and the Transcript tab say so;
// - Gemini labels two speakers: shown in the caption rows and the Transcript tab, renamed everywhere
//   at once (one undo step), in the WebVTT voice tags and, when asked, the SRT, and on the video;
// - a recording with microphone and computer-sound tracks is labelled You and Others with no AI;
// - a retired model fails with a plain message after its day (SSW_AI_TODAY).
// SSW_E2E_SHOTS=<dir> saves screenshots of the new UI.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')
const { startMockAi, mockAiEnv, burstAudioArgs } = require('./ai-mock-server.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const SHOTS = process.env.SSW_E2E_SHOTS || null

/** "Word k" bursts start here (seconds); parts of at most 8 s are cut in the pauses between them. */
const STARTS = [1, 3.6, 6.2, 8.8, 11.4, 14, 16.6]
const SECONDS = 19

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

function cached(name, args) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, name)
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/(\.\w+)$/, '.part$1')
  execFileSync(FF, ['-v', 'error', '-y', ...args, tmp])
  fs.renameSync(tmp, file)
  return file
}

const wordsVideo = (name, starts) =>
  cached(`nw09-${name}.mp4`, [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', ...burstAudioArgs(starts, SECONDS),
    '-t', String(SECONDS), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'
  ])
const wordsAudio = (name, starts) => cached(`nw09-${name}.m4a`, [...burstAudioArgs(starts, SECONDS), '-c:a', 'aac', '-b:a', '128k'])

const STYLE = { background: { type: 'color', color: '#00a040' }, padding: 0.08, cornerRadius: 12, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }

function seed(home, opts) {
  const id = fx.seedProject(home, { style: STYLE, effects: NO_FX, ...opts })
  const dir = path.join(h.projectsRoot(home), id)
  for (const [name, file] of Object.entries(opts.files || {})) fs.symlinkSync(file, path.join(dir, name))
  const file = path.join(dir, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...(opts.extra || {}) }, null, 2))
  return id
}

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
  // Xvfb has no keyring: the test turns on Chromium's basic store from outside (the app never does).
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

const saved = (home, id, pred, what, timeout = 15000) =>
  f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return pred(p) ? p : null
      } catch {
        return null
      }
    },
    what,
    timeout
  )

const captionsTab = (win) => win.click('.insp-tabs button:has-text("Captions")')
const transcriptTab = (win) => win.click('.insp-tabs button:has-text("Transcript")')

/** Saves a screenshot of the inspector section holding `selector`, or of the inspector (SSW_E2E_SHOTS only). */
async function shot(win, name, selector) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  const target = selector ? win.locator('.insp-section', { has: win.locator(selector) }).first() : win.locator('.inspector').first()
  await target.scrollIntoViewIfNeeded()
  await target.screenshot({ path: path.join(SHOTS, `transcription-${name}.png`) })
}

/** Picks provider `id` in the Generate form and generates; waits for the summary. */
async function generateWith(win, providerId) {
  await win.selectOption('select[aria-label="Transcription provider"]', providerId)
  await win.click('button.primary:has-text("Generate captions")')
}

async function main() {
  const mock = await startMockAi({ ffmpeg: FF })
  try {
    await test('transcription: gpt-transcribe text is timed from the sound and marked estimated', fx.withHome('nw09-openai', async (ctx, home) => {
      const id = seed(home, { id: 'rec-nw09-openai', name: 'Text only', seconds: SECONDS, media: wordsVideo('words', STARTS), audio: true })
      const { win } = await launch(ctx, home, mock)
      const r = await api(win, 'saveAiProvider', { kind: 'openai', label: 'OpenAI', apiKey: 'sk-e2e-openai-key-0001' })
      h.assert(r.ok && r.value.transcriptionModel === 'gpt-transcribe', `the suggested transcription model is gpt-transcribe (${r.value?.transcriptionModel})`)

      await fx.openProject(win, 'Text only')
      await captionsTab(win)
      const hint = await win.waitForSelector('[data-testid="estimated-times-hint"]', { timeout: 10000 })
      h.assert(/gives text without timings\. Flown estimates when each word is spoken/.test(await hint.textContent()), 'the form says word times will be estimated')
      await shot(win, 'form', '[data-testid="estimated-times-hint"]')
      const before = mock.requests.length
      await generateWith(win, r.value.id)
      await win.waitForSelector('[data-testid="estimated-summary"]', { timeout: 60000 })
      h.assert(/Word times are estimated/.test(await win.textContent('[data-testid="estimated-summary"]')), 'the summary says the word times are estimated')
      await shot(win, 'summary', '[data-testid="estimated-summary"]')

      const sent = mock.requests.slice(before).filter((q) => q.route === '/audio/transcriptions')
      h.assert(sent.length === 3, `sent in 3 parts (${sent.length})`)
      h.assert(sent.every((q) => q.fields.model === 'gpt-transcribe' && q.fields.response_format === 'json' && !q.fields['timestamp_granularities[]']), `text-only requests: ${JSON.stringify(sent[0].fields)}`)

      const p = await saved(home, id, (q) => q.transcript?.segments?.length === STARTS.length, 'the captions are saved')
      p.transcript.segments.forEach((s, k) => {
        h.assert(s.text === `Word ${k}.`, `caption ${k}: ${s.text}`)
        h.assert(s.words.every((w) => w.estimated === true), `caption ${k}: every word estimated`)
        h.assert(Math.abs(s.words[0].start - STARTS[k]) < 0.6 && Math.abs(s.words[s.words.length - 1].end - (STARTS[k] + 1.2)) < 0.6, `caption ${k} on its sound: ${s.words[0].start}..${s.words[s.words.length - 1].end}`)
      })

      await transcriptTab(win)
      await win.waitForSelector('[data-testid="transcript-words"] .tw.estimated', { timeout: 10000 })
      const marked = await win.$$eval('[data-testid="transcript-words"] .tw', (els) => els.map((e) => [e.classList.contains('estimated'), e.title]))
      h.assert(marked.length === 14 && marked.every(([on, title]) => on && title === 'Estimated time'), `every word is marked estimated: ${JSON.stringify(marked.slice(0, 3))}`)
      h.assert(await win.isVisible('text=Words with a dotted line have estimated times.'), 'the Transcript tab says what the dotted line means')
      await shot(win, 'transcript-estimated')
    }))

    await test('transcription: Gemini speakers in the tabs, renamed everywhere in one undo step, in the files and on the video', fx.withHome('nw09-gemini', async (ctx, home) => {
      const id = seed(home, { id: 'rec-nw09-gemini', name: 'Interview', seconds: SECONDS, media: wordsVideo('words', STARTS), audio: true })
      const { app, win } = await launch(ctx, home, mock)
      const r = await api(win, 'saveAiProvider', { kind: 'gemini', label: 'Gemini', apiKey: 'AIza-e2e-gemini-key-0002' })
      h.assert(r.ok, `saved Gemini: ${r.error}`)
      await fx.openProject(win, 'Interview')
      await captionsTab(win)
      await generateWith(win, r.value.id)
      const p = await saved(home, id, (q) => q.transcript?.segments?.length === STARTS.length, 'the captions are saved', 60000)
      h.assert(p.transcript.segments.every((s, k) => s.speaker === `Speaker ${k % 2 === 0 ? 1 : 2}`), `Gemini's speakers: ${p.transcript.segments.map((s) => s.speaker)}`)
      h.assert(!(await win.$('[data-testid="estimated-summary"]')), 'Gemini word times are not called estimated')

      // The Speakers section and each caption's speaker.
      await win.waitForSelector('[data-testid="speaker-list"]')
      const names = await win.$$eval('[data-testid="speaker-list"] input', (els) => els.map((e) => e.value))
      h.assert(JSON.stringify(names) === '["Speaker 1","Speaker 2"]', `speakers listed: ${names}`)
      const rowSpeaker = await win.$eval(`[data-caption-row="${p.transcript.segments[1].id}"] select.caption-speaker`, (e) => e.value)
      h.assert(rowSpeaker === 'Speaker 2', `the second caption's speaker (${rowSpeaker})`)
      await shot(win, 'speakers', '[data-testid="speaker-list"]')
      await shot(win, 'caption-rows', 'select.caption-speaker')

      // Renamed on Enter, everywhere at once; one undo step brings the old name back.
      const field = win.locator('input[aria-label="Name of Speaker 1"]')
      await field.fill('Priya')
      await field.press('Enter')
      await saved(home, id, (q) => q.transcript.segments.filter((s) => s.speaker === 'Priya').length === 4 && !q.transcript.segments.some((s) => s.speaker === 'Speaker 1'), 'Speaker 1 is renamed Priya on every caption')
      await win.click('.insp-tabs button:has-text("Captions")')
      await win.keyboard.press('Control+z')
      await saved(home, id, (q) => q.transcript.segments.filter((s) => s.speaker === 'Speaker 1').length === 4, 'one undo brings Speaker 1 back')
      await win.keyboard.press('Control+Shift+z')
      await saved(home, id, (q) => q.transcript.segments.filter((s) => s.speaker === 'Priya').length === 4, 'redo renames again')

      // One caption's speaker from its row.
      const third = p.transcript.segments[2].id
      await win.selectOption(`[data-caption-row="${third}"] select.caption-speaker`, 'Speaker 2')
      await saved(home, id, (q) => q.transcript.segments[2].speaker === 'Speaker 2', 'a caption gets another speaker from its row')
      await win.keyboard.press('Control+z')
      await saved(home, id, (q) => q.transcript.segments[2].speaker === 'Priya', 'and undo puts it back')

      // The Transcript tab names the speaker where it changes.
      await transcriptTab(win)
      await win.waitForSelector('[data-testid="transcript-speaker"]')
      const shown = await win.$$eval('[data-testid="transcript-speaker"]', (els) => els.map((e) => e.textContent))
      h.assert(JSON.stringify(shown) === JSON.stringify(STARTS.map((_, k) => (k % 2 === 0 ? 'Priya' : 'Speaker 2'))), `the Transcript tab names the speakers: ${shown}`)
      await shot(win, 'transcript-speakers')

      // WebVTT voice tags always; SRT names only when asked.
      await captionsTab(win)
      const vtt = path.join(home, 'speakers.vtt')
      await h.mockSaveDialog(app, vtt)
      await win.click('.chips[aria-label="Subtitle format"] .chip:has-text("VTT")')
      await win.click('button:has-text("Export captions…")')
      await f.waitFor(() => fs.existsSync(vtt), 'the VTT file is written')
      const vttText = fs.readFileSync(vtt, 'utf8')
      h.assert(/\n<v Priya>Word 0\n/.test(vttText) && /\n<v Speaker 2>Word 1\n/.test(vttText), `VTT voice tags:\n${vttText.slice(0, 200)}`)
      const srt = path.join(home, 'speakers.srt')
      await h.mockSaveDialog(app, srt)
      await win.click('.chips[aria-label="Subtitle format"] .chip:has-text("SRT")')
      await win.click('button:has-text("Export captions…")')
      await f.waitFor(() => fs.existsSync(srt), 'the SRT file is written')
      h.assert(!/Priya/.test(fs.readFileSync(srt, 'utf8')), 'no names in the SRT by default')
      fs.rmSync(srt)
      await win.locator('label', { hasText: 'Speaker names in SRT and text' }).click()
      await h.mockSaveDialog(app, srt)
      await win.click('button:has-text("Export captions…")')
      await f.waitFor(() => fs.existsSync(srt), 'the SRT file is written again')
      h.assert(/\nPriya: Word 0\n/.test(fs.readFileSync(srt, 'utf8')), `names in the SRT when asked:\n${fs.readFileSync(srt, 'utf8').slice(0, 120)}`)

      // Show speaker names on the video: off by default; on, the caption is wider in the export.
      h.assert(!h.readProject(home, id).captions?.showSpeaker, 'speaker names are not drawn by default')
      const out = (name) => path.join(home, `${name}.mp4`)
      const whiteSpan = async (file) => {
        const { width, height, frames } = fx.framesAt(file, [Math.round((STARTS[0] + 0.6) * 30)], 'rgb24')
        const buf = frames[0]
        let minX = Infinity
        let maxX = -Infinity
        for (let y = Math.round(height * 0.7); y < height; y += 2) {
          for (let x = 0; x < width; x += 2) {
            const i = (y * width + x) * 3
            if (buf[i] >= 230 && buf[i + 1] >= 230 && buf[i + 2] >= 230) {
              minX = Math.min(minX, x)
              maxX = Math.max(maxX, x)
            }
          }
        }
        return maxX - minX
      }
      const exportTo = async (file) => {
        await h.mockSaveDialog(app, file)
        await fx.openExportDialog(win)
        await fx.pickChip(win, 'Format', 'MP4')
        await fx.pickChip(win, 'Resolution', '1080p')
        await fx.pickChip(win, 'Frame rate', '30 fps')
        await win.locator('.modal button.primary', { hasText: 'Export' }).click()
        const res = await fx.waitForExport(win)
        h.assert(res.ok, `export: ${res.text}`)
        await win.click('.modal button:has-text("Done")')
        await win.waitForSelector('.modal', { state: 'detached' })
      }
      await exportTo(out('plain'))
      await win.locator('label', { hasText: 'Show speaker names' }).click()
      await saved(home, id, (q) => q.captions?.showSpeaker === true, 'Show speaker names is saved')
      await exportTo(out('named'))
      const [plain, named] = [await whiteSpan(out('plain')), await whiteSpan(out('named'))]
      h.assert(named > plain + 60, `the name is drawn before the caption (${plain} px wide without, ${named} px with)`)
      if (SHOTS) {
        // Half size: the screenshot stays small.
        const png = path.join(SHOTS, 'transcription-burned-in.png')
        execFileSync(FF, ['-v', 'error', '-y', '-ss', String(STARTS[0] + 0.6), '-i', out('named'), '-frames:v', '1', '-vf', 'scale=960:-2', png])
      }
    }))

    await test('transcription: You and Others from the microphone and computer-sound tracks, with no AI', fx.withHome('nw09-stems', async (ctx, home) => {
      const mine = [1, 6.2]
      const theirs = [3.6, 8.8]
      const segs = [...mine.map((t) => ['m', t]), ...theirs.map((t) => ['o', t])]
        .sort((a, b) => a[1] - b[1])
        .map(([w, t], k) => ({ id: `c${k}`, start: t, end: t + 1.2, text: w === 'm' ? `Mine ${k}` : `Theirs ${k}` }))
      const id = seed(home, {
        id: 'rec-nw09-stems', name: 'Call', seconds: SECONDS, media: wordsVideo('call', [...mine, ...theirs].sort((a, b) => a - b)), audio: true,
        files: { 'mic.m4a': wordsAudio('call-mic', mine), 'system.m4a': wordsAudio('call-system', theirs) },
        extra: { audioStems: { mic: true, system: true }, transcript: { provider: 'openai', model: 'whisper-1', createdAt: new Date().toISOString(), language: 'en', segments: segs } }
      })
      // The tracks' levels decide: the fixture's tone bursts are not speech to the speech detector, which
      // otherwise limits the microphone to where it hears speech (unit-tested in tests/speakers.test.ts).
      const { win } = await launch(ctx, home, mock, { SSW_SPEECH_HELPER: '/nonexistent' })
      await fx.openProject(win, 'Call')
      await captionsTab(win)
      await win.waitForSelector('text=For calls, transcribe the Mixed sound')
      await win.click('button:has-text("Label You and Others")')
      const p = await saved(home, id, (q) => q.transcript.segments.every((s) => s.speaker), 'every caption gets a speaker')
      const got = p.transcript.segments.map((s) => s.speaker)
      h.assert(JSON.stringify(got) === JSON.stringify(segs.map((s) => (s.text.startsWith('Mine') ? 'You' : 'Others'))), `You and Others: ${got}`)
      await win.waitForSelector('text=Labelled 4 captions: 2 You, 2 Others.')
      await shot(win, 'you-and-others', '[data-testid="speaker-list"]')
      // Remove labels: one step, undone in one.
      await win.click('button:has-text("Remove labels")')
      await saved(home, id, (q) => !q.transcript.segments.some((s) => s.speaker), 'labels removed')
      await win.keyboard.press('Control+z')
      await saved(home, id, (q) => q.transcript.segments.every((s) => s.speaker), 'undo brings them back')
    }))

    await test('transcription: a retired model fails with a plain message after its day', fx.withHome('nw09-retired', async (ctx, home) => {
      seed(home, { id: 'rec-nw09-retired', name: 'Retired', seconds: SECONDS, media: wordsVideo('words', STARTS), audio: true })
      const { win } = await launch(ctx, home, mock, { SSW_AI_TODAY: '2027-03-01' })
      const r = await api(win, 'saveAiProvider', { kind: 'openai', label: 'Old OpenAI', apiKey: 'retired-e2e-openai-key', transcriptionModel: 'whisper-1' })
      h.assert(r.ok, `saved: ${r.error}`)
      await fx.openProject(win, 'Retired')
      await captionsTab(win)
      h.assert(!(await win.$('[data-testid="estimated-times-hint"]')), 'whisper-1 gives word times: no estimate hint')
      await generateWith(win, r.value.id)
      const alert = await win.waitForSelector('.captions-error[role="alert"]', { timeout: 60000 })
      const text = await alert.textContent()
      h.assert(/OpenAI retired whisper-1 on 26 February 2027\. Choose gpt-transcribe as the transcription model in Settings › AI providers, or make captions On this PC\./.test(text), `plain message: ${text}`)
      h.assert(!/deprecated|model_not_found|404/.test(text), 'no raw API error')
    }))
  } finally {
    await mock.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
