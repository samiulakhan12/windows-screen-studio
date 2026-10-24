// Wave-3 render fixes in the real built app:
// - the 3D tilt next to a camera card (side by side): the tilted screen stays in its own slot and
//   never slides under the flat camera card (exported frames, the default Hero tilt);
// - the preview's camera while it seeks: playing a camera-only recording through cuts at a high
//   speed, every preview frame that draws the (hidden) screen draws the camera too, so the whole
//   picture never flashes to the background and the half-size screen behind the camera.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const W = 1920
const H = 1080
// Chromium blocklists WebGL on Xvfb's software GL; SwiftShader gives the tilt a WebGL to draw with.
const GL_ARGS = ['--enable-unsafe-swiftshader']

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-w3fix-'))
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))
/** The shared layout and tilt code, to know where the app draws the cards. */
const geo = (() => {
  const outfile = path.join(scratch, 'geo.cjs')
  const contents = "export * from './src/shared/engine/tilt'\nexport * from './src/shared/engine/layout'\n"
  esbuild.buildSync({ stdin: { contents, resolveDir: h.APP_DIR, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  return require(outfile)
})()

/** Seeds a project with a screen and a camera video, then merges `extra` into it. */
function seed(home, { id, name, seconds, screenColor, cameraColor, extra }) {
  fx.seedProject(home, { id, name, seconds, media: fx.solidVideo({ seconds, color: screenColor }), webcam: fx.solidVideo({ seconds, color: cameraColor }) })
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra, webcam: { ...p.webcam, ...extra.webcam } }, null, 2))
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function launch(ctx, home, args = []) {
  const { app, win, logs } = await h.launch({ home, args })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

const luma = (buf, x, y) => buf[Math.round(y) * W + Math.round(x)]

async function main() {
  await test('tilt beside a camera card: the tilted screen stays left of the camera card (export)', fx.withHome('w3fix-tilt-side', async (ctx, home) => {
    // A light screen and a mid-grey camera on a dark background; the default tilt (Hero), side by side.
    const style = { background: { type: 'color', color: '#101010' }, padding: 0.06, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
    const project = seed(home, {
      id: 'rec-side',
      name: 'Side by side',
      seconds: 1,
      screenColor: 'ebebeb',
      cameraColor: '606060',
      extra: { style, tilt: { enabled: true, rotateX: 16, rotateY: -14, perspective: 0.7, animate: 'none' }, layouts: [{ id: 'l', start: 0, end: 1, layout: 'side-by-side' }], webcam: { show: true, corner: 'bottom-right' } }
    })
    const { app, win } = await launch(ctx, home, GL_ARGS)
    await fx.openProject(win, 'Side by side')
    const out = path.join(home, 'side.mp4')
    await h.mockSaveDialog(app, out)
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Resolution', '1080p')
    await fx.pickChip(win, 'Frame rate', '30 fps')
    await win.locator('.modal button.primary', { hasText: 'Export' }).click()
    const r = await fx.waitForExport(win)
    h.assert(r.ok, `export: ${r.text}`)
    const { width, height, frames } = fx.framesAt(out, [15], 'gray')
    h.assert(width === W && height === H, `1080p export (${width}x${height})`)
    const img = frames[0]
    const screen = geo.sceneContentRect(project, W, H, 1280, 720, 0.5)
    const cam = geo.sceneCameraBox(project, W, H, 1280, 720, 0.5).rect
    h.assert(cam.x > screen.x + screen.w, `the camera card is right of the screen (${JSON.stringify(cam)})`)
    // The tilt really is drawn: the screen's right edge leans (light pixels well past where the flat card ends, low down).
    let light = 0
    let leaked = []
    // The strip between the middle of the gap and the camera card, over the card's height and
    // below it: only background. The tilted corner used to come out under the camera card.
    const gapMid = (screen.x + screen.w + cam.x) / 2
    for (let y = Math.ceil(cam.y); y < Math.min(H - 1, cam.y + cam.h + 60); y++) {
      for (let x = Math.ceil(gapMid + 3); x < cam.x + 30; x++) {
        // The camera card and its (light) ring border.
        const inCamera = x >= cam.x - 4 && y <= cam.y + cam.h + 4
        if (inCamera) continue
        const v = luma(img, x, y)
        if (v > 160) leaked.push([x, y, v])
      }
    }
    for (let y = screen.y; y < screen.y + screen.h; y += 4) for (let x = screen.x; x < gapMid; x += 4) if (luma(img, x, y) > 160) light++
    h.assert(light > 1000, `the tilted screen is drawn (${light} light samples)`)
    h.assert(leaked.length === 0, `no part of the tilted screen beside or under the camera card: ${leaked.length} light pixels, e.g. ${JSON.stringify(leaked.slice(0, 5))}`)
  }))

  await test('preview camera while it seeks: playing camera-only through cuts at 4x, every frame draws the camera', fx.withHome('w3fix-preview-seek', async (ctx, home) => {
    // 12 s, cut into four kept parts played at 4x: each cut and each drift seeks the camera.
    const clips = [
      { id: 'a', start: 0, end: 2.5, speed: 4 },
      { id: 'b', start: 3, end: 5.5, speed: 4 },
      { id: 'c', start: 6, end: 8.5, speed: 4 },
      { id: 'd', start: 9, end: 12, speed: 4 }
    ]
    seed(home, { id: 'rec-cam', name: 'Camera only', seconds: 12, screenColor: 'ebebeb', cameraColor: '3060c0', extra: { clips, layouts: [{ id: 'l', start: 0, end: 12, layout: 'camera-only' }], webcam: { show: true } } })
    const { win } = await launch(ctx, home)
    // Before the editor opens: note, for each draw on the preview canvas, whether it drew the
    // screen video and the camera (its video, or a frame copied from it).
    await win.evaluate(() => {
      const w = window
      w.__draws = { frames: 0, withoutCamera: 0, camera: 0, current: null }
      const drawImage = CanvasRenderingContext2D.prototype.drawImage
      CanvasRenderingContext2D.prototype.drawImage = function (src, ...rest) {
        if (this.canvas && this.canvas.classList && this.canvas.classList.contains('preview-canvas')) {
          const d = w.__draws
          const isVideo = typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement
          const isFrame = typeof VideoFrame !== 'undefined' && src instanceof VideoFrame
          if (isVideo && /screen/.test(src.currentSrc || src.src)) {
            if (d.current && !d.current.camera) d.withoutCamera++
            d.frames++
            d.current = { camera: false }
          } else if ((isVideo && /webcam/.test(src.currentSrc || src.src)) || isFrame) {
            if (d.current) d.current.camera = true
            d.camera++
          }
        }
        return drawImage.call(this, src, ...rest)
      }
    })
    await fx.openProject(win, 'Camera only')
    await win.click('.transport .btn.round')
    await win.waitForFunction(() => document.querySelector('.transport .btn.round')?.dataset.playing === 'true', null, { timeout: 10000 })
    await win.waitForFunction(() => document.querySelector('.transport .btn.round')?.dataset.playing === 'false', null, { timeout: 30000 })
    const d = await win.evaluate(() => {
      const r = window.__draws
      if (r.current && !r.current.camera) r.withoutCamera++
      return r
    })
    console.log(`  ${d.frames} preview frames, ${d.withoutCamera} without the camera`)
    h.assert(d.frames > 20, `the preview drew while playing (${d.frames} frames)`)
    h.assert(d.withoutCamera === 0, `every preview frame drew the camera (${d.withoutCamera} of ${d.frames} did not)`)
  }))
}

main()
