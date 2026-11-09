/**
 * *Copy guide* and *Copy screenshot* in main and the preload (docs/design/smart-tools.md §5.8): the
 * main side of test 110 of §22.1 (the renderer's side is in guidePanel.test.ts).
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  written: [] as unknown[],
  images: [] as unknown[],
  invoked: [] as unknown[][]
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', isPackaged: false, on: () => undefined, getAppPath: () => '/nonexistent' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  ipcRenderer: { invoke: (...args: unknown[]) => (h.invoked.push(args), Promise.resolve()) },
  clipboard: {
    write: async (items: { entries: Record<string, unknown> }[]) => {
      for (const item of items) {
        const blob = item.entries['image/png']
        if (blob instanceof Blob) h.images.push({ type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) })
        else h.written.push(item.entries)
      }
    }
  },
  ClipboardItem: class {
    entries: Record<string, unknown>
    constructor(entries: Record<string, unknown>) {
      this.entries = entries
    }
  },
  dialog: {},
  shell: {},
  safeStorage: { isEncryptionAvailable: () => true },
  protocol: {},
  BrowserWindow: class {}
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => null }))

const { registerGuideIpc } = await import('../src/main/guide/guideIpc')
const { GUIDE_CHANNELS, GUIDE_SAVE_LIMITS } = await import('../src/shared/api/guide')
const { guideApi } = await import('../src/preload/guide')
registerGuideIpc()

const APP = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
const app = { sender: {}, senderFrame: { url: APP } }
const call = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => h.handlers.get(channel)!(app, ...args))
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

beforeEach(() => {
  h.written.length = 0
  h.images.length = 0
  h.invoked.length = 0
})

describe('test 110: Copy guide and Copy screenshot (main)', () => {
  it('writes the HTML and the plain text together', async () => {
    await call(GUIDE_CHANNELS.copy, { html: '<h1>Billing</h1>', text: 'Billing\n\n1. Click “Export”\n' })
    expect(h.written).toEqual([{ 'text/html': '<h1>Billing</h1>', 'text/plain': 'Billing\n\n1. Click “Export”\n' }])
  })

  it('a 64 MB + 1 HTML or 2 MB + 1 text is refused, in the preload and in main', async () => {
    for (const clip of [{ html: 'x'.repeat(GUIDE_SAVE_LIMITS.html + 1), text: '' }, { html: '', text: 'x'.repeat(GUIDE_SAVE_LIMITS.clipText + 1) }, { html: 1, text: '' }, null]) {
      await expect(call(GUIDE_CHANNELS.copy, clip)).rejects.toThrow()
      await expect(guideApi.copyGuide(clip as never)).rejects.toThrow()
    }
    expect(h.written).toEqual([])
    expect(h.invoked).toEqual([])
  })

  it('Copy screenshot writes one PNG; anything else is refused', async () => {
    await call(GUIDE_CHANNELS.copyImage, PNG)
    expect(h.images).toEqual([{ type: 'image/png', bytes: PNG }])
    // A PNG of 16 MB + 1 is refused as well as what is not a PNG.
    const big = new Uint8Array(GUIDE_SAVE_LIMITS.image + 1)
    big.set(PNG)
    for (const bad of [new Uint8Array([0xff, 0xd8, 0xff, 0]), 'png', big]) await expect(call(GUIDE_CHANNELS.copyImage, bad)).rejects.toThrow()
    await expect(guideApi.copyGuideImage(big)).rejects.toThrow()
    expect(h.images).toHaveLength(1)
  })
})
