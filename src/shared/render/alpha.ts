/**
 * Transparent exports (docs/design/output-and-languages.md §6): which background an export draws
 * see-through, and whether anything would be see-through at all. Pure. Part P2 writes it; the
 * contracts' stub draws every export opaque, as before.
 */
import type { Project } from '../types'
import type { ExportOptions } from './exportPresets'

/** The RenderScene.alpha an export draws with ('background' or 'overlays'), or undefined for an opaque frame (§6.1). Part P2. */
export function alphaOf(o: ExportOptions): 'background' | 'overlays' | undefined {
  void o
  return undefined
}

/** Whether a `w`×`h` frame of `project` drawn with `alpha` has anything see-through: false when the card fills the frame (§6.1). Part P2. */
export function seeThrough(project: Project, alpha: 'background' | 'overlays', w: number, h: number): boolean {
  void project
  void alpha
  void w
  void h
  return false
}
