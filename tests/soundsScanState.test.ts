// The editor's scan controller (docs/design/sound-finder.md §4.7): stored scores shown without
// listening, missing sources listened to and kept, Cancel keeps nothing, a failure is said, a stop
// of the project's work returns to the start.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoundsApi } from '../src/shared/api/sounds'
import { SOUNDS_STOPPED } from '../src/shared/api/sounds'
import { HOP_SECONDS, SCORE_COLUMNS, SOUND_KIND_ORDER, type SoundRow } from '../src/shared/audio/sounds'
import { cacheEntry, type SoundCacheEntry } from '../src/shared/audio/soundsCache'
import { skipKey } from '../src/shared/audio/soundsScan'

const analysis = vi.hoisted(() => ({ speech: null as { start: number; end: number }[] | null, calls: 0 }))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({
  loadAudioAnalysis: async (_id: string, sources: string[]) => {
    analysis.calls++
    return Object.fromEntries(sources.map((s) => [s, { window: 0.05, power: new Float32Array(2000), ...(s === 'mic' && analysis.speech ? { speech: analysis.speech } : {}) }]))
  }
}))

type Project = { id: string; hasAudio: boolean; audioStems: { mic: boolean; system: boolean }; duration: number }
type Listener = { done: Promise<{ n: number; scores: Uint8Array }>; stop(): void }
type ListenFn = (api: SoundsApi, project: Project, source: string, skip: unknown, onSeconds: (s: number) => void) => Promise<{ info: { size: number; mtimeMs: number }; listener: Listener }>
type ScanState = { status: 'idle'; checking?: boolean } | { status: 'listening'; progress: number } | { status: 'done'; rows: SoundRow[]; fromCache: boolean } | { status: 'failed'; message: string }
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const MODULE = '../src/renderer/src/editor/sounds/soundScan'
const { cancelScan, checkStored, scanState, startScan } = (await import(/* @vite-ignore */ MODULE)) as {
  cancelScan(id: string): void
  checkStored(api: SoundsApi, p: Project): Promise<void>
  scanState(id: string): ScanState
  startScan(api: SoundsApi, p: Project, listen: ListenFn): Promise<void>
}

const COLS = SCORE_COLUMNS.length
const project = (id: string) => ({ id, hasAudio: true, audioStems: { mic: true, system: true }, duration: 100 })

/** Scores with a ding in window 20. */
function dingScores(n = 200): Uint8Array {
  const s = new Uint8Array(n * COLS)
  s[20 * COLS + 1 + SOUND_KIND_ORDER.indexOf('ping')] = 200
  return s
}

function fakeApi(stored: Partial<Record<string, SoundCacheEntry>> = {}) {
  const saved: Record<string, SoundCacheEntry> = {}
  const api = {
    soundsCached: vi.fn(async (_id: string, source: string) => stored[source] ?? null),
    soundsSave: vi.fn(async (_id: string, source: string, e: SoundCacheEntry) => {
      saved[source] = e
    })
  } as unknown as SoundsApi
  return { api, saved }
}

/** A listener that finishes when `release` is called (or fails with `error`). */
function fakeListen(opts: { error?: string } = {}) {
  const stops: string[] = []
  const pending: { source: string; resolve: () => void; reject: (e: Error) => void }[] = []
  const listen: ListenFn = async (_api, _p, source, _skip, onSeconds) => {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const done = new Promise<{ n: number; scores: Uint8Array }>((res, rej) => {
      resolve = () => res({ n: 200, scores: dingScores() })
      reject = rej
    })
    pending.push({ source, resolve, reject })
    onSeconds(50)
    if (opts.error) queueMicrotask(() => reject(new Error(opts.error)))
    return {
      info: { size: 10, mtimeMs: 20 },
      listener: {
        done,
        stop: () => {
          stops.push(source)
          reject(new Error('cancelled'))
        }
      }
    }
  }
  return { listen, stops, pending }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  analysis.speech = null
  analysis.calls = 0
})

describe('the scan controller', () => {
  it('shows stored scores at once, and stays idle without them (not waiting for the levels)', async () => {
    const e = cacheEntry({ size: 1, mtimeMs: 2 }, 'none', 200, dingScores())
    const both = fakeApi({ mic: e, system: e })
    await checkStored(both.api, project('p1'))
    const s = scanState('p1')
    expect(s.status).toBe('done')
    if (s.status === 'done') {
      expect(s.fromCache).toBe(true)
      expect(s.rows.map((r) => r.kind)).toEqual(['ping'])
      expect(s.rows[0].start).toBeCloseTo(20 * HOP_SECONDS, 3)
    }
    const one = fakeApi({ mic: e })
    await checkStored(one.api, project('p2'))
    expect(scanState('p2')).toEqual({ status: 'idle' })
    expect(analysis.calls).toBe(1)
    // Scores made with other speech skipped are not used.
    analysis.speech = [{ start: 1, end: 2 }]
    await checkStored(both.api, project('p3'))
    expect(scanState('p3')).toEqual({ status: 'idle' })
  })

  it('listens to the missing sources, reports progress, keeps their scores and lists the rows', async () => {
    analysis.speech = [{ start: 50, end: 60 }]
    const e = cacheEntry({ size: 1, mtimeMs: 2 }, skipKey(analysis.speech), 200, dingScores())
    const { api, saved } = fakeApi({ mic: e })
    const { listen, pending } = fakeListen()
    const run = startScan(api, project('p4'), listen)
    // First the levels and the speech detector: said as getting ready, not as 0% listened.
    expect(scanState('p4')).toEqual({ status: 'listening', progress: 0, preparing: true })
    await tick()
    await tick()
    expect(pending.map((p) => p.source)).toEqual(['system'])
    const s = scanState('p4')
    expect(s.status).toBe('listening')
    if (s.status === 'listening') expect(s.progress).toBeCloseTo(0.5)
    pending[0].resolve()
    await run
    expect(Object.keys(saved)).toEqual(['system'])
    expect(saved.system.skip).toBe(skipKey(analysis.speech))
    expect(saved.system.size).toBe(10)
    const done = scanState('p4')
    expect(done.status === 'done' && done.fromCache).toBe(false)
    expect(done.status === 'done' && done.rows.length).toBe(1)
  })

  it('Cancel stops every listener and keeps nothing', async () => {
    const { api, saved } = fakeApi()
    const { listen, stops } = fakeListen()
    const run = startScan(api, project('p5'), listen)
    await tick()
    await tick()
    cancelScan('p5')
    await run
    expect([...new Set(stops)].sort()).toEqual(['mic', 'system'])
    expect(scanState('p5')).toEqual({ status: 'idle' })
    expect(saved).toEqual({})
  })

  it('says why it failed, stops the other source, and goes back to the start when the project was stopped', async () => {
    const { api } = fakeApi()
    const failing = fakeListen({ error: 'The sound finder could not run: no memory' })
    await startScan(api, project('p6'), failing.listen)
    expect(scanState('p6')).toEqual({ status: 'failed', message: 'The sound finder could not run: no memory' })
    expect(failing.stops.length).toBeGreaterThan(0)
    const stopped = fakeListen({ error: SOUNDS_STOPPED })
    await startScan(api, project('p7'), stopped.listen)
    expect(scanState('p7')).toEqual({ status: 'idle' })
  })
})
