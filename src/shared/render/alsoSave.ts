/**
 * Also save: sound stems and timelines (docs/design/output-and-languages.md §2.3, §8.5): when each is
 * blocked and why (message keys), which editors open which codec, and the stems hint. Pure. Part P5
 * writes the functions; EDITOR_OPENS holds the starting values of §8.5, which only the checks on real
 * installations of §0 decision 14 change.
 */
import type { SoundStem, TimelineEditor, TimelineKind } from '../api/export'
import type { MessageKey } from '../i18n/t'
import type { ExportCodec } from '../types'
import type { ExportOptions } from './exportPresets'

const all = (v: 'yes' | 'no' | 'unchecked'): Record<ExportCodec, 'yes' | 'no' | 'unchecked'> => ({
  h264: v,
  hevc: v,
  av1: v,
  vp9: v,
  cineform: v,
  animation: v,
  'prores-422': v,
  'prores-4444': v
})

/** Whether each editor opens each codec: 'no' blocks the editor's chip, 'unchecked' shows a warning line (§8.5). */
export const EDITOR_OPENS: Readonly<Record<TimelineEditor, Readonly<Record<ExportCodec, 'yes' | 'no' | 'unchecked'>>>> = {
  resolve: { ...all('yes'), av1: 'unchecked', vp9: 'unchecked', animation: 'unchecked' },
  premiere: { ...all('yes'), av1: 'unchecked', vp9: 'unchecked', animation: 'unchecked' },
  finalcut: { ...all('yes'), av1: 'no', vp9: 'no', cineform: 'unchecked', animation: 'unchecked' },
  edl: all('yes')
}

/** Why Sound stems cannot be saved with this export, or null. Part P5. */
export function stemsBlocked(o: ExportOptions, mode: 'single' | 'batch', perChapter: boolean, hasSound: boolean): MessageKey | null {
  void o
  void mode
  void perChapter
  void hasSound
  return null
}

/** Why a timeline cannot be saved with this export (GIF, M4A, WAV, batch, per chapter), or null. Part P5. */
export function timelineBlocked(o: ExportOptions, mode: 'single' | 'batch', perChapter: boolean): MessageKey | null {
  void o
  void mode
  void perChapter
  return null
}

/** Why `editor` cannot be chosen, or null. Part P5. */
export function editorBlocked(editor: TimelineEditor, o: ExportOptions, media: 'export' | 'recordings'): MessageKey | null {
  void editor
  void o
  void media
  return null
}

/** The warning line under `editor`, or null. Part P5. */
export function editorWarning(editor: TimelineEditor, o: ExportOptions, media: 'export' | 'recordings'): MessageKey | null {
  void editor
  void o
  void media
  return null
}

/** The timeline files the chosen editors need (Resolve and Final Cut Pro share one FCPXML). Part P5. */
export function timelineKindsFor(editors: readonly TimelineEditor[]): TimelineKind[] {
  void editors
  return []
}

/** "Saves Voice, System sound and Music (32-bit float WAV, about 23 MB each)." Part P5. */
export function stemsHint(stems: readonly SoundStem[], seconds: number): string {
  void stems
  void seconds
  return ''
}
