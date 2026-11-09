import { useEffect, useId, useState, type FormEvent } from 'react'
import { AI_LIMITS, AI_PROVIDER_KINDS, type AiProviderInfo, type AiProviderInput, type ModelListTarget, type ServicePreset } from '../../../shared/api/ai'
import type { AiProviderKind } from '../../../shared/types'
import { azureBaseUrl, azureResource, readBaseUrl, type BaseUrlResult } from '../../../shared/ai/baseUrl'
import { PRESET_ORDER, presetAt, SERVICE_PRESETS } from '../../../shared/ai/presets'
import { priceOf } from '../../../shared/ai/prices'
import { ModelCombobox } from '../ai/ModelCombobox'
import { costData, refreshCostData } from '../ai/useCost'
import { canDo, ipcMessage } from './providerText'
import { suggestedModels, useModelList } from './useModelList'

/** The kinds of the picker: the three providers, and More services (§2.6). */
type FormKind = AiProviderKind | 'service'
const KINDS: { kind: FormKind; label: string }[] = [...Object.values(AI_PROVIDER_KINDS).map((k) => ({ kind: k.kind as FormKind, label: k.label })), { kind: 'service', label: 'More services' }]
export const MORE_SERVICES_HINT = 'OpenRouter, Groq, Together AI, Azure OpenAI, Ollama, LM Studio or any OpenAI-compatible address'

/** Where each provider's requests go (the key and the text), as the line under the form names it. */
const KIND_HOSTS: Record<AiProviderKind, string> = { openai: 'api.openai.com', gemini: 'generativelanguage.googleapis.com', anthropic: 'api.anthropic.com' }

/** What a check of the key said, for the provider's row. */
export interface CheckResult {
  ok: boolean
  message: string
}

/** A name for a new provider that no other provider has ("OpenAI", "OpenAI 2", ...). */
function freeName(base: string, existing: readonly AiProviderInfo[]): string {
  const taken = new Set(existing.map((p) => p.label))
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`
    if (!taken.has(name)) return name
  }
}

/** A price typed in the Prices fields: a number of 0 to 1,000, or null (empty or not a number). */
const priceOk = (v: string): number | null => {
  if (!v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : null
}

/**
 * Adds a provider or edits one: its kind (OpenAI, Gemini, Claude, or More services: OpenRouter, Groq,
 * Together AI, Azure OpenAI, Ollama and LM Studio on this PC, or any OpenAI-compatible address), a
 * name, the API key (hidden unless shown; when editing, left empty to keep the stored one, unless a
 * service moved to another address), the models (comboboxes filled from the provider), and its prices.
 * Saving sends the key to the main process, which checks and encrypts it; a service is then checked
 * (Save and check): the key, and how it answers in JSON.
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
  onSaved: (saved: AiProviderInfo, check?: CheckResult) => void
}): JSX.Element {
  const id = useId()
  const startKind: FormKind = editing?.service ? 'service' : (editing?.kind ?? 'openai')
  const [kind, setKind] = useState<FormKind>(startKind)
  const [preset, setPreset] = useState<ServicePreset>(editing?.service?.preset ?? 'openrouter')
  const [baseUrl, setBaseUrl] = useState(editing?.service?.baseUrl ?? SERVICE_PRESETS.openrouter.baseUrl ?? '')
  const [resource, setResource] = useState(editing?.service ? (azureResource(editing.service.baseUrl) ?? '') : '')
  const [keepNoData, setKeepNoData] = useState(editing?.service ? editing.service.keepNoData === true : true)
  const [label, setLabel] = useState(editing?.label ?? freeName('OpenAI', existing))
  const [labelEdited, setLabelEdited] = useState(!!editing)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const isService = kind === 'service'
  const apiKind: AiProviderKind = isService ? 'openai' : kind
  const info = AI_PROVIDER_KINDS[apiKind]
  const sameKind = !!editing && (editing.service ? isService : !isService && editing.kind === kind)
  // The suggested models come from the list Flown has (NW-15), which may answer after the form opens.
  const list = useModelList()
  const suggested = suggestedModels(list, apiKind)
  const [model, setModel] = useState(editing?.model ?? suggested.model)
  const [transcriptionModel, setTranscriptionModel] = useState(editing?.transcriptionModel ?? suggested.transcriptionModel ?? '')
  const [modelsEdited, setModelsEdited] = useState(!!editing)
  // Sent only once typed in: main fills in its own newest suggestion, or keeps the provider's model.
  const [transcriptionTyped, setTranscriptionTyped] = useState(false)
  const [pricesOpen, setPricesOpen] = useState(false)
  const [prices, setPrices] = useState<{ input: string; output: string } | null>(null)
  const [saving, setSaving] = useState<'saving' | 'checking' | false>(false)
  const [error, setError] = useState<string | null>(null)

  // The list answered after the form opened: its suggestions replace the built-in ones not yet edited.
  useEffect(() => {
    if (!list || modelsEdited || isService) return
    setModel(suggestedModels(list, apiKind).model)
    setTranscriptionModel(suggestedModels(list, apiKind).transcriptionModel ?? '')
    // Only when the list arrives: a change of kind sets its own models.
  }, [list])

  // A service's address: Azure's built from its resource name (§10.2).
  const url: BaseUrlResult | null = isService ? (preset === 'azure' ? azureBaseUrl(resource) : readBaseUrl(baseUrl)) : null
  const origin = url?.ok ? url.origin : null
  const sameOrigin = !!editing?.service && !!origin && new URL(editing.service.baseUrl).origin === origin
  const loopback = !!url?.ok && url.loopback
  const keepsKey = sameKind && (!isService || sameOrigin)
  const keyNeeded = !keepsKey && !(isService && loopback)
  const host = isService ? (url?.ok ? url.host : (SERVICE_PRESETS[preset].host ?? '')) : KIND_HOSTS[apiKind]

  // The prices Flown knows for this model (the user's own first), shown until the user types others.
  const priceService = isService ? (url?.ok ? SERVICE_PRESETS[presetAt(url.host)].priceService : null) : apiKind
  // The user's own prices are for the model they were typed for, where it ran: another model, kind or address has none of them.
  const ownHolds = !!editing && model.trim() === editing.model && (editing.service ? sameOrigin : sameKind)
  const ownPrice = ownHolds ? costData().own[editing.id] : undefined
  const listed = priceService ? priceOf(costData().shown, priceService, model.trim()) : null
  const known = ownPrice ?? (listed && listed.input !== undefined && listed.output !== undefined ? { input: listed.input, output: listed.output } : null)
  const priceFields = prices ?? { input: known ? String(known.input) : '', output: known ? String(known.output) : '' }

  const pickKind = (k: FormKind): void => {
    if (k === kind) return
    setKind(k)
    const nextKind: AiProviderKind = k === 'service' ? 'openai' : k
    const next = suggestedModels(list, nextKind)
    const back = !!editing && (editing.service ? k === 'service' : k === editing.kind)
    // Models of one provider mean nothing to another: back to the new kind's suggestions (none for a service).
    setModel(back && editing ? editing.model : k === 'service' ? '' : next.model)
    setTranscriptionModel(back && editing ? (editing.transcriptionModel ?? next.transcriptionModel ?? '') : (next.transcriptionModel ?? ''))
    setModelsEdited(back)
    setTranscriptionTyped(false)
    setPrices(null)
    if (!labelEdited) setLabel(freeName(k === 'service' ? SERVICE_PRESETS[preset].label : AI_PROVIDER_KINDS[k].label, existing))
  }

  const pickPreset = (p: ServicePreset): void => {
    setPreset(p)
    const fill = SERVICE_PRESETS[p].baseUrl
    if (fill) setBaseUrl(fill)
    else if (p === 'other') setBaseUrl('')
    setPrices(null)
    if (!labelEdited) setLabel(freeName(SERVICE_PRESETS[p].label, existing))
  }

  /**
   * Whether the edit stays in the same store: a provider of another kind is changed in place (main
   * asks for the new kind's key, keyStore.ts), a service moved to a provider or back is saved anew
   * and the old one then removed.
   */
  const sameStore = !!editing && !!editing.service === isService

  /** What the form would save, as main reads it (also the model lists' draft). */
  const input = (withKey: boolean): AiProviderInput | null => {
    if (isService && !url?.ok) return null
    return {
      ...(editing && sameStore ? { id: editing.id } : {}),
      kind: apiKind,
      label: label.trim(),
      ...(withKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      model: model.trim(),
      ...(!isService && info.canTranscribe && transcriptionTyped ? { transcriptionModel: transcriptionModel.trim() } : {}),
      ...(isService && url?.ok ? { service: { preset, baseUrl: url.baseUrl, ...(preset === 'openrouter' ? { keepNoData } : {}) } } : {})
    }
  }
  const draft = input(true)
  const target: ModelListTarget | null = draft ? { draft: { ...draft, label: draft.label || 'draft' } } : null

  /**
   * Keeps the prices typed for provider `pid` (pref aiPrices), or forgets them when cleared, or when
   * none were typed and those it had were for another model or address (they would under-count it).
   */
  const savePrices = async (pid: string): Promise<void> => {
    const own = { ...costData().own }
    if (!prices) {
      if (ownHolds || !own[pid]) return
      delete own[pid]
    } else {
      const inP = priceOk(prices.input)
      const outP = priceOk(prices.output)
      if (inP === null || outP === null) delete own[pid]
      else own[pid] = { input: inP, output: outP }
    }
    await window.api.setPref('aiPrices', own)
    await refreshCostData()
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (saving) return
    setError(null)
    if (!label.trim()) return setError('Give the provider a name.')
    if (isService && !url?.ok) return setError(url && !url.ok ? url.message : 'Enter the address of the service.')
    if (isService && !model.trim()) return setError("Enter the model's name.")
    if (keyNeeded && !apiKey.trim()) return setError(editing?.service && !sameOrigin ? 'Enter the API key for the new address.' : 'Enter the API key.')
    if (prices && (prices.input.trim() || prices.output.trim()) && (priceOk(prices.input) === null || priceOk(prices.output) === null)) {
      return setError('Prices are US$ per million tokens, from 0 to 1,000, for both input and output.')
    }
    const body = input(true)
    if (!body) return
    setSaving('saving')
    try {
      const saved = await window.api.saveAiProvider(body)
      // The key is not kept here a moment longer than needed.
      setApiKey('')
      // Edited into the other store: the provider it was is gone, not left beside it.
      if (editing && saved.id !== editing.id) await window.api.removeAiProvider(editing.id).catch(() => undefined)
      await savePrices(saved.id).catch(() => undefined)
      let check: CheckResult | undefined
      if (isService) {
        // Save and check (§10.3): the key, and how the service answers in JSON; a fixed probe, never project text.
        setSaving('checking')
        check = await window.api.testAiProvider(saved.id).catch((err: unknown) => ({ ok: false, message: ipcMessage(err) }))
      }
      onSaved(saved, check)
    } catch (err) {
      setError(ipcMessage(err))
      setSaving(false)
    }
  }

  const keyHint = !keyNeeded && editing && keepsKey ? `Leave empty to keep the current key (${editing.maskedKey}).` : null
  const title = editing ? `Edit “${editing.label}”` : 'Add a provider'

  return (
    <form className="ai-form" onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-title`} noValidate>
      <h4 id={`${id}-title`}>{title}</h4>

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
        {isService ? (
          <p className="hint ai-can">{MORE_SERVICES_HINT}. Can do: clean-up, translation, chapters, titles and summaries; transcription is not offered through a service yet.</p>
        ) : (
          <p className="hint ai-can">
            Can do: {canDo(apiKind).toLowerCase()}.
            {!info.canTranscribe && ' It cannot transcribe: the Claude API does not accept sound, so add OpenAI or Google Gemini for auto captions.'}
          </p>
        )}
      </div>

      {isService && (
        <>
          <label className="field">
            <span>Service</span>
            <select className="settings-input" value={preset} onChange={(e) => pickPreset(e.target.value as ServicePreset)} data-testid="service-preset">
              {PRESET_ORDER.map((p) => (
                <option key={p} value={p}>
                  {SERVICE_PRESETS[p].label}
                </option>
              ))}
            </select>
          </label>
          {preset === 'azure' ? (
            <div className="field">
              <label htmlFor={`${id}-resource`}>
                <span className="settings-label">Your resource name</span>
              </label>
              <input
                id={`${id}-resource`}
                className="settings-input"
                value={resource}
                spellCheck={false}
                autoComplete="off"
                maxLength={63}
                aria-describedby={`${id}-url-hint`}
                aria-invalid={!!resource && !url?.ok}
                onChange={(e) => setResource(e.target.value)}
              />
              <p className={resource && url && !url.ok ? 'hint error' : 'hint'} id={`${id}-url-hint`}>
                {resource && url && !url.ok ? url.message : url?.ok ? url.baseUrl : 'The name of your Azure OpenAI resource: Flown builds its address.'}
              </p>
            </div>
          ) : (
            <div className="field">
              <label htmlFor={`${id}-url`}>
                <span className="settings-label">Base URL</span>
              </label>
              <input
                id={`${id}-url`}
                className="settings-input"
                value={baseUrl}
                spellCheck={false}
                autoComplete="off"
                maxLength={300}
                placeholder="https://"
                aria-describedby={`${id}-url-hint`}
                aria-invalid={!!baseUrl.trim() && !url?.ok}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <p className={baseUrl.trim() && url && !url.ok ? 'hint error' : 'hint'} id={`${id}-url-hint`}>
                {baseUrl.trim() && url && !url.ok ? url.message : 'An address that speaks OpenAI’s chat API. Plain http:// only for a service on this PC.'}
              </p>
            </div>
          )}
        </>
      )}

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
            placeholder={keepsKey && editing ? `Unchanged (${editing.maskedKey})` : isService ? (loopback ? 'Not needed' : '') : info.keyPlaceholder}
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
          {isService ? (
            <>
              {editing?.service && origin && !sameOrigin
                ? 'Enter the API key for the new address.'
                : loopback
                  ? 'No key needed for Ollama and LM Studio on this PC.'
                  : (keyHint ?? 'The key the service gave you.')}{' '}
              It is encrypted on this PC and only sent to this address.
            </>
          ) : (
            <>
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
            </>
          )}
        </p>
      </div>

      <ModelCombobox
        id={`${id}-model`}
        label={isService ? (preset === 'azure' ? 'Model (the deployment’s name)' : 'Model') : 'Model for text tasks'}
        value={model}
        target={target}
        field="text"
        onChange={(v) => {
          setModelsEdited(true)
          setModel(v)
          setPrices(null)
        }}
      />

      {!isService && info.canTranscribe && (
        <>
          <ModelCombobox
            id={`${id}-tm`}
            label="Transcription model"
            value={transcriptionModel}
            target={target}
            field="transcription"
            onChange={(v) => {
              setModelsEdited(true)
              setTranscriptionTyped(true)
              setTranscriptionModel(v)
            }}
          />
          <p className="hint" id={`${id}-tm-hint`}>
            {kind === 'openai'
              ? 'gpt-transcribe gives text only: Flown estimates word times from the sound. whisper-1 gives exact word times until OpenAI retires it on 26 February 2027.'
              : 'Gemini listens to the sound and returns sentences with their times.'}
          </p>
        </>
      )}

      <div className="field">
        <button type="button" className="link" aria-expanded={pricesOpen} aria-controls={`${id}-prices`} onClick={() => setPricesOpen((v) => !v)}>
          Prices (US$ per million tokens)
        </button>
        {pricesOpen && (
          <div id={`${id}-prices`} className="ai-prices">
            <label className="field">
              <span>Input</span>
              <input
                className="settings-input"
                type="number"
                min={0}
                max={1000}
                step="0.001"
                value={priceFields.input}
                onChange={(e) => setPrices({ ...priceFields, input: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Output</span>
              <input
                className="settings-input"
                type="number"
                min={0}
                max={1000}
                step="0.001"
                value={priceFields.output}
                onChange={(e) => setPrices({ ...priceFields, output: e.target.value })}
              />
            </label>
            {!known && <p className="hint">Not in Flown&apos;s price list: add them to see costs.</p>}
          </div>
        )}
      </div>

      {isService && preset === 'openrouter' && (
        <label className="ai-check-row">
          <input type="checkbox" checked={keepNoData} onChange={(e) => setKeepNoData(e.target.checked)} />
          <span>Only use hosts that do not keep my prompts</span>
        </label>
      )}

      <p className="hint" data-testid="ai-goes-to">
        Your key and the text you send go to <strong>{host || 'the address above'}</strong>.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ai-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!!saving}>
          {saving === 'checking' ? 'Checking…' : saving ? 'Saving…' : isService ? 'Save and check' : editing ? 'Save' : 'Add provider'}
        </button>
      </div>
    </form>
  )
}
