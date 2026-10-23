import { describe, expect, it } from 'vitest'
import { proxyArgs } from '../src/main/proxyArgs'

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
