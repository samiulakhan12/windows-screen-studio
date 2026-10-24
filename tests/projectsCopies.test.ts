// Audit F1, F2, F6: a copied project or recording folder (a backup, a OneDrive conflict copy)
// is its own project; and cursor.json is replaced atomically, never rewritten in place.
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => root.dir } }))

import * as projects from '../src/main/projects'
import { createProject, migrateCursor } from '../src/shared/engine/project'

const dirOf = (id: string): string => path.join(projects.projectsRoot(), id)

function seedProject(id: string, name: string): void {
  mkdirSync(dirOf(id), { recursive: true })
  const p = createProject({
    id,
    name,
    duration: 2,
    width: 320,
    height: 240,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null, target: 'screen', fps: 60 }
  })
  writeFileSync(path.join(dirOf(id), 'project.json'), JSON.stringify(p))
}

beforeEach(() => {
  root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-copies-'))
})

describe('copied folders', () => {
  it('lists, loads and deletes a copied project as itself, never as the original (F2)', async () => {
    seedProject('rec-A', 'original A')
    cpSync(dirOf('rec-A'), dirOf('rec-A-PC1'), { recursive: true })
    const list = await projects.listProjects()
    expect(list.map((p) => [p.id, p.dir]).sort()).toEqual([
      ['rec-A', dirOf('rec-A')],
      ['rec-A-PC1', dirOf('rec-A-PC1')]
    ])
    expect((await projects.readProject('rec-A-PC1')).id).toBe('rec-A-PC1')
    // What Home does with the copy's card.
    await projects.deleteProject(list.find((p) => p.dir.endsWith('rec-A-PC1'))!.id)
    expect(existsSync(dirOf('rec-A'))).toBe(true)
    expect(existsSync(dirOf('rec-A-PC1'))).toBe(false)
  })

  it("reads a copied recording's manifest under the folder's id, so recovering it never touches the original (F1)", async () => {
    const { id } = await projects.createProjectDir(new Date(0))
    const m: projects.RecordingManifest = {
      version: 1,
      id,
      createdAt: new Date(0).toISOString(),
      status: 'interrupted',
      error: null,
      method: 'chromium',
      sourceKind: 'screen',
      region: null,
      startedAt: 0,
      width: 320,
      height: 240,
      hasAudio: false,
      hasWebcam: false,
      webcamFps: 30,
      webcamOffset: 0,
      audioOffset: 0,
      duration: 2
    }
    await projects.writeManifest(m)
    cpSync(dirOf(id), dirOf(`${id}-backup`), { recursive: true })
    expect((await projects.readManifest(`${id}-backup`))?.id).toBe(`${id}-backup`)
    expect((await projects.readManifest(id))?.id).toBe(id)
  })
})

describe('writeCursor (F6)', () => {
  it('replaces cursor.json with a new file instead of truncating and rewriting it in place', async () => {
    seedProject('rec-C', 'C')
    const before = { ...migrateCursor(undefined), valid: true, samples: [{ t: 0, x: 0.5, y: 0.5 }] }
    await projects.writeCursor('rec-C', before)
    // A second name for the same file: an in-place rewrite changes what it reads, a rename does not.
    const old = path.join(root.dir, 'old-cursor.json')
    linkSync(path.join(dirOf('rec-C'), 'cursor.json'), old)
    await projects.writeCursor('rec-C', { ...before, samples: [{ t: 1, x: 0.1, y: 0.2 }] })
    expect(JSON.parse(readFileSync(old, 'utf8')).samples).toEqual(before.samples)
    expect((await projects.readCursor('rec-C')).samples).toEqual([{ t: 1, x: 0.1, y: 0.2 }])
    expect(existsSync(path.join(dirOf('rec-C'), 'cursor.json.tmp'))).toBe(false)
  })
})
