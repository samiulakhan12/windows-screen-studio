/**
 * Fixtures for the export/render e2e tests: frame-indexed test videos (the frame
 * number is drawn as 12 black/white boxes in the top quarter of every frame, so a
 * decoded export frame tells exactly which source frame it shows), optional
 * once-per-second tone bursts, and seeded v2 project folders.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const h = require('./helpers.cjs')

const MEDIA_CACHE = path.join(os.tmpdir(), 'ssw-e2e-render-media')
const BITS = 12

/**
 * 60 fps CFR H.264 (like the app's proxies) whose top quarter encodes the frame
 * index. With `beeps`, a 1 kHz tone plays for 100 ms at the start of every second.
 */
function indexedVideo({ seconds, width = 1280, height = 720, fps = 60, beeps = false }) {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, `idx-${seconds}s-${width}x${height}-${fps}${beeps ? '-beep' : ''}.mp4`)
  if (fs.existsSync(file)) return file
  const bw = Math.floor(width / BITS)
  const bh = Math.floor(height / 4)
  const boxes = []
  for (let b = 0; b < BITS; b++) {
    boxes.push(`drawbox=x=${b * bw}:y=0:w=${bw}:h=${bh}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** b}),2),1)'`)
  }
  const vf = [`drawbox=x=0:y=0:w=iw:h=${bh}:color=black:t=fill`, ...boxes].join(',')
  const tmp = `${file}.part.mp4`
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
      ...(beeps ? ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000'] : []),
      '-t', String(seconds),
      '-vf', vf,
      ...(beeps ? ['-af', "volume='if(lt(mod(t,1),0.1),1,0)':eval=frame"] : []),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
      ...(beeps ? ['-c:a', 'aac', '-b:a', '128k'] : []),
      '-movflags', '+faststart',
      tmp
    ],
    { stdio: 'inherit' }
  )
  fs.renameSync(tmp, file)
  return file
}

/** Frame codes of every frame of `file`, reading the boxes inside `rect` (output pixels). */
function decodeIndices(file, rect) {
  const { x, y, w, h: rh } = rect
  const out = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `crop=${w}:${rh}:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 30 }
  ).stdout
  const size = w * rh
  const codes = []
  const row = Math.floor(rh / 8)
  for (let f = 0; f + size <= out.length; f += size) {
    let code = 0
    for (let b = 0; b < BITS; b++) {
      const px = Math.floor((w / BITS) * (b + 0.5))
      if (out[f + row * w + px] > 128) code |= 1 << b
    }
    codes.push(code)
  }
  return codes
}

/** Onset times (seconds) of tone bursts in the first audio stream of `file`. */
function beepOnsets(file, threshold = 0.1) {
  const rate = 8000
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30
  }).stdout
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4))
  const win = rate / 200
  const onsets = []
  let on = false
  for (let i = 0; i + win <= samples.length; i += win) {
    let peak = 0
    for (let j = i; j < i + win; j++) peak = Math.max(peak, Math.abs(samples[j]))
    if (!on && peak > threshold) {
      onsets.push(i / rate)
      on = true
    } else if (on && peak < threshold / 4) {
      on = false
    }
  }
  return { onsets, duration: samples.length / rate }
}

function probe(file) {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration,color_space,color_primaries,color_transfer,color_range,pix_fmt:format=duration', '-count_frames', '-of', 'json', file]).toString()
  )
}

/** Writes a v2 project folder into `home` and returns its id. */
function seedProject(home, opts) {
  const { id = 'rec-render', name = 'Render test', seconds, width = 1280, height = 720 } = opts
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(opts.media, path.join(dir, 'screen.mp4'))
  const project = {
    version: 2,
    id,
    name,
    createdAt: new Date().toISOString(),
    duration: seconds,
    width,
    height,
    hasWebcam: false,
    hasAudio: !!opts.audio,
    webcamOffset: 0,
    capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: opts.clips || [{ id: 'c0', start: 0, end: seconds, speed: 1 }],
    zooms: opts.zooms || [],
    autoZoom: false,
    annotations: opts.annotations || [],
    style: opts.style || { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: opts.cursorSettings || { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: opts.effects || { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: opts.audioSettings || { volume: 1, muted: false }
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify(opts.cursor || { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }))
  return id
}

/** Opens a project from the Home library and waits for the editor preview. */
async function openProject(win, name) {
  await win.waitForSelector(`.project-open:has-text("${name}")`, { timeout: 30000 })
  await win.click(`.project-open:has-text("${name}")`)
  await win.waitForSelector('.editor canvas', { timeout: 60000 })
  await h.sleep(800)
}

/** Opens the export dialog of the open editor. */
async function openExportDialog(win) {
  await win.click('header button.primary:has-text("Export")')
  await win.waitForSelector('.modal[aria-label="Export"]')
}

/** Clicks the chip with exactly `label` inside the export dialog row `row`. */
async function pickChip(win, row, label) {
  const chip = win.locator(`.modal .form-row:has(> span:text-is("${row}")) .chip`, { hasText: label }).first()
  await chip.click()
}

/** Waits for the dialog to reach done/error; returns { ok, text, seconds }. */
async function waitForExport(win, timeout = 600000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const text = (await win.textContent('.modal').catch(() => '')) || ''
    if (/Export finished/.test(text)) return { ok: true, text, seconds: (Date.now() - t0) / 1000 }
    if (/Export failed/.test(text)) return { ok: false, text, seconds: (Date.now() - t0) / 1000 }
    await h.sleep(200)
  }
  throw new Error('export timed out')
}

module.exports = { indexedVideo, decodeIndices, beepOnsets, probe, seedProject, openProject, openExportDialog, pickChip, waitForExport, MEDIA_CACHE }
