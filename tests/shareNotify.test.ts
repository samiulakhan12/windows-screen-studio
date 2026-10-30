import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, app: { getPath: () => os.tmpdir(), isPackaged: false } }))

import { beginJob, disposeJobs, setExportedFileCheck, setNotificationExtras, setTaskbarPort, type NotificationExtra, type TaskbarPort } from '../src/main/longJobs'

/** "Export finished" with the share buttons (F-22, docs/design/share.md §2.7). */
describe('Export finished notification extras', () => {
  let dir = ''
  let notes: { extras?: NotificationExtra[] }[] = []
  const port: TaskbarPort = {
    setProgress: () => undefined,
    setButtons: () => undefined,
    isFocused: () => false,
    flash: () => undefined,
    notify: (_copy, handlers) => notes.push(handlers),
    keepAwake: () => undefined,
    onPower: () => undefined,
    openFile: () => undefined,
    showFile: () => undefined
  }
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-sharenote-'))
    notes = []
    setTaskbarPort(port)
  })
  afterEach(() => {
    setNotificationExtras(null)
    disposeJobs()
    setTaskbarPort(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds the share buttons for one exported file, and none for several', async () => {
    const a = path.join(dir, 'A.mp4')
    const b = path.join(dir, 'B.mp4')
    writeFileSync(a, 'x')
    writeFileSync(b, 'x')
    setExportedFileCheck((f) => f === a || f === b)
    const ran: string[] = []
    setNotificationExtras(async (file) => [{ text: 'Copy to OneDrive', run: () => ran.push(file) }])
    await beginJob({ kind: 'export' }).end({ kind: 'done', files: [a] })
    expect(notes[0].extras?.map((x) => x.text)).toEqual(['Copy to OneDrive'])
    notes[0].extras![0].run()
    expect(ran).toEqual([a])
    await beginJob({ kind: 'export' }).end({ kind: 'done', files: [a, b] })
    expect(notes[1].extras).toBeUndefined()
  })

  it('shows the notification as before when the extras fail or there are none', async () => {
    const a = path.join(dir, 'A.mp4')
    writeFileSync(a, 'x')
    setExportedFileCheck((f) => f === a)
    setNotificationExtras(async () => Promise.reject(new Error('boom')))
    await beginJob({ kind: 'export' }).end({ kind: 'done', files: [a] })
    setNotificationExtras(null)
    await beginJob({ kind: 'export' }).end({ kind: 'done', files: [a] })
    expect(notes).toHaveLength(2)
    expect(notes.every((n) => n.extras === undefined)).toBe(true)
  })
})
