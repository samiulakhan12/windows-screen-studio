// Hands-off long jobs and app health in the real built app (docs/design/hands-off.md §9): the
// export bundle (SRT, VTT, chapter list, thumbnail, description) next to the video, never replacing
// a file it did not replace itself; one file per chapter with the right frames; pause and resume
// from the dialog and around a simulated sleep, with what the taskbar would show (SSW_JOBS_TRACE);
// Settings › Storage moving old recordings and caches to a stubbed Recycle Bin only after review;
// Settings › Diagnostics showing a redacted report and copying exactly it.
const fs = require('node:fs')
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

const TRACE_ENV = { SSW_JOBS_TRACE: '1', SSW_JOBS_UNFOCUSED: '1' }
const seg = (id, start, end, text) => ({ id, start, end, text })
const transcript = (segments) => ({ provider: 'openai', model: 'test-model', createdAt: new Date().toISOString(), language: 'en', segments })
const even = (v) => Math.floor(v / 2) * 2

function addItems(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

async function launch(ctx, home, env = {}) {
  const { app, win, logs } = await h.launch({ home, env: { ...TRACE_ENV, ...env } })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

async function mockFolderDialog(app, dir) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, dir)
}

const trace = (app) => app.evaluate(() => globalThis.__sswJobsTrace || [])

/** Turns on the "Also save" chips named. */
async function tickSidecars(win, kinds) {
  for (const k of kinds) {
    const chip = win.locator(`.modal [data-sidecar="${k}"]`)
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
  }
}

async function fastSettings(win) {
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', '30 fps')
}

function seedChaptered(home, id = 'rec-bundle', name = 'Demo') {
  const media = fx.indexedVideo({ seconds: 6 })
  fx.seedProject(home, { id, name, seconds: 6, media })
  addItems(home, id, {
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    chapters: [
      { id: 'k1', t: 0, title: 'Intro' },
      { id: 'k2', t: 2, title: 'Billing: part/1' },
      { id: 'k3', t: 4, title: 'End' }
    ],
    transcript: transcript([seg('s1', 0.5, 1.5, 'Hello there'), seg('s2', 2.5, 3.5, 'About billing'), seg('s3', 4.5, 5.5, 'Goodbye')]),
    captions: { show: false, preset: 'boxed', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#facc15', background: 'box', maxLines: 2 }
  })
  return id
}

const run = async () => {
  await test(
    'export bundle: SRT, VTT, chapters, thumbnail and description next to the video; notification and taskbar',
    fx.withHome('ho-bundle', async (ctx, home) => {
      seedChaptered(home)
      const out = fs.mkdtempSync(path.join(home, 'out-'))
      const { app, win } = await launch(ctx, home)
      await fx.openProject(win, 'Demo')
      await fx.openExportDialog(win)
      await fastSettings(win)
      await tickSidecars(win, ['srt', 'vtt', 'chapters', 'thumbnail', 'description'])
      await shot(win, 'hands-off-export-bundle')
      // A file of the same name as a sidecar exists: it must stay.
      fs.writeFileSync(path.join(out, 'Demo.vtt'), 'mine')
      const video = path.join(out, 'Demo.mp4')
      await h.mockSaveDialog(app, video)
      await win.locator('.modal button.primary', { hasText: 'Export' }).click()
      const r = await fx.waitForExport(win)
      h.assert(r.ok, `export finished: ${r.text}`)
      const extras = await win.textContent('[data-testid="export-extras"]')
      h.assert(/Also saved: .*Demo\.srt/.test(extras), `done view lists the extras: ${extras}`)

      const srt = fs.readFileSync(path.join(out, 'Demo.srt'), 'utf8')
      h.assert(srt.startsWith('﻿1\n00:00:00,500 --> 00:00:01,500\nHello there'), `SRT content: ${JSON.stringify(srt.slice(0, 60))}`)
      h.assert(fs.readFileSync(path.join(out, 'Demo.vtt'), 'utf8') === 'mine', 'an existing file is never replaced')
      const vtt = fs.readFileSync(path.join(out, 'Demo (2).vtt'), 'utf8')
      h.assert(vtt.startsWith('WEBVTT\n') && vtt.includes('00:00:04.500 --> 00:00:05.500\nGoodbye'), `VTT content: ${vtt}`)
      const chapters = fs.readFileSync(path.join(out, 'Demo - chapters.txt'), 'utf8')
      h.assert(chapters === '0:00 Intro\n0:02 Billing: part/1\n0:04 End\n', `chapter list: ${JSON.stringify(chapters)}`)
      const desc = fs.readFileSync(path.join(out, 'Demo - description.txt'), 'utf8')
      h.assert(desc.startsWith('Demo\n\nLength: 0:06\n\nChapters\n0:00 Intro'), `description: ${JSON.stringify(desc)}`)
      const png = fx.probe(path.join(out, 'Demo - thumbnail.png')).streams[0]
      h.assert(png.width === 1280 && png.height === 720, `thumbnail at the export size: ${png.width}x${png.height}`)
      h.assert(fs.readdirSync(out).every((f) => !f.includes('.partial-')), 'no partial files left')

      // The taskbar followed the export, the PC was kept awake and released, and the window
      // (reported unfocused) got the notification with its buttons.
      await ef.waitFor(async () => (await trace(app)).some((e) => e.call === 'notify'), 'the notification')
      const t = await trace(app)
      const progress = t.filter((e) => e.call === 'progress').map((e) => e.value)
      h.assert(progress.some((p) => p.mode === 'normal' && p.value > 0 && p.value < 1), `taskbar showed progress: ${JSON.stringify(progress.slice(0, 8))}`)
      h.assert(progress[progress.length - 1].mode === 'none', 'taskbar cleared at the end')
      const awake = t.filter((e) => e.call === 'awake').map((e) => e.value)
      h.assert(awake.includes(true) && awake[awake.length - 1] === false, `keep-awake on then off: ${awake}`)
      const buttons = t.filter((e) => e.call === 'buttons').map((e) => e.value)
      h.assert(buttons.some((b) => b.some((x) => x.action === 'pause' && x.enabled) && b.some((x) => x.action === 'stop')), `Pause and Stop offered: ${JSON.stringify(buttons)}`)
      const note = t.find((e) => e.call === 'notify' && e.value.title === 'Export finished')
      h.assert(note && /^Demo\.mp4 · /.test(note.value.body) && note.value.actions.join() === 'open,show', `notification: ${JSON.stringify(note)}`)

      // Exported again over the same file (the save dialog asked): its own sidecars are replaced, not doubled.
      await win.locator('.modal button.primary', { hasText: 'Done' }).click()
      await fx.openExportDialog(win)
      await h.mockSaveDialog(app, video)
      await win.locator('.modal button.primary', { hasText: 'Export' }).click()
      h.assert((await fx.waitForExport(win)).ok, 'second export finished')
      h.assert(!fs.existsSync(path.join(out, 'Demo (2).srt')), 'the replaced export replaces its own SRT')
      // The user chose to replace Demo.mp4: the files named after it are that export's, and are replaced too.
      h.assert(fs.readFileSync(path.join(out, 'Demo.vtt'), 'utf8').startsWith('WEBVTT\n'), 'the replaced export writes its own VTT')
      h.assert(!fs.existsSync(path.join(out, 'Demo (3).vtt')), 'and does not add another copy')

      // Main refuses a sidecar for a file this session did not export, or an unknown kind.
      const refused = await win.evaluate(async (dir) => {
        const outcomes = []
        for (const [anchor, kind] of [[`${dir}/Other.mp4`, 'srt'], [`${dir}/Demo.mp4`, '../../x']]) {
          outcomes.push(await window.api.writeSidecar(anchor, kind, 'WEBVTT\n').then(() => 'written', (e) => String(e)))
        }
        return outcomes
      }, out)
      h.assert(refused.every((o) => o !== 'written'), `refused: ${refused}`)
    })
  )

  await test(
    'one file per chapter: "01 Intro.mp4", "02 …", each with its own frames and captions',
    fx.withHome('ho-chapters', async (ctx, home) => {
      seedChaptered(home)
      const out = fs.mkdtempSync(path.join(home, 'parts-'))
      const { app, win } = await launch(ctx, home)
      await fx.openProject(win, 'Demo')
      await fx.openExportDialog(win)
      await fastSettings(win)
      await tickSidecars(win, ['srt', 'description'])
      await win.click('.modal [data-per-chapter]')
      const files = await win.textContent('[data-testid="export-part-files"]')
      h.assert(/01 Intro\.mp4/.test(files) && /02 Billing- part-1\.mp4/.test(files) && /03 End\.mp4/.test(files), `part names listed: ${files}`)
      await shot(win, 'hands-off-per-chapter')
      await mockFolderDialog(app, out)
      await win.locator('.modal button.primary', { hasText: 'Export 3 chapters' }).click()
      await ef.waitFor(async () => /Batch finished/.test((await win.textContent('.modal')) || ''), 'the chapter export', 300000)
      const text = await win.textContent('.modal')
      h.assert(/Batch finished: 3 files exported/.test(text), `all parts exported: ${text}`)
      const names = ['01 Intro.mp4', '02 Billing- part-1.mp4', '03 End.mp4']
      names.forEach((n, i) => {
        const file = path.join(out, n)
        h.assert(fs.existsSync(file), `${n} exists`)
        const v = fx.probe(file).streams.find((s) => s.codec_type === 'video')
        h.assert(Number(v.nb_frames) === 60, `${n}: 60 frames at 30 fps (got ${v.nb_frames})`)
        const codes = fx.decodeIndices(file, { x: 0, y: 0, w: even(1278), h: even(180) })
        h.assert(codes[0] === 120 * i && codes[59] === 120 * i + 118, `${n}: frames ${codes[0]}..${codes[59]} (want ${120 * i}..${120 * i + 118})`)
      })
      const srt2 = fs.readFileSync(path.join(out, '02 Billing- part-1.srt'), 'utf8')
      h.assert(srt2 === '﻿1\n00:00:00,500 --> 00:00:01,500\nAbout billing\n', `part 2 captions in its own time: ${JSON.stringify(srt2)}`)
      const desc = fs.readFileSync(path.join(out, '03 End - description.txt'), 'utf8')
      h.assert(desc.startsWith('03 End\n\nPart 3 of 3 of Demo\nLength: 0:02'), `part description: ${JSON.stringify(desc)}`)
      h.assert(!fs.readdirSync(out).some((f) => f.includes('chapters.txt')), 'a part has no chapter list')
      const t = await trace(app)
      const note = t.find((e) => e.call === 'notify')
      h.assert(note && note.value.title === '3 files exported' && note.value.actions.join() === 'show', `one notification for the batch: ${JSON.stringify(note)}`)
    })
  )

  await test(
    'pause and resume: the dialog, the taskbar state and a simulated sleep; the file is complete',
    fx.withHome('ho-pause', async (ctx, home) => {
      const media = fx.indexedVideo({ seconds: 20 })
      fx.seedProject(home, { id: 'rec-long', name: 'Long one', seconds: 20, media })
      addItems(home, 'rec-long', { effects: { motionBlur: 0.5, keystrokes: { show: false, position: 'bottom', size: 0.035 } } })
      const out = path.join(home, 'Long one.mp4')
      const { app, win } = await launch(ctx, home)
      await fx.openProject(win, 'Long one')
      await fx.openExportDialog(win)
      await fx.pickChip(win, 'Resolution', '1080p')
      await fx.pickChip(win, 'Frame rate', '60 fps')
      await fx.pickChip(win, 'Encoder', 'Software')
      await h.mockSaveDialog(app, out)
      await win.locator('.modal button.primary', { hasText: 'Export' }).click()
      await ef.waitFor(async () => /Rendering… [1-9]\d?%/.test((await win.textContent('.export-status')) || ''), 'rendering', 120000)
      await win.click('.modal button.export-pause')
      await ef.waitFor(async () => /Paused · Resume to carry on/.test((await win.textContent('.export-status')) || ''), 'paused text')
      await shot(win, 'hands-off-paused')
      const bar = async () => (await win.getAttribute('.modal .progress-bar', 'style')) || ''
      const before = await bar()
      await h.sleep(1500)
      h.assert((await bar()) === before, 'no frames are rendered while paused')
      const t1 = await trace(app)
      const last = t1.filter((e) => e.call === 'progress').pop()
      h.assert(last.value.mode === 'paused', `taskbar shows paused: ${JSON.stringify(last)}`)
      const lastButtons = t1.filter((e) => e.call === 'buttons').pop().value
      h.assert(lastButtons.some((b) => b.action === 'resume'), `thumbnail offers Resume: ${JSON.stringify(lastButtons)}`)
      await win.click('.modal button.export-pause')
      await ef.waitFor(async () => /Rendering/.test((await win.textContent('.export-status')) || ''), 'resumed')

      // The PC goes to sleep: the export pauses; it wakes: the export carries on by itself (after 3 s).
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'))
      await ef.waitFor(async () => /Paused while the PC slept/.test((await win.textContent('.export-status')) || ''), 'paused for sleep')
      await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
      await ef.waitFor(async () => !/Paused/.test((await win.textContent('.export-status')) || ''), 'resumed after waking', 8000)
      const r = await fx.waitForExport(win)
      h.assert(r.ok, `export finished: ${r.text}`)
      const v = fx.probe(out).streams.find((s) => s.codec_type === 'video')
      h.assert(Number(v.nb_frames) === 1200, `every frame is there after the pauses: ${v.nb_frames}`)
      const codes = fx.decodeIndices(out, { x: 0, y: 0, w: 1920, h: 270 })
      const wrong = codes.filter((c, i) => c !== i).length
      h.assert(wrong === 0, `frames in order after pausing (${wrong} wrong)`)
    })
  )

  await test(
    'storage: sizes per recording, rules reviewed before anything moves, Recycle Bin only',
    fx.withHome('ho-storage', async (ctx, home) => {
      const media = fx.solidVideo({ seconds: 2 })
      const day = 24 * 3600_000
      fx.seedProject(home, { id: 'rec-old', name: 'Old demo', seconds: 2, media })
      fx.seedProject(home, { id: 'rec-cache', name: 'Cached demo', seconds: 2, media })
      fx.seedProject(home, { id: 'rec-new', name: 'New demo', seconds: 2, media })
      const root = h.projectsRoot(home)
      addItems(home, 'rec-old', { createdAt: new Date(Date.now() - 200 * day).toISOString() })
      addItems(home, 'rec-cache', { createdAt: new Date(Date.now() - 100 * day).toISOString() })
      for (const id of ['rec-cache', 'rec-new']) {
        fs.mkdirSync(path.join(root, id, '.cache'), { recursive: true })
        fs.writeFileSync(path.join(root, id, '.cache', 'speech.json'), Buffer.alloc(3_000_000))
      }
      fs.writeFileSync(path.join(root, 'rec-old', 'music.mp3'), Buffer.alloc(5_000_000))
      for (const [id, days] of [['rec-old', 200], ['rec-cache', 120]]) {
        const old = new Date(Date.now() - days * day)
        fs.utimesSync(path.join(root, id, 'project.json'), old, old)
      }
      // An unfinished recording, also old: never part of a rule.
      fs.mkdirSync(path.join(root, 'rec-unfinished'))
      fs.writeFileSync(path.join(root, 'rec-unfinished', 'screen.webm'), Buffer.alloc(1000))
      // A link out of the projects folder is not followed.
      const outside = fs.mkdtempSync(path.join(home, 'outside-'))
      fs.writeFileSync(path.join(outside, 'big.bin'), Buffer.alloc(9_000_000))
      fs.symlinkSync(outside, path.join(root, 'rec-new', 'linked'))
      const bin = fs.mkdtempSync(path.join(home, 'bin-'))

      const { app, win } = await launch(ctx, home)
      await app.evaluate(({ shell }, target) => {
        const fsm = process.mainModule.require('node:fs')
        const p = process.mainModule.require('node:path')
        globalThis.__trashed = []
        shell.trashItem = async (file) => {
          globalThis.__trashed.push(file)
          fsm.renameSync(file, p.join(target, `${globalThis.__trashed.length}-${p.basename(file)}`))
        }
      }, bin)
      await win.click('button[aria-label="Settings"]')
      await win.waitForSelector('[data-testid="storage-total"]')
      const total = await win.textContent('[data-testid="storage-total"]')
      h.assert(/Recordings use 1[1-2] MB/.test(total), `total without what links point to: ${total}`)
      const rows = await win.locator('.storage-row').allTextContents()
      h.assert(rows[0].includes('Old demo') && rows.some((r) => r.includes('Unfinished')), `largest first, unfinished listed: ${rows}`)
      h.assert(rows.some((r) => r.includes('Cached demo') && r.includes('incl. 3 MB cache')), `cache size shown: ${rows}`)
      await win.selectOption('#storage-remove-days', '180')
      await win.click('button:has-text("Review clean-up…")')
      await win.waitForSelector('[data-testid="storage-review"]')
      await shot(win, 'hands-off-storage')
      const review = await win.textContent('[data-testid="storage-review"]')
      h.assert(/Move to the Recycle Bin \(1 recording/.test(review) && /Old demo/.test(review), `old recording offered: ${review}`)
      h.assert(/Clear caches \(1 recording/.test(review) && /Cached demo/.test(review) && !/New demo/.test(review), `only the old cache offered: ${review}`)
      h.assert(!(await app.evaluate(() => globalThis.__trashed.length)), 'nothing moves before the confirmation')
      await win.click('button:has-text("Move 2 to the Recycle Bin")')
      await win.waitForSelector('[data-testid="storage-result"]')
      const result = await win.textContent('[data-testid="storage-result"]')
      h.assert(/Moved 2 items to the Recycle Bin/.test(result), `result: ${result}`)
      const trashed = await app.evaluate(() => globalThis.__trashed)
      h.assert(trashed.length === 2 && trashed.includes(path.join(root, 'rec-old')) && trashed.includes(path.join(root, 'rec-cache', '.cache')), `trashed: ${trashed}`)
      h.assert(fs.existsSync(path.join(root, 'rec-cache', 'project.json')) && fs.existsSync(path.join(root, 'rec-new', '.cache')), 'everything else stays')
      h.assert(fs.existsSync(path.join(root, 'rec-unfinished')) && fs.existsSync(path.join(outside, 'big.bin')), 'unfinished recordings and linked folders untouched')
      // Requests outside the plan, or outside the folder, do nothing.
      const sneaky = await win.evaluate(() => window.api.storageClean([{ id: '..', action: 'remove' }, { id: 'rec-new', action: 'remove' }, { id: 'rec-unfinished', action: 'remove' }]))
      h.assert(sneaky.moved.length === 0 && (await app.evaluate(() => globalThis.__trashed.length)) === 2, `nothing else moved: ${JSON.stringify(sneaky)}`)
      const saved = JSON.parse(fs.readFileSync(path.join(home, '.config', 'Flown', 'storage.json'), 'utf8'))
      h.assert(saved.rules.removeDays === 180 && saved.rules.cacheDays === 30, `rules saved: ${JSON.stringify(saved.rules)}`)
    })
  )

  await test(
    'diagnostics: a redacted report is shown, then copied exactly; the log is kept in userData',
    fx.withHome('ho-diagnostics', async (ctx, home) => {
      fx.seedProject(home, { id: 'rec-d', name: 'Diag', seconds: 2, media: fx.solidVideo({ seconds: 2 }), capture: { method: 'native', cursorInVideo: false, region: null, target: 'window' } })
      const { app, win } = await launch(ctx, home)
      await app.evaluate((_e, dir) => console.warn(`Could not open ${dir}/Desktop/private.mp4 with key sk-proj-abcdefghijklmnopqrstuv`), home)
      await win.click('button[aria-label="Settings"]')
      await win.click('[data-testid="diagnostics"] button:has-text("Show diagnostics")')
      await win.waitForSelector('[data-testid="diagnostics-text"]', { timeout: 30000 })
      const text = await win.inputValue('[data-testid="diagnostics-text"]')
      await win.locator('[data-testid="diagnostics"]').scrollIntoViewIfNeeded()
      await shot(win, 'hands-off-diagnostics')
      h.assert(/Flown diagnostics/.test(text) && /== Capture helper/.test(text) && /Native capture: no/.test(text), `report sections: ${text.slice(0, 400)}`)
      h.assert(/native capture · window · cursor in video: no/.test(text), 'last capture method')
      h.assert(/Could not open <path> with key <secret>/.test(text), 'the log line is in it, redacted')
      h.assert(!text.includes(home) && !text.includes('sk-proj'), 'no home path and no key')
      await win.click('[data-testid="diagnostics"] button:has-text("Copy diagnostics")')
      await win.waitForSelector('[data-testid="diagnostics"] button:has-text("Copied")')
      const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
      h.assert(clip === text, 'the clipboard holds exactly the report shown')
      await h.sleep(800)
      const log = fs.readFileSync(path.join(home, '.config', 'Flown', 'logs', 'main.log'), 'utf8')
      h.assert(/INFO Flown .* starting/.test(log) && /WARN Could not open <path>/.test(log), `log kept: ${log.slice(0, 300)}`)
      h.assert(!log.includes(home) && !log.includes('sk-proj'), 'the log has no home path and no key')
    })
  )
}

run()
