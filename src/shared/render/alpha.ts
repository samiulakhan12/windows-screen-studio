/**
 * Transparent exports (docs/design/output-and-languages.md §6): which background an export draws
 * see-through, whether anything would be see-through at all, and the Background row's standing hint.
 * Pure: the compositor draws what alphaOf says, the dialog asks seeThrough before it shows the hint.
 */
import type { MessageKey } from '../i18n/t'
import type { Project } from '../types'
import { visibleSize } from '../engine/crop'
import { frameInsets, frameOf } from '../engine/deviceFrames'
import { cameraBoxShown, intersectRect, sceneLayout, type Rect } from '../engine/layout'
import { tiltOf } from '../engine/tilt'
import type { ExportOptions } from './exportPresets'
import { canAlpha, codecOf } from './proFormats'

/**
 * The RenderScene.alpha an export draws with (§6.1): its Background when the format and codec can
 * carry transparency (canAlpha, the policy included), else undefined, an opaque frame as before.
 */
export function alphaOf(o: ExportOptions): 'background' | 'overlays' | undefined {
  const alpha = o.alpha
  if (alpha !== 'background' && alpha !== 'overlays') return undefined
  return canAlpha(o.format, codecOf(o)) ? alpha : undefined
}

/** Points tested across the frame, per side (a 9 × 9 grid of pixel centres, the edges included). */
const GRID = 8

/** The card's outline at rest: the recording's rectangle with a device frame's chrome around it (styleContentRect's insets). */
function cardOutline(screen: Rect, project: Project, srcW: number, srcH: number): Rect {
  const frame = frameOf(project.style)
  if (!frame) return screen
  const ins = frameInsets(frame.kind, srcW > srcH)
  const u = Math.min(screen.w, screen.h)
  return { x: screen.x - ins.left * u, y: screen.y - ins.top * u, w: screen.w + (ins.left + ins.right) * u, h: screen.h + (ins.top + ins.bottom) * u }
}

/** Whether the opaque card (and a camera card drawn fully opaque) cover a `w`×`h` frame of `project` at source time `t`. */
function covered(project: Project, w: number, h: number, srcW: number, srcH: number, t: number): boolean {
  const layout = sceneLayout(project, w, h, srcW, srcH, t)
  const card = layout.follow ? intersectRect(layout.follow.slot, layout.screen) : cardOutline(layout.screen, project, srcW, srcH)
  const rects = [card]
  if (cameraBoxShown(layout.camera) && layout.camera.opacity >= 1) rects.push(layout.camera.rect)
  // A sliver at the edges (a 1918-pixel recording in a 1920-pixel frame) is not worth a hint.
  const slack = 0.5 + 0.01 * Math.min(w, h)
  const inside = (x: number, y: number): boolean => rects.some((r) => x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + r.h + slack)
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (!inside(0.5 + ((w - 1) * i) / GRID, 0.5 + ((h - 1) * j) / GRID)) return false
    }
  }
  return true
}

/**
 * Whether a `w`×`h` frame of `project` drawn with `alpha` has anything see-through (§6.1). Overlays
 * only always has. Transparent has unless the card fills the frame all the time: at rest, under each
 * camera layout, never pulled back by a zoom and never tilted (aspect Project on auto with padding 0
 * is the usual case). `project` is the one the export draws (exportProject, in its shape).
 */
export function seeThrough(project: Project, alpha: 'background' | 'overlays', w: number, h: number): boolean {
  if (alpha === 'overlays') return true
  const src = visibleSize(project)
  if (!(src.width > 0 && src.height > 0 && w > 0 && h > 0)) return true
  // A tilted card (one turned, or leaning toward the cursor) or one a zoom pulls back leaves the frame around it.
  const tilt = tiltOf(project)
  if (tilt && (tilt.rotateX !== 0 || tilt.rotateY !== 0 || tilt.animate === 'cursor')) return true
  if (project.zooms.some((z) => z.scale < 1)) return true
  const times = [0, ...(project.layouts ?? []).map((s) => (s.start + s.end) / 2)]
  return times.some((t) => !covered(project, w, h, src.width, src.height, t))
}

/**
 * The Background row's standing hint (§2.1, §6.1): that nothing would be see-through (Transparent
 * while the card fills the frame), else where a transparent file plays; null for an opaque export.
 * The hints after a click (the codec switched or given back) are the dialog's.
 */
export function alphaHint(o: ExportOptions, canSeeThrough: boolean): MessageKey | null {
  const alpha = alphaOf(o)
  if (!alpha) return null
  return alpha === 'background' && !canSeeThrough ? 'alpha.hint.fills' : 'alpha.hint.plays'
}
