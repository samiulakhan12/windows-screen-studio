import { describe, expect, it } from 'vitest'
import { av1CodecString, av1Level, h264Fits, hevcCodecString, hevcLevel } from '../src/shared/render/codecLevels'
import { ivfFileHeader } from '../src/shared/render/codec'

/*
 * Codec levels and codec strings of part P1 (docs/design/output-and-languages.md §5.4, §5.6, §5.8;
 * tests 16 and 17).
 */

describe('levels (test 16)', () => {
  it('hevcLevel gives the lowest Main-tier level × 30 that holds the export', () => {
    expect(hevcLevel(1920, 1080, 60)).toBe(123)
    expect(hevcLevel(1920, 1080, 120)).toBe(150)
    expect(hevcLevel(3840, 2160, 60)).toBe(153)
    expect(hevcLevel(3840, 2160, 120)).toBe(156)
    // §5.4 and §5.8: 2160×2700 at 30 is level 5; 1080×1350 is 4, 4.1 and 5 at 30, 60 and 120.
    expect(hevcLevel(2160, 2700, 30)).toBe(150)
    expect([30, 60, 120].map((fps) => hevcLevel(1080, 1350, fps))).toEqual([120, 123, 150])
    expect(hevcLevel(1280, 720, 30)).toBe(93)
    expect(hevcLevel(1080, 1920, 60)).toBe(hevcLevel(1920, 1080, 60))
  })

  it('av1Level follows Annex A: 4.0 to 1080p30, 4.1 at 1080p60, 5.0 for 1080p120, 1440p60 and 2160p30, then 5.1 and 5.2', () => {
    expect(av1Level(1920, 1080, 30)).toEqual({ level: '4.0', seqLevelIdx: 8 })
    expect(av1Level(1920, 1080, 60)).toEqual({ level: '4.1', seqLevelIdx: 9 })
    expect(av1Level(1920, 1080, 120)).toEqual({ level: '5.0', seqLevelIdx: 12 })
    expect(av1Level(2560, 1440, 60)).toEqual({ level: '5.0', seqLevelIdx: 12 })
    expect(av1Level(3840, 2160, 30)).toEqual({ level: '5.0', seqLevelIdx: 12 })
    expect(av1Level(3840, 2160, 60)).toEqual({ level: '5.1', seqLevelIdx: 13 })
    expect(av1Level(3840, 2160, 120)).toEqual({ level: '5.2', seqLevelIdx: 14 })
    // A tall frame fits the level of the same frame on its side.
    expect(av1Level(1080, 1920, 60)).toEqual(av1Level(1920, 1080, 60))
    expect(av1Level(2160, 3840, 60)).toEqual(av1Level(3840, 2160, 60))
  })

  it('h264Fits: up to level 5.2, so 4K at 120 fps does not fit and 1440p120 does', () => {
    expect(h264Fits(3840, 2160, 120)).toBe(false)
    expect(h264Fits(2560, 1440, 120)).toBe(true)
    expect(h264Fits(3840, 2160, 60)).toBe(true)
    expect(h264Fits(1920, 1080, 120)).toBe(true)
    expect(h264Fits(2160, 3840, 120)).toBe(false)
  })

  it('the WebCodecs codec strings carry the levels', () => {
    expect(hevcCodecString(1920, 1080, 60)).toBe('hvc1.1.6.L123.B0')
    expect(hevcCodecString(3840, 2160, 30)).toBe('hvc1.1.6.L150.B0')
    expect(av1CodecString(1920, 1080, 60)).toBe('av01.0.09M.08')
    expect(av1CodecString(1280, 720, 30)).toBe('av01.0.05M.08')
    expect(av1CodecString(3840, 2160, 120)).toBe('av01.0.14M.08')
  })
})

describe('the IVF header of AV1 (test 17)', () => {
  it("names fourcc 'AV01' when asked, and stays 'VP90' byte for byte by default", () => {
    const vp9 = ivfFileHeader(1920, 1080, 60, 0)
    expect(Array.from(vp9)).toEqual([
      0x44, 0x4b, 0x49, 0x46, 0, 0, 32, 0, 0x56, 0x50, 0x39, 0x30, 0x80, 0x07, 0x38, 0x04, 60, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ])
    expect(Array.from(ivfFileHeader(1920, 1080, 60, 0, 'VP90'))).toEqual(Array.from(vp9))
    const av1 = ivfFileHeader(1920, 1080, 60, 0, 'AV01')
    expect(String.fromCharCode(...av1.slice(8, 12))).toBe('AV01')
    expect(Array.from(av1.slice(12))).toEqual(Array.from(vp9.slice(12)))
    expect(Array.from(av1.slice(0, 8))).toEqual(Array.from(vp9.slice(0, 8)))
  })
})
