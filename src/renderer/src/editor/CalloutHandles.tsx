/**
 * The preview's handles of step badges and speech bubbles (docs/design/editing-polish.md §2.3,
 * §12): over a selected badge, a handle that is dragged or moved with the arrow keys (1 % of the
 * frame, Shift 10 %); for a bubble, a round handle on the tail's tip ("Tail points to 52 %, 40 %")
 * and the body, dragged around it. A pinned badge or tip moves on the recording (its pin), and
 * where it shows at the item's start is written to x, y (§4.5). Shown while the preview holds a
 * frame that shows the item; a drag is one undo step, key presses merge into one.
 */
import { useEffect, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { moveBody, movePin, setFollowsZoom } from '../../../shared/editor/calloutsEdit'
import { displayTime } from '../../../shared/editor/clips'
import type { SceneLayout } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import { calloutOf } from '../../../shared/render/calloutData'
import { badgeLabels, BUBBLE_BODY, calloutPlace, type CalloutPlace } from '../../../shared/render/callouts'
import type { Project } from '../../../shared/types'
import { calloutStack, measurer } from '../render/calloutLayer'
import { calloutMapping, pausedScene, type CalloutMapping } from './calloutView'
import { holdGesture, useEditor } from './context'
import { releaseFocus } from './focus'
import { useGroup } from './groupContext'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import './panels/callouts.css'

/** What the preview shows at the playhead (useSceneView). */
type SceneView = SceneLayout

type Point = { x: number; y: number }

let measureCtx: CanvasRenderingContext2D | null = null
const measureOf = (stack: string): ((text: string, px: number, weight: number) => number) => {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  return measureCtx ? measurer(measureCtx, stack) : (text, px) => text.length * px * 0.55
}

/** "52 %, 40 %": a place in the frame for screen readers. */
const percents = (p: Point, m: CalloutMapping): string => `${Math.round((p.x / m.view.w) * 100)} %, ${Math.round((p.y / m.view.h) * 100)} %`

export function CalloutHandles(props: { project: Project; selection: Selection; view: SceneView }): JSX.Element | null {
  const { store, player } = useEditor()
  const group = useGroup()
  // Re-drawn when the playhead stops somewhere else, or starts or stops moving (never every frame of playback).
  const [key, setKey] = useState('')
  useEffect(() => {
    const check = (): void => setKey(player.moving ? 'moving' : `${player.time}`)
    check()
    return player.subscribe(check)
  }, [player])
  const sel = props.selection
  const found = sel?.kind === 'annotation' ? props.project.annotations.find((x) => x.id === sel.id) : undefined
  const a = found && (found.style === 'badge' || found.style === 'bubble') && !player.moving ? found : null
  const t = displayTime(props.project.clips, player.time)
  const shows = !!a && t >= a.start && t < a.end
  const scene = shows ? pausedScene(player) : null
  // The preview holds no frame yet (a seek still running): look again shortly.
  const waiting = shows && !scene
  useEffect(() => {
    if (!waiting) return
    const id = window.setTimeout(() => setKey((k) => `${k}+`), 150)
    return () => window.clearTimeout(id)
  }, [waiting, key])
  if (!a || !scene) return null
  const m = calloutMapping(scene, t)
  const place = calloutPlace(a, a.style === 'badge' ? (badgeLabels(props.project).get(a.id) ?? null) : null, m.frame, measureOf(calloutStack(props.project, a)))
  if (!place) return null
  const start = calloutMapping(scene, a.start)
  const c = calloutOf(a)
  const S = Math.min(m.view.w, m.view.h)

  /** Where a frame point (px at the playhead) puts the badge or the tip, and where it shows at the start. */
  const moveTo = (p: Point, key?: string): void => {
    const q = { x: clamp(p.x, 0, m.view.w), y: clamp(p.y, 0, m.view.h) }
    if (!c.pin) {
      // Not following the zoom (a badge) or without a tail (a bubble's body): it stays at this place in the frame.
      store.update((x) => setFollowsZoom(x, a.id, false, { pin: { x: 0, y: 0 }, shownAt: { x: q.x / m.view.w, y: q.y / m.view.h } }), key)
      return
    }
    const pin = m.view.fromOut(q.x, q.y)
    store.update((x) => movePin(x, a.id, pin, shownAtStart(pin)), key)
  }
  /** Where the item shows at its start for a pin there (a bubble: its body's centre). */
  const shownAtStart = (pin: Point): Point => {
    const tip = start.view.toOut(pin.x, pin.y)
    const body = a.style === 'bubble' ? (c.body ?? BUBBLE_BODY) : { dx: 0, dy: 0 }
    return { x: clamp((tip.x + body.dx * S) / start.view.w, 0, 1), y: clamp((tip.y + body.dy * S) / start.view.h, 0, 1) }
  }
  const moveBodyTo = (centre: Point): void => {
    if (!c.pin || !place.pin) return moveTo(centre)
    const body = { dx: (centre.x - place.pin.x) / S, dy: (centre.y - place.pin.y) / S }
    const tip = start.view.toOut(c.pin.x, c.pin.y)
    const shown = { x: clamp((tip.x + body.dx * S) / start.view.w, 0, 1), y: clamp((tip.y + body.dy * S) / start.view.h, 0, 1) }
    store.update((x) => moveBody(x, a.id, body, shown))
  }
  const announce = (what: string, p: Point): void => group.notice(`${what} ${percents(p, m)}`)

  const badgeName = place.lines[0] ? `Badge ${place.lines[0]} on ${percents(place.origin, m)}` : `Badge on ${percents(place.origin, m)}`
  const centre = { x: place.box.x + place.box.w / 2, y: place.box.y + place.box.h / 2 }
  return (
    <>
      {place.kind === 'badge' ? (
        <Handle
          testId="badge-handle"
          className="callout-handle badge"
          name={badgeName}
          box={place}
          m={m}
          at={place.origin}
          onMove={(p, key) => {
            moveTo(p, key)
            if (key) announce('Badge on', p)
          }}
          onHold={() => holdGesture(store)}
        />
      ) : (
        <>
          <Handle testId="bubble-body" className="callout-handle" name="Speech bubble" box={place} m={m} at={centre} onMove={(p) => moveBodyTo(p)} onHold={() => holdGesture(store)} focusable={false} />
          {place.pin && (
            <Handle
              testId="tail-handle"
              className="callout-tip"
              name={`Tail points to ${percents(place.pin, m)}`}
              m={m}
              at={place.pin}
              onMove={(p, key) => {
                moveTo(p, key)
                if (key) announce('Tail points to', p)
              }}
              onHold={() => holdGesture(store)}
            />
          )}
        </>
      )}
    </>
  )
}

/**
 * One handle: a box (a badge, a bubble's body) or a point (the tail's tip), in percents of the
 * frame. Dragged with the pointer; arrow keys move it 1 % of the frame, Shift 10 %.
 */
function Handle(props: {
  testId: string
  className: string
  name: string
  m: CalloutMapping
  at: Point
  box?: Pick<CalloutPlace, 'box'>
  onMove: (p: Point, key?: string) => void
  onHold: () => void
  focusable?: boolean
}): JSX.Element {
  const { m, at } = props
  const style = props.box
    ? { left: `${(props.box.box.x / m.view.w) * 100}%`, top: `${(props.box.box.y / m.view.h) * 100}%`, width: `${(props.box.box.w / m.view.w) * 100}%`, height: `${(props.box.box.h / m.view.h) * 100}%` }
    : { left: `${(at.x / m.view.w) * 100}%`, top: `${(at.y / m.view.h) * 100}%` }
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const frame = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    const scale = { x: m.view.w / frame.width, y: m.view.h / frame.height }
    const off = { x: (e.clientX - frame.left) * scale.x - at.x, y: (e.clientY - frame.top) * scale.y - at.y }
    props.onHold()
    followPointer(e, (ev) => props.onMove({ x: (ev.clientX - frame.left) * scale.x - off.x, y: (ev.clientY - frame.top) * scale.y - off.y }))
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 0.1 : 0.01
    const d = e.key === 'ArrowLeft' ? [-1, 0] : e.key === 'ArrowRight' ? [1, 0] : e.key === 'ArrowUp' ? [0, -1] : e.key === 'ArrowDown' ? [0, 1] : null
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    props.onMove({ x: at.x + d[0] * step * m.view.w, y: at.y + d[1] * step * m.view.h }, `callout-move:${props.testId}`)
  }
  const focusable = props.focusable !== false
  return (
    <div
      className={props.className}
      data-testid={props.testId}
      style={style}
      role={focusable ? 'button' : undefined}
      tabIndex={focusable ? 0 : undefined}
      aria-label={focusable ? props.name : undefined}
      aria-roledescription={focusable ? 'movable handle' : undefined}
      title={focusable ? `${props.name} · drag, or move it with the arrow keys (Shift: further)` : 'Drag to move the bubble around its tail'}
      onPointerDown={onDown}
      onKeyDown={focusable ? onKey : undefined}
    />
  )
}
