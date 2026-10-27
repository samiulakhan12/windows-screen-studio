/**
 * "On this PC" as a transcription client of the existing pipeline (ai/transcribe.ts runJob,
 * docs/design/offline-captions.md §3.2): each part is a 16 kHz mono WAV transcribed by one run
 * of the speech helper, cached in the project's .cache/transcript-parts by its content, so a
 * cancelled or failed job continues where it stopped. Workstream B's own module.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawTranscript } from '../../shared/captions/transcriptParse'
import { ENGINE_VERSION, speechModel, speechModelBlock, speechThreads, type SpeechModelSpec } from '../../shared/speech/catalog'
import { localErrorMessage, type LocalCaptionsError, type LocalErrorParams } from '../../shared/speech/errors'
import { estimateSeconds } from '../../shared/speech/estimate'
import { localTranscript, modelArgs, readSidecarLine, SIDECAR, type SidecarResult, type SidecarSegment } from '../../shared/speech/protocol'
import { writeFileAtomicSync } from '../atomicWrite'
import { cancelled } from '../ai/request'
import type { AiClient, AudioPart, TranscribeCall } from '../ai/types'
import type { ProjectProcesses } from '../projectProcesses'
import { commonArgs, markIllegalInstruction, runHelper, selectHelper, spawnFailure, speechHelperPaths, SPEECH_TIMING, type HelperBuild, type HelperChoice, type SpeechExit } from './helper'
import type { SpeechModelStore } from './models'
import { detectorModelOk } from './vad'

export interface LocalClientDeps {
  /** The project's folder (its .cache holds finished parts). */
  projectDir: string
  /** The job's processes (stopping the project stops the helper) and their owner (the project id). */
  processes?: ProjectProcesses
  owner?: string
  /** Defaults: the app's store, selectHelper, the bundled detector model, this PC's processors and memory. */
  store?: SpeechModelStore
  helper?: () => Promise<HelperChoice>
  vadModel?: string
  cores?: number
  totalMemBytes?: number
  /** The stall watchdog (default SPEECH_TIMING.stallMs; tests shorten it). */
  stallMs?: number
}

/** Folder of finished parts inside a project. */
export const PART_CACHE_DIR = path.join('.cache', 'transcript-parts')
/** Largest cached part read back. */
const PART_CACHE_MAX = 8 << 20
/** Parts at least this long, with detected speech in at least this share of them, teach the store this PC's speed. */
const LEARN_MIN_SECONDS = 60
const LEARN_MIN_SPEECH = 0.5

/** Cache key of a finished part: its WAV's SHA-256, the model's SHA-256, the language asked for and ENGINE_VERSION. */
export function partCacheKey(partSha256: string, spec: Pick<SpeechModelSpec, 'sha256'>, language: string | undefined, engine: string): string {
  return createHash('sha256')
    .update([partSha256, spec.sha256, language || 'auto', engine].join('\n'))
    .digest('hex')
}

/**
 * How long a part may run: max(10 min, 4 × its estimate for this build and thread count), ms. A
 * measured speed only lengthens it: one learned on a quieter recording or another PC must never
 * kill real work.
 */
export function partLimitMs(spec: Pick<SpeechModelSpec, 'rtf4'>, seconds: number, threads: number, measured: { rtf: number; threads: number } | null, build: 'standard' | 'compatible' | 'host' | null): number {
  const estimate = Math.max(estimateSeconds(spec, seconds, threads, measured, build), estimateSeconds(spec, seconds, threads, null, build))
  return Math.max(SPEECH_TIMING.partMinMs, SPEECH_TIMING.partEstimateFactor * estimate * 1000)
}

/** A local failure, as the Captions tab maps it back (localErrorCode). */
const fail = (code: LocalCaptionsError, params: LocalErrorParams = {}): Error => new Error(localErrorMessage(code, params))

/** The primary subtag of a language the user chose ("pt-BR" → "pt"), as whisper.cpp takes it. */
export const helperLanguage = (language: string | undefined): string | undefined => (language ? language.split('-')[0].toLowerCase() : undefined)

interface CachedPart {
  version: 1
  model: string
  modelSha256: string
  language: string
  languageSeconds: number
  engine: string
  partSha256: string
  transcript: RawTranscript
}

/**
 * How localTranscript forms captions for `spec`: a model that decodes without timestamp tokens
 * (the Bangla model) writes one segment per chunk of up to 20 s, so its segments are cut into
 * captions at the pauses (protocol.ts captionPieces); the Whisper models' segments are kept.
 */
export const captionSplit = (spec: Pick<SpeechModelSpec, 'noTimestamps'>): { split: boolean } => ({ split: spec.noTimestamps === true })

/** A cached part read back as untrusted input (size cap, the same checks as live output); null when unusable. */
export async function readCachedPart(file: string, expect: { spec: SpeechModelSpec; partSha256: string; seconds: number }): Promise<{ transcript: RawTranscript; language: string; languageSeconds: number } | null> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile() || stat.size > PART_CACHE_MAX) return null
  let raw: Partial<CachedPart>
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || raw.version !== 1 || raw.model !== expect.spec.id || raw.modelSha256 !== expect.spec.sha256 || raw.engine !== ENGINE_VERSION || raw.partSha256 !== expect.partSha256) return null
  if (typeof raw.language !== 'string' || raw.language.length > 32 || typeof raw.languageSeconds !== 'number' || !Number.isFinite(raw.languageSeconds) || raw.languageSeconds < 0) return null
  const segs = raw.transcript?.segments
  if (!Array.isArray(segs)) return null
  // Through the live output's own checks: each segment as the helper's line would be.
  const lines: SidecarSegment[] = []
  for (const s of segs) {
    const event = readSidecarLine(JSON.stringify({ type: 'segment', start: s?.start, end: s?.end, text: s?.text, words: Array.isArray(s?.words) ? s.words.map((w) => ({ ...w, prob: 1 })) : [] }))
    if (event?.type !== 'segment') return null
    lines.push(event)
  }
  // A part kept before captions were cut (the Bangla model's 20 s segments) is cut as it is read.
  return { transcript: localTranscript(lines, raw.language, expect.seconds, captionSplit(expect.spec)), language: raw.language, languageSeconds: raw.languageSeconds }
}

/** `heard`: seconds of speech the helper's detector found in the part (the audio it transcribed). */
type PartRun = { kind: 'done'; segments: SidecarSegment[]; result: SidecarResult; wallMs: number; heard: number } | SpeechExit

/** The client for model `modelId` (absent: the default model); rejects with a message when the engine or the model is not ready. */
export async function localSpeechClient(modelId: string | undefined, deps: LocalClientDeps): Promise<AiClient> {
  const store = deps.store ?? (await import('./service')).speechStore()
  let choice = await (deps.helper ?? selectHelper)()
  if ('error' in choice) throw fail('unavailable', { reason: choice.error })
  const spec = speechModel(modelId ?? store.defaultModel())
  if (!spec) throw fail('no-model')
  const block = speechModelBlock(spec, { totalMemBytes: deps.totalMemBytes ?? os.totalmem(), build: choice.build })
  if (block) throw fail('blocked', { model: spec.id, block })
  const modelFile = await store.installedFile(spec.id)
  const vadModel = deps.vadModel ?? speechHelperPaths()?.vadModel
  // A missing or damaged detector model is part of Flown missing, never the Whisper model's fault (the helper calls both `model`).
  if (!vadModel || !(await detectorModelOk(vadModel))) throw fail('unavailable', { reason: 'missing' })
  const release = store.hold(spec.id)
  const baseThreads = speechThreads(deps.cores ?? os.cpus().length)
  /** A detected language heard long enough (language_s >= detectMinSpeech) is used for every later part. */
  let carried: string | undefined
  const cacheDir = path.join(deps.projectDir, PART_CACHE_DIR)

  const runPart = async (part: AudioPart, lang: string, threads: number, call: TranscribeCall, exe: string, build: HelperBuild): Promise<PartRun> => {
    const limitMs = partLimitMs(spec, part.seconds, threads, store.measured(spec.id, build), build)
    const args = [
      'transcribe',
      '--model-dir', path.dirname(modelFile),
      '--model', spec.file,
      '--audio', part.file,
      '--vad-model', vadModel,
      '--lang', lang,
      // The model's own arguments (the Bangla model: 20 s chunks, no timestamp tokens), else none.
      ...modelArgs(spec),
      '--threads', String(threads),
      '--stdin-control',
      ...commonArgs()
    ]
    const started = Date.now()
    call.onProgress?.({ phase: 'loading', fraction: 0 })
    let spawnError: NodeJS.ErrnoException | undefined
    const run = runHelper(exe, args, { cwd: path.dirname(part.file), stdin: 'control', signal: call.signal, timeoutMs: limitMs, stallMs: deps.stallMs, processes: deps.processes, owner: deps.owner, onSpawnError: (e) => (spawnError = e) })
    const segments: SidecarSegment[] = []
    let result: SidecarResult | null = null
    let fraction = 0
    let at = 0
    let preview: string | undefined
    let heard = 0
    for await (const e of run.events) {
      if (e.type === 'ready') call.onProgress?.({ phase: 'transcribing', fraction: 0 })
      else if (e.type === 'speech') heard = e.segments.reduce((sum, [start, end]) => sum + end - start, 0)
      else if (e.type === 'progress') {
        fraction = Math.max(fraction, e.percent / 100)
        at = Math.min(part.seconds, Math.max(at, e.at))
        call.onProgress?.({ phase: 'transcribing', fraction, at, ...(preview ? { preview } : {}) })
      } else if (e.type === 'segment') {
        segments.push(e)
        const text = e.words.length ? e.words.map((w) => w.text.trim()).filter(Boolean).join(' ') : e.text.trim()
        if (text) preview = text.length > SIDECAR.previewChars ? text.slice(-SIDECAR.previewChars) : text
        at = Math.min(part.seconds, Math.max(at, e.end))
        call.onProgress?.({ phase: 'transcribing', fraction, at, ...(preview ? { preview } : {}) })
      } else if (e.type === 'result') result = e
    }
    const exit = await run.done
    // The helper never started (gone, or Windows or an antivirus refused it): not a crash, so the model stays trusted and nothing is retried.
    if (spawnError) throw fail('unavailable', { reason: spawnFailure(spawnError) })
    if (exit.kind !== 'ok') {
      if (exit.kind === 'crash' || exit.kind === 'protocol' || exit.kind === 'stalled') console.warn(`Speech helper (${exit.kind}) on ${path.basename(part.file)}: ${'detail' in exit ? exit.detail : ''} ${run.stderr().trim().split('\n').slice(-2).join(' | ')}`)
      return exit
    }
    if (!result) return { kind: 'protocol', detail: 'the run ended without a result' }
    return { kind: 'done', segments, result, wallMs: Date.now() - started, heard }
  }

  const transcribe = async (part: AudioPart, call: TranscribeCall): Promise<RawTranscript> => {
    if (call.signal.aborted) throw cancelled()
    // A model made for one language always runs with it (validateTranscribeOptions refuses another).
    const asked = spec.language ?? helperLanguage(call.language)
    const lang = asked ?? carried ?? 'auto'
    const partSha256 = createHash('sha256').update(await fs.readFile(part.file)).digest('hex')
    const key = partCacheKey(partSha256, spec, lang, ENGINE_VERSION)
    const cacheFile = path.join(cacheDir, `${key}.json`)
    const learn = (language: string, seconds: number): void => {
      if (!asked && !carried && language && language !== 'auto' && seconds >= SIDECAR.detectMinSpeech) carried = language
    }

    const hit = await readCachedPart(cacheFile, { spec, partSha256, seconds: part.seconds })
    if (hit) {
      learn(hit.language, hit.languageSeconds)
      call.onProgress?.({ phase: 'transcribing', fraction: 1, at: part.seconds, cached: true })
      return hit.transcript
    }

    let threads = baseThreads
    let switched = false
    let retried = false
    const where = call.part ? { part: call.part.index + 1, parts: call.part.count } : {}
    for (;;) {
      if ('error' in choice) throw fail('unavailable', { reason: choice.error })
      const r = await runPart(part, lang, threads, call, choice.exe, choice.build)
      if (r.kind === 'done') {
        const transcript = localTranscript(r.segments, r.result.language, part.seconds, captionSplit(spec))
        const language = r.result.language === 'auto' ? '' : r.result.language
        const entry: CachedPart = { version: 1, model: spec.id, modelSha256: spec.sha256, language, languageSeconds: r.result.language_s, engine: ENGINE_VERSION, partSha256, transcript }
        try {
          await fs.mkdir(cacheDir, { recursive: true })
          writeFileAtomicSync(cacheFile, JSON.stringify(entry))
        } catch (err) {
          console.warn(`Could not keep a finished caption part: ${err instanceof Error ? err.message : String(err)}`)
        }
        learn(language, r.result.language_s)
        // Only the speech is transcribed: a mostly silent part would teach a speed several times too fast.
        if (part.seconds >= LEARN_MIN_SECONDS && r.heard >= LEARN_MIN_SPEECH * part.seconds) store.recordMeasured(spec.id, r.wallMs / 1000 / part.seconds, threads, choice.build)
        return transcript
      }
      if (r.kind === 'cancelled' || call.signal.aborted) throw cancelled()
      if ((r.kind === 'crash' && r.illegalInstruction) || (r.kind === 'error' && r.code === 'cpu')) {
        // The standard build cannot run here after all: the compatible one, for the rest of the session.
        if (switched || choice.build !== 'standard') throw fail('unavailable', { reason: 'cpu' })
        switched = true
        markIllegalInstruction()
        choice = await (deps.helper ?? selectHelper)()
        continue
      }
      if (r.kind === 'error') {
        if (r.code === 'memory') throw fail('memory', { model: spec.id })
        if (r.code === 'model') {
          store.clearVerified(spec.id)
          throw fail('damaged', { model: spec.id })
        }
        if (r.code === 'language') throw fail('language', { language: call.language ?? lang })
        if (r.code === 'args') {
          // The helper refused the app's own arguments: it is not the one built with this version of
          // Flown (an older one bundled by mistake lacks --no-timestamps, which the Bangla model needs).
          console.warn(`Speech helper refused the arguments for ${spec.id}: ${r.message}`)
          throw fail('outdated', { model: spec.id })
        }
        if (r.code !== 'internal') throw fail('protocol')
      }
      if (r.kind === 'protocol') throw fail('protocol')
      // A crash (or an internal error) or a stall: the part once more.
      if (r.kind === 'crash') store.clearVerified(spec.id)
      if (retried) throw r.kind === 'stalled' ? fail('stalled') : fail('crashed', where)
      retried = true
      if (r.kind !== 'stalled') threads = Math.max(1, Math.floor(threads / 2))
    }
  }

  return {
    test: async () => 'On this PC',
    json: async () => {
      throw new Error('Text tasks need an AI provider.')
    },
    transcribe,
    partLimits: { maxSeconds: spec.partSeconds, maxBytes: Infinity },
    input: 'wav',
    model: spec.id,
    dispose: release
  }
}
