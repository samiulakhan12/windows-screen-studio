// Camera fixtures shared by the camera end-to-end tests (camera.e2e.cjs, camera-director.e2e.cjs):
// a synthetic person the bundled segmentation model recognises, drawn by the app and turned into a
// camera video with ffmpeg (cached in the media cache).
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

/* ---------- the camera fixture: a person the segmentation model recognises ---------- */

/**
 * Draws a person (hair, face with eyes, brows, nose and mouth, neck, shoulders in a dark shirt) in
 * front of a detailed background of fine stripes, with a red marker left of the person and a
 * blue one right of it (mirroring swaps them). `cx`: where the person stands across the picture
 * (0..1, default the middle); `markers: false` leaves the markers out. Runs in the app's page;
 * returns a PNG data URL.
 */
function drawPerson(W, H, opts = {}) {
  const at = opts.cx ?? 0.5
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  for (let x = 0; x < W; x += 4) {
    g.fillStyle = (x / 4) % 2 ? '#e8e2d0' : '#4a5a78'
    g.fillRect(x, 0, 4, H)
  }
  for (let y = 0; y < H; y += H / 6) {
    g.fillStyle = '#3b2a1a'
    g.fillRect(0, y, W, H * 0.02)
  }
  if (opts.markers !== false) {
    g.fillStyle = '#ff0000'
    g.fillRect(W * (at - 0.25), H * 0.4, W * 0.11, H * 0.16)
    g.fillStyle = '#0000ff'
    g.fillRect(W * (at + 0.14), H * 0.4, W * 0.11, H * 0.16)
  }
  const cx = W * at
  const S = H
  const ellipse = (x, y, rx, ry, color, a0 = 0, a1 = Math.PI * 2) => {
    g.fillStyle = color
    g.beginPath()
    g.ellipse(x, y, rx, ry, 0, a0, a1)
    g.fill()
  }
  // Shoulders in a dark shirt: from the base of the neck down the slope of the shoulders to round
  // shoulder tips, then the arms. The segmentation model takes this for the person, as it does a
  // real person's clothes (a flat green shirt on the stripes passed for background: the mask
  // was a head on a neck, which no real camera gives).
  g.save()
  g.beginPath()
  g.moveTo(cx - S * 0.4, H)
  g.lineTo(cx - S * 0.39, H * 0.78)
  g.quadraticCurveTo(cx - S * 0.38, H * 0.7, cx - S * 0.3, H * 0.675)
  g.quadraticCurveTo(cx - S * 0.15, H * 0.64, cx - S * 0.09, H * 0.6)
  g.lineTo(cx + S * 0.09, H * 0.6)
  g.quadraticCurveTo(cx + S * 0.15, H * 0.64, cx + S * 0.3, H * 0.675)
  g.quadraticCurveTo(cx + S * 0.38, H * 0.7, cx + S * 0.39, H * 0.78)
  g.lineTo(cx + S * 0.4, H)
  g.closePath()
  g.fillStyle = '#1f2a44'
  g.fill()
  g.clip()
  g.fillStyle = 'rgba(0, 0, 0, 0.18)'
  for (const s of [-1, 1]) g.fillRect(cx + s * S * 0.34 - S * 0.06, H * 0.76, S * 0.12, H * 0.24)
  g.fillStyle = '#d9a37e'
  g.beginPath()
  g.moveTo(cx - S * 0.09, H * 0.6)
  g.lineTo(cx, H * 0.72)
  g.lineTo(cx + S * 0.09, H * 0.6)
  g.closePath()
  g.fill()
  g.restore()
  g.fillStyle = '#d9a37e'
  g.fillRect(cx - S * 0.06, H * 0.5, S * 0.12, H * 0.16)
  ellipse(cx, H * 0.33, S * 0.17, H * 0.21, '#2b1a10')
  ellipse(cx, H * 0.37, S * 0.14, H * 0.18, '#e8b896')
  ellipse(cx, H * 0.22, S * 0.15, H * 0.08, '#2b1a10', Math.PI, 0)
  for (const s of [-1, 1]) {
    ellipse(cx + s * S * 0.055, H * 0.34, S * 0.025, H * 0.014, '#ffffff')
    ellipse(cx + s * S * 0.055, H * 0.34, S * 0.011, S * 0.011, '#3a2412')
    ellipse(cx + s * S * 0.14, H * 0.37, S * 0.02, H * 0.035, '#dca582')
  }
  g.strokeStyle = '#2b1a10'
  g.lineWidth = S * 0.012
  for (const s of [-1, 1]) {
    g.beginPath()
    g.moveTo(cx + s * S * 0.03, H * 0.305)
    g.lineTo(cx + s * S * 0.085, H * 0.3)
    g.stroke()
  }
  g.strokeStyle = '#b07a5a'
  g.lineWidth = S * 0.008
  g.beginPath()
  g.moveTo(cx, H * 0.35)
  g.lineTo(cx - S * 0.012, H * 0.41)
  g.lineTo(cx + S * 0.01, H * 0.415)
  g.stroke()
  g.strokeStyle = '#a0464a'
  g.lineWidth = S * 0.012
  g.beginPath()
  g.arc(cx, H * 0.43, S * 0.04, 0.2, Math.PI - 0.2)
  g.stroke()
  return c.toDataURL('image/png')
}

/**
 * A 640x360 30 fps camera video of the person (drawn once by the app, then cached), standing at
 * `cx` across the picture (default the middle), with the markers unless `markers` is false.
 */
async function personVideo(seconds, { cx = 0.5, markers = true } = {}) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  // A new name whenever the drawing changes, so no earlier run's cached video is used.
  const variant = cx === 0.5 && markers ? 'person-v4' : `person-v4-cx${cx}${markers ? '' : '-plain'}`
  const file = path.join(fx.MEDIA_CACHE, `${variant}-640x360-30-${seconds}s.mp4`)
  if (fs.existsSync(file)) return file
  const png = path.join(fx.MEDIA_CACHE, `${variant}.png`)
  if (!fs.existsSync(png)) {
    const home = h.tempHome('camera-fixture')
    const { app, win } = await h.launch({ home })
    try {
      const url = await win.evaluate(`(${drawPerson.toString()})(640, 360, ${JSON.stringify({ cx, markers })})`)
      fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'))
    } finally {
      await app.close().catch(() => undefined)
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', png, '-t', String(seconds), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '15', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp])
  fs.renameSync(tmp, file)
  return file
}

module.exports = { drawPerson, personVideo }
