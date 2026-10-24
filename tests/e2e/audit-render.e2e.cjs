// Render audit fixes, end to end on real exports: a privacy shape covers the very frame where
// its secret appears, even when the edit makes the export sample just before the shape starts.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const FPS = 60
const W = 1280
const H = 720

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** Adds shapes to a seeded project.json (the shared fixtures do not know them). */
function addShapes(home, id, shapes) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, shapes }, null, 2))
}

const luma = (buf, i) => 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]

/** Mean luma spread inside the cells of a `cols` x `rows` grid over `r` (px): about 0 for that mosaic. */
function cellSpread(buf, r, cols, rows) {
  const cw = r.w / cols
  const ch = r.h / rows
  let total = 0
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0
      let s2 = 0
      let n = 0
      for (let y = Math.ceil(r.y + j * ch + 3); y < r.y + (j + 1) * ch - 3; y++) {
        for (let x = Math.ceil(r.x + i * cw + 3); x < r.x + (i + 1) * cw - 3; x++) {
          const v = luma(buf, (y * W + x) * 3)
          s += v
          s2 += v * v
          n++
        }
      }
      total += n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0
    }
  }
  return total / (cols * rows)
}

async function main() {
  await test('audit-render: a pixelate region covers its first frame when the edit starts off the frame grid (RE-3)', fx.withHome('audit-render-privacy', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 4, width: W, height: H })
    const style = { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }
    // The secret appears in source frame 120 (2.000 s) and the pixelate region starts exactly there.
    // The edit starts at 0.995 s, so output frame 60 samples 1.995 s, which shows frame 120.
    fx.seedProject(home, {
      id: 'rec-privacy',
      name: 'Privacy timing',
      media,
      seconds: 4,
      style,
      clips: [{ id: 'c0', start: 0.995, end: 4, speed: 1 }],
      capture: { method: 'chromium', cursorInVideo: true, region: null, fps: FPS }
    })
    const box = { x: 0.3, y: 0.45, w: 0.4, h: 0.35 }
    addShapes(home, 'rec-privacy', [{ id: 'pix', kind: 'pixelate', start: 2, end: 3, ...box, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }])

    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    const out = path.join(home, 'privacy.mp4')
    await fx.openProject(win, 'Privacy timing')
    await h.mockSaveDialog(app, out)
    await fx.openExportDialog(win)
    await fx.pickChip(win, 'Resolution', '720p')
    await fx.pickChip(win, 'Frame rate', '60 fps')
    await win.locator('.modal button.primary', { hasText: 'Export' }).click()
    const r = await fx.waitForExport(win)
    h.assert(r.ok, `export: ${r.text}`)

    // Which source frame every output frame shows (the frame code in the top quarter).
    const codes = fx.decodeIndices(out, { x: 0, y: 0, w: W, h: H / 4 })
    const first = codes.indexOf(120)
    const before = codes.indexOf(119)
    console.log(`  output frames ${before} and ${first} show source frames 119 and 120 (sampled at ${(0.995 + before / FPS).toFixed(4)} s and ${(0.995 + first / FPS).toFixed(4)} s)`)
    h.assert(first > 0 && before === first - 1, `source frames 119 and 120 are consecutive output frames (${before}, ${first})`)
    h.assert(0.995 + first / FPS < 2, 'the first frame of the secret is sampled before the region starts')

    // The mosaic grid of strength 0.5 on a 720 px recording (shared/render/shapes.ts pixelCell/pixelGrid).
    const cell = (0.01 + 0.04 * 0.5) * H
    const rect = { x: Math.round(box.x * W), y: Math.round(box.y * H), w: Math.round(box.w * W), h: Math.round(box.h * H) }
    const cols = Math.round(rect.w / cell)
    const rows = Math.round(rect.h / cell)
    const { frames } = fx.framesAt(out, [before, first, first + 1], 'rgb24')
    const [prev, secret, next] = frames.map((f) => cellSpread(f, rect, cols, rows))
    console.log(`  spread inside the mosaic cells: frame 119 ${prev.toFixed(2)}, frame 120 ${secret.toFixed(2)}, frame 121 ${next.toFixed(2)}`)
    h.assert(secret < 3, `the first frame of the secret is pixelated (spread ${secret.toFixed(2)})`)
    h.assert(next < 3, `the next frame is pixelated (spread ${next.toFixed(2)})`)
    h.assert(prev > 2 && prev > secret * 5, `the frame before the secret is left alone (spread ${prev.toFixed(2)})`)
  }))
}

main()
