/**
 * Reading the screen (docs/design/smart-tools.md §7.2, §22.1 tests 31, 32, 34 and 115): the scan's
 * arguments, its log, its cache in memory and in .cache/scenes.json, stopping it, and a 25 fps
 * import read with fps=4.
 *
 * The recordings are made here with ffmpeg as the research recording was: still "pages" and a
 * dialog, a menu and another page drawn over them, lossless, with a key frame every 15 frames like
 * a proxy. tests/fixtures/scenes/pages-30fps-ffmpeg.txt is ffmpeg's log of one scan of the 30 fps one
 * (events at 5, 8, 11 and 14 s changing 62%, 17%, 7% and 73% of the picture).
 */
import { execFileSync, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-scenes-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, () => void>(),
  spawned: [] as ChildProcess[],
  onSpawn: null as ((proc: ChildProcess) => void) | null
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = (...args: Parameters<typeof actual.spawn>): ChildProcess => {
    const proc = actual.spawn(...args)
    h.spawned.push(proc)
    h.onSpawn?.(proc)
    return proc
  }
  return { ...actual, spawn, default: { ...actual, spawn } }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(h.root, name),
    on: (event: string, fn: () => void) => h.appEvents.set(event, fn)
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) }
}))

import { freezeDetectArgs, stopAnalyses } from '../src/main/analysisIpc'
import { cropFilter } from '../src/main/proxyArgs'
import { detectScenes, parseSceneLog, readSceneScan, registerSceneIpc, sceneCacheKey, sceneScanArgs, sceneStep } from '../src/main/sceneScan'
import { SMART_PROJECT_CHANNELS } from '../src/shared/api/projects'
import { SCREEN_RULES, screenChanges } from '../src/shared/smart/screenChanges'

const projectsRoot = path.join(h.root, 'videos', 'Flown')
const appEvent = (sent: unknown[] = []) => ({
  senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href },
  sender: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
})

/**
 * A recording of still pages at `fps` (`seconds` long): page A, at 5 s a page covering 62% of the
 * picture, at 8 s a dialog of 17%, at 11 s a menu of 7%, at 14 s a page of 73%. Lossless, a key
 * frame every 15 frames.
 */
function seed(id: string, opts: { fps?: number; seconds?: number; project?: unknown } = {}): string {
  const fps = opts.fps ?? 30
  const seconds = opts.seconds ?? 20
  const dir = path.join(projectsRoot, id)
  mkdirSync(dir, { recursive: true })
  const box = (x: number, y: number, w: number, h: number, c: string, t: number): string => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:c=${c}:t=fill:enable='gte(t,${t})'`
  execFileSync(ffmpegPath(), [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x404040:s=640x400:r=${fps}:d=${seconds}`,
    '-vf', [box(0, 0, 640, 248, '0x808080', 5), box(100, 40, 272, 160, '0xa0a0a0', 8), box(400, 260, 112, 160, '0xc0c0c0', 11), box(0, 0, 640, 292, '0xe0e0e0', 14), 'format=yuv420p'].join(','),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-g', '15',
    path.join(dir, 'screen.mp4')
  ])
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(opts.project ?? { duration: seconds, capture: { fps } }))
  return dir
}

/** The changed share at each event and the samples between them. */
function at(scan: { t: number[]; changed: number[] }, t: number): number | undefined {
  const i = scan.t.findIndex((x) => Math.abs(x - t) < 1e-6)
  return i < 0 ? undefined : scan.changed[i]
}

beforeAll(() => {
  seed('rec-pages')
  registerSceneIpc()
})

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('parseSceneLog (test 31)', () => {
  const log = readFileSync(path.join(__dirname, 'fixtures/scenes/pages-30fps-ffmpeg.txt'), 'utf8')

  it("reads blackframe's changed share and freezedetect's stills from a saved log", () => {
    const scan = parseSceneLog(log, 20, 0.25)
    expect(scan.step).toBe(0.25)
    // A sample every 0.25 s from the second frame on.
    expect(scan.t[0]).toBe(0.25)
    expect(scan.t).toHaveLength(79)
    expect(scan.t.every((t, i) => i === 0 || Math.abs(t - scan.t[i - 1] - 0.25) < 1e-9)).toBe(true)
    expect([5, 8, 11, 14].map((t) => at(scan, t))).toEqual([62, 17, 7, 73])
    // Nothing changes between the events.
    expect(scan.changed.filter((c) => c !== 0)).toEqual([62, 17, 7, 73])
    expect(scan.stills).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 8 },
      { start: 8, end: 11 },
      { start: 11, end: 14 },
      // Still at the end: it lasts to the length ffmpeg printed.
      { start: 14, end: 20 }
    ])
    // What screenChanges then finds: the two pages and the dialog, never the menu.
    expect(screenChanges(scan)).toEqual([
      { t: 5, share: 62, page: true },
      { t: 8, share: 17, page: false },
      { t: 14, share: 73, page: true }
    ])
  })

  it('takes the start offset off, sorts the samples, keeps one per time and skips what it does not know', () => {
    const scan = parseSceneLog(
      [
        '  Duration: 00:00:10.00, start: 0.500000, bitrate: 1 kb/s',
        '[Parsed_blackframe_6 @ 0x1] frame:3 pblack:90 pts:4 t:1.500000 type:P last_keyframe:0',
        '[Parsed_blackframe_6 @ 0x1] frame:1 pblack:100 pts:2 t:1.000000 type:P last_keyframe:0',
        '[Parsed_blackframe_6 @ 0x1] frame:3 pblack:40 pts:4 t:1.500000 type:P last_keyframe:0',
        '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 2.5',
        '[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 4.5',
        'some other line pblack:5 t:3',
        '[Parsed_blackframe_6 @ 0x1] frame:9 pblack:abc t:x',
        '[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 6',
        '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 8.5'
      ].join('\n'),
      99,
      0.25
    )
    expect(scan.t).toEqual([0.5, 1])
    expect(scan.changed).toEqual([0, 60])
    // An end without a start is skipped; the open one lasts to the printed length (not `duration`).
    expect(scan.stills).toEqual([
      { start: 2, end: 4 },
      { start: 8, end: 10 }
    ])
    // Without a header, `duration` ends it.
    expect(parseSceneLog('[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 3', 7, 0.5)).toEqual({ step: 0.5, t: [], changed: [], stills: [{ start: 3, end: 7 }] })
    expect(parseSceneLog('', NaN, 0.25)).toEqual({ step: 0.25, t: [], changed: [], stills: [] })
  })
})

describe('sceneScanArgs (test 32)', () => {
  it('writes the crop as still detection does, before the scale', () => {
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }
    const args = sceneScanArgs('screen.mp4', 30, crop)
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain(`fps=4,${cropFilter(crop)},scale=320:-2:flags=area,split=2[a][b]`)
    // Still detection writes the same crop.
    expect(freezeDetectArgs('screen.mp4', 0.5, false, crop).join(' ')).toContain(`${cropFilter(crop)},scale=320:-2:flags=area`)
    expect(graph).toContain('[a]freezedetect=n=-50dB:d=0.5[fa]')
    expect(graph).toContain('[b]format=gray,tblend=all_mode=difference,blackframe=amount=0:threshold=8[fb]')
    expect(args.join(' ')).toContain('-map [fa] -f null - -map [fb] -f null -')
    expect(sceneScanArgs('screen.mp4', 30, null).join(' ')).not.toContain('crop=')
  })

  it('reads only the key frames at 60 fps and above; at 30, 25 and 24 fps (or an unknown rate) every frame with fps=4', () => {
    for (const fps of [60, 120]) {
      const args = sceneScanArgs('screen.mp4', fps, null)
      expect(args.slice(args.indexOf('-skip_frame'), args.indexOf('-skip_frame') + 3)).toEqual(['-skip_frame', 'nokey', '-i'])
      expect(args.join(' ')).not.toContain('fps=4')
      expect(sceneStep(fps)).toBeCloseTo(15 / fps, 9)
    }
    for (const fps of [30, 25, 24, 59.94, undefined]) {
      const args = sceneScanArgs('screen.mp4', fps, null)
      expect(args, String(fps)).not.toContain('-skip_frame')
      expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v:0\]fps=4,scale=/)
      expect(sceneStep(fps)).toBe(0.25)
    }
  })
})

describe('the scan and its cache (test 34)', () => {
  it('reads the recording once: kept in memory and in .cache/scenes.json, with progress over IPC', async () => {
    const sent: unknown[] = []
    const runs = h.spawned.length
    const scan = (await h.handlers.get(SMART_PROJECT_CHANNELS.detectScenes)!(appEvent(sent), 'rec-pages', null)) as Awaited<ReturnType<typeof detectScenes>>
    expect(h.spawned.length).toBe(runs + 1)
    expect([5, 8, 11, 14].map((t) => at(scan, t))).toEqual([62, 17, 7, 73])
    expect(scan.stills.slice(0, 4)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 8 },
      { start: 8, end: 11 },
      { start: 11, end: 14 }
    ])
    // Progress went to the page that asked, as shares of the recording.
    expect(sent.length).toBeGreaterThan(0)
    for (const [channel, p] of sent as [string, { id: string; fraction: number }][]) {
      expect(channel).toBe(SMART_PROJECT_CHANNELS.sceneProgress)
      expect(p.id).toBe('rec-pages')
      expect(p.fraction).toBeGreaterThanOrEqual(0)
      expect(p.fraction).toBeLessThanOrEqual(1)
    }
    const file = path.join(projectsRoot, 'rec-pages', '.cache', 'scenes.json')
    const kept = JSON.parse(readFileSync(file, 'utf8'))
    expect(kept.v).toBe(1)
    expect(readSceneScan(kept.scans[0].scan)).toEqual(scan)
    // The second run is instant.
    expect(await detectScenes('rec-pages', null)).toEqual(scan)
    expect(h.spawned.length).toBe(runs + 1)
  })

  it('a copy of the project (its files keeping their times) reads the kept scan at once', async () => {
    cpSync(path.join(projectsRoot, 'rec-pages'), path.join(projectsRoot, 'rec-pages-copy'), { recursive: true, preserveTimestamps: true })
    const runs = h.spawned.length
    expect(at(await detectScenes('rec-pages-copy', null), 8)).toBe(17)
    expect(h.spawned.length).toBe(runs)
  })

  it('the key changes with the size, the time and the crop', async () => {
    const crop = { x: 0, y: 0, w: 0.5, h: 1 }
    const base = sceneCacheKey(1000, 1700000000000.4, null, 30)
    expect(sceneCacheKey(1000, 1700000000000, null, 30)).toBe(base)
    expect(sceneCacheKey(1001, 1700000000000, null, 30)).not.toBe(base)
    expect(sceneCacheKey(1000, 1700000001000, null, 30)).not.toBe(base)
    expect(sceneCacheKey(1000, 1700000000000, crop, 30)).not.toBe(base)
    expect(sceneCacheKey(1000, 1700000000000, { ...crop, w: 0.6 }, 30)).not.toBe(sceneCacheKey(1000, 1700000000000, crop, 30))
    // The way it is sampled too.
    expect(sceneCacheKey(1000, 1700000000000, null, 60)).not.toBe(base)

    // A crop is read apart; asked again, it is kept.
    let runs = h.spawned.length
    const left = await detectScenes('rec-pages', crop)
    expect(h.spawned.length).toBe(runs + 1)
    expect(h.spawned[runs].spawnargs.join(' ')).toContain(`${cropFilter(crop)},scale=`)
    // Inside the left half, the menu on the right changes nothing.
    expect(at(left, 11)).toBe(0)
    await detectScenes('rec-pages', { ...crop })
    expect(h.spawned.length).toBe(runs + 1)
    // Both are in the file.
    expect(JSON.parse(readFileSync(path.join(projectsRoot, 'rec-pages', '.cache', 'scenes.json'), 'utf8')).scans).toHaveLength(2)

    // A newer file (another time) is read again.
    const video = path.join(projectsRoot, 'rec-pages', 'screen.mp4')
    const st = statSync(video)
    utimesSync(video, st.atime, new Date(st.mtimeMs + 5000))
    runs = h.spawned.length
    await detectScenes('rec-pages', null)
    expect(h.spawned.length).toBe(runs + 1)
  })

  it('a damaged or linked cache file is never trusted', async () => {
    const dir = seed('rec-damaged', { seconds: 6 })
    await detectScenes('rec-damaged', null)
    const file = path.join(dir, '.cache', 'scenes.json')
    const good = JSON.parse(readFileSync(file, 'utf8'))
    const bad = [{ ...good.scans[0].scan, changed: good.scans[0].scan.changed.map(() => 101) }, { ...good.scans[0].scan, t: [...good.scans[0].scan.t].reverse() }, { ...good.scans[0].scan, step: 0 }, { ...good.scans[0].scan, stills: [{ start: 3, end: 2 }] }]
    for (const scan of bad) expect(readSceneScan(scan)).toBeNull()
    expect(readSceneScan(good.scans[0].scan)).toEqual(good.scans[0].scan)
    // Copied to another project with a bad entry: read again there.
    cpSync(dir, path.join(projectsRoot, 'rec-damaged-2'), { recursive: true, preserveTimestamps: true })
    writeFileSync(path.join(projectsRoot, 'rec-damaged-2', '.cache', 'scenes.json'), JSON.stringify({ v: 1, scans: [{ key: good.scans[0].key, scan: bad[0] }] }))
    let runs = h.spawned.length
    await detectScenes('rec-damaged-2', null)
    expect(h.spawned.length).toBe(runs + 1)
    // A cache folder that is a link to another project's is not read.
    const linked = path.join(projectsRoot, 'rec-damaged-3')
    cpSync(dir, linked, { recursive: true, preserveTimestamps: true })
    rmSync(path.join(linked, '.cache'), { recursive: true })
    symlinkSync(path.join(dir, '.cache'), path.join(linked, '.cache'))
    runs = h.spawned.length
    await detectScenes('rec-damaged-3', null)
    expect(h.spawned.length).toBe(runs + 1)
  })

  it('stopAnalyses stops a scan and waits for ffmpeg; the stopped scan is not kept', async () => {
    seed('rec-stop', { seconds: 30 })
    const started = new Promise<ChildProcess>((resolve) => {
      h.onSpawn = (proc) => {
        h.onSpawn = null
        resolve(proc)
      }
    })
    const pending = detectScenes('rec-stop', null)
    const proc = await started
    expect(proc.exitCode).toBeNull()
    await stopAnalyses('rec-stop')
    // ffmpeg has let go of the video when stopAnalyses resolves.
    expect(proc.signalCode).toBe('SIGKILL')
    await expect(pending).rejects.toThrow('reading the screen was stopped')
    expect(existsSync(path.join(projectsRoot, 'rec-stop', '.cache', 'scenes.json'))).toBe(false)
    // The next request reads it again, and finishes.
    const runs = h.spawned.length
    expect(at(await detectScenes('rec-stop', null), 8)).toBe(17)
    expect(h.spawned.length).toBe(runs + 1)
  })

  it('the app quitting stops a scan', async () => {
    seed('rec-quit', { seconds: 30 })
    const started = new Promise<ChildProcess>((resolve) => {
      h.onSpawn = (proc) => {
        h.onSpawn = null
        resolve(proc)
      }
    })
    const pending = detectScenes('rec-quit', null)
    await started
    h.appEvents.get('will-quit')!()
    await expect(pending).rejects.toThrow('reading the screen was stopped')
  })

  it('a failed scan is not kept: the next request tries again', async () => {
    const dir = path.join(projectsRoot, 'rec-broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'screen.mp4'), 'not a video')
    const runs = h.spawned.length
    await expect(detectScenes('rec-broken', null)).rejects.toThrow(/^ffmpeg could not read the video \(exit code \d+\)$/)
    await expect(detectScenes('rec-broken', null)).rejects.toThrow(/could not read/)
    expect(h.spawned.length).toBe(runs + 2)
    expect(existsSync(path.join(dir, '.cache', 'scenes.json'))).toBe(false)
  })

  it('names no project: refused without running anything; only the app page may ask', async () => {
    const runs = h.spawned.length
    for (const id of ['../rec-pages', 'a/b', '', 42, null, 'rec missing']) await expect(detectScenes(id, null), String(id)).rejects.toThrow('the video file is missing')
    for (const evil of [{ sender: {} }, { senderFrame: { url: 'https://example.com/' }, sender: {} }, { senderFrame: { url: pathToFileURL('/tmp/evil.html').href }, sender: {} }]) {
      expect(() => h.handlers.get(SMART_PROJECT_CHANNELS.detectScenes)!(evil, 'rec-pages', null)).toThrow('Not allowed')
    }
    expect(h.spawned.length).toBe(runs)
  })
})

describe('a 25 fps import (test 115)', () => {
  it('is decoded with fps=4, its settle window is 4 samples, and its dialog of 17% is found', async () => {
    seed('rec-25', { fps: 25, project: { duration: 20, capture: { fps: 25 } } })
    const runs = h.spawned.length
    const scan = await detectScenes('rec-25', null)
    const args = h.spawned[runs].spawnargs
    expect(args).not.toContain('-skip_frame')
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v:0\]fps=4,/)
    expect(scan.step).toBe(0.25)
    expect(Math.ceil(SCREEN_RULES.settleS / scan.step)).toBe(4)
    expect(screenChanges(scan)).toEqual([
      { t: 5, share: 62, page: true },
      { t: 8, share: 17, page: false },
      { t: 14, share: 73, page: true }
    ])
  })

  it('a 60 fps recording is read from its key frames, 0.25 s apart', async () => {
    seed('rec-60', { fps: 60 })
    const runs = h.spawned.length
    const scan = await detectScenes('rec-60', null)
    expect(h.spawned[runs].spawnargs.join(' ')).toContain('-skip_frame nokey -i')
    expect(scan.step).toBe(0.25)
    expect(screenChanges(scan).map((c) => [c.t, c.share])).toEqual([
      [5, 62],
      [8, 17],
      [14, 73]
    ])
  })
})
