import { useEffect, useMemo, useRef, useState } from 'react'
import { exportPreviewSize, exportProject, exportSize } from '../../../shared/render/exportPlan'
import type { ExportOptions } from '../../../shared/render/exportPresets'
import type { Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'
import { CameraMaskPreparer, onCameraMasksChanged } from '../render/segmentation/cameraMasks'
import { webcamLook } from '../../../shared/engine/webcamData'
import { onStyleAssetsChanged } from '../render/watermarkLayer'
import { createVideo, SCREEN_PROXY_FPS, seekToFrame, WEBCAM_PROXY_FPS, whenReady } from './media'
import { planOf } from '../../../shared/engine/freeze'
import { frameVideoTime, joinAt, joinPlan } from '../../../shared/render/joins'
import { JoinStills } from './joinStills'

interface Props {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
  options: ExportOptions
  /** Source (recording) seconds of the frame to show. */
  time: number
  /** Source seconds of its sound (the camera, captions and background follow it): a freeze frame's picture differs (E-11). */
  soundTime?: number
  /** Inside a freeze frame: drawn sharp, as the export draws it. */
  held?: boolean
  /** Largest size of the picture in CSS pixels. */
  box: { width: number; height: number }
}

/** A camera still's person mask, when the camera's background is blurred (A* shows it blurred, as the export does). */
function segmentStill(project: Project): (still: ImageBitmap) => Promise<void> {
  let masker: CameraMaskPreparer | null = null
  return async (still) => {
    if (!(webcamLook(project.webcam).backgroundBlur > 0)) return
    masker ??= new CameraMaskPreparer()
    if (await masker.start()) await masker.prepare({ image: still, width: still.width, height: still.height })
  }
}

/**
 * The export's frame at `time` in its own shape (a Reels preset shows 9:16), drawn by the
 * same compositor at a small size. It owns two paused video elements, so the editor's
 * player is never moved; nothing is drawn unless the time or the look changes.
 */
export function ExportPreview(props: Props): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const media = useRef<{ screen: HTMLVideoElement; webcam: HTMLVideoElement | null } | null>(null)
  // Smooth cuts (editing polish §5.8): A* of a cut whose window holds the frame, made on demand.
  const joinStills = useRef<JoinStills | null>(null)
  const [stillsReady, setStillsReady] = useState(0)
  const [frameTime, setFrameTime] = useState<{ t: number; sound: number } | null>(null)
  // The camera's background blur: redraw when a frame's person mask arrives.
  const [masks, setMasks] = useState(0)
  useEffect(() => onCameraMasksChanged(() => setMasks((n) => n + 1)), [])
  // Images, GIFs, fonts and the logo load in the background: redraw when one arrives.
  const [assets, setAssets] = useState(0)
  useEffect(() => onStyleAssetsChanged(() => setAssets((n) => n + 1)), [])
  const project = useMemo(() => exportProject(props.project, { aspect: props.options.aspect }), [props.project, props.options.aspect])
  // The scene keeps the project as drawn (cropped: the view), with the export's aspect ratio.
  const drawn = useMemo(
    () => (props.scene.project === props.project ? project : exportProject(props.scene.project, { aspect: props.options.aspect })),
    [project, props.project, props.scene.project, props.options.aspect]
  )
  const scene = useMemo(() => (drawn === props.scene.project ? props.scene : { ...props.scene, project: drawn }), [drawn, props.scene])
  const size = exportSize(project, props.options)
  const { css, pixels } = exportPreviewSize(size, props.box, window.devicePixelRatio || 1)

  useEffect(() => {
    const screen = createVideo(props.screenUrl)
    screen.muted = true
    const webcam = props.webcamUrl ? createVideo(props.webcamUrl) : null
    if (webcam) webcam.muted = true
    media.current = { screen, webcam }
    return () => {
      media.current = null
      joinStills.current?.dispose()
      joinStills.current = null
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
    const sound = props.soundTime ?? t
    const camT = sound - props.project.webcamOffset
    void (async () => {
      try {
        await whenReady(m.screen)
        await Promise.all([seekToFrame(m.screen, t, SCREEN_PROXY_FPS), m.webcam ? whenReady(m.webcam).then(() => seekToFrame(m.webcam!, Math.max(0, camT), WEBCAM_PROXY_FPS)) : null])
        if (live) setFrameTime({ t, sound })
      } catch {
        // The preview is a convenience: the export reports real failures.
      }
    })()
    return () => {
      live = false
    }
  }, [props.time, props.soundTime, props.project.webcamOffset, props.screenUrl, props.webcamUrl])

  useEffect(() => {
    const c = canvas.current
    const m = media.current
    if (!c || !m || frameTime === null) return
    const { width: w, height: h } = pixels
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
    const ctx = c.getContext('2d', { alpha: false })
    if (!ctx) return
    // The frame's video time and the join it is in, with A* once it is ready (a hard cut until then).
    const windows = joinPlan(project)
    let extras: Parameters<typeof drawFrame>[8]
    if (windows.length > 0) {
      const video = frameVideoTime(project.clips, planOf(project), frameTime.sound, null, null)
      const at = joinAt(windows, video)
      let still: CanvasImageSource | null = null
      if (at?.window.still) {
        joinStills.current ??= new JoinStills(props.screenUrl, props.webcamUrl, () => setStillsReady((n) => n + 1), segmentStill(project))
        joinStills.current.prepare([at.window], scene, w, h, props.background)
        still = joinStills.current.still(at.window, w, h)
      }
      extras = { video, join: at ? { at, still } : null }
    }
    drawFrame(ctx, w, h, frameTime.t, scene, { screen: m.screen, webcam: m.webcam, background: props.background }, { frameInterval: 1 / size.fps, blurSamples: props.held ? 1 : 4 }, frameTime.sound, extras)
  }, [frameTime, scene, project, props.background, props.held, props.screenUrl, props.webcamUrl, pixels.width, pixels.height, size.fps, masks, assets, stillsReady])

  return <canvas ref={canvas} className="export-preview-canvas" style={{ width: css.width, height: css.height }} />
}
