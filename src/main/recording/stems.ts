import { promises as fs } from 'node:fs'
import path from 'node:path'
import { STEM_KINDS, type StemKind } from '../../shared/audio/settings'

/**
 * Raw files of the microphone and system sound recorded on their own ("stems"), next to the
 * mixed sound. Processing turns each into <kind>.m4a, aligned with the screen proxy.
 */
export const STEM_RAW: Record<StemKind, string> = { mic: 'mic.webm', system: 'system.webm' }

/** Removes the raw files of stems not in `keep` (they failed while recording, so they are incomplete). */
export async function discardStems(dir: string, keep: readonly StemKind[]): Promise<void> {
  for (const kind of STEM_KINDS) {
    if (keep.includes(kind)) continue
    await fs.rm(path.join(dir, STEM_RAW[kind]), { force: true, maxRetries: 3 }).catch((err) => console.warn(`Could not remove the ${kind} sound file:`, err))
  }
}
