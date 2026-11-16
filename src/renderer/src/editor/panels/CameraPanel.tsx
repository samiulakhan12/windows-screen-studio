import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { cornerRefusal, layoutRefusal, setCornerAt, setLayoutAt } from '../../../../shared/editor/layoutCommands'
import { cornerName, LAYOUT_OPTIONS, layoutAt, layoutLabel, layoutSegmentAt, layoutTimeAt, removeLayout, segmentHasCorner, updateLayout } from '../../../../shared/editor/layouts'
import { autoLayoutHint } from '../../../../shared/editor/directorCopy'
import { bandOf } from '../../../../shared/editor/followEdit'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { CORNERS, LOOK_LIMITS } from '../../../../shared/editor/styleDefaults'
import { visibleSize } from '../../../../shared/engine/crop'
import { cameraSourceRect, layoutGeometry, outputSize } from '../../../../shared/engine/layout'
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
import { DirectorSection } from './DirectorSection'
import { followPointer } from '../pointer'
import { IMPORTED_COPY, isImported } from '../../../../shared/import/imported'
import { fmt } from '../../../../shared/i18n/fmt'
import '../camera.css'
import './cursorPanel.css'
import { CameraColourSection } from './CameraColourSection'
import { t } from '../../../../shared/i18n/t'

const L = LOOK_LIMITS
const BORDER_COLORS = [DEFAULT_WEBCAM_BORDER.color, '#000000', '#8b5cf6', '#22d3ee', '#facc15', '#f43f5e']
const pxFmt = (v: number): string => (v > 0 ? `${fmt.count(Math.round(v))} px` : t('camera.cameraPanel.off'))
const offPct = (v: number): string => (v > 0 ? pctFmt(v) : t('camera.cameraPanel.off'))
const zoomFmt = (v: number): string => `${fmt.number(v, { max: 1 })}×`

type Props = Pick<InspectorProps, 'project' | 'cursor' | 'recorded' | 'hasWebcam' | 'selection' | 'onSelect' | 'onNotice' | 'directorRequest'>

/* ---------- Camera ---------- */

export function CameraPanel({ project, cursor, recorded, hasWebcam, selection, onSelect, onNotice, directorRequest }: Props): JSX.Element {
  const { store } = useEditor()
  const { webcam } = project
  const look = webcamLook(webcam)
  const set = (patch: Partial<WebcamSettings>, key?: string): void => store.update((p) => ({ ...p, webcam: { ...p.webcam, ...patch } }), key)
  const off = !hasWebcam || !webcam.show
  // In a band (the view follows the action in a tall frame) corners do nothing; they stay stored
  // for the bubble and 16:9 (docs/design/vertical-video.md §2.10).
  const band = hasWebcam ? bandOf(project) : null
  return (
    <>
      {!hasWebcam && <p className="hint">{isImported(project) ? IMPORTED_COPY.camera : t('camera.cameraPanel.thisRecordingHasNo')}</p>}
      {hasWebcam && <DirectorSection project={project} cursor={cursor} recorded={recorded} onSelect={onSelect} onNotice={onNotice} directorRequest={directorRequest} />}
      <Section title={t('common.label.camera')}>
        <Toggle label={t('camera.cameraPanel.showCamera')} checked={hasWebcam && webcam.show} disabled={!hasWebcam} onChange={(v) => set({ show: v })} />
        <Slider label={t('common.label.size')} value={webcam.size} {...L.webcamSize} step={0.01} format={pctFmt} disabled={off} onChange={(v) => set({ size: v }, 'webcam.size')} />
        <Chips
          label={t('camera.cameraPanel.cameraShape')}
          value={webcam.shape}
          disabled={off}
          onChange={(shape) => set({ shape })}
          options={[
            { value: 'circle', label: t('camera.cameraPanel.shape.circle') },
            { value: 'rounded', label: t('camera.cameraPanel.shape.rounded') },
            { value: 'square', label: t('camera.cameraPanel.shape.square') }
          ]}
        />
        <div className="corner-grid" role="group" aria-label={t('camera.cameraPanel.cameraCorner')} title={t('camera.cameraPanel.theCameraSCorner')}>
          {CORNERS.map((c) => (
            <button
              key={c}
              disabled={off}
              aria-disabled={band ? true : undefined}
              className={`corner ${webcam.corner === c ? 'active' : ''} ${c}`}
              onClick={() => !band && set({ corner: c })}
              title={t('camera.cameraPanel.cornerLower', { corner: c })}
              aria-label={t('camera.cameraPanel.cornerLower', { corner: c })}
            >
              <span />
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('common.label.look')}>
        <Slider
          label={t('camera.cameraPanel.border')}
          value={look.border.width}
          min={WEBCAM_LIMITS.borderWidth.min}
          max={WEBCAM_LIMITS.borderWidth.max}
          step={1}
          format={pxFmt}
          disabled={off}
          onChange={(v) => set({ border: { ...look.border, width: v } }, 'webcam.border.width')}
        />
        <ColorRow
          label={t('camera.cameraPanel.borderColour')}
          value={look.border.color}
          presets={BORDER_COLORS}
          disabled={off || look.border.width <= 0}
          onChange={(color, key) => set({ border: { ...look.border, color } }, key)}
          mergeKey="webcam.border.color"
        />
        <Slider label={t('common.label.shadow')} value={look.shadow} min={0} max={1} step={0.01} format={offPct} disabled={off} onChange={(v) => set({ shadow: v }, 'webcam.shadow')} />
        <Toggle label={t('camera.cameraPanel.mirror')} title={t('camera.cameraPanel.showTheCameraFlipped')} checked={look.mirror} disabled={off} onChange={(v) => set({ mirror: v })} />
      </Section>

      <FramingSection project={project} off={off} set={set} />
      <BlurSection value={look.backgroundBlur} off={off} set={set} />
      {/* The camera's colour and Auto colour (docs/design/editing-polish.md §2.5). */}
      <CameraColourSection project={project} />
      {hasWebcam && <LayoutSection project={project} selection={selection} onSelect={onSelect} onNotice={onNotice} band={band} />}
      {hasWebcam && <PositionSection project={project} selection={selection} onSelect={onSelect} onNotice={onNotice} band={band} />}
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
  const shown = visibleSize(project)
  const out = outputSize(project.style.aspectRatio, shown.width, shown.height, 1080)
  const layout = useSyncExternalStore(player.subscribe, () => layoutAt(project, layoutTimeAt(project, player.time)))
  const box = layoutGeometry(layout, project, out.width, out.height, shown.width, shown.height).camera.rect
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
      title={t('camera.cameraPanel.framing')}
      aside={
        framed && !off ? (
          <button className="cam-reset" onClick={() => set({ zoom: 1, cropX: 0.5, cropY: 0.5 })} title={t('camera.cameraPanel.showTheWholeCamera')}>{t('common.action.reset')}</button>
        ) : undefined
      }
    >
      {video && (
        <div
          className={`cam-pad ${off ? 'disabled' : ''}`}
          style={{ width: PAD_W, height: padH }}
          onPointerDown={onPadDown}
          role="slider"
          aria-label={t('camera.cameraPanel.visiblePartOfThe')}
          aria-valuetext={t('camera.cameraPanel.acrossDown', { x: fmt.count(Math.round(look.cropX * 100)), y: fmt.count(Math.round(look.cropY * 100)) })}
          title={t('camera.cameraPanel.dragToChooseWhich')}
          data-testid="camera-framing"
        >
          <canvas ref={canvasRef} width={PAD_W * 2} height={padH * 2} />
          <span className="cam-pad-frame" style={{ left: `${frame.left}%`, top: `${frame.top}%`, width: `${frame.width}%`, height: `${frame.height}%` }} />
        </div>
      )}
      <Slider
        label={t('common.label.zoom')}
        value={look.zoom}
        min={WEBCAM_LIMITS.zoom.min}
        max={WEBCAM_LIMITS.zoom.max}
        step={0.05}
        format={zoomFmt}
        disabled={off}
        onChange={(v) => set({ zoom: v }, 'webcam.zoom')}
      />
      <p className="hint">{t('camera.cameraPanel.zoomInToFill')}</p>
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
    <Section title={t('camera.cameraPanel.backgroundBlur')}>
      <Slider label={t('camera.cameraPanel.blurBehindYou')} value={value} min={0} max={1} step={0.01} format={offPct} disabled={off} onChange={(v) => set({ backgroundBlur: v }, 'webcam.backgroundBlur')} />
      {state.status === 'failed' ? (
        <p className="callout" role="alert" data-testid="blur-unavailable">
          {t('camera.cameraPanel.blurUnavailable', { reason: state.reason })}
        </p>
      ) : (
        <p className="hint" data-testid="blur-status" data-state={on ? state.status : 'off'}>
          {on && state.status === 'loading'
            ? t('camera.cameraPanel.loadingPersonDetection')
            : t('camera.cameraPanel.softensTheRoomBehind')}
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
function LayoutSection({
  project,
  selection,
  onSelect,
  onNotice,
  band
}: Pick<Props, 'project' | 'selection' | 'onSelect' | 'onNotice'> & { band: 'top' | 'bottom' | null }): JSX.Element {
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
    store.update((p) => ({ ...p, layouts: removeLayout(p.layouts, target.id) }))
    onSelect(null)
  }

  return (
    <Section
      title={t('common.label.layout')}
      aside={
        target ? (
          <span className="muted small">
            {fmt.clock(target.start)} – {fmt.clock(target.end)}
          </span>
        ) : undefined
      }
    >
      {hidden && <p className="hint">{t('camera.cameraPanel.theCameraIsHidden')}</p>}
      {band && (
        <p className="hint" data-testid="layout-band-hint">
          {band === 'top' ? t('camera.cameraPanel.bandTop') : t('camera.cameraPanel.bandBottom')}
        </p>
      )}
      <div className="layout-picker" role="group" aria-label={t('camera.cameraPanel.cameraLayout')}>
        {LAYOUT_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`layout-option ${current === o.value ? 'active' : ''}`}
            aria-pressed={current === o.value}
            disabled={hidden || (!target && o.value === 'default')}
            title={target ? t('camera.cameraPanel.layoutTitle', { label: o.label, hint: o.hint }) : o.value === 'default' ? t('camera.cameraPanel.theLayoutOutsideAny', { hint: o.hint }) : t('camera.cameraPanel.changeToAtThe', { label: o.label.toLowerCase(), hint: o.hint.toLowerCase() })}
            onClick={() => pick(o.value)}
          >
            <LayoutGlyph layout={o.value} size={30} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {target?.auto && (
        <p className="hint" data-testid="layout-auto-hint">
          {autoLayoutHint()}
        </p>
      )}
      {target ? (
        <div className="layout-actions">
          <p className="hint">{t('camera.cameraPanel.dragTheBlockOn')}</p>
          <button className="btn ghost danger" onClick={remove} title={withShortcut(t('camera.cameraPanel.deleteTitle'), keymap.deleteSelection)}>
            <Icon name="trash" size={16} />{t('camera.cameraPanel.delete')}</button>
        </div>
      ) : (
        <p className="hint">{t('camera.cameraPanel.pickALayoutTo')}</p>
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
function PositionSection({
  project,
  selection,
  onSelect,
  onNotice,
  band
}: Pick<Props, 'project' | 'selection' | 'onSelect' | 'onNotice'> & { band: 'top' | 'bottom' | null }): JSX.Element {
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
    // An edit by hand: a change the director made becomes the user's (updateLayout).
    store.update((p) => ({ ...p, layouts: updateLayout(p.layouts, target.id, { corner: undefined }) }))
  }

  const label = target ? t('camera.cameraPanel.cameraPosition') : t('camera.cameraPanel.moveHere')
  return (
    <Section
      title={t('camera.cameraPanel.cameraPosition')}
      aside={
        target?.corner && !fixed ? (
          <button className="cam-reset" onClick={reset} title={t('camera.cameraPanel.useTheCameraS')}>{t('camera.cameraPanel.default')}</button>
        ) : undefined
      }
    >
      <div className="corner-grid cam-position" role="group" aria-label={label} data-testid="camera-position">
        {CORNERS.map((c) => (
          <button
            key={c}
            disabled={hidden || fixed}
            aria-disabled={band ? true : undefined}
            className={`corner ${target && !fixed && current === c ? 'active' : ''} ${c}`}
            aria-pressed={!!target && !fixed && current === c}
            onClick={() => !band && pick(c)}
            title={target ? t('camera.cameraPanel.duringThisLayoutChange', { corner: cornerName(c) }) : t('camera.cameraPanel.moveTheCameraTo', { corner: c })}
            aria-label={t('camera.cameraPanel.positionName', { label, corner: c })}
          >
            <span />
          </button>
        ))}
      </div>
      <p className="hint">
        {hidden
          ? t('camera.cameraPanel.cameraHiddenPosition')
          : fixed
            ? t('camera.cameraPanel.hasNoCameraCorner', { layout: layoutLabel(target!.layout) })
            : target
              ? t('camera.cameraPanel.theCornerOfThe')
              : t('camera.cameraPanel.pickACornerTo')}
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
          title={c === DEFAULT_WEBCAM_BORDER.color ? t('camera.cameraPanel.white') : c}
          aria-label={c === DEFAULT_WEBCAM_BORDER.color ? t('camera.cameraPanel.swatchWhite', { label }) : `${label} ${c}`}
          aria-pressed={v === c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className={`color-dot custom ${custom ? 'active' : ''}`} title={t('common.colour.pickAny')} style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={t('common.colour.anyFor', { label: String(label) })} value={hex} disabled={disabled} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}
