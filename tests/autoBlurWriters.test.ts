import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Cover, Project } from '../src/shared/types'

/*
 * The writers of project.json and Home's summaries (docs/design/auto-blur.md §4.6, §9 row 17; §17.1
 * tests 8, 9 and 14), on real folders in a temporary userData and Videos folder.
 */

const h = vi.hoisted(() => ({ root: '' }))
h.root = mkdtempSync(path.join(tmpdir(), 'flown-autoblur-writers-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), on: () => undefined, getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: () => undefined, on: () => undefined },
  dialog: {},
  shell: {},
  protocol: {},
  clipboard: {},
  BrowserWindow: class {}
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: () => undefined } }) }))

const { saveProjectNow } = await import('../src/main/projectsIpc')
const { writeProject, projectDir, projectsRoot, listProjects } = await import('../src/main/projects')
const { duplicateProject } = await import('../src/main/projectCopy')
const { saveVersion, renameVersion, readVersion, hashProject, versionsDir } = await import('../src/main/versions')
const { projectFileText } = await import('../src/main/projectFile')
const { migrateProject } = await import('../src/shared/engine/project')
const { versionSummary } = await import('../src/shared/editor/versions')
const { LEGACY_PREFIX, hidesSomething, thumbCovers, thumbTime } = await import('../src/shared/privacy/coverData')
const { coverOf, key, base, oldFixtures } = await import('./autoBlurFixtures')

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

/** A project with two covers (one moving) and a blur shape. */
function covered(id: string): Project {
  const covers: Cover[] = [coverOf('c1', 0.5, 4, [key(0.5, 0.1, 0.1, 0.2, 0.05), key(2, 0.3, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'g1' }), coverOf('c2', 1, 3, [key(1, 0.6, 0.6, 0.1, 0.1)])]
  return { ...base(id, 8), createdAt: '2026-11-20T10:00:00.000Z', covers }
}

const legacyIn = (text: string): string[] => ((JSON.parse(text) as Project).shapes ?? []).map((s) => s.id).filter((id) => id.startsWith(LEGACY_PREFIX))

describe('auto-blur contracts: writers', () => {
  it('8. Every writer (saveProjectNow, writeProject, makeCopy, saveVersion and renameVersion) writes the legacy shapes after the shapes; without covers a project is written as JSON.stringify(project, null, 2) and a version body as JSON.stringify(project)', async () => {
    rmSync(projectsRoot(), { recursive: true, force: true })
    // saveProjectNow: the editor's save.
    const saved = covered('rec-20261120-100000')
    mkdirSync(projectDir(saved.id), { recursive: true })
    saveProjectNow(saved)
    const savedText = readFileSync(path.join(projectDir(saved.id), 'project.json'), 'utf8')
    expect(savedText).toBe(projectFileText(saved))
    // The legacy shapes come after the project's own shapes: a pixelate and a box per piece of each cover.
    expect(legacyIn(savedText)).toEqual(['~cover:c1:0:p', '~cover:c1:0:r', '~cover:c1:1:p', '~cover:c1:1:r', '~cover:c2:0:p', '~cover:c2:0:r'])
    // writeProject: a new project.
    const fresh = covered('rec-20261120-100100')
    mkdirSync(projectDir(fresh.id), { recursive: true })
    await writeProject(fresh)
    expect(legacyIn(readFileSync(path.join(projectDir(fresh.id), 'project.json'), 'utf8')).length).toBeGreaterThanOrEqual(4)
    // makeCopy: Duplicate and the other copies.
    writeFileSync(path.join(projectDir(saved.id), 'screen.mp4'), 'video')
    const copy = await duplicateProject(saved.id, saved, { now: new Date(2026, 10, 21, 9, 0, 0) })
    const copyText = readFileSync(path.join(projectDir(copy.id), 'project.json'), 'utf8')
    expect(legacyIn(copyText).length).toBeGreaterThanOrEqual(4)
    expect(migrateProject(JSON.parse(copyText)).covers).toEqual(saved.covers)
    // saveVersion's body, and renameVersion keeps it as written.
    const dir = projectDir(saved.id)
    const v = saveVersion(dir, saved.id, saved, { name: 'With covers', now: new Date(Date.UTC(2026, 10, 20, 11)) }).saved!
    const file = path.join(versionsDir(dir)!, readdirSync(versionsDir(dir)!).find((f) => f.startsWith(v.id))!)
    const body = readFileSync(file, 'utf8')
    expect(body).toContain(`"project":${projectFileText(saved, 'compact')}`)
    expect(legacyIn(JSON.stringify(JSON.parse(body).project)).length).toBeGreaterThanOrEqual(4)
    renameVersion(dir, v.id, 'Renamed')
    const renamed = JSON.parse(readFileSync(file, 'utf8'))
    expect(renamed.project).toEqual(JSON.parse(body).project)
    expect((await readVersion(dir, saved.id, v.id)).project.covers).toEqual(saved.covers)
    // Without covers: byte for byte as before, in every writer.
    for (const f of oldFixtures().slice(0, 4)) {
      const p = migrateProject(structuredClone(f.raw))
      expect(projectFileText(p)).toBe(JSON.stringify(p, null, 2))
      expect(projectFileText(p, 'compact')).toBe(JSON.stringify(p))
    }
    const plain = { ...base('rec-20261120-100200', 6), createdAt: '2026-11-20T10:02:00.000Z' }
    mkdirSync(projectDir(plain.id), { recursive: true })
    saveProjectNow(plain)
    expect(readFileSync(path.join(projectDir(plain.id), 'project.json'), 'utf8')).toBe(JSON.stringify(plain, null, 2))
    await writeProject(plain)
    expect(readFileSync(path.join(projectDir(plain.id), 'project.json'), 'utf8')).toBe(JSON.stringify(plain, null, 2))
    const pv = saveVersion(projectDir(plain.id), plain.id, plain, { name: 'Plain', now: new Date(Date.UTC(2026, 10, 20, 12)) }).saved!
    const pvFile = path.join(versionsDir(projectDir(plain.id))!, readdirSync(versionsDir(projectDir(plain.id))!).find((f) => f.startsWith(pv.id))!)
    expect(readFileSync(pvFile, 'utf8')).toContain(`"project":${JSON.stringify(plain)}}`)
  })

  it('9. Hash and summary: hashProject and versionSummary of a project equal those of the same project after a write and a read through projectFileText and migrateProject', () => {
    const p = migrateProject(JSON.parse(JSON.stringify(covered('rec-20261120-100300'))))
    const back = migrateProject(JSON.parse(projectFileText(p)))
    expect(back).toEqual(p)
    expect(hashProject(back)).toBe(hashProject(p))
    expect(versionSummary(back)).toEqual(versionSummary(p))
    const compact = migrateProject(JSON.parse(projectFileText(p, 'compact')))
    expect(hashProject(compact)).toBe(hashProject(p))
  })

  it('14. thumbCovers and hidesSomething: the boxes of covers and of blur and pixelate shapes active about the thumbnail; a project with only a bleep hides something and has no boxes; listProjects adds thumbCovers only when there are boxes', async () => {
    rmSync(projectsRoot(), { recursive: true, force: true })
    const t = thumbTime(8)
    const withCover: Project = { ...covered('rec-20261120-100400'), covers: [coverOf('c', t - 0.05, t + 2, [key(t - 0.05, 0.2, 0.2, 0.1, 0.1)])] }
    const withBlur: Project = { ...base('rec-20261120-100500', 8), createdAt: '2026-11-20T10:05:00.000Z', shapes: [{ id: 'h', start: 0, end: 3, kind: 'blur', x: 0.5, y: 0.5, w: 0.2, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.5 }] }
    const withBleep: Project = { ...base('rec-20261120-100600', 8), createdAt: '2026-11-20T10:06:00.000Z', bleeps: [{ id: 'b', start: 1, end: 1.4, word: 'x', sound: 'tone' }] }
    const plain: Project = { ...base('rec-20261120-100700', 8), createdAt: '2026-11-20T10:07:00.000Z' }
    expect(hidesSomething(withBleep)).toBe(true)
    expect(thumbCovers(withBleep, t - 0.1, t + 0.1)).toEqual([])
    expect(hidesSomething(plain)).toBe(false)
    expect(hidesSomething({ ...plain, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } })).toBe(false)
    for (const p of [withCover, withBlur, withBleep, plain]) {
      mkdirSync(projectDir(p.id), { recursive: true })
      writeFileSync(path.join(projectDir(p.id), 'project.json'), projectFileText(p))
    }
    const list = await listProjects()
    const byId = new Map(list.map((s) => [s.id, s]))
    expect(byId.get(withCover.id)!.thumbCovers).toEqual(thumbCovers(withCover, t - 0.1, t + 0.1))
    expect(byId.get(withCover.id)!.thumbCovers).toHaveLength(1)
    expect(byId.get(withBlur.id)!.thumbCovers).toEqual([{ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }])
    expect(byId.get(withBleep.id)).not.toHaveProperty('thumbCovers')
    expect(byId.get(plain.id)).not.toHaveProperty('thumbCovers')
    expect(Object.keys(byId.get(plain.id)!)).toEqual(['id', 'name', 'createdAt', 'duration', 'dir'])
  })
})
