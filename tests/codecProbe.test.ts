import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The HEVC and AV1 probe (docs/design/output-and-languages.md §5.9; tests 24 and the probe half of 12):
 * a test encode per GPU encoder in its own pixel format, hevc_mf with -hw_encoding 1, once per codec
 * per session, never at start, the Windows-only encoders only on Windows, and nothing off the allow-list.
 */
const h = vi.hoisted(() => ({ spawned: [] as string[][], handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) }
}))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...real,
    spawn: (_cmd: string, args: string[]) => {
      h.spawned.push(args)
      const proc = Object.assign(new EventEmitter(), { kill: () => undefined })
      setTimeout(() => proc.emit('close', 1), 1)
      return proc
    }
  }
})

const { AV1_ENCODERS, forgetCodecProbes, HEVC_ENCODERS, probeCandidates, probeCodec, probeCodecArgs, probeCodecWith, registerCodecProbeIpc } = await import('../src/main/codecProbe')
const { gpuEncoderOptions, encoderPixelFormat, probeArgs } = await import('../src/main/hwEncoders')
const { ALLOWED_ENCODERS } = await import('../src/shared/render/proFormats')

const after = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]

afterEach(() => {
  forgetCodecProbes()
  h.spawned.length = 0
})

describe('probe arguments (tests 12 and 24)', () => {
  it('each encoder probes in its own pixel format: NV12 for Quick Sync, AMF and Media Foundation, planar 4:2:0 for NVENC', () => {
    expect(Object.fromEntries([...HEVC_ENCODERS, ...AV1_ENCODERS].map((e) => [e, after(probeCodecArgs(e), '-pix_fmt')]))).toEqual({
      hevc_nvenc: 'yuv420p',
      hevc_qsv: 'nv12',
      hevc_amf: 'nv12',
      hevc_mf: 'nv12',
      av1_nvenc: 'yuv420p',
      av1_qsv: 'nv12',
      av1_amf: 'nv12'
    })
    for (const e of [...HEVC_ENCODERS, ...AV1_ENCODERS]) {
      const args = probeCodecArgs(e)
      expect(after(args, '-c:v')).toBe(e)
      expect(after(args, '-frames:v')).toBe('10')
      expect(args.slice(-3)).toEqual(['-f', 'null', '-'])
      expect(ALLOWED_ENCODERS).toContain(e)
    }
  })

  it('hevc_mf carries -hw_encoding 1 in the probe (only Media Foundation does), as h264_mf always has', () => {
    const mf = probeCodecArgs('hevc_mf')
    expect(mf.slice(mf.indexOf('-c:v'), mf.indexOf('-c:v') + 4)).toEqual(['-c:v', 'hevc_mf', '-hw_encoding', '1'])
    for (const e of [...HEVC_ENCODERS, ...AV1_ENCODERS].filter((x) => x !== 'hevc_mf')) expect(probeCodecArgs(e)).not.toContain('-hw_encoding')
    expect(gpuEncoderOptions('hevc_mf')).toEqual(['-hw_encoding', '1'])
    // The H.264 list and probe do not change.
    expect(gpuEncoderOptions('h264_mf')).toEqual(['-hw_encoding', '1'])
    expect(probeArgs('h264_qsv')).toEqual(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30', '-frames:v', '10', '-pix_fmt', 'nv12', '-c:v', 'h264_qsv', '-f', 'null', '-'])
    expect(['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264'].map((e) => encoderPixelFormat(e as 'libx264'))).toEqual(['yuv420p', 'nv12', 'nv12', 'nv12', 'yuv420p'])
  })
})

describe('probeCodec (test 24)', () => {
  it('av1_amf and the Media Foundation encoders only on Windows; libx265 and libaom never', () => {
    expect(probeCandidates('hevc', 'win32')).toEqual(['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'])
    expect(probeCandidates('hevc', 'linux')).toEqual(['hevc_nvenc', 'hevc_qsv', 'hevc_amf'])
    expect(probeCandidates('av1', 'win32')).toEqual(['av1_nvenc', 'av1_qsv', 'av1_amf'])
    expect(probeCandidates('av1', 'darwin')).toEqual(['av1_nvenc', 'av1_qsv'])
  })

  it('tries each candidate in order and gives the ones that worked, best first', async () => {
    const tried: string[] = []
    const working = await probeCodecWith('hevc', 'win32', async (args) => {
      tried.push(after(args, '-c:v'))
      return after(args, '-c:v') !== 'hevc_nvenc'
    })
    expect(tried).toEqual(['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'])
    expect(working).toEqual(['hevc_qsv', 'hevc_amf', 'hevc_mf'])
    // A probe that throws counts as failed.
    expect(await probeCodecWith('av1', 'win32', async () => Promise.reject(new Error('gone')))).toEqual([])
  })

  it('runs once per codec per session: later calls, at once or later, share the first answer', async () => {
    const run = vi.fn(async (args: string[]) => after(args, '-c:v').endsWith('_nvenc'))
    const [a, b] = await Promise.all([probeCodec('av1', run), probeCodec('av1', run)])
    expect(await probeCodec('av1', run)).toEqual(['av1_nvenc'])
    expect(a).toBe(b)
    const av1Runs = run.mock.calls.length
    expect(av1Runs).toBe(probeCandidates('av1', process.platform).length)
    await probeCodec('hevc', run)
    await probeCodec('hevc', run)
    expect(run.mock.calls.length).toBe(av1Runs + probeCandidates('hevc', process.platform).length)
  })

  it('never runs an encoder the allow-list lacks', async () => {
    const list = ALLOWED_ENCODERS as string[]
    const at = list.indexOf('hevc_qsv')
    list.splice(at, 1)
    try {
      const tried: string[] = []
      await probeCodecWith('hevc', 'win32', async (args) => {
        tried.push(after(args, '-c:v'))
        return true
      })
      expect(tried).toEqual(['hevc_nvenc', 'hevc_amf', 'hevc_mf'])
    } finally {
      list.splice(at, 0, 'hevc_qsv')
    }
  })

  it('never runs at start: registering the channel probes nothing, the first request does, once', async () => {
    registerCodecProbeIpc()
    await new Promise((r) => setTimeout(r, 10))
    expect(h.spawned).toEqual([])
    const app = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).toString() } }
    expect(await h.handlers.get('export:probeCodec')!(app, 'av1')).toEqual([])
    expect(h.spawned.map((a) => after(a, '-c:v'))).toEqual(probeCandidates('av1', process.platform))
    await h.handlers.get('export:probeCodec')!(app, 'av1')
    expect(h.spawned).toHaveLength(probeCandidates('av1', process.platform).length)
    // Main's start registers the channel and calls no probe.
    const index = readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(index).toContain('registerCodecProbeIpc()')
    expect(index).not.toMatch(/probeCodec\(/)
  })
})
