/**
 * The export's names in the UI language (docs/design/output-and-languages.md §9.1, §10.3 rule 1):
 * src/renderer/src/editor/exportNames.ts gives the renderer the destinations' labels, a batch file's
 * label, the encoders' names and Also save's chips, reasons and chapter note, while the shared tables
 * stay English data for main and for file names. In English each gives exactly the table's text.
 */
import { describe, expect, it } from 'vitest'
import type { FfmpegVideoEncoder } from '../src/shared/api/export'
import { routeLabel, type ExportRoute } from '../src/shared/render/exportPlan'
import { BATCH_ASPECTS, batchItems, EXPORT_PRESETS, normalizeOptions } from '../src/shared/render/exportPresets'
import { chaptersNote, perChapterBlocked, SIDECAR_KINDS, SIDECAR_LABELS, sidecarBlocked, type BundleSources } from '../src/shared/render/exportBundle'
import type { ExportFormat } from '../src/shared/types'
import type { BatchItem } from '../src/shared/render/exportPresets'

// The renderer's module, imported as the other renderer tests do (it is outside the node project).
const NAMES = '../src/renderer/src/editor/exportNames'
const { chaptersNoteText, itemLabel, perChapterBlockedText, presetName, routeName, sidecarBlockedText, sidecarLabel } = (await import(/* @vite-ignore */ NAMES)) as {
  presetName(p: { id: string; label: string }): string
  itemLabel(item: BatchItem, userPresets?: { id: string }[]): string
  routeName(r: ExportRoute, format: ExportFormat): string
  sidecarLabel(kind: (typeof SIDECAR_KINDS)[number]): string
  sidecarBlockedText(kind: (typeof SIDECAR_KINDS)[number], format: ExportFormat, has: BundleSources): string | null
  perChapterBlockedText(has: BundleSources, mode: 'single' | 'batch'): string | null
  chaptersNoteText(count: number, gif: boolean, perChapter: boolean): string
}

const FORMATS: ExportFormat[] = ['mp4', 'gif', 'webm', 'mov', 'm4a', 'wav']
const ENCODERS: FfmpegVideoEncoder[] = [
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_mf',
  'libx264',
  'libvpx-vp9',
  'hevc_nvenc',
  'hevc_qsv',
  'hevc_amf',
  'hevc_mf',
  'libx265',
  'av1_nvenc',
  'av1_qsv',
  'av1_amf',
  'libaom-av1',
  'cfhd',
  'qtrle',
  'prores_ks'
]

describe('the export’s names give the tables’ English', () => {
  it('names every destination as EXPORT_PRESETS labels it', () => {
    for (const p of EXPORT_PRESETS) expect(presetName(p)).toBe(p.label)
    // A destination the list does not know keeps its own label.
    expect(presetName({ id: 'future', label: 'Future place' })).toBe('Future place')
  })

  it('labels every batch file as batchItems does', () => {
    for (const format of FORMATS) {
      const current = normalizeOptions({ format, resolution: 1080 })
      const items = batchItems(
        EXPORT_PRESETS.map((p) => p.id),
        [...BATCH_ASPECTS],
        current,
        [{ id: 'u1', name: 'Client review', options: current, createdAt: '' } as never]
      )
      for (const it of items) expect(itemLabel(it, [{ id: 'u1' }])).toBe(it.label)
    }
  })

  it('names every route as routeLabel does', () => {
    const routes: ExportRoute[] = [
      { video: 'none' },
      ...ENCODERS.map((encoder): ExportRoute => ({ video: 'ffmpeg', encoder })),
      ...(['h264', 'vp9', 'hevc', 'av1'] as const).flatMap((codec) => [true, false].map((hardware): ExportRoute => ({ video: 'webcodecs', codec, hardware })))
    ]
    for (const format of FORMATS) for (const r of routes) expect(routeName(r, format)).toBe(routeLabel(r, format))
  })

  it('gives Also save’s chips, reasons and the chapter note as exportBundle writes them', () => {
    const sources: BundleSources[] = []
    for (const captions of [true, false]) for (const chapters of [true, false]) for (const stillAcross of [true, false, undefined]) sources.push({ captions, chapters, stillAcross })
    for (const k of SIDECAR_KINDS) {
      expect(sidecarLabel(k)).toBe(SIDECAR_LABELS[k])
      for (const format of FORMATS) for (const has of sources) expect(sidecarBlockedText(k, format, has)).toBe(sidecarBlocked(k, format, has))
    }
    for (const has of sources) for (const mode of ['single', 'batch'] as const) expect(perChapterBlockedText(has, mode)).toBe(perChapterBlocked(has, mode))
    for (const count of [0, 1, 2, 7, 1000]) for (const gif of [true, false]) for (const per of [true, false]) expect(chaptersNoteText(count, gif, per)).toBe(chaptersNote(count, gif, per))
  })
})
