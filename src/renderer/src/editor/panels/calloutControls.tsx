/**
 * The controls of the callout sections (docs/design/editing-polish.md §12): a labelled select, a
 * radio group of chips (the ARIA radio pattern: one tab stop, arrows, Home and End), a switch and
 * colour swatches named for screen readers. Every change calls `onChange` once (one update).
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface Choice<T extends string> {
  value: T
  label: string
  /** Shown instead of the label (a sample in its own script); the label stays the accessible name. */
  content?: ReactNode
  title?: string
  disabled?: boolean
}

/** A labelled native select. */
export function SelectRow<T extends string>(props: { id: string; label: string; value: T; options: readonly Choice<T>[]; onChange: (v: T) => void; describedBy?: string }): JSX.Element {
  const id = `${props.id}-select`
  return (
    <label className="field callout-field" htmlFor={id}>
      <span>{props.label}</span>
      <select id={id} data-testid={props.id} value={props.value} aria-describedby={props.describedBy} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** A radio group of chips with a visible label. */
export function RadioRow<T extends string>(props: { id: string; label: string; value: T | null; options: readonly Choice<T>[]; onChange: (v: T) => void; disabled?: boolean }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const enabled = props.options.filter((o) => !o.disabled && !props.disabled)
  const current = Math.max(0, enabled.findIndex((o) => o.value === props.value))
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!enabled.length) return
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (current + 1) % enabled.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (current - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    const v = enabled[next].value
    if (v !== props.value) props.onChange(v)
    box.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[props.options.indexOf(enabled[next])]?.focus()
  }
  const labelId = `${props.id}-label`
  return (
    <div className="field callout-field">
      <span className="field-label" id={labelId}>
        {props.label}
      </span>
      <div className="chips" role="radiogroup" aria-labelledby={labelId} data-testid={props.id} ref={box} onKeyDown={onKey}>
        {props.options.map((o) => {
          const on = o.value === props.value
          const focusable = on || (props.value === null && enabled[0] === o)
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={o.content ? o.label : undefined}
              data-value={o.value}
              tabIndex={focusable ? 0 : -1}
              className={`chip ${on ? 'active' : ''}`}
              title={o.title}
              disabled={props.disabled || o.disabled}
              onClick={() => {
                if (!on) props.onChange(o.value)
              }}
            >
              {o.content ?? o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A labelled switch (role="switch"); Space toggles it. */
export function SwitchRow(props: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void; hint?: string; disabled?: boolean }): JSX.Element {
  const hintId = props.hint ? `${props.id}-hint` : undefined
  return (
    <div className="field callout-field">
      <label className={`toggle ${props.disabled ? 'disabled' : ''}`}>
        <span>{props.label}</span>
        <input
          type="checkbox"
          role="switch"
          data-testid={props.id}
          aria-checked={props.checked}
          aria-describedby={hintId}
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      </label>
      {props.hint && (
        <p className="hint" id={hintId}>
          {props.hint}
        </p>
      )}
    </div>
  )
}

/** Colour swatches as a radio group, each named ("White", "Brand colour 1, #e4572e"). */
export function SwatchRow(props: { id: string; label: string; value: string; swatches: readonly { color: string; name: string }[]; onChange: (color: string) => void }): JSX.Element {
  const value = props.value.toLowerCase()
  return (
    <RadioRow
      id={props.id}
      label={props.label}
      value={props.swatches.some((s) => s.color.toLowerCase() === value) ? value : null}
      options={props.swatches.map((s) => ({ value: s.color.toLowerCase(), label: s.name, title: s.name, content: <span className="callout-swatch" style={{ background: s.color }} aria-hidden="true" /> }))}
      onChange={props.onChange}
    />
  )
}
