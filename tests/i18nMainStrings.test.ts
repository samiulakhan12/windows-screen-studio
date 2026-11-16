/**
 * Test 75 (docs/design/output-and-languages.md §16.3): main's messages (dialogs, file filters,
 * notifications, taskbar tooltips) in English equal the main-process strings the English guard's tour
 * recorded at S2 (tests/e2e/english-guard/baseline.json, screens' `main`), entry by entry, and the
 * ones the tour does not reach equal today's English.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { t } from '../src/shared/i18n/t'
import { JOB_WORDS, notificationFor, thumbarButtons, type JobView } from '../src/shared/jobs/longJobs'

vi.mock('electron', () => ({
  app: { getPath: () => require('node:os').tmpdir(), on: () => undefined, getGPUFeatureStatus: () => ({}) },
  dialog: {},
  ipcMain: { handle: () => undefined },
  shell: {}
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => null }))

const { saveFilters } = await import('../src/main/exportIpc')

interface Recorded {
  kind: string
  title?: string
  message?: string
  body?: string
  buttons?: string[]
  filters?: string[]
  actions?: string[]
  tooltips?: string[]
}
const baseline = JSON.parse(readFileSync(path.join(__dirname, 'e2e/english-guard/baseline.json'), 'utf8')) as { screens: { name: string; main?: Recorded[] }[] }
const recorded = (screen: string): Recorded[] => baseline.screens.find((s) => s.name === screen)?.main ?? []
/** The tour masks a size inside a main string (uiTour.cjs, maskMain). */
const masked = (s: string): string => s.replace(/\b\d+(?:\.\d+)? (?:bytes|KB|MB|GB)\b/g, '‹masked›')
const filterText = (f: Electron.FileFilter): string => `${f.name}: ${f.extensions.join(',')}`

describe('test 75: main’s English equals what the guard tour recorded', () => {
  it('records something on every screen this test reads', () => {
    for (const screen of ['editor', 'export-running', 'export-done', 'export-error', 'home-confirm']) expect(recorded(screen).length).toBeGreaterThan(0)
  })

  it('the export’s save dialog: title and file filter', () => {
    for (const screen of ['export-running', 'export-error']) {
      const save = recorded(screen).find((r) => r.kind === 'save')!
      expect(save.title).toBe(t('main.export.saveTitle'))
      expect(save.filters).toEqual([filterText(saveFilters().mp4)])
    }
  })

  it('the export notifications: finished and failed', () => {
    const done = recorded('export-done').find((r) => r.kind === 'notify')!
    const made = notificationFor('export', { kind: 'done' }, [{ path: 'C:\\Users\\me\\Videos\\Product tour.mp4', bytes: 2_800_000 }])!
    expect({ kind: 'notify', title: made.title, body: masked(made.body), actions: made.actions }).toEqual(done)
    const failed = recorded('export-error').find((r) => r.kind === 'notify')!
    const reason = t('errors.exportIpc.couldNotWriteTo', { value: '/tmp/flown-english-guard-home/no such folder' })
    const told = notificationFor('export', { kind: 'failed', message: reason }, [])!
    expect({ kind: 'notify', title: told.title, body: told.body, actions: told.actions }).toEqual(failed)
  })

  it('the delete question Electron shows for the page in English (askConfirm is window.confirm there)', () => {
    const asked = recorded('home-confirm').find((r) => r.kind === 'message')!
    expect(asked.message).toBe(t('home.library.deleteQuestion', { name: 'Phone demo' }))
    expect(recorded('home-confirm').find((r) => r.kind === 'page-confirm')!.message).toBe(asked.message)
  })

  it('the taskbar: no buttons without a job, and today’s tooltips with one', () => {
    expect(recorded('editor').find((r) => r.kind === 'taskbar')!.tooltips).toEqual(thumbarButtons([], 0).map((b) => b.tooltip))
    const job = (kind: JobView['kind'], extra: Partial<JobView> = {}): JobView => ({ id: kind, kind, fraction: 0.5, paused: false, pausable: true, stoppable: true, startedAt: 0, ...extra })
    expect(thumbarButtons([job('export')], 5000).map((b) => b.tooltip)).toEqual(['Pause export', 'Stop export'])
    expect(thumbarButtons([job('export', { paused: true })], 5000).map((b) => b.tooltip)).toEqual(['Resume export', 'Stop export'])
    expect(thumbarButtons([job('captions')], 5000).map((b) => b.tooltip)).toEqual(['Stop making captions'])
    expect(thumbarButtons([job('ai')], 5000).map((b) => b.tooltip)).toEqual(['Stop writing with AI on this PC'])
    expect({ ...JOB_WORDS }).toEqual({ export: 'Exporting', captions: 'Making captions', analysis: 'Reading the recording', ai: 'Writing with AI on this PC' })
  })

  it('the notifications and filters the tour does not reach keep today’s English', () => {
    expect(notificationFor('captions', { kind: 'done' }, [], '')).toEqual({ title: 'Captions are ready', body: 'Your recording has captions now.', actions: [] })
    expect(notificationFor('captions', { kind: 'failed', message: '' }, [])).toEqual({ title: 'Captions failed', body: 'Something went wrong.', actions: [] })
    const files = [
      { path: 'C:\\Videos\\Batch\\a.mp4', bytes: 1 },
      { path: 'C:\\Videos\\Batch\\b.mp4', bytes: 1 }
    ]
    expect(notificationFor('export', { kind: 'done', failed: 1, stopped: true }, files)).toEqual({ title: '2 files exported', body: 'Batch · 1 failed · stopped early', actions: ['show'] })
    expect(notificationFor('export', { kind: 'done', failed: 2 }, files.slice(0, 1))!.body).toBe('a.mp4 · 1 KB · 2 failed')
    expect(Object.values(saveFilters()).map(filterText)).toEqual(['MP4 video: mp4', 'GIF: gif', 'WebM video: webm', 'QuickTime movie: mov', 'M4A audio: m4a', 'WAV audio: wav', 'PNG image: png'])
    expect(t('main.export.thumbnailTitle')).toBe('Save thumbnail')
  })
})
