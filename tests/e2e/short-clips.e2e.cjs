/**
 * Short clips end to end (docs/design/smart-tools.md §22.3 steps 13–15, part P3): the panel opened
 * from the Publish dialog's link on a narrated 3-minute recording, its moments and reasons, Play
 * and Esc, a vertical copy with captions made from one moment (its clips inside the moment, the
 * original untouched, listed under Made from this video); a 40 s recording too short for clips and
 * for a shorter version of 60 or 90 s; and a 60 s shorter version whose cuts Review lists with
 * one Smooth cuts row, Remove bringing a stretch back. Run after `npm run build` under xvfb-run.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const { waitFor, openProject } = require('./editor-fixtures.cjs')

const W = 1280
const H = 720
const PAGES = ['0x803030', '0x308030', '0x303080', '0x808030', '0x803080', '0x308080']

/** A recording of `seconds` s: a page of its own colour every 30 s. */
function makeVideo(file, seconds) {
  const filter = [`color=c=${PAGES[0]}:s=${W}x${H}:r=30:d=${seconds}`, ...PAGES.slice(1).map((c, i) => `drawbox=x=0:y=0:w=${W}:h=${H}:color=${c}:t=fill:enable='gte(t,${30 * (i + 1)})'`)].join(',')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: 'inherit' })
}

const NOUNS = ['invoice', 'report', 'billing page', 'export', 'chart', 'customer list', 'refund', 'tax setting', 'payment', 'team folder', 'dashboard', 'reminder']
const VERBS = ['opens', 'shows', 'keeps', 'sorts', 'lists', 'checks', 'updates', 'sends', 'saves', 'names']
const ENDS = ['for every account', 'once a week', 'before the deadline', 'with one click', 'in the side panel', 'for the whole team', 'at the end of the month', 'without any extra steps']
/** Sentence n of the narration: different words each time, so none is a retake of another. */
const sentence = (n) => `${n % 7 === 0 ? 'How does the' : 'The'} ${NOUNS[n % NOUNS.length]} ${VERBS[(n * 3) % VERBS.length]} item ${n + 1} ${ENDS[(n * 5) % ENDS.length]}${n % 7 === 0 ? '?' : '.'}`

/** Captions with their words' times: one sentence every `every` s from 1 s, each word 0.3 s. */
function transcript(count, every) {
  const segments = []
  for (let n = 0; n < count; n++) {
    const text = sentence(n)
    const start = 1 + n * every
    const words = text.split(' ').map((w, k) => ({ text: w, start: +(start + k * 0.3).toFixed(3), end: +(start + k * 0.3 + 0.25).toFixed(3) }))
    segments.push({ id: `s${n}`, start, end: words[words.length - 1].end, text, words })
  }
  return { language: 'en', provider: 'local', model: 'test', createdAt: '2026-11-07T12:00:00.000Z', segments }
}

function seed(home, id, name, seconds, sentences) {
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  makeVideo(path.join(dir, 'screen.mp4'), seconds)
  const samples = []
  for (let t = 0; t <= seconds; t += 0.5) samples.push({ t, x: 0.5, y: 0.5 })
  const clicks = []
  for (let t = 5; t < seconds; t += 7) clicks.push({ t, x: 0.4, y: 0.4, button: 'left' })
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify({ samples, clicks, keys: [], shapes: [], scale: 1, valid: true }))
  const project = {
    version: 2,
    id,
    name,
    createdAt: '2026-11-07T12:00:00.000Z',
    duration: seconds,
    width: W,
    height: H,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 30 },
    clips: [{ id: 'c0', start: 0, end: seconds, speed: 1 }],
    zooms: [],
    autoZoom: false,
    annotations: [],
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' },
    cursor: { show: true, size: 1.4, smoothing: 0.6, clickEffect: true, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    ...(sentences ? { transcript: transcript(sentences.count, sentences.every) } : {})
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  return dir
}

/** The editor's way back to the library. */
async function backToLibrary(win) {
  await win.click('button[aria-label="Back to recordings"]')
  await win.waitForSelector('.project-open', { timeout: 30000 })
}

h.run('short clips: moments, Play, a vertical copy, too short, a 60 s shorter version', async (ctx) => {
  const home = h.tempHome('short-clips')
  const narratedDir = seed(home, 'rec-narrated3', 'Narrated3', 180, { count: 60, every: 3 })
  seed(home, 'rec-secret', 'Secret', 40, { count: 6, every: 6 })
  const original = fs.readFileSync(path.join(narratedDir, 'project.json'))
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)
  // The Publish dialog shows its link once there is a provider to write with (nothing is sent: no
  // text is written here). Xvfb has no keyring: Chromium's basic store, as ai.e2e.cjs does.
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  await win.waitForSelector('.home', { timeout: 30000 })
  const saved = await win.evaluate(() => window.api.saveAiProvider({ kind: 'openai', label: 'OpenAI', apiKey: 'sk-test-not-used' }).then(() => true, (e) => String(e)))
  h.assert(saved === true, `provider saved: ${saved}`)

  // Step 13: Narrated3, the panel from the Publish dialog's link.
  await openProject(win, 'Narrated3')
  await win.locator('[data-testid="publish-open"]').click()
  await win.locator('[data-testid="publish-short-clips"]').click()
  await win.waitForSelector('[data-testid="clips-panel"]')
  await waitFor(async () => (await win.locator('[data-testid="clips-row"]').count()) > 0, 'moments', 30000)
  const rows = await win.locator('[data-testid="clips-row"]').count()
  const why = await win.locator('[data-testid="clips-row"] .clips-why').first().innerText()
  console.log('moments', rows, 'first reasons:', why)
  h.assert(why.length > 0, 'the first moment has reasons')
  const range = await win.locator('[data-testid="clips-row"] .clips-time').first().innerText()
  console.log('first range', range)

  // Play clip 1: the row says how far it is, and Esc stops it.
  await win.locator('button[aria-label="Play clip 1"]').click()
  const first = await waitFor(async () => (await win.locator('[data-testid="clips-playing"]').count()) && win.locator('[data-testid="clips-playing"]').innerText(), 'playing', 10000)
  await waitFor(async () => (await win.locator('[data-testid="clips-playing"]').innerText().catch(() => first)) !== first, 'the playhead moving inside the moment', 10000)
  await win.keyboard.press('Escape')
  await waitFor(async () => (await win.locator('button[aria-label="Play clip 1"]').getAttribute('aria-pressed')) === 'false', 'Esc stops playing', 5000)
  h.assert(await win.locator('[data-testid="clips-panel"]').isVisible(), 'Esc stopped playing before closing the panel')

  // Tick it, Vertical and Captions as they are; Make 1 copy.
  await win.locator('input[aria-label="Make clip 1"]').check()
  h.assert(await win.locator('input[type="radio"][value="vertical"]').isChecked(), 'Vertical by default')
  h.assert(await win.locator('[data-testid="clips-captions"]').isChecked(), 'Captions on')
  h.assert((await win.locator('[data-testid="clips-make"]').innerText()) === 'Make 1 copy', 'Make 1 copy')
  await win.locator('[data-testid="clips-make"]').click()
  await waitFor(async () => /^Made 1 copy\./.test(await win.locator('[data-testid="clips-status"]').innerText().catch(() => '')), 'the copy made', 60000)
  const copies = h.listProjects(home).filter((id) => id !== 'rec-narrated3' && id !== 'rec-secret')
  h.assert(copies.length === 1, `one copy in the library: ${copies}`)
  const copy = h.readProject(home, copies[0])
  console.log('copy', copy.name, JSON.stringify(copy.clipOf), copy.style.aspectRatio, JSON.stringify(copy.clips))
  h.assert(copy.copyOf && copy.copyOf.id === 'rec-narrated3', 'copyOf')
  h.assert(copy.clipOf && copy.clipOf.kind === 'moment', 'clipOf')
  h.assert(copy.style.aspectRatio === '9:16', '9:16')
  h.assert(copy.captions && copy.captions.show === true, 'captions shown')
  h.assert(copy.clips.every((c) => c.start >= copy.clipOf.start - 1e-6 && c.end <= copy.clipOf.end + 1e-6), 'its clips inside the moment')
  h.assert(!copy.autoCuts || copy.autoCuts.every((c) => c.start >= copy.clipOf.start - 1e-6 && c.end <= copy.clipOf.end + 1e-6), 'no change listed outside the moment')
  h.assert(fs.readFileSync(path.join(narratedDir, 'project.json')).equals(original), "the original's project.json is unchanged")
  await waitFor(async () => (await win.locator('[data-testid="clips-made-from"]').innerText().catch(() => '')).includes(copy.name), 'Made from this video lists it', 10000)

  // Step 15: a 60 s shorter version of Narrated3.
  await win.locator('[data-testid="clips-close"]').click()
  await win.locator('[data-testid="copy-menu"]').click()
  await win.locator('[data-testid="copy-short"]').click()
  await win.waitForSelector('[data-testid="short-version"]')
  h.assert(await win.locator('[data-testid="short-version"] input[type="radio"][value="60"]').isChecked(), '60 s by default')
  const line = await waitFor(async () => {
    const text = await win.locator('[data-testid="short-line"]').innerText()
    return /^Keeps \d+ sentences, [\d.]+ s, smooth cuts$/.test(text) && text
  }, 'the line saying what it keeps', 20000)
  console.log('short line', line)
  await win.locator('[data-testid="short-make"]').click()
  await win.waitForSelector('[data-testid="short-made"]', { timeout: 60000 })
  const shortId = h.listProjects(home).find((id) => h.readProject(home, id).name === 'Narrated3 (60 s)')
  h.assert(shortId, 'the shorter version is in the library')
  let short = h.readProject(home, shortId)
  const viewing = (p) => p.clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0)
  console.log('short', viewing(short).toFixed(2), 's,', short.clips.length, 'pieces')
  h.assert(viewing(short) <= 60.0 + 1e-6, `at most 60.0 s: ${viewing(short)}`)
  h.assert(short.joins && short.joins.auto && short.joins.auto.by === 'short', 'smooth cuts recorded for Review')
  await win.locator('button:has-text("Open the copy")').click()
  await waitFor(async () => (await win.locator('.editor .preview-canvas').count()) > 0, 'the copy open', 30000)
  await h.sleep(1000)
  await win.locator('[data-testid="review-open"]').click()
  await win.waitForSelector('[data-testid="review-panel"]')
  const labels = await win.locator('[data-testid="review-panel"] .review-item').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  console.log('review rows', labels.length, labels.slice(0, 3))
  h.assert(labels.some((l) => /^Cut [\d.]+ s for the shorter version/.test(l)), 'a cut for the shorter version')
  h.assert(labels.filter((l) => /^Smooth cuts at \d+ cuts?/.test(l)).length === 1, 'one Smooth cuts row')
  // Remove one cut: that stretch comes back.
  const before = viewing(short)
  const row = win.locator('[data-testid="review-row"]', { has: win.locator('.review-item[aria-label^="Cut "]') }).nth(1)
  await row.locator('.review-item').click()
  await row.locator('[data-testid="review-remove"]').click()
  await waitFor(() => viewing(h.readProject(home, shortId)) > before + 0.5, 'the stretch back in the saved copy', 20000)
  short = h.readProject(home, shortId)
  console.log('after Remove', viewing(short).toFixed(2), 's')

  // Step 14: Secret (40 s) is too short for clips and for a 60 or 90 s version.
  await backToLibrary(win)
  await openProject(win, 'Secret')
  await win.locator('[data-testid="copy-menu"]').click()
  await win.locator('[data-testid="copy-clips"]').click()
  await win.waitForSelector('[data-testid="clips-too-short"]')
  h.assert((await win.locator('[data-testid="clips-too-short"]').innerText()) === 'Too short for clips: post the whole video.', 'too short for clips')
  await win.locator('[data-testid="clips-close"]').click()
  await win.locator('[data-testid="copy-menu"]').click()
  await win.locator('[data-testid="copy-short"]').click()
  await win.waitForSelector('[data-testid="short-version"]')
  for (const s of ['60', '90']) h.assert(await win.locator(`[data-testid="short-version"] input[type="radio"][value="${s}"]`).isDisabled(), `${s} s disabled`)
  h.assert(!(await win.locator('[data-testid="short-version"] input[type="radio"][value="30"]').isDisabled()), '30 s offered')
  const dialog = await win.locator('[data-testid="short-version"]').innerText()
  h.assert(dialog.includes('This video is already 40 s'), 'the reason')
  const errors = logs.filter((l) => l.startsWith('[pageerror]'))
  h.assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`)
})
