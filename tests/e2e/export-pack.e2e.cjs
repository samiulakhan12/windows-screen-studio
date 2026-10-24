// Export pack in the real built app: destination presets (aspect for the export only),
// batch export into a folder, size targets, WebM / MOV / M4A, and thumbnails.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** Replaces the main-process folder dialog so batch exports go to `dir`. */
async function mockFolderDialog(app, dir) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, dir)
}

async function launchWith(ctx, home, project, env = {}) {
  const { app, win, logs } = await h.launch({ home, env })
  ctx.app = app
  ctx.logs = logs
  await fx.openProject(win, project)
  return { app, win }
}

async function closeDialog(win) {
  const back = win.locator('.modal button', { hasText: /^Back$/ })
  if (await back.count()) await back.click()
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Starts the single-file export with the primary button and waits for the result. */
async function exportNow(app, win, out) {
  await h.mockSaveDialog(app, out)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export finished: ${r.text}`)
  return r
}

async function setTarget(win, mb) {
  await win.fill('.modal input[aria-label="Target size in MB"]', String(mb))
}

const formatName = (file) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', file]).toString().trim()
const videoOf = (file) => fx.probe(file).streams.find((s) => s.codec_type === 'video')
const audioOf = (file) => fx.probe(file).streams.find((s) => s.codec_type === 'audio')

/** Frame codes of an export whose recording (16:9, no padding) is drawn at `rect`. */
function codesIn(file, rect) {
  // ffmpeg's crop rounds to the 4:2:0 chroma grid: keep everything even.
  const even = (v) => Math.floor(v / 2) * 2
  return fx.decodeIndices(file, { x: even(rect.x + 1), y: even(rect.y + 1), w: even(rect.w - 2), h: even(rect.h / 4) })
}

function expectCodes(got, times, label) {
  const want = times.map((t) => Math.round(t * 60))
  h.assert(got.length === want.length, `${label}: ${got.length} frames, expected ${want.length}`)
  const wrong = got.map((c, i) => (c === want[i] ? null : `#${i}: ${c} != ${want[i]}`)).filter(Boolean)
  h.assert(wrong.length === 0, `${label}: ${wrong.length} frames show the wrong source frame (${wrong.slice(0, 8).join(', ')})`)
}

/** Where a 16:9 recording lands inside a 9:16 1080x1920 output with no padding. */
const PORTRAIT_RECT = { x: 0, y: Math.ceil((1920 - 607.5) / 2) + 1, w: 1080, h: 606 }

/** A PNG decoded to raw RGB. */
function pngPixels(file) {
  const info = fx.probe(file).streams[0]
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 })
  return { width: info.width, height: info.height, data }
}

async function main() {
  await test('export pack: preset gallery, Reels exports 1080x1920 with the aspect for the export only', fx.withHome('pack-reels', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: 1280, height: 720 })
    const id = fx.seedProject(home, {
      name: 'Reels demo',
      media,
      seconds: 4,
      style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
    })
    const { app, win } = await launchWith(ctx, home, 'Reels demo')
    await fx.openExportDialog(win)
    await h.sleep(800)
    await shot(win, 'pack-dialog')
    await win.click('.modal .preset-card[data-preset="reels"]')
    await h.sleep(600)
    const summary = await win.textContent('.modal .export-size')
    h.assert(summary.includes('1080×1920') && summary.includes('30 fps'), `summary shows the Reels size: ${summary}`)
    h.assert(await win.isVisible('.modal .preset-card[data-preset="reels"].active'), 'the Reels card is selected')
    await shot(win, 'pack-reels-selected')
    // A tweak makes the settings custom; picking the card again restores them.
    await fx.pickChip(win, 'Frame rate', '60 fps')
    h.assert(!(await win.isVisible('.modal .preset-card.active')), 'no card is selected after a tweak')
    await win.click('.modal .preset-card[data-preset="reels"]')
    const out = path.join(home, 'reels.mp4')
    await exportNow(app, win, out)
    await shot(win, 'pack-reels-done')
    const v = videoOf(out)
    h.assert(v.width === 1080 && v.height === 1920, `1080x1920 (got ${v.width}x${v.height})`)
    h.assert(v.r_frame_rate === '30/1' && Number(v.nb_frames) === 120, `30 fps, 120 frames (got ${v.r_frame_rate}, ${v.nb_frames})`)
    expectCodes(codesIn(out, PORTRAIT_RECT), fx.exportFrameTimes([{ start: 0, end: 4, speed: 1 }], 30), 'reels')
    // Background above and below the recording (the gradient, not black bars).
    const { frames } = fx.framesAt(out, [60], 'rgb24')
    const px = (x, y) => Array.from(frames[0].subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3))
    const top = px(540, 200)
    h.assert(top.some((c) => c > 40), `the background fills the area above the recording (${top})`)
    await closeDialog(win)
    await app.close()
    ctx.app = null
    const saved = h.readProject(home, id)
    h.assert(saved.style.aspectRatio === 'auto', `the saved project keeps its aspect (got ${saved.style.aspectRatio})`)
    // The choice is remembered.
    const again = await launchWith(ctx, home, 'Reels demo')
    await fx.openExportDialog(again.win)
    h.assert(await again.win.isVisible('.modal .preset-card[data-preset="reels"].active'), 'the last preset is remembered')
  }))

  await test('export pack: a batch of 3 makes 3 correct files in the chosen folder; cancel stops the rest', fx.withHome('pack-batch', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 3, width: 1280, height: 720 })
    fx.seedProject(home, { name: 'Batch: demo', media, seconds: 3 })
    const { app, win } = await launchWith(ctx, home, 'Batch: demo')
    const folder = path.join(home, 'batch out')
    fs.mkdirSync(folder)
    // An existing file is never replaced.
    fs.writeFileSync(path.join(folder, 'Batch- demo - Square post.mp4'), 'KEEP')
    await mockFolderDialog(app, folder)
    await fx.openExportDialog(win)
    await win.click('.modal .export-mode button:has-text("Batch")')
    for (const id of ['youtube-1080', 'square', 'slack-gif']) await win.click(`.modal .preset-card[data-preset="${id}"]`)
    await h.sleep(300)
    await shot(win, 'pack-batch-settings')
    const button = win.locator('.modal button.primary', { hasText: 'Export 3 files' })
    await button.click()
    await win.waitForSelector('.modal .success:has-text("Batch finished")', { timeout: 300000 })
    await shot(win, 'pack-batch-done')
    const files = fs.readdirSync(folder).sort()
    h.assert(
      JSON.stringify(files) === JSON.stringify(['Batch- demo - Slack GIF.gif', 'Batch- demo - Square post (2).mp4', 'Batch- demo - Square post.mp4', 'Batch- demo - YouTube 1080p60.mp4']),
      `files: ${files}`
    )
    h.assert(fs.readFileSync(path.join(folder, 'Batch- demo - Square post.mp4'), 'utf8') === 'KEEP', 'the existing file is untouched')
    const yt = videoOf(path.join(folder, 'Batch- demo - YouTube 1080p60.mp4'))
    h.assert(yt.width === 1920 && yt.height === 1080 && yt.r_frame_rate === '60/1' && Number(yt.nb_frames) === 180, `YouTube: ${yt.width}x${yt.height} ${yt.r_frame_rate} ${yt.nb_frames}`)
    const sq = videoOf(path.join(folder, 'Batch- demo - Square post (2).mp4'))
    h.assert(sq.width === 1080 && sq.height === 1080 && sq.r_frame_rate === '30/1', `Square: ${sq.width}x${sq.height} ${sq.r_frame_rate}`)
    const gifFile = path.join(folder, 'Batch- demo - Slack GIF.gif')
    const gif = videoOf(gifFile)
    h.assert(gif.codec_name === 'gif' && gif.width === 720 && gif.height === 406, `Slack GIF: ${gif.codec_name} ${gif.width}x${gif.height}`)
    h.assert(fs.statSync(gifFile).size <= 15e6, 'the GIF fits 15 MB')
    expectCodes(codesIn(path.join(folder, 'Batch- demo - YouTube 1080p60.mp4'), { x: 0, y: 0, w: 1920, h: 1080 }), fx.exportFrameTimes([{ start: 0, end: 3, speed: 1 }], 60), 'batch youtube')
    h.assert(fx.partialFiles(path.join(folder, 'x')).length === 0, 'no partial files')
    // Copy a file of the batch.
    await win.click('.modal .batch-row.done >> nth=0 >> button')
    await win.click('.modal button:has-text("Back")')

    // Cancel during the first file: nothing of it stays, the others are skipped.
    const folder2 = path.join(home, 'cancelled')
    fs.mkdirSync(folder2)
    await mockFolderDialog(app, folder2)
    await win.click('.modal .preset-card[data-preset="square"]')
    await win.click('.modal .preset-card[data-preset="slack-gif"]')
    await win.click('.modal .preset-card[data-preset="youtube-4k"]')
    await win.locator('.modal button.primary', { hasText: 'Export 2 files' }).click()
    await win.waitForSelector('.modal .batch-row.running', { timeout: 60000 })
    await h.sleep(1500)
    await win.click('.modal button:has-text("Cancel export")')
    await win.waitForSelector('.modal .success, .modal .export-error', { timeout: 30000 })
    await h.sleep(500)
    const states = await win.$$eval('.modal .batch-row', (rows) => rows.map((r) => r.dataset.state))
    h.assert(JSON.stringify(states) === '["cancelled","cancelled"]', `states after cancel: ${states}`)
    h.assert(fs.readdirSync(folder2).length === 0, `nothing written: ${fs.readdirSync(folder2)}`)
  }))

  await test('export pack: a target size lands within 10% (x264 two-pass, WebCodecs CBR) and a GIF is shrunk to fit', fx.withHome('pack-target', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 8, width: 1280, height: 720, beeps: true })
    fx.seedProject(home, { name: 'Target', media, seconds: 8, audio: true })
    for (const venc of ['ffmpeg', 'webcodecs-software']) {
      const { app, win } = await launchWith(ctx, home, 'Target', { SSW_EXPORT_VIDEO_ENCODER: venc })
      await fx.openExportDialog(win)
      await fx.pickChip(win, 'Format', 'MP4')
      await fx.pickChip(win, 'Resolution', '720p')
      await fx.pickChip(win, 'Frame rate', '30 fps')
      await setTarget(win, 2)
      await h.sleep(300)
      await shot(win, `pack-target-${venc}`)
      const out = path.join(home, `target-${venc}.mp4`)
      const r = await exportNow(app, win, out)
      const bytes = fs.statSync(out).size
      const err = bytes / 2e6 - 1
      console.log(`  ${venc}: ${bytes} bytes for a 2 MB target (${(err * 100).toFixed(1)}%) in ${r.seconds.toFixed(1)} s`)
      h.assert(Math.abs(err) < 0.1, `${venc}: ${bytes} bytes is not within 10% of 2 MB`)
      const v = videoOf(out)
      h.assert(Number(v.nb_frames) === 240, `every frame (${v.nb_frames})`)
      h.assert(Math.abs(Number(audioOf(out).duration) - 8) < 0.05, 'audio kept')
      h.assert(/Target 2 MB/.test(await win.textContent('.modal')), 'the result says how it compares with the target')
      await closeDialog(win)
      await app.close()
      ctx.app = null
    }
    // A GIF over its limit is made smaller until it fits.
    const { app, win } = await launchWith(ctx, home, 'Target')
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Format', 'GIF')
    await fx.pickChip(win, 'Resolution', '720p')
    await setTarget(win, 3)
    const out = path.join(home, 'small.gif')
    await exportNow(app, win, out)
    const text = await win.textContent('.modal')
    const bytes = fs.statSync(out).size
    const g = videoOf(out)
    console.log(`  GIF: ${bytes} bytes, ${g.width}x${g.height}, ${g.r_frame_rate}; ${/To fit[^.]*\./.exec(text)?.[0]}`)
    h.assert(bytes <= 3e6, `GIF within 3 MB (${bytes})`)
    h.assert(/To fit 3 MB the GIF was made at/.test(text), `the dialog says how the GIF was reduced: ${text}`)
    await shot(win, 'pack-gif-fitted')
  }))

  await test('export pack: WebM (WebCodecs VP9 and libvpx), MOV and M4A probe correctly', fx.withHome('pack-formats', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: 1280, height: 720, beeps: true })
    const clips = [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 3, end: 4, speed: 1 }
    ]
    fx.seedProject(home, { name: 'Formats', media, seconds: 4, audio: true, clips })
    const times60 = fx.exportFrameTimes(clips, 60)
    // Auto (here: WebCodecs VP9 in software, framed as IVF), then ffmpeg's libvpx-vp9 from raw frames.
    for (const venc of [null, 'ffmpeg']) {
      const { app, win } = await launchWith(ctx, home, 'Formats', venc ? { SSW_EXPORT_VIDEO_ENCODER: venc } : {})
      const timing = fx.exportTimings(win)
      for (const format of venc ? ['WebM'] : ['WebM', 'MOV', 'M4A']) {
        await fx.openExportDialog(win)
        await fx.pickChip(win, 'Format', format)
        if (format !== 'M4A') {
          await fx.pickChip(win, 'Resolution', '720p')
          await fx.pickChip(win, 'Frame rate', '60 fps')
        }
        const out = path.join(home, `formats-${venc || 'auto'}.${format.toLowerCase()}`)
        const r = await exportNow(app, win, out)
        const info = fx.probe(out)
        const v = info.streams.find((s) => s.codec_type === 'video')
        const a = info.streams.find((s) => s.codec_type === 'audio')
        const via = format === 'M4A' ? 'audio only' : timing.last().line.replace(/^export: /, '').split(';')[0]
        console.log(`  ${format}${venc ? ` (${venc})` : ''}: ${info.format.duration} s, ${(fs.statSync(out).size / 1e3).toFixed(0)} KB, ${r.seconds.toFixed(1)} s, ${via}`)
        if (format === 'M4A') {
          h.assert(!v && a && a.codec_name === 'aac', `M4A is AAC only (${info.streams.map((s) => s.codec_name)})`)
          h.assert(Math.abs(Number(a.duration) - 3) < 0.05, `M4A is 3 s (${a.duration})`)
          const { onsets } = fx.beepOnsets(out)
          h.assert(onsets.length === 3 && [0, 1, 2].every((t, i) => Math.abs(onsets[i] - t) < 0.03), `beeps at 0, 1, 2 (${onsets})`)
        } else {
          const codec = format === 'WebM' ? 'vp9' : 'h264'
          h.assert(v.codec_name === codec, `${format}: ${codec} (got ${v.codec_name})`)
          h.assert(a && a.codec_name === (format === 'WebM' ? 'opus' : 'aac'), `${format}: audio ${a && a.codec_name}`)
          h.assert(v.width === 1280 && v.height === 720, `${format}: 1280x720`)
          h.assert(v.color_space === 'smpte170m' && v.color_primaries === 'bt709' && v.color_transfer === 'bt709' && v.color_range === 'tv', `${format}: colour tags ${v.color_space}/${v.color_primaries}/${v.color_transfer}/${v.color_range}`)
          expectCodes(codesIn(out, { x: 0, y: 0, w: 1280, h: 720 }), times60, `${format} ${venc || ''}`)
          h.assert(Math.abs(Number(info.format.duration) - 3) < 0.06, `${format}: 3 s (${info.format.duration})`)
          if (format === 'WebM') h.assert((venc ? /Software \(VP9\)/ : /WebCodecs VP9/).test(r.text), `the expected VP9 route was used: ${r.text}`)
          if (format === 'MOV') h.assert(formatName(out).includes('mov') && fs.readFileSync(out).subarray(4, 12).toString('latin1').includes('qt'), `QuickTime container (${formatName(out)})`)
          if (format === 'WebM') h.assert(formatName(out).includes('webm'), `WebM container (${formatName(out)})`)
        }
        await closeDialog(win)
      }
      await app.close()
      ctx.app = null
    }
  }))

  await test('export pack: the thumbnail PNG is the exported frame at the playhead', fx.withHome('pack-thumb', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: 1280, height: 720 })
    fx.seedProject(home, {
      name: 'Thumb',
      media,
      seconds: 4,
      style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.08, cornerRadius: 12, shadow: 0.5, aspectRatio: '16:9' }
    })
    const { app, win } = await launchWith(ctx, home, 'Thumb')
    // Playhead to 2 s (Shift+Right = 1 s).
    await win.keyboard.press('Home')
    await win.keyboard.press('Shift+ArrowRight')
    await win.keyboard.press('Shift+ArrowRight')
    await h.sleep(500)
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Format', 'MP4')
    await fx.pickChip(win, 'Resolution', '720p')
    await fx.pickChip(win, 'Frame rate', '60 fps')
    const frameLabel = await win.textContent('.modal .export-frame .muted')
    h.assert(frameLabel.trim() === '0:02.0', `the frame defaults to the playhead (${frameLabel})`)
    const png = path.join(home, 'thumb.png')
    await h.mockSaveDialog(app, png)
    await win.click('.modal button:has-text("Save thumbnail")')
    await win.waitForSelector('.modal .export-thumb-status', { timeout: 30000 })
    await shot(win, 'pack-thumbnail-saved')
    const pic = pngPixels(png)
    h.assert(pic.width === 1280 && pic.height === 720, `export size ${pic.width}x${pic.height}`)
    // The same frame of an MP4 export with the same settings.
    const out = path.join(home, 'thumb.mp4')
    await exportNow(app, win, out)
    const { frames } = fx.framesAt(out, [120], 'rgb24')
    let sum = 0
    for (let i = 0; i < pic.data.length; i++) sum += Math.abs(pic.data[i] - frames[0][i])
    const mean = sum / pic.data.length
    console.log(`  thumbnail vs exported frame 120: mean difference ${mean.toFixed(2)} levels`)
    h.assert(mean < 3, `the thumbnail matches the exported frame (mean difference ${mean.toFixed(2)})`)
    // And it is frame 120 of the recording (2.0 s), read from the frame-index boxes.
    const tmp = path.join(home, 'thumb-frame.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-loop', '1', '-i', png, '-frames:v', '1', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', tmp])
    const rect = (() => {
      const pad = 720 * 0.08
      const w = 1280 - pad * 2
      const hh = 720 - pad * 2
      const k = Math.min(w / 1280, hh / 720)
      return { x: Math.round((1280 - 1280 * k) / 2), y: Math.round((720 - 720 * k) / 2), w: Math.floor(1280 * k), h: Math.floor(720 * k) }
    })()
    const [code] = codesIn(tmp, rect)
    h.assert(code === 120, `the thumbnail shows source frame 120 (got ${code})`)
  }))
}

main()
