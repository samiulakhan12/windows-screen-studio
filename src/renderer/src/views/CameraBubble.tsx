import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RecordingApi } from '../../../shared/api/recording'
import { BUBBLE_SIZES, type BubbleSize } from '../../../shared/recording/cameraBubble'
import { RecIcon } from './recordingIcons'

export interface CameraBubbleProps {
  api: Pick<RecordingApi, 'dragCameraBubble' | 'resizeCameraBubble' | 'toggleCameraBubble'>
  token: string
  /** The camera as it is being recorded (a clone of the recorder's track). */
  stream: MediaStream
  shape: 'circle' | 'rounded' | 'square'
  mirror: boolean
  size: BubbleSize
}

/** A pointer that moved less than this (px) clicked rather than dragged. */
const DRAG_SLOP = 3

/**
 * The live camera bubble shown while recording (its own small always-on-top window, kept out of
 * the capture). Drag it anywhere: let go and it glides into the nearest corner, which is where
 * the camera goes in the video from then on. Hovering shows the size buttons and Hide.
 *
 * It runs in the recorder's page and is drawn into the bubble window's document, so it shows
 * the camera stream the recorder already has.
 */
export function CameraBubble({ api, token, stream, shape, mirror, size: initialSize }: CameraBubbleProps): JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [live, setLive] = useState(false)
  const [size, setSize] = useState(initialSize)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const v = video.current
    if (!v) return
    const onData = (): void => setLive(true)
    v.addEventListener('loadeddata', onData)
    v.srcObject = stream
    void v.play().catch(() => undefined)
    return () => {
      v.removeEventListener('loadeddata', onData)
      v.srcObject = null
    }
  }, [stream])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const sx = e.screenX
    const sy = e.screenY
    let moved = false
    let frame = 0
    let last = { x: sx, y: sy }
    api.dragCameraBubble(token, 'start', sx, sy)
    const move = (ev: PointerEvent): void => {
      last = { x: ev.screenX, y: ev.screenY }
      if (!moved && Math.hypot(last.x - sx, last.y - sy) <= DRAG_SLOP) return
      if (!moved) setDragging(true)
      moved = true
      // One move per frame at most: the window follows the pointer, not every event.
      if (!frame) {
        frame = el.ownerDocument.defaultView!.requestAnimationFrame(() => {
          frame = 0
          api.dragCameraBubble(token, 'move', last.x, last.y)
        })
      }
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (frame) el.ownerDocument.defaultView!.cancelAnimationFrame(frame)
      if (moved) api.dragCameraBubble(token, 'move', last.x, last.y)
      api.dragCameraBubble(token, 'end', last.x, last.y)
      setDragging(false)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const resize = (s: BubbleSize): void => {
    setSize(s)
    api.resizeCameraBubble(token, s)
  }

  return (
    <div
      className={`cam-bubble shape-${shape} ${live ? 'live' : ''} ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      title="Drag to move the camera to another corner"
      data-testid="camera-bubble"
    >
      <video ref={video} className={mirror ? 'mirrored' : ''} muted playsInline autoPlay aria-label="Live camera" />
      {!live && <span className="cam-bubble-wait">Camera…</span>}
      <div className="cam-bubble-controls" role="toolbar" aria-label="Camera bubble">
        {BUBBLE_SIZES.map((s) => (
          <button
            key={s}
            className={`cam-bubble-btn size ${size === s ? 'active' : ''}`}
            aria-pressed={size === s}
            aria-label={`Camera bubble size ${s === 'S' ? 'small' : s === 'M' ? 'medium' : 'large'}`}
            title={s === 'S' ? 'Small' : s === 'M' ? 'Medium' : 'Large'}
            onClick={() => resize(s)}
          >
            {s}
          </button>
        ))}
        <button className="cam-bubble-btn hide" aria-label="Hide camera bubble" title="Hide the camera bubble (show it again from the recording bar). The camera keeps recording." onClick={() => void api.toggleCameraBubble()}>
          <RecIcon name="eye-off" size={14} />
        </button>
      </div>
    </div>
  )
}
