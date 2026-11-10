// Test 60 (docs/design/output-and-languages.md §23.1, §18.1): a Bangla session makes no request
// outside the app's own files. The English guard's tour (uiTour.cjs) walks the app with Flown set to
// Bangla and the fixture catalogue (tests/fixtures/i18n, through SSW_I18N_CATALOGUE_DIR in this
// unpackaged build); the tour blocks and logs every http, https, ws and wss request, so anything it
// logs went outside file:, studio-media: and the dev server. The run proves it was Bangla: <html
// lang="bn"> and the Language section's heading from the fixture catalogue.
//
//   npm run build
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/languages-network.e2e.cjs
//
// The tour's fixed home and its screenshots go under this run's own folder, so an English guard run
// at the same time keeps its own.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const h = require('./helpers.cjs')

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-languages-network-'))
const realTmpdir = os.tmpdir
os.tmpdir = () => RUN_DIR
const tour = require('./uiTour.cjs')
os.tmpdir = realTmpdir

const FIXTURES = path.join(__dirname, '../fixtures/i18n')

/** Every launch of the tour: Flown set to Bangla, the fixture catalogue, and what each page's <html> says. */
const launch = h.launch
const pages = []
h.launch = async (opts) => {
  const userData = path.join(opts.home, '.config', 'Flown')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'editor-prefs.json'), JSON.stringify({ ui: { language: 'bn' } }))
  const started = await launch({ ...opts, env: { ...opts.env, SSW_I18N_CATALOGUE_DIR: FIXTURES } })
  pages.push(await started.win.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir })))
  return started
}

async function main() {
  await h.run('languages: a Bangla session through the tour makes no request outside the app (test 60)', async () => {
    try {
      const result = await tour.runTour({ out: path.join(RUN_DIR, 'shots'), log: (m) => process.env.SSW_GUARD_VERBOSE && console.log(m) })
      h.assert(pages.length > 0 && pages.every((p) => p.lang === 'bn' && p.dir === 'ltr'), `every window started in Bangla (${JSON.stringify(pages)})`)
      const settings = result.screens.find((s) => s.name === 'settings')
      h.assert(settings && settings.text.includes('ভাষা · Language'), 'Settings shows the Language section from the Bangla catalogue')
      h.assert(result.screens.length > 40, `the tour walked its screens (${result.screens.length})`)
      h.assert(result.blocked.length === 0, `no request left the app (blocked: ${result.blocked.join(', ')})`)
      console.log(`A Bangla session walked ${result.screens.length} screens and made no network request.`)
    } finally {
      fs.rmSync(RUN_DIR, { recursive: true, force: true })
    }
  })
}

void main()
