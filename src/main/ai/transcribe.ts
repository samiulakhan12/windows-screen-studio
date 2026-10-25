/**
 * Transcription of a project's sound with the user's AI provider.
 *
 * 1. The sound is picked (TranscribeOptions.source: 'auto' takes the microphone stem mic.m4a
 *    when the recording kept one, so music and system sounds do not get in the way, else the
 *    mixed sound of screen.mp4; stems are aligned with the video by the recorder) and decoded
 *    once by ffmpeg to 16 kHz mono PCM in a temporary folder, on the video's clock (a stream
 *    that starts late is padded, so times stay source seconds).
 * 2. A recording longer than the provider takes in one request is split (transcriptPlan): its
 *    levels are measured as for ducking (shared/audio/loudness + activity) and parts are cut in
 *    quiet stretches, else at fixed points with a short overlap.
 * 3. Each part is encoded as 32 kbit/s MP3 (16 kHz mono: a 25 MB request holds well over an
 *    hour) and transcribed; the results are shifted to source seconds and merged
 *    (transcriptMerge). The editor maps them through cuts.
 *
 * Progress is sent per phase and part. One job runs per project; cancelling it (or closing its
 * editor, or deleting the project: see stopAnalyses) aborts the requests, kills ffmpeg and
 * removes the temporary files before it resolves.
 */
import { spawn } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AI_PROVIDER_KINDS, type TranscribeOptions, type TranscribeProgress } from '../../shared/api/ai'
import { detectActivity } from '../../shared/audio/activity'
import { LevelMeter } from '../../shared/audio/loudness'
import { mergeParts } from '../../shared/captions/transcriptMerge'
import type { RawTranscript } from '../../shared/captions/transcriptParse'
import { planParts, secondsForBytes, silencesBetween, type TranscriptPart } from '../../shared/captions/transcriptPlan'
import type { Transcript } from '../../shared/types'
import { describeFfmpegError, ffmpegPath } from '../ffmpeg'
import { ProjectProcesses } from '../projectProcesses'
import { projectDir, readProject } from '../projects'
import { testLimit } from './endpoints'
import type { AiProviderStore } from './keyStore'
import { clientFor } from './providers'
import type { AiClient } from './types'
import { cancelled } from './request'

const RATE = 16000
/** Bytes per second of the decoded sound (16-bit mono). */
const PCM_RATE = RATE * 2
const MP3_BITRATE = 32000
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/
const SOURCES = ['auto', 'mic', 'mixed'] as const

interface Job {
  controller: AbortController
  done: Promise<unknown>
}

const jobs = new Map<string, Job>()
const processes = new ProjectProcesses()

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** TranscribeOptions from the renderer, checked; throws a message to show. */
export function validateTranscribeOptions(raw: unknown): Required<Pick<TranscribeOptions, 'providerId' | 'source'>> & Pick<TranscribeOptions, 'language'> {
  if (!isObject(raw) || typeof raw.providerId !== 'string' || raw.providerId.length > 64) throw new Error('Choose an AI provider for the transcription.')
  const source = raw.source === undefined ? 'auto' : raw.source
  if (!SOURCES.includes(source as (typeof SOURCES)[number])) throw new Error('Invalid sound source.')
  let language: string | undefined
  if (raw.language !== undefined && raw.language !== null && raw.language !== '') {
    if (typeof raw.language !== 'string' || !LANGUAGE_RE.test(raw.language.trim())) throw new Error('The language must be a code such as "en" or "pt-BR".')
    language = raw.language.trim()
  }
  return { providerId: raw.providerId, source: source as TranscribeOptions['source'] & string, ...(language ? { language } : {}) }
}

/** Runs ffmpeg for project `id`; rejects as cancelled when `signal` aborts (ffmpeg is killed). */
function runFfmpeg(args: string[], id: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled())
    const proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    processes.add(proc, id)
    let log = ''
    proc.stderr!.on('data', (d: Buffer) => {
      log = (log + d.toString()).slice(-3000)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    const onAbort = (): void => {
      proc.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const done = (err: Error | null): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      processes.delete(proc)
      if (err) reject(err)
      else resolve()
    }
    proc.on('error', (e) => done(new Error(`ffmpeg could not be started (${e.message})`)))
    proc.on('close', (code) => {
      if (signal.aborted) done(cancelled())
      else if (code === 0) done(null)
      else if (timedOut) done(new Error('Reading the sound took too long and was stopped.'))
      else done(new Error(describeFfmpegError(log, 'The sound of the recording could not be read.')))
    })
  })
}

/** Arguments decoding the first audio stream of `input` to 16 kHz mono PCM on the video's clock. */
export function decodeArgs(input: string, output: string): string[] {
  return ['-v', 'error', '-nostdin', '-y', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', `aresample=${RATE}:async=1:first_pts=0`, '-ac', '1', '-f', 's16le', output]
}

/** Arguments encoding [start, start + seconds) of the decoded PCM as a small MP3. */
export function partArgs(pcm: string, start: number, seconds: number, output: string): string[] {
  return [
    '-v', 'error', '-nostdin', '-y',
    '-f', 's16le', '-ar', String(RATE), '-ac', '1',
    '-ss', start.toFixed(3), '-t', seconds.toFixed(3), '-i', pcm,
    '-c:a', 'libmp3lame', '-b:a', `${MP3_BITRATE / 1000}k`, output
  ]
}

/** Quiet stretches of the decoded sound (seconds), from its levels as measured for ducking. */
async function silencesOf(pcm: string, duration: number, signal: AbortSignal): Promise<{ start: number; end: number }[]> {
  const meter = new LevelMeter(RATE, 1)
  let carry: Buffer = Buffer.alloc(0)
  const stream = createReadStream(pcm, { highWaterMark: 1 << 20 })
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (signal.aborted) {
      stream.destroy()
      throw cancelled()
    }
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const whole = buf.length - (buf.length % 2)
    const samples = new Float32Array(whole / 2)
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2) / 32768
    meter.push(samples)
    carry = Buffer.from(buf.subarray(whole))
  }
  return silencesBetween(detectActivity(meter.finish()), duration)
}

/** Which file of project `dir` to transcribe. */
async function soundFile(dir: string, project: { hasAudio: boolean; audioStems?: { mic: boolean } }, source: 'auto' | 'mic' | 'mixed'): Promise<string> {
  if (!project.hasAudio) throw new Error('This recording has no sound to transcribe.')
  const mic = path.join(dir, 'mic.m4a')
  const hasMic = project.audioStems?.mic === true && (await fs.stat(mic).catch(() => null))?.isFile() === true
  if (source === 'mic' && !hasMic) throw new Error('This recording has no separate microphone track. Transcribe the mixed sound instead.')
  return source !== 'mixed' && hasMic ? mic : path.join(dir, 'screen.mp4')
}

/**
 * Transcribes project `projectId` with the provider and options the renderer chose; resolves
 * with the transcript in source seconds. `progress` gets every step.
 */
export async function transcribeProject(store: AiProviderStore, projectId: unknown, rawOptions: unknown, progress: (p: TranscribeProgress) => void): Promise<Transcript> {
  if (typeof projectId !== 'string') throw new Error('Invalid project.')
  const dir = projectDir(projectId)
  const options = validateTranscribeOptions(rawOptions)
  if (jobs.has(projectId)) throw new Error('This recording is already being transcribed.')
  const { info, apiKey } = store.get(options.providerId)
  if (!AI_PROVIDER_KINDS[info.kind].canTranscribe) {
    throw new Error(
      'Claude cannot transcribe: the Claude API does not accept sound. Choose an OpenAI or Google Gemini provider to transcribe; Claude can then clean up, translate and summarise the captions.'
    )
  }
  const controller = new AbortController()
  const model = info.transcriptionModel ?? AI_PROVIDER_KINDS[info.kind].defaultTranscriptionModel!
  const run = clientFor(info, apiKey).then((client) => runJob(projectId, dir, options, info.kind, model, client, controller.signal, progress))
  const job: Job = { controller, done: run.catch(() => undefined) }
  jobs.set(projectId, job)
  try {
    return await run
  } finally {
    if (jobs.get(projectId) === job) jobs.delete(projectId)
  }
}

async function runJob(
  id: string,
  dir: string,
  options: ReturnType<typeof validateTranscribeOptions>,
  kind: Transcript['provider'],
  model: string,
  client: AiClient,
  signal: AbortSignal,
  progress: (p: TranscribeProgress) => void
): Promise<Transcript> {
  const send = (phase: TranscribeProgress['phase'], done: number, total: number): void => progress({ projectId: id, phase, done, total })
  const project = await readProject(id)
  const input = await soundFile(dir, project, options.source)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ssw-transcribe-'))
  try {
    send('extracting', 0, 1)
    const pcm = path.join(tmp, 'sound.pcm')
    const length = Number.isFinite(project.duration) && project.duration > 0 ? project.duration : 3600
    await runFfmpeg(decodeArgs(input, pcm), id, signal, 120_000 + length * 500)
    const decoded = (await fs.stat(pcm)).size / PCM_RATE
    const duration = Number.isFinite(project.duration) && project.duration > 0 ? Math.min(decoded, project.duration) : decoded
    if (duration < 0.1) throw new Error('This recording has no sound to transcribe.')

    const limits = client.partLimits!
    const maxSeconds = Math.min(limits.maxSeconds, secondsForBytes(limits.maxBytes, MP3_BITRATE), testLimit('SSW_AI_MAX_PART_SECONDS') ?? Infinity)
    const silences = duration > maxSeconds ? await silencesOf(pcm, duration, signal) : []
    const parts = planParts(duration, silences, { maxSeconds })

    const results: { part: TranscriptPart; transcript: RawTranscript }[] = []
    for (const part of parts) {
      if (signal.aborted) throw cancelled()
      send('transcribing', part.index, parts.length)
      const file = path.join(tmp, `part-${part.index}.mp3`)
      const seconds = part.end - part.start
      await runFfmpeg(partArgs(pcm, part.start, seconds, file), id, signal, 60_000 + seconds * 1000)
      const bytes = (await fs.stat(file)).size
      const transcript = await client.transcribe!(
        { file, mimeType: 'audio/mpeg', bytes, seconds },
        { language: options.language, signal, onUpload: () => send('uploading', part.index, parts.length) }
      )
      results.push({ part, transcript })
      await fs.rm(file, { force: true })
    }
    send('finishing', parts.length, parts.length)
    const merged = mergeParts(results, duration)
    return {
      ...(options.language ?? merged.language ? { language: options.language ?? merged.language } : {}),
      provider: kind,
      model,
      createdAt: new Date().toISOString(),
      segments: merged.segments
    }
  } catch (err) {
    if (signal.aborted) throw cancelled()
    throw err
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
}

/** Stops project `id`'s transcription; resolves once ffmpeg has let go of its files and the temporary files are gone. */
export async function stopTranscription(id: string): Promise<void> {
  const job = jobs.get(id)
  job?.controller.abort()
  await processes.stop(id)
  await job?.done
}

/** Stops every transcription (the app is quitting). */
export function stopAllTranscriptions(): void {
  for (const job of jobs.values()) job.controller.abort()
  processes.stopAll()
}

