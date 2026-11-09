/**
 * A model field that is a list loaded from the provider (docs/design/smart-tools.md §2.6, §10.4): the
 * ARIA 1.2 combobox (a text field with a list). Load models asks main for the provider's models
 * (window.api.listModels: the key only is sent, never project text) and says how many came; typing
 * filters the list; Down opens it and moves through it, Up moves back, Enter picks, Esc closes; any
 * text is still allowed. OpenRouter's entries show their price, or "price varies" for its router
 * models. The list lives for the session (in useCost, where OpenRouter's prices then price the cost
 * line); nothing is stored.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AI_LIMITS, type ListedModel, type ModelListTarget } from '../../../shared/api/ai'
import { filterModels } from '../../../shared/ai/modelFilter'
import { usd } from '../../../shared/ai/cost'
import type { AiProviderKind } from '../../../shared/types'
import { ipcMessage } from '../settings/providerText'
import { rememberListedModels } from './useCost'
import './cost.css'

/** Most options shown at once (the rest are reached by typing). */
const SHOWN = 200

/** "US$2.00 / US$10.00 per million tokens", or "price varies". */
export function priceLabel(m: ListedModel): string | null {
  if (!m.prices) return null
  if (m.prices === 'varies') return 'price varies'
  if (m.prices.input === 0 && m.prices.output === 0) return 'free'
  return `${usd(m.prices.input)} / ${usd(m.prices.output)} per million tokens`
}

/** The kind of provider a target's models belong to (what filters the list for a field). */
const kindOf = (target: ModelListTarget | null): AiProviderKind => (target && 'draft' in target ? target.draft.kind : 'openai')

export function ModelCombobox(props: { id: string; label: string; value: string; onChange(v: string): void; target: ModelListTarget | null; field: 'text' | 'transcription' }): JSX.Element {
  const { id, label, value, onChange, target, field } = props
  const uid = useId()
  const listId = `${id}-list`
  const [models, setModels] = useState<ListedModel[] | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const typed = useRef(false)

  const ofField = useMemo(() => {
    if (!models) return []
    const keep = new Set(filterModels(kindOf(target), models.map((m) => m.id), field))
    return models.filter((m) => keep.has(m.id))
  }, [models, target, field])
  // Typing filters; a value picked from the list shows the whole list again.
  const shown = useMemo(() => {
    const q = typed.current ? value.trim().toLowerCase() : ''
    return (q ? ofField.filter((m) => m.id.toLowerCase().includes(q)) : ofField).slice(0, SHOWN)
  }, [ofField, value])

  const load = async (): Promise<void> => {
    if (!target || loading) return
    setLoading(true)
    setStatus(null)
    try {
      const list = await window.api.listModels(target)
      setModels(list)
      const n = filterModels(kindOf(target), list.map((m) => m.id), field).length
      setStatus({ text: n === 1 ? 'Loaded 1 model' : `Loaded ${n} models`, error: false })
      const pid = 'providerId' in target ? target.providerId : target.draft.id
      if (pid) rememberListedModels(pid, list)
      typed.current = false
      setOpen(n > 0)
      setActive(-1)
    } catch (err) {
      setStatus({ text: ipcMessage(err), error: true })
    } finally {
      setLoading(false)
    }
  }

  const pick = (m: ListedModel): void => {
    typed.current = false
    onChange(m.id)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      if (!shown.length) return
      e.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(Math.max(0, shown.findIndex((m) => m.id === value)))
      } else setActive((i) => Math.min(shown.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      if (!open || !shown.length) return
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      // Enter picks the highlighted option; otherwise the form goes on as usual.
      if (open && active >= 0 && shown[active]) {
        e.preventDefault()
        pick(shown[active])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        // Closes the list only, not the form around it.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        setActive(-1)
      }
    }
  }

  const expanded = open && shown.length > 0
  const activeId = expanded && active >= 0 ? `${uid}-opt-${active}` : undefined
  return (
    <div className="field model-combobox">
      <label htmlFor={id}>
        <span className="settings-label">{label}</span>
      </label>
      <div className="ai-key-row">
        <input
          id={id}
          className="settings-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-describedby={`${id}-status`}
          value={value}
          maxLength={AI_LIMITS.modelLength}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            typed.current = true
            onChange(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        <button type="button" className="btn ghost settings-small" disabled={!target || loading} onClick={() => void load()}>
          {loading ? 'Loading…' : 'Load models'}
        </button>
      </div>
      <ul id={listId} role="listbox" aria-label={`${label}: models`} className="model-list" hidden={!expanded}>
        {expanded &&
          shown.map((m, i) => {
            const price = priceLabel(m)
            return (
              <li
                key={m.id}
                id={`${uid}-opt-${i}`}
                role="option"
                aria-selected={m.id === value}
                className={i === active ? 'model-option active' : 'model-option'}
                // Before the field's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(m)
                }}
              >
                <span>{m.id}</span>
                {price && <span className="model-price">{price}</span>}
              </li>
            )
          })}
      </ul>
      <p className={status?.error ? 'hint error' : 'hint'} id={`${id}-status`} role="status">
        {status?.text ?? ''}
      </p>
    </div>
  )
}
