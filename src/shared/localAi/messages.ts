/**
 * What AI on this PC says when it cannot run or stops (docs/design/smart-tools.md §9.5, §9.9).
 * Shared by the main process (which throws them; Electron passes only the message of a rejected
 * invoke) and Settings › AI on this PC. Pure.
 */
import type { LocalAiProgress, LocalModelId, LocalModelUse } from '../api/localAi'
import { fitsFreeMemory, localModel, localModelBlock, pickLocalModel, RECOMMENDED, SMALL, type LocalModelSpec } from './catalog'

export const LOCAL_MESSAGES = {
  notInBuild: 'AI on this PC is not part of this build.',
  processorOld: "This PC's processor is too old for AI on this PC (it needs AVX2).",
  processorUnknown: "Flown could not check this PC's processor.",
  damaged: 'The model file is missing or damaged. Download it again in Settings › AI on this PC.',
  noModel: 'Download a model for AI on this PC first, in Settings › AI on this PC.',
  crashed: 'AI on this PC stopped unexpectedly. Try again, or use the Small model.',
  stalled: 'AI on this PC stopped responding. Try again.',
  stopped: 'Stopped.',
  waiting: 'Waiting for AI on this PC…',
  lowMemory: 'Memory is low: this may be slow',
  tooLong: 'This text is too long for AI on this PC: shorten it or use an AI service.',
  notesTooLong: 'These notes are too long for AI on this PC: shorten them or use an AI service.',
  written: 'Written on this PC: check it before you use it.'
} as const

/** Gigabytes with one decimal ("3.8"). */
export const gb = (bytes: number): string => (Math.max(0, bytes) / 2 ** 30).toFixed(1)
/** Whole gigabytes of memory as Windows names a PC ("8"). */
const memGb = (bytes: number): number => Math.round(Math.max(0, bytes) / 2 ** 30)

/** The PC's line in Settings: "This PC: 16 GB of memory · processor OK", or why it cannot run AI on this PC. */
export function pcLine(pc: { totalMemBytes: number; avx2: boolean | null; helper: boolean }): string {
  if (!pc.helper) return LOCAL_MESSAGES.notInBuild
  if (pc.avx2 === null) return LOCAL_MESSAGES.processorUnknown
  if (!pc.avx2) return LOCAL_MESSAGES.processorOld
  return `This PC: ${memGb(pc.totalMemBytes)} GB of memory · processor OK`
}

/** Why a model's row offers no Download (§2.5): its block in words. */
export function blockReason(spec: LocalModelSpec, block: 'memory' | 'processor' | 'helper', pc: { totalMemBytes: number; avx2: boolean | null }): string {
  if (block === 'helper') return LOCAL_MESSAGES.notInBuild
  if (block === 'processor') return pc.avx2 === null ? LOCAL_MESSAGES.processorUnknown : LOCAL_MESSAGES.processorOld
  return `Needs ${spec.minTotalMemGB} GB of memory; this PC has ${memGb(pc.totalMemBytes)} GB`
}

/** §9.5: the free memory a model needs and what is free; "or download the Small model" when Small is not downloaded. */
export function freeMemoryMessage(spec: Pick<LocalModelSpec, 'peakMB' | 'id'>, freeMemBytes: number, smallReady: boolean): string {
  const need = (spec.peakMB / 1024).toFixed(1)
  const tail = spec.id !== SMALL && !smallReady ? 'Close some apps, or download the Small model.' : 'Close some apps.'
  return `AI on this PC needs about ${need} GB of free memory and ${gb(freeMemBytes)} GB is free. ${tail}`
}

/** A model's size as Settings names it, decimal ("3.1 GB", "1.3 GB"). */
export const sizeGb = (bytes: number): string => `${(Math.max(0, bytes) / 1e9).toFixed(1)} GB`

/** "Not enough disk space: the model needs 3.2 GB." (§9.9; the file and the 64 MB spare, rounded up). */
export function diskMessage(spec: Pick<LocalModelSpec, 'bytes'>): string {
  return `Not enough disk space: the model needs ${(Math.ceil(((spec.bytes + (64 << 20)) / 1e9) * 10) / 10).toFixed(1)} GB.`
}

/** "about 2 minutes left", "less than a minute left". */
export function timeLeft(seconds: number): string {
  if (!(seconds >= 60)) return 'less than a minute left'
  const minutes = Math.round(seconds / 60)
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`
}

/** The progress line beside a busy button (§2.5): "On this PC: loading the model…", "reading the text… 45%", "writing… about 2 minutes left". */
export function progressWords(p: LocalAiProgress): string {
  switch (p.phase) {
    case 'waiting':
      return LOCAL_MESSAGES.waiting
    case 'loading':
      return 'On this PC: loading the model…'
    case 'reading':
      return `On this PC: reading the text… ${p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0}%`
    case 'writing':
      return `On this PC: writing… ${timeLeft(p.secondsLeft ?? 0)}`
  }
}

/** Words of English text a token, for the measured-speed line (§2.5). */
const WORDS_A_TOKEN = 0.75

/** "Measured on this PC: reads about 300 words a second and writes about 4." */
export function speedLine(speed: { read: number; write: number }): string {
  const words = (tps: number): number => {
    const w = tps * WORDS_A_TOKEN
    return w >= 100 ? Math.round(w / 10) * 10 : Math.max(1, Math.round(w))
  }
  return `Measured on this PC: reads about ${words(speed.read)} words a second and writes about ${words(speed.write)}.`
}

/**
 * The model a run uses now, or why none can run (§9.5): the build, the processor, nothing
 * downloaded, or the free memory (after Automatic has tried Small). A pinned choice that is
 * downloaded is used as set, and refused only when its peak does not fit in the free memory.
 */
export function localRunProblem(use: LocalModelUse, ready: readonly LocalModelId[], pc: { totalMemBytes: number; freeMemBytes: number; avx2: boolean | null; helper: boolean }): { id: LocalModelId } | { message: string } {
  if (!pc.helper) return { message: LOCAL_MESSAGES.notInBuild }
  if (pc.avx2 !== true) return { message: pc.avx2 === null ? LOCAL_MESSAGES.processorUnknown : LOCAL_MESSAGES.processorOld }
  const id = pickLocalModel(use, ready, pc)
  const smallReady = ready.includes(SMALL)
  if (id) {
    const spec = localModel(id)!
    return fitsFreeMemory(spec, pc.freeMemBytes) ? { id } : { message: freeMemoryMessage(spec, pc.freeMemBytes, smallReady) }
  }
  // None picked: the last model Automatic tried (or the pinned one) names the memory it needs.
  const candidates = (use === 'auto' ? [RECOMMENDED, SMALL] : [use]).map((m) => localModel(m)!).filter((s) => ready.includes(s.id) && !localModelBlock(s, pc))
  const last = candidates[candidates.length - 1]
  if (last) return { message: freeMemoryMessage(last, pc.freeMemBytes, smallReady) }
  const blocked = (use === 'auto' ? [RECOMMENDED, SMALL] : [use]).map((m) => localModel(m)!).find((s) => ready.includes(s.id))
  if (blocked) return { message: blockReason(blocked, localModelBlock(blocked, pc) ?? 'memory', pc) }
  return { message: LOCAL_MESSAGES.noModel }
}
