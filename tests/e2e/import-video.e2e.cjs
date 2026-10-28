// Import a video (NW-07) in the real built app (docs/design/import-video.md §11 test plan):
// the Import video button imports a rotated phone-style MOV and opens the editor, whose cursor,
// zoom, effects and camera tabs explain what an imported video cannot have; a manual zoom is added
// and the project exports with its sound at the right length. A dropped MKV with two sound tracks
// shows its note before opening; refusals (sound only, several files, a fake video) are shown and
// leave nothing behind; Cancel stops a long import at once. Old projects still open.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const FFMPEG = require(path.join(h.APP_DIR, 'node_modules/ffmpeg-static'))
const SHOTS = process.env.SSW_E2E_SHOTS || null

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const ff = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args])

/** Media made once per run, outside any HOME. */
const MEDIA = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ssw-e2e-import-media-'))
process.on('exit', () => fs.rmSync(MEDIA, { recursive: true, force: true }))
const at = (name) => path.join(MEDIA, name)

function makeMedia() {
  // A phone video: 640 x 360 stored, shown upright (rotation 90), 30 fps, with sound.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', at('flat.mov'))
  ff('-display_rotation', '90', '-i', at('flat.mov'), '-c', 'copy', at('Phone clip.mov'))
  // OBS-style MKV with two sound tracks at 60 fps.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-f', 'lavfi', '-i', 'sine=f=440', '-f', 'lavfi', '-i', 'sine=f=880', '-t', '2', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', at('obs tracks.mkv'))
  ff('-f', 'lavfi', '-i', 'sine', '-t', '2', '-c:a', 'aac', '-f', 'mp4', at('voice memo.mp4'))
  // Long enough that Cancel lands while the copy is being made.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', at('long.mp4'))
  fs.writeFileSync(at('fake.mp4'), Buffer.alloc(8192, 0x41))
}

/** ffprobe's view of a file: streams and duration. */
function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]).toString())
}

/** Drops real files (with paths, as from Explorer) on the library. */
async function dropFiles(win, files) {
  await win.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = 'e2e-drop-files'
    input.style.display = 'none'
    document.body.appendChild(input)
  })
  await win.setInputFiles('#e2e-drop-files', files)
  await win.evaluate(() => {
    const input = document.getElementById('e2e-drop-files')
    const target = document.querySelector('[data-testid="import-drop"]')
    const data = new DataTransfer()
    for (const file of input.files) data.items.add(file)
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    input.remove()
  })
}

async function dialogText(win) {
  return (await win.textContent('[data-testid="import-dialog"]').catch(() => '')) || ''
}

async function shot(win, name) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await win.screenshot({ path: path.join(SHOTS, `import-video-${name}.png`) })
}

async function main() {
  makeMedia()

  await test('import video: the button imports a phone video, the editor explains what it lacks, a manual zoom exports', async (ctx) => {
    const home = h.tempHome('import-pick')
    // An old project in the same library still opens next to the imported one.
    const oldId = f.seedProject(home, { name: 'Old recording', seconds: 2 })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => undefined)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, at('Phone clip.mov'))
    await win.waitForSelector('[data-testid="import-video"]')
    await shot(win, 'home')
    await win.click('[data-testid="import-video"]')
    await win.waitForSelector('.editor canvas', { timeout: 60000 })
    await h.sleep(800)

    const ids = h.listProjects(home).filter((id) => id !== oldId)
    h.assert(ids.length === 1, `one imported project: ${ids}`)
    const id = ids[0]
    const dir = path.join(h.projectsRoot(home), id)
    h.assert(fs.readdirSync(dir).sort().join() === 'cursor.json,project.json,screen.mp4', `project files: ${fs.readdirSync(dir)}`)
    const project = h.readProject(home, id)
    h.assert(project.name === 'Phone clip', `name ${project.name}`)
    h.assert(project.width === 360 && project.height === 640, `upright size ${project.width}x${project.height}`)
    h.assert(project.source && project.source.kind === 'import' && project.source.rotation === 90, `source ${JSON.stringify(project.source)}`)
    h.assert(project.hasAudio === true && project.capture.fps === 30 && project.autoZoom === false, 'audio, 30 fps, auto zoom off')
    h.assert(Math.abs(project.duration - 3) < 0.05, `duration ${project.duration}`)

    // Every tab whose feature needs recorded input explains why it is off; none crashes.
    await win.click('.insp-tabs button:has-text("Cursor")')
    const cursorNote = await win.textContent('[data-testid="cursor-not-recorded"][data-imported]')
    h.assert(/This video was imported/.test(cursorNote), `cursor note: ${cursorNote}`)
    await shot(win, 'editor-cursor')
    await win.click('.insp-tabs button:has-text("Zoom")')
    const zoomNote = await win.textContent('[data-testid="auto-zoom-summary"][data-imported]')
    h.assert(/no clicks or typing to zoom on/.test(zoomNote), `zoom note: ${zoomNote}`)
    await win.click('.insp-tabs button:has-text("Effects")')
    h.assert(await win.isVisible('text=This video was imported, so no keyboard shortcuts were recorded.'), 'effects note')
    await win.click('.insp-tabs button:has-text("Camera")')
    h.assert(await win.isVisible('text=This video was imported, so it has no separate camera.'), 'camera note')
    for (const tab of ['Style', 'Clip', 'Text', 'Captions', 'Shapes', 'Images', 'Audio']) {
      await win.click(`.insp-tabs button:has-text("${tab}")`)
      await h.sleep(150)
    }
    h.assert(!logs.some((l) => l.startsWith('[pageerror]')), `no page errors: ${logs.filter((l) => l.startsWith('[pageerror]')).join('')}`)

    // A manual zoom at the playhead (Z) is saved.
    await win.keyboard.press('z')
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'the manual zoom added')
    await f.waitFor(() => h.readProject(home, id).zooms.length === 1, 'the manual zoom saved', 10000)

    // Export: 1080p MP4 of the upright video, with its sound, 3 s long.
    const out = path.join(home, 'imported.mp4')
    await h.mockSaveDialog(app, out)
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Format', 'MP4')
    await fx.pickChip(win, 'Resolution', '1080p')
    await win.locator('.modal button.primary', { hasText: 'Export' }).click()
    const r = await fx.waitForExport(win)
    h.assert(r.ok, `export: ${r.text}`)
    const info = probe(out)
    const video = info.streams.find((s) => s.codec_type === 'video')
    h.assert(video && video.width === 1080 && video.height === 1920, `portrait 1080p export (short side 1080) ${video && `${video.width}x${video.height}`}`)
    h.assert(info.streams.some((s) => s.codec_type === 'audio'), 'export has sound')
    h.assert(Math.abs(Number(info.format.duration) - 3) < 0.15, `export duration ${info.format.duration}`)
    await win.click('.modal button:has-text("Done")')

    // Back home: the old recording still opens.
    await win.click('button[aria-label="Back to recordings"]')
    await win.waitForSelector('[data-testid="import-video"]', { timeout: 15000 })
    await f.openProject(win, 'Old recording')
    h.assert(!('source' in h.readProject(home, oldId)), 'the old project has no source')
  })

  await test('import video: a dropped MKV shows its note first; refusals and Cancel leave nothing behind', async (ctx) => {
    const home = h.tempHome('import-drop')
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => undefined)
    await win.waitForSelector('[data-testid="import-drop"]')

    // The drop zone shows while a file is dragged over it.
    await win.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
      document.querySelector('[data-testid="import-drop"]').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }))
    })
    await win.waitForSelector('.import-drop-overlay')
    await shot(win, 'drop-zone')
    await win.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
      document.querySelector('[data-testid="import-drop"]').dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: data }))
    })
    await win.waitForSelector('.import-drop-overlay', { state: 'detached' })

    // Sound only: refused with the sentence, focus on Close, nothing written.
    await dropFiles(win, [at('voice memo.mp4')])
    await win.waitForSelector('[data-testid="import-dialog"][data-state="failed"]', { timeout: 30000 })
    h.assert(/has sound but no picture/.test(await dialogText(win)), `sound only: ${await dialogText(win)}`)
    h.assert(await win.evaluate(() => document.activeElement && document.activeElement.textContent === 'Close'), 'Close has the focus')
    await shot(win, 'refused')
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="import-dialog"]', { state: 'detached' })

    // A text file named .mp4.
    await dropFiles(win, [at('fake.mp4')])
    await win.waitForSelector('[data-testid="import-dialog"][data-state="failed"]', { timeout: 30000 })
    h.assert(/not a video Flown can read/.test(await dialogText(win)), `fake: ${await dialogText(win)}`)
    await win.click('[data-testid="import-dialog"] button:has-text("Close")')

    // Two files at once.
    await dropFiles(win, [at('fake.mp4'), at('voice memo.mp4')])
    await win.waitForSelector('[data-testid="import-dialog"][data-state="failed"]')
    h.assert(/Drop one video at a time/.test(await dialogText(win)), `several: ${await dialogText(win)}`)
    await win.click('[data-testid="import-dialog"] button:has-text("Close")')
    h.assert(h.listProjects(home).length === 0 && (!fs.existsSync(h.projectsRoot(home)) || fs.readdirSync(h.projectsRoot(home)).length === 0), 'nothing written by refusals')

    // Cancel while the copy is made: the dialog closes and no folder is left.
    await dropFiles(win, [at('long.mp4')])
    await win.waitForSelector('[data-testid="import-dialog"] [role="progressbar"]', { timeout: 30000 })
    await f.waitFor(async () => /\d+ %/.test(await dialogText(win)), 'progress shown', 30000)
    await shot(win, 'progress')
    await win.click('[data-testid="import-dialog"] button:has-text("Cancel")')
    await win.waitForSelector('[data-testid="import-dialog"]', { state: 'detached', timeout: 10000 })
    await f.waitFor(() => !fs.existsSync(h.projectsRoot(home)) || fs.readdirSync(h.projectsRoot(home)).length === 0, 'the cancelled import removed', 10000)

    // An MKV with two sound tracks: the note is shown, then Open in editor.
    await dropFiles(win, [at('obs tracks.mkv')])
    await win.waitForSelector('[data-testid="import-dialog"][data-state="done"]', { timeout: 60000 })
    h.assert(/This video has 2 sound tracks; Flown uses the first one\./.test(await dialogText(win)), `note: ${await dialogText(win)}`)
    await shot(win, 'notes')
    await win.click('[data-testid="import-dialog"] button:has-text("Open in editor")')
    await win.waitForSelector('.editor canvas', { timeout: 60000 })
    const [id] = h.listProjects(home)
    const project = h.readProject(home, id)
    h.assert(project.capture.fps === 60 && project.width === 1280 && project.height === 720 && project.hasAudio, `mkv project ${JSON.stringify(project.capture)} ${project.width}x${project.height}`)
    h.assert(!fs.existsSync(path.join(h.projectsRoot(home), id, 'import.json')), 'marker removed')
  })
}

main()
