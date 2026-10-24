// Export pipeline in the real built app: frame accuracy, cuts/speed with A/V sync,
// colours, cancel/failure handling, bounded-memory GIFs and copy-to-clipboard.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })

/** Opens the export dialog, applies `opts` and starts the export to `out`. */
async function startExport(app, win, out, opts = {}) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  if (opts.format) await fx.pickChip(win, 'Format', opts.format)
  if (opts.res) await fx.pickChip(win, 'Resolution', opts.res)
  if (opts.fps) await fx.pickChip(win, 'Frame rate', opts.fps)
  if (opts.quality) await fx.pickChip(win, 'Quality', opts.quality)
  if (opts.encoder) await fx.pickChip(win, 'Encoder', opts.encoder)
  if (opts.beforeStart) await opts.beforeStart()
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
}

async function exportTo(app, win, out, opts) {
  await startExport(app, win, out, opts)
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export finished: ${r.text}`)
  return r
}

async function closeDialog(win) {
  const back = win.locator('.modal button', { hasText: /^Back$/ })
  if (await back.count()) await back.click()
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/**
 * Records about `seconds` of the screen with the app's own recorder. Under Xvfb the
 * capture source is sometimes missing when recording starts, so it retries.
 */
async function recordClip(app, win, seconds) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await h.waitForSources(win)
    await win.click('button.record')
    const t0 = Date.now()
    while (Date.now() - t0 < 15000 && !h.toolbarOf(app)) await h.sleep(250)
    const toolbar = h.toolbarOf(app)
    if (toolbar) {
      await h.sleep(seconds * 1000)
      await toolbar.click('button.stop')
      return
    }
    console.log(`  recording did not start (attempt ${attempt}), retrying`)
    const refresh = await win.$('button[title="Refresh"]')
    if (refresh) await refresh.click()
    await h.sleep(1500)
  }
  throw new Error('Could not start a recording')
}

/** Frame codes of an export whose content is the indexed source at 1:1 (no padding). */
function codes(file, width, height) {
  return fx.decodeIndices(file, { x: 0, y: 0, w: width, h: Math.floor(height / 4) })
}

function expectCodes(got, times, label) {
  const want = times.map((t) => Math.round(t * 60))
  h.assert(got.length === want.length, `${label}: ${got.length} frames, expected ${want.length}`)
  const wrong = got.map((c, i) => (c === want[i] ? null : `#${i}: ${c} != ${want[i]}`)).filter(Boolean)
  h.assert(wrong.length === 0, `${label}: ${wrong.length} frames show the wrong source frame (${wrong.slice(0, 8).join(', ')})`)
}

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

async function main() {
  await test('export: every frame shows the right source frame (60/30 fps, decoder and seek fallback)', fx.withHome('export-frames', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: 1280, height: 720 })
    fx.seedProject(home, { name: 'Frames', media, seconds: 4 })
    for (const decoder of ['webcodecs', 'element']) {
      const { app, win, logs } = await h.launch({ home, env: { SSW_EXPORT_DECODER: decoder } })
      ctx.app = app
      ctx.logs = logs
      await fx.openProject(win, 'Frames')
      for (const fps of decoder === 'webcodecs' ? [60, 30] : [60]) {
        const out = path.join(home, `frames-${decoder}-${fps}.mp4`)
        await exportTo(app, win, out, { res: '720p', fps: `${fps} fps` })
        await closeDialog(win)
        expectCodes(codes(out, 1280, 720), fx.exportFrameTimes([{ start: 0, end: 4, speed: 1 }], fps), `${decoder} ${fps} fps`)
      }
      await app.close()
      ctx.app = null
    }
  }))

  await test('export: a cut and a 2x clip keep audio and video in sync', fx.withHome('export-sync', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 8, width: 1280, height: 720, beeps: true })
    const clips = [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 4, end: 8, speed: 2 }
    ]
    fx.seedProject(home, { name: 'Sync', media, seconds: 8, audio: true, clips })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Sync')
    const out = path.join(home, 'sync.mp4')
    await exportTo(app, win, out, { res: '720p', fps: '60 fps' })
    const info = fx.probe(out)
    const video = info.streams.find((s) => s.codec_type === 'video')
    const audio = info.streams.find((s) => s.codec_type === 'audio')
    h.assert(Number(video.nb_frames) === 240, `240 video frames (got ${video.nb_frames})`)
    h.assert(Math.abs(Number(audio.duration) - 4) < 0.03, `audio is 4 s (got ${audio.duration})`)
    const times = fx.exportFrameTimes(clips, 60)
    const frameCodes = codes(out, 1280, 720)
    expectCodes(frameCodes, times, 'cut + 2x')
    // Every beep starts within ~1 frame of the video frame showing its source second.
    const { onsets } = fx.beepOnsets(out)
    const want = [0, 1, 2, 2.5, 3, 3.5]
    h.assert(onsets.length === want.length, `beeps at ${onsets.map((t) => t.toFixed(3))}`)
    onsets.forEach((t, i) => {
      const frame = frameCodes.findIndex((c) => c >= Math.round([0, 1, 4, 5, 6, 7][i] * 60))
      h.assert(Math.abs(t - want[i]) < 0.03, `beep ${i} at ${t.toFixed(3)} s, expected ${want[i]}`)
      h.assert(Math.abs(frame / 60 - t) < 0.03, `beep ${i}: audio ${t.toFixed(3)} s vs video ${(frame / 60).toFixed(3)} s`)
    })
    console.log(`  beeps at ${onsets.map((t) => t.toFixed(3)).join(', ')} s; 240 frames, audio ${Number(audio.duration).toFixed(3)} s`)
  }))

  await test('export: a project recorded by the app, edited with a cut and a 2x clip', fx.withHome('export-recorded', async (ctx, home) => {
    let { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await recordClip(app, win, 7)
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    await h.sleep(1500)
    await app.close()
    const [id] = h.listProjects(home)
    const file = path.join(h.projectsRoot(home), id, 'project.json')
    const project = JSON.parse(fs.readFileSync(file, 'utf8'))
    const d = project.duration
    project.clips = [
      { id: 'a', start: 0, end: 1.5, speed: 1 },
      { id: 'b', start: 2.5, end: d, speed: 2 }
    ]
    fs.writeFileSync(file, JSON.stringify(project, null, 2))
    ;({ app, win, logs } = await h.launch({ home }))
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, project.name)
    const out = path.join(home, 'recorded.mp4')
    await exportTo(app, win, out, { res: '720p', fps: '60 fps' })
    const frames = fx.exportFrameTimes(project.clips, 60).length
    const info = fx.probe(out)
    const video = info.streams.find((s) => s.codec_type === 'video')
    h.assert(Number(video.nb_frames) === frames, `${frames} frames (got ${video.nb_frames})`)
    h.assert(Math.abs(Number(info.format.duration) - frames / 60) < 0.05, `duration ${info.format.duration} vs ${frames / 60}`)
    const audio = info.streams.find((s) => s.codec_type === 'audio')
    if (project.hasAudio) h.assert(audio && Math.abs(Number(audio.duration) - frames / 60) < 0.03, 'audio as long as the video')
    console.log(`  recorded ${d.toFixed(2)} s -> exported ${frames} frames (${(frames / 60).toFixed(3)} s), audio: ${project.hasAudio}`)
  }))

  await test('export: colours match the canvas (x264 and WebCodecs)', fx.withHome('export-colours', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 2, width: 1280, height: 720 })
    const id = fx.seedProject(home, {
      name: 'Colours',
      media,
      seconds: 2,
      style: { background: { type: 'image', path: 'background.png' }, padding: 0.25, cornerRadius: 0, shadow: 0, aspectRatio: '16:9' }
    })
    const colors = ['22c55e', 'db2777', '5b21b6', 'f59e0b', '0ea5e9', 'ffffff', '808080', '000000']
    const bars = colors.map((c) => ['-f', 'lavfi', '-i', `color=c=0x${c}:s=240x1080`]).flat()
    execFileSync('ffmpeg', ['-v', 'error', ...bars, '-filter_complex', 'hstack=inputs=8', '-frames:v', '1', path.join(h.projectsRoot(home), id, 'background.png')])
    for (const venc of ['ffmpeg', 'webcodecs-software']) {
      const { app, win, logs } = await h.launch({ home, env: { SSW_EXPORT_VIDEO_ENCODER: venc } })
      ctx.app = app
      ctx.logs = logs
      await fx.openProject(win, 'Colours')
      const out = path.join(home, `colours-${venc}.mp4`)
      await exportTo(app, win, out, { res: '1080p' })
      // Decode the way Chrome/Edge/Slack previews do: Chromium's own video pipeline.
      const pixels = await app.evaluate(async ({ BrowserWindow }, file) => {
        const w = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } })
        await w.loadURL('about:blank')
        const res = await w.webContents.executeJavaScript(`(async () => {
          const v = document.createElement('video')
          v.muted = true
          v.src = ${JSON.stringify('file://' + file)}
          await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('load failed')) })
          v.currentTime = 0.5
          await new Promise((r) => (v.onseeked = r))
          const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight
          const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0)
          return Array.from({ length: 8 }, (_, k) => Array.from(ctx.getImageData(240 * k + 120, 60, 1, 1).data.slice(0, 3)))
        })()`)
        w.destroy()
        return res
      }, out)
      const tags = fx.probe(out).streams.find((s) => s.codec_type === 'video')
      const worst = Math.max(...pixels.map((p, k) => Math.max(...p.map((v, j) => Math.abs(v - parseInt(colors[k].slice(j * 2, j * 2 + 2), 16))))))
      console.log(`  ${venc}: ${tags.color_space}/${tags.color_primaries}/${tags.color_transfer}/${tags.color_range}, worst channel error ${worst}: ${pixels.map((p) => p.map((v) => v.toString(16).padStart(2, '0')).join('')).join(' ')}`)
      h.assert(tags.color_space === 'smpte170m' && tags.color_primaries === 'bt709' && tags.color_transfer === 'bt709' && tags.color_range === 'tv', 'fully tagged')
      h.assert(worst <= 4, `${venc}: colours off by up to ${worst} levels`)
      await app.close()
      ctx.app = null
    }
  }))

  await test('export: cancel keeps the existing file, leaves nothing behind; failures are readable', fx.withHome('export-cancel', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 10, width: 1920, height: 1080 })
    fx.seedProject(home, { name: 'Cancel', media, seconds: 10, width: 1920, height: 1080 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Cancel')
    const dir = path.join(home, 'out')
    fs.mkdirSync(dir)
    const existing = path.join(dir, 'existing.mp4')
    fs.writeFileSync(existing, 'ORIGINAL')
    for (const target of [existing, path.join(dir, 'fresh.mp4')]) {
      await startExport(app, win, target, { res: '1080p', fps: '60 fps', encoder: 'Software' })
      await win.waitForSelector('.modal .export-status:has-text("Rendering")', { timeout: 60000 })
      await h.sleep(1500)
      await shot(win, 'export-running')
      // Escape never cancels a running export; only the Cancel button does.
      await win.keyboard.press('Escape')
      await h.sleep(300)
      h.assert(await win.isVisible('.modal .export-status'), 'Escape leaves a running export alone')
      await win.click('.modal button:has-text("Cancel export")')
      await win.waitForSelector('.modal button.primary:has-text("Export MP4")', { timeout: 30000 })
      await h.sleep(500)
      h.assert(fx.partialFiles(target).length === 0, `no partial files: ${fx.partialFiles(target)}`)
      await closeDialog(win)
    }
    h.assert(fs.readFileSync(existing, 'utf8') === 'ORIGINAL', 'the existing file is untouched')
    h.assert(!fs.existsSync(path.join(dir, 'fresh.mp4')), 'no file at a fresh target')

    // An unwritable destination fails with a readable message (and nothing is created).
    await startExport(app, win, path.join(home, 'no-such-folder', 'x.mp4'))
    const r = await fx.waitForExport(win)
    h.assert(!r.ok && /Could not write to the folder/.test(r.text), `readable error: ${r.text}`)
    await shot(win, 'export-error')
    await closeDialog(win)
  }))

  await test('export: a renderer crash stops ffmpeg and deletes the partial file; a killed app is cleaned up at the next start', fx.withHome('export-crash', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 10, width: 1920, height: 1080 })
    fx.seedProject(home, { name: 'Crash', media, seconds: 10, width: 1920, height: 1080 })
    const dir = path.join(home, 'out')
    fs.mkdirSync(dir)
    const target = path.join(dir, 'crash.mp4')
    /** Launches, opens the project and starts a long software export into `target`; resolves while it renders. */
    const exporting = async () => {
      const { app, win, logs } = await h.launch({ home })
      ctx.app = app
      ctx.logs = logs
      await fx.openProject(win, 'Crash')
      await startExport(app, win, target, { res: '1080p', fps: '60 fps', encoder: 'Software' })
      await win.waitForSelector('.modal .export-status:has-text("Rendering")', { timeout: 60000 })
      await h.sleep(1000)
      const pid = app.process().pid
      h.assert(fx.ffmpegChildren(pid).length === 1, 'ffmpeg is encoding')
      h.assert(fx.partialFiles(target).length === 1, 'the partial file exists while rendering')
      return { app, pid }
    }

    // 1. The editor's renderer crashes mid-export (audit-A-3).
    const first = await exporting()
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    const t0 = Date.now()
    while (Date.now() - t0 < 15000 && (fx.ffmpegChildren(first.pid).length || fx.partialFiles(target).length)) await h.sleep(200)
    h.assert(fx.ffmpegChildren(first.pid).length === 0, 'ffmpeg was stopped')
    h.assert(fx.partialFiles(target).length === 0, `partial file deleted: ${fx.partialFiles(target)}`)
    console.log(`  renderer crash: ffmpeg stopped and the partial file deleted after ${Date.now() - t0} ms`)
    await first.app.close()
    ctx.app = null

    // 2. The whole app is killed mid-export: the next start deletes what it left (audit-B-1).
    const second = await exporting()
    second.app.process().kill('SIGKILL')
    ctx.app = null
    const t1 = Date.now()
    while (Date.now() - t1 < 15000 && fx.ffmpegChildren(second.pid).length) await h.sleep(200)
    const left = fx.partialFiles(target)
    h.assert(left.length === 1, `the killed app left its partial file (${left})`)
    const { app, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const t2 = Date.now()
    while (Date.now() - t2 < 10000 && fx.partialFiles(target).length) await h.sleep(200)
    h.assert(fx.partialFiles(target).length === 0, `leftover deleted at start-up: ${fx.partialFiles(target)}`)
    h.assert(!fs.existsSync(target), 'no file at the target')
  }))

  await test('export: a very wide Area exports at 4096 px instead of failing (auto aspect)', fx.withHome('export-wide', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 2, width: 1920, height: 200 })
    fx.seedProject(home, { name: 'Strip', media, seconds: 2, width: 1920, height: 200 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Strip')
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Resolution', '1080p')
    const summary = await win.textContent('.modal .export-size')
    h.assert(summary.includes('4096×426'), `the dialog shows the real size: ${summary}`)
    h.assert(await win.isVisible('.modal .export-capped'), 'the dialog says why')
    await shot(win, 'export-wide-capped')
    await closeDialog(win)
    const out = path.join(home, 'strip.mp4')
    await exportTo(app, win, out, { res: '1080p', fps: '60 fps' })
    const video = fx.probe(out).streams.find((s) => s.codec_type === 'video')
    h.assert(video.width === 4096 && video.height === 426, `4096x426 (got ${video.width}x${video.height})`)
    expectCodes(codes(out, 4096, 426), fx.exportFrameTimes([{ start: 0, end: 2, speed: 1 }], 60), 'wide strip')
  }))

  await test('export: element seeking with a 30 fps webcam takes each camera frame at once', fx.withHome('export-webcam-element', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 3, width: 1280, height: 720 })
    const webcam = fx.indexedVideo({ seconds: 3, width: 320, height: 240, fps: 30 })
    fx.seedProject(home, { name: 'Webcam', media, seconds: 3, webcam })
    const { app, win, logs } = await h.launch({ home, env: { SSW_EXPORT_DECODER: 'element' } })
    ctx.app = app
    ctx.logs = logs
    const timing = fx.exportTimings(win)
    await fx.openProject(win, 'Webcam')
    const out = path.join(home, 'webcam.mp4')
    await exportTo(app, win, out, { res: '720p', fps: '60 fps' })
    const t = timing.last()
    console.log(`  ${t.line}`)
    h.assert(/element decoding \(webcam: element\)/.test(t.line), 'screen and webcam came from the seeking path')
    // The screen stays frame-exact (the camera bubble is in the bottom-right corner).
    expectCodes(codes(out, 1280, 720), fx.exportFrameTimes([{ start: 0, end: 3, speed: 1 }], 60), 'element + webcam')
    // With the webcam taken as 60 fps, every other frame waited 100 ms for a frame that never came (>= 50 ms per frame).
    h.assert(t.decode < 30, `waited ${t.decode} ms per frame for decoding`)
  }))

  await test('export: a 60 s GIF keeps ffmpeg memory bounded; cancel works while finalizing', fx.withHome('export-gif', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 60, width: 1280, height: 720 })
    fx.seedProject(home, { name: 'Gif', media, seconds: 60 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Gif')
    const out = path.join(home, 'long.gif')
    const mem = fx.watchFfmpegMemory()
    const r = await exportTo(app, win, out, { format: 'GIF', res: '720p' })
    const peak = mem.stop()
    const info = fx.probe(out)
    const v = info.streams[0]
    console.log(`  60 s GIF: ${r.seconds.toFixed(1)} s, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${v.width}x${v.height}, ${v.nb_frames} frames, ffmpeg peak RSS ${peak.toFixed(0)} MB`)
    h.assert(v.width === 1280 && v.height === 720, 'real 720p GIF')
    h.assert(Number(v.nb_frames) === 900, `900 frames at 15 fps (got ${v.nb_frames})`)
    // Buffering every frame (the old split+palettegen graph) needs ~3.3 GB here and grows
    // ~55 MB per second of GIF; the streaming passes stay at a few hundred MB whatever the length.
    h.assert(peak > 0 && peak < 600, `ffmpeg peak RSS ${peak.toFixed(0)} MB`)
    await closeDialog(win)

    // Cancel during the palette pass.
    const out2 = path.join(home, 'cancelled.gif')
    await startExport(app, win, out2, { format: 'GIF', res: '1080p' })
    await win.waitForSelector('.modal .export-status:has-text("Finalizing")', { timeout: 300000 })
    await shot(win, 'export-finalizing')
    await win.click('.modal button:has-text("Cancel export")')
    await win.waitForSelector('.modal button.primary:has-text("Export GIF")', { timeout: 30000 })
    await h.sleep(500)
    h.assert(!fs.existsSync(out2), 'no GIF after cancelling while finalizing')
    h.assert(fx.partialFiles(out2).length === 0, 'no partial GIF')
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('screen-studio-gif-'))
    h.assert(leftovers.length === 0, `GIF intermediates removed (${leftovers})`)
  }))

  await test('export: Copy puts the exported file on the clipboard (xclip text/uri-list)', fx.withHome('export-copy', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 2, width: 1280, height: 720 })
    fx.seedProject(home, { name: 'Copy me', media, seconds: 2 })
    // A stand-in xclip records what the app hands it (the container has no clipboard tool).
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    const record = path.join(home, 'xclip-call')
    fs.writeFileSync(path.join(bin, 'xclip'), `#!/bin/sh\necho "$@" > "${record}.args"\ncat > "${record}.data"\n`, { mode: 0o755 })
    const { app, win, logs } = await h.launch({ home, env: { PATH: `${bin}:${process.env.PATH}`, WAYLAND_DISPLAY: '' } })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Copy me')
    // Keyboard: the dialog opens with Export focused, and Escape closes it.
    await fx.openExportDialog(win)
    const focused = await win.evaluate(() => document.activeElement?.textContent?.trim())
    h.assert(focused === 'Export MP4', `Export is focused (got ${JSON.stringify(focused)})`)
    await win.keyboard.press('Escape')
    await win.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
    const out = path.join(home, 'My clip #1.mp4')
    await exportTo(app, win, out, { res: '720p' })
    await shot(win, 'export-done')
    await win.click('.modal button:has-text("Copy")')
    await win.waitForSelector('.modal button:has-text("Copied")', { timeout: 10000 })
    await win.keyboard.press('Escape')
    await win.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
    h.assert(fs.readFileSync(`${record}.args`, 'utf8').trim() === '-selection clipboard -t text/uri-list -i', 'xclip arguments')
    const uri = fs.readFileSync(`${record}.data`, 'utf8')
    h.assert(uri === `file://${encodeURI(out).replace('#', '%23')}\r\n`, `uri-list payload: ${JSON.stringify(uri)}`)
  }))
}

main()
