import { describe, expect, it, vi } from 'vitest'
import type { FindRequest, FindResult, FoundCover } from '../src/shared/api/privacy'
import type { NotificationCopy } from '../src/shared/jobs/longJobs'

/*
 * Find's done notification (docs/design/auto-blur.md §2.6; §17.1 test 256): when Flown's window does
 * not have the focus as Find ends, Windows shows main.jobs.privacyDone with the count of private
 * items to review; with the focus, nothing. Through Find's own channel in main, its scan a fake.
 */

const h = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(), found: [] as FoundCover[] }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  app: { getPath: () => '', isPackaged: false, getAppPath: () => '', on: () => undefined },
  BrowserWindow: class {}
}))
vi.mock('../src/main/security', () => ({ isAppUrl: (url: string) => url === 'file:///flown/index.html' }))
vi.mock('../src/main/recording/toolbarWindow', () => ({ isToolbarVisible: () => false }))
vi.mock('../src/main/projects', () => ({ readProject: async (id: string) => ({ id, duration: 20 }) }))
vi.mock('../src/main/privacy/scan', () => ({
  runFind: async (req: FindRequest): Promise<FindResult> => ({ ok: true, projectId: req.projectId, requestId: req.requestId, found: h.found, failedReads: 0, thinSpans: '', stopped: false, readTo: null, reader: 'pp-ocrv6-tiny+small-careful-long' }),
  followCover: async () => ({ ok: false, reason: 'failed' }),
  underCover: async () => ({ ok: false, reason: 'failed' }),
  coverEverywhere: async () => ({ ok: false, reason: 'failed' }),
  forgetReads: () => undefined
}))

const { PRIVACY_CHANNELS } = await import('../src/shared/api/privacy')
const { registerFindIpc } = await import('../src/main/privacy/findIpc')
const { setTaskbarPort, disposeJobs } = await import('../src/main/longJobs')
registerFindIpc()

const cover = (group: string, start: number): FoundCover => ({ kind: 'email', score: 0.9, group, start, end: start + 1, path: `${start} 0.1 0.1 0.2 0.05`, color: '#202020' })

/** Runs one Find through main's channel with the window focused or not; what Windows was asked to show. */
async function findEnds(focused: boolean, groups: number): Promise<NotificationCopy[]> {
  const notified: NotificationCopy[] = []
  const port = { setProgress: () => undefined, setButtons: () => undefined, isFocused: () => focused, flash: () => undefined, notify: (c: NotificationCopy) => void notified.push(c), keepAwake: () => undefined, onPower: () => undefined, openFile: () => undefined, showFile: () => undefined }
  setTaskbarPort(port as never)
  // Two covers of a group are one private item to review.
  h.found = Array.from({ length: groups }, (_v, i) => [cover(`g${i}`, i * 2), cover(`g${i}`, i * 2 + 1)]).flat()
  const request: FindRequest = { projectId: 'nd', requestId: `r${groups}${focused ? 'f' : 'a'}`, kinds: ['email'], regions: ['US'], names: [], neverHide: [] }
  const r = (await h.handlers.get(PRIVACY_CHANNELS.find)!({ senderFrame: { url: 'file:///flown/index.html' } }, request)) as FindResult
  expect(r.ok).toBe(true)
  setTaskbarPort(null)
  disposeJobs()
  return notified
}

describe('auto-blur P5: Find done', () => {
  it('256. Done notification: when the window is not focused as Find ends, main.jobs.privacyDone is shown with the count to review; when it is focused, none', async () => {
    expect(await findEnds(false, 3)).toEqual([{ title: 'Find private info is done: 3 to review.', body: '', actions: [] }])
    expect(await findEnds(true, 3)).toEqual([])
    expect(await findEnds(false, 0)).toEqual([{ title: 'Find private info is done: nothing to review.', body: '', actions: [] }])
    expect(await findEnds(false, 1)).toEqual([{ title: 'Find private info is done: 1 to review.', body: '', actions: [] }])
  })
})
