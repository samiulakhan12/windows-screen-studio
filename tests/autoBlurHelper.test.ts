import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadResult } from '../src/shared/privacy/protocol'

/*
 * The text reader helper as main runs it (src/main/privacy/readerHelper.ts; docs/design/auto-blur.md
 * §5.5, §10.4, §10.6; §17.1 tests 81-84, 93, 94, 96, 98-100, 216-219 and 222), against the scripted
 * fake helper (tests/fixtures/fake-ocr-helper.cjs). Where a test needs Find's loop around the
 * helper (restarting it, reading the next planned read), a few lines here stand in for part P4's
 * scan.
 */

const h = vi.hoisted(() => ({ recording: false, root: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => h.root, getPath: () => h.root } }))
vi.mock('../src/main/recording/toolbarWindow', () => ({ isToolbarVisible: () => h.recording }))

const { findFailureOf, flownRecording, HelperError, HELPER_LIMITS, OcrHelper, pauseWhileRecording } = await import('../src/main/privacy/readerHelper')
const { AppLog } = await import('../src/main/appLog')
type Helper = Awaited<ReturnType<typeof OcrHelper.start>>

const FAKE = path.resolve(__dirname, 'fixtures/fake-ocr-helper.cjs')
const dir = mkdtempSync(path.join(tmpdir(), 'flown-ocr-helper-'))
h.root = dir
const logFile = path.join(dir, 'calls.jsonl')
const scriptFile = path.join(dir, 'script.json')
const pins = [{ file: 'PP-OCRv6_tiny_det_onnx/inference.onnx', path: '/models/det.onnx', bytes: 3, sha256: 'a'.repeat(64) }]
const video = '/projects/p/screen.mp4'

type Logged = { start?: true; n?: number; args?: string[]; line?: { op: string; id: number; t?: number; target?: number; lines?: number[]; read?: number; models?: unknown[] } }
const logged = (): Logged[] =>
  readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged)
const sent = (op?: string): NonNullable<Logged['line']>[] =>
  logged()
    .map((l) => l.line!)
    .filter((l) => l && (!op || l.op === op))

let helpers: Helper[] = []
const script = (s: object): void => writeFileSync(scriptFile, JSON.stringify(s))
const start = async (s: object = {}, deps: Parameters<typeof OcrHelper.start>[0] = {}): Promise<Helper> => {
  script(s)
  const helper = await OcrHelper.start({ path: FAKE, ...deps })
  helpers.push(helper)
  return helper
}
const opened = async (s: object = {}, deps: Parameters<typeof OcrHelper.start>[0] = {}): Promise<Helper> => {
  const helper = await start(s, deps)
  await helper.open(pins, 'ffmpeg')
  return helper
}
const read = (helper: Helper, t: number, signal = new AbortController().signal) => helper.read({ video, key: 0, t, areas: [[0, 0, 100, 40]] }, signal)

beforeEach(() => {
  process.env.SSW_OCR_SCRIPT = scriptFile
  process.env.SSW_OCR_LOG = logFile
  writeFileSync(logFile, '')
  h.recording = false
})
afterEach(async () => {
  for (const x of helpers.splice(0)) x.kill()
  delete process.env.SSW_OCR_SCRIPT
  delete process.env.SSW_OCR_LOG
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('auto-blur P2: the helper in main', () => {
  it('81. OcrHelper with the fake helper: open sends the pins; heartbeats arrive during open (finding 25); 20 s of silence kills it; an exit is reported', async () => {
    const lines: string[] = []
    // Open takes 1.2 s; the silence limit is 0.6 s, so only the heartbeats during open keep it alive.
    const helper = await start({ openMs: 1200, heartbeatMs: 150 }, { silenceMs: 600, log: (l) => lines.push(l) })
    await helper.open(pins, 'ffmpeg')
    expect(sent('open')[0].models).toEqual(pins)
    expect(HELPER_LIMITS.silenceMs).toBe(20_000)
    // Silent after open (no heartbeat): killed after the limit; the exit is reported.
    const quiet = await start({ heartbeatMs: 0, silentAfterOpen: true }, { silenceMs: 400, log: (l) => lines.push(l) })
    await quiet.open(pins, 'ffmpeg')
    const pending = read(quiet, 1)
    await expect(pending).rejects.toMatchObject({ kind: 'silent' })
    expect(await quiet.exited).toBeNull()
    expect(lines.some((l) => /silent/.test(l))).toBe(true)
    expect(lines.some((l) => /ended \(code/.test(l))).toBe(true)
  })

  it('82. Malformed helper lines are dropped; a line over 16 MB kills the helper', async () => {
    const helper = await opened({ badLines: ['not json', '{"id":1,"opened":{"protocol":"x"}}', '{"alive":-1}', '{"id":2,"read":{"t":1}}'] })
    const { result } = await read(helper, 1)
    expect(result.lines[0].variants[0].text).toBe('hello')
    expect(helper.refusedLines).toBe(4)
    const huge = await start({ hugeLine: true })
    await huge.open(pins, 'ffmpeg')
    await expect(read(huge, 1)).rejects.toMatchObject({ kind: 'crashed' })
    expect(await huge.exited).toBeNull()
  }, 30_000)

  it('83. read, careful and release: never more than 3 reads unreleased; a careful answers as its own event while a fourth read waits', async () => {
    const helper = await opened()
    const first = await Promise.all([read(helper, 1), read(helper, 2), read(helper, 3)])
    const fourth = read(helper, 4)
    let fourthDone = false
    void fourth.then(() => (fourthDone = true))
    await new Promise((r) => setTimeout(r, 200))
    // The fourth waits here: the helper has three reads' crops.
    expect(sent('read')).toHaveLength(3)
    expect(fourthDone).toBe(false)
    const careful = await helper.careful(first[0].id, [0])
    expect(careful).toEqual([[{ model: 'small', text: 'careful 0', conf: 0.99, spans: [] }]])
    // The careful pass freed a slot: the fourth goes.
    await fourth
    expect(sent('read')).toHaveLength(4)
    helper.release(first[1].id)
    helper.release(first[2].id)
    await Promise.all([read(helper, 5), read(helper, 6)])
    expect(sent('release').map((r) => r.read)).toEqual([first[1].id, first[2].id])
    expect(sent('careful')[0]).toMatchObject({ read: first[0].id, lines: [0] })
  })

  it('84. A read error comes back as { id, error } for that read only (finding 23)', async () => {
    const helper = await opened({ reads: { '2': { error: 'read' } } })
    const results = await Promise.allSettled([read(helper, 1), read(helper, 2), read(helper, 3)])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ kind: 'read' })
    // A failed read holds no crops: three more reads go at once.
    await Promise.all([read(helper, 4)])
  })

  it('93. pause and resume reach the fake helper when the recording state turns true and false (isToolbarVisible); the progress shows waiting', async () => {
    const helper = await opened()
    const waiting: boolean[] = []
    vi.useFakeTimers()
    try {
      const stop = pauseWhileRecording(helper, flownRecording, (w) => waiting.push(w))
      h.recording = true
      vi.advanceTimersByTime(2000)
      h.recording = false
      vi.advanceTimersByTime(2000)
      h.recording = true
      vi.advanceTimersByTime(2000)
      stop()
    } finally {
      vi.useRealTimers()
    }
    expect(waiting).toEqual([true, false, true, false])
    await vi.waitFor(() => expect(sent().filter((l) => l.op === 'pause' || l.op === 'resume').map((l) => l.op)).toEqual(['pause', 'resume', 'pause', 'resume']))
  })

  it('94. OcrHelper.start refuses a helper that answers another protocol number', async () => {
    script({ protocol: 2 })
    await expect(OcrHelper.start({ path: FAKE, open: { pins, ffmpeg: 'ffmpeg' } })).rejects.toMatchObject({ kind: 'protocol' })
    // The one it started is ended.
    const pid = logged().find((l) => l.start)!
    await vi.waitFor(() => expect(() => process.kill((pid as { pid: number }).pid, 0)).toThrow())
  })

  it('96. The helper is started with shell: false, windowsHide and below-normal priority', async () => {
    const calls: { file: string; args: readonly string[]; opts: Record<string, unknown> }[] = []
    const priorities: [number, number][] = []
    const spy = ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts })
      return spawn(file, args as string[], opts)
    }) as unknown as typeof spawn
    const helper = await start({}, { spawn: spy, setPriority: (pid, p) => priorities.push([pid, p]) })
    expect(calls[0].opts).toMatchObject({ shell: false, windowsHide: true })
    expect(calls[0].args).toContain('--low-priority')
    expect(priorities).toEqual([[helper.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL]])
    // Only what the C runtime needs reaches it.
    expect(Object.keys(calls[0].opts.env as object).filter((k) => !k.startsWith('SSW_OCR_'))).toEqual(expect.arrayContaining(['PATH']))
    expect(Object.keys(calls[0].opts.env as object)).not.toContain('HOME')
  })

  it("98. The fake helper's crash on one read fails every read in flight; the scan starts it once more and goes on from the next planned read, never the one that crashed; a second crash ends Find with crashed", async () => {
    script({ reads: { '2': { crash: 3, delayMs: 0 } }, crashStart: 2 })
    // P4's scan, in brief: at most 3 reads in flight, one restart.
    const plan = [1, 2, 3, 4, 5, 6]
    const failed: number[] = []
    const done: number[] = []
    let helper = await OcrHelper.start({ path: FAKE, open: { pins, ffmpeg: 'ffmpeg' } })
    helpers.push(helper)
    let restarts = 0
    let ended: string | null = null
    let next = 0
    while (next < plan.length && !ended) {
      const batch = plan.slice(next, next + 3)
      next += batch.length
      const out = await Promise.allSettled(batch.map((t) => read(helper, t)))
      let died = false
      out.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          done.push(batch[i])
          helper.release(r.value.id)
        } else {
          failed.push(batch[i])
          died ||= r.reason.kind === 'crashed'
        }
      })
      if (died) {
        if (restarts === 1) ended = findFailureOf(new HelperError('crashed'))
        else {
          restarts++
          helper = await OcrHelper.start({ path: FAKE, open: { pins, ffmpeg: 'ffmpeg' } })
          helpers.push(helper)
        }
      }
    }
    // Reads 1-3 were in flight when the second crashed it: 1 answered before, 2 and 3 failed.
    expect(done).toEqual([1])
    expect(failed).toEqual([2, 3, 4, 5, 6])
    const second = logged().filter((l) => l.start).length
    expect(second).toBe(2)
    const byProcess: number[][] = [[], []]
    let n = -1
    for (const l of logged()) {
      if (l.start) n++
      else if (l.line?.op === 'read') byProcess[n].push(l.line.t!)
    }
    // The restarted helper was sent the next planned read (4), never the one that crashed (2).
    expect(byProcess[1][0]).toBe(4)
    expect(byProcess[1]).not.toContain(2)
    expect(ended).toBe('crashed')
  })

  it("99. The look batches' frame times and key flags reach main without loss", async () => {
    const frames = [
      { t: 0, key: true, tiles: '/w==', moves: [] },
      { t: 0.033333, key: false, tiles: 'AA==', moves: [{ box: [0, 0, 480, 270], dx: 0, dy: -12.5, score: 0.97, alt: [[0, -25, 0.88]] }] },
      { t: 1140.366667, key: true, tiles: 'AAE=', moves: [] }
    ]
    const helper = await opened({ look: frames })
    const got: unknown[][] = []
    await helper.look({ video, k: 4, step: 2, from: 0, to: 2000 }, (f: unknown[]) => got.push(f), new AbortController().signal)
    expect(got).toHaveLength(2)
    expect(got.flat()).toEqual(frames)
  })

  it('100. tooLarge from the helper ends Find with privacy.run.tooLarge; model with privacy.run.readerDamaged', async () => {
    const helper = await opened({ read: { error: 'tooLarge' } })
    const err: unknown = await read(helper, 1).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'tooLarge' })
    expect(findFailureOf(err)).toBe('tooLarge')
    const bad = await start({ open: 'model' })
    const m: unknown = await bad.open(pins, 'ffmpeg').catch((e: unknown) => e)
    expect(findFailureOf(m)).toBe('reader')
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '../src/shared/i18n/messages/en/privacy.json'), 'utf8'))
    expect(en['run.tooLarge']).toMatch(/too large/)
    expect(en['run.readerDamaged']).toMatch(/damaged/)
    expect(findFailureOf(new HelperError('missing'))).toBe('helper')
    expect(findFailureOf(new HelperError('video'))).toBe('video')
    expect(findFailureOf(new Error('x'))).toBe('failed')
  })

  it('216. Nothing the helper says is logged: after a marker on its stderr, a malformed line holding it and a crash, app.log holds no marker and refusedLines counts the line', async () => {
    const marker = 'SECRET-MARKER-7f3a'
    const logDir = path.join(dir, 'logs')
    const log = new AppLog(logDir, {}, { maxBytes: 1 << 20, flushMs: 10_000, lineMax: 2000 }, () => new Date(Date.UTC(2026, 10, 23)))
    const consoleLines: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void consoleLines.push(a.join(' '))))
    try {
      const helper = await opened({ marker, reads: { '1': { crash: 3 } } }, { log: (l) => log.write('info', [l]) })
      await expect(read(helper, 1)).rejects.toMatchObject({ kind: 'crashed' })
      expect(await helper.exited).toBe(3)
      expect(helper.refusedLines).toBe(1)
    } finally {
      for (const s of spies) s.mockRestore()
    }
    await log.flush()
    const text = readFileSync(log.file, 'utf8')
    expect(text).toContain('text reader ended (code 3)')
    expect(text).toContain('1 text reader lines refused')
    expect(text).not.toContain(marker)
    expect((await log.recent(300)).join('\n')).not.toContain(marker)
    expect(consoleLines.join('\n')).not.toContain(marker)
  })

  it('217. OcrHelper numbers every command from one counter; every event is matched to its command by id, whatever order the answers come in; cancel drops a queued read', async () => {
    const helper = await opened({ holdReads: 3, reads: { '1': { lines: ['one'] }, '2': { lines: ['two'] }, '3': { lines: ['three'] } } })
    const three = Promise.all([read(helper, 1), read(helper, 2), read(helper, 3)])
    const queued = new AbortController()
    const fourth = read(helper, 4, queued.signal)
    const got = await three
    // Answered newest first, matched by id.
    expect(got.map((g) => (g.result as ReadResult).lines[0].variants[0].text)).toEqual(['one', 'two', 'three'])
    const ids = sent().map((l) => l.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
    // The fourth waited for a slot; cancelled, it is dropped and never sent.
    queued.abort()
    await expect(fourth).rejects.toMatchObject({ kind: 'cancelled' })
    for (const g of got) helper.release(g.id)
    await new Promise((r) => setTimeout(r, 100))
    expect(sent('read').map((r) => r.t)).toEqual([1, 2, 3])
    expect(sent('cancel')).toEqual([])
  })

  it('218. A helper death with 3 reads in flight fails those 3 reads (lost areas) and the restarted helper is sent the next planned read', async () => {
    script({ holdReads: 4, reads: { '3': { crash: 9 } } })
    let helper = await OcrHelper.start({ path: FAKE, open: { pins, ffmpeg: 'ffmpeg' } })
    helpers.push(helper)
    const out = await Promise.allSettled([read(helper, 10), read(helper, 11), read(helper, 12)])
    expect(out.map((r) => (r.status === 'rejected' ? r.reason.kind : 'ok'))).toEqual(['crashed', 'crashed', 'crashed'])
    expect(await helper.exited).toBe(9)
    // Lost areas: each failed read's own areas, for the scan to cover.
    script({})
    helper = await OcrHelper.start({ path: FAKE, open: { pins, ffmpeg: 'ffmpeg' } })
    helpers.push(helper)
    await read(helper, 13)
    const reads = logged().filter((l) => l.start || l.line?.op === 'read')
    const lastStart = reads.map((l) => !!l.start).lastIndexOf(true)
    const afterRestart = reads.slice(lastStart + 1).map((l) => l.line!.t)
    expect(afterRestart).toEqual([13])
  })

  it('219. The follow session API: followOpen, track, match and close round-trip with the fake helper, and every track of a frame is answered in one matched event', async () => {
    const helper = await opened({ matched: { parts: 0.82, second: 0.31 } })
    const session = await helper.followOpen({ video, key: 0, from: 1, to: 3, dir: -1 }, new AbortController().signal)
    await session.track(1, 3, [[10, 10, 60, 20]])
    await session.track(2, 3, [[10, 40, 60, 20], [70, 40, 60, 20]])
    const m = await session.match(2.95, [
      { track: 1, parts: [0], candidates: [{ dx: 0, dy: 4, scale: 1 }] },
      { track: 2, parts: [0, 1], candidates: [{ dx: 0, dy: 4, scale: 1 }, { dx: 0, dy: 0, scale: 1 }] }
    ])
    expect(m).toEqual([
      { track: 1, parts: [0.82], best: { dx: 0, dy: 4, scale: 1 }, second: 0.31 },
      { track: 2, parts: [0.82, 0.82], best: { dx: 0, dy: 4, scale: 1 }, second: 0.31 }
    ])
    await session.close()
    expect(sent('match')).toHaveLength(1)
    expect(sent().map((l) => l.op)).toEqual(['open', 'followOpen', 'track', 'track', 'match', 'closeSession'])
    expect(sent('track').every((t) => (t as unknown as { session: number }).session === session.id)).toBe(true)
  })

  it('222. Partial reads: the fake helper answers partial for a read; its unread areas are read as extra reads, and when those fail too each is a failed read', async () => {
    const helper = await opened({ reads: { '1': { lines: ['first'], partial: [[0, 500, 960, 540], [960, 500, 960, 540]] }, '2': { error: 'read' }, '3': { lines: ['rest'] } } })
    const first = await read(helper, 5)
    expect(first.result.partial).toEqual([[0, 500, 960, 540], [960, 500, 960, 540]])
    helper.release(first.id)
    // The scan reads each unread area at the same frame.
    const extra = await Promise.allSettled(first.result.partial!.map((a) => helper.read({ video, key: 0, t: 5, areas: [a] }, new AbortController().signal)))
    const failedReads = extra.filter((r) => r.status === 'rejected').length
    expect(failedReads).toBe(1)
    expect(sent('read').slice(1).map((r) => (r as unknown as { areas: number[][] }).areas)).toEqual([[[0, 500, 960, 540]], [[960, 500, 960, 540]]])
  })
})
