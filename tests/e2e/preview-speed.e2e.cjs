// J / K / L shuttle and preview speed (E-08), end to end on a seeded project: the speed menu
// plays the preview faster, L goes faster with each press (silent above 4×), J plays backwards
// through landed seeks, K + L steps one frame, > and < change the speed with notices, and none of
// it reaches the project, the undo history or the save state.
const h = require('./helpers.cjs')
const f = require('./editor-fixtures.cjs')

/** Launches the app on a fresh HOME with one seeded project and opens it in the editor. */
async function setup(ctx, tag, opts) {
  const home = h.tempHome(tag)
  const id = f.seedProject(home, opts)
  const { app, win, logs } = await h.launch({ home })
  ctx.app = app
  ctx.logs = logs
  await win.waitForSelector('.home', { timeout: 30000 })
  // Keep handles on the editor's (detached) <video> elements.
  await win.evaluate(() => {
    const create = document.createElement.bind(document)
    window.__videos = []
    document.createElement = (tag, ...rest) => {
      const el = create(tag, ...rest)
      if (String(tag).toLowerCase() === 'video') window.__videos.push(el)
      return el
    }
  })
  await f.openProject(win, opts.name)
  return { home, id, app, win }
}

const disk = (home, id) => h.readProject(home, id)
const waitSaved = (win) => win.waitForSelector('.save-state[data-state="saved"]', { timeout: 10000 })
const timecode = (win) => win.$eval('.timecode', (e) => e.textContent)
/** "1:02.3 / 2:00.0" -> 62.3 */
const outTime = (tc) => {
  const [m, s] = tc.split('/')[0].trim().split(':')
  return Number(m) * 60 + Number(s)
}
const isPlaying = (win) => win.$eval('.transport .btn.round', (b) => b.dataset.playing === 'true')
const video = (win) =>
  win.evaluate(() => {
    const v = window.__videos.find((x) => x.getAttribute('src'))
    return v ? { t: v.currentTime, rate: v.playbackRate, paused: v.paused, muted: v.muted, volume: v.volume } : null
  })
const badge = (win) => win.evaluate(() => document.querySelector('.shuttle-badge')?.textContent ?? null)
const notice = (win, text) => win.waitForSelector(`.notice:has-text("${text}")`, { timeout: 10000 })

/** Puts the playhead at `seconds` (whole seconds) with Home and Shift+→. */
async function playheadAt(win, seconds) {
  await win.keyboard.press('Home')
  for (let i = 0; i < seconds; i++) await win.keyboard.press('Shift+ArrowRight')
  await f.waitFor(async () => Math.abs(outTime(await timecode(win)) - seconds) < 0.05, `playhead at ${seconds} s`, 3000)
}

async function main() {
  await h.run('preview speed and J/K/L never change the project', async (ctx) => {
    // 60 s: at 8× a short video would reach its end (and clear the badge) during the checks.
    const { home, id, win } = await setup(ctx, 'shuttle', { name: 'Shuttle', seconds: 60, width: 320, height: 180, fps: 30, audio: true })
    await waitSaved(win)
    const clips0 = disk(home, id).clips
    const SPEED = 'select[aria-label="Preview speed"]'

    // The menu: 2× plays the preview twice as fast, and gives the keys back at once.
    h.assert((await win.$eval(SPEED, (s) => s.value)) === '1', 'the preview starts at 1×')
    await win.selectOption(SPEED, '2')
    h.assert(await win.$eval(SPEED, (s) => document.activeElement !== s), 'the menu lets go of the focus after a choice')
    h.assert((await win.$eval('.preview-speed', (l) => l.dataset.changed)) === 'true', 'the menu is outlined while not at 1×')
    const before = outTime(await timecode(win))
    await win.keyboard.press('Space')
    await f.waitFor(() => isPlaying(win), 'Space plays at the preview speed', 3000)
    h.assert((await video(win)).rate === 2, `element rate 2 at 2×: ${JSON.stringify(await video(win))}`)
    await h.sleep(1500)
    const moved = outTime(await timecode(win)) - before
    h.assert(moved >= 2.2, `2× moves the playhead at least 2.2 s in 1.5 s: ${moved}`)
    await win.keyboard.press('Space')
    await f.waitFor(async () => !(await isPlaying(win)), 'Space stops', 3000)

    // L: forward, faster with each press up to 8×, silent above 4×.
    await win.selectOption(SPEED, '1')
    await win.keyboard.press('Home')
    await win.keyboard.press('l')
    await f.waitFor(() => isPlaying(win), 'L plays', 3000)
    h.assert((await video(win)).rate === 1 && (await badge(win)) === null, 'L once: 1×, no badge')
    await win.keyboard.press('l')
    await f.waitFor(async () => (await badge(win)) === 'Forward 2×', 'L twice: Forward 2×', 3000)
    h.assert((await video(win)).rate === 2, 'element rate 2')
    await win.keyboard.press('l')
    await win.keyboard.press('l')
    await f.waitFor(async () => (await badge(win)) === 'Forward 8× · no sound', 'L four times: Forward 8×, no sound', 3000)
    const fast = await video(win)
    h.assert(fast.rate === 8 && fast.muted === true, `element rate 8 and muted: ${JSON.stringify(fast)}`)
    await win.keyboard.press('l')
    await h.sleep(200)
    h.assert((await badge(win)) === 'Forward 8× · no sound', 'a fifth L stays at 8×')
    await win.keyboard.press('Space')
    await f.waitFor(async () => !(await isPlaying(win)) && (await badge(win)) === null, 'Space stops and clears the badge', 3000)
    h.assert((await video(win)).muted === false, 'no shuttle mute is left behind')

    // J: backwards from 8 s, through seeks that land and are drawn.
    await playheadAt(win, 8)
    await win.keyboard.press('j')
    await f.waitFor(async () => (await badge(win)) === 'Reverse 1×', 'J: Reverse 1×', 3000)
    h.assert(await isPlaying(win), 'the play button shows Pause while reversing')
    h.assert((await video(win)).paused === true, 'the element itself stays paused')
    await h.sleep(1500)
    const back = outTime(await timecode(win))
    const shown = await video(win)
    h.assert(back >= 5.5 && back <= 7.6, `reverse moved the playhead back about 1.5 s: ${back}`)
    h.assert(shown.t < 8, `the video followed: ${JSON.stringify(shown)}`)
    await win.keyboard.press('k')
    await f.waitFor(async () => !(await isPlaying(win)) && (await badge(win)) === null, 'K stops reverse', 3000)

    // K held + L: one frame forward per tap.
    await playheadAt(win, 3)
    await f.waitFor(async () => Math.abs((await video(win)).t - 3) < 0.01, 'the video at 3 s', 3000)
    await win.keyboard.down('k')
    for (let i = 0; i < 3; i++) await win.keyboard.press('l')
    await win.keyboard.up('k')
    await f.waitFor(async () => Math.abs((await video(win)).t - 3.1) < 0.02, 'K + three L: three frames forward', 3000)
    h.assert(!(await isPlaying(win)), 'frame steps do not play')

    // > and <: the preview speed, with notices.
    await win.keyboard.press('>')
    await notice(win, 'Preview speed 1.5× (the export is not affected)')
    await win.keyboard.press('>')
    await notice(win, 'Preview speed 2× (the export is not affected)')
    await win.keyboard.press('>')
    await notice(win, 'The preview already plays at its fastest speed (2×)')
    h.assert((await win.$eval(SPEED, (s) => s.value)) === '2', 'the menu follows the keys')
    await win.keyboard.press('<')
    await notice(win, 'Preview speed 1.5× (the export is not affected)')

    // J at the start has nothing to play.
    await win.keyboard.press('Home')
    await win.keyboard.press('j')
    await notice(win, 'At the start: nothing to play backwards')
    h.assert((await badge(win)) === null && !(await isPlaying(win)), 'J at the start does nothing')

    // Nothing reached the project.
    await h.sleep(500)
    await waitSaved(win)
    const after = disk(home, id)
    h.assert(JSON.stringify(after.clips) === JSON.stringify(clips0), 'the clips are unchanged')
    h.assert(!Object.keys(after).some((k) => /preview|shuttle/i.test(k)), `no preview speed in the project: ${Object.keys(after)}`)
    h.assert(await win.$eval('button[aria-label="Undo"]', (b) => b.disabled), 'nothing to undo')
  })
}

main()
