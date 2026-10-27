/**
 * The speech helper's protocol (docs/design/offline-captions.md §5.2), frozen: what
 * `ssw-speech cpu | vad | transcribe` prints, one JSON object per line on stdout, and how the
 * main process reads it. native/speech implements the other side. Every line is untrusted
 * input: it is size-capped, parsed, checked field by field, and dropped when malformed.
 */
import { cleanText, languageCode, type RawSegment, type RawTranscript, type RawWord } from '../captions/transcriptParse'

export const SIDECAR = {
  /** Longest line read, bytes; a longer one is a protocol violation (the helper is killed). */
  lineMax: 1 << 20,
  /** Most stdout read from one run, bytes. */
  totalMax: 64 << 20,
  /** Exit codes. */
  exit: { ok: 0, error: 1, cancelled: 2 },
  /** Seconds per speech detector probability (512 samples at 16 kHz). */
  vadFrame: 0.032,
  /** Longest chunk the helper hands whisper.cpp, seconds (it encodes 30 s windows). */
  maxChunk: 29,
  /** Longest preview of the words heard that progress carries, characters. */
  previewChars: 120,
  /**
   * While it works, the helper prints a progress line at least this often, seconds (whisper.cpp
   * reports progress only once per 30 s window, which can take minutes on a slow processor).
   */
  heartbeat: 15,
  /**
   * Seconds of speech a language detection must have heard before the app carries the detected
   * language to the later parts of a recording (SidecarResult.language_s).
   */
  detectMinSpeech: 10
} as const

/** Error codes of `{"type":"error"}` lines. */
export type SidecarErrorCode =
  /** Bad arguments (a bug on the app's side). */
  | 'args'
  /** The model could not be loaded: treated as a damaged file (hashed again before the next use). */
  | 'model'
  /** The audio is not 16 kHz mono WAV or f32le. */
  | 'audio'
  /** The language code is not one the model knows. */
  | 'language'
  /** Memory ran out. */
  | 'memory'
  /**
   * The standard build's own CPUID check found the processor lacking (SidecarCpu): use the
   * compatible build. A wrong choice can also fault before this check runs (code compiled for
   * AVX2 may run in static initialisers), so an illegal-instruction exit means the same.
   */
  | 'cpu'
  | 'internal'

/** `ssw-speech cpu`: what the processor offers (Rust's feature detection; runs no SIMD code). */
export interface SidecarCpu {
  type: 'cpu'
  sse42: boolean
  avx: boolean
  avx2: boolean
  fma: boolean
  f16c: boolean
  /** Some virtual machines and emulators offer AVX2 without BMI2; the standard build needs both. */
  bmi2: boolean
  /** Logical processors. */
  logical: number
}

/** `transcribe`: the model is loaded. */
export interface SidecarReady {
  type: 'ready'
  /** 'tiny', 'base', 'small', 'large-v3-turbo', … from the model's header. */
  model: string
  multilingual: boolean
  /** The DTW alignment-heads preset in use, or 'off'. */
  dtw: string
  build: 'standard' | 'compatible' | 'host'
  /** whisper.cpp's system line (which SIMD features are on). */
  system: string
}

/** `transcribe`: speech ranges found in the audio, seconds from its start. */
export interface SidecarSpeech {
  type: 'speech'
  segments: [number, number][]
}

/**
 * `transcribe`: progress through the audio. Printed when whisper.cpp reports progress and, with
 * the latest values, at least every SIDECAR.heartbeat seconds while the helper works.
 */
export interface SidecarProgress {
  type: 'progress'
  /** 0..100 of the audio's speech. */
  percent: number
  /** Seconds of the audio transcribed so far. */
  at: number
}

export interface SidecarWord {
  /** The word as written, punctuation kept ("presided,"). */
  text: string
  start: number
  end: number
  /** Mean token probability, 0..1. */
  prob: number
}

/**
 * `transcribe`: one finished segment (sent after each chunk), seconds from the start of the
 * audio. Its word times are final: the helper refines each chunk's words before printing them
 * (docs/design/offline-captions.md §5.2 "Word forming"), and nothing later changes them.
 */
export interface SidecarSegment {
  type: 'segment'
  start: number
  end: number
  text: string
  words: SidecarWord[]
}

/** `transcribe`: the end of a successful run. */
export interface SidecarResult {
  type: 'result'
  /**
   * The language the run used ("en"): the one asked for, or the one detected; '' when it was
   * 'auto' and the audio held no speech to detect it from.
   */
  language: string
  /**
   * Seconds of speech the language detection heard (the first chunk with at least
   * SIDECAR.detectMinSpeech s of speech, else the chunk with the most); 0 when the language was
   * given or nothing was detected. The app carries a detected language to later parts only from
   * a run with language_s >= SIDECAR.detectMinSpeech.
   */
  language_s: number
  /** Seconds of audio. */
  duration: number
  timing: { load_ms: number; vad_ms: number; asr_ms: number; rtf: number; peak_rss_mb: number }
}

/** `vad`: the speech detector's probability per frame. */
export interface SidecarVad {
  type: 'vad'
  /** Seconds of audio read. */
  audio_s: number
  /** Seconds per probability (SIDECAR.vadFrame). */
  frame: number
  /** Number of probabilities. */
  n: number
  /** Base64 of n bytes: probability × 255, rounded. */
  probs: string
  detect_ms: number
}

/** Cancelled (a "cancel" line or the end of stdin): exit code 2. */
export interface SidecarCancelled {
  type: 'cancelled'
  /** Seconds of the audio fully transcribed before stopping. */
  done_until: number
}

/** Failed: exit code 1. */
export interface SidecarError {
  type: 'error'
  code: SidecarErrorCode
  message: string
}

export type SidecarEvent = SidecarCpu | SidecarReady | SidecarSpeech | SidecarProgress | SidecarSegment | SidecarResult | SidecarVad | SidecarCancelled | SidecarError

const ERROR_CODES: readonly SidecarErrorCode[] = ['args', 'model', 'audio', 'language', 'memory', 'cpu', 'internal']
const BUILDS = ['standard', 'compatible', 'host'] as const
/** Most words read from one segment line, and most characters of a word or a text. */
const MAX_WORDS = 400
const MAX_TEXT = 2000
const MAX_WORD_TEXT = 200

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const time = (v: unknown): v is number => finite(v) && v >= 0
const bool = (v: unknown): v is boolean => typeof v === 'boolean'
const str = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max

function readWord(w: unknown): SidecarWord | null {
  if (!isObject(w) || !str(w.text, MAX_WORD_TEXT) || !time(w.start) || !time(w.end) || !finite(w.prob)) return null
  // A word whose times are reversed is dropped (the rest of its segment is kept).
  if (w.end < w.start) return null
  return { text: w.text, start: w.start, end: w.end, prob: Math.min(1, Math.max(0, w.prob)) }
}

function readEvent(o: Obj): SidecarEvent | null {
  switch (o.type) {
    case 'cpu':
      if (!bool(o.sse42) || !bool(o.avx) || !bool(o.avx2) || !bool(o.fma) || !bool(o.f16c) || !bool(o.bmi2) || !finite(o.logical) || o.logical < 0) return null
      return { type: 'cpu', sse42: o.sse42, avx: o.avx, avx2: o.avx2, fma: o.fma, f16c: o.f16c, bmi2: o.bmi2, logical: Math.floor(o.logical) }
    case 'vad':
      if (!time(o.audio_s) || !finite(o.frame) || o.frame <= 0 || !finite(o.n) || o.n < 0 || !Number.isInteger(o.n) || typeof o.probs !== 'string' || !time(o.detect_ms)) return null
      return { type: 'vad', audio_s: o.audio_s, frame: o.frame, n: o.n, probs: o.probs, detect_ms: o.detect_ms }
    case 'ready':
      if (!str(o.model, 200) || !bool(o.multilingual) || !str(o.dtw, 200) || !BUILDS.includes(o.build as (typeof BUILDS)[number]) || !str(o.system)) return null
      return { type: 'ready', model: o.model, multilingual: o.multilingual, dtw: o.dtw, build: o.build as SidecarReady['build'], system: o.system }
    case 'speech': {
      if (!Array.isArray(o.segments)) return null
      const segments: [number, number][] = []
      for (const s of o.segments) {
        if (!Array.isArray(s) || s.length !== 2 || !time(s[0]) || !time(s[1]) || s[1] < s[0]) return null
        segments.push([s[0], s[1]])
      }
      return { type: 'speech', segments }
    }
    case 'progress':
      if (!finite(o.percent) || !time(o.at)) return null
      return { type: 'progress', percent: Math.min(100, Math.max(0, o.percent)), at: o.at }
    case 'segment': {
      if (!time(o.start) || !time(o.end) || o.end < o.start || !str(o.text) || !Array.isArray(o.words)) return null
      const words: SidecarWord[] = []
      for (const w of o.words) {
        const word = readWord(w)
        if (word && words.length < MAX_WORDS) words.push(word)
      }
      return { type: 'segment', start: o.start, end: o.end, text: o.text, words }
    }
    case 'result': {
      const t = o.timing
      if (typeof o.language !== 'string' || o.language.length > 32 || !time(o.language_s) || !time(o.duration) || !isObject(t)) return null
      if (!finite(t.load_ms) || !finite(t.vad_ms) || !finite(t.asr_ms) || !finite(t.rtf) || !finite(t.peak_rss_mb)) return null
      return {
        type: 'result',
        language: o.language,
        language_s: o.language_s,
        duration: o.duration,
        timing: { load_ms: t.load_ms, vad_ms: t.vad_ms, asr_ms: t.asr_ms, rtf: t.rtf, peak_rss_mb: t.peak_rss_mb }
      }
    }
    case 'cancelled':
      if (!time(o.done_until)) return null
      return { type: 'cancelled', done_until: o.done_until }
    case 'error':
      if (!ERROR_CODES.includes(o.code as SidecarErrorCode) || !str(o.message)) return null
      return { type: 'error', code: o.code as SidecarErrorCode, message: o.message }
    default:
      return null
  }
}

/**
 * One stdout line read: the event when it is valid JSON of a known type with every field of
 * the right kind (finite numbers, strings, words with ordered times), else null. Lines longer
 * than SIDECAR.lineMax are null. Unknown types are null (ignored), never an error.
 */
export function readSidecarLine(line: string): SidecarEvent | null {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > SIDECAR.lineMax) return null
  let parsed: unknown
  try {
    // JSON.parse rejects NaN and Infinity, which are not JSON.
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  return isObject(parsed) ? readEvent(parsed) : null
}

const round = (t: number): number => Math.round(t * 1000) / 1000

/**
 * The segments of one run as the transcript of a part (seconds from the part's start, inside
 * [0, partSeconds]): each segment's text is its words joined by single spaces (so the caption
 * layout always finds a timing per word), words with no text are dropped, times are made
 * ordered and monotonic, at most 400 words per segment; probabilities are dropped. `language`
 * is the result's; '' and 'auto' are left out (never stored or counted by mergeParts).
 */
export function localTranscript(segments: readonly SidecarSegment[], language: string | undefined, partSeconds: number): RawTranscript {
  const limit = Number.isFinite(partSeconds) && partSeconds > 0 ? partSeconds : 0
  const clamp = (t: number): number => round(Math.min(limit, Math.max(0, Number.isFinite(t) ? t : 0)))
  const ordered = [...segments].sort((a, b) => a.start - b.start)
  const out: RawSegment[] = []
  let last = 0
  for (const seg of ordered) {
    const words: RawWord[] = []
    for (const w of seg.words) {
      if (words.length >= MAX_WORDS) break
      const text = cleanText(typeof w.text === 'string' ? w.text : '', MAX_WORD_TEXT)
      if (!text) continue
      const start = Math.max(clamp(Math.min(w.start, w.end)), last)
      const end = Math.max(clamp(Math.max(w.start, w.end)), start)
      words.push({ text, start, end })
      last = end
    }
    let start: number
    let end: number
    let text: string
    if (words.length > 0) {
      start = words[0].start
      end = words[words.length - 1].end
      text = words.map((w) => w.text).join(' ')
    } else {
      // A segment without words (the helper always sends them; kept for safety) keeps its own text and times.
      text = cleanText(seg.text, MAX_TEXT)
      start = Math.max(clamp(Math.min(seg.start, seg.end)), last)
      end = Math.max(clamp(Math.max(seg.start, seg.end)), start)
      if (text) last = end
    }
    if (!text) continue
    out.push({ start, end, text, ...(words.length ? { words } : {}) })
  }
  const code = language && language !== 'auto' ? languageCode(language) : undefined
  return { ...(code ? { language: code } : {}), segments: out }
}
