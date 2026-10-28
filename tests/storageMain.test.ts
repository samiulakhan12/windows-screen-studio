import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupTarget, folderSize, runCleanup, scanProjects } from '../src/main/storage'
import { MAX_USED, StorageStore } from '../src/main/storageStore'
import { DAY_MS, type StorageRules } from '../src/shared/storage/rules'

let home = ''
let root = ''
let bin = ''
const NOW = Date.now()
const RULES: StorageRules = { cacheDays: 30, autoCaches: false, removeDays: 90 }

function project(id: string, opts: { days?: number; bytes?: number; cache?: number; manifest?: boolean; noProject?: boolean } = {}): string {
  const dir = path.join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'screen.mp4'), Buffer.alloc(opts.bytes ?? 1000))
  if (!opts.noProject) {
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: `Name of ${id}`, createdAt: new Date(NOW - (opts.days ?? 0) * DAY_MS).toISOString() }))
    const t = new Date(NOW - (opts.days ?? 0) * DAY_MS)
    utimesSync(path.join(dir, 'project.json'), t, t)
  }
  if (opts.cache) {
    mkdirSync(path.join(dir, '.cache', 'transcript-parts'), { recursive: true })
    writeFileSync(path.join(dir, '.cache', 'transcript-parts', 'p.json'), Buffer.alloc(opts.cache))
  }
  if (opts.manifest) writeFileSync(path.join(dir, 'recording.json'), '{}')
  return dir
}

const trashTo = () => {
  const moved: string[] = []
  const trash = vi.fn(async (file: string) => {
    moved.push(file)
    renameSync(file, path.join(bin, `${moved.length}`))
  })
  return { trash, moved }
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'ssw-storage-'))
  root = path.join(home, 'Videos', 'Flown')
  bin = path.join(home, 'bin')
  mkdirSync(root, { recursive: true })
  mkdirSync(bin)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('scan', () => {
  it('measures every recording, its cache, and whether it is finished', async () => {
    project('rec-a', { bytes: 5000, cache: 700, days: 10 })
    project('rec-b', { noProject: true, bytes: 300 })
    project('rec-c', { manifest: true })
    mkdirSync(path.join(root, 'not a project'))
    writeFileSync(path.join(root, 'loose.txt'), 'x')
    const list = await scanProjects(root, { 'rec-c': new Date(NOW).toISOString() })
    const a = list.find((r) => r.id === 'rec-a')!
    expect(list.map((r) => r.id).sort()).toEqual(['rec-a', 'rec-b', 'rec-c'])
    expect(a.name).toBe('Name of rec-a')
    expect(a.cacheBytes).toBe(700)
    expect(a.bytes).toBeGreaterThanOrEqual(5700)
    expect(Math.abs(a.lastUsed - (NOW - 10 * DAY_MS))).toBeLessThan(2000)
    expect(list.find((r) => r.id === 'rec-b')!.finished).toBe(false)
    expect(list.find((r) => r.id === 'rec-c')!.finished).toBe(false)
    expect(list[0].id).toBe('rec-a')
  })

  it('never follows links, and caps deep or wide folders', async () => {
    const outside = path.join(home, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'big'), Buffer.alloc(1_000_000))
    const dir = project('rec-l', { bytes: 10 })
    symlinkSync(outside, path.join(dir, 'link'))
    symlinkSync(outside, path.join(root, 'rec-linked'))
    const list = await scanProjects(root, {})
    expect(list.map((r) => r.id)).toEqual(['rec-l'])
    expect(list[0].bytes).toBeLessThan(10_000)
    let deep = dir
    for (let i = 0; i < 10; i++) deep = path.join(deep, `d${i}`)
    mkdirSync(deep, { recursive: true })
    writeFileSync(path.join(deep, 'f'), Buffer.alloc(100))
    expect((await folderSize(dir, undefined, { maxDepth: 8, maxEntries: 20_000 })).capped).toBe(true)
    expect((await folderSize(dir, undefined, { maxDepth: 30, maxEntries: 3 })).capped).toBe(true)
  })
})

describe('clean-up', () => {
  it('moves to the Recycle Bin only what the rules find again, never deleting', async () => {
    project('rec-old', { days: 200, cache: 100 })
    project('rec-cache', { days: 40, cache: 500 })
    project('rec-new', { days: 1, cache: 500 })
    const { trash, moved } = trashTo()
    const before = vi.fn(async () => undefined)
    const r = await runCleanup(
      root,
      [
        { id: 'rec-old', action: 'remove' },
        { id: 'rec-cache', action: 'caches' },
        { id: 'rec-new', action: 'remove' },
        { id: 'rec-new', action: 'caches' },
        { id: '..', action: 'remove' },
        { id: 'rec-old', action: 'remove' }
      ],
      RULES,
      {},
      new Set(),
      NOW,
      { trash, beforeRemove: before }
    )
    expect(moved).toEqual([path.join(root, 'rec-old'), path.join(root, 'rec-cache', '.cache')])
    expect(r.moved.map((i) => i.id)).toEqual(['rec-old', 'rec-cache'])
    expect(r.freed).toBeGreaterThan(500)
    expect(before).toHaveBeenCalledWith('rec-old')
    expect(existsSync(path.join(root, 'rec-cache', 'project.json'))).toBe(true)
    expect(existsSync(path.join(root, 'rec-new', '.cache'))).toBe(true)
  })

  it('skips the open recording and recordings used lately (storage.json)', async () => {
    project('rec-open', { days: 200 })
    project('rec-seen', { days: 200 })
    const { trash, moved } = trashTo()
    await runCleanup(
      root,
      [
        { id: 'rec-open', action: 'remove' },
        { id: 'rec-seen', action: 'remove' }
      ],
      RULES,
      { 'rec-seen': new Date(NOW - DAY_MS).toISOString() },
      new Set(['rec-open']),
      NOW,
      { trash }
    )
    expect(moved).toEqual([])
  })

  it('reports a Recycle Bin failure and keeps the files (no permanent delete)', async () => {
    project('rec-old', { days: 200 })
    const trash = vi.fn(async () => {
      throw new Error('No Recycle Bin on this drive')
    })
    const r = await runCleanup(root, [{ id: 'rec-old', action: 'remove' }], RULES, {}, new Set(), NOW, { trash })
    expect(r.failed.map((f) => [f.item.id, f.reason])).toEqual([['rec-old', 'No Recycle Bin on this drive']])
    expect(existsSync(path.join(root, 'rec-old', 'screen.mp4'))).toBe(true)
  })

  it('refuses a target that is a link or leads outside the projects folder', async () => {
    const outside = path.join(home, 'outside')
    mkdirSync(path.join(outside, '.cache'), { recursive: true })
    symlinkSync(outside, path.join(root, 'rec-link'))
    await expect(cleanupTarget(root, 'rec-link', 'remove')).rejects.toThrow(/projects folder/)
    const dir = project('rec-x', { days: 200 })
    symlinkSync(path.join(outside, '.cache'), path.join(dir, '.cache'))
    await expect(cleanupTarget(root, 'rec-x', 'caches')).rejects.toThrow(/projects folder/)
    await expect(cleanupTarget(root, '../x', 'remove')).rejects.toThrow(/Invalid/)
    expect(await cleanupTarget(root, 'rec-x', 'remove')).toBe(dir)
  })
})

describe('storage.json', () => {
  it('starts with the defaults, saves rules and openings, and keeps them bounded', () => {
    const file = path.join(home, 'storage.json')
    const s = new StorageStore(file)
    expect(s.rules).toEqual({ cacheDays: 30, autoCaches: false, removeDays: null })
    s.setRules({ cacheDays: 60, removeDays: 365, autoCaches: true })
    s.noteUsed('rec-a', new Date(NOW))
    s.noteUsed('../bad')
    const again = new StorageStore(file)
    expect(again.rules).toEqual({ cacheDays: 60, autoCaches: true, removeDays: 365 })
    expect(Object.keys(again.used)).toEqual(['rec-a'])
    const used = Object.fromEntries(Array.from({ length: MAX_USED + 5 }, (_, i) => [`rec-${i}`, new Date(NOW + i).toISOString()]))
    writeFileSync(file, JSON.stringify({ version: 1, rules: again.rules, used, lastAutoClean: null }))
    const full = new StorageStore(file)
    full.noteUsed('rec-latest', new Date(NOW + 1e6))
    const kept = Object.keys(JSON.parse(readFileSync(file, 'utf8')).used)
    expect(kept.length).toBe(MAX_USED)
    expect(kept).toContain('rec-latest')
    expect(kept).not.toContain('rec-0')
  })

  it('reads a broken file as the defaults', () => {
    const file = path.join(home, 'storage.json')
    writeFileSync(file, '{ not json')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(new StorageStore(file).rules.cacheDays).toBe(30)
  })
})
