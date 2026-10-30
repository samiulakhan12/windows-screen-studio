// Search every recording (F-18; docs/design/search.md) in the real built app, with seeded projects
// (no network): the box under Recent recordings and Ctrl+F; a typo finds the moment a word was said,
// with the word marked and the count read out; arrow keys and Enter open the editor at the moment;
// a moment that was cut opens at the next kept part with a notice; Bangla is found by a prefix of an
// inflected word; a rename saved in the editor is found; a deleted recording's results go and leave
// the index file; the index file sits in userData and a damaged one is rebuilt; projects the index
// only read are byte-for-byte unchanged.
const fs = require('node:fs')
const path = require('node:path')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
/** A screenshot of Home's left column (the library and its search). */
async function shot(win, name) {
  if (!SHOTS) return
  const area = await (await win.$('.home-main')).boundingBox()
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`), clip: area })
}

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

const seg = (id, start, end, text) => ({ id, start, end, text })

/** Writes `extra` into a seeded project's project.json. */
function withFields(home, id, extra) {
  const file = path.join(h.projectsRoot(home), id, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }, null, 2))
}

/** Three recordings: an English one with a cut, a Bangla one, and one with only notes and a name. */
function seedLibrary(home) {
  const demo = f.seedProject(home, { id: 'rec-search-demo', name: 'Product demo', seconds: 10, width: 640, height: 360, clips: [{ id: 'a', start: 0, end: 4, speed: 1 }, { id: 'b', start: 6, end: 10, speed: 1 }], ageMs: 3000 })
  withFields(home, demo, {
    transcript: {
      provider: 'local',
      model: 'test',
      createdAt: new Date().toISOString(),
      language: 'en',
      segments: [
        seg('s1', 1, 2.5, 'Welcome to the product tour.'),
        seg('s2', 3, 3.9, 'Open the settings page.'),
        seg('s3', 4.2, 5.5, 'This bit about pricing was removed.'),
        seg('s4', 7.2, 8.9, 'Then save your changes.')
      ]
    },
    chapters: [{ id: 'c1', t: 7, title: 'Saving' }]
  })
  const bangla = f.seedProject(home, { id: 'rec-search-bangla', name: 'বাংলা ডেমো', seconds: 10, width: 640, height: 360, ageMs: 2000 })
  withFields(home, bangla, {
    transcript: { provider: 'local', model: 'test', createdAt: new Date().toISOString(), language: 'bn', segments: [seg('b1', 2, 4, 'আমি বাংলায় কথা বলি।')] }
  })
  const plain = f.seedProject(home, { id: 'rec-search-plain', name: 'Quarterly numbers', seconds: 10, width: 640, height: 360, ageMs: 1000 })
  withFields(home, plain, { script: { text: 'Mention the budget first.\nThen the hiring plan.' } })
  return { demo, bangla, plain }
}

const box = (win) => win.waitForSelector('[data-testid="library-search"]', { timeout: 30000 })
const timecode = (win) => win.$eval('.timecode', (e) => e.textContent)
const outTime = (tc) => {
  const [m, s] = tc.split('/')[0].trim().split(':')
  return Number(m) * 60 + Number(s)
}
const liveText = (win) => win.$eval('.library-search [role="status"]', (e) => e.textContent)
const activeRowText = (win) =>
  win.evaluate(() => {
    const input = document.querySelector('[data-testid="library-search"]')
    const id = input && input.getAttribute('aria-activedescendant')
    const el = id && document.getElementById(id)
    return el ? el.getAttribute('aria-label') : null
  })

/** Types `query` into the box (replacing what is there) and waits for results naming `expect` (or none). */
async function search(win, query, expectText) {
  await win.fill('[data-testid="library-search"]', query)
  await f.waitFor(
    async () => {
      const text = await liveText(win)
      return expectText === null ? text.startsWith('No recordings match') : text && (await win.textContent('.search-list')).includes(expectText)
    },
    `results for "${query}"`,
    10000
  )
}

/** The userData folder of a test HOME (Linux: ~/.config/<app name>). */
function indexFileOf(home) {
  const config = path.join(home, '.config')
  for (const name of fs.existsSync(config) ? fs.readdirSync(config) : []) {
    const file = path.join(config, name, 'search', 'index.json')
    if (fs.existsSync(file)) return file
  }
  return null
}

async function backToHome(win) {
  await win.click('button[aria-label="Back to recordings"]')
  await box(win)
}

;(async () => {
  const home = h.tempHome('search')
  const ids = seedLibrary(home)
  const root = h.projectsRoot(home)
  const before = Object.fromEntries(Object.values(ids).map((id) => [id, fs.readFileSync(path.join(root, id, 'project.json'))]))

  await test('Ctrl+F, a typo finds the moment, Enter opens the editor there', async (ctx) => {
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await box(win)
    h.assert((await win.$$('.search-results')).length === 0, 'no results before typing')
    await win.click('.home-section-title')
    await win.keyboard.press('Control+f')
    h.assert(await win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'library-search'), 'Ctrl+F puts the cursor in the box')

    await win.keyboard.type('setings')
    await f.waitFor(async () => (await liveText(win)) === '1 recording found', 'the count is read out', 10000)
    h.assert(await win.isHidden('.project-grid'), 'the grid makes room for the results')
    const marked = await win.$$eval('.search-moment mark', (els) => els.map((e) => e.textContent))
    h.assert(marked.includes('settings'), `the matched word is marked (${marked})`)
    h.assert((await win.textContent('.search-moment')).includes('0:03'), 'the moment shows its time')
    await shot(win, 'search-results')

    await win.keyboard.press('ArrowDown')
    h.assert((await activeRowText(win)).startsWith('Open Product demo'), 'the first row opens the recording')
    await win.keyboard.press('ArrowDown')
    const label = await activeRowText(win)
    h.assert(label.startsWith('Said at 3 seconds: Open the settings page.'), `a moment reads as one sentence (${label})`)
    await win.keyboard.press('Enter')
    await win.waitForSelector('.editor .preview-canvas', { timeout: 30000 })
    await f.waitFor(async () => Math.abs(outTime(await timecode(win)) - 3) < 0.05, 'the playhead at the moment (3 s)', 8000)

    // A moment in the cut (4..6 s) opens at the next kept part, with a notice.
    await backToHome(win)
    await win.click('[data-testid="library-search"]')
    await search(win, 'pricing', 'pricing')
    h.assert((await win.textContent('.search-moment')).includes('Cut'), 'a cut moment says so')
    await shot(win, 'search-cut')
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.editor .preview-canvas', { timeout: 30000 })
    await f.waitFor(async () => ((await win.textContent('.notice-slot').catch(() => '')) || '').includes('That moment was cut from the video'), 'the cut notice', 8000)
    await f.waitFor(async () => Math.abs(outTime(await timecode(win)) - 4) < 0.05, 'the playhead at the next kept part (output 4 s)', 8000)

    // A rename saved in the editor is found from Home.
    await win.fill('input[aria-label="Recording name"]', 'Product demo Zebra')
    await win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
    await backToHome(win)
    await f.waitFor(
      async () => {
        await win.fill('[data-testid="library-search"]', '')
        await win.fill('[data-testid="library-search"]', 'zebra')
        await h.sleep(600)
        return (await liveText(win)) === '1 recording found'
      },
      'the renamed recording is found',
      12000
    )
    h.assert((await win.$$eval('.search-hit-name mark', (els) => els.map((e) => e.textContent))).includes('Zebra'), 'the name has the word marked')

    // Escape clears the box; the grid is back.
    await win.keyboard.press('Escape')
    h.assert((await win.inputValue('[data-testid="library-search"]')) === '', 'Escape clears the box')
    await win.waitForSelector('.project-grid', { state: 'visible' })
  })

  await test('Bangla by a prefix, notes, no match, and a deleted recording goes', async (ctx) => {
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await box(win)
    await win.click('[data-testid="library-search"]')
    await search(win, 'বাংলা', 'বাংলায়')
    h.assert((await win.textContent('.search-moment')).includes('0:02'), 'the Bangla moment and its time')
    await shot(win, 'search-bangla')

    await search(win, 'budget', 'budget')
    h.assert((await win.textContent('.search-moment .search-kind')) === 'Notes', 'speaker notes are found')

    await search(win, 'nothing like this', null)
    h.assert((await win.textContent('.search-empty')).includes('Search looks in what was said'), 'no match says where search looks')
    await shot(win, 'search-empty')

    // Delete Quarterly numbers: its notes are no longer found, and leave the index file.
    await win.fill('[data-testid="library-search"]', '')
    win.once('dialog', (d) => void d.accept())
    await win.click('button[aria-label="Delete Quarterly numbers"]')
    await f.waitFor(async () => !(await win.$('.project-open:has-text("Quarterly numbers")')), 'the recording is deleted')
    await search(win, 'budget', null)
    await f.waitFor(
      () => {
        const file = indexFileOf(home)
        return file && !fs.readFileSync(file, 'utf8').includes('rec-search-plain')
      },
      'the index file forgets the deleted recording',
      10000
    )
  })

  await test('the index file: in userData, rebuilt when damaged, projects unchanged', async (ctx) => {
    const file = indexFileOf(home)
    h.assert(file, 'the index file is in userData/search')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    h.assert(stored.version === 1 && stored.projects['rec-search-bangla'], 'it holds the recordings')
    h.assert(!fs.readdirSync(path.join(root, ids.bangla)).some((n) => /search|index/i.test(n)), 'nothing is written into project folders')
    fs.writeFileSync(file, '{ damaged')

    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await box(win)
    await win.click('[data-testid="library-search"]')
    await search(win, 'বলি', 'বলি')
    await f.waitFor(
      () => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8')).version === 1
        } catch {
          return false
        }
      },
      'the damaged index is written again',
      15000
    )
    // Only the editor saves: the Bangla project was only read by the index.
    h.assert(Buffer.compare(fs.readFileSync(path.join(root, ids.bangla, 'project.json')), before[ids.bangla]) === 0, 'an indexed project is byte-for-byte unchanged')
    h.assert(!logs.join('').includes('বলি'), 'the query is never logged')
  })
})()
