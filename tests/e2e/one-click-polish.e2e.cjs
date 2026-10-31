// Polish in one click end to end (docs/design/polish-in-one-click.md §10), against the local mock
// of the AI providers (ai-mock-server.cjs): on a 12 s recording with a camera, two clicks, a zoom
// of yours and four spoken "words" with a long pause between them, Shift+P opens the dialog, and
// one Polish cuts the silences, turns auto zoom on (keeping your zoom), makes the captions,
// directs the camera and applies the Studio style. It is one undo step: one Ctrl+Z gives every
// field back, Ctrl+Shift+Z brings it all back, and the export is as long as the polished clips.
// Cancel writes nothing; Skip on the Captions row goes on without captions. A sound file ffmpeg
// cannot read skips only Remove silences, with its reason on the row while the rest goes on.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')
const fx = require('./render-fixtures.cjs')
const { startMockAi, mockAiEnv, burstAudioArgs } = require('./ai-mock-server.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
/** Screenshots of the dialog's views when set to a folder. */
const SHOTS = process.env.SSW_E2E_SHOTS || null
const SECONDS = 12
/** "Word k" bursts of 1.2 s: talking 0.5-3.2 s and 8.0-10.7 s, a 4.8 s pause between. */
const STARTS = [0.5, 2.0, 8.0, 9.5]
const NAME = 'Polish me'
const ZM = { id: 'zm', start: 10.9, end: 11.7, scale: 1.5, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }
/** The fields polish writes (design §3): one undo gives every one of them back. */
const FIELDS = ['clips', 'zooms', 'autoZoom', 'zoomSettings', 'layouts', 'director', 'webcam', 'transcript', 'captions', 'style', 'cursor', 'tilt']

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** The 640x360 30 fps test pattern with the "Word k" bursts as its sound (cached). */
function wordsVideo() {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, `polish-words-${SECONDS}s-640x360-30.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/\.mp4$/, '.part.mp4')
  execFileSync(FF, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', ...burstAudioArgs(STARTS, SECONDS),
    '-t', String(SECONDS), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    tmp
  ])
  fs.renameSync(tmp, file)
  return file
}

/** The sound of wordsVideo alone, as a microphone stem (cached). */
function wordsAudio() {
  const file = path.join(fx.MEDIA_CACHE, `polish-words-${SECONDS}s.m4a`)
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/\.m4a$/, '.part.m4a')
  execFileSync(FF, ['-v', 'error', '-y', '-i', wordsVideo(), '-vn', '-c:a', 'copy', tmp])
  fs.renameSync(tmp, file)
  return file
}

/** The recording: a camera, left clicks at 2.2 and 8.6 s, your zoom `zm`, auto zoom off, the director without face framing. */
function seed(home) {
  const id = f.seedProject(home, {
    id: 'rec-polish',
    name: NAME,
    seconds: SECONDS,
    width: 640,
    height: 360,
    fps: 30,
    audio: true,
    webcam: true,
    capture: { method: 'chromium', cursorInVideo: false, region: null },
    clicks: [
      { t: 2.2, x: 0.3, y: 0.4, button: 'left' },
      { t: 8.6, x: 0.7, y: 0.6, button: 'left' }
    ],
    zooms: [ZM]
  })
  const dir = path.join(h.projectsRoot(home), id)
  fs.unlinkSync(path.join(dir, 'screen.mp4'))
  fs.symlinkSync(wordsVideo(), path.join(dir, 'screen.mp4'))
  const file = path.join(dir, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  // No zoomSettings are seeded, so autoZoom decides: polish turns auto zoom on. frameFace off: no WebGL face pass.
  p.autoZoom = false
  p.director = { intro: 'camera-only', corners: 'auto', hideAfter: 10, frameFace: false }
  fs.writeFileSync(file, JSON.stringify(p, null, 2))
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

/** Launches against the mock with one OpenAI provider whose key is `apiKey`, and opens the recording. */
async function open(ctx, home, mock, apiKey) {
  const { app, win, logs } = await h.launch({ home, env: mockAiEnv(mock.url) })
  ctx.app = app
  ctx.logs = logs
  // Xvfb has no keyring: the test turns on Chromium's basic store from outside (as ai.e2e.cjs does).
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  await win.waitForSelector('.home', { timeout: 30000 })
  // whisper-1: the captions' exact text and times are checked (gpt-transcribe's estimated times: transcription.e2e.cjs).
  const saved = await api(win, 'saveAiProvider', { kind: 'openai', label: 'OpenAI', apiKey, transcriptionModel: 'whisper-1' })
  h.assert(saved.ok, `provider saved: ${saved.error}`)
  await f.openProject(win, NAME)
  return { app, win }
}

const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
/** project.json once `pred` holds for it. */
const savedWhen = (home, id, pred, what) => f.waitFor(() => (pred(h.readProject(home, id)) ? h.readProject(home, id) : null), what, 15000)
const outLength = (clips) => clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0)
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const dialog = (win) => win.locator('.polish-dialog[role="dialog"]')
const row = (win, step) => win.locator(`[data-testid="polish-row-${step}"]`)
const line = (win, step) => win.locator(`[data-testid="polish-line-${step}"]`)
const checked = (win, step) => row(win, step).locator('input[type="checkbox"]').isChecked()

/** Opens the dialog with Shift+P (focus outside text fields) and waits for its options. */
async function openDialog(win) {
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await win.keyboard.press('Shift+P')
  await dialog(win).waitFor({ timeout: 10000 })
  await win.waitForSelector('.polish-dialog .modal-foot button.primary:not([disabled])', { timeout: 10000 })
}

async function main() {
  const mock = await startMockAi({ ffmpeg: FF })
  try {
    await test('polish applies everything in one undo step, and the export matches', fx.withHome('polish-one', async (ctx, home) => {
      const id = seed(home)
      const { app, win } = await open(ctx, home, mock, 'sk-e2e-polish-0001')
      // A saved, migrated project to compare with (renaming is its own undo step, before the polish).
      await win.fill('input[aria-label="Recording name"]', `${NAME}!`)
      await win.keyboard.press('Enter')
      const before = await savedWhen(home, id, (p) => p.name === `${NAME}!`, 'the renamed project saved')

      await openDialog(win)
      for (const step of ['silences', 'zoom', 'captions', 'director']) h.assert(await checked(win, step), `${step} is checked`)
      h.assert((await row(win, 'captions').textContent()).includes('The sound is sent to OpenAI'), 'captions hint names the provider')
      await win.selectOption('select[aria-label="Style preset"]', 'studio')
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'polish-options.png') })
      await win.click('.polish-dialog .modal-foot button.primary:has-text("Polish")')
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'polish-running.png') })
      await win.waitForSelector('[data-testid="polish-summary"]', { timeout: 60000 })
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'polish-summary.png') })
      const status = async (step) => line(win, step).getAttribute('data-status')
      const lines = await win.$$eval('[data-testid^="polish-line-"]', (els) => els.map((e) => `${e.dataset.status}: ${e.textContent}`))
      console.log(`summary: ${await win.textContent('.polish-headline')} | ${lines.join(' | ')}`)
      for (const step of ['style', 'silences', 'zoom', 'captions']) h.assert((await status(step)) === 'changed', `${step} changed: ${lines}`)
      h.assert(['changed', 'unchanged'].includes(await status('director')), `director ran: ${lines}`)
      h.assert(/^Polished: the video is \d\.\d s shorter$/.test(await win.textContent('.polish-headline')), 'headline says how much shorter')

      const p = await savedWhen(home, id, (q) => !!q.transcript, 'the polish saved')
      const shorter = SECONDS - outLength(p.clips)
      console.log(`clips ${JSON.stringify(p.clips.map((c) => [c.start, c.end, c.speed]))}, ${shorter.toFixed(2)} s shorter`)
      h.assert(p.clips.length >= 2, 'the pause is cut')
      h.assert(shorter > 4.3 && shorter < 6.4, `4.3-6.4 s shorter (about 5.35: 3.45-7.75 and the tail from 10.95): ${shorter}`)
      h.assert(same(p.zooms.find((z) => z.id === 'zm'), ZM), 'your zoom is kept as it was')
      const auto = p.zooms.filter((z) => z.auto)
      for (const t of [2.2, 8.6]) h.assert(auto.some((z) => z.start <= t && z.end >= t), `an automatic zoom covers the click at ${t}: ${JSON.stringify(auto)}`)
      h.assert(!auto.some((z) => z.start < ZM.end && z.end > ZM.start), 'no automatic zoom over yours')
      h.assert(p.autoZoom === true, 'auto zoom on')
      h.assert(same(p.transcript.segments.map((s) => s.text), ['Word 0', 'Word 1', 'Word 2', 'Word 3']), `captions: ${JSON.stringify(p.transcript.segments.map((s) => s.text))}`)
      h.assert(p.captions.show === true, 'captions shown')
      h.assert(same(p.style.background, { type: 'wallpaper', id: 'violet-mesh' }), `Studio background: ${JSON.stringify(p.style.background)}`)
      h.assert(p.style.aspectRatio === 'auto', 'the aspect ratio stays')
      h.assert(p.director && p.director.frameFace === false && p.director.hideAfter === 10, `the Camera tab options are used: ${JSON.stringify(p.director)}`)

      // Done, then one undo gives every field back.
      await win.click('.polish-dialog .modal-foot button:has-text("Done")')
      await win.waitForSelector('.notice:has-text("Polished:")', { timeout: 5000 })
      await dialog(win).waitFor({ state: 'detached' })
      await win.keyboard.press('Control+z')
      const undone = await savedWhen(home, id, (q) => !q.transcript, 'the undo saved')
      for (const k of FIELDS) h.assert(same(undone[k], before[k]), `undo gives back ${k}: ${JSON.stringify(undone[k])} vs ${JSON.stringify(before[k])}`)
      h.assert(undone.name === `${NAME}!`, 'only the polish was undone')

      // Redo brings the whole polish back; the export is as long as its clips.
      await win.keyboard.press('Control+Shift+z')
      const redone = await savedWhen(home, id, (q) => !!q.transcript, 'the redo saved')
      for (const k of FIELDS) h.assert(same(redone[k], p[k]), `redo brings back ${k}`)
      await waitSaved(win)
      const out = path.join(home, 'polished.mp4')
      await h.mockSaveDialog(app, out)
      await fx.openExportDialog(win)
      await fx.pickChip(win, 'Format', 'MP4')
      await fx.pickChip(win, 'Frame rate', '30 fps')
      await win.locator('.modal button.primary', { hasText: 'Export' }).click()
      const r = await fx.waitForExport(win)
      h.assert(r.ok, `export: ${r.text}`)
      const duration = f.ffprobeDuration(out)
      const frames = f.ffprobeFrames(out)
      const want = fx.exportFrameTimes(redone.clips, 30).length
      console.log(`export: ${duration.toFixed(3)} s, ${frames} frames (clips ${outLength(redone.clips).toFixed(3)} s, ${want} frames)`)
      h.assert(Math.abs(duration - outLength(redone.clips)) < 0.1, `export length ${duration} = polished clips ${outLength(redone.clips)}`)
      h.assert(Math.abs(frames - want) <= 1, `frames ${frames} = ${want}`)
    }))

    await test('cancel writes nothing; skipping the captions goes on without them', fx.withHome('polish-cancel', async (ctx, home) => {
      const id = seed(home)
      const { win } = await open(ctx, home, mock, 'slow-e2e-0001')
      await waitSaved(win)
      const before = fs.readFileSync(path.join(h.projectsRoot(home), id, 'project.json'), 'utf8')

      // Cancel while the slow provider transcribes.
      await openDialog(win)
      await win.click('.polish-dialog .modal-foot button.primary:has-text("Polish")')
      await f.waitFor(async () => /Sending the sound|Transcribing/.test((await row(win, 'captions').textContent().catch(() => '')) || ''), 'the transcription running', 30000)
      await win.click('.polish-dialog .modal-foot button:has-text("Cancel")')
      await win.waitForSelector('.notice:has-text("Polish cancelled: nothing was changed")', { timeout: 5000 })
      await dialog(win).waitFor({ state: 'detached' })
      await h.sleep(1500)
      h.assert(fs.readFileSync(path.join(h.projectsRoot(home), id, 'project.json'), 'utf8') === before, 'nothing was written')

      // The cancelled job shows as busy until the main process lets go of it.
      await win.click('[data-testid="polish-open"]')
      await dialog(win).waitFor({ timeout: 10000 })
      await win.waitForSelector('[data-testid="polish-row-captions"][data-available="true"]', { timeout: 20000 })
      h.assert(await checked(win, 'captions'), 'captions checked again once the job is gone')
      await win.click('.polish-dialog .modal-foot button.primary:has-text("Polish")')
      const skip = row(win, 'captions').locator('button:has-text("Skip")')
      await f.waitFor(async () => /Sending the sound|Transcribing/.test((await row(win, 'captions').textContent().catch(() => '')) || ''), 'the transcription running again', 30000)
      await skip.click()
      await win.waitForSelector('[data-testid="polish-summary"]', { timeout: 30000 })
      h.assert((await line(win, 'captions').textContent()) === 'Captions: skipped', `captions skipped: ${await line(win, 'captions').textContent()}`)
      h.assert((await line(win, 'silences').getAttribute('data-status')) === 'changed', 'the silences are still cut')
      await win.click('.polish-dialog .modal-foot button:has-text("Done")')
      const p = await savedWhen(home, id, (q) => q.clips.length >= 2, 'the polish without captions saved')
      h.assert(!p.transcript, 'no captions')
    }))

    await test('a sound that cannot be measured skips only the silences', fx.withHome('polish-unmeasured', async (ctx, home) => {
      const id = seed(home)
      // Stems: a microphone ffmpeg can read, and a system sound file it cannot (a copy cut short).
      const dir = path.join(h.projectsRoot(home), id)
      fs.symlinkSync(wordsAudio(), path.join(dir, 'mic.m4a'))
      fs.writeFileSync(path.join(dir, 'system.m4a'), 'not a sound file')
      const file = path.join(dir, 'project.json')
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), audioStems: { mic: true, system: true } }, null, 2))
      const { win } = await open(ctx, home, mock, 'slow-e2e-0002')
      await waitSaved(win)
      const before = h.readProject(home, id)

      await openDialog(win)
      await win.selectOption('select[aria-label="Style preset"]', 'studio')
      await win.click('.polish-dialog .modal-foot button.primary:has-text("Polish")')
      // The row gives the reason while the transcription goes on.
      await f.waitFor(async () => (await row(win, 'silences').getAttribute('data-phase').catch(() => null)) === 'skipped', 'the silences skipped', 30000)
      const said = await row(win, 'silences').textContent()
      h.assert(said.includes('The sound could not be measured, so nothing was cut'), `the silences row says why: ${said}`)
      await f.waitFor(async () => /Sending the sound|Transcribing/.test((await row(win, 'captions').textContent().catch(() => '')) || ''), 'the transcription running', 30000)
      h.assert((await dialog(win).getAttribute('data-view')) === 'running', 'the run goes on')
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'polish-unmeasured.png') })
      await row(win, 'captions').locator('button:has-text("Skip")').click()
      await win.waitForSelector('[data-testid="polish-summary"]', { timeout: 30000 })
      const lines = await win.$$eval('[data-testid^="polish-line-"]', (els) => els.map((e) => `${e.dataset.status}: ${e.textContent}`))
      h.assert((await line(win, 'silences').getAttribute('data-status')) === 'skipped', `silences skipped: ${lines}`)
      h.assert((await line(win, 'silences').textContent()).includes('the sound could not be measured'), `the summary says why: ${lines}`)
      for (const step of ['style', 'zoom']) h.assert((await line(win, step).getAttribute('data-status')) === 'changed', `${step} changed: ${lines}`)
      await win.click('.polish-dialog .modal-foot button:has-text("Done")')
      const p = await savedWhen(home, id, (q) => q.autoZoom === true, 'the polish saved')
      h.assert(same(p.clips, before.clips), `nothing was cut: ${JSON.stringify(p.clips)}`)
      h.assert(same(p.style.background, { type: 'wallpaper', id: 'violet-mesh' }), `Studio background: ${JSON.stringify(p.style.background)}`)
      h.assert(!p.transcript, 'no captions')
    }))
  } finally {
    await mock.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
