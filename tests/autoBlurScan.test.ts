import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined, on: () => undefined }, app: { getPath: () => tmpdir(), isPackaged: false, getAppPath: () => tmpdir(), on: () => undefined }, BrowserWindow: class {}, screen: {}, shell: {}, dialog: {}, clipboard: {} }))

const { coverCopies, listCopies, originCovers } = await import('../src/main/privacy/copies')
const { readLookCache, writeLookCache, lookKeyOf } = await import('../src/main/privacy/lookCache')
const { RulesHost } = await import('../src/main/privacy/rulesHost')
const { coverEverywhere, followCover, forgetReads, keptLines, runFind, ScanUnavailable, underCover } = await import('../src/main/privacy/scan')
const { projectFileText } = await import('../src/main/projectFile')
const { parsePath, pathKeys, writePath } = await import('../src/shared/privacy/coverPath')
const { privateBleepWord, LEGACY_PREFIX } = await import('../src/shared/privacy/coverData')
const { addRead, planReads, hintsOf } = await import('../src/shared/privacy/plan')
const { migrateProject } = await import('../src/shared/engine/project')
import type { FindProgress, FindRequest, FindResult, FoundCover } from '../src/shared/api/privacy'
import type { ScanDeps, ScanHelper } from '../src/main/privacy/scan'
import type { Box, ReadResult } from '../src/shared/privacy/protocol'
import type { Bleep, Cover, Project, ProjectSummary } from '../src/shared/types'
import { base, key, rng } from './autoBlurFixtures'
import { FakeHelper, HD, inside, lookOf, plantedLines, type FakeScript, type Planted } from './autoBlurScanFixtures'

/*
 * The scan in main (docs/design/auto-blur.md §5; §17.1 tests 153-158, 237-240): runFind, Follow, the
 * text under a cover and Cover this text everywhere against a fake helper, with the real rules in
 * their worker; the look cache; the copies.
 */

const roots: string[] = []
afterAll(() => {
  forgetReads()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const EMAIL: Box = [600, 400, 460, 30]
const NAME: Box = [300, 700, 220, 30]
const ADDRESS = 'priya.raman@example.com'
/** What a result must never hold: the planted texts and their folded forms. */
const SECRETS = ['priya', 'raman', 'example', 'prlya']

function scene(over: Partial<FakeScript> = {}, seconds = 20, wrap: (h: FakeHelper) => void = () => undefined) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flown-scan-'))
  roots.push(dir)
  writeFileSync(path.join(dir, 'screen.mp4'), 'not a video')
  const planted: Planted[] = [
    { key: 'email', text: ADDRESS, at: (t) => (t >= 2 && t < 12 ? EMAIL : null) },
    { key: 'name', text: 'Priya Raman', at: (t) => (t >= 5 && t < 15 ? NAME : null) }
  ]
  const at = (t: number, x: number): boolean => Math.abs(t - x) < 1e-6
  const look = lookOf(HD, 30, seconds, (_i, t) => ({ changed: [...(at(t, 2) || at(t, 12) ? [[576, 384, 512, 64] as Box] : []), ...(at(t, 5) || at(t, 15) ? [[288, 672, 256, 64] as Box] : [])] }))
  const log: string[] = []
  const project: Project = base('rec-1', seconds, { fps: 30 })
  let clock = 1_000_000
  let starts = 0
  // Each start is a new helper process; their commands go to one log.
  const make = (): FakeHelper => {
    const h = new FakeHelper({ look, planted, ...over }, log)
    wrap(h)
    return h
  }
  const deps: ScanDeps = {
    helper: async () => {
      starts++
      return make() as unknown as ScanHelper
    },
    readProject: async () => project,
    projectDir: () => dir,
    readCursor: async () => null,
    now: () => clock,
    log: () => undefined
  }
  return { dir, log, make, project, planted, look, deps, advance: (ms: number) => (clock += ms), starts: () => starts }
}

const request = (over: Partial<FindRequest> = {}): FindRequest => ({ projectId: 'rec-1', requestId: 'r1', kinds: ['email', 'name', 'key', 'qr', 'notice'], regions: ['US'], names: ['Priya Raman'], neverHide: [], ...over })
const never = new AbortController().signal
const noProgress = (): void => undefined
const holdsSecret = (v: unknown): string | null => {
  const json = JSON.stringify(v).toLowerCase()
  return SECRETS.find((s) => json.includes(s)) ?? null
}
const boxOf = (f: Pick<FoundCover, 'path'>, t: number): Box => {
  const keys = parsePath(f.path)!
  let k = keys[0]
  for (const x of keys) if (x.t <= t + 1e-9) k = x
  return [k.x * 1920, k.y * 1080, k.w * 1920, k.h * 1080]
}

describe('auto-blur P4: the scan', () => {
  it('153. runFind with the fake helper: progress phases; the result holds no text (a JSON scan of it finds none of the planted strings)', async () => {
    // A secret QR code beside the text from 5 s: covered, its payload never in the result.
    const quad: [number, number][] = [
      [1500, 200],
      [1700, 200],
      [1700, 400],
      [1500, 400]
    ]
    const payload = 'otpauth://totp/Acme:priya?secret=JBSWY3DPEHPK3PXP&issuer=Acme'
    const s = scene({ qr: (t) => (t >= 5 ? [{ quad, payload }] : []) })
    const phases: FindProgress['phase'][] = []
    const r = await runFind(request(), (p) => phases[phases.length - 1] !== p.phase && phases.push(p.phase), never, s.deps)
    expect(phases).toEqual(['look', 'read', 'follow'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const email = r.found.find((f) => f.kind === 'email')!
    // The listed name, where it shows (the name inside the email is covered with the email too).
    const name = r.found.find((f) => f.kind === 'name' && f.start > 4)!
    expect(email.start).toBeGreaterThan(1.9)
    expect(email.start).toBeLessThanOrEqual(2)
    expect(email.end).toBeCloseTo(12 + 1 / 30, 2)
    expect(inside(EMAIL, boxOf(email, 5))).toBe(true)
    expect(name.start).toBeLessThanOrEqual(5)
    expect(inside(NAME, boxOf(name, 10))).toBe(true)
    expect(holdsSecret(r)).toBeNull()
    const qr = r.found.find((f) => f.kind === 'qr')!
    expect(inside([1500, 200, 200, 200], boxOf(qr, 6))).toBe(true)
    expect(JSON.stringify(r).toLowerCase()).not.toMatch(/otpauth|jbswy3|acme/)
    // The look pass ran once and was kept; a second run reads it from the cache.
    expect(s.log.filter((l) => l === 'look')).toHaveLength(1)
    await runFind(request({ requestId: 'r2' }), noProgress, never, s.deps)
    expect(s.log.filter((l) => l === 'look')).toHaveLength(1)
  })

  it('154. runFind and a failed read: a lost area from that frame until the next good read; failedReads counted (finding 23)', async () => {
    const s = scene({ read: (t) => (Math.abs(t - 2.3) < 0.01 ? 'fail' : undefined) })
    const r = await runFind(request(), noProgress, never, s.deps)
    expect(r.ok && r.failedReads).toBe(1)
    if (!r.ok) return
    const lost = r.found.filter((f) => f.lost && f.start === 2.3)
    expect(lost).toHaveLength(1)
    // It covers the read's areas (the email's region) until the next good read of them (the periodic read).
    expect(inside(EMAIL, boxOf(lost[0], 2.5))).toBe(true)
    expect(lost[0].end).toBeGreaterThan(2.3)
    expect(lost[0].end).toBeLessThanOrEqual(20)
  })

  it('155. Stop: the found covers come back with unfinished walks run to the end as lost areas over their last box and region; stopped and readTo are set', async () => {
    // Stopped while reading: what was read is covered to the end; readTo says how far.
    const controller = new AbortController()
    const s = scene({ read: (t) => void (t > 4 && controller.abort()) })
    const r = await runFind(request(), noProgress, controller.signal, s.deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.stopped).toBe(true)
    expect(r.readTo).not.toBeNull()
    expect(r.readTo!).toBeGreaterThanOrEqual(2.3)
    expect(r.readTo!).toBeLessThan(12)
    const email = r.found.find((f) => f.kind === 'email')!
    expect(email.end).toBeCloseTo(20, 2)
    expect(email.lost).toBe(true)
    expect(inside(EMAIL, boxOf(email, 15))).toBe(true)
    // Stopped while following: the walk not finished runs to the end as a lost area.
    const c2 = new AbortController()
    const s2 = scene({}, 20, (h) => {
      const open = h.followOpen.bind(h)
      h.followOpen = async (req) => {
        const session = await open(req)
        return { ...session, match: async (t, tracks) => (t > 6 && c2.abort(), session.match(t, tracks)) }
      }
    })
    const r2 = await runFind(request(), noProgress, c2.signal, s2.deps)
    expect(r2.ok && r2.stopped).toBe(true)
    if (!r2.ok) return
    expect(r2.readTo).toBeNull()
    for (const f of r2.found.filter((x) => x.kind === 'email' || x.kind === 'name')) {
      expect(f.end).toBeCloseTo(20, 2)
      expect(f.lost).toBe(true)
    }
  })

  it('156. followCover returns walked and lostSpans with its path; without the reader, a template-only path marked thin', async () => {
    const s = scene()
    const box = { x: EMAIL[0] / 1920, y: EMAIL[1] / 1080, w: EMAIL[2] / 1920, h: EMAIL[3] / 1080 }
    const r = await followCover({ projectId: 'rec-1', requestId: 'f1', t: 6, box, start: 5, end: 7, path: writePath([{ t: 5, ...box }]) }, never, s.deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.walked.start).toBeGreaterThan(1.9)
    expect(r.walked.start).toBeLessThanOrEqual(2)
    expect(r.walked.end).toBeCloseTo(12 + 1 / 30, 2)
    expect(r.start).toBe(r.walked.start)
    expect(typeof r.lostSpans).toBe('string')
    expect(r.thin).toBe(false)
    expect(inside(EMAIL, boxOf(r, 6))).toBe(true)
    expect(holdsSecret(r)).toBeNull()
    // Without the reader: a helper with no models, the box itself as the template, thin.
    const s2 = scene()
    let asked: boolean[] = []
    const r2 = await followCover({ projectId: 'rec-1', requestId: 'f2', t: 6, box, start: 5, end: 7, path: writePath([{ t: 5, ...box }]) }, never, {
      ...s2.deps,
      helper: async (models) => {
        asked = [...asked, models]
        if (models) throw new ScanUnavailable('reader')
        return s2.make() as unknown as ScanHelper
      }
    })
    expect(asked).toEqual([true, false])
    expect(r2.ok && r2.thin).toBe(true)
    expect(s2.log.some((l) => l.startsWith('read'))).toBe(false)
    // Stop changes nothing: the result says so.
    const stopped = new AbortController()
    stopped.abort()
    expect(await followCover({ projectId: 'rec-1', requestId: 'f3', t: 6, box, start: 5, end: 7, path: writePath([{ t: 5, ...box }]) }, stopped.signal, scene().deps)).toMatchObject({ ok: false, reason: 'stopped' })
  })

  it('157. coverEverywhere uses the kept folded reads within 10 minutes of Find, else a limited Find with progress and Stop', async () => {
    const s = scene()
    await runFind(request(), noProgress, never, s.deps)
    const box = { x: EMAIL[0] / 1920, y: EMAIL[1] / 1080, w: EMAIL[2] / 1920, h: EMAIL[3] / 1080 }
    expect(await underCover({ projectId: 'rec-1', requestId: 'u1', t: 6, box }, never, s.deps)).toEqual({ ok: true, nameLike: false })
    const readsBefore = s.log.filter((l) => l.startsWith('read')).length
    const kept = await coverEverywhere({ projectId: 'rec-1', requestId: 'u1', remember: 'no' }, noProgress, never, s.deps)
    expect(kept.ok).toBe(true)
    if (!kept.ok) return
    expect(kept.found.length).toBeGreaterThan(0)
    expect(kept.found.every((f) => f.kind === 'text' && f.group === kept.found[0].group)).toBe(true)
    expect(kept.found.some((f) => inside(EMAIL, boxOf(f, 6)))).toBe(true)
    // From the kept reads: no planned read again (only a walk's check reads, at most).
    expect(s.log.filter((l) => l.startsWith('read')).length - readsBefore).toBeLessThan(3)
    // Ten minutes later the kept reads are gone: a Find of that text alone, with progress, that Stop ends.
    s.advance(10 * 60 * 1000 + 1)
    expect(keptLines('rec-1', 1_000_000 + 10 * 60 * 1000 + 1)).toBe(0)
    expect(await underCover({ projectId: 'rec-1', requestId: 'u2', t: 6, box }, never, s.deps)).toMatchObject({ ok: true })
    const phases: string[] = []
    const limited = await coverEverywhere({ projectId: 'rec-1', requestId: 'u2', remember: 'no' }, (p) => phases.push(p.phase), never, s.deps)
    expect(limited.ok).toBe(true)
    if (!limited.ok) return
    expect(phases).toContain('read')
    expect(limited.found.some((f) => f.kind === 'text' && inside(EMAIL, boxOf(f, 6)))).toBe(true)
    expect(limited.found.every((f) => f.kind === 'text')).toBe(true)
    const stop = new AbortController()
    expect(await underCover({ projectId: 'rec-1', requestId: 'u3', t: 6, box }, never, s.deps)).toMatchObject({ ok: true })
    s.advance(1)
    const s3 = { ...s.deps, readCursor: async () => (stop.abort(), null) }
    const stopped = await coverEverywhere({ projectId: 'rec-1', requestId: 'u3', remember: 'no' }, noProgress, stop.signal, s3)
    expect(stopped.ok && stopped.stopped).toBe(true)
  })

  it('158. lookCache round-trips and is ignored when screen.mp4’s size or mtime changes', async () => {
    const s = scene()
    const keyNow = (await lookKeyOf(s.dir, 4, 1))!
    await writeLookCache(s.dir, keyNow, s.look)
    const back = await readLookCache(s.dir, keyNow)
    expect(back?.frames).toEqual(s.look.frames)
    expect(back?.keys).toEqual(s.look.keys)
    expect(back?.size).toEqual(s.look.size)
    // Another file: a different size, then a different modified time.
    writeFileSync(path.join(s.dir, 'screen.mp4'), 'a different recording')
    expect(await readLookCache(s.dir, (await lookKeyOf(s.dir, 4, 1))!)).toBeNull()
    writeFileSync(path.join(s.dir, 'screen.mp4'), 'not a video')
    utimesSync(path.join(s.dir, 'screen.mp4'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    expect(await readLookCache(s.dir, (await lookKeyOf(s.dir, 4, 1))!)).toBeNull()
    // Another scale or step, and a damaged file: ignored.
    expect(await readLookCache(s.dir, { ...keyNow, step: 2 })).toBeNull()
    mkdirSync(path.join(s.dir, '.cache'), { recursive: true })
    writeFileSync(path.join(s.dir, '.cache', 'look.bin'), 'damaged')
    expect(await readLookCache(s.dir, keyNow)).toBeNull()
  })

  it('237. Partial and check reads count: extra reads for a partial answer and check reads are in the plan’s units and its report', async () => {
    const look = lookOf(HD, 30, 10)
    const plan = planReads(look, hintsOf(null), HD, 30, 1e9)
    const before = plan.units
    addRead(plan, 2, [[0, 0, 300, 80]], 'partial')
    addRead(plan, 3, [[0, 0, 1200, 500]], 'check')
    expect(plan.units).toBeCloseTo(before + 0.1 + 1, 6)
    expect(plan.reads.slice(-2).map((r) => r.why)).toEqual(['partial', 'check'])
    // In a run: a read capped at the email's area is read again in halves; the report counts their units.
    const logs: string[] = []
    // The settle read of the email's area answers partial; its halves read it.
    const partial = scene({ read: (t, areas) => (Math.abs(t - 2.3) < 0.01 && areas.some((a) => a[2] > 300) ? ({ t, lines: [], qr: [], partial: [[576, 384, 512, 64]] } as ReadResult) : undefined) })
    const r = await runFind(request(), noProgress, never, { ...partial.deps, log: (l) => logs.push(l) })
    const plain = scene()
    const logs2: string[] = []
    await runFind(request(), noProgress, never, { ...plain.deps, log: (l) => logs2.push(l) })
    const count = (l: string, what: string): number => Number(new RegExp(`(\\d+) ${what}`).exec(l)![1])
    expect(count(logs[0], 'partial')).toBe(2)
    expect(count(logs2[0], 'partial')).toBe(0)
    // The report's units: the plan's and every extra read's (each half a 0.1-unit bucket, each check read its own).
    const units = (l: string): number => Number(/\(([\d.]+) units/.exec(l)![1])
    expect(units(logs[0]) - 0.2).toBeCloseTo(units(logs2[0]) - 0.1 * (count(logs2[0], 'check') - count(logs[0], 'check')), 6)
    expect(partial.log.filter((l) => l.startsWith('read 2.3')).length).toBe(3)
    expect(r.ok && r.found.some((f) => f.kind === 'email' && inside(EMAIL, boxOf(f, 6)))).toBe(true)
  })

  it('238. The rules worker’s limit: a read whose rules take over 2 s (a test rule that spins) is counted as failed, its area becomes a lost area, and the next read runs in a new worker', async () => {
    const code = `const { parentPort } = require('node:worker_threads')
parentPort.on('message', (m) => {
  if (m.lines.some((l) => l.variants.some((v) => v.text === 'spin'))) { const end = Date.now() + 60000; while (Date.now() < end) {} }
  parentPort.postMessage({ id: m.id, hits: [], careful: [] })
})`
    const host = new RulesHost({ create: () => new Worker(code, { eval: true }) })
    const line = (text: string) => ({ box: [0, 0, 100, 20] as Box, quad: [], variants: [{ model: 'tiny' as const, text, conf: 0.99, spans: [] }], ring: '#000000', spread: 0 })
    const options = { kinds: [], regions: [], names: { entries: [], never: new Set<string>() }, frame: { width: 1920, height: 1080 } }
    const t0 = Date.now()
    expect(await host.detect([line('spin')], [], options)).toBe('timeout')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900)
    expect(await host.detect([line('calm')], [], options)).toEqual([])
    expect(host.started).toBe(2)
    host.close()
    // In a run: the read whose rules spin fails, its areas are covered, the reads after it still run.
    const s = scene({ read: (t, areas) => (Math.abs(t - 5.3) < 0.01 ? { t, lines: [line('spin')], qr: [] } : { t, lines: plantedLines(s.planted, t, areas), qr: [] }) })
    const spinning = new RulesHost({ create: () => new Worker(code, { eval: true }) })
    const r = await runFind(request(), noProgress, never, { ...s.deps, rules: () => spinning })
    expect(r.ok && r.failedReads).toBe(1)
    if (!r.ok) return
    expect(r.found.some((f) => f.lost && f.start === 5.3 && inside(NAME, boxOf(f, 5.5)))).toBe(true)
    expect(s.log.some((l) => l.startsWith('read 15.3'))).toBe(true)
  }, 20000)

  it('239. Results are tagged: every result carries the request’s projectId and requestId', async () => {
    const s = scene()
    const tagOf = (r: { projectId?: string; requestId?: string }) => [r.projectId, r.requestId]
    expect(tagOf(await runFind(request({ requestId: 'a1' }), noProgress, never, s.deps))).toEqual(['rec-1', 'a1'])
    expect(tagOf(await runFind(request({ requestId: 'a2' }), noProgress, never, { ...s.deps, helper: async () => Promise.reject(new ScanUnavailable('reader')) }))).toEqual(['rec-1', 'a2'])
    expect(tagOf(await runFind(request({ requestId: 'a3' }), noProgress, never, { ...s.deps, readProject: async () => ({ ...s.project, width: 8000, height: 4500 }) }))).toEqual(['rec-1', 'a3'])
    const box = { x: 0.3, y: 0.37, w: 0.24, h: 0.03 }
    expect(tagOf(await followCover({ projectId: 'rec-1', requestId: 'a4', t: 6, box, start: 5, end: 7, path: writePath([{ t: 5, ...box }]) }, never, s.deps))).toEqual(['rec-1', 'a4'])
    expect(tagOf(await coverEverywhere({ projectId: 'rec-1', requestId: 'a5', remember: 'no' }, noProgress, never, s.deps))).toEqual(['rec-1', 'a5'])
    expect(await underCover({ projectId: 'rec-1', requestId: 'a6', t: 6, box }, never, s.deps)).toMatchObject({ ok: true })
    expect(tagOf(await coverEverywhere({ projectId: 'rec-1', requestId: 'a6', remember: 'project' }, noProgress, never, s.deps))).toEqual(['rec-1', 'a6'])
  })

  it('240. Copies: listCopies finds the copies by copyOf.id; coverCopies adds the original’s covers and private bleeps to a closed copy as suggestions through projectFileText and skips an open one; originCovers counts what a copy lacks', async () => {
    const found: Cover = { id: 'c1', start: 2, end: 12, path: writePath([key(2, 0.3, 0.37, 0.24, 0.03)]), color: '#202020', found: 'check', kind: 'email', group: 'g1' }
    const kept: Cover = { id: 'c2', start: 5, end: 15, path: writePath([key(5, 0.15, 0.64, 0.12, 0.03)]), color: '#202020', kind: 'name', group: 'g2' }
    const drawn: Cover = { id: 'c3', start: 0, end: 20, path: writePath([key(0, 0.8, 0.8, 0.1, 0.1)]), color: '#000000' }
    const said: Bleep = { id: 'b1', start: 3, end: 4, word: privateBleepWord('card', 'k3v9q2m8xa'), auto: true, sound: 'tone' } as Bleep
    const original: Project = { ...base('orig', 20), covers: [found, kept, drawn], bleeps: [said], privacy: { find: { at: '2026-11-23T12:00:00.000Z', kinds: ['email', 'name'], listened: true } } }
    const a: Project = { ...base('copyA', 20), copyOf: { id: 'orig', name: 'orig' } }
    const b: Project = { ...base('copyB', 20), copyOf: { id: 'orig', name: 'orig' } }
    const other: Project = { ...base('other', 20), copyOf: { id: 'elsewhere', name: 'x' } }
    const all = new Map([original, a, b, other].map((p) => [p.id, p]))
    const summary = (p: Project): ProjectSummary => ({ id: p.id, name: p.name, createdAt: p.createdAt, duration: p.duration, dir: `/p/${p.id}`, ...(p.copyOf ? { copyOf: p.copyOf } : {}) })
    const written: string[] = []
    const deps = {
      listProjects: async () => [...all.values()].map(summary),
      readProject: async (id: string) => structuredClone(all.get(id)!),
      save: (p: Project) => {
        const text = projectFileText(p)
        written.push(p.id)
        all.set(p.id, migrateProject(JSON.parse(text)))
        expect(JSON.parse(text).shapes.some((x: { id: string }) => x.id.startsWith(LEGACY_PREFIX))).toBe(true)
      },
      isOpen: (id: string) => id === 'copyB',
      random: rng(240)
    }
    expect((await listCopies('orig', deps)).map((c) => [c.id, c.open])).toEqual([
      ['copyA', false],
      ['copyB', true]
    ])
    expect((await originCovers('copyA', deps)).missing).toBe(3)
    expect(await coverCopies('orig', ['copyA', 'copyB', 'other'], deps)).toEqual({ covered: 1, skipped: ['copyB', 'other'] })
    expect(written).toEqual(['copyA'])
    const copied = all.get('copyA')!
    // The found and kept covers arrive as suggestions with their kinds, groups and tiers; the drawn one is the original's own.
    expect(copied.covers!.map((c) => [c.kind, c.group, c.found]).sort()).toEqual([
      ['email', 'g1', 'check'],
      ['name', 'g2', 'auto']
    ])
    expect(copied.bleeps!.map((x) => x.word)).toEqual([said.word])
    expect(copied.privacy?.find?.kinds).toEqual(['email', 'name'])
    expect(pathKeys(copied.covers![0]).length).toBeGreaterThan(0)
    expect((await originCovers('copyA', deps)).missing).toBe(0)
    expect((await originCovers('copyB', deps)).missing).toBe(3)
    expect((await originCovers('orig', deps)).missing).toBe(0)
  })
})

describe('auto-blur P4: test numbers', () => {
  it('the scan’s numbered tests (136-160, 229-240) each exist exactly once', async () => {
    const fs = await import('node:fs')
    const numbers = [...Array.from({ length: 25 }, (_v, i) => 136 + i), ...Array.from({ length: 12 }, (_v, i) => 229 + i)]
    const found = new Map<number, number>()
    for (const file of fs.readdirSync(__dirname).filter((f) => /^autoBlur.*\.test\.ts$/.test(f)))
      for (const m of fs.readFileSync(path.join(__dirname, file), 'utf8').matchAll(/\bit\(\s*(['"`])(\d+)\. /g)) found.set(Number(m[2]), (found.get(Number(m[2])) ?? 0) + 1)
    for (const n of numbers) expect(found.get(n), `test ${n}`).toBe(1)
  })
})

export type { FindResult }
