/**
 * The speech detector in the level analysis (src/main/audioAnalysis.ts, src/main/speech/vad.ts)
 * with real ffmpeg and the fake helper: which sources get speech, failures and stops, the
 * persisted .cache/speech.json read back as untrusted input, serialised writes and a write
 * skipped after a stop, and the switch to the compatible build after an illegal instruction.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioLevels } from '../src/shared/audio/loudness'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-analysis-speech-')) as string
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => require('node:path').resolve(__dirname, '..'),
    getPath: (name: string) => require('node:path').join(h.root, name),
    on: () => undefined
  }
}))

import { analyzeAudio, stopAudioAnalysisFor } from '../src/main/audioAnalysis'
import { ffmpegPath } from '../src/main/ffmpeg'
import { ProjectProcesses } from '../src/main/projectProcesses'
import { resetHelperSelection, type HelperChoice } from '../src/main/speech/helper'
import { rangesOfEntry, resetSpeechDetector, SPEECH_CACHE_FILE, speechOfFile, speechWritesSettled, vadLineFits } from '../src/main/speech/vad'
import { ENGINE_VERSION, VAD_MODEL } from '../src/shared/speech/catalog'

const FAKE = path.resolve(__dirname, 'fixtures/fake-speech-helper.cjs')
const log = path.join(h.root, 'calls.jsonl')
const vadCalls = (): number => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).filter((l) => JSON.parse(l).args[0] === 'vad').length
const root = path.join(h.root, 'videos', 'Flown')
/** The fake reports speech in frames 31..93 (1-3 s), padded by 30 ms. */
const FAKE_RANGES = [{ start: 0.962, end: 3.038 }]

/** A project with a 6 s mixed track and, optionally, a 6 s microphone stem. */
function seed(id: string, mic: boolean): string {
  const dir = path.join(root, id)
  mkdirSync(dir, { recursive: true })
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'aac']
  execFileSync(ffmpegPath(), ['-v', 'error', '-y', ...tone, '-f', 'mp4', path.join(dir, 'screen.mp4')])
  if (mic) execFileSync(ffmpegPath(), ['-v', 'error', '-y', ...tone, path.join(dir, 'mic.m4a')])
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ duration: 6 }))
  return dir
}

const levelsOf = (seconds: number): AudioLevels => ({ window: 0.05, power: new Float32Array(Math.round(seconds / 0.05)) })

beforeAll(() => {
  process.env.SSW_SPEECH_HELPER = FAKE
  process.env.FAKE_SPEECH_LOG = log
})
beforeEach(() => {
  writeFileSync(log, '')
  delete process.env.FAKE_SPEECH_MODE
  delete process.env.FAKE_SPEECH_AUDIO_S
  resetHelperSelection()
  resetSpeechDetector()
})
afterAll(() => {
  for (const k of ['SSW_SPEECH_HELPER', 'FAKE_SPEECH_LOG', 'FAKE_SPEECH_MODE', 'FAKE_SPEECH_AUDIO_S']) delete process.env[k]
  rmSync(h.root, { recursive: true, force: true })
})

describe('analyzeAudio with the speech detector', () => {
  it('adds speech to the microphone stem, and to the mixed track only when there is no mic.m4a; never to system', async () => {
    seed('rec-mic', true)
    const withMic = await analyzeAudio('rec-mic', ['mix', 'mic'])
    expect(withMic.mic!.speech).toEqual(FAKE_RANGES)
    expect(withMic.mix!.speech).toBeUndefined()
    expect(vadCalls()).toBe(1)
    seed('rec-mix', false)
    const mixOnly = await analyzeAudio('rec-mix', ['mix'])
    expect(mixOnly.mix!.speech).toHaveLength(1)
    // Persisted per source in the project, and reused from main's cache next time.
    expect(Object.keys(JSON.parse(readFileSync(path.join(root, 'rec-mix', SPEECH_CACHE_FILE), 'utf8')).entries)).toEqual(['mix'])
    await analyzeAudio('rec-mix', ['mix'])
    expect(vadCalls()).toBe(2)
  })

  it('a definitive failure settles the levels without speech, and is not run again this session', async () => {
    seed('rec-fail', true)
    process.env.FAKE_SPEECH_MODE = 'crash'
    // The probe is the helper's `cpu`; only `vad` should fail.
    process.env.FAKE_SPEECH_MATCH = '--format'
    try {
      const out = await analyzeAudio('rec-fail', ['mic'])
      expect(out.mic!.power.length).toBeGreaterThan(100)
      expect(out.mic!.speech).toBeUndefined()
      const dir = path.join(root, 'rec-fail')
      const proc = new ProjectProcesses()
      const st = statSync(path.join(dir, 'mic.m4a'))
      expect(await speechOfFile('rec-fail', 'mic', path.join(dir, 'mic.m4a'), st, proc, Promise.resolve(out.mic!))).toBeNull()
      expect(vadCalls()).toBe(1)
      expect(existsSync(path.join(dir, SPEECH_CACHE_FILE))).toBe(false)
    } finally {
      delete process.env.FAKE_SPEECH_MATCH
    }
  })

  it('a stop rejects and is not cached: the next request runs again', async () => {
    seed('rec-stop', true)
    process.env.FAKE_SPEECH_MODE = 'hang'
    process.env.FAKE_SPEECH_MATCH = '--format'
    try {
      const pending = analyzeAudio('rec-stop', ['mic'])
      await new Promise((r) => setTimeout(r, 400))
      await stopAudioAnalysisFor('rec-stop')
      await expect(pending).rejects.toThrow('The sound measurement was stopped.')
      expect(existsSync(path.join(root, 'rec-stop', SPEECH_CACHE_FILE))).toBe(false)
      delete process.env.FAKE_SPEECH_MODE
      const again = await analyzeAudio('rec-stop', ['mic'])
      expect(again.mic!.speech).toHaveLength(1)
    } finally {
      delete process.env.FAKE_SPEECH_MATCH
    }
  })

  it('without the helper, levels come without speech (the level-based detector is used)', async () => {
    seed('rec-nohelper', true)
    process.env.SSW_SPEECH_HELPER = '/nonexistent/helper'
    try {
      const out = await analyzeAudio('rec-nohelper', ['mic'])
      expect(out.mic!.speech).toBeUndefined()
    } finally {
      process.env.SSW_SPEECH_HELPER = FAKE
    }
  })
})

describe('the persisted .cache/speech.json', () => {
  const probs = (n: number): string => Buffer.alloc(n, 255).toString('base64')
  const entry = (over: Record<string, unknown> = {}) => ({ size: 0, mtimeMs: 0, engine: ENGINE_VERSION, model: VAD_MODEL.sha256, frame: 0.032, audio_s: 6, n: 187, probs: probs(187), ...over })

  it('rangesOfEntry: n and audio_s bounds; a stem 1 s longer than the levels is accepted', () => {
    expect(rangesOfEntry(entry(), 6)).toEqual([{ start: 0, end: 5.984 }])
    expect(rangesOfEntry(entry({ n: 190, probs: probs(190) }), 6)).toBeNull()
    expect(rangesOfEntry(entry(), 3.9)).toBeNull()
    expect(rangesOfEntry(entry({ audio_s: 7, n: 218, probs: probs(218) }), 6)).not.toBeNull()
    expect(rangesOfEntry(entry({ n: 10 }), 6)).toBeNull()
    expect(rangesOfEntry(entry({ frame: 0.02 }), 6)).toBeNull()
    expect(rangesOfEntry(entry({ audio_s: Number.NaN }), 6)).toBeNull()
  })

  it('is reused without running anything, and rejected when stale, too large or out of bounds', async () => {
    const dir = seed('rec-cache', true)
    const mic = path.join(dir, 'mic.m4a')
    const st = statSync(mic)
    const file = path.join(dir, SPEECH_CACHE_FILE)
    mkdirSync(path.dirname(file), { recursive: true })
    const write = (e: unknown): void => writeFileSync(file, JSON.stringify({ version: 1, entries: { mic: e } }))
    const run = () => speechOfFile('rec-cache', 'mic', mic, st, new ProjectProcesses(), Promise.resolve(levelsOf(6)))

    write(entry({ size: st.size, mtimeMs: st.mtimeMs }))
    expect(await run()).toEqual([{ start: 0, end: 5.984 }])
    expect(vadCalls()).toBe(0)

    for (const bad of [
      entry({ size: st.size, mtimeMs: st.mtimeMs + 1 }),
      entry({ size: st.size, mtimeMs: st.mtimeMs, engine: 'ssw-speech/0' }),
      entry({ size: st.size, mtimeMs: st.mtimeMs, n: 500, probs: probs(500) }),
      entry({ size: st.size, mtimeMs: st.mtimeMs, audio_s: 60, n: 1875, probs: probs(1875) })
    ]) {
      write(bad)
      expect(await run()).toEqual(FAKE_RANGES)
    }
    expect(vadCalls()).toBe(4)
    // Too large to read back: run again.
    writeFileSync(file, JSON.stringify({ version: 1, entries: { mic: entry({ size: st.size, mtimeMs: st.mtimeMs }) }, pad: 'x'.repeat(11 << 20) }))
    await run()
    expect(vadCalls()).toBe(5)
  })

  it('concurrent mic and mix runs both land in the file', async () => {
    const dir = seed('rec-both', true)
    const proc = new ProjectProcesses()
    const files = { mic: path.join(dir, 'mic.m4a'), mix: path.join(dir, 'screen.mp4') }
    await Promise.all((['mic', 'mix'] as const).map((s) => speechOfFile('rec-both', s, files[s], statSync(files[s]), proc, Promise.resolve(levelsOf(6)))))
    await speechWritesSettled('rec-both')
    expect(Object.keys(JSON.parse(readFileSync(path.join(dir, SPEECH_CACHE_FILE), 'utf8')).entries).sort()).toEqual(['mic', 'mix'])
  })

  it('a write that lands after a stop is skipped and creates no .cache', async () => {
    const dir = seed('rec-late', true)
    const proc = new ProjectProcesses()
    let release!: (l: AudioLevels) => void
    const levels = new Promise<AudioLevels>((r) => (release = r))
    const mic = path.join(dir, 'mic.m4a')
    const pending = speechOfFile('rec-late', 'mic', mic, statSync(mic), proc, levels)
    // The detector finishes; the project is stopped (being deleted) before the result is written.
    await new Promise((r) => setTimeout(r, 1000))
    expect(vadCalls()).toBe(1)
    await proc.stop('rec-late')
    release(levelsOf(6))
    await pending
    await speechWritesSettled('rec-late')
    expect(existsSync(path.join(dir, '.cache'))).toBe(false)
  })
})

describe('a recording too long for one detector line (about 7 h)', () => {
  it('vadLineFits: up to about 25 160 s of sound', () => {
    expect(vadLineFits(6)).toBe(true)
    expect(vadLineFits(25_000)).toBe(true)
    expect(vadLineFits(25_200)).toBe(false)
    expect(vadLineFits(25_600)).toBe(false)
  })

  it('gets the level detector without running anything when the project says so', async () => {
    const dir = seed('rec-long', true)
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'rec-long', duration: 25_600 }))
    const out = await analyzeAudio('rec-long', ['mic'])
    expect(out.mic!.power.length).toBeGreaterThan(100)
    expect(out.mic!.speech).toBeUndefined()
    expect(vadCalls()).toBe(0)
  })

  it('stops a run as soon as the levels show the length, and does not run it again this session', async () => {
    const dir = seed('rec-long-levels', true)
    // The helper would only refuse after reading everything: here it never ends on its own.
    process.env.FAKE_SPEECH_MODE = 'hang'
    process.env.FAKE_SPEECH_MATCH = '--format'
    try {
      const mic = path.join(dir, 'mic.m4a')
      const st = statSync(mic)
      const started = Date.now()
      expect(await speechOfFile('rec-long-levels', 'mic', mic, st, new ProjectProcesses(), Promise.resolve(levelsOf(25_600)))).toBeNull()
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(vadCalls()).toBe(1)
      expect(await speechOfFile('rec-long-levels', 'mic', mic, st, new ProjectProcesses(), Promise.resolve(levelsOf(25_600)))).toBeNull()
      expect(vadCalls()).toBe(1)
      expect(existsSync(path.join(dir, SPEECH_CACHE_FILE))).toBe(false)
    } finally {
      delete process.env.FAKE_SPEECH_MATCH
    }
  }, 20_000)
})

describe('an illegal instruction in vad', () => {
  it('switches to the compatible build for the session and keeps the detector on', async () => {
    const standard = path.join(h.root, 'standard.cjs')
    writeFileSync(standard, "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGILL')\n")
    chmodSync(standard, 0o755)
    let switched = false
    const choose = async (): Promise<HelperChoice> => (switched ? { exe: FAKE, build: 'compatible' } : { exe: standard, build: 'standard' })
    const helperModule = await import('../src/main/speech/helper')
    const spy = vi.spyOn(helperModule, 'markIllegalInstruction')
    resetSpeechDetector(async () => {
      if (spy.mock.calls.length > 0) switched = true
      return choose()
    })
    const dir = seed('rec-sigill', true)
    const mic = path.join(dir, 'mic.m4a')
    const ranges = await speechOfFile('rec-sigill', 'mic', mic, statSync(mic), new ProjectProcesses(), Promise.resolve(levelsOf(6)))
    expect(ranges).toEqual(FAKE_RANGES)
    expect(switched).toBe(true)
    spy.mockRestore()
  })
})
