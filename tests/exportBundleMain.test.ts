import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, app: { getPath: () => os.tmpdir(), on: vi.fn() }, dialog: {}, shell: {} }))

import { sidecarBytes, sidecarTarget, writeSidecar, type SidecarDeps } from '../src/main/exportBundle'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

let dir = ''
let video = ''
const deps = (replaced = false): SidecarDeps => ({ isExported: (f) => f === video, replaced: () => replaced, exists: existsSync })

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-bundle-'))
  video = path.join(dir, 'Demo.mp4')
  writeFileSync(video, 'video')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sidecar files', () => {
  it('goes next to an exported file, named after it', () => {
    expect(sidecarTarget(video, 'srt', deps())).toBe(path.join(dir, 'Demo.srt'))
    expect(sidecarTarget(video, 'description', deps())).toBe(path.join(dir, 'Demo - description.txt'))
  })

  it('refuses files not exported in this session, relative paths and unknown kinds', () => {
    expect(() => sidecarTarget(path.join(dir, 'Other.mp4'), 'srt', deps())).toThrow(/exported in this session/)
    expect(() => sidecarTarget('Demo.mp4', 'srt', { ...deps(), isExported: () => true })).toThrow(/exported in this session/)
    expect(() => sidecarTarget(video, '../evil', deps())).toThrow(/Invalid extra file/)
  })

  it('never replaces an existing file unless the export replaced the video', async () => {
    writeFileSync(path.join(dir, 'Demo.srt'), 'mine')
    const file = await writeSidecar(video, 'srt', '1\n00:00:00,000 --> 00:00:01,000\nHi\n', deps())
    expect(file).toBe(path.join(dir, 'Demo (2).srt'))
    expect(readFileSync(path.join(dir, 'Demo.srt'), 'utf8')).toBe('mine')
    const replaced = await writeSidecar(video, 'srt', '', deps(true))
    expect(replaced).toBe(path.join(dir, 'Demo.srt'))
    expect(readFileSync(replaced, 'utf8')).toBe('﻿')
    expect(readdirSync(dir).some((f) => f.includes('.partial-'))).toBe(false)
  })

  it('checks the content of each kind', () => {
    expect(() => sidecarBytes('srt', 'not a subtitle')).toThrow()
    expect(() => sidecarBytes('vtt', '1\n')).toThrow()
    expect(Buffer.from(sidecarBytes('vtt', 'WEBVTT\n')).toString()).toBe('WEBVTT\n')
    expect(() => sidecarBytes('description', 'a\u0000b')).toThrow()
    expect(() => sidecarBytes('chapters', 'x'.repeat(1024 * 1024 + 1))).toThrow()
    expect(() => sidecarBytes('chapters', 42)).toThrow()
    expect(() => sidecarBytes('thumbnail', Uint8Array.from([1, 2, 3]))).toThrow(/thumbnail/)
    expect(() => sidecarBytes('thumbnail', 'png')).toThrow(/thumbnail/)
    expect(sidecarBytes('thumbnail', PNG)).toBe(PNG)
  })
})
