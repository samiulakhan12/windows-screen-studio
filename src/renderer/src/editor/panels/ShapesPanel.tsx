import { useEffect, useState } from 'react'
import { displayTime } from '../../../../shared/editor/clips'
import type { CommandId } from '../../../../shared/editor/commands'
import {
  duplicateItem,
  hasStroke,
  HIGHLIGHT_COLORS,
  isPrivacyKind,
  itemVisibleAt,
  MIN_SHAPE_LENGTH,
  revealKeptTime,
  setItemTime,
  SHAPE_COLORS,
  SHAPE_KINDS,
  shapeLabel,
  STROKE_LIMITS
} from '../../../../shared/editor/shapes'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { clamp } from '../../../../shared/engine/math'
import { formatTime } from '../../../../shared/engine/project'
import type { Clip, Project, Shape, ShapeKind, Spotlight } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import { addShapeAt, addSpotlightAt, cursorPosFor, revealItem } from '../playheadItems'
import { ShapeIcon } from '../shapeIcons'
import '../shapes.css'

type Item = { type: 'shape'; item: Shape } | { type: 'spotlight'; item: Spotlight }

const spotlightLabel = (s: Spotlight): string => (s.mode === 'cursor' ? 'Cursor spotlight' : 'Spotlight')

/** Which command adds each kind (its shortcut, if the user gave it one, goes in the tooltip). */
const ADD_COMMAND: Record<ShapeKind, CommandId> = {
  arrow: 'addArrow',
  line: 'addLine',
  rect: 'addRect',
  ellipse: 'addEllipse',
  highlight: 'addHighlight',
  blur: 'addBlur',
  pixelate: 'addPixelate'
}

/* ---------- Shapes, privacy blur and spotlight ---------- */

export function ShapesPanel(props: InspectorProps): JSX.Element {
  const services = useEditor()
  const { player } = services
  const keymap = useKeymap()
  const { project, selection, cursor } = props
  const shapes = project.shapes ?? []
  const spotlights = project.spotlights ?? []
  const shape = selection?.kind === 'shape' ? (shapes.find((s) => s.id === selection.id) ?? null) : null
  const spot = selection?.kind === 'spotlight' ? (spotlights.find((s) => s.id === selection.id) ?? null) : null
  const selId = selection && 'id' in selection ? selection.id : null

  /** Where viewers see the cursor at source time `t` (what a cursor spotlight follows), when it is over the recording. */
  const cursorPos = (t: number): { x: number; y: number } | null => cursorPosFor(project, cursor, t)

  const addShape = (kind: ShapeKind): void => void addShapeAt(services, kind, cursor, { onSelect: props.onSelect })
  const addSpotlight = (mode: Spotlight['mode']): void => void addSpotlightAt(services, mode, { onSelect: props.onSelect })

  const items: Item[] = [...shapes.map((s): Item => ({ type: 'shape', item: s })), ...spotlights.map((s): Item => ({ type: 'spotlight', item: s }))].sort(
    (a, b) => a.item.start - b.item.start
  )

  return (
    <>
      {shape && <SelectedShape project={project} shape={shape} onSelect={props.onSelect} />}
      {spot && <SelectedSpotlight project={project} spot={spot} cursorValid={cursor.valid} cursorPos={cursorPos} onSelect={props.onSelect} />}

      <Section title="Add at playhead">
        <div className="shape-tools" role="group" aria-label="Add a shape">
          {SHAPE_KINDS.map((k) => (
            <button
              key={k.kind}
              className={`shape-tool ${isPrivacyKind(k.kind) ? 'privacy' : ''}`}
              data-kind={k.kind}
              title={withShortcut(k.title, keymap[ADD_COMMAND[k.kind]])}
              aria-label={`Add ${k.label.toLowerCase()}`}
              onClick={() => addShape(k.kind)}
            >
              <ShapeIcon name={k.kind} size={20} />
              <span>{k.label}</span>
            </button>
          ))}
        </div>
        <p className="hint">Shapes stay on the content while the camera zooms. Blur and pixelate are always fully applied and drawn under the cursor.</p>
      </Section>

      <Section title="Spotlight">
        <div className="shape-tools two" role="group" aria-label="Add a spotlight">
          <button
            className="shape-tool spotlight"
            data-kind="spotlight-cursor"
            disabled={!cursor.valid}
            title={cursor.valid ? withShortcut('Dim everything but the area around the cursor', keymap.addCursorSpotlight) : 'No cursor data in this recording'}
            aria-label="Add cursor spotlight"
            onClick={() => addSpotlight('cursor')}
          >
            <ShapeIcon name="spotlight-cursor" size={20} />
            <span>Follow cursor</span>
          </button>
          <button
            className="shape-tool spotlight"
            data-kind="spotlight-region"
            title={withShortcut('Dim everything but an area you place', keymap.addSpotlight)}
            aria-label="Add region spotlight"
            onClick={() => addSpotlight('region')}
          >
            <ShapeIcon name="spotlight-region" size={20} />
            <span>Region</span>
          </button>
        </div>
      </Section>

      {items.length > 0 ? (
        <Section title={`In this video (${items.length})`}>
          <ul className="item-list shape-list">
            {items.slice(0, 200).map(({ type, item }) => {
              const selected = selId === item.id
              return (
                <li key={item.id}>
                  <button
                    className={selected ? 'active' : ''}
                    data-shape-item={item.id}
                    onClick={() => {
                      props.onSelect({ kind: type, id: item.id })
                      revealItem(player, project.clips, item, type === 'spotlight' ? 'spotlight' : (item as Shape).kind)
                    }}
                  >
                    <ShapeIcon name={type === 'shape' ? (item as Shape).kind : (item as Spotlight).mode === 'cursor' ? 'spotlight-cursor' : 'spotlight-region'} size={15} />
                    <span>{type === 'shape' ? shapeLabel((item as Shape).kind) : spotlightLabel(item as Spotlight)}</span>
                    <span className="muted">
                      {formatTime(item.start, false)} – {formatTime(item.end, false)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Section>
      ) : (
        <p className="hint">Added items appear on the shapes track of the timeline: drag them to change when they show, and drag them on the preview to place them.</p>
      )}
    </>
  )
}

/* ---------- selected shape ---------- */

function SelectedShape({ project, shape, onSelect }: { project: Project; shape: Shape; onSelect: InspectorProps['onSelect'] }): JSX.Element {
  const { store } = useEditor()
  const id = shape.id
  const set = (patch: Partial<Shape>, key?: string): void =>
    store.update((p) => ({ ...p, shapes: (p.shapes ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }), key)
  const privacy = isPrivacyKind(shape.kind)
  const boxKind = shape.kind === 'rect' || shape.kind === 'ellipse'
  const title = `Selected ${shapeLabel(shape.kind).toLowerCase()}`

  return (
    <Section title={title} aside={<span className="muted small">{formatTime(shape.start)} – {formatTime(shape.end)}</span>}>
      <OnPreview item={shape} kind={shape.kind} clips={project.clips} />
      {privacy ? (
        <>
          <Chips<ShapeKind>
            label="Privacy effect"
            value={shape.kind}
            onChange={(kind) => set({ kind })}
            options={[
              { value: 'blur', label: 'Blur', title: 'A soft blur over the area' },
              { value: 'pixelate', label: 'Pixelate', title: 'Large square pixels over the area' }
            ]}
          />
          <Slider
            label={shape.kind === 'blur' ? 'Blur amount' : 'Pixel size'}
            value={shape.strength}
            min={0}
            max={1}
            step={0.01}
            format={pctFmt}
            onChange={(v) => set({ strength: v }, `shape-strength:${id}`)}
          />
          <p className="hint">Hides what is under it for its whole time on screen, also while the camera moves. The cursor stays visible on top.</p>
        </>
      ) : (
        <>
          <ColorDots
            label="Colour"
            value={shape.color}
            presets={shape.kind === 'highlight' ? HIGHLIGHT_COLORS : SHAPE_COLORS}
            onChange={(color, key) => set({ color }, key ?? undefined)}
            mergeKey={`shape-color:${id}`}
          />
          {boxKind && <Toggle label="Filled" checked={shape.fill} onChange={(fill) => set({ fill })} />}
          {hasStroke(shape) && (
            <Slider
              label="Line width"
              value={shape.strokeWidth}
              min={STROKE_LIMITS.min}
              max={STROKE_LIMITS.max}
              step={0.5}
              format={(v) => `${+v.toFixed(1)} px`}
              onChange={(v) => set({ strokeWidth: v }, `shape-stroke:${id}`)}
            />
          )}
          <Slider label="Opacity" value={shape.opacity} min={0.1} max={1} step={0.01} format={pctFmt} onChange={(v) => set({ opacity: v }, `shape-opacity:${id}`)} />
          <p className="hint">{shape.kind === 'arrow' || shape.kind === 'line' ? 'Drag its ends on the preview, or drag elsewhere to draw it again.' : 'Drag it on the preview to move it, its handles to resize, or drag elsewhere to draw it again.'}</p>
        </>
      )}
      <TimeFields project={project} item={shape} onChange={(times) => set(times, `shape-time:${id}`)} />
      <ItemActions
        onDuplicate={() => {
          const copy = duplicateItem(shape)
          store.update((p) => ({ ...p, shapes: [...(p.shapes ?? []), copy] }))
          onSelect({ kind: 'shape', id: copy.id })
        }}
        onDelete={() => {
          store.update((p) => ({ ...p, shapes: (p.shapes ?? []).filter((s) => s.id !== id) }))
          onSelect(null)
        }}
        what={shapeLabel(shape.kind).toLowerCase()}
      />
    </Section>
  )
}

/* ---------- selected spotlight ---------- */

function SelectedSpotlight({
  project,
  spot,
  cursorValid,
  cursorPos,
  onSelect
}: {
  project: Project
  spot: Spotlight
  cursorValid: boolean
  cursorPos: (t: number) => { x: number; y: number } | null
  onSelect: InspectorProps['onSelect']
}): JSX.Element {
  const { store, player } = useEditor()
  const id = spot.id
  const set = (patch: Partial<Spotlight>, key?: string): void =>
    store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }), key)
  const setMode = (mode: Spotlight['mode']): void => {
    if (mode === spot.mode) return
    if (mode === 'region') {
      // Stay where the cursor spotlight is now instead of jumping to its old box.
      const at = cursorPos(itemVisibleAt(spot, player.time) ? player.time : spot.start)
      set(at ? { mode, x: clamp(at.x - spot.w / 2, 0, 1 - spot.w), y: clamp(at.y - spot.h / 2, 0, 1 - spot.h) } : { mode })
    } else {
      set({ mode })
    }
  }

  return (
    <Section title="Selected spotlight" aside={<span className="muted small">{formatTime(spot.start)} – {formatTime(spot.end)}</span>}>
      <OnPreview item={spot} kind="spotlight" clips={project.clips} />
      <Chips<Spotlight['mode']>
        label="Spotlight follows"
        value={spot.mode === 'cursor' && !cursorValid ? null : spot.mode}
        onChange={setMode}
        options={[
          { value: 'cursor', label: 'Cursor', disabled: !cursorValid, title: cursorValid ? 'The lit area follows the cursor' : 'No cursor data in this recording' },
          { value: 'region', label: 'Region', title: 'The lit area stays on the content you place it on' }
        ]}
      />
      <Chips<Spotlight['shape']>
        label="Spotlight shape"
        value={spot.shape}
        onChange={(shape) => set({ shape })}
        options={[
          { value: 'ellipse', label: 'Ellipse' },
          { value: 'rect', label: 'Rectangle' }
        ]}
      />
      <Slider label="Darkness" value={spot.dim} min={0.1} max={0.95} step={0.01} format={pctFmt} onChange={(v) => set({ dim: v }, `spot-dim:${id}`)} />
      <Slider label="Soft edge" value={spot.feather} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => set({ feather: v }, `spot-feather:${id}`)} />
      {spot.mode === 'cursor' && (
        <Slider
          label="Size"
          value={spot.h}
          min={0.06}
          max={1}
          step={0.01}
          format={pctFmt}
          onChange={(h) => set({ h, w: clamp((spot.w / spot.h) * h, 0.04, 2) }, `spot-size:${id}`)}
        />
      )}
      <p className="hint">{spot.mode === 'cursor' ? 'Follows the cursor. Drag its corners on the preview to resize it.' : 'Drag the lit area on the preview to move it, its handles to resize it.'}</p>
      <TimeFields project={project} item={spot} onChange={(times) => set(times, `spot-time:${id}`)} />
      <ItemActions
        onDuplicate={() => {
          const copy = duplicateItem(spot)
          store.update((p) => ({ ...p, spotlights: [...(p.spotlights ?? []), copy] }))
          onSelect({ kind: 'spotlight', id: copy.id })
        }}
        onDelete={() => {
          store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).filter((s) => s.id !== id) }))
          onSelect(null)
        }}
        what="spotlight"
      />
    </Section>
  )
}

/* ---------- shared controls ---------- */

/**
 * The selected item is edited on the preview while the frame there shows it: when it does not,
 * a link moves the playhead there (onto a kept frame where it is fully shown).
 */
function OnPreview({ item, kind, clips }: { item: { start: number; end: number }; kind: ShapeKind | 'spotlight'; clips: Clip[] }): JSX.Element | null {
  const { player } = useEditor()
  // The frame the preview shows (inside a cut, the next kept one), as the preview's handles use.
  const [inside, setInside] = useState(() => itemVisibleAt(item, displayTime(clips, player.time)))
  useEffect(() => {
    const check = (): void => setInside(itemVisibleAt(item, displayTime(clips, player.time)))
    check()
    return player.subscribe(check)
  }, [item, clips, player])
  if (inside) return null
  if (revealKeptTime(item, kind, clips, player.time) === null) return <p className="hint shape-offscreen">Not in the video: all of it is in a part that is cut.</p>
  return (
    <p className="hint shape-offscreen">
      Not on screen at the playhead.{' '}
      <button className="link" onClick={() => revealItem(player, clips, item, kind)}>
        Show it on the preview
      </button>
    </p>
  )
}

/** Start and end in seconds, typed or set from the playhead. */
function TimeFields({ project, item, onChange }: { project: Project; item: { start: number; end: number }; onChange: (t: { start: number; end: number }) => void }): JSX.Element {
  const { player } = useEditor()
  const len = Math.min(MIN_SHAPE_LENGTH, project.duration)
  const row = (edge: 'start' | 'end', label: string): JSX.Element => (
    <TimeField
      label={label}
      value={item[edge]}
      max={project.duration}
      // While typing, only values that leave the other end where it is apply at once.
      fits={(v) => (edge === 'start' ? v >= 0 && v <= item.end - len : v >= item.start + len && v <= project.duration)}
      onCommit={(v) => onChange(setItemTime(item, edge, v, project.duration))}
      onPlayhead={() => onChange(setItemTime(item, edge, player.time, project.duration))}
    />
  )
  return (
    <div className="shape-times">
      {row('start', 'Starts at')}
      {row('end', 'Ends at')}
    </div>
  )
}

function TimeField({
  label,
  value,
  max,
  fits,
  onCommit,
  onPlayhead
}: {
  label: string
  value: number
  max: number
  fits: (v: number) => boolean
  onCommit: (v: number) => void
  onPlayhead: () => void
}): JSX.Element {
  // The field keeps what is typed; the project gets it as soon as it fits, or when leaving the field.
  const [draft, setDraft] = useState<string | null>(null)
  const parse = (text: string): number | null => {
    const v = Number(text)
    return text.trim() !== '' && Number.isFinite(v) ? v : null
  }
  return (
    <>
      <span className="field-label">{label}</span>
      <input
        className="shape-time-input"
        type="number"
        aria-label={label}
        min={0}
        max={Math.round(max * 100) / 100}
        step={0.1}
        value={draft ?? (Math.round(value * 100) / 100).toString()}
        onChange={(e) => {
          setDraft(e.target.value)
          const v = parse(e.target.value)
          if (v !== null && fits(v)) onCommit(v)
        }}
        onBlur={() => {
          const v = draft === null ? null : parse(draft)
          if (v !== null && Math.abs(v - value) > 1e-6) onCommit(v)
          setDraft(null)
        }}
      />
      <button className="btn ghost shape-time-now" onClick={onPlayhead} title={`${label}: set to the playhead`} aria-label={`${label}: set to the playhead`}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v18M7 3h10l-5 5z" />
        </svg>
      </button>
    </>
  )
}

function ItemActions({ onDuplicate, onDelete, what }: { onDuplicate: () => void; onDelete: () => void; what: string }): JSX.Element {
  const keymap = useKeymap()
  return (
    <div className="row start shape-actions">
      <button className="btn" onClick={onDuplicate} title={`Duplicate this ${what}`}>
        <ShapeIcon name="duplicate" size={16} /> Duplicate
      </button>
      <button className="btn ghost danger" onClick={onDelete} title={withShortcut(`Delete this ${what}`, keymap.deleteSelection)}>
        <Icon name="trash" size={16} /> Delete
      </button>
    </div>
  )
}

/** Preset colours and a "pick any colour" dot. */
function ColorDots({
  label,
  value,
  presets,
  onChange,
  mergeKey
}: {
  label: string
  value: string
  presets: string[]
  onChange: (color: string, key: string | null) => void
  mergeKey: string
}): JSX.Element {
  const v = value.toLowerCase()
  const custom = !presets.includes(v)
  return (
    <div className="shape-colors" role="group" aria-label={label}>
      {presets.map((c) => (
        <button
          key={c}
          className={`shape-color ${v === c ? 'active' : ''}`}
          style={{ background: c }}
          title={c}
          aria-label={`${label} ${c}`}
          aria-pressed={v === c}
          onClick={() => onChange(c, null)}
        />
      ))}
      <label className={`shape-color custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={`${label} (any colour)`} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}
