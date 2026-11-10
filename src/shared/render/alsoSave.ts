/**
 * Also save: sound stems and timelines (docs/design/output-and-languages.md §2.3, §8.5): when each is
 * blocked and why (message keys), which editors open which codec, and the stems hint. Pure. Part P5
 * writes the functions; EDITOR_OPENS holds the starting values of §8.5, which only the checks on real
 * installations of §0 decision 14 change.
 */
import type { SoundStem, TimelineEditor, TimelineKind } from '../api/export'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'
import type { ExportCodec } from '../types'
import type { ExportOptions } from './exportPresets'
import { codecOf, FORMAT_CODECS, MB_PER_MINUTE_1080P60 } from './proFormats'

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

/** Why Sound stems cannot be saved with this export, or null (§2.3): GIFs, batch exports and one file per chapter, and a video without sound. */
export function stemsBlocked(o: ExportOptions, mode: 'single' | 'batch', perChapter: boolean, hasSound: boolean): MessageKey | null {
  if (o.format === 'gif') return 'stems.blocked.gif'
  if (mode === 'batch') return 'stems.blocked.batch'
  if (perChapter) return 'stems.blocked.perChapter'
  if (!hasSound) return 'stems.blocked.silent'
  return null
}

/** Why a timeline cannot be saved with this export (GIF, batch, one file per chapter, M4A and WAV), or null (§2.3). */
export function timelineBlocked(o: ExportOptions, mode: 'single' | 'batch', perChapter: boolean): MessageKey | null {
  if (o.format === 'gif') return 'stems.blocked.gif'
  if (mode === 'batch') return 'stems.blocked.batch'
  if (perChapter) return 'stems.blocked.perChapter'
  if (o.format === 'm4a' || o.format === 'wav') return 'timelines.blocked.needsVideo'
  return null
}

/** The codec the timeline's editor opens: the export's own with This export; the recordings' copies (H.264 and WAV) otherwise. */
const openedCodec = (o: ExportOptions, media: 'export' | 'recordings'): ExportCodec | null => (media === 'export' && FORMAT_CODECS[o.format].length > 0 ? codecOf(o) : null)

/**
 * Why `editor` cannot be chosen, or null (§2.3): an EDL holds the finished video only, and an editor
 * that cannot open the export's codec (EDITOR_OPENS 'no': Final Cut Pro with VP9 or AV1) is blocked.
 * The message names the codec ({codec}).
 */
export function editorBlocked(editor: TimelineEditor, o: ExportOptions, media: 'export' | 'recordings'): MessageKey | null {
  if (editor === 'edl' && media === 'recordings') return 'timelines.blocked.edlRecordings'
  const codec = openedCodec(o, media)
  if (codec && EDITOR_OPENS[editor][codec] === 'no') return 'timelines.blocked.finalcutCodec'
  return null
}

/** The warning line under `editor` for a pair not yet checked on a real installation (EDITOR_OPENS 'unchecked'), or null. Names {editor} and {codec}. */
export function editorWarning(editor: TimelineEditor, o: ExportOptions, media: 'export' | 'recordings'): MessageKey | null {
  const codec = openedCodec(o, media)
  return codec && EDITOR_OPENS[editor][codec] === 'unchecked' ? 'timelines.unchecked' : null
}

/** The timeline files the chosen editors need, each once: Resolve and Final Cut Pro share one FCPXML. */
export function timelineKindsFor(editors: readonly TimelineEditor[]): TimelineKind[] {
  const kinds = new Set(editors.map((e): TimelineKind => (e === 'premiere' ? 'xmeml' : e === 'edl' ? 'edl' : 'fcpxml')))
  return (['fcpxml', 'xmeml', 'edl'] as const).filter((k) => kinds.has(k))
}

/** Bytes of one stem a second: 32-bit float stereo at 48 kHz (§7.8), from the stem's megabytes a minute. */
const STEM_BYTES_PER_SECOND = (MB_PER_MINUTE_1080P60.stem * 1e6) / 60

/** Each stem's name in the UI language. */
const STEM_NAMES: Readonly<Record<SoundStem, MessageKey>> = {
  voice: 'stems.name.voice',
  system: 'stems.name.system',
  recording: 'stems.name.recording',
  music: 'stems.name.music',
  effects: 'stems.name.effects'
}

/** "Saves Voice, System sound and Music (32-bit float WAV, about 23 MB each)." for a video of `seconds`; empty without stems. */
export function stemsHint(stems: readonly SoundStem[], seconds: number): string {
  if (stems.length === 0) return ''
  const list = fmt.list(stems.map((s) => t(STEM_NAMES[s])))
  return t('stems.hint.saves', { list, size: fmt.bytes(STEM_BYTES_PER_SECOND * Math.max(0, seconds)) })
}
