import type { Range } from '../../../../shared/audio/activity'
import type { ScanStats } from '../../../../shared/audio/soundsScan'

/** Messages to the sound finder's worker (sounds.worker.ts): one source per worker. */
export type ToWorker =
  /** Load the model and get ready for a source whose windows inside `skip` (speech) need no classifying. */
  | { type: 'start'; skip: Range[] | null }
  /** 16 kHz mono float samples (transferred). */
  | { type: 'chunk'; samples: ArrayBuffer }
  /** The source's sound ended. */
  | { type: 'end' }

/** Messages from the worker. */
export type FromWorker =
  /** The model is loaded: chunks may come. */
  | { type: 'ready' }
  /** A chunk is done: `seconds` of sound received so far. */
  | { type: 'progress'; seconds: number }
  /** The source's scores: n windows × SCORE_COLUMNS bytes (transferred). */
  | { type: 'done'; n: number; scores: ArrayBuffer; stats: ScanStats }
  /** The model could not load or a window could not be classified. */
  | { type: 'failed'; reason: string }
