import { describe, expect, it } from 'vitest'
import { parseProbe, splitTopLevel } from '../src/shared/import/probe'

// Logs of the bundled ffmpeg 7.0 (`ffmpeg -hide_banner -i <file>`), trimmed to what matters.
const MOV = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:\\Users\\me\\Videos\\Game Bar (1).mov':
  Metadata:
    major_brand     : qt
    title           : DRM free encryption talk
  Duration: 00:01:02.50, start: 0.000000, bitrate: 872 kb/s
  Stream #0:0[0x1]: Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 787 kb/s, 29.97 fps, 30 tbr, 15360 tbn (default)
      Metadata:
        handler_name    : VideoHandler
  Stream #0:1[0x2]: Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 69 kb/s (default)
At least one output file must be specified`

const ROTATED = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'phone.mp4':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 871 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 787 kb/s, 59.81 fps, 60 tbr, 15360 tbn (default)
      Metadata:
        handler_name    : VideoHandler
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 69 kb/s (default)`

const WEBM = `Input #0, matroska,webm, from 'vp9.webm':
  Metadata:
    ENCODER         : Lavf61.1.100
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 25 fps, 25 tbr, 1k tbn
      Metadata:
        DURATION        : 00:00:02.000000000`

const COVER = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'cover.m4v':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x0]: Video: png, rgba(pc, gbr/unknown/unknown), 512x512, 90k tbr, 90k tbn (attached pic)
  Stream #0:1[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 787 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:2[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 69 kb/s (default)`

const DV = `Input #0, matroska,webm, from 'tape.mkv':
  Duration: 00:00:01.00, start: 0.000000, bitrate: 283 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(top coded first (swapped)), 720x576 [SAR 16:15 DAR 4:3], 25 fps, 25 tbr, 1k tbn`

describe('parseProbe', () => {
  it('reads the container, length and streams', () => {
    const p = parseProbe(MOV)
    expect(p).toMatchObject({ opened: true, container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 62.5, encrypted: false })
    expect(p.streams).toHaveLength(2)
    expect(p.streams[0]).toMatchObject({ index: 0, type: 'video', codec: 'h264', tag: 'avc1', pixFmt: 'yuv420p', width: 640, height: 360, sar: 1, fps: 29.97, rotation: 0, attachedPic: false, interlaced: false, transfer: null })
    expect(p.streams[1]).toMatchObject({ index: 1, type: 'audio', codec: 'aac', tag: 'mp4a' })
  })

  it('reads rotation, HDR transfer and the stream it belongs to', () => {
    const v = parseProbe(ROTATED).streams[0]
    expect(v).toMatchObject({ codec: 'hevc', pixFmt: 'yuv420p10le', transfer: 'arib-std-b67', rotation: 270, fps: 59.81 })
    expect(parseProbe(ROTATED).streams[1].rotation).toBe(0)
    expect(parseProbe(ROTATED.replace('-90.00', '90.00')).streams[0].rotation).toBe(90)
    expect(parseProbe(ROTATED.replace('-90.00', '180.00')).streams[0].rotation).toBe(180)
    expect(parseProbe(ROTATED.replace('arib-std-b67', 'smpte2084')).streams[0].transfer).toBe('smpte2084')
  })

  it('reads the colour primaries and matrix, tagged or not', () => {
    expect(parseProbe(ROTATED).streams[0]).toMatchObject({ matrix: 'bt2020nc', primaries: 'bt2020' })
    expect(parseProbe(ROTATED.replace('bt2020nc/bt2020/', 'unknown/unknown/')).streams[0]).toMatchObject({ matrix: 'unknown', primaries: 'unknown', transfer: 'arib-std-b67' })
  })

  it('reads an unknown length, a SAR written apart and cover art', () => {
    const w = parseProbe(WEBM)
    expect(w.duration).toBeNull()
    expect(w.streams[0]).toMatchObject({ codec: 'vp9', width: 320, height: 240, sar: 1, fps: 25, tag: null })
    const c = parseProbe(COVER)
    expect(c.streams.map((s) => [s.index, s.type, s.attachedPic])).toEqual([
      [0, 'video', true],
      [1, 'video', false],
      [2, 'audio', false]
    ])
    expect(c.streams[0].fps).toBe(90000)
  })

  it('reads non-square pixels and interlacing', () => {
    expect(parseProbe(DV).streams[0]).toMatchObject({ width: 720, height: 576, interlaced: true, sar: 16 / 15 })
    expect(parseProbe(DV.replace('top coded first (swapped)', 'tv, bottom first')).streams[0].interlaced).toBe(true)
  })

  it('marks encrypted tracks by their tag or ffmpeg message, never by metadata or the file name', () => {
    expect(parseProbe(MOV).encrypted).toBe(false)
    expect(parseProbe(MOV.replace('(avc1 / 0x31637661)', '(encv / 0x76636E65)')).encrypted).toBe(true)
    expect(parseProbe(MOV.replace('(mp4a / 0x6134706D)', '(drms / 0x736D7264)')).encrypted).toBe(true)
    expect(parseProbe(`${MOV}\n[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] Incorrect number of samples in encryption info`).encrypted).toBe(true)
    expect(parseProbe(MOV.replace("Game Bar (1).mov'", "DRM encrypted.mov'")).encrypted).toBe(false)
  })

  it('reports a file ffmpeg could not open', () => {
    const p = parseProbe("[in#0 @ 0x1] Error opening input: Invalid data found when processing input\nError opening input file x.mp4.")
    expect(p).toEqual({ opened: false, container: null, duration: null, streams: [], encrypted: false })
  })

  it('stops at an output section and ignores unknown lines', () => {
    const p = parseProbe(`${MOV}\nOutput #0, null, to 'pipe:':\n  Stream #0:0: Video: wrapped_avframe, yuv420p, 640x360`)
    expect(p.streams).toHaveLength(2)
    expect(parseProbe(`garbage\n${MOV}\nmore garbage: Video: x`).streams).toHaveLength(2)
  })

  it('splits stream details at top-level commas only', () => {
    expect(splitTopLevel('h264 (High), yuv420p10le(tv, bt2020nc/bt2020/smpte2084, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps')).toEqual([
      'h264 (High)',
      'yuv420p10le(tv, bt2020nc/bt2020/smpte2084, progressive)',
      '1920x1080 [SAR 1:1 DAR 16:9]',
      '30 fps'
    ])
  })
})
