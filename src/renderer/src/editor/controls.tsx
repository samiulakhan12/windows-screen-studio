import type { ReactNode } from 'react'
import { holdGesture, useEditor } from './context'

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
}): JSX.Element {
  const { store } = useEditor()
  return (
    <label className={`slider ${props.disabled ? 'disabled' : ''}`}>
      <span className="slider-head">
        <span>{props.label}</span>
        <span className="muted">{props.format ? props.format(props.value) : props.value}</span>
      </span>
      <input
        type="range"
        aria-label={props.label}
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

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  title
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  title?: string
}): JSX.Element {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`} title={title}>
      <span>{label}</span>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }): JSX.Element {
  return (
    <section className="insp-section">
      <h3>
        <span>{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  )
}

export function Chips<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  label
}: {
  value: T | null
  options: { value: T; label: string; disabled?: boolean; title?: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  label?: string
}): JSX.Element {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={`chip ${o.value === value ? 'active' : ''}`}
          disabled={disabled || o.disabled}
          title={o.title}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export const pctFmt = (v: number): string => `${Math.round(v * 100)}%`
