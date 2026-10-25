import { useId, useState, type FormEvent } from 'react'
import { AI_LIMITS, AI_PROVIDER_KINDS, type AiProviderInfo } from '../../../shared/api/ai'
import type { AiProviderKind } from '../../../shared/types'
import { canDo, ipcMessage } from './providerText'

const KINDS = Object.values(AI_PROVIDER_KINDS)

/** A name for a new provider of `kind` that no other provider has ("OpenAI", "OpenAI 2", ...). */
function freeName(kind: AiProviderKind, existing: readonly AiProviderInfo[]): string {
  const base = AI_PROVIDER_KINDS[kind].label
  const taken = new Set(existing.map((p) => p.label))
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`
    if (!taken.has(name)) return name
  }
}

/**
 * Adds a provider or edits one: its kind, a name, the API key (hidden unless shown; when editing,
 * left empty to keep the stored one) and the models, with good defaults. Saving sends the key to
 * the main process, which checks and encrypts it.
 */
export function ProviderForm({
  editing,
  existing,
  onCancel,
  onSaved
}: {
  editing: AiProviderInfo | null
  existing: readonly AiProviderInfo[]
  onCancel: () => void
  onSaved: (saved: AiProviderInfo) => void
}): JSX.Element {
  const id = useId()
  const [kind, setKind] = useState<AiProviderKind>(editing?.kind ?? 'openai')
  const [label, setLabel] = useState(editing?.label ?? freeName('openai', existing))
  const [labelEdited, setLabelEdited] = useState(!!editing)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const info = AI_PROVIDER_KINDS[kind]
  const sameKind = editing?.kind === kind
  const [model, setModel] = useState(editing?.model ?? info.defaultModel)
  const [transcriptionModel, setTranscriptionModel] = useState(editing?.transcriptionModel ?? info.defaultTranscriptionModel ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pickKind = (k: AiProviderKind): void => {
    if (k === kind) return
    setKind(k)
    const next = AI_PROVIDER_KINDS[k]
    // Models of one provider mean nothing to another: back to the new kind's defaults.
    setModel(editing?.kind === k ? editing.model : next.defaultModel)
    setTranscriptionModel(editing?.kind === k ? (editing.transcriptionModel ?? next.defaultTranscriptionModel ?? '') : (next.defaultTranscriptionModel ?? ''))
    if (!labelEdited) setLabel(freeName(k, existing))
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (saving) return
    setError(null)
    if (!label.trim()) return setError('Give the provider a name.')
    if (!apiKey.trim() && !(editing && sameKind)) return setError('Enter the API key.')
    setSaving(true)
    try {
      const saved = await window.api.saveAiProvider({
        ...(editing ? { id: editing.id } : {}),
        kind,
        label: label.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model: model.trim(),
        ...(info.canTranscribe ? { transcriptionModel: transcriptionModel.trim() } : {})
      })
      // The key is not kept here a moment longer than needed.
      setApiKey('')
      onSaved(saved)
    } catch (err) {
      setError(ipcMessage(err))
      setSaving(false)
    }
  }

  const keyHint = editing && sameKind ? `Leave empty to keep the current key (${editing.maskedKey}).` : null

  return (
    <form className="ai-form" onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-title`} noValidate>
      <h4 id={`${id}-title`}>{editing ? `Edit “${editing.label}”` : 'Add a provider'}</h4>

      <div className="field">
        <span id={`${id}-kind`}>Provider</span>
        <div className="segmented ai-kind-picker" role="radiogroup" aria-labelledby={`${id}-kind`}>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              className={kind === k.kind ? 'active' : ''}
              tabIndex={kind === k.kind ? 0 : -1}
              onClick={() => pickKind(k.kind)}
              onKeyDown={(e) => {
                // Arrow keys move between the choices, as in any radio group.
                const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                if (!step) return
                e.preventDefault()
                const next = KINDS[(KINDS.findIndex((x) => x.kind === kind) + step + KINDS.length) % KINDS.length]
                pickKind(next.kind)
                const group = e.currentTarget.parentElement
                window.setTimeout(() => group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(), 0)
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="hint ai-can">
          Can do: {canDo(kind).toLowerCase()}.
          {!info.canTranscribe && ' It cannot transcribe: the Claude API does not accept sound, so add OpenAI or Google Gemini for auto captions.'}
        </p>
      </div>

      <label className="field">
        <span>Name</span>
        <input
          className="settings-input"
          value={label}
          maxLength={AI_LIMITS.labelLength}
          autoFocus
          onChange={(e) => {
            setLabel(e.target.value)
            setLabelEdited(true)
          }}
        />
      </label>

      <div className="field">
        <label htmlFor={`${id}-key`}>
          <span className="settings-label">API key</span>
        </label>
        <div className="ai-key-row">
          <input
            id={`${id}-key`}
            className="settings-input"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            placeholder={editing && sameKind ? `Unchanged (${editing.maskedKey})` : info.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            maxLength={AI_LIMITS.keyLength}
            aria-describedby={`${id}-key-hint`}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button type="button" className="btn ghost settings-small" aria-pressed={showKey} aria-label={showKey ? 'Hide the key' : 'Show the key'} onClick={() => setShowKey((v) => !v)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="hint" id={`${id}-key-hint`}>
          {keyHint ?? (
            <>
              Create a key at{' '}
              <a href={info.keyPage} target="_blank" rel="noreferrer">
                {new URL(info.keyPage).host}
              </a>
              .
            </>
          )}{' '}
          It is encrypted on this PC and only sent to {info.label}.
        </p>
      </div>

      <label className="field">
        <span>Model for text tasks</span>
        <input
          className="settings-input"
          value={model}
          placeholder={info.defaultModel}
          maxLength={AI_LIMITS.modelLength}
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>

      {info.canTranscribe && (
        <label className="field">
          <span>Transcription model</span>
          <input
            className="settings-input"
            value={transcriptionModel}
            placeholder={info.defaultTranscriptionModel}
            maxLength={AI_LIMITS.modelLength}
            spellCheck={false}
            aria-describedby={`${id}-tm-hint`}
            onChange={(e) => setTranscriptionModel(e.target.value)}
          />
          <span className="hint" id={`${id}-tm-hint`}>
            {kind === 'openai'
              ? 'whisper-1 is the OpenAI model that gives word and sentence timings, which captions need.'
              : 'Gemini listens to the sound and returns sentences with their times.'}
          </span>
        </label>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ai-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save' : 'Add provider'}
        </button>
      </div>
    </form>
  )
}
