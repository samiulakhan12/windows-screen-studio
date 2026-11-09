/**
 * Saving a guide (docs/design/smart-tools.md §5.8, §16 rules 12 and 13): test 28 of §22.1. The save
 * and folder dialogs and the print are faked; the files are written to a private temporary folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  save: null as string | null,
  folder: null as string | null,
  dialogs: [] as { kind: string; options: Record<string, unknown> }[],
  shown: [] as string[],
  invoked: [] as unknown[][],
  printed: [] as { html: string; opts: unknown }[]
}))
h.root = mkdtempSync(path.join(tmpdir(), 'w11-save-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), isPackaged: false, on: () => undefined, getAppPath: () => '/nonexistent' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  ipcRenderer: { invoke: (...args: unknown[]) => (h.invoked.push(args), Promise.resolve('sent')) },
  dialog: {
    showSaveDialog: (_w: unknown, options: Record<string, unknown>) => (h.dialogs.push({ kind: 'save', options }), Promise.resolve(h.save ? { canceled: false, filePath: h.save } : { canceled: true })),
    showOpenDialog: (_w: unknown, options: Record<string, unknown>) => (h.dialogs.push({ kind: 'open', options }), Promise.resolve(h.folder ? { canceled: false, filePaths: [h.folder] } : { canceled: true, filePaths: [] }))
  },
  shell: { showItemInFolder: (file: string) => h.shown.push(file) },
  clipboard: {},
  ClipboardItem: class {},
  safeStorage: { isEncryptionAvailable: () => true },
  protocol: {},
  BrowserWindow: class {}
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: {} }) }))
vi.mock('../src/main/guide/printPdf', () => ({
  PRINT_DIR: 'tmp/guide-print',
  printGuidePdf: async (html: string, opts: unknown) => (h.printed.push({ html, opts }), Buffer.from('%PDF-1.7\nguide\n')),
  sweepGuidePrint: async () => []
}))

const { registerGuideIpc } = await import('../src/main/guide/guideIpc')
const { guideNameOk, checkGuidePayload, writeGuideFiles } = await import('../src/main/guide/writeGuide')
const { isExportedFile } = await import('../src/main/exportIpc')
const { GUIDE_CHANNELS, GUIDE_SAVE_LIMITS, guidePayloadProblem } = await import('../src/shared/api/guide')
const { guideApi } = await import('../src/preload/guide')
registerGuideIpc()
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const APP = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
const app = { sender: {}, senderFrame: { url: APP } }
const other = { sender: {}, senderFrame: { url: 'https://example.com/' } }
const call = (e: object, channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => h.handlers.get(channel)!(e, ...args))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])

let n = 0
const out = (): string => {
  const dir = path.join(h.root, `out-${n++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  h.save = null
  h.folder = null
  h.dialogs.length = 0
  h.shown.length = 0
  h.invoked.length = 0
  h.printed.length = 0
})

describe('test 28: guide:save', () => {
  it('a name with \\ / : * ? " < > | or CON falls back to "Guide"', () => {
    for (const bad of ['a\\b', 'a/b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'CON', 'con', 'NUL', 'com1', 'LPT9', '.hidden', 'trailing.', ' lead', 'x'.repeat(121), '']) {
      expect(guideNameOk(bad), bad).toBe(false)
      if (bad.length <= 120) expect(checkGuidePayload({ format: 'html', name: bad, html: '<p></p>' }).name, bad).toBe('Guide')
      else expect(() => checkGuidePayload({ format: 'html', name: bad, html: '<p></p>' })).toThrow()
    }
    expect(guideNameOk('Billing guide')).toBe(true)
    expect(guideNameOk('বিলিং গাইড')).toBe(true)
    expect(guideNameOk('Console tour')).toBe(true)
  })

  it('PDF: the dialog in Documents, printed by main, written into place and remembered for Show in folder and Share', async () => {
    const dir = out()
    h.save = path.join(dir, 'Billing guide')
    const html = '<ol class="steps"><li class="step"></li><li class="step"></li></ol>'
    const r = (await call(app, GUIDE_CHANNELS.save, { format: 'pdf', name: 'Billing guide', html, page: 'Letter' })) as { path: string; bytes: number }
    expect(h.dialogs[0].kind).toBe('save')
    expect(h.dialogs[0].options.defaultPath).toBe(path.join(h.root, 'documents', 'Billing guide.pdf'))
    expect(h.printed[0]).toEqual({ html, opts: { page: 'Letter', steps: 2 } })
    expect(r.path).toBe(path.join(dir, 'Billing guide.pdf'))
    expect(readFileSync(r.path, 'latin1').startsWith('%PDF-')).toBe(true)
    expect(r.bytes).toBe(readFileSync(r.path).byteLength)
    expect(readdirSync(dir)).toEqual(['Billing guide.pdf'])
    expect(isExportedFile(r.path)).toBe(true)
    await call(app, GUIDE_CHANNELS.showItem, r.path)
    expect(h.shown).toEqual([r.path])
  })

  it('HTML and demo: written as the page sent; a cancelled dialog writes nothing', async () => {
    const dir = out()
    h.save = path.join(dir, 'Billing demo.html')
    const r = (await call(app, GUIDE_CHANNELS.save, { format: 'demo', name: 'Billing demo', html: '<!DOCTYPE html><p>demo</p>' })) as { path: string }
    expect(readFileSync(r.path, 'utf8')).toBe('<!DOCTYPE html><p>demo</p>')
    expect(isExportedFile(r.path)).toBe(true)
    h.save = null
    expect(await call(app, GUIDE_CHANNELS.save, { format: 'html', name: 'X', html: '<p></p>' })).toBeNull()
  })

  it('Markdown makes a new folder (" (2)" when taken) with guide.md and the images it names', async () => {
    const parent = out()
    h.folder = parent
    const markdown = '# Billing\n\n## 1. A\n\n![Step 1: A](images/step-01.png)\n\n## 2. B\n\n![Step 2: B](images/step-02.png)\n\n![Actual](images/actual.png)\n'
    const payload = { format: 'markdown', name: 'Billing guide', markdown, images: [PNG, PNG, PNG] }
    const a = (await call(app, GUIDE_CHANNELS.save, payload)) as { path: string }
    const b = (await call(app, GUIDE_CHANNELS.save, payload)) as { path: string }
    expect(a.path).toBe(path.join(parent, 'Billing guide'))
    expect(b.path).toBe(path.join(parent, 'Billing guide (2)'))
    expect(h.dialogs[0].options.buttonLabel).toBe('Save the guide in this folder')
    expect(readFileSync(path.join(a.path, 'guide.md'), 'utf8')).toBe(markdown)
    expect(readdirSync(path.join(a.path, 'images')).sort()).toEqual(['actual.png', 'step-01.png', 'step-02.png'])
    // A folder it wrote can be shown.
    await call(app, GUIDE_CHANNELS.showItem, a.path)
    expect(h.shown).toEqual([a.path])
    // Pictures that do not match the text are refused, and leave no folder.
    await expect(call(app, GUIDE_CHANNELS.save, { ...payload, images: [PNG] })).rejects.toThrow(/do not match/)
    expect(existsSync(path.join(parent, 'Billing guide (3)'))).toBe(false)
  })

  it('an image that is not PNG, JPEG or WebP, the 301st image, a 64 MB + 1 HTML and 256 MB + 1 in all are refused, in the preload and in main', async () => {
    const big = (bytes: number): Uint8Array => {
      const b = new Uint8Array(bytes)
      b.set(PNG)
      return b
    }
    const cases: unknown[] = [
      { format: 'markdown', name: 'G', markdown: '#', images: [GIF] },
      { format: 'markdown', name: 'G', markdown: '#', images: Array.from({ length: 301 }, () => PNG) },
      { format: 'html', name: 'G', html: 'x'.repeat(GUIDE_SAVE_LIMITS.html + 1) },
      { format: 'markdown', name: 'G', markdown: '#', images: [...Array.from({ length: 16 }, () => big(GUIDE_SAVE_LIMITS.image)), big(PNG.length)] },
      { format: 'exe', name: 'G', html: '' },
      { format: 'html', name: 'G'.repeat(121), html: '' }
    ]
    for (const c of cases) {
      expect(guidePayloadProblem(c)).not.toBeNull()
      await expect(guideApi.saveGuide(c as never)).rejects.toThrow()
      expect(() => checkGuidePayload(c)).toThrow()
      await expect(call(app, GUIDE_CHANNELS.save, c)).rejects.toThrow()
    }
    expect(h.invoked).toEqual([])
    expect(h.dialogs).toEqual([])
    // JPEG and WebP pass the payload check (as PNG does).
    expect(guidePayloadProblem({ format: 'markdown', name: 'G', markdown: '#', images: [PNG, JPEG, WEBP] })).toBeNull()
    // Exactly at the limits is accepted.
    expect(guidePayloadProblem({ format: 'html', name: 'G', html: 'x'.repeat(GUIDE_SAVE_LIMITS.html) })).toBeNull()
    await guideApi.saveGuide({ format: 'html', name: 'G', html: '<p></p>' })
    expect(h.invoked).toEqual([[GUIDE_CHANNELS.save, { format: 'html', name: 'G', html: '<p></p>' }]])
  })

  it('a path it did not write is refused by guide:showItem', async () => {
    for (const bad of [path.join(h.root, 'nope.pdf'), 'relative.pdf', 42, null]) {
      await expect(call(app, GUIDE_CHANNELS.showItem, bad)).rejects.toThrow('Flown did not save that file.')
    }
    expect(h.shown).toEqual([])
  })

  it('a sender that is not the app’s page is refused', async () => {
    h.save = path.join(out(), 'x.html')
    for (const channel of Object.values(GUIDE_CHANNELS)) await expect(call(other, channel, { format: 'html', name: 'x', html: '' })).rejects.toThrow('Not allowed')
    expect(h.dialogs).toEqual([])
  })

  it('writeGuideFiles never writes a PDF that is not one, nor to a relative path', async () => {
    await expect(writeGuideFiles(path.join(out(), 'a.pdf'), { format: 'pdf', name: 'a', html: '' }, Buffer.from('nope'))).rejects.toThrow()
    await expect(writeGuideFiles('a.html', { format: 'html', name: 'a', html: '' })).rejects.toThrow()
  })
})
