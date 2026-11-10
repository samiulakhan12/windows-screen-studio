// Wave 12's export formats in the real built app (docs/design/output-and-languages.md §23.3): stored
// settings of before, AV1, frame rates and 4:5, transparent WebM and CineForm against the dialog's own
// preview, sound stems and the WAV format, timelines over this export and over the original
// recordings, and an Export click while the HEVC check runs. Every launch blocks and logs the network
// (F14): nothing may leave the app.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/output-formats.e2e.cjs
//
// Steps F2, F12, F13, F15 and F16 (the dialog's rows, saved presets, the keyboard and the editors,
// with nothing exported) are in export-presets.e2e.cjs, which the same e2e list runs.
//
// The fixtures are 4 s long instead of the design's 10 s, so the encodes fit a shared machine; every
// count below follows from 4 s (F4's 24, 25 and 120 fps give 96, 100 and 480 frames). Set
// SSW_E2E_BASELINE_DIR to a checkout holding a build of the release before wave 12 to compare F1's
// file with that build's export of the same project; without it F1 checks the values that build gives.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
const SECONDS = 4
const RATE = 48000

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/* ---------- the app ---------- */

/** Launches the app (or a baseline build) with the network blocked and logged, stored settings in place, and `project` open. */
async function launchWith(ctx, home, project, { settings, bundle, appDir } = {}) {
  const { app, win, logs } = await h.launch({ home, appDir })
  ctx.app = app
  ctx.logs = logs
  await app.evaluate(({ session }) => {
    globalThis.__requests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
      globalThis.__requests.push(details.url)
      done({ cancel: true })
    })
  })
  await win.evaluate(({ s, b }) => {
    localStorage.setItem('export-mode', 'single')
    if (s) localStorage.setItem('export-settings', JSON.stringify(s))
    if (b) localStorage.setItem('export-bundle', JSON.stringify(b))
  }, { s: settings, b: bundle })
  await fx.openProject(win, project)
  return { app, win }
}

/** F14: no request left the app. */
async function offline(app) {
  const urls = await app.evaluate(() => globalThis.__requests)
  h.assert(urls.length === 0, `no request left the app (${urls.join(', ')})`)
}

async function openSettings(win) {
  await fx.openExportDialog(win)
  const head = win.locator('.modal button.toggle-head')
  if ((await head.count()) && (await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  await win.waitForSelector('.modal .export-settings')
  await h.sleep(500)
}

async function closeDialog(win) {
  const back = win.locator('.modal button', { hasText: /^Back$/ })
  if (await back.count()) await back.click()
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Starts the single-file export to `out` and waits for the done view. */
async function exportNow(app, win, out) {
  await h.mockSaveDialog(app, out)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export to ${path.basename(out)} finished: ${r.text}`)
  return r
}

/** Opens the dialog, sets the stored settings first, exports to `out` and closes the dialog again. */
async function exportWith(app, win, out, settings, bundle) {
  await win.evaluate(({ s, b }) => {
    localStorage.setItem('export-settings', JSON.stringify(s))
    localStorage.setItem('export-bundle', JSON.stringify(b ?? {}))
  }, { s: settings, b: bundle })
  await openSettings(win)
  const r = await exportNow(app, win, out)
  await closeDialog(win)
  return r
}

const radio = (win, group, value) => win.click(`.modal [data-testid="${group}"] [data-value="${value}"]`)
const checked = (win, group) => win.$$eval(`.modal [data-testid="${group}"] [aria-checked="true"]`, (els) => els.map((e) => e.getAttribute('data-value')))

/* ---------- files ---------- */

const videoOf = (file) => fx.probe(file).streams.find((s) => s.codec_type === 'video')
/** The audio streams of `file` with their codec, sample rate and channels. */
const audioStreams = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', file]).toString()).streams

/** Every field of the video stream ffprobe reports as tags of the picture (F1). */
function streamTags(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_read_frames,color_space,color_primaries,color_transfer,color_range,field_order:stream_tags', '-of', 'json', file]).toString())
  const s = j.streams[0]
  return { ...s, tags: Object.fromEntries(Object.entries(s.tags ?? {}).filter(([k]) => !/creation_time|encoder|handler_name|vendor_id/i.test(k))) }
}

/** Decoded frame `index` of `file` as straight RGBA (VP9 through libvpx, which keeps alpha), optionally scaled to `size`. */
function rgbaAt(file, index, size) {
  const vp9 = videoOf(file).codec_name === 'vp9'
  const scale = size ? `,scale=${size.width}:${size.height}:flags=area` : ''
  const out = spawnSync('ffmpeg', ['-v', 'error', ...(vp9 ? ['-c:v', 'libvpx-vp9'] : []), '-i', file, '-vf', `select='eq(n\\,${index})'${scale}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 })
  const v = videoOf(file)
  const width = size ? size.width : v.width
  const height = size ? size.height : v.height
  h.assert(out.stdout.length === width * height * 4, `frame ${index} of ${path.basename(file)} decoded (${out.stdout.length} bytes, ${out.stderr})`)
  return { width, height, data: out.stdout }
}
const pixel = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))

/** Shares of transparent (alpha ≤ 10), opaque (≥ 245) and partial pixels, in percent. */
function alphaClasses(img) {
  const n = img.width * img.height
  let clear = 0
  let solid = 0
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] <= 10) clear++
    else if (img.data[i] >= 245) solid++
  }
  return { clear: (100 * clear) / n, solid: (100 * solid) / n, partial: (100 * (n - clear - solid)) / n }
}

/**
 * Shares of the colour classes of the visible pixels (alpha > 10), in percent of all pixels: each
 * channel in five steps centred on 0, 64, 128, 192 and 255, so the fixtures' colours sit in the middle
 * of a step and the encoders' small colour changes keep their class.
 */
function colourClasses(img) {
  const n = img.width * img.height
  const out = {}
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] <= 10) continue
    const k = `${(img.data[i] + 32) >> 6}${(img.data[i + 1] + 32) >> 6}${(img.data[i + 2] + 32) >> 6}`
    out[k] = (out[k] ?? 0) + 100 / n
  }
  return out
}

/** The export's frame and the preview's agree within `points` per alpha class and per colour class. */
function sameClasses(a, b, label, points = 2) {
  const x = alphaClasses(a)
  const y = alphaClasses(b)
  for (const k of ['clear', 'solid', 'partial']) h.assert(Math.abs(x[k] - y[k]) <= points, `${label}: ${k} ${x[k].toFixed(2)}% in the export against ${y[k].toFixed(2)}% in the preview`)
  const cx = colourClasses(a)
  const cy = colourClasses(b)
  for (const k of new Set([...Object.keys(cx), ...Object.keys(cy)])) {
    const d = Math.abs((cx[k] ?? 0) - (cy[k] ?? 0))
    h.assert(d <= points, `${label}: colour class ${k} is ${(cx[k] ?? 0).toFixed(2)}% in the export against ${(cy[k] ?? 0).toFixed(2)}% in the preview`)
  }
}

/** The dialog's preview canvas pixels (straight RGBA, as getImageData gives them). */
async function previewPixels(win) {
  await h.sleep(1200)
  return win.evaluate(() => {
    const c = document.querySelector('.modal canvas.export-preview-canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height)
    return { width: c.width, height: c.height, data: Array.from(d.data), alpha: c.classList.contains('alpha-preview') }
  }).then((p) => ({ ...p, data: Buffer.from(p.data) }))
}

/** Moves the dialog's preview (the thumbnail frame) to `seconds`. */
async function previewAt(win, seconds) {
  await win.locator('.modal input[aria-label="Thumbnail frame"]').fill(String(seconds))
  await h.sleep(800)
}

function hue([r, g, b]) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const raw = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (raw * 60 + 360) % 360
}

/** Interleaved float samples of the first audio stream of `file` at 48 kHz stereo. */
function pcm(file) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '2', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(out.buffer, out.byteOffset, out.length / 4)
}

const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity)

/** The project folder's files with their bytes and modification times (F11: never changed). */
function folderState(dir) {
  const out = {}
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isFile()) out[name] = { size: st.size, mtime: st.mtimeMs, sum: require('node:crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex') }
  }
  return out
}

/* ---------- fixtures ---------- */

/** A cached media file made by ffmpeg from `args`. */
function cached(name, args) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, name)
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/(\.\w+)$/, '.part$1')
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, tmp])
  fs.renameSync(tmp, file)
  return file
}

/** Patches the seeded project.json of `id`. */
function patchProject(home, id, patch) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 2))
}

/** The demo: 1280×720, 6% padding (about 40 px at 720p), a gradient, two chapters, music and clicks; mic and system as separate files. */
function seedDemo(home, { id = 'rec-demo', name = 'Demo', camera = false, clips } = {}) {
  const mic = cached('w12-mic-mono.m4a', ['-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000`, '-t', String(SECONDS + 1), '-ac', '1', '-af', 'volume=0.5', '-c:a', 'aac', '-b:a', '128k'])
  const system = cached('w12-system.m4a', ['-f', 'lavfi', '-i', `sine=frequency=300:sample_rate=48000`, '-t', String(SECONDS + 1), '-ac', '2', '-af', 'volume=0.5', '-c:a', 'aac', '-b:a', '192k'])
  const music = cached('w12-music.m4a', ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000`, '-t', String(SECONDS + 1), '-ac', '2', '-af', 'volume=0.4', '-c:a', 'aac', '-b:a', '192k'])
  const screen = fx.indexedVideo({ seconds: SECONDS, width: 1280, height: 720 })
  // The recording's own mixed track, as the recorder makes it: the microphone on both sides at full level, plus the system sound.
  const media = cached('w12-demo-screen2.mp4', ['-i', screen, '-i', mic, '-i', system, '-filter_complex', '[1:a]pan=stereo|FL=c0|FR=c0[m];[m][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-t', String(SECONDS), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'])
  const webcam = camera ? fx.solidVideo({ seconds: SECONDS, width: 640, height: 480, color: '00c040' }) : undefined
  fx.seedProject(home, {
    id,
    name,
    media,
    webcam,
    seconds: SECONDS,
    audio: true,
    clips,
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.06, cornerRadius: 12, shadow: 0, aspectRatio: 'auto' },
    cursorSettings: { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true, clickSound: true, clickSoundVolume: 0.8 },
    cursor: { samples: [{ t: 0, x: 0.5, y: 0.5 }, { t: SECONDS, x: 0.5, y: 0.5 }], clicks: [{ t: 1, x: 0.5, y: 0.5, button: 'left' }, { t: 3, x: 0.5, y: 0.5, button: 'left' }], keys: [], shapes: [], scale: 1, valid: true },
    // The microphone a little lower: the video then mixes the separate files, the very graph its stems are cut from
    // (at the default gains it plays the recording's mixed track, §7.6).
    audioSettings: { volume: 1, muted: false, mic: { volume: 0.8, muted: false }, system: { volume: 1, muted: false }, music: { path: 'music.m4a', volume: 1, ducking: 0, loop: true, fadeIn: 0, fadeOut: 0 } }
  })
  const dir = path.join(h.projectsRoot(home), id)
  for (const [n, f] of Object.entries({ 'mic.m4a': mic, 'system.m4a': system, 'music.m4a': music })) fs.symlinkSync(f, path.join(dir, n))
  patchProject(home, id, { audioStems: { mic: true, system: true }, chapters: [{ id: 'ch1', t: 0, title: 'Start' }, { id: 'ch2', t: 2, title: 'Settings' }] })
  return { id, dir }
}

/** The previous release's stored export settings (F1). */
const BEFORE = { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }
/**
 * What the build before wave 12 (be3cbdc, wave 11's head with the design) exports for BEFORE on this
 * project, measured with SSW_E2E_BASELINE_DIR on 10 November 2026; that run also found the frames identical.
 */
const BEFORE_FILE = { codec_name: 'h264', profile: 'High', width: 1920, height: 1080, pix_fmt: 'yuv420p', color_range: 'tv', color_space: 'smpte170m', color_transfer: 'bt709', color_primaries: 'bt709', field_order: 'progressive', r_frame_rate: '60/1', nb_read_frames: String(SECONDS * 60) }

async function main() {
  await test('output formats: stored settings of before, AV1 on the processor, 24, 25 and 120 fps, and 4:5 (F1, F3, F4, F14)', fx.withHome('of-formats', async (ctx, home) => {
    seedDemo(home)
    const { app, win } = await launchWith(ctx, home, 'Demo', { settings: BEFORE })

    // F1: the previous release's settings export the file they made, and are written back unchanged.
    const stored = () => win.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('export')).map((k) => [k, localStorage.getItem(k)])))
    const before = await stored()
    await openSettings(win)
    const f1 = path.join(home, 'before.mp4')
    await exportNow(app, win, f1)
    await closeDialog(win)
    h.assert(JSON.stringify(await stored()) === JSON.stringify(before), `the stored export settings are byte for byte the same (${JSON.stringify(before)} → ${JSON.stringify(await stored())})`)
    const got = streamTags(f1)
    if (!process.env.SSW_E2E_BASELINE_DIR) for (const [k, v] of Object.entries(BEFORE_FILE)) h.assert(String(got[k]) === String(v), `F1 ${k}: ${got[k]}, before ${v}`)
    else {
      await app.close()
      ctx.app = null
      const base = await launchWith(ctx, home, 'Demo', { settings: BEFORE, appDir: process.env.SSW_E2E_BASELINE_DIR })
      await openSettings(base.win)
      const f0 = path.join(home, 'baseline.mp4')
      await exportNow(base.app, base.win, f0)
      await closeDialog(base.win)
      console.log(`F1 baseline: ${JSON.stringify(streamTags(f0))}`)
      h.assert(JSON.stringify(streamTags(f0)) === JSON.stringify(got), `F1 equals the baseline build's export (${JSON.stringify(streamTags(f0))} against ${JSON.stringify(got)})`)
      const md5 = (f) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'md5', '-']).toString().trim()
      h.assert(md5(f0) === md5(f1), 'F1 draws the frames the baseline build draws')
      await base.app.close()
      ctx.app = null
      return
    }

    // F3: MP4 + AV1 + Software at 720p, with the time hint; then WebM + AV1.
    await openSettings(win)
    await fx.pickChip(win, 'Resolution', '720p')
    await radio(win, 'export-codec', 'av1')
    await fx.pickChip(win, 'Encoder', 'Software')
    await h.sleep(300)
    const hint = await win.textContent('.modal [data-testid="export-codec-hint"]')
    h.assert(/^AV1 on the processor takes about 6 times as long as H\.264: roughly .+ for this video\.$/.test(hint), `the AV1 hint gives a time for this video (${hint})`)
    await shot(win, 'output-av1')
    const av1mp4 = path.join(home, 'av1.mp4')
    await exportNow(app, win, av1mp4)
    await closeDialog(win)
    h.assert(videoOf(av1mp4).codec_name === 'av1' && videoOf(av1mp4).height === 720, `MP4 + AV1 is AV1 at 720p (${JSON.stringify(videoOf(av1mp4))})`)
    await openSettings(win)
    await fx.pickChip(win, 'Format', 'WebM')
    await radio(win, 'export-codec', 'av1')
    const av1webm = path.join(home, 'av1.webm')
    await exportNow(app, win, av1webm)
    await closeDialog(win)
    h.assert(videoOf(av1webm).codec_name === 'av1', `WebM + AV1 is AV1 (${videoOf(av1webm).codec_name})`)

    // F4: 24, 25 and 120 fps give 4 s of frames at their rate.
    const base720 = { format: 'mp4', resolution: 720, fps: 30, quality: 'medium', encoder: 'auto' }
    for (const fps of [24, 25, 120]) {
      const out = path.join(home, `fps${fps}.mp4`)
      await exportWith(app, win, out, { ...base720, fps })
      const v = videoOf(out)
      h.assert(v.r_frame_rate === `${fps}/1` && Number(v.nb_frames) === SECONDS * fps, `${fps} fps: ${SECONDS * fps} frames (got ${v.r_frame_rate}, ${v.nb_frames})`)
    }
    // 4:5 at 1080 is 1080×1350; the Portrait post destination gives the same file.
    const portrait = { format: 'mp4', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', aspect: '4:5' }
    const byHand = path.join(home, 'portrait-hand.mp4')
    await exportWith(app, win, byHand, portrait)
    await openSettings(win)
    const line = await win.textContent('.modal .export-size')
    h.assert(line.includes('1080×1350') && line.includes('30 fps'), `the size line says 1080×1350 at 30 fps (${line})`)
    await win.evaluate(() => localStorage.setItem('export-settings', JSON.stringify({ format: 'mp4', resolution: 720, fps: 60, quality: 'small', encoder: 'auto' })))
    await closeDialog(win)
    await openSettings(win)
    await win.click('.modal .preset-card[data-preset="portrait-post"]')
    await h.sleep(400)
    await shot(win, 'output-portrait')
    const byCard = path.join(home, 'portrait-card.mp4')
    await exportNow(app, win, byCard)
    await closeDialog(win)
    const a = videoOf(byHand)
    const b = videoOf(byCard)
    h.assert(a.width === 1080 && a.height === 1350 && b.width === 1080 && b.height === 1350, `4:5 is 1080×1350 (${a.width}×${a.height}, ${b.width}×${b.height})`)
    const md5 = (f) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'md5', '-']).toString().trim()
    h.assert(md5(byHand) === md5(byCard), 'Portrait post exports the same frames as 4:5 chosen by hand')
    await offline(app)
  }))

  await test('output formats: transparent WebM and CineForm match the dialog preview, with straight alpha and joins (F5, F6, F7, F14)', fx.withHome('of-alpha', async (ctx, home) => {
    // A red card with a shadow on a gradient; the camera in its corner.
    const red = fx.solidVideo({ seconds: SECONDS, width: 1280, height: 720, color: 'ff0000' })
    fx.seedProject(home, {
      id: 'rec-overlay',
      name: 'Overlay',
      media: red,
      webcam: fx.solidVideo({ seconds: SECONDS, width: 640, height: 480, color: '00c040' }),
      seconds: SECONDS,
      style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.1, cornerRadius: 24, shadow: 0.8, aspectRatio: 'auto' }
    })
    // The same, with a crossfade at the cut between two clips.
    fx.seedProject(home, {
      id: 'rec-fade',
      name: 'Fade',
      media: fx.indexedVideo({ seconds: SECONDS, width: 1280, height: 720 }),
      webcam: fx.solidVideo({ seconds: SECONDS, width: 640, height: 480, color: '00c040' }),
      seconds: SECONDS,
      clips: [{ id: 'a', start: 0, end: 1.6, speed: 1 }, { id: 'b', start: 2.4, end: SECONDS, speed: 1 }],
      style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.1, cornerRadius: 24, shadow: 0, aspectRatio: 'auto' }
    })
    patchProject(home, 'rec-fade', { joins: { all: { kind: 'crossfade', duration: 0.5 } } })

    const transparent = { format: 'webm', resolution: 720, fps: 30, quality: 'high', encoder: 'auto', alpha: 'background' }
    const { app, win } = await launchWith(ctx, home, 'Overlay', { settings: transparent })
    await openSettings(win)
    await previewAt(win, 1)
    const preview = await previewPixels(win)
    h.assert(preview.alpha, 'the dialog previews the transparent export on its alpha canvas')
    await shot(win, 'output-transparent')
    const webm = path.join(home, 'overlay.webm')
    await exportNow(app, win, webm)
    await closeDialog(win)

    // F5: libvpx decodes alpha 0 in the corner and 255 in the card's centre; the classes match the preview's.
    const frame = rgbaAt(webm, 30)
    h.assert(pixel(frame, 2, 2)[3] === 0, `the corner is transparent (${pixel(frame, 2, 2)})`)
    const centre = pixel(frame, Math.floor(frame.width / 2) - 200, Math.floor(frame.height / 2))
    h.assert(centre[3] === 255 && centre[0] > 230 && centre[1] < 30, `the card's centre is opaque red (${centre})`)
    const small = rgbaAt(webm, 30, preview)
    sameClasses(small, preview, 'F5 transparent WebM at 1.0 s')

    // F6: a shadow pixel in the flattest part of the preview's shadow has the export's alpha within 3 levels.
    let best = null
    for (let y = 2; y < preview.height - 2; y++) {
      for (let x = 2; x < preview.width - 2; x++) {
        const a = preview.data[(y * preview.width + x) * 4 + 3]
        if (a < 40 || a > 200) continue
        const at = (dx, dy) => preview.data[((y + dy) * preview.width + x + dx) * 4 + 3]
        const slope = Math.abs(at(1, 0) - at(-1, 0)) + Math.abs(at(0, 1) - at(0, -1))
        if (!best || slope < best.slope) best = { x, y, a, slope }
      }
    }
    h.assert(best, 'the preview shows a shadow with partial alpha')
    const exported = pixel(small, best.x, best.y)[3]
    h.assert(Math.abs(exported - best.a) <= 3, `the shadow's alpha is straight end to end (export ${exported}, preview ${best.a} at ${best.x},${best.y})`)
    // A red card-edge pixel keeps its hue.
    const row = Math.floor(frame.height / 2)
    let edge = null
    for (let x = 0; x < frame.width / 2; x++) {
      const p = pixel(frame, x, row)
      if (p[3] > 64 && p[0] > p[1] + 40) {
        edge = p
        break
      }
    }
    h.assert(edge && (hue(edge) <= 10 || hue(edge) >= 350), `the card's left edge stays red (${edge}, hue ${edge && hue(edge)})`)

    // F7: MOV + CineForm + Overlays only: the camera is opaque, the rest transparent.
    await openSettings(win)
    await win.click('.modal .preset-card[data-preset="overlay"]')
    await fx.pickChip(win, 'Resolution', '720p')
    await h.sleep(300)
    const mov = path.join(home, 'overlay.mov')
    await exportNow(app, win, mov)
    await closeDialog(win)
    const v = videoOf(mov)
    h.assert(v.codec_name === 'cfhd' && v.pix_fmt === 'gbrap12le', `CineForm with alpha (${v.codec_name}, ${v.pix_fmt})`)
    const ov = rgbaAt(mov, 30)
    h.assert(alphaClasses(ov).clear > 80, `everything but the overlays is transparent (${JSON.stringify(alphaClasses(ov))})`)
    h.assert(pixel(ov, Math.floor(ov.width / 2), Math.floor(ov.height / 2))[3] <= 4, 'the recording is not drawn')
    // The camera sits in the bottom-right corner: its centre is opaque.
    let cam = null
    for (let y = ov.height - 1; y > ov.height / 2 && !cam; y -= 4) for (let x = ov.width - 1; x > ov.width / 2 && !cam; x -= 4) if (pixel(ov, x, y)[3] >= 251) cam = pixel(ov, x, y)
    h.assert(cam && cam[1] > cam[0], `the camera is opaque (${cam})`)
    await app.close()
    ctx.app = null

    // On the crossfade project, the crossfade's middle frame matches the dialog's preview at the same time.
    const fade = await launchWith(ctx, home, 'Fade', { settings: { ...transparent } })
    await openSettings(fade.win)
    const middle = 1.6
    await previewAt(fade.win, middle)
    const fadePreview = await previewPixels(fade.win)
    const fadeOut = path.join(home, 'fade.webm')
    await exportNow(fade.app, fade.win, fadeOut)
    await closeDialog(fade.win)
    const at = Math.round(middle * 30)
    const fadeFrame = rgbaAt(fadeOut, at, fadePreview)
    sameClasses(fadeFrame, fadePreview, 'F7 the crossfade frame')
    // The crossfade is kept: its middle frame differs from both clips' own frames next to the cut.
    const hard = (i) => colourClasses(rgbaAt(fadeOut, i, fadePreview))
    const differs = (x, y) => Object.keys({ ...x, ...y }).some((k) => Math.abs((x[k] ?? 0) - (y[k] ?? 0)) > 2)
    const mid = colourClasses(fadeFrame)
    h.assert(differs(mid, hard(at - 12)) && differs(mid, hard(at + 12)), 'the middle of the crossfade is a mix of both clips')
    await offline(fade.app)
  }))

  await test('output formats: sound stems add up to the WAV export, and the WAV equals the M4A (F8, F9, F14)', fx.withHome('of-stems', async (ctx, home) => {
    seedDemo(home)
    fx.seedProject(home, { id: 'rec-silent', name: 'Silent', media: fx.indexedVideo({ seconds: SECONDS, width: 1280, height: 720 }), seconds: SECONDS })
    const plain = { format: 'mp4', resolution: 720, fps: 30, quality: 'medium', encoder: 'auto' }
    const { app, win } = await launchWith(ctx, home, 'Demo', { settings: plain })

    // F8: Also save → Sound stems writes Voice, System sound, Music and Effects, each exactly 4 s of samples.
    await openSettings(win)
    const stems = win.locator('.modal [data-also="stems"]')
    await stems.scrollIntoViewIfNeeded()
    await stems.click()
    const stemsHint = await win.textContent('.modal [data-testid="stems-hint"]')
    h.assert(/Voice/.test(stemsHint) && /Music/.test(stemsHint), `the hint lists the stems (${stemsHint})`)
    await shot(win, 'output-stems')
    const video = path.join(home, 'Demo.mp4')
    await exportNow(app, win, video)
    const doneText = await win.textContent('.modal')
    await shot(win, 'output-stems-done')
    await closeDialog(win)
    const names = ['Voice', 'System sound', 'Music', 'Effects']
    const files = names.map((n) => path.join(home, `Demo - ${n}.wav`))
    for (const f of files) h.assert(fs.existsSync(f), `${path.basename(f)} is written next to the video (${fs.readdirSync(home).join(', ')})`)
    h.assert(names.every((n) => doneText.includes(`Demo - ${n}.wav`)), 'the done view lists every stem')
    h.assert(!doneText.includes('The recordings the timeline uses'), 'without a timeline, no stem is called a timeline\'s recording')
    const want = SECONDS * RATE
    for (const f of files) {
      const a = audioStreams(f)[0]
      h.assert(a.codec_name === 'pcm_f32le' && Number(a.sample_rate) === RATE, `${path.basename(f)} is float at 48 kHz (${a.codec_name}, ${a.sample_rate})`)
      const n = pcm(f).length / 2
      h.assert(n === want, `${path.basename(f)} is exactly ${want} samples (${n})`)
    }

    // F9 and F8's sum: the WAV format is the same graph's render; the stems add up to it within -90 dBFS.
    const wav = path.join(home, 'Demo-mix.wav')
    await exportWith(app, win, wav, { ...plain, format: 'wav' })
    const wa = audioStreams(wav)[0]
    h.assert(wa.codec_name === 'pcm_f32le', `the WAV format is 32-bit float (${wa.codec_name})`)
    const mix = pcm(wav)
    h.assert(mix.length / 2 === want, `the WAV is the video's length (${mix.length / 2} samples, ${want} expected)`)
    const parts = files.map(pcm)
    let worst = 0
    for (let i = 0; i < mix.length; i++) worst = Math.max(worst, Math.abs(parts.reduce((s, p) => s + p[i], 0) - mix[i]))
    h.assert(dbfs(worst) < -90, `the stems add up to the soundtrack (largest difference ${dbfs(worst).toFixed(1)} dBFS)`)
    // F9: the M4A export's decoded samples match the WAV within AAC's error.
    const m4a = path.join(home, 'Demo-mix.m4a')
    await exportWith(app, win, m4a, { ...plain, format: 'm4a' })
    const aac = pcm(m4a)
    const n = Math.min(aac.length, mix.length)
    let best = 0
    // AAC's priming may shift the decoded samples by a few; the best alignment within 4,096 samples.
    for (let lag = -4096; lag <= 4096; lag += 2) {
      let xy = 0
      let xx = 0
      let yy = 0
      for (let i = Math.max(0, -lag); i < n && i + lag < n; i += 8) {
        const x = mix[i]
        const y = aac[i + lag]
        xy += x * y
        xx += x * x
        yy += y * y
      }
      best = Math.max(best, xy / Math.sqrt(xx * yy || 1))
    }
    h.assert(best >= 0.999, `the WAV equals the M4A's sound (correlation ${best.toFixed(5)})`)

    // With M4A, stems are offered and Timeline says why it is off.
    await win.evaluate(() => localStorage.setItem('export-settings', JSON.stringify({ format: 'm4a', resolution: 720, fps: 30, quality: 'medium', encoder: 'auto' })))
    await openSettings(win)
    h.assert(!(await win.isDisabled('.modal [data-also="stems"]')), 'stems are offered with M4A')
    h.assert(await win.isDisabled('.modal [data-also="timeline"]'), 'Timeline is off with M4A')
    h.assert((await win.textContent('.modal [data-testid="also-save-reasons"]')).includes('Timelines need a video'), 'and says why')
    await closeDialog(win)
    await offline(app)
    await app.close()
    ctx.app = null

    // A silent project shows why there are no stems.
    const silent = await launchWith(ctx, home, 'Silent', { settings: plain })
    await openSettings(silent.win)
    h.assert(await silent.win.isDisabled('.modal [data-also="stems"]'), 'a silent project offers no stems')
    const reasons = await silent.win.textContent('.modal [data-testid="also-save-reasons"]')
    h.assert(reasons.length > 0, `with its reason (${reasons})`)
    await offline(silent.app)
  }))

  await test('output formats: timelines over this export and over the original recordings (F10, F11, F14)', fx.withHome('of-timelines', async (ctx, home) => {
    const { dir } = seedDemo(home, { camera: true, clips: [{ id: 'a', start: 0, end: 2, speed: 1 }, { id: 'b', start: 2, end: SECONDS, speed: 2 }] })
    const plain = { format: 'mp4', resolution: 720, fps: 30, quality: 'medium', encoder: 'auto' }
    const { app, win } = await launchWith(ctx, home, 'Demo', { settings: plain })

    // F10: This export, for Resolve, Premiere and another editor, with stems.
    const exportTimelines = async (folder, withStems) => {
      fs.mkdirSync(folder, { recursive: true })
      await win.evaluate((s) => localStorage.setItem('export-bundle', JSON.stringify({ srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, timelines: ['resolve', 'premiere', 'edl'], ...(s ? { stems: true } : {}) })), withStems)
      await openSettings(win)
      await shot(win, withStems ? 'output-timeline' : 'output-timeline-nostems')
      const video = path.join(folder, 'Demo.mp4')
      await exportNow(app, win, video)
      const text = await win.textContent('.modal')
      if (withStems) await shot(win, 'output-timeline-done')
      await closeDialog(win)
      return { video, text }
    }
    const withStems = await exportTimelines(path.join(home, 'with'), true)
    const folder = path.dirname(withStems.video)
    for (const f of ['Demo.fcpxml', 'Demo.xml', 'Demo.edl', 'Demo - Resolve markers.edl']) h.assert(fs.existsSync(path.join(folder, f)), `${f} is written next to the video (${fs.readdirSync(folder).join(', ')})`)
    const fcpxml = fs.readFileSync(path.join(folder, 'Demo.fcpxml'), 'utf8')
    const xmeml = fs.readFileSync(path.join(folder, 'Demo.xml'), 'utf8')
    const url = (p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`
    h.assert(fcpxml.includes(url(withStems.video)) && fcpxml.includes(url(path.join(folder, 'Demo - Voice.wav'))), 'the FCPXML names the video and the stems by absolute path')
    h.assert(xmeml.includes(withStems.video.split('/').map(encodeURIComponent).join('/')) && xmeml.includes('Demo%20-%20Voice.wav'), 'the Premiere XML names the video and the stems by absolute path')
    h.assert(/srcEnable="video"/.test(fcpxml), 'with stems, V1 plays the picture only')
    // FCPXML times are whole-frame fractions ("60/30s").
    const seconds = (t) => (t.includes('/') ? Number(t.split('/')[0]) / Number(t.split('/')[1].replace('s', '')) : Number(t.replace('s', '')))
    const chapters = [...fcpxml.matchAll(/<chapter-marker start="([^"]+)"[^>]*value="([^"]+)"/g)].map((m) => `${m[2]}@${seconds(m[1])}`)
    h.assert(chapters.join() === 'Start@0,Settings@2', `the chapters are chapter markers at 0 and 2 s (${chapters})`)
    const markers = fs.readFileSync(path.join(folder, 'Demo - Resolve markers.edl'), 'utf8')
    h.assert(markers.includes('Start') && markers.includes('Settings'), 'the marker EDL holds the chapters')
    for (const line of ['In DaVinci Resolve: File › Import › Timeline…', 'In Premiere Pro: File › Import…', 'In your editor: import the EDL and link it to Demo.mp4']) h.assert(withStems.text.includes(line), `the done view says how to open each file (${line})`)
    const without = await exportTimelines(path.join(home, 'without'), false)
    const plainFcpxml = fs.readFileSync(path.join(path.dirname(without.video), 'Demo.fcpxml'), 'utf8')
    h.assert(!/srcEnable="video"/.test(plainFcpxml), 'without stems, V1 keeps its sound')

    // F11: The original recordings: copies and WAVs in "<base> media", the camera turned off, the 2× clip retimed.
    const project = folderState(dir)
    await win.evaluate(() => localStorage.setItem('export-bundle', JSON.stringify({ srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, timelines: ['resolve'], timelineMedia: 'recordings' })))
    await openSettings(win)
    h.assert(await win.isDisabled('.modal [data-editor="edl"]'), 'the EDL chip is off for the recordings')
    h.assert((await win.textContent('.modal [data-testid="editor-blocked-edl"]')).length > 0, 'with its reason')
    await shot(win, 'output-timeline-recordings')
    const recFolder = path.join(home, 'recordings')
    fs.mkdirSync(recFolder)
    const recVideo = path.join(recFolder, 'Demo.mp4')
    await exportNow(app, win, recVideo)
    const recDone = await win.textContent('.modal')
    h.assert(recDone.split('The recordings the timeline uses').length === 2 && recDone.includes('Demo media'), `the done view says what the media folder is for, once (${recDone})`)
    await closeDialog(win)
    const media = path.join(recFolder, 'Demo media')
    h.assert(fs.existsSync(media), `the recordings are copied into "Demo media" (${fs.readdirSync(recFolder).join(', ')})`)
    const copies = fs.readdirSync(media)
    const screen = copies.find((f) => /^screen\.mp4$/i.test(f))
    h.assert(screen, `the screen recording is copied (${copies.join(', ')})`)
    h.assert(audioStreams(path.join(media, screen)).length === 0, 'the screen copy has no sound')
    h.assert(copies.some((f) => /\.wav$/i.test(f)), `the sound is copied as WAV (${copies.join(', ')})`)
    const rec = fs.readFileSync(path.join(recFolder, 'Demo.fcpxml'), 'utf8')
    h.assert(/<timeMap>/.test(rec), 'the 2× clip has a timeMap')
    // V2 is the first lane above the spine in FCPXML.
    const camera = [...rec.matchAll(/<asset-clip [^>]*name="Camera"[^>]*>/g)].map((m) => m[0])
    h.assert(camera.length > 0 && camera.every((c) => /lane="1"/.test(c) && /enabled="0"/.test(c)), `the camera clips are on V2, turned off (${camera.join(' ')})`)
    h.assert(/<format [^>]*width="1280" height="720"/.test(rec), 'the sequence is the screen recording\'s size')
    h.assert(JSON.stringify(folderState(dir)) === JSON.stringify(project), 'the project folder is unchanged, bytes and times')
    await offline(app)
  }))

  await test('output formats: Export while the HEVC check runs says so, and exports the settings shown when it ends (F2)', fx.withHome('of-checking', async (ctx, home) => {
    seedDemo(home)
    const { app, win } = await launchWith(ctx, home, 'Demo', { settings: { format: 'mp4', resolution: 1080, fps: 30, quality: 'medium', encoder: 'auto', codec: 'hevc' } })
    // The HEVC probe answers only when told to (on a real PC it is up to four test encodes); it finds nothing.
    await app.evaluate(({ ipcMain, dialog }, target) => {
      globalThis.__saves = 0
      dialog.showSaveDialog = async () => {
        globalThis.__saves++
        return { canceled: false, filePath: target }
      }
      ipcMain.removeHandler('export:probeCodec')
      ipcMain.handle('export:probeCodec', () => new Promise((resolve) => (globalThis.__probeDone = () => resolve([]))))
    }, path.join(home, 'checked.mp4'))
    await openSettings(win)
    const button = win.locator('.modal .modal-foot button.primary')
    // From the keyboard, so the button keeps the focus (a clicked button hands it back to the editor).
    await button.focus()
    await win.keyboard.press('Enter')
    await win.waitForSelector('.modal .modal-foot button.primary[aria-busy="true"]')
    h.assert((await button.textContent()).trim() === 'Checking this PC…', `the Export button says the wait (${await button.textContent()})`)
    h.assert((await win.textContent('.modal .modal-foot [role="status"]')) === 'Checking this PC…', 'and screen readers hear it')
    h.assert(await win.evaluate(() => !!document.activeElement?.matches('.modal-foot button.primary')), 'the button keeps the focus')
    // A setting changed meanwhile is the one exported; a second press starts nothing more.
    await fx.pickChip(win, 'Resolution', '720p')
    await button.focus()
    await win.keyboard.press('Enter')
    await h.sleep(300)
    h.assert((await app.evaluate(() => globalThis.__saves)) === 0, 'no save dialog before the check ends')
    await app.evaluate(() => globalThis.__probeDone())
    const r = await fx.waitForExport(win)
    h.assert(r.ok, `the export finished: ${r.text}`)
    h.assert((await app.evaluate(() => globalThis.__saves)) === 1, 'one save dialog')
    const v = videoOf(path.join(home, 'checked.mp4'))
    h.assert(v.codec_name === 'h264' && v.height === 720, `H.264 at 720p, as the dialog showed when the check ended (${v.codec_name}, ${v.height})`)
    await closeDialog(win)
    await offline(app)
  }))
}

main()
