import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { correctProjectMedia } from '../src/shared/editor/clips'
import { mediaLength, trackEnd } from '../src/shared/editor/mediaLength'
import { createProject } from '../src/shared/engine/project'
import { demuxVideoTrack } from '../src/shared/render/mp4'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-media-length-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('mediaLength', () => {
  it('prefers the video track, shorter or longer than the recorded duration', () => {
    expect(mediaLength(10, 9.95, 10.4)).toBe(9.95)
    expect(mediaLength(10, 10.02, 10.4)).toBe(10.02)
    expect(mediaLength(10, 10, 13)).toBe(10)
  })

  it('without the track length, lets the container only shorten the project', () => {
    expect(mediaLength(10, null, 9.9)).toBe(9.9)
    expect(mediaLength(10, null, 10.3)).toBe(10)
    expect(mediaLength(10, NaN, 10.3)).toBe(10)
    expect(mediaLength(10, 0, 9)).toBe(9)
  })

  it('keeps the recorded duration when the file reports nothing usable', () => {
    expect(mediaLength(10, null, NaN)).toBe(10)
    expect(mediaLength(10, null, Infinity)).toBe(10)
    expect(mediaLength(10, null, 0)).toBe(10)
  })
})

describe('trackEnd', () => {
  it('is the end of the last frame in presentation order', () => {
    expect(trackEnd([{ time: 0, duration: 0.5 }, { time: 1, duration: 0.5 }, { time: 0.5, duration: 0.5 }])).toBe(1.5)
    expect(trackEnd([])).toBeNull()
  })
})

/** `ffmpeg -i` prints the container duration as "Duration: 00:00:03.26". */
function containerDuration(file: string): number {
  const out = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(out)
  if (!m) throw new Error(`no duration in: ${out}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

describe('a native proxy whose separately recorded audio outlasts the video (seams-2)', () => {
  it('keeps the frame-count duration instead of the longer container duration', async () => {
    const video = path.join(dir, 'video.mkv')
    const audio = path.join(dir, 'audio.webm')
    const out = path.join(dir, 'screen.mp4')
    const ff = (args: string[]): void => void execFileSync(ffmpegPath(), ['-v', 'error', '-y', ...args])
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', video])
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3.2', '-c:a', 'libopus', audio])
    // Same shape as the native proxy: external audio delayed by the audio offset, no -shortest.
    ff([
      '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-fps_mode', 'cfr', '-r', '60',
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-af', 'adelay=50:all=1', '-c:a', 'aac', '-movflags', '+faststart', out
    ])
    const container = containerDuration(out)
    expect(container).toBeGreaterThan(3.2)

    const bytes = new Uint8Array(readFileSync(out))
    const track = await demuxVideoTrack(async (o, l) => bytes.subarray(o, o + l), bytes.length)
    const end = trackEnd(track.samples)
    expect(end).toBeCloseTo(3, 6)

    const project = createProject({
      id: 'rec-1',
      name: 'Native',
      duration: track.samples.length / 60,
      width: 320,
      height: 240,
      hasWebcam: false,
      hasAudio: true,
      webcamOffset: 0,
      zooms: [],
      cursorValid: true,
      capture: { method: 'native', cursorInVideo: false, region: null }
    })
    // The editor no longer stretches the project (and its clip) over the audio tail.
    expect(correctProjectMedia(project, { duration: mediaLength(project.duration, end, container), width: 320, height: 240 })).toBe(project)
    // What it did before: duration and clip followed the container.
    expect(correctProjectMedia(project, { duration: container, width: 320, height: 240 }).clips[0].end).toBeCloseTo(container, 6)
  })
})
