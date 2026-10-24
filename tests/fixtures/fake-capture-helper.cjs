#!/usr/bin/env node
// Stand-in for native/ssw-capture.exe that speaks the same CLI and stdin/stdout protocol
// (native/README.md). Used through SSW_CAPTURE_HELPER by tests/nativeCapture.test.ts and
// tests/e2e/native.e2e.cjs, and handy for exercising the app's native path on Linux.
//
// Environment:
//   FAKE_HELPER_PROBE    supported (default) | unsupported | hang | garbage
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
//                        they are fragmented MP4 (one fragment per 1 s GOP).
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

async function main() {
  const command = args[0]
  if (command === 'probe') {
    const mode = env.FAKE_HELPER_PROBE || 'supported'
    if (mode === 'hang') return new Promise(() => setInterval(() => undefined, 1000))
    if (mode === 'garbage') {
      process.stdout.write('not json\n')
      return 3
    }
    const ok = mode === 'supported'
    out({
      supported: ok,
      cursorToggle: ok,
      borderToggle: ok,
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
  process.stderr.write(`unknown command ${command}\n`)
  return 2
}

/**
 * Real video via ffmpeg: one segment per active span, each trimmed to the span it stands
 * for (ffmpeg needs a moment to stop) and joined on stop.
 */
class Segments {
  constructor(file, fps, monitor) {
    this.file = file
    this.fps = fps
    this.monitor = monitor
    this.parts = []
    this.current = null
  }

  input() {
    const { width, height, x, y } = this.monitor
    if (env.FAKE_HELPER_VIDEO === 'x11grab') {
      // -draw_mouse 0: like the real helper, the cursor is not in the video.
      return ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(this.fps), '-video_size', `${width}x${height}`, '-i', `${env.DISPLAY}+${x},${y}`]
    }
    return ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${this.fps}`]
  }

  /** Starts a segment; resolves with the epoch ms of its first frame. */
  start() {
    const part = { file: `${this.file}.part${this.parts.length}.mp4`, start: 0, end: 0 }
    this.parts.push(part)
    const spawnedAt = Date.now()
    // prettier-ignore
    const proc = spawn(env.FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', ...this.input(),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(this.fps), '-r', String(this.fps),
      ...FRAGMENTED, '-progress', 'pipe:1', part.file
    ], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.current = { proc, part, done: new Promise((r) => proc.on('close', r)) }
    return new Promise((resolve, reject) => {
      proc.on('error', reject)
      proc.on('close', (code) => reject(new Error(`ffmpeg exited with ${code} before the first frame`)))
      proc.stdout.on('data', (d) => {
        const frames = Math.max(0, ...[...String(d).matchAll(/frame=(\d+)/g)].map((m) => Number(m[1])))
        if (frames > 0 && !part.start) {
          part.start = Math.max(spawnedAt, Date.now() - (frames * 1000) / this.fps)
          resolve(part.start)
        }
      })
    })
  }

  /** Ends the current segment at epoch ms `at`. */
  async stopCurrent(at) {
    const seg = this.current
    if (!seg) return
    this.current = null
    seg.part.end = at
    seg.proc.stdin.end('q')
    await seg.done
  }

  /** Seconds of video kept. */
  duration() {
    return this.parts.reduce((sum, p) => sum + Math.max(0, p.end - p.start) / 1000, 0)
  }

  async finish(at) {
    await this.stopCurrent(at)
    this.join()
  }

  join() {
    const list = `${this.file}.parts.txt`
    const quote = (f) => `'${f.replace(/'/g, "'\\''")}'`
    const entries = this.parts.map((p) => `file ${quote(p.file)}\noutpoint ${Math.max(0.001, (p.end - p.start) / 1000).toFixed(3)}`)
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
  const file = flag('--out')
  const fps = Number(flag('--fps'))
  if (!device || !file || (fps !== 30 && fps !== 60)) {
    out({ event: 'error', message: 'invalid arguments' })
    return 2
  }
  const monitor = monitors().find((m) => m.device === device || String(m.index) === device)
  if (!monitor) {
    out({ event: 'error', message: `Monitor ${device} not found` })
    return 4
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

  // stdin commands
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
  const nextLine = () =>
    lines.length || eof
      ? Promise.resolve(lines.shift() ?? null)
      : new Promise((r) => {
          wake = () => {
            wake = null
            r(lines.shift() ?? null)
          }
        })

  if (mode === 'never-start') {
    // Blocks until killed; ignores stop.
    return new Promise(() => setInterval(() => undefined, 1000))
  }

  const real = env.FAKE_HELPER_VIDEO === 'x11grab' || env.FAKE_HELPER_VIDEO === 'testsrc'
  const segments = real ? new Segments(file, fps, monitor) : null
  const startedAt = segments ? await segments.start() : Date.now()
  if (mode === 'bad-start') {
    out({ event: 'started', at: startedAt, width: 0, height: monitor.height })
  } else {
    out({ event: 'started', at: startedAt, width: monitor.width & ~1, height: monitor.height & ~1, fps, encoder: 'Fake H.264 Encoder MFT', hardware: true })
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
    const line = await Promise.race([nextLine(), ended])
    if (line === END) {
      const at = Date.now()
      if (!paused) active += Math.max(0, at - since)
      log({ ended: mode })
      if (mode === 'crash-early') {
        // No event, no finalising: what is on disk is what a killed helper leaves.
        if (segments) segments.crash(at)
        else fs.writeFileSync(file, 'fake video (cut off)')
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
  if (mode === 'hang-on-stop') return new Promise(() => setInterval(() => undefined, 1000))
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
