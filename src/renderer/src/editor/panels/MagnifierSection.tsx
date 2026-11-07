/**
 * Shapes tab: Add magnifier (and on the cursor), and a selected magnifier's panel
 * (docs/design/editing-polish.md §2.2, §12): Zoom with its value text, Shape, Follows and
 * Darkness, the softness note, its times, copy look, duplicate and delete. Each change is one
 * update (a slider's drag merges through its key).
 */
import type { KeyboardEvent } from 'react'
import { duplicateItem, itemVisibleAt } from '../../../../shared/editor/shapes'
import { magnifierLooksSoft, magnifyStep, MAGNIFIER_DARKNESS, withMagnifier } from '../../../../shared/editor/magnifierEdit'
import { itemKey } from '../../../../shared/editor/multiSelect'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { cropOf, cropView, geometryFromCrop, rectToCrop } from '../../../../shared/engine/crop'
import { clamp } from '../../../../shared/engine/math'
import { formatTime } from '../../../../shared/engine/project'
import { isMagnifier, MAGNIFIER, timesText } from '../../../../shared/render/magnifier'
import type { CursorTrack, Project, Spotlight } from '../../../../shared/types'
import { holdGesture, useEditor } from '../context'
import { Section } from '../controls'
import { useGroup } from '../groupContext'
import { useKeymap } from '../keymapContext'
import { LookButtons } from '../LookButtons'
import { cursorPosFor } from '../playheadItems'
import type { Selection } from '../selection'
import { ShapeIcon } from '../shapeIcons'
import { ItemActions, OnPreview, TimeFields } from './ShapesPanel'
import { RadioChips } from './RadioChips'
import './magnifier.css'

export const MAGNIFIER_HINT = "Shows a detail larger, from the recording's own pixels, while the rest of the screen stays in view. Blurred and pixelated areas stay hidden inside it."
export const SOFT_NOTE = "Shown larger than the recording's pixels: it may look soft."
const NO_CURSOR = 'No cursor data in this recording'

/** "20 percent": the Darkness slider's value text. */
const percentText = (v: number): string => `${Math.round(v * 100)} percent`

export function MagnifierSection(props: { project: Project; selection: Selection; cursor?: CursorTrack }): JSX.Element {
  const { project, selection } = props
  const group = useGroup()
  const keymap = useKeymap()
  const cursorValid = props.cursor ? props.cursor.valid : true
  const spot = selection?.kind === 'spotlight' ? ((project.spotlights ?? []).find((s) => s.id === selection.id) ?? null) : null
  return (
    <>
      {spot && isMagnifier(spot) && <SelectedMagnifier project={project} spot={spot} cursor={props.cursor ?? null} />}
      <Section title="Magnifier">
        <div className="shape-tools two" role="group" aria-label="Add a magnifier">
          <button
            type="button"
            className="shape-tool spotlight"
            data-testid="magnifier-add"
            title={withShortcut('Show a detail larger where the preview shows it, without zooming', keymap.addMagnifier)}
            onClick={() => group.command('addMagnifier')}
          >
            <ShapeIcon name="magnifier" size={20} />
            <span>Add magnifier</span>
          </button>
          <button
            type="button"
            className="shape-tool spotlight"
            data-testid="magnifier-add-cursor"
            disabled={!cursorValid}
            title={cursorValid ? withShortcut('A magnifier that follows the cursor', keymap.addMagnifierCursor) : NO_CURSOR}
            onClick={() => group.command('addMagnifierCursor')}
          >
            <ShapeIcon name="spotlight-cursor" size={20} />
            <span>Add magnifier on the cursor</span>
          </button>
        </div>
      </Section>
    </>
  )
}

function SelectedMagnifier({ project, spot, cursor }: { project: Project; spot: Spotlight; cursor: CursorTrack | null }): JSX.Element {
  const { store, player } = useEditor()
  const group = useGroup()
  const id = spot.id
  const zoom = clamp(spot.magnify ?? MAGNIFIER.min, MAGNIFIER.min, MAGNIFIER.max)
  const set = (patch: Partial<Omit<Spotlight, 'id'>>, key?: string): void => store.update((p) => withMagnifier(p, id, patch), key)
  const cursorValid = cursor ? cursor.valid : true
  const soft = magnifierLooksSoft(project, spot, cursor)

  const setZoom = (z: number): void => set({ magnify: magnifyStep(z) }, `mag-zoom:${id}`)
  const zoomKeys = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Page Up and Page Down move a whole step of 1 (the arrows 0.25, Home and End the ends: the input's own).
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return
    e.preventDefault()
    setZoom(zoom + (e.key === 'PageUp' ? 1 : -1))
  }

  const setFollows = (mode: Spotlight['mode']): void => {
    if (mode === spot.mode) return
    if (mode === 'region' && cursor) {
      // Stays where the cursor is now instead of jumping to its old box (placed in the crop's view).
      const crop = cropOf(project)
      const view = cropView(project, cursor)
      const size = rectToCrop(crop, spot)
      const at = cursorPosFor(view.project, view.cursor, itemVisibleAt(spot, player.time) ? player.time : spot.start)
      set(at ? { mode, ...geometryFromCrop(crop, { x: at.x - size.w / 2, y: at.y - size.h / 2 }) } : { mode })
    } else {
      set({ mode })
    }
  }

  return (
    <Section title="Selected magnifier" aside={<span className="muted small">{formatTime(spot.start)} – {formatTime(spot.end)}</span>}>
      <div data-testid="magnifier-section" className="magnifier-section">
        <OnPreview item={spot} kind="spotlight" clips={project.clips} />
        <label className="slider">
          <span className="slider-head">
            <span>Zoom</span>
            <span className="muted">{`${Number(zoom.toFixed(2))}×`}</span>
          </span>
          <input
            type="range"
            data-testid="magnifier-zoom"
            aria-label="Zoom"
            aria-valuetext={timesText(zoom)}
            min={MAGNIFIER.min}
            max={MAGNIFIER.max}
            step={MAGNIFIER.step}
            value={zoom}
            onPointerDown={() => holdGesture(store)}
            onKeyDown={zoomKeys}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        <p className="hint magnifier-soft" aria-live="polite">
          {soft && <span data-testid="magnifier-soft">{SOFT_NOTE}</span>}
        </p>
        <RadioChips<Spotlight['shape']>
          id="magnifier-shape"
          label="Shape"
          value={spot.shape}
          onChange={(shape) => set({ shape })}
          options={[
            { value: 'ellipse', label: 'Round' },
            { value: 'rect', label: 'Rounded rectangle' }
          ]}
        />
        <RadioChips<Spotlight['mode']>
          id="magnifier-follows"
          label="Follows"
          value={spot.mode}
          onChange={setFollows}
          options={[
            { value: 'region', label: 'A place on the screen', title: 'The lens stays on the content you place it on' },
            { value: 'cursor', label: 'The cursor', disabled: !cursorValid, title: cursorValid ? 'The lens follows the cursor' : NO_CURSOR }
          ]}
        />
        <label className="slider">
          <span className="slider-head">
            <span>Darkness</span>
            <span className="muted">{`${Math.round(spot.dim * 100)}%`}</span>
          </span>
          <input
            type="range"
            data-testid="magnifier-darkness"
            aria-label="Darkness"
            aria-valuetext={percentText(spot.dim)}
            min={MAGNIFIER_DARKNESS.min}
            max={MAGNIFIER_DARKNESS.max}
            step={MAGNIFIER_DARKNESS.step}
            value={clamp(spot.dim, MAGNIFIER_DARKNESS.min, MAGNIFIER_DARKNESS.max)}
            onPointerDown={() => holdGesture(store)}
            onChange={(e) => set({ dim: clamp(Number(e.target.value), MAGNIFIER_DARKNESS.min, MAGNIFIER_DARKNESS.max) }, `mag-dim:${id}`)}
          />
        </label>
        <p className="hint">{MAGNIFIER_HINT}</p>
        <TimeFields project={project} item={spot} onChange={(times) => set(times, `mag-time:${id}`)} />
        <LookButtons itemKey={itemKey('spotlight', id)} />
        <ItemActions
          onDuplicate={() => {
            const copy = duplicateItem(spot)
            store.update((p) => ({ ...p, spotlights: [...(p.spotlights ?? []), copy] }))
            group.select([itemKey('spotlight', copy.id)], null)
          }}
          onDelete={() => {
            store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).filter((s) => s.id !== id) }))
            group.select([], null)
          }}
          what="magnifier"
        />
      </div>
    </Section>
  )
}
