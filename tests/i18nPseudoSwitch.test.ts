import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * FLOWN_I18N_PSEUDO (docs/design/output-and-languages.md §12.3, §16.3): in an unpackaged build,
 * en-XA, bn-XA or ar-XB starts Flown in that pseudo-locale, from the folder `npm run i18n:pseudo`
 * writes, standing in for the UI language it is made for; ar-XB's page is right to left. A packaged
 * build never reads the variable.
 */
const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-pseudo-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  packaged: false,
  /** The app's folder of this "unpackaged build" (app.getAppPath), where scripts/i18n/pseudo/ is. */
  appPath: null as string | null
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(h.root, name),
    getAppPath: () => h.appPath ?? require('node:path').join(h.root, 'app'),
    get isPackaged() {
      return h.packaged
    },
    getPreferredSystemLanguages: () => ['en-US'],
    getSystemLocale: () => 'en-US',
    relaunch: () => undefined,
    quit: () => undefined,
    on: () => undefined
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  shell: {}
}))
vi.mock('../src/main/updates/updatesIpc', () => ({ busyReason: () => null }))
vi.mock('../src/main/speech/service', () => ({ speechDownloading: () => false }))
vi.mock('../src/main/assets/assetStore', () => ({ assetDownloading: () => false }))
vi.mock('../src/main/soundLibrary/store', () => ({ bedDownloading: () => false }))
vi.mock('../src/main/localAi/models', () => ({ localModelDownloading: () => false }))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({}) }))

const { registerPrefsIpc, writePrefSync, readPrefSync } = await import('../src/main/prefsIpc')
const i18n = await import('../src/main/i18n')
const { t, uiLanguage, uiDir } = await import('../src/shared/i18n/t')
const pseudo = require('../scripts/i18n/lib/pseudo.cjs') as { PSEUDO_LOCALES: string[]; PSEUDO_SLOT: Record<string, string>; pseudoDir(locale: string): 'ltr' | 'rtl' }

const page = { sender: { id: 1 }, senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).toString() } }
const uiInfo = async (): Promise<Record<string, unknown>> => (await h.handlers.get('ui:info')!(page)) as Record<string, unknown>

beforeAll(() => {
  mkdirSync(path.join(h.root, 'userData'), { recursive: true })
  // What `npm run i18n:pseudo` writes, under the app folder of this "unpackaged build".
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/i18n/pseudo.mjs'), '--out', path.join(h.root, 'app', 'scripts', 'i18n', 'pseudo')], { stdio: 'ignore' })
  registerPrefsIpc()
  i18n.registerUiIpc()
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => {
  h.packaged = false
  delete process.env.SSW_I18N_CATALOGUE_DIR
  writePrefSync('ui', null)
})
afterEach(() => {
  delete process.env.FLOWN_I18N_PSEUDO
  h.packaged = false
  i18n.initUiLanguage()
})

describe('FLOWN_I18N_PSEUDO (§16.3, development builds only)', () => {
  it('names the same pseudo-locales, languages and directions as npm run i18n:pseudo', () => {
    expect(Object.keys(i18n.PSEUDO_LOCALES).sort()).toEqual([...pseudo.PSEUDO_LOCALES].sort())
    for (const locale of pseudo.PSEUDO_LOCALES) expect(i18n.PSEUDO_LOCALES[locale]).toEqual({ language: pseudo.PSEUDO_SLOT[locale], dir: pseudo.pseudoDir(locale) })
  })

  it('starts an unpackaged build in bn-XA: main speaks it and ui:info hands the renderer its catalogue', async () => {
    process.env.FLOWN_I18N_PSEUDO = 'bn-XA'
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'bn', dir: 'ltr', shipped: ['bn'] })
    expect(uiLanguage()).toBe('bn')
    expect(t('errors.cancelled')).toMatch(/[ঀ-৿]/)
    const info = await uiInfo()
    expect(info).toMatchObject({ language: 'bn', dir: 'ltr' })
    const catalogue = info.catalogue as { messages: Record<string, string> }
    expect(catalogue.messages['editor.preview.focusHint.whole']).toMatch(/[ঀ-৿]/)
    // The preference is not changed: the pseudo-locale lasts as long as the variable.
    expect(readPrefSync('ui')).toBeNull()
  })

  it('makes ar-XB’s page right to left and en-XA’s left to right', async () => {
    process.env.FLOWN_I18N_PSEUDO = 'ar-XB'
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'es', dir: 'rtl' })
    expect(uiDir()).toBe('rtl')
    expect(await uiInfo()).toMatchObject({ language: 'es', dir: 'rtl' })
    expect(t('errors.cancelled').startsWith('‏')).toBe(true)
    process.env.FLOWN_I18N_PSEUDO = 'en-XA'
    expect(i18n.initUiLanguage()).toMatchObject({ language: 'es', dir: 'ltr' })
    expect(t('errors.cancelled')).toMatch(/^\[/)
  })

  it('is ignored by a packaged build, whatever it says', async () => {
    h.packaged = true
    for (const locale of ['bn-XA', 'ar-XB', 'en-XA']) {
      process.env.FLOWN_I18N_PSEUDO = locale
      expect(i18n.pseudoLocale()).toBeNull()
      expect(i18n.initUiLanguage()).toMatchObject({ language: 'en', dir: 'ltr', shipped: [] })
      expect(uiLanguage()).toBe('en')
      expect(t('errors.cancelled')).toBe('Cancelled.')
      expect((await uiInfo()).catalogue).toBeUndefined()
    }
  })

  it('starts in English for an unknown name, or before npm run i18n:pseudo has written the folder', () => {
    process.env.FLOWN_I18N_PSEUDO = 'xx-XX'
    expect(i18n.pseudoLocale()).toBeNull()
    expect(i18n.initUiLanguage().language).toBe('en')
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ssw-pseudo-none-'))
    h.appPath = empty
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      process.env.FLOWN_I18N_PSEUDO = 'bn-XA'
      expect(i18n.initUiLanguage()).toMatchObject({ language: 'en', dir: 'ltr' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm run i18n:pseudo'))
    } finally {
      h.appPath = null
      warn.mockRestore()
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
