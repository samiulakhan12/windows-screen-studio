/**
 * Seeds editor projects straight into a test HOME (a project folder with a
 * project.json, cursor.json and an ffmpeg-generated screen.mp4), so editor
 * tests do not depend on screen capture working under Xvfb.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')

const MEDIA_CACHE = path.join(os.tmpdir(), 'ssw-e2e-media')

/** Test-pattern video (optionally with a tone), cached between runs. */
function makeVideo({ seconds, width = 1280, height = 720, fps = 60, audio = false }) {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, `v-${seconds}s-${width}x${height}-${fps}${audio ? '-a' : ''}.mp4`)
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
      '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '96k'] : []),
      '-movflags', '+faststart',
      tmp
    ],
    { stdio: 'inherit' }
  )
  fs.renameSync(tmp, file)
  return file
}

function cursorTrack(seconds, clicks = []) {
  const samples = []
  for (let t = 0; t <= seconds; t += 1 / 30) samples.push({ t: +t.toFixed(4), x: 0.5 + 0.3 * Math.sin(t), y: 0.5 + 0.3 * Math.cos(t * 0.7) })
  return { samples, clicks, keys: [], shapes: [], scale: 1, valid: true }
}

/** Writes a v2 project folder into `home` and returns its id. */
function seedProject(home, opts) {
  const { id = 'rec-e2e', name = 'Seeded', seconds = 12, width = 1280, height = 720, fps = 60, audio = false } = opts
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  const media = makeVideo({ seconds, width, height, fps, audio })
  fs.symlinkSync(media, path.join(dir, 'screen.mp4'))
  if (opts.webcam) fs.symlinkSync(makeVideo({ seconds, width: 320, height: 240, fps: 30 }), path.join(dir, 'webcam.mp4'))
  const project = {
    version: 2,
    id,
    name,
    createdAt: new Date(Date.now() - (opts.ageMs || 0)).toISOString(),
    duration: seconds,
    width,
    height,
    hasWebcam: !!opts.webcam,
    hasAudio: audio,
    webcamOffset: 0,
    capture: opts.capture || { method: 'chromium', cursorInVideo: true, region: null },
    clips: opts.clips || [{ id: 'c0', start: 0, end: seconds, speed: 1 }],
    zooms: opts.zooms || [],
    autoZoom: true,
    annotations: opts.annotations || [],
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' },
    cursor: { show: false, size: 1.4, smoothing: 0.6, clickEffect: true, hideWhenIdle: true },
    webcam: { show: !!opts.webcam, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0.5, keystrokes: { show: true, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false }
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify(opts.cursor || cursorTrack(seconds, opts.clicks || [])))
  return id
}

/** Opens a seeded project from the Home library and waits for the editor preview. */
async function openProject(win, name) {
  await win.waitForSelector(`.project-open:has-text("${name}")`, { timeout: 30000 })
  await win.click(`.project-open:has-text("${name}")`)
  await win.waitForSelector('.editor .preview-canvas', { timeout: 30000 })
  // First frame drawn and save state settled.
  await h.sleep(800)
}

/** Polls `fn` until it returns a truthy value (or throws after `timeout` ms). */
async function waitFor(fn, message, timeout = 8000) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    last = await fn()
    if (last) return last
    await h.sleep(100)
  }
  throw new Error(`Timed out waiting for ${message} (last: ${JSON.stringify(last)})`)
}

const ffprobeDuration = (file) =>
  parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString())

const ffprobeFrames = (file) =>
  parseInt(
    execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).toString(),
    10
  )

module.exports = { makeVideo, cursorTrack, seedProject, openProject, waitFor, ffprobeDuration, ffprobeFrames }
