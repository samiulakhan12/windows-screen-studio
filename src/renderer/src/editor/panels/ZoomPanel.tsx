import { isCommandId } from '../../../../shared/editor/commands'
import { orPress, shortcutLabel, undoHint, withShortcut, zoomLevelKeysHint } from '../../../../shared/editor/shortcuts'
import { ZOOM_EASINGS } from '../../../../shared/engine/easing'
import { formatTime } from '../../../../shared/engine/project'
import {
  isZoomClick,
  MAX_TRANSITION,
  MIN_TRANSITION,
  regenerateAutoZooms,
  zoomEasing,
  zoomSettingsOf,
  zoomStyleOf,
  zoomTargetScale,
  zoomTransition,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE
} from '../../../../shared/engine/zoom'
import {
  clearZoomStyles,
  connectToNext,
  disconnectFromNext,
  formatLevel,
  isConnectedToNext,
  nextZoom,
  regionAround,
  setZoomLevel,
  ZOOM_LEVEL_PRESETS
} from '../../../../shared/editor/zoomEdit'
import type { AutoZoomSettings, CursorTrack, Project, ZoomEasing, ZoomSegment, ZoomSettings } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import '../zoom.css'

const secFmt = (v: number): string => `${v.toFixed(2)} s`
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Recorded input auto zoom can use, given its settings. */
function inputSummary(track: CursorTrack, auto: AutoZoomSettings): { clicks: number; typing: number; marks: number } {
  return {
    clicks: track.valid ? track.clicks.filter((c) => isZoomClick(c, auto.rightClicks)).length : 0,
    // Typing zooms aim at clicks or the cursor, so they need cursor data; marks do not.
    typing: track.valid ? (track.typing?.length ?? 0) : 0,
    marks: track.marks?.length ?? 0
  }
}

/* ---------- Zoom ---------- */

export function ZoomPanel(props: InspectorProps): JSX.Element {
  const { project, selection } = props
  const keymap = useKeymap()
  const zoom = selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id) ?? null) : null
  const levelKeys = zoomLevelKeysHint(keymap)
  return (
    <>
      {zoom ? (
        <SelectedZoom {...props} zoom={zoom} />
      ) : (
        <p className="hint">
          Select a zoom on the timeline to edit it{keymap.addZoom[0] ? `, or press ${shortcutLabel(keymap.addZoom[0])} to add one at the playhead` : ''}.
          {levelKeys ? ` With a zoom selected, ${levelKeys}.` : ''}
        </p>
      )}
      <ZoomStyleSection project={project} onNotice={props.onNotice} />
      <AutoZoomSection project={project} cursor={props.cursor} onNotice={props.onNotice} />
    </>
  )
}

function SelectedZoom(props: InspectorProps & { zoom: ZoomSegment }): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const { project, zoom } = props
  const cursorValid = props.cursor.valid
  const style = zoomStyleOf(project)
  const next = nextZoom(project.zooms, zoom.id)
  const connected = isConnectedToNext(project.zooms, zoom.id, style)
  const focus = zoom.focus
  const level = zoomTargetScale(zoom)

  const patch = (fn: (z: ZoomSegment) => ZoomSegment, key?: string): void => {
    store.update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === zoom.id ? fn(z) : z)) }), key)
  }
  const setZoom = (change: Partial<ZoomSegment>, key?: string): void => patch((z) => ({ ...z, ...change, auto: false }), key)
  const setLevel = (v: number, key?: string): void => patch((z) => setZoomLevel(z, v), key)

  /** Shows the zoom on the preview while picking on it. */
  const startPicking = (): void => {
    if (player.time < zoom.start || player.time >= zoom.end) player.seek((zoom.start + zoom.end) / 2)
    props.onPickFocus(true)
  }

  const setFocusMode = (mode: 'cursor' | 'fixed' | 'region'): void => {
    if (mode === focus.mode) return
    // Keep looking where the zoom looks now instead of jumping to the centre.
    const f = focus.mode === 'region' ? { x: focus.x + focus.w / 2, y: focus.y + focus.h / 2 } : focus.mode === 'fixed' ? focus : props.focusFor(zoom)
    if (mode === 'cursor') {
      setZoom({ focus: { mode: 'cursor' } })
      props.onPickFocus(false)
    } else if (mode === 'fixed') {
      setZoom({ focus: { mode: 'fixed', x: f.x, y: f.y } })
    } else {
      const region = regionAround(f.x, f.y, level >= 1.05 ? level : 2)
      patch((z) => setZoomLevel({ ...z, focus: region }, level >= 1.05 ? level : 2))
      startPicking()
    }
  }

  const toggleConnect = (on: boolean): void => {
    if (on) {
      const zooms = connectToNext(store.state.zooms, zoom.id)
      if (zooms) store.update((p) => ({ ...p, zooms }))
      return
    }
    const zooms = disconnectFromNext(store.state.zooms, zoom.id, zoomStyleOf(store.state))
    if (zooms) store.update((p) => ({ ...p, zooms }))
    else props.onNotice('This zoom is too short to end before the next one: shorten or move a zoom instead')
  }

  const easing = zoomEasing(zoom, style)
  const transition = zoomTransition(zoom, style)
  const ownStyle = zoom.easing !== undefined || zoom.transition !== undefined

  return (
    <Section title="Selected zoom" aside={<span className="muted small">{zoom.auto ? 'automatic' : 'edited'}</span>}>
      <p className="hint">
        {formatTime(zoom.start)} – {formatTime(zoom.end)} · {(zoom.end - zoom.start).toFixed(1)} s
      </p>
      <div className="zoom-chips-fill">
        <Chips
          label="Zoom level presets"
          value={ZOOM_LEVEL_PRESETS.find((p) => Math.abs(p.value - level) < 1e-3)?.value ?? null}
          onChange={(v) => setLevel(v)}
          options={ZOOM_LEVEL_PRESETS.map((p) => {
            const command = `zoomLevel${p.key}`
            return { value: p.value, label: p.label, title: withShortcut(p.title, isCommandId(command) ? keymap[command] : undefined) }
          })}
        />
      </div>
      <Slider
        label={level < 1 ? 'Zoom level · pull back' : 'Zoom level'}
        value={level}
        min={ZOOM_MIN_SCALE}
        max={ZOOM_MAX_SCALE}
        step={0.05}
        format={formatLevel}
        onChange={(v) => setLevel(v, `zoom-scale:${zoom.id}`)}
      />
      <Chips
        label="Zoom focus"
        value={focus.mode === 'cursor' && !cursorValid ? null : focus.mode}
        onChange={setFocusMode}
        options={[
          { value: 'cursor', label: 'Follow cursor', disabled: !cursorValid, title: cursorValid ? 'Follow the cursor' : 'No cursor data in this recording' },
          { value: 'fixed', label: 'Fixed point', title: 'Look at one point' },
          { value: 'region', label: 'Region', title: 'Frame a rectangle you draw on the preview' }
        ]}
      />
      {focus.mode === 'cursor' && level < 1 && <p className="hint">A pulled-back zoom stays centred while the cursor moves.</p>}
      {focus.mode === 'fixed' && (
        <>
          <button className={`btn ${props.pickFocus ? 'primary' : ''}`} onClick={() => (props.pickFocus ? props.onPickFocus(false) : startPicking())} aria-pressed={props.pickFocus}>
            <EditorIcon name="crosshair" size={16} /> {props.pickFocus ? 'Done picking' : 'Pick on preview'}
          </button>
          <Slider label="Focus X" value={focus.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: v, y: focus.y } }, `zoom-focus:${zoom.id}`)} />
          <Slider label="Focus Y" value={focus.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: focus.x, y: v } }, `zoom-focus:${zoom.id}`)} />
        </>
      )}
      {focus.mode === 'region' && (
        <>
          <button className={`btn ${props.pickFocus ? 'primary' : ''}`} onClick={() => (props.pickFocus ? props.onPickFocus(false) : startPicking())} aria-pressed={props.pickFocus}>
            <RegionIcon /> {props.pickFocus ? 'Done' : 'Draw on preview'}
          </button>
          <p className="hint" data-testid="zoom-region-readout">
            Frames {pctFmt(focus.w)} × {pctFmt(focus.h)} of the recording at {formatLevel(level)}. Drag on the preview to draw a new box, or move and resize it.
          </p>
        </>
      )}
      <div className="field-label zoom-subhead">
        <span>Motion</span>
        {ownStyle ? (
          <button className="link" onClick={() => setZoom({ easing: undefined, transition: undefined })} title="Use the project's zoom style for this zoom">
            Use zoom style
          </button>
        ) : (
          <span className="muted small">zoom style</span>
        )}
      </div>
      <div className="zoom-chips-fill">
        <Chips label="Zoom easing" value={easing} onChange={(v: ZoomEasing) => setZoom({ easing: v })} options={ZOOM_EASINGS} />
      </div>
      <Slider label="Transition" value={transition} min={MIN_TRANSITION} max={MAX_TRANSITION} step={0.05} format={secFmt} onChange={(v) => setZoom({ transition: v }, `zoom-transition:${zoom.id}`)} />
      <Toggle
        label="Pan to next zoom"
        checked={connected}
        disabled={!next}
        title={next ? 'Move straight to the next zoom instead of zooming out in between' : 'There is no zoom after this one'}
        onChange={toggleConnect}
      />
      <button
        className="btn ghost danger"
        onClick={() => {
          store.update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== zoom.id) }))
          props.onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> Delete zoom
      </button>
    </Section>
  )
}

function ZoomStyleSection({ project, onNotice }: { project: Project; onNotice: (m: string) => void }): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const settings = zoomSettingsOf(project)
  const set = (patch: Partial<ZoomSettings>, key?: string): void =>
    store.update((p) => ({ ...p, zoomSettings: { ...zoomSettingsOf(p), ...patch } }), key)
  const overridden = project.zooms.filter((z) => z.easing !== undefined || z.transition !== undefined).length
  return (
    <Section title="Zoom style" aside={<span className="muted small">all zooms</span>}>
      <div className="zoom-chips-fill">
        <Chips label="Default zoom easing" value={settings.easing} onChange={(easing: ZoomEasing) => set({ easing })} options={ZOOM_EASINGS} />
      </div>
      <Slider label="Transition" value={settings.transition} min={MIN_TRANSITION} max={MAX_TRANSITION} step={0.05} format={secFmt} onChange={(transition) => set({ transition }, 'zoomSettings.transition')} />
      <Slider label="New zoom level" value={settings.defaultScale} min={ZOOM_MIN_SCALE} max={ZOOM_MAX_SCALE} step={0.05} format={formatLevel} onChange={(defaultScale) => set({ defaultScale }, 'zoomSettings.defaultScale')} />
      <p className="hint">
        Every zoom without its own motion follows this style; zooms you add start at the new zoom level.
        {overridden > 0 ? ` ${plural(overridden, 'zoom')} ${overridden === 1 ? 'has its' : 'have their'} own.` : ''}
      </p>
      <div className="row start zoom-actions">
        <button
          className="btn"
          disabled={overridden === 0}
          onClick={() => {
            store.update((p) => ({ ...p, zooms: clearZoomStyles(p.zooms) }))
            onNotice(`Zoom style applied to all zooms${undoHint(keymap)}`)
          }}
        >
          Apply to all zooms
        </button>
      </div>
    </Section>
  )
}

function AutoZoomSection({ project, cursor, onNotice }: { project: Project; cursor: CursorTrack; onNotice: (m: string) => void }): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const settings = zoomSettingsOf(project)
  const auto = settings.auto
  const found = inputSummary(cursor, auto)
  const autoCount = project.zooms.filter((z) => z.auto).length
  const hasInput = (cursor.valid && cursor.clicks.some((c) => isZoomClick(c, true))) || found.typing > 0 || found.marks > 0

  /** Changes auto zoom settings and regenerates the automatic zooms with them (one undo step per drag). */
  const setAuto = (patch: Partial<AutoZoomSettings>, key?: string): void => {
    store.update((p) => {
      const zs = zoomSettingsOf(p)
      const next = { ...zs, auto: { ...zs.auto, ...patch } }
      const zooms = hasInput || !next.auto.enabled ? regenerateAutoZooms(p.zooms, cursor, p.duration, next.auto).zooms : p.zooms
      return { ...p, autoZoom: next.auto.enabled, zoomSettings: next, zooms }
    }, key)
  }

  const regenerate = (): void => {
    const r = regenerateAutoZooms(project.zooms, cursor, project.duration, { ...auto, enabled: true })
    store.update((p) => ({ ...p, autoZoom: true, zoomSettings: { ...zoomSettingsOf(p), auto: { ...zoomSettingsOf(p).auto, enabled: true } }, zooms: r.zooms }))
    onNotice(`Auto zoom: ${plural(r.added, 'zoom')}${r.kept ? `, ${r.kept} edited kept` : ''}`)
  }

  const removeAll = (): void => {
    const n = project.zooms.length
    store.update((p) => ({ ...p, zooms: [] }))
    onNotice(`Removed ${plural(n, 'zoom')}${undoHint(keymap)}`)
  }

  const sources = [
    found.clicks > 0 && plural(found.clicks, auto.rightClicks ? 'click' : 'left click'),
    found.typing > 0 && plural(found.typing, 'typing burst'),
    found.marks > 0 && plural(found.marks, 'zoom mark')
  ].filter(Boolean)

  return (
    <Section title="Auto zoom" aside={<span className="muted small">{plural(autoCount, 'automatic zoom')}</span>}>
      <p className="hint" data-testid="auto-zoom-summary">
        {hasInput
          ? `${sources.length ? sources.join(' · ') : 'No usable input'} detected. Changing these settings regenerates the automatic zooms; zooms you added or edited are kept.`
          : `${orPress('No clicks were captured, so add zooms yourself: double-click the zoom track', keymap.addZoom)}.`}
      </p>
      <Toggle label="Auto zoom" checked={auto.enabled} disabled={!hasInput} onChange={(enabled) => setAuto({ enabled })} />
      <div className={`auto-zoom-options ${auto.enabled && hasInput ? '' : 'off'}`}>
        <Slider label="Level" value={auto.scale} min={1.1} max={4} step={0.05} format={formatLevel} disabled={!auto.enabled || !hasInput} onChange={(scale) => setAuto({ scale }, 'auto.scale')} />
        <Slider label="Group clicks within" value={auto.clusterGap} min={0.5} max={8} step={0.1} format={(v) => `${v.toFixed(1)} s`} disabled={!auto.enabled || !hasInput} onChange={(clusterGap) => setAuto({ clusterGap }, 'auto.clusterGap')} />
        <Slider label="Zoom in before" value={auto.leadIn} min={0.2} max={2.5} step={0.05} format={secFmt} disabled={!auto.enabled || !hasInput} onChange={(leadIn) => setAuto({ leadIn }, 'auto.leadIn')} />
        <Slider label="Hold after" value={auto.hold} min={0.5} max={6} step={0.1} format={(v) => `${v.toFixed(1)} s`} disabled={!auto.enabled || !hasInput} onChange={(hold) => setAuto({ hold }, 'auto.hold')} />
        <Toggle label="Right clicks" checked={auto.rightClicks} disabled={!auto.enabled || !hasInput} onChange={(rightClicks) => setAuto({ rightClicks })} />
        <Toggle label="Typing" title="Zoom in on the place you type into" checked={auto.onTyping} disabled={!auto.enabled || !hasInput} onChange={(onTyping) => setAuto({ onTyping })} />
        <Toggle label="Zoom-here marks" title="Zoom where you pressed the zoom-here shortcut while recording" checked={auto.onMarks} disabled={!auto.enabled || !hasInput} onChange={(onMarks) => setAuto({ onMarks })} />
      </div>
      <div className="row start zoom-actions">
        <button className="btn" disabled={!hasInput} onClick={regenerate}>
          <Icon name="refresh" size={16} /> Regenerate
        </button>
        <button className="btn ghost danger" disabled={project.zooms.length === 0} onClick={removeAll}>
          <Icon name="trash" size={16} /> Remove all
        </button>
      </div>
    </Section>
  )
}

function RegionIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z" />
    </svg>
  )
}
