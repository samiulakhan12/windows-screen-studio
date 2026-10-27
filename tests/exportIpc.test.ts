import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportFinish, ExportJob } from '../src/shared/api/export'

/**
 * The export lifecycle in the main process with a fake ffmpeg: like the real one it
 * creates its output file when it starts and, when killed, exits only a moment
 * later. On Windows the file cannot be deleted until then.
 */
const h = vi.hoisted(() => {
  const root = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-export-ipc-')) as string
  return {
    root,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    appEvents: new Map<string, (...args: unknown[]) => void>(),
    quit: vi.fn(),
    canvasStatus: 'enabled',
    saveTo: '',
    folder: '',
    /** Sizes (bytes) the next fake ffmpeg passes write, in order; 'pass' (4 bytes) when empty. */
    passSizes: [] as number[],
    /** Fake passes exit successfully on their own. */
    autoExit: false,
    encoders: [] as FakeEncoderLike[],
    runs: [] as { args: string[]; kill: () => void; exit: (ok: boolean) => void }[]
  }
  interface FakeEncoderLike {
    args: string[]
    killed: boolean
    output: string
    exit(ok: boolean): void
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(h.root, name),
    on: (event: string, fn: (...args: unknown[]) => void) => h.appEvents.set(event, fn),
    quit: h.quit,
    getGPUFeatureStatus: () => ({ '2d_canvas': h.canvasStatus })
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: h.saveTo }),
    showOpenDialog: async () => ({ canceled: !h.folder, filePaths: h.folder ? [h.folder] : [] })
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  shell: { showItemInFolder: () => undefined }
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({}) }))
vi.mock('../src/main/projects', () => ({
  projectDir: (id: string) => path.join(h.root, 'projects', id),
  // No project.json in these tests: the export then knows of no stems beyond the job's.
  readProject: async () => {
    throw new Error('no project.json')
  }
}))
vi.mock('../src/main/hwEncoders', async (orig) => ({ ...(await orig<object>()), detectH264Encoders: async () => ['libx264'] }))
vi.mock('../src/main/ffmpeg', async (orig) => {
  const real = await orig<typeof import('../src/main/ffmpeg')>()
  const fs = require('node:fs') as typeof import('node:fs')
  class FrameEncoder {
    killed = false
    readonly output: string
    readonly done: Promise<void>
    private settle!: (ok: boolean) => void
    constructor(readonly args: string[]) {
      this.output = args[args.length - 1]
      fs.writeFileSync(this.output, 'partial')
      this.done = new Promise<void>((resolve, reject) => {
        this.settle = (ok) => (ok ? resolve() : reject(new real.FfmpegFailure('The export was cancelled.', 'cancelled')))
      })
      this.done.catch(() => undefined)
      h.encoders.push(this)
    }
    async write(): Promise<void> {
      if (this.killed) throw new real.FfmpegFailure('The export was cancelled.', 'cancelled')
    }
    finish(): Promise<void> {
      this.settle(true)
      return this.done
    }
    kill(): void {
      // Like TerminateProcess: returns at once; the process exits (and closes its files) later.
      this.killed = true
    }
    exit(ok: boolean): void {
      this.settle(ok)
    }
  }
  const startFfmpeg = (args: string[]) => {
    let settle!: (ok: boolean) => void
    const done = new Promise<void>((resolve, reject) => (settle = (ok) => (ok ? resolve() : reject(new Error('stopped')))))
    done.catch(() => undefined)
    // Pass 1 of a two-pass encode writes to '-' (the null muxer): nothing to create.
    const target = args[args.length - 1]
    const size = h.passSizes.shift()
    if (require('node:path').isAbsolute(target)) fs.writeFileSync(target, size ? Buffer.alloc(size) : 'pass')
    const run = { args, kill: () => undefined, exit: (ok: boolean) => settle(ok), done }
    h.runs.push(run)
    if (h.autoExit) setTimeout(() => settle(true), 1)
    return run
  }
  return { ...real, FrameEncoder, startFfmpeg }
})

import { disposeExport, registerExportIpc } from '../src/main/exportIpc'
import { partialPath, tempStem } from '../src/main/exportJob'

const out = path.join(h.root, 'Videos')
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Calls a handler like ipcRenderer.invoke would (a synchronous throw becomes a rejection). */
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => h.handlers.get(channel)!(...args)
const partials = (): string[] => readdirSync(out).filter((f) => f.includes('.partial-'))
const gifTemps = (): string[] => readdirSync(path.join(h.root, 'temp')).filter((f) => f.startsWith('screen-studio-gif-'))
const logged = (): string[] => JSON.parse(readFileSync(path.join(h.root, 'userData', 'export-leftovers.json'), 'utf8'))
const lastEncoder = () => h.encoders[h.encoders.length - 1]

function jobFor(file: string, format: 'mp4' | 'gif' = 'mp4'): ExportJob {
  return {
    width: 1280,
    height: 720,
    fps: format === 'gif' ? 15 : 60,
    frames: 60,
    format,
    quality: 'high',
    video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
    outputPath: file
  }
}

/** A fake webContents: the renderer that started the export. */
const renderer = (): EventEmitter => new EventEmitter()

async function start(file: string, sender = renderer(), format: 'mp4' | 'gif' = 'mp4'): Promise<EventEmitter> {
  h.saveTo = file
  await invoke('export:choosePath', {}, 'x', format)
  await invoke('export:start', { sender }, 'p1', jobFor(file, format))
  return sender
}

// Files an earlier run left behind (it crashed mid-export).
const stalePartial = path.join(h.root, 'Videos', '.Old.partial-99999991-abc.mp4')
const staleGif = path.join(h.root, 'temp', 'screen-studio-gif-99999991-abc.mkv')

beforeAll(async () => {
  for (const d of ['Videos', 'temp', 'userData']) mkdirSync(path.join(h.root, d), { recursive: true })
  writeFileSync(stalePartial, 'old')
  writeFileSync(staleGif, 'old')
  writeFileSync(path.join(h.root, 'userData', 'export-leftovers.json'), JSON.stringify([stalePartial, staleGif]))
  registerExportIpc()
  await tick(50)
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('export clean-up in the main process', () => {
  it('deletes what an earlier run left behind at start-up (audit-B-1)', () => {
    expect(existsSync(stalePartial)).toBe(false)
    expect(existsSync(staleGif)).toBe(false)
    expect(logged()).toEqual([])
  })

  it('cancel while rendering: deletes the partial MP4 only after ffmpeg has exited (audit-B-1)', async () => {
    await start(path.join(out, 'Demo.mp4'))
    const enc = lastEncoder()
    expect(partials()).toHaveLength(1)
    expect(logged()).toEqual([enc.output])
    let cancelled = false
    const cancel = invoke('export:cancel').then(() => (cancelled = true))
    await tick()
    // Killed, but still running: on Windows its file cannot be deleted yet, so nothing tries.
    expect(enc.killed).toBe(true)
    expect(existsSync(enc.output)).toBe(true)
    expect(cancelled).toBe(false)
    enc.exit(false)
    await cancel
    expect(partials()).toEqual([])
    expect(logged()).toEqual([])
    await expect(invoke('export:frame', {}, new Uint8Array(4))).rejects.toThrow(/cancelled/)
  })

  it('cancel while rendering a GIF: deletes the intermediate in the temp folder after ffmpeg exits (audit-B-1)', async () => {
    await start(path.join(out, 'Demo.gif'), renderer(), 'gif')
    const enc = lastEncoder()
    expect(gifTemps()).toHaveLength(1)
    const cancel = invoke('export:cancel')
    await tick()
    expect(existsSync(enc.output)).toBe(true)
    enc.exit(false)
    await cancel
    expect(gifTemps()).toEqual([])
    expect(partials()).toEqual([])
  })

  it('cancel while a GIF is finalizing: stops the palette pass and deletes everything once it exits', async () => {
    const target = path.join(out, 'Final.gif')
    await start(target, renderer(), 'gif')
    const finishing = invoke('export:finish').catch((e: Error) => e)
    await tick()
    const pass = h.runs[h.runs.length - 1]
    expect(pass.args.join(' ')).toContain('palettegen')
    expect(gifTemps().length).toBeGreaterThan(0)
    const cancel = invoke('export:cancel')
    await tick()
    pass.exit(false)
    await cancel
    expect(((await finishing) as Error).message).toMatch(/cancelled/)
    expect(gifTemps()).toEqual([])
    expect(partials()).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(logged()).toEqual([])
  })

  it('a normal export moves the file into place and forgets its temporary files', async () => {
    const target = path.join(out, 'Done.mp4')
    const sender = await start(target)
    expect(sender.listenerCount('destroyed')).toBe(1)
    const r = (await invoke('export:finish')) as { bytes: number }
    expect(r.bytes).toBeGreaterThan(0)
    expect(readFileSync(target, 'utf8')).toBe('partial')
    expect(partials()).toEqual([])
    expect(logged()).toEqual([])
    // The renderer is no longer watched.
    expect(sender.listenerCount('destroyed') + sender.listenerCount('render-process-gone')).toBe(0)
  })

  for (const event of ['render-process-gone', 'destroyed', 'did-navigate']) {
    it(`stops ffmpeg and deletes the partial file when the exporting renderer is gone (${event}, audit-A-3)`, async () => {
      const sender = await start(path.join(out, 'Crash.mp4'))
      const enc = lastEncoder()
      sender.emit(event, {}, { reason: 'crashed' })
      expect(enc.killed).toBe(true)
      await tick()
      expect(existsSync(enc.output)).toBe(true)
      enc.exit(false)
      await tick()
      expect(partials()).toEqual([])
      expect(logged()).toEqual([])
      // Another export has to go through the save dialog again.
      await expect(invoke('export:start', { sender }, 'p1', jobFor(path.join(out, 'Crash.mp4')))).rejects.toThrow(/save dialog/)
    })
  }

  it("a renderer that is gone after its export finished, or another renderer, stops nothing", async () => {
    const first = await start(path.join(out, 'A.mp4'))
    await invoke('export:finish')
    const second = await start(path.join(out, 'B.mp4'))
    const enc = lastEncoder()
    first.emit('destroyed')
    expect(enc.killed).toBe(false)
    await invoke('export:finish')
    expect(existsSync(path.join(out, 'B.mp4'))).toBe(true)
    second.emit('destroyed')
  })

  it('quitting during an export waits until ffmpeg has exited and its files are deleted (audit-B-1)', async () => {
    await start(path.join(out, 'Quit.mp4'))
    const enc = lastEncoder()
    const event = { preventDefault: vi.fn() }
    h.appEvents.get('before-quit')!(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(enc.killed).toBe(true)
    await tick()
    expect(h.quit).not.toHaveBeenCalled()
    enc.exit(false)
    await tick()
    expect(partials()).toEqual([])
    expect(h.quit).toHaveBeenCalledTimes(1)
    // The quit it starts again goes through.
    const again = { preventDefault: vi.fn() }
    h.appEvents.get('before-quit')!(again)
    expect(again.preventDefault).not.toHaveBeenCalled()
  })

  it('will-quit: a synchronous last resort kills ffmpeg and deletes what it can', async () => {
    await start(path.join(out, 'Sync.mp4'))
    const enc = lastEncoder()
    disposeExport()
    expect(enc.killed).toBe(true)
    expect(partials()).toEqual([])
    expect(logged()).toEqual([])
  })

  it('tells the renderer whether canvases are drawn on the GPU (perf-2)', async () => {
    h.canvasStatus = 'enabled'
    expect(await invoke('export:capabilities')).toMatchObject({ gpuCanvas: true, hardwareEncoders: [] })
    h.canvasStatus = 'disabled_software'
    expect(await invoke('export:capabilities')).toMatchObject({ gpuCanvas: false })
  })

  it('names temporary files so the next start can recognise them', () => {
    expect(path.basename(partialPath(path.join(out, 'X.mp4')))).toMatch(/^\.X\.partial-\d+-[0-9a-z]+\.mp4$/)
    expect(path.basename(tempStem(h.root))).toMatch(/^screen-studio-gif-\d+-[0-9a-z]+$/)
  })
})

describe('export:analyzeAudio', () => {
  const appEvent = { senderFrame: { url: require('node:url').pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href } }

  it('accepts only the app page as the sender (it starts the speech helper)', async () => {
    for (const evil of [{}, { senderFrame: { url: 'https://example.com/' } }, { senderFrame: { url: 'file:///tmp/evil.html' } }]) {
      await expect(invoke('export:analyzeAudio', evil, 'p1', ['mic'])).rejects.toThrow('Not allowed')
    }
    await expect(invoke('export:analyzeAudio', appEvent, 42, ['mic'])).rejects.toThrow('Invalid project.')
    // The app page gets the sources that exist (none here).
    expect(await invoke('export:analyzeAudio', appEvent, 'p1', ['mic', 'mix'])).toEqual({})
  })
})

describe('batch exports, size targets and thumbnails in the main process', () => {
  const finishAll = async (): Promise<ExportFinish> => {
    h.autoExit = true
    try {
      return (await invoke('export:finish')) as ExportFinish
    } finally {
      h.autoExit = false
    }
  }

  it('a batch writes only into the chosen folder, never over an existing file, each path once', async () => {
    const folder = path.join(out, 'batch')
    mkdirSync(folder)
    writeFileSync(path.join(folder, 'Demo - Email.mp4'), 'OLD')
    h.folder = folder
    expect(await invoke('export:chooseFolder')).toBe(folder)
    await expect(invoke('export:batchPath', {}, path.join(out, 'elsewhere'), 'a.mp4')).rejects.toThrow(/folder dialog/)
    await expect(invoke('export:batchPath', {}, folder, '../a.mp4')).rejects.toThrow(/file name/)
    const first = (await invoke('export:batchPath', {}, folder, 'Demo - Email.mp4')) as string
    expect(first).toBe(path.join(folder, 'Demo - Email (2).mp4'))
    // Handed out but not written yet: the next one is (3).
    expect(await invoke('export:batchPath', {}, folder, 'Demo - Email.mp4')).toBe(path.join(folder, 'Demo - Email (3).mp4'))
    await invoke('export:start', { sender: renderer() }, 'p1', jobFor(first))
    await invoke('export:finish')
    expect(readFileSync(path.join(folder, 'Demo - Email.mp4'), 'utf8')).toBe('OLD')
    expect(existsSync(first)).toBe(true)
    // Accepted once.
    await expect(invoke('export:start', { sender: renderer() }, 'p1', jobFor(first))).rejects.toThrow(/save dialog/)
    // A path in the folder that was never handed out is refused.
    await expect(invoke('export:start', { sender: renderer() }, 'p1', jobFor(path.join(folder, 'x.mp4')))).rejects.toThrow(/save dialog/)
    h.folder = ''
  })

  it('a size target on x264 runs both passes, then deletes the intermediate and logs', async () => {
    const target = path.join(out, 'Target.mp4')
    h.saveTo = target
    await invoke('export:choosePath', {}, 'x', 'mp4')
    await invoke('export:start', { sender: renderer() }, 'p1', { ...jobFor(target), bitrate: { video: 1_000_000, audio: 0 } })
    const enc = lastEncoder()
    expect(enc.args.join(' ')).toContain('-qp 0 -f matroska')
    const runs = h.runs.length
    await finishAll()
    const passes = h.runs.slice(runs).map((r) => r.args.join(' '))
    expect(passes).toHaveLength(2)
    expect(passes[0]).toContain('-pass 1')
    expect(passes[1]).toContain('-pass 2')
    expect(existsSync(target)).toBe(true)
    expect(gifTemps()).toEqual([])
    expect(partials()).toEqual([])
  })

  it('a GIF over its size limit is made again smaller until it fits, and says how', async () => {
    const target = path.join(out, 'Slack.gif')
    h.saveTo = target
    await invoke('export:choosePath', {}, 'x', 'gif')
    await invoke('export:start', { sender: renderer() }, 'p1', { ...jobFor(target, 'gif'), maxBytes: 3000 })
    // palette, GIF (too big), then palette + GIF of the first reduction (fits).
    h.passSizes = [100, 9000, 100, 2500]
    const runs = h.runs.length
    const r = await finishAll()
    expect(r.bytes).toBe(2500)
    expect(r.reduced).toMatch(/fps/)
    expect(r.overLimit).toBeUndefined()
    expect(h.runs.slice(runs)).toHaveLength(4)
    expect(h.runs[h.runs.length - 1].args.join(' ')).toMatch(/fps=\d+/)
    expect(gifTemps()).toEqual([])
  })

  it('says so when a GIF cannot fit even at the smallest setting', async () => {
    const target = path.join(out, 'Huge.gif')
    h.saveTo = target
    await invoke('export:choosePath', {}, 'x', 'gif')
    await invoke('export:start', { sender: renderer() }, 'p1', { ...jobFor(target, 'gif'), maxBytes: 1000 })
    h.passSizes = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1_000_000 : 100))
    const r = await finishAll()
    h.passSizes = []
    expect(r.overLimit).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('saves a thumbnail only to the path chosen for it, only as a PNG, through a temporary file', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const file = path.join(out, 'thumb.png')
    await expect(invoke('export:saveThumbnail', {}, file, png)).rejects.toThrow(/save dialog/)
    h.saveTo = file
    await invoke('export:choosePath', {}, 'x', 'png')
    await expect(invoke('export:saveThumbnail', {}, file, new Uint8Array(20))).rejects.toThrow(/Invalid thumbnail/)
    expect(await invoke('export:saveThumbnail', {}, file, png)).toEqual({ bytes: png.byteLength })
    expect(Array.from(readFileSync(file))).toEqual(Array.from(png))
    expect(partials()).toEqual([])
    // The approval is used up.
    await expect(invoke('export:saveThumbnail', {}, file, png)).rejects.toThrow(/save dialog/)
  })
})

