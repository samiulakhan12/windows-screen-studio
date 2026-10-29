// Edit by text (NW-04, NW-01, NW-06; docs/design/edit-by-text.md) in the real built app, with a
// transcript seeded into the project (no network): the Transcript tab lists the words; a click moves
// the playhead to a word; Shift+arrows select; Delete cuts the words from the video (saved clips at
// the middle of the pauses), struck through, one undo step, redo and Restore; Find fillers and
// retakes lists the retake and the filler, Keep drops a row without an edit, Remove all cuts the
// rest in one undo step; no transcript offers Make captions, which opens the Captions tab; the M4A
// export fades the sound at the cut; and opening an older project leaves project.json as it was.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const RATE = 48000
const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** A 10 s, 60 fps video with a steady 330 Hz tone (amplitude 0.5), cached. */
function toneVideo() {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, 'edit-by-text-tone.mp4')
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/\.mp4$/, '.part.mp4')
  execFileSync(FF, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000,volume=4',
    '-t', '10', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    tmp
  ])
  fs.renameSync(tmp, file)
  return file
}

const w = (text, start, end) => ({ text, start, end })
/** Words 0..4 (caption a), 5..13 (b), 14..17 (c). */
const TRANSCRIPT = {
  provider: 'local',
  model: 'test',
  createdAt: new Date().toISOString(),
  language: 'en',
  segments: [
    { id: 'a', start: 0.5, end: 2.0, text: 'So um the first thing', words: [w('So', 0.5, 0.7), w('um', 0.8, 1.0), w('the', 1.1, 1.25), w('first', 1.3, 1.6), w('thing', 1.65, 2.0)] },
    {
      id: 'b',
      start: 3.0,
      end: 5.9,
      text: 'So the first thing you do is open settings.',
      words: [w('So', 3.0, 3.2), w('the', 3.25, 3.4), w('first', 3.45, 3.7), w('thing', 3.75, 4.0), w('you', 4.1, 4.3), w('do', 4.35, 4.5), w('is', 4.55, 4.7), w('open', 4.8, 5.1), w('settings.', 5.2, 5.9)]
    },
    { id: 'c', start: 7.2, end: 8.9, text: 'Then uh click it.', words: [w('Then', 7.2, 7.5), w('uh', 7.6, 7.9), w('click', 8.0, 8.4), w('it.', 8.5, 8.9)] }
  ]
}

function seed(home, { name, transcript = TRANSCRIPT, id = `rec-${name.toLowerCase().replace(/\W+/g, '-')}` }) {
  fx.seedProject(home, { id, name, seconds: 10, width: 640, height: 360, media: toneVideo(), audio: true })
  if (transcript) {
    const file = path.join(h.projectsRoot(home), id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), transcript }, null, 2))
  }
  return id
}

async function open(ctx, home, name) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await f.openProject(win, name)
  return { app, win }
}

const transcriptTab = (win) => win.click('.insp-tabs button:has-text("Transcript")')

/** Waits until the saved project.json matches `pred`, and returns it. */
const saved = (home, id, pred, what) =>
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
    10000
  )

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol
const clipsAre = (p, list) => p.clips.length === list.length && p.clips.every((c, i) => near(c.start, list[i][0]) && near(c.end, list[i][1]))
const struck = (win) => win.$$eval('.transcript-words .tw.cut', (els) => els.map((e) => e.textContent))

async function main() {
  await test('edit by text: click to seek, Delete cuts words, undo, redo and Restore', fx.withHome('ebt-cut', async (ctx, home) => {
    const id = seed(home, { name: 'Words' })
    const { win } = await open(ctx, home, 'Words')
    await transcriptTab(win)
    await win.waitForSelector('[data-testid="transcript-words"]')
    const count = await win.$$eval('.transcript-words [role="option"]', (els) => els.length)
    h.assert(count === 18, `the transcript lists 18 words (${count})`)
    h.assert((await win.textContent('.transcript-count')).includes('18 words · 0 cut'), 'the count says nothing is cut')

    // A click selects the word and moves the playhead there: it becomes the current word.
    await win.click('#tw-12')
    await f.waitFor(() => win.$eval('#tw-12', (e) => e.classList.contains('current')), 'the clicked word is under the playhead')
    h.assert(await win.$eval('#tw-12', (e) => e.getAttribute('aria-selected') === 'true'), 'the clicked word is selected')
    await win.keyboard.press('Shift+ArrowRight')
    h.assert(await win.$eval('#tw-13', (e) => e.getAttribute('aria-selected') === 'true'), 'Shift+Right extends the selection')
    await shot(win, 'edit-by-text-selected')

    // "open settings." (4.8..5.9): the cut runs to the middle of the pauses, 4.75 and 6.4 (at most 0.5 s on).
    await win.keyboard.press('Delete')
    await saved(home, id, (p) => clipsAre(p, [[0, 4.75], [6.4, 10]]), 'Delete cuts "open settings." from the video')
    h.assert(JSON.stringify(await struck(win)) === JSON.stringify(['open', 'settings.']), 'the cut words are struck through')
    h.assert((await win.textContent('.transcript-count')).includes('2 cut'), 'the count follows')
    await shot(win, 'edit-by-text-cut')

    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => clipsAre(p, [[0, 10]]), 'one Ctrl+Z brings the words back')
    h.assert((await struck(win)).length === 0, 'nothing is struck after undo')
    await win.keyboard.press('Control+Shift+z')
    await saved(home, id, (p) => clipsAre(p, [[0, 4.75], [6.4, 10]]), 'redo cuts them again')

    // Restore with the words still selected.
    await win.click('.transcript-tools button:has-text("Restore")')
    await saved(home, id, (p) => clipsAre(p, [[0, 10]]), 'Restore brings them back')

    // The keyboard alone: Home, Shift+End selects every word; Delete refuses to cut the whole video.
    await win.focus('[data-testid="transcript-words"]')
    await win.keyboard.press('Home')
    await win.keyboard.press('Shift+End')
    const all = await win.$$eval('.transcript-words [aria-selected="true"]', (els) => els.length)
    h.assert(all === 18, `Home, Shift+End selects every word (${all})`)
    await win.keyboard.press('Escape')
    const none = await win.$$eval('.transcript-words [aria-selected="true"]', (els) => els.length)
    h.assert(none === 0, 'Esc clears the selection')
  }))

  await test('edit by text: Find fillers and retakes, Keep and Remove all in one undo step', fx.withHome('ebt-review', async (ctx, home) => {
    const id = seed(home, { name: 'Review' })
    const { win } = await open(ctx, home, 'Review')
    await transcriptTab(win)
    await win.click('[data-testid="transcript-find"]')
    await win.waitForSelector('[data-testid="transcript-review"] .review-row')
    const rows = await win.$$eval('[data-testid="transcript-review"] .review-row', (els) => els.map((e) => `${e.dataset.kind}: ${e.querySelector('strong').textContent}`))
    h.assert(JSON.stringify(rows) === JSON.stringify(['retake: So um the first thing', 'filler: uh']), `the list has the retake and the filler: ${JSON.stringify(rows)}`)
    h.assert(await win.$eval('#tw-15', (e) => e.classList.contains('suggested')), 'a suggested word is marked in the text')
    await shot(win, 'edit-by-text-review')
    const before = fs.readFileSync(path.join(h.projectsRoot(home), id, 'project.json'), 'utf8')

    // Keep: the row goes, nothing is cut.
    await win.click('.review-row[data-kind="filler"] button:has-text("Keep")')
    await f.waitFor(async () => (await win.$$('.review-row')).length === 1, 'Keep removes the row')
    await h.sleep(600)
    h.assert(h.readProject(home, id).clips.length === 1 && clipsAre(h.readProject(home, id), [[0, 10]]), 'Keep cuts nothing')
    h.assert(fs.readFileSync(path.join(h.projectsRoot(home), id, 'project.json'), 'utf8') === before, 'and saves nothing')

    // Remove all: the retake (from the start to the middle of the pause before the second take, 2.5 s).
    await win.click('[data-testid="transcript-review"] ~ .row button:has-text("Remove all")')
    await saved(home, id, (p) => clipsAre(p, [[2.5, 10]]), 'Remove all cuts the first take')
    h.assert(!(await win.$('[data-testid="transcript-review"]')), 'the list closes')
    await win.focus('[data-testid="transcript-words"]')
    await win.keyboard.press('Control+z')
    await saved(home, id, (p) => clipsAre(p, [[0, 10]]), 'one undo brings it all back')
  }))

  await test('edit by text: no transcript offers Make captions, which opens the Captions tab', fx.withHome('ebt-none', async (ctx, home) => {
    const id = seed(home, { name: 'Older', transcript: null })
    const file = path.join(h.projectsRoot(home), id, 'project.json')
    const before = fs.readFileSync(file, 'utf8')
    const { win } = await open(ctx, home, 'Older')
    await transcriptTab(win)
    await win.waitForSelector('[data-testid="transcript-make-captions"]')
    h.assert((await win.textContent('.insp-body')).includes('This video has no transcript yet. Make captions first'), 'the tab says what to do')
    await shot(win, 'edit-by-text-empty')
    await win.click('[data-testid="transcript-make-captions"]')
    await f.waitFor(async () => (await win.textContent('.insp-tabs button.active')).includes('Captions'), 'the Captions tab opens')
    await h.sleep(800)
    h.assert(fs.readFileSync(file, 'utf8') === before, 'opening an older project leaves its project.json as it was')
  }))

  await test('edit by text: the M4A export fades the sound at a cut made in the transcript', fx.withHome('ebt-fade', async (ctx, home) => {
    const id = seed(home, { name: 'Fades' })
    const { app, win } = await open(ctx, home, 'Fades')
    await transcriptTab(win)
    await win.click('#tw-12')
    await win.keyboard.press('Shift+ArrowRight')
    await win.keyboard.press('Delete')
    await saved(home, id, (p) => clipsAre(p, [[0, 4.75], [6.4, 10]]), 'the cut is saved')
    const out = path.join(home, 'fades.m4a')
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Format', 'M4A')
    await h.mockSaveDialog(app, out)
    await win.locator('.modal button.primary', { hasText: 'Export' }).click()
    const res = await fx.waitForExport(win)
    h.assert(res.ok, `export finished: ${res.text}`)
    const raw = execFileSync(FF, ['-v', 'error', '-i', out, '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
    const s = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length))
    const peak = (from, to) => {
      let m = 0
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) m = Math.max(m, Math.abs(s[i]))
      return m
    }
    const joint = 4.75
    const level = peak(2, 4)
    const atJoint = peak(joint - 0.0005, joint + 0.0005)
    console.log(`  tone ${level.toFixed(3)}, at the cut ${atJoint.toFixed(3)}, after ${peak(joint + 0.03, joint + 1).toFixed(3)}`)
    h.assert(level > 0.3, `the tone is heard (${level})`)
    // Without a fade the tone is at up to 86 % of its level within 0.5 ms of the joint, whatever its phase.
    h.assert(atJoint < level * 0.25, `the sound fades to near silence at the cut (${atJoint} of ${level})`)
    h.assert(peak(joint + 0.03, joint + 1) > level * 0.9, 'and is back at full level after it')
    h.assert(Math.abs(s.length / RATE - 8.35) < 0.05, `the export is as long as the edit (${s.length / RATE})`)
  }))
}

main()
