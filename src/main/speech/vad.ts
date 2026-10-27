/**
 * The speech detector on a project's sound (docs/design/offline-captions.md §3.5): ffmpeg
 * decodes the source to 16 kHz mono float samples into `ssw-speech vad`, which returns a
 * probability per 32 ms frame; shared/audio/vad.ts turns them into ranges. Results are kept in
 * the project's .cache/speech.json (keyed by the file's size and time, the engine and the model),
 * so the editor opens without running it again. Workstream B's own module.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SpeechDetectorInfo } from '../../shared/api/speech'
import type { Range } from '../../shared/audio/activity'
import type { AudioLevels } from '../../shared/audio/loudness'
import { decodeProbs, speechFromProbs, VAD } from '../../shared/audio/vad'
import { ENGINE_VERSION, VAD_MODEL, VAD_THREADS } from '../../shared/speech/catalog'
import type { SidecarVad } from '../../shared/speech/protocol'
import { writeFileAtomicSync } from '../atomicWrite'
import { ffmpegPath } from '../ffmpeg'
import type { ProjectProcesses } from '../projectProcesses'
import { commonArgs, markIllegalInstruction, runHelper, selectHelper, speechHelperPaths, SPEECH_TIMING, type HelperChoice } from './helper'
import { sha256File } from './models'

/** The project's file of detector results. */
export const SPEECH_CACHE_FILE = path.join('.cache', 'speech.json')
/** Largest speech.json read back. */
const CACHE_MAX = 10 << 20
/** How far the detector's audio length may be from the level envelope's, seconds. */
const LENGTH_SLACK = 2
/** Before the length is known: a limit for the longest recording (4 h). */
const UNKNOWN_SECONDS = 4 * 3600

export interface SpeechCacheEntry {
  size: number
  mtimeMs: number
  engine: string
  model: string
  frame: number
  audio_s: number
  n: number
  probs: string
}

/** The detector's state for this session (Settings' line). */
let detector: { available: boolean; reason?: string } | null = null
let modelCheck: Promise<boolean> | null = null

/** Test hooks: forget the session's checks; replace how the helper is chosen. */
let chooseHelper: () => Promise<HelperChoice> = selectHelper
export function resetSpeechDetector(choose: () => Promise<HelperChoice> = selectHelper): void {
  detector = null
  modelCheck = null
  failedFiles.clear()
  chooseHelper = choose
}

/** Whether the detector can run: the helper runs here and the bundled model matches its pin (checked once per session). */
async function ready(): Promise<{ exe: string; vadModel: string } | null> {
  const paths = speechHelperPaths()
  if (!paths) {
    detector = { available: false, reason: 'the speech helper is not part of this build' }
    return null
  }
  modelCheck ??= (async () => {
    const stat = await fs.stat(paths.vadModel).catch(() => null)
    return !!stat?.isFile() && stat.size === VAD_MODEL.bytes && (await sha256File(paths.vadModel).catch(() => '')) === VAD_MODEL.sha256
  })()
  if (!(await modelCheck)) {
    detector = { available: false, reason: 'its model is missing or damaged' }
    return null
  }
  const choice = await chooseHelper()
  if ('error' in choice) {
    detector = { available: false, reason: choice.detail || 'the speech engine did not start' }
    return null
  }
  if (!detector) detector = { available: true }
  return { exe: choice.exe, vadModel: paths.vadModel }
}

/** For SpeechState: whether the detector can run, and why not. */
export async function detectorInfo(): Promise<SpeechDetectorInfo> {
  if (!detector) await ready().catch(() => null)
  return detector ?? { available: false, reason: 'the speech engine did not start' }
}

/** ffmpeg arguments decoding `file`'s first audio stream to 16 kHz mono float samples on stdout. */
export function vadDecodeArgs(file: string): string[] {
  return ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Ranges from a stored or fresh result, checked as untrusted input; null when out of bounds. */
export function rangesOfEntry(e: Pick<SpeechCacheEntry, 'audio_s' | 'n' | 'probs' | 'frame'>, levelsSeconds: number | null): Range[] | null {
  if (!finite(e.audio_s) || e.audio_s < 0 || !finite(e.n) || !Number.isInteger(e.n) || e.n < 0 || e.frame !== VAD.frame) return null
  if (e.n > e.audio_s / VAD.frame + 2) return null
  if (levelsSeconds !== null && Math.abs(e.audio_s - levelsSeconds) > LENGTH_SLACK) return null
  const probs = decodeProbs(e.probs, e.n)
  if (!probs || probs.length !== e.n) return null
  return speechFromProbs(probs).map((r) => ({ start: r.start, end: Math.min(r.end, e.audio_s) })).filter((r) => r.end > r.start)
}

/** The stored entry of `source`, if it matches the file, the engine and the model. */
async function readEntry(dir: string, source: 'mic' | 'mix', stat: { size: number; mtimeMs: number }): Promise<SpeechCacheEntry | null> {
  const file = path.join(dir, SPEECH_CACHE_FILE)
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile() || st.size > CACHE_MAX) return null
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!isObject(raw) || raw.version !== 1 || !isObject(raw.entries)) return null
    const e = raw.entries[source]
    if (!isObject(e) || e.size !== stat.size || e.mtimeMs !== stat.mtimeMs || e.engine !== ENGINE_VERSION || e.model !== VAD_MODEL.sha256 || typeof e.probs !== 'string') return null
    return e as unknown as SpeechCacheEntry
  } catch {
    return null
  }
}

/** Per project: writes of .cache/speech.json one after another (mic and mix are read-modify-write). */
const writes = new Map<string, Promise<void>>()

/** Stores `entry` for `source`, unless the project's work was stopped since `generation` (no .cache in a folder being deleted). */
function writeEntry(projectId: string, dir: string, source: 'mic' | 'mix', entry: SpeechCacheEntry, processes: ProjectProcesses, generation: number): Promise<void> {
  const prev = writes.get(projectId) ?? Promise.resolve()
  const next = prev.then(async () => {
    if (processes.generation(projectId) !== generation) return
    const file = path.join(dir, SPEECH_CACHE_FILE)
    let entries: Record<string, unknown> = {}
    try {
      const st = await fs.stat(file)
      if (st.size <= CACHE_MAX) {
        const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
        if (isObject(raw) && raw.version === 1 && isObject(raw.entries)) entries = raw.entries
      }
    } catch {
      // A new or unreadable file starts empty.
    }
    if (processes.generation(projectId) !== generation) return
    await fs.mkdir(path.dirname(file), { recursive: true })
    writeFileAtomicSync(file, JSON.stringify({ version: 1, entries: { ...entries, [source]: entry } }))
  })
  const settled = next.catch((err) => console.warn(`Could not keep the speech detector's result: ${err instanceof Error ? err.message : String(err)}`))
  writes.set(projectId, settled)
  void settled.then(() => {
    if (writes.get(projectId) === settled) writes.delete(projectId)
  })
  return settled
}

/** Resolves once every queued write of `projectId` is done (tests). */
export const speechWritesSettled = (projectId: string): Promise<void> => writes.get(projectId) ?? Promise.resolve()

const STOPPED = 'The sound measurement was stopped.'
/** Files the detector definitively failed on this session (the next start tries again). */
const failedFiles = new Set<string>()

/** One run of ffmpeg into the helper: the vad line, or the exit. */
async function detect(exe: string, vadModel: string, file: string, projectId: string, processes: ProjectProcesses, levels: Promise<AudioLevels>): Promise<{ vad: SidecarVad } | { stopped: true } | { illegal: true } | { failed: string }> {
  const controller = new AbortController()
  let ffmpeg: ChildProcess
  try {
    ffmpeg = spawn(ffmpegPath(), vadDecodeArgs(file), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { failed: `ffmpeg could not be started (${err instanceof Error ? err.message : String(err)})` }
  }
  processes.add(ffmpeg, projectId)
  ffmpeg.on('error', () => undefined)
  ffmpeg.stderr?.resume()
  const ffmpegClosed = new Promise<void>((r) => ffmpeg.on('close', () => r()))
  const run = runHelper(exe, ['vad', '--audio', '-', '--format', 'f32le', '--vad-model', vadModel, '--threads', String(VAD_THREADS), ...commonArgs()], {
    cwd: os.tmpdir(),
    stdin: ffmpeg.stdout!,
    signal: controller.signal,
    timeoutMs: SPEECH_TIMING.vadBaseMs + SPEECH_TIMING.vadPerSecondMs * UNKNOWN_SECONDS,
    // `vad` prints one line, at the end: only its overall limit applies, not the transcription's stall rule.
    stallMs: SPEECH_TIMING.vadBaseMs + SPEECH_TIMING.vadPerSecondMs * UNKNOWN_SECONDS,
    processes,
    owner: projectId
  })
  // Once the length is known, the limit is 30 s + 50 ms per second of audio.
  levels.then(
    (l) => run.limit(SPEECH_TIMING.vadBaseMs + SPEECH_TIMING.vadPerSecondMs * l.power.length * l.window),
    () => undefined
  )
  let vad: SidecarVad | null = null
  for await (const e of run.events) if (e.type === 'vad') vad = e
  const exit = await run.done
  if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill('SIGKILL')
  await ffmpegClosed
  processes.delete(ffmpeg)
  if (exit.kind === 'cancelled') return { stopped: true }
  if ((exit.kind === 'crash' && exit.illegalInstruction) || (exit.kind === 'error' && exit.code === 'cpu')) return { illegal: true }
  if (exit.kind === 'ok' && vad) return { vad }
  const why = exit.kind === 'ok' ? 'no result' : exit.kind === 'error' ? `${exit.code}: ${exit.message}` : exit.kind === 'crash' || exit.kind === 'protocol' ? exit.detail : exit.kind
  return { failed: `${why}${run.stderr().trim() ? ` (${run.stderr().trim().split('\n').pop()})` : ''}` }
}

/**
 * Speech ranges of `file` (source `source` of project `projectId`), or null when the detector
 * cannot run or failed (the level-based detector is used then). Rejects only when stopped (the
 * editor closed), like the level measurement. `levels` is the same file's level measurement,
 * running alongside: the detector's audio length must agree with it.
 */
export async function speechOfFile(projectId: string, source: 'mic' | 'mix', file: string, stat: { size: number; mtimeMs: number }, processes: ProjectProcesses, levels: Promise<AudioLevels>): Promise<Range[] | null> {
  const generation = processes.generation(projectId)
  const dir = path.dirname(file)
  const seconds = async (): Promise<number> => {
    const l = await levels
    return l.power.length * l.window
  }
  const stored = await readEntry(dir, source, stat)
  if (stored) {
    const ranges = rangesOfEntry(stored, await seconds())
    if (ranges) return ranges
  }
  const key = `${file}|${stat.size}|${stat.mtimeMs}`
  if (failedFiles.has(key)) return null
  const helper = await ready().catch((err) => {
    detector = { available: false, reason: 'the speech engine did not start' }
    console.warn(`Speech detector unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  if (!helper) return null
  if (processes.generation(projectId) !== generation) throw new Error(STOPPED)
  let r = await detect(helper.exe, helper.vadModel, file, projectId, processes, levels)
  if ('illegal' in r) {
    // The standard build faulted: the compatible one for the session, and the detector stays on.
    markIllegalInstruction()
    const again = await ready().catch(() => null)
    if (!again || again.exe === helper.exe) {
      console.warn('Speech detector: the speech helper cannot run on this processor; sound levels are used.')
      detector = { available: false, reason: "this PC's processor cannot run the speech engine" }
      return null
    }
    r = await detect(again.exe, again.vadModel, file, projectId, processes, levels)
  }
  if ('stopped' in r || processes.generation(projectId) !== generation) throw new Error(STOPPED)
  if ('illegal' in r || 'failed' in r) {
    console.warn(`Speech detector failed on ${path.basename(file)}; sound levels are used. ${'failed' in r ? r.failed : 'illegal instruction'}`)
    failedFiles.add(key)
    return null
  }
  const entry: SpeechCacheEntry = { size: stat.size, mtimeMs: stat.mtimeMs, engine: ENGINE_VERSION, model: VAD_MODEL.sha256, frame: r.vad.frame, audio_s: r.vad.audio_s, n: r.vad.n, probs: r.vad.probs }
  const ranges = rangesOfEntry(entry, await seconds())
  if (!ranges) {
    console.warn(`Speech detector returned an unusable result for ${path.basename(file)}; sound levels are used.`)
    failedFiles.add(key)
    return null
  }
  await writeEntry(projectId, dir, source, entry, processes, generation)
  return ranges
}
