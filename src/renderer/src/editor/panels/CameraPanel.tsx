import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { cornerRefusal, layoutRefusal, setCornerAt, setLayoutAt } from '../../../../shared/editor/layoutCommands'
import { LAYOUT_OPTIONS, layoutAt, layoutLabel, layoutSegmentAt, layoutTimeAt, segmentHasCorner, updateLayout } from '../../../../shared/editor/layouts'
import { CORNER_NAMES } from '../../../../shared/recording/cameraBubble'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { CORNERS, LOOK_LIMITS } from '../../../../shared/editor/styleDefaults'
import { cameraSourceRect, layoutGeometry, outputSize } from '../../../../shared/engine/layout'
import { formatTime } from '../../../../shared/engine/project'
import { DEFAULT_WEBCAM_BORDER, framingAt, WEBCAM_LIMITS, webcamLook } from '../../../../shared/engine/webcamData'
import type { CameraLayout, Corner, Project, WebcamSettings } from '../../../../shared/types'
import { ensureSegmenter, onSegmenterState, segmenterState } from '../../render/segmentation/personSegmenter'
import { holdGesture, useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { Icon } from '../../components/Icon'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import { LayoutGlyph } from '../layoutGlyphs'
import { showLayout } from '../LayoutTrack'
import { followPointer } from '../pointer'
import '../camera.css'
import './cursorPanel.css'

const L = LOOK_LIMITS
const BORDER_COLORS = [DEFAULT_WEBCAM_BORDER.color, '#000000', '#8b5cf6', '#22d3ee', '#facc15', '#f43f5e']
const pxFmt = (v: number): string => (v > 0 ? `${Math.round(v)} px` : 'Off')
const offPct = (v: number): string => (v > 0 ? pctFmt(v) : 'Off')
const zoomFmt = (v: number): string => `${v.toFixed(1)}×`

type Props = Pick<InspectorProps, 'project' | 'hasWebcam' | 'selection' | 'onSelect' | 'onNotice'>

/* ---------- Camera ---------- */

export function CameraPanel({ project, hasWebcam, selection, onSelect, onNotice }: Props): JSX.Element {
  const { store } = useEditor()
  const { webcam } = project
  const look = webcamLook(webcam)
  const set = (patch: Partial<WebcamSettings>, key?: string): void => store.update((p) => ({ ...p, webcam: { ...p.webcam, ...patch } }), key)
  const off = !hasWebcam || !webcam.show
  return (
    <>
      {!hasWebcam && <p className="hint">This recording has no camera. Pick a camera on the home screen before recording.</p>}
      <Section title="Camera">
        <Toggle label="Show camera" checked={hasWebcam && webcam.show} disabled={!hasWebcam} onChange={(v) => set({ show: v })} />
        <Slider label="Size" value={webcam.size} {...L.webcamSize} step={0.01} format={pctFmt} disabled={off} onChange={(v) => set({ size: v }, 'webcam.size')} />
        <Chips
          label="Camera shape"
          value={webcam.shape}
          disabled={off}
          onChange={(shape) => set({ shape })}
          options={[
            { value: 'circle', label: 'Circle' },
            { value: 'rounded', label: 'Rounded' },
            { value: 'square', label: 'Square' }
          ]}
        />
        <div className="corner-grid" role="group" aria-label="Camera corner" title="The camera's corner wherever no layout change chooses another one">
          {CORNERS.map((c) => (
            <button key={c} disabled={off} className={`corner ${webcam.corner === c ? 'active' : ''} ${c}`} onClick={() => set({ corner: c })} title={c.replace('-', ' ')} aria-label={c.replace('-', ' ')}>
              <span />
            </button>
          ))}
        </div>
      </Section>

      <Section title="Look">
        <Slider
          label="Border"
          value={look.border.width}
          min={WEBCAM_LIMITS.borderWidth.min}
          max={WEBCAM_LIMITS.borderWidth.max}
          step={1}
          format={pxFmt}
          disabled={off}
          onChange={(v) => set({ border: { ...look.border, width: v } }, 'webcam.border.width')}
        />
        <ColorRow
          label="Border colour"
          value={look.border.color}
          presets={BORDER_COLORS}
          disabled={off || look.border.width <= 0}
          onChange={(color, key) => set({ border: { ...look.border, color } }, key)}
          mergeKey="webcam.border.color"
        />
        <Slider label="Shadow" value={look.shadow} min={0} max={1} step={0.01} format={offPct} disabled={off} onChange={(v) => set({ shadow: v }, 'webcam.shadow')} />
        <Toggle label="Mirror" title="Show the camera flipped, as in a mirror (how you see yourself)" checked={look.mirror} disabled={off} onChange={(v) => set({ mirror: v })} />
      </Section>

      <FramingSection project={project} off={off} set={set} />
      <BlurSection value={look.backgroundBlur} off={off} set={set} />
      {hasWebcam && <LayoutSection project={project} selection={selection} onSelect={onSelect} onNotice={onNotice} />}
      {hasWebcam && <PositionSection project={project} selection={selection} onSelect={onSelect} onNotice={onNotice} />}
    </>
  )
}

/* ---------- framing: zoom and crop ---------- */

const PAD_W = 236

/**
 * Zoom into the camera picture and choose which part shows: a thumbnail of the camera frame at
 * the playhead with the visible area marked (for the layout in effect there); drag it, or click
 * where it should be.
 */
function FramingSection({ project, off, set }: { project: Project; off: boolean; set: (patch: Partial<WebcamSettings>, key?: string) => void }): JSX.Element {
  const { store, player } = useEditor()
  const look = webcamLook(project.webcam)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const video = player.webcam
  const camW = video?.videoWidth || 16
  const camH = video?.videoHeight || 9
  const padH = Math.round((PAD_W * camH) / camW)
  // The shape of the camera in the layout at the playhead (on the frame the preview shows) decides how much of the picture shows.
  const out = outputSize(project.style.aspectRatio, project.width, project.height, 1080)
  const layout = useSyncExternalStore(player.subscribe, () => layoutAt(project, layoutTimeAt(project, player.time)))
  const box = layoutGeometry(layout, project, out.width, out.height, project.width, project.height).camera.rect
  const src = cameraSourceRect(camW, camH, Math.max(1, box.w), Math.max(1, box.h), look)
  const fx = src.x / camW
  const fw = src.w / camW
  const frame = { left: (look.mirror ? 1 - fx - fw : fx) * 100, top: (src.y / camH) * 100, width: fw * 100, height: (src.h / camH) * 100 }
  const framed = look.zoom > 1.001 || Math.abs(look.cropX - 0.5) > 1e-3 || Math.abs(look.cropY - 0.5) > 1e-3

  // The thumbnail follows the camera picture at the playhead (at most ~8 times a second while playing).
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !video) return
    let last = 0
    let timer = 0
    const draw = (): void => {
      timer = 0
      last = performance.now()
      const ctx = canvas.getContext('2d')
      if (!ctx || video.readyState < 2 || !video.videoWidth) return
      ctx.save()
      if (look.mirror) {
        ctx.translate(canvas.width, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      ctx.restore()
    }
    const schedule = (): void => {
      if (timer) return
      timer = window.setTimeout(draw, Math.max(0, 120 - (performance.now() - last)))
    }
    draw()
    video.addEventListener('seeked', schedule)
    video.addEventListener('loadeddata', schedule)
    const off = player.subscribe(schedule)
    return () => {
      window.clearTimeout(timer)
      off()
      video.removeEventListener('seeked', schedule)
      video.removeEventListener('loadeddata', schedule)
    }
  }, [video, player, look.mirror, padH])

  /**
   * Centres the visible area on the pointer (in picture coordinates): every layout then centres
   * on that point as far as its own visible area allows (an axis this one shows whole is kept).
   */
  const onPadDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || off) return
    const el = e.currentTarget
    const visible = { w: fw, h: src.h / camH }
    const grab = (ev: { clientX: number; clientY: number }, key?: string): void => {
      const r = el.getBoundingClientRect()
      set(framingAt((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height, look, visible), key)
    }
    holdGesture(store)
    grab(e, 'webcam.crop')
    followPointer(e, (ev) => grab(ev, 'webcam.crop'))
  }

  return (
    <Section
      title="Framing"
      aside={
        framed && !off ? (
          <button className="cam-reset" onClick={() => set({ zoom: 1, cropX: 0.5, cropY: 0.5 })} title="Show the whole camera picture, centred">
            Reset
          </button>
        ) : undefined
      }
    >
      {video && (
        <div
          className={`cam-pad ${off ? 'disabled' : ''}`}
          style={{ width: PAD_W, height: padH }}
          onPointerDown={onPadDown}
          role="slider"
          aria-label="Visible part of the camera picture"
          aria-valuetext={`${Math.round(look.cropX * 100)}% across, ${Math.round(look.cropY * 100)}% down`}
          title="Drag to choose which part of the camera picture shows"
          data-testid="camera-framing"
        >
          <canvas ref={canvasRef} width={PAD_W * 2} height={padH * 2} />
          <span className="cam-pad-frame" style={{ left: `${frame.left}%`, top: `${frame.top}%`, width: `${frame.width}%`, height: `${frame.height}%` }} />
        </div>
      )}
      <Slider
        label="Zoom"
        value={look.zoom}
        min={WEBCAM_LIMITS.zoom.min}
        max={WEBCAM_LIMITS.zoom.max}
        step={0.05}
        format={zoomFmt}
        disabled={off}
        onChange={(v) => set({ zoom: v }, 'webcam.zoom')}
      />
      <p className="hint">Zoom in to fill the camera with your face; drag the box to choose what shows.</p>
    </Section>
  )
}

/* ---------- background blur ---------- */

function BlurSection({ value, off, set }: { value: number; off: boolean; set: (patch: Partial<WebcamSettings>, key?: string) => void }): JSX.Element {
  const state = useSyncExternalStore(onSegmenterState, segmenterState)
  const on = value > 0 && !off
  // Load person detection as soon as the blur is wanted, so the panel can say how it went.
  useEffect(() => {
    if (on) void ensureSegmenter()
  }, [on])
  return (
    <Section title="Background blur">
      <Slider label="Blur behind you" value={value} min={0} max={1} step={0.01} format={offPct} disabled={off} onChange={(v) => set({ backgroundBlur: v }, 'webcam.backgroundBlur')} />
      {state.status === 'failed' ? (
        <p className="callout" role="alert" data-testid="blur-unavailable">
          Background blur is unavailable: {state.reason}. The camera is shown without it, in the preview and the export.
        </p>
      ) : (
        <p className="hint" data-testid="blur-status" data-state={on ? state.status : 'off'}>
          {on && state.status === 'loading'
            ? 'Loading person detection…'
            : 'Softens the room behind you and keeps you sharp. The person is found on this PC; nothing is uploaded.'}
        </p>
      )}
    </Section>
  )
}

/* ---------- layouts ---------- */

/**
 * How the screen and the camera share the frame over time: the layout of the selected change,
 * or of the playhead (picking one there adds a change at the playhead, as the layout commands do).
 */
function LayoutSection({ project, selection, onSelect, onNotice }: Pick<Props, 'project' | 'selection' | 'onSelect' | 'onNotice'>): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const layouts = project.layouts ?? []
  // The change on the frame the preview shows. Re-renders only when the playhead enters or leaves one, not on every frame.
  const hereId = useSyncExternalStore(player.subscribe, () => layoutSegmentAt(layouts, layoutTimeAt(project, player.time))?.id ?? '')
  const selected = selection?.kind === 'layout' ? (layouts.find((s) => s.id === selection.id) ?? null) : null
  const target = selected ?? layouts.find((s) => s.id === hereId) ?? null
  const current: CameraLayout = target ? target.layout : 'default'
  const hidden = !project.webcam.show

  const pick = (layout: CameraLayout): void => {
    if (selected) {
      if (selected.layout !== layout) store.update((p) => ({ ...p, layouts: updateLayout(p.layouts, selected.id, { layout }) }))
      return
    }
    // At the playhead: the change there, else a new one (the rule of the layout commands).
    const r = setLayoutAt(store.state, layout, player.time)
    if (!r.ok) {
      if (r.id) onSelect({ kind: 'layout', id: r.id })
      if (r.reason !== 'same') onNotice(layoutRefusal(r.reason, layout))
      return
    }
    store.update((p) => ({ ...p, layouts: r.layouts }))
    onSelect({ kind: 'layout', id: r.id })
    if (r.added) showLayout(player, store.state, r.id)
  }

  const remove = (): void => {
    if (!target) return
    store.update((p) => ({ ...p, layouts: (p.layouts ?? []).filter((s) => s.id !== target.id) }))
    onSelect(null)
  }

  return (
    <Section
      title="Layout"
      aside={
        target ? (
          <span className="muted small">
            {formatTime(target.start)} – {formatTime(target.end)}
          </span>
        ) : undefined
      }
    >
      {hidden && <p className="hint">The camera is hidden: show it to use layouts.</p>}
      <div className="layout-picker" role="group" aria-label="Camera layout">
        {LAYOUT_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`layout-option ${current === o.value ? 'active' : ''}`}
            aria-pressed={current === o.value}
            disabled={hidden || (!target && o.value === 'default')}
            title={target ? `${o.label}: ${o.hint}` : o.value === 'default' ? `${o.hint} (the layout outside any change)` : `Change to ${o.label.toLowerCase()} at the playhead: ${o.hint.toLowerCase()}`}
            onClick={() => pick(o.value)}
          >
            <LayoutGlyph layout={o.value} size={30} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {target ? (
        <div className="layout-actions">
          <p className="hint">Drag the block on the camera track to move it; drag its ends to change when it starts and stops.</p>
          <button className="btn ghost danger" onClick={remove} title={withShortcut('Delete this layout change', keymap.deleteSelection)}>
            <Icon name="trash" size={16} /> Delete
          </button>
        </div>
      ) : (
        <p className="hint">Pick a layout to switch to it at the playhead, or double-click the camera track on the timeline. Changes animate smoothly in and out.</p>
      )}
    </Section>
  )
}

/* ---------- camera position over time ---------- */

/**
 * Where the camera bubble sits over time: the corner of the selected layout change (or the one at
 * the playhead), or, outside every change, "Move camera here from the playhead", which adds a
 * change with that corner there. The Camera section's corner stays the default elsewhere.
 */
function PositionSection({ project, selection, onSelect, onNotice }: Pick<Props, 'project' | 'selection' | 'onSelect' | 'onNotice'>): JSX.Element {
  const { store, player } = useEditor()
  const layouts = project.layouts ?? []
  const hereId = useSyncExternalStore(player.subscribe, () => layoutSegmentAt(layouts, layoutTimeAt(project, player.time))?.id ?? '')
  const selected = selection?.kind === 'layout' ? (layouts.find((s) => s.id === selection.id) ?? null) : null
  const target = selected ?? layouts.find((s) => s.id === hereId) ?? null
  const hidden = !project.webcam.show
  const fixed = !!target && !segmentHasCorner(target)
  const current: Corner = target?.corner ?? project.webcam.corner

  const pick = (corner: Corner): void => {
    if (selected) {
      if (!segmentHasCorner(selected) || (selected.corner ?? project.webcam.corner) === corner) return
      store.update((p) => ({ ...p, layouts: updateLayout(p.layouts, selected.id, { corner }) }))
      return
    }
    // At the playhead: the change there, else a new one with that corner (the rule of the layout commands).
    const r = setCornerAt(store.state, corner, player.time)
    if (!r.ok) {
      if (r.id) onSelect({ kind: 'layout', id: r.id })
      if (r.reason !== 'same') onNotice(cornerRefusal(r.reason, corner))
      return
    }
    store.update((p) => ({ ...p, layouts: r.layouts }))
    onSelect({ kind: 'layout', id: r.id })
    if (r.added) showLayout(player, store.state, r.id)
  }

  const reset = (): void => {
    if (!target?.corner) return
    store.update((p) => ({ ...p, layouts: (p.layouts ?? []).map((s) => (s.id === target.id ? { ...s, corner: undefined } : s)) }))
  }

  const label = target ? 'Camera position' : 'Move camera here from the playhead'
  return (
    <Section
      title="Camera position"
      aside={
        target?.corner && !fixed ? (
          <button className="cam-reset" onClick={reset} title="Use the camera's default corner (Camera section) in this change">
            Default
          </button>
        ) : undefined
      }
    >
      <div className="corner-grid cam-position" role="group" aria-label={label} data-testid="camera-position">
        {CORNERS.map((c) => (
          <button
            key={c}
            disabled={hidden || fixed}
            className={`corner ${target && !fixed && current === c ? 'active' : ''} ${c}`}
            aria-pressed={!!target && !fixed && current === c}
            onClick={() => pick(c)}
            title={target ? `${CORNER_NAMES[c]} during this layout change` : `Move the camera to the ${CORNER_NAMES[c].toLowerCase()} corner from the playhead`}
            aria-label={`${label}: ${CORNER_NAMES[c].toLowerCase()}`}
          >
            <span />
          </button>
        ))}
      </div>
      <p className="hint">
        {hidden
          ? 'The camera is hidden: show it to move it.'
          : fixed
            ? `${layoutLabel(target!.layout)} has no camera corner.`
            : target
              ? 'The corner of the camera during this layout change; it glides there and back.'
              : 'Pick a corner to move the camera there from the playhead. Elsewhere it stays in the corner chosen above.'}
      </p>
    </Section>
  )
}

/* ---------- colours ---------- */

function ColorRow({
  label,
  value,
  presets,
  disabled,
  onChange,
  mergeKey
}: {
  label: string
  value: string
  presets: string[]
  disabled?: boolean
  onChange: (color: string, key?: string) => void
  mergeKey: string
}): JSX.Element {
  const v = value.toLowerCase()
  const custom = !presets.includes(v)
  // The colour picker only takes #rrggbb; the original translucent white ring shows as white.
  const hex = /^#[0-9a-f]{6}$/.test(v) ? v : '#ffffff'
  return (
    <div className={`color-row ${disabled ? 'disabled' : ''}`} role="group" aria-label={label}>
      {presets.map((c) => (
        <button
          key={c}
          className={`color-dot ${v === c ? 'active' : ''}`}
          style={{ background: c }}
          disabled={disabled}
          title={c === DEFAULT_WEBCAM_BORDER.color ? 'White' : c}
          aria-label={`${label} ${c === DEFAULT_WEBCAM_BORDER.color ? 'white' : c}`}
          aria-pressed={v === c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className={`color-dot custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={`${label} (any colour)`} value={hex} disabled={disabled} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}
