import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { displayTime } from '../../../../shared/editor/clips'
import type { CommandId } from '../../../../shared/editor/commands'
import { applyField, fieldItems, fieldsFor, fieldValue, lookClassOf, type FieldCtx, type GroupField, type LookClass } from '../../../../shared/editor/groupEdit'
import { setGroupLength, setGroupStart } from '../../../../shared/editor/groupMove'
import { GROUP_KINDS, groupLabel, kindCounts, projectItems, toggleKey, type GroupKind, type ItemEntry, type ItemKey } from '../../../../shared/editor/multiSelect'
import { copyLookFirst, movedNotice } from '../../../../shared/editor/multiSelectCopy'
import { shapeName, zoomLevelPresets } from '../../../../shared/editor/itemNames'
import { commandKeys, shortcutLabel, withShortcut } from '../../../../shared/editor/shortcuts'
import { ZOOM_LEVEL_PRESETS } from '../../../../shared/editor/zoomEdit'
import { cropOf, zoomInView } from '../../../../shared/engine/crop'
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
import { fmt } from '../../../../shared/i18n/fmt'
import { graphicLabel } from './GraphicsPanel'
import { t, uiLanguage, type MessageKey } from '../../../../shared/i18n/t'

/** Section titles of the look classes, in their order (§4.9 item 5). */
const CLASS_TITLE: Readonly<Record<LookClass, MessageKey>> = {
  zoom: 'style.selectionPanel.class.zoom',
  text: 'common.label.text',
  mark: 'style.selectionPanel.class.mark',
  privacy: 'style.selectionPanel.class.privacy',
  spotlight: 'style.selectionPanel.class.spotlight',
  image: 'style.selectionPanel.class.image',
  title: 'style.selectionPanel.class.title',
  freeze: 'style.selectionPanel.class.freeze',
  graphic: 'style.selectionPanel.class.graphic',
  cover: 'privacy.track.title'
}

/** Kinds with a start and an end (Length applies to them). */
const SPAN_KINDS: readonly GroupKind[] = ['zoom', 'annotation', 'shape', 'spotlight', 'overlay', 'title', 'graphic']

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
  if (kind === 'graphic') return <EditorIcon name="burst" size={14} />
  return <EditorIcon name="text" size={14} />
}

/** What a row calls an item: its text, title or name, "Zoom 2×", a shape's kind, "Freeze frame". */
function itemName(p: Project, e: ItemEntry): string {
  switch (e.kind) {
    case 'zoom': {
      const z = p.zooms.find((x) => x.id === e.id)
      return z ? t('style.selectionPanel.zoomLevel', { level: fmt.factor(zoomTargetScale(zoomInView(cropOf(p), z))) }) : t('common.label.zoom')
    }
    case 'annotation':
      return p.annotations.find((x) => x.id === e.id)?.text.trim() || t('common.label.text')
    case 'shape': {
      const s = p.shapes?.find((x) => x.id === e.id)
      return s ? shapeName(s.kind) : t('text.shape.shape')
    }
    case 'spotlight':
      return p.spotlights?.find((x) => x.id === e.id)?.mode === 'cursor' ? t('style.selectionPanel.cursorSpotlight') : t('style.groupEdit.name.spotlight')
    case 'title': {
      const c = p.titles?.find((x) => x.id === e.id)
      return c?.title.trim() || c?.subtitle?.trim() || t('style.groupEdit.name.titleCard')
    }
    case 'chapter':
      return p.chapters?.find((x) => x.id === e.id)?.title.trim() || t('style.groupEdit.name.chapter')
    case 'freeze':
      return t('style.groupEdit.name.freeze')
    case 'overlay': {
      const o = p.overlays?.find((x) => x.id === e.id)
      return o ? overlayLabel(o) : t('style.groupEdit.name.image')
    }
    case 'graphic': {
      const g = p.graphics?.find((x) => x.id === e.id)
      return g ? graphicLabel(g) : t('style.selectionPanel.popUp')
    }
    case 'cover':
      return t('privacy.cover.title')
  }
}


/** The hint about copying looks in a language other than English: one whole sentence for the keys there are (merge group, §9.3). */
export function lookKeysHint(copy: string | undefined, paste: string | undefined): string {
  const keys = copy && paste ? 'both' : copy ? 'copy' : paste ? 'paste' : 'none'
  return t('style.selectionPanel.lookKeys.whole', { keys, copy: copy ? shortcutLabel(copy) : '', paste: paste ? shortcutLabel(paste) : '' })
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
      G.notice(t('style.selectionPanel.freezesAtEnd', { count: refused, n: fmt.count(refused) }))
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
    if (r.clamped) G.notice(t('style.selectionPanel.shorter', { count: r.clamped, n: fmt.count(r.clamped) }))
  }

  const pasteLookWhy =
    !look ? copyLookFirst(commandKeys(keymap, 'copyLook').map(shortcutLabel)[0] ?? null) : keys.some((k) => lookClassOf(project, k) === look.cls) ? null : t('style.lookButtons.copiedLookFor', { cls: look.cls })
  const autoZooms = keys.filter((k) => k.startsWith('zoom:') && project.zooms.find((z) => `zoom:${z.id}` === k)?.auto).length

  return (
    <div className="selection-panel" data-testid="selection-panel">
      <div role="status" aria-live="polite">
        <Section title={t('style.selectionPanel.itemsSelected', { n: fmt.count(keys.length) })}>
          <p className="hint selection-summary">
            {groupLabel(keys)} · {fmt.clock(span.start)} – {fmt.clock(span.end)}
          </p>
          {Object.keys(counts).length > 1 && (
            <div className="selection-narrow">
              {GROUP_KINDS.filter((k) => counts[k]).map((kind) => (
                <button
                  key={kind}
                  className="btn ghost"
                  title={t('style.selectionPanel.selectOnlyThe', { kind })}
                  onClick={() => {
                    const only = keys.filter((k) => k.startsWith(`${kind}:`))
                    narrowTo(only, only.includes(G.group.anchor as ItemKey) ? G.group.anchor : only[0])
                  }}
                >
                  {t('style.selectionPanel.onlyKind', { kind, n: fmt.count(counts[kind] ?? 0) })}
                </button>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section title={t('style.selectionPanel.actions')}>
        <div className="selection-actions">
          <button className="btn" onClick={() => onCommand('duplicateItems')} title={withShortcut(t('style.selectionPanel.duplicateTitle'), commandKeys(keymap, 'duplicateItems'))}>
            <ShapeIcon name="duplicate" size={15} /> {t('style.selectionPanel.duplicate')}
          </button>
          <button className="btn" onClick={() => onCommand('copyItems')} title={withShortcut(t('style.selectionPanel.copyTitle'), commandKeys(keymap, 'copyItems'))}>{t('common.action.copy')}</button>
          <button
            className="btn"
            disabled={!!pasteLookWhy}
            onClick={() => onCommand('pasteLook')}
            title={pasteLookWhy ?? withShortcut(t('style.selectionPanel.pasteLookTitle'), commandKeys(keymap, 'pasteLook'))}
          >{t('style.selectionPanel.pasteLook')}</button>
          <button
            className="btn ghost danger"
            onClick={() => onCommand('deleteSelection')}
            title={withShortcut(t('style.selectionPanel.deleteTitle'), keymap.deleteSelection)}
          >
            <Icon name="trash" size={15} /> {t('common.action.delete')}
          </button>
        </div>
      </Section>

      <Section title={t('style.selectionPanel.selectedItems')}>
        <details open={keys.length <= 12}>
          <summary>{t('style.selectionPanel.selectedItemsCount', { n: fmt.count(keys.length) })}</summary>
          <ul className="selection-items" ref={listRef}>
            {entries.slice(0, 200).map((e, i) => {
              const name = itemName(project, e)
              const at = fmt.clock(e.start)
              return (
                <li key={e.key} data-group-item={e.key}>
                  <KindIcon kind={e.kind} project={project} id={e.id} />
                  <span className="item-name" title={name}>
                    {name}
                  </span>
                  <span className="muted small">{at}</span>
                  <button className="btn ghost leave-out" aria-label={t('style.selectionPanel.leaveOutAt', { name, at })} title={t('style.selectionPanel.leaveThisItemOut')} onClick={() => leaveOut(e.key, i)}>{t('style.selectionPanel.leaveOut')}</button>
                </li>
              )
            })}
          </ul>
        </details>
      </Section>

      <Section title={t('style.selectionPanel.timing')}>
        <div className="group-time">
          <span className="field-label">{t('style.selectionPanel.startsAt')}</span>
          <GroupTimeField label={t('style.selectionPanel.startsAt')} testId="group-start" value={span.start} min={0} max={project.duration} onCommit={moveTo} />
          <button
            className="btn ghost shape-time-now"
            onClick={() => moveTo(displayTime(project.clips, player.time))}
            title={t('style.selectionPanel.startsAtSetTo')}
            aria-label={t('style.selectionPanel.startsAtSetTo')}
          >
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v18M7 3h10l-5 5z" />
            </svg>
          </button>
        </div>
        <div className="group-move" role="group" aria-label={t('style.selectionPanel.moveTheSelection')}>
          <span className="field-label">{t('style.selectionPanel.move')}</span>
          <button className="btn" onClick={() => moveTo(span.start - 1)} aria-label={t('style.selectionPanel.moveEarlier')}>{t('style.selectionPanel.secondsMinus', { n: fmt.count(1) })}</button>
          <button className="btn" onClick={() => moveTo(span.start + 1)} aria-label={t('style.selectionPanel.moveLater')}>{t('style.selectionPanel.secondsPlus', { n: fmt.count(1) })}</button>
        </div>
        {spans.length > 0 && (
          <div className="group-time group-length">
            <span className="field-label">{t('common.label.length')}</span>
            <GroupTimeField label={t('common.label.length')} testId="group-length" value={lengths[0]} mixed={!sameLength} min={0.3} max={project.duration} onCommit={setLength} />
            <span className="muted small">{t('style.selectionPanel.secondsUnit')}</span>
          </div>
        )}
        <p className="hint">{t('style.selectionPanel.movesAsOneBlock')}</p>
        {counts.chapter ? <p className="hint">{t('style.selectionPanel.chaptersMoveWithThe')}</p> : null}
      </Section>

      {sections.map((s) => (
        <Section
          key={s.cls}
          title={t('style.selectionPanel.classCount', { name: t(CLASS_TITLE[s.cls]), n: fmt.count(s.keys.length) })}
          aside={s.cls === 'zoom' ? <span className="muted small">{t('style.selectionPanel.automaticEdited', { auto: fmt.count(autoZooms), edited: fmt.count(s.keys.length - autoZooms) })}</span> : undefined}
        >
          {s.cls === 'zoom' && autoZooms > 0 && <p className="hint">{t('style.selectionPanel.changingOrMovingThe')}</p>}
          {s.fields.map(({ field, targets }) => (
            <FieldRow key={field.id} project={project} field={field} targets={targets} of={s.keys.length} ctx={ctx} onWrite={write} />
          ))}
        </Section>
      ))}
      {uiLanguage() === 'en' ? (
        // English keeps today's three text nodes (merge group, output-and-languages §9.3).
        <p className="hint">
          {t('style.selectionPanel.lookKeys.intro')}
          {keymap.copyLook[0] ? t('style.selectionPanel.lookKeys.copy', { keys: shortcutLabel(keymap.copyLook[0]) }) : ''}
          {keymap.pasteLook[0] ? t('style.selectionPanel.lookKeys.paste', { keys: shortcutLabel(keymap.pasteLook[0]) }) : ''}
        </p>
      ) : (
        <p className="hint">{lookKeysHint(keymap.copyLook[0], keymap.pasteLook[0])}</p>
      )}
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
  const label = targets.length < of && field.control.type !== 'action' ? t('style.selectionPanel.appliesTo', { label: field.label, n: fmt.count(targets.length), total: fmt.count(of) }) : field.label
  const c = field.control
  if (c.type === 'action') {
    return (
      <p className="hint">
        <button className="link" onClick={() => onWrite(field, targets, null)} title={t('style.selectionPanel.useTheProjectS')}>
          {c.label}
        </button>{' '}
        {t('style.selectionPanel.ownMotionCount', { count: targets.length, n: fmt.count(targets.length) })}
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
          <MixedChips label={t('style.selectionPanel.zoomLevelPresets')} value={preset} mixed={shared.mixed} options={zoomLevelPresets().map((p) => ({ value: p.value, label: p.label, title: p.title }))} onChange={(v) => onWrite(field, targets, v)} />
        </div>
        {slider}
      </>
    )
  }
  if (c.type === 'chips') {
    const options = c.options.map((o) => (field.id === 'zoom.focus' && o.value === 'cursor' && !ctx.cursorValid ? { ...o, disabled: true, title: t('style.selectionPanel.noCursor') } : o))
    // A focus mode not offered here (a region) reads as Mixed with the others.
    const offered = options.some((o) => o.value === shared.value)
    return <MixedChips label={label} value={offered ? (shared.value as string | number) : null} mixed={shared.mixed || !offered} options={options} onChange={(v) => onWrite(field, targets, v)} />
  }
  if (c.type === 'toggle') return <MixedToggle label={label} checked={!!shared.value} mixed={shared.mixed} onChange={(v) => onWrite(field, targets, v)} />
  const presets = field.presets ? field.presets(fieldItems(project, targets) as Shape[]) : c.presets
  return <MixedColorDots label={label} value={String(shared.value)} mixed={shared.mixed} presets={presets} onChange={(color, picker) => onWrite(field, targets, color, picker ? 'picker' : undefined)} />
}
