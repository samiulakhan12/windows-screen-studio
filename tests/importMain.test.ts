import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), isPackaged: false, getAppPath: () => h.root },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))

h.root = mkdtempSync(path.join(os.tmpdir(), 'ssw-import-'))
const { importVideo, checkImportFile, sweepAbandonedImports, IMPORT_MARKER, decodeTest, probeFile, scanProtection } = await import('../src/main/importVideo')
const { ffmpegPath } = await import('../src/main/ffmpeg')
const { IMPORT_COPY } = await import('../src/shared/import/plan')

const media = path.join(h.root, 'media')
const library = path.join(h.root, 'videos', 'Flown')
const ff = (...args: string[]): void => {
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args])
}
const at = (name: string): string => path.join(media, name)
const deps = { encoders: async () => ['libx264' as const], toneMap: async () => true, freeBytes: async () => 1e12 }

/** ffmpeg's view of a finished editing copy. */
function describeVideo(file: string): string {
  try {
    execFileSync(ffmpegPath(), ['-hide_banner', '-i', file], { stdio: 'pipe' })
  } catch (err) {
    return String((err as { stderr?: Buffer }).stderr ?? '')
  }
  return ''
}

beforeAll(() => {
  mkdirSync(media, { recursive: true })
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=641x361:rate=30', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000']
  ff(...src, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', at('odd.mov'))
  ff('-display_rotation', '90', '-i', at('odd.mov'), '-c', 'copy', at('rotated.mp4'))
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '1.5', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', at('vp9.webm'))
  ff('-f', 'lavfi', '-i', 'sine', '-t', '2', '-c:a', 'aac', at('sound.m4a'))
  ff('-i', at('sound.m4a'), '-c', 'copy', '-f', 'mp4', at('sound-named.mp4'))
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60', '-f', 'lavfi', '-i', 'sine', '-f', 'lavfi', '-i', 'sine=f=880', '-t', '1', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-c:a', 'aac', at('tracks.mkv'))
  ff('-i', at('odd.mov'), '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', '76a6c65c5ea762046bd749a2e632ccbb', '-encryption_kid', 'a7e61c373e219033c21091fa607bf3b8', at('protected.mp4'))
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '0.2', '-c:v', 'libx264', at('blink.mp4'))
  // DV-style anamorphic PAL (720 x 576 shown as 768 x 576) and a 10-bit HDR (PQ) phone clip.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=25', '-t', '1', '-vf', 'setsar=16/15', '-c:v', 'libx264', at('anamorphic.mkv'))
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-c:v', 'libx265', '-x265-params', 'log-level=error', at('hdr.mp4'))
  // Live WebM (as streamed by a browser recorder): no length in the file.
  const live = (seconds: string, name: string): void => {
    writeFileSync(at(name), execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', seconds, '-c:v', 'libvpx', '-f', 'webm', '-live', '1', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 }))
  }
  live('0.3', 'live-short.webm')
  live('2', 'live.webm')
  writeFileSync(at('notes.mp4'), 'x'.repeat(4096))
  writeFileSync(at('tiny.mp4'), 'x')
  writeFileSync(at('clip.avi'), 'x'.repeat(4096))
  // A WebM named .mp4: accepted, ffmpeg reads the content.
  ff('-i', at('vp9.webm'), '-c', 'copy', '-f', 'webm', at('webm-named.mp4'))
  // A stream-copy trim of a recording with 2 s between keyframes: the picture starts 1.6 s after the sound.
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine', '-t', '6', '-c:v', 'libx264', '-g', '60', '-c:a', 'aac', at('gop.mp4'))
  ff('-i', at('gop.mp4'), '-ss', '0.4', '-c', 'copy', at('trimmed.mp4'))
  // Sound that starts half a second after the picture (an audio delay in an MKV).
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=f=1000', '-t', '2', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'libopus', at('late-sound.mkv'))
  // A camera file with 5.1.4 PCM sound (10 channels), and one with 4 channels.
  for (const [layout, name] of [['5.1.4', 'surround.mov'], ['4.0', 'quad.mov']]) {
    ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-f', 'lavfi', '-i', `anullsrc=channel_layout=${layout}:sample_rate=48000`, '-t', '1', '-c:v', 'libx264', '-c:a', 'pcm_s16le', at(name))
  }
  // Frames at 0, 1, 2 and 60 s, and a header that says 3 s (a crafted or damaged file).
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '4', '-vf', "setpts='if(eq(N,3),60,N)/TB'", '-fps_mode', 'passthrough', '-c:v', 'libx264', at('gap.mkv'))
  const gap = readFileSync(at('gap.mkv'))
  // Segment Info › Duration: ID 0x4489, size 8, a big-endian float in milliseconds.
  const duration = gap.indexOf(Buffer.from([0x44, 0x89, 0x88]))
  gap.writeDoubleBE(3000, duration + 3)
  writeFileSync(at('understated.mkv'), gap)
}, 60_000)

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(library, { recursive: true, force: true })
})

const folders = (): string[] => (existsSync(library) ? readdirSync(library) : [])
const readJson = (id: string, file: string): any => JSON.parse(readFileSync(path.join(library, id, file), 'utf8'))

describe('checkImportFile', () => {
  it('refuses paths that are not absolute files of an importable type', async () => {
    expect(await checkImportFile(42)).toEqual({ ok: false, error: IMPORT_COPY.cannotOpen })
    expect(await checkImportFile('odd.mov')).toEqual({ ok: false, error: IMPORT_COPY.cannotOpen })
    expect(await checkImportFile(`${at('odd.mov')}\0`)).toEqual({ ok: false, error: IMPORT_COPY.cannotOpen })
    expect(await checkImportFile(path.join(media, 'a\nStream #0:9: Video: h264.mp4'))).toEqual({ ok: false, error: IMPORT_COPY.cannotOpen })
    expect(await checkImportFile(at('clip.avi'))).toEqual({ ok: false, error: IMPORT_COPY.extension })
    expect(await checkImportFile(at('missing.mp4'))).toEqual({ ok: false, error: IMPORT_COPY.cannotOpen })
    mkdirSync(at('folder.mp4'), { recursive: true })
    expect(await checkImportFile(at('folder.mp4'))).toEqual({ ok: false, error: IMPORT_COPY.cannotOpen })
    expect(await checkImportFile(at('tiny.mp4'))).toEqual({ ok: false, error: IMPORT_COPY.empty })
    expect(await checkImportFile(at('notes.mp4'))).toEqual({ ok: false, error: IMPORT_COPY.notVideo('mp4') })
  })

  it('accepts a video by its content, whatever its extension says', async () => {
    expect(await checkImportFile(at('odd.mov'))).toMatchObject({ ok: true, fileName: 'odd.mov' })
    expect(await checkImportFile(at('webm-named.mp4'))).toMatchObject({ ok: true })
  })
})

describe('probe, decode test and protection scan', () => {
  it('reads the streams of a real file', async () => {
    const p = await probeFile(at('rotated.mp4'))
    expect(p.opened).toBe(true)
    expect(p.streams.find((s) => s.type === 'video')).toMatchObject({ width: 640, height: 360, rotation: 90 })
  })

  it('decodes what the bundled ffmpeg can read and fails a stream it cannot', async () => {
    expect(await decodeTest(at('odd.mov'), 0, 1)).toBe(true)
    // There is no stream 5: ffmpeg refuses the map.
    expect(await decodeTest(at('odd.mov'), 5, null)).toBe(false)
  })

  it('decodes a picture that starts more than a second after the sound', async () => {
    expect(await decodeTest(at('trimmed.mp4'), 0, 1)).toBe(true)
    expect(await decodeTest(at('trimmed.mp4'), 0, null)).toBe(true)
  })

  it('finds a protected track in an encrypted MP4 only', async () => {
    expect(await scanProtection(at('protected.mp4'), readFileSync(at('protected.mp4')).length)).toBe(true)
    expect(await scanProtection(at('odd.mov'), readFileSync(at('odd.mov')).length)).toBe(false)
  })
})

describe('importVideo', () => {
  it('turns a video into a project: editing copy, empty cursor track, source record', async () => {
    const progress: string[] = []
    const r = await importVideo(at('odd.mov'), { deps, onProgress: (p) => progress.push(p.stage), now: () => new Date('2026-10-28T10:00:00Z') })
    expect(r).toMatchObject({ ok: true, fileName: 'odd.mov', notes: [] })
    if (!r.ok) return
    const dir = path.join(library, r.projectId)
    expect(readdirSync(dir).sort()).toEqual(['cursor.json', 'project.json', 'screen.mp4'])
    const project = readJson(r.projectId, 'project.json')
    expect(project).toMatchObject({
      name: 'odd',
      width: 640,
      height: 360,
      hasAudio: true,
      hasWebcam: false,
      autoZoom: false,
      zooms: [],
      createdAt: '2026-10-28T10:00:00.000Z',
      capture: { method: 'chromium', cursorInVideo: true, region: null, target: 'screen', fps: 30 },
      source: { kind: 'import', fileName: 'odd.mov', videoCodec: 'h264', audioCodec: 'aac', width: 640, height: 360, rotation: 0, fps: 30 }
    })
    expect(project.zoomSettings.auto.enabled).toBe(false)
    expect(project.cursor.show).toBe(false)
    expect(project.duration).toBeCloseTo(2, 1)
    expect(readJson(r.projectId, 'cursor.json')).toEqual({ samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false })
    const copy = describeVideo(path.join(dir, 'screen.mp4'))
    expect(copy).toMatch(/Video: h264.*640x360.*30 fps/)
    expect(copy).toMatch(/Audio: aac/)
    expect(progress[0]).toBe('checking')
    expect(progress).toContain('converting')
    expect(progress.at(-1)).toBe('finishing')
  }, 60_000)

  it('makes a rotated phone video upright', async () => {
    const r = await importVideo(at('rotated.mp4'), { deps })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const project = readJson(r.projectId, 'project.json')
    expect([project.width, project.height]).toEqual([360, 640])
    expect(project.source.rotation).toBe(90)
    const copy = describeVideo(path.join(library, r.projectId, 'screen.mp4'))
    expect(copy).toMatch(/360x640/)
    expect(copy).not.toMatch(/rotation/)
  }, 60_000)

  it('measures a video that does not say how long it is, and refuses one too short', async () => {
    const r = await importVideo(at('live.webm'), { deps })
    expect(r).toMatchObject({ ok: true, notes: [] })
    if (r.ok) expect(readJson(r.projectId, 'project.json').duration).toBeCloseTo(2, 1)
    rmSync(library, { recursive: true, force: true })
    expect(await importVideo(at('live-short.webm'), { deps })).toMatchObject({ ok: false, error: IMPORT_COPY.tooShort })
    expect(folders()).toEqual([])
  }, 60_000)

  it('imports a stream-copy trim whose picture starts after its sound', async () => {
    const r = await importVideo(at('trimmed.mp4'), { deps })
    expect(r).toMatchObject({ ok: true, notes: [] })
    if (r.ok) expect(readJson(r.projectId, 'project.json')).toMatchObject({ hasAudio: true, source: { videoCodec: 'h264', audioCodec: 'aac' } })
  }, 60_000)

  it('pads sound that starts after the picture, so its first sample is at 0', async () => {
    const r = await importVideo(at('late-sound.mkv'), { deps })
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    // Decoded as the editor's level analysis does (from the first sample, no timestamps).
    const pcm = execFileSync(ffmpegPath(), ['-v', 'error', '-i', path.join(library, r.projectId, 'screen.mp4'), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 16 * 1024 * 1024 })
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4)
    expect(samples.findIndex((v) => Math.abs(v) > 0.05) / 16000).toBeCloseTo(0.5, 1)
  }, 60_000)

  it('turns surround sound into stereo', async () => {
    for (const name of ['surround.mov', 'quad.mov']) {
      const r = await importVideo(at(name), { deps })
      expect(r, name).toMatchObject({ ok: true })
      if (r.ok) expect(describeVideo(path.join(library, r.projectId, 'screen.mp4'))).toMatch(/Audio: aac.*, stereo,/)
    }
  }, 60_000)

  it('cuts the copy near the stated length when the header understates it', async () => {
    const r = await importVideo(at('understated.mkv'), { deps })
    expect(r).toMatchObject({ ok: true, notes: [] })
    if (r.ok) expect(readJson(r.projectId, 'project.json').duration).toBeLessThanOrEqual(5)
  }, 60_000)

  it('widens non-square pixels instead of adding bars', async () => {
    const r = await importVideo(at('anamorphic.mkv'), { deps })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(readJson(r.projectId, 'project.json')).toMatchObject({ width: 768, height: 576 })
    // The first and last 8 columns of the first frame: picture, not black bars.
    const edges = execFileSync(ffmpegPath(), ['-v', 'error', '-i', path.join(library, r.projectId, 'screen.mp4'), '-frames:v', '1', '-vf', 'crop=8:576:0:0,format=gray', '-f', 'rawvideo', '-'])
    const mean = edges.reduce((a, b) => a + b, 0) / edges.length
    expect(mean).toBeGreaterThan(40)
    expect(describeVideo(path.join(library, r.projectId, 'screen.mp4'))).toMatch(/768x576 \[SAR 1:1/)
  }, 60_000)

  it('tone-maps an HDR video to an 8-bit editing copy, with a note', async () => {
    const r = await importVideo(at('hdr.mp4'), { deps })
    expect(r).toMatchObject({ ok: true, notes: [IMPORT_COPY.noteHdr] })
    if (!r.ok) return
    expect(readJson(r.projectId, 'project.json').source).toMatchObject({ videoCodec: 'hevc', hdr: true })
    expect(describeVideo(path.join(library, r.projectId, 'screen.mp4'))).toMatch(/Video: h264 \(High\).*yuv420p\(/)
  }, 60_000)

  it('imports VP9 WebM without sound, and 60 fps with the first of several sound tracks', async () => {
    const webm = await importVideo(at('vp9.webm'), { deps })
    expect(webm).toMatchObject({ ok: true })
    if (webm.ok) expect(readJson(webm.projectId, 'project.json')).toMatchObject({ hasAudio: false, capture: { fps: 30 }, source: { videoCodec: 'vp9', audioCodec: null } })
    const mkv = await importVideo(at('tracks.mkv'), { deps })
    expect(mkv).toMatchObject({ ok: true, notes: [IMPORT_COPY.noteTracks(2)] })
    if (mkv.ok) expect(readJson(mkv.projectId, 'project.json')).toMatchObject({ hasAudio: true, capture: { fps: 60 } })
  }, 60_000)

  it('imports without sound, with a note, when only the sound cannot be read', async () => {
    const tried: (number | null)[] = []
    const decodes = async (_file: string, _video: number, audio: number | null): Promise<boolean> => {
      tried.push(audio)
      return audio === null
    }
    const r = await importVideo(at('odd.mov'), { deps: { ...deps, decodes } })
    expect(tried).toEqual([1, null])
    expect(r).toMatchObject({ ok: true, notes: [IMPORT_COPY.noteNoSound] })
    if (!r.ok) return
    expect(readJson(r.projectId, 'project.json')).toMatchObject({ hasAudio: false, source: { audioCodec: null } })
    expect(describeVideo(path.join(library, r.projectId, 'screen.mp4'))).not.toMatch(/Audio:/)
  }, 60_000)

  it('refuses a picture the bundled ffmpeg cannot decode', async () => {
    const r = await importVideo(at('odd.mov'), { deps: { ...deps, decodes: async () => false } })
    expect(r).toMatchObject({ ok: false, error: IMPORT_COPY.codec('h264') })
    expect(folders()).toEqual([])
  })

  it('refuses what cannot be edited, leaving no folder', async () => {
    expect(await importVideo(at('sound.m4a'), { deps })).toMatchObject({ ok: false, error: IMPORT_COPY.extension })
    expect(await importVideo(at('sound-named.mp4'), { deps })).toMatchObject({ ok: false, error: IMPORT_COPY.soundOnly })
    expect(await importVideo(at('protected.mp4'), { deps })).toMatchObject({ ok: false, error: IMPORT_COPY.drm })
    expect(await importVideo(at('blink.mp4'), { deps })).toMatchObject({ ok: false, error: IMPORT_COPY.tooShort })
    expect(await importVideo(at('notes.mp4'), { deps })).toMatchObject({ ok: false, error: IMPORT_COPY.notVideo('mp4') })
    expect(folders()).toEqual([])
  }, 60_000)

  it('refuses when the disk is too full, before writing anything', async () => {
    const r = await importVideo(at('odd.mov'), { deps: { ...deps, freeBytes: async () => 100 * 1024 ** 2 } })
    expect(r.ok).toBe(false)
    if (!r.ok && !r.cancelled) expect(r.error).toMatch(/^There is not enough free space for this video: it needs about \d+ MB and 100 MB is free\.$/)
    expect(folders()).toEqual([])
  }, 30_000)

  it('stops at once when cancelled and leaves nothing behind', async () => {
    const controller = new AbortController()
    const r = await importVideo(at('odd.mov'), {
      deps,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.stage === 'converting') controller.abort()
      }
    })
    expect(r).toEqual({ ok: false, cancelled: true, fileName: 'odd.mov' })
    expect(folders()).toEqual([])
  }, 30_000)

  it('removes the folder when the encode fails', async () => {
    const r = await importVideo(at('odd.mov'), { deps: { ...deps, encoders: async () => ['h264_nvenc' as const] } })
    expect(r.ok).toBe(false)
    if (!r.ok && !r.cancelled) expect(r.error).toMatch(/^The video could not be converted/)
    expect(folders()).toEqual([])
  }, 30_000)
})

describe('sweepAbandonedImports', () => {
  it('removes folders of unfinished imports only', async () => {
    const make = (id: string, files: string[]): void => {
      mkdirSync(path.join(library, id), { recursive: true })
      for (const f of files) writeFileSync(path.join(library, id, f), '{}')
    }
    make('rec-1', [IMPORT_MARKER, 'screen.part.mp4'])
    make('rec-2', [IMPORT_MARKER, 'project.json'])
    make('rec-3', ['project.json'])
    make('rec-4', ['screen.webm'])
    make('rec-5', [IMPORT_MARKER])
    expect((await sweepAbandonedImports('rec-5')).sort()).toEqual(['rec-1'])
    expect(folders().sort()).toEqual(['rec-2', 'rec-3', 'rec-4', 'rec-5'])
    // A finished project keeps its folder; only its stale marker goes.
    expect(readdirSync(path.join(library, 'rec-2'))).toEqual(['project.json'])
  })
})
