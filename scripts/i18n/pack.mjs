#!/usr/bin/env node
// The review pack (docs/design/output-and-languages.md §15.4): the English guard's tour (§10.6) run
// under the language's draft catalogue, one screenshot per screen with every text's key drawn beside
// it, plus the bn-XA screenshots that show text too long or too tall at the Bangla sizes, in one
// folder with one HTML page. A reviewer opens translations/<lang>/pack/index.html; nothing has to be
// installed. Fixture projects only: never a user's data.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/i18n/pack.mjs --lang bn
//
// The review build for developers (unpackaged only):
//   FLOWN_I18N_REVIEW=1 node scripts/i18n/pack.mjs --lang bn --live
// writes the catalogue with each message's key and state marked to scripts/i18n/review/<lang>/ and
// starts `npm run dev` on it; choose the language in Settings › Language. Without FLOWN_I18N_REVIEW
// the catalogue carries no marks and the overlay stays off.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const files = require('./lib/files.cjs')
const { reviewCatalogue, liveMarks, mainPart, keysOnScreen, packPage } = require('./lib/review.cjs')
const { pseudoCatalogue } = require('./lib/pseudo.cjs')
const { builtFile } = require('./lib/build.cjs')

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const fail = (msg) => {
  console.error(`i18n pack: ${msg}`)
  process.exit(1)
}
const root = path.resolve(option('--root') ?? files.ROOT)
const lang = option('--lang')
if (!lang || !files.LANGUAGES.includes(lang)) fail(`give --lang, one of ${files.LANGUAGES.join(', ')}.`)
const en = files.readEnglish(root)
const translations = files.readTranslations(root, lang)
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

/** Writes a catalogue folder an unpackaged build reads through SSW_I18N_CATALOGUE_DIR. */
function writeFolder(dir, language, catalogue) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${language}.json`), json(catalogue))
  fs.writeFileSync(path.join(dir, `${language}.main.json`), json(mainPart(catalogue)))
  fs.writeFileSync(path.join(dir, 'shipped.json'), json([{ language, preview: true }]))
}

if (args.includes('--live')) {
  const marks = liveMarks(process.env)
  const dir = path.join(root, files.TOOLS_DIR, 'review', lang)
  writeFolder(dir, lang, reviewCatalogue({ lang, english: en.messages, meta: en.meta, translations, marks }).catalogue)
  console.log(`i18n pack: the ${lang} review catalogue is in ${path.relative(root, dir)} (${marks ? 'keys marked for the overlay' : 'no marks: set FLOWN_I18N_REVIEW=1 for the overlay'}). Starting npm run dev; choose the language in Settings › Language.`)
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], { cwd: root, stdio: 'inherit', env: { ...process.env, SSW_I18N_CATALOGUE_DIR: dir } })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) fail('build the app first: npm run build.')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-review-pack-'))
  const packDir = path.join(root, files.TRANSLATIONS_DIR, lang, 'pack')
  // The tour keeps its fixed home under the temporary folder, so a guard run at the same time keeps its own.
  const realTmpdir = os.tmpdir
  os.tmpdir = () => work
  const tour = require(path.join(root, 'tests', 'e2e', 'uiTour.cjs'))
  const h = require(path.join(root, 'tests', 'e2e', 'helpers.cjs'))
  os.tmpdir = realTmpdir
  const launch = h.launch
  let catalogueDir = ''
  h.launch = async (opts) => {
    const userData = path.join(opts.home, '.config', 'Flown')
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(path.join(userData, 'editor-prefs.json'), JSON.stringify({ ui: { language: lang } }))
    return launch({ ...opts, env: { ...opts.env, SSW_I18N_CATALOGUE_DIR: catalogueDir, FLOWN_I18N_REVIEW: '1' } })
  }
  try {
    const review = reviewCatalogue({ lang, english: en.messages, meta: en.meta, translations, marks: 'labels' })
    catalogueDir = path.join(work, 'review')
    writeFolder(catalogueDir, lang, review.catalogue)
    fs.rmSync(packDir, { recursive: true, force: true })
    console.log(`i18n pack: walking the tour in ${lang} with every key drawn beside its text...`)
    const shots = path.join(packDir, 'screens')
    const result = await tour.runTour({ out: shots, log: (m) => process.env.SSW_GUARD_VERBOSE && console.log(m) })
    if (result.blocked.length) fail(`the app tried to reach the network: ${result.blocked.join(', ')}`)
    const screens = result.screens.map((s) => ({ name: s.name, keys: keysOnScreen(`${s.title}\n${s.text}\n${JSON.stringify(s.attrs ?? [])}\n${JSON.stringify(s.main ?? [])}`) }))

    console.log('i18n pack: walking the tour in bn-XA for text that does not fit...')
    const pseudo = pseudoCatalogue('bn-XA', en.messages, en.meta)
    catalogueDir = path.join(work, 'bn-XA')
    writeFolder(catalogueDir, 'bn', builtFile(pseudo.messages, en.meta))
    const savedLang = lang
    const overflowRun = await (async () => {
      const prev = h.launch
      h.launch = async (opts) => {
        const userData = path.join(opts.home, '.config', 'Flown')
        fs.mkdirSync(userData, { recursive: true })
        fs.writeFileSync(path.join(userData, 'editor-prefs.json'), JSON.stringify({ ui: { language: 'bn' } }))
        return launch({ ...opts, env: { ...opts.env, SSW_I18N_CATALOGUE_DIR: catalogueDir } })
      }
      try {
        return await tour.runTour({ out: path.join(packDir, 'bn-XA'), log: () => undefined })
      } finally {
        h.launch = prev
      }
    })()
    fs.writeFileSync(
      path.join(packDir, 'index.html'),
      packPage({ lang: savedLang, screens, overflow: overflowRun.screens.map((s) => s.name), english: en.messages, translations, states: review.states })
    )
    console.log(`i18n pack: ${screens.length} screen(s) in ${path.relative(root, packDir)}/index.html.`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
