// The stem step after the video (docs/design/output-and-languages.md §7.6, §23.1 tests 34 and 35): the
// stems are cut from the project's own files, the separate microphone and system files even where the
// video mixed screen.mp4, Clean voice's cleaned microphone in place of the original; they go next to the
// video under free names; a failure is reported and a cancel deletes the stems written so far, never
// the video. Runs the Linux ffmpeg where the files themselves matter.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'
import { APP_NAME } from '../src/shared/brand'
import { t } from '../src/shared/i18n/t'

const root = mkdtempSync(path.join(tmpdir(), 'ssw-stems-run-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(root, name), on: () => undefined, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined }
}))

const { writeStemsStep, renderStems } = await import('../src/main/stemsRun')
const { cleanVoiceInputs } = await import('../src/main/voice/voiceIpc')
const { ffmpegPath, FfmpegFailure, startFfmpeg } = await import('../src/main/ffmpeg')
type Deps = NonNullable<Parameters<typeof writeStemsStep>[4]>

const ff = ffmpegPath()
// Where the app keeps project p1 (projects.projectDir), so Clean voice's own lookup finds it too.
const project = path.join(root, 'videos', APP_NAME, 'p1')
mkdirSync(project, { recursive: true })
const make = (file: string, lavfi: string, codec = 'aac'): string => {
  execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', lavfi, '-t', '4', '-c:a', codec, file])
  return file
}
make(path.join(project, 'screen.mp4'), "aevalsrc='0.2*sin(2*PI*330*t)|0.2*sin(2*PI*660*t)':s=48000:c=stereo")
make(path.join(project, 'mic.m4a'), 'aevalsrc=0.4*sin(2*PI*440*t):s=48000:c=mono')
make(path.join(project, 'system.m4a'), "aevalsrc='0.1*sin(2*PI*300*t)|0.1*sin(2*PI*300*t)':s=48000:c=stereo")
// What Clean voice made of the microphone: much quieter, so the stem shows which file it read.
make(path.join(project, 'voice-normal.wav'), 'aevalsrc=0.01*sin(2*PI*440*t):s=48000:c=mono', 'pcm_s16le')

let out = ''
let n = 0
beforeEach(() => {
  out = path.join(root, `out${n++}`)
  mkdirSync(out)
  writeFileSync(path.join(out, 'Demo.mp4'), 'the video')
})

const leftovers = { added: [] as string[][], removed: [] as string[][], add(f: string[]) { this.added.push(f) }, remove(f: string[]) { this.removed.push(f) } }
/** The step's own parts, with the project above and no Clean voice. */
const deps = (over: Partial<Deps> = {}): Partial<Deps> => ({
  recorded: async () => ['mic', 'system'],
  cleanVoice: async (sound) => sound,
  tempDir: () => root,
  leftovers,
  ...over
})

/** An export of 3 s whose video mixes screen.mp4's track (the separate files are at their default gains). */
const job = (over: Partial<ExportJob> = {}): ExportJob => ({
  width: 1280,
  height: 720,
  fps: 30,
  frames: 90,
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' },
  audio: { clips: [{ id: 'a', start: 0, end: 3, speed: 1 }], volume: 1 },
  stems: { stems: ['voice', 'system'] },
  outputPath: path.join(out, 'Demo.mp4'),
  ...over
})

/** RMS of a float WAV's samples. */
function level(file: string): number {
  const b = readFileSync(file)
  const at = b.indexOf('data')
  const bytes = new Uint8Array(b.subarray(at + 8, at + 8 + b.readUInt32LE(at + 4)))
  const s = new Float32Array(bytes.buffer)
  return Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length)
}

/** The temporary outputs an ffmpeg command writes (after each "-f wav"). */
const wavOutputs = (args: string[]): string[] => args.flatMap((a, i) => (a === 'wav' && args[i - 1] === '-f' ? [args[i + 1]] : []))

describe('the stem step with the Linux ffmpeg', () => {
  it('cuts Voice and System sound from the separate files next to the video, with free names, and leaves nothing else', async () => {
    writeFileSync(path.join(out, 'Demo - Voice.wav'), 'kept')
    const ran: string[][] = []
    const r = await writeStemsStep(job(), path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', deps({ run: (args) => (ran.push(args), startFfmpeg(args)) }))
    expect(r.stemsProblem).toBeUndefined()
    expect(r.stems?.map((s) => [s.stem, path.basename(s.path)])).toEqual([
      ['voice', 'Demo - Voice (2).wav'],
      ['system', 'Demo - System sound.wav']
    ])
    for (const s of r.stems!) expect(s.bytes).toBe(readFileSync(s.path).length)
    // One ffmpeg run, reading the separate files although the video mixed screen.mp4.
    expect(ran).toHaveLength(1)
    expect(ran[0]).toContain(path.join(project, 'mic.m4a'))
    expect(ran[0]).toContain(path.join(project, 'system.m4a'))
    expect(ran[0]).not.toContain(path.join(project, 'screen.mp4'))
    expect(level(r.stems![0].path)).toBeGreaterThan(0.2)
    // The video and the file that was there are untouched; no temporary file is left.
    expect(readFileSync(path.join(out, 'Demo.mp4'), 'utf8')).toBe('the video')
    expect(readFileSync(path.join(out, 'Demo - Voice.wav'), 'utf8')).toBe('kept')
    expect(readdirSync(out).sort()).toEqual(['Demo - System sound.wav', 'Demo - Voice (2).wav', 'Demo - Voice.wav', 'Demo.mp4'])
    expect(leftovers.added.at(-1)).toEqual(wavOutputs(ran[0]))
    expect(leftovers.removed.at(-1)).toEqual(leftovers.added.at(-1))
  })

  it('Clean voice: the Voice stem is the cleaned microphone (test 34)', async () => {
    const ensure = vi.fn(async () => 'voice-normal.wav')
    const ran: string[][] = []
    const voiced = job({ audio: { clips: [{ id: 'a', start: 0, end: 3, speed: 1 }], volume: 1, voice: 'normal' } })
    const r = await writeStemsStep(voiced, path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', {
      ...deps(),
      cleanVoice: (sound, id, requested) => cleanVoiceInputs(sound, id, requested, { ensure }),
      run: (args) => (ran.push(args), startFfmpeg(args))
    })
    expect(ensure).toHaveBeenCalledWith('p1', 'mic', 'normal')
    expect(ran[0]).toContain(path.join(project, 'voice-normal.wav'))
    expect(ran[0]).not.toContain(path.join(project, 'mic.m4a'))
    const voice = r.stems!.find((s) => s.stem === 'voice')!
    expect(level(voice.path)).toBeLessThan(0.02)
  })

  it('a recording without separate files gives Recording, from screen.mp4', async () => {
    const r = await writeStemsStep(job({ stems: { stems: ['recording'] } }), path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', deps({ recorded: async () => [] }))
    expect(r.stems?.map((s) => path.basename(s.path))).toEqual(['Demo - Recording.wav'])
  })

  it('renderStems writes Music and Effects alone into a folder under the names given (P4)', async () => {
    const music = make(path.join(project, 'music-1.m4a'), "aevalsrc='0.3*sin(2*PI*220*t)|0.3*sin(2*PI*220*t)':s=48000:c=stereo")
    void music
    const media = path.join(out, 'Demo media')
    mkdirSync(media)
    writeFileSync(path.join(media, 'Music.wav'), 'taken')
    const timelineJob = job({ stems: undefined, music: { file: 'music-1.m4a', volume: 0.5, loop: false, fadeIn: 0, fadeOut: 0, duration: 4 }, clicks: { times: [1], volume: 1 } })
    const ran: string[][] = []
    const written = await renderStems(timelineJob, media, ['music', 'effects'], { music: 'Music.wav', effects: '../Effects.wav' }, new AbortController().signal, 'p1', deps({ run: (args) => (ran.push(args), startFfmpeg(args)) }))
    expect(written).toEqual({ music: path.join(media, 'Music (2).wav'), effects: path.join(media, 'Effects.wav') })
    expect(readFileSync(path.join(media, 'Music.wav'), 'utf8')).toBe('taken')
    expect(level(written.music!)).toBeGreaterThan(0.1)
    // The recording is not read for Music and Effects.
    for (const f of ['mic.m4a', 'system.m4a', 'screen.mp4']) expect(ran[0]).not.toContain(path.join(project, f))
  })
})

describe('failures, cancels and silence (test 35)', () => {
  /** An ffmpeg that writes its outputs' first bytes, then waits to be killed or ended. */
  function fakeRun(end: { ok: boolean; detail?: string } | null) {
    const runs: { args: string[]; killed: boolean }[] = []
    const run = (args: string[]) => {
      for (const f of wavOutputs(args)) writeFileSync(f, 'RIFF partial')
      const entry = { args, killed: false }
      runs.push(entry)
      let settle!: (e?: Error) => void
      const done = new Promise<void>((resolve, reject) => (settle = (e) => (e ? reject(e) : resolve())))
      done.catch(() => undefined)
      if (end) setTimeout(() => settle(end.ok ? undefined : new FfmpegFailure('The video encoder stopped unexpectedly.', `ffmpeg exited with code 1\n${end.detail ?? ''}`)), 5)
      return {
        done,
        kill: () => {
          entry.killed = true
          settle(new FfmpegFailure('The video encoder was stopped.', 'ffmpeg stopped (SIGKILL)'))
        }
      }
    }
    return { run, runs }
  }

  it('a cancel while ffmpeg runs kills it, deletes the stems written so far and keeps the video', async () => {
    const f = fakeRun(null)
    const abort = new AbortController()
    const step = writeStemsStep(job(), path.join(out, 'Demo.mp4'), abort.signal, 'p1', deps({ run: f.run }))
    await vi.waitFor(() => expect(f.runs).toHaveLength(1))
    const temps = wavOutputs(f.runs[0].args)
    expect(temps.every((p) => existsSync(p))).toBe(true)
    abort.abort()
    expect(await step).toEqual({})
    expect(f.runs[0].killed).toBe(true)
    expect(readdirSync(out)).toEqual(['Demo.mp4'])
    expect(readFileSync(path.join(out, 'Demo.mp4'), 'utf8')).toBe('the video')
  })

  it('a cancel between two renames deletes the stem already in place too', async () => {
    const f = fakeRun({ ok: true })
    const abort = new AbortController()
    const renamed: string[] = []
    const rename = async (from: string, to: string): Promise<void> => {
      writeFileSync(to, readFileSync(from))
      rmSync(from)
      renamed.push(to)
      abort.abort()
    }
    expect(await writeStemsStep(job(), path.join(out, 'Demo.mp4'), abort.signal, 'p1', deps({ run: f.run, rename }))).toEqual({})
    expect(renamed).toEqual([path.join(out, 'Demo - Voice.wav')])
    expect(readdirSync(out)).toEqual(['Demo.mp4'])
  })

  it('a cancel before anything ran writes nothing', async () => {
    const f = fakeRun({ ok: true })
    const abort = new AbortController()
    abort.abort()
    expect(await writeStemsStep(job(), path.join(out, 'Demo.mp4'), abort.signal, 'p1', deps({ run: f.run }))).toEqual({})
    expect(f.runs).toHaveLength(0)
    expect(readdirSync(out)).toEqual(['Demo.mp4'])
  })

  it('renderStems rejects on a cancel, having deleted what it wrote', async () => {
    const f = fakeRun(null)
    const abort = new AbortController()
    const media = path.join(out, 'media')
    mkdirSync(media)
    const step = renderStems(job({ stems: undefined, clicks: { times: [1], volume: 1 } }), media, ['effects'], { effects: 'Effects.wav' }, abort.signal, 'p1', deps({ run: f.run }))
    await vi.waitFor(() => expect(f.runs).toHaveLength(1))
    abort.abort()
    await expect(step).rejects.toMatchObject({ name: 'AbortError' })
    expect(readdirSync(media)).toEqual([])
  })

  it('a failure is reported with its reason, in the stems words when ffmpeg gives none, and never undoes the video', async () => {
    const full = await writeStemsStep(job(), path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', deps({ run: fakeRun({ ok: false, detail: 'Error writing trailer: No space left on device' }).run }))
    expect(full).toEqual({ stemsProblem: 'The disk is full.' })
    const other = await writeStemsStep(job(), path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', deps({ run: fakeRun({ ok: false, detail: 'something else' }).run }))
    expect(other).toEqual({ stemsProblem: t('errors.stems.failed') })
    expect(readdirSync(out)).toEqual(['Demo.mp4'])
  })

  it('a missing file the stems need is reported as the export reports it', async () => {
    // The system sound is turned down, so the mixed track cannot stand in for a missing file.
    const turned = job({ stems: { stems: ['voice', 'system'], gains: { system: 0.5 } } })
    const r = await writeStemsStep(turned, path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', deps({ fileExists: async (f) => !f.endsWith('system.m4a') }))
    expect(r.stemsProblem).toMatch(/system sound \(system\.m4a\) file of this recording is missing/)
    expect(readdirSync(out)).toEqual(['Demo.mp4'])
  })

  it('stems that would all be silent are not written, and the step says so', async () => {
    const run = vi.fn()
    const r = await writeStemsStep(job({ clicks: { times: [9], volume: 1 }, stems: { stems: ['effects'] } }), path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', deps({ run }))
    expect(r).toEqual({ stemsProblem: t('errors.stems.noSound') })
    expect(run).not.toHaveBeenCalled()
  })

  it('a job without stems runs nothing', async () => {
    const run = vi.fn()
    expect(await writeStemsStep(job({ stems: undefined }), path.join(out, 'Demo.mp4'), new AbortController().signal, 'p1', deps({ run }))).toEqual({})
    expect(run).not.toHaveBeenCalled()
  })
})
