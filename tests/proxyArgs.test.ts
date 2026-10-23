import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { cropFilter, proxyArgs, regionPixels } from '../src/main/proxyArgs'

const arg = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

describe('proxyArgs', () => {
  it('defaults to a fast software encode with short GOPs at 60 fps CFR', () => {
    const args = proxyArgs('in.webm', 'out.mp4', true)
    expect(arg(args, '-c:v')).toBe('libx264')
    expect(arg(args, '-preset')).toBe('superfast')
    expect(arg(args, '-g')).toBe('15')
    expect(arg(args, '-r')).toBe('60')
    expect(arg(args, '-fps_mode')).toBe('cfr')
    expect(args).toContain('aac')
    expect(args.at(-1)).toBe('out.mp4')
  })

  it('uses a detected GPU encoder with NV12 input where required', () => {
    const nv = proxyArgs('in.webm', 'out.mp4', false, { encoder: 'h264_nvenc' })
    expect(arg(nv, '-c:v')).toBe('h264_nvenc')
    expect(arg(nv, '-vf')).toContain('format=yuv420p')
    const qsv = proxyArgs('in.webm', 'out.mp4', false, { encoder: 'h264_qsv' })
    expect(arg(qsv, '-c:v')).toBe('h264_qsv')
    expect(arg(qsv, '-vf')).toContain('format=nv12')
    expect(arg(qsv, '-g')).toBe('15')
  })

  it('keeps the camera at its own frame rate', () => {
    expect(arg(proxyArgs('cam.webm', 'cam.mp4', false, { fps: 30 }), '-r')).toBe('30')
  })

  it('fits frames of another size into the fixed output without stretching', () => {
    const vf = arg(proxyArgs('in.webm', 'out.mp4', false, { size: { width: 1280, height: 720 } }), '-vf')!
    expect(vf).toContain('scale=1280:720:force_original_aspect_ratio=decrease')
    expect(vf).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2')
  })

  it('maps a separate audio file and applies its offset', () => {
    const later = proxyArgs('v.mp4', 'o.mp4', false, { audio: { input: 'a.webm', offset: 0.25 } })
    expect(later.join(' ')).toContain('-i v.mp4 -i a.webm')
    expect(later.join(' ')).toContain('-map 1:a:0?')
    expect(arg(later, '-af')).toBe('adelay=250:all=1')
    const earlier = proxyArgs('v.mp4', 'o.mp4', false, { audio: { input: 'a.webm', offset: -0.4 } })
    expect(earlier.join(' ')).toContain('-ss 0.400 -i a.webm')
    expect(earlier).not.toContain('-af')
    expect(earlier).toContain('aac')
  })

  it('drops audio when there is none and can report progress', () => {
    const args = proxyArgs('in.webm', 'out.mp4', false, { progress: true })
    expect(args).toContain('-an')
    expect(args.join(' ')).toContain('-progress pipe:1 -nostats')
    expect(args.at(-1)).toBe('out.mp4')
  })
})

describe('regionPixels', () => {
  it('converts a normalised region to even pixels inside the frame', () => {
    expect(regionPixels({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, 1920, 1080)).toEqual({ x: 192, y: 216, width: 960, height: 540 })
    const r = regionPixels({ x: 0.3337, y: 0.1, w: 0.6663, h: 0.3001 }, 1366, 768)
    expect(r.width % 2).toBe(0)
    expect(r.height % 2).toBe(0)
    expect(r.x + r.width).toBeLessThanOrEqual(1366)
  })
})

const ffmpeg = ffmpegPath()
const haveFfmpeg = ffmpeg !== 'ffmpeg' && existsSync(ffmpeg)

describe.skipIf(!haveFfmpeg)('proxy filters (real ffmpeg)', () => {
  const probeSize = (file: string): string =>
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString()

  const sizeOf = (file: string): string => {
    try {
      probeSize(file)
    } catch (err) {
      const log = String((err as { stderr?: Buffer }).stderr ?? '')
      return /Video: [^\n]*?(\d{2,5}x\d{2,5})/.exec(log)?.[1] ?? 'none'
    }
    return 'none'
  }

  const makeInput = (dir: string, size: string): string => {
    const file = path.join(dir, `in-${size}.mkv`)
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=0.5`, '-c:v', 'ffv1', file])
    return file
  }

  it('crops a region exactly to the computed pixel size', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-proxy-'))
    const region = { x: 0.25, y: 0.1, w: 0.5013, h: 0.4999 }
    const px = regionPixels(region, 1366, 768)
    const out = path.join(dir, 'crop.mp4')
    const args = proxyArgs(makeInput(dir, '1366x768'), out, false, { size: { width: px.width, height: px.height }, crop: region, fps: 30 })
    execFileSync(ffmpeg, args, { stdio: 'ignore' })
    expect(sizeOf(out)).toBe(`${px.width}x${px.height}`)
    expect(cropFilter(region)).toContain('exact=1')
  })

  it('fits a differently sized frame (resized window) into the fixed output size', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-proxy-'))
    const out = path.join(dir, 'fit.mp4')
    execFileSync(ffmpeg, proxyArgs(makeInput(dir, '1000x640'), out, false, { size: { width: 1280, height: 720 }, fps: 30 }), { stdio: 'ignore' })
    expect(sizeOf(out)).toBe('1280x720')
  })
})
