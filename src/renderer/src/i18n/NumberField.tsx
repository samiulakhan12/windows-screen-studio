/**
 * A number field that reads the digits the UI shows (docs/design/output-and-languages.md §11.1). In
 * English it renders exactly today's `<input type="number">`, same attributes, so nothing changes.
 * In another language Chromium would format a number input with its en-US locale and refuse ২৫
 * typed through Avro or Bijoy, so it renders a text field with `inputmode="decimal"` that shows the
 * UI's digits, reads typed and pasted digits of any script (fmt.parseNumber), keeps `min`, `max` and
 * `step`, steps with ArrowUp and ArrowDown, and says it is a spin button to screen readers.
 */
import { useState, type InputHTMLAttributes } from 'react'
import { fmt } from '../../../shared/i18n/fmt'
import { uiLanguage } from '../../../shared/i18n/t'

type Props = InputHTMLAttributes<HTMLInputElement> & { value: number; onValue: (n: number) => void }

/** An attribute's number (min="0", step={0.5}), or undefined when it is none ('any', absent). */
const numberOf = (v: string | number | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Decimal places of a step (0.25 → 2), so stepping never shows 0.30000000000000004. */
const placesOf = (step: number): number => {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

/**
 * The value one step up (1) or down (-1) from `from`, as a number input steps: to the next multiple
 * of `step` counted from `min` (or 0), within `min` and `max`. An empty field starts from `min` or 0.
 */
export function stepValue(from: number, dir: 1 | -1, bounds: { min?: number; max?: number; step?: number }): number {
  const step = bounds.step !== undefined && bounds.step > 0 ? bounds.step : 1
  const origin = bounds.min ?? 0
  const base = Number.isFinite(from) ? from : origin
  const k = (base - origin) / step
  const nextK = dir > 0 ? Math.floor(k + 1e-9) + 1 : Math.ceil(k - 1e-9) - 1
  let next = Number((origin + nextK * step).toFixed(Math.min(20, Math.max(placesOf(step), placesOf(origin)))))
  if (bounds.max !== undefined && next > bounds.max) next = bounds.max
  if (bounds.min !== undefined && next < bounds.min) next = bounds.min
  return next
}

/** The value as the field shows it: the UI's digits, no grouping; empty for no number. */
const shownText = (value: number): string => (Number.isFinite(value) ? fmt.count(value) : '')

export function NumberField(props: Props): JSX.Element {
  if (uiLanguage() !== 'en') return <LocalNumberField {...props} />
  const { value, onValue, ...rest } = props
  return <input type="number" {...rest} value={value} onChange={(e) => onValue(e.currentTarget.valueAsNumber)} />
}

/** The field outside English: what the user types stays as typed while the field has the focus. */
function LocalNumberField(props: Props): JSX.Element {
  const { value, onValue, min, max, step, onKeyDown, onBlur, type: _type, inputMode: _inputMode, ...rest } = props
  const [draft, setDraft] = useState<string | null>(null)
  const bounds = { min: numberOf(min), max: numberOf(max), step: numberOf(step) }
  const shown = draft ?? shownText(value)
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      role="spinbutton"
      aria-valuenow={Number.isFinite(value) ? value : undefined}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuetext={shown}
      value={shown}
      onChange={(e) => {
        const text = e.currentTarget.value
        setDraft(text)
        onValue(fmt.parseNumber(text))
      }}
      onBlur={(e) => {
        setDraft(null)
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        const from = draft !== null ? fmt.parseNumber(draft) : value
        setDraft(null)
        onValue(stepValue(from, e.key === 'ArrowUp' ? 1 : -1, bounds))
      }}
    />
  )
}
