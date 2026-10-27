/**
 * Sound levels of a project's recorded sources (the screen proxy's track, mic.m4a,
 * system.m4a): ffmpeg decodes the audio at a low rate and the level meter of
 * shared/audio/loudness measures it as it streams in, so an hour-long recording costs a few
 * seconds and constant memory. The renderer turns the levels into ducking ranges and the
 * preview's loudness gain. The microphone stem (or the mixed track of a recording without one)
 * also gets the speech detector's ranges (speech/vad.ts). A project's measurements stop when its editor closes or before it
 * is deleted (see ProjectProcesses).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LevelMeter, type AudioLevels } from '../shared/audio/loudness'
import { SOURCE_FILES, type AudioSource } from '../shared/audio/settings'
import { ffmpegPath } from './ffmpeg'
import { ProjectProcesses } from './projectProcesses'
import * as projects from './projects'
import { speechOfFile } from './speech/vad'

/** Decoding rate and layout: plenty for speech and loudness, cheap to measure. */
const RATE = 16000
const CHANNELS = 2
const SOURCES: readonly AudioSource[] = ['mix', 'mic', 'system']
/** Results kept for files measured earlier (keyed by path, size and modification time). */
const CACHE_SIZE = 12

const cache = new Map<string, Promise<AudioLevels>>()
const running = new ProjectProcesses()

/** ffmpeg arguments that decode the first audio stream of `file` to raw float samples on stdout. */
export function levelArgs(file: string): string[] {
  return ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0?', '-vn', '-ac', String(CHANNELS), '-ar', String(RATE), '-f', 'f32le', 'pipe:1']
}

/** Levels of one file (of project `owner`); an empty envelope when it has no audio stream. */
export function measureLevels(file: string, owner = ''): Promise<AudioLevels> {
  return new Promise((resolve, reject) => {
    const meter = new LevelMeter(RATE, CHANNELS)
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath(), levelArgs(file), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    running.add(proc, owner)
    // Chunks end anywhere; carry the bytes of an incomplete sample over to the next one.
    let carry = Buffer.alloc(0)
    proc.stdout?.on('data', (d: Buffer) => {
      const buf = carry.length > 0 ? Buffer.concat([carry, d]) : d
      const whole = buf.length - (buf.length % 4)
      if (whole > 0) {
        // Copied so the floats are aligned whatever offset Node's buffer pool gave the chunk.
        const bytes = new Uint8Array(buf.subarray(0, whole))
        meter.push(new Float32Array(bytes.buffer, 0, whole / 4))
      }
      carry = Buffer.from(buf.subarray(whole))
    })
    let log = ''
    proc.stderr?.on('data', (d: Buffer) => {
      log = (log + d.toString()).slice(-2000)
    })
    proc.on('error', (err) => {
      running.delete(proc)
      reject(err)
    })
    proc.on('close', (code, signal) => {
      running.delete(proc)
      if (code === 0) resolve(meter.finish())
      else if (signal) reject(new Error('The sound measurement was stopped.'))
      else reject(new Error(`Could not read the sound of ${path.basename(file)} (${log.trim().split('\n').pop() || `exit code ${code}`})`))
    })
  })
}

/**
 * Levels of `file`, with the speech detector's ranges when `speech` names its source: both run
 * at once, and the result settles only once the detector has succeeded or definitively failed
 * (then without `speech`), so every reader sees one settled object. A stop rejects.
 */
export async function levelsWithSpeech(id: string, file: string, stat: { size: number; mtimeMs: number }, speech: 'mic' | 'mix' | null): Promise<AudioLevels> {
  const levels = measureLevels(file, id)
  if (!speech) return levels
  levels.catch(() => undefined)
  const ranges = speechOfFile(id, speech, file, stat, running, levels)
  const [l, s] = await Promise.all([levels, ranges])
  return s ? { ...l, speech: s } : l
}

function cachedLevels(id: string, file: string, stat: { size: number; mtimeMs: number }, speech: 'mic' | 'mix' | null): Promise<AudioLevels> {
  const key = `${file}|${stat.size}|${stat.mtimeMs}|${speech ?? ''}`
  let levels = cache.get(key)
  if (!levels) {
    levels = levelsWithSpeech(id, file, stat, speech)
    cache.set(key, levels)
    // A failure is not remembered: the next request tries again.
    levels.catch(() => cache.delete(key))
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  }
  return levels
}

/** Levels of the requested sources of project `id` that exist (unknown names are ignored). */
export async function analyzeAudio(id: string, sources: unknown): Promise<Partial<Record<AudioSource, AudioLevels>>> {
  const dir = projects.projectDir(id)
  const wanted = Array.isArray(sources) ? [...new Set(sources.filter((s): s is AudioSource => SOURCES.includes(s as AudioSource)))] : []
  const out: Partial<Record<AudioSource, AudioLevels>> = {}
  const generation = running.generation(id)
  // The speech detector runs on the voice: the microphone stem, or the mixed track of a recording without one.
  const hasMic = (await fs.stat(path.join(dir, SOURCE_FILES.mic)).catch(() => null))?.isFile() === true
  // One at a time: decoding is light, but exports and the preview share the CPU.
  for (const source of wanted) {
    const file = path.join(dir, SOURCE_FILES[source])
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) continue
    // Stopped meanwhile (the editor closed, the project is being deleted): nothing more is read.
    if (running.generation(id) !== generation) throw new Error('The sound measurement was stopped.')
    const speech = source === 'mic' ? 'mic' : source === 'mix' && !hasMic ? 'mix' : null
    out[source] = await cachedLevels(id, file, stat, speech)
  }
  return out
}

/** Stops project `id`'s measurements; resolves once ffmpeg has let go of its files. */
export const stopAudioAnalysisFor = (id: string): Promise<void> => running.stop(id)

/** Stops measurements in progress (the app is quitting). */
export function stopAudioAnalysis(): void {
  running.stopAll()
}
