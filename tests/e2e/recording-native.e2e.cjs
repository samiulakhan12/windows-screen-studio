// Native capture integration through the nativeCapture contract, using a fake helper
// (ffmpeg x11grab without the cursor) injected into the main process. Chromium then
// records audio only; the proxy combines both. A failing helper falls back to
// Chromium capture automatically.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const r = require('./recordingHelpers.cjs')

/** Installs a fake NativeCaptureApi (see src/main/recording/nativeVideo.ts). */
async function installFakeHelper(app, { fail = false, startDelayMs = 0, endAfterMs = 0 } = {}) {
  await app.evaluate((_electron, cfg) => {
    const { spawn } = process.mainModule.require('node:child_process')
    const log = (globalThis.__fakeNative = { starts: 0, calls: [], options: null })
    globalThis.__SSW_NATIVE_CAPTURE__ = {
      isNativeCaptureAvailable: async () => true,
      startNativeCapture(opts) {
        log.starts++
        log.options = opts
        if (cfg.fail) {
          return {
            started: Promise.reject(new Error('fake helper: capture unsupported')),
            pause() {},
            resume() {},
            stop: async () => ({ frames: 0, shapes: [] }),
            kill: () => void log.calls.push('kill')
          }
        }
        const spawnedAt = Date.now()
        // prettier-ignore
        const proc = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '60', '-video_size', '1920x1080', '-i', process.env.DISPLAY,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-progress', 'pipe:1', opts.output
        ], { stdio: ['pipe', 'pipe', 'inherit'] })
        let startedAt = 0
        let exited = false
        let stopRequested = false
        let onEnded = null
        const exit = new Promise((resolve) => proc.on('exit', resolve))
        const started = new Promise((resolve, reject) => {
          proc.on('error', reject)
          proc.on('exit', (code) => reject(new Error(`fake helper exited with ${code}`)))
          proc.stdout.on('data', (d) => {
            if (!startedAt && /frame=[1-9]/.test(String(d))) {
              startedAt = spawnedAt
              // A slow start (encoder setup, first frame) keeps the toolbar on "Starting…".
              setTimeout(() => resolve({ startedAt, width: 1920, height: 1080 }), cfg.startDelayMs)
            }
          })
        })
        void exit.then(() => {
          exited = true
          // The helper ended on its own (monitor unplugged): tell the app, as nativeCapture does.
          if (!stopRequested && startedAt && onEnded) {
            log.calls.push('ended')
            onEnded({ reason: 'closed' })
          }
        })
        if (cfg.endAfterMs) {
          started.then(
            () => setTimeout(() => !stopRequested && proc.stdin.end('q'), cfg.endAfterMs),
            () => undefined
          )
        }
        const result = () => ({ frames: 0, shapes: [{ at: startedAt + 300, shape: 'text' }, { at: startedAt + 1200, shape: 'pointer' }] })
        return {
          started,
          pause: () => void log.calls.push('pause'),
          resume: () => void log.calls.push('resume'),
          stop() {
            log.calls.push('stop')
            if (exited) return Promise.resolve(result())
            stopRequested = true
            proc.stdin.end('q')
            return exit.then(result)
          },
          kill() {
            log.calls.push('kill')
            stopRequested = true
            proc.kill('SIGKILL')
          },
          onEnded(cb) {
            onEnded = cb
          }
        }
      }
    }
  }, { fail, startDelayMs, endAfterMs })
  return () => app.evaluate(() => globalThis.__fakeNative)
}

/** seams-2: the proxy is exactly as long as its video, so the editor shows no frozen frames at the end. */
function assertNoFrozenTail(file, project) {
  const info = r.probe(file)
  const video = info.streams.find((s) => s.codec_type === 'video')
  const container = Number(info.format.duration)
  h.assert(Math.abs(container - Number(video.duration)) < 0.02, `container ${container} s = video ${video.duration} s`)
  h.assert(Math.abs(project.duration - Number(video.duration)) < 0.02, `project duration ${project.duration} = video ${video.duration}`)
}

;(async () => {
  await h.run('native capture: helper video + Chromium audio, cursor shapes, no cursor in video', async (ctx) => {
    const home = h.tempHome('rec-native')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    const fake = await installFakeHelper(app)
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    const tb = await r.startRecording(app, win)
    await h.sleep(2500)
    const dir = r.activeDir(home)
    h.assert(r.fileSize(path.join(dir, 'native.mp4')) > 0, 'the helper writes the video')
    h.assert(r.fileSize(path.join(dir, 'audio.webm')) > 0, 'Chromium streams the audio')
    h.assert(!fs.existsSync(path.join(dir, 'screen.webm')), 'Chromium does not record the screen')
    await tb.click('button.pause')
    await tb.waitForSelector('.rec-dot.paused')
    await h.sleep(500)
    await tb.click('button.pause')
    await tb.waitForSelector('.rec-dot:not(.paused)')
    await h.sleep(1000)
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })

    const state = await fake()
    h.assert(state.starts === 1 && typeof state.options.displayId === 'string' && state.options.fps === 60, `helper options ${JSON.stringify(state.options)}`)
    h.assert(JSON.stringify(state.calls) === JSON.stringify(['pause', 'resume', 'stop']), `helper driven: ${state.calls}`)

    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    const pdir = path.join(h.projectsRoot(home), id)
    h.assert(JSON.stringify(project.capture) === JSON.stringify({ method: 'native', cursorInVideo: false, region: null }), `capture ${JSON.stringify(project.capture)}`)
    h.assert(project.cursor.show === true, 'the synthetic cursor is on (no OS cursor in the video)')
    h.assert(project.hasAudio && project.width === 1920 && project.height === 1080, 'audio and helper video size')
    const streams = r.probe(path.join(pdir, 'screen.mp4')).streams
    h.assert(streams.some((s) => s.codec_type === 'audio') && streams.some((s) => s.codec_type === 'video' && s.width === 1920), 'proxy muxes helper video and Chromium audio')
    assertNoFrozenTail(path.join(pdir, 'screen.mp4'), project)
    const cursor = JSON.parse(fs.readFileSync(path.join(pdir, 'cursor.json'), 'utf8'))
    const shapes = cursor.shapes.map((s) => `${s.shape}@${s.t.toFixed(1)}`)
    h.assert(JSON.stringify(shapes) === JSON.stringify(['text@0.3', 'pointer@1.2']), `cursor shapes ${shapes}`)
    for (const f of ['native.mp4', 'audio.webm', 'recording.json']) h.assert(!fs.existsSync(path.join(pdir, f)), `${f} removed`)
  })

  await h.run('native capture failure falls back to Chromium capture automatically', async (ctx) => {
    const home = h.tempHome('rec-native-fail')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    const fake = await installFakeHelper(app, { fail: true })
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    const tb = await r.startRecording(app, win)
    await h.sleep(2500)
    await tb.click('button.stop')
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    const state = await fake()
    h.assert(state.starts === 1 && state.calls.includes('kill'), `failed helper was attempted and killed: ${JSON.stringify(state)}`)
    const project = h.readProject(home, h.listProjects(home)[0])
    h.assert(project.capture.method === 'chromium' && project.capture.cursorInVideo === true, `fell back: ${JSON.stringify(project.capture)}`)
    h.assert(project.hasAudio && project.duration > 1.5, 'the fallback recording has audio and content')
  })
  await h.run('native capture: a helper that ends on its own stops the recording, keeps it and says why (windows-1)', async (ctx) => {
    const home = h.tempHome('rec-native-ended')
    const { app, win, logs } = await h.launch({ home, args: r.FAKE_MEDIA })
    ctx.app = r.closable(app)
    ctx.logs = logs
    const fake = await installFakeHelper(app, { startDelayMs: 1500, endAfterMs: 2500 })
    await r.waitForSources(win)
    await (await win.$$('.record-panel select'))[0].selectOption({ index: 1 })
    await win.evaluate(() => {
      // What the processing overlay told the user.
      window.__overlayNotices = ''
      new MutationObserver(() => {
        const n = document.querySelector('.overlay-notices')
        if (n) window.__overlayNotices = n.textContent
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await r.readyToRecord(win)
    await win.click('button.record')
    const tb = await r.toolbar(app)
    // seams-5: the toolbar says the capture is starting while the helper gets ready.
    await tb.waitForSelector('.countdown-starting', { timeout: 15000 })
    await tb.waitForSelector('button.stop', { timeout: 20000 })
    // perf-5: no CSS animation keeps the toolbar repainting every frame.
    h.assert((await tb.evaluate(() => getComputedStyle(document.querySelector('.rec-dot')).animationName)) === 'none', 'recording dot is not animated by CSS')
    const t0 = Date.now()
    // No Stop click: the helper ends by itself after 2.5 s and the app stops the recording.
    await win.waitForSelector('.editor canvas', { timeout: 120000 })
    h.assert(Date.now() - t0 < 60000, 'stopped by itself')
    const state = await fake()
    h.assert(state.calls.includes('ended') && state.calls.includes('stop'), `helper ended, then the recording was stopped: ${state.calls}`)
    const notice = await win.evaluate(() => window.__overlayNotices)
    h.assert(/disconnected or turned off/.test(notice) && /kept/.test(notice), `the user is told why: "${notice}"`)

    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    h.assert(project.duration > 2 && project.duration < 6, `duration ${project.duration} is what the helper recorded`)
    h.assert(project.hasAudio, 'the audio recorded until then was kept')
    assertNoFrozenTail(path.join(h.projectsRoot(home), id, 'screen.mp4'), project)
  })
})()
