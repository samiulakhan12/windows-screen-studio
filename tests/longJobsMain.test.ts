import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, app: { getPath: () => os.tmpdir(), isPackaged: false } }))

import { beginJob, disposeJobs, jobsSnapshot, setExportedFileCheck, setTaskbarPort, type JobOwner, type PowerEvent, type TaskbarPort } from '../src/main/longJobs'
import { JOB_TIMING } from '../src/shared/jobs/longJobs'

function fakePort(focused = false) {
  const calls: { call: string; value: unknown }[] = []
  let power: ((e: PowerEvent) => void) | null = null
  let click: ((a: 'pause' | 'resume' | 'stop') => void) | null = null
  const port: TaskbarPort = {
    setProgress: (s) => calls.push({ call: 'progress', value: s }),
    setButtons: (b, onClick) => {
      click = onClick
      calls.push({ call: 'buttons', value: b })
    },
    isFocused: () => focused,
    flash: () => calls.push({ call: 'flash', value: true }),
    notify: (copy, handlers) => calls.push({ call: 'notify', value: { copy, handlers } }),
    keepAwake: (on) => calls.push({ call: 'awake', value: on }),
    onPower: (l) => {
      power = l
    },
    openFile: (f) => calls.push({ call: 'open', value: f }),
    showFile: (f) => calls.push({ call: 'show', value: f })
  }
  return { port, calls, power: (e: PowerEvent) => power!(e), click: (a: 'pause' | 'resume' | 'stop') => click!(a) }
}

function fakeOwner() {
  const sent: unknown[] = []
  const listeners = new Map<string, () => void>()
  const owner: JobOwner = {
    id: 7,
    send: (_c, v) => sent.push(v),
    isDestroyed: () => false,
    once: (e, l) => listeners.set(e, l),
    removeListener: (e) => listeners.delete(e)
  }
  return { owner, sent, fire: (e: string) => listeners.get(e)?.() }
}

let dir = ''
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-jobs-'))
})
afterEach(() => {
  disposeJobs()
  setTaskbarPort(null)
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('long jobs registry', () => {
  it('keeps the PC awake while a job runs and shows it on the taskbar after a second', async () => {
    const f = fakePort()
    setTaskbarPort(f.port)
    const job = beginJob({ kind: 'export', pausable: true, owner: fakeOwner().owner })
    expect(f.calls.filter((c) => c.call === 'awake').map((c) => c.value)).toEqual([true])
    expect(f.calls.filter((c) => c.call === 'progress').pop()?.value).toEqual({ mode: 'none', value: 0 })
    job.update({ fraction: 0.25, pausable: true, paused: false })
    vi.advanceTimersByTime(JOB_TIMING.showAfterMs + 20)
    expect(f.calls.filter((c) => c.call === 'progress').pop()?.value).toEqual({ mode: 'normal', value: 0.25 })
    await job.end({ kind: 'cancelled' })
    expect(f.calls.filter((c) => c.call === 'awake').map((c) => c.value)).toEqual([true, false])
    expect(jobsSnapshot()).toEqual([])
  })

  it('sends taskbar commands to the page that owns the job, and Stop to a main-side job', () => {
    const f = fakePort()
    setTaskbarPort(f.port)
    const o = fakeOwner()
    const job = beginJob({ kind: 'export', pausable: true, owner: o.owner })
    vi.advanceTimersByTime(JOB_TIMING.showAfterMs + 20)
    f.click('pause')
    expect(o.sent).toEqual([{ id: job.id, action: 'pause' }])
    disposeJobs()
    const stop = vi.fn()
    beginJob({ kind: 'captions', onStop: stop })
    vi.advanceTimersByTime(JOB_TIMING.showAfterMs + 20)
    f.click('stop')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('pauses on sleep and resumes 3 s after waking only the jobs it paused, whatever progress arrives meanwhile', () => {
    const f = fakePort()
    setTaskbarPort(f.port)
    const a = fakeOwner()
    const b = fakeOwner()
    const running = beginJob({ kind: 'export', pausable: true, owner: a.owner })
    const userPaused = beginJob({ kind: 'export', pausable: true, owner: b.owner })
    userPaused.update({ paused: true })
    f.power('suspend')
    expect(a.sent).toEqual([{ id: running.id, action: 'pause', sleep: true }])
    expect(b.sent).toEqual([])
    // A progress message the page sent before it got the pause.
    running.update({ paused: false, fraction: 0.3 })
    f.power('resume')
    vi.advanceTimersByTime(JOB_TIMING.resumeAfterSleepMs - 10)
    expect(a.sent.length).toBe(1)
    vi.advanceTimersByTime(20)
    expect(a.sent).toEqual([
      { id: running.id, action: 'pause', sleep: true },
      { id: running.id, action: 'resume', sleep: true }
    ])
    expect(b.sent).toEqual([])
  })

  it('keeps running on lock (hands-off), and never pauses a job that cannot pause', () => {
    const f = fakePort()
    setTaskbarPort(f.port)
    const o = fakeOwner()
    beginJob({ kind: 'export', pausable: false, owner: o.owner })
    f.power('lock-screen')
    f.power('suspend')
    expect(o.sent).toEqual([])
  })

  it('ends the job when its page goes away', () => {
    setTaskbarPort(fakePort().port)
    const o = fakeOwner()
    beginJob({ kind: 'export', owner: o.owner })
    o.fire('render-process-gone')
    expect(jobsSnapshot()).toEqual([])
  })

  it('notifies only when the window is in the background, and opens only exported files', async () => {
    const file = path.join(dir, 'Demo.mp4')
    writeFileSync(file, Buffer.alloc(2_000_000))
    setExportedFileCheck((f) => f === file)
    const focused = fakePort(true)
    setTaskbarPort(focused.port)
    await beginJob({ kind: 'export' }).end({ kind: 'done', files: [file] })
    expect(focused.calls.some((c) => c.call === 'notify')).toBe(false)

    const away = fakePort(false)
    setTaskbarPort(away.port)
    await beginJob({ kind: 'export' }).end({ kind: 'done', files: [path.join(dir, 'not-exported.mp4'), file] })
    const note = away.calls.find((c) => c.call === 'notify')!.value as { copy: { title: string; body: string }; handlers: { open: () => void; show: () => void } }
    expect(note.copy.title).toBe('Export finished')
    expect(note.copy.body).toBe('Demo.mp4 · 2.0 MB')
    note.handlers.open()
    note.handlers.show()
    expect(away.calls.filter((c) => c.call === 'open' || c.call === 'show').map((c) => c.value)).toEqual([file, file])
    expect(away.calls.some((c) => c.call === 'flash')).toBe(true)

    const none = fakePort(false)
    setTaskbarPort(none.port)
    await beginJob({ kind: 'export' }).end({ kind: 'done', files: [path.join(dir, 'other.mp4')] })
    expect(none.calls.some((c) => c.call === 'notify')).toBe(false)
  })

  it('turns the taskbar red after a failure, for a while', async () => {
    const f = fakePort(true)
    setTaskbarPort(f.port)
    await beginJob({ kind: 'export' }).end({ kind: 'failed', message: 'x' })
    expect(f.calls.filter((c) => c.call === 'progress').pop()?.value).toEqual({ mode: 'error', value: 1 })
    vi.advanceTimersByTime(JOB_TIMING.errorMs + 20)
    expect(f.calls.filter((c) => c.call === 'progress').pop()?.value).toEqual({ mode: 'none', value: 0 })
  })
})
