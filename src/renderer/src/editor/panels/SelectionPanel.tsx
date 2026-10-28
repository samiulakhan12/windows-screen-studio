import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { displayTime } from '../../../../shared/editor/clips'
import type { CommandId } from '../../../../shared/editor/commands'
import { applyField, fieldItems, fieldsFor, fieldValue, LOOK_CLASS_WORDS, lookClassOf, type FieldCtx, type GroupField, type LookClass } from '../../../../shared/editor/groupEdit'
import { setGroupLength, setGroupStart } from '../../../../shared/editor/groupMove'
import { countOf, GROUP_KINDS, groupLabel, kindCounts, KIND_WORDS, projectItems, toggleKey, type GroupKind, type ItemEntry, type ItemKey } from '../../../../shared/editor/multiSelect'
import { copyLookFirst, movedNotice } from '../../../../shared/editor/multiSelectCopy'
import { shapeLabel } from '../../../../shared/editor/shapes'
import { commandKeys, shortcutLabel, withShortcut } from '../../../../shared/editor/shortcuts'
import { formatLevel, ZOOM_LEVEL_PRESETS } from '../../../../shared/editor/zoomEdit'
import { cropOf, zoomInView } from '../../../../shared/engine/crop'
import { formatTime } from '../../../../shared/engine/project'
import { zoomStyleOf, zoomTargetScale } from '../../../../shared/engine/zoom'
import type { Project, Shape } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Section } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { keepInspectorFocus } from '../inspectorFocus'
import { useGroup } from '../groupContext'
import type { InspectorProps } from '../Inspector'
import { useLookClipboard } from '../itemClipboard'
import { useKeymap } from '../keymapContext'
import { GroupTimeField, MixedChips, MixedColorDots, MixedSlider, MixedToggle } from '../mixedControls'
import { ShapeIcon } from '../shapeIcons'
import '../multiSelect.css'
import '../shapes.css'
import { overlayLabel } from '../../../../shared/editor/overlays'

/** Section titles of the look classes, in their order (§4.9 item 5). */
const CLASS_TITLE: Readonly<Record<LookClass, string>> = {
  zoom: 'Zooms',
  text: 'Text',
  mark: 'Shapes',
  privacy: 'Privacy',
  spotlight: 'Spotlights',
  image: 'Images',
  title: 'Title cards',
  freeze: 'Freeze frames'
}

/** Kinds with a start and an end (Length applies to them). */
const SPAN_KINDS: readonly GroupKind[] = ['zoom', 'annotation', 'shape', 'spotlight', 'overlay', 'title']

/** A row's icon: the kind's track icon, or the shape's own. */
function KindIcon({ kind, project, id }: { kind: GroupKind; project: Project; id: string }): JSX.Element {
  if (kind === 'shape') {
    const s = project.shapes?.find((x) => x.id === id)
    return <ShapeIcon name={s?.kind ?? 'rect'} size={14} />
  }
  if (kind === 'spotlight') return <ShapeIcon name={project.spotlights?.find((x) => x.id === id)?.mode === 'cursor' ? 'spotlight-cursor' : 'spotlight-region'} size={14} />
  if (kind === 'zoom') return <Icon name="zoom" size={14} />
  if (kind === 'freeze') return <Icon name="pause" size={14} />
  if (kind === 'overlay') return <EditorIcon name="image" size={14} />
  return <EditorIcon name="text" size={14} />
}

/** What a row calls an item: its text, title or name, "Zoom 2×", a shape's kind, "Freeze frame". */
function itemName(p: Project, e: ItemEntry): string {
  switch (e.kind) {
    case 'zoom': {
      const z = p.zooms.find((x) => x.id === e.id)
      return z ? `Zoom ${formatLevel(zoomTargetScale(zoomInView(cropOf(p), z)))}` : 'Zoom'
    }
    case 'annotation':
      return p.annotations.find((x) => x.id === e.id)?.text.trim() || 'Text'
    case 'shape': {
      const s = p.shapes?.find((x) => x.id === e.id)
      return s ? shapeLabel(s.kind) : 'Shape'
    }
    case 'spotlight':
      return p.spotlights?.find((x) => x.id === e.id)?.mode === 'cursor' ? 'Cursor spotlight' : 'Spotlight'
    case 'title': {
      const c = p.titles?.find((x) => x.id === e.id)
      return c?.title.trim() || c?.subtitle?.trim() || 'Title card'
    }
    case 'chapter':
      return p.chapters?.find((x) => x.id === e.id)?.title.trim() || 'Chapter'
    case 'freeze':
      return 'Freeze frame'
    case 'overlay': {
      const o = p.overlays?.find((x) => x.id === e.id)
      return o ? overlayLabel(o) : 'Image'
    }
  }
}

/**
 * The Selection view (E-06, docs/design/multi-select.md §4.9): what is selected, the actions on it,
 * the selected items (each can be left out), their timing, and one section per kind of look with
 * the properties they share; "Mixed" where they differ. Every change is one undo step.
 */
export function SelectionPanel(props: InspectorProps & { onCommand: (id: CommandId) => void }): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const G = useGroup()
  const look = useLookClipboard()
  const { project, onCommand } = props
  const keys = G.group.keys
  const stamp = G.group.stamp
  const ctx = useMemo(
    (): FieldCtx => ({ crop: cropOf(project), cursorValid: props.cursor.valid, style: zoomStyleOf(project), background: project.style.background, focusFor: props.focusFor }),
    [project, props.cursor.valid, props.focusFor]
  )
  const entries = useMemo(() => {
    const set = new Set<string>(keys)
    return projectItems(project).filter((e) => set.has(e.key))
  }, [project, keys])
  const sections = useMemo(() => fieldsFor(project, keys), [project, keys])
  const counts = kindCounts(keys)
  const span = { start: Math.min(...entries.map((e) => e.start)), end: Math.max(...entries.map((e) => e.end)) }
  const spans = entries.filter((e) => SPAN_KINDS.includes(e.kind))
  const lengths = spans.map((e) => e.end - e.start)
  const sameLength = lengths.length > 0 && lengths.every((l) => Math.abs(l - lengths[0]) <= 1e-6)

  // Leave out: focus moves to the next row's button (or the previous one, for the last row).
  const listRef = useRef<HTMLUListElement>(null)
  const [focusRow, setFocusRow] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (focusRow === null) return
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button.leave-out')
    if (buttons?.length) buttons[Math.min(focusRow, buttons.length - 1)].focus()
    setFocusRow(null)
  }, [focusRow, entries])

  /**
   * Selects `only` from this view: a group stays in it; one item is the single selection, revealed
   * as if it had been clicked (its own tab opens), with the keyboard on that tab's rail button.
   */
  const narrowTo = (only: readonly ItemKey[], anchor: ItemKey | null): void => {
    if (only.length >= 2) return G.select(only, anchor, { reveal: false })
    keepInspectorFocus()
    G.select(only, anchor)
  }

  const leaveOut = (key: ItemKey, index: number): void => {
    const r = toggleKey(keys, null, key, G.group.anchor)
    if (r.keys.length < 2) return narrowTo(r.keys, r.anchor)
    G.select(r.keys, r.anchor, { reveal: false })
    setFocusRow(index)
  }

  /** Writes a field to its targets: one update (sliders merge within their drag, colour pickers within their stream). */
  const write = (field: GroupField, targets: readonly ItemKey[], v: unknown, merge?: 'drag' | 'picker'): void => {
    let refused = 0
    const key = merge === 'drag' ? `group-field:${field.id}:${stamp}` : merge === 'picker' ? `group-color:${field.id}:${stamp}` : undefined
    store.update((p) => {
      const r = applyField(p, field, targets, v, ctx)
      refused = r.refused
      return r.project
    }, key)
    if (refused && field.id === 'freeze.sound')
      G.notice(`${countOf(refused, 'freeze')} at the end ${refused === 1 ? 'keeps' : 'keep'} pausing the sound: nothing plays after the end of the video`)
  }

  const moveTo = (t: number): void => {
    const r = setGroupStart(store.state, keys, t)
    if (r.project !== store.state) store.update(() => r.project)
    const text = movedNotice(r.moved, r.stopped)
    if (text) G.notice(text)
  }

  const setLength = (length: number): void => {
    const r = setGroupLength(store.state, keys, length)
    if (r.project !== store.state) store.update(() => r.project)
    if (r.clamped) G.notice(`${r.clamped === 1 ? '1 item is' : `${r.clamped} items are`} shorter: ${r.clamped === 1 ? 'it stops' : 'they stop'} at the next zoom, the end of the recording or the shortest length`)
  }

  const pasteLookWhy =
    !look ? copyLookFirst(commandKeys(keymap, 'copyLook').map(shortcutLabel)[0] ?? null) : keys.some((k) => lookClassOf(project, k) === look.cls) ? null : `The copied look is for ${LOOK_CLASS_WORDS[look.cls][1]}`
  const autoZooms = keys.filter((k) => k.startsWith('zoom:') && project.zooms.find((z) => `zoom:${z.id}` === k)?.auto).length

  return (
    <div className="selection-panel" data-testid="selection-panel">
      <div role="status" aria-live="polite">
        <Section title={`${keys.length} items selected`}>
          <p className="hint selection-summary">
            {groupLabel(keys)} · {formatTime(span.start)} – {formatTime(span.end)}
          </p>
          {Object.keys(counts).length > 1 && (
            <div className="selection-narrow">
              {GROUP_KINDS.filter((k) => counts[k]).map((kind) => (
                <button
                  key={kind}
                  className="btn ghost"
                  title={`Select only the ${KIND_WORDS[kind][1]}`}
                  onClick={() => {
                    const only = keys.filter((k) => k.startsWith(`${kind}:`))
                    narrowTo(only, only.includes(G.group.anchor as ItemKey) ? G.group.anchor : only[0])
                  }}
                >
                  Only {KIND_WORDS[kind][1].replace(/ items$/, '')} ({counts[kind]})
                </button>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section title="Actions">
        <div className="selection-actions">
          <button className="btn" onClick={() => onCommand('duplicateItems')} title={withShortcut('Duplicate the selected items right after themselves', commandKeys(keymap, 'duplicateItems'))}>
            <ShapeIcon name="duplicate" size={15} /> Duplicate
          </button>
          <button className="btn" onClick={() => onCommand('copyItems')} title={withShortcut('Copy the selected items', commandKeys(keymap, 'copyItems'))}>
            Copy
          </button>
          <button
            className="btn"
            disabled={!!pasteLookWhy}
            onClick={() => onCommand('pasteLook')}
            title={pasteLookWhy ?? withShortcut('Paste the copied look onto the selected items', commandKeys(keymap, 'pasteLook'))}
          >
            Paste look
          </button>
          <button
            className="btn ghost danger"
            onClick={() => onCommand('deleteSelection')}
            title={withShortcut('Delete the selected items', keymap.deleteSelection)}
          >
            <Icon name="trash" size={15} /> Delete
          </button>
        </div>
      </Section>

      <Section title="Selected items">
        <details open={keys.length <= 12}>
          <summary>Selected items ({keys.length})</summary>
          <ul className="selection-items" ref={listRef}>
            {entries.slice(0, 200).map((e, i) => {
              const name = itemName(project, e)
              const at = formatTime(e.start)
              return (
                <li key={e.key} data-group-item={e.key}>
                  <KindIcon kind={e.kind} project={project} id={e.id} />
                  <span className="item-name" title={name}>
                    {name}
                  </span>
                  <span className="muted small">{at}</span>
                  <button className="btn ghost leave-out" aria-label={`Leave out ${name} at ${at}`} title="Leave this item out of the selection" onClick={() => leaveOut(e.key, i)}>
                    Leave out
                  </button>
                </li>
              )
            })}
          </ul>
        </details>
      </Section>

      <Section title="Timing">
        <div className="group-time">
          <span className="field-label">Starts at</span>
          <GroupTimeField label="Starts at" testId="group-start" value={span.start} min={0} max={project.duration} onCommit={moveTo} />
          <button
            className="btn ghost shape-time-now"
            onClick={() => moveTo(displayTime(project.clips, player.time))}
            title="Starts at: set to the playhead"
            aria-label="Starts at: set to the playhead"
          >
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v18M7 3h10l-5 5z" />
            </svg>
          </button>
        </div>
        <div className="group-move" role="group" aria-label="Move the selection">
          <span className="field-label">Move</span>
          <button className="btn" onClick={() => moveTo(span.start - 1)} aria-label="Move the selection 1 second earlier">
            −1 s
          </button>
          <button className="btn" onClick={() => moveTo(span.start + 1)} aria-label="Move the selection 1 second later">
            +1 s
          </button>
        </div>
        {spans.length > 0 && (
          <div className="group-time group-length">
            <span className="field-label">Length</span>
            <GroupTimeField label="Length" testId="group-length" value={lengths[0]} mixed={!sameLength} min={0.3} max={project.duration} onCommit={setLength} />
            <span className="muted small">s</span>
          </div>
        )}
        <p className="hint">Moves as one block: it stops at the recording's ends, at zooms in the way, and a freeze frame stays in its clip.</p>
        {counts.chapter ? <p className="hint">Chapters move with the selection; rename them one at a time.</p> : null}
      </Section>

      {sections.map((s) => (
        <Section
          key={s.cls}
          title={`${CLASS_TITLE[s.cls]} (${s.keys.length})`}
          aside={s.cls === 'zoom' ? <span className="muted small">{`${autoZooms} automatic · ${s.keys.length - autoZooms} edited`}</span> : undefined}
        >
          {s.cls === 'zoom' && autoZooms > 0 && <p className="hint">Changing or moving the automatic ones makes them yours: auto zoom then keeps them.</p>}
          {s.fields.map(({ field, targets }) => (
            <FieldRow key={field.id} project={project} field={field} targets={targets} of={s.keys.length} ctx={ctx} onWrite={write} />
          ))}
        </Section>
      ))}
      <p className="hint">
        Text, titles and chapter names are edited one at a time. {keymap.copyLook[0] ? `${shortcutLabel(keymap.copyLook[0])} copies one item's look; ` : ''}
        {keymap.pasteLook[0] ? `${shortcutLabel(keymap.pasteLook[0])} pastes it onto the selection.` : ''}
      </p>
    </div>
  )
}

/** One property of a section, for the items it applies to ("Filled · applies to 1 of 3"). */
function FieldRow({
  project,
  field,
  targets,
  of,
  ctx,
  onWrite
}: {
  project: Project
  field: GroupField
  targets: ItemKey[]
  of: number
  ctx: FieldCtx
  onWrite: (field: GroupField, targets: readonly ItemKey[], v: unknown, merge?: 'drag' | 'picker') => void
}): JSX.Element | null {
  const shared = fieldValue(project, field, targets, ctx)
  const label = targets.length < of && field.control.type !== 'action' ? `${field.label} · applies to ${targets.length} of ${of}` : field.label
  const c = field.control
  if (c.type === 'action') {
    return (
      <p className="hint">
        <button className="link" onClick={() => onWrite(field, targets, null)} title="Use the project's zoom style for these zooms">
          {c.label}
        </button>{' '}
        ({targets.length} with {targets.length === 1 ? 'its' : 'their'} own motion)
      </p>
    )
  }
  if (!shared) return null
  if (c.type === 'slider') {
    const slider = (
      <MixedSlider
        label={label}
        value={shared.value as number}
        mixed={shared.mixed}
        min={c.min}
        max={c.max}
        step={c.step}
        format={c.format}
        onChange={(v) => onWrite(field, targets, v, 'drag')}
      />
    )
    if (field.id !== 'zoom.level') return slider
    // The level presets, as in the Zoom panel (one click: one undo step).
    const preset = shared.mixed ? null : (ZOOM_LEVEL_PRESETS.find((p) => Math.abs(p.value - (shared.value as number)) < 1e-3)?.value ?? null)
    return (
      <>
        <div className="zoom-chips-fill">
          <MixedChips label="Zoom level presets" value={preset} mixed={shared.mixed} options={ZOOM_LEVEL_PRESETS.map((p) => ({ value: p.value, label: p.label, title: p.title }))} onChange={(v) => onWrite(field, targets, v)} />
        </div>
        {slider}
      </>
    )
  }
  if (c.type === 'chips') {
    const options = c.options.map((o) => (field.id === 'zoom.focus' && o.value === 'cursor' && !ctx.cursorValid ? { ...o, disabled: true, title: 'No cursor data in this recording' } : o))
    // A focus mode not offered here (a region) reads as Mixed with the others.
    const offered = options.some((o) => o.value === shared.value)
    return <MixedChips label={label} value={offered ? (shared.value as string | number) : null} mixed={shared.mixed || !offered} options={options} onChange={(v) => onWrite(field, targets, v)} />
  }
  if (c.type === 'toggle') return <MixedToggle label={label} checked={!!shared.value} mixed={shared.mixed} onChange={(v) => onWrite(field, targets, v)} />
  const presets = field.presets ? field.presets(fieldItems(project, targets) as Shape[]) : c.presets
  return <MixedColorDots label={label} value={String(shared.value)} mixed={shared.mixed} presets={presets} onChange={(color, picker) => onWrite(field, targets, color, picker ? 'picker' : undefined)} />
}
