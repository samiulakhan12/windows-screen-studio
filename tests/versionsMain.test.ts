import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalJson, deleteVersion, hashProject, listVersions, readVersion, renameVersion, saveVersion, versionsDir, VersionError } from '../src/main/versions'
import { restoreVersion, VERSION_ID_RE, VERSION_LIMITS } from '../src/shared/editor/versions'
import type { Project } from '../src/shared/types'
import { p20, zoom } from './groupFixture'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-versions-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 30, 10, minute))
const edit = (n: number): Project => p20({ zooms: Array.from({ length: n }, (_, i) => zoom(`z${i}`, i, i + 0.5)) })
const folder = (): string => path.join(dir, 'versions')

describe('saving and listing', () => {
  it('lists nothing without a versions folder, and creates none by listing', () => {
    expect(listVersions(dir)).toEqual([])
    expect(fs.existsSync(folder())).toBe(false)
  })

  it('keeps a named version: a file with its meta and the project, then the index', () => {
    const r = saveVersion(dir, 'p20', edit(2), { name: '  v1 for client ', now: at(0) })
    expect(r.saved).toMatchObject({ name: 'v1 for client', auto: false, createdAt: at(0).toISOString() })
    expect(r.saved!.summary.zooms).toBe(2)
    expect(VERSION_ID_RE.test(r.saved!.id)).toBe(true)
    const file = JSON.parse(fs.readFileSync(path.join(folder(), `${r.saved!.id}.json`), 'utf8'))
    expect(file.format).toBe('flown-version')
    expect(file.project.zooms).toHaveLength(2)
    const index = JSON.parse(fs.readFileSync(path.join(folder(), 'index.json'), 'utf8'))
    expect(index.items.map((m: { id: string }) => m.id)).toEqual([r.saved!.id])
    expect(listVersions(dir)).toEqual([r.saved])
    expect(r.saved!.bytes).toBe(fs.statSync(path.join(folder(), `${r.saved!.id}.json`)).size)
  })

  it('names an unnamed version "Version N" and lists the newest first', () => {
    const a = saveVersion(dir, 'p20', edit(1), { now: at(0) }).saved!
    const b = saveVersion(dir, 'p20', edit(2), { name: '', now: at(1) }).saved!
    expect([a.name, b.name]).toEqual(['Version 1', 'Version 2'])
    expect(listVersions(dir).map((v) => v.id)).toEqual([b.id, a.id])
  })

  it('refuses another project, a non-project, an unknown reason and an oversized edit', () => {
    expect(() => saveVersion(dir, 'other', edit(1))).toThrow('Not allowed')
    expect(() => saveVersion(dir, 'p20', { nope: true })).toThrow(VersionError)
    expect(() => saveVersion(dir, 'p20', edit(1), { reason: 'evil' })).toThrow('Unknown reason')
    const big = { ...edit(0), name: 'x'.repeat(VERSION_LIMITS.bytes) }
    expect(() => saveVersion(dir, 'p20', big)).toThrow('too large')
    expect(listVersions(dir)).toEqual([])
  })

  it('stops at 50 named versions', () => {
    for (let i = 0; i < VERSION_LIMITS.named; i++) saveVersion(dir, 'p20', edit(i % 3), { now: at(i) })
    expect(() => saveVersion(dir, 'p20', edit(1))).toThrow('You have 50 saved versions. Delete one to save another.')
    // Automatic ones still go.
    expect(saveVersion(dir, 'p20', edit(7), { reason: 'polish' }).saved).not.toBeNull()
  })
})

describe('automatic versions', () => {
  it('are named by their reason and skipped when the edit is already kept', () => {
    const one = edit(1)
    const named = saveVersion(dir, 'p20', one, { name: 'v1', now: at(0) }).saved!
    expect(saveVersion(dir, 'p20', structuredClone(one), { reason: 'polish', now: at(1) })).toEqual({ saved: null, removed: [] })
    const auto = saveVersion(dir, 'p20', edit(2), { reason: 'open', about: 'v1', now: at(2) }).saved!
    expect(auto).toMatchObject({ auto: true, reason: 'open', name: 'Before opening “v1”' })
    expect(listVersions(dir).map((v) => v.id)).toEqual([auto.id, named.id])
  })

  it('treat the same edit with its fields in another order as the same', () => {
    const p = edit(2)
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as Project
    expect(hashProject(reordered)).toBe(hashProject(p))
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}')
    saveVersion(dir, 'p20', p, { name: 'v', now: at(0) })
    expect(saveVersion(dir, 'p20', reordered, { reason: 'fillers', now: at(1) }).saved).toBeNull()
  })

  it('keep the newest five, never removing a named one', () => {
    const named = saveVersion(dir, 'p20', edit(0), { name: 'keep me', now: at(0) }).saved!
    const autos = [1, 2, 3, 4, 5, 6, 7].map((n) => saveVersion(dir, 'p20', edit(n), { reason: 'polish', now: at(n) }))
    expect(autos[5].removed).toEqual([autos[0].saved!.id])
    expect(autos[6].removed).toEqual([autos[1].saved!.id])
    const left = listVersions(dir)
    expect(left).toHaveLength(6)
    expect(left.some((v) => v.id === named.id)).toBe(true)
    expect(fs.readdirSync(folder()).filter((n) => n !== 'index.json')).toHaveLength(6)
  })
})

describe('rename, delete, read', () => {
  it('renames, keeping the name when the new one is empty', () => {
    const v = saveVersion(dir, 'p20', edit(1), { name: 'v1', now: at(0) }).saved!
    expect(renameVersion(dir, v.id, ' Final cut ').name).toBe('Final cut')
    expect(renameVersion(dir, v.id, '   ').name).toBe('Final cut')
    expect(listVersions(dir)[0].name).toBe('Final cut')
    expect(() => renameVersion(dir, 'v-aaaaaaaa-00000000', 'x')).toThrow('no longer there')
    expect(() => renameVersion(dir, '../index', 'x')).toThrow('Unknown version')
  })

  it('deletes the file and the entry, and a deleted version never comes back', () => {
    const a = saveVersion(dir, 'p20', edit(1), { name: 'a', now: at(0) }).saved!
    const b = saveVersion(dir, 'p20', edit(2), { name: 'b', now: at(1) }).saved!
    deleteVersion(dir, a.id)
    expect(fs.existsSync(path.join(folder(), `${a.id}.json`))).toBe(false)
    expect(listVersions(dir).map((v) => v.id)).toEqual([b.id])
    expect(() => deleteVersion(dir, '../../project')).toThrow('Unknown version')
  })

  it('reads a version back as a project with the folder’s id', async () => {
    const v = saveVersion(dir, 'p20', edit(3), { name: 'three', now: at(0) }).saved!
    const r = await readVersion(dir, 'p20', v.id)
    expect(r.meta.name).toBe('three')
    expect(r.project.zooms).toHaveLength(3)
    expect(r.project.id).toBe('p20')
    // Opening it into a newer edit keeps the recording's fields.
    const now = { ...edit(0), name: 'Renamed since' }
    expect(restoreVersion(now, r.project)).toMatchObject({ name: 'Renamed since', zooms: r.project.zooms })
    await expect(readVersion(dir, 'p20', 'v-aaaaaaaa-00000000')).rejects.toThrow('no longer there')
    await expect(readVersion(dir, 'p20', 'nope')).rejects.toThrow('Unknown version')
  })

  it('refuses a version file that is not one', async () => {
    const v = saveVersion(dir, 'p20', edit(1), { name: 'a', now: at(0) }).saved!
    fs.writeFileSync(path.join(folder(), `${v.id}.json`), '{"format":"other"}')
    await expect(readVersion(dir, 'p20', v.id)).rejects.toThrow('could not be read')
  })
})

describe('the index is a cache of the files', () => {
  it('is rebuilt from the files when missing or unreadable', () => {
    const a = saveVersion(dir, 'p20', edit(1), { name: 'a', now: at(0) }).saved!
    const b = saveVersion(dir, 'p20', edit(2), { reason: 'polish', now: at(1) }).saved!
    fs.rmSync(path.join(folder(), 'index.json'))
    expect(listVersions(dir).map((v) => [v.id, v.name, v.auto])).toEqual([
      [b.id, 'Before Polish in one click', true],
      [a.id, 'a', false]
    ])
    fs.writeFileSync(path.join(folder(), 'index.json'), 'not json')
    expect(listVersions(dir)).toHaveLength(2)
    // And written again.
    expect(JSON.parse(fs.readFileSync(path.join(folder(), 'index.json'), 'utf8')).items).toHaveLength(2)
  })

  it('adopts a file the index does not list (a crash between the two writes) and drops entries without a file', () => {
    const a = saveVersion(dir, 'p20', edit(1), { name: 'a', now: at(0) }).saved!
    const index = fs.readFileSync(path.join(folder(), 'index.json'), 'utf8')
    const b = saveVersion(dir, 'p20', edit(2), { name: 'b', now: at(1) }).saved!
    fs.writeFileSync(path.join(folder(), 'index.json'), index)
    expect(listVersions(dir).map((v) => v.id)).toEqual([b.id, a.id])
    fs.rmSync(path.join(folder(), `${a.id}.json`))
    expect(listVersions(dir).map((v) => v.id)).toEqual([b.id])
  })

  it('ignores other files and a file whose meta names another id', () => {
    const a = saveVersion(dir, 'p20', edit(1), { name: 'a', now: at(0) }).saved!
    fs.writeFileSync(path.join(folder(), 'notes.txt'), 'x')
    fs.copyFileSync(path.join(folder(), `${a.id}.json`), path.join(folder(), 'v-bbbbbbbb-00000000.json'))
    expect(listVersions(dir).map((v) => v.id)).toEqual([a.id])
  })
})

describe('the versions folder', () => {
  it('must be a real folder, never a link', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-elsewhere-'))
    try {
      fs.symlinkSync(elsewhere, folder(), 'dir')
      expect(() => listVersions(dir)).toThrow('not a folder')
      expect(() => saveVersion(dir, 'p20', edit(1))).toThrow('not a folder')
      expect(fs.readdirSync(elsewhere)).toEqual([])
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
  it('is not made in a recording folder that is gone', () => {
    expect(() => versionsDir(path.join(dir, 'gone'), true)).toThrow('no longer exists')
  })
})
