import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/*
 * Main's side of the UI language and of the new export channels (docs/design/output-and-languages.md
 * §4.4, §9.4, §18.5, §21.0): the `ui` and `exportPresets` preferences read through their readers,
 * readPrefSync and writePrefSync on the cache prefs:set uses, and every new channel answering only
 * the app's own page.
 */
const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-ui-ipc-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  boxes: [] as { owner: unknown; options: Record<string, unknown> }[],
  response: 0
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), isPackaged: false },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  BrowserWindow: { fromWebContents: (wc: unknown) => (wc ? { owner: wc } : null) },
  dialog: {
    showMessageBox: async (a: unknown, b?: Record<string, unknown>) => {
      h.boxes.push(b ? { owner: a, options: b } : { owner: null, options: a as Record<string, unknown> })
      return { response: h.response }
    },
    // The preset file dialogs (part P5) are cancelled here: their channels then answer null.
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  }
}))

const { readPrefSync, registerPrefsIpc, writePrefSync } = await import('../src/main/prefsIpc')
const { initUiLanguage, registerUiIpc } = await import('../src/main/i18n')
const { registerCodecProbeIpc } = await import('../src/main/codecProbe')
const { registerTimelineIpc } = await import('../src/main/timelineIpc')
const { registerPresetFileIpc } = await import('../src/main/presetFiles')

const prefsFile = path.join(h.root, 'userData', 'editor-prefs.json')
const app = { sender: { id: 1 }, senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).toString() } }
const stranger = { sender: { id: 2 }, senderFrame: { url: 'https://example.com/' } }
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => h.handlers.get(channel)!(...args)

beforeAll(() => {
  mkdirSync(path.join(h.root, 'userData'), { recursive: true })
  writeFileSync(prefsFile, JSON.stringify({ ui: { language: 'bn', digits: 'beng', seen: ['bn', 'xx'] }, exportPresets: { version: 1, presets: [{ id: 'user:0123456789ab', name: 'A‮', options: { format: 'mov', codec: 'prores-422', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto' }, saved: 1 }] }, older: { kept: true } }))
  registerPrefsIpc()
  registerUiIpc()
  registerCodecProbeIpc()
  registerTimelineIpc()
  registerPresetFileIpc()
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('wave 12 preferences', () => {
  it('reads `ui` and `exportPresets` through their readers, on prefs:get and readPrefSync alike', async () => {
    expect(readPrefSync('ui')).toEqual({ language: 'bn' })
    expect(await invoke('prefs:get', app, 'ui')).toEqual({ language: 'bn' })
    const store = readPrefSync('exportPresets') as { presets: { name: string; options: { codec?: string } }[] }
    expect(store.presets[0].name).toBe('A')
    expect(store.presets[0].options.codec).toBe('cineform')
    expect(readPrefSync('guide')).toBeNull()
  })

  it('writes from main on the cache prefs:set uses, so neither puts back a stale value', async () => {
    writePrefSync('ui', { language: 'system', offered: ['bn'], junk: 1 })
    expect(JSON.parse(readFileSync(prefsFile, 'utf8')).ui).toEqual({ language: 'system', offered: ['bn'] })
    await invoke('prefs:set', app, 'polish', { level: 1 })
    const file = JSON.parse(readFileSync(prefsFile, 'utf8'))
    expect(file.ui).toEqual({ language: 'system', offered: ['bn'] })
    expect(file.older).toEqual({ kept: true })
    writePrefSync('ui', null)
    expect(JSON.parse(readFileSync(prefsFile, 'utf8'))).not.toHaveProperty('ui')
    expect(readPrefSync('ui')).toBeNull()
    await invoke('prefs:set', app, 'exportPresets', { version: 1, presets: [{ id: 'nope', name: 'x', options: {} }] })
    expect(JSON.parse(readFileSync(prefsFile, 'utf8')).exportPresets).toEqual({ version: 1, presets: [] })
    await invoke('prefs:set', app, 'exportPresets', 'nonsense')
    expect(JSON.parse(readFileSync(prefsFile, 'utf8'))).not.toHaveProperty('exportPresets')
  })
})

describe('the ui channels', () => {
  it('starts in English with nothing shipped or offered', async () => {
    const info = initUiLanguage()
    expect(info).toMatchObject({ language: 'en', dir: 'ltr', shipped: [], preview: [], offer: null, reopen: null })
    writePrefSync('ui', { language: 'bn', seen: ['bn'] })
    expect(await invoke('ui:info', app)).toMatchObject({ language: 'en', prefs: { language: 'bn', seen: ['bn'] } })
  })

  it('stores language settings only through their reader', async () => {
    await invoke('ui:setPrefs', app, { language: 'hi', digits: 'western', extra: 'x' })
    expect(readPrefSync('ui')).toEqual({ language: 'hi', digits: 'western' })
    await expect(invoke('ui:setPrefs', app, 'bn')).rejects.toThrow()
    await invoke('ui:setPrefs', app, {})
    expect(readPrefSync('ui')).toBeNull()
  })

  it('asks a confirmation with the caller’s two buttons, owned by the asking window', async () => {
    h.response = 0
    expect(await invoke('ui:confirm', app, { message: 'মুছে ফেলবেন?', action: 'মুছুন', cancel: 'বাতিল' })).toBe(true)
    expect(h.boxes[0].owner).toEqual({ owner: app.sender })
    expect(h.boxes[0].options).toMatchObject({ message: 'মুছে ফেলবেন?', buttons: ['মুছুন', 'বাতিল'], defaultId: 0, cancelId: 1 })
    h.response = 1
    expect(await invoke('ui:confirm', app, { message: 'Delete?', action: 'Delete', cancel: 'Cancel' })).toBe(false)
    await expect(invoke('ui:confirm', app, { message: 'x'.repeat(2001), action: 'Delete', cancel: 'Cancel' })).rejects.toThrow()
    await expect(invoke('ui:confirm', app, { message: 'Delete?', action: '', cancel: 'Cancel' })).rejects.toThrow()
  })

  it('refuses a relaunch while P6 is not built, and records nothing for a language seen', async () => {
    expect(await invoke('ui:relaunch', app, 'p1')).toMatchObject({ ok: false })
    await invoke('ui:noteSeen', app, 'bn')
  })

  it('answers every new channel only to the app’s own page', async () => {
    for (const [channel, args] of [
      ['ui:info', []],
      ['ui:setPrefs', [{}]],
      ['ui:relaunch', []],
      ['ui:noteSeen', ['bn']],
      ['ui:confirm', [{ message: 'x', action: 'y', cancel: 'z' }]],
      ['export:probeCodec', ['hevc']],
      ['export:writeTimeline', [{}]],
      ['export:savePresetFile', ['A', []]],
      ['export:openPresetFile', []]
    ] as const)
      await expect(invoke(channel, stranger, ...args), channel).rejects.toThrow(/Not allowed/)
    expect(await invoke('export:probeCodec', app, 'hevc')).toEqual([])
    await expect(invoke('export:probeCodec', app, 'h264')).rejects.toThrow()
    expect(await invoke('export:openPresetFile', app)).toBeNull()
  })
})
