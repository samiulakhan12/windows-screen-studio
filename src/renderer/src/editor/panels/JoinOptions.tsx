/**
 * A cut style's options (docs/design/editing-polish.md §2.1, §12): the lengths and the punch-in's
 * size as sliders with their value text ("0.15 seconds", "110 percent"; arrows by 0.01 s or 1 %,
 * Page Up and Down by 0.1 s or 5 %, Home and End), the dip's colour swatches and the slide's side,
 * then the style's hint. A drag is one undo step (the gesture's merge key).
 */
import type { KeyboardEvent } from 'react'
import { CUT_HINTS, percentText, secondsText, SLIDE_NAMES } from '../../../../shared/editor/cutsCopy'
import { JOIN_DEFAULTS, PUNCH_SCALE } from '../../../../shared/render/joins'
import type { CutJoin, SlideFrom } from '../../../../shared/types'
import { holdGesture, useEditor } from '../context'

/** A slider with its value text, and Page Up / Page Down steps of its own. */
function JoinSlider(props: {
  label: string
  testId: string
  value: number
  min: number
  max: number
  step: number
  page: number
  text: (v: number) => string
  onChange: (v: number) => void
}): JSX.Element {
  const { store } = useEditor()
  const set = (v: number): void => props.onChange(Number(Math.min(props.max, Math.max(props.min, Math.round(v / props.step) * props.step)).toFixed(4)))
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return
    e.preventDefault()
    set(props.value + (e.key === 'PageUp' ? props.page : -props.page))
  }
  return (
    <label className="slider cut-slider">
      <span className="slider-head">
        <span>{props.label}</span>
        <span className="muted">{props.text(props.value)}</span>
      </span>
      <input
        type="range"
        data-testid={props.testId}
        aria-label={props.label}
        aria-valuetext={props.text(props.value)}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onPointerDown={() => holdGesture(store)}
        onKeyDown={onKeyDown}
        onChange={(e) => set(Number(e.target.value))}
      />
    </label>
  )
}

const SLIDES: readonly SlideFrom[] = ['right', 'left', 'top', 'bottom']

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/**
 * A radio group keeps its arrow keys (they move the choice, §12): the editor's step keys, which
 * listen on the window, never see them.
 */
export function keepArrows(e: KeyboardEvent<HTMLElement>): void {
  if (ARROWS.has(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) e.stopPropagation()
}

/**
 * The options of `join` (none for a hard cut), and its hint. `onChange(next, key)`: the new join,
 * with the merge key of a slider's gesture (absent: one step of its own).
 */
export function JoinOptions(props: { join: CutJoin; brand: readonly string[]; name: string; onChange: (next: CutJoin, key?: string) => void }): JSX.Element {
  const { join, onChange, name } = props
  const length = (kind: 'crossfade' | 'dip' | 'slide', label: string): JSX.Element => (
    <JoinSlider
      label={label}
      testId="cut-length"
      value={join.duration ?? JOIN_DEFAULTS[kind].duration}
      min={JOIN_DEFAULTS[kind].min}
      max={JOIN_DEFAULTS[kind].max}
      step={0.01}
      page={0.1}
      text={secondsText}
      onChange={(duration) => onChange({ ...join, duration }, `${name}-length`)}
    />
  )
  const size = (label: string): JSX.Element => (
    <JoinSlider
      label={label}
      testId="cut-punch-size"
      value={join.scale ?? PUNCH_SCALE.default}
      min={PUNCH_SCALE.min}
      max={PUNCH_SCALE.max}
      step={0.01}
      page={0.05}
      text={percentText}
      onChange={(scale) => onChange({ ...join, scale }, `${name}-size`)}
    />
  )
  const colour = join.color ?? '#000000'
  const swatches = [
    { color: '#000000', label: 'Black' },
    { color: '#ffffff', label: 'White' },
    ...props.brand.map((c, i) => ({ color: c.toLowerCase(), label: `Brand colour ${i + 1}, ${c.toLowerCase()}` }))
  ].filter((s, i, all) => all.findIndex((x) => x.color === s.color) === i)
  const other = !swatches.some((s) => s.color === colour)
  return (
    <div className="cut-options">
      {join.kind === 'smooth' && (
        <>
          {length('crossfade', 'Crossfade length')}
          {size('Punch-in size')}
        </>
      )}
      {join.kind === 'crossfade' && length('crossfade', 'Length')}
      {join.kind === 'punch' && size('Size')}
      {join.kind === 'dip' && (
        <>
          {length('dip', 'Length')}
          <span className="field-label" id={`${name}-dip-label`}>
            Colour
          </span>
          <div className="cut-swatches" role="radiogroup" aria-labelledby={`${name}-dip-label`} data-testid="cut-dip-colour" onKeyDown={keepArrows}>
            {swatches.map((s) => (
              <label key={s.color} className={`cut-swatch ${s.color === colour ? 'active' : ''}`} title={s.label}>
                <input type="radio" name={`${name}-dip`} aria-label={s.label} checked={s.color === colour} onChange={() => onChange({ ...join, color: s.color })} />
                <span className="cut-swatch-dot" style={{ background: s.color }} aria-hidden="true" />
              </label>
            ))}
            <label className={`cut-swatch other ${other ? 'active' : ''}`} title="Other colour">
              <span className="cut-swatch-other">Other…</span>
              <input type="color" aria-label="Other colour" value={colour} onChange={(e) => onChange({ ...join, color: e.target.value.toLowerCase() }, `${name}-colour`)} />
            </label>
          </div>
        </>
      )}
      {join.kind === 'slide' && (
        <>
          {length('slide', 'Length')}
          <span className="field-label" id={`${name}-from-label`}>
            Comes in from
          </span>
          <div className="cut-radios" role="radiogroup" aria-labelledby={`${name}-from-label`} data-testid="cut-slide-from" onKeyDown={keepArrows}>
            {SLIDES.map((side) => (
              <label key={side} className={`chip ${(join.from ?? 'right') === side ? 'active' : ''}`}>
                <input type="radio" name={`${name}-from`} checked={(join.from ?? 'right') === side} onChange={() => onChange({ ...join, from: side })} />
                {SLIDE_NAMES[side]}
              </label>
            ))}
          </div>
        </>
      )}
      <p className="hint">{CUT_HINTS[join.kind]}</p>
    </div>
  )
}
