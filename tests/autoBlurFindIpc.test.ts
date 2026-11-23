import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/*
 * Find's channels and lifetime in main (docs/design/auto-blur.md §5.1, §5.7, D22, D25; §17.1 tests 159,
 * 160 and 233): one Find in Flown, Follow and Everywhere ahead of its reads on the one helper,
 * stopAnalyses and the page going away stopping it, and no screen text leaving main.
 */

const h = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(), dir: '', project: null as unknown }))
h.dir = mkdtempSync(path.join(tmpdir(), 'flown-find-ipc-'))
writeFileSync(path.join(h.dir, 'screen.mp4'), 'not a video')

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  app: { getPath: () => h.dir, isPackaged: false, getAppPath: () => h.dir, on: () => undefined },
  BrowserWindow: class {},
  screen: {},
  shell: {},
  dialog: {},
  clipboard: {}
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

const { PRIVACY_CHANNELS } = await import('../src/shared/api/privacy')
const { registerFindIpc, setFindDeps, findRunning } = await import('../src/main/privacy/findIpc')
const { keptLines, runFind, forgetReads, underCover, coverEverywhere, followCover } = await import('../src/main/privacy/scan')
const { stopAnalyses } = await import('../src/main/analysisIpc')
const { foldText } = await import('../src/shared/privacy/detect/clean')
import type { FindRequest, FindResult } from '../src/shared/api/privacy'
import type { ScanDeps, ScanHelper } from '../src/main/privacy/scan'
import type { Box } from '../src/shared/privacy/protocol'
import { base, rng } from './autoBlurFixtures'
import { loadReads, loadTruth } from './autoBlurRulesFixtures'
import { FakeHelper, HD, lookOf, plantedLines, type FakeScript, type Planted } from './autoBlurScanFixtures'

afterAll(() => {
  forgetReads()
  setFindDeps({})
  rmSync(h.dir, { recursive: true, force: true })
})

const EMAIL: Box = [600, 400, 460, 30]
const NAME: Box = [300, 700, 220, 30]
const app = (sender?: unknown) => ({ senderFrame: { url: 'file:///flown/index.html' }, ...(sender ? { sender } : {}) })
const find = (projectId: string, requestId: string): FindRequest => ({ projectId, requestId, kinds: ['email', 'name'], regions: ['US'], names: ['Priya Raman'], neverHide: [] })
const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(h.handlers.get(channel)!(app(), ...args)) as Promise<T>

/** A Find scene on the mocked project: an email from 2 s to 12 s, a listed name from 5 s to 15 s; each helper start a new fake. */
function scene(over: Partial<FakeScript> = {}, wrap: (f: FakeHelper) => void = () => undefined) {
  h.project = base('rec-1', 20, { fps: 30 })
  rmSync(path.join(h.dir, '.cache'), { recursive: true, force: true })
  const planted: Planted[] = [
    { key: 'email', text: 'priya.raman@example.com', at: (t) => (t >= 2 && t < 12 ? EMAIL : null) },
    { key: 'name', text: 'Priya Raman', at: (t) => (t >= 5 && t < 15 ? NAME : null) }
  ]
  const at = (t: number, x: number): boolean => Math.abs(t - x) < 1e-6
  const look = lookOf(HD, 30, 20, (_i, t) => ({ changed: [...(at(t, 2) || at(t, 12) ? [[576, 384, 512, 64] as Box] : []), ...(at(t, 5) || at(t, 15) ? [[288, 672, 256, 64] as Box] : [])] }))
  const log: string[] = []
  let starts = 0
  let clock = 5_000_000
  const deps: ScanDeps = {
    helper: async () => {
      starts++
      const f = new FakeHelper({ look, planted, ...over }, log)
      wrap(f)
      return f as unknown as ScanHelper
    },
    now: () => clock,
    random: rng(233),
    log: () => undefined
  }
  setFindDeps(deps)
  return { log, deps, starts: () => starts, advance: (ms: number) => (clock += ms), now: () => clock }
}

/** A gate the fake's reads wait at until it opens. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { wait: () => opened, open }
}

const waitFor = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

registerFindIpc()

describe('auto-blur P4: Find in main', () => {
  it('159. stopAnalyses stops Find and forgets its reads', async () => {
    const g = gate()
    const s = scene({ gate: (t) => (t > 4 ? g.wait() : Promise.resolve()) })
    const running = call<FindResult>(PRIVACY_CHANNELS.find, find('rec-1', 's1'))
    await waitFor(() => s.log.some((l) => l.startsWith('read 5.3')))
    expect(findRunning()).toBe(true)
    const stopping = stopAnalyses('rec-1')
    g.open()
    await stopping
    const r = await running
    expect(r.ok && r.stopped).toBe(true)
    expect(findRunning()).toBe(false)
    expect(keptLines('rec-1', s.now())).toBe(0)
    // A Find that finished keeps its folded reads until the editor closes.
    scene()
    const done = await call<FindResult>(PRIVACY_CHANNELS.find, find('rec-1', 's2'))
    expect(done.ok && !done.stopped).toBe(true)
    expect(keptLines('rec-1', 5_000_000)).toBeGreaterThan(0)
    await stopAnalyses('rec-1')
    expect(keptLines('rec-1', 5_000_000)).toBe(0)
  })

  it('160. A second privacy:find, for the same project or another, while one runs answers busy; Follow and Everywhere go through the same helper’s queue ahead of Find’s reads', async () => {
    const g = gate()
    // Find's first three reads wait; Follow's read (of the email at 8 s) does not; Follow's session opening lets Find go on.
    const s = scene({ gate: (t) => (t < 8 ? g.wait() : Promise.resolve()) }, (f) => {
      const open = f.followOpen.bind(f)
      f.followOpen = async (req) => {
        g.open()
        await new Promise((r) => setTimeout(r, 50))
        return open(req)
      }
    })
    const first = call<FindResult>(PRIVACY_CHANNELS.find, find('rec-1', 'b1'))
    await waitFor(() => s.log.filter((l) => l.startsWith('read')).length === 3)
    expect(await call<FindResult>(PRIVACY_CHANNELS.find, find('rec-1', 'b2'))).toEqual({ ok: false, projectId: 'rec-1', requestId: 'b2', reason: 'busy' })
    expect(await call<FindResult>(PRIVACY_CHANNELS.find, find('rec-2', 'b3'))).toEqual({ ok: false, projectId: 'rec-2', requestId: 'b3', reason: 'busy' })
    const box = { x: EMAIL[0] / 1920, y: EMAIL[1] / 1080, w: EMAIL[2] / 1920, h: EMAIL[3] / 1080 }
    const follow = await call<{ ok: boolean }>(PRIVACY_CHANNELS.follow, { projectId: 'rec-1', requestId: 'b4', t: 8, box, start: 7, end: 9, path: `7 ${box.x} ${box.y} ${box.w} ${box.h}` })
    expect(follow.ok).toBe(true)
    const r = await first
    expect(r.ok).toBe(true)
    // One helper served both; the Follow's whole session came before Find's next read.
    expect(s.starts()).toBe(1)
    // From the Follow's read of the email at 8 s to its last session's close, Find sent no read.
    const followAt = s.log.findIndex((l) => l.startsWith('read 8 '))
    const closeAt = s.log.lastIndexOf('close', s.log.findIndex((l) => l.startsWith('read 12.3')))
    expect(followAt).toBeGreaterThan(-1)
    expect(closeAt).toBeGreaterThan(followAt)
    expect(s.log.slice(followAt, closeAt).filter((l) => l.startsWith('followOpen'))).toHaveLength(2)
    expect(s.log.slice(followAt, closeAt).some((l) => /^read (12|15)\.3/.test(l))).toBe(false)
    // Everywhere waits its turn too: one at a time with Find.
    expect(await call<{ ok: boolean; reason?: string }>(PRIVACY_CHANNELS.everywhere, { projectId: 'rec-1', requestId: 'none', remember: 'no' })).toMatchObject({ ok: false })
  })

  it('233. No text leaves main: a JSON scan of every FindResult, FollowResult, UnderCoverResult and EverywhereResult of the e2e fixtures finds none of the planted strings, except addedName for a name-like text with remember set; the kept folded texts are gone after 10 minutes (a fake clock), on Stop, on stopAnalyses, on render-process-gone and on a new Find', async () => {
    // The evaluation set's 24 frames, each shown for a while, read as the reader read them.
    const truth = loadTruth('truth')
    const reads = loadReads('main-careful-long')
    // 8 s a frame: a Find's budget (one unit per 8 s) reads every frame whole.
    const frameAt = (t: number) => reads[Math.min(reads.length - 1, Math.floor(t / 8))]
    const look = lookOf(HD, 30, 8 * reads.length, (i) => (i > 0 && i % 240 === 0 ? { changed: [[0, 0, 1920, 1080]] } : {}))
    h.project = base('rec-1', 8 * reads.length, { fps: 30 })
    rmSync(path.join(h.dir, '.cache'), { recursive: true, force: true })
    const log: string[] = []
    const deps: ScanDeps = {
      helper: async () =>
        new FakeHelper(
          {
            look,
            planted: [],
            read: (t, areas) => ({ t, lines: frameAt(t).lines.filter((l) => areas.some((a) => l.box[0] >= a[0] - 1 && l.box[1] >= a[1] - 1 && l.box[0] + l.box[2] <= a[0] + a[2] + 1 && l.box[1] + l.box[3] <= a[1] + a[3] + 1)), qr: [] })
          },
          log
        ) as unknown as ScanHelper,
      readProject: async () => h.project as never,
      projectDir: () => h.dir,
      random: rng(2331),
      log: () => undefined
    }
    const planted = [...new Set(truth.frames.flatMap((f) => f.items.filter((i) => i.text.replace(/\s/g, '').length >= 6).map((i) => i.text)))]
    expect(planted.length).toBeGreaterThan(100)
    const leaks = (v: unknown): string[] => {
      const json = JSON.stringify(v).toLowerCase()
      return planted.filter((p) => json.includes(p.toLowerCase()) || json.includes(foldText(p)))
    }
    const result = await runFind({ projectId: 'rec-1', requestId: 'e1', kinds: ['password', 'code', 'qr', 'key', 'link', 'email', 'card', 'phone', 'id', 'name'] as FindRequest['kinds'], regions: ['US', 'GB', 'BD'], names: truth.listedNames, neverHide: [] }, () => undefined, new AbortController().signal, deps)
    expect(result.ok && result.found.length).toBeGreaterThan(50)
    expect(leaks(result)).toEqual([])
    expect(keptLines('rec-1')).toBeGreaterThan(100)

    // Follow, the text under a cover and Everywhere on the scene with the email and the listed name.
    const s = scene()
    await runFind(find('rec-1', 'e2'), () => undefined, new AbortController().signal, s.deps)
    const box = (b: Box) => ({ x: b[0] / 1920, y: b[1] / 1080, w: b[2] / 1920, h: b[3] / 1080 })
    const results: unknown[] = []
    results.push(await followCover({ projectId: 'rec-1', requestId: 'e3', t: 6, box: box(EMAIL), start: 5, end: 7, path: `5 ${box(EMAIL).x} ${box(EMAIL).y} ${box(EMAIL).w} ${box(EMAIL).h}` }, new AbortController().signal, s.deps))
    for (const [id, b, remember] of [['e4', EMAIL, 'project'], ['e5', NAME, 'no'], ['e6', NAME, 'project'], ['e7', NAME, 'settings']] as const) {
      const under = await underCover({ projectId: 'rec-1', requestId: id, t: 6, box: box(b) }, new AbortController().signal, s.deps)
      results.push(under)
      expect(under.ok).toBe(true)
      const everywhere = await coverEverywhere({ projectId: 'rec-1', requestId: id, remember }, () => undefined, new AbortController().signal, s.deps)
      expect(everywhere.ok).toBe(true)
      if (!everywhere.ok) continue
      // Only a name-like text, with remember set, comes back: the user chose to add it to a list.
      expect(everywhere.addedName).toBe(b === NAME && remember !== 'no' ? 'Priya Raman' : undefined)
      const { addedName: _a, ...rest } = everywhere
      void _a
      results.push(rest)
    }
    const secret = (v: unknown) => ['priya', 'raman', 'example', 'prlya'].filter((x) => JSON.stringify(v).toLowerCase().includes(x))
    expect(secret(results)).toEqual([])

    // The kept folded texts: gone after 10 minutes, on Stop, on stopAnalyses, on render-process-gone and on a new Find.
    expect(keptLines('rec-1', s.now())).toBeGreaterThan(0)
    expect(keptLines('rec-1', s.now() + 10 * 60 * 1000 + 1)).toBe(0)
    scene()
    await call(PRIVACY_CHANNELS.find, find('rec-1', 'k1'))
    expect(keptLines('rec-1', 5_000_000)).toBeGreaterThan(0)
    await call(PRIVACY_CHANNELS.stopFind, 'rec-1')
    expect(keptLines('rec-1', 5_000_000)).toBe(0)
    await call(PRIVACY_CHANNELS.find, find('rec-1', 'k2'))
    expect(keptLines('rec-1', 5_000_000)).toBeGreaterThan(0)
    await stopAnalyses('rec-1')
    expect(keptLines('rec-1', 5_000_000)).toBe(0)
    await call(PRIVACY_CHANNELS.find, find('rec-1', 'k3'))
    expect(keptLines('rec-1', 5_000_000)).toBeGreaterThan(0)
    // The page goes away while it waits for the text under a cover.
    const page = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => undefined })
    const g = gate()
    scene({ gate: () => g.wait() })
    const following = Promise.resolve(h.handlers.get(PRIVACY_CHANNELS.underCover)!(app(page), { projectId: 'rec-1', requestId: 'k5', t: 6, box: box(EMAIL) }))
    await new Promise((r) => setTimeout(r, 20))
    page.emit('render-process-gone')
    g.open()
    await following
    expect(keptLines('rec-1', 5_000_000)).toBe(0)
    // A new Find forgets the last one's (here another project's).
    scene()
    await call(PRIVACY_CHANNELS.find, find('rec-1', 'k6'))
    expect(keptLines('rec-1', 5_000_000)).toBeGreaterThan(0)
    await call(PRIVACY_CHANNELS.find, find('rec-2', 'k7'))
    expect(keptLines('rec-1', 5_000_000)).toBe(0)
    expect(keptLines('rec-2', 5_000_000)).toBeGreaterThan(0)
  }, 60000)
})

export { plantedLines }
