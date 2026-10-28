// Brand kit (E-03), image overlays and brand fonts (NW-12) in the real built app
// (docs/design/brand-kit.md §11): the preview and the export draw a PNG overlay (rotated) and a GIF
// overlay the same, the GIF frame-exact; a brand font in the captions draws the same in preview and
// export and differently from the default font; "Apply brand kit" is one undo step and its result
// exports as previewed; images dropped on or pasted into the editor are added, an SVG's script never
// runs, and the overlay's box moves it as one undo step; Settings › Brand kit saves the kit.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const W = 1920
const H = 1080
const FONT = path.join(h.APP_DIR, 'tests/fixtures/fonts/brand-mono.ttf')
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const STYLE = { background: { type: 'color', color: '#00a040' }, padding: 0.08, cornerRadius: 12, shadow: 0, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }
const GRAY = [128, 128, 128]
const RED = [255, 0, 0]
const BLUE = [0, 0, 255]
const YELLOW = [255, 255, 0]
const near = (p, want, tol = 40) => p.every((v, i) => Math.abs(v - want[i]) <= tol)
const fmt = (p) => `rgb(${p.map((v) => Math.round(v)).join(',')})`
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))

/** Adds fields to a seeded project.json. */
function addItems(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

/** A one-colour PNG made by ffmpeg. */
function png(file, color, size = '200x100') {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', file])
  return file
}

/**
 * An animated GIF written byte by byte (ffmpeg's muxer drops a short GIF's last frame): `frames`
 * one-colour frames of 64 x 64, each `delay` centiseconds, looping forever. LZW with a clear code
 * after every second pixel keeps every code 3 bits wide, which every decoder reads.
 */
function gif(file, colors, delay = 50) {
  const size = 64
  const bytes = []
  const u16 = (v) => bytes.push(v & 255, v >> 8)
  bytes.push(...Buffer.from('GIF89a'))
  u16(size)
  u16(size)
  bytes.push(0xf1, 0, 0) // global colour table of 4 entries
  for (let i = 0; i < 4; i++) bytes.push(...(colors[i] ?? [0, 0, 0]))
  bytes.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0) // loop forever
  colors.forEach((_, index) => {
    bytes.push(0x21, 0xf9, 4, 0x04, delay & 255, delay >> 8, 0, 0) // graphic control: keep, delay
    bytes.push(0x2c)
    u16(0)
    u16(0)
    u16(size)
    u16(size)
    bytes.push(0, 2) // no local table; LZW minimum code size 2
    // Codes: clear 4, end 5; [clear, p, p] repeated, then end; 3 bits each, packed LSB first.
    const codes = []
    for (let i = 0; i < size * size; i += 2) codes.push(4, index, index)
    codes.push(5)
    const data = []
    let acc = 0
    let bits = 0
    for (const c of codes) {
      acc |= c << bits
      bits += 3
      while (bits >= 8) {
        data.push(acc & 255)
        acc >>= 8
        bits -= 8
      }
    }
    if (bits) data.push(acc & 255)
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255)
      bytes.push(block.length, ...block)
    }
    bytes.push(0)
  })
  bytes.push(0x3b)
  fs.writeFileSync(file, Buffer.from(bytes))
  return file
}

async function launch(ctx, home) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

/** Exports the open project at 1080p / 30 fps to `out` and closes the dialog. */
async function exportOpen(app, win, out) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Format', 'MP4')
  await fx.pickChip(win, 'Resolution', '1080p')
  await fx.pickChip(win, 'Frame rate', '30 fps')
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.click('.modal button:has-text("Done")')
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** Frame `index` of a 1080p export with readers in normalised (0..1) coordinates. */
function exportFrame(file, index) {
  const { width, height, frames } = fx.framesAt(file, [index], 'rgb24')
  h.assert(width === W && height === H, `export is ${W}x${H} (got ${width}x${height})`)
  const buf = frames[0]
  const px = (x, y) => {
    const i = (Math.round(y) * width + Math.round(x)) * 3
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
  return {
    /** Mean colour of a small square around normalised (x, y). */
    at: (x, y, r = 4) => {
      const s = [0, 0, 0]
      let n = 0
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const p = px(x * width + dx, y * height + dy)
          s[0] += p[0]
          s[1] += p[1]
          s[2] += p[2]
          n++
        }
      return s.map((v) => v / n)
    },
    /** Left and right edge (normalised) of the bright (white text) pixels in the band y0..y1. */
    brightSpan: (y0, y1) => brightSpan(width, height, (x, y) => px(x, y), y0, y1)
  }
}

function brightSpan(width, height, px, y0, y1) {
  let left = width
  let right = -1
  for (let y = Math.round(y0 * height); y < Math.round(y1 * height); y += 2) {
    for (let x = 0; x < width; x++) {
      const p = px(x, y)
      if (p[0] > 225 && p[1] > 225 && p[2] > 225) {
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  return right < 0 ? null : { left: left / width, right: right / width, width: (right - left) / width }
}

/** The same readers on the preview canvas. */
async function previewAt(win, x, y, r = 2) {
  return win.evaluate(
    ([nx, ny, rad]) => {
      const c = document.querySelector('.preview-canvas')
      const cx = Math.round(nx * c.width)
      const cy = Math.round(ny * c.height)
      const d = c.getContext('2d').getImageData(cx - rad, cy - rad, rad * 2 + 1, rad * 2 + 1).data
      const s = [0, 0, 0]
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k]
      const n = d.length / 4
      return s.map((v) => v / n)
    },
    [x, y, r]
  )
}

async function previewBrightSpan(win, y0, y1) {
  const { width, height, data } = await win.evaluate(() => {
    const c = document.querySelector('.preview-canvas')
    return { width: c.width, height: c.height, data: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data) }
  })
  return brightSpan(
    width,
    height,
    (x, y) => {
      const i = (y * width + x) * 4
      return [data[i], data[i + 1], data[i + 2]]
    },
    y0,
    y1
  )
}

/** Waits until the preview's colour at (x, y) is near `want`; the error names the last colour seen. */
async function previewBecomes(win, x, y, want, what, tol = 50, timeout = 15000) {
  let last = null
  try {
    return await f.waitFor(
      async () => {
        last = await previewAt(win, x, y)
        return near(last, want, tol) ? last : null
      },
      what,
      timeout
    )
  } catch (err) {
    throw new Error(`${err.message}; last colour ${last ? fmt(last) : 'none'}`)
  }
}

/** Moves the playhead to source time `t` by clicking the ruler. */
async function seekTo(win, t) {
  const x = await win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
  const y = await win.$eval('.tl-ruler', (el) => {
    const b = el.getBoundingClientRect()
    return b.y + b.height / 2
  })
  await win.mouse.click(x, y)
  await h.sleep(250)
}

/** Waits until the saved project.json matches `pred`, and returns it. */
const saved = (home, id, pred, what, timeout = 10000) =>
  f.waitFor(
    () => {
      try {
        const p = h.readProject(home, id)
        return pred(p) ? p : null
      } catch {
        return null
      }
    },
    what,
    timeout
  )

/** Points of a box (normalised to a w x h frame) clearly inside / outside it after its rotation. */
function rotatedSamples(o, w, hgt) {
  const m = Math.min(w, hgt)
  const bw = o.w * m
  const bh = o.h * m
  const a = (o.rotation * Math.PI) / 180
  const toFrame = (lx, ly) => ({ x: (o.x * w + lx * Math.cos(a) - ly * Math.sin(a)) / w, y: (o.y * hgt + lx * Math.sin(a) + ly * Math.cos(a)) / hgt })
  // Inside: near the rotated corners; outside: the unrotated corners, which the rotation moved away.
  const inside = [toFrame(0.38 * bw, 0.3 * bh), toFrame(-0.38 * bw, -0.3 * bh), toFrame(0, 0)]
  const unrotated = (lx, ly) => ({ x: (o.x * w + lx) / w, y: (o.y * hgt + ly) / hgt })
  const outside = [unrotated(0.48 * bw, -0.46 * bh), unrotated(-0.48 * bw, 0.46 * bh)]
  return { inside, outside }
}

/** Builds a File in the page from bytes and drops or pastes it on the editor. */
async function deliverFile(win, how, name, type, bytes) {
  await win.evaluate(
    ([kind, fileName, mime, b64]) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([raw], fileName, { type: mime }))
      if (kind === 'paste') {
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        return
      }
      const target = document.querySelector('.canvas-wrap')
      for (const t of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    [how, name, type, Buffer.from(bytes).toString('base64')]
  )
}

async function main() {
  await test(
    'brand kit: a rotated PNG and a GIF overlay draw the same in preview and export, the GIF frame-exact',
    fx.withHome('bk-overlays', async (ctx, home) => {
      const media = fx.solidVideo({ seconds: 6 })
      fx.seedProject(home, { id: 'rec-ov', name: 'Overlays', media, seconds: 6, style: STYLE, effects: NO_FX })
      const dir = path.join(h.projectsRoot(home), 'rec-ov')
      png(path.join(dir, 'overlay-1.png'), 'red')
      gif(path.join(dir, 'overlay-2.gif'), [RED, BLUE, YELLOW])
      const pngOverlay = { id: 'png', start: 0.5, end: 5.5, file: 'overlay-1.png', name: 'red.png', x: 0.3, y: 0.32, w: 0.4, h: 0.2, rotation: 25, opacity: 1, fadeIn: 0, fadeOut: 0 }
      const gifOverlay = { id: 'gif', start: 1, end: 5.5, file: 'overlay-2.gif', name: 'anim.gif', x: 0.72, y: 0.62, w: 0.22, h: 0.22, rotation: 0, opacity: 1, fadeIn: 0, fadeOut: 0 }
      addItems(home, 'rec-ov', { overlays: [pngOverlay, gifOverlay] })
      const { app, win } = await launch(ctx, home)
      await fx.openProject(win, 'Overlays')

      // The GIF's frames: 0.5 s each from its start (1 s), looping red, blue, yellow.
      const times = [
        [1.25, RED],
        [1.75, BLUE],
        [2.25, YELLOW],
        [2.75, RED]
      ]
      const { inside, outside } = rotatedSamples(pngOverlay, 16, 9)
      const preview = []
      for (const [t, want] of times) {
        await seekTo(win, t)
        preview.push(await previewBecomes(win, gifOverlay.x, gifOverlay.y, want, `preview shows GIF frame ${fmt(want)} at ${t} s`))
      }
      // The rotated PNG on the preview: red inside the rotated box, not red where only the unrotated box would be.
      for (const pt of inside) h.assert(near(await previewAt(win, pt.x, pt.y), RED, 50), `preview: red inside the rotated image at ${JSON.stringify(pt)}`)
      for (const pt of outside) h.assert(!near(await previewAt(win, pt.x, pt.y), RED, 80), `preview: nothing red outside the rotated image at ${JSON.stringify(pt)}`)
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'brand-kit-overlays-editor.png') })

      const out = path.join(home, 'overlays.mp4')
      await exportOpen(app, win, out)
      for (let i = 0; i < times.length; i++) {
        const [t, want] = times[i]
        const fr = exportFrame(out, Math.round(t * 30))
        const e = fr.at(gifOverlay.x, gifOverlay.y)
        h.assert(near(e, want), `export: GIF frame ${fmt(want)} at ${t} s (got ${fmt(e)})`)
        h.assert(near(e, preview[i], 45), `preview and export agree at ${t} s (${fmt(preview[i])} vs ${fmt(e)})`)
      }
      const fr = exportFrame(out, 60)
      for (const pt of inside) h.assert(near(fr.at(pt.x, pt.y), RED), `export: red inside the rotated image at ${JSON.stringify(pt)} (${fmt(fr.at(pt.x, pt.y))})`)
      for (const pt of outside) h.assert(!near(fr.at(pt.x, pt.y), RED, 80), `export: nothing red outside the rotated image at ${JSON.stringify(pt)}`)
      // Before the overlays start: none of them.
      const before = exportFrame(out, 6)
      h.assert(!near(before.at(gifOverlay.x, gifOverlay.y), RED, 80) && near(before.at(pngOverlay.x, pngOverlay.y), GRAY, 30), 'no overlay before its start')
      if (SHOTS) fx.savePng(out, 45, path.join(SHOTS, 'brand-kit-overlays-export.png'))
    })
  )

  await test(
    'brand kit: a brand font in the captions draws the same in preview and export, unlike the default font',
    fx.withHome('bk-font', async (ctx, home) => {
      const media = fx.solidVideo({ seconds: 4 })
      fx.seedProject(home, { id: 'rec-font', name: 'Font', media, seconds: 4, style: STYLE, effects: NO_FX })
      const dir = path.join(h.projectsRoot(home), 'rec-font')
      fs.copyFileSync(FONT, path.join(dir, 'font-1.ttf'))
      addItems(home, 'rec-font', {
        fonts: [{ id: 'f1', name: 'Brand Mono', file: 'font-1.ttf' }],
        transcript: { provider: 'local', model: 'test', createdAt: new Date().toISOString(), segments: [{ id: 's1', start: 0, end: 4, text: 'iiii brand MMMM' }] },
        captions: { show: true, preset: 'clean', position: 'middle', size: 0.07, color: '#ffffff', highlightColor: '#facc15', background: 'none', maxLines: 1, font: 'f1' }
      })
      const { app, win } = await launch(ctx, home)
      await fx.openProject(win, 'Font')
      await seekTo(win, 2)
      await f.waitFor(() => win.evaluate(() => document.fonts.check('20px "FlownFont-f1"')), 'the brand font loads in the preview', 15000)
      await h.sleep(500)
      const band = [0.4, 0.6]
      const brandPreview = await previewBrightSpan(win, ...band)
      h.assert(brandPreview && brandPreview.width > 0.2, `caption text on the preview: ${JSON.stringify(brandPreview)}`)

      const out = path.join(home, 'font.mp4')
      await exportOpen(app, win, out)
      const brandExport = exportFrame(out, 60).brightSpan(...band)
      h.assert(brandExport, 'caption text in the export')
      h.assert(
        Math.abs(brandExport.width - brandPreview.width) < 0.012 && Math.abs(brandExport.left - brandPreview.left) < 0.012,
        `preview and export lay the brand font out the same (${JSON.stringify(brandPreview)} vs ${JSON.stringify(brandExport)})`
      )
      if (SHOTS) fx.savePng(out, 60, path.join(SHOTS, 'brand-kit-font-export.png'))

      // Back to the default font in the Captions tab: the same words take another width.
      await win.click('.insp-tabs button:has-text("Captions")')
      await win.waitForSelector('[data-testid="font-picker"]', { timeout: 10000 })
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'brand-kit-font-picker.png') })
      await win.selectOption('[data-testid="font-picker"]', '')
      await saved(home, 'rec-font', (p) => !p.captions.font, 'the default font is saved')
      await h.sleep(500)
      const plain = await previewBrightSpan(win, ...band)
      h.assert(plain && Math.abs(plain.width - brandPreview.width) > 0.03, `the default font differs (${JSON.stringify(plain)} vs ${JSON.stringify(brandPreview)})`)
      // One undo brings the brand font back.
      await win.keyboard.press('Control+z')
      await saved(home, 'rec-font', (p) => p.captions.font === 'f1', 'undo brings the brand font back')
    })
  )

  await test(
    'brand kit: Apply brand kit is one undo step, and exports as previewed',
    fx.withHome('bk-apply', async (ctx, home) => {
      const media = fx.solidVideo({ seconds: 6 })
      fx.seedProject(home, { id: 'rec-kit', name: 'Kit', media, seconds: 6, style: STYLE, effects: NO_FX })
      const { app, win } = await launch(ctx, home)
      const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
      const kitDir = path.join(userData, 'brand-kit')
      fs.mkdirSync(kitDir, { recursive: true })
      png(path.join(kitDir, 'logo-1.png'), 'red', '300x150')
      fs.copyFileSync(FONT, path.join(kitDir, 'font-1.ttf'))
      const kit = {
        version: 1,
        logo: { file: 'logo-1.png', position: 'top-left', size: 0.2, opacity: 1, margin: 0.03 },
        colors: ['#2040c0', '#ffcc00'],
        fonts: [{ id: 'kf', name: 'Brand Mono', file: 'font-1.ttf' }],
        headingFont: 'kf',
        bodyFont: 'kf',
        intro: { title: 'ACME', style: 'centered', background: 'solid', length: 2 },
        outro: { title: 'BYE', style: 'big', background: 'solid', length: 1.5 },
        preset: { name: 'Orange', look: { style: { background: { type: 'color', color: '#ff8800' } }, cursor: {}, zoom: {} } },
        autoApply: false
      }
      fs.writeFileSync(path.join(userData, 'brand-kit.json'), JSON.stringify(kit))
      const original = h.readProject(home, 'rec-kit')
      await fx.openProject(win, 'Kit')
      await win.waitForSelector('[data-testid="apply-brand-kit"]:not([disabled])', { timeout: 10000 })
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'brand-kit-apply.png') })
      await win.click('[data-testid="apply-brand-kit"]')
      const p = await saved(home, 'rec-kit', (q) => q.watermark?.path === 'watermark-1.png', 'the applied kit is saved', 15000)
      h.assert(p.style.background.color === '#ff8800', `the preset applied: ${JSON.stringify(p.style.background)}`)
      h.assert(p.fonts?.length === 1 && p.fonts[0].file === 'font-1.ttf' && p.captions?.font === p.fonts[0].id, `fonts: ${JSON.stringify({ fonts: p.fonts, captions: p.captions })}`)
      const intro = p.titles.find((c) => c.brand === 'intro')
      const outro = p.titles.find((c) => c.brand === 'outro')
      h.assert(intro && intro.start === 0 && Math.abs(intro.end - 2) < 1e-6 && intro.color === '#2040c0' && intro.font === p.fonts[0].id, `intro: ${JSON.stringify(intro)}`)
      h.assert(outro && Math.abs(outro.start - 4.5) < 1e-6 && outro.end === 6, `outro: ${JSON.stringify(outro)}`)
      h.assert(JSON.stringify(p.brand.colors) === '["#2040c0","#ffcc00"]', `brand colours kept: ${JSON.stringify(p.brand)}`)
      h.assert(
        fs.existsSync(path.join(h.projectsRoot(home), 'rec-kit', 'font-1.ttf')) && fs.existsSync(path.join(h.projectsRoot(home), 'rec-kit', 'watermark-1.png')),
        'kit files copied into the project'
      )

      // The preview at 1 s: the intro card (brand blue) under the red logo at the top left.
      await seekTo(win, 1)
      const logoAt = { x: 0.03 * (9 / 16) + 0.1 * (9 / 16), y: 0.03 + 0.05 }
      const pLogo = await previewBecomes(win, logoAt.x, logoAt.y, RED, 'the logo shows on the preview')
      const pCard = await previewAt(win, 0.5, 0.75)
      h.assert(near(pCard, hex('#2040c0'), 30), `the intro card on the preview (${fmt(pCard)})`)
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'brand-kit-applied.png') })

      const out = path.join(home, 'kit.mp4')
      await exportOpen(app, win, out)
      const e = exportFrame(out, 30)
      h.assert(near(e.at(logoAt.x, logoAt.y), pLogo, 45) && near(e.at(logoAt.x, logoAt.y), RED), `the logo exports as previewed (${fmt(e.at(logoAt.x, logoAt.y))})`)
      h.assert(near(e.at(0.5, 0.75), pCard, 30), `the intro card exports as previewed (${fmt(e.at(0.5, 0.75))})`)
      // After the intro: the preset's orange background around the recording.
      const mid = exportFrame(out, 90)
      h.assert(near(mid.at(0.01, 0.5), hex('#ff8800'), 30), `the preset's background in the export (${fmt(mid.at(0.01, 0.5))})`)

      // One undo takes all of it back; nothing is left to undo.
      await win.keyboard.press('Control+z')
      const back = await saved(home, 'rec-kit', (q) => !q.watermark, 'one undo removes the whole kit')
      h.assert(
        back.style.background.color === '#00a040' && !back.fonts && !back.brand && !(back.titles ?? []).length && !back.captions?.font,
        `the project is as before: ${JSON.stringify({ style: back.style, titles: back.titles, captions: back.captions })}`
      )
      h.assert(JSON.stringify(back.style) === JSON.stringify(original.style), 'the style is exactly as before')
      h.assert(await win.$eval('button[aria-label="Undo"]', (b) => b.disabled), 'nothing else to undo')
      await f.waitFor(async () => !near(await previewAt(win, logoAt.x, logoAt.y), RED, 60), 'the logo is gone from the preview')
      // Redo puts it all back in one step.
      await win.click('button[aria-label="Redo"]')
      await saved(home, 'rec-kit', (q) => q.watermark?.path === 'watermark-1.png' && q.titles.length === 2, 'redo applies the whole kit again')
    })
  )

  await test(
    'brand kit: drop and paste add images at the playhead, an SVG script never runs, the box moves an image',
    fx.withHome('bk-drop', async (ctx, home) => {
      const media = fx.solidVideo({ seconds: 6 })
      fx.seedProject(home, { id: 'rec-drop', name: 'Drop', media, seconds: 6, style: STYLE, effects: NO_FX })
      const { win } = await launch(ctx, home)
      await fx.openProject(win, 'Drop')
      await seekTo(win, 2)
      const red = fs.readFileSync(png(path.join(home, 'red.png'), 'red'))

      await deliverFile(win, 'drop', 'dropped.png', 'image/png', red)
      let p = await saved(home, 'rec-drop', (q) => q.overlays?.length === 1, 'a dropped image is added', 15000)
      h.assert(p.overlays[0].file === 'overlay-1.png' && p.overlays[0].name === 'dropped.png', `dropped: ${JSON.stringify(p.overlays[0])}`)
      h.assert(p.overlays[0].start <= 2 && p.overlays[0].end > 2, 'at the playhead')
      h.assert(fs.existsSync(path.join(h.projectsRoot(home), 'rec-drop', 'overlay-1.png')), 'the image is copied into the project')
      await previewBecomes(win, 0.5, 0.5, RED, 'the dropped image shows on the preview')

      // A file that is not an image changes nothing.
      await deliverFile(win, 'drop', 'notes.txt', 'text/plain', Buffer.from('hello'))
      await win.waitForSelector('text=Only PNG, JPG, WebP, SVG and GIF images can be added', { timeout: 5000 })

      // A pasted SVG with a script is drawn as a picture; the script never runs.
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" onload="window.top.__pwned=1"><script>window.top.__pwned = 2; top.document.title = "pwned"</script><rect width="200" height="200" fill="#0000ff"/><image href="https://example.com/x.png" width="10" height="10"/></svg>'
      )
      await win.click('.preview-canvas', { position: { x: 5, y: 5 } }).catch(() => undefined)
      await win.keyboard.press('k').catch(() => undefined)
      await deliverFile(win, 'paste', 'evil.svg', 'image/svg+xml', svg)
      p = await saved(home, 'rec-drop', (q) => q.overlays?.length === 2, 'a pasted SVG is added', 15000)
      const svgOverlay = p.overlays[1]
      h.assert(svgOverlay.file === 'overlay-2.svg', `pasted: ${JSON.stringify(svgOverlay)}`)
      await previewBecomes(win, svgOverlay.x, svgOverlay.y, BLUE, 'the SVG draws on the preview')
      h.assert((await win.evaluate(() => window.__pwned)) === undefined, 'the SVG script did not run')
      h.assert((await win.title()) !== 'pwned', 'the SVG did not change the page')

      // Its box on the preview moves it; one undo puts it back.
      await win.waitForSelector('[data-testid="overlay-box"]', { timeout: 5000 })
      const box = await win.$eval('[data-testid="overlay-box"]', (el) => {
        const b = el.getBoundingClientRect()
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      })
      await win.mouse.move(box.x, box.y)
      await win.mouse.down()
      for (let i = 1; i <= 6; i++) await win.mouse.move(box.x + i * 10, box.y + i * 5)
      await win.mouse.up()
      const moved = await saved(home, 'rec-drop', (q) => q.overlays[1].x > svgOverlay.x + 0.02, 'dragging the box moves the image')
      h.assert(moved.overlays[1].y > svgOverlay.y, 'down too')
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'brand-kit-images-panel.png') })
      await win.keyboard.press('Control+z')
      await saved(home, 'rec-drop', (q) => Math.abs(q.overlays[1].x - svgOverlay.x) < 1e-9 && q.overlays.length === 2, 'one undo puts it back')
      // Delete removes the selected image.
      await win.keyboard.press('Delete')
      await saved(home, 'rec-drop', (q) => q.overlays.length === 1, 'Delete removes the selected image')
    })
  )

  await test(
    'brand kit: Settings › Brand kit saves colours, the intro and Apply to new recordings',
    fx.withHome('bk-settings', async (ctx, home) => {
      const { app, win } = await launch(ctx, home)
      const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
      const logo = png(path.join(home, 'logo.png'), 'red', '120x60')
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, logo)
      await win.click('button[aria-label="Settings"]')
      await win.waitForSelector('[data-testid="brand-kit-section"]', { timeout: 10000 })
      await win.click('[data-testid="brand-kit-section"] button:has-text("Choose logo…")')
      await f.waitFor(
        () => {
          try {
            return JSON.parse(fs.readFileSync(path.join(userData, 'brand-kit.json'), 'utf8')).logo?.file === 'logo-1.png'
          } catch {
            return false
          }
        },
        'the logo is saved in the kit',
        10000
      )
      await win.click('[data-testid="brand-kit-section"] button:has-text("Add colour")')
      await win.check('input[aria-label="Intro title card"]')
      await win.fill('input[aria-label="Intro title"]', 'Hello brand')
      await win.check('input[aria-label="Apply to new recordings"]')
      const stored = await f.waitFor(
        () => {
          try {
            const k = JSON.parse(fs.readFileSync(path.join(userData, 'brand-kit.json'), 'utf8'))
            return k.autoApply && k.intro?.title === 'Hello brand' && k.colors.length === 1 ? k : null
          } catch {
            return null
          }
        },
        'the kit is saved',
        10000
      )
      h.assert(fs.existsSync(path.join(userData, 'brand-kit', 'logo-1.png')), 'the logo file is kept in the kit folder')
      h.assert(stored.version === 1, 'versioned file')
      if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'brand-kit-settings.png') })
    })
  )
}

main()
