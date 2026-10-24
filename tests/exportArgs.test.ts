import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { audioFilterGraph, colorBitstreamFilter, colorTagArgs, EXPORT_COLOR, exportArgs, gifCaptureArgs, gifEncodeArgs, gifPaletteArgs, videoEncoderArgs } from '../src/main/exportArgs'
import { ffmpegPath } from '../src/main/ffmpeg'
import { detectWith, gpuEncoderOptions, probeArgs } from '../src/main/hwEncoders'
import type { ExportJob } from '../src/shared/api/export'
import type { Clip } from '../src/shared/types'

const job: ExportJob = {
  width: 1920,
  height: 1080,
  fps: 60,
  frames: 600,
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
  outputPath: '/videos/out.mp4'
}
const io = { audioInput: null, output: '/videos/.out.partial.mp4' }
const after = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]
const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })

describe('exportArgs (raw frames)', () => {
  const args = exportArgs(job, io)
  it('reads raw RGBA frames of the right size and rate from stdin', () => {
    expect(args.join(' ')).toContain('-f rawvideo -pix_fmt rgba -s 1920x1080 -framerate 60 -i pipe:0')
  })
  it('converts with the BT.601 matrix (limited range) and tags every colour field', () => {
    expect(after(args, '-filter_complex')).toContain('scale=out_color_matrix=bt601:out_range=tv,format=yuv420p')
    expect(args.join(' ')).toContain('-color_primaries bt709 -color_trc bt709 -colorspace smpte170m -color_range tv')
    expect(after(args, '-bsf:v')).toBe('h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=6:video_full_range_flag=0')
  })
  it('writes MP4 explicitly to the temporary path (not the target)', () => {
    expect(args.slice(-3)).toEqual(['-f', 'mp4', io.output])
    expect(args).not.toContain(job.outputPath)
  })
  it('never uses -shortest and adds no audio without a soundtrack', () => {
    expect(args).not.toContain('-shortest')
    expect(args).not.toContain('-c:a')
    expect(args.join(' ')).not.toContain('[aout]')
  })
  it('feeds NV12 to GPU encoders that need it', () => {
    const qsv = exportArgs({ ...job, video: { kind: 'raw', encoder: 'h264_qsv', pixelFormat: 'bgr0' } }, io)
    expect(after(qsv, '-filter_complex')).toContain('format=nv12')
    expect(qsv).toContain('h264_qsv')
  })
})

describe('exportArgs (WebCodecs stream)', () => {
  const color = { primaries: 1, transfer: 1, matrix: 6, fullRange: false }
  const args = exportArgs({ ...job, video: { kind: 'h264', color } }, io)
  it('copies the H.264 stream and numbers frames at the export rate', () => {
    expect(args.join(' ')).toContain('-f h264 -r 60 -i pipe:0')
    expect(after(args, '-c:v')).toBe('copy')
    expect(after(args, '-map')).toBe('0:v:0')
  })
  it("tags the stream with the encoder's own matrix", () => {
    expect(after(args, '-bsf:v')).toContain('matrix_coefficients=6')
    expect(args.join(' ')).toContain('-colorspace smpte170m')
  })
  it("keeps the stream's matrix and range when the encoder did not report them", () => {
    const unknown = exportArgs({ ...job, video: { kind: 'h264', color: { primaries: 1, transfer: 1, matrix: null, fullRange: null } } }, io)
    expect(after(unknown, '-bsf:v')).toBe('h264_metadata=colour_primaries=1:transfer_characteristics=1')
    expect(unknown).not.toContain('-colorspace')
  })
})

describe('exportArgs (audio)', () => {
  const clips = [clip(1, 4), clip(6, 10, 2)]
  const args = exportArgs({ ...job, frames: 300, audio: { clips, volume: 0.5 } }, { ...io, audioInput: '/p/screen.mp4' })
  it('reads the proxy audio only and maps the edited soundtrack', () => {
    expect(args.join(' ')).toContain('-vn -i /p/screen.mp4')
    expect(args.join(' ')).toContain('-map [aout] -c:a aac')
    expect(after(args, '-filter_complex')).toContain('[1:a]aresample')
  })
  it('pads/trims the soundtrack to exactly frames / fps', () => {
    expect(after(args, '-filter_complex')).toContain('apad=whole_dur=5,atrim=end=5[aout]')
  })
  it('rejects GIF jobs (they use the two-pass pipeline)', () => {
    expect(() => exportArgs({ ...job, format: 'gif' }, io)).toThrow()
  })
})

describe('audioFilterGraph', () => {
  it('passes a single untouched clip through with exact length', () => {
    expect(audioFilterGraph([clip(0, 5)], 1, 5)).toBe(
      '[1:a]aresample=async=1:first_pts=0[s0];[s0]atrim=start=0:end=5,asetpts=PTS-STARTPTS,apad=whole_dur=5,atrim=end=5[c0];[c0]apad=whole_dur=5,atrim=end=5[aout]'
    )
  })
  it('cuts, re-times and joins clips in order, then applies the gain', () => {
    const g = audioFilterGraph([clip(0, 2), clip(3, 5, 2), clip(5, 6, 0.25)], 1.5, 7)
    // Re-timed: read at the export's rate, kept on their frames despite atempo's lead, every clip cut to the samples its video lasts.
    expect(g).toContain('[1:a]aresample=48000:async=1:first_pts=0,asplit=3[s0][s1][s2]')
    expect(g).toContain('[s0]atrim=start=0:end=2,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2,apad=whole_len=96000,atrim=end_sample=96000[c0]')
    expect(g).toContain('[s1]atrim=start=3:end=5,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2,adelay=delays=41.667:all=1,atempo=2,asetpts=PTS-STARTPTS,atrim=start_sample=500,asetpts=PTS-STARTPTS,apad=whole_len=48000,atrim=end_sample=48000[c1]')
    expect(g).toContain('[s2]atrim=start=5:end=6,asetpts=PTS-STARTPTS,apad=whole_dur=1,atrim=end=1,adelay=delays=62.500:all=1,atempo=0.5,atempo=0.5,asetpts=PTS-STARTPTS,atrim=start_sample=6000,asetpts=PTS-STARTPTS,apad=whole_len=192000,atrim=end_sample=192000[c2]')
    expect(g).toContain('[c0][c1][c2]concat=n=3:v=0:a=1,volume=1.5,apad=whole_dur=7,atrim=end=7[aout]')
  })
  it('keeps the earlier graph for clips at normal speed', () => {
    expect(audioFilterGraph([clip(0, 2), clip(3, 5)], 1, 4)).toBe(
      '[1:a]aresample=async=1:first_pts=0,asplit=2[s0][s1];[s0]atrim=start=0:end=2,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2[c0];[s1]atrim=start=3:end=5,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2[c1];[c0][c1]concat=n=2:v=0:a=1,apad=whole_dur=4,atrim=end=4[aout]'
    )
  })
})

describe('audioFilterGraph with ffmpeg', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssw-audio-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const ff = ffmpegPath()

  /** Onsets (s) of 1 kHz bursts in a file, at 5 ms resolution. */
  function onsets(file: string): { onsets: number[]; duration: number } {
    const pcm = execFileSync(ff, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4)
    const out: number[] = []
    let on = false
    for (let i = 0; i + 40 <= s.length; i += 40) {
      let peak = 0
      for (let j = i; j < i + 40; j++) peak = Math.max(peak, Math.abs(s[j]))
      if (!on && peak > 0.1) {
        out.push(i / 8000)
        on = true
      } else if (on && peak < 0.02) on = false
    }
    return { onsets: out, duration: s.length / 8000 }
  }

  it('keeps every beep in sync after a cut and a 2x segment', () => {
    // 8 s source: a 100 ms beep at the start of every second.
    const src = path.join(dir, 'beeps.m4a')
    execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '8', '-af', "volume='if(lt(mod(t,1),0.1),1,0)':eval=frame", '-c:a', 'aac', src])
    // Keep 0-2 s, cut 2-4 s, keep 4-8 s at 2x: output = 2 + 2 = 4 s.
    const clips = [clip(0, 2), clip(4, 8, 2)]
    const out = path.join(dir, 'edited.wav')
    const r = spawnSync(ff, ['-v', 'error', '-i', src, '-filter_complex', audioFilterGraph(clips, 1, 4, '0:a'), '-map', '[aout]', out])
    expect(r.status, r.stderr.toString()).toBe(0)
    const { onsets: got, duration } = onsets(out)
    expect(duration).toBeCloseTo(4, 2)
    // Source beeps at 0, 1 (kept 1x) and 4, 5, 6, 7 (at 2x -> 2, 2.5, 3, 3.5).
    const want = [0, 1, 2, 2.5, 3, 3.5]
    expect(got).toHaveLength(want.length)
    got.forEach((t, i) => expect(Math.abs(t - want[i])).toBeLessThan(0.03))
  })

  it('pads with silence when the source audio is shorter than the edit', () => {
    const src = path.join(dir, 'short.m4a')
    execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '2.5', '-c:a', 'aac', src])
    const out = path.join(dir, 'padded.wav')
    const r = spawnSync(ff, ['-v', 'error', '-i', src, '-filter_complex', audioFilterGraph([clip(0, 3)], 1, 3.2, '0:a'), '-map', '[aout]', out])
    expect(r.status, r.stderr.toString()).toBe(0)
    expect(onsets(out).duration).toBeCloseTo(3.2, 2)
  })
})

describe('colour helpers', () => {
  it('maps code points to ffmpeg names', () => {
    expect(colorTagArgs(EXPORT_COLOR)).toEqual(['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'smpte170m', '-color_range', 'tv'])
    expect(colorTagArgs({ ...EXPORT_COLOR, matrix: 1, fullRange: true })).toContain('pc')
    expect(colorBitstreamFilter({ ...EXPORT_COLOR, fullRange: true })).toContain('video_full_range_flag=1')
  })
})

describe('encoder settings', () => {
  it('uses a fast x264 preset for every quality and a 2 s GOP', () => {
    for (const quality of ['high', 'medium', 'small'] as const) {
      const a = videoEncoderArgs('libx264', { ...job, quality })
      expect(['veryfast', 'faster']).toContain(after(a, '-preset'))
      expect(after(a, '-g')).toBe('120')
    }
  })
  it('gives Media Foundation a bitrate', () => {
    expect(Number(after(videoEncoderArgs('h264_mf', job), '-b:v'))).toBeGreaterThan(5e6)
  })
  it('asks Media Foundation for a hardware encoder, as the probe did (perf-1 / windows-3)', () => {
    // Without -hw_encoding 1, h264_mf is Microsoft's software encoder, present on every Windows install.
    expect(after(videoEncoderArgs('h264_mf', job), '-hw_encoding')).toBe('1')
    expect(after(probeArgs('h264_mf'), '-hw_encoding')).toBe('1')
    expect(after(exportArgs({ ...job, video: { kind: 'raw', encoder: 'h264_mf', pixelFormat: 'bgra' } }, io), '-hw_encoding')).toBe('1')
    // Other encoders take no such flag.
    for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as const) {
      expect(videoEncoderArgs(e, job)).not.toContain('-hw_encoding')
      expect(probeArgs(e)).not.toContain('-hw_encoding')
      expect(gpuEncoderOptions(e)).toEqual([])
    }
  })
})

describe('encoder detection (perf-1 / windows-3)', () => {
  it('lists Media Foundation as a GPU encoder only when its hardware probe passes, after the vendor encoders and before x264', async () => {
    const probed: string[] = []
    const only = (ok: string[]) => async (e: string): Promise<boolean> => (probed.push(e), ok.includes(e))
    expect(await detectWith('win32', only(['h264_mf']))).toEqual(['h264_mf', 'libx264'])
    expect(await detectWith('win32', only(['h264_nvenc', 'h264_mf']))).toEqual(['h264_nvenc', 'h264_mf', 'libx264'])
    // A machine with no hardware encoder: only x264 (the software MFT no longer passes the probe).
    expect(await detectWith('win32', only([]))).toEqual(['libx264'])
    probed.length = 0
    expect(await detectWith('linux', only(['h264_mf']))).toEqual(['libx264'])
    expect(probed).not.toContain('h264_mf')
  })
  it('the probe encodes a few frames to nowhere with the same options as a real encode', () => {
    const a = probeArgs('h264_qsv')
    expect(after(a, '-c:v')).toBe('h264_qsv')
    expect(after(a, '-pix_fmt')).toBe('nv12')
    expect(a.slice(-3)).toEqual(['-f', 'null', '-'])
  })
})

describe('GIF pipeline', () => {
  const gif: ExportJob = { ...job, format: 'gif', fps: 15, width: 1280, height: 720 }
  it('only stores frames losslessly while rendering (no palette in the same process: it buffers every frame)', () => {
    const a = gifCaptureArgs(gif, '/tmp/x.mkv')
    expect(a.join(' ')).not.toContain('palette')
    expect(a.join(' ')).toContain('-s 1280x720 -framerate 15 -i pipe:0 -c:v ffv1')
    expect(a.at(-1)).toBe('/tmp/x.mkv')
  })
  it('builds the palette, then maps frames onto it, each streaming from the intermediate', () => {
    expect(gifPaletteArgs('/tmp/x.mkv', '/tmp/x.png').join(' ')).toContain('-i /tmp/x.mkv -vf palettegen')
    const a = gifEncodeArgs('/tmp/x.mkv', '/tmp/x.png', '/v/.a.partial.gif')
    expect(after(a, '-filter_complex')).toContain('paletteuse')
    expect(a.slice(-3)).toEqual(['-f', 'gif', '/v/.a.partial.gif'])
  })
})
