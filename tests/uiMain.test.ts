import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUSY_COPY } from '../src/shared/updates/updates'

/*
 * The UI language in main (docs/design/output-and-languages.md §9.4, §21.6): the language chosen at
 * start from the preference, Windows' languages and what ships; main's own texts from its catalogue
 * (test 56); the offer and the languages Flown knows offline (tests 51, 58); a relaunch refused
 * while anything would be lost, and the project reopened once after it (test 79). The catalogues
 * come from the fixture folder through SSW_I18N_CATALOGUE_DIR, which only an unpackaged build reads.
 */
const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-ui-main-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  packaged: false,
  preferred: ['en-US'] as string[],
  locale: 'en-US',
  relaunch: vi.fn(),
  quit: vi.fn(),
  busy: null as string | null,
  downloads: { speech: false, asset: false, bed: false, local: false }
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(h.root, name),
    get isPackaged() {
      return h.packaged
    },
    getPreferredSystemLanguages: () => h.preferred,
    getSystemLocale: () => h.locale,
    relaunch: h.relaunch,
    quit: h.quit,
    on: () => undefined
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: async () => ({ response: 0 }), showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: {}
}))
// What a relaunch waits for: busyReason (the recording, exports, captions, …) and the four downloads.
vi.mock('../src/main/updates/updatesIpc', () => ({ busyReason: () => h.busy }))
vi.mock('../src/main/speech/service', () => ({ speechDownloading: () => h.downloads.speech }))
vi.mock('../src/main/assets/assetStore', () => ({ assetDownloading: () => h.downloads.asset }))
vi.mock('../src/main/soundLibrary/store', () => ({ bedDownloading: () => h.downloads.bed }))
vi.mock('../src/main/localAi/models', () => ({ localModelDownloading: () => h.downloads.local }))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({}) }))

const { registerPrefsIpc, readPrefSync, writePrefSync } = await import('../src/main/prefsIpc')
const i18n = await import('../src/main/i18n')
const { t, uiLanguage, formatLocale } = await import('../src/shared/i18n/t')
const { saveFilters } = await import('../src/main/exportIpc')
const { speechModel } = await import('../src/shared/speech/catalog')

const FIXTURES = path.join(__dirname, 'fixtures/i18n')
const app = { sender: { id: 1 }, senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).toString() } }
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => h.handlers.get(channel)!(app, ...args)
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const argv = [...process.argv]

beforeAll(() => {
  mkdirSync(path.join(h.root, 'userData'), { recursive: true })
  registerPrefsIpc()
  i18n.registerUiIpc()
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => {
  process.env.SSW_I18N_CATALOGUE_DIR = FIXTURES
  delete process.env.SSW_PREFERRED_LANGUAGES
  delete process.env.SSW_RELAUNCH_LOG
  h.packaged = false
  h.preferred = ['en-US']
  h.busy = null
  h.downloads = { speech: false, asset: false, bed: false, local: false }
  h.relaunch.mockClear()
  h.quit.mockClear()
  writePrefSync('ui', null)
  rmSync(path.join(h.root, 'userData', 'speech-models'), { recursive: true, force: true })
})
afterEach(() => {
  process.argv.splice(0, process.argv.length, ...argv)
  delete process.env.SSW_I18N_CATALOGUE_DIR
  i18n.initUiLanguage()
})

describe('the language main starts in (§9.4 step 1, test 51)', () => {
  it('starts in English with no preference, and in a shipped language when it is chosen', () => {
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'en', shipped: ['bn'], preview: ['bn'], offer: null })
    expect(uiLanguage()).toBe('en')
    writePrefSync('ui', { language: 'bn' })
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'bn', formatLocale: 'bn', dir: 'ltr', digits: 'native' })
    expect(uiLanguage()).toBe('bn')
    expect(formatLocale()).toBe('bn')
  })

  it('takes the system locale’s region and the digits choice into the format locale', () => {
    h.locale = 'bn-BD'
    writePrefSync('ui', { language: 'bn', digits: 'western' })
    expect(i18n.initUiLanguage().formatLocale).toBe('bn-BD-u-nu-latn')
    h.locale = 'en-US'
  })

  it('follows Windows only when asked to, and only into a language that ships', () => {
    h.preferred = ['bn-IN', 'en-US']
    expect(i18n.initUiLanguage().language).toBe('en')
    writePrefSync('ui', { language: 'system' })
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'bn', system: 'bn' })
    h.preferred = ['hi-IN']
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'en', system: 'en' })
  })

  it('is English when nothing ships: no fixture folder in a packaged build, and a language with no catalogue', () => {
    writePrefSync('ui', { language: 'bn' })
    h.packaged = true
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'en', shipped: [] })
    h.packaged = false
    writePrefSync('ui', { language: 'hi' })
    expect(i18n.initUiLanguage().language).toBe('en')
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ssw-ui-shipped-'))
    writeFileSync(path.join(empty, 'shipped.json'), JSON.stringify([{ language: 'bn', preview: false }, { language: 'hi' }]))
    process.env.SSW_I18N_CATALOGUE_DIR = empty
    writePrefSync('ui', { language: 'bn' })
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'en', shipped: [] })
    process.env.SSW_I18N_CATALOGUE_DIR = 'relative/path'
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'en', shipped: [] })
    rmSync(empty, { recursive: true, force: true })
  })

  it('stands in SSW_PREFERRED_LANGUAGES for Windows’ languages in an unpackaged build only', () => {
    process.env.SSW_PREFERRED_LANGUAGES = 'bn-BD, en-US'
    expect(i18n.initUiLanguage().offer).toBe('bn')
    h.packaged = true
    process.env.SSW_I18N_CATALOGUE_DIR = FIXTURES
    expect(i18n.initUiLanguage().offer).toBeNull()
  })
})

describe('the offer and what Flown knows offline (§2.7, tests 51 and 58)', () => {
  it('offers a shipped language Windows lists while the language is absent, and not after Not now', async () => {
    h.preferred = ['bn-BD', 'en-US']
    i18n.initUiLanguage()
    expect(await invoke('ui:info')).toMatchObject({ language: 'en', offer: 'bn' })
    await invoke('ui:setPrefs', { offered: ['bn'] })
    expect(await invoke('ui:info')).toMatchObject({ offer: null, prefs: { offered: ['bn'] } })
    await invoke('ui:setPrefs', { language: 'en' })
    expect(await invoke('ui:info')).toMatchObject({ offer: null })
  })

  it('knows Bangla from an installed Bangla speech model or a project seen in Bangla, with Windows in English', async () => {
    expect(i18n.knownLanguages()).toEqual([])
    const dir = path.join(h.root, 'userData', 'speech-models')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${speechModel('whisper-bn-medium')!.file}.part`), 'half')
    writeFileSync(path.join(dir, speechModel('whisper-small')!.file), 'a multilingual model')
    expect(i18n.knownLanguages()).toEqual([])
    // An empty file is no model.
    writeFileSync(path.join(dir, speechModel('whisper-bn-medium')!.file), '')
    expect(i18n.knownLanguages()).toEqual([])
    writeFileSync(path.join(dir, speechModel('whisper-bn-medium')!.file), 'the Bangla model')
    expect(i18n.knownLanguages()).toEqual(['bn'])
    i18n.initUiLanguage()
    expect(await invoke('ui:info')).toMatchObject({ offer: 'bn' })
    rmSync(dir, { recursive: true, force: true })
    expect(await invoke('ui:info')).toMatchObject({ offer: null })
    await invoke('ui:noteSeen', 'bn')
    expect(i18n.knownLanguages()).toEqual(['bn'])
    expect(await invoke('ui:info')).toMatchObject({ offer: 'bn' })
  })

  it('records a language seen once, never English or anything else', async () => {
    await invoke('ui:noteSeen', 'bn')
    // Seen already: the preferences file is not written again.
    const file = path.join(h.root, 'userData', 'editor-prefs.json')
    utimesSync(file, new Date(2000, 0, 1), new Date(2000, 0, 1))
    await invoke('ui:noteSeen', 'bn')
    expect(statSync(file).mtime.getFullYear()).toBe(2000)
    for (const junk of ['en', 'xx', 3, null, ['bn']]) await invoke('ui:noteSeen', junk)
    expect(readPrefSync('ui')).toEqual({ seen: ['bn'] })
    await invoke('ui:setPrefs', { language: 'system', digits: 'western' })
    await invoke('ui:noteSeen', 'hi')
    expect(readPrefSync('ui')).toEqual({ language: 'system', digits: 'western', seen: ['hi'] })
  })
})

describe('main’s texts come from its catalogue (test 56)', () => {
  const ENGLISH = {
    'main.saveFilter.wav': 'WAV audio',
    'main.presetFile.saveTitle': 'Save presets',
    'main.presetFile.openTitle': 'Import presets',
    'main.presetFile.filter': 'Flown presets',
    'main.relaunch.download': 'Wait for the download to finish, or stop it.',
    'main.confirm.cancel': 'Cancel'
  } as const

  it('in English: exactly today’s texts, the save dialog’s filters included', () => {
    i18n.initUiLanguage()
    for (const [key, text] of Object.entries(ENGLISH)) expect(t(key as keyof typeof ENGLISH)).toBe(text)
    expect(saveFilters()).toEqual({
      mp4: { name: 'MP4 video', extensions: ['mp4'] },
      gif: { name: 'GIF', extensions: ['gif'] },
      webm: { name: 'WebM video', extensions: ['webm'] },
      mov: { name: 'QuickTime movie', extensions: ['mov'] },
      m4a: { name: 'M4A audio', extensions: ['m4a'] },
      wav: { name: 'WAV audio', extensions: ['wav'] },
      png: { name: 'PNG image', extensions: ['png'] }
    })
  })

  it('in Bangla: the dialog titles, filter names and reasons of main’s catalogue, English for a key it lacks', () => {
    writePrefSync('ui', { language: 'bn' })
    i18n.initUiLanguage()
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, 'bn.main.json'), 'utf8')) as { messages: Record<string, string> }
    for (const key of Object.keys(ENGLISH)) expect(t(key as keyof typeof ENGLISH)).toBe(fixture.messages[key])
    expect(saveFilters().wav.name).toBe('‹bn› WAV অডিও')
    expect(t('errors.stems.failed')).toBe('The sound stems could not be written.')
  })
})

describe('relaunching (§9.4 step 6, test 79)', () => {
  it('refuses with each busy reason, quitting nothing', async () => {
    i18n.initUiLanguage()
    for (const reason of Object.values(BUSY_COPY)) {
      h.busy = reason
      expect(i18n.relaunchBlocker()).toBe(reason)
      expect(await invoke('ui:relaunch', 'p1')).toEqual({ ok: false, reason })
    }
    await tick()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('refuses while a speech model, caption fonts, music or a model for AI on this PC downloads, in the UI language', async () => {
    i18n.initUiLanguage()
    for (const which of ['speech', 'asset', 'bed', 'local'] as const) {
      h.downloads = { speech: false, asset: false, bed: false, local: false, [which]: true }
      expect(i18n.relaunchBlocker(), which).toBe('Wait for the download to finish, or stop it.')
      expect(await invoke('ui:relaunch')).toEqual({ ok: false, reason: 'Wait for the download to finish, or stop it.' })
    }
    h.busy = BUSY_COPY.export
    expect(i18n.relaunchBlocker()).toBe(BUSY_COPY.export)
    h.busy = null
    writePrefSync('ui', { language: 'bn' })
    i18n.initUiLanguage()
    expect(i18n.relaunchBlocker()).toBe('‹bn› ডাউনলোড · Wait for the download to finish, or stop it.')
    await tick()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('relaunches with today’s arguments and the project to open, then quits', async () => {
    process.argv.splice(0, process.argv.length, '/app/flown', '.', '--flown-open=old', '--trace')
    expect(await invoke('ui:relaunch', 'proj_1-a')).toEqual({ ok: true })
    expect(h.relaunch).toHaveBeenCalledWith({ args: ['.', '--trace', '--flown-open=proj_1-a'] })
    expect(h.quit).not.toHaveBeenCalled()
    await tick()
    expect(h.quit).toHaveBeenCalledTimes(1)
    for (const bad of ['../x', 'a b', '', 'x'.repeat(129), 7]) {
      h.relaunch.mockClear()
      expect(await invoke('ui:relaunch', bad)).toEqual({ ok: true })
      expect(h.relaunch).toHaveBeenCalledWith({ args: ['.', '--trace'] })
    }
  })

  it('records the arguments instead of relaunching under SSW_RELAUNCH_LOG, in an unpackaged build only', async () => {
    const log = path.join(h.root, 'relaunch.json')
    process.env.SSW_RELAUNCH_LOG = log
    process.argv.splice(0, process.argv.length, '/app/flown', '.')
    expect(await invoke('ui:relaunch', 'p2')).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({ args: ['.', '--flown-open=p2'] })
    expect(h.relaunch).not.toHaveBeenCalled()
    h.packaged = true
    await invoke('ui:relaunch', 'p2')
    expect(h.relaunch).toHaveBeenCalledWith({ args: ['.', '--flown-open=p2'] })
  })

  it('gives the project to reopen once, and only a project id', async () => {
    process.argv.splice(0, process.argv.length, '/app/flown', '.', '--flown-open=proj-7')
    expect(i18n.initUiLanguage().reopen).toBe('proj-7')
    expect(await invoke('ui:info')).toMatchObject({ reopen: 'proj-7' })
    expect(await invoke('ui:info')).toMatchObject({ reopen: null })
    process.argv.splice(0, process.argv.length, '/app/flown', '--flown-open=../../etc')
    i18n.initUiLanguage()
    expect(await invoke('ui:info')).toMatchObject({ reopen: null })
    expect(i18n.reopenArgument(['x', '--flown-open=a_b-9'])).toBe('a_b-9')
    expect(i18n.reopenArgument(['x', '--flown-open='])).toBeNull()
  })
})

describe('the renderer’s catalogue from the fixture folder (test 55)', () => {
  it('goes with ui:info in an unpackaged build only, and never in English', async () => {
    i18n.initUiLanguage()
    expect(await invoke('ui:info')).not.toHaveProperty('catalogue')
    writePrefSync('ui', { language: 'bn' })
    i18n.initUiLanguage()
    const info = (await invoke('ui:info')) as { catalogue?: { messages: Record<string, string>; latn: string[] } }
    expect(info.catalogue?.messages['language.section.title']).toBe('ভাষা')
    expect(info.catalogue?.latn).toEqual(['language.digits.western'])
    h.packaged = true
    expect(await invoke('ui:info')).not.toHaveProperty('catalogue')
  })
})
