/**
 * Clean voice in the main process (docs/design/clean-voice.md §4.3): makes the cleaned stem of a
 * project's microphone (or mixed track) once per source file and strength, with ffmpeg's arnndn
 * and the bundled RNNoise models, and keeps it in the project folder as voice-<key>.m4a.
 *
 * One render per project: a request for the same stem joins the running one, a request for
 * another stops it first. Renders report their progress, can be cancelled (the part file goes),
 * stop after a time proportional to the sound's length, and stop with the project's other work
 * (the editor closed, the project about to be deleted) and at quit.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VOICE_CANCELLED, type VoiceProgress, type VoiceStemStatus } from '../../shared/api/voice'
import { SOURCE_FILES } from '../../shared/audio/settings'
import {
  isVoiceStrength,
  staleVoiceFiles,
  VOICE_ENGINE,
  VOICE_FILE_RE,
  VOICE_MODEL_IDS,
  VOICE_PART_RE,
  VOICE_RATE,
  VOICE_SOURCES,
  voiceFileName,
  voiceGraph,
  voiceKeyInput,
  voicePartName,
  type VoiceModelId,
  type VoiceSource
} from '../../shared/audio/voiceClean'
import { VOICE_COPY } from '../../shared/audio/voiceCopy'
import type { VoiceStrength } from '../../shared/types'
import { describeFfmpegError } from '../ffmpeg'

/** Seconds a render may take: this much, plus RENDER_PER_SECOND for each second of sound. */
const RENDER_BASE = 60
const RENDER_PER_SECOND = 2
/** Until ffmpeg has said how long the sound is. */
const RENDER_UNKNOWN = 2 * 3600
/** Progress events per render, at most one in this many ms. */
const PROGRESS_EVERY_MS = 250

/** ffmpeg arguments that clean `input`'s first audio stream into `output` (run with the model's folder as the working folder). */
export function voiceCleanArgs(input: string, output: string, strength: VoiceStrength): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-y',
    '-i', input,
    '-filter_complex', voiceGraph(strength),
    '-map', '[voice]',
    // As mic.m4a is kept (proxyArgs stemArgs).
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', String(VOICE_RATE),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    output
  ]
}

/** The 16 hex digits naming the stem of `source` (its file as `stat` says) at `strength`. */
export function voiceKey(source: VoiceSource, strength: VoiceStrength, stat: { size: number; mtimeMs: number }): string {
  return createHash('sha256').update(voiceKeyInput(source, strength, stat)).digest('hex').slice(0, 16)
}

/** Seconds of the input from ffmpeg's log ("Duration: 00:01:02.50"), or null. */
export function parseDuration(log: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(log)
  if (!m) return null
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(s) && s > 0 ? s : null
}

/** The last output time (seconds) in a chunk of ffmpeg's -progress output, or null. */
export function parseProgress(chunk: string): number | null {
  let out: number | null = null
  for (const m of chunk.matchAll(/^out_time_us=(\d+)\s*$/gm)) out = Number(m[1]) / 1e6
  return out
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/**
 * Makes sure `dir` holds every model exactly as bundled (`texts`, each checked against its pin
 * first). A missing, damaged or replaced file is written again (atomically).
 */
export async function ensureVoiceModels(dir: string, texts: Record<VoiceModelId, string>): Promise<void> {
  for (const id of VOICE_MODEL_IDS) {
    const pin = VOICE_ENGINE.models[id]
    const text = texts[id]
    if (typeof text !== 'string' || sha256(text) !== pin.sha256) throw new Error(VOICE_COPY.damagedModel)
    const file = path.join(dir, pin.file)
    const current = await fs.readFile(file).catch(() => null)
    if (current && current.length === pin.bytes && sha256(current) === pin.sha256) continue
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
  }
}

export interface VoiceCleanerDeps {
  /** A project's folder (throws for an invalid id). */
  projectDir(id: string): string
  /** The folder the model is kept in (ffmpeg's working folder). */
  modelDir(): string
  /** The models as bundled. */
  modelTexts: Record<VoiceModelId, string>
  ffmpeg(): string
  onProgress?(p: VoiceProgress): void
}

interface Job {
  key: string
  source: VoiceSource
  strength: VoiceStrength
  progress: number
  promise: Promise<string>
  proc: ChildProcess | null
  cancelled: boolean
  /** Resolves once the job's ffmpeg has exited and its part file is gone. */
  settled: Promise<void>
}

/** Request arguments as the IPC receives them, checked. */
function checked(source: unknown, strength: unknown): { source: VoiceSource; strength: VoiceStrength } {
  if (!(VOICE_SOURCES as readonly unknown[]).includes(source) || !isVoiceStrength(strength)) throw new Error('Invalid request.')
  return { source: source as VoiceSource, strength }
}

const exists = (file: string): Promise<boolean> =>
  fs.stat(file).then(
    (s) => s.isFile(),
    () => false
  )

export class VoiceCleaner {
  private readonly jobs = new Map<string, Job>()

  constructor(private readonly deps: VoiceCleanerDeps) {}

  /** The project folder and the stem's file name for these arguments (the source must exist). */
  private async locate(id: unknown, source: VoiceSource, strength: VoiceStrength): Promise<{ id: string; dir: string; input: string; key: string } | null> {
    if (typeof id !== 'string') throw new Error('Invalid request.')
    const dir = this.deps.projectDir(id)
    const input = path.join(dir, SOURCE_FILES[source])
    const stat = await fs.stat(input).catch(() => null)
    if (!stat?.isFile()) return null
    return { id, dir, input, key: voiceKey(source, strength, stat) }
  }

  async status(id: unknown, source: unknown, strength: unknown): Promise<VoiceStemStatus> {
    const args = checked(source, strength)
    const at = await this.locate(id, args.source, args.strength)
    if (!at) return { state: 'missing' }
    const job = this.jobs.get(at.id)
    if (job && job.key === at.key && !job.cancelled) return { state: 'working', progress: job.progress }
    const file = voiceFileName(at.key)
    return (await exists(path.join(at.dir, file))) ? { state: 'ready', file } : { state: 'missing' }
  }

  /** The cleaned stem's file name in the project folder, made first when it is not there. */
  async ensure(id: unknown, source: unknown, strength: unknown): Promise<string> {
    const args = checked(source, strength)
    const at = await this.locate(id, args.source, args.strength)
    if (!at) throw new Error(args.source === 'mic' ? VOICE_COPY.missingMic : VOICE_COPY.missingMix)
    const running = this.jobs.get(at.id)
    if (running && running.key === at.key && !running.cancelled) return running.promise
    if (running) await this.cancel(at.id)
    const file = voiceFileName(at.key)
    const final = path.join(at.dir, file)
    if (await exists(final)) {
      // Used again: the newest, so pruning keeps it.
      const now = new Date()
      await fs.utimes(final, now, now).catch(() => undefined)
      return file
    }
    // Another request may have started this render while the folder was being looked at.
    const again = this.jobs.get(at.id)
    if (again && again.key === at.key && !again.cancelled) return again.promise
    if (again) await this.cancel(at.id)
    return this.start(at.id, at.dir, at.input, at.key, args.source, args.strength)
  }

  private start(id: string, dir: string, input: string, key: string, source: VoiceSource, strength: VoiceStrength): Promise<string> {
    let settle: () => void = () => undefined
    const job: Job = {
      key,
      source,
      strength,
      progress: 0,
      proc: null,
      cancelled: false,
      settled: new Promise<void>((r) => (settle = r)),
      promise: Promise.resolve('')
    }
    job.promise = this.render(job, id, dir, input).finally(() => {
      if (this.jobs.get(id) === job) this.jobs.delete(id)
      settle()
    })
    // A caller that stopped waiting must not leave an unhandled rejection behind.
    job.promise.catch(() => undefined)
    this.jobs.set(id, job)
    return job.promise
  }

  private async render(job: Job, id: string, dir: string, input: string): Promise<string> {
    const file = voiceFileName(job.key)
    const part = path.join(dir, voicePartName(job.key))
    const send = throttle((progress: number) => this.deps.onProgress?.({ projectId: id, source: job.source, strength: job.strength, progress }), PROGRESS_EVERY_MS)
    send(0)
    const modelDir = this.deps.modelDir()
    await ensureVoiceModels(modelDir, this.deps.modelTexts)
    await removeParts(dir)
    if (job.cancelled) throw new Error(VOICE_CANCELLED)
    try {
      await this.run(job, input, part, modelDir, (p) => {
        job.progress = p
        send(p)
      })
      if (job.cancelled) throw new Error(VOICE_CANCELLED)
      await fs.rename(part, path.join(dir, file))
    } catch (err) {
      await fs.rm(part, { force: true }).catch(() => undefined)
      throw err
    }
    job.progress = 1
    send.flush(1)
    await prune(dir, file)
    return file
  }

  private run(job: Job, input: string, output: string, cwd: string, progress: (p: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess
      try {
        proc = spawn(this.deps.ffmpeg(), voiceCleanArgs(input, output, job.strength), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        reject(new Error(`${VOICE_COPY.engine} (${err instanceof Error ? err.message : String(err)})`))
        return
      }
      job.proc = proc
      let duration: number | null = null
      let log = ''
      let timedOut = false
      let timer = setTimeout(() => kill(), RENDER_UNKNOWN * 1000)
      const kill = (): void => {
        timedOut = true
        proc.kill('SIGKILL')
      }
      proc.stderr!.on('data', (d: Buffer) => {
        log = (log + d.toString()).slice(-8000)
        if (duration === null) {
          duration = parseDuration(log)
          if (duration !== null) {
            clearTimeout(timer)
            timer = setTimeout(kill, (RENDER_BASE + RENDER_PER_SECOND * duration) * 1000)
          }
        }
      })
      let tail = ''
      proc.stdout!.on('data', (d: Buffer) => {
        const text = tail + d.toString()
        const cut = text.lastIndexOf('\n')
        tail = text.slice(cut + 1)
        const t = parseProgress(text.slice(0, cut + 1))
        if (t !== null && duration) progress(Math.min(0.99, Math.max(0, t / duration)))
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`${VOICE_COPY.engine} (${err.message})`))
      })
      proc.on('close', (code, signal) => {
        clearTimeout(timer)
        job.proc = null
        if (job.cancelled) return reject(new Error(VOICE_CANCELLED))
        if (code === 0) return resolve()
        if (timedOut) return reject(new Error(VOICE_COPY.tooLong))
        const last = log.trim().split('\n').pop() ?? ''
        console.warn(`Clean voice failed (${signal ?? `exit code ${code}`}): ${last.slice(0, 300)}`)
        reject(new Error(describeFfmpegError(log, VOICE_COPY.engine)))
      })
    })
  }

  /** Stops project `id`'s render, if any; resolves once ffmpeg has exited and the part file is gone. */
  async cancel(id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('Invalid request.')
    const job = this.jobs.get(id)
    if (!job) return
    job.cancelled = true
    job.proc?.kill('SIGKILL')
    await job.settled
  }

  /** Kills every render (the app is quitting). */
  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.cancelled = true
      job.proc?.kill('SIGKILL')
    }
  }
}

/** Removes part files a stopped render left in `dir`. */
async function removeParts(dir: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(names.filter((n) => VOICE_PART_RE.test(n)).map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => undefined)))
}

/** Deletes the cleaned files of `dir` beyond the newest few (staleVoiceFiles); one still open (Windows) stays for the next time. */
async function prune(dir: string, current: string): Promise<void> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => VOICE_FILE_RE.test(n))
  const files = await Promise.all(names.map(async (name) => ({ name, mtimeMs: (await fs.stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })))
  for (const name of staleVoiceFiles(files, current)) await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)
}

/** `fn` at most once per `ms` (the latest value wins); `flush` sends a value at once. */
function throttle(fn: (v: number) => void, ms: number): ((v: number) => void) & { flush(v: number): void } {
  let last = 0
  const call = (v: number): void => {
    const now = Date.now()
    if (now - last < ms) return
    last = now
    fn(v)
  }
  return Object.assign(call, { flush: (v: number) => fn(v) })
}
