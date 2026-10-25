// The start-up move from "Screen Studio for Windows" to Flown (src/main/brandMigration.ts), on
// real temp folders.
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFreshUserData, migrateRecordings, migrateUserData, planUserData } from '../src/main/brandMigration'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-brand-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Makes fs.renameSync fail (EPERM, as for a file another program holds open) for sources matching `match`. */
function failRenames(match: (from: string) => boolean): void {
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (match(String(from))) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' })
    rename(from, to)
  })
}

function write(file: string, text = 'x'): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** A recording folder as the app writes it. */
function recording(root: string, id: string, name = id): void {
  write(path.join(root, id, 'project.json'), JSON.stringify({ id, name }))
  write(path.join(root, id, 'screen.mp4'), 'video')
}

const read = (file: string): string => readFileSync(file, 'utf8')

describe('userData', () => {
  function oldUserData(appData: string): string {
    const dir = path.join(appData, 'Screen Studio for Windows')
    write(path.join(dir, 'Local State'), '{"os_crypt":{"encrypted_key":"KEY"}}')
    write(path.join(dir, 'ai-providers.json'), '{"providers":["sealed"]}')
    write(path.join(dir, 'app-settings.json'), '{"hotkeys":{}}')
    return dir
  }

  it('moves the whole old folder, safeStorage key included, when Flown has none', () => {
    const appData = tmp()
    const from = oldUserData(appData)
    const to = path.join(appData, 'Flown')
    expect(planUserData(from, to)).toBe('move')
    expect(migrateUserData(from, to)).toEqual({ plan: 'move', dir: to })
    expect(existsSync(from)).toBe(false)
    expect(read(path.join(to, 'Local State'))).toContain('KEY')
    expect(read(path.join(to, 'ai-providers.json'))).toContain('sealed')
  })

  it('replaces the folder Electron created empty before the main script ran (and its lock files)', () => {
    const appData = tmp()
    const from = oldUserData(appData)
    const to = path.join(appData, 'Flown')
    mkdirSync(to)
    expect(isFreshUserData(to)).toBe(true)
    write(path.join(to, 'SingletonLock'), '')
    write(path.join(to, 'Crashpad', 'settings.dat'))
    expect(isFreshUserData(to)).toBe(true)
    expect(migrateUserData(from, to).dir).toBe(to)
    expect(readdirSync(to).sort()).toEqual(['Local State', 'ai-providers.json', 'app-settings.json'])
  })

  it('is idempotent and never touches a Flown folder that holds settings', () => {
    const appData = tmp()
    const from = oldUserData(appData)
    const to = path.join(appData, 'Flown')
    migrateUserData(from, to)
    expect(planUserData(from, to)).toBe('none')
    expect(migrateUserData(from, to)).toEqual({ plan: 'none', dir: to })

    // An old folder that comes back (an old copy restored) while Flown has its own settings.
    oldUserData(appData)
    write(path.join(to, 'app-settings.json'), '{"flown":true}')
    expect(planUserData(from, to)).toBe('keep-new')
    expect(migrateUserData(from, to)).toEqual({ plan: 'keep-new', dir: to })
    expect(read(path.join(to, 'app-settings.json'))).toBe('{"flown":true}')
    expect(existsSync(path.join(from, 'Local State'))).toBe(true)
  })

  it('keeps using the old folder in place when it cannot be moved, and moves it on a later start', () => {
    const appData = tmp()
    const from = oldUserData(appData)
    const to = path.join(appData, 'Flown')
    mkdirSync(to) // as Electron leaves it
    failRenames(() => true)
    const r = migrateUserData(from, to)
    vi.restoreAllMocks()
    expect(r.plan).toBe('move')
    expect(r.dir).toBe(from)
    expect(r.error).toBeTruthy()
    expect(read(path.join(from, 'Local State'))).toContain('KEY')
    expect(migrateUserData(from, to)).toEqual({ plan: 'move', dir: to })
    expect(read(path.join(to, 'Local State'))).toContain('KEY')
  })

  it('does nothing without an old folder', () => {
    const appData = tmp()
    expect(migrateUserData(path.join(appData, 'Screen Studio for Windows'), path.join(appData, 'Flown'))).toEqual({ plan: 'none', dir: path.join(appData, 'Flown') })
  })
})

describe('recordings', () => {
  it('renames Videos\\Screen Studio for Windows to Videos\\Flown when Flown has no folder', () => {
    const videos = tmp()
    const from = path.join(videos, 'Screen Studio for Windows')
    const to = path.join(videos, 'Flown')
    recording(from, 'rec-20260101-100000')
    recording(from, 'rec-20260102-100000')
    write(path.join(from, 'notes.txt'), 'the user put this here')
    expect(migrateRecordings(from, to)).toEqual({ legacyRoots: [], moved: 1, renamed: {}, errors: [] })
    expect(existsSync(from)).toBe(false)
    expect(readdirSync(to).sort()).toEqual(['notes.txt', 'rec-20260101-100000', 'rec-20260102-100000'])
    expect(migrateRecordings(from, to)).toEqual({ legacyRoots: [], moved: 0, renamed: {}, errors: [] })
  })

  it('merges into an existing Flown folder, giving a clashing id a -2 suffix, and removes the emptied old folder', () => {
    const videos = tmp()
    const from = path.join(videos, 'Screen Studio for Windows')
    const to = path.join(videos, 'Flown')
    recording(from, 'rec-1', 'old one')
    recording(from, 'rec-2', 'old two')
    recording(to, 'rec-2', 'new two')
    const r = migrateRecordings(from, to)
    expect(r).toEqual({ legacyRoots: [], moved: 2, renamed: { 'rec-2': 'rec-2-2' }, errors: [] })
    expect(existsSync(from)).toBe(false)
    expect(readdirSync(to).sort()).toEqual(['rec-1', 'rec-2', 'rec-2-2'])
    expect(JSON.parse(read(path.join(to, 'rec-2', 'project.json'))).name).toBe('new two')
    expect(JSON.parse(read(path.join(to, 'rec-2-2', 'project.json'))).name).toBe('old two')
  })

  it('finishes a merge a crash interrupted', () => {
    const videos = tmp()
    const from = path.join(videos, 'Screen Studio for Windows')
    const to = path.join(videos, 'Flown')
    recording(to, 'rec-1') // moved before the crash
    recording(from, 'rec-3') // not yet
    expect(migrateRecordings(from, to)).toMatchObject({ legacyRoots: [], moved: 1, errors: [] })
    expect(readdirSync(to).sort()).toEqual(['rec-1', 'rec-3'])
  })

  it('keeps listing the old folder when the whole folder cannot be renamed, after moving what it can', () => {
    const videos = tmp()
    const from = path.join(videos, 'Screen Studio for Windows')
    const to = path.join(videos, 'Flown')
    recording(from, 'rec-1')
    recording(from, 'rec-busy') // a file in it is open in another program
    failRenames((src) => src === from || src.endsWith('rec-busy'))
    const r = migrateRecordings(from, to)
    expect(r.moved).toBe(0) // Flown had no folder and the folder rename failed: nothing to merge into
    expect(r.legacyRoots).toEqual([from])
    expect(r.errors).toHaveLength(1)

    // Next start: Flown's folder exists now (the library created it), so entries are merged.
    mkdirSync(to)
    const next = migrateRecordings(from, to)
    expect(next.moved).toBe(1)
    expect(next.legacyRoots).toEqual([from])
    expect(readdirSync(to)).toEqual(['rec-1'])
    expect(readdirSync(from)).toEqual(['rec-busy'])

    vi.restoreAllMocks()
    expect(migrateRecordings(from, to)).toMatchObject({ moved: 1, legacyRoots: [], errors: [] })
    expect(existsSync(from)).toBe(false)
    expect(readdirSync(to).sort()).toEqual(['rec-1', 'rec-busy'])
  })

  it('does nothing without an old folder', () => {
    const videos = tmp()
    expect(migrateRecordings(path.join(videos, 'Screen Studio for Windows'), path.join(videos, 'Flown'))).toEqual({ legacyRoots: [], moved: 0, renamed: {}, errors: [] })
  })
})

describe('library with a legacy root', () => {
  it('lists and opens recordings left in the old folder, and creates new ones in Flown’s', async () => {
    vi.resetModules()
    const videos = tmp()
    vi.doMock('electron', () => ({ app: { getPath: () => videos } }))
    const projects = await import('../src/main/projects')
    const legacy = path.join(videos, 'Screen Studio for Windows')
    const project = (id: string, createdAt: string) => JSON.stringify({ id, name: id, createdAt, duration: 3 })
    write(path.join(legacy, 'rec-old', 'project.json'), project('rec-old', '2026-01-01T00:00:00.000Z'))
    write(path.join(legacy, 'rec-both', 'project.json'), project('rec-both', '2026-01-02T00:00:00.000Z'))
    write(path.join(videos, 'Flown', 'rec-both', 'project.json'), project('rec-both', '2026-01-03T00:00:00.000Z'))
    write(path.join(legacy, 'rec-cut', 'screen.webm'), 'raw') // an unfinished recording
    projects.setLegacyProjectRoots([legacy])
    try {
      expect(projects.projectsRoot()).toBe(path.join(videos, 'Flown'))
      expect(projects.projectDir('rec-old')).toBe(path.join(legacy, 'rec-old'))
      expect(projects.projectDir('rec-both')).toBe(path.join(videos, 'Flown', 'rec-both'))
      const list = await projects.listProjects()
      expect(list.map((p) => [p.id, p.dir])).toEqual([
        ['rec-both', path.join(videos, 'Flown', 'rec-both')],
        ['rec-old', path.join(legacy, 'rec-old')]
      ])
      expect((await projects.readProject('rec-old')).name).toBe('rec-old')
      expect((await projects.listUnfinished(new Set())).map((u) => u.dir)).toEqual([path.join(legacy, 'rec-cut')])
      const created = await projects.createProjectDir(new Date(2026, 0, 5, 10, 0, 0))
      expect(path.dirname(created.dir)).toBe(path.join(videos, 'Flown'))
    } finally {
      projects.setLegacyProjectRoots([])
      vi.doUnmock('electron')
    }
  })
})
