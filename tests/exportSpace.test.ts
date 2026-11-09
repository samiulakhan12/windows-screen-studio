import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'

/*
 * Free space before a large export (docs/design/output-and-languages.md §5.10; the check of test 22):
 * below 1.2 × the estimate an editing format, a WAV file or stems do not start, with the exact
 * message and the error code `disk-full`; what its encoder sizes is never held back.
 */
const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-export-space-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  saveTo: '',
  free: 0,
  statfsCalls: 0,
  started: 0
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), on: () => undefined, quit: () => undefined, getGPUFeatureStatus: () => ({ '2d_canvas': 'enabled' }), isPackaged: false },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: h.saveTo }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  shell: { showItemInFolder: () => undefined }
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({}) }))
vi.mock('../src/main/projects', () => ({
  projectDir: (id: string) => require('node:path').join(h.root, 'projects', id),
  readProject: async () => {
    throw new Error('no project.json')
  }
}))
vi.mock('../src/main/hwEncoders', async (orig) => ({ ...(await orig<object>()), detectH264Encoders: async () => ['libx264'] }))
vi.mock('../src/main/ffmpeg', async (orig) => {
  const real = await orig<typeof import('../src/main/ffmpeg')>()
  class FrameEncoder {
    constructor(readonly args: string[]) {
      h.started++
    }
    async write(): Promise<void> {}
    async finish(): Promise<void> {}
    kill(): void {}
  }
  return { ...real, FrameEncoder }
})
// The free space the export's folder reports: the real check, with statfs answered here.
vi.mock('../src/main/exportSpace', async (orig) => {
  const real = await orig<typeof import('../src/main/exportSpace')>()
  return {
    ...real,
    spaceProblem: (job: ExportJob, folder: string) =>
      real.spaceProblem(job, folder, async () => {
        h.statfsCalls++
        return { bavail: h.free, bsize: 1 }
      })
  }
})

// The module itself for the check's own tests; exportIpc gets the wrapper above.
const { jobBytes, SPACE_MARGIN, spaceProblem } = await vi.importActual<typeof import('../src/main/exportSpace')>('../src/main/exportSpace')
const { registerExportIpc } = await import('../src/main/exportIpc')
const { fmt } = await import('../src/shared/i18n/fmt')

const out = path.join(h.root, 'Videos')
const app = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).toString() } }
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => h.handlers.get(channel)!(...args)

/** A minute of 1080p60 CineForm: 1,500 MB by the table. */
const cineform: ExportJob = {
  width: 1920,
  height: 1080,
  fps: 60,
  frames: 3600,
  format: 'mov',
  quality: 'high',
  codec: 'cineform',
  video: { kind: 'raw', encoder: 'cfhd', pixelFormat: 'bgr0' },
  clicks: { times: [0.5], volume: 1 },
  outputPath: ''
}

const like = (x: Partial<ExportJob>): ExportJob => ({ ...cineform, ...x })

beforeAll(() => {
  for (const d of ['Videos', 'temp', 'userData']) mkdirSync(path.join(h.root, d), { recursive: true })
  registerExportIpc()
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('the free-space check (test 22)', () => {
  it('estimates what a job writes: the editing formats and stems; 0 for what its encoder sizes', () => {
    expect(jobBytes(cineform)).toBe(1500e6)
    expect(jobBytes({ ...cineform, stems: { stems: ['voice', 'system'] } })).toBe(1500e6 + 2 * 23.04e6)
    expect(jobBytes(like({ codec: undefined, format: 'mp4', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' } }))).toBe(0)
  })

  it('refuses below 1.2 × the estimate with the exact message, and lets 1.2 × through', async () => {
    const need = 1500e6
    const at = (free: number) => async () => ({ bavail: free, bsize: 1 })
    expect(await spaceProblem(cineform, '/x', at(need * SPACE_MARGIN))).toBeNull()
    const refused = await spaceProblem(cineform, '/x', at(need * SPACE_MARGIN - 1))
    expect(refused).toBe(`This export needs about ${fmt.bytes(need)} and the folder has ${fmt.bytes(need * SPACE_MARGIN - 1)} free. Choose another folder or a smaller format.`)
    // Blocks of 4 KB, as statfs reports them; bigint fields too.
    expect(await spaceProblem(cineform, '/x', async () => ({ bavail: 100n, bsize: 4096n }))).toMatch(/^This export needs about /)
  })

  it('never holds back an export its encoder sizes, and lets an export run when the free space cannot be read', async () => {
    const statfs = vi.fn(async () => ({ bavail: 0, bsize: 1 }))
    expect(await spaceProblem(like({ codec: 'hevc', format: 'mp4', video: { kind: 'raw', encoder: 'hevc_nvenc', pixelFormat: 'yuv420p' } }), '/x', statfs)).toBeNull()
    expect(statfs).not.toHaveBeenCalled()
    expect(await spaceProblem(cineform, '/x', async () => Promise.reject(new Error('EIO')))).toBeNull()
  })

  it('export:start refuses before anything runs and reports disk-full; a later start clears the code', async () => {
    const file = path.join(out, 'Edit.mov')
    h.saveTo = file
    await invoke('export:choosePath', {}, 'Edit', 'mov')
    h.free = 1000e6
    const started = h.started
    await expect(invoke('export:start', { sender: new EventEmitter() }, 'p1', { ...cineform, outputPath: file })).rejects.toThrow(/This export needs about 1\.50 GB and the folder has 1\.00 GB free/)
    expect(h.started).toBe(started)
    expect(await invoke('export:errorCode', app)).toBe('disk-full')
    h.free = 2000e6
    await invoke('export:start', { sender: new EventEmitter() }, 'p1', { ...cineform, outputPath: file })
    expect(h.started).toBe(started + 1)
    expect(await invoke('export:errorCode', app)).toBeNull()
    await invoke('export:cancel')
  })
})
