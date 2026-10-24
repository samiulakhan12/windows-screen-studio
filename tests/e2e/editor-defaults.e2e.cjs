// Editor end-to-end tests: saved style defaults for new recordings (audit-C-4) and the
// recording length the editor keeps when the MP4's audio outlasts its video (seams-2).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

/**
 * Bundles the style defaults module (and createProject) on its own so the test can call,
 * inside the real main process, exactly what the recording code calls when it creates a
 * project: applyStyleDefaults(createProject(...), await loadStyleDefaults()).
 */
function bundleDefaultsModule(dir) {
  const outfile = path.join(dir, 'styleDefaults.cjs')
  esbuild.buildSync({
    stdin: {
      contents: "export * from './src/main/styleDefaults'\nexport { createProject } from './src/shared/engine/project'\n",
      resolveDir: h.APP_DIR,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile,
    logLevel: 'silent'
  })
  return outfile
}

/** Creates a project the way a finished recording does, in the main process. */
function createInMain(app, init) {
  return app.evaluate(async (_electron, init) => {
    const m = globalThis.__styleDefaults
    const project = m.createProject({
      id: init.id,
      name: init.name,
      duration: init.duration,
      width: 1280,
      height: 720,
      hasWebcam: init.hasWebcam,
      hasAudio: false,
      webcamOffset: 0,
      zooms: [],
      cursorValid: true,
      capture: init.capture
    })
    return m.applyStyleDefaults(project, await m.loadStyleDefaults())
  }, init)
}

const NATIVE = { method: 'native', cursorInVideo: false, region: null }
const CHROMIUM = { method: 'chromium', cursorInVideo: true, region: null }

/** Seeds a project folder (media, cursor) and replaces its project.json with `project`. */
function seedCreated(home, project) {
  f.seedProject(home, { id: project.id, name: project.name, seconds: project.duration, webcam: project.hasWebcam })
  fs.writeFileSync(path.join(h.projectsRoot(home), project.id, 'project.json'), JSON.stringify(project, null, 2))
}

const notice = (win, text) => win.waitForSelector(`.notice:has-text("${text}")`, { timeout: 10000 })
const pressed = (win, selector) => win.$eval(selector, (b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('active'))
const sliderText = (win, label) => win.$eval(`.slider:has-text("${label}") .slider-head .muted`, (e) => e.textContent)

async function backHome(win) {
  await win.click('button[aria-label="Back to recordings"]')
  await win.waitForSelector('.home', { timeout: 15000 })
}

async function main() {
  await h.run('editor: "Save as default" gives new recordings the saved look; Reset brings back the built-in one (audit-C-4)', async (ctx) => {
    const home = h.tempHome('defaults')
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-defaults-mod-'))
    try {
      f.seedProject(home, { id: 'rec-a', name: 'Styled', seconds: 4, webcam: true, capture: CHROMIUM })
      const { app, win, logs } = await h.launch({ home })
      ctx.app = app
      ctx.logs = logs
      const mod = bundleDefaultsModule(scratch)
      await app.evaluate((_e, file) => {
        globalThis.__styleDefaults = process.mainModule.require(file)
      }, mod)
      const userData = await app.evaluate(({ app }) => app.getPath('userData'))
      const file = path.join(userData, 'style-defaults.json')

      await win.waitForSelector('.home', { timeout: 30000 })
      await f.openProject(win, 'Styled')
      h.assert((await win.textContent('[data-testid="style-defaults-state"]')).includes('built-in look'), 'starts with the built-in look')
      h.assert(await win.$eval('button:has-text("Reset defaults")', (b) => b.disabled), 'nothing to reset yet')

      // A dark background, no padding, a rounded camera in the top-left, no motion blur, no click effect.
      await win.click('button[aria-label="Midnight background"]')
      await win.focus('.slider:has-text("Padding") input')
      await win.keyboard.press('Home')
      h.assert((await sliderText(win, 'Padding')) === '0%', 'padding set to 0')
      await win.click('.insp-tabs button:has-text("Camera")')
      await win.click('button.chip:has-text("Rounded")')
      await win.click('button[aria-label="top left"]')
      await win.click('.insp-tabs button:has-text("Effects")')
      await win.focus('.slider:has-text("Strength") input')
      await win.keyboard.press('Home')
      await win.click('.insp-tabs button:has-text("Cursor")')
      await win.click('label.toggle:has-text("Click effect")')

      await win.click('.insp-tabs button:has-text("Style")')
      await win.click('button:has-text("Save as default for new recordings")')
      await notice(win, 'Saved as default for new recordings')
      await f.waitFor(async () => (await win.textContent('[data-testid="style-defaults-state"]')).includes('saved look'), 'saved state shown')
      h.assert(!(await win.$eval('button:has-text("Reset defaults")', (b) => b.disabled)), 'reset enabled once saved')

      const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
      h.assert(stored.style.background.preset === 'midnight' && stored.style.padding === 0, `style stored: ${JSON.stringify(stored.style)}`)
      h.assert(stored.webcam.shape === 'rounded' && stored.webcam.corner === 'top-left' && !('show' in stored.webcam), `camera stored: ${JSON.stringify(stored.webcam)}`)
      h.assert(stored.cursor.clickEffect === false && !('show' in stored.cursor), `cursor stored: ${JSON.stringify(stored.cursor)}`)
      h.assert(stored.effects.motionBlur === 0, 'motion blur stored')

      // A new native recording with a camera gets the saved look; the recording still decides visibility.
      const b = await createInMain(app, { id: 'rec-b', name: 'New native', duration: 4, hasWebcam: true, capture: NATIVE })
      h.assert(b.style.background.type === 'gradient' && b.style.background.preset === 'midnight', `new project background: ${JSON.stringify(b.style.background)}`)
      h.assert(b.style.padding === 0 && b.effects.motionBlur === 0 && b.cursor.clickEffect === false, 'new project layout/effects/cursor')
      h.assert(b.webcam.shape === 'rounded' && b.webcam.corner === 'top-left' && b.webcam.show === true, `new project camera: ${JSON.stringify(b.webcam)}`)
      h.assert(b.cursor.show === true, 'smooth cursor on for a native recording, although the saved (screen-capture) project had it off')
      // A screen-capture recording without a camera: no smooth cursor, no camera, same look.
      const c = await createInMain(app, { id: 'rec-c', name: 'New chromium', duration: 4, hasWebcam: false, capture: CHROMIUM })
      h.assert(c.cursor.show === false && c.webcam.show === false && c.style.padding === 0, `chromium project: ${JSON.stringify({ cursor: c.cursor, webcam: c.webcam })}`)

      // The new project opens in the editor with that look.
      seedCreated(home, b)
      await backHome(win)
      await f.openProject(win, 'New native')
      h.assert(await pressed(win, 'button[aria-label="Midnight background"]'), 'Midnight swatch active in the new project')
      h.assert((await sliderText(win, 'Padding')) === '0%', 'padding 0 in the new project')
      await win.click('.insp-tabs button:has-text("Camera")')
      h.assert(await pressed(win, 'button.chip:has-text("Rounded")'), 'rounded camera in the new project')
      h.assert(await pressed(win, 'button[aria-label="top left"]'), 'camera top-left in the new project')

      // Reset: new recordings use the built-in look again.
      await win.click('.insp-tabs button:has-text("Style")')
      await win.click('button:has-text("Reset defaults")')
      await notice(win, 'Defaults reset')
      h.assert(!fs.existsSync(file), 'defaults file removed')
      await f.waitFor(async () => (await win.textContent('[data-testid="style-defaults-state"]')).includes('built-in look'), 'built-in state shown')
      const d = await createInMain(app, { id: 'rec-d', name: 'After reset', duration: 4, hasWebcam: true, capture: NATIVE })
      h.assert(d.style.background.preset === 'aurora' && d.style.padding === 0.07 && d.webcam.shape === 'circle' && d.webcam.corner === 'bottom-right', 'built-in look after reset')

      // A corrupt file never blocks a new recording.
      fs.writeFileSync(file, '{ not json')
      const e = await createInMain(app, { id: 'rec-e', name: 'Corrupt', duration: 4, hasWebcam: false, capture: NATIVE })
      h.assert(e.style.background.preset === 'aurora' && e.style.padding === 0.07, 'built-in look with a corrupt defaults file')
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })

  await h.run('editor: keeps the video length when the MP4 audio outlasts the video; still corrects a short file (seams-2)', async (ctx) => {
    const home = h.tempHome('length')
    // Like a native proxy: 3 s of video, separately recorded audio that runs on for 0.25 s more.
    const media = path.join(home, 'native-proxy.mp4')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-length-'))
    try {
      const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
      ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(tmp, 'v.mkv')])
      ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3.2', '-c:a', 'libopus', path.join(tmp, 'a.webm')])
      ff([
        '-i', path.join(tmp, 'v.mkv'), '-i', path.join(tmp, 'a.webm'), '-map', '0:v:0', '-map', '1:a:0', '-fps_mode', 'cfr', '-r', '60',
        '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-af', 'adelay=50:all=1', '-c:a', 'aac', '-movflags', '+faststart', media
      ])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    const container = f.ffprobeDuration(media)
    h.assert(container > 3.2, `fixture container is longer than the video (${container})`)

    const seed = (id, name, duration) => {
      f.seedProject(home, { id, name, seconds: 3, audio: true, capture: NATIVE })
      const dir = path.join(h.projectsRoot(home), id)
      fs.rmSync(path.join(dir, 'screen.mp4'))
      fs.symlinkSync(media, path.join(dir, 'screen.mp4'))
      const p = h.readProject(home, id)
      p.duration = duration
      p.clips = [{ id: 'c0', start: 0, end: duration, speed: 1 }]
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2))
    }
    seed('rec-exact', 'Exact', 3)
    // Recorded with a clock that ran 0.3 s long: the file's video wins.
    seed('rec-long', 'TooLong', 3.3)

    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.waitForSelector('.home', { timeout: 30000 })

    await f.openProject(win, 'Exact')
    const total = async () => (await win.textContent('.timecode')).split('/')[1].trim()
    h.assert((await total()) === '0:03.0', `length stays 3.0 s, not the container's ${container.toFixed(3)} s (got ${await total()})`)
    await win.click('.insp-tabs button:has-text("Clip")')
    h.assert((await win.textContent('.insp-body .hint')).includes('of 0:03.0 recorded'), 'recorded length 3.0 s')
    h.assert(await win.$('.save-state[data-state="saved"]'), 'nothing to save: the project was not changed')
    h.assert(h.readProject(home, 'rec-exact').duration === 3, 'duration on disk unchanged')

    await backHome(win)
    await f.openProject(win, 'TooLong')
    h.assert((await total()) === '0:03.0', `corrected to the video length (got ${await total()})`)
    await f.waitFor(() => Math.abs(h.readProject(home, 'rec-long').duration - 3) < 1e-6, 'corrected duration saved')
    const clips = h.readProject(home, 'rec-long').clips
    h.assert(clips.length === 1 && Math.abs(clips[0].end - 3) < 1e-6, `clip follows the video length: ${JSON.stringify(clips)}`)
  })
}

main()
