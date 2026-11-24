import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The reader's test mirror (docs/design/auto-blur.md §17.3 A9): SSW_READER_BASE_URL points an
 * unpackaged app's download at a local server, as SSW_SPEECH_MODEL_BASE_URL does for the speech
 * models; a packaged app never reads it. Not a numbered test of §17.1: the hook exists for the
 * end-to-end run of the download.
 */

const h = vi.hoisted(() => ({ packaged: false, handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(), calls: [] as unknown[][] }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    },
    getPath: () => '/nowhere',
    getAppPath: () => '/nowhere'
  },
  net: {},
  ipcMain: { handle: (c: string, fn: (e: unknown, ...a: unknown[]) => unknown) => h.handlers.set(c, fn) },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../src/main/security', () => ({ isAppUrl: (url: string) => url === 'file:///flown/index.html' }))
vi.mock('../src/main/privacy/readerModels', () => ({
  cancelReaderDownload: async () => undefined,
  removeReader: async () => ({ status: 'none' }),
  readerState: () => ({ status: 'none' }),
  onReaderState: () => () => undefined,
  downloadReader: (...args: unknown[]) => {
    h.calls.push(args)
    return Promise.resolve({ status: 'ready', bytes: 1, decodeMs: null })
  }
}))

const { registerReaderIpc, testMirror } = await import('../src/main/privacy/readerIpc')
const { PRIVACY_CHANNELS } = await import('../src/shared/api/privacy')

const FILE = { file: 'PP-OCRv6_tiny_det_onnx/inference.onnx', bytes: 1, sha256: '0'.repeat(64), repo: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx', commit: 'c' }

describe("the reader's test mirror", () => {
  beforeEach(() => {
    h.packaged = false
    h.calls = []
    delete process.env.SSW_READER_BASE_URL
  })

  it('is read only by an unpackaged app, and only when set', () => {
    expect(testMirror(true, { SSW_READER_BASE_URL: 'http://127.0.0.1:9000/' })).toEqual({})
    expect(testMirror(false, {})).toEqual({})
    const deps = testMirror(false, { SSW_READER_BASE_URL: 'http://127.0.0.1:9000/' })
    expect(deps.testBase).toBe('http://127.0.0.1:9000/')
    expect(deps.sources?.(FILE)).toEqual(['http://127.0.0.1:9000/PP-OCRv6_tiny_det_onnx/inference.onnx'])
  })

  it("the download channel passes it, and a packaged app's does not", async () => {
    registerReaderIpc()
    const download = h.handlers.get(PRIVACY_CHANNELS.downloadReader)!
    const app = { senderFrame: { url: 'file:///flown/index.html' } }
    process.env.SSW_READER_BASE_URL = 'http://127.0.0.1:9000'
    await download(app)
    const deps = h.calls[0][2] as { testBase?: string; sources?: (f: typeof FILE) => string[] }
    expect(deps.testBase).toBe('http://127.0.0.1:9000')
    expect(deps.sources?.(FILE)).toEqual(['http://127.0.0.1:9000/PP-OCRv6_tiny_det_onnx/inference.onnx'])
    h.packaged = true
    await download(app)
    expect(h.calls[1][2]).toEqual({})
  })
})
