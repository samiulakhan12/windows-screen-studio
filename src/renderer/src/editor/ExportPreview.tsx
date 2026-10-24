import { useEffect, useMemo, useRef, useState } from 'react'
import { exportProject, exportSize } from '../../../shared/render/exportPlan'
import type { ExportOptions } from '../../../shared/render/exportPresets'
import type { Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'
import { createVideo, SCREEN_PROXY_FPS, seekToFrame, WEBCAM_PROXY_FPS, whenReady } from './media'

interface Props {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
  options: ExportOptions
  /** Source (recording) seconds of the frame to show. */
  time: number
  /** Largest size of the picture in CSS pixels. */
  box: { width: number; height: number }
}

/**
 * The export's frame at `time` in its own shape (a Reels preset shows 9:16), drawn by the
 * same compositor at a small size. It owns two paused video elements, so the editor's
 * player is never moved; nothing is drawn unless the time or the look changes.
 */
export function ExportPreview(props: Props): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const media = useRef<{ screen: HTMLVideoElement; webcam: HTMLVideoElement | null } | null>(null)
  const [frameTime, setFrameTime] = useState<number | null>(null)
  const project = useMemo(() => exportProject(props.project, { aspect: props.options.aspect }), [props.project, props.options.aspect])
  const scene = useMemo(() => (project === props.scene.project ? props.scene : { ...props.scene, project }), [project, props.scene])
  const size = exportSize(project, props.options)
  const k = Math.min(props.box.width / size.width, props.box.height / size.height)
  const css = { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) }

  useEffect(() => {
    const screen = createVideo(props.screenUrl)
    screen.muted = true
    const webcam = props.webcamUrl ? createVideo(props.webcamUrl) : null
    if (webcam) webcam.muted = true
    media.current = { screen, webcam }
    return () => {
      media.current = null
      for (const v of [screen, webcam]) {
        if (!v) continue
        v.removeAttribute('src')
        v.load()
      }
    }
  }, [props.screenUrl, props.webcamUrl])

  // Seek both videos to the wanted frame; the newest request wins.
  useEffect(() => {
    let live = true
    const m = media.current
    if (!m) return
    const t = props.time
    const camT = t - props.project.webcamOffset
    void (async () => {
      try {
        await whenReady(m.screen)
        await Promise.all([seekToFrame(m.screen, t, SCREEN_PROXY_FPS), m.webcam ? whenReady(m.webcam).then(() => seekToFrame(m.webcam!, Math.max(0, camT), WEBCAM_PROXY_FPS)) : null])
        if (live) setFrameTime(t)
      } catch {
        // The preview is a convenience: the export reports real failures.
      }
    })()
    return () => {
      live = false
    }
  }, [props.time, props.project.webcamOffset, props.screenUrl, props.webcamUrl])

  useEffect(() => {
    const c = canvas.current
    const m = media.current
    if (!c || !m || frameTime === null) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(2, Math.round(css.width * dpr))
    const h = Math.max(2, Math.round(css.height * dpr))
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
    const ctx = c.getContext('2d', { alpha: false })
    if (!ctx) return
    drawFrame(ctx, w, h, frameTime, scene, { screen: m.screen, webcam: m.webcam, background: props.background }, { frameInterval: 1 / size.fps, blurSamples: 4 })
  }, [frameTime, scene, props.background, css.width, css.height, size.fps])

  return <canvas ref={canvas} className="export-preview-canvas" style={{ width: css.width, height: css.height }} />
}
