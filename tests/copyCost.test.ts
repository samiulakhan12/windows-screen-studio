import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

/*
 * What copies of a project cost on disk (docs/design/smart-tools.md §8.5 step 6; §22.1 tests 57 and
 * 60), on real folders: linked outside OneDrive and not inside, the bytes one copy writes, the free
 * space, the checks of the id; the panel's space line and its block; and the library's summaries
 * saying what each copy was made from.
 */

const h = vi.hoisted(() => ({ root: '' }))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-copy-cost-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), on: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  dialog: {},
  shell: {},
  protocol: {},
  clipboard: {},
  BrowserWindow: class {}
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => null }))

const { copyCost } = await import('../src/main/clips/copyCost')
const { listProjects, projectDir, projectsRoot } = await import('../src/main/projects')
const { createProject } = await import('../src/shared/engine/project')
const RUN = '../src/renderer/src/clips/clipsRun'
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
type CopyCost = import('../src/shared/api/projects').CopyCost
const { copySpace, SPARE_BYTES } = (await import(/* @vite-ignore */ RUN)) as { copySpace(cost: CopyCost, n: number): { text: string; blocked: boolean }; SPARE_BYTES: number }
type Project = import('../src/shared/types').Project

afterAll(() => rmSync(h.root, { recursive: true, force: true }))
afterEach(() => {
  delete process.env.OneDrive
  delete process.env.OneDriveConsumer
  delete process.env.OneDriveCommercial
})

const SOURCE = 'rec-20260101-090000'

function project(id: string, over: Partial<Project> = {}): Project {
  return {
    ...createProject({ id, name: id, duration: 60, width: 1280, height: 720, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
    createdAt: `2026-01-0${id.endsWith('1') ? 2 : 3}T09:00:00.000Z`,
    ...over
  }
}

/** A recording folder: media of 1,000 + 500 bytes, small files of 50 + 20 + 7, and files a copy leaves out. */
function seed(id = SOURCE): string {
  rmSync(projectsRoot(), { recursive: true, force: true })
  const dir = projectDir(id)
  mkdirSync(path.join(dir, '.cache', 'transcript-parts'), { recursive: true })
  mkdirSync(path.join(dir, 'versions'), { recursive: true })
  writeFileSync(path.join(dir, 'screen.mp4'), Buffer.alloc(1000))
  writeFileSync(path.join(dir, 'mic.m4a'), Buffer.alloc(500))
  writeFileSync(path.join(dir, 'cursor.json'), Buffer.alloc(50))
  writeFileSync(path.join(dir, '.cache', 'speech.json'), Buffer.alloc(20))
  writeFileSync(path.join(dir, 'background.png'), Buffer.alloc(7))
  // Left out by a copy: not counted.
  writeFileSync(path.join(dir, 'versions', 'v1.json'), Buffer.alloc(4000))
  writeFileSync(path.join(dir, '.cache', 'transcript-parts', 'part-1.json'), Buffer.alloc(3000))
  writeFileSync(path.join(dir, 'notes.txt'), Buffer.alloc(2000))
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project(id)))
  return dir
}

describe('copyCost (test 57)', () => {
  it('outside OneDrive the media are linked: a copy writes only its small files', async () => {
    seed()
    const cost = await copyCost(SOURCE)
    expect(cost.linked).toBe(true)
    expect(cost.bytes).toBe(50 + 20 + 7)
    expect(cost.free).toBeGreaterThan(0)
  })

  it('inside OneDrive nothing is linked: a copy writes the media too', async () => {
    seed()
    process.env.OneDrive = path.join(h.root, 'videos')
    const cost = await copyCost(SOURCE)
    expect(cost.linked).toBe(false)
    expect(cost.bytes).toBe(1000 + 500 + 50 + 20 + 7)
  })

  it('a link in the folder is not followed; the source folder is never written', async () => {
    const dir = seed()
    const outside = path.join(h.root, 'outside.bin')
    writeFileSync(outside, Buffer.alloc(9999))
    symlinkSync(outside, path.join(dir, 'webcam.mp4'))
    process.env.OneDrive = path.join(h.root, 'videos')
    expect((await copyCost(SOURCE)).bytes).toBe(1577)
  })

  it('refuses an id that is not a project’s, and a project whose folder is gone', async () => {
    seed()
    await expect(copyCost('../evil')).rejects.toThrow(/Invalid project id/)
    await expect(copyCost(42)).rejects.toThrow(/Invalid project id/)
    await expect(copyCost('rec-20990101-000000')).rejects.toThrow("The recording's files could not be read.")
  })

  it('the panel says the copies share the files, or what each takes, and blocks when n × bytes + 64 MB > free', () => {
    const GB = 1e9
    expect(copySpace({ linked: true, bytes: 80_000, free: 50 * GB }, 3)).toEqual({ text: "The copies share this video's files: they take almost no space.", blocked: false })
    expect(copySpace({ linked: false, bytes: 1.2 * GB, free: 50 * GB }, 3)).toEqual({ text: 'Each copy takes 1.2 GB: files in a OneDrive folder cannot be shared.', blocked: false })
    expect(copySpace({ linked: false, bytes: 1.2 * GB, free: 2.1 * GB }, 3)).toEqual({ text: 'These 3 copies need 3.6 GB; 2.1 GB is free.', blocked: true })
    // The edge: exactly enough room with 64 MB to spare fits; a byte less does not.
    const bytes = 1e8
    expect(copySpace({ linked: false, bytes, free: 2 * bytes + SPARE_BYTES }, 2).blocked).toBe(false)
    expect(copySpace({ linked: false, bytes, free: 2 * bytes + SPARE_BYTES - 1 }, 2).blocked).toBe(true)
    expect(copySpace({ linked: false, bytes: 2 * GB, free: 1 * GB }, 1).text).toBe('This copy needs 2.0 GB; 1.0 GB is free.')
  })
})

describe('the library knows what each copy was made from (test 60)', () => {
  it('listProjects gives copyOf and clip; other projects have neither', async () => {
    rmSync(projectsRoot(), { recursive: true, force: true })
    const write = (p: Project): void => {
      mkdirSync(projectDir(p.id), { recursive: true })
      writeFileSync(path.join(projectDir(p.id), 'project.json'), JSON.stringify(p))
    }
    write(project('rec-20260101-000001'))
    write(project('rec-20260101-000002', { copyOf: { id: 'rec-20260101-000001', name: 'a' }, clipOf: { kind: 'moment', start: 1, end: 20 } }))
    write(project('rec-20260101-000003', { copyOf: { id: 'rec-20260101-000001', name: 'a' } }))
    const list = await listProjects()
    const byId = new Map(list.map((p) => [p.id, p]))
    expect(byId.get('rec-20260101-000001')).not.toHaveProperty('copyOf')
    expect(byId.get('rec-20260101-000001')).not.toHaveProperty('clip')
    expect(byId.get('rec-20260101-000002')).toMatchObject({ copyOf: { id: 'rec-20260101-000001', name: 'a' }, clip: true })
    expect(byId.get('rec-20260101-000003')).toMatchObject({ copyOf: { id: 'rec-20260101-000001' } })
    expect(byId.get('rec-20260101-000003')).not.toHaveProperty('clip')
  })
})
