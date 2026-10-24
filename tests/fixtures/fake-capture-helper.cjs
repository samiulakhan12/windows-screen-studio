#!/usr/bin/env node
// Stand-in for native/ssw-capture.exe that speaks the same CLI and stdin/stdout protocol
// (native/README.md). Used through SSW_CAPTURE_HELPER by tests/nativeCapture.test.ts and
// tests/e2e/native.e2e.cjs, and handy for exercising the app's native path on Linux.
//
// Commands: probe, list, record --monitor <device|index> | --window <id>, watch-window --window <id>.
// On Linux the window id is an X11 window id (Electron's "window:<xid>:0"): its rectangle is read
// with python3 + libX11 (XGetWindowAttributes, XTranslateCoordinates to the root) at 60 Hz, and
// cursorOver like the real helper's WindowFromPoint + GA_ROOTOWNER: the root's child under the
// pointer (XQueryPointer) is the recorded window's top-level window (its window-manager frame).
//
// Environment:
//   FAKE_HELPER_PROBE    supported (default) | unsupported | hang | garbage
//   FAKE_HELPER_WINDOW_CAPTURE  0: probe reports "windowCapture":false (default: true when supported)
//   FAKE_HELPER_MONITORS JSON array for `list` (default: one 1920x1080 primary monitor at 0,0)
//   FAKE_HELPER_RECORD   ok (default) | fail-start | crash | never-start | hang-on-stop | error-on-stop
//                        | bad-start
//                        | close-early  ends on its own FAKE_HELPER_END_AFTER_MS after "started", like the
//                                       real helper when the monitor goes away: finalises the video,
//                                       {"event":"stopped","reason":"closed"}, exit 0
//                        | error-early  same, but like an encoder/GPU failure: keeps the partial video,
//                                       {"event":"error"}, exit 1
//                        | crash-early  same, but dies without a word (SIGKILL), leaving the video as a
//                                       killed helper's fragmented MP4 would be
//                        Until then pause/resume/stop work as usual.
//   FAKE_HELPER_END_AFTER_MS  for the *-early modes (default 200)
//   FAKE_HELPER_VIDEO    none (default: placeholder file) | x11grab (real screen, no cursor) | testsrc
//                        Real videos are recorded in segments, one per active span, and joined on stop,
//                        so paused time is excluded like the real helper does. Like the real helper's,
//                        they are fragmented MP4 (one fragment per 1 s GOP). A window recording keeps the
//                        window's initial size; x11grab follows the window and fits a resized window into
//                        that size (fitContent in src/shared/recording/windowGeometry.ts), starting a new
//                        segment when the rectangle changes (overlapping, so no time is lost).
//   FAKE_HELPER_WINDOW_RECTS  JSON timeline used instead of the X11 window, e.g.
//                        [{"after":0,"x":10,"y":20,"width":800,"height":600,"cursorOver":true},
//                         {"after":300,"x":50,"y":20,"width":800,"height":600,"minimized":false},
//                         {"after":500,"cursorOver":false},
//                         {"after":900,"closed":true}]
//                        `after` is ms after "started" (record) or "ready" (watch-window); a first entry
//                        with "closed" means the window does not exist (exit 4). `cursorOver` carries over
//                        to later entries; an entry without x keeps the rectangle (only cursorOver changes).
//                        A timeline that never sets cursorOver omits it, like helpers that predate it.
//   FAKE_HELPER_WATCH    ok (default) | crash (exits 1 after "ready", before any rectangle)
//                        | silent (never reports a rectangle, ignores stdin) | hang-on-stop
//   FAKE_HELPER_LOG      file to append the argv and every stdin line to (JSON lines)
//   FAKE_HELPER_SHAPES   comma-separated cursor shapes emitted 50 ms apart after "started" (default arrow,text,pointer)
//   FFMPEG               ffmpeg binary for real videos (default: ffmpeg on PATH)
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')

const env = process.env
const args = process.argv.slice(2)
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const log = (entry) => {
  if (env.FAKE_HELPER_LOG) fs.appendFileSync(env.FAKE_HELPER_LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hang = () => new Promise(() => setInterval(() => undefined, 1000))
// The real helper's container: moov first, then one moof/mdat per key frame (1 s GOP).
const FRAGMENTED = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof']

log({ argv: args, pid: process.pid })

function monitors() {
  if (env.FAKE_HELPER_MONITORS) return JSON.parse(env.FAKE_HELPER_MONITORS)
  return [{ index: 0, device: '\\\\.\\DISPLAY1', name: 'Fake Monitor', x: 0, y: 0, width: 1920, height: 1080, primary: true }]
}

function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** The helper's --window value: a non-zero decimal handle. */
function validWindow(value) {
  return typeof value === 'string' && /^-?\d{1,20}$/.test(value) && BigInt(value) !== 0n
}

async function main() {
  const command = args[0]
  if (command === 'probe') {
    const mode = env.FAKE_HELPER_PROBE || 'supported'
    if (mode === 'hang') return hang()
    if (mode === 'garbage') {
      process.stdout.write('not json\n')
      return 3
    }
    const ok = mode === 'supported'
    out({
      supported: ok,
      cursorToggle: ok,
      borderToggle: ok,
      windowCapture: ok && env.FAKE_HELPER_WINDOW_CAPTURE !== '0',
      capture: ok,
      hardwareEncoders: ok ? ['Fake H.264 Encoder MFT'] : [],
      softwareEncoder: ok,
      reason: ok ? null : 'Fake helper: capture unsupported'
    })
    return ok ? 0 : 3
  }
  if (command === 'list') {
    out(monitors())
    return 0
  }
  if (command === 'record') return record()
  if (command === 'watch-window') return watchWindow()
  process.stderr.write(`unknown command ${command}\n`)
  return 2
}

/** Commands on stdin, one per line; null once stdin ended. */
function commandReader() {
  const lines = []
  let wake = null
  let eof = false
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buffer += d
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      log({ stdin: line })
      lines.push(line)
      wake?.()
    }
  })
  process.stdin.on('end', () => {
    eof = true
    log({ stdin: '<eof>' })
    wake?.()
  })
  return () =>
    lines.length || eof
      ? Promise.resolve(lines.shift() ?? null)
      : new Promise((r) => {
          wake = () => {
            wake = null
            r(lines.shift() ?? null)
          }
        })
}

// Reads one X11 window's geometry at 60 Hz and prints it on change (JSON lines): first
// {"screen":{...}}, then {"x","y","width","height","minimized","cursorOver"} or {"gone":true}. Exits when the
// window is gone or its parent (this helper) died.
const X11_WINDOW = String.raw`
import ctypes, json, os, sys, time
from ctypes import POINTER, byref, c_int, c_long, c_uint, c_ulong, c_void_p

def out(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()

try:
    x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
except OSError as e:
    out({'error': 'libX11 is not available: %s' % e})
    sys.exit(1)

class Attributes(ctypes.Structure):
    _fields_ = [('x', c_int), ('y', c_int), ('width', c_int), ('height', c_int), ('border_width', c_int),
                ('depth', c_int), ('visual', c_void_p), ('root', c_ulong), ('cls', c_int), ('bit_gravity', c_int),
                ('win_gravity', c_int), ('backing_store', c_int), ('backing_planes', c_ulong),
                ('backing_pixel', c_ulong), ('save_under', c_int), ('colormap', c_ulong), ('map_installed', c_int),
                ('map_state', c_int), ('all_event_masks', c_long), ('your_event_mask', c_long),
                ('do_not_propagate_mask', c_long), ('override_redirect', c_int), ('screen', c_void_p)]

ERROR_HANDLER = ctypes.CFUNCTYPE(c_int, c_void_p, c_void_p)
x11.XSetErrorHandler.argtypes = [ERROR_HANDLER]
x11.XSetErrorHandler.restype = c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = c_void_p
x11.XDefaultRootWindow.argtypes = [c_void_p]
x11.XDefaultRootWindow.restype = c_ulong
x11.XDisplayWidth.argtypes = [c_void_p, c_int]
x11.XDisplayHeight.argtypes = [c_void_p, c_int]
x11.XGetWindowAttributes.argtypes = [c_void_p, c_ulong, POINTER(Attributes)]
x11.XTranslateCoordinates.argtypes = [c_void_p, c_ulong, c_ulong, c_int, c_int, POINTER(c_int), POINTER(c_int), POINTER(c_ulong)]
x11.XQueryPointer.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_ulong), POINTER(c_int), POINTER(c_int),
                              POINTER(c_int), POINTER(c_int), POINTER(c_uint)]
x11.XQueryTree.argtypes = [c_void_p, c_ulong, POINTER(c_ulong), POINTER(c_ulong), POINTER(POINTER(c_ulong)), POINTER(c_uint)]
x11.XFree.argtypes = [c_void_p]

# BadWindow once the window is destroyed: report it instead of exiting.
ignore_errors = ERROR_HANDLER(lambda display, event: 0)
x11.XSetErrorHandler(ignore_errors)
display = x11.XOpenDisplay(None)
if not display:
    out({'error': 'cannot open the X display %s' % os.environ.get('DISPLAY')})
    sys.exit(1)
root = x11.XDefaultRootWindow(display)
window = int(sys.argv[1]) & 0xFFFFFFFF
parent = os.getppid()

def top_level(w):
    # The root's child holding w: the window manager's frame around it (or w itself): like
    # GetAncestor(GA_ROOTOWNER) on Windows.
    while True:
        root_return, up, children, count = c_ulong(), c_ulong(), POINTER(c_ulong)(), c_uint()
        if not x11.XQueryTree(display, w, byref(root_return), byref(up), byref(children), byref(count)):
            return w
        if children:
            x11.XFree(children)
        if up.value in (0, root_return.value):
            return w
        w = up.value

def under_pointer():
    # The root's child under the pointer, in stacking order (like WindowFromPoint), or 0.
    root_return, child = c_ulong(), c_ulong()
    rx, ry, wx, wy, mask = c_int(), c_int(), c_int(), c_int(), c_uint()
    if not x11.XQueryPointer(display, root, byref(root_return), byref(child), byref(rx), byref(ry), byref(wx), byref(wy), byref(mask)):
        return 0
    return child.value

out({'screen': {'width': x11.XDisplayWidth(display, 0), 'height': x11.XDisplayHeight(display, 0)}})
last = None
while os.getppid() == parent:
    attributes = Attributes()
    if not x11.XGetWindowAttributes(display, window, byref(attributes)):
        out({'gone': True})
        break
    x, y, child = c_int(), c_int(), c_ulong()
    x11.XTranslateCoordinates(display, window, root, 0, 0, byref(x), byref(y), byref(child))
    # IsViewable = 2: an iconified (minimised) window is unmapped.
    state = {'x': x.value, 'y': y.value, 'width': attributes.width, 'height': attributes.height,
             'minimized': attributes.map_state != 2}
    over = under_pointer()
    state['cursorOver'] = over != 0 and over == top_level(window)
    if state != last:
        out(state)
        last = state
    time.sleep(1.0 / 60)
`

/**
 * Follows a window's rectangle like the real helper: the first state, then changes; while it is
 * minimised the last on-screen rectangle is reported with minimized:true. The source is
 * FAKE_HELPER_WINDOW_RECTS or the X11 window.
 */
class WindowFollower {
  constructor(id) {
    this.id = id
    this.screen = null
    this.lastShown = null
    this.last = null
    this.onState = null
    this.onClosed = null
    this.pending = []
    this.proc = null
    this.timers = []
    this.closed = false
  }

  /** Resolves with the first state, or null when the window does not exist. */
  first() {
    if (env.FAKE_HELPER_WINDOW_RECTS) {
      this.timeline = JSON.parse(env.FAKE_HELPER_WINDOW_RECTS)
      const head = this.timeline[0]
      if (!head || head.closed) return Promise.resolve(null)
      return Promise.resolve(this.normalise(head))
    }
    return new Promise((resolve, reject) => {
      let resolved = false
      let buffer = ''
      const proc = spawn('python3', ['-I', '-c', X11_WINDOW, String(BigInt(this.id))], { stdio: ['ignore', 'pipe', 'pipe'] })
      this.proc = proc
      let stderr = ''
      proc.stderr.on('data', (d) => (stderr += d))
      proc.on('error', (err) => reject(new Error(`python3 could not run: ${err.message}`)))
      proc.on('exit', (code) => {
        if (!resolved) reject(new Error(`reading the X11 window failed (exit ${code}): ${stderr.trim().slice(-300)}`))
      })
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (d) => {
        buffer += d
        let i
        while ((i = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, i))
          buffer = buffer.slice(i + 1)
          if (msg.error) {
            resolved = true
            reject(new Error(msg.error))
          } else if (msg.screen) {
            this.screen = msg.screen
          } else if (!resolved) {
            resolved = true
            resolve(msg.gone ? null : this.normalise(msg))
          } else {
            this.deliver(msg)
          }
        }
      })
    })
  }

  /** Reports later changes: onState(state) and onClosed() once. Timeline offsets count from now. */
  begin(onState, onClosed) {
    this.onState = onState
    this.onClosed = onClosed
    for (const msg of this.pending.splice(0)) this.deliver(msg)
    for (const entry of (this.timeline || []).slice(1)) {
      this.timers.push(setTimeout(() => this.deliver(entry.closed ? { gone: true } : entry), entry.after || 0))
    }
  }

  deliver(msg) {
    if (this.closed) return
    if (!this.onState) {
      this.pending.push(msg)
      return
    }
    if (msg.gone) {
      this.closed = true
      this.onClosed()
      return
    }
    const before = this.last
    const state = this.normalise(msg)
    if (!before || ['x', 'y', 'width', 'height', 'minimized', 'cursorOver'].some((k) => before[k] !== state[k])) this.onState(state)
  }

  normalise(msg) {
    if (typeof msg.cursorOver === 'boolean') this.cursorOver = msg.cursorOver
    const over = this.cursorOver === undefined ? {} : { cursorOver: this.cursorOver }
    if (msg.x === undefined && this.last) {
      // A timeline entry that only moves the cursor onto or off the window.
      this.last = { ...this.last, ...over }
      return this.last
    }
    const minimized = msg.minimized === true
    let rect = { x: msg.x, y: msg.y, width: msg.width, height: msg.height }
    if (minimized) rect = this.lastShown || rect
    else this.lastShown = rect
    this.last = { ...rect, minimized, ...over }
    return this.last
  }

  stop() {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.proc?.kill()
    this.proc = null
  }
}

function windowEvent(state) {
  const event = { event: 'window', at: Date.now(), x: state.x, y: state.y, width: state.width, height: state.height, minimized: state.minimized }
  // Like the real helper (always), unless a timeline never set it (helpers that predate it).
  if (state.cursorOver !== undefined) event.cursorOver = state.cursorOver
  return event
}

/** fitContent() of src/shared/recording/windowGeometry.ts. */
function fitContent(content, outSize) {
  const cw = Math.max(1, content.width)
  const ch = Math.max(1, content.height)
  const scale = Math.min(outSize.width / cw, outSize.height / ch)
  const width = cw * scale
  const height = ch * scale
  return { scale, dx: (outSize.width - width) / 2, dy: (outSize.height - height) / 2, width, height }
}

/**
 * x11grab input for a window at `rect`, fitted into `size`: the part of the window that is on
 * screen is grabbed, scaled by the whole window's fit and placed where it would be.
 */
function windowGrab(rect, size, screen, fps) {
  const fit = fitContent(rect, size)
  const sw = screen ? screen.width : 1 << 15
  const sh = screen ? screen.height : 1 << 15
  const x0 = Math.min(Math.max(rect.x, 0), sw - 2)
  const y0 = Math.min(Math.max(rect.y, 0), sh - 2)
  const x1 = Math.max(Math.min(rect.x + rect.width, sw), x0 + 2)
  const y1 = Math.max(Math.min(rect.y + rect.height, sh), y0 + 2)
  const w = Math.max(1, Math.min(size.width, Math.round((x1 - x0) * fit.scale)))
  const h = Math.max(1, Math.min(size.height, Math.round((y1 - y0) * fit.scale)))
  const px = Math.min(size.width - w, Math.max(0, Math.round(fit.dx + (x0 - rect.x) * fit.scale)))
  const py = Math.min(size.height - h, Math.max(0, Math.round(fit.dy + (y0 - rect.y) * fit.scale)))
  return {
    input: ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${x1 - x0}x${y1 - y0}`, '-i', `${env.DISPLAY}+${x0},${y0}`],
    filter: `scale=${w}:${h},pad=${size.width}:${size.height}:${px}:${py}:black`
  }
}

/**
 * Real video via ffmpeg: one segment per active span, each trimmed to the span it stands
 * for (ffmpeg needs a moment to stop) and joined on stop. Operations run one at a time.
 */
class Segments {
  /** `source()` returns the ffmpeg input arguments and an optional filter for a new segment. */
  constructor(file, fps, source) {
    this.file = file
    this.fps = fps
    this.source = source
    this.parts = []
    this.current = null
    this.starting = null
    this.queue = Promise.resolve()
    this.switchQueued = false
  }

  op(fn) {
    const p = this.queue.then(fn)
    this.queue = p.catch(() => undefined)
    return p
  }

  /** Starts a segment; resolves with the epoch ms of its first frame. */
  start() {
    return this.op(() => this.startNow())
  }

  startNow() {
    const part = { file: `${this.file}.part${this.parts.length}.mp4`, start: 0, end: 0 }
    this.parts.push(part)
    const spawnedAt = Date.now()
    const { input, filter } = this.source()
    // prettier-ignore
    const proc = spawn(env.FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', ...input, ...(filter ? ['-vf', filter] : []),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(this.fps), '-r', String(this.fps),
      ...FRAGMENTED, '-progress', 'pipe:1', part.file
    ], { stdio: ['pipe', 'pipe', 'inherit'] })
    const seg = { proc, part, done: new Promise((r) => proc.on('close', r)) }
    this.starting = seg
    return new Promise((resolve, reject) => {
      proc.on('error', reject)
      proc.on('close', (code) => reject(new Error(`ffmpeg exited with ${code} before the first frame`)))
      proc.stdout.on('data', (d) => {
        const frames = Math.max(0, ...[...String(d).matchAll(/frame=(\d+)/g)].map((m) => Number(m[1])))
        if (frames > 0 && !part.start) {
          part.start = Math.max(spawnedAt, Date.now() - (frames * 1000) / this.fps)
          this.starting = null
          this.current = seg
          resolve(part.start)
        }
      })
    })
  }

  /** Ends the current segment at epoch ms `at`. */
  stopCurrent(at) {
    return this.op(() => this.stopNow(at))
  }

  async stopNow(at) {
    const seg = this.current
    if (!seg) return
    this.current = null
    seg.part.end = at
    seg.proc.stdin.end('q')
    await seg.done
  }

  /**
   * The source changed (the window moved or was resized): a new segment takes over from its first
   * frame on, and the old one ends there. Coalesces bursts (dragging) into one switch at a time.
   */
  switchSource() {
    if (this.switchQueued) return
    this.switchQueued = true
    this.op(async () => {
      this.switchQueued = false
      const old = this.current
      // Paused: the next segment starts with the new source anyway.
      if (!old) return
      const start = await this.startNow()
      old.part.end = start
      old.proc.stdin.end('q')
      await old.done
    }).catch((err) => process.stderr.write(`fake helper: switching segments failed: ${err.message}\n`))
  }

  /** Seconds of video kept. */
  duration() {
    return this.parts.reduce((sum, p) => sum + Math.max(0, p.end - p.start) / 1000, 0)
  }

  finish(at) {
    return this.op(async () => {
      await this.stopNow(at)
      this.join()
    })
  }

  join() {
    const list = `${this.file}.parts.txt`
    const quote = (f) => `'${f.replace(/'/g, "'\\''")}'`
    const parts = this.parts.filter((p) => p.start > 0)
    const entries = parts.map((p) => `file ${quote(p.file)}\noutpoint ${Math.max(0.001, (p.end - p.start) / 1000).toFixed(3)}`)
    fs.writeFileSync(list, entries.join('\n'))
    // prettier-ignore
    const r = spawnSync(env.FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...FRAGMENTED, this.file
    ])
    for (const p of [...this.parts.map((x) => x.file), list]) fs.rmSync(p, { force: true })
    if (r.status !== 0) throw new Error(`joining segments failed: ${r.stderr}`)
  }

  /**
   * The state a killed helper leaves: the running segment's ffmpeg is killed too (its
   * fragmented part keeps its complete fragments), and what is readable becomes the output.
   */
  crash(at) {
    const seg = this.current
    this.current = null
    this.starting?.proc.kill('SIGKILL')
    if (seg) {
      seg.part.end = at
      seg.proc.kill('SIGKILL')
    }
    try {
      this.join()
    } catch {
      // Nothing readable yet (killed before its first fragment): leave the cut-off part.
      const last = this.parts[this.parts.length - 1]
      if (last && fs.existsSync(last.file)) fs.renameSync(last.file, this.file)
    }
  }
}

async function record() {
  const mode = env.FAKE_HELPER_RECORD || 'ok'
  const device = flag('--monitor')
  const windowId = flag('--window')
  const file = flag('--out')
  const fps = Number(flag('--fps'))
  if ((device === undefined) === (windowId === undefined) || !file || (fps !== 30 && fps !== 60)) {
    out({ event: 'error', message: 'invalid arguments' })
    return 2
  }
  if (windowId !== undefined && !validWindow(windowId)) {
    out({ event: 'error', message: `--window must be a window handle (decimal HWND), got '${windowId}'` })
    return 2
  }
  // What is recorded: the monitor, or the window at its initial size (made even).
  let monitor = null
  let follower = null
  let firstState = null
  let size
  if (windowId !== undefined) {
    follower = new WindowFollower(windowId)
    process.on('exit', () => follower.stop())
    firstState = await follower.first()
    if (!firstState) {
      out({ event: 'error', message: `Window ${windowId} not found (it may have been closed)` })
      return 4
    }
    size = { width: Math.max(2, firstState.width & ~1), height: Math.max(2, firstState.height & ~1) }
  } else {
    monitor = monitors().find((m) => m.device === device || String(m.index) === device)
    if (!monitor) {
      out({ event: 'error', message: `Monitor ${device} not found` })
      return 4
    }
    size = { width: monitor.width & ~1, height: monitor.height & ~1 }
  }
  if (mode === 'fail-start') {
    out({ event: 'error', message: 'Fake helper: Windows.Graphics.Capture is not available on this system' })
    process.stderr.write('ssw-capture: Windows.Graphics.Capture is not available on this system\n')
    return 3
  }
  out({ event: 'ready' })
  if (mode === 'crash') {
    process.stderr.write('ssw-capture: Creating the Direct3D 11 device failed: fake crash\n')
    return 1
  }

  const nextLine = commandReader()

  if (mode === 'never-start') {
    // Blocks until killed; ignores stop.
    return hang()
  }

  // The rectangle the next segment grabs (a window's latest on-screen one).
  let rect = firstState
  const source = () => {
    if (env.FAKE_HELPER_VIDEO === 'x11grab') {
      if (follower) return windowGrab(rect, size, follower.screen, fps)
      const { width, height, x, y } = monitor
      // -draw_mouse 0: like the real helper, the cursor is not in the video.
      return { input: ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', `${env.DISPLAY}+${x},${y}`] }
    }
    return { input: ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${size.width}x${size.height}:rate=${fps}`] }
  }
  const real = env.FAKE_HELPER_VIDEO === 'x11grab' || env.FAKE_HELPER_VIDEO === 'testsrc'
  const segments = real ? new Segments(file, fps, source) : null
  const startedAt = segments ? await segments.start() : Date.now()
  if (mode === 'bad-start') {
    out({ event: 'started', at: startedAt, width: 0, height: size.height })
  } else {
    out({ event: 'started', at: startedAt, width: size.width, height: size.height, fps, encoder: 'Fake H.264 Encoder MFT', hardware: true })
  }

  // A window: its rectangle right after "started" (before any cursor event), then on change.
  const CLOSED = Symbol('closed')
  let windowClosed = new Promise(() => undefined)
  if (follower) {
    out(windowEvent(firstState))
    windowClosed = new Promise((resolve) => {
      follower.begin(
        (state) => {
          out(windowEvent(state))
          const moved = !state.minimized && ['x', 'y', 'width', 'height'].some((k) => state[k] !== rect[k])
          if (moved) {
            rect = state
            if (env.FAKE_HELPER_VIDEO === 'x11grab') segments.switchSource()
          }
        },
        () => resolve(CLOSED)
      )
    })
  }

  const shapes = (env.FAKE_HELPER_SHAPES ?? 'arrow,text,pointer').split(',').filter(Boolean)
  void (async () => {
    for (const shape of shapes) {
      out({ event: 'cursor', at: Date.now(), shape })
      await sleep(50)
    }
  })()

  // The *-early modes: the helper ends on its own (monitor unplugged, encoder failure, crash).
  const END = Symbol('end')
  const endsEarly = ['close-early', 'error-early', 'crash-early'].includes(mode)
  const endAfter = Number(env.FAKE_HELPER_END_AFTER_MS || 200)
  const ended = endsEarly ? sleep(endAfter).then(() => END) : new Promise(() => undefined)

  // Active time bookkeeping, as in the real helper: pauses are cut out of the video.
  let active = 0
  let since = startedAt
  let paused = false
  let reason = 'eof'
  let stopAt = Date.now()
  for (;;) {
    const line = await Promise.race([nextLine(), ended, windowClosed])
    if (line === CLOSED) {
      // Like the real helper when the recorded window closes: finalise, "closed", exit 0.
      log({ ended: 'window-closed' })
      reason = 'closed'
      stopAt = Date.now()
      if (!paused) active += Math.max(0, stopAt - since)
      break
    }
    if (line === END) {
      const at = Date.now()
      if (!paused) active += Math.max(0, at - since)
      log({ ended: mode })
      if (mode === 'crash-early') {
        // No event, no finalising: what is on disk is what a killed helper leaves.
        if (segments) segments.crash(at)
        else fs.writeFileSync(file, 'fake video (cut off)')
        follower?.stop()
        process.kill(process.pid, 'SIGKILL')
        return new Promise(() => undefined)
      }
      if (segments) await segments.finish(at)
      else fs.writeFileSync(file, 'fake video')
      const duration = segments ? segments.duration() : active / 1000
      if (mode === 'error-early') {
        // The real helper finalises what it recorded, then reports the failure.
        out({ event: 'error', message: 'Encoding a frame failed: fake device removed (HRESULT 0x887A0005)' })
        return 1
      }
      out({ event: 'stopped', frames: Math.round(duration * fps), dropped: 0, duration: Math.round(duration * 1000) / 1000, reason: 'closed' })
      return 0
    }
    const [name, value] = (line ?? 'stop').split(/\s+/)
    const at = value ? Math.min(Number(value), Date.now()) : Date.now()
    if (name === 'pause' && !paused) {
      paused = true
      active += Math.max(0, at - since)
      if (segments) await segments.stopCurrent(at)
      out({ event: 'paused', at })
    } else if (name === 'resume' && paused) {
      paused = false
      since = segments ? await segments.start() : at
      out({ event: 'resumed', at })
    } else if (name === 'stop') {
      if (line !== null) reason = 'stop'
      stopAt = at
      if (!paused) active += Math.max(0, at - since)
      break
    }
  }
  follower?.stop()
  if (mode === 'hang-on-stop') return hang()
  if (mode === 'error-on-stop') {
    out({ event: 'error', message: 'Finalising the MP4 failed: fake encoder error' })
    return 1
  }
  if (segments) await segments.finish(stopAt)
  else fs.writeFileSync(file, 'fake video')
  const duration = segments ? segments.duration() : active / 1000
  out({ event: 'stopped', frames: Math.round(duration * fps), dropped: 0, duration: Math.round(duration * 1000) / 1000, reason })
  return 0
}

/** `watch-window --window <id>`: the window's rectangle until stop, the end of stdin, or it closing. */
async function watchWindow() {
  const mode = env.FAKE_HELPER_WATCH || 'ok'
  const windowId = flag('--window')
  if (args.length !== 3 || !validWindow(windowId)) {
    out({ event: 'error', message: `invalid arguments for watch-window: ${args.slice(1).join(' ')}` })
    return 2
  }
  const follower = new WindowFollower(windowId)
  process.on('exit', () => follower.stop())
  const first = await follower.first()
  if (!first) {
    out({ event: 'error', message: `Window ${windowId} not found (it may have been closed)` })
    return 4
  }
  out({ event: 'ready' })
  if (mode === 'crash') {
    process.stderr.write('ssw-capture: fake watch-window crash\n')
    return 1
  }
  if (mode === 'silent') return hang()
  const nextLine = commandReader()
  out(windowEvent(first))
  const CLOSED = Symbol('closed')
  const closed = new Promise((resolve) => follower.begin((state) => out(windowEvent(state)), () => resolve(CLOSED)))
  for (;;) {
    const line = await Promise.race([nextLine(), closed])
    if (line === CLOSED) {
      follower.stop()
      out({ event: 'stopped', reason: 'closed' })
      return 0
    }
    if (line === null || line.split(/\s+/)[0] === 'stop') {
      follower.stop()
      if (mode === 'hang-on-stop') return hang()
      out({ event: 'stopped', reason: 'stop' })
      return 0
    }
  }
}

// Exit only once stdout is flushed (pipes are asynchronous on Windows).
const exit = (code) => process.stdout.write('', () => process.exit(code))
main().then(
  (code) => {
    if (typeof code === 'number') exit(code)
  },
  (err) => {
    out({ event: 'error', message: String(err && err.message ? err.message : err) })
    exit(1)
  }
)
