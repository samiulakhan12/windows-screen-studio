/**
 * The export dialog's settings rows as data (docs/design/output-and-languages.md §2.1): which chips
 * show, which are disabled and why (message keys), each row's hint, and the picks that switch other
 * settings in the same step. Pure. Part P5 writes it; the contracts' stubs keep today's rows.
 */
import type { FfmpegVideoEncoder } from '../api/export'
import type { MessageKey } from '../i18n/t'
import type { ExportCodec, ExportFps, ExportSettings } from '../types'
import type { ExportOptions } from './exportPresets'

/** What this PC can make, as the dialog knows it (the HEVC probe may still run). */
export interface CodecUiCaps {
  hevc: 'probing' | 'none' | FfmpegVideoEncoder[] | 'webcodecs'
  av1Gpu: boolean
  h264Gpu: boolean
}

/** A chip of a row: its value, and why it is disabled (a message key), or null. */
export interface RowChip<V> {
  value: V
  disabled: MessageKey | null
}

/** The rows the dialog shows for the current settings (null: the row is hidden). */
export interface RowsState {
  codec: { chips: RowChip<ExportCodec>[]; hint: MessageKey | null; notice: MessageKey | null } | null
  background: { chips: RowChip<'with' | 'background' | 'overlays'>[]; hint: MessageKey | null } | null
  fps: { chips: RowChip<ExportFps>[]; reason: MessageKey | null }
  quality: { labels: 'delivery' | 'intermediate'; hidden: boolean }
  targetSize: { disabled: MessageKey | null }
  encoder: { hidden: boolean; softwareDisabled: MessageKey | null }
}

/** The rows for `o`. Part P5; the stub gives today's rows. */
export function settingsRows(o: ExportOptions, caps: CodecUiCaps, ctx: { seeThrough: boolean; size: { width: number; height: number }; seconds: number }): RowsState {
  void o
  void caps
  void ctx
  return {
    codec: null,
    background: null,
    fps: { chips: [30, 60].map((value) => ({ value: value as ExportFps, disabled: null })), reason: null },
    quality: { labels: 'delivery', hidden: false },
    targetSize: { disabled: null },
    encoder: { hidden: false, softwareDisabled: null }
  }
}

/** `o` with a codec this PC can make, and the notice that says so when it changed. Part P5. */
export function usableCodec(o: ExportOptions, caps: CodecUiCaps): { options: ExportOptions; notice: MessageKey | null } {
  void caps
  return { options: o, notice: null }
}

/** Picks a codec (Background back to With background when it cannot carry transparency). Part P5. */
export function pickCodec(o: ExportOptions, codec: ExportCodec): ExportOptions {
  void codec
  return o
}

/** Picks a background, switching the codec in the same step and giving it back on With background (§2.1). Part P5. */
export function pickBackground(o: ExportOptions, alpha: ExportSettings['alpha'] | undefined, replaced: ExportCodec | null): { options: ExportOptions; replaced: ExportCodec | null } {
  void alpha
  return { options: o, replaced }
}

/** Picks a frame rate. Part P5. */
export function pickFps(o: ExportOptions, fps: ExportFps): ExportOptions {
  void fps
  return o
}

/** Picks a resolution (4K at 120 fps with H.264 → 60 fps). Part P5. */
export function pickResolution(o: ExportOptions, r: ExportSettings['resolution']): ExportOptions {
  void r
  return o
}

/** The size line under the preview: "1080×1350 · 30 fps · HEVC · 2:14" (Latin digits). Part P5. */
export function sizeLine(o: ExportOptions, size: { width: number; height: number }, seconds: number): string {
  void o
  void size
  void seconds
  return ''
}
