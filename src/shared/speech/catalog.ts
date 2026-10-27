/**
 * The speech models Flown can download for captions made on this PC, and the speech detector
 * model it ships (docs/design/offline-captions.md §2). Data only: every file is pinned by
 * repository commit, size and SHA-256 (the Hugging Face LFS oid), and only a file that matches
 * its pin is ever handed to the speech engine, which parses it; nothing downloaded is executed.
 *
 * The numbers were measured on the reference PC (4 cores, Linux, 4 threads, the speech detector
 * on, the 105.7 s LibriSpeech clip with forced-aligned word times). Windows under wine ran about
 * 1.3 times slower (WINDOWS_FACTOR in estimate.ts).
 */

export type SpeechModelId = 'whisper-tiny' | 'whisper-base' | 'whisper-small' | 'whisper-turbo' | 'whisper-bn-medium'

/**
 * How the model is offered: quickest to most accurate, and 'bangla' for the model made for
 * Bangla only (docs/design/offline-captions.md §14).
 */
export type SpeechTier = 'fast' | 'standard' | 'accurate' | 'best' | 'bangla'

/** The tiers as the Captions tab names them (the model's own name follows in brackets once). */
export const SPEECH_TIER_NAMES: Readonly<Record<SpeechTier, string>> = { fast: 'Fast', standard: 'Standard', accurate: 'Accurate', best: 'Most accurate', bangla: 'Bangla' }

export interface SpeechLicense {
  name: 'MIT' | 'Apache-2.0'
  /** Copyright holder as the licence states it. */
  holder: string
  /** Where the licence and the source can be read. */
  url: string
}

export interface SpeechModelSpec {
  id: SpeechModelId
  tier: SpeechTier
  /** Shown name ("Whisper base"). */
  name: string
  /** File name in the repository and on disk ([A-Za-z0-9._-]+, never a path). */
  file: string
  /** Exact size of the file, bytes. */
  bytes: number
  /** SHA-256 of the file, lowercase hex. */
  sha256: string
  /** Processing time / audio time on the reference PC with 4 threads. */
  rtf4: number
  /** Peak memory of the engine on the reference clip, MB. */
  ramMB: number
  /** Word error rate on the reference clip (lowercase, punctuation-free tokens), 0..1. */
  wer: number
  /** Median absolute error of word starts against forced-aligned times, ms. */
  startMedianMs: number
  /** Longest stretch of a recording one engine run transcribes, seconds (one process per part). */
  partSeconds: number
  /** Total memory a PC needs before this model may be downloaded or used, GB (absent: any PC). */
  minTotalMemGB?: number
  /**
   * Not offered where only the compatible build runs (no AVX2): about 4.3 times slower there,
   * it would take several times the recording's length.
   */
  needsStandardBuild?: true
  /**
   * The one language this model makes captions in (a whisper code). It always runs with this
   * language, is used only when the spoken language is this one, and is never the default model
   * (absent: a multilingual model, offered for every language).
   */
  language?: 'bn'
  /** Longest chunk the helper hands whisper.cpp for this model, seconds (absent: SIDECAR.maxChunk). */
  maxChunkSeconds?: number
  /**
   * Decode without timestamp tokens (`--no-timestamps`): a model fine-tuned without them (the
   * Bangla model) garbles the first word of most chunks when made to start with one. Word times
   * come from DTW either way.
   */
  noTimestamps?: true
  /** Where the file comes from (absent: SPEECH_MODEL_REPO). */
  repo?: { repo: string; commit: string }
  license: SpeechLicense
}

/** Where the Whisper models come from: the whisper.cpp project's ggml conversions, at one commit. */
export const SPEECH_MODEL_REPO = {
  host: 'https://huggingface.co',
  repo: 'ggerganov/whisper.cpp',
  commit: '5359861c739e955e79d9a303bcbc70fb988958b1'
} as const

const WHISPER_LICENSE: SpeechLicense = {
  name: 'MIT',
  holder: 'OpenAI (Whisper weights); converted by the whisper.cpp project',
  url: 'https://huggingface.co/ggerganov/whisper.cpp'
}

/**
 * The offered models: the multilingual ones quickest first (so "Detect automatically" always
 * works with them), then the ones made for one language (`language`).
 */
export const SPEECH_MODELS: readonly SpeechModelSpec[] = [
  {
    id: 'whisper-tiny',
    tier: 'fast',
    name: 'Whisper tiny',
    file: 'ggml-tiny-q8_0.bin',
    bytes: 43_537_433,
    sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca',
    rtf4: 0.042,
    ramMB: 252,
    wer: 0.083,
    startMedianMs: 75,
    partSeconds: 600,
    license: WHISPER_LICENSE
  },
  {
    id: 'whisper-base',
    tier: 'standard',
    name: 'Whisper base',
    file: 'ggml-base-q5_1.bin',
    bytes: 59_707_625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    rtf4: 0.079,
    ramMB: 311,
    wer: 0.087,
    startMedianMs: 45,
    partSeconds: 600,
    license: WHISPER_LICENSE
  },
  {
    id: 'whisper-small',
    tier: 'accurate',
    name: 'Whisper small',
    file: 'ggml-small-q5_1.bin',
    bytes: 190_085_487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    rtf4: 0.293,
    ramMB: 557,
    wer: 0.079,
    startMedianMs: 45,
    partSeconds: 300,
    license: WHISPER_LICENSE
  },
  {
    id: 'whisper-turbo',
    tier: 'best',
    name: 'Whisper large-v3 turbo',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    rtf4: 1.138,
    ramMB: 1014,
    wer: 0.057,
    startMedianMs: 45,
    partSeconds: 180,
    minTotalMemGB: 8,
    needsStandardBuild: true,
    license: WHISPER_LICENSE
  },
  {
    // Bangla only (docs/design/offline-captions.md §14): measured on 59 FLEURS bn_in test clips,
    // long-form with 20 s chunks: WER 22.2 %, CER 9.2 % (large-v3 turbo with Bengali: 98 %).
    id: 'whisper-bn-medium',
    tier: 'bangla',
    name: 'Bengali.AI Whisper medium',
    file: 'ggml-bengaliai-whisper-medium-q5_0.bin',
    bytes: 539_257_671,
    sha256: '2c64c7f1e2c8f2417ed1fe5b78c7238933c00a2cdc2ef33e7087a95475256605',
    rtf4: 0.87,
    ramMB: 1200,
    wer: 0.222,
    startMedianMs: 40,
    partSeconds: 180,
    minTotalMemGB: 8,
    needsStandardBuild: true,
    language: 'bn',
    maxChunkSeconds: 20,
    noTimestamps: true,
    repo: { repo: 'winshades/bengaliai-whisper-medium-ggml', commit: '11cf5cbd282e0e46a761093939952f74906ddce1' },
    license: {
      name: 'Apache-2.0',
      holder: 'Bengali.AI (the tugstugi team), fine-tuned from OpenAI Whisper; converted to ggml by WinShades',
      url: 'https://huggingface.co/bengaliAI/tugstugi_bengaliai-asr_whisper-medium'
    }
  }
]

/** The model offered first and used when nothing else was chosen. */
export const DEFAULT_SPEECH_MODEL: SpeechModelId = 'whisper-base'

/** The model made for Bangla. */
export const BANGLA_MODEL: SpeechModelId = 'whisper-bn-medium'

/** Whether `spec` makes captions in one language only (never the default model, never for another language). */
export const isLanguageModel = (spec: Pick<SpeechModelSpec, 'language'> | null | undefined): boolean => !!spec?.language

/** Whether a spoken language code ("bn", "bn-BD", any case) is Bengali. */
export const isBengali = (language: string | null | undefined): boolean => typeof language === 'string' && language.trim().split('-')[0].toLowerCase() === 'bn'

/**
 * The speech detector shipped in the installer (resources/speech/, see its MODEL.md): Silero
 * VAD v6.2.0 converted to ggml by the whisper.cpp project.
 */
export const VAD_MODEL = {
  file: 'ggml-silero-v6.2.0.bin',
  bytes: 885_098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  release: 'Silero VAD v6.2.0',
  source: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
  license: { name: 'MIT', holder: 'Silero Team', url: 'https://huggingface.co/ggml-org/whisper-vad' } satisfies SpeechLicense
} as const

/**
 * Version of the speech helper's output. Part of every cache key (finished transcript parts,
 * the speech detector's results), so a helper that forms words or speech differently never
 * reuses an older result.
 */
export const ENGINE_VERSION = 'ssw-speech/1'

/** The speech detector always runs on one thread: on four it was 5 to 20 times slower. */
export const VAD_THREADS = 1

const IDS: readonly string[] = SPEECH_MODELS.map((m) => m.id)

export const isSpeechModelId = (v: unknown): v is SpeechModelId => typeof v === 'string' && IDS.includes(v)

/** The catalog entry of `id`; null for anything that is not a catalog id (paths and URLs included). */
export function speechModel(id: unknown): SpeechModelSpec | null {
  return isSpeechModelId(id) ? SPEECH_MODELS.find((m) => m.id === id)! : null
}

/** The pinned download address of `spec` (its own repository, else SPEECH_MODEL_REPO); `base` replaces the repository (tests only, never in a packaged app). */
export function modelUrl(spec: Pick<SpeechModelSpec, 'file' | 'repo'>, base?: string): string {
  const from = spec.repo ?? SPEECH_MODEL_REPO
  const root = base ?? `${SPEECH_MODEL_REPO.host}/${from.repo}/resolve/${from.commit}`
  return `${root.replace(/\/+$/, '')}/${spec.file}`
}

/** Why this PC may not download or use a model: too little memory in all, or a processor that runs only the compatible build. */
export type SpeechModelBlock = 'memory' | 'processor'

/**
 * Why this PC may not download or use `spec`, or null when it may. Memory: an "8 GB" PC can
 * report as little as 7 GB (memory kept by the graphics chip), so the bar is one GB under
 * minTotalMemGB. Processor: `build` 'compatible' and a model that needs the standard build.
 */
export function speechModelBlock(spec: Pick<SpeechModelSpec, 'minTotalMemGB' | 'needsStandardBuild'>, pc: { totalMemBytes: number; build: 'standard' | 'compatible' | 'host' | null }): SpeechModelBlock | null {
  if (spec.minTotalMemGB !== undefined && !(pc.totalMemBytes >= (spec.minTotalMemGB - 1) * 2 ** 30)) return 'memory'
  if (spec.needsStandardBuild && pc.build === 'compatible') return 'processor'
  return null
}

/** Engine threads for transcription: one core is left for the editor, at most 8 (more barely helps). */
export function speechThreads(cores: number): number {
  const n = Number.isFinite(cores) ? Math.floor(cores) : 1
  return Math.min(8, Math.max(1, n - 1))
}

/**
 * Memory a transcription with `spec` needs, MB: the engine's measured peak, one part of
 * 16 kHz float samples (64 KB a second) and some headroom. Below this much free memory the
 * Captions tab warns (it never refuses).
 */
export function memoryNeedMB(spec: Pick<SpeechModelSpec, 'ramMB' | 'partSeconds'>): number {
  return Math.round(spec.ramMB + spec.partSeconds * 0.064 + 50)
}
