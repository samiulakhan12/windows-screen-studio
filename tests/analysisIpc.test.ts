import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-analysis-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, () => void>(),
  /** Every process spawned, and a callback for the next one (called as soon as it starts). */
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

import { detectStill, freezeDetectArgs, parseFreezeLog, registerAnalysisIpc } from '../src/main/analysisIpc'

const projectsRoot = path.join(h.root, 'videos', 'Screen Studio for Windows')

/** A 16 s test pattern that freezes from 3 s to 9 s and from 11 s to the end. */
function seed(id: string, opts: { project?: unknown } = {}): string {
  const dir = path.join(projectsRoot, id)
  mkdirSync(dir, { recursive: true })
  execFileSync(ffmpegPath(), [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-t', '16',
    '-filter_complex', '[0:v]split[a][b];[a][b]freezeframes=first=90:last=270:replace=90[c];[c]split[d][e];[d][e]freezeframes=first=330:last=479:replace=330',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
    path.join(dir, 'screen.mp4')
  ])
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(opts.project ?? { duration: 16 }))
  return dir
}

beforeAll(() => {
  seed('rec-still')
  registerAnalysisIpc()
})

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('parseFreezeLog', () => {
  it('reads freeze start and end lines, relative to the start of the video', () => {
    const log = [
      '  Duration: 00:01:02.50, start: 0.500000, bitrate: 932 kb/s',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 3.5',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 6',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 9.5',
      'some other line: freeze_end: 4',
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 60.5'
    ].join('\n')
    // The freeze still running at the end lasts to the end of the video.
    expect(parseFreezeLog(log)).toEqual([
      { start: 3, end: 9 },
      { start: 60, end: 62.5 }
    ])
  })

  it('copes with logs without a duration, unmatched lines and garbage', () => {
    expect(parseFreezeLog('lavfi.freezedetect.freeze_end: 4\nlavfi.freezedetect.freeze_start: 5\nlavfi.freezedetect.freeze_end: 7')).toEqual([{ start: 5, end: 7 }])
    expect(parseFreezeLog('lavfi.freezedetect.freeze_start: 5')).toEqual([])
    expect(parseFreezeLog('lavfi.freezedetect.freeze_start: 5', 12)).toEqual([{ start: 5, end: 12 }])
    expect(parseFreezeLog('lavfi.freezedetect.freeze_start: 1e1\nlavfi.freezedetect.freeze_end: 1.2e1')).toEqual([{ start: 10, end: 12 }])
    expect(parseFreezeLog('')).toEqual([])
    expect(parseFreezeLog('Duration: N/A, start: 0.0\nlavfi.freezedetect.freeze_start: 2', 8)).toEqual([{ start: 2, end: 8 }])
  })

  it('builds arguments for the first video stream only, at a low frame rate', () => {
    const args = freezeDetectArgs('C:\\rec\\screen.mp4', 2)
    expect(args).toContain('C:\\rec\\screen.mp4')
    expect(args.join(' ')).toContain('-map 0:v:0')
    expect(args.join(' ')).toMatch(/fps=10,scale=320:-2:flags=area,freezedetect=n=-50dB:d=2/)
    expect(args.slice(-3)).toEqual(['-f', 'null', '-'])
  })
})

describe('detectStill', () => {
  it('finds the frozen stretches of screen.mp4 with ffmpeg', async () => {
    const ranges = await detectStill('rec-still', 1)
    expect(ranges).toHaveLength(2)
    expect(ranges[0].start).toBeCloseTo(3, 0)
    expect(ranges[0].end).toBeCloseTo(9, 0)
    expect(ranges[1].start).toBeCloseTo(11, 0)
    expect(ranges[1].end).toBeCloseTo(16, 0)
  })

  it('applies the minimum length to the same analysis', async () => {
    expect(await detectStill('rec-still', 5.5)).toHaveLength(1)
    expect(await detectStill('rec-still', 100)).toEqual([])
    // Out of range or missing minimums fall back to the shortest.
    expect(await detectStill('rec-still', Number.NaN)).toHaveLength(2)
    expect(await detectStill('rec-still', -3)).toHaveLength(2)
  })

  it('is reachable over IPC, and analyses each file version once', async () => {
    const handler = h.handlers.get('projects:detectStill')!
    const runs = h.spawned.length
    expect(await handler({}, 'rec-still', 1)).toHaveLength(2)
    expect(await handler({}, 'rec-still', 3)).toHaveLength(2)
    expect(h.spawned.length).toBe(runs)
  })

  it('kills a running analysis when the app quits, and does not keep the failure', async () => {
    seed('rec-quit')
    const started = new Promise<ChildProcess>((resolve) => {
      h.onSpawn = (proc) => {
        h.onSpawn = null
        resolve(proc)
      }
    })
    const pending = detectStill('rec-quit', 1)
    const proc = await started
    expect(proc.exitCode).toBeNull()
    expect(h.appEvents.has('will-quit')).toBe(true)
    const t0 = Date.now()
    h.appEvents.get('will-quit')!()
    await expect(pending).rejects.toThrow('the analysis was stopped')
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(proc.signalCode).toBe('SIGKILL')
    // The next request analyses the file again, and this time finishes.
    const runs = h.spawned.length
    expect(await detectStill('rec-quit', 1)).toHaveLength(2)
    expect(h.spawned.length).toBe(runs + 1)
  })

  it('finds nothing for ids that are not project ids', async () => {
    const runs = h.spawned.length
    for (const id of ['../rec-still', 'a/b', '', 42, null, 'rec still', '..']) expect(await detectStill(id, 1), String(id)).toEqual([])
    expect(h.spawned.length).toBe(runs)
  })

  it('reports a missing video and files ffmpeg cannot read, and tries those again', async () => {
    await expect(detectStill('rec-missing', 1)).rejects.toThrow('the video file is missing')
    // A folder named screen.mp4 is not a video either.
    mkdirSync(path.join(projectsRoot, 'rec-dir', 'screen.mp4'), { recursive: true })
    await expect(detectStill('rec-dir', 1)).rejects.toThrow('the video file is missing')
    const dir = path.join(projectsRoot, 'rec-broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'screen.mp4'), 'not a video')
    const runs = h.spawned.length
    await expect(detectStill('rec-broken', 1)).rejects.toThrow(/^ffmpeg could not read the video \(exit code \d+\)$/)
    await expect(detectStill('rec-broken', 1)).rejects.toThrow(/could not read/)
    expect(h.spawned.length).toBe(runs + 2)
  })

  it('uses the length ffmpeg reports when project.json is unreadable', async () => {
    const dir = seed('rec-nojson')
    writeFileSync(path.join(dir, 'project.json'), '{ not json')
    const ranges = await detectStill('rec-nojson', 1)
    expect(ranges.at(-1)?.end).toBeCloseTo(16, 0)
  })
})
