// Audio pack in the real built app: background music with ducking, loop and fades (levels
// measured per time window of the export), per-source volume of microphone / system stems,
// music in an M4A, an older project exporting as before (re-timed clips now exactly on their
// video), the Music controls, the preview keeping stems and music on time, and stems kept by
// real recordings (Chromium and native capture), aligned with the mixed sound, or not at all
// once one fails (the mixed sound then has every source).
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const h = require('./helpers.cjs')
const sp = require('./speech-fixtures.cjs')
const fx = require('./render-fixtures.cjs')
const r = require('./recordingHelpers.cjs')

/** The app's own ffmpeg: references made with it encode bit for bit like the app's exports. */
const FF = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const RATE = 48000

const SHOTS = process.env.SSW_E2E_SHOTS || null
const shot = async (win, name) => SHOTS && win.screenshot({ path: path.join(SHOTS, `${name}.png`) })

/** Runs one test; SSW_E2E_ONLY=<substring> runs only matching tests. */
function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/* ---------- fixtures ---------- */

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

/** A small 60 fps video with a soundtrack from an ffmpeg audio filter expression. */
const videoWithSound = (name, seconds, audioGraph) =>
  cached(`audio-pack-${name}.mp4`, [
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=60`,
    '-f', 'lavfi', '-i', audioGraph,
    '-t', String(seconds), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'
  ])

const audioOnly = (name, seconds, audioGraph, ext = 'm4a') =>
  cached(`audio-pack-${name}.${ext}`, ['-f', 'lavfi', '-i', audioGraph, '-t', String(seconds), ...(ext === 'mp3' ? ['-c:a', 'libmp3lame'] : ['-c:a', 'aac', '-b:a', '192k'])])

/** A tone of `freq` Hz at amplitude `amp`, sounding where `when` (an expression in t) is true. */
const toneGraph = (freq, amp, when = '1') => `sine=frequency=${freq}:sample_rate=48000,volume='if(${when},${amp * 8},0)':eval=frame`

/** The microphone beeps (1 kHz, 0.1 s at the start of every second) over a steady system sound (300 Hz). */
const micBeeps = toneGraph(1000, 0.2, 'lt(mod(t,1),0.1)')
/** A 6 s video whose mixed sound is the beeping microphone and the system sound. */
const stemsMixMedia = () =>
  cached('audio-pack-stems-mix-beeps.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60',
    '-filter_complex', `${micBeeps}[m];${toneGraph(300, 0.2)}[s];[m][s]amix=inputs=2:normalize=0[a]`, '-t', '6', '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'
  ])

/** Seeds a project (render-fixtures layout) and adds the given files and project fields. */
function seed(home, opts) {
  const id = fx.seedProject(home, opts)
  const dir = path.join(h.projectsRoot(home), id)
  for (const [name, file] of Object.entries(opts.files || {})) fs.symlinkSync(file, path.join(dir, name))
  const file = path.join(dir, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...(opts.extra || {}) }, null, 2))
  return { id, dir }
}

async function openEditor(ctx, home, name, { hookMedia = false } = {}) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  if (hookMedia) {
    // Keep handles on the editor's (detached) media elements.
    await win.waitForSelector('.home', { timeout: 30000 })
    await win.evaluate(() => {
      const create = document.createElement.bind(document)
      window.__media = []
      document.createElement = (tag, ...rest) => {
        const el = create(tag, ...rest)
        if (/^(video|audio)$/i.test(String(tag))) window.__media.push(el)
        return el
      }
    })
  }
  await fx.openProject(win, name)
  return { app, win }
}

async function closeDialog(win) {
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Exports with the dialog to `out` in `format` and waits until it is done. */
async function exportAs(app, win, out, format, { resolution = '720p', keepOpen = false } = {}) {
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Format', format)
  if (format !== 'M4A') await fx.pickChip(win, 'Resolution', resolution)
  await h.mockSaveDialog(app, out)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const res = await fx.waitForExport(win)
  h.assert(res.ok, `export finished: ${res.text}`)
  if (!keepOpen) await closeDialog(win)
  return res
}

const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const readProject = (home, id) => h.readProject(home, id)

/* ---------- measuring ---------- */

/** Samples of each channel of the first audio stream of `file`, at 48 kHz. */
function channels(file) {
  const n = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]).toString().trim())
  h.assert(n >= 1, `${file} has sound (${n} channels)`)
  const out = execFileSync(FF, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  const all = new Float32Array(out.buffer, out.byteOffset, out.length / 4)
  const len = Math.floor(all.length / n)
  return Array.from({ length: n }, (_, c) => Float32Array.from({ length: len }, (_, i) => all[i * n + c]))
}

/**
 * The first audio stream of `file` as one signal at 48 kHz: the mean of its channels, so a
 * level reads as heard on each side. Sources mixed with others are exported in stereo, a mono
 * one on both sides at its own level; ffmpeg's -ac 1 adds the two sides at -3 dB each and would
 * read such a track sqrt(2) louder than it plays.
 */
function pcm(file) {
  const ch = channels(file)
  if (ch.length === 1) return ch[0]
  const out = new Float32Array(ch[0].length)
  for (const c of ch) for (let i = 0; i < out.length; i++) out[i] += c[i] / ch.length
  return out
}

/** Amplitude of the `freq` Hz component of [from, to) seconds (Goertzel). */
function amplitude(s, freq, from, to) {
  const a = Math.round(from * RATE)
  const b = Math.min(s.length, Math.round(to * RATE))
  const n = b - a
  const k = 2 * Math.cos((2 * Math.PI * freq) / RATE)
  let s1 = 0
  let s2 = 0
  for (let i = a; i < b; i++) {
    const s0 = s[i] + k * s1 - s2
    s2 = s1
    s1 = s0
  }
  const power = s1 * s1 + s2 * s2 - k * s1 * s2
  return (2 * Math.sqrt(Math.max(0, power))) / n
}

/** Onsets (seconds) of sound bursts: where the level rises above a third of its peak after a quiet stretch. */
function onsets(s, rate = RATE) {
  const win = Math.round(rate / 200)
  const levels = []
  for (let i = 0; i + win <= s.length; i += win) {
    let peak = 0
    for (let j = i; j < i + win; j++) peak = Math.max(peak, Math.abs(s[j]))
    levels.push(peak)
  }
  const max = Math.max(...levels)
  const out = []
  let on = false
  levels.forEach((v, i) => {
    if (!on && v > max / 3) {
      out.push((i * win) / rate)
      on = true
    } else if (on && v < max / 12) on = false
  })
  return out
}

const close = (a, b, tol) => Math.abs(a - b) <= tol

/** Onsets (seconds) of bursts of the `freq` Hz component, from its level in 10 ms steps. */
function bandOnsets(s, freq) {
  const step = 0.01
  const levels = []
  for (let t = 0; t + 0.02 <= s.length / RATE; t += step) levels.push(amplitude(s, freq, t, t + 0.02))
  const max = Math.max(...levels)
  const out = []
  let on = false
  levels.forEach((v, i) => {
    if (!on && v > max / 2) {
      out.push(i * step)
      on = true
    } else if (on && v < max / 8) on = false
  })
  return out
}

/* ---------- fake native helper (as in recording-native.e2e.cjs) ---------- */

async function installFakeHelper(app) {
  await app.evaluate(() => {
    const { spawn: run } = process.mainModule.require('node:child_process')
    globalThis.__SSW_NATIVE_CAPTURE__ = {
      isNativeCaptureAvailable: async () => true,
      startNativeCapture(opts) {
        const spawnedAt = Date.now()
        // prettier-ignore
        const proc = run('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(opts.fps || 60), '-video_size', '1920x1080', '-i', process.env.DISPLAY,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1', opts.output
        ], { stdio: ['pipe', 'pipe', 'inherit'] })
        let startedAt = 0
        const exit = new Promise((resolve) => proc.on('exit', resolve))
        const started = new Promise((resolve, reject) => {
          proc.on('error', reject)
          proc.on('exit', (code) => reject(new Error(`fake helper exited with ${code}`)))
          proc.stdout.on('data', (d) => {
            if (!startedAt && /frame=[1-9]/.test(String(d))) {
              startedAt = spawnedAt
              resolve({ startedAt, width: 1920, height: 1080 })
            }
          })
        })
        return {
          started,
          pause() {},
          resume() {},
          stop() {
            proc.stdin.end('q')
            return exit.then(() => ({ frames: 0, shapes: [] }))
          },
          kill: () => proc.kill('SIGKILL'),
          onEnded() {}
        }
      }
    }
  })
}

/* ---------- tests ---------- */

async function main() {
  await test('audio pack: music loops, fades and ducks under the recording, on the output timeline (M4A and MP4)', fx.withHome('ap-music', async (ctx, home) => {
    // The speech detector runs on this sound: it must be there, so nothing passes silently on the fallback.
    sp.requireSpeechAssets({ model: false })
    // The recording "speaks" (1 kHz) from 2 to 3.5 s and from 6 to 7 s; 4.5-5.5 s is cut.
    const media = videoWithSound('speech', 9, toneGraph(1000, 0.25, 'between(t,2,3.5)+between(t,6,7)'))
    const musicFile = audioOnly('music-3s', 3, toneGraph(440, 0.125))
    const clips = [
      { id: 'a', start: 0, end: 4.5, speed: 1 },
      { id: 'b', start: 5.5, end: 9, speed: 1 }
    ]
    seed(home, {
      name: 'Music demo',
      media,
      seconds: 9,
      audio: true,
      clips,
      files: { 'music.m4a': musicFile },
      audioSettings: { volume: 1, muted: false, fadeOut: 0.5, music: { path: 'music.m4a', volume: 0.5, ducking: 0.8, loop: true, fadeIn: 1, fadeOut: 1 } }
    })
    const { app, win } = await openEditor(ctx, home, 'Music demo')
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.waitForSelector('[data-testid="music-file"]')
    h.assert((await win.textContent('[data-testid="music-file"]')).includes('M4A · 0:03'), 'the music file is shown with its length')
    await shot(win, 'audio-panel-music')

    const m4a = path.join(home, 'music.m4a')
    await exportAs(app, win, m4a, 'M4A')
    const s = pcm(m4a)
    h.assert(close(s.length / RATE, 8, 0.03), `M4A is 8 s long (the edit): ${s.length / RATE}`)
    const M = 0.0625 // music amplitude: 0.125 at 50%
    // Windows never span a loop point (every 3 s): the tone's phase jumps there.
    const music = (a, b) => amplitude(s, 440, a, b) / M
    const speech = (a, b) => amplitude(s, 1000, a, b)
    const report = {
      fadeIn: music(0, 0.1),
      full: music(1.2, 1.7),
      ducked: music(2.3, 2.95),
      back: music(4.1, 4.5),
      ducked2: music(5.2, 5.8),
      beforeEnd: music(6.6, 6.95),
      end: music(7.92, 8)
    }
    console.log(`  music levels (1 = full): ${JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, +v.toFixed(3)])))}`)
    h.assert(report.fadeIn < 0.15, `music fades in (${report.fadeIn})`)
    h.assert(close(report.full, 1, 0.1), `music at its volume (${report.full})`)
    // Each side on its own: the music at its volume and ducked, not one side louder for the other.
    for (const [i, side] of channels(m4a).entries()) {
      const full = amplitude(side, 440, 1.2, 1.7) / M
      const ducked = amplitude(side, 440, 2.3, 2.95) / M
      h.assert(close(full, 1, 0.1) && close(ducked, 0.2, 0.06), `channel ${i}: music at its volume (${full}) and ducked (${ducked})`)
    }
    h.assert(close(report.ducked, 0.2, 0.06), `music ducked by 80% under the recording (${report.ducked})`)
    h.assert(close(report.back, 1, 0.1), `music back up after the release, and still playing after its 3 s file looped (${report.back})`)
    // Speech at 6-7 s (source) is at 5-6 s of the output: the ducking follows the cut.
    h.assert(close(report.ducked2, 0.2, 0.06), `ducking follows the edit's timeline (${report.ducked2})`)
    h.assert(close(report.beforeEnd, 1, 0.12), `full again before the fades (${report.beforeEnd})`)
    h.assert(report.end < 0.1, `music and soundtrack fade out at the end (${report.end})`)
    h.assert(close(speech(2.3, 3.3), 0.25, 0.04), `the recording plays at its own level (${speech(2.3, 3.3)})`)
    h.assert(speech(0.5, 1.5) < 0.01, 'no recording sound where it was silent')
    // The ramp starts just before the sound: the music already dips at 1.95 s.
    h.assert(music(1.9, 1.98) < 0.95 && music(1.9, 1.98) > 0.3, `the music dips ahead of the sound (${music(1.9, 1.98)})`)

    const mp4 = path.join(home, 'music.mp4')
    await exportAs(app, win, mp4, 'MP4')
    const info = fx.probe(mp4)
    const a = info.streams.find((x) => x.codec_type === 'audio')
    const v = info.streams.find((x) => x.codec_type === 'video')
    h.assert(a && close(Number(a.duration), Number(v.duration), 0.05), `MP4 audio as long as the video (${a && a.duration} / ${v.duration})`)
    const sv = pcm(mp4)
    h.assert(close(amplitude(sv, 440, 2.3, 2.95) / M, 0.2, 0.06) && close(amplitude(sv, 440, 1.2, 1.7) / M, 1, 0.1), 'the MP4 has the same music and ducking')
  }))

  await test('audio pack: per-source volume and mute of the microphone and system stems change the export; the preview keeps them on time', fx.withHome('ap-stems', async (ctx, home) => {
    // The speech detector runs on this sound: it must be there, so nothing passes silently on the fallback.
    sp.requireSpeechAssets({ model: false })
    const beeps = micBeeps
    const media = stemsMixMedia()
    const mic = audioOnly('stem-mic-beeps', 6, beeps)
    const system = audioOnly('stem-system', 6, toneGraph(300, 0.2))
    const music = audioOnly('music-8s', 8, toneGraph(440, 0.125))
    const { id } = seed(home, {
      name: 'Stems demo',
      media,
      seconds: 6,
      audio: true,
      clips: [
        { id: 'a', start: 0, end: 2, speed: 1 },
        { id: 'b', start: 3, end: 6, speed: 2 }
      ],
      files: { 'mic.m4a': mic, 'system.m4a': system, 'music.m4a': music },
      extra: { audioStems: { mic: true, system: true } }
    })
    const { app, win } = await openEditor(ctx, home, 'Stems demo', { hookMedia: true })
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.waitForSelector('.insp-section h3:has-text("Microphone")')
    await win.waitForSelector('.insp-section h3:has-text("System sound")')
    await shot(win, 'audio-panel-stems')

    // Default settings: the mixed track, both sources at the same level.
    const plain = path.join(home, 'plain.m4a')
    await exportAs(app, win, plain, 'M4A')
    let s = pcm(plain)
    // A beep of the microphone against the system sound, inside the first (1x) clip.
    const ratio = () => amplitude(s, 1000, 1.01, 1.09) / amplitude(s, 300, 1.01, 1.09)
    h.assert(close(ratio(), 1, 0.08), `both sources at the same level (${ratio()})`)

    // Microphone to about 25% with its slider.
    const slider = await win.$('.slider:has-text("Microphone volume") input')
    await slider.scrollIntoViewIfNeeded()
    const box = await slider.boundingBox()
    await win.mouse.click(box.x + box.width * 0.125, box.y + box.height / 2)
    await waitSaved(win)
    const micVolume = readProject(home, id).audio.mic.volume
    h.assert(micVolume > 0.15 && micVolume < 0.35, `microphone volume saved (${micVolume})`)
    const quieter = path.join(home, 'mic-quieter.m4a')
    await exportAs(app, win, quieter, 'M4A')
    s = pcm(quieter)
    console.log(`  microphone at ${micVolume}: 1 kHz / 300 Hz = ${ratio().toFixed(3)}`)
    h.assert(close(ratio(), micVolume, 0.05), `the microphone is at its own volume in the export (${ratio()} for ${micVolume})`)
    h.assert(close(s.length / RATE, 3.5, 0.03), `cuts and speed apply to the stems (${s.length / RATE} s)`)
    // Beeps at source 0, 1 (1x), then 3, 4, 5 in the 2x clip: output 0, 1, 2, 2.5, 3.
    const beepsAt = bandOnsets(s, 1000)
    h.assert(
      beepsAt.length === 5 && [0, 1, 2, 2.5, 3].every((t, i) => close(beepsAt[i], t, 0.03)),
      `the microphone follows the cut and the 2x clip (${beepsAt.map((t) => t.toFixed(3))})`
    )

    // Mute the system sound.
    await win.click('label.toggle:has-text("Mute system sound")')
    await waitSaved(win)
    const noSystem = path.join(home, 'no-system.m4a')
    await exportAs(app, win, noSystem, 'M4A')
    s = pcm(noSystem)
    h.assert(amplitude(s, 300, 0.3, 1.7) < 0.003 && amplitude(s, 1000, 1.01, 1.09) > 0.03, 'the muted system sound is gone, the microphone stays')

    // The preview plays the stems (and music) in step with the video, through the cut and the 2x clip.
    await win.click('.insp-tabs button:has-text("Audio")')
    const project = readProject(home, id)
    project.audio.music = { path: 'music.m4a', volume: 0.5, ducking: 0.5, loop: true, fadeIn: 0, fadeOut: 0 }
    await app.close()
    ctx.app = null
    fs.writeFileSync(path.join(h.projectsRoot(home), id, 'project.json'), JSON.stringify(project, null, 2))
    const again = await openEditor(ctx, home, 'Stems demo', { hookMedia: true })
    const pwin = again.win
    await pwin.keyboard.press('Home')
    await pwin.keyboard.press('Space')
    const samples = []
    const audioPaused = () => pwin.evaluate(() => window.__media.filter((m) => m.tagName === 'AUDIO' && m.getAttribute('src')).every((m) => m.paused))
    // The edit is 3.5 s long: sample while it plays, then let it reach its end.
    for (let i = 0; i < 9; i++) {
      await h.sleep(250)
      samples.push(
        await pwin.evaluate(() => {
          const els = window.__media.filter((m) => m.getAttribute('src'))
          const video = els.find((m) => m.tagName === 'VIDEO' && /screen\.mp4/.test(m.src))
          const pick = (re) => els.find((m) => m.tagName === 'AUDIO' && re.test(m.src))
          const state = (m) => (m ? { t: m.currentTime, paused: m.paused, rate: m.playbackRate } : null)
          return { video: state(video), mic: state(pick(/mic\.m4a/)), music: state(pick(/music\.m4a/)), system: state(pick(/system\.m4a/)) }
        })
      )
    }
    await pwin.waitForFunction(() => document.querySelector('.transport .btn.round')?.dataset.playing === 'false', null, { timeout: 10000 })
    h.assert(await audioPaused(), 'stems and music stop at the end of the edit')
    // Pausing by hand pauses them too.
    await pwin.keyboard.press('Home')
    await pwin.keyboard.press('Space')
    await h.sleep(600)
    await pwin.keyboard.press('Space')
    await h.sleep(100)
    h.assert(await audioPaused(), 'stems and music pause with the video')
    const playing = samples.filter((x) => x.video && !x.video.paused && x.mic && !x.mic.paused)
    h.assert(playing.length >= 6, `the microphone stem plays with the video (${JSON.stringify(samples.slice(0, 3))})`)
    const drift = Math.max(...playing.map((x) => Math.abs(x.mic.t - x.video.t)))
    console.log(`  preview: largest microphone/video drift ${drift.toFixed(3)} s over ${playing.length} samples`)
    h.assert(drift < 0.2, `the stem stays with the video through the cut and the speed change (drift ${drift})`)
    h.assert(samples.some((x) => x.video && x.video.t > 3), 'playback went past the cut')
    // The music runs on the output timeline: it started at 0 and keeps going at normal speed.
    const withMusic = samples.filter((x) => x.music && !x.music.paused)
    h.assert(withMusic.length >= 6, 'the music plays during playback')
    h.assert(withMusic.every((x) => x.music.rate > 0.9 && x.music.rate < 1.1), 'the music plays at its own speed even in the 2x clip')
    // Output time of the video's position: 0-2 s at 1x, then source 3-6 s at 2x.
    const outputOf = (t) => (t < 2 ? t : 2 + (t - 3) / 2)
    const musicDrift = Math.max(...withMusic.filter((x) => !x.video.paused).map((x) => Math.abs(x.music.t - outputOf(x.video.t))))
    console.log(`  preview: largest music/output-time drift ${musicDrift.toFixed(3)} s`)
    h.assert(musicDrift < 0.35, `the music follows the output timeline through the cut (drift ${musicDrift})`)
  }))

  await test('audio pack: a recording whose system sound file is missing opens with its mixed sound and names that file; preview and export agree, and the stems are used again once the file is back', fx.withHome('ap-stem-missing', async (ctx, home) => {
    const media = stemsMixMedia()
    const mic = audioOnly('stem-mic-beeps', 6, micBeeps)
    const system = audioOnly('stem-system', 6, toneGraph(300, 0.2))
    // The microphone was muted while system.m4a was still there; now it is gone (a folder copied in part).
    const { id, dir } = seed(home, {
      name: 'Lost stem',
      media,
      seconds: 6,
      audio: true,
      files: { 'mic.m4a': mic },
      audioSettings: { volume: 1, muted: false, mic: { volume: 1, muted: true } },
      extra: { audioStems: { mic: true, system: true } }
    })
    const { app, win } = await openEditor(ctx, home, 'Lost stem', { hookMedia: true })
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.waitForSelector('[data-testid="stems-missing"]')
    const said = (await win.textContent('[data-testid="stems-missing"]')).trim()
    h.assert(/^The system sound file of this recording \(system\.m4a\) is missing, so a source can no longer be muted or turned down on its own/.test(said), `the Audio panel names the missing file: ${said}`)
    h.assert(!/microphone|mic\.m4a/.test(said), `and only that one (mic.m4a is there): ${said}`)
    h.assert(/including one you muted or turned down/.test(said), `and says the muted microphone is heard: ${said}`)
    h.assert(!(await win.$('.insp-section h3:has-text("Microphone")')), 'no per-source controls that cannot apply')
    await shot(win, 'audio-panel-stem-missing')
    // The preview plays the video's own (mixed) track: no stem is loaded.
    await win.click('.transport .btn.round')
    await h.sleep(800)
    await win.click('.transport .btn.round')
    const stems = await win.evaluate(() => window.__media.filter((m) => /(mic|system)\.m4a/.test(m.src)).length)
    h.assert(stems === 0, `the preview plays the mixed sound (${stems} stem elements)`)
    // The export plays the same: the microphone is in it, as the panel said.
    const out = path.join(home, 'lost-stem.m4a')
    await exportAs(app, win, out, 'M4A')
    let s = pcm(out)
    const ratio = amplitude(s, 1000, 1.01, 1.09) / amplitude(s, 300, 1.01, 1.09)
    h.assert(close(ratio, 1, 0.1), `the export has every source, like the preview (${ratio})`)
    // An edit is saved with the stems the recording kept and the microphone still muted.
    await win.click('.title-input')
    await win.keyboard.press('End')
    await win.keyboard.type(' 2')
    await win.keyboard.press('Enter')
    await waitSaved(win)
    const saved = readProject(home, id)
    h.assert(
      saved.name === 'Lost stem 2' && saved.audioStems?.mic === true && saved.audioStems?.system === true && saved.audio.mic?.muted === true,
      `the stems and their settings are kept: ${JSON.stringify({ name: saved.name, stems: saved.audioStems, audio: saved.audio })}`
    )

    // The file is back (the copy finished): opening the recording again uses the stems, microphone muted.
    fs.symlinkSync(system, path.join(dir, 'system.m4a'))
    await win.click('button[aria-label="Back to recordings"]')
    await fx.openProject(win, 'Lost stem 2')
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.waitForSelector('.insp-section h3:has-text("Microphone")')
    h.assert(!(await win.$('[data-testid="stems-missing"]')), 'no notice once the file is back')
    h.assert(await win.isChecked('input[aria-label="Mute microphone"]'), 'the microphone is still muted')
    const back = path.join(home, 'stem-back.m4a')
    await exportAs(app, win, back, 'M4A')
    s = pcm(back)
    h.assert(amplitude(s, 1000, 1.01, 1.09) < 0.003 && amplitude(s, 300, 0.3, 1.7) > 0.1, 'the export leaves the muted microphone out again')
  }))

  await test('audio pack: M4A includes the music, also for a recording without sound', fx.withHome('ap-m4a', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: 1280, height: 720 })
    const music = audioOnly('music-mp3', 10, toneGraph(440, 0.125), 'mp3')
    seed(home, {
      name: 'Silent with music',
      media,
      seconds: 4,
      audio: false,
      files: { 'music.mp3': music },
      audioSettings: { volume: 1, muted: false, music: { path: 'music.mp3', volume: 1, ducking: 0.7, loop: false, fadeIn: 0, fadeOut: 0 } }
    })
    const { app, win } = await openEditor(ctx, home, 'Silent with music')
    await fx.openExportDialog(win)
    const disabled = await win.$eval('.modal .form-row:has(> span:text-is("Format")) .chip:text-is("M4A")', (b) => b.disabled)
    h.assert(!disabled, 'M4A can be chosen: the music is a soundtrack')
    await closeDialog(win)
    const out = path.join(home, 'silent-music.m4a')
    await exportAs(app, win, out, 'M4A')
    const s = pcm(out)
    h.assert(close(s.length / RATE, 4, 0.03), `M4A as long as the video (${s.length / RATE})`)
    h.assert(close(amplitude(s, 440, 1, 3), 0.125, 0.015), `the music is in the M4A at its volume (${amplitude(s, 440, 1, 3)})`)
    for (const [i, side] of channels(out).entries()) h.assert(close(amplitude(side, 440, 1, 3), 0.125, 0.015), `channel ${i}: the music at its volume (${amplitude(side, 440, 1, 3)})`)
  }))

  await test('audio pack: an older project (no stems, music or new settings) exports the audio it did before, with re-timed clips now exactly on their video and fades at its cuts', fx.withHome('ap-legacy', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 8, width: 1280, height: 720, beeps: true })
    const clips = [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 3, end: 5, speed: 2 },
      { id: 'c', start: 6, end: 7, speed: 0.5 }
    ]
    const { id, dir } = seed(home, { name: 'Older project', media, seconds: 8, audio: true, clips, audioSettings: { volume: 0.8, muted: false } })
    const before = fs.readFileSync(path.join(dir, 'project.json'), 'utf8')
    const { app, win } = await openEditor(ctx, home, 'Older project')
    await win.click('.insp-tabs button:has-text("Audio")')
    await shot(win, 'audio-panel-older')
    h.assert(!(await win.$('.insp-section h3:has-text("Microphone")')), 'no per-source controls without stems')
    const out = path.join(home, 'older.m4a')
    await exportAs(app, win, out, 'M4A')
    // What earlier versions ran for this project (see tests/fixtures/legacy-audio-args.json),
    // and the same graph with the intended changes: the clips are read at 48 kHz and each is
    // cut to the samples its video lasts (2 s, 1 s, 2 s), because atempo's output is a little
    // off the clip's length and every later clip used to move by that much; and each re-timed
    // clip is kept on its frames, as atempo plays its sound early (half a window per stage):
    // silence first, then the lead (1/96 s at 2x, 1/24 s at 0.5x) dropped from its output.
    const earlier =
      '[0:a]aresample=async=1:first_pts=0,asplit=3[s0][s1][s2];' +
      '[s0]atrim=start=0:end=2,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2[c0];' +
      '[s1]atrim=start=3:end=5,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2,atempo=2[c1];' +
      '[s2]atrim=start=6:end=7,asetpts=PTS-STARTPTS,apad=whole_dur=1,atrim=end=1,atempo=0.5[c2];' +
      '[c0][c1][c2]concat=n=3:v=0:a=1,volume=0.8,apad=whole_dur=5,atrim=end=5[aout]'
    const retimed = (pre, chain, lead) => `adelay=delays=${pre}:all=1,${chain},asetpts=PTS-STARTPTS,atrim=start_sample=${lead},asetpts=PTS-STARTPTS`
    const exact = earlier
      .replace('aresample=async=1', 'aresample=48000:async=1')
      .replace(',atempo=2[c1]', `,${retimed('41.667', 'atempo=2', 500)}[c1]`)
      .replace(',atempo=0.5[c2]', `,${retimed('41.667', 'atempo=0.5', 2000)}[c2]`)
      .replace('[c0];', ',apad=whole_len=96000,atrim=end_sample=96000[c0];')
      .replace('[c1];', ',apad=whole_len=48000,atrim=end_sample=48000[c1];')
      .replace('[c2];', ',apad=whole_len=96000,atrim=end_sample=96000[c2];')
      // Smooth cuts (NW-06): the sound fades out over 10 ms before each cut and in over 10 ms after it.
      .replace('atrim=end_sample=96000[c0];', 'atrim=end_sample=96000,afade=t=out:st=1.99:d=0.01[c0];')
      .replace('atrim=end_sample=48000[c1];', 'atrim=end_sample=48000,afade=t=in:st=0:d=0.01,afade=t=out:st=0.99:d=0.01[c1];')
      .replace('atrim=end_sample=96000[c2];', 'atrim=end_sample=96000,afade=t=in:st=0:d=0.01[c2];')
    const encode = (graph, file) =>
      // prettier-ignore
      execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin', '-vn', '-i', path.join(dir, 'screen.mp4'), '-filter_complex', graph, '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-f', 'ipod', file])
    encode(exact, path.join(home, 'reference.m4a'))
    encode(earlier, path.join(home, 'earlier.m4a'))
    const a = pcm(out)
    const b = pcm(path.join(home, 'reference.m4a'))
    let diff = 0
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff = Math.max(diff, Math.abs((a[i] ?? 9) - (b[i] ?? 9)))
    console.log(`  older project: ${a.length} samples, largest difference from the reference export ${diff}`)
    h.assert(a.length === b.length && diff < 1e-6, `the export's audio is exactly the earlier graph with exact, on-frame re-timed clips and fades at its cuts (${a.length} vs ${b.length} samples, max diff ${diff})`)
    // The last clip (0.5x from 3 s) on its own, as the video shows it: where does it start in each export?
    // prettier-ignore
    const alone = execFileSync(FF, ['-v', 'error', '-i', path.join(dir, 'screen.mp4'), '-af', `aresample=48000:async=1:first_pts=0,atrim=start=6:end=7,asetpts=PTS-STARTPTS,apad=whole_dur=1,atrim=end=1,${retimed('41.667', 'atempo=0.5', 2000)},volume=0.8`, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
    const clip = new Float32Array(alone.buffer, alone.byteOffset, alone.length / 4).subarray(0, RATE)
    const lagAt = (s, at) => {
      let best = 0
      let bestSum = -Infinity
      for (let lag = -480; lag <= 480; lag++) {
        let sum = 0
        for (let i = 0; i < clip.length; i++) sum += (s[at + lag + i] ?? 0) * clip[i]
        if (sum > bestSum) [best, bestSum] = [lag, sum]
      }
      return best
    }
    const now = lagAt(a, 3 * RATE)
    const then = lagAt(pcm(path.join(home, 'earlier.m4a')), 3 * RATE)
    console.log(`  older project: the 0.5x clip starts ${now} samples from its video time (earlier versions: ${then})`)
    h.assert(Math.abs(now) <= 1, `the last clip's sound starts with its video (${now} samples off)`)
    h.assert(Math.abs(then) > Math.abs(now), `earlier versions started it off its video (${then} samples), so the change is a fix`)
    await app.close()
    ctx.app = null
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
    h.assert(JSON.stringify(after.audio) === JSON.stringify(JSON.parse(before).audio) && !('audioStems' in after), `the project's sound settings are untouched: ${JSON.stringify(after.audio)}`)
    void id
  }))

  await test('audio pack: choose, replace and remove music in the Audio panel (undoable, also back to the replaced track)', fx.withHome('ap-pick', async (ctx, home) => {
    const media = videoWithSound('speech', 9, toneGraph(1000, 0.25, 'between(t,2,3.5)+between(t,6,7)'))
    const { id, dir } = seed(home, { name: 'Pick music', media, seconds: 9, audio: true })
    const { app, win } = await openEditor(ctx, home, 'Pick music')
    await win.click('.insp-tabs button:has-text("Audio")')
    const pickFile = async (file) =>
      app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
      }, file)
    // An unsupported file is refused with a readable message.
    const bad = path.join(home, 'notes.txt')
    fs.writeFileSync(bad, 'not music')
    await pickFile(bad)
    await win.click('button:has-text("Choose music")')
    await win.waitForSelector('[data-testid="music-error"]')
    const refusal = await win.textContent('[data-testid="music-error"]')
    h.assert(/Choose an MP3, M4A, AAC, WAV, Ogg, Opus or FLAC file/.test(refusal), `unsupported file explained: ${refusal}`)

    await pickFile(audioOnly('music-3s', 3, toneGraph(440, 0.125)))
    await win.click('button:has-text("Choose music")')
    await win.waitForSelector('[data-testid="music-file"]')
    await waitSaved(win)
    let music = readProject(home, id).audio.music
    h.assert(music && music.path === 'music-1.m4a' && music.volume === 0.35 && music.ducking === 0.7 && music.loop === true, `music added with defaults: ${JSON.stringify(music)}`)
    h.assert(fs.existsSync(path.join(dir, 'music-1.m4a')), 'the file is copied into the project')
    await shot(win, 'audio-panel-picked')

    // Settings survive a replacement.
    const volume = await win.$('.slider:has-text("Music volume") input')
    await volume.scrollIntoViewIfNeeded()
    const vb = await volume.boundingBox()
    await win.mouse.click(vb.x + vb.width * 0.5, vb.y + vb.height / 2)
    await waitSaved(win)
    await pickFile(audioOnly('music-mp3', 10, toneGraph(440, 0.125), 'mp3'))
    await win.click('button:has-text("Replace")')
    await h.sleep(500)
    await waitSaved(win)
    music = readProject(home, id).audio.music
    h.assert(music.path === 'music-2.mp3' && music.volume > 0.9 && music.volume < 1.1, `replaced, keeping the volume: ${JSON.stringify(music)}`)
    h.assert(fs.existsSync(path.join(dir, 'music-1.m4a')), 'the replaced track stays in the folder (undo can go back to it)')
    await win.waitForFunction(() => /MP3 · 0:10/.test(document.querySelector('[data-testid="music-file"]')?.textContent ?? ''))

    // Undo goes back to the first track, which plays and exports; redo to the new one.
    await win.keyboard.press('Control+z')
    await waitSaved(win)
    h.assert(readProject(home, id).audio.music.path === 'music-1.m4a', `undo brings back the first track: ${JSON.stringify(readProject(home, id).audio.music)}`)
    await win.waitForFunction(() => /M4A · 0:03/.test(document.querySelector('[data-testid="music-file"]')?.textContent ?? ''))
    h.assert(!(await win.$('[data-testid="music-missing"]')), 'the first track is found')
    const undone = path.join(home, 'undone.m4a')
    await exportAs(app, win, undone, 'M4A')
    const back = pcm(undone)
    h.assert(amplitude(back, 440, 0.5, 2.5) > 0.02, `the export has the music again, from the first track's file (${amplitude(back, 440, 0.5, 2.5)})`)
    await win.keyboard.press('Control+y')
    await waitSaved(win)
    h.assert(readProject(home, id).audio.music.path === 'music-2.mp3', 'redo returns to the replacement')

    await win.click('button[aria-label="Remove music"]')
    await waitSaved(win)
    h.assert(readProject(home, id).audio.music === null, 'music removed')
    await win.keyboard.press('Control+z')
    await win.waitForSelector('[data-testid="music-file"]')
    await waitSaved(win)
    h.assert(readProject(home, id).audio.music.path === 'music-2.mp3', 'undo brings it back')
  }))

  await test('audio pack: a Chromium recording keeps the microphone as its own track, aligned with the mixed sound', async (ctx) => {
    const home = h.tempHome('ap-rec')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    const tb = await r.startRecording(app, win)
    await h.sleep(1500)
    const dir = r.activeDir(home)
    h.assert(r.fileSize(path.join(dir, 'mic.webm')) > 0, 'the microphone is streamed to its own file while recording')
    await tb.click('button.pause')
    await tb.waitForSelector('.rec-dot.paused')
    await h.sleep(1500)
    await tb.click('button.pause')
    await tb.waitForSelector('.rec-dot:not(.paused)')
    await h.sleep(3000)
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    await checkRecordedStems(home, 'chromium')
    await win.click('.insp-tabs button:has-text("Audio")')
    await win.waitForSelector('.insp-section h3:has-text("Microphone")')
    h.assert(!(await win.$('.insp-section h3:has-text("System sound")')), 'no system sound section without system sound')
  })

  await test('audio pack: a native recording keeps the microphone as its own track, aligned with the mixed sound', async (ctx) => {
    const home = h.tempHome('ap-rec-native')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await installFakeHelper(app)
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    const tb = await r.startRecording(app, win)
    await h.sleep(4500)
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    await checkRecordedStems(home, 'native')
  })

  await test('audio pack: a recording interrupted by a crash keeps its microphone track when recovered', async (ctx) => {
    const home = h.tempHome('ap-rec-crash')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.captureDialogs(app)
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    await r.startRecording(app, win)
    await h.sleep(4500)
    const dir = r.activeDir(home)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
      main.webContents.forcefullyCrashRenderer()
    })
    await r.until(() => r.mainVisible(app), { what: 'main window shown after the crash' })
    h.assert(r.fileSize(path.join(dir, 'mic.webm')) > 0, 'the microphone file is kept with the interrupted recording')
    // Playwright's page object stays dead after a renderer crash: drive the reloaded page directly.
    const js = (code) =>
      app.evaluate(({ BrowserWindow }, c) => {
        const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
        return main.webContents.executeJavaScript(c)
      }, code)
    await r.until(() => js(`!!document.querySelector('.unfinished')`), { timeout: 20000, what: 'unfinished recording on Home' })
    await js(`[...document.querySelectorAll('.unfinished button')].find((b) => b.textContent.includes('Recover')).click()`)
    await r.until(() => js(`!!document.querySelector('.editor canvas')`), { timeout: 120000, what: 'editor after recovery' })
    await checkRecordedStems(home, 'chromium')
  })

  await test('audio pack: a microphone track that fails while recording is dropped at once; the recovered recording keeps its mixed sound', async (ctx) => {
    const home = h.tempHome('ap-rec-stem-fails')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    await r.captureDialogs(app)
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    await r.startRecording(app, win)
    const dir = r.activeDir(home)
    // A folder where the microphone's own file goes: its first write fails (the mixed sound is unaffected).
    fs.mkdirSync(path.join(dir, 'mic.webm'))
    const manifest = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8'))
      } catch {
        return {}
      }
    }
    // Started with a microphone track of its own, which the recorder drops when its writes fail.
    await r.until(() => Array.isArray(manifest().stems) && manifest().stems.length === 0 && manifest().hasAudio === true, {
      timeout: 20000,
      what: 'the recording stops expecting stems as soon as one fails'
    })
    await r.until(() => logs.join('').includes('stopped being recorded on its own'), { what: 'the stems were started, then dropped while recording' })
    await h.sleep(1500)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
      main.webContents.forcefullyCrashRenderer()
    })
    await r.until(() => r.mainVisible(app), { what: 'main window shown after the crash' })
    h.assert(JSON.stringify(manifest().stems) === '[]', `the interrupted recording expects no stems: ${JSON.stringify(manifest().stems)}`)
    const js = (code) =>
      app.evaluate(({ BrowserWindow }, c) => {
        const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('#/'))
        return main.webContents.executeJavaScript(c)
      }, code)
    await r.until(() => js(`!!document.querySelector('.unfinished')`), { timeout: 20000, what: 'unfinished recording on Home' })
    await js(`[...document.querySelectorAll('.unfinished button')].find((b) => b.textContent.includes('Recover')).click()`)
    await r.until(() => js(`!!document.querySelector('.editor canvas')`), { timeout: 120000, what: 'editor after recovery' })
    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    h.assert(project.hasAudio === true && !('audioStems' in project), `the mixed sound only, no stems: ${JSON.stringify({ hasAudio: project.hasAudio, audioStems: project.audioStems })}`)
    h.assert(!fs.existsSync(path.join(dir, 'mic.m4a')), 'no microphone track is kept')
    h.assert(onsets(pcm(path.join(dir, 'screen.mp4'))).length >= 2, 'the mixed sound has the microphone')
    await js(`[...document.querySelectorAll('.insp-tabs button')].find((b) => b.textContent.includes('Audio')).click()`)
    await r.until(() => js(`!!document.querySelector('.insp-section h3')`), { what: 'audio panel' })
    h.assert(!(await js(`[...document.querySelectorAll('.insp-section h3')].some((e) => /Microphone|System sound/.test(e.textContent))`)), 'no per-source sections')
  })
}

/** The newest recording has a microphone stem as long as the video, with its sound where the mixed track has it. */
async function checkRecordedStems(home, method) {
  const [id] = h.listProjects(home)
  const project = h.readProject(home, id)
  const dir = path.join(h.projectsRoot(home), id)
  h.assert(project.capture.method === method, `recorded with ${method} capture (${project.capture.method})`)
  h.assert(JSON.stringify(project.audioStems) === JSON.stringify({ mic: true, system: false }), `stems listed: ${JSON.stringify(project.audioStems)}`)
  for (const f of ['mic.webm', 'system.webm', 'recording.json']) h.assert(!fs.existsSync(path.join(dir, f)), `${f} removed`)
  const mic = pcm(path.join(dir, 'mic.m4a'))
  const mix = pcm(path.join(dir, 'screen.mp4'))
  h.assert(close(mic.length / RATE, project.duration, 0.05), `the stem is as long as the video (${mic.length / RATE} vs ${project.duration})`)
  // Compared over the recording, which ends with the video's last frame. The stem ends there;
  // the mixed track of a Chromium recording can run a few tens of ms longer, and a burst that
  // starts in that tail is never played or exported.
  const end = Math.round(project.duration * RATE)
  const a = onsets(mic.subarray(0, end))
  const b = onsets(mix.subarray(0, end))
  console.log(`  ${method}: stem onsets ${a.map((t) => t.toFixed(3)).join(' ')} | mixed ${b.map((t) => t.toFixed(3)).join(' ')}`)
  h.assert(a.length >= 2 && a.length === b.length, `the same sound bursts in both (${a.length} vs ${b.length})`)
  const worst = Math.max(...a.map((t, i) => Math.abs(t - b[i])))
  h.assert(worst < 0.012, `the stem is aligned with the mixed sound (largest offset ${worst.toFixed(3)} s)`)
}

main()
