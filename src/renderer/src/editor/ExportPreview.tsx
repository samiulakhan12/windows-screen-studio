import { useEffect, useMemo, useRef, useState } from 'react'
import { exportPreviewSize, exportProject, exportSize } from '../../../shared/render/exportPlan'
import type { ExportOptions } from '../../../shared/render/exportPresets'
import type { Project } from '../../../shared/types'
import { drawFrame, type FrameImage, type RenderScene } from '../render/compositor'
import { forOutput } from '../render/coverLayer'
import { CameraMaskPreparer, onCameraMasksChanged } from '../render/segmentation/cameraMasks'
import { webcamLook } from '../../../shared/engine/webcamData'
import { onStyleAssetsChanged } from '../render/watermarkLayer'
import { createVideo, SCREEN_PROXY_FPS, seekedFrame, seekToFrame, WEBCAM_PROXY_FPS, whenReady } from './media'
import { planOf } from '../../../shared/engine/freeze'
import { frameVideoTime, joinAt, joinPlan } from '../../../shared/render/joins'
import { alphaOf } from '../../../shared/render/alpha'
import { t } from '../../../shared/i18n/t'
import { JoinStills } from './joinStills'
import './alphaPreview.css'

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

/**
 * A sought frame: its picture and sound times, and the screen's decoded frame (null: the element is
 * drawn). The camera is drawn from its element, which the camera layer segments for a blurred background.
 */
interface Sought {
  t: number
  sound: number
  screen: VideoFrame | null
  /**
   * The screen frame's timestamp is the sought one's (true too when there is no frame to check). False
   * while it is the picture seekedFrame gave up waiting on, which under load can be the frame before.
   */
  verified: boolean
}

/**
 * How often, and how many times, a screen picture that is not yet the sought frame is taken again:
 * at least 10 s, past which a file whose timestamps never match is not checked any longer.
 */
const RECHECK_MS = 25
const RECHECKS = 400

/** The screen recording's frame rate, as its proxy was made (capture.fps; 60 for older projects). */
function screenRate(project: Project): number {
  const fps = project.capture?.fps
  return typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : SCREEN_PROXY_FPS
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
 *
 * A transparent export (output-and-languages §6.5) is drawn with the export's own RenderScene.alpha
 * into a canvas with alpha, with a checkerboard behind it in CSS: the canvas holds the export's
 * pixels, the checkerboard is never drawn into them.
 */
export function ExportPreview(props: Props): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const media = useRef<{ screen: HTMLVideoElement; webcam: HTMLVideoElement | null } | null>(null)
  // Smooth cuts (editing polish §5.8): A* of a cut whose window holds the frame, made on demand.
  const joinStills = useRef<JoinStills | null>(null)
  // The see-through background its stills were composed with: an opaque and a transparent A* are never the same still.
  const joinStillsAlpha = useRef<RenderScene['alpha']>(undefined)
  const [stillsReady, setStillsReady] = useState(0)
  const [frameTime, setFrameTime] = useState<Sought | null>(null)
  // A sought frame's screen picture is let go once another replaces it, or the preview goes.
  useEffect(() => () => frameTime?.screen?.close(), [frameTime])
  // The sought frame the canvas last drew: data-settled below says whether it is the newest request's.
  const [shown, setShown] = useState<Sought | null>(null)
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
  // A transparent export's see-through background, as the exporter sets it on its scene (§6.5).
  const alpha = alphaOf(props.options)
  const scene = useMemo(() => {
    // The export's frames: never the preview's Peek or cover outlines (auto-blur §8.5).
    const given = forOutput(props.scene)
    const shaped = drawn === given.project ? given : { ...given, project: drawn }
    return alpha ? { ...shaped, alpha } : shaped
  }, [drawn, props.scene, alpha])
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

  // The screen is sought and checked at its own rate, as the export reads its frames.
  const screenFps = screenRate(props.project)

  // Seek both videos to the wanted frame; the newest request wins.
  useEffect(() => {
    let live = true
    // The wait before the screen's picture is taken again; a newer request or closing the dialog ends it at once.
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | null = null
    const pause = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, ms)
      })
    const m = media.current
    if (!m) return
    const t = props.time
    const sound = props.soundTime ?? t
    const camT = sound - props.project.webcamOffset
    void (async () => {
      try {
        await whenReady(m.screen)
        // A newer request seeks instead: this one's seek could land after it and leave this frame on the element.
        if (!live) return
        await Promise.all([seekToFrame(m.screen, t, screenFps), m.webcam ? whenReady(m.webcam).then(() => seekToFrame(m.webcam!, Math.max(0, camT), WEBCAM_PROXY_FPS)) : null])
        // 'seeked' can come a moment before the new picture reaches the element, and the preview draws
        // once per seek: the screen is drawn from the decoded frame whose timestamp is the sought one, as
        // the export and the thumbnail draw it (seekedFrame), never the picture before.
        const seeked = await seekedFrame(m.screen, t, screenFps)
        if (!live) return void seeked?.frame.close()
        setFrameTime({ t, sound, screen: seeked?.frame ?? null, verified: seeked?.verified ?? true })
        if (!seeked || seeked.verified) return
        // seekedFrame stopped waiting before the sought frame reached the element (under load it can take
        // longer): its picture, perhaps the frame before, stays on the canvas without data-settled, and
        // the element's picture is taken again until it is the sought frame, which replaces it.
        for (let i = 0; i < RECHECKS; i++) {
          await pause(RECHECK_MS)
          if (!live) return
          const again = await seekedFrame(m.screen, t, screenFps, 0)
          if (!again) return
          if (live && again.verified) {
            setFrameTime({ t, sound, screen: again.frame, verified: true })
            return
          }
          again.frame.close()
          if (!live) return
        }
      } catch {
        // The preview is a convenience: the export reports real failures.
      }
    })()
    return () => {
      live = false
      clearTimeout(timer)
      wake?.()
    }
  }, [props.time, props.soundTime, props.project.webcamOffset, props.screenUrl, props.webcamUrl, screenFps])

  useEffect(() => {
    const c = canvas.current
    const m = media.current
    if (!c || !m || frameTime === null) return
    const { width: w, height: h } = pixels
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
    // Each look has a canvas of its own (keyed below): a context keeps the alpha it was made with.
    const ctx = c.getContext('2d', { alpha: !!scene.alpha })
    if (!ctx) return
    // The frame's video time and the join it is in, with A* once it is ready (a hard cut until then).
    const windows = joinPlan(project)
    let extras: Parameters<typeof drawFrame>[8]
    if (windows.length > 0) {
      const video = frameVideoTime(project.clips, planOf(project), frameTime.sound, null, null)
      const at = joinAt(windows, video)
      let still: CanvasImageSource | null = null
      if (at?.window.still) {
        if (joinStills.current && joinStillsAlpha.current !== scene.alpha) {
          joinStills.current.dispose()
          joinStills.current = null
        }
        joinStillsAlpha.current = scene.alpha
        joinStills.current ??= new JoinStills(props.screenUrl, props.webcamUrl, () => setStillsReady((n) => n + 1), segmentStill(project))
        joinStills.current.prepare([at.window], scene, w, h, props.background)
        still = joinStills.current.still(at.window, w, h)
      }
      extras = { video, join: at ? { at, still } : null }
    }
    const screenFrame: FrameImage | null = frameTime.screen ? { image: frameTime.screen, width: frameTime.screen.displayWidth, height: frameTime.screen.displayHeight } : null
    drawFrame(ctx, w, h, frameTime.t, scene, { screen: m.screen, webcam: m.webcam, background: props.background, screenFrame }, { frameInterval: 1 / size.fps, blurSamples: props.held ? 1 : 4 }, frameTime.sound, extras)
    setShown(frameTime)
  }, [frameTime, scene, project, props.background, props.held, props.screenUrl, props.webcamUrl, pixels.width, pixels.height, size.fps, masks, assets, stillsReady])

  // Present once the canvas holds the newest time's frame; absent before the first draw, while a
  // newer frame is sought (the canvas still shows the one before) and while the screen's picture is
  // not yet the sought frame's. A font or image that arrives later draws the same frame again.
  const settled = shown !== null && shown === frameTime && frameTime.verified && frameTime.t === props.time && frameTime.sound === (props.soundTime ?? props.time) ? '' : undefined
  if (scene.alpha) return <canvas key="alpha" ref={canvas} className="export-preview-canvas alpha-preview" role="img" aria-label={t('alpha.preview.name')} data-settled={settled} style={{ width: css.width, height: css.height }} />
  return <canvas key="opaque" ref={canvas} className="export-preview-canvas" data-settled={settled} style={{ width: css.width, height: css.height }} />
}
