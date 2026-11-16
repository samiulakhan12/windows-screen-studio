// The pseudo-locale check of docs/design/output-and-languages.md §12.3, for development: Flown runs
// with the en-XA (40% longer, bracketed) and bn-XA (Bengali syllables with reph, chandrabindu and
// below-base forms, at the Bangla sizes) catalogues from `npm run i18n:pseudo`, walks Home, Settings
// (every section), the editor with every inspector tab, the command palette, Polish, Versions,
// Publish and the export dialog, and lists every element whose text overflows its box
// (scrollWidth > clientWidth or scrollHeight > clientHeight, fixed-height controls included).
// The same walk in English is the reference: an element that overflows in English too is listed
// apart, so what remains is what longer or taller text does.
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/pseudo-overflow.cjs [--out <dir>]
//
// Writes <out>/overflow.json and screenshots; prints a summary. It reports and never fails: the
// overflows are for the translators' review (§15.4) and the layout work before a language ships.
// Not part of run-all (no .e2e.cjs suffix).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const fx = require('./render-fixtures.cjs')

const args = process.argv.slice(2)
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(os.tmpdir(), 'flown-pseudo-overflow'))
const LOCALES = [
  { locale: 'en', slot: null },
  { locale: 'bn-XA', slot: 'bn' },
  { locale: 'en-XA', slot: 'es' }
]

function setUiPref(home, ui) {
  const userData = path.join(home, '.config', 'Flown')
  fs.mkdirSync(userData, { recursive: true })
  const file = path.join(userData, 'editor-prefs.json')
  const prefs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  if (ui === undefined) delete prefs.ui
  else prefs.ui = ui
  fs.writeFileSync(file, JSON.stringify(prefs))
}

function seed(home) {
  const media = fx.indexedVideo({ seconds: 3, width: 1280, height: 720, beeps: true })
  return fx.seedProject(home, {
    id: 'rec-pseudo',
    name: 'Pseudo',
    media,
    seconds: 3,
    audio: true,
    style: { background: { type: 'gradient', preset: 'aurora' }, padding: 0.06, cornerRadius: 12, shadow: 0.5, aspectRatio: 'auto' }
  })
}

/** In the page: every visible element with its own text whose text overflows its box. */
function overflowing() {
  const pathOf = (el) => {
    const parts = []
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const id = e.getAttribute('data-testid')
      const cls = [...e.classList].slice(0, 2).join('.')
      const parent = e.parentElement
      const index = parent ? [...parent.children].filter((c) => c.tagName === e.tagName).indexOf(e) : 0
      parts.unshift(`${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls ? `.${cls}` : ''}:${index}`)
    }
    return parts.join('>')
  }
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
    if (!own || !/\p{L}/u.test(own)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'inline' || cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    // Visually hidden text (sr-only: a 1 px box) is for screen readers; it has no box to fit.
    if (r.width <= 1 || r.height <= 1) continue
    const w = el.scrollWidth - el.clientWidth
    const hgt = el.scrollHeight - el.clientHeight
    if (w > 1 || hgt > 1) out.push({ path: pathOf(el), text: own.slice(0, 80), width: el.clientWidth, height: el.clientHeight, over: { x: Math.max(0, w), y: Math.max(0, hgt) }, ellipsis: cs.textOverflow === 'ellipsis', clipped: cs.overflow !== 'visible' })
  }
  return out
}

async function walk(win, locale, home, shots) {
  const screens = {}
  const capture = async (name) => {
    await h.sleep(400)
    screens[name] = await win.evaluate(overflowing)
    await win.screenshot({ path: path.join(shots, `${locale}-${name}.png`) }).catch(() => undefined)
  }
  await capture('home')
  await win.click('.titlebar button[aria-haspopup="dialog"]')
  await win.waitForSelector('.settings-modal')
  await capture('settings')
  const sections = await win.$$eval('.settings-body > *', (els) => els.length)
  for (let i = 0; i < sections; i++) {
    const shown = await win.evaluate((k) => {
      const el = document.querySelectorAll('.settings-body > *')[k]
      if (!el || !el.getBoundingClientRect().height) return false
      el.scrollIntoView({ block: 'start' })
      return true
    }, i)
    if (shown) await capture(`settings-${String(i + 1).padStart(2, '0')}`)
  }
  await win.keyboard.press('Escape')
  await win.waitForSelector('.settings-modal', { state: 'detached' })
  await fx.openProject(win, 'Pseudo')
  await capture('editor')
  const tabs = await win.$$eval('.insp-tabs button', (els) => els.length)
  for (let i = 0; i < tabs; i++) {
    await win.click(`.insp-tabs button >> nth=${i}`)
    await h.sleep(300)
    await capture(`tab-${String(i + 1).padStart(2, '0')}`)
  }
  await win.click('.titlebar .command-button')
  await win.waitForSelector('.command-palette[role="dialog"]')
  await capture('palette')
  await win.keyboard.press('Escape')
  for (const id of ['polish-open', 'versions-open']) {
    await win.click(`[data-testid="${id}"]`)
    await h.sleep(800)
    await capture(id.replace('-open', ''))
    await win.keyboard.press('Escape')
    await h.sleep(300)
  }
  await win.click('.titlebar .btn.primary')
  await win.waitForSelector('.export-modal, .export-dialog, [role="dialog"]', { timeout: 15000 })
  await h.sleep(800)
  await capture('export')
  await win.keyboard.press('Escape')
  return screens
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  const shots = path.join(OUT, 'shots')
  fs.mkdirSync(shots, { recursive: true })
  const pseudoDir = path.join(OUT, 'catalogues')
  execFileSync(process.execPath, [path.join(__dirname, '../../scripts/i18n/pseudo.mjs'), '--out', pseudoDir], { stdio: 'inherit' })
  const results = {}
  for (const { locale, slot } of LOCALES) {
    await h.run(`pseudo overflow: ${locale}`, fx.withHome(`pseudo-${locale}`, async (ctx, home) => {
      seed(home)
      if (slot) setUiPref(home, { language: slot })
      const env = slot ? { SSW_I18N_CATALOGUE_DIR: path.join(pseudoDir, locale), SSW_PREFERRED_LANGUAGES: 'en-US' } : {}
      const { app, win } = await h.launch({ home, env })
      ctx.app = app
      await win.waitForSelector('.home, .editor', { timeout: 30000 })
      const lang = await win.evaluate(() => document.documentElement.lang)
      h.assert(lang === (slot ?? 'en'), `the session is in ${slot ?? 'en'} (${lang})`)
      results[locale] = await walk(win, locale, home, shots)
    }))
  }
  const english = new Set(Object.entries(results.en ?? {}).flatMap(([screen, list]) => list.map((o) => `${screen}|${o.path}`)))
  const summary = {}
  for (const locale of ['bn-XA', 'en-XA']) {
    const all = Object.entries(results[locale] ?? {}).flatMap(([screen, list]) => list.map((o) => ({ screen, ...o })))
    summary[locale] = { new: all.filter((o) => !english.has(`${o.screen}|${o.path}`)), alsoInEnglish: all.filter((o) => english.has(`${o.screen}|${o.path}`)).length }
  }
  fs.writeFileSync(path.join(OUT, 'overflow.json'), JSON.stringify({ english: [...english], summary }, null, 2))
  console.log(`English overflows (reference): ${english.size}`)
  for (const [locale, s] of Object.entries(summary)) {
    // One line per element: the screens it overflows on, then its box and how far the text goes past it.
    const byPath = new Map()
    for (const o of s.new) {
      const seen = byPath.get(o.path)
      if (seen) seen.screens.push(o.screen)
      else byPath.set(o.path, { ...o, screens: [o.screen] })
    }
    console.log(`${locale}: ${byPath.size} element(s) overflow only in ${locale} (${s.new.length} on all screens); ${s.alsoInEnglish} overflow in English too`)
    for (const o of byPath.values()) console.log(`  ${o.path.split('>').slice(-3).join('>')}  "${o.text}"  ${o.width}x${o.height} +${o.over.x}/${o.over.y}${o.ellipsis ? ' (ellipsis)' : ''}  [${o.screens.length > 3 ? `${o.screens.slice(0, 3).join(', ')} and ${o.screens.length - 3} more` : o.screens.join(', ')}]`)
  }
  console.log(`Details: ${path.join(OUT, 'overflow.json')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
