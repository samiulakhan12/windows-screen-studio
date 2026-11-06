import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, changedFiles, deleteVersion, hashProject, inPlaceHashes, listVersions, readVersion, renameVersion, saveVersion, versionsDir, VersionError } from '../src/main/versions'
import { restoreVersion, VERSION_ID_RE, VERSION_LIMITS } from '../src/shared/editor/versions'
import type { Project } from '../src/shared/types'
import { p20, zoom } from './groupFixture'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-versions-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

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
    // Review mode's Remove all and Make my captions great keep theirs too, listed with their reason.
    const review = saveVersion(dir, 'p20', edit(3), { reason: 'review', now: at(3) }).saved!
    const captions = saveVersion(dir, 'p20', edit(4), { reason: 'captions', now: at(4) }).saved!
    expect(review).toMatchObject({ auto: true, reason: 'review', name: 'Before removing automatic changes' })
    expect(captions).toMatchObject({ auto: true, reason: 'captions', name: 'Before Make my captions great' })
    expect(listVersions(dir).map((v) => [v.id, v.reason])).toEqual([
      [captions.id, 'captions'],
      [review.id, 'review'],
      [auto.id, 'open'],
      [named.id, undefined]
    ])
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

describe('opening the oldest automatic version', () => {
  it('never prunes the version being opened, nor the one just kept', async () => {
    const autos = [1, 2, 3, 4, 5].map((n) => saveVersion(dir, 'p20', edit(n), { reason: 'polish', now: at(n) }).saved!)
    const oldest = autos[0]
    const r = saveVersion(dir, 'p20', edit(9), { reason: 'open', about: oldest.name, protect: oldest.id, now: at(9) })
    expect(r.removed).toEqual([autos[1].id])
    expect((await readVersion(dir, 'p20', oldest.id)).project.zooms).toHaveLength(1)
    // A clock that went back never prunes the version just kept.
    const back = saveVersion(dir, 'p20', edit(10), { reason: 'polish', now: at(0) })
    expect(back.removed).not.toContain(back.saved!.id)
    expect(listVersions(dir).some((v) => v.id === back.saved!.id)).toBe(true)
  })
})

describe('rename, delete, read', () => {
  it('keeps a new name when the index is rebuilt from the files', () => {
    const v = saveVersion(dir, 'p20', edit(1), { name: 'v1', now: at(0) }).saved!
    renameVersion(dir, v.id, 'Final cut')
    fs.rmSync(path.join(folder(), 'index.json'))
    expect(listVersions(dir)[0].name).toBe('Final cut')
  })

  it('reads an index only when it is a small regular file', () => {
    const v = saveVersion(dir, 'p20', edit(1), { name: 'v1', now: at(0) }).saved!
    fs.rmSync(path.join(folder(), 'index.json'))
    fs.mkdirSync(path.join(folder(), 'index.json'))
    // Rebuilt from the files instead (its write then fails, which listing survives).
    expect(listVersions(dir).map((x) => x.id)).toEqual([v.id])
  })

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

describe('a write that fails', () => {
  const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code })

  it('leaves no part-written temporary file (a full disk), and a listing removes one a crash left', () => {
    saveVersion(dir, 'p20', edit(1), { name: 'small', now: at(0) })
    const write = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, opts) => {
      // The disk fills up part-way through a version's temporary file.
      if (/^v-.*\.json\.tmp$/.test(path.basename(String(file)))) {
        write(file, String(data).slice(0, 100))
        throw failure('ENOSPC')
      }
      return write(file, data, opts)
    })
    for (let i = 0; i < 3; i++) expect(() => saveVersion(dir, 'p20', edit(2 + i), { reason: 'polish', now: at(1 + i) })).toThrow('ENOSPC')
    vi.restoreAllMocks()
    expect(fs.readdirSync(folder()).filter((n) => n.endsWith('.tmp'))).toEqual([])
    // One left by a crash (or an older build) goes with the next listing; other names stay.
    fs.writeFileSync(path.join(folder(), 'v-aaaaaaaa-00000000.json.tmp'), 'part')
    fs.writeFileSync(path.join(folder(), 'notes.json.tmp'), 'mine')
    expect(listVersions(dir)).toHaveLength(1)
    expect(fs.readdirSync(folder()).filter((n) => n.endsWith('.tmp'))).toEqual(['notes.json.tmp'])
  })
})

describe('a version file Windows holds (an indexer, antivirus, OneDrive)', () => {
  const locked = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: resource busy or locked`), { code })

  it('is pruned next time: the version just kept is still saved, listed and returned', () => {
    const autos = [1, 2, 3, 4, 5].map((n) => saveVersion(dir, 'p20', edit(n), { reason: 'polish', now: at(n) }).saved!)
    const held = path.join(folder(), `${autos[0].id}.json`)
    const rm = fs.rmSync.bind(fs)
    vi.spyOn(fs, 'rmSync').mockImplementation((file, opts) => {
      if (String(file) === held) throw locked('EPERM')
      return rm(file, opts)
    })
    const r = saveVersion(dir, 'p20', edit(6), { reason: 'open', about: 'v', now: at(6) })
    expect(r.saved).toMatchObject({ name: 'Before opening “v”' })
    expect(r.removed).toEqual([])
    expect(listVersions(dir).map((v) => v.id)).toContain(r.saved!.id)
    expect(fs.existsSync(held)).toBe(true)
    vi.restoreAllMocks()
    // Let go: the next automatic version removes it, and the one after it beyond five.
    const next = saveVersion(dir, 'p20', edit(7), { reason: 'polish', now: at(7) })
    expect(next.removed).toEqual([autos[0].id, autos[1].id])
    expect(listVersions(dir).filter((v) => v.auto)).toHaveLength(5)
  })

  it('is deleted once it is let go a moment later', () => {
    const v = saveVersion(dir, 'p20', edit(1), { name: 'a', now: at(0) }).saved!
    const file = path.join(folder(), `${v.id}.json`)
    const rm = fs.rmSync.bind(fs)
    let tries = 0
    vi.spyOn(fs, 'rmSync').mockImplementation((f, opts) => {
      if (String(f) === file && ++tries < 3) throw locked('EBUSY')
      return rm(f, opts)
    })
    deleteVersion(dir, v.id)
    expect(fs.existsSync(file)).toBe(false)
    expect(listVersions(dir)).toEqual([])
  })

  it('still says why when it stays held', () => {
    const v = saveVersion(dir, 'p20', edit(1), { name: 'a', now: at(0) }).saved!
    const file = path.join(folder(), `${v.id}.json`)
    const rm = fs.rmSync.bind(fs)
    vi.spyOn(fs, 'rmSync').mockImplementation((f, opts) => {
      if (String(f) === file) throw locked('EBUSY')
      return rm(f, opts)
    })
    expect(() => deleteVersion(dir, v.id)).toThrow('EBUSY')
    vi.restoreAllMocks()
    expect(listVersions(dir).map((x) => x.id)).toEqual([v.id])
  })
})

describe('images a later pick writes over (background.<ext>, cursor.<ext>)', () => {
  const withImages = (p: Project): Project => ({
    ...p,
    style: { ...p.style, background: { type: 'image', path: 'background.png' } },
    cursor: { ...p.cursor, style: 'custom', customImage: 'cursor.png' }
  })
  const keep = async (p: Project, name: string, minute: number) => saveVersion(dir, 'p20', p, { name, files: await inPlaceHashes(dir, p), now: at(minute) }).saved!

  it('are kept as hashes, so opening or comparing a version says which changed since', async () => {
    fs.writeFileSync(path.join(dir, 'background.png'), 'picture A')
    fs.writeFileSync(path.join(dir, 'cursor.png'), 'arrow')
    const p = withImages(edit(1))
    const v = await keep(p, 'v1 for client', 0)
    let r = await readVersion(dir, 'p20', v.id)
    expect(Object.keys(r.files)).toEqual(['background.png', 'cursor.png'])
    expect(await changedFiles(dir, r.project, r.files)).toEqual([])
    // Picture B, also a PNG, is picked: it is written over background.png.
    fs.writeFileSync(path.join(dir, 'background.png'), 'picture B')
    r = await readVersion(dir, 'p20', v.id)
    expect(await changedFiles(dir, r.project, r.files)).toEqual(['background image'])
    // A new name keeps them (they are in the version's file).
    renameVersion(dir, v.id, 'Final cut')
    fs.writeFileSync(path.join(dir, 'cursor.png'), 'hand')
    r = await readVersion(dir, 'p20', v.id)
    expect(await changedFiles(dir, r.project, r.files)).toEqual(['background image', 'cursor image'])
    // Picture A picked again: the same as kept. A file gone is left to the missing notice.
    fs.writeFileSync(path.join(dir, 'background.png'), 'picture A')
    fs.rmSync(path.join(dir, 'cursor.png'))
    expect(await changedFiles(dir, r.project, r.files)).toEqual([])
  })

  it('keeps nothing for an edit without them, nor for a version kept before them', async () => {
    const plain = await keep(edit(1), 'plain', 0)
    expect(fs.readFileSync(path.join(folder(), `${plain.id}.json`), 'utf8')).not.toContain('"files"')
    expect((await readVersion(dir, 'p20', plain.id)).files).toEqual({})
    // A version file written before (no "files"): nothing is said to have changed.
    fs.writeFileSync(path.join(dir, 'background.png'), 'picture B')
    const old = saveVersion(dir, 'p20', withImages(edit(2)), { name: 'old', now: at(1) }).saved!
    const r = await readVersion(dir, 'p20', old.id)
    expect(r.files).toEqual({})
    expect(await changedFiles(dir, r.project, r.files)).toEqual([])
  })

  it('hashes only the names a pick writes over, and keeps only hashes of files the edit names', async () => {
    fs.writeFileSync(path.join(dir, 'screen.mp4'), 'video')
    const odd: Project = { ...edit(1), style: { ...edit(1).style, background: { type: 'image', path: 'screen.mp4' } } }
    expect(await inPlaceHashes(dir, odd)).toEqual({})
    expect(await inPlaceHashes(dir, { not: 'a project' })).toEqual({})
    const hash = 'a'.repeat(64)
    const v = saveVersion(dir, 'p20', withImages(edit(1)), { name: 'v', files: { 'screen.mp4': hash, 'background.png': 'not a hash', 'cursor.png': hash, '../x.png': hash }, now: at(0) }).saved!
    expect((await readVersion(dir, 'p20', v.id)).files).toEqual({ 'cursor.png': hash })
  })
})
