import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { FILMSTRIP, filmstripPlan, filmstripTiles, sanitizeFilmstripMeta, tileSource } from '../src/shared/editor/filmstrip'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'flown-filmstrip-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, () => void>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(h.root, name),
    on: (event: string, fn: () => void) => h.appEvents.set(event, fn)
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) }
}))

import { countShowinfo, filmstripArgs, filmstripKey, getFilmstrip, registerFilmstripIpc, stopFilmstrip } from '../src/main/filmstrip'

const projectsRoot = path.join(h.root, 'videos', 'Flown')
const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href } }

/** A 12 s, 60 fps test pattern with a key frame every 15 frames, like a proxy. */
function seed(id: string, project: unknown = { duration: 12, width: 1920, height: 1080, capture: { fps: 60 } }): string {
  const dir = path.join(projectsRoot, id)
  mkdirSync(dir, { recursive: true })
  execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', path.join(dir, 'screen.mp4')])
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project))
  return dir
}

beforeAll(() => registerFilmstripIpc())
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('the sheet plan', () => {
  it('takes key frames for short recordings and at most 400 frames for long ones', () => {
    expect(filmstripPlan(60, 1920, 1080, 0.25)).toEqual({ interval: 0.25, cols: 20, rows: 13, tileW: 128, tileH: 72 })
    const hour = filmstripPlan(3600, 1920, 1080, 0.25)
    expect(hour.interval).toBe(9)
    expect(Math.ceil(3600 / hour.interval)).toBe(FILMSTRIP.maxFrames)
    expect(filmstripPlan(10, 1920, 1080, 0.5).interval).toBe(0.5)
  })
  it('sizes tiles by the aspect, within limits', () => {
    expect(filmstripPlan(10, 1080, 1920, 0.25).tileW).toBe(40)
    expect(filmstripPlan(10, 100, 10_000, 0.25).tileW).toBe(24)
    expect(filmstripPlan(10, 10_000, 100, 0.25).tileW).toBe(256)
    expect(filmstripPlan(Number.NaN, 0, 0, Number.NaN)).toMatchObject({ interval: 0.25, tileW: 128 })
  })
  it('builds ffmpeg arguments that decode key frames only', () => {
    const args = filmstripArgs('in.mp4', filmstripPlan(60, 1920, 1080, 0.25), 'out.jpg')
    expect(args.slice(args.indexOf('-skip_frame'), args.indexOf('-skip_frame') + 2)).toEqual(['-skip_frame', 'nokey'])
    expect(args[args.indexOf('-vf') + 1]).toBe('fps=fps=4,scale=128:72:flags=area,showinfo,tile=20x13')
    expect(args.slice(-1)).toEqual(['out.jpg'])
  })
  it('counts showinfo frames', () => {
    const log = '[Parsed_showinfo_2 @ 0x1] config in time_base: 1/4\n[Parsed_showinfo_2 @ 0x1] n:   0 pts: 0 mean:[1]\n[Parsed_showinfo_2 @ 0x1] n:   1 pts: 1\nframe=1\n'
    expect(countShowinfo(log)).toBe(2)
  })
  it('keys the cache on the proxy and the numbers', () => {
    const plan = filmstripPlan(60, 1920, 1080, 0.25)
    expect(filmstripKey(10, 5.4, plan)).not.toBe(filmstripKey(11, 5.4, plan))
    expect(filmstripKey(10, 5.4, plan)).not.toBe(filmstripKey(10, 5.4, filmstripPlan(60, 1080, 1920, 0.25)))
  })
})

describe('tiles on the track', () => {
  const meta = { interval: 0.25, count: 49 }
  it('lie on a grid from the track’s start and show the frame nearest their middle', () => {
    // 100 px per second, 71 px tiles: the middle of tile 0 is at 0.355 s → frame 1.
    const tiles = filmstripTiles(meta, { start: 0, end: 2 }, 100, 71, 12)
    expect(tiles.map((t) => t.x)).toEqual([0, 71, 142])
    expect(tiles.map((t) => t.frame)).toEqual([1, 4, 7])
    // Scrolled: the first tile is the one the window starts in, at the same place.
    expect(filmstripTiles(meta, { start: 1, end: 2 }, 100, 71, 12)[0]).toEqual({ x: 71, frame: 4 })
  })
  it('repeat a frame zoomed far in and stay within the sheet and the recording', () => {
    const tiles = filmstripTiles(meta, { start: 11.5, end: 12 }, 2000, 71, 12)
    expect(tiles.every((t) => t.frame === 46 || t.frame === 47 || t.frame === 48)).toBe(true)
    expect(Math.max(...tiles.map((t) => t.x))).toBeLessThan(12 * 2000)
    expect(filmstripTiles({ interval: 0.25, count: 10 }, { start: 0, end: 12 }, 10, 71, 12).at(-1)!.frame).toBe(9)
  })
  it('are none without a sheet or a scale', () => {
    expect(filmstripTiles({ interval: 0.25, count: 0 }, { start: 0, end: 2 }, 100, 71, 12)).toEqual([])
    expect(filmstripTiles(meta, { start: 0, end: 2 }, 0, 71, 12)).toEqual([])
  })
  it('draw the crop of a tile', () => {
    const m = { cols: 20, tileW: 128, tileH: 72 }
    expect(tileSource(m, 21, null)).toEqual({ sx: 128, sy: 72, sw: 128, sh: 72 })
    expect(tileSource(m, 0, { x: 0.5, y: 0, w: 0.5, h: 0.5 })).toEqual({ sx: 64, sy: 0, sw: 64, sh: 36 })
  })
  it('read a meta back only when it is one', () => {
    const good = { v: 1, key: 'k', interval: 0.25, count: 40, cols: 20, tileW: 128, tileH: 72 }
    expect(sanitizeFilmstripMeta(good)).toEqual(good)
    expect(sanitizeFilmstripMeta({ ...good, count: 0 })).toBeNull()
    expect(sanitizeFilmstripMeta({ ...good, tileW: 9999 })).toBeNull()
    expect(sanitizeFilmstripMeta({ ...good, interval: -1 })).toBeNull()
    expect(sanitizeFilmstripMeta('x')).toBeNull()
  })
})

describe('making the sheet', () => {
  it('runs ffmpeg once, keeps the sheet in .cache and reuses it', async () => {
    const dir = seed('rec-film-1')
    const first = await getFilmstrip('rec-film-1')
    expect(first).not.toBeNull()
    expect(first!.meta).toMatchObject({ v: 1, interval: 0.25, cols: 20, tileW: 128, tileH: 72 })
    // 12 s at 4 frames a second.
    expect(first!.meta.count).toBeGreaterThanOrEqual(47)
    expect(first!.meta.count).toBeLessThanOrEqual(49)
    expect([...first!.jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    const jpg = path.join(dir, '.cache', 'filmstrip.jpg')
    const made = statSync(jpg).mtimeMs
    const again = await getFilmstrip('rec-film-1')
    expect(again!.meta).toEqual(first!.meta)
    expect(statSync(jpg).mtimeMs).toBe(made)
    expect(JSON.parse(readFileSync(path.join(dir, '.cache', 'filmstrip.json'), 'utf8')).key).toBe(first!.meta.key)
  })

  it('makes it again for another proxy', async () => {
    const dir = seed('rec-film-2')
    const first = await getFilmstrip('rec-film-2')
    writeFileSync(path.join(dir, '.cache', 'filmstrip.json'), JSON.stringify({ ...first!.meta, key: 'old' }))
    const again = await getFilmstrip('rec-film-2')
    expect(again!.meta.key).toBe(first!.meta.key)
  })

  it('shares one run between requests at once', async () => {
    seed('rec-film-3')
    const [a, b] = await Promise.all([getFilmstrip('rec-film-3'), getFilmstrip('rec-film-3')])
    expect(a).toBe(b)
  })

  it('gives nothing without a proxy or a project, and refuses bad ids', async () => {
    mkdirSync(path.join(projectsRoot, 'rec-film-empty'), { recursive: true })
    expect(await getFilmstrip('rec-film-empty')).toBeNull()
    expect(await getFilmstrip(42)).toBeNull()
    await expect(getFilmstrip('../x')).rejects.toThrow('Invalid project id')
  })

  it('never writes through a linked cache folder', async () => {
    const dir = seed('rec-film-link')
    const elsewhere = path.join(h.root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, path.join(dir, '.cache'), 'dir')
    expect(await getFilmstrip('rec-film-link')).toBeNull()
    expect(require('node:fs').readdirSync(elsewhere)).toEqual([])
  })

  it('is stopped with the project’s other analyses', async () => {
    seed('rec-film-stop')
    const run = getFilmstrip('rec-film-stop')
    await stopFilmstrip('rec-film-stop')
    // Stopped before or while ffmpeg ran: nothing, or a sheet made before the stop.
    const r = await run
    expect(r === null || r.meta.count > 0).toBe(true)
  })

  it('answers only the app’s page', async () => {
    const handler = h.handlers.get('filmstrip:get')!
    await expect(Promise.resolve().then(() => handler({ senderFrame: { url: 'https://example.com/' } }, 'rec-film-1'))).rejects.toThrow('Not allowed')
    const r = (await handler(appEvent, 'rec-film-1')) as { meta: { count: number } } | null
    expect(r?.meta.count).toBeGreaterThan(0)
    expect(h.appEvents.has('will-quit')).toBe(true)
  })
})
