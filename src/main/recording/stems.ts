import { promises as fs } from 'node:fs'
import path from 'node:path'
import { STEM_KINDS, type StemKind } from '../../shared/audio/settings'
import type { RecordingManifest } from '../projects'

/**
 * Raw files of the microphone and system sound recorded on their own ("stems"), next to the
 * mixed sound. Processing turns each into <kind>.m4a, aligned with the screen proxy.
 */
export const STEM_RAW: Record<StemKind, string> = { mic: 'mic.webm', system: 'system.webm' }

/**
 * What a recording's manifest also says about its stems: the sources mixed into its sound,
 * each also being recorded on its own; emptied once one of them stopped early. Stems are
 * kept only as this complete set, so a project's missing stem always means a source that was
 * not recorded (never one whose sound would then be lost). Older manifests have none.
 */
type StemManifest = RecordingManifest & { stems?: unknown }

/** Logged when the stems are given up (the recording itself goes on). */
export const STEMS_DROPPED = 'A sound source stopped being recorded on its own: the recording keeps only its mixed sound.'

/** Known stem kinds in `value` (read from disk or sent by the recorder), each once. */
export const stemKindsOf = (value: unknown): StemKind[] => (Array.isArray(value) ? STEM_KINDS.filter((k) => value.includes(k)) : [])

/** The stems a recording keeps when every one of them was recorded to the end. */
export const expectedStems = (m: RecordingManifest): StemKind[] => stemKindsOf((m as StemManifest).stems)

export function setExpectedStems(m: RecordingManifest, kinds: unknown): void {
  Object.assign(m, { stems: stemKindsOf(kinds) })
}

/**
 * On stop: whether every expected stem was recorded to the end (`recorded`, from the
 * recorder). If not, none is kept: the manifest expects none and every raw stem file goes.
 */
export async function settleStems(m: RecordingManifest, dir: string, recorded: unknown): Promise<StemKind[]> {
  const expected = expectedStems(m)
  const done = stemKindsOf(recorded)
  const keep = expected.length > 0 && expected.every((k) => done.includes(k)) ? expected : []
  if (keep.length < expected.length) console.warn(STEMS_DROPPED)
  setExpectedStems(m, keep)
  await discardStems(dir, keep)
  return keep
}

/** Removes the raw files of stems not in `keep`. */
export async function discardStems(dir: string, keep: readonly StemKind[]): Promise<void> {
  for (const kind of STEM_KINDS) {
    if (keep.includes(kind)) continue
    await fs.rm(path.join(dir, STEM_RAW[kind]), { force: true, maxRetries: 3 }).catch((err) => console.warn(`Could not remove the ${kind} sound file:`, err))
  }
}
