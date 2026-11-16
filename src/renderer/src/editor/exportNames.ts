/**
 * The export's names in the UI language (docs/design/output-and-languages.md §9.1): the destinations'
 * labels, a batch file's label and the encoders' names. Their tables (EXPORT_PRESETS, batchItems,
 * routeLabel's ENCODER_NAMES) stay English data in src/shared/render, because main imports those
 * modules and carries only the common, errors and main messages (test 86), and file names stay
 * English (§0 decision 10). The renderer shows these instead; English gives the tables' own text
 * (tests/i18nExportNames.test.ts holds them equal). Also save's chips and reasons likewise.
 */
import type { ExportFormat } from '../../../shared/types'
import type { FfmpegVideoEncoder } from '../../../shared/api/export'
import type { ExportRoute } from '../../../shared/render/exportPlan'
import { BATCH_ASPECTS, FORMAT_LABELS, RESOLUTION_LABELS, type BatchItem, type ExportPreset } from '../../../shared/render/exportPresets'
import type { UserExportPreset } from '../../../shared/render/userPresets'
import { perChapterBlocked, sidecarBlocked, type BundleSources, type SidecarKind } from '../../../shared/render/exportBundle'
import { fmt } from '../../../shared/i18n/fmt'
import { t, type MessageKey } from '../../../shared/i18n/t'

/** Each built-in destination's label (the gallery's cards, the settings' name, a batch file). */
const PRESET_KEYS: Readonly<Record<string, MessageKey>> = {
  'youtube-1080': 'export.preset.youtube1080',
  'youtube-4k': 'export.preset.youtube4k',
  x: 'export.preset.x',
  linkedin: 'export.preset.linkedin',
  reels: 'export.preset.reels',
  tiktok: 'export.preset.tiktok',
  shorts: 'export.preset.shorts',
  square: 'export.preset.square',
  'portrait-post': 'presets.destination.portrait.label',
  'slack-gif': 'export.preset.slackGif',
  email: 'export.preset.email',
  editing: 'presets.destination.editing.label',
  overlay: 'presets.destination.overlay.label'
}

/** A destination's label in the UI language; one this list does not know keeps its own. */
export const presetName = (p: Pick<ExportPreset, 'id' | 'label'>): string => (PRESET_KEYS[p.id] ? t(PRESET_KEYS[p.id]) : p.label)

/** What a batch file is called in the dialog: a user preset by its name, a destination by its label, an aspect as "MP4 1080p · 9:16". */
export function itemLabel(item: BatchItem, userPresets: readonly Pick<UserExportPreset, 'id'>[] = []): string {
  if (userPresets.some((u) => u.id === item.key)) return item.label
  if (item.key.startsWith('aspect:')) {
    const aspect = item.key.slice('aspect:'.length)
    if (!(BATCH_ASPECTS as readonly string[]).includes(aspect)) return item.label
    const o = item.options
    const size = o.format === 'm4a' || o.format === 'wav' ? t('export.batch.audioSize') : RESOLUTION_LABELS[o.resolution]
    return t('export.batch.aspectItem', { format: FORMAT_LABELS[o.format], size, aspect })
  }
  return presetName({ id: item.key, label: item.label })
}

/** Each ffmpeg encoder: on the graphics card or in software, and its own name (never translated). */
const ENCODERS: Readonly<Record<FfmpegVideoEncoder, { gpu: boolean; name: string }>> = {
  h264_nvenc: { gpu: true, name: 'NVIDIA NVENC' },
  h264_qsv: { gpu: true, name: 'Intel Quick Sync' },
  h264_amf: { gpu: true, name: 'AMD AMF' },
  h264_mf: { gpu: true, name: 'Media Foundation' },
  libx264: { gpu: false, name: 'x264' },
  'libvpx-vp9': { gpu: false, name: 'VP9' },
  hevc_nvenc: { gpu: true, name: 'NVIDIA NVENC' },
  hevc_qsv: { gpu: true, name: 'Intel Quick Sync' },
  hevc_amf: { gpu: true, name: 'AMD AMF' },
  hevc_mf: { gpu: true, name: 'Media Foundation' },
  libx265: { gpu: false, name: 'x265' },
  av1_nvenc: { gpu: true, name: 'NVIDIA NVENC' },
  av1_qsv: { gpu: true, name: 'Intel Quick Sync' },
  av1_amf: { gpu: true, name: 'AMD AMF' },
  'libaom-av1': { gpu: false, name: 'AV1' },
  cfhd: { gpu: false, name: 'CineForm' },
  qtrle: { gpu: false, name: 'QuickTime Animation' },
  prores_ks: { gpu: false, name: 'ProRes' }
}

/** routeLabel in the UI language: how an export's frames became a file ("GPU (NVIDIA NVENC)", "Software (x264)"). */
export function routeName(r: ExportRoute, format: ExportFormat): string {
  if (format === 'wav') return t('export.encoder.audioWav')
  if (r.video === 'none' || format === 'm4a') return t('export.encoder.audioAac')
  if (format === 'gif') return t('export.encoder.gif')
  if (r.video === 'webcodecs') {
    const name = r.codec === 'vp9' ? 'WebCodecs VP9' : r.codec === 'hevc' ? 'WebCodecs HEVC' : r.codec === 'av1' ? 'WebCodecs AV1' : 'WebCodecs'
    return r.hardware ? t('export.encoder.gpu', { name }) : t('export.encoder.webcodecsSoftware', { name })
  }
  const e = ENCODERS[r.encoder]
  return t(e.gpu ? 'export.encoder.gpu' : 'export.encoder.software', { name: e.name })
}

/** "Also save"'s chips: each file's name (exportBundle's SIDECAR_LABELS, in the UI language). */
const SIDECAR_KEYS: Readonly<Record<SidecarKind, MessageKey>> = {
  srt: 'export.sidecar.srt',
  vtt: 'export.sidecar.vtt',
  chapters: 'export.sidecar.chapters',
  thumbnail: 'export.sidecar.thumbnail',
  description: 'export.sidecar.description'
}
export const sidecarLabel = (kind: SidecarKind): string => t(SIDECAR_KEYS[kind])

/** sidecarBlocked's reason in the UI language: why `kind` cannot be saved with this export, or null. */
export function sidecarBlockedText(kind: SidecarKind, format: ExportFormat, has: BundleSources): string | null {
  if (!sidecarBlocked(kind, format, has)) return null
  if (format === 'gif') return t('export.sidecar.gifAlone')
  if (kind === 'srt' || kind === 'vtt') return t('export.sidecar.noCaptions')
  if (kind === 'chapters') return t('export.sidecar.noChapters')
  return t('export.sidecar.audioNoThumbnail')
}

/** perChapterBlocked's reason in the UI language, or null. */
export function perChapterBlockedText(has: BundleSources, mode: 'single' | 'batch'): string | null {
  if (!perChapterBlocked(has, mode)) return null
  if (mode === 'batch') return t('export.perChapter.batch')
  if (!has.chapters) return t('export.perChapter.noChapters')
  return t('export.perChapter.stillAcross')
}

/** chaptersNote in the UI language: where the video's `count` chapters end up. */
export function chaptersNoteText(count: number, gif: boolean, perChapter: boolean): string {
  const values = { count, n: fmt.count(count) }
  if (gif) return t('export.chapters.noteGif', values)
  return perChapter ? t('export.chapters.notePerChapter', values) : t('export.chapters.noteInFile', values)
}
