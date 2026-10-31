/**
 * Synthesised pop and ding sounds for graphics, and bleep tones (docs/design/captions-studio.md
 * §10.6, §11.7): the same partials in the preview (Web Audio) and the export (ffmpeg).
 *
 * CONTRACT (part P2): signatures are frozen; bodies are to be written. POP_SOUNDS holds the
 * partials of §10.6.
 */
import type { Project } from '../types'

/** The body of a frozen signature part P2 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P2)`)
}

/** Decaying sine partials (Hz, amplitude, decay constant in s) and length (s). */
export const POP_SOUNDS: Readonly<Record<'pop' | 'ding', { partials: readonly { freq: number; amp: number; tau: number }[]; duration: number }>> = {
  pop: {
    partials: [
      { freq: 520, amp: 0.55, tau: 0.04 },
      { freq: 1040, amp: 0.25, tau: 0.02 },
      { freq: 2600, amp: 0.08, tau: 0.006 }
    ],
    duration: 0.12
  },
  ding: {
    partials: [
      { freq: 1320, amp: 0.4, tau: 0.35 },
      { freq: 2640, amp: 0.12, tau: 0.18 },
      { freq: 3960, amp: 0.05, tau: 0.08 }
    ],
    duration: 0.9
  }
}

/** The pops of the project's graphics: output times on the captions' clock. */
export function popJob(project: Project): { times: number[]; sound: 'pop' | 'ding' }[] {
  return notImplemented('popJob', project)
}

/** The bleep tones (output seconds, split at cuts). */
export function toneJob(project: Project): { start: number; end: number }[] {
  return notImplemented('toneJob', project)
}

/** One sound's samples at `rate`. */
export function popWaveform(sound: 'pop' | 'ding', rate: number): Float32Array {
  return notImplemented('popWaveform', sound, rate)
}

/** The ffmpeg source expression of one sound. */
export function popSoundSource(sound: 'pop' | 'ding'): string {
  return notImplemented('popSoundSource', sound)
}
