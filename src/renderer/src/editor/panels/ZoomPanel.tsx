import { formatTime } from '../../../../shared/engine/project'
import { isUsableClick, regenerateAutoZooms } from '../../../../shared/engine/zoom'
import type { ZoomSegment } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'

/* ---------- Zoom ---------- */

export function ZoomPanel(props: InspectorProps): JSX.Element {
  const { store, player } = useEditor()
  const { project, selection } = props
  const zoom = selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id) ?? null) : null
  const clicks = props.cursor.clicks.filter(isUsableClick)
  const cursorValid = props.cursor.valid
  const autoCount = project.zooms.filter((z) => z.auto).length

  const setZoom = (patch: Partial<ZoomSegment>, key?: string): void => {
    if (!zoom) return
    store.update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === zoom.id ? { ...z, ...patch, auto: false } : z)) }), key)
  }

  const regenerate = (): void => {
    const r = regenerateAutoZooms(project.zooms, props.cursor.clicks, project.duration)
    store.update((p) => ({ ...p, autoZoom: true, zooms: r.zooms }))
    props.onNotice(`Auto zoom: ${r.added} zoom${r.added === 1 ? '' : 's'} from clicks${r.kept ? `, ${r.kept} edited kept` : ''}`)
  }

  const removeAll = (): void => {
    const n = project.zooms.length
    store.update((p) => ({ ...p, zooms: [] }))
    props.onNotice(`Removed ${n} zoom${n === 1 ? '' : 's'} · Ctrl+Z to undo`)
  }

  return (
    <>
      <Section title="Auto zoom">
        <p className="hint">
          {clicks.length > 0
            ? `${clicks.length} click${clicks.length === 1 ? '' : 's'} detected. Regenerating replaces the ${autoCount} automatic zoom${autoCount === 1 ? '' : 's'}; zooms you added or edited are kept.`
            : 'No clicks were captured, so add zooms yourself: press Z or double-click the zoom track.'}
        </p>
        <div className="row start">
          <button className="btn" disabled={clicks.length === 0} onClick={regenerate}>
            <Icon name="refresh" size={16} /> Regenerate
          </button>
          <button className="btn ghost danger" disabled={project.zooms.length === 0} onClick={removeAll}>
            <Icon name="trash" size={16} /> Remove all
          </button>
        </div>
      </Section>
      {zoom ? (
        <Section title="Selected zoom" aside={<span className="muted small">{zoom.auto ? 'automatic' : 'edited'}</span>}>
          <p className="hint">
            {formatTime(zoom.start)} – {formatTime(zoom.end)}
          </p>
          <Slider label="Zoom level" value={zoom.scale} min={1.1} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setZoom({ scale: v }, `zoom-scale:${zoom.id}`)} />
          <Chips
            label="Zoom focus"
            value={zoom.focus.mode === 'cursor' && cursorValid ? 'cursor' : zoom.focus.mode === 'fixed' ? 'fixed' : null}
            onChange={(mode) => {
              if (mode === 'cursor') {
                setZoom({ focus: { mode: 'cursor' } })
                props.onPickFocus(false)
              } else if (zoom.focus.mode !== 'fixed') {
                // Keep looking where the zoom looks now instead of jumping to the centre.
                const f = props.focusFor(zoom)
                setZoom({ focus: { mode: 'fixed', x: f.x, y: f.y } })
              }
            }}
            options={[
              { value: 'cursor', label: 'Follow cursor', disabled: !cursorValid, title: cursorValid ? undefined : 'No cursor data in this recording' },
              { value: 'fixed', label: 'Fixed point' }
            ]}
          />
          {zoom.focus.mode === 'fixed' && (
            <>
              <button
                className={`btn ${props.pickFocus ? 'primary' : ''}`}
                onClick={() => {
                  if (!props.pickFocus && (player.time < zoom.start || player.time >= zoom.end)) player.seek((zoom.start + zoom.end) / 2)
                  props.onPickFocus(!props.pickFocus)
                }}
                aria-pressed={props.pickFocus}
              >
                <EditorIcon name="crosshair" size={16} /> {props.pickFocus ? 'Done picking' : 'Pick on preview'}
              </button>
              <Slider label="Focus X" value={zoom.focus.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: v, y: (zoom.focus as { y: number }).y } }, `zoom-focus:${zoom.id}`)} />
              <Slider label="Focus Y" value={zoom.focus.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: (zoom.focus as { x: number }).x, y: v } }, `zoom-focus:${zoom.id}`)} />
            </>
          )}
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
      ) : (
        <p className="hint">Select a zoom on the timeline to edit it, or press Z to add one at the playhead.</p>
      )}
    </>
  )
}
