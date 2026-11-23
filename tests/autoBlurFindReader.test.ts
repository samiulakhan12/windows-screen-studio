import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/*
 * The text reader as Find, Follow and Everywhere reach it in the app (docs/design/auto-blur.md §5.1,
 * §5.9, §5.11, and §16.6's seam between P2's reader and P4's scan): registerFindIpc gives the scan
 * readerStart, which opens the checked files through readerModels' startReader with the bundled
 * ffmpeg, starts the helper with no files for Follow without the reader, and keeps this PC's decode
 * speed for the next estimate.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
  dir: '',
  project: null as unknown,
  starts: [] as string[],
  decode: [] as number[],
  startReader: null as null | ((ffmpeg: string) => Promise<unknown>)
}))
h.dir = mkdtempSync(path.join(tmpdir(), 'flown-find-reader-'))
writeFileSync(path.join(h.dir, 'screen.mp4'), 'not a video')

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  app: { getPath: () => h.dir, isPackaged: false, getAppPath: () => h.dir, on: () => undefined },
  BrowserWindow: class {},
  screen: {},
  shell: {},
  dialog: {},
  clipboard: {},
  net: {}
}))
vi.mock('../src/main/security', () => ({ isAppUrl: (url: string) => url === 'file:///flown/index.html' }))
vi.mock('../src/main/recording/toolbarWindow', () => ({ isToolbarVisible: () => false }))
vi.mock('../src/main/projects', () => ({
  readProject: async (id: string) => ({ ...(h.project as object), id }),
  projectDir: () => h.dir,
  readCursor: async () => ({ samples: [], clicks: [], valid: false }),
  listProjects: async () => [],
  projectsRoot: () => h.dir
}))
vi.mock('../src/main/privacy/readerModels', () => ({
  startReader: (ffmpeg: string) => {
    h.starts.push(ffmpeg)
    return h.startReader ? h.startReader(ffmpeg) : Promise.reject(new Error('no reader in this test'))
  },
  recordDecodeSpeed: (ms: number) => void h.decode.push(ms)
}))

const { PRIVACY_CHANNELS } = await import('../src/shared/api/privacy')
const { readerStart, registerFindIpc, setFindDeps } = await import('../src/main/privacy/findIpc')
const { forgetReads, ScanUnavailable } = await import('../src/main/privacy/scan')
const { HelperError, OcrHelper } = await import('../src/main/privacy/readerHelper')
const { ffmpegPath } = await import('../src/main/ffmpeg')
const { answer } = await import('../src/main/privacy/rulesWorker')
import type { FindRequest, FindResult, FollowResult } from '../src/shared/api/privacy'
import type { ScanHelper, ScanRules } from '../src/main/privacy/scan'
import type { Box } from '../src/shared/privacy/protocol'
import { base, rng } from './autoBlurFixtures'
import { FakeHelper, HD, lookOf, type Planted } from './autoBlurScanFixtures'

afterAll(() => {
  forgetReads()
  setFindDeps({})
  rmSync(h.dir, { recursive: true, force: true })
})

const EMAIL: Box = [600, 400, 460, 30]
const planted: Planted[] = [{ key: 'email', text: 'priya.raman@example.com', at: (t) => (t >= 2 && t < 12 ? EMAIL : null) }]
const at = (t: number, x: number): boolean => Math.abs(t - x) < 1e-6
const look = lookOf(HD, 30, 20, (_i, t) => ({ changed: at(t, 2) || at(t, 12) ? [[576, 384, 512, 64] as Box] : [] }))
const app = { senderFrame: { url: 'file:///flown/index.html' } }
const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(h.handlers.get(channel)!(app, ...args)) as Promise<T>
const find = (requestId: string): FindRequest => ({ projectId: 'rec-1', requestId, kinds: ['email'], regions: ['US'], names: [], neverHide: [] })

/** The rules on main's own thread (no worker to start). */
const inProcess: ScanRules = {
  detect: async (lines, qr, options) => {
    const a = answer({ id: 0, lines: [...lines], qr, options })
    return 'hits' in a ? a.hits : 'timeout'
  },
  detectCareful: async (lines, qr, options) => {
    const a = answer({ id: 0, lines: [...lines], qr, options, careful: true })
    return 'hits' in a ? a : 'timeout'
  },
  close: () => undefined
}

/** A helper as the scan sees it, opened as `open` says. */
function bareHelper(open: () => Promise<void>) {
  const calls: string[] = []
  const helper = {
    open: async (pins: unknown[], ffmpeg: string) => {
      calls.push(`open ${pins.length} ${ffmpeg}`)
      await open()
    },
    kill: () => void calls.push('kill')
  } as unknown as ScanHelper
  return { helper, calls }
}

function scene(): void {
  h.project = base('rec-1', 20, { fps: 30 })
  rmSync(path.join(h.dir, '.cache'), { recursive: true, force: true })
  h.starts = []
  h.decode = []
  let clock = 5_000_000
  setFindDeps({ now: () => (clock += 3), random: rng(17), log: () => undefined, rules: () => inProcess })
}

registerFindIpc()

describe('auto-blur: the text reader behind Find in the app', () => {
  it('Find, from its channel, opens the checked reader through startReader with the bundled ffmpeg, and keeps this PC’s decode speed', async () => {
    scene()
    h.startReader = async () => new FakeHelper({ look, planted })
    const r = await call<FindResult>(PRIVACY_CHANNELS.find, find('r1'))
    expect(r.ok).toBe(true)
    expect(r.ok && r.found.some((f) => f.kind === 'email')).toBe(true)
    expect(h.starts).toEqual([ffmpegPath()])
    expect(h.decode).toHaveLength(1)
    expect(h.decode[0]).toBeGreaterThan(0)
  })

  it('Find ends as reader when the files are missing or refused, and as helper when the helper cannot run', async () => {
    scene()
    h.startReader = async () => {
      throw new HelperError('model')
    }
    expect(await call<FindResult>(PRIVACY_CHANNELS.find, find('r2'))).toMatchObject({ ok: false, reason: 'reader' })
    h.startReader = async () => {
      throw new HelperError('missing')
    }
    expect(await call<FindResult>(PRIVACY_CHANNELS.find, find('r3'))).toMatchObject({ ok: false, reason: 'helper' })
  })

  it('Follow without the reader follows by template alone on a helper opened with no files, and its result is thin', async () => {
    scene()
    h.startReader = async () => {
      throw new HelperError('model')
    }
    const log: string[] = []
    const fake = new FakeHelper({ look, planted }, log)
    const opens: string[] = []
    fake.open = async (...args: unknown[]) => {
      opens.push(JSON.stringify(args))
      log.push('open')
      // The real helper holds no reader after an open with no files, and says so.
      throw new HelperError('model')
    }
    const spy = vi.spyOn(OcrHelper, 'start').mockImplementation(async () => fake as unknown as Awaited<ReturnType<typeof OcrHelper.start>>)
    try {
      const box = { x: EMAIL[0] / 1920, y: EMAIL[1] / 1080, w: EMAIL[2] / 1920, h: EMAIL[3] / 1080 }
      const r = await call<FollowResult>(PRIVACY_CHANNELS.follow, { projectId: 'rec-1', requestId: 'f1', t: 8, box, start: 7, end: 9, path: `7 ${box.x} ${box.y} ${box.w} ${box.h}` })
      expect(r.ok).toBe(true)
      expect(r.ok && r.thin).toBe(true)
      expect(h.starts).toEqual([ffmpegPath()])
      expect(opens).toEqual([JSON.stringify([[], ffmpegPath()])])
      expect(log.some((l) => l.startsWith('read'))).toBe(false)
      expect(log.some((l) => l.startsWith('followOpen'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('readerStart: with models, startReader’s refusal is reader and anything else helper; the helper started with nothing open is ffmpeg’s alone', async () => {
    const opened = { helper: {} as ScanHelper }
    const ok = readerStart({ startReader: async (f) => (f === 'ffmpeg-bundled' ? opened.helper : Promise.reject(new Error('wrong ffmpeg'))), ffmpeg: () => 'ffmpeg-bundled' })
    expect(await ok(true)).toBe(opened.helper)
    for (const [err, reason] of [
      [new HelperError('model'), 'reader'],
      [new HelperError('missing'), 'helper'],
      [new HelperError('protocol'), 'helper'],
      [new HelperError('crashed'), 'helper'],
      [new Error('spawn'), 'helper']
    ] as const) {
      const start = readerStart({ startReader: () => Promise.reject(err), ffmpeg: () => 'f' })
      const got = await start(true).then(
        () => null,
        (e: unknown) => e
      )
      expect(got).toBeInstanceOf(ScanUnavailable)
      expect((got as InstanceType<typeof ScanUnavailable>).reason).toBe(reason)
    }
    // Without models: opened with no files; the helper's answer that it holds no reader is expected.
    const refused = bareHelper(() => Promise.reject(new HelperError('model')))
    expect(await readerStart({ startHelper: async () => refused.helper, ffmpeg: () => 'ffmpeg-bundled' })(false)).toBe(refused.helper)
    expect(refused.calls).toEqual(['open 0 ffmpeg-bundled'])
    const accepted = bareHelper(() => Promise.resolve())
    expect(await readerStart({ startHelper: async () => accepted.helper, ffmpeg: () => 'f' })(false)).toBe(accepted.helper)
    // Any other answer ends that helper; no helper at all is helper.
    const dead = bareHelper(() => Promise.reject(new HelperError('crashed')))
    await expect(readerStart({ startHelper: async () => dead.helper, ffmpeg: () => 'f' })(false)).rejects.toMatchObject({ reason: 'helper' })
    expect(dead.calls).toEqual(['open 0 f', 'kill'])
    await expect(readerStart({ startHelper: () => Promise.reject(new HelperError('missing')), ffmpeg: () => 'f' })(false)).rejects.toMatchObject({ reason: 'helper' })
  })
})
