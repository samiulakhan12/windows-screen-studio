import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'

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
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: h.saveTo }) },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  shell: { showItemInFolder: () => undefined }
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({}) }))
vi.mock('../src/main/projects', () => ({ projectDir: (id: string) => path.join(h.root, 'projects', id) }))
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
    fs.writeFileSync(args[args.length - 1], 'pass')
    const run = { args, kill: () => undefined, exit: (ok: boolean) => settle(ok), done }
    h.runs.push(run)
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
