import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JobKind, JobOutcome, NotificationCopy } from '../src/shared/jobs/longJobs'

/*
 * Find's job ends with its own notification (docs/design/auto-blur.md §2.6; §17.1 test 197), and
 * every other job's ending says what it said at 37f9355 (tests/fixtures/autoblur-job-notices-37f9355.json,
 * made from that commit's notificationFor).
 */

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined, on: () => undefined }, app: { getPath: () => '' }, BrowserWindow: class {} }))
vi.mock('../src/main/security', () => ({ isAppUrl: () => true }))

const { notificationFor } = await import('../src/shared/jobs/longJobs')
const { beginJob, setTaskbarPort, disposeJobs } = await import('../src/main/longJobs')
const { privacyDoneNotice } = await import('../src/main/privacy/findIpc')

function port(focused: boolean): { notified: NotificationCopy[]; flashed: number } & Record<string, unknown> {
  const p = {
    notified: [] as NotificationCopy[],
    flashed: 0,
    setProgress: () => undefined,
    setButtons: () => undefined,
    isFocused: () => focused,
    flash: () => void p.flashed++,
    notify: (copy: NotificationCopy) => void p.notified.push(copy),
    keepAwake: () => undefined,
    onPower: () => undefined,
    openFile: () => undefined,
    showFile: () => undefined
  }
  return p
}

describe('auto-blur contracts: job notices', () => {
  it('197. Job notices: a done outcome with notice gives that notification for an analysis job when the window is not focused; every old kind and outcome gives what it gave at 37f9355', async () => {
    const notice = privacyDoneNotice(3)
    expect(notice).toEqual({ title: 'Find private info is done: 3 to review.', body: '', actions: [] })
    expect(notificationFor('analysis', { kind: 'done', notice }, [])).toBe(notice)
    expect(notificationFor('analysis', { kind: 'done' }, [])).toBeNull()
    // Through main's registry: shown only while Flown's window does not have the focus.
    const away = port(false)
    setTaskbarPort(away as never)
    await beginJob({ kind: 'analysis', name: 'Find private info' } as never).end({ kind: 'done', notice })
    expect(away.notified).toEqual([notice])
    expect(away.flashed).toBe(1)
    const here = port(true)
    setTaskbarPort(here as never)
    await beginJob({ kind: 'analysis', name: 'Find private info' } as never).end({ kind: 'done', notice })
    expect(here.notified).toEqual([])
    setTaskbarPort(null)
    disposeJobs()
    // Every other ending, as before.
    const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/autoblur-job-notices-37f9355.json'), 'utf8')) as { cases: [JobKind, JobOutcome, { path: string; bytes: number }[], string, NotificationCopy | null][] }
    expect(old.cases).toHaveLength(144)
    for (const [kind, outcome, files, name, was] of old.cases) expect(notificationFor(kind, outcome, files, name), JSON.stringify([kind, outcome, files.length, name])).toEqual(was)
  })
})
