// UI checks on the redesigned app: the native window controls match the title bar, every Inspector
// tab is visible and clickable at the minimum window size (and the open tab is scrolled into view
// on a shorter rail), timeline segment labels and the primary button (resting, hover, pressed)
// reach WCAG AA contrast, a keyboard-focused slider shows the solid focus ring, and the editor's
// and Home's .notice rules no longer leak into each other.
// SSW_UI_SHOTS=<dir> also writes the README screenshots (docs/screenshots) from seeded projects.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** Adds fields to a seeded project.json (the shared fixture only knows the basic ones). */
function addItems(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...p, ...extra }, null, 2))
}

const TABS = ['Style', 'Cursor', 'Zoom', 'Clip', 'Text', 'Captions', 'Shapes', 'Effects', 'Camera', 'Audio']

/** A recording with every timeline lane: camera (layouts), captions, text, shapes and titles. */
function seedFull(home) {
  const id = f.seedProject(home, {
    id: 'rec-ui',
    name: 'Everything',
    seconds: 12,
    webcam: true,
    zooms: [
      { id: 'z1', start: 0.5, end: 2.5, scale: 2, focus: { mode: 'cursor' }, auto: false },
      { id: 'z2', start: 3, end: 5, scale: 1.6, focus: { mode: 'cursor' }, auto: true },
      { id: 'z3', start: 6, end: 8, scale: 0.8, focus: { mode: 'cursor' }, auto: false }
    ],
    annotations: [{ id: 'a1', start: 1, end: 5, text: 'Click here', x: 0.5, y: 0.5, size: 0.05, style: 'pill' }]
  })
  const shape = { x: 0.2, y: 0.2, w: 0.3, h: 0.2, color: '#ff3366', strokeWidth: 4, fill: false, opacity: 1, strength: 0.5 }
  addItems(home, id, {
    shapes: [
      { id: 's1', start: 0.5, end: 3.5, kind: 'rect', ...shape },
      { id: 's2', start: 4, end: 7, kind: 'blur', ...shape }
    ],
    spotlights: [{ id: 'sp', start: 7.5, end: 11, mode: 'cursor', x: 0, y: 0, w: 0.3, h: 0.3, shape: 'ellipse', dim: 0.6, feather: 0.5 }],
    titles: [{ id: 't1', start: 0.5, end: 3.5, title: 'Welcome', style: 'centered', background: 'blur' }],
    layouts: [
      { id: 'l1', start: 0, end: 3, layout: 'side-by-side' },
      { id: 'l2', start: 3, end: 6, layout: 'camera-large' },
      { id: 'l3', start: 6, end: 9, layout: 'camera-only' },
      { id: 'l4', start: 9, end: 12, layout: 'screen-only' }
    ],
    transcript: { provider: 'openai', model: 'test-model', createdAt: new Date().toISOString(), language: 'en', segments: [{ id: 'c1', start: 1, end: 4, text: 'Hello there' }] }
  })
  return id
}

async function launchIn(ctx, home) {
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  return { app, win }
}

async function setSize(app, win, width, height) {
  await app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0].setContentSize(w, hh), [width, height])
  await f.waitFor(() => win.evaluate(([w, hh]) => innerWidth === w && innerHeight === hh, [width, height]), `a ${width}x${height} window`)
  await h.sleep(300)
}

/** In-page helpers: CSS colours to sRGB and WCAG contrast. */
const COLOR_FNS = `
  window.__ui = {
    rgb(css) {
      let m = css.match(/^rgba?\\(([^)]*)\\)$/)
      if (m) { const p = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
      m = css.match(/^color\\(srgb ([^)]*)\\)$/)
      if (m) { const p = m[1].split(/[\\s/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 } }
      throw new Error('unparsed colour ' + css)
    },
    lum({ r, g, b }) {
      const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    },
    contrast(a, b) { const x = this.lum(a), y = this.lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) },
    bright(c, k) { return { r: Math.min(255, c.r * k), g: Math.min(255, c.g * k), b: Math.min(255, c.b * k), a: c.a } },
    /** The opaque colour stops of a computed background-image. */
    stops(image) { return (image.match(/rgba?\\([^)]*\\)|color\\(srgb [^)]*\\)/g) || []).map((c) => this.rgb(c)).filter((c) => c.a === 1) }
  }`

;(async () => {
  await test('the native window controls match the title bar', async (ctx) => {
    const home = h.tempHome('ui-titlebar')
    const { app, win } = await launchIn(ctx, home)
    const src = fs.readFileSync(path.join(h.APP_DIR, 'src/main/windows.ts'), 'utf8')
    const overlay = src.match(/titleBarOverlay: \{ color: '(#[0-9a-f]{6})', symbolColor: '#[0-9a-f]{6}', height: (\d+) \}/i)
    h.assert(overlay, 'the main window sets a titleBarOverlay')
    const bar = await win.evaluate(() => {
      const t = document.querySelector('.titlebar')
      const cs = getComputedStyle(t)
      return { height: t.getBoundingClientRect().height, bg: cs.backgroundColor, border: parseFloat(cs.borderBottomWidth), page: getComputedStyle(document.body).backgroundColor }
    })
    const hex = (css) => '#' + css.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')
    h.assert(hex(bar.bg) === overlay[1].toLowerCase(), `overlay colour ${overlay[1]} is the title bar's ${hex(bar.bg)}`)
    h.assert(Number(overlay[2]) === bar.height - bar.border, `overlay height ${overlay[2]} ends at the title bar's hairline (${bar.height} - ${bar.border})`)
    const bg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())
    h.assert(bg.toLowerCase() === hex(bar.page), `window background ${bg} is the page's ${hex(bar.page)}`)
  })

  await test('every Inspector tab is visible and clickable at the minimum window size', async (ctx) => {
    const home = h.tempHome('ui-rail')
    seedFull(home)
    const { app, win } = await launchIn(ctx, home)
    await f.openProject(win, 'Everything')
    await win.waitForSelector('[data-testid="caption-track"]')
    await win.waitForSelector('.layout-seg')

    // The labelled rail on the default window.
    await setSize(app, win, 1360, 860)
    const labelled = await win.evaluate(() => [...document.querySelectorAll('.insp-tabs button span')].every((s) => s.getBoundingClientRect().height > 0))
    h.assert(labelled, 'tabs carry their labels on a tall window')

    const min = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
    await setSize(app, win, min[0], min[1])
    const rail = await win.evaluate(() => {
      const nav = document.querySelector('.insp-tabs')
      const r = nav.getBoundingClientRect()
      return {
        overflow: nav.scrollHeight - nav.clientHeight,
        tabs: [...nav.querySelectorAll('button')].map((b) => {
          const q = b.getBoundingClientRect()
          const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2)
          return { title: b.title, inside: q.top >= r.top - 0.5 && q.bottom <= r.bottom + 0.5 && q.height > 20, hit: !!hit && b.contains(hit) }
        })
      }
    })
    h.assert(rail.overflow <= 0, `the rail fits without scrolling at ${min.join('x')} (${rail.overflow}px over)`)
    h.assert(rail.tabs.map((t) => t.title).join() === TABS.join(), `ten tabs: ${rail.tabs.map((t) => t.title)}`)
    for (const t of rail.tabs) h.assert(t.inside && t.hit, `${t.title} is fully shown and on top: ${JSON.stringify(t)}`)
    for (const name of TABS) {
      await win.click(`.insp-tabs button[title="${name}"]`)
      await f.waitFor(() => win.evaluate(() => document.querySelector('.insp-tabs button.active')?.title), `${name} opens`, 3000)
      h.assert((await win.getAttribute('.insp-tabs button.active', 'title')) === name, `${name} is the open tab`)
    }

    // Shorter than any real window: the rail scrolls, and selecting a layout segment brings the
    // Camera tab into view.
    await win.click('.insp-tabs button[title="Style"]')
    await win.addStyleTag({ content: '.insp-tabs { max-height: 140px; }' })
    await win.click('.layout-seg >> nth=1')
    await f.waitFor(async () => (await win.getAttribute('.insp-tabs button.active', 'title')) === 'Camera', 'the Camera tab opens')
    const shown = await win.evaluate(() => {
      const nav = document.querySelector('.insp-tabs')
      const r = nav.getBoundingClientRect()
      const q = nav.querySelector('button.active').getBoundingClientRect()
      return { scrolls: nav.scrollHeight > nav.clientHeight, inView: q.top >= r.top - 0.5 && q.bottom <= r.bottom + 0.5, scrollbar: getComputedStyle(nav).scrollbarWidth }
    })
    h.assert(shown.scrolls && shown.inView, `the open tab is scrolled into view: ${JSON.stringify(shown)}`)
    h.assert(shown.scrollbar !== 'none', 'the rail shows a scrollbar when it scrolls')
  })

  await test('segment labels and the primary button reach WCAG AA contrast', async (ctx) => {
    const home = h.tempHome('ui-contrast')
    seedFull(home)
    const { app, win } = await launchIn(ctx, home)
    await f.openProject(win, 'Everything')
    await setSize(app, win, 1600, 1000)
    await win.waitForSelector('.text-seg .seg-label')
    await win.waitForSelector('.caption-seg .seg-label')
    await win.evaluate(COLOR_FNS)

    const labels = await win.evaluate(() => {
      const u = window.__ui
      return [...document.querySelectorAll('.seg .seg-label')]
        .filter((l) => l.textContent.trim())
        .map((l) => {
          const seg = l.closest('.seg')
          const text = u.rgb(getComputedStyle(l).color)
          const stops = u.stops(getComputedStyle(seg).backgroundImage)
          const solid = getComputedStyle(seg).backgroundColor
          if (!stops.length && u.rgb(solid).a === 1) stops.push(u.rgb(solid))
          return {
            seg: seg.className.replace(/\s+/g, ' ').trim(),
            label: l.textContent.trim(),
            stops: stops.length,
            min: Math.min(...stops.map((s) => u.contrast(text, s))),
            hover: Math.min(...stops.map((s) => u.contrast(text, u.bright(s, 1.1))))
          }
        })
    })
    const kinds = new Set(labels.map((l) => l.seg.split(' ')[1]))
    for (const k of ['zoom-seg', 'text-seg', 'shape-seg', 'title-seg', 'layout-seg', 'caption-seg']) h.assert(kinds.has(k), `a ${k} label is checked (${[...kinds]})`)
    for (const l of labels) {
      h.assert(l.stops > 0, `${l.seg} has a background`)
      h.assert(l.min >= 4.5 && l.hover >= 4.5, `"${l.label}" on ${l.seg}: ${l.min.toFixed(2)}:1, hovered ${l.hover.toFixed(2)}:1`)
    }
    console.log(`  ${labels.length} labels, lowest ${Math.min(...labels.map((l) => Math.min(l.min, l.hover))).toFixed(2)}:1`)

    const button = '.titlebar .btn.primary'
    const ratio = () =>
      win.evaluate((sel) => {
        const u = window.__ui
        const cs = getComputedStyle(document.querySelector(sel))
        return u.contrast(u.rgb(cs.color), u.rgb(cs.backgroundColor))
      }, button)
    const rest = await ratio()
    await win.hover(button)
    await h.sleep(300)
    const hover = await ratio()
    await win.mouse.down()
    await h.sleep(300)
    const pressed = await ratio()
    await win.mouse.move(5, 300)
    await win.mouse.up()
    for (const [state, r] of [['resting', rest], ['hovered', hover], ['pressed', pressed]]) h.assert(r >= 4.5, `primary button ${state}: ${r.toFixed(2)}:1`)
  })

  await test('a keyboard-focused slider shows the solid focus ring', async (ctx) => {
    const home = h.tempHome('ui-slider')
    f.seedProject(home, { id: 'rec-s', name: 'Sliders', seconds: 4 })
    const { win } = await launchIn(ctx, home)
    await f.openProject(win, 'Sliders')
    await win.click('.insp-tabs button[title="Style"]')
    const sliders = await win.$$('.insp-body input[type="range"]:not(:disabled)')
    h.assert(sliders.length >= 2, 'the Style tab has sliders')

    // Pixels of the --focus-ring colour (#a99bff) around the thumb.
    const ringPixels = async (el) => {
      const b = await el.boundingBox()
      const png = await win.screenshot({ clip: { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 } })
      return win.evaluate(async (data) => {
        const img = new Image()
        img.src = 'data:image/png;base64,' + data
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const g = c.getContext('2d')
        g.drawImage(img, 0, 0)
        const d = g.getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 169) < 24 && Math.abs(d[i + 1] - 155) < 24 && Math.abs(d[i + 2] - 255) < 24) n++
        return n
      }, png.toString('base64'))
    }

    // Keyboard focus: focus the slider before it, then Tab.
    await sliders[0].focus()
    await win.keyboard.press('Tab')
    const focused = await win.evaluate(() => {
      const el = document.activeElement
      return { range: el.type === 'range', visible: el.matches(':focus-visible') }
    })
    h.assert(focused.range && focused.visible, `Tab moves keyboard focus to a slider: ${JSON.stringify(focused)}`)
    const target = await win.evaluateHandle(() => document.activeElement)
    const on = await ringPixels(target)
    await win.evaluate(() => document.activeElement.blur())
    await h.sleep(200)
    const off = await ringPixels(target)
    h.assert(on >= 60 && on >= 5 * off, `focused slider shows the ring (${on} ring pixels focused, ${off} unfocused)`)
  })

  await test('the editor and Home notices keep their own looks', async (ctx) => {
    const home = h.tempHome('ui-notice')
    f.seedProject(home, { id: 'rec-n', name: 'Notices', seconds: 6 })
    const { win } = await launchIn(ctx, home)
    await win.evaluate(COLOR_FNS)

    // Home: a long warning in the recording panel wraps instead of being clipped.
    const homeNotice = await win.evaluate(() => {
      const body = document.querySelector('.record-panel .record-body') || document.querySelector('.record-panel')
      const n = document.createElement('div')
      n.className = 'notice'
      n.innerHTML = '<span>Processing was stopped. Your recording is kept under Unfinished recordings; finish it there any time.</span>'
      body.append(n)
      const cs = getComputedStyle(n)
      const s = n.firstElementChild
      const r = { whiteSpace: cs.whiteSpace, overflow: cs.overflowX, bg: cs.backgroundColor, color: cs.color, clipped: s.scrollWidth > n.clientWidth + 1, lines: Math.round(s.getBoundingClientRect().height / parseFloat(cs.lineHeight)) }
      n.remove()
      return r
    })
    h.assert(homeNotice.whiteSpace === 'normal' && homeNotice.overflow === 'visible', `Home notice is not given the editor's nowrap/clipping: ${JSON.stringify(homeNotice)}`)
    h.assert(!homeNotice.clipped && homeNotice.lines >= 2, `the long Home notice wraps: ${JSON.stringify(homeNotice)}`)
    h.assert(homeNotice.color === 'rgb(252, 211, 77)', `Home notice keeps the warning colour: ${homeNotice.color}`)

    // Editor: a transport message is the neutral pill, not the amber warning box.
    await f.openProject(win, 'Notices')
    await win.evaluate(COLOR_FNS)
    const addZoom = '.transport button[title^="Add a zoom"]'
    await win.click(addZoom)
    await f.waitFor(async () => (await win.$$('.zoom-seg')).length === 1, 'a zoom added')
    await win.click(addZoom)
    await win.waitForSelector('.notice-slot .notice', { timeout: 5000 })
    const pill = await win.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.notice-slot .notice'))
      return { display: cs.display, whiteSpace: cs.whiteSpace, bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius }
    })
    h.assert(pill.bg === 'rgb(28, 28, 34)', `editor notice on --surface-2: ${JSON.stringify(pill)}`)
    h.assert(pill.color !== 'rgb(252, 211, 77)' && pill.display !== 'flex' && pill.whiteSpace === 'nowrap' && pill.radius === '999px', `editor notice is the neutral pill: ${JSON.stringify(pill)}`)
  })

  const SHOTS = process.env.SSW_UI_SHOTS
  if (SHOTS) {
    await test('screenshots', async (ctx) => {
      fs.mkdirSync(SHOTS, { recursive: true })
      const home = h.tempHome('ui-shots')
      const hour = 3600 * 1000
      seedFull(home)
      addItems(home, 'rec-ui', {
        name: 'Product demo',
        transcript: {
          provider: 'openai',
          model: 'whisper-1',
          createdAt: new Date().toISOString(),
          language: 'en',
          segments: [
            { id: 'c1', start: 0.4, end: 2.6, text: 'Here is the new dashboard.' },
            { id: 'c2', start: 2.9, end: 5.4, text: 'Click Export to share it with your team.' },
            { id: 'c3', start: 5.8, end: 8.6, text: 'Captions are generated from your voice.' },
            { id: 'c4', start: 9, end: 11.6, text: 'Edit any line right here in the editor.' }
          ]
        },
        captions: { show: true, preset: 'boxed', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#facc15', background: 'box', maxLines: 2 }
      })
      f.seedProject(home, { id: 'rec-b', name: 'Onboarding walkthrough', seconds: 8, ageMs: 2 * hour })
      f.seedProject(home, { id: 'rec-c', name: 'Bug report: login', seconds: 5, ageMs: 26 * hour })
      f.seedProject(home, { id: 'rec-d', name: 'Release notes 0.4', seconds: 10, ageMs: 80 * hour })
      const { app, win } = await launchIn(ctx, home)
      await setSize(app, win, 1440, 900)
      const shot = async (name) => {
        await h.sleep(500)
        await win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
      }

      await h.waitForSources(win)
      await win.waitForSelector('.project-thumb img', { timeout: 30000 }).catch(() => undefined)
      await win.mouse.move(1, 450)
      await shot('home')

      await f.openProject(win, 'Product demo')
      // The playhead on the second caption, and nothing selected.
      const x = await win.$eval('.tl-content', (el) => el.getBoundingClientRect().left + 10 + 3.6 * Number(el.dataset.pxPerSec))
      const ruler = await win.$eval('.tl-ruler', (el) => { const b = el.getBoundingClientRect(); return b.y + b.height / 2 })
      await win.mouse.click(x, ruler)
      await win.mouse.move(1, 450)
      for (const [tab, name] of [['Style', 'editor-style'], ['Captions', 'editor-captions'], ['Camera', 'editor-camera']]) {
        await win.click(`.insp-tabs button[title="${tab}"]`)
        await win.mouse.move(1, 450)
        await shot(name)
      }

      await win.click('.titlebar .btn.primary')
      await win.waitForSelector('.modal[aria-label="Export"]')
      await win.mouse.move(1, 450)
      await shot('export')
      await win.keyboard.press('Escape')
      await f.waitFor(async () => !(await win.$('.modal[aria-label="Export"]')), 'the export dialog closes')

      await win.keyboard.press('Control+k')
      await win.waitForSelector('.command-palette[role="dialog"]')
      await win.keyboard.type('cap')
      await shot('palette')
      await win.keyboard.press('Escape')
      await f.waitFor(async () => !(await win.$('.command-palette')), 'the palette closes')

      await win.getByRole('button', { name: 'Settings' }).click()
      const d = win.locator('[role="dialog"][aria-labelledby="settings-title"]')
      await d.getByRole('button', { name: '+ Add provider' }).click()
      await d.getByLabel('Name').fill('My OpenAI')
      await d.getByLabel('API key').fill('sk-proj-example-key')
      await win.mouse.move(1, 450)
      await shot('settings-ai')
    })
  }
})()
