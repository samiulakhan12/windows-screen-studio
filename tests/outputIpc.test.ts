import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'

/*
 * The seams of output and the app in exportIpc.ts (docs/design/output-and-languages.md §21.0): the
 * save dialog's filters with WAV, stems refused in a batch, the stem step after the video with a
 * signal a cancel reaches, and the error code channel. The fake ffmpeg is exportIpc.test.ts's.
 */
const h = vi.hoisted(() => {
  const root = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-output-ipc-')) as string
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

// A user's own looping Opus music is decoded before the encoder starts (editing polish §0 decision 2): a stand-in that waits for the export's signal.
const loops = vi.hoisted(() => ({ calls: [] as { file: string; seconds: number; signal: AbortSignal }[] }))
vi.mock('../src/main/musicLoopCache', () => ({
  loopableMusic: (_dir: string, file: string, _ff: string, opts: { seconds: number; signal: AbortSignal }) =>
    new Promise<string>((_resolve, reject) => {
      loops.calls.push({ file, seconds: opts.seconds, signal: opts.signal })
      opts.signal.addEventListener('abort', () => reject(new Error('The export was cancelled.')), { once: true })
    })
}))


const stemStep = vi.hoisted(() => ({
  calls: [] as { job: unknown; output: string; signal: AbortSignal; projectId: string; videoThere: boolean }[],
  result: {} as Record<string, unknown>,
  hold: null as Promise<void> | null
}))
vi.mock('../src/main/stemsRun', () => ({
  writeStemsStep: async (job: unknown, output: string, signal: AbortSignal, projectId: string) => {
    stemStep.calls.push({ job, output, signal, projectId, videoThere: require('node:fs').existsSync(output) })
    if (stemStep.hold) await stemStep.hold
    return stemStep.result
  }
}))

import { registerExportIpc, saveFilters, setExportErrorCode } from '../src/main/exportIpc'

const out = path.join(h.root, 'Videos')
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => h.handlers.get(channel)!(...args)
// The app's page as security.ts sees it from src/main (appPage: ../renderer/index.html).
const app = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).toString() } }

function jobFor(file: string, extra: Partial<ExportJob> = {}): ExportJob {
  return {
    width: 1280,
    height: 720,
    fps: 60,
    frames: 60,
    format: 'mp4',
    quality: 'high',
    video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
    clicks: { times: [0.5], volume: 1 },
    outputPath: file,
    ...extra
  }
}

beforeAll(() => {
  for (const d of ['Videos', 'temp', 'userData']) mkdirSync(path.join(h.root, d), { recursive: true })
  registerExportIpc()
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('export IPC seams of wave 12', () => {
  it('offers WAV in the save dialog, with every filter of before unchanged', () => {
    const f = saveFilters()
    expect(f.wav).toEqual({ name: 'WAV audio', extensions: ['wav'] })
    expect(f.mp4).toEqual({ name: 'MP4 video', extensions: ['mp4'] })
    expect(f.m4a).toEqual({ name: 'M4A audio', extensions: ['m4a'] })
    expect(f.png).toEqual({ name: 'PNG image', extensions: ['png'] })
    expect(Object.keys(f)).toEqual(['mp4', 'gif', 'webm', 'mov', 'm4a', 'wav', 'png'])
  })

  it('refuses stems for a file of a batch', async () => {
    h.folder = out
    await invoke('export:chooseFolder')
    const file = (await invoke('export:batchPath', {}, out, 'Batch - 1080p.mp4')) as string
    await expect(invoke('export:start', { sender: new EventEmitter() }, 'p1', jobFor(file, { stems: { stems: ['recording'] } }))).rejects.toThrow(/Invalid export settings/)
  })

  it('writes the stems after the video is in place, with the project and a signal, and adds what they report', async () => {
    const file = path.join(out, 'Stems.mp4')
    h.saveTo = file
    await invoke('export:choosePath', {}, 'Stems', 'mp4')
    stemStep.result = { stems: [{ stem: 'recording', path: path.join(out, 'Stems - Recording.wav'), bytes: 10 }] }
    await invoke('export:start', { sender: new EventEmitter() }, 'p7', jobFor(file, { stems: { stems: ['recording'] } }))
    const done = (await invoke('export:finish')) as Record<string, unknown>
    expect(stemStep.calls).toHaveLength(1)
    expect(stemStep.calls[0]).toMatchObject({ output: file, projectId: 'p7', videoThere: true })
    expect(stemStep.calls[0].signal.aborted).toBe(false)
    expect(done.stems).toEqual(stemStep.result.stems)
    expect(done.bytes).toBeGreaterThan(0)
  })

  it('a job without stems never runs the stem step and finishes as before', async () => {
    const file = path.join(out, 'Plain.mp4')
    h.saveTo = file
    await invoke('export:choosePath', {}, 'Plain', 'mp4')
    const before = stemStep.calls.length
    await invoke('export:start', { sender: new EventEmitter() }, 'p1', jobFor(file))
    const done = (await invoke('export:finish')) as Record<string, unknown>
    expect(stemStep.calls.length).toBe(before)
    expect(Object.keys(done)).toEqual(['bytes'])
  })

  it('a cancel during the stem step reaches its signal and never removes the video', async () => {
    const file = path.join(out, 'Cancel.mp4')
    h.saveTo = file
    await invoke('export:choosePath', {}, 'Cancel', 'mp4')
    let release!: () => void
    stemStep.hold = new Promise<void>((r) => (release = r))
    stemStep.result = { stemsProblem: 'cancelled' }
    await invoke('export:start', { sender: new EventEmitter() }, 'p1', jobFor(file, { stems: { stems: ['recording'] } }))
    const finishing = invoke('export:finish')
    await tick()
    const call = stemStep.calls[stemStep.calls.length - 1]
    expect(call.output).toBe(file)
    await invoke('export:cancel')
    expect(call.signal.aborted).toBe(true)
    release()
    stemStep.hold = null
    const done = (await finishing) as Record<string, unknown>
    expect(done.stemsProblem).toBe('cancelled')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('partial')
  })

  it('answers the error code only to the app page', async () => {
    setExportErrorCode('disk-full')
    expect(await invoke('export:errorCode', app)).toBe('disk-full')
    await expect(invoke('export:errorCode', { senderFrame: { url: 'https://example.com/' } })).rejects.toThrow(/Not allowed/)
    setExportErrorCode(null)
    expect(await invoke('export:errorCode', app)).toBeNull()
  })
})
