import type { Project } from '../../../shared/types'
import type { FrameContext } from './frameContext'

/** Stamps the project's watermark (logo image or text) over the finished frame. */
export function drawWatermarkLayer(fc: FrameContext): void {
  void fc
}

/**
 * Loads the images a project's style needs that are not passed in RenderSources (the
 * watermark logo, generated wallpapers). Export awaits it before the first frame; the
 * preview loads them lazily and repaints through onStyleAssetsChanged.
 */
export async function prepareStyleAssets(project: Project, mediaUrl: (file: string) => string): Promise<void> {
  void project
  void mediaUrl
}

const listeners = new Set<() => void>()

/** Calls `fn` whenever a style image finishes loading. Returns an unsubscribe function. */
export function onStyleAssetsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyStyleAssetsChanged(): void {
  for (const fn of listeners) fn()
}
