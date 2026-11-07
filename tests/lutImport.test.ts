/**
 * Importing a .cube LUT in main (docs/design/editing-polish.md §9.5, §14 rule 1; §19.1 test 58): a
 * bad file is refused before anything is copied, with the parser's reason; a good one is stored as
 * lut-<n>.cube from the bytes that were checked, with its SHA-256, title and size; imports are
 * pruned to the three newest plus the ones the saved project uses; the media protocol, Duplicate
 * and Versions know the file.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ root: '' }))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-lut-import-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(h.root, name), isPackaged: false, getAppPath: () => h.root },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined },
  clipboard: { read: async () => [] },
  BrowserWindow: class {},
  shell: {}
}))

const { importLut } = await import('../src/main/lutImport')
const { importAsset, isAssetFile } = await import('../src/main/assetIpc')
const { MEDIA_FILE_RE } = await import('../src/main/mediaProtocol')
const { copiedFile } = await import('../src/main/projectCopy')
const { projectDir } = await import('../src/main/projects')
const { namedFiles } = await import('../src/shared/editor/versions')
const { createProject } = await import('../src/shared/engine/project')

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

/** An identity .cube of size n, with `head` lines first. */
function cube(n: number, head: string[] = []): string {
  const lines = [...head, `LUT_3D_SIZE ${n}`]
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`)
  return lines.join('\n') + '\n'
}

let n = 0
let source = ''
/** A fresh project folder (with a saved project) and a folder of files to import. */
function setUp(saved: { screen?: string; camera?: string } = {}): string {
  const id = `rec-lut-import-${++n}`
  const dir = projectDir(id)
  mkdirSync(dir, { recursive: true })
  const p = createProject({ id, name: id, duration: 5, width: 1280, height: 720, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
  const ref = (file: string) => ({ lut: { file, sha256: 'a'.repeat(64), title: 't', size: 2 } })
  const grade = { ...(saved.screen ? { screen: ref(saved.screen) } : {}), ...(saved.camera ? { camera: ref(saved.camera) } : {}) }
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(Object.keys(grade).length ? { ...p, grade } : p))
  source = path.join(h.root, `sources-${n}`)
  mkdirSync(source, { recursive: true })
  return dir
}
const file = (name: string, content: string | Uint8Array): string => {
  const f = path.join(source, name)
  writeFileSync(f, content)
  return f
}
const luts = (dir: string): string[] => readdirSync(dir).filter((f) => f !== 'project.json').sort()

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined))

describe('importing a LUT (test 58)', () => {
  it('refuses a bad file before anything is copied, saying why', async () => {
    const dir = setUp()
    const bad: [string, string | Uint8Array, RegExp][] = [
      ['short.cube', 'LUT_3D_SIZE 2\n0 0 0\n1 1 1\n', /data/],
      ['nan.cube', cube(2).replace('1 0 0', 'NaN 0 0'), /line 3/],
      ['huge-size.cube', 'LUT_3D_SIZE 66\n', /66/],
      ['two-d.cube', 'LUT_2D_SIZE 4\n', /LUT_2D_SIZE/],
      ['nul.cube', new Uint8Array([0x4c, 0x55, 0x54, 0]), /NUL/],
      ['empty.cube', '', /empty/],
      ['big.cube', new Uint8Array(16 * 1024 * 1024 + 1).fill(0x23), /too large \(17 MB; 16 MB at most\)/],
      ['notes.txt', cube(2), /Choose a \.cube LUT/]
    ]
    for (const [name, content, why] of bad) {
      await expect(importLut(dir, file(name, content)), name).rejects.toThrow(why)
      expect(luts(dir), name).toEqual([])
    }
    // The parser's own words, naming the line.
    await expect(importLut(dir, file('three.cube', cube(2).replace('0 1 0', '0 1')))).rejects.toThrow(/^This LUT could not be used: line 4 has 2 numbers, not 3\.$/)
    await expect(importLut(dir, 'relative.cube')).rejects.toThrow(/Choose/)
    expect(luts(dir)).toEqual([])
  })

  it('stores a good file as lut-<n>.cube from the bytes it checked, with its hash, title and size', async () => {
    const dir = setUp()
    const text = cube(3, ['TITLE "Teal ‮and orange"'])
    const got = await importLut(dir, file('My look.cube', text))
    expect(got).toEqual({ file: 'lut-1.cube', sha256: sha(text), title: 'Teal and orange', size: 3 })
    expect(readFileSync(path.join(dir, 'lut-1.cube'), 'utf8')).toBe(text)
    // Without a TITLE, its file name; every import gets a new name.
    const again = await importLut(dir, file('Warm film.CUBE', cube(2)))
    expect(again).toMatchObject({ file: 'lut-2.cube', title: 'Warm film', size: 2 })
    expect(luts(dir)).toEqual(['lut-1.cube', 'lut-2.cube'])
  })

  it('keeps the three newest imports and the ones the saved project uses', async () => {
    const dir = setUp({ camera: 'lut-1.cube' })
    for (let i = 0; i < 6; i++) await importLut(dir, file(`l${i}.cube`, cube(2, [`TITLE "${i}"`])))
    expect(luts(dir)).toEqual(['lut-1.cube', 'lut-4.cube', 'lut-5.cube', 'lut-6.cube'])
  })

  it('goes through the asset pick, which returns what main read', async () => {
    setUp()
    const id = `rec-lut-import-${n}`
    const text = cube(2, ['TITLE "Mono"'])
    const picked = await importAsset(id, 'lut', file('mono.cube', text))
    expect(picked).toMatchObject({ path: 'lut-1.cube', name: 'mono.cube', lut: { sha256: sha(text), title: 'Mono', size: 2 } })
    expect(picked.url).toMatch(/^studio-media:\/\/project\/rec-lut-import-\d+\/lut-1\.cube/)
    await expect(importAsset(id, 'lut', file('bad.cube', 'LUT_3D_SIZE 2\n'))).rejects.toThrow(/This LUT could not be used/)
  })

  it('is a project file the media protocol, Duplicate and Versions know', () => {
    for (const ok of ['lut-1.cube', 'lut-42.cube']) {
      expect(MEDIA_FILE_RE.test(ok), ok).toBe(true)
      expect(isAssetFile(ok), ok).toBe(true)
      expect(copiedFile(ok), ok).toBe('copy')
    }
    for (const bad of ['lut-0.cube', 'lut.cube', '../lut-1.cube', 'lut-1.cube.part', '.lut-1.cube.part']) {
      expect(MEDIA_FILE_RE.test(bad), bad).toBe(false)
      expect(copiedFile(bad), bad).toBeNull()
    }
    const p = createProject({ id: 'p', name: 'p', duration: 5, width: 1280, height: 720, hasWebcam: true, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
    const lut = (f: string) => ({ file: f, sha256: 'b'.repeat(64), title: 't', size: 17 })
    expect(namedFiles({ ...p, grade: { screen: { lut: lut('lut-1.cube') }, camera: { lut: lut('lut-2.cube') } } })).toEqual(
      expect.arrayContaining([
        { file: 'lut-1.cube', what: 'colour LUT' },
        { file: 'lut-2.cube', what: 'colour LUT' }
      ])
    )
  })
})
