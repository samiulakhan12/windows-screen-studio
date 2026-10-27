// The audio waveform on the timeline (E-04) in the built app: a recording with talk / silence /
// talk shows its sound on the clip track with the pause shaded, a cut fades the waveform under
// it, playback never redraws it, undo leaves the pauses alone, the palette hides it (remembered
// on reopening) and shows it again, and a recording without sound has none.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

const SHOTS = process.env.SSW_E2E_SHOTS || null
const MEDIA_CACHE = path.join(os.tmpdir(), 'ssw-e2e-media')
const GUTTER = 10 // .tl-content padding (Timeline.tsx GUTTER)
const WAVE = '[data-testid="clip-waveform"]'

function test(name, body) {
  const only = process.env.SSW_E2E_ONLY
  if (only && !name.includes(only)) return Promise.resolve()
  return h.run(name, body)
}

/** 12 s test pattern with a voice (a tone) from 0.3 s to 3.5 s and from 7.5 s to 11.9 s, silent in between (cached). */
function talkSilenceTalk() {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, 'talk-silence-talk-12s-640x360-30.mp4')
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.mp4`
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', "sine=frequency=330:sample_rate=48000,volume='if(between(t,0.3,3.5)+between(t,7.5,11.9),1.5,0)':eval=frame",
    '-t', '12', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    tmp
  ], { stdio: 'inherit' })
  fs.renameSync(tmp, file)
  return file
}

/** Seeds a project into `home`, its screen.mp4 replaced by `opts.video` when given. */
function seed(home, opts) {
  const id = f.seedProject(home, opts)
  if (opts.video) {
    const media = path.join(h.projectsRoot(home), id, 'screen.mp4')
    fs.unlinkSync(media)
    fs.symlinkSync(opts.video, media)
  }
  return id
}

const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const notice = (win, text) => win.waitForSelector(`.notice:has-text("${text}")`, { timeout: 10000 })
const paletteTitles = (win) => win.$$eval('.command-palette [role="option"] .palette-title', (els) => els.map((e) => e.textContent))

async function xForTime(win, t) {
  return win.$eval('.tl-content', (el, [time, gutter]) => el.getBoundingClientRect().left + gutter + time * Number(el.dataset.pxPerSec), [t, GUTTER])
}

async function centerY(win, selector) {
  return win.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return b.y + b.height / 2
  })
}

/** Opens the palette and types `query`, waiting for the waveform command to be listed first. */
async function paletteWaveform(win) {
  await win.keyboard.press('Control+k')
  await win.waitForSelector('.command-palette[role="dialog"]', { timeout: 5000 })
  await win.keyboard.type('waveform')
  await f.waitFor(async () => (await paletteTitles(win))[0] === 'Audio waveform on the timeline', 'the waveform command listed first', 3000)
}

/** The canvas column at source time `t`: its device-pixel ratio and each row's RGBA. */
function column(win, t) {
  return win.$eval(
    WAVE,
    (c, time) => {
      const r = c.width / c.clientWidth
      const x = Math.round((time - Number(c.dataset.from)) * Number(c.dataset.px) * r)
      const d = c.getContext('2d').getImageData(Math.min(c.width - 1, Math.max(0, x)), 0, 1, c.height).data
      const rows = []
      for (let i = 0; i < c.height; i++) rows.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]])
      return { r, rows }
    },
    t
  )
}

/** Share of the column's rows the waveform lights (bright and mostly opaque; the pause band is neither). */
const litShare = ({ rows }) => rows.filter(([r, , , a]) => r > 150 && a > 100).length / rows.length
const meanAlpha = ({ rows }) => rows.reduce((s, [, , , a]) => s + a, 0) / rows.length

async function main() {
  await test('waveform shows talk and pauses, follows a cut, costs nothing during playback, hides from the palette', async (ctx) => {
    const home = h.tempHome('waveform')
    seed(home, { id: 'rec-talk', name: 'Talk', seconds: 12, width: 640, height: 360, fps: 30, audio: true, video: talkSilenceTalk() })
    seed(home, { id: 'rec-silent', name: 'Silent', seconds: 12, width: 640, height: 360, fps: 30, audio: false })
    const { app, win, logs } = await h.launch({ home })
    ctx.app = app
    ctx.logs = logs
    await win.waitForSelector('.home', { timeout: 30000 })
    await f.openProject(win, 'Talk')

    // Ready: the mixed track, one pause between the two stretches of talk.
    await win.waitForSelector(`${WAVE}[data-state="ready"]`, { timeout: 30000 })
    const attrs = await win.$eval(WAVE, (c) => ({ ...c.dataset }))
    console.log(`waveform: ${JSON.stringify(attrs)}`)
    h.assert(attrs.sources === 'mix', `the mixed track is drawn: ${attrs.sources}`)
    const pauses = attrs.pauses.split(';').filter(Boolean).map((p) => p.split('-').map(Number))
    h.assert(pauses.length === 1 && Math.abs(pauses[0][0] - 3.5) < 0.15 && Math.abs(pauses[0][1] - 7.5) < 0.15, `one pause 3.5–7.5 s: ${attrs.pauses}`)
    const title = await win.getAttribute('.tl-track.clip-track', 'title')
    h.assert(title.endsWith(" · Waveform: the recording's sound; darker stretches are pauses"), `the clip track's tooltip explains it: ${title}`)

    // Pixels: talk fills most of the track's height; the pause is a hairline over a dark band.
    const talk = await column(win, 2)
    const pause = await column(win, 5.5)
    console.log(`lit at 2.0 s: ${litShare(talk).toFixed(2)}, at 5.5 s: ${litShare(pause).toFixed(2)}; band ${JSON.stringify(pause.rows[Math.round(3 * pause.r)])}`)
    h.assert(litShare(talk) > 0.5, `talk spans more than half the height: ${litShare(talk)}`)
    h.assert(litShare(pause) < 0.1, `the pause is (almost) flat: ${litShare(pause)}`)
    const [bandR, , , bandA] = pause.rows[Math.round(3 * pause.r)]
    h.assert(bandA > 40 && bandR < 60, `the pause is shaded darker: ${pause.rows[Math.round(3 * pause.r)]}`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'waveform.png') })

    // A range cut: the waveform stays, faded over the cut's hatching.
    const y = await centerY(win, '.tl-track.clip-track')
    const a = await xForTime(win, 1)
    const b = await xForTime(win, 2.5)
    await win.keyboard.down('Shift')
    await win.mouse.move(a, y)
    await win.mouse.down()
    for (let i = 1; i <= 8; i++) await win.mouse.move(a + ((b - a) * i) / 8, y)
    await win.mouse.up()
    await win.keyboard.up('Shift')
    await win.waitForSelector('[data-testid="range-selection"]')
    await win.keyboard.press('Delete')
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 1, 'the range is cut', 3000)
    const inCut = meanAlpha(await column(win, 1.75))
    const kept = meanAlpha(await column(win, 3))
    console.log(`mean alpha in the cut ${inCut.toFixed(1)}, kept ${kept.toFixed(1)}`)
    // It keeps 30% of its opacity there (WAVEFORM.gapAlpha).
    h.assert(Math.abs(inCut / kept - 0.3) < 0.08, `the waveform is faded to 30% in the cut: ${inCut} vs ${kept}`)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'waveform-cut.png') })

    // Playback never redraws it (at fit the timeline does not scroll).
    await waitSaved(win)
    const draws = await win.getAttribute(WAVE, 'data-draws')
    await win.keyboard.press('Space')
    await h.sleep(1500)
    await win.keyboard.press('Space')
    h.assert((await win.getAttribute(WAVE, 'data-draws')) === draws, `no redraw while playing: ${draws} -> ${await win.getAttribute(WAVE, 'data-draws')}`)

    // Undo brings the footage back; the pauses do not depend on the cuts.
    await win.keyboard.press('Control+z')
    await f.waitFor(async () => (await win.$$('.gap-block.cut')).length === 0, 'the cut is undone', 3000)
    h.assert((await win.getAttribute(WAVE, 'data-pauses')) === attrs.pauses, 'the pauses are unchanged')

    // Hidden from the palette, and still hidden when the project is opened again.
    await paletteWaveform(win)
    h.assert((await win.$eval('.command-palette [role="option"] .palette-state', (e) => e.textContent)) === 'On', 'the palette shows it on')
    await win.keyboard.press('Enter')
    await notice(win, 'Audio waveform off')
    h.assert(!(await win.$(WAVE)), 'no waveform once hidden')
    h.assert(!(await win.getAttribute('.tl-track.clip-track', 'title')).includes('Waveform'), 'nor its tooltip')
    await win.click('button[aria-label="Back to recordings"]')
    await f.openProject(win, 'Talk')
    await h.sleep(500)
    h.assert(!(await win.$(WAVE)), 'still hidden after reopening')
    await paletteWaveform(win)
    await win.keyboard.press('Enter')
    await notice(win, 'Audio waveform on')
    await win.waitForSelector(`${WAVE}[data-state="ready"]`, { timeout: 30000 })

    // A recording without sound: no waveform, and the command says why.
    await win.click('button[aria-label="Back to recordings"]')
    await f.openProject(win, 'Silent')
    await h.sleep(500)
    h.assert(!(await win.$(WAVE)), 'no waveform without sound')
    h.assert((await win.getAttribute('.tl-track.clip-track', 'title')) === 'Click to move the playhead, Shift+drag to select a range to cut', 'the tooltip is as before')
    await paletteWaveform(win)
    const first = await win.$eval('.command-palette .palette-item', (e) => ({ unavailable: e.classList.contains('unavailable'), title: e.getAttribute('title') }))
    h.assert(first.unavailable && first.title === 'This recording has no sound', `unavailable without sound: ${JSON.stringify(first)}`)
    await win.keyboard.press('Escape')
  })
}

main()
