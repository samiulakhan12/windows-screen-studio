/**
 * The speech helper's protocol (docs/design/offline-captions.md §5.2), frozen: what
 * `ssw-speech cpu | vad | transcribe` prints, one JSON object per line on stdout, and how the
 * main process reads it. native/speech implements the other side. Every line is untrusted
 * input: it is size-capped, parsed, checked field by field, and dropped when malformed.
 */
import type { RawTranscript } from '../captions/transcriptParse'

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
  previewChars: 120
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
  /** The standard build found no AVX2/FMA/F16C before running any ggml code: use the compatible build. */
  | 'cpu'
  | 'internal'

/** `ssw-speech cpu`: what the processor offers (Rust's feature detection; runs no SIMD code). */
export interface SidecarCpu {
  type: 'cpu'
  avx: boolean
  avx2: boolean
  fma: boolean
  f16c: boolean
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

/** `transcribe`: progress through the audio. */
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

/** `transcribe`: one finished segment (sent after each chunk), seconds from the start of the audio. */
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
  /** Detected or forced language code ("en"). */
  language: string
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

/**
 * One stdout line read: the event when it is valid JSON of a known type with every field of
 * the right kind (finite numbers, strings, words with ordered times), else null. Lines longer
 * than SIDECAR.lineMax are null. Unknown types are null (ignored), never an error.
 */
export function readSidecarLine(line: string): SidecarEvent | null {
  void line
  throw new Error('readSidecarLine: not implemented yet (workstream B)')
}

/**
 * The segments of one run as the transcript of a part (seconds from the part's start, inside
 * [0, partSeconds]): each segment's text is its words joined by single spaces (so the caption
 * layout always finds a timing per word), words with no text are dropped, times are made
 * ordered and monotonic, at most 400 words per segment; probabilities are dropped.
 */
export function localTranscript(segments: readonly SidecarSegment[], language: string | undefined, partSeconds: number): RawTranscript {
  void segments
  void language
  void partSeconds
  throw new Error('localTranscript: not implemented yet (workstream B)')
}
