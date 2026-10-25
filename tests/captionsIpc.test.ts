import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Saving subtitle files in the main process: the content is checked, only the dialog's path is written. */
const h = vi.hoisted(() => {
  const root = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-captions-ipc-')) as string
  return {
    root,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    dialog: { canceled: false, filePath: '' } as { canceled: boolean; filePath: string },
    asked: [] as { defaultPath: string; filters: { extensions: string[] }[] }[]
  }
})

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name) },
  dialog: {
    showSaveDialog: async (_w: unknown, opts: { defaultPath: string; filters: { extensions: string[] }[] }) => {
      h.asked.push(opts)
      return h.dialog
    }
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) }
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({}) }))

const { registerCaptionsIpc, subtitleFileName, withExtension } = await import('../src/main/captionsIpc')

const save = (...args: unknown[]): Promise<unknown> => Promise.resolve(h.handlers.get('captions:save')!({}, ...args))
const SRT = '1\n00:00:00,500 --> 00:00:01,500\nHello\n'

describe('captions:save', () => {
  beforeAll(() => registerCaptionsIpc())
  afterAll(() => rmSync(h.root, { recursive: true, force: true }))

  it('writes the subtitles where the dialog says, with the format’s extension', async () => {
    h.dialog = { canceled: false, filePath: path.join(h.root, 'My video') }
    const file = await save('My: video?', 'srt', SRT)
    expect(file).toBe(path.join(h.root, 'My video.srt'))
    expect(readFileSync(file as string, 'utf8')).toBe(`﻿${SRT}`)
    expect(path.basename(h.asked[h.asked.length - 1].defaultPath)).toBe('My video.srt')
    expect(h.asked[h.asked.length - 1].filters[0].extensions).toEqual(['srt'])
  })

  it('returns null when the dialog is cancelled', async () => {
    h.dialog = { canceled: true, filePath: '' }
    expect(await save('x', 'vtt', 'WEBVTT\n')).toBeNull()
  })

  it('refuses content that is not a subtitle file of that format, before asking', async () => {
    const asked = h.asked.length
    await expect(save('x', 'srt', 'not subtitles')).rejects.toThrow(/cannot be saved/)
    await expect(save('x', 'exe', 'x')).rejects.toThrow(/cannot be saved/)
    await expect(save('x', 'txt', 42)).rejects.toThrow(/cannot be saved/)
    expect(h.asked.length).toBe(asked)
  })

  it('refuses a path that is not absolute', async () => {
    h.dialog = { canceled: false, filePath: 'relative/file.txt' }
    await expect(save('x', 'txt', 'hello\n')).rejects.toThrow(/folder/)
  })

  it('cleans the suggested name and fixes the extension', () => {
    expect(subtitleFileName('a/b\\\\c:*?"<>|d')).toBe('a b c d')
    expect(subtitleFileName('...hidden')).toBe('hidden')
    expect(subtitleFileName('')).toBe('Captions')
    expect(subtitleFileName(5)).toBe('Captions')
    expect(withExtension('/x/a.SRT', 'srt')).toBe('/x/a.SRT')
    expect(withExtension('/x/a.txt', 'vtt')).toBe('/x/a.txt.vtt')
  })
})
