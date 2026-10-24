import { useEffect, useRef, useState, type FormEvent } from 'react'
import { cleanPresetName, MAX_PRESETS, PRESET_NAME_MAX, presetSummary, type RecordingPreset } from '../../../shared/recording/settings'
import { Icon } from '../components/Icon'
import './presets.css'

function PresetIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="icon">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  )
}

/**
 * Recording presets on Home: pick a saved setup (applied at once), save the current one under
 * a name (the same name replaces that preset), delete the one in use. Which preset is in use
 * follows the setup: changing any option shows "Custom setup".
 */
export function RecordingPresets({
  presets,
  active,
  suggestedName,
  disabled,
  onApply,
  onSave,
  onDelete
}: {
  presets: RecordingPreset[]
  /** The preset the current setup matches, if any. */
  active: RecordingPreset | null
  /** Name offered when saving (the preset applied last, so it is easy to update). */
  suggestedName: string
  disabled: boolean
  onApply: (preset: RecordingPreset) => void
  /** Saves the current setup as `name`; resolves to an error message, or null when saved. */
  onSave: (name: string) => Promise<string | null>
  onDelete: (preset: RecordingPreset) => void
}): JSX.Element {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (naming) input.current?.select()
  }, [naming])

  const clean = cleanPresetName(name)
  const replaces = clean ? presets.find((p) => p.name.localeCompare(clean, undefined, { sensitivity: 'accent' }) === 0) : undefined
  const full = presets.length >= MAX_PRESETS && !replaces

  const startNaming = (): void => {
    setError(null)
    setName(active?.name ?? suggestedName)
    setNaming(true)
  }

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!clean || busy) return
    setBusy(true)
    const message = await onSave(clean)
    setBusy(false)
    setError(message)
    if (!message) setNaming(false)
  }

  return (
    <div className="field presets" data-testid="recording-presets">
      <span>
        <PresetIcon /> Preset
      </span>
      <div className="preset-row">
        <select
          aria-label="Recording preset"
          value={active?.id ?? ''}
          disabled={disabled || presets.length === 0}
          title={active ? presetSummary(active) : undefined}
          onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value)
            if (p) onApply(p)
          }}
        >
          <option value="" disabled>
            {presets.length ? 'Custom setup' : 'No presets saved'}
          </option>
          {presets.map((p) => (
            <option key={p.id} value={p.id} title={presetSummary(p)}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`btn ghost preset-btn ${naming ? 'active' : ''}`}
          aria-label="Save as preset"
          aria-expanded={naming}
          title="Save the current setup as a preset"
          disabled={disabled}
          onClick={() => (naming ? setNaming(false) : startNaming())}
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          type="button"
          className="btn ghost danger preset-btn"
          aria-label={active ? `Delete preset ${active.name}` : 'Delete preset'}
          title={active ? `Delete the preset “${active.name}”` : 'Pick a preset to delete it'}
          disabled={disabled || !active}
          onClick={() => active && onDelete(active)}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
      {naming && (
        <form className="preset-save" onSubmit={(e) => void save(e)}>
          <input
            ref={input}
            aria-label="Preset name"
            placeholder="Name, e.g. Tutorial"
            value={name}
            maxLength={PRESET_NAME_MAX}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setNaming(false)
              }
            }}
          />
          <button type="submit" className="btn primary" disabled={!clean || busy || full}>
            {replaces ? 'Replace' : 'Save'}
          </button>
        </form>
      )}
      {naming && (error || replaces || full) && (
        <p className={`hint preset-note ${error || full ? 'error' : ''}`} role={error ? 'alert' : undefined}>
          {error ??
            (full
              ? `You can keep up to ${MAX_PRESETS} presets: delete one to save another.`
              : `Replaces the saved “${replaces!.name}” with the current setup.`)}
        </p>
      )}
    </div>
  )
}
