/**
 * A number field that reads the digits the UI shows (docs/design/output-and-languages.md §11.1). In
 * English it renders exactly today's `<input type="number">`, same attributes. Part P6 writes the
 * other languages' text field; the stub is the English input.
 */
import type { InputHTMLAttributes } from 'react'

export function NumberField(props: InputHTMLAttributes<HTMLInputElement> & { value: number; onValue: (n: number) => void }): JSX.Element {
  const { value, onValue, ...rest } = props
  return <input {...rest} type="number" value={value} onChange={(e) => onValue(e.currentTarget.valueAsNumber)} />
}
