// The native helper writes a fragmented MP4 (native/src/win/encoder.rs) so that a recording
// whose helper died before finalising (crash, End task, power loss, a kill after the stop
// timeout) can still be recovered from "Unfinished recordings". This checks the app's side of
// that promise on a real file: processRecording() turns a fragmented MP4 that was cut off in
// the middle of a fragment into a project, while a plain MP4 cut off the same way cannot be
// read at all (no moov), which is why the helper no longer writes one.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => root.dir } }))

import { ffmpegPath } from '../src/main/ffmpeg'
import * as projects from '../src/main/projects'
import { processRecording, RecordingError } from '../src/main/recording/finalize'

const T0 = 1_700_000_000_000
const ffmpeg = ffmpegPath()
const haveFfmpeg = ffmpeg !== 'ffmpeg' && existsSync(ffmpeg)

function manifest(id: string, over: Partial<projects.RecordingManifest> = {}): projects.RecordingManifest {
  const m = {
    version: 1,
    id,
    createdAt: new Date(T0).toISOString(),
    status: 'interrupted',
    error: null,
    method: 'native',
    sourceKind: 'screen',
    region: null,
    startedAt: T0,
    width: 320,
    height: 240,
    hasAudio: false,
    hasWebcam: false,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    // An interrupted recording: the app never learned how long it was.
    duration: null,
    ...over
  } satisfies Partial<projects.RecordingManifest>
  return m as projects.RecordingManifest
}

/** 4 s of 60 fps H.264 with a 1 s GOP, laid out like the helper's file: plain or one fragment per GOP. */
function encode(file: string, fragmented: boolean): void {
  // prettier-ignore
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60',
    ...(fragmented ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'] : []),
    file
  ])
}

/** What a process killed while writing leaves behind: the first `share` of the bytes. */
function cutOff(file: string, share: number): void {
  const bytes = readFileSync(file)
  writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length * share)))
}

describe.skipIf(!haveFfmpeg)('crash-safe native recordings (real ffmpeg)', () => {
  it('recovers a fragmented MP4 that was cut off mid-fragment', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-fmp4-'))
    const { id, dir } = await projects.createProjectDir(new Date(T0))
    const raw = path.join(dir, projects.RAW.native)
    encode(raw, true)
    const full = statSync(raw).size
    // Not on a fragment boundary: ~2.4 s of 4 s, the last fragment incomplete.
    cutOff(raw, 0.6)
    expect(statSync(raw).size).toBeLessThan(full)
    const m = manifest(id)
    await projects.writeManifest(m)

    const project = await processRecording(m, () => undefined)

    // Everything up to the last complete fragment (at least the first two 1 s GOPs) survives.
    expect(project.duration).toBeGreaterThanOrEqual(1.9)
    expect(project.duration).toBeLessThan(3.9)
    expect([project.width, project.height]).toEqual([320, 240])
    expect(project.capture.method).toBe('native')
    expect(existsSync(path.join(dir, 'screen.mp4'))).toBe(true)
    expect(existsSync(path.join(dir, 'project.json'))).toBe(true)
  }, 60000)

  it('cannot recover a plain MP4 cut off the same way (its index is written last)', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-mp4-'))
    const { id, dir } = await projects.createProjectDir(new Date(T0))
    const raw = path.join(dir, projects.RAW.native)
    encode(raw, false)
    cutOff(raw, 0.6)
    await expect(processRecording(manifest(id), () => undefined)).rejects.toBeInstanceOf(RecordingError)
    // Raw files stay for another attempt.
    expect(existsSync(raw)).toBe(true)
  }, 60000)
})
