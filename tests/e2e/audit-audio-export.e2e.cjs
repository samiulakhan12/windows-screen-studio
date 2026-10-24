// Audit fixes for the export's sound and raw frames, in the real built app: slowed-down clips
// keep their sound on their frames (atempo used to play it 40-125 ms early), a mono
// microphone keeps stereo system sound and music stereo, and the Software encoder gets its
// frames as 4:2:0 YUV (2.7x less to copy over IPC than RGBA) with the right colours and frames.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

/** The app's own ffmpeg. */
const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const RATE = 48000

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** A cached media file made by ffmpeg from `args` (the output path is appended). */
function cached(name, args) {
  fs.mkdirSync(fx.MEDIA_CACHE, { recursive: true })
  const file = path.join(fx.MEDIA_CACHE, name)
  if (fs.existsSync(file)) return file
  const tmp = file.replace(/(\.\w+)$/, '.part$1')
  execFileSync(FF, ['-v', 'error', '-y', ...args, tmp])
  fs.renameSync(tmp, file)
  return file
}

/** Exports the open project with the dialog to `out` (MP4, 720p, 60 fps, with `encoder`). */
async function exportMp4(app, win, out, encoder) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Format', 'MP4')
  await fx.pickChip(win, 'Resolution', '720p')
  await fx.pickChip(win, 'Frame rate', '60 fps')
  if (encoder) await fx.pickChip(win, 'Encoder', encoder)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export finished: ${r.text}`)
  return r
}

/** Pixel formats of the raw frames ffmpeg reads from the app (`-f rawvideo -pix_fmt X ... -i pipe:0`), sampled until stop(). */
function watchRawFormats(ms = 100) {
  const seen = new Set()
  const timer = setInterval(() => {
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
        if (!/ffmpeg/.test(args[0]) || !args.includes('pipe:0')) continue
        const raw = args.indexOf('rawvideo')
        if (raw >= 0 && args[raw + 1] === '-pix_fmt') seen.add(args[raw + 2])
      } catch {
        // The process exited meanwhile.
      }
    }
  }, ms)
  return { stop: () => (clearInterval(timer), [...seen]) }
}

/** The first audio stream of `file`: channel count and interleaved samples at 48 kHz. */
function pcmChannels(file) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', file]).toString())
  const count = info.streams[0].channels
  const out = execFileSync(FF, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return { count, samples: new Float32Array(out.buffer, out.byteOffset, out.length / 4) }
}

/** Amplitude of the `freq` Hz component of channel `ch` over [from, to) seconds (Goertzel). */
function amplitude({ count, samples }, ch, freq, from, to) {
  const a = Math.round(from * RATE)
  const b = Math.round(to * RATE)
  const w = (2 * Math.PI * freq) / RATE
  let s1 = 0
  let s2 = 0
  for (let i = a; i < b; i++) {
    const s0 = samples[i * count + ch] + 2 * Math.cos(w) * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2)) / (b - a)
}

async function main() {
  await test('audit audio export: slowed-down clips (0.5x, 0.25x) keep their sound on their frames; Software encoding gets YUV frames', fx.withHome('audit-slow', async (ctx, home) => {
    // A 100 ms beep at the start of every source second; the frame index drawn in every frame.
    const media = fx.indexedVideo({ seconds: 8, width: 1280, height: 720, beeps: true })
    const clips = [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 2, end: 4, speed: 0.5 },
      { id: 'c', start: 4, end: 5.5, speed: 0.25 }
    ]
    fx.seedProject(home, { name: 'Slow motion', media, seconds: 8, audio: true, clips })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const timings = fx.exportTimings(win)
    await fx.openProject(win, 'Slow motion')
    const out = path.join(home, 'slow.mp4')
    const formats = watchRawFormats()
    await exportMp4(app, win, out, 'Software')
    const pixFmts = formats.stop()
    console.log(`  ${timings.last().line}`)

    // Every frame shows its source frame (the YUV conversion keeps the frame codes readable);
    // a time exactly between two source frames (slow motion has many) may show either.
    const times = fx.exportFrameTimes(clips, 60)
    const codes = fx.decodeIndices(out, { x: 0, y: 0, w: 1280, h: 180 })
    h.assert(codes.length === times.length, `${codes.length} frames, expected ${times.length}`)
    const wrong = codes.map((c, i) => (Math.abs(c - times[i] * 60) <= 0.5 + 1e-6 ? null : `#${i}: ${c} != ${Math.round(times[i] * 60)} (t ${times[i].toFixed(4)})`)).filter(Boolean)
    h.assert(wrong.length === 0, `${wrong.length} frames show the wrong source frame (${wrong.slice(0, 16).join(', ')})`)

    // Each beep (source seconds 0-5) starts where the video shows its source second. atempo used
    // to play the ones in slowed clips early (here 20 ms at 0.5x, 55 ms at 0.25x; up to 150 ms
    // for other sounds). Sound ahead of the picture is what viewers notice (from about 45 ms);
    // atempo's own placement still varies with the sound, so a beep may come a little late (a
    // slowed-down beep also rises slowly: 70-80 ms at 0.25x, within what viewers accept).
    const { onsets } = fx.beepOnsets(out)
    const want = [0, 1, 2, 4, 6, 10]
    console.log(`  beeps at ${onsets.map((t) => t.toFixed(3)).join(', ')} s (video: ${want.join(', ')} s)`)
    h.assert(onsets.length === want.length, `${onsets.length} beeps, expected ${want.length}`)
    onsets.forEach((t, i) => {
      h.assert(t - want[i] > -0.015 && t - want[i] < 0.1, `beep ${i}: audio ${t.toFixed(3)} s vs video ${want[i]} s`)
    })
    h.assert(pixFmts.length === 1 && pixFmts[0] === 'yuv420p', `the Software encoder reads 4:2:0 YUV frames (ffmpeg -pix_fmt: ${pixFmts.join(', ') || 'none seen'})`)
  }))

  await test('audit audio export: a mono microphone keeps stereo system sound and music stereo', fx.withHome('audit-stereo', async (ctx, home) => {
    const seconds = 6
    // The microphone (mono, as Chromium records it with echo cancellation): 1 kHz. The system
    // sound and the music are stereo with sound on the left only: 300 Hz and 440 Hz.
    const mic = cached('audit-mic-mono.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', String(seconds), '-ac', '1', '-c:a', 'aac', '-b:a', '128k'])
    const leftOnly = (freq) => ['-filter_complex', `sine=frequency=${freq}:sample_rate=48000[l];anullsrc=r=48000:cl=mono[r];[l][r]join=inputs=2:channel_layout=stereo[a]`, '-map', '[a]', '-t', String(seconds), '-c:a', 'aac', '-b:a', '192k']
    const system = cached('audit-system-left.m4a', leftOnly(300))
    const music = cached('audit-music-left.m4a', leftOnly(440))
    const media = cached('audit-stereo-screen.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60', '-i', mic, '-i', system,
      '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'
    ])
    const id = fx.seedProject(home, {
      name: 'Stereo',
      media,
      seconds,
      width: 640,
      height: 360,
      audio: true,
      // The microphone turned down a little: the export mixes the stems.
      audioSettings: { volume: 1, muted: false, mic: { volume: 0.8, muted: false }, system: { volume: 1, muted: false }, music: { path: 'music.m4a', volume: 1, ducking: 0, loop: true, fadeIn: 0, fadeOut: 0 } }
    })
    const dir = path.join(h.projectsRoot(home), id)
    for (const [name, file] of Object.entries({ 'mic.m4a': mic, 'system.m4a': system, 'music.m4a': music })) fs.symlinkSync(file, path.join(dir, name))
    const file = path.join(dir, 'project.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), audioStems: { mic: true, system: true } }, null, 2))

    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Stereo')
    const out = path.join(home, 'stereo.mp4')
    await exportMp4(app, win, out)
    const sound = pcmChannels(out)
    const level = (ch, freq) => amplitude(sound, ch, freq, 1, 5)
    const report = { mic: [level(0, 1000), level(1, 1000)], system: [level(0, 300), level(1, 300)], music: [level(0, 440), level(1, 440)] }
    console.log(`  ${sound.count} channels; left/right amplitude ${JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.map((x) => +x.toFixed(4))])))}`)
    // Before, the mono microphone made the whole soundtrack mono.
    h.assert(sound.count === 2, `the export is stereo (${sound.count} channels)`)
    // lavfi's sine is at 1/8 of full scale; the microphone at 80%, on both sides at full level.
    h.assert(Math.abs(report.mic[0] - 0.1) < 0.01 && Math.abs(report.mic[1] - 0.1) < 0.01, `the microphone on both sides at its level (${report.mic})`)
    // The stereo sources stay on their side, not averaged into the middle at half their level.
    for (const k of ['system', 'music']) {
      h.assert(Math.abs(report[k][0] - 0.125) < 0.012 && report[k][1] < 0.005, `the ${k} stays on the left at its level (${report[k]})`)
    }
  }))
}

main()
