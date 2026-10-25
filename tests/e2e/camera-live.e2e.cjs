// The live camera bubble and the recording bar, in the real built app with Chromium's fake camera
// and microphone: while recording, the camera shows live in a small always-on-top bubble window
// (content protection requested, its own video playing) that the recorder's page fills with the
// stream it already records (the camera is opened once); dragging the bubble with real X input
// snaps it into corners, and those moves (one while paused) become camera corners on the saved
// project's layout track at the right times, which the export draws there (measured on exported
// frames); the bubble hides and shows from the bar (its timer keeps counting); the bar's and the
// bubble's pages paint no background; the bar's pause/resume, mute, restart and discard (both
// confirmed) work, and a restarted take that cannot be prepared brings the app back; with "Camera follows the preview bubble" off nothing moves; and
// the Camera panel's camera position (a change's corner, "Move camera here from the playhead",
// undo).
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const OUT_W = 1280
const OUT_H = 720

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** A window manager, so frameless windows move and stack as on a desktop (exits at once if one runs). */
function startWindowManager() {
  const wm = spawn('openbox', [], { stdio: 'ignore' })
  wm.on('error', () => undefined)
  return wm
}

/** Presses the left button at (x0, y0), moves to (x1, y1) and releases it: real X input (XTest). */
const DRAG_PY = `
import ctypes, sys, time
x11 = ctypes.cdll.LoadLibrary('libX11.so.6'); xtst = ctypes.cdll.LoadLibrary('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
d = ctypes.c_void_p(x11.XOpenDisplay(None))
def move(x, y):
    xtst.XTestFakeMotionEvent(d, -1, int(x), int(y), 0); x11.XFlush(d)
x0, y0, x1, y1 = [float(v) for v in sys.argv[1:5]]
move(x0, y0); time.sleep(0.08)
xtst.XTestFakeButtonEvent(d, 1, 1, 0); x11.XFlush(d); time.sleep(0.08)
for i in range(1, 25):
    move(x0 + (x1 - x0) * i / 24, y0 + (y1 - y0) * i / 24); time.sleep(0.016)
time.sleep(0.08)
xtst.XTestFakeButtonEvent(d, 1, 0, 0); x11.XFlush(d)
x11.XCloseDisplay(d)
`

function xDrag(from, to) {
  const res = spawnSync('python3', ['-I', '-c', DRAG_PY, String(from.x), String(from.y), String(to.x), String(to.y)], { stdio: 'inherit' })
  h.assert(res.status === 0, 'X drag ran')
}

/** The bubble window's state in the main process (null when there is none). */
function bubbleWindow(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL() === 'about:blank')
    return w ? { id: w.id, visible: w.isVisible(), onTop: w.isAlwaysOnTop(), focusable: w.isFocusable(), bounds: w.getBounds() } : null
  })
}

/** The bubble's page (about:blank, filled by the recorder's page). */
const bubblePage = (app) => r.until(() => app.windows().find((p) => p.url() === 'about:blank'), { what: 'camera bubble page' })

/** Drags the bubble from its centre to (x, y) and waits until it has settled in `corner`. */
async function dragBubbleTo(app, point, corner) {
  const b = (await bubbleWindow(app)).bounds
  xDrag({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, point)
  const display = { width: 1920, height: 1080 }
  return r.until(
    async () => {
      const now = (await bubbleWindow(app))?.bounds
      if (!now) return null
      const left = now.x < display.width / 2
      const top = now.y < display.height / 2
      const at = `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}`
      // Settled: in the corner, inside the margin.
      const inCorner = (left ? now.x === 24 : now.x + now.width === display.width - 24) && (top ? now.y === 24 : now.y + now.height <= display.height - 24)
      return at === corner && inCorner ? now : null
    },
    { what: `bubble in the ${corner} corner`, timeout: 5000 }
  )
}

/** Counts getUserMedia calls of the recorder's page from now on (video ones separately). */
function countCameraOpens(win) {
  return win.evaluate(() => {
    const md = navigator.mediaDevices
    const original = md.getUserMedia.bind(md)
    window.__gum = { video: 0, audio: 0 }
    md.getUserMedia = (c) => {
      if (c && c.video) window.__gum.video++
      else window.__gum.audio++
      return original(c)
    }
  })
}

/** Records which windows content protection was asked for. */
function watchContentProtection(app) {
  return app.evaluate(({ BrowserWindow }) => {
    globalThis.__protected = []
    const original = BrowserWindow.prototype.setContentProtection
    BrowserWindow.prototype.setContentProtection = function (on) {
      globalThis.__protected.push({ id: this.id, on })
      return original.call(this, on)
    }
  })
}

async function pickDevices(win) {
  const selects = await win.$$('.record-panel select')
  await selects[0].selectOption({ index: 1 })
  await selects[1].selectOption({ index: 1 })
}

/* ---------- measuring exported frames ---------- */

const isCameraGreen = ([r, g, b]) => g > 90 && r < 90 && b < 90 && g - r > 50
/**
 * Share of fake-camera green in the part of each corner's camera bubble that lies in the padding
 * beside the recording (layout.ts webcamRect at the default size; the recording is fitted inside
 * the 0.07 padding, 89.6 px from the sides at 720p), so the recorded screen (which shows the
 * bubble window too: Linux has no capture exclusion) cannot be mistaken for the camera.
 */
function cornerShares(buf) {
  const size = Math.min(OUT_W, OUT_H) * 0.24
  const m = Math.min(OUT_W, OUT_H) * 0.04
  const strips = {
    'top-left': { x: m + 10, y: m + size / 2 - 25, w: 48, h: 50 },
    'top-right': { x: OUT_W - m - 58, y: m + size / 2 - 25, w: 48, h: 50 },
    'bottom-left': { x: m + 10, y: OUT_H - m - size / 2 - 25, w: 48, h: 50 },
    'bottom-right': { x: OUT_W - m - 58, y: OUT_H - m - size / 2 - 25, w: 48, h: 50 }
  }
  const out = {}
  for (const [corner, s] of Object.entries(strips)) {
    let n = 0
    let all = 0
    for (let y = Math.round(s.y); y < Math.round(s.y + s.h); y++) {
      for (let x = Math.round(s.x); x < Math.round(s.x + s.w); x++) {
        const i = (y * OUT_W + x) * 3
        all++
        if (isCameraGreen([buf[i], buf[i + 1], buf[i + 2]])) n++
      }
    }
    out[corner] = n / all
  }
  return out
}

const near = (a, b, eps) => Math.abs(a - b) <= eps

/* ---------- editor helpers ---------- */

const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

async function seekTo(win, t) {
  const ruler = await win.$eval('.tl-ruler', (el) => {
    const b = el.getBoundingClientRect()
    return b.y + b.height / 2
  })
  await win.mouse.click(await xForTime(win, t), ruler)
  await h.sleep(300)
}

function saved(home, id, pred, message) {
  return f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return pred(p) ? p : null
      } catch {
        return null // mid-write
      }
    },
    `saved: ${message}`,
    10000
  )
}

async function main() {
  const wm = startWindowManager()
  try {
    await test('the live camera bubble: one camera open, out of the capture, dragged corners become camera corners at their times', async (ctx) => {
      const home = h.tempHome('cam-live')
      const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
      ctx.app = r.closable(app)
      ctx.logs = logs
      await r.waitForSources(win)
      await pickDevices(win)
      // Home shows its own camera preview until the recording starts (then releases it).
      await win.waitForSelector('.camera-preview.live', { timeout: 15000 })
      await watchContentProtection(app)
      await countCameraOpens(win)

      await r.readyToRecord(win)
      await win.click('button.record')
      const tb = await r.toolbar(app)
      await tb.waitForSelector('.countdown-number', { timeout: 10000 })
      // The bubble is up during the countdown already, so it can be put in place before recording.
      const page = await bubblePage(app)
      await tb.waitForSelector('button.stop', { timeout: 20000 })
      const t0 = Date.now()

      // The window: always on top, never focused, out of the capture, in the default corner.
      const bw = await bubbleWindow(app)
      h.assert(bw && bw.visible && bw.onTop, `bubble window shown and always on top: ${JSON.stringify(bw)}`)
      h.assert(bw.focusable === false, 'the bubble never takes the keyboard focus')
      const prot = await app.evaluate(() => globalThis.__protected)
      h.assert(prot.some((p) => p.id === bw.id && p.on === true), `content protection requested for the bubble: ${JSON.stringify(prot)}`)
      h.assert(bw.bounds.x + bw.bounds.width === 1920 - 24 && bw.bounds.width >= 120, `starts in the bottom-right corner: ${JSON.stringify(bw.bounds)}`)

      // Its picture: the recorded camera, live (frames keep coming), with no code of its own.
      const live = await r.until(
        () => page.evaluate(() => {
          const v = document.querySelector('video')
          return v && v.readyState >= 2 && v.videoWidth > 0 ? { w: v.videoWidth, t: v.currentTime } : null
        }),
        { what: 'bubble video playing' }
      )
      await h.sleep(600)
      const later = await page.evaluate(() => document.querySelector('video').currentTime)
      h.assert(later > live.t, `bubble video advances (${live.t} -> ${later})`)
      h.assert((await page.evaluate(() => typeof window.api)) === 'undefined', 'the bubble window has no preload (window.api)')
      const shot = await page.screenshot()
      const png = path.join(os.tmpdir(), `ssw-bubble-${process.pid}.png`)
      fs.writeFileSync(png, shot)
      const px = fx.framesAt(png, [0], 'rgb24')
      // Points around the middle of the circle (the fake camera's moving wedge is at its centre).
      const samples = [
        [0.5, 0.85],
        [0.18, 0.5],
        [0.82, 0.5],
        [0.5, 0.18]
      ].map(([fxr, fyr]) => {
        const i = Math.floor(fyr * px.height) * px.width + Math.floor(fxr * px.width)
        return [px.frames[0][i * 3], px.frames[0][i * 3 + 1], px.frames[0][i * 3 + 2]]
      })
      h.assert(samples.filter(isCameraGreen).length >= 3, `bubble shows the fake camera picture (rgb ${JSON.stringify(samples)})`)
      fs.rmSync(png, { force: true })

      // Moves while recording (real drags), and one while paused.
      await h.sleep(2000)
      await dragBubbleTo(app, { x: 300, y: 250 }, 'top-left')
      const m1 = (Date.now() - t0) / 1000
      await h.sleep(3000)
      await dragBubbleTo(app, { x: 1600, y: 200 }, 'top-right')
      const m2 = (Date.now() - t0) / 1000
      await h.sleep(2500)
      await tb.click('button.pause')
      await tb.waitForSelector('.rec-dot.paused')
      const pausedAt = (Date.now() - t0) / 1000
      await h.sleep(800)
      await dragBubbleTo(app, { x: 300, y: 900 }, 'bottom-left')
      await h.sleep(800)
      await tb.click('button.pause')
      await tb.waitForSelector('.rec-dot:not(.paused)')
      const pause = (Date.now() - t0) / 1000 - pausedAt

      // Hide and show the bubble from the bar; the camera keeps recording.
      await tb.click('button.camera')
      await r.until(async () => (await bubbleWindow(app))?.visible === false, { what: 'bubble hidden' })
      await tb.waitForSelector('button.camera.off[aria-label="Show camera bubble"]')
      await tb.click('button.camera')
      await r.until(async () => (await bubbleWindow(app))?.visible === true, { what: 'bubble shown again' })
      await h.sleep(2500)

      const opens = await win.evaluate(() => window.__gum)
      h.assert(opens.video === 1, `the camera was opened exactly once for the recording and its bubble: ${JSON.stringify(opens)}`)
      await tb.click('button.stop')
      const wall = (Date.now() - t0) / 1000
      await win.waitForSelector('.editor canvas', { timeout: 180000 })
      h.assert(!(await bubbleWindow(app)), 'the bubble closes with the recording')

      const id = h.listProjects(home)[0]
      const project = h.readProject(home, id)
      const segs = project.layouts
      h.assert(project.hasWebcam && project.webcam.corner === 'bottom-right', 'recorded with the camera, default corner bottom right')
      h.assert(segs.length === 3, `three camera corners on the layout track: ${JSON.stringify(segs)}`)
      h.assert(segs.every((s) => s.layout === 'default'), 'corner changes use the default layout')
      h.assert(
        segs[0].corner === 'top-left' && segs[1].corner === 'top-right' && segs[2].corner === 'bottom-left',
        `corners in order: ${segs.map((s) => s.corner)}`
      )
      h.assert(near(segs[0].start, m1, 0.9), `top left from ${segs[0].start} (dropped at ~${m1.toFixed(2)})`)
      h.assert(near(segs[1].start, m2, 0.9) && Math.abs(segs[0].end - segs[1].start) < 1e-6, `top right from ${segs[1].start} (~${m2.toFixed(2)}), straight from top left`)
      // The move while paused applies where the pause began (paused time is not in the video).
      h.assert(near(segs[2].start, pausedAt, 0.9), `bottom left from the pause at ${segs[2].start} (~${pausedAt.toFixed(2)})`)
      h.assert(near(segs[2].end, project.duration, 1e-3), `bottom left to the end (${segs[2].end} of ${project.duration})`)
      h.assert(project.duration < wall - pause + 0.5, `the duration ${project.duration} leaves out the ${pause.toFixed(1)} s pause`)
      // The editor's layout track shows the corners.
      const blocks = await win.$$eval('[data-testid="layout-track"] .layout-seg', (els) => els.map((e) => e.dataset.corner))
      h.assert(JSON.stringify(blocks) === JSON.stringify(['top-left', 'top-right', 'bottom-left']), `layout track blocks show the corners: ${blocks}`)

      // The export draws the camera in those corners at those times.
      const out = path.join(home, 'corners.mp4')
      await h.mockSaveDialog(app, out)
      await fx.openExportDialog(win)
      await fx.pickChip(win, 'Resolution', '720p')
      await fx.pickChip(win, 'Frame rate', '30 fps')
      await win.locator('.modal button.primary', { hasText: 'Export' }).click()
      const done = await fx.waitForExport(win)
      h.assert(done.ok, `export: ${done.text}`)
      const settledIn = (s) => (s.start + s.end) / 2
      const checks = [
        { t: Math.max(0.3, segs[0].start / 2), corner: 'bottom-right' },
        { t: settledIn(segs[0]), corner: 'top-left' },
        { t: settledIn(segs[1]), corner: 'top-right' },
        { t: settledIn(segs[2]), corner: 'bottom-left' }
      ]
      const frames = fx.framesAt(out, checks.map((c) => Math.round(c.t * 30)), 'rgb24')
      h.assert(frames.width === OUT_W && frames.height === OUT_H, `720p export (${frames.width}x${frames.height})`)
      checks.forEach((c, i) => {
        const shares = cornerShares(frames.frames[i])
        h.assert(shares[c.corner] > 0.6, `camera in the ${c.corner} corner at ${c.t.toFixed(2)} s: ${JSON.stringify(shares)}`)
        for (const [other, share] of Object.entries(shares)) if (other !== c.corner) h.assert(share < 0.05, `no camera in the ${other} corner at ${c.t.toFixed(2)} s: ${JSON.stringify(shares)}`)
      })
      // Halfway through the move from top left to top right, the camera is on its way (between them).
      const midMove = fx.framesAt(out, [Math.round((segs[1].start + 0.2) * 30)], 'rgb24')
      const moving = cornerShares(midMove.frames[0])
      h.assert(moving['top-left'] < 0.6 && moving['top-right'] < 0.6, `camera gliding between the top corners: ${JSON.stringify(moving)}`)
    })

    await test('recording bar: pause and resume, mute, restart and discard with confirmation', async (ctx) => {
      const home = h.tempHome('cam-bar')
      const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
      ctx.app = r.closable(app)
      ctx.logs = logs
      await r.waitForSources(win)
      await pickDevices(win)
      const tb = await r.startRecording(app, win)
      const first = r.activeDir(home)
      h.assert(first, 'a recording folder exists')
      // The bar: the microphone with its meter, the camera bubble toggle, and the timer.
      await tb.waitForSelector('button.mic[aria-label="Mute microphone"] .rb-meter')
      await tb.waitForSelector('button.camera[aria-label="Hide camera bubble"]')
      h.assert(await tb.$('.tb-time'), 'timer shown')
      h.assert((await tb.evaluate(() => getComputedStyle(document.querySelector('.rec-dot')).animationName)) === 'none', 'recording dot is not animated by CSS')
      // The bar's and the bubble's windows show only the pill and the bubble: their pages paint no
      // background over the desktop; the main window keeps its own.
      const rootBg = (page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
      h.assert((await rootBg(tb)) === 'rgba(0, 0, 0, 0)', `the bar's page has no background: ${await rootBg(tb)}`)
      h.assert((await rootBg(await bubblePage(app))) === 'rgba(0, 0, 0, 0)', 'the bubble page has no background')
      h.assert((await rootBg(win)) !== 'rgba(0, 0, 0, 0)', `the main window keeps its background: ${await rootBg(win)}`)

      // Hiding and showing the camera bubble keeps the bar's timer running (it never jumps back).
      const timerSeconds = () =>
        tb.$eval('.tb-time', (el) => {
          const [m, sec] = el.textContent.split(':').map(Number)
          return m * 60 + sec
        })
      await r.until(async () => (await timerSeconds()) >= 3, { what: 'the timer at 3 s', timeout: 15000 })
      await tb.click('button.camera')
      await tb.waitForSelector('button.camera.off[aria-label="Show camera bubble"]')
      await h.sleep(700)
      h.assert((await timerSeconds()) >= 3, `the timer keeps counting after hiding the bubble: ${await timerSeconds()} s`)
      await tb.click('button.camera')
      await tb.waitForSelector('button.camera[aria-label="Hide camera bubble"]')
      await h.sleep(700)
      h.assert((await timerSeconds()) >= 3, `the timer keeps counting after showing the bubble: ${await timerSeconds()} s`)

      await tb.click('button.pause')
      await tb.waitForSelector('.rec-dot.paused')
      h.assert((await tb.textContent('.tb-state')) === 'Paused', 'shows Paused')
      await tb.click('button.pause')
      await tb.waitForSelector('.rec-dot:not(.paused)')

      // Mute: the recorder confirms, and the bar shows it.
      await tb.click('button.mic')
      await tb.waitForSelector('button.mic.muted[aria-label="Unmute microphone"]', { timeout: 5000 })
      await tb.click('button.mic')
      await tb.waitForSelector('button.mic:not(.muted)', { timeout: 5000 })

      // Restart, kept at first, then confirmed: a new countdown and a new recording; the first is gone.
      await tb.click('button.restart')
      await tb.waitForSelector('.toolbar.confirm.restart')
      await tb.click('button:has-text("Keep")')
      await tb.waitForSelector('button.stop')
      h.assert(fs.existsSync(first), 'kept: the recording goes on')
      await tb.click('button.restart')
      await tb.waitForSelector('.toolbar.confirm.restart')
      await tb.click('.toolbar.confirm button:has-text("Restart")')
      await tb.waitForSelector('.countdown-number', { timeout: 15000 })
      h.assert(!(await r.mainVisible(app)), 'the main window stays hidden while restarting')
      await tb.waitForSelector('button.stop', { timeout: 20000 })
      const second = await r.until(() => r.activeDir(home), { what: 'new recording folder' })
      h.assert(second !== first && !fs.existsSync(first), 'the first take was deleted')
      await bubblePage(app)
      h.assert((await bubbleWindow(app))?.visible, 'the new recording has its camera bubble again')
      await h.sleep(1000)

      // Discard, kept at first, then confirmed.
      await tb.click('button.discard')
      await tb.waitForSelector('.toolbar.confirm.discard')
      await tb.click('button:has-text("Keep")')
      await tb.waitForSelector('button.stop')
      await tb.click('button.discard')
      await tb.click('.toolbar.confirm button:has-text("Discard")')
      await r.until(() => r.mainVisible(app), { what: 'main window shown again' })
      await h.sleep(500)
      h.assert(r.projectDirs(home).length === 0, `nothing left: ${r.projectDirs(home)}`)
      h.assert(!(await bubbleWindow(app)), 'no bubble left')
      h.assert(!(await win.$('.home-error')), 'no error shown')
    })

    await test('restart: a next take that cannot be prepared brings the app back with its error', async (ctx) => {
      const home = h.tempHome('cam-restart-fail')
      const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
      ctx.app = r.closable(app)
      ctx.logs = logs
      await r.waitForSources(win)
      await pickDevices(win)
      const tb = await r.startRecording(app, win)
      h.assert(!(await r.mainVisible(app)), 'the main window is hidden while recording')
      // From now on no new recording folder can be created (a full disk, say).
      await app.evaluate(() => {
        const fsp = process.getBuiltinModule('node:fs').promises
        const mkdir = fsp.mkdir
        fsp.mkdir = function (p, opts, ...rest) {
          if (!opts && /[\\/]rec-[^\\/]*$/.test(String(p))) return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
          return mkdir.call(this, p, opts, ...rest)
        }
      })
      await tb.click('button.restart')
      await tb.waitForSelector('.toolbar.confirm.restart')
      await tb.click('.toolbar.confirm button:has-text("Restart")')
      await r.until(() => r.mainVisible(app), { what: 'main window shown again', timeout: 15000 })
      await win.waitForSelector('.home-error', { timeout: 10000 })
      h.assert(r.projectDirs(home).length === 0, `the restarted take was deleted: ${r.projectDirs(home)}`)
      h.assert(!(await bubbleWindow(app)), 'no bubble left')
    })

    await test('"Camera follows the preview bubble" off: moving the bubble moves nothing in the video', async (ctx) => {
      const home = h.tempHome('cam-nofollow')
      const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
      ctx.app = r.closable(app)
      ctx.logs = logs
      await r.waitForSources(win)
      await pickDevices(win)
      if (!(await win.$('.rec-options.open'))) await win.click('.rec-options-head')
      await win.click('input[aria-label="Camera follows the preview bubble"]')
      await r.until(() => win.$('input[aria-label="Camera follows the preview bubble"]:not(:checked)'), { what: 'option off' })
      const tb = await r.startRecording(app, win)
      await bubblePage(app)
      await h.sleep(1500)
      await dragBubbleTo(app, { x: 300, y: 250 }, 'top-left')
      await h.sleep(2000)
      await tb.click('button.stop')
      await win.waitForSelector('.editor canvas', { timeout: 180000 })
      const project = h.readProject(home, h.listProjects(home)[0])
      h.assert(project.hasWebcam && project.layouts.length === 0, `no camera corners: ${JSON.stringify(project.layouts)}`)
    })

    await test('Camera panel: camera position of a layout change, "Move camera here from the playhead", undo', async (ctx) => {
      const home = h.tempHome('cam-position')
      f.seedProject(home, { id: 'rec-pos', name: 'Positions', seconds: 12, webcam: true })
      const { app, win, logs } = await h.launch({ home })
      ctx.app = r.closable(app)
      ctx.logs = logs
      await f.openProject(win, 'Positions')
      await win.waitForSelector('[data-testid="layout-track"]')
      await win.click('.insp-tabs button[title="Camera"]')
      await win.waitForSelector('[data-testid="camera-position"]')

      // Outside every change: the buttons move the camera from the playhead (a new change, 5 s).
      await seekTo(win, 2)
      await win.keyboard.press('Escape')
      await win.click('[data-testid="camera-position"] button[aria-label="Move camera here from the playhead: top left"]')
      let p = await saved(home, 'rec-pos', (q) => (q.layouts ?? []).length === 1, 'a corner change added')
      const seg = p.layouts[0]
      h.assert(seg.layout === 'default' && seg.corner === 'top-left' && near(seg.start, 2, 0.15) && near(seg.end - seg.start, 5, 0.01), `top left from 2 s for 5 s: ${JSON.stringify(seg)}`)
      await win.waitForSelector(`.layout-seg.selected[data-layout="${seg.id}"][data-corner="top-left"]`)
      h.assert(p.webcam.corner === 'bottom-right', 'the default corner stays')

      // The selected change: its corner changes in place.
      await win.waitForSelector('[data-testid="camera-position"] button[aria-label="Camera position: top left"][aria-pressed="true"]')
      await win.click('[data-testid="camera-position"] button[aria-label="Camera position: top right"]')
      p = await saved(home, 'rec-pos', (q) => q.layouts[0].corner === 'top-right', 'the corner changed')
      await win.waitForSelector(`.layout-seg[data-layout="${seg.id}"][data-corner="top-right"]`)
      h.assert(p.layouts.length === 1 && near(p.layouts[0].start, seg.start, 1e-6), 'the same change, in place')

      // Undo goes back to top left, then to no change at all.
      await win.keyboard.press('Control+z')
      await saved(home, 'rec-pos', (q) => q.layouts[0]?.corner === 'top-left', 'undo: top left again')
      await win.keyboard.press('Control+z')
      await saved(home, 'rec-pos', (q) => (q.layouts ?? []).length === 0, 'undo: no change')
      h.assert(!(await win.$('.layout-seg')), 'gone from the timeline')

      // A change of layout without a camera bubble has no corner to pick.
      await seekTo(win, 6)
      await win.keyboard.press('Escape')
      await win.click('.layout-option:has-text("Camera only")')
      await saved(home, 'rec-pos', (q) => (q.layouts ?? []).length === 1, 'camera only added')
      await win.waitForSelector('[data-testid="camera-position"] button[aria-label="Camera position: top left"]:disabled')
    })
  } finally {
    wm.kill()
  }
}

main()
