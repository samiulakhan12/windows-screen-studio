/**
 * Smart tools' recordings for the end-to-end runs (docs/design/smart-tools.md §22.3 fixtures):
 * *Secret*, 40 s at 60 fps of three solid "pages" (A 0–12 s with a red label, B 12–26 s with a
 * dialog at 18–20 s and a text field typed into from 21 s, C after), its cursor.json (clicks at 3,
 * 8 double, 16.5 a drag, 20.5 then typing 21–23, 24.5, Ctrl + S at 30, Enter at 31) and its
 * narration; *Silent* is the same video without words. Used by guides.e2e.cjs and
 * smart-tools.e2e.cjs.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const { MEDIA_CACHE } = require('./render-fixtures.cjs')

const W = 1280
const H = 720
const SECONDS = 40

/** The recording: page A (grey, a red label) 0–12 s, page B (blue, a text field typed into from 21 s) 12–26 s, page C (green) after. */
function makeSecretVideo(file) {
  const filter = [
    `color=c=0x707070:s=${W}x${H}:r=60:d=${SECONDS}`,
    "drawbox=x=560:y=330:w=160:h=60:color=red:t=fill:enable='lt(t,12)'",
    // Letters of the label: grey strokes across it, so a pixelated label shows no pure red.
    ...Array.from({ length: 20 }, (_, i) => `drawbox=x=${564 + 8 * i}:y=330:w=4:h=60:color=0x707070:t=fill:enable='lt(t,12)'`),
    "drawbox=x=0:y=0:w=1280:h=720:color=0x3050a0:t=fill:enable='between(t,12,26)'",
    "drawbox=x=440:y=200:w=400:h=260:color=0xe0e0e0:t=fill:enable='between(t,18,20)'",
    "drawbox=x=480:y=410:w=320:h=44:color=white:t=fill:enable='between(t,12,26)'",
    "drawbox=x=490:y=420:w=260:h=24:color=black:t=fill:enable='between(t,21,26)'",
    "drawbox=x=0:y=0:w=1280:h=720:color=0x40a040:t=fill:enable='gte(t,26)'"
  ].join(',')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: 'inherit' })
}

/** The Secret video, made once and kept in the e2e media cache. */
function secretVideo() {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, 'smart-secret-40s.mp4')
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/\.mp4$/, '.part.mp4')
  makeSecretVideo(tmp)
  fs.renameSync(tmp, file)
  return file
}

/** Words of `text` spread evenly over start–end. */
const words = (start, end, text) => {
  const parts = text.split(' ')
  const d = (end - start) / parts.length
  return parts.map((w, i) => ({ text: w, start: +(start + i * d).toFixed(3), end: +(start + (i + 1) * d - 0.02).toFixed(3) }))
}

/** The narration of Secret (§22.3), in English or in Bangla. */
const LINES = {
  en: [
    [2.2, 3.4, 'Now click the Export button'],
    [12.4, 13.6, 'Next we open settings'],
    [26.4, 27.4, 'Finally save it']
  ],
  bn: [
    [2.2, 3.4, 'এখন রপ্তানি বোতামে ক্লিক করুন'],
    [12.4, 13.6, 'এরপর আমরা সেটিংস খুলব'],
    [26.4, 27.4, 'শেষে এটি সংরক্ষণ করুন']
  ]
}

function transcriptOf(language) {
  return {
    language,
    provider: 'local',
    model: 'test',
    createdAt: '2026-11-07T12:00:00.000Z',
    segments: LINES[language].map(([start, end, text], i) => ({ id: `s${i + 1}`, start, end, text, words: words(start, end, text) }))
  }
}

/** Secret's cursor.json: the clicks, the drag, the typing and the two keys of §22.3. */
function secretCursor() {
  const samples = []
  for (let t = 0; t <= SECONDS; t += 1 / 30) {
    let x = 0.5
    let y = 0.5
    if (t >= 16.4 && t <= 17.2) {
      const k = Math.min(1, (t - 16.5) / 0.5)
      x = 0.3 + 0.3 * Math.max(0, k)
      y = 0.3 + 0.2 * Math.max(0, k)
    } else if (t > 17.2 && t < 20) {
      x = 0.6
      y = 0.5
    } else if (t >= 20 && t < 24) {
      x = 0.4
      y = 0.6
    } else if (t >= 24) {
      x = 0.45
      y = 0.6
    }
    samples.push({ t: +t.toFixed(4), x, y })
  }
  return {
    samples,
    clicks: [
      { t: 3, x: 0.5, y: 0.5, button: 'left' },
      { t: 8, x: 0.7, y: 0.3, button: 'left' },
      { t: 8.2, x: 0.7, y: 0.3, button: 'left' },
      { t: 16.5, x: 0.3, y: 0.3, button: 'left', up: 17.0 },
      { t: 20.5, x: 0.4, y: 0.6, button: 'left' },
      { t: 24.5, x: 0.45, y: 0.6, button: 'left' }
    ],
    keys: [
      { t: 30, label: 'Ctrl + S' },
      { t: 31, label: 'Enter' }
    ],
    typing: [{ t: 21, end: 23 }],
    shapes: [],
    scale: 1,
    valid: true
  }
}

/**
 * Seeds Secret into `home`: `language` 'en' (default) or 'bn' narrates it, null leaves it silent
 * (*Silent*). The pixelate shape over the red label (0–12 s) is there unless `pixelate` is false.
 */
function seedSecret(home, { id = 'rec-guide', name = 'Secret', language = 'en', pixelate = true } = {}) {
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(secretVideo(), path.join(dir, 'screen.mp4'))
  const project = {
    version: 2,
    id,
    name,
    createdAt: '2026-11-07T12:00:00.000Z',
    duration: SECONDS,
    width: W,
    height: H,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 },
    clips: [{ id: 'c0', start: 0, end: SECONDS, speed: 1 }],
    zooms: [],
    autoZoom: false,
    annotations: [],
    shapes: pixelate ? [{ id: 'px1', kind: 'pixelate', start: 0, end: 12, x: 0.4, y: 0.4, w: 0.2, h: 0.2, color: '#000000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.6 }] : [],
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' },
    cursor: { show: true, size: 1.4, smoothing: 0.6, clickEffect: true, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    ...(language ? { transcript: transcriptOf(language) } : {})
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify(secretCursor()))
  return id
}

/** With SSW_E2E_DOC_SHOTS set: pictures for the docs, docs/screenshots/smart-tools-<name>.png, each under 300 KB. */
const DOC_SHOTS = process.env.SSW_E2E_DOC_SHOTS ? path.join(h.APP_DIR, 'docs', 'screenshots') : null

/** Saves a PNG of `locator` (or the window) as docs/screenshots/smart-tools-<name>.png, scaled down until under 300 KB. */
async function docShot(win, name, locator = null) {
  if (!DOC_SHOTS) return
  fs.mkdirSync(DOC_SHOTS, { recursive: true })
  const file = path.join(DOC_SHOTS, `smart-tools-${name}.png`)
  const raw = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-shot-')), `${name}.png`)
  if (locator) await locator.screenshot({ path: raw })
  else await win.screenshot({ path: raw })
  try {
    for (const width of [0, 1400, 1100, 900, 700]) {
      if (width) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', `scale='min(${width},iw)':-1:flags=lanczos`, '-pix_fmt', 'rgb24', file])
      else fs.copyFileSync(raw, file)
      if (fs.statSync(file).size < 300 * 1024) return
    }
    throw new Error(`${file} is over 300 KB`)
  } finally {
    fs.rmSync(path.dirname(raw), { recursive: true, force: true })
  }
}

module.exports = { docShot, W, H, SECONDS, makeSecretVideo, secretVideo, seedSecret, secretCursor, transcriptOf, LINES }
