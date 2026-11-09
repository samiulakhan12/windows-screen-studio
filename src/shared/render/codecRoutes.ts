/**
 * Routes for the codecs added in wave 12 and for transparent exports (docs/design/output-and-languages.md
 * §5.3): which encoders to try, in order, for HEVC, AV1, VP9 with alpha and the editing formats. Pure.
 *
 * Part P1 writes it; the contracts' stub gives no route, so nothing can export a new codec before P1.
 */
import type { Av1Encoder, ExportCapabilities, HevcEncoder } from '../api/export'
import type { ExportRoute } from './exportPlan'
import type { ExportOptions } from './exportPresets'

/** What this PC can make: WebCodecs on the GPU, and the GPU encoders the probe found, best first (§5.9). */
export interface CodecCaps {
  webcodecs: { hevc: boolean; av1: boolean }
  gpu: { hevc: HevcEncoder[]; av1: Av1Encoder[] }
  overrides: ExportCapabilities['overrides']
}

/** The routes to try for a non-default codec or a transparent export, in order (§5.3). Part P1. */
export function codecRoutes(o: Pick<ExportOptions, 'format' | 'codec' | 'alpha' | 'encoder' | 'targetSizeMB' | 'resolution' | 'aspect'>, caps: CodecCaps, size: { width: number; height: number }): ExportRoute[] {
  void o
  void caps
  void size
  return []
}

/** Whether AMD's AV1 encoder in this ffmpeg build makes `width`×`height` without padding it (§5.4). Part P1. */
export function amfAv1Fits(width: number, height: number): boolean {
  void width
  void height
  return false
}
