// The main process's checks of an export's soundtrack: validated settings, files resolved
// inside the project folder only, stems falling back to the mixed track only when that sounds
// the same, and per-pick music names.
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
    // Each music pick has its own name (music-<n>.<ext>), so undo can go back to an earlier one.
    expect(() => validateJob({ ...job, music: { ...music, file: 'music-12.wav' } })).not.toThrow()
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
      { music: { ...music, file: 'music-0.mp3' } },
      { music: { ...music, file: 'music-1.mp3/../x.mp3' } },
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
    const plain = await resolveSoundInputs({ ...job, audio }, dir, files([]), [])
    expect(plain).toEqual({ job: { ...job, audio }, audioInput: path.join(dir, 'screen.mp4') })
    const withStems = { ...job, audio: { ...audio, stems: { mic: 1, system: 0.5 } }, music }
    const r = await resolveSoundInputs(withStems, dir, files(['mic.m4a', 'system.m4a', 'music.mp3']), ['mic', 'system'])
    expect(r.stems).toEqual({ mic: path.join(dir, 'mic.m4a'), system: path.join(dir, 'system.m4a') })
    expect(r.music).toBe(path.join(dir, 'music.mp3'))
    expect(r.job).toBe(withStems)
    const picked = await resolveSoundInputs({ ...job, music: { ...music, file: 'music-3.m4a' } }, dir, files(['music-3.m4a']), [])
    expect(picked.music).toBe(path.join(dir, 'music-3.m4a'))
  })

  it('falls back to the mixed track for a missing stem only when that sounds the same', async () => {
    // Stems asked for only to clean the microphone, every source at full volume: the mixed track is their sum.
    const cleanOnly = { ...job, audio: { ...audio, stems: { mic: 1, system: 1 }, noiseReduction: 0.5, normalize: true } }
    const r = await resolveSoundInputs(cleanOnly, dir, files(['mic.m4a']), ['mic', 'system'])
    expect(r.stems).toBeUndefined()
    expect(r.job.audio).toEqual({ ...audio, noiseReduction: 0.5, normalize: true })
  })

  it('refuses to bring back a source the user muted or turned down when a stem file is missing', async () => {
    // The system sound turned down: the mixed track would play it at full volume.
    await expect(resolveSoundInputs({ ...job, audio: { ...audio, stems: { mic: 1, system: 0.5 } } }, dir, files(['mic.m4a']), ['mic', 'system'])).rejects.toThrow(
      /system sound \(system\.m4a\) file of this recording is missing, so a source you muted or turned down cannot be left out/
    )
    // The microphone muted (left out of the job): the mixed track has it.
    await expect(resolveSoundInputs({ ...job, audio: { ...audio, stems: { system: 1 } } }, dir, files([]), ['mic', 'system'])).rejects.toThrow(/Open the recording again/)
    // Its stem being there does not matter: what is missing is the one that is heard.
    await expect(resolveSoundInputs({ ...job, audio: { ...audio, stems: { system: 1 } } }, dir, files(['mic.m4a']), ['mic', 'system'])).rejects.toThrow(/system sound/)
  })

  it('says so when the music file is gone', async () => {
    await expect(resolveSoundInputs({ ...job, music }, dir, files([]), [])).rejects.toThrow(/music file is missing/)
  })
})
