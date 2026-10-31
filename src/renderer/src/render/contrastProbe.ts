/**
 * The contrast meter's measurement (docs/design/captions-studio.md §7.3): only while paused and
 * after a seek, never during playback. The frame at the playhead is drawn without captions by the
 * same path as the preview and the export (drawFrame with `captions.show` false) into a small
 * canvas made with `willReadFrequently` (a CPU canvas, so reading it never stalls the GPU
 * preview), and the pixels under the caption block are measured against the look's text colour
 * (colors.ts measuredContrast: the 10th percentile of the ratio).
 *
 * The preview registers where its frame comes from (setContrastSource: the scene and the player's
 * elements, seeked to the playhead); without it there is nothing to measure and the meter keeps
 * the static figure.
 */
import { measuredContrast } from '../../../shared/captions/colors'
import type { CaptionStudio, Project } from '../../../shared/types'
import { drawFrame, type RenderScene, type RenderSources } from './compositor'
import { studioBlockAt } from './studioLayer'

/** Where the preview's frame comes from: the scene it draws and its sources at the playhead. */
export type ContrastSource = () => { scene: RenderScene; sources: RenderSources; width: number; height: number } | null

let source: ContrastSource | null = null

/** Registers the preview's frame source (null when the editor closes). */
export function setContrastSource(next: ContrastSource | null): void {
  source = next
}

/** The probe's canvas: 320 px on its long side, the output's shape. */
const PROBE_SIDE = 320

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null

function probeCanvas(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  if (!canvas) {
    canvas = document.createElement('canvas')
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  return ctx
}

/**
 * The measured contrast of `studio`'s text over the video at source time `t`, or null when there
 * is no frame to read or no caption shows there. `at` is the time measured (the meter's "at 0:42").
 */
export async function probeContrast(project: Project, t: number, studio: CaptionStudio): Promise<{ ratio: number; at: number } | null> {
  const from = source?.()
  if (!from || !project.captions) return null
  const scale = PROBE_SIDE / Math.max(from.width, from.height, 1)
  const w = Math.max(2, Math.round(from.width * scale))
  const h = Math.max(2, Math.round(from.height * scale))
  const c = probeCanvas(w, h)
  if (!c) return null
  // The frame without captions, as the preview and the export draw it.
  const hidden: Project = { ...from.scene.project, captions: { ...project.captions, show: false } }
  drawFrame(c, w, h, t, { ...from.scene, project: hidden }, from.sources, { blurSamples: 1 })
  // Where the look's block goes at t in this frame.
  const shown: Project = { ...project, captions: { ...project.captions, show: true, studio } }
  const block = studioBlockAt(c, shown, t, w, h)
  if (!block) return null
  const x = Math.max(0, Math.floor(block.box.x))
  const y = Math.max(0, Math.floor(block.box.y))
  const bw = Math.min(w - x, Math.ceil(block.box.w))
  const bh = Math.min(h - y, Math.ceil(block.box.h))
  if (bw <= 0 || bh <= 0) return null
  const pixels = c.getImageData(x, y, bw, bh).data
  return { ratio: measuredContrast(studio, pixels), at: t }
}
