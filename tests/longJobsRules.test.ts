import { describe, expect, it } from 'vitest'
import { JOB_TIMING, leadJob, notificationFor, taskbarState, thumbarButtons, type JobView } from '../src/shared/jobs/longJobs'
import { thumbIcon } from '../src/shared/jobs/thumbIcons'

const T0 = 1_000_000
const job = (patch: Partial<JobView>): JobView => ({ id: 'j', kind: 'export', fraction: 0.5, paused: false, pausable: true, stoppable: true, startedAt: T0, ...patch })
const later = T0 + JOB_TIMING.showAfterMs

describe('taskbarState', () => {
  it('shows the export first, then captions, then analysis', () => {
    const jobs = [job({ id: 'a', kind: 'analysis', fraction: null }), job({ id: 'c', kind: 'captions', fraction: 0.2 }), job({ id: 'e', fraction: 0.7 })]
    expect(leadJob(jobs, later)?.id).toBe('e')
    expect(taskbarState(jobs, later)).toEqual({ mode: 'normal', value: 0.7 })
    expect(taskbarState(jobs.slice(0, 2), later)).toEqual({ mode: 'normal', value: 0.2 })
    expect(taskbarState(jobs.slice(0, 1), later)).toEqual({ mode: 'indeterminate', value: 0 })
  })

  it('hides jobs younger than a second', () => {
    expect(taskbarState([job({})], later - 1)).toEqual({ mode: 'none', value: 0 })
    expect(taskbarState([job({})], later).mode).toBe('normal')
  })

  it('shows paused and unknown progress, and clamps the share', () => {
    expect(taskbarState([job({ paused: true, fraction: 0.4 })], later)).toEqual({ mode: 'paused', value: 0.4 })
    expect(taskbarState([job({ fraction: null })], later)).toEqual({ mode: 'indeterminate', value: 0 })
    expect(taskbarState([job({ fraction: 7 })], later).value).toBe(1)
    expect(taskbarState([job({ fraction: Number.NaN })], later).value).toBe(0)
  })

  it('stays red for a while after a failure, then clears', () => {
    expect(taskbarState([], T0 + 100, T0)).toEqual({ mode: 'error', value: 1 })
    expect(taskbarState([], T0 + JOB_TIMING.errorMs, T0)).toEqual({ mode: 'none', value: 0 })
  })
})

describe('thumbarButtons', () => {
  it('offers Pause and Stop while an export renders, Resume when paused', () => {
    expect(thumbarButtons([job({})], later)).toEqual([
      { action: 'pause', tooltip: 'Pause export', enabled: true },
      { action: 'stop', tooltip: 'Stop export', enabled: true }
    ])
    expect(thumbarButtons([job({ paused: true })], later)[0]).toEqual({ action: 'resume', tooltip: 'Resume export', enabled: true })
  })

  it('disables Pause while finalizing, and offers only Stop for captions', () => {
    expect(thumbarButtons([job({ pausable: false, fraction: null })], later)[0].enabled).toBe(false)
    expect(thumbarButtons([job({ kind: 'captions' })], later)).toEqual([{ action: 'stop', tooltip: 'Stop making captions', enabled: true }])
    expect(thumbarButtons([job({ kind: 'analysis', stoppable: false })], later)).toEqual([])
    expect(thumbarButtons([], later)).toEqual([])
  })
})

describe('notificationFor', () => {
  it('says what an export wrote, with Open and Show in folder for one file', () => {
    expect(notificationFor('export', { kind: 'done' }, [{ path: 'C:\\Videos\\Demo.mp4', bytes: 24_100_000 }])).toEqual({
      title: 'Export finished',
      body: 'Demo.mp4 · 24.1 MB',
      actions: ['open', 'show']
    })
    expect(notificationFor('export', { kind: 'done' }, [{ path: '/v/out/a.mp4', bytes: 1 }, { path: '/v/out/b.mp4', bytes: 1 }])).toEqual({
      title: '2 files exported',
      body: 'out',
      actions: ['show']
    })
  })

  it('says when a batch lost files or stopped early', () => {
    const files = [{ path: '/v/out/a.mp4', bytes: 1 }, { path: '/v/out/b.mp4', bytes: 1 }]
    expect(notificationFor('export', { kind: 'done', failed: 1, stopped: true }, files)?.body).toBe('out · 1 failed · stopped early')
    expect(notificationFor('export', { kind: 'done', failed: 2 }, files.slice(0, 1))?.body).toBe('a.mp4 · 1 KB · 2 failed')
  })

  it('says nothing for cancels, analyses and exports without checked files', () => {
    expect(notificationFor('export', { kind: 'cancelled' }, [])).toBeNull()
    expect(notificationFor('analysis', { kind: 'done' }, [])).toBeNull()
    expect(notificationFor('export', { kind: 'done' }, [])).toBeNull()
  })

  it('names failures by their first line, and finished captions', () => {
    expect(notificationFor('export', { kind: 'failed', message: 'The disk is full.\n\nffmpeg log' }, [])).toEqual({ title: 'Export failed', body: 'The disk is full.', actions: [] })
    expect(notificationFor('captions', { kind: 'done' }, [], 'My demo')).toEqual({ title: 'Captions are ready', body: 'My demo', actions: [] })
  })
})

describe('thumbIcon', () => {
  const lit = (px: Uint8Array, x: number, y: number): boolean => px[(y * 16 + x) * 4 + 3] === 255
  it('draws white glyphs on a transparent square', () => {
    const pause = thumbIcon('pause')
    expect(pause.length).toBe(16 * 16 * 4)
    expect(lit(pause, 5, 8) && lit(pause, 10, 8) && !lit(pause, 8, 8) && !lit(pause, 0, 0)).toBe(true)
    const stop = thumbIcon('stop')
    expect(lit(stop, 8, 8) && !lit(stop, 2, 2)).toBe(true)
    const play = thumbIcon('resume')
    expect(lit(play, 6, 8) && !lit(play, 11, 4)).toBe(true)
    for (let i = 0; i < pause.length; i += 4) expect([0, 255]).toContain(pause[i])
  })
})
