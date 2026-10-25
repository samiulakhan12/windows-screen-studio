// Background and cursor image picks: checked before anything is replaced, and copied through a
// temporary file so a copy that fails partway never truncates the image the project uses.
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => root.dir },
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  protocol: {},
  BrowserWindow: class {}
}))

import { importBackgroundImage, importCursorImage } from '../src/main/projectsIpc'

root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-picked-image-'))
afterAll(() => rmSync(root.dir, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const projectDir = path.join(root.dir, 'Flown', 'rec-1')
mkdirSync(projectDir, { recursive: true })

function file(name: string, content: Buffer | string): string {
  const p = path.join(root.dir, name)
  writeFileSync(p, content)
  return p
}

/** copyFile that writes a few bytes of `dest` and then fails, like a source on a drive that disconnects. */
function failingCopy(): void {
  vi.spyOn(fsp, 'copyFile').mockImplementation(async (_src, dest) => {
    writeFileSync(dest as string, 'trunc')
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  })
}

describe('importBackgroundImage', () => {
  it('copies a PNG, JPG or WebP image as background.<ext>', async () => {
    expect(await importBackgroundImage('rec-1', file('Sky.PNG', PNG))).toMatchObject({ path: 'background.png' })
    expect(readFileSync(path.join(projectDir, 'background.png'))).toEqual(PNG)
    expect((await importBackgroundImage('rec-1', file('a.jpeg', JPG))).path).toBe('background.jpg')
    expect((await importBackgroundImage('rec-1', file('a.webp', 'RIFF\0\0\0\0WEBPVP8 '))).path).toBe('background.webp')
  })

  it('refuses other extensions, folders, files that are not that image, and huge files', async () => {
    await expect(importBackgroundImage('rec-1', file('notes.txt', PNG))).rejects.toThrow(/PNG, JPG or WebP/)
    await expect(importBackgroundImage('rec-1', file('a.svg', '<svg></svg>'))).rejects.toThrow(/PNG, JPG or WebP/)
    mkdirSync(path.join(root.dir, 'folder.png'), { recursive: true })
    await expect(importBackgroundImage('rec-1', path.join(root.dir, 'folder.png'))).rejects.toThrow(/PNG, JPG or WebP/)
    await expect(importBackgroundImage('rec-1', file('fake.png', 'not an image'))).rejects.toThrow(/could not be read as a \.png image/)
    await expect(importBackgroundImage('rec-1', file('jpg.png', JPG))).rejects.toThrow(/could not be read as a \.png image/)
    const big = Buffer.alloc(101 * 1024 * 1024)
    PNG.copy(big)
    await expect(importBackgroundImage('rec-1', file('big.png', big))).rejects.toThrow(/too large/)
    expect(readFileSync(path.join(projectDir, 'background.png'))).toEqual(PNG)
    expect(existsSync(path.join(projectDir, 'background.txt'))).toBe(false)
  })

  it('a copy that fails partway leaves the background in use intact', async () => {
    await importBackgroundImage('rec-1', file('first.png', PNG))
    failingCopy()
    await expect(importBackgroundImage('rec-1', file('second.png', Buffer.concat([PNG, PNG])))).rejects.toThrow(/ENOSPC/)
    expect(readFileSync(path.join(projectDir, 'background.png'))).toEqual(PNG)
    expect(readdirSync(projectDir).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('rejects ids that would escape the projects folder', async () => {
    await expect(importBackgroundImage('../evil', file('b.png', PNG))).rejects.toThrow(/Invalid project id/)
  })
})

describe('importCursorImage', () => {
  it('a copy that fails partway leaves the cursor image in use intact', async () => {
    await importCursorImage('rec-1', file('cursor-first.png', PNG))
    failingCopy()
    await expect(importCursorImage('rec-1', file('cursor-second.png', Buffer.concat([PNG, PNG])))).rejects.toThrow(/ENOSPC/)
    expect(readFileSync(path.join(projectDir, 'cursor.png'))).toEqual(PNG)
    expect(readdirSync(projectDir).filter((f) => f.endsWith('.part'))).toEqual([])
  })
})
