// Editing polish (wave 10), the steps that span the parts, end to end (docs/design/editing-polish.md
// §19.3): E1 (an old project exports the same frames and the same sound as Flown before wave 10),
// E17 (Versions names "smooth cuts" and "colour") and E18 (the export's per-frame times for a 1080p
// graded project with crossfades and a magnifier). Run by editing-polish.e2e.cjs.
//
// E1 compares with a build of Flown from before wave 10 on the same machine: set
// SSW_E2E_BASELINE_APP to a checkout of it (built with `npm run build`, its node_modules in place).
// Without it the step says SKIP: frames are only comparable with the same Chromium, ffmpeg and GPU.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')
const f = require('./editor-fixtures.cjs')

/** Chromium blocklists WebGL on Xvfb's software GL; SwiftShader gives the grade a WebGL2 to draw with. */
const GL_ARGS = ['--enable-unsafe-swiftshader']
const STYLE = { background: { type: 'gradient', preset: 'aurora' }, padding: 0.06, cornerRadius: 12, shadow: 0.5, aspectRatio: 'auto' }
const NO_FX = { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }

/** Merges `extra` into a seeded project.json. */
function patchProject(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

/** Exports the open project to `out` at `res` and `fps`, then closes the dialog (staying in the editor). */
async function exportOpen(app, win, out, res, fps) {
  await h.mockSaveDialog(app, out)
  await fx.openExportDialog(win)
  await fx.pickChip(win, 'Resolution', res)
  await fx.pickChip(win, 'Frame rate', fps)
  await win.locator('.modal button.primary', { hasText: 'Export' }).click()
  const r = await fx.waitForExport(win)
  h.assert(r.ok, `export ${out}: ${r.text}`)
  await win.locator('.modal button', { hasText: /^(Done|Cancel)$/ }).first().click()
  await win.waitForSelector('.modal', { state: 'detached' })
}

/** One md5 per decoded frame of the video, and one of the whole decoded sound (48 kHz stereo float). */
function hashes(file) {
  const frames = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { maxBuffer: 1 << 26 })
    .toString()
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop().trim())
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  return { frames, audio: createHash('md5').update(pcm).digest('hex'), samples: pcm.length / 8 }
}

/**
 * An old project (made before wave 10): a cut, a zoom, a text, an arrow, a spotlight, a lower
 * third and the sound of the recording, on a gradient card. Nothing of wave 10 in it.
 */
function seedOld(home) {
  const media = fx.indexedVideo({ seconds: 6, beeps: true })
  const id = fx.seedProject(home, {
    id: 'rec-old',
    name: 'Old project',
    media,
    seconds: 6,
    audio: true,
    style: STYLE,
    effects: NO_FX,
    clips: [
      { id: 'c0', start: 0, end: 2.2, speed: 1 },
      { id: 'c1', start: 3, end: 6, speed: 1 }
    ],
    zooms: [{ id: 'z1', start: 3.4, end: 5.2, scale: 1.8, focus: { mode: 'fixed', x: 0.3, y: 0.6 }, auto: false }],
    annotations: [{ id: 'a1', start: 0.4, end: 4.5, text: 'Step one', x: 0.5, y: 0.82, size: 0.06, style: 'pill' }]
  })
  patchProject(home, id, {
    shapes: [{ id: 's1', start: 0.6, end: 4.8, kind: 'arrow', x: 0.62, y: 0.3, w: 0.16, h: 0.12, color: '#ff3b30', strokeWidth: 0.008, fill: false, opacity: 1, strength: 1 }],
    spotlights: [{ id: 'l1', start: 1, end: 5, mode: 'region', x: 0.1, y: 0.4, w: 0.3, h: 0.3, shape: 'ellipse', dim: 0.5, feather: 0.4 }],
    titles: [{ id: 't1', start: 0.2, end: 2, title: 'Priya Sharma', subtitle: 'Designer', style: 'lower-third', background: 'solid' }]
  })
  return id
}

async function oldProjectStep(test) {
  /* ---------- E1 Old projects (§4.4, §19.2) ---------- */

  const baseline = process.env.SSW_E2E_BASELINE_APP
  if (!baseline || !fs.existsSync(path.join(baseline, 'out', 'main'))) {
    console.log('SKIP E1 old projects: set SSW_E2E_BASELINE_APP to a built checkout of Flown from before wave 10')
  } else {
    await test('E1 old projects: an old project exports the same frames and the same sound as Flown before wave 10', fx.withHome('ep-old', async (ctx, home) => {
      seedOld(home)
      const outs = {}
      for (const [key, appDir] of [['before', baseline], ['now', h.APP_DIR]]) {
        const { app, win, logs } = await h.launch({ home, appDir })
        ctx.app = app
        ctx.logs = logs
        await fx.openProject(win, 'Old project')
        outs[key] = path.join(home, `old-${key}.mp4`)
        await exportOpen(app, win, outs[key], '720p', '30 fps')
        await app.close()
        ctx.app = null
      }
      // Wave 10 writes nothing into an old project it only opens and exports.
      const p = h.readProject(home, 'rec-old')
      for (const k of ['joins', 'grade', 'chapterBar', 'soundFx']) h.assert(!(k in p), `no ${k} written`)
      const before = hashes(outs.before)
      const now = hashes(outs.now)
      console.log(`  ${now.frames.length} frames, ${now.samples} samples; before wave 10: ${before.frames.length} frames, ${before.samples} samples`)
      h.assert(now.frames.length === before.frames.length && now.frames.length > 100, `as many frames (${now.frames.length} vs ${before.frames.length})`)
      const differ = now.frames.map((m, i) => (m === before.frames[i] ? -1 : i)).filter((i) => i >= 0)
      h.assert(differ.length === 0, `every frame the same (differ at ${differ.slice(0, 10).join(', ')}${differ.length > 10 ? ', …' : ''})`)
      h.assert(now.audio === before.audio, 'the same sound, sample for sample')
    }))
  }

}

async function laterSteps(test) {
  /* ---------- E17 Versions (§4.6) ---------- */

  await test('E17 versions: after a version is saved, smoothing the cuts and grading the camera makes the comparison name smooth cuts and colour', fx.withHome('ep-versions', async (ctx, home) => {
    const media = fx.solidVideo({ seconds: 6, color: '5070a0' })
    const webcam = fx.solidVideo({ seconds: 6, width: 640, height: 480, color: 'b08860' })
    const id = fx.seedProject(home, {
      id: 'rec-ver',
      name: 'Versions polish',
      media,
      webcam,
      seconds: 6,
      clips: [
        { id: 'a', start: 0, end: 2.5, speed: 1 },
        { id: 'b', start: 3.5, end: 6, speed: 1 }
      ]
    })
    const { app, win, logs } = await h.launch({ home, args: GL_ARGS })
    ctx.app = app
    ctx.logs = logs
    await fx.openProject(win, 'Versions polish')
    await win.click('[data-testid="versions-open"]')
    await win.waitForSelector('[data-testid="versions-dialog"]')
    await win.fill('[data-testid="version-name"]', 'Before polish')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.notice-text:has-text("Saved “Before polish”")', { timeout: 10000 })
    await win.keyboard.press('Escape')
    await win.waitForSelector('[data-testid="versions-dialog"]', { state: 'detached' })

    // Smooth all cuts (Clip tab), then the camera's Warm look (Camera tab).
    await win.click('.insp-tabs button:has-text("Clip")')
    await win.click('[data-testid="cut-smooth-all"]')
    await f.waitFor(() => (h.readProject(home, id).joins?.all?.kind === 'smooth' ? true : null), 'every cut smooth', 10000)
    await win.click('.insp-tabs button:has-text("Camera")')
    await win.click('[data-testid="camera-colour-section"] [data-testid="colour-look"] [data-look="warm"]')
    await f.waitFor(() => (h.readProject(home, id).grade?.camera?.look === 'warm' ? true : null), 'the camera graded warm', 10000)

    await win.click('[data-testid="versions-open"]')
    await win.waitForSelector('[data-testid="versions-dialog"]')
    await win.click('[data-testid="version-row"] button:has-text("Compare")')
    await win.waitForSelector('[data-testid="version-compare"]')
    await f.waitFor(async () => (/smooth cuts/.test((await win.textContent('[data-testid="version-compare"]')) || '') ? true : null), 'the comparison lists its areas', 10000)
    const text = (await win.textContent('[data-testid="version-compare"]')) || ''
    console.log(`  comparison: ${text.replace(/\s+/g, ' ').trim()}`)
    h.assert(/smooth cuts/.test(text), `names smooth cuts: ${text}`)
    h.assert(/colour/.test(text), `names colour: ${text}`)
    h.assert(!logs.some((l) => l.includes('[pageerror]')), 'no page errors')
  }))

  /* ---------- E18 Cost (§15) ---------- */

  await test('E18 cost: the per-frame decode, draw and encode times of a 1080p graded export with crossfades and a magnifier', fx.withHome('ep-cost', async (ctx, home) => {
    const media = fx.indexedVideo({ seconds: 6, width: 1920, height: 1080 })
    const webcam = fx.solidVideo({ seconds: 6, width: 640, height: 480, color: 'b08860' })
    const id = fx.seedProject(home, {
      id: 'rec-cost',
      name: 'Cost',
      media,
      webcam,
      seconds: 6,
      width: 1920,
      height: 1080,
      style: STYLE,
      effects: NO_FX,
      clips: [
        { id: 'a', start: 0, end: 1.8, speed: 1 },
        { id: 'b', start: 2.2, end: 3.8, speed: 1 },
        { id: 'c', start: 4.2, end: 6, speed: 1 }
      ]
    })
    patchProject(home, id, {
      joins: { all: { kind: 'crossfade', duration: 0.3 } },
      grade: { screen: { look: 'vivid', contrast: 0.2 }, camera: { look: 'warm', saturation: 0.1 } },
      spotlights: [{ id: 'm1', start: 0.5, end: 5, mode: 'region', x: 0.35, y: 0.35, w: 0.17, h: 0.3, shape: 'ellipse', dim: 0, feather: 0, magnify: 2 }]
    })
    const { app, win, logs } = await h.launch({ home, args: GL_ARGS })
    ctx.app = app
    ctx.logs = logs
    const warnings = []
    win.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()))
    const timing = fx.exportTimings(win)
    await fx.openProject(win, 'Cost')
    await exportOpen(app, win, path.join(home, 'cost.mp4'), '1080p', '30 fps')
    const t = timing.last()
    const backend = warnings.some((m) => m.includes('Colour grading uses the CPU')) ? 'CPU' : 'WebGL2'
    console.log(`  1080p, graded (${backend}), crossfades and a magnifier: decode ${t.decode} ms, draw ${t.draw} ms, encode ${t.encode} ms a frame`)
    console.log(`  ${t.line}`)
    h.assert(Number.isFinite(t.draw), `the export printed its per-frame times: ${t.line}`)
    h.assert(t.draw < 400, `draw under the generous 400 ms ceiling (${t.draw} ms)`)
  }))
}

module.exports = { oldProjectStep, laterSteps }
