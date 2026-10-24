// Custom cursor images: importing a picked file into the project folder, and serving it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => root.dir },
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  protocol: {},
  BrowserWindow: class {}
}))

import { MEDIA_FILE_RE } from '../src/main/mediaProtocol'
import { importCursorImage, looksLikeCursorImage } from '../src/main/projectsIpc'
import { mediaUrl, projectMediaUrl } from '../src/shared/mediaUrl'

root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-cursor-image-'))
afterAll(() => rmSync(root.dir, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const projectDir = path.join(root.dir, 'Screen Studio for Windows', 'rec-1')
mkdirSync(projectDir, { recursive: true })

function file(name: string, content: Buffer | string): string {
  const p = path.join(root.dir, name)
  writeFileSync(p, content)
  return p
}

describe('importCursorImage', () => {
  it('copies the image into the project folder as cursor.<ext>', async () => {
    const r = await importCursorImage('rec-1', file('My Cursor.PNG', PNG))
    expect(r.path).toBe('cursor.png')
    expect(r.url).toMatch(/^studio-media:\/\/project\/rec-1\/cursor\.png\?v=\d+$/)
    expect(readFileSync(path.join(projectDir, 'cursor.png'))).toEqual(PNG)
  })

  it('names .jpeg files .jpg and keeps other formats next to each other (for undo)', async () => {
    const r = await importCursorImage('rec-1', file('a.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])))
    expect(r.path).toBe('cursor.jpg')
    const svg = await importCursorImage('rec-1', file('a.svg', '<?xml version="1.0"?>\n<!-- arrow -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
    expect(svg.path).toBe('cursor.svg')
    expect(existsSync(path.join(projectDir, 'cursor.png'))).toBe(true)
  })

  it('accepts ICO and CUR', async () => {
    expect((await importCursorImage('rec-1', file('a.ico', Buffer.from([0, 0, 1, 0, 1, 0])))).path).toBe('cursor.ico')
    expect((await importCursorImage('rec-1', file('a.cur', Buffer.from([0, 0, 2, 0, 1, 0])))).path).toBe('cursor.cur')
  })

  it('refuses other formats, files that are not images, and huge files, without touching the old image', async () => {
    await expect(importCursorImage('rec-1', file('a.gif', 'GIF89a'))).rejects.toThrow(/PNG, JPG, WebP, SVG, ICO or CUR/)
    await expect(importCursorImage('rec-1', file('fake.png', 'not an image'))).rejects.toThrow(/could not be read as an image/)
    expect(readFileSync(path.join(projectDir, 'cursor.png'))).toEqual(PNG)
    const big = Buffer.alloc(11 * 1024 * 1024)
    PNG.copy(big)
    await expect(importCursorImage('rec-1', file('big.png', big))).rejects.toThrow(/too large/)
  })

  it('rejects ids that would escape the projects folder', async () => {
    await expect(importCursorImage('../evil', file('b.png', PNG))).rejects.toThrow(/Invalid project id/)
  })
})

describe('looksLikeCursorImage', () => {
  it('recognises the supported formats by their first bytes', () => {
    expect(looksLikeCursorImage(PNG)).toBe(true)
    expect(looksLikeCursorImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true)
    expect(looksLikeCursorImage(Buffer.from('<svg viewBox="0 0 1 1">'))).toBe(true)
    expect(looksLikeCursorImage(Buffer.from('hello'))).toBe(false)
    expect(looksLikeCursorImage(Buffer.from('<svgx>'))).toBe(false)
    expect(looksLikeCursorImage(Buffer.alloc(0))).toBe(false)
  })
})

describe('media URLs', () => {
  it('the protocol serves cursor images and nothing else new', () => {
    for (const f of ['cursor.png', 'cursor.jpg', 'cursor.jpeg', 'cursor.webp', 'cursor.svg', 'cursor.ico', 'cursor.cur', 'screen.mp4', 'background.png']) expect(MEDIA_FILE_RE.test(f)).toBe(true)
    for (const f of ['cursor.gif', 'cursor.png.exe', 'project.json', 'cursor.json', '../cursor.png', 'mycursor.png']) expect(MEDIA_FILE_RE.test(f)).toBe(false)
  })

  it('builds the same URLs in main and renderer', () => {
    expect(mediaUrl('rec 1', 'cursor.png', 5)).toBe('studio-media://project/rec%201/cursor.png?v=5')
    expect(projectMediaUrl('rec-1')('cursor.svg')).toMatch(/^studio-media:\/\/project\/rec-1\/cursor\.svg\?v=\d+$/)
  })
})
