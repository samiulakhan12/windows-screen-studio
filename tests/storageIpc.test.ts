import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { StorageCleanupResult } from '../src/shared/api/storage'
import { APP_NAME } from '../src/shared/brand'
import { DAY_MS } from '../src/shared/storage/rules'

const home = mkdtempSync(path.join(os.tmpdir(), 'ssw-storage-ipc-'))
const root = path.join(home, 'Videos', APP_NAME)
const bin = path.join(home, 'bin')
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
let binned = 0

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(home, name === 'videos' ? 'Videos' : name) },
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn), on: () => undefined },
  // The Recycle Bin: slow, as Windows is with many files.
  shell: {
    trashItem: async (file: string) => {
      await new Promise((r) => setTimeout(r, 20))
      renameSync(file, path.join(bin, `${++binned}`))
    }
  }
}))
vi.mock('../src/main/security', () => ({ isAppUrl: () => true }))
vi.mock('../src/main/analysisIpc', () => ({ stopAnalyses: async () => undefined }))

const { registerStorageIpc } = await import('../src/main/storageIpc')

afterAll(() => rmSync(home, { recursive: true, force: true }))

function project(id: string): void {
  const dir = path.join(root, id)
  mkdirSync(path.join(dir, '.cache'), { recursive: true })
  writeFileSync(path.join(dir, 'screen.mp4'), Buffer.alloc(1000))
  writeFileSync(path.join(dir, '.cache', 'part.json'), Buffer.alloc(500))
  const t = new Date(Date.now() - 40 * DAY_MS)
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: id, createdAt: t.toISOString() }))
  utimesSync(path.join(dir, 'project.json'), t, t)
}

describe('storage:clean', () => {
  it('runs one clean-up at a time: a second one started meanwhile never reports items the first moved as failed', async () => {
    mkdirSync(bin, { recursive: true })
    const ids = ['rec-1', 'rec-2', 'rec-3', 'rec-4']
    ids.forEach(project)
    registerStorageIpc()
    const clean = (): Promise<StorageCleanupResult> => handlers.get('storage:clean')!({ senderFrame: { url: 'app://x' } }, ids.map((id) => ({ id, action: 'caches' }))) as Promise<StorageCleanupResult>
    const [a, b] = await Promise.all([clean(), clean()])
    expect(a.failed).toEqual([])
    expect(b.failed).toEqual([])
    expect([...a.moved, ...b.moved].map((i) => i.id).sort()).toEqual(ids)
    expect(readdirSync(bin).length).toBe(4)
  })
})
