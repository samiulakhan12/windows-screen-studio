import { describe, expect, it } from 'vitest'
import { exportArgs, proxyArgs } from '../src/main/ffmpegArgs'
import type { ExportJob } from '../src/shared/types'

const job: ExportJob = { width: 1920, height: 1080, fps: 60, format: 'mp4', quality: 'high', outputPath: '/out.mp4' }

describe('proxyArgs', () => {
  it('produces a short-GOP H.264 file', () => {
    const args = proxyArgs('in.webm', 'out.mp4', true)
    expect(args).toContain('libx264')
    expect(args[args.indexOf('-g') + 1]).toBe('15')
    expect(args[args.indexOf('-r') + 1]).toBe('60')
    expect(args).toContain('aac')
    expect(args.at(-1)).toBe('out.mp4')
  })
  it('drops audio when there is none', () => {
    expect(proxyArgs('in.webm', 'out.mp4', false)).toContain('-an')
  })
})

describe('exportArgs', () => {
  it('reads raw RGBA frames of the right size from stdin', () => {
    const args = exportArgs(job, null)
    expect(args.join(' ')).toContain('-f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i pipe:0')
    expect(args).not.toContain('1:a:0?')
    expect(args.at(-1)).toBe('/out.mp4')
  })
  it('muxes trimmed audio when provided', () => {
    const args = exportArgs({ ...job, audio: { start: 1.5, end: 10 } }, '/p/screen.mp4')
    const joined = args.join(' ')
    expect(joined).toContain('-ss 1.500 -to 10.000 -i /p/screen.mp4')
    expect(joined).toContain('-map 1:a:0?')
    expect(joined).toContain('-c:a aac')
  })
  it('builds a palette pipeline for GIFs', () => {
    const args = exportArgs({ ...job, format: 'gif', fps: 15, outputPath: '/o.gif' }, null)
    expect(args.join(' ')).toContain('palettegen')
    expect(args).toContain('-loop')
  })
})
