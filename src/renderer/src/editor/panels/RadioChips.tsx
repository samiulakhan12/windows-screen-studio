/**
 * A labelled radio group of chips (docs/design/editing-polish.md §12): role="radiogroup" with one
 * role="radio" per choice, a visible label, and the keys of the ARIA radio pattern (one tab stop;
 * the arrows, Home and End move the choice and the focus together).
 */
import { useRef, type KeyboardEvent } from 'react'

export interface RadioChoice<T extends string> {
  value: T
  label: string
  title?: string
  disabled?: boolean
}

export function RadioChips<T extends string>(props: { id: string; label: string; value: T; options: readonly RadioChoice<T>[]; onChange: (v: T) => void; disabled?: boolean }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const enabled = props.options.filter((o) => !o.disabled && !props.disabled)
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!enabled.length) return
    const at = Math.max(0, enabled.findIndex((o) => o.value === props.value))
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % enabled.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    const v = enabled[next].value
    if (v !== props.value) props.onChange(v)
    box.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(v)}"]`)?.focus()
  }
  const labelId = `${props.id}-label`
  return (
    <div className="field">
      <span className="field-label" id={labelId}>
        {props.label}
      </span>
      <div className="chips" role="radiogroup" aria-labelledby={labelId} data-testid={props.id} ref={box} onKeyDown={onKey}>
        {props.options.map((o) => {
          const on = o.value === props.value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              data-value={o.value}
              tabIndex={on ? 0 : -1}
              className={`chip ${on ? 'active' : ''}`}
              title={o.title}
              disabled={props.disabled || o.disabled}
              onClick={() => {
                if (!on) props.onChange(o.value)
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A labelled switch (role="switch"), one tab stop, Space toggles it. */
export function Switch(props: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void; hint?: string; disabled?: boolean }): JSX.Element {
  const hintId = props.hint ? `${props.id}-hint` : undefined
  return (
    <div className="field">
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
