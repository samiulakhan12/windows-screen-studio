/**
 * Controls of the Selection view (E-06, docs/design/multi-select.md §4.9.2): the single panels'
 * slider, chips, toggle and colour dots with a "Mixed" state for values that differ between the
 * selected items, and the group's time field. controls.tsx is left as it is.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { holdGesture, useEditor } from './context'

/** A slider whose readout says "Mixed" when the items differ; the thumb sits at the first item's value. Moving it sets every item. */
export function MixedSlider(props: {
  label: string
  value: number
  mixed: boolean
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
}): JSX.Element {
  const { store } = useEditor()
  const shown = props.mixed ? 'Mixed' : props.format ? props.format(props.value) : String(props.value)
  return (
    <label className={`slider ${props.mixed ? 'mixed' : ''} ${props.disabled ? 'disabled' : ''}`}>
      <span className="slider-head">
        <span>{props.label}</span>
        <span className="muted" data-testid="mixed-readout">
          {shown}
        </span>
      </span>
      <input
        type="range"
        aria-label={props.label}
        aria-valuetext={props.mixed ? 'Mixed' : props.format ? props.format(props.value) : undefined}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onPointerDown={() => holdGesture(store)}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

/** Chips with none pressed and a "Mixed" tag when the items differ. */
export function MixedChips<T extends string | number>({
  label,
  value,
  mixed,
  options,
  onChange,
  disabled
}: {
  label: string
  value: T | null
  mixed: boolean
  options: readonly { value: T; label: string; disabled?: boolean; title?: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div className="field">
      <span className="field-label">
        {label}
        {mixed && <span className="mixed-tag">Mixed</span>}
      </span>
      <div className="chips" role="group" aria-label={mixed ? `${label}, mixed` : label}>
        {options.map((o) => {
          const on = !mixed && o.value === value
          return (
            <button
              key={String(o.value)}
              className={`chip ${on ? 'active' : ''}`}
              disabled={disabled || o.disabled}
              title={o.title}
              aria-pressed={on}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A checkbox that shows "mixed" (indeterminate) when the items differ; a click sets every item on. */
export function MixedToggle({ label, checked, mixed, onChange, disabled }: { label: string; checked: boolean; mixed: boolean; onChange: (v: boolean) => void; disabled?: boolean }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <span>
        {label}
        {mixed && <span className="mixed-tag">Mixed</span>}
      </span>
      <input ref={ref} type="checkbox" aria-label={label} checked={mixed ? false : checked} disabled={disabled} onChange={(e) => onChange(mixed ? true : e.target.checked)} />
    </label>
  )
}

/** Preset colours and a "pick any colour" dot; none pressed and "Mixed" beside them when the items differ. */
export function MixedColorDots({
  label,
  value,
  mixed,
  presets,
  onChange
}: {
  label: string
  value: string
  mixed: boolean
  presets: readonly string[]
  /** `picker`: from the any-colour picker, whose changes come in a stream and merge into one undo step. */
  onChange: (color: string, picker: boolean) => void
}): JSX.Element {
  const v = value.toLowerCase()
  const custom = !mixed && !presets.includes(v)
  return (
    <div className="field">
      <span className="field-label">
        {label}
        {mixed && <span className="mixed-tag">Mixed</span>}
      </span>
      <div className="shape-colors" role="group" aria-label={mixed ? `${label}, mixed` : label}>
        {presets.map((c) => {
          const on = !mixed && v === c
          return (
            <button
              key={c}
              className={`shape-color ${on ? 'active' : ''}`}
              style={{ background: c }}
              title={c}
              aria-label={`${label} ${c}`}
              aria-pressed={on}
              onClick={() => onChange(c, false)}
            />
          )
        })}
        <label className={`shape-color custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
          <input type="color" aria-label={`${label} (any colour)`} value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={(e) => onChange(e.target.value.toLowerCase(), true)} />
        </label>
      </div>
    </div>
  )
}

/**
 * A time in seconds typed into a number field: committed on Enter or when leaving the field, when
 * it is a valid number (as the Shapes panel's time fields); empty with "Mixed" as placeholder when
 * the items differ.
 */
export function GroupTimeField({
  label,
  value,
  mixed,
  min,
  max,
  onCommit,
  testId
}: {
  label: string
  value: number
  mixed?: boolean
  min: number
  max: number
  onCommit: (v: number) => void
  testId?: string
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const parse = (text: string): number | null => {
    const v = Number(text)
    return text.trim() !== '' && Number.isFinite(v) ? v : null
  }
  const commit = (): void => {
    const v = draft === null ? null : parse(draft)
    setDraft(null)
    if (v !== null && (mixed || Math.abs(v - value) > 1e-6)) onCommit(v)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return
    // The editor's own Enter handling (leaving the field) comes after; commit first.
    e.preventDefault()
    e.stopPropagation()
    commit()
  }
  return (
    <input
      className="shape-time-input"
      type="number"
      aria-label={label}
      data-testid={testId}
      min={min}
      max={Math.round(max * 100) / 100}
      step={0.1}
      placeholder={mixed ? 'Mixed' : undefined}
      value={draft ?? (mixed ? '' : (Math.round(value * 10) / 10).toString())}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  )
}
