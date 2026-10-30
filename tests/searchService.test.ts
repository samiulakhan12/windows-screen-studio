import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_READ_BYTES, SEARCH_TIMING, SearchService, type SearchDisk } from '../src/main/search/searchService'
import { SEARCH_CHANNELS } from '../src/shared/api/search'
import { serializeIndex } from '../src/shared/search/indexFile'
import { SEARCH_INDEX_VERSION, type SearchStatus } from '../src/shared/search/types'

const ROOT = '/videos/Flown'
const LEGACY = '/videos/Old'
const INDEX = '/data/search/index.json'

/** A tiny disk: files by path, with mtimes. */
class FakeDisk implements SearchDisk {
  files = new Map<string, { text: string; mtimeMs: number }>()
  dirs = new Map<string, string[]>()
  reads: string[] = []
  writes: string[] = []
  failWrites = false
  clock = 1000

  put(file: string, value: unknown): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    this.files.set(file, { text, mtimeMs: ++this.clock })
    const dir = path.posix.dirname(path.posix.dirname(file))
    const name = path.posix.basename(path.posix.dirname(file))
    const list = this.dirs.get(dir) ?? []
    if (!list.includes(name)) list.push(name)
    this.dirs.set(dir, list)
  }

  project(id: string, project: Record<string, unknown>, root = ROOT): void {
    this.put(`${root}/${id}/project.json`, { version: 2, id, createdAt: '2026-10-01T00:00:00.000Z', duration: 60, clips: [{ id: 'c', start: 0, end: 60, speed: 1 }], ...project })
  }

  removeFolder(id: string, root = ROOT): void {
    this.files.delete(`${root}/${id}/project.json`)
    this.dirs.set(root, (this.dirs.get(root) ?? []).filter((n) => n !== id))
  }

  async listDirs(dir: string): Promise<string[]> {
    return [...(this.dirs.get(dir) ?? [])]
  }

  async stat(file: string): Promise<{ mtimeMs: number; size: number } | null> {
    const f = this.files.get(file)
    return f ? { mtimeMs: f.mtimeMs, size: Buffer.byteLength(f.text) } : null
  }

  async readText(file: string, max: number): Promise<string | null> {
    this.reads.push(file)
    const f = this.files.get(file)
    return f && Buffer.byteLength(f.text) <= max ? f.text : null
  }

  writeText(file: string, text: string): void {
    if (this.failWrites) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    this.writes.push(text)
    this.files.set(file, { text, mtimeMs: ++this.clock })
  }
}

const said = (start: number, text: string): Record<string, unknown> => ({ id: `s${start}`, start, end: start + 2, text })

function setup(disk = new FakeDisk()): { disk: FakeDisk; service: SearchService; logs: string[]; statuses: SearchStatus[] } {
  const logs: string[] = []
  const statuses: SearchStatus[] = []
  const service = new SearchService({
    disk,
    roots: () => [ROOT, LEGACY],
    indexFile: INDEX,
    yieldTurn: () => Promise.resolve(),
    log: (l) => logs.push(l),
    onStatus: (s) => statuses.push(s)
  })
  return { disk, service, logs, statuses }
}

const ids = async (service: SearchService, q: string): Promise<string[]> => (await service.query(q)).hits.map((h) => h.id)

describe('SearchService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds from the folders, then says it is ready', async () => {
    const { disk, service, statuses } = setup()
    disk.project('rec-a', { name: 'Demo', transcript: { segments: [said(3, 'open the settings')] } })
    disk.project('rec-b', { name: 'Call' })
    disk.put(`${ROOT}/not a project/project.json`, {}) // a folder name projects never have
    disk.dirs.get(ROOT)?.push('rec-unfinished') // no project.json yet
    await service.start()
    expect(service.getStatus()).toEqual({ state: 'ready', indexed: 2, total: 2 })
    expect(statuses[0]).toEqual({ state: 'building', indexed: 0, total: 0 })
    expect(statuses.some((s) => s.state === 'building' && s.total === 3)).toBe(true)
    expect(await ids(service, 'setings')).toEqual(['rec-a'])
    const r = await service.query('settings')
    expect(r.hits[0].moments[0]).toMatchObject({ kind: 'said', start: 3 })
    expect(r.withoutTranscript).toBe(1)
  })

  it('lists the current root first: an id in both is read from it', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'New place' })
    disk.project('rec-a', { name: 'Old place' }, LEGACY)
    disk.project('rec-old', { name: 'Only old' }, LEGACY)
    await service.start()
    expect(await ids(service, 'place')).toEqual(['rec-a'])
    expect((await service.query('place')).hits[0].name).toBe('New place')
    expect(await ids(service, 'only')).toEqual(['rec-old'])
  })

  it('reads again only what changed, and drops what is gone', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Alpha' })
    disk.project('rec-b', { name: 'Beta' })
    await service.start()
    disk.reads = []
    disk.project('rec-a', { name: 'Gamma' })
    disk.removeFolder('rec-b')
    await service.reconcile()
    expect(disk.reads).toEqual([`${ROOT}/rec-a/project.json`])
    expect(await ids(service, 'gamma')).toEqual(['rec-a'])
    expect(await ids(service, 'alpha')).toEqual([])
    expect(await ids(service, 'beta')).toEqual([])
  })

  it('drops a project whose project.json is gone or no longer parses', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Alpha' })
    disk.project('rec-b', { name: 'Beta' })
    await service.start()
    disk.files.delete(`${ROOT}/rec-a/project.json`)
    disk.put(`${ROOT}/rec-b/project.json`, '{ not json')
    await service.reconcile()
    expect(service.index.ids()).toEqual([])
  })

  it('reconciles before a query when the last one is older than 2 s', async () => {
    const { disk, service } = setup()
    await service.start()
    disk.project('rec-new', { name: 'Fresh' })
    expect(await ids(service, 'fresh')).toEqual([]) // just reconciled
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.reconcileAfterMs + 10)
    expect(await ids(service, 'fresh')).toEqual(['rec-new'])
  })

  it('writes the index once after changes, and loads it without reading the projects again', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Alpha', chapters: [{ id: 'c', t: 5, title: 'Intro' }] })
    await service.start()
    expect(disk.writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.writeDebounceMs)
    expect(disk.writes).toHaveLength(1)
    expect(JSON.parse(disk.writes[0]).version).toBe(SEARCH_INDEX_VERSION)

    const second = setup(disk)
    disk.reads = []
    await second.service.start()
    expect(disk.reads).toEqual([INDEX])
    expect(await ids(second.service, 'intro')).toEqual(['rec-a'])
    // Nothing changed: nothing written.
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.writeDebounceMs * 2)
    expect(disk.writes).toHaveLength(1)
  })

  it('builds again from the projects when the index file is damaged or of another version', async () => {
    for (const file of ['{ broken', JSON.stringify({ version: SEARCH_INDEX_VERSION + 1, projects: {} }), JSON.stringify([1, 2])]) {
      const disk = new FakeDisk()
      disk.project('rec-a', { name: 'Alpha' })
      disk.put(INDEX, file)
      const { service } = setup(disk)
      await service.start()
      expect(await ids(service, 'alpha')).toEqual(['rec-a'])
      await vi.advanceTimersByTimeAsync(SEARCH_TIMING.writeDebounceMs)
      expect(JSON.parse(disk.files.get(INDEX)?.text ?? '{}').version).toBe(SEARCH_INDEX_VERSION)
    }
  })

  it('reads a stale entry of the file again (its stamp differs)', async () => {
    const disk = new FakeDisk()
    disk.project('rec-a', { name: 'Current' })
    const stale = new Map([['rec-a', { stamp: 'old', name: 'Stale', createdAt: '', duration: 1, units: [{ kind: 'name' as const, start: null, end: null, text: 'Stale' }], hasTranscript: false, kept: [] }]])
    disk.put(INDEX, serializeIndex(stale))
    const { service } = setup(disk)
    await service.start()
    expect(await ids(service, 'stale')).toEqual([])
    expect(await ids(service, 'current')).toEqual(['rec-a'])
  })

  it('takes a save from the object in hand, debounced, without reading the file', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Alpha' })
    await service.start()
    disk.reads = []
    const file = `${ROOT}/rec-a/project.json`
    const base = JSON.parse(disk.files.get(file)?.text ?? '{}')
    for (const title of ['One', 'Two', 'Three']) {
      const project = { ...base, chapters: [{ id: 'c', t: 9, title }] }
      disk.put(file, project)
      service.noteSaved(project, file)
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(await ids(service, 'three')).toEqual([])
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.saveDebounceMs)
    expect(await ids(service, 'three')).toEqual(['rec-a'])
    expect(await ids(service, 'two')).toEqual([])
    // Its stamp is the saved file's: a reconcile does not read it again.
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.reconcileAfterMs + 10)
    await service.reconcile()
    expect(disk.reads).toEqual([])
  })

  it('a refresh before the start does not start the index; after it, it reconciles', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Alpha' })
    expect(await service.refresh()).toEqual({ state: 'idle', indexed: 0, total: 0 })
    expect(disk.reads).toEqual([])
    await service.start()
    disk.removeFolder('rec-a')
    expect(await service.refresh()).toMatchObject({ state: 'ready' })
    expect(service.index.ids()).toEqual([])
  })

  it('a save taken before the file is loaded is not replaced by the older stored entry', async () => {
    const disk = new FakeDisk()
    disk.project('rec-a', { name: 'Stored' })
    const first = setup(disk)
    await first.service.start()
    first.service.dispose()
    const file = `${ROOT}/rec-a/project.json`
    const saved = { ...JSON.parse(disk.files.get(file)?.text ?? '{}'), name: 'Saved later' }
    disk.put(file, saved)
    const { service } = setup(disk)
    service.noteSaved(saved, file)
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.saveDebounceMs + 10)
    disk.reads = []
    await service.start()
    expect(await ids(service, 'later')).toEqual(['rec-a'])
    expect(disk.reads).toEqual([INDEX]) // its stamp is current: not read again
  })

  it('keeps the stamp taken at the save: a later write by someone else is read again', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Alpha' })
    await service.start()
    const file = `${ROOT}/rec-a/project.json`
    const saved = { ...JSON.parse(disk.files.get(file)?.text ?? '{}'), name: 'Edited' }
    disk.put(file, saved)
    service.noteSaved(saved, file, await disk.stat(file))
    // Within the debounce, the recording's finish writes the file again.
    disk.put(file, { ...saved, name: 'Finished' })
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.saveDebounceMs + SEARCH_TIMING.reconcileAfterMs + 10)
    expect(await ids(service, 'finished')).toEqual(['rec-a'])
  })

  it('never writes the file before it was loaded (it would drop what the file holds)', async () => {
    const disk = new FakeDisk()
    disk.project('rec-a', { name: 'Alpha' })
    disk.put(INDEX, serializeIndex(new Map([['rec-z', { stamp: 'x', name: 'Zed', createdAt: '', duration: 1, units: [], hasTranscript: false, kept: [] }]])))
    const { service } = setup(disk)
    service.noteSaved({ id: 'rec-a', name: 'Alpha' }, `${ROOT}/rec-a/project.json`)
    service.dispose()
    expect(disk.writes).toEqual([])
  })

  it('ignores saves of things that are not projects', async () => {
    const { service } = setup()
    await service.start()
    service.noteSaved(null, 'x')
    service.noteSaved({ id: '../evil', name: 'x' }, 'x')
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.saveDebounceMs + 10)
    expect(service.index.ids()).toEqual([])
  })

  it('answers while building, saying so', async () => {
    const disk = new FakeDisk()
    for (let i = 0; i < 5; i++) disk.project(`rec-${i}`, { name: `Talk ${i}` })
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const realStat = disk.stat.bind(disk)
    disk.stat = async (f) => {
      await gate
      return realStat(f)
    }
    const { service } = setup(disk)
    const started = service.start()
    const r = await service.query('talk')
    expect(r.status.state).toBe('building')
    release()
    await started
    expect((await service.query('talk')).hits).toHaveLength(5)
  })

  it('keeps working when the index cannot be written, and tries again', async () => {
    const { disk, service, logs } = setup()
    disk.project('rec-a', { name: 'Alpha' })
    disk.failWrites = true
    await service.start()
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.writeDebounceMs)
    expect(logs.some((l) => l.includes('EBUSY'))).toBe(true)
    disk.failWrites = false
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.writeDebounceMs)
    expect(disk.writes).toHaveLength(1)
    expect(await ids(service, 'alpha')).toEqual(['rec-a'])
  })

  it('writes pending saves when disposed', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Alpha' })
    await service.start()
    service.noteSaved({ id: 'rec-a', name: 'Renamed' }, `${ROOT}/rec-a/project.json`)
    service.dispose()
    expect(disk.writes).toHaveLength(1)
    expect(disk.writes[0]).toContain('Renamed')
  })

  it('skips project files over the read limit', async () => {
    const { disk, service } = setup()
    disk.project('rec-a', { name: 'Huge' })
    const realStat = disk.stat.bind(disk)
    disk.stat = async (f) => {
      const st = await realStat(f)
      return st && f.includes('rec-a') ? { ...st, size: MAX_READ_BYTES + 1 } : st
    }
    await service.start()
    expect(service.index.ids()).toEqual([])
  })

  it('never logs a query or indexed text', async () => {
    const { disk, service, logs } = setup()
    disk.project('rec-a', { name: 'Secret plan', transcript: { segments: [said(1, 'the password is swordfish')] }, script: { text: 'private notes' } })
    disk.put(INDEX, '{ broken')
    await service.start()
    await service.query('swordfish')
    await service.query('private')
    disk.failWrites = true
    await vi.advanceTimersByTimeAsync(SEARCH_TIMING.writeDebounceMs)
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) expect(line).not.toMatch(/secret|swordfish|password|private|plan/i)
  })
})

describe('search IPC contract', () => {
  it('the preload uses the channels of SEARCH_CHANNELS', () => {
    const preload = readFileSync(path.join(__dirname, '../src/preload/search.ts'), 'utf8')
    for (const channel of Object.values(SEARCH_CHANNELS)) expect(preload).toContain(`'${channel}'`)
    // Types only from shared code: the sandboxed preload bundle has no other imports.
    expect(preload).not.toMatch(/import \{[^}]*\} from '\.\.\/shared/)
  })
})
