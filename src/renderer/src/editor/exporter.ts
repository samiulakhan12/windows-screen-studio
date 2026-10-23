import { outputSize } from '../../../shared/engine/layout'
import { frameTimes } from '../../../shared/engine/project'
import type { ExportSettings, Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'
import { createVideo, seekTo, whenReady } from './media'

export interface ExportInput {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
  settings: ExportSettings
  outputPath: string
  onProgress: (fraction: number) => void
  signal: AbortSignal
}

/** Effective export parameters (GIFs are capped to keep files shareable). */
export function exportDimensions(project: Project, settings: ExportSettings): { width: number; height: number; fps: number } {
  const gif = settings.format === 'gif'
  const height = gif ? Math.min(settings.resolution, 540) : settings.resolution
  const size = outputSize(project.style.aspectRatio, project.width, project.height, height)
  return { ...size, fps: gif ? 15 : settings.fps }
}

/**
 * Renders every frame through the same compositor as the preview and streams raw
 * RGBA frames to ffmpeg in the main process.
 */
export async function exportVideo(input: ExportInput): Promise<void> {
  const { project, settings, signal } = input
  const { width, height, fps } = exportDimensions(project, settings)
  const screen = createVideo(input.screenUrl)
  const webcam = input.webcamUrl && project.webcam.show ? createVideo(input.webcamUrl) : null
  screen.muted = true
  if (webcam) webcam.muted = true
  await whenReady(screen)
  if (webcam) await whenReady(webcam)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false })!

  const { start, end } = project.trim
  await window.api.exportStart(project.id, {
    width,
    height,
    fps,
    format: settings.format,
    quality: settings.quality,
    audio: project.hasAudio && settings.format === 'mp4' ? { start, end } : undefined,
    outputPath: input.outputPath
  })

  try {
    const times = frameTimes(start, end, fps)
    for (let i = 0; i < times.length; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
      const t = times[i]
      await Promise.all([seekTo(screen, t), webcam ? seekTo(webcam, t - project.webcamOffset) : Promise.resolve()])
      drawFrame(ctx, width, height, t, input.scene, { screen, webcam, background: input.background })
      const pixels = ctx.getImageData(0, 0, width, height).data
      await window.api.exportFrame(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength))
      input.onProgress((i + 1) / times.length)
    }
    await window.api.exportFinish()
  } catch (err) {
    await window.api.exportCancel()
    throw err
  } finally {
    screen.removeAttribute('src')
    screen.load()
    webcam?.removeAttribute('src')
    webcam?.load()
  }
}
