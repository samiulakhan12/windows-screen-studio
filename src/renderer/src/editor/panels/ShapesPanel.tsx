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
  STROKE_LIMITS
} from '../../../../shared/editor/shapes'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { cropOf, cropView, geometryFromCrop, rectToCrop } from '../../../../shared/engine/crop'
import { clamp } from '../../../../shared/engine/math'
import { itemKey } from '../../../../shared/editor/multiSelect'
import type { Clip, Project, Shape, ShapeKind, Spotlight } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import { useListSelect } from '../listSelect'
import { LookButtons } from '../LookButtons'
import { addShapeAt, addSpotlightAt, cursorPosFor, revealItem } from '../playheadItems'
import { ShapeIcon } from '../shapeIcons'
import '../shapes.css'
import { MagnifierSection } from './MagnifierSection'
import { isMagnifier, MAGNIFIER } from '../../../../shared/render/magnifier'
import { fmt } from '../../../../shared/i18n/fmt'
import { CalloutSection } from './CalloutSection'
import { t, uiLanguage } from '../../../../shared/i18n/t'
import { shapeKinds, shapeName } from '../../../../shared/editor/itemNames'
import { NumberField } from '../../i18n/NumberField'

type Item = { type: 'shape'; item: Shape } | { type: 'spotlight'; item: Spotlight }

/** "2 times": a magnifier's zoom in words (magnifier.ts's timesText, in the UI language). */
export const magnifierTimes = (z: number): string => t('text.shapesPanel.times', { n: fmt.number(Number(z.toFixed(2))) })

/** A spotlight's name in the list: "Cursor spotlight", "Spotlight", or "Magnifier, 2 times" (editing polish §2.2; magnifier.ts's spotlightName). */
const spotlightLabel = (s: Spotlight): string =>
  isMagnifier(s)
    ? t('text.shapesPanel.magnifierName', { times: magnifierTimes(clamp(s.magnify as number, MAGNIFIER.min, MAGNIFIER.max)) })
    : s.mode === 'cursor'
      ? t('text.shapesPanel.cursorSpotlightName')
      : t('text.shapesPanel.spotlightName')

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
  const keymap = useKeymap()
  const { project, selection, cursor } = props
  const shapes = project.shapes ?? []
  const spotlights = project.spotlights ?? []
  const shape = selection?.kind === 'shape' ? (shapes.find((s) => s.id === selection.id) ?? null) : null
  const spot = selection?.kind === 'spotlight' ? (spotlights.find((s) => s.id === selection.id) ?? null) : null
  const selId = selection && 'id' in selection ? selection.id : null

  /** Where viewers see the cursor at source time `t` (what a cursor spotlight follows), when it is over the recording (its crop's view). */
  const view = cropView(project, cursor)
  const cursorPos = (t: number): { x: number; y: number } | null => cursorPosFor(view.project, view.cursor, t)

  const addShape = (kind: ShapeKind): void => void addShapeAt(services, kind, cursor, { onSelect: props.onSelect })
  const addSpotlight = (mode: Spotlight['mode']): void => void addSpotlightAt(services, mode, { onSelect: props.onSelect })

  const items: Item[] = [...shapes.map((s): Item => ({ type: 'shape', item: s })), ...spotlights.map((s): Item => ({ type: 'spotlight', item: s }))].sort(
    (a, b) => a.item.start - b.item.start
  )

  return (
    <>
      {shape && <SelectedShape project={project} shape={shape} onSelect={props.onSelect} />}
      {spot && !isMagnifier(spot) && <SelectedSpotlight project={project} spot={spot} cursorValid={cursor.valid} cursorPos={cursorPos} onSelect={props.onSelect} />}
      {/* Editing polish (docs/design/editing-polish.md §2.2, §2.3): the magnifier (a selected one's panel too), and a shape's animation. */}
      <MagnifierSection project={project} selection={selection ?? null} cursor={cursor} />
      <CalloutSection project={project} selection={selection ?? null} />

      <Section title={t('text.shapesPanel.addAtPlayhead')}>
        <div className="shape-tools" role="group" aria-label={t('text.shapesPanel.addAShape')}>
          {shapeKinds().map((k) => (
            <button
              key={k.kind}
              className={`shape-tool ${isPrivacyKind(k.kind) ? 'privacy' : ''}`}
              data-kind={k.kind}
              title={withShortcut(k.title, keymap[ADD_COMMAND[k.kind]])}
              aria-label={t('text.shapesPanel.addKind', { kind: k.kind })}
              onClick={() => addShape(k.kind)}
            >
              <ShapeIcon name={k.kind} size={20} />
              <span>{k.label}</span>
            </button>
          ))}
        </div>
        <p className="hint">{t('text.shapesPanel.shapesStayOnThe')}</p>
      </Section>

      <Section title={t('text.shapesPanel.spotlight')}>
        <div className="shape-tools two" role="group" aria-label={t('text.shapesPanel.addASpotlight')}>
          <button
            className="shape-tool spotlight"
            data-kind="spotlight-cursor"
            disabled={!cursor.valid}
            title={cursor.valid ? withShortcut(t('text.shapesPanel.cursorSpotlightTitle'), keymap.addCursorSpotlight) : t('text.shapesPanel.noCursorDataIn')}
            aria-label={t('text.shapesPanel.addCursorSpotlight')}
            onClick={() => addSpotlight('cursor')}
          >
            <ShapeIcon name="spotlight-cursor" size={20} />
            <span>{t('text.shapesPanel.followCursor')}</span>
          </button>
          <button
            className="shape-tool spotlight"
            data-kind="spotlight-region"
            title={withShortcut(t('text.shapesPanel.regionSpotlightTitle'), keymap.addSpotlight)}
            aria-label={t('text.shapesPanel.addRegionSpotlight')}
            onClick={() => addSpotlight('region')}
          >
            <ShapeIcon name="spotlight-region" size={20} />
            <span>{t('text.shapesPanel.region')}</span>
          </button>
        </div>
      </Section>

      {items.length > 0 ? (
        <ShapeList project={project} items={items} selId={selId} onSelect={props.onSelect} />
      ) : (
        <p className="hint">{t('text.shapesPanel.addedItemsAppearOn')}</p>
      )}
    </>
  )
}

/** Every shape and spotlight, in time order: a click selects one; Ctrl/Shift and the keyboard select several (E-06). */
function ShapeList({ project, items, selId, onSelect }: { project: Project; items: Item[]; selId: string | null; onSelect: InspectorProps['onSelect'] }): JSX.Element {
  const { player } = useEditor()
  const list = useListSelect()
  return (
    <Section
      title={t('text.shapesPanel.inThisVideo', { n: fmt.count(items.length) })}
      aside={
        items.length > 1 ? (
          <button className="link small" onClick={() => list.selectAll(items.map(({ type, item }) => itemKey(type, item.id)))} title={t('text.shapesPanel.selectAllShapesAnd', { n: fmt.count(items.length) })}
          >
            {t('common.action.selectAll')}
          </button>
        ) : undefined
      }
    >
      <ul className="item-list shape-list">
        {items.slice(0, 200).map(({ type, item }) => {
          const key = itemKey(type, item.id)
          const selected = selId === item.id || list.member(key)
          return (
            <li key={item.id}>
              <button
                className={selected ? 'active' : ''}
                data-shape-item={item.id}
                {...list.row(key, () => {
                  onSelect({ kind: type, id: item.id })
                  revealItem(player, project.clips, item, type === 'spotlight' ? 'spotlight' : (item as Shape).kind)
                }, selId === item.id)}
              >
                <ShapeIcon name={type === 'shape' ? (item as Shape).kind : isMagnifier(item as Spotlight) ? 'magnifier' : (item as Spotlight).mode === 'cursor' ? 'spotlight-cursor' : 'spotlight-region'} size={15} />
                <span>{type === 'shape' ? shapeName((item as Shape).kind) : spotlightLabel(item as Spotlight)}</span>
                <span className="muted">
                  {fmt.clock(item.start, 'whole')} – {fmt.clock(item.end, 'whole')}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Section>
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
  const title = t('text.shapesPanel.selectedKind', { kind: shape.kind })

  return (
    <Section title={title} aside={<span className="muted small">{fmt.clock(shape.start)} – {fmt.clock(shape.end)}</span>}>
      <OnPreview item={shape} kind={shape.kind} clips={project.clips} />
      {privacy ? (
        <>
          <Chips<ShapeKind>
            label={t('text.shapesPanel.privacyEffect')}
            value={shape.kind}
            onChange={(kind) => set({ kind })}
            options={[
              { value: 'blur', label: shapeName('blur'), title: t('text.shapesPanel.blurTitle') },
              { value: 'pixelate', label: shapeName('pixelate'), title: t('text.shapesPanel.pixelateTitle') }
            ]}
          />
          <Slider
            label={shape.kind === 'blur' ? t('text.shapesPanel.blurAmount') : t('text.shapesPanel.pixelSize')}
            value={shape.strength}
            min={0}
            max={1}
            step={0.01}
            format={pctFmt}
            onChange={(v) => set({ strength: v }, `shape-strength:${id}`)}
          />
          <p className="hint">{t('text.shapesPanel.hidesWhatIsUnder')}</p>
        </>
      ) : (
        <>
          <ColorDots
            label={t('common.label.colour')}
            value={shape.color}
            presets={shape.kind === 'highlight' ? HIGHLIGHT_COLORS : SHAPE_COLORS}
            onChange={(color, key) => set({ color }, key ?? undefined)}
            mergeKey={`shape-color:${id}`}
          />
          {boxKind && <Toggle label={t('text.shapesPanel.filled')} checked={shape.fill} onChange={(fill) => set({ fill })} />}
          {hasStroke(shape) && (
            <Slider
              label={t('text.shapesPanel.lineWidth')}
              value={shape.strokeWidth}
              min={STROKE_LIMITS.min}
              max={STROKE_LIMITS.max}
              step={0.5}
              format={(v) => t('text.shapesPanel.px', { n: fmt.number(+v.toFixed(1)) })}
              onChange={(v) => set({ strokeWidth: v }, `shape-stroke:${id}`)}
            />
          )}
          <Slider label={t('common.label.opacity')} value={shape.opacity} min={0.1} max={1} step={0.01} format={pctFmt} onChange={(v) => set({ opacity: v }, `shape-opacity:${id}`)} />
          <p className="hint">{shape.kind === 'arrow' || shape.kind === 'line' ? t('text.shapesPanel.dragItsEndsOn') : t('text.shapesPanel.dragItOnThe')}</p>
        </>
      )}
      <TimeFields project={project} item={shape} onChange={(times) => set(times, `shape-time:${id}`)} />
      <LookButtons itemKey={itemKey('shape', id)} />
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
        kind={shape.kind}
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
  // Its size as the preview draws it (in the crop's view); edits are stored in the full frame.
  const crop = cropOf(project)
  const size = rectToCrop(crop, spot)
  const set = (patch: Partial<Spotlight>, key?: string): void =>
    store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }), key)
  const setMode = (mode: Spotlight['mode']): void => {
    if (mode === spot.mode) return
    if (mode === 'region') {
      // Stay where the cursor spotlight is now instead of jumping to its old box (placed in the crop's view).
      const at = cursorPos(itemVisibleAt(spot, player.time) ? player.time : spot.start)
      set(at ? { mode, ...geometryFromCrop(crop, { x: clamp(at.x - size.w / 2, 0, 1 - size.w), y: clamp(at.y - size.h / 2, 0, 1 - size.h) }) } : { mode })
    } else {
      set({ mode })
    }
  }

  return (
    <Section title={t('text.shapesPanel.selectedSpotlight')} aside={<span className="muted small">{fmt.clock(spot.start)} – {fmt.clock(spot.end)}</span>}>
      <OnPreview item={spot} kind="spotlight" clips={project.clips} />
      <Chips<Spotlight['mode']>
        label={t('text.shapesPanel.spotlightFollows')}
        value={spot.mode === 'cursor' && !cursorValid ? null : spot.mode}
        onChange={setMode}
        options={[
          { value: 'cursor', label: t('text.shapesPanel.followsCursor'), disabled: !cursorValid, title: cursorValid ? t('text.shapesPanel.followsCursorTitle') : t('text.shapesPanel.noCursorDataIn') },
          { value: 'region', label: t('text.shapesPanel.region'), title: t('text.shapesPanel.followsRegionTitle') }
        ]}
      />
      <Chips<Spotlight['shape']>
        label={t('text.shapesPanel.spotlightShape')}
        value={spot.shape}
        onChange={(shape) => set({ shape })}
        options={[
          { value: 'ellipse', label: t('text.shapesPanel.spotEllipse') },
          { value: 'rect', label: t('text.shapesPanel.spotRectangle') }
        ]}
      />
      <Slider label={t('text.shapesPanel.darkness')} value={spot.dim} min={0.1} max={0.95} step={0.01} format={pctFmt} onChange={(v) => set({ dim: v }, `spot-dim:${id}`)} />
      <Slider label={t('text.shapesPanel.softEdge')} value={spot.feather} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => set({ feather: v }, `spot-feather:${id}`)} />
      {spot.mode === 'cursor' && (
        <Slider
          label={t('common.label.size')}
          value={size.h}
          min={0.06}
          max={1}
          step={0.01}
          format={pctFmt}
          onChange={(h) => {
            // Keeps the spot's shape in the view: the height stops where the width reaches its limits.
            const ratio = size.w / size.h
            const k = Math.min(clamp(h, 0.04 / ratio, 2 / ratio), 2)
            set(geometryFromCrop(crop, { h: k, w: ratio * k }), `spot-size:${id}`)
          }}
        />
      )}
      <p className="hint">{spot.mode === 'cursor' ? t('text.shapesPanel.followsTheCursorDrag') : t('text.shapesPanel.dragTheLitArea')}</p>
      <TimeFields project={project} item={spot} onChange={(times) => set(times, `spot-time:${id}`)} />
      <LookButtons itemKey={itemKey('spotlight', id)} />
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
        kind="spotlight"
      />
    </Section>
  )
}

/* ---------- shared controls ---------- */

/**
 * The selected item is edited on the preview while the frame there shows it: when it does not,
 * a link moves the playhead there (onto a kept frame where it is fully shown).
 */
export function OnPreview({ item, kind, clips }: { item: { start: number; end: number }; kind: ShapeKind | 'spotlight'; clips: Clip[] }): JSX.Element | null {
  const { player } = useEditor()
  // The frame the preview shows (inside a cut, the next kept one), as the preview's handles use.
  const [inside, setInside] = useState(() => itemVisibleAt(item, displayTime(clips, player.time)))
  useEffect(() => {
    const check = (): void => setInside(itemVisibleAt(item, displayTime(clips, player.time)))
    check()
    return player.subscribe(check)
  }, [item, clips, player])
  if (inside) return null
  if (revealKeptTime(item, kind, clips, player.time) === null) return <p className="hint shape-offscreen">{t('text.shapesPanel.notInTheVideo')}</p>
  return (
    <p className="hint shape-offscreen">
      {t('text.shapesPanel.notOnScreenAt')}{' '}
      <button className="link" onClick={() => revealItem(player, clips, item, kind)}>
        {t('text.shapesPanel.showItOnThe')}
      </button>
    </p>
  )
}

/** Start and end in seconds, typed or set from the playhead. */
export function TimeFields({ project, item, onChange }: { project: Project; item: { start: number; end: number }; onChange: (t: { start: number; end: number }) => void }): JSX.Element {
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
      {row('start', t('text.shapesPanel.startsAt'))}
      {row('end', t('text.shapesPanel.endsAt'))}
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
  const typed = (text: string): void => {
    setDraft(text)
    const v = parse(text)
    if (v !== null && fits(v)) onCommit(v)
  }
  const leave = (): void => {
    const v = draft === null ? null : parse(draft)
    if (v !== null && Math.abs(v - value) > 1e-6) onCommit(v)
    setDraft(null)
  }
  return (
    <>
      <span className="field-label">{label}</span>
      {/* English keeps today's number input, which holds what is typed as text; other languages type their own digits (§11.1). */}
      {uiLanguage() === 'en' ? (
        <input
          className="shape-time-input"
          type="number"
          aria-label={label}
          min={0}
          max={Math.round(max * 100) / 100}
          step={0.1}
          value={draft ?? (Math.round(value * 100) / 100).toString()}
          onChange={(e) => typed(e.target.value)}
          onBlur={leave}
        />
      ) : (
        <NumberField
          className="shape-time-input"
          aria-label={label}
          min={0}
          max={Math.round(max * 100) / 100}
          step={0.1}
          value={Math.round(value * 100) / 100}
          onValue={(v) => typed(Number.isFinite(v) ? String(v) : '')}
          onBlur={leave}
        />
      )}
      <button className="btn ghost shape-time-now" onClick={onPlayhead} title={t('text.shapesPanel.setToThePlayhead', { label })} aria-label={t('text.shapesPanel.setToThePlayhead', { label })}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v18M7 3h10l-5 5z" />
        </svg>
      </button>
    </>
  )
}

export function ItemActions({ onDuplicate, onDelete, kind }: { onDuplicate: () => void; onDelete: () => void; kind: ShapeKind | 'spotlight' | 'magnifier' }): JSX.Element {
  const keymap = useKeymap()
  return (
    <div className="row start shape-actions">
      <button className="btn" onClick={onDuplicate} title={t('text.shapesPanel.duplicateThis', { kind })}>
        <ShapeIcon name="duplicate" size={16} /> {t('text.shapesPanel.duplicate')}
      </button>
      <button className="btn ghost danger" onClick={onDelete} title={withShortcut(t('text.shapesPanel.deleteThis', { kind }), keymap.deleteSelection)}>
        <Icon name="trash" size={16} /> {t('common.action.delete')}
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
      <label className={`shape-color custom ${custom ? 'active' : ''}`} title={t('common.colour.pickAny')} style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={t('common.colour.anyFor', { label: String(label) })} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}
