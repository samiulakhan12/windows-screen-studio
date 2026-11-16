// Test 76 in the app and step L10 (docs/design/output-and-languages.md §13, §23.1, §23.4): under the
// ar-XB pseudo-locale the panels mirror while the time axis and the preview do not, and nothing
// overlaps.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/languages-rtl.e2e.cjs
//
// The ar-XB catalogue comes from scripts/i18n/pseudo.mjs (every message reversed inside right-to-left
// marks) through SSW_I18N_CATALOGUE_DIR in this unpackaged build. In its folder it stands in for
// Spanish, a left-to-right language, and no right-to-left language is a UI language yet, so the test
// sets <html dir="rtl"> itself, as bootLanguage does for a right-to-left language (§13.2). The same
// page is measured left to right first, so each right-to-left position is compared with its own
// left-to-right one. Under English, test 10 (english-guard.e2e.cjs) is the check that nothing moved.
//
// Every selector here is a class or an id, never English text, so the test keeps working as the
// extraction parts move text into the catalogues.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const ROOT = path.resolve(__dirname, '../..')
const RLM = '‏'

/** Sets the page's direction and waits for two frames. */
async function setDir(win, dir) {
  await win.evaluate(async (d) => {
    document.documentElement.dir = d
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  }, dir)
  await h.sleep(300)
}

/** The editor's layout in the current direction: regions, directions, the inspector's labels, the ruler and the time axis. */
function measure() {
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const one = (sel) => document.querySelector(sel)
  const regions = {}
  for (const [name, sel] of Object.entries({ titlebar: '.titlebar', preview: '.canvas-wrap', transport: '.transport', timeline: '.timeline', inspector: '.inspector', tabs: '.insp-tabs', body: '.insp-body' })) {
    const el = one(sel)
    regions[name] = el ? rect(el) : null
  }
  const dirs = {}
  for (const sel of ['.timeline', '.tl-ruler', '.tl-scroller', '.canvas-wrap', '.transport', '.timecode', '.inspector', '.insp-body', '.tl-hint', '.tl-empty']) {
    const el = one(sel)
    dirs[sel] = el ? getComputedStyle(el).direction : null
  }
  // Sentences inside the time axis: their reading direction and where they stand.
  const bidi = {}
  for (const sel of ['.tl-hint', '.tl-empty']) {
    const el = one(sel)
    bidi[sel] = el ? getComputedStyle(el).unicodeBidi : null
  }
  // The inspector's labels: headings, field labels, a slider's name, a switch's name.
  const body = one('.insp-body')
  const b = body.getBoundingClientRect()
  const labels = []
  for (const el of body.querySelectorAll('h3 > span:first-child, .field-label, .slider-head > span:first-child, .toggle > span:first-child')) {
    const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim())
    if (!text) continue
    const range = document.createRange()
    range.selectNodeContents(text)
    const r = range.getBoundingClientRect()
    if (!r.width || r.bottom < b.top || r.top > b.bottom) continue
    labels.push({ text: text.textContent.trim(), fromLeft: r.left - b.left, fromRight: b.right - r.right, top: r.top - b.top, width: r.width })
  }
  const scroller = one('.tl-scroller').getBoundingClientRect()
  const ticks = [...document.querySelectorAll('.tl-ruler .tick')].map((t) => t.getBoundingClientRect().left - scroller.left)
  const hints = [...document.querySelectorAll('.timeline .tl-empty')].map((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const r = range.getBoundingClientRect()
    return Math.round((r.left - scroller.left) * 2) / 2
  })
  const icon = one('.titlebar > .btn:first-child > .icon')
  return {
    regions,
    dirs,
    labels,
    ticks,
    hints,
    bidi,
    backIcon: icon ? getComputedStyle(icon).transform : null,
    playButton: rect(one('.transport .btn.round')),
    timecode: rect(one('.transport .timecode'))
  }
}

/** Probes the shared controls' right-to-left rules with elements of their own, removed again. */
function probeControls() {
  const add = (parent, html) => {
    const box = document.createElement('div')
    box.innerHTML = html
    const el = box.firstElementChild
    parent.appendChild(el)
    return el
  }
  const panelSelect = add(document.querySelector('.insp-body'), '<select data-probe="1"><option>a</option></select>')
  const transportSelect = add(document.querySelector('.transport'), '<select data-probe="1"><option>a</option></select>')
  const toggle = add(document.querySelector('.insp-body'), '<label class="toggle" data-probe="1"><span>a</span><input type="checkbox" checked></label>')
  const out = {
    panelSelect: getComputedStyle(panelSelect).backgroundPositionX,
    transportSelect: getComputedStyle(transportSelect).backgroundPositionX,
    knob: getComputedStyle(toggle.querySelector('input'), '::after').transform
  }
  for (const el of document.querySelectorAll('[data-probe="1"]')) el.remove()
  return out
}

/** The area two boxes share. */
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol

async function main() {
  await h.run('languages: right to left under ar-XB (test 76, L10)', async (ctx) => {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-languages-rtl-'))
    try {
      const pseudo = path.join(run, 'pseudo')
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/i18n/pseudo.mjs'), '--out', pseudo], { stdio: 'pipe' })
      const home = h.tempHome('rtl')
      f.seedProject(home, {
        id: 'rtl-wide',
        name: 'Right to left',
        seconds: 6,
        audio: true,
        webcam: true,
        zooms: [{ id: 'z1', start: 0.5, end: 2, scale: 2, focus: { mode: 'cursor' }, auto: false }],
        annotations: [{ id: 'a1', start: 1, end: 3, text: 'Click Save', x: 0.5, y: 0.2, size: 0.05, style: 'pill' }]
      })
      const userData = path.join(home, '.config', 'Flown')
      fs.mkdirSync(userData, { recursive: true })
      fs.writeFileSync(path.join(userData, 'editor-prefs.json'), JSON.stringify({ ui: { language: 'es' } }))
      const { app, win, logs } = await h.launch({ home, env: { SSW_I18N_CATALOGUE_DIR: path.join(pseudo, 'ar-XB') } })
      ctx.app = app
      ctx.logs = logs
      await win.waitForSelector('.home', { timeout: 30000 })
      h.assert((await win.evaluate(() => document.documentElement.lang)) === 'es', 'the app started with the ar-XB catalogue (standing in for es)')

      await f.openProject(win, 'Right to left')
      await win.waitForSelector('.insp-body', { timeout: 15000 })
      await h.sleep(1000)

      const ltr = await win.evaluate(measure)
      await win.screenshot({ path: path.join(run, 'editor-ltr.png') })
      await setDir(win, 'rtl')
      const rtl = await win.evaluate(measure)
      await win.screenshot({ path: path.join(run, 'editor-rtl.png') })
      const rtlControls = await win.evaluate(probeControls)
      await setDir(win, 'ltr')
      const again = await win.evaluate(measure)
      const ltrControls = await win.evaluate(probeControls)
      h.assert(JSON.stringify(again.labels) === JSON.stringify(ltr.labels), 'the inspector did not change while it was measured')

      // Left to right, as English: the inspector on the right, its labels starting on the left.
      h.assert(ltr.regions.inspector.left >= ltr.regions.preview.right, 'left to right, the inspector is right of the preview')
      h.assert(near(ltr.regions.tabs.left, ltr.regions.inspector.left, 2), 'left to right, the tab rail is on the inspector’s left')
      h.assert(ltr.backIcon === 'none', `left to right, the Back arrow is as drawn (${ltr.backIcon})`)
      h.assert(/right|100%/.test(ltrControls.panelSelect), `left to right, a list’s chevron is on its right (${ltrControls.panelSelect})`)
      h.assert(/matrix\(1, 0, 0, 1, 14, 0\)/.test(ltrControls.knob), `left to right, a switch that is on has its knob on the right (${ltrControls.knob})`)
      for (const [sel, d] of Object.entries(ltr.dirs)) h.assert(d === null || d === 'ltr', `left to right, ${sel} is ltr (${d})`)

      // Right to left: the panels mirror.
      h.assert(rtl.regions.inspector.right <= rtl.regions.preview.left, 'right to left, the inspector is left of the preview')
      h.assert(near(rtl.regions.tabs.right, rtl.regions.inspector.right, 2), 'right to left, the tab rail is on the inspector’s right')
      for (const sel of ['.inspector', '.insp-body']) h.assert(rtl.dirs[sel] === 'rtl', `right to left, ${sel} is rtl (${rtl.dirs[sel]})`)
      h.assert(rtl.labels.length >= 3, `the inspector shows labels (${rtl.labels.map((l) => l.text).join(', ')})`)
      for (const [i, label] of rtl.labels.entries()) {
        const before = ltr.labels[i]
        h.assert(before && before.text === label.text, `the same label in both directions (${label.text})`)
        h.assert(near(label.fromRight, before.fromLeft) && near(label.top, before.top), `“${label.text}” starts on the right: ${label.fromRight.toFixed(1)} px from the right, as it was ${before.fromLeft.toFixed(1)} px from the left`)
        h.assert(label.fromRight < label.fromLeft || label.width > rtl.regions.body.width / 2, `“${label.text}” sits on the right half`)
      }
      h.assert(rtl.backIcon === 'matrix(-1, 0, 0, 1, 0, 0)', `right to left, the Back arrow points right (${rtl.backIcon})`)
      h.assert(!/right|100%/.test(rtlControls.panelSelect) && rtlControls.panelSelect !== ltrControls.panelSelect, `right to left, a panel list’s chevron is on its left (${rtlControls.panelSelect}, left to right ${ltrControls.panelSelect})`)
      h.assert(/right|100%/.test(rtlControls.transportSelect), `right to left, the transport’s lists keep their chevron on the right (${rtlControls.transportSelect})`)
      h.assert(/matrix\(1, 0, 0, 1, -14, 0\)/.test(rtlControls.knob), `right to left, a switch that is on has its knob on the left (${rtlControls.knob})`)

      // The time axis, the ruler, the preview and the transport keep left to right.
      for (const sel of ['.timeline', '.tl-ruler', '.tl-scroller', '.canvas-wrap', '.transport', '.timecode']) h.assert(rtl.dirs[sel] === 'ltr', `right to left, ${sel} keeps ltr (${rtl.dirs[sel]})`)
      h.assert(rtl.ticks.length >= 3 && rtl.ticks.every((x, i) => i === 0 || x > rtl.ticks[i - 1]), `the ruler’s times run left to right (${rtl.ticks.map((x) => x.toFixed(0)).join(', ')})`)
      h.assert(JSON.stringify(rtl.ticks) === JSON.stringify(ltr.ticks), 'the ruler’s ticks stand where they stood left to right')
      h.assert(rtl.playButton.right <= rtl.timecode.left, 'the play button stays left of the timecode')
      // Sentences inside the time axis read in their own text's direction and stand where they stood.
      for (const sel of ['.tl-hint', '.tl-empty']) {
        h.assert(rtl.dirs[sel] === null || rtl.dirs[sel] === 'ltr', `right to left, ${sel} keeps the timeline's ltr (${rtl.dirs[sel]})`)
        h.assert(rtl.bidi[sel] === null || rtl.bidi[sel] === 'plaintext', `right to left, ${sel} reads in its own text's direction (${rtl.bidi[sel]})`)
        h.assert(ltr.bidi[sel] === null || ltr.bidi[sel] === 'normal', `left to right, ${sel} is as it was (${ltr.bidi[sel]})`)
      }
      h.assert(rtl.hints.length > 0 && JSON.stringify(rtl.hints) === JSON.stringify(ltr.hints), `the timeline's hints stand where they stood (${rtl.hints.join(', ')})`)

      // The playhead moves right as time passes, in both directions, by the same amounts.
      const playheadAt = async (share) => {
        const ruler = await win.locator('.tl-ruler').boundingBox()
        await win.mouse.click(ruler.x + ruler.width * share, ruler.y + ruler.height / 2)
        await h.sleep(250)
        return win.evaluate(() => document.querySelector('.playhead').getBoundingClientRect().left - document.querySelector('.tl-scroller').getBoundingClientRect().left)
      }
      const ltrEarly = await playheadAt(0.25)
      const ltrLate = await playheadAt(0.75)
      await setDir(win, 'rtl')
      const rtlEarly = await playheadAt(0.25)
      const rtlLate = await playheadAt(0.75)
      h.assert(ltrLate > ltrEarly + 50, `left to right, the playhead moves right as time passes (${ltrEarly.toFixed(0)} to ${ltrLate.toFixed(0)})`)
      h.assert(rtlLate > rtlEarly + 50, `right to left, the playhead moves right as time passes (${rtlEarly.toFixed(0)} to ${rtlLate.toFixed(0)})`)
      h.assert(near(rtlEarly, ltrEarly, 2) && near(rtlLate, ltrLate, 2), 'the playhead stands where it stood left to right')

      // Nothing overlaps: the title bar, the preview, the transport, the timeline and the inspector, and the inspector's rail and body.
      const names = ['titlebar', 'preview', 'transport', 'timeline', 'inspector']
      for (const [i, a] of names.entries())
        for (const b of names.slice(i + 1)) h.assert(overlap(rtl.regions[a], rtl.regions[b]) < 1, `right to left, ${a} and ${b} do not overlap`)
      h.assert(overlap(rtl.regions.tabs, rtl.regions.body) < 1, 'right to left, the tab rail and the panel do not overlap')

      // The export dialog in the ar-XB catalogue: its codec row's label is the pseudo-locale's, and the frame slider, a slider for time, keeps ltr.
      await win.click('.titlebar button.primary')
      await win.waitForSelector('.export-modal', { timeout: 15000 })
      await h.sleep(500)
      const dialog = await win.evaluate(() => {
        const label = document.querySelector('#export-codec-label')
        const slider = document.querySelector('.export-frame input[type="range"]')
        return { label: label ? label.textContent : null, slider: slider ? getComputedStyle(slider).direction : null, modal: getComputedStyle(document.querySelector('.export-modal')).direction }
      })
      h.assert(dialog.label && dialog.label.includes(RLM), `the export dialog shows the ar-XB catalogue (${JSON.stringify(dialog.label)})`)
      h.assert(dialog.modal === 'rtl', `the export dialog reads right to left (${dialog.modal})`)
      h.assert(dialog.slider === null || dialog.slider === 'ltr', `the thumbnail's frame slider keeps ltr (${dialog.slider})`)
      await win.screenshot({ path: path.join(run, 'export-rtl.png') })
      await win.keyboard.press('Escape')

      const keep = process.env.SSW_RTL_SHOTS
      if (keep) for (const shot of ['editor-ltr.png', 'editor-rtl.png', 'export-rtl.png']) fs.copyFileSync(path.join(run, shot), path.join(keep, shot))
      console.log(`Right to left: ${rtl.labels.length} inspector labels mirrored (${rtl.labels.map((l) => l.text).join(', ')}); the ruler's ${rtl.ticks.length} ticks and the playhead stayed in place.`)
    } finally {
      fs.rmSync(run, { recursive: true, force: true })
    }
  })
}

void main()
