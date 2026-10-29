import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { StorageCleanupResult, StorageOverview } from '../src/shared/api/storage'
import type { CleanupItem } from '../src/shared/storage/rules'

/*
 * Settings › Storage after Duplicate (docs/design/hands-off.md §2.7, vertical-video.md §4.7):
 * the media Duplicate hard-links into a copy take their bytes once, so the total counts them once,
 * and removing one of the two recordings frees only its own files, also when the other is in a
 * legacy root.
 */

const h = vi.hoisted(() => ({ home: '', bin: '', binned: 0, handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>() }))
h.home = mkdtempSync(path.join(tmpdir(), 'ssw-storage-dup-'))
h.bin = path.join(h.home, 'bin')
mkdirSync(h.bin)

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.home, name), on: () => undefined },
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  // The Recycle Bin keeps the files (and their names) elsewhere on the drive.
  shell: { trashItem: async (file: string) => renameSync(file, path.join(h.bin, `${++h.binned}`)) },
  dialog: {},
  protocol: {},
  clipboard: {},
  session: {},
  BrowserWindow: class {}
}))
vi.mock('../src/main/analysisIpc', () => ({ stopAnalyses: async () => undefined }))

const { duplicateProject } = await import('../src/main/projectCopy')
const { projectDir, setLegacyProjectRoots } = await import('../src/main/projects')
const { registerStorageIpc } = await import('../src/main/storageIpc')
const { createProject } = await import('../src/shared/engine/project')
const { DAY_MS } = await import('../src/shared/storage/rules')

afterAll(() => rmSync(h.home, { recursive: true, force: true }))

const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href } }
const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(h.handlers.get(channel)!(appEvent, ...args) as T)

/** Long unused: older than the 90 days of the removal rule. */
const OLD = new Date(Date.now() - 200 * DAY_MS)
const MEDIA = { 'screen.mp4': 600_000, 'mic.m4a': 90_000 }
const MEDIA_BYTES = Object.values(MEDIA).reduce((n, b) => n + b, 0)

/** A finished recording, not used for 200 days, and a copy of it made by Duplicate then. */
async function recordingAndCopy(id: string, copyMade: Date): Promise<{ source: string; copy: string }> {
  const dir = projectDir(id)
  mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(MEDIA)) writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 7))
  writeFileSync(path.join(dir, 'cursor.json'), '[]')
  const project = {
    ...createProject({ id, name: 'Demo', duration: 8, width: 1280, height: 720, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
    createdAt: OLD.toISOString()
  }
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project))
  const made = await duplicateProject(id, project, { now: copyMade })
  expect(made.linked).toBe(true)
  for (const p of [dir, projectDir(made.id)]) utimesSync(path.join(p, 'project.json'), OLD, OLD)
  return { source: id, copy: made.id }
}

describe('Settings › Storage after Duplicate', () => {
  registerStorageIpc()

  it('counts the linked media once, and a removal frees only what no recording that stays still holds', async () => {
    await call('storage:setRules', { cacheDays: 30, autoCaches: false, removeDays: 90 })
    const first = await recordingAndCopy('rec-20250101-090000', new Date(OLD.getTime() + 60_000))
    const second = await recordingAndCopy('rec-20250102-090000', new Date(OLD.getTime() + 120_000))
    expect(statSync(path.join(projectDir(first.copy), 'screen.mp4')).ino).toBe(statSync(path.join(projectDir(first.source), 'screen.mp4')).ino)

    const overview = await call<StorageOverview>('storage:scan')
    const size = (id: string): number => overview.recordings.find((r) => r.id === id)!.bytes
    // Each folder shows what it holds, media included; the total counts each pair's media once.
    for (const id of [first.source, first.copy, second.source, second.copy]) expect(size(id)).toBeGreaterThan(MEDIA_BYTES)
    const own = (id: string): number => size(id) - MEDIA_BYTES
    expect(overview.bytes).toBe(own(first.source) + own(first.copy) + own(second.source) + own(second.copy) + 2 * MEDIA_BYTES)
    for (const id of [first.source, first.copy]) {
      const shared = overview.recordings.find((r) => r.id === id)!.shared ?? []
      expect(shared.reduce((n, f) => n + f.bytes, 0)).toBe(MEDIA_BYTES)
    }

    // The review offers each recording at the bytes it frees by itself.
    const plan = await call<CleanupItem[]>('storage:plan')
    const offered = (id: string): number => plan.find((i) => i.id === id && i.action === 'remove')!.bytes
    for (const id of [first.source, first.copy, second.source, second.copy]) expect(offered(id)).toBe(own(id))

    // The first original alone: its copy keeps the media, so they are not freed.
    const alone = await call<StorageCleanupResult>('storage:clean', [{ id: first.source, action: 'remove' }])
    expect(alone.moved.map((i) => i.id)).toEqual([first.source])
    expect(alone.freed).toBe(own(first.source))
    expect(readFileSync(path.join(projectDir(first.copy), 'screen.mp4')).length).toBe(MEDIA['screen.mp4'])

    // The second pair together: the media go with the last of them.
    const both = await call<StorageCleanupResult>('storage:clean', [
      { id: second.source, action: 'remove' },
      { id: second.copy, action: 'remove' }
    ])
    expect(both.moved.map((i) => i.id).sort()).toEqual([second.source, second.copy].sort())
    expect(both.freed).toBe(own(second.source) + own(second.copy) + MEDIA_BYTES)

    // What is left: the first copy, whose media the Recycle Bin still shares, counted once.
    const after = await call<StorageOverview>('storage:scan')
    expect(after.recordings.map((r) => r.id)).toEqual([first.copy])
    expect(after.bytes).toBe(size(first.copy))

    // A name in the Recycle Bin holds nothing: the copy now has the media to itself, so it is
    // offered at its full size, and removing it frees that.
    expect(after.recordings[0].shared).toBeUndefined()
    const last = await call<CleanupItem[]>('storage:plan')
    expect(last.map((i) => [i.action, i.id, i.bytes, i.shared])).toEqual([['remove', first.copy, size(first.copy), undefined]])
    const gone = await call<StorageCleanupResult>('storage:clean', [{ id: first.copy, action: 'remove' }])
    expect(gone.moved.map((i) => i.id)).toEqual([first.copy])
    expect(gone.freed).toBe(size(first.copy))
  })

  it('a recording in a legacy root still holds the media it shares with its copy', async () => {
    // Left in Videos\Screen Studio for Windows by the start-up move (brandMigration.ts), still listed.
    const legacy = path.join(h.home, 'videos', 'Screen Studio for Windows')
    const id = 'rec-20250103-090000'
    mkdirSync(path.join(legacy, id), { recursive: true })
    setLegacyProjectRoots([legacy])
    try {
      const pair = await recordingAndCopy(id, new Date(OLD.getTime() + 180_000))
      expect(path.dirname(projectDir(pair.source))).toBe(legacy)

      // Storage lists only the copy, with the media its original still holds.
      const overview = await call<StorageOverview>('storage:scan')
      expect(overview.recordings.map((r) => r.id)).toEqual([pair.copy])
      const copy = overview.recordings[0]
      expect(copy.shared?.map((f) => [f.bytes, f.links, f.here]).sort()).toEqual(Object.values(MEDIA).map((b) => [b, 2, 1]).sort())

      // So removing the copy is offered at, and frees, only its own files; the original keeps the media.
      const plan = await call<CleanupItem[]>('storage:plan')
      expect(plan.map((i) => [i.action, i.id, i.bytes])).toEqual([['remove', pair.copy, copy.bytes - MEDIA_BYTES]])
      const gone = await call<StorageCleanupResult>('storage:clean', [{ id: pair.copy, action: 'remove' }])
      expect(gone.moved.map((i) => i.id)).toEqual([pair.copy])
      expect(gone.freed).toBe(copy.bytes - MEDIA_BYTES)
      expect(readFileSync(path.join(legacy, id, 'screen.mp4')).length).toBe(MEDIA['screen.mp4'])
    } finally {
      setLegacyProjectRoots([])
    }
  })
})
