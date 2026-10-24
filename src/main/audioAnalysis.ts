/**
 * Sound levels of a project's recorded sources (the screen proxy's track, mic.m4a,
 * system.m4a): ffmpeg decodes the audio at a low rate and the level meter of
 * shared/audio/loudness measures it as it streams in, so an hour-long recording costs a few
 * seconds and constant memory. The renderer turns the levels into ducking ranges and the
 * preview's loudness gain.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LevelMeter, type AudioLevels } from '../shared/audio/loudness'
import { SOURCE_FILES, type AudioSource } from '../shared/audio/settings'
import { ffmpegPath } from './ffmpeg'
import * as projects from './projects'

/** Decoding rate and layout: plenty for speech and loudness, cheap to measure. */
const RATE = 16000
const CHANNELS = 2
const SOURCES: readonly AudioSource[] = ['mix', 'mic', 'system']
/** Results kept for files measured earlier (keyed by path, size and modification time). */
const CACHE_SIZE = 12

const cache = new Map<string, Promise<AudioLevels>>()
const running = new Set<ChildProcess>()

/** ffmpeg arguments that decode the first audio stream of `file` to raw float samples on stdout. */
export function levelArgs(file: string): string[] {
  return ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0?', '-vn', '-ac', String(CHANNELS), '-ar', String(RATE), '-f', 'f32le', 'pipe:1']
}

/** Levels of one file; an empty envelope when it has no audio stream. */
export function measureLevels(file: string): Promise<AudioLevels> {
  return new Promise((resolve, reject) => {
    const meter = new LevelMeter(RATE, CHANNELS)
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath(), levelArgs(file), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    running.add(proc)
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
    proc.on('close', (code) => {
      running.delete(proc)
      if (code === 0) resolve(meter.finish())
      else reject(new Error(`Could not read the sound of ${path.basename(file)} (${log.trim().split('\n').pop() || `exit code ${code}`})`))
    })
  })
}

function cachedLevels(file: string, stat: { size: number; mtimeMs: number }): Promise<AudioLevels> {
  const key = `${file}|${stat.size}|${stat.mtimeMs}`
  let levels = cache.get(key)
  if (!levels) {
    levels = measureLevels(file)
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
  // One at a time: decoding is light, but exports and the preview share the CPU.
  for (const source of wanted) {
    const file = path.join(dir, SOURCE_FILES[source])
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) continue
    out[source] = await cachedLevels(file, stat)
  }
  return out
}

/** Stops measurements in progress (the app is quitting). */
export function stopAudioAnalysis(): void {
  for (const proc of running) proc.kill('SIGKILL')
  running.clear()
}
