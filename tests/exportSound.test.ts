// The main process's checks of an export's soundtrack: validated settings, files resolved
// inside the project folder only, stems falling back to the mixed track.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSoundInputs, validateJob } from '../src/main/exportJob'
import { MAX_DUCK_RANGES } from '../src/shared/audio/automation'
import type { ExportJob, MusicSound } from '../src/shared/api/export'

const job: ExportJob = {
  width: 1280,
  height: 720,
  fps: 30,
  frames: 300,
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
  outputPath: '/videos/out.mp4'
}
const audio = { clips: [{ id: 'a', start: 0, end: 10, speed: 1 }], volume: 1 }
const music: MusicSound = { file: 'music.mp3', volume: 0.4, loop: true, fadeIn: 1, fadeOut: 2, duration: 30, duck: { depth: 0.7, attack: 0.15, release: 0.45, ranges: [{ start: 1, end: 2 }] } }

describe('validateJob (soundtrack)', () => {
  it('accepts stems, cleanup, music and fades', () => {
    expect(() => validateJob({ ...job, audio: { ...audio, stems: { mic: 1.5, system: 0.2 }, noiseReduction: 0.4, normalize: true }, music, fadeIn: 1, fadeOut: 2 })).not.toThrow()
    expect(() => validateJob({ ...job, music: { ...music, duration: null, duck: undefined } })).not.toThrow()
  })

  it('rejects anything ffmpeg arguments could be built from unchecked', () => {
    const bad: Partial<ExportJob>[] = [
      { audio: { ...audio, stems: { camera: 1 } as never } },
      { audio: { ...audio, stems: {} } },
      { audio: { ...audio, stems: { mic: 3 } } },
      { audio: { ...audio, noiseReduction: 2 } },
      { audio: { ...audio, normalize: 'yes' as never } },
      { music: { ...music, file: '../secret.mp3' } },
      { music: { ...music, file: 'music.exe' } },
      { music: { ...music, file: 'C:\\music.mp3' } },
      { music: { ...music, volume: Number.NaN } },
      { music: { ...music, loop: 1 as never } },
      { music: { ...music, fadeOut: 60 } },
      { music: { ...music, duck: { ...music.duck!, depth: 2 } } },
      { music: { ...music, duck: { ...music.duck!, ranges: [{ start: 3, end: 1 }] } } },
      { music: { ...music, duck: { ...music.duck!, ranges: Array.from({ length: MAX_DUCK_RANGES + 1 }, (_, i) => ({ start: i, end: i + 0.5 })) } } },
      { fadeIn: -1 },
      { fadeOut: 100 }
    ]
    for (const b of bad) expect(() => validateJob({ ...job, ...b }), JSON.stringify(b).slice(0, 80)).toThrow('Invalid export settings')
  })

  it('a GIF never carries music; an M4A may be music only', () => {
    expect(() => validateJob({ ...job, format: 'gif', music })).toThrow()
    const m4a: ExportJob = { ...job, format: 'm4a', width: 0, height: 0, video: { kind: 'none' } }
    expect(() => validateJob(m4a)).toThrow(/no sound/)
    expect(() => validateJob({ ...m4a, music })).not.toThrow()
  })
})

describe('resolveSoundInputs', () => {
  const dir = path.join('/projects', 'rec-1')
  const files = (present: string[]) => async (f: string) => present.includes(path.basename(f)) && path.dirname(f) === dir

  it('reads the screen proxy, or the stems, and the music, all inside the project folder', async () => {
    const plain = await resolveSoundInputs({ ...job, audio }, dir, files([]))
    expect(plain).toEqual({ job: { ...job, audio }, audioInput: path.join(dir, 'screen.mp4') })
    const withStems = { ...job, audio: { ...audio, stems: { mic: 1, system: 0.5 } }, music }
    const r = await resolveSoundInputs(withStems, dir, files(['mic.m4a', 'system.m4a', 'music.mp3']))
    expect(r.stems).toEqual({ mic: path.join(dir, 'mic.m4a'), system: path.join(dir, 'system.m4a') })
    expect(r.music).toBe(path.join(dir, 'music.mp3'))
    expect(r.job).toBe(withStems)
  })

  it('falls back to the mixed track when a stem file is missing', async () => {
    const r = await resolveSoundInputs({ ...job, audio: { ...audio, stems: { mic: 1, system: 0.5 }, normalize: true } }, dir, files(['mic.m4a']))
    expect(r.stems).toBeUndefined()
    expect(r.job.audio).toEqual({ ...audio, normalize: true })
  })

  it('says so when the music file is gone', async () => {
    await expect(resolveSoundInputs({ ...job, music }, dir, files([]))).rejects.toThrow(/music file is missing/)
  })
})
