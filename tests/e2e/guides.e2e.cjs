/**
 * Guides and demos end to end (docs/design/smart-tools.md §22.3 steps 2–9, part P1): the Guide
 * panel on a recording of three "pages" with a pixelated label, a typed field and narration; the
 * steps and their titles, the screenshots (the pixelated label stays hidden, the typing step is
 * shot before its typing, a later shot is marked), Esc and focus, and saving as PDF, Markdown,
 * HTML and a demo, and Copy guide. Run after `npm run build` under xvfb-run.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const { waitFor, openProject } = require('./editor-fixtures.cjs')

const W = 1280
const H = 720
const SECONDS = 40

/** The recording: page A (grey, a red label) 0–12 s, page B (blue, a text field typed into from 21 s) 12–26 s, page C (green) after. */
function makeVideo(file) {
  const filter = [
    `color=c=0x707070:s=${W}x${H}:r=60:d=${SECONDS}`,
    "drawbox=x=560:y=330:w=160:h=60:color=red:t=fill:enable='lt(t,12)'",
    // Letters of the label: grey strokes across it, so a pixelated label shows no pure red.
    ...Array.from({ length: 20 }, (_, i) => `drawbox=x=${564 + 8 * i}:y=330:w=4:h=60:color=0x707070:t=fill:enable='lt(t,12)'`),
    "drawbox=x=0:y=0:w=1280:h=720:color=0x3050a0:t=fill:enable='between(t,12,26)'",
    "drawbox=x=440:y=200:w=400:h=260:color=0xe0e0e0:t=fill:enable='between(t,18,20)'",
    "drawbox=x=480:y=410:w=320:h=44:color=white:t=fill:enable='between(t,12,26)'",
    "drawbox=x=490:y=420:w=260:h=24:color=black:t=fill:enable='between(t,21,26)'",
    "drawbox=x=0:y=0:w=1280:h=720:color=0x40a040:t=fill:enable='gte(t,26)'"
  ].join(',')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: 'inherit' })
}

const words = (start, end, text) => {
  const parts = text.split(' ')
  const d = (end - start) / parts.length
  return parts.map((w, i) => ({ text: w, start: +(start + i * d).toFixed(3), end: +(start + (i + 1) * d - 0.02).toFixed(3) }))
}

function seed(home) {
  const id = 'rec-guide'
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  makeVideo(path.join(dir, 'screen.mp4'))
  const samples = []
  for (let t = 0; t <= SECONDS; t += 1 / 30) {
    let x = 0.5
    let y = 0.5
    if (t >= 16.4 && t <= 17.2) {
      const k = Math.min(1, (t - 16.5) / 0.5)
      x = 0.3 + 0.3 * Math.max(0, k)
      y = 0.3 + 0.2 * Math.max(0, k)
    } else if (t > 17.2 && t < 20) {
      x = 0.6
      y = 0.5
    } else if (t >= 20 && t < 24) {
      x = 0.4
      y = 0.6
    } else if (t >= 24) {
      x = 0.45
      y = 0.6
    }
    samples.push({ t: +t.toFixed(4), x, y })
  }
  const cursor = {
    samples,
    clicks: [
      { t: 3, x: 0.5, y: 0.5, button: 'left' },
      { t: 8, x: 0.7, y: 0.3, button: 'left' },
      { t: 8.2, x: 0.7, y: 0.3, button: 'left' },
      { t: 16.5, x: 0.3, y: 0.3, button: 'left', up: 17.0 },
      { t: 20.5, x: 0.4, y: 0.6, button: 'left' },
      { t: 24.5, x: 0.45, y: 0.6, button: 'left' }
    ],
    keys: [
      { t: 30, label: 'Ctrl + S' },
      { t: 31, label: 'Enter' }
    ],
    typing: [{ t: 21, end: 23 }],
    shapes: [],
    scale: 1,
    valid: true
  }
  const project = {
    version: 2,
    id,
    name: 'Secret',
    createdAt: '2026-11-07T12:00:00.000Z',
    duration: SECONDS,
    width: W,
    height: H,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 },
    clips: [{ id: 'c0', start: 0, end: SECONDS, speed: 1 }],
    zooms: [],
    autoZoom: false,
    annotations: [],
    shapes: [{ id: 'px1', kind: 'pixelate', start: 0, end: 12, x: 0.4, y: 0.4, w: 0.2, h: 0.2, color: '#000000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.6 }],
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' },
    cursor: { show: true, size: 1.4, smoothing: 0.6, clickEffect: true, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    transcript: {
      language: 'en',
      provider: 'local',
      model: 'test',
      createdAt: '2026-11-07T12:00:00.000Z',
      segments: [
        { id: 's1', start: 2.2, end: 3.4, text: 'Now click the Export button', words: words(2.2, 3.4, 'Now click the Export button') },
        { id: 's2', start: 12.4, end: 13.6, text: 'Next we open settings', words: words(12.4, 13.6, 'Next we open settings') },
        { id: 's3', start: 26.4, end: 27.4, text: 'Finally save it', words: words(26.4, 27.4, 'Finally save it') }
      ]
    }
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify(cursor))
  return id
}

/** Strongly red pixels in a step's screenshot in the panel, and its size. */
const redIn = (win, index) =>
  win.evaluate(async (i) => {
    const img = document.querySelectorAll('[data-testid="guide-shot"] img')[i]
    if (!img) return null
    await img.decode().catch(() => undefined)
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let red = 0
    for (let k = 0; k < d.length; k += 4) if (d[k] > 200 && d[k + 1] < 60 && d[k + 2] < 60) red++
    return { red, w: c.width, h: c.height }
  }, index)

/** Black pixels in the text field's place of a step's screenshot (the typed text). */
const typedIn = (win, index) =>
  win.evaluate(async (i) => {
    const img = document.querySelectorAll('[data-testid="guide-shot"] img')[i]
    if (!img) return null
    await img.decode().catch(() => undefined)
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let black = 0
    for (let k = 0; k < d.length; k += 4) if (d[k] < 30 && d[k + 1] < 30 && d[k + 2] < 30) black++
    return black
  }, index)

const said = (win) => win.locator('[data-testid="guide-said"]').innerText()

async function saveAs(win, format) {
  await win.locator('[data-testid="guide-format"] label', { hasText: format }).click()
  await win.locator('[data-testid="guide-save"]').click()
  // The first Save asks about the screenshots not checked at full size.
  const q = win.locator('[data-testid="guide-question"]')
  if (await q.isVisible().catch(() => false)) {
    if (await win.locator('[data-testid="guide-save-anyway"]').isVisible().catch(() => false)) await win.locator('[data-testid="guide-save-anyway"]').click()
    else await win.locator('[data-testid="guide-link-anyway"]').click()
  }
  await h.sleep(300)
  if (await win.locator('[data-testid="guide-link-anyway"]').isVisible().catch(() => false)) await win.locator('[data-testid="guide-link-anyway"]').click()
}

h.run('guides: steps, screenshots, PDF, Markdown, HTML, demo and Copy guide', async (ctx) => {
  const home = h.tempHome('guides')
  seed(home)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-e2e-guides-out-'))
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => undefined)
  await openProject(win, 'Secret')

  // Step 2: the panel, its steps and titles.
  await win.locator('[data-testid="guide-open"]').click()
  await win.waitForSelector('[data-testid="guide-panel"]')
  await waitFor(async () => (await win.locator('[data-testid="guide-step"]').count()) === 7, 'seven steps', 20000)
  const titles = await win.locator('[data-testid="guide-step-title"]').evaluateAll((els) => els.map((e) => e.value))
  console.log('titles', JSON.stringify(titles))
  h.assert(titles[0] === 'Click “Export”', `step 1's title: ${titles[0]}`)
  h.assert(titles[1].startsWith('Double-click '), `step 2: ${titles[1]}`)
  h.assert(titles[2].startsWith('Drag from '), `step 3: ${titles[2]}`)
  h.assert(/and type$/.test(titles[3]), `step 4: ${titles[3]}`)
  h.assert(titles[5] === 'Press Ctrl + S' && titles[6] === 'Press Enter', `keys: ${titles[5]}, ${titles[6]}`)
  const line = await win.locator('[data-testid="guide-count"]').innerText()
  console.log('line', line)
  h.assert(line.startsWith('7 steps'), line)

  // The screenshots are made.
  await waitFor(async () => {
    const bar = win.locator('[aria-label="Making screenshots"]')
    return (await bar.getAttribute('aria-valuenow')) === (await bar.getAttribute('aria-valuemax'))
  }, 'the screenshots', 90000)
  await waitFor(async () => (await win.locator('[data-testid="guide-shot"] img').count()) === 7, 'seven pictures', 20000)

  // Step 3: the pixelated label stays hidden; the typing step is shot before its typing; step 5 is marked.
  const shot1 = await redIn(win, 0)
  console.log('step 1 red pixels', JSON.stringify(shot1))
  h.assert(shot1 && shot1.w === 950, `step 1's shot is 950 px wide: ${JSON.stringify(shot1)}`)
  h.assert(shot1.red < 0.05 * 80 * 60, `the label is pixelated in step 1's shot (${shot1.red} red pixels)`)
  const typedBefore = await typedIn(win, 3)
  console.log('typing step black pixels', typedBefore)
  h.assert(typedBefore < 200, `step 4's shot is before the typing (${typedBefore} black pixels: the cursor only)`)
  const row5 = await win.locator('[data-testid="guide-step"]').nth(4).getAttribute('aria-label')
  h.assert(/may show what you typed in step 4/.test(row5), `step 5 is marked: ${row5}`)
  const typedAfter = await typedIn(win, 4)
  console.log('step 5 black pixels before the blur', typedAfter)
  h.assert(typedAfter > 1000, `step 5's shot shows the typed text (${typedAfter})`)

  // Blur the typed text: one shape, and step 5's shot is made again without the text.
  const shapesBefore = h.readProject(home, 'rec-guide').shapes?.length ?? 0
  await win.locator('[data-testid="guide-step"]').nth(4).locator('[data-testid="guide-blur-typed"]').click()
  await waitFor(async () => (await typedIn(win, 4)) < 200, 'step 5 made again with the blur', 30000)
  await waitFor(async () => (h.readProject(home, 'rec-guide').shapes?.length ?? 0) === shapesBefore + 1, 'the blur saved', 10000)

  // Keyboard: a title typed, Esc closes and the focus is on the Guide button; reopening keeps it.
  const title3 = win.locator('[data-testid="guide-step-title"]').nth(2)
  await title3.fill('Drag the header')
  await win.keyboard.press('Escape')
  await waitFor(async () => !(await win.locator('[data-testid="guide-panel"]').count()), 'the panel closed')
  h.assert(await win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'guide-open'), 'focus is back on the Guide button')
  await win.locator('[data-testid="guide-open"]').click()
  await waitFor(async () => (await win.locator('[data-testid="guide-step-title"]').nth(2).inputValue()) === 'Drag the header', 'the edit kept')

  // Step 5: PDF.
  await waitFor(async () => (await win.locator('[data-testid="guide-shot"] img').count()) === 7, 'pictures again', 90000)
  const pdf = path.join(out, 'Secret guide.pdf')
  await h.mockSaveDialog(app, pdf)
  await saveAs(win, 'PDF')
  await waitFor(async () => /Saved “Secret guide\.pdf”/.test(await said(win)), 'the PDF saved', 60000)
  const bytes = fs.readFileSync(pdf)
  h.assert(bytes.subarray(0, 4).toString() === '%PDF', 'a PDF')
  const info = execFileSync('pdfinfo', [pdf]).toString()
  console.log(info)
  h.assert(/Tagged:\s+yes/.test(info), 'tagged')
  h.assert(/Title:\s+Secret/.test(info), 'its title')
  h.assert(!bytes.toString('latin1').includes('guide-'), 'no temporary file name in the PDF')
  const text = execFileSync('pdftotext', [pdf, '-']).toString()
  h.assert(text.indexOf('Click “Export”') >= 0 && text.indexOf('Click “Export”') < text.indexOf('Drag the header'), 'the titles in order')
  const printDir = path.join(home, '.config', 'flown', 'tmp', 'guide-print')
  const leftovers = fs.existsSync(printDir) ? fs.readdirSync(printDir) : []
  h.assert(leftovers.length === 0, `the print folder is empty: ${leftovers}`)

  // Step 6: Markdown.
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, out)
  await saveAs(win, 'Markdown')
  await waitFor(async () => /Saved “Secret guide”/.test(await said(win)), 'the Markdown saved', 60000)
  const md = fs.readFileSync(path.join(out, 'Secret guide', 'guide.md'), 'utf8')
  h.assert(md.startsWith('# Secret\n\n## 1. Click “Export”'), md.slice(0, 80))
  h.assert(fs.existsSync(path.join(out, 'Secret guide', 'images', 'step-01.png')), 'step-01.png')

  // Step 7: HTML.
  const html = path.join(out, 'Secret guide.html')
  await h.mockSaveDialog(app, html)
  await saveAs(win, 'HTML')
  await waitFor(async () => /Saved “Secret guide\.html”/.test(await said(win)), 'the HTML saved', 60000)
  const page = fs.readFileSync(html, 'utf8')
  h.assert(!page.includes('<script'), 'no script in the HTML guide')
  h.assert((page.match(/<img src="data:image\/webp;base64,/g) || []).length === 7, 'seven WebP pictures')

  // Step 8: the demo.
  const demo = path.join(out, 'Secret demo.html')
  await h.mockSaveDialog(app, demo)
  await saveAs(win, 'Click-through demo')
  await waitFor(async () => /Saved “Secret demo\.html”/.test(await said(win)), 'the demo saved', 90000)
  const result = await app.evaluate(async ({ BrowserWindow, session }, file) => {
    const ses = session.fromPartition('demo-check')
    const requests = []
    ses.webRequest.onBeforeRequest((d, cb) => {
      if (!d.url.startsWith('file:') && !d.url.startsWith('data:')) requests.push(d.url)
      cb({})
    })
    const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, partition: 'demo-check' } })
    const errors = []
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error') errors.push(e.message)
    })
    await w.loadFile(file)
    await new Promise((r) => setTimeout(r, 500))
    const js = (code) => w.webContents.executeJavaScript(code)
    const state = () => js(`({ demo: document.documentElement.classList.contains('demo'), where: document.querySelector('.where').textContent, live: document.querySelector('.live').textContent, shown: [...document.querySelectorAll('li.step')].findIndex((s) => !s.hidden) })`)
    const key = (k) => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }))`)
    const first = await state()
    await key('ArrowRight')
    const right = await state()
    await key('End')
    const end = await state()
    await key('Home')
    const home = await state()
    w.destroy()
    return { first, right, end, home, requests, errors }
  }, demo)
  console.log(JSON.stringify(result))
  h.assert(result.first.demo && result.first.where === 'Step 1 of 7', `the demo starts at step 1: ${JSON.stringify(result.first)}`)
  h.assert(result.right.where === 'Step 2 of 7' && result.end.where === 'Step 7 of 7' && result.home.where === 'Step 1 of 7', 'keys move between steps')
  h.assert(/^Step 2 of 7: /.test(result.right.live), 'the live region says the step')
  h.assert(result.requests.length === 0, `no network request: ${result.requests}`)
  h.assert(result.errors.length === 0, `no console error: ${result.errors}`)

  // Step 9: Copy guide.
  await win.locator('[data-testid="guide-copy"]').click()
  await waitFor(async () => /Copied the guide with 7 screenshots\./.test(await said(win)), 'copied', 30000)
  const clip = await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const item = items.find((i) => i.types.includes('text/html'))
    const htmlBlob = item ? await item.getType('text/html') : null
    const textItem = items.find((i) => i.types.includes('text/plain'))
    const textBlob = textItem ? await textItem.getType('text/plain') : null
    return { html: htmlBlob ? await htmlBlob.text() : '', text: textBlob ? await textBlob.text() : '' }
  })
  h.assert((clip.html.match(/<img src="data:image\/png/g) || []).length === 7, 'seven PNG pictures on the clipboard')
  h.assert(clip.text.includes('1. Click “Export”'), 'the plain text has the numbered titles')
  fs.rmSync(out, { recursive: true, force: true })
})
