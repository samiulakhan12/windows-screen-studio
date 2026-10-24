// Style pack in the real built app: device frames, wallpapers, blurred and animated
// backgrounds, borders and shadow styles, watermarks (exported pixels), style presets with
// undo, your own presets, and "Save as default" carrying the new look to new recordings.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const esbuild = require('esbuild')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const W = 1920
const H = 1080

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** Bundles `entry` source (TypeScript, resolved from the app folder) into a CommonJS file. */
function bundle(dir, name, contents, external = []) {
  const outfile = path.join(dir, `${name}.cjs`)
  esbuild.buildSync({ stdin: { contents, resolveDir: h.APP_DIR, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external, outfile, logLevel: 'silent' })
  return outfile
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-style-mod-'))
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))
/** The shared layout code, to know where the export draws things. */
const geo = require(
  bundle(
    scratch,
    'geometry',
    "export * from './src/shared/engine/layout'\nexport * from './src/shared/engine/deviceFrames'\nexport * from './src/shared/engine/watermark'\n"
  )
)

const STYLE = { background: { type: 'color', color: '#00a040' }, padding: 0.08, cornerRadius: 12, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }

/** Exports the open project at 1080p / 30 fps to `out` and returns to Home. */
async function exportMp4(app, win, name, out) {
  await fx.openProject(win, name)
  await exportOpen(app, win, out)
  await win.click('header .btn.ghost >> nth=0')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

/** Exports the project open in the editor (1080p, 30 fps) and closes the dialog. */
async function exportOpen(app, win, out) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', '1080p')
  await fx.pickChip(win, 'Frame rate', '30 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Frame `index` of an export as an rgb24 buffer with a pixel reader. */
function frameOf(file, index) {
  const { width, height, frames } = fx.framesAt(file, [index], 'rgb24')
  h.assert(width === W && height === H, `export is ${W}x${H} (got ${width}x${height})`)
  const buf = frames[0]
  const px = (x, y) => {
    const i = (Math.round(y) * width + Math.round(x)) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
  /** Mean colour of a rectangle. */
  const mean = (r) => {
    const s = [0, 0, 0]
    let n = 0
    for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y++) {
      for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x++) {
        const p = px(x, y)
        s[0] += p[0]
        s[1] += p[1]
        s[2] += p[2]
        n++
      }
    }
    return s.map((v) => v / n)
  }
  return { buf, px, mean, width, height }
}

const near = (p, want, tol = 18) => p.every((v, i) => Math.abs(v - want[i]) <= tol)
const fmt = (p) => `rgb(${p.map((v) => Math.round(v)).join(',')})`
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
const GRAY = [128, 128, 128]
const GREEN = hex('#00a040')

function shot(file, index, name) {
  if (SHOTS) fx.savePng(file, index, path.join(SHOTS, `${name}.png`))
}

/** Mean gradient magnitude of a rectangle (gray): drops when a picture is blurred. */
function sharpness(fr, r) {
  let s = 0
  let n = 0
  const lum = (x, y) => {
    const p = fr.px(x, y)
    return p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11
  }
  for (let y = r.y + 1; y < r.y + r.h - 1; y += 2) {
    for (let x = r.x + 1; x < r.x + r.w - 1; x += 2) {
      s += Math.abs(lum(x + 1, y) - lum(x - 1, y)) + Math.abs(lum(x, y + 1) - lum(x, y - 1))
      n++
    }
  }
  return s / n
}

async function launch(ctx, home) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

async function main() {
  await test('style pack: every device frame draws its chrome around the recording (export)', fx.withHome('style-frames', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 1 })
    const frames = [
      { kind: 'browser', theme: 'dark', title: 'acme.dev/dashboard' },
      { kind: 'laptop', theme: 'light' },
      { kind: 'monitor', theme: 'dark' },
      { kind: 'phone', theme: 'light' }
    ]
    for (const frame of frames) {
      fx.seedProject(home, { id: `rec-${frame.kind}`, name: `Frame ${frame.kind}`, media, seconds: 1, style: { ...STYLE, frame }, effects: NO_FX })
    }
    const { app, win } = await launch(ctx, home)
    for (const frame of frames) {
      const out = path.join(home, `${frame.kind}.mp4`)
      await exportMp4(app, win, `Frame ${frame.kind}`, out)
      shot(out, 10, `frame-${frame.kind}`)
      const fr = frameOf(out, 10)
      const style = { ...STYLE, frame }
      const rect = geo.styleContentRect(W, H, 1280, 720, style)
      const k = Math.min(W, H) / 1080
      const d = geo.deviceFrameDrawing(frame, rect, { radius: 12 * k, title: frame.title || '' })
      const u = Math.min(rect.w, rect.h)
      // The recording, inside the chrome.
      const centre = fr.mean({ x: rect.x + rect.w * 0.4, y: rect.y + rect.h * 0.4, w: rect.w * 0.2, h: rect.h * 0.2 })
      h.assert(near(centre, GRAY, 10), `${frame.kind}: the recording fills its screen (${fmt(centre)})`)
      // Background outside the device.
      const corner = fr.mean({ x: 4, y: 4, w: 30, h: 30 })
      h.assert(near(corner, GREEN, 12), `${frame.kind}: background around the device (${fmt(corner)})`)
      h.assert(d.outer.x > 30 && d.outer.y > 30, `${frame.kind}: the device sits inside the padding`)
      const checks = []
      if (frame.kind === 'browser') {
        const barH = rect.y - d.outer.y
        checks.push(['title bar', { x: rect.x + rect.w * 0.85, y: rect.y - barH / 2 }, [40, 40, 45], 14])
        const dots = d.parts.filter((p) => p.type === 'circle')
        checks.push(['close button', { x: dots[0].x, y: dots[0].y }, [255, 95, 87], 45])
        checks.push(['zoom button', { x: dots[2].x, y: dots[2].y }, [40, 200, 64], 45])
        // The address bar text is drawn: light pixels inside the field.
        const field = d.parts.find((p) => p.type === 'rrect' && p.fill === '#3a3a41').rect
        let bright = 0
        for (let x = field.x; x < field.x + field.w; x += 1) {
          const p = fr.px(x, field.y + field.h / 2)
          if (p[0] > 150) bright++
        }
        h.assert(bright > 20, `browser: the address shows in the field (${bright} light pixels)`)
      } else if (frame.kind === 'laptop') {
        const [, bezel, , , base] = d.parts
        checks.push(['black bezel', { x: (bezel.rect.x + rect.x) / 2, y: rect.y + rect.h / 2 }, [11, 11, 13], 14])
        checks.push(['base', { x: base.rect.x + base.rect.w * 0.25, y: base.rect.y + base.rect.h * 0.35 }, [220, 222, 226], 30])
        // The base is wider than the lid.
        checks.push(['base overhang', { x: base.rect.x + (d.outline[0].rect.x - base.rect.x) / 2, y: base.rect.y + base.rect.h * 0.3 }, [225, 227, 230], 35])
      } else if (frame.kind === 'monitor') {
        const [neck, foot, body] = d.parts
        checks.push(['rim', { x: (body.rect.x + (rect.x - u * 0.018)) / 2, y: rect.y + rect.h / 2 }, [26, 26, 29], 14])
        checks.push(['stand', { x: neck.rect.x + neck.rect.w / 2, y: neck.rect.y + neck.rect.h * 0.6 }, [54, 56, 60], 20])
        checks.push(['foot', { x: foot.rect.x + foot.rect.w * 0.3, y: foot.rect.y + foot.rect.h * 0.4 }, [48, 50, 54], 26])
      } else {
        // A landscape recording: the phone lies on its side, camera island on the left.
        const body = d.outline[0].rect
        checks.push(['black bezel', { x: rect.x + rect.w / 2, y: rect.y - u * 0.018 }, [5, 5, 6], 14])
        checks.push(['camera island', { x: rect.x - u * 0.0375, y: rect.y + rect.h / 2 + u * 0.06 }, [24, 24, 28], 14])
        checks.push(['light rim', { x: body.x + body.w / 2, y: body.y + u * 0.007 }, [207, 210, 216], 40])
      }
      for (const [label, p, want, tol] of checks) {
        const got = fr.mean({ x: p.x - 1, y: p.y - 1, w: 3, h: 3 })
        h.assert(near(got, want, tol), `${frame.kind}: ${label} at (${Math.round(p.x)}, ${Math.round(p.y)}) is ${fmt(got)}, expected about ${fmt(want)}`)
      }
    }
  }))

  await test('style pack: a wallpaper renders, and its blurred version is soft', fx.withHome('style-wallpaper', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 1 })
    const style = { ...STYLE, padding: 0.18, background: { type: 'wallpaper', id: 'blueprint' } }
    fx.seedProject(home, { id: 'rec-sharp', name: 'Wallpaper sharp', media, seconds: 1, style, effects: NO_FX })
    fx.seedProject(home, { id: 'rec-blur', name: 'Wallpaper blurred', media, seconds: 1, style: { ...style, background: { ...style.background, blur: 0.8 } }, effects: NO_FX })
    const { app, win } = await launch(ctx, home)
    const sharp = path.join(home, 'sharp.mp4')
    const blurred = path.join(home, 'blurred.mp4')
    await exportMp4(app, win, 'Wallpaper sharp', sharp)
    await exportMp4(app, win, 'Wallpaper blurred', blurred)
    shot(sharp, 10, 'wallpaper-sharp')
    shot(blurred, 10, 'wallpaper-blurred')
    const a = frameOf(sharp, 10)
    const b = frameOf(blurred, 10)
    // The blueprint: dark blue, with grid lines.
    const region = { x: 20, y: 20, w: 260, h: 150 }
    const tint = a.mean(region)
    h.assert(tint[2] > tint[0] + 25 && tint[2] > 50, `the wallpaper is drawn (blue: ${fmt(tint)})`)
    const sa = sharpness(a, region)
    const sb = sharpness(b, region)
    console.log(`  sharpness: wallpaper ${sa.toFixed(2)}, blurred ${sb.toFixed(2)}`)
    h.assert(sa > 1.5 && sb < sa * 0.45, `the blurred wallpaper is much softer (${sa.toFixed(2)} -> ${sb.toFixed(2)})`)
    const tintB = b.mean(region)
    h.assert(tintB[2] > tintB[0] + 25, `the blurred version keeps the wallpaper's colours (${fmt(tintB)})`)
    // The recording itself is untouched by the blur.
    const rect = geo.styleContentRect(W, H, 1280, 720, style)
    h.assert(near(b.mean({ x: rect.x + 100, y: rect.y + 100, w: 50, h: 50 }), GRAY, 10), 'the recording stays sharp and grey')
  }))

  await test('style pack: an animated background moves over time; the recording does not', fx.withHome('style-animated', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 3 })
    const style = { ...STYLE, padding: 0.12, background: { type: 'animated', preset: 'aurora', speed: 2 } }
    fx.seedProject(home, { id: 'rec-anim', name: 'Animated', media, seconds: 3, style, effects: NO_FX })
    const { app, win } = await launch(ctx, home)
    const out = path.join(home, 'animated.mp4')
    await exportMp4(app, win, 'Animated', out)
    shot(out, 3, 'animated-0.1s')
    shot(out, 75, 'animated-2.5s')
    const a = frameOf(out, 3)
    const b = frameOf(out, 75)
    const c = frameOf(out, 4)
    const regions = [
      { x: 10, y: 10, w: 200, h: 90 },
      { x: W - 210, y: H - 100, w: 200, h: 90 }
    ]
    let moved = 0
    let step = 0
    for (const r of regions) {
      const ma = a.mean(r)
      const mb = b.mean(r)
      const mc = c.mean(r)
      moved = Math.max(moved, ...ma.map((v, i) => Math.abs(v - mb[i])))
      step = Math.max(step, ...ma.map((v, i) => Math.abs(v - mc[i])))
    }
    console.log(`  background change: ${moved.toFixed(1)} over 2.4 s, ${step.toFixed(2)} from one frame to the next`)
    h.assert(moved > 12, `the background differs between 0.1 s and 2.5 s (by ${moved.toFixed(1)})`)
    h.assert(step < 4, `it moves smoothly: one frame apart it barely changes (${step.toFixed(2)})`)
    const rect = geo.styleContentRect(W, H, 1280, 720, style)
    for (const fr of [a, b]) h.assert(near(fr.mean({ x: rect.x + 200, y: rect.y + 200, w: 60, h: 60 }), GRAY, 10), 'the recording is unchanged')
  }))

  await test('style pack: border, hard shadow and glow colours appear where expected (export)', fx.withHome('style-card', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 1 })
    const hard = { ...STYLE, padding: 0.12, shadow: 1, shadowStyle: 'hard', shadowColor: '#ff0000', border: { width: 12, color: '#ff00ff', glass: false } }
    const glow = { ...STYLE, padding: 0.12, shadow: 1, shadowStyle: 'glow', shadowColor: '#00ffff', background: { type: 'color', color: '#202020' } }
    fx.seedProject(home, { id: 'rec-hard', name: 'Hard shadow', media, seconds: 1, style: hard, effects: NO_FX })
    fx.seedProject(home, { id: 'rec-glow', name: 'Glow', media, seconds: 1, style: glow, effects: NO_FX })
    const { app, win } = await launch(ctx, home)
    const outHard = path.join(home, 'hard.mp4')
    const outGlow = path.join(home, 'glow.mp4')
    await exportMp4(app, win, 'Hard shadow', outHard)
    await exportMp4(app, win, 'Glow', outGlow)
    shot(outHard, 10, 'card-border-hard')
    shot(outGlow, 10, 'card-glow')

    const k = 1
    const rect = geo.styleContentRect(W, H, 1280, 720, hard)
    const a = frameOf(outHard, 10)
    const cy = rect.y + rect.h / 2
    const sample = (fr, x, y) => fr.mean({ x: x - 2, y: y - 2, w: 5, h: 5 })
    const border = sample(a, rect.x - 6 * k, cy)
    h.assert(near(border, [255, 0, 255], 40), `magenta border just outside the recording (${fmt(border)})`)
    // The hard shadow: offset 26 px down/right from the border's outer edge, solid red, no blur.
    const right = sample(a, rect.x + rect.w + 12 + 13, cy)
    h.assert(near(right, [255, 0, 0], 45), `solid red shadow to the right (${fmt(right)})`)
    const left = sample(a, rect.x - 12 - 13, cy)
    h.assert(near(left, GREEN, 15), `no shadow to the left (${fmt(left)})`)
    const below = sample(a, rect.x + rect.w / 2, rect.y + rect.h + 12 + 13)
    h.assert(near(below, [255, 0, 0], 45), `solid red shadow below (${fmt(below)})`)
    const beyond = sample(a, rect.x + rect.w + 12 + 26 + 8, cy)
    h.assert(near(beyond, GREEN, 15), `a hard edge, no blur beyond the offset (${fmt(beyond)})`)

    const g = frameOf(outGlow, 10)
    const grect = geo.styleContentRect(W, H, 1280, 720, glow)
    const gcy = grect.y + grect.h / 2
    for (const [label, x, y] of [
      ['left', grect.x - 15, gcy],
      ['right', grect.x + grect.w + 15, gcy],
      ['above', grect.x + grect.w / 2, grect.y - 15],
      ['below', grect.x + grect.w / 2, grect.y + grect.h + 15]
    ]) {
      const p = sample(g, x, y)
      h.assert(p[1] > p[0] + 50 && p[2] > p[0] + 50, `cyan glow ${label} of the card (${fmt(p)})`)
    }
    const far = sample(g, 20, 20)
    h.assert(near(far, [32, 32, 32], 12), `the glow fades out (corner ${fmt(far)})`)
  }))

  await test('style pack: text and logo watermarks appear in their corners (UI + export)', fx.withHome('style-watermark', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 1 })
    const dark = { ...STYLE, background: { type: 'color', color: '#202020' }, padding: 0.1 }
    fx.seedProject(home, { id: 'rec-wm-text', name: 'Watermark text', media, seconds: 1, style: dark, effects: NO_FX })
    fx.seedProject(home, { id: 'rec-wm-logo', name: 'Watermark logo', media, seconds: 1, style: dark, effects: NO_FX })
    const logo = path.join(home, 'logo.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=200x100', '-frames:v', '1', logo])
    const { app, win } = await launch(ctx, home)

    // Text, top left, set up in the Style panel.
    await fx.openProject(win, 'Watermark text')
    await win.click('label.toggle:has-text("Show watermark")')
    await win.fill('input[aria-label="Watermark text"]', 'ACME STUDIO')
    await win.click('button[aria-label="Watermark top left"]')
    await win.focus('.slider:has-text("Opacity") input')
    await win.keyboard.press('End')
    await f.waitFor(() => h.readProject(home, 'rec-wm-text').watermark?.text === 'ACME STUDIO', 'watermark saved', 10000)
    const saved = h.readProject(home, 'rec-wm-text').watermark
    h.assert(saved.kind === 'text' && saved.position === 'top-left' && saved.opacity === 1, `watermark settings saved: ${JSON.stringify(saved)}`)
    const outText = path.join(home, 'wm-text.mp4')
    await exportOpen(app, win, outText)
    await win.click('header .btn.ghost >> nth=0')
    await win.waitForSelector('.project-open', { timeout: 30000 })
    shot(outText, 10, 'watermark-text')
    const a = frameOf(outText, 10)
    const brightIn = (fr, r) => {
      let n = 0
      for (let y = r.y; y < r.y + r.h; y += 2) for (let x = r.x; x < r.x + r.w; x += 2) if (fr.px(x, y)[0] > 200) n++
      return n
    }
    const m = Math.min(W, H)
    const box = (corner) => {
      const w = 420
      const hh = 110
      return { x: corner.includes('left') ? 10 : W - w - 10, y: corner.includes('top') ? 10 : H - hh - 10, w, h: hh }
    }
    const topLeft = brightIn(a, box('top-left'))
    h.assert(topLeft > 80, `white text in the top-left corner (${topLeft} bright samples)`)
    for (const c of ['top-right', 'bottom-left', 'bottom-right']) h.assert(brightIn(a, box(c)) === 0, `nothing in the ${c} corner`)

    // A logo picked through the asset dialog, bottom right.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, logo)
    await fx.openProject(win, 'Watermark logo')
    await win.click('label.toggle:has-text("Show watermark")')
    await win.click('.chip:has-text("Logo")')
    await f.waitFor(async () => (await win.textContent('.style-file-row')).includes('watermark.png'), 'logo picked', 15000)
    h.assert(fs.existsSync(path.join(h.projectsRoot(home), 'rec-wm-logo', 'watermark.png')), 'the logo is copied into the project')
    await win.click('button[aria-label="Watermark bottom right"]')
    await win.focus('.slider:has-text("Opacity") input')
    await win.keyboard.press('End')
    await f.waitFor(() => h.readProject(home, 'rec-wm-logo').watermark?.opacity === 1, 'logo settings saved', 10000)
    const wm = h.readProject(home, 'rec-wm-logo').watermark
    h.assert(wm.kind === 'image' && wm.path === 'watermark.png' && wm.position === 'bottom-right', `logo saved: ${JSON.stringify(wm)}`)
    // The preview shows it too (loaded lazily, then repainted).
    const previewRed = () =>
      win.evaluate(() => {
        const c = document.querySelector('.preview-canvas')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 0; i < d.length; i += 4 * 7) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) n++
        return n
      })
    await f.waitFor(async () => (await previewRed()) > 50, 'the logo shows in the preview', 10000)
    const outLogo = path.join(home, 'wm-logo.mp4')
    await exportOpen(app, win, outLogo)
    shot(outLogo, 10, 'watermark-logo')
    const b = frameOf(outLogo, 10)
    const r = geo.watermarkRect(W, H, wm, 2)
    const inLogo = b.mean({ x: r.x + r.w * 0.3, y: r.y + r.h * 0.3, w: r.w * 0.4, h: r.h * 0.4 })
    h.assert(near(inLogo, [255, 0, 0], 40), `red logo at the bottom right (${fmt(inLogo)} in ${JSON.stringify(r)})`)
    h.assert(r.x + r.w > W - m * 0.1 && r.y + r.h > H - m * 0.1, 'in the bottom-right corner')
    const elsewhere = b.mean({ x: 20, y: 20, w: 100, h: 60 })
    h.assert(near(elsewhere, [32, 32, 32], 12), `no logo at the top left (${fmt(elsewhere)})`)
  }))

  await test('style pack: presets apply as one undo step; your own presets are saved, renamed and deleted', async (ctx) => {
    const home = h.tempHome('style-presets')
    f.seedProject(home, { id: 'rec-p', name: 'Presets', seconds: 4 })
    const { app, win } = await launch(ctx, home)
    // A preferences file with one good preset of your own and some junk (written before the editor reads it).
    const look = { style: { background: { type: 'color', color: '#ff8800' }, padding: 0.05 }, cursor: {}, zoom: { defaultScale: 1.5 } }
    const realUserData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    fs.mkdirSync(realUserData, { recursive: true })
    fs.writeFileSync(path.join(realUserData, 'editor-prefs.json'), JSON.stringify({ stylePresets: [{ id: 'mine1', name: 'Orange', look }, { id: 'bad' }, 42, { id: 'x y', name: 'Bad id', look }] }))
    await f.openProject(win, 'Presets')
    // The gallery opens from the current look's name.
    h.assert((await win.textContent('.preset-summary')).includes('Custom look'), 'a seeded project matches no preset')
    await win.click('button:has-text("Browse presets")')

    const corner = () =>
      win.evaluate(() => {
        const c = document.querySelector('.preview-canvas')
        return Array.from(c.getContext('2d').getImageData(3, 3, 1, 1).data.slice(0, 3))
      })
    const before = await corner()
    // Only the valid preset of your own is listed.
    const mine = await win.$$eval('[data-testid="user-presets"] .preset-card', (els) => els.map((e) => e.getAttribute('aria-label')))
    h.assert(JSON.stringify(mine) === '["Orange preset"]', `your presets: ${JSON.stringify(mine)}`)
    const builtIn = await win.$$eval('[data-testid="built-in-presets"] .preset-card', (els) => els.length)
    h.assert(builtIn >= 6, `${builtIn} built-in presets`)

    await win.click('button[aria-label="Pop preset"]')
    await f.waitFor(async () => near(await corner(), hex('#fde68a'), 12), 'the Pop background in the preview')
    h.assert(await win.$eval('button[aria-label="Pop preset"]', (b) => b.getAttribute('aria-pressed') === 'true'), 'the Pop card shows as active')
    await f.waitFor(() => h.readProject(home, 'rec-p').style.shadowStyle === 'hard', 'preset saved')
    const p = h.readProject(home, 'rec-p')
    h.assert(p.style.border.width === 3 && p.cursor.style === 'black' && p.zoomSettings.defaultScale === 1.75, `preset applied: ${JSON.stringify({ style: p.style, cursor: p.cursor.style, zoom: p.zoomSettings })}`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'preset-pop.png') })

    // One undo restores the whole previous look.
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => near(await corner(), before, 6), 'undo restores the preview')
    await f.waitFor(() => h.readProject(home, 'rec-p').style.shadowStyle === undefined, 'undo saved')
    const q = h.readProject(home, 'rec-p')
    h.assert(q.style.background.preset === 'aurora' && !q.style.border && q.zoomSettings?.defaultScale !== 1.75, `previous look back: ${JSON.stringify(q.style)}`)

    // Your own preset applies too.
    await win.click('button[aria-label="Orange preset"]')
    await f.waitFor(async () => near(await corner(), hex('#ff8800'), 12), 'your preset applies')

    // Save the current look as a new preset, rename it, delete it.
    await win.click('button[aria-label="Laptop showcase preset"]')
    await win.click('button:has-text("Save this look as a preset")')
    await win.fill('input[aria-label="New preset name"]', 'Launch video')
    await win.click('.preset-name-row button[type="submit"]')
    await win.waitForSelector('button[aria-label="Launch video preset"]')
    const stored = () => JSON.parse(fs.readFileSync(path.join(realUserData, 'editor-prefs.json'), 'utf8')).stylePresets
    const s1 = stored()
    h.assert(s1.length === 2 && s1[0].name === 'Launch video' && s1[0].look.style.frame.kind === 'laptop', `saved to the preferences: ${JSON.stringify(s1.map((x) => x.name))}`)
    h.assert(await win.$eval('button[aria-label="Launch video preset"]', (b) => b.getAttribute('aria-pressed') === 'true'), 'the new preset is the current look')
    await win.hover('button[aria-label="Launch video preset"]')
    await win.click('button[aria-label="Rename Launch video"]')
    await win.fill('input[aria-label="Preset name"]', 'Orange')
    await win.click('.preset-name-row button[type="submit"]')
    // Names stay unique.
    await win.waitForSelector('button[aria-label="Orange (2) preset"]')
    h.assert(stored()[0].name === 'Orange (2)', `renamed: ${stored()[0].name}`)
    await win.hover('button[aria-label="Orange (2) preset"]')
    await win.click('button[aria-label="Delete Orange (2)"]')
    await win.click('button[aria-label="Confirm deleting Orange (2)"]')
    await f.waitFor(async () => !(await win.$('button[aria-label="Orange (2) preset"]')), 'preset deleted')
    h.assert(JSON.stringify(stored().map((x) => x.id)) === '["mine1"]', `deleted from the preferences: ${JSON.stringify(stored())}`)
  })

  await test('style pack: "Save as default" carries frame, border, shadow, wallpaper, watermark and zoom style to a new recording', async (ctx) => {
    const home = h.tempHome('style-defaults')
    f.seedProject(home, { id: 'rec-d', name: 'Defaults', seconds: 4, capture: { method: 'native', cursorInVideo: false, region: null } })
    const logo = path.join(home, 'logo.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=120x60', '-frames:v', '1', logo])
    const { app, win } = await launch(ctx, home)
    const mod = bundle(scratch, 'styleDefaultsMain', "export * from './src/main/styleDefaults'\nexport { createProject } from './src/shared/engine/project'\n", ['electron'])
    await app.evaluate((_e, file) => {
      globalThis.__styleDefaults = process.mainModule.require(file)
    }, mod)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, logo)
    await f.openProject(win, 'Defaults')
    // A look built in the Style panel.
    await win.click('button[aria-label="Browser frame"]')
    await win.click('.chip:has-text("Dark")')
    await win.click('.chip:has-text("Wallpapers")')
    await win.click('button[aria-label="Dunes wallpaper"]')
    await win.click('.chip:has-text("Glow")')
    await win.focus('.slider:has-text("Border width") input')
    for (let i = 0; i < 4; i++) await win.keyboard.press('ArrowRight')
    await win.click('label.toggle:has-text("Show watermark")')
    await win.click('.chip:has-text("Logo")')
    await f.waitFor(async () => (await win.textContent('.style-file-row')).includes('watermark.png'), 'logo picked', 15000)
    await win.click('.insp-tabs button:has-text("Zoom")')
    await win.click('.chip:has-text("Bouncy")')
    await win.click('.insp-tabs button:has-text("Style")')
    await f.waitFor(() => h.readProject(home, 'rec-d').zoomSettings?.easing === 'bouncy', 'look saved')
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'defaults-look.png') })

    await win.click('button:has-text("Save as default for new recordings")')
    await win.waitForSelector('.notice:has-text("Saved as default for new recordings")', { timeout: 10000 })
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'style-defaults.json'), 'utf8'))
    h.assert(stored.style.frame.kind === 'browser' && stored.style.frame.theme === 'dark', `frame stored: ${JSON.stringify(stored.style.frame)}`)
    h.assert(stored.style.background.id === 'dunes' && stored.style.shadowStyle === 'glow' && stored.style.border.width === 4, `style stored: ${JSON.stringify(stored.style)}`)
    h.assert(stored.watermark.kind === 'image' && stored.zoom.easing === 'bouncy' && !('source' in stored), `watermark/zoom stored: ${JSON.stringify({ wm: stored.watermark, zoom: stored.zoom })}`)
    h.assert(fs.existsSync(path.join(userData, 'style-defaults-watermark.png')), 'a copy of the logo is kept with the defaults')

    // A new recording, created the way the recorder does it.
    fs.mkdirSync(path.join(h.projectsRoot(home), 'rec-new'), { recursive: true })
    const created = await app.evaluate(async () => {
      const m = globalThis.__styleDefaults
      const project = m.createProject({
        id: 'rec-new',
        name: 'New recording',
        duration: 4,
        width: 1280,
        height: 720,
        hasWebcam: false,
        hasAudio: false,
        webcamOffset: 0,
        zooms: [],
        cursorValid: true,
        capture: { method: 'native', cursorInVideo: false, region: null }
      })
      return m.applyStyleDefaults(project, await m.loadStyleDefaults())
    })
    h.assert(created.style.frame.kind === 'browser' && created.style.background.id === 'dunes' && created.style.shadowStyle === 'glow', `new project style: ${JSON.stringify(created.style)}`)
    h.assert(created.style.border.width === 4 && created.zoomSettings.easing === 'bouncy', 'border and zoom style')
    h.assert(created.watermark && created.watermark.kind === 'image' && created.watermark.path === 'watermark.png', `watermark: ${JSON.stringify(created.watermark)}`)
    h.assert(fs.existsSync(path.join(h.projectsRoot(home), 'rec-new', 'watermark.png')), 'the logo is copied into the new recording')
  })
}

main()
