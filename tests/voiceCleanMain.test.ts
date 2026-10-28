// Clean voice in the main process (src/main/voice, docs/design/clean-voice.md §4.3, §4.6, §7),
// with the real ffmpeg: the cleaned stem lies on the source's samples, is made once per source and
// strength, reports progress, can be cancelled, joins and replaces renders, keeps its model intact,
// and refuses anything but the app's own requests.
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-voice-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, () => void>(),
  spawned: [] as ChildProcess[]
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = (...args: Parameters<typeof actual.spawn>): ChildProcess => {
    const proc = actual.spawn(...args)
    h.spawned.push(proc)
    return proc
  }
  return { ...actual, spawn, default: { ...actual, spawn } }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(h.root, name),
    on: (event: string, fn: () => void) => h.appEvents.set(event, fn)
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { validateJob, type SoundInputs } from '../src/main/exportJob'
import { ensureVoiceModels, parseDuration, parseProgress, voiceCleanArgs, VoiceCleaner, voiceKey } from '../src/main/voice/voiceClean'
import { cleanVoiceInputs, registerVoiceIpc } from '../src/main/voice/voiceIpc'
import generalModel from '../src/main/voice/model/cb.rnnn?raw'
import speechModel from '../src/main/voice/model/sh.rnnn?raw'
import { VOICE_CANCELLED, VOICE_CHANNELS, VOICE_REPLACED, type VoiceProgress } from '../src/shared/api/voice'
import type { ExportJob } from '../src/shared/api/export'
import { VOICE_ENGINE, VOICE_FILE_RE, VOICE_MODEL_IDS, VOICE_PART_RE, voiceGraph } from '../src/shared/audio/voiceClean'
import { VOICE_COPY } from '../src/shared/audio/voiceCopy'

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const ff = ffmpegPath()
const RATE = 48000
const LS = path.join(__dirname, 'fixtures/speech/ls-1272-128104-0000.flac')
const projectsRoot = path.join(h.root, 'projects')
const modelDir = path.join(h.root, 'model')
const ID_RE = /^[a-zA-Z0-9_-]+$/
const projectDir = (id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`)
  return path.join(projectsRoot, id)
}

const texts = { speech: speechModel, general: generalModel }

function cleaner(progress?: (p: VoiceProgress) => void, modelTexts = texts): { c: VoiceCleaner; runs: () => number } {
  let runs = 0
  const c = new VoiceCleaner({
    projectDir,
    modelDir: () => modelDir,
    modelTexts,
    ffmpeg: () => {
      runs++
      return ff
    },
    onProgress: progress
  })
  return { c, runs: () => runs }
}

/** A project whose mic.m4a is speech with a fan-like hum and noise (and `seconds` long). */
function seed(id: string, seconds = 6): string {
  const dir = projectDir(id)
  mkdirSync(dir, { recursive: true })
  execFileSync(ff, [
    '-v', 'error', '-y', '-i', LS,
    '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.02:sample_rate=48000:seed=3:d=${seconds}`,
    '-filter_complex', `[0:a]aresample=48000,aformat=channel_layouts=mono,apad[s];[s][1:a]amix=inputs=2:duration=shortest:normalize=0,atrim=end=${seconds}`,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', path.join(dir, 'mic.m4a')
  ])
  return dir
}

/** Mono samples of `file` at 48 kHz. */
function samples(file: string): Float32Array {
  const r = spawnSync(ff, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
}

/** The lag (samples) of `b` behind `a` with the strongest correlation, within ±`max`, over 1–5 s. */
function lagOf(a: Float32Array, b: Float32Array, max = 2000): number {
  let best = 0
  let bestScore = -Infinity
  const from = RATE
  const to = 5 * RATE
  for (let lag = -max; lag <= max; lag++) {
    let s = 0
    for (let i = from; i < to; i += 2) s += a[i] * (b[i + lag] ?? 0)
    if (s > bestScore) {
      bestScore = s
      best = lag
    }
  }
  return best
}

const files = (dir: string): string[] => readdirSync(dir).sort()

describe('arguments and parsing', () => {
  it('cleans the first audio stream into AAC at 48 kHz with progress on stdout', () => {
    const args = voiceCleanArgs('/p/mic.m4a', '/p/voice-0123456789abcdef.part.m4a', 'strong')
    expect(args).toEqual([
      '-hide_banner', '-nostdin', '-nostats', '-y', '-i', '/p/mic.m4a', '-filter_complex', voiceGraph('strong'), '-map', '[voice]', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-progress', 'pipe:1', '/p/voice-0123456789abcdef.part.m4a'
    ])
  })

  it('reads the duration and the progress ffmpeg prints', () => {
    expect(parseDuration('  Duration: 00:01:02.50, start: 0.000000, bitrate: 160 kb/s')).toBeCloseTo(62.5, 6)
    expect(parseDuration('Duration: N/A')).toBeNull()
    expect(parseProgress('out_time_us=1500000\nprogress=continue\nout_time_us=2500000\n')).toBe(2.5)
    expect(parseProgress('out_time_us=N/A\n')).toBeNull()
  })

  it('keys a stem by the source file, the strength and the engine', () => {
    const k = voiceKey('mic', 'normal', { size: 10, mtimeMs: 1 })
    expect(k).toMatch(/^[0-9a-f]{16}$/)
    expect(voiceKey('mic', 'normal', { size: 10, mtimeMs: 1 })).toBe(k)
    expect(voiceKey('mic', 'light', { size: 10, mtimeMs: 1 })).not.toBe(k)
  })
})

describe('the models', () => {
  it('are the pinned files, bundled byte for byte', () => {
    const md = readFileSync(path.join(__dirname, '../src/main/voice/model/MODEL.md'), 'utf8')
    for (const id of VOICE_MODEL_IDS) {
      const pin = VOICE_ENGINE.models[id]
      const bytes = readFileSync(path.join(__dirname, '../src/main/voice/model', pin.file))
      expect(bytes.length, pin.file).toBe(pin.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), pin.file).toBe(pin.sha256)
      expect(Buffer.from(texts[id], 'utf8').equals(bytes), pin.file).toBe(true)
      expect(md, pin.file).toContain(pin.sha256)
    }
  })

  it('are written when missing and written again when damaged', async () => {
    const dir = path.join(h.root, 'model-check')
    await ensureVoiceModels(dir, texts)
    const file = path.join(dir, VOICE_ENGINE.models.general.file)
    expect(readFileSync(file, 'utf8')).toBe(generalModel)
    writeFileSync(file, 'rnnoise-nu model file version 1\n0 0 0\n')
    await ensureVoiceModels(dir, texts)
    expect(readFileSync(file, 'utf8')).toBe(generalModel)
    expect(readFileSync(path.join(dir, VOICE_ENGINE.models.speech.file), 'utf8')).toBe(speechModel)
  })

  it('refuse a bundled text that is not the pinned model', async () => {
    await expect(ensureVoiceModels(path.join(h.root, 'model-bad'), { ...texts, speech: speechModel.replace('42', '43') })).rejects.toThrow(VOICE_COPY.damagedModel)
    const { c } = cleaner(undefined, { ...texts, general: `${generalModel} ` })
    seed('badmodel', 2)
    await expect(c.ensure('badmodel', 'mic', 'normal')).rejects.toThrow(VOICE_COPY.damagedModel)
  })
})

describe('making the stem', () => {
  it('lies on the source samples, as long as the source, for every strength', async () => {
    const dir = seed('align')
    const { c } = cleaner()
    const src = samples(path.join(dir, 'mic.m4a'))
    for (const strength of ['light', 'normal', 'strong'] as const) {
      const file = await c.ensure('align', 'mic', strength)
      expect(file).toMatch(VOICE_FILE_RE)
      const out = samples(path.join(dir, file))
      expect(out.length, strength).toBe(src.length)
      expect(Math.abs(lagOf(src, out)), strength).toBeLessThanOrEqual(1)
    }
    expect(files(dir).filter((f) => VOICE_PART_RE.test(f))).toEqual([])
  }, 60_000)

  it('reports progress up to 1, then is ready and made only once', async () => {
    seed('once')
    const events: VoiceProgress[] = []
    const { c, runs } = cleaner((p) => events.push(p))
    expect(await c.status('once', 'mic', 'normal')).toEqual({ state: 'missing' })
    const file = await c.ensure('once', 'mic', 'normal')
    expect(runs()).toBe(1)
    expect(events[0]).toEqual({ projectId: 'once', source: 'mic', strength: 'normal', progress: 0 })
    expect(events[events.length - 1].progress).toBe(1)
    for (let i = 1; i < events.length; i++) expect(events[i].progress).toBeGreaterThanOrEqual(events[i - 1].progress)
    expect(await c.status('once', 'mic', 'normal')).toEqual({ state: 'ready', file })
    expect(await c.ensure('once', 'mic', 'normal')).toBe(file)
    expect(runs()).toBe(1)
  }, 30_000)

  it('is made again when the strength or the source file changes', async () => {
    const dir = seed('again', 2)
    const { c } = cleaner()
    const a = await c.ensure('again', 'mic', 'normal')
    const b = await c.ensure('again', 'mic', 'strong')
    expect(b).not.toBe(a)
    utimesSync(path.join(dir, 'mic.m4a'), new Date(), new Date(Date.now() + 5000))
    const d = await c.ensure('again', 'mic', 'normal')
    expect(d).not.toBe(a)
    expect(await c.status('again', 'mic', 'normal')).toEqual({ state: 'ready', file: d })
  }, 30_000)

  it('keeps the three newest stems', async () => {
    const dir = seed('prune', 2)
    const { c } = cleaner()
    const made: string[] = []
    for (const strength of ['light', 'normal', 'strong'] as const) made.push(await c.ensure('prune', 'mic', strength))
    expect(files(dir).filter((f) => VOICE_FILE_RE.test(f))).toHaveLength(3)
    // A changed source: a fourth stem, and the oldest goes.
    utimesSync(path.join(dir, 'mic.m4a'), new Date(), new Date(Date.now() + 9000))
    const fourth = await c.ensure('prune', 'mic', 'normal')
    const kept = files(dir).filter((f) => VOICE_FILE_RE.test(f))
    expect(kept).toHaveLength(3)
    expect(kept).toContain(fourth)
    expect(kept).not.toContain(made[0])
  }, 30_000)

  it('cleans the mixed track of a recording without stems, on its timestamps', async () => {
    const dir = projectDir('mixed')
    mkdirSync(dir, { recursive: true })
    // The sound starts 0.5 s into the video, as a proxy's track can.
    execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-itsoffset', '0.5', '-i', LS, '-t', '4', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ar', '48000', path.join(dir, 'screen.mp4')])
    const { c } = cleaner()
    const file = await c.ensure('mixed', 'mix', 'normal')
    const out = samples(path.join(dir, file))
    // What the export reads of the mixed track: the same placement.
    const ref = spawnSync(ff, ['-v', 'error', '-i', path.join(dir, 'screen.mp4'), '-vn', '-af', 'aresample=48000:async=1:first_pts=0', '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }).stdout
    const src = new Float32Array(ref.buffer.slice(ref.byteOffset, ref.byteOffset + ref.length))
    expect(Math.abs(out.length - src.length)).toBeLessThanOrEqual(1024)
    expect(Math.abs(lagOf(src, out))).toBeLessThanOrEqual(1)
    let lead = 0
    for (let i = 0; i < 0.45 * RATE; i++) lead = Math.max(lead, Math.abs(out[i]))
    expect(lead).toBeLessThan(1e-3)
  }, 30_000)

  it('says what is missing', async () => {
    mkdirSync(projectDir('empty'), { recursive: true })
    const { c } = cleaner()
    await expect(c.ensure('empty', 'mic', 'normal')).rejects.toThrow(VOICE_COPY.missingMic)
    await expect(c.ensure('empty', 'mix', 'normal')).rejects.toThrow(VOICE_COPY.missingMix)
    expect(await c.status('empty', 'mic', 'normal')).toEqual({ state: 'missing' })
  })

  it('refuses ids, sources and strengths it does not know', async () => {
    const { c } = cleaner()
    await expect(c.ensure('../x', 'mic', 'normal')).rejects.toThrow(/Invalid project id/)
    await expect(c.ensure(3, 'mic', 'normal')).rejects.toThrow('Invalid request.')
    await expect(c.ensure('align', 'system', 'normal')).rejects.toThrow('Invalid request.')
    await expect(c.ensure('align', '../../etc/passwd', 'normal')).rejects.toThrow('Invalid request.')
    await expect(c.ensure('align', 'mic', 'max')).rejects.toThrow('Invalid request.')
    await expect(c.status('align', 'mic', undefined)).rejects.toThrow('Invalid request.')
    await expect(c.cancel(null)).rejects.toThrow('Invalid request.')
  })
})

describe('running renders', () => {
  it('cancel stops ffmpeg and leaves no part file', async () => {
    const dir = seed('cancel', 120)
    let first!: () => void
    const started = new Promise<void>((r) => (first = r))
    const { c } = cleaner((p) => p.progress > 0 && first())
    const run = c.ensure('cancel', 'mic', 'strong')
    await started
    expect((await c.status('cancel', 'mic', 'strong')).state).toBe('working')
    await c.cancel('cancel')
    await expect(run).rejects.toThrow(VOICE_CANCELLED)
    expect(files(dir).filter((f) => f.startsWith('voice-'))).toEqual([])
    expect(await c.status('cancel', 'mic', 'strong')).toEqual({ state: 'missing' })
  }, 60_000)

  it('a second request for the same stem joins the first', async () => {
    seed('join', 4)
    const { c, runs } = cleaner()
    const [a, b] = await Promise.all([c.ensure('join', 'mic', 'normal'), c.ensure('join', 'mic', 'normal')])
    expect(a).toBe(b)
    expect(runs()).toBe(1)
  }, 30_000)

  it('a request for another stem stops the running one', async () => {
    const dir = seed('switch', 60)
    const { c } = cleaner()
    const first = c.ensure('switch', 'mic', 'strong')
    const second = c.ensure('switch', 'mic', 'light')
    await expect(first).rejects.toThrow(VOICE_REPLACED)
    const file = await second
    expect(files(dir).filter((f) => f.startsWith('voice-'))).toEqual([file])
  }, 60_000)

  it('quick changes of strength leave one render, which Cancel stops', async () => {
    const dir = seed('quick', 120)
    const { c, runs } = cleaner()
    const a = c.ensure('quick', 'mic', 'normal')
    await new Promise((r) => setTimeout(r, 50))
    // Light, Strong, then Normal again: each request replaces the one before.
    const b = c.ensure('quick', 'mic', 'light')
    const d = c.ensure('quick', 'mic', 'strong')
    const e = c.ensure('quick', 'mic', 'normal')
    const later = Promise.allSettled([b, d, e])
    await expect(a).rejects.toThrow(VOICE_REPLACED)
    await new Promise((r) => setTimeout(r, 300))
    await c.cancel('quick')
    const results = await later
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    // Every ffmpeg that started has exited: nothing is left running or written.
    expect(h.spawned.every((p) => p.exitCode !== null || p.signalCode !== null)).toBe(true)
    expect(files(dir).filter((f) => f.startsWith('voice-'))).toEqual([])
    expect(runs()).toBeLessThanOrEqual(3)
  }, 60_000)

  it('asking for a stem that is already made never stops another render', async () => {
    seed('keep', 120)
    const { c } = cleaner()
    const quick = cleaner().c
    // Light is made first (by another cleaner, so this one only finds the file).
    const light = await quick.ensure('keep', 'mic', 'light')
    const strong = c.ensure('keep', 'mic', 'strong')
    strong.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 200))
    expect(await c.ensure('keep', 'mic', 'light')).toBe(light)
    expect((await c.status('keep', 'mic', 'strong')).state).toBe('working')
    await c.cancel('keep')
    await expect(strong).rejects.toThrow(VOICE_CANCELLED)
  }, 60_000)

  it('stopAll kills every render', async () => {
    seed('quit', 120)
    const { c } = cleaner()
    const run = c.ensure('quit', 'mic', 'strong')
    await new Promise((r) => setTimeout(r, 300))
    c.stopAll()
    await expect(run).rejects.toThrow(VOICE_CANCELLED)
  }, 60_000)
})

describe('IPC and export', () => {
  const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href } }
  const otherEvent = { senderFrame: { url: 'https://example.com/' } }

  it('answers the app page only', async () => {
    registerVoiceIpc()
    for (const ch of Object.values(VOICE_CHANNELS).filter((c) => c !== VOICE_CHANNELS.progress)) {
      const handler = h.handlers.get(ch)!
      expect(handler, ch).toBeTypeOf('function')
      expect(() => handler(otherEvent, 'x', 'mic', 'normal'), ch).toThrow('Not allowed')
      expect(() => handler({}, 'x', 'mic', 'normal'), ch).toThrow('Not allowed')
    }
    mkdirSync(path.join(h.root, 'videos', 'Flown', 'ipc'), { recursive: true })
    await expect(h.handlers.get(VOICE_CHANNELS.status)!(appEvent, 'ipc', 'mic', 'normal')).resolves.toEqual({ state: 'missing' })
    expect(h.appEvents.has('will-quit')).toBe(true)
  })

  const job = (voice?: unknown, stems?: Record<string, number>): ExportJob =>
    ({
      width: 0,
      height: 0,
      fps: 30,
      frames: 90,
      format: 'm4a',
      quality: 'high',
      video: { kind: 'none' },
      audio: { clips: [{ id: 'a', start: 0, end: 3, speed: 1 }], volume: 1, ...(stems ? { stems } : {}), ...(voice === undefined ? {} : { voice }) },
      outputPath: '/videos/out.m4a'
    }) as ExportJob

  it('accepts the three strengths in a job and nothing else', () => {
    for (const v of ['light', 'normal', 'strong']) expect(() => validateJob(job(v))).not.toThrow()
    expect(() => validateJob(job())).not.toThrow()
    for (const v of ['max', '', 1, null, { on: true }]) expect(() => validateJob(job(v)), String(v)).toThrow(/Invalid export settings/)
  })

  it('puts the cleaned stem in place of the microphone stem, or of the mixed track', async () => {
    const dir = path.join(h.root, 'videos', 'Flown', 'exp')
    const ensure = vi.fn(async (_id: unknown, source: unknown, strength: unknown) => `voice-${source === 'mic' ? 'a' : 'b'}${strength === 'strong' ? 'c' : 'd'}00000000000000.m4a`)
    const stems: SoundInputs = { job: job('strong', { mic: 1, system: 1 }), audioInput: path.join(dir, 'screen.mp4'), stems: { mic: path.join(dir, 'mic.m4a'), system: path.join(dir, 'system.m4a') } }
    expect(await cleanVoiceInputs(stems, 'exp', undefined, { ensure })).toEqual({ ...stems, stems: { mic: path.join(dir, 'voice-ac00000000000000.m4a'), system: path.join(dir, 'system.m4a') } })
    expect(ensure).toHaveBeenLastCalledWith('exp', 'mic', 'strong')
    const mixed: SoundInputs = { job: job('normal'), audioInput: path.join(dir, 'screen.mp4') }
    expect(await cleanVoiceInputs(mixed, 'exp', undefined, { ensure })).toEqual({ ...mixed, audioInput: path.join(dir, 'voice-bd00000000000000.m4a') })
    expect(ensure).toHaveBeenLastCalledWith('exp', 'mix', 'normal')
  })

  it('leaves a job without Clean voice, or without a microphone stem, untouched', async () => {
    const ensure = vi.fn(async () => 'voice-0000000000000000.m4a')
    const plain: SoundInputs = { job: job(undefined, { mic: 1 }), audioInput: '/p/screen.mp4', stems: { mic: '/p/mic.m4a' } }
    expect(await cleanVoiceInputs(plain, 'exp', undefined, { ensure })).toBe(plain)
    const systemOnly: SoundInputs = { job: job('normal', { system: 1 }), audioInput: '/p/screen.mp4', stems: { system: '/p/system.m4a' } }
    expect(await cleanVoiceInputs(systemOnly, 'exp', undefined, { ensure })).toBe(systemOnly)
    const silent: SoundInputs = { job: { ...job('normal'), audio: undefined }, audioInput: null }
    expect(await cleanVoiceInputs(silent, 'exp', undefined, { ensure })).toBe(silent)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('cleans nothing when the stems were dropped for a missing file (the preview plays the mixed sound then)', async () => {
    const ensure = vi.fn(async () => 'voice-0000000000000000.m4a')
    const requested = job('normal', { mic: 1, system: 1 })
    const fellBack: SoundInputs = { job: job('normal'), audioInput: '/p/screen.mp4' }
    expect(await cleanVoiceInputs(fellBack, 'exp', requested, { ensure })).toBe(fellBack)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('stops the export with the reason when the voice cannot be cleaned', async () => {
    const ensure = vi.fn(async () => {
      throw new Error(VOICE_COPY.missingMic)
    })
    await expect(cleanVoiceInputs({ job: job('normal', { mic: 1 }), audioInput: '/p/screen.mp4', stems: { mic: '/p/mic.m4a' } }, 'exp', undefined, { ensure })).rejects.toThrow(`${VOICE_COPY.failed} ${VOICE_COPY.missingMic}`)
  })
})
