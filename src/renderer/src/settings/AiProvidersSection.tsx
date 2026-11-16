import { useEffect, useId, useRef, useState } from 'react'
import { AI_PROVIDER_KINDS, type AiProviderInfo } from '../../../shared/api/ai'
import { presetLabel, ProviderForm, type CheckResult } from './ProviderForm'
import { canDo, ipcMessage } from './providerText'
import { SPEECH_COPY } from '../../../shared/speech/speechCopy'
import { BUNDLED_MODEL_LIST, retiringNotes } from '../../../shared/ai/modelList'
import { presetApplies } from '../../../shared/ai/presets'
import { CONFIRM_PREFS, DEFAULT_CONFIRM, type ConfirmPref } from '../../../shared/smart/smartPrefs'
import { refreshCostData } from '../ai/useCost'
import { LocalAiRow } from './LocalAiSection'
import { OPEN_SETTINGS_EVENT } from './brandKitEvents'
import { today, useModelList } from './useModelList'
import { t } from '../../../shared/i18n/t'
import { richText } from '../i18n/richText'

/** Settings › AI providers › Ask before a run that costs more than (pref aiConfirm, §2.6): each choice's label (the US$ amounts stay as they are). */
export const confirmLabel = (p: ConfirmPref): string => (p === 'always' ? t('settings.ai.confirmAlways') : p === 'never' ? t('settings.ai.confirmNever') : p === '0.1' ? 'US$0.10' : `US$${p}`)

/** The amount a run may cost before Flown asks, kept in pref aiConfirm (US$1 by default). */
function ConfirmSetting(): JSX.Element {
  const id = useId()
  const [value, setValue] = useState<ConfirmPref>(DEFAULT_CONFIRM)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.api.getPref('aiConfirm'))
      .then((v) => live && setValue(CONFIRM_PREFS.includes(v as ConfirmPref) ? (v as ConfirmPref) : DEFAULT_CONFIRM))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return (
    <label className="field ai-confirm-setting" htmlFor={`${id}-confirm`}>
      <span>{t('settings.ai.confirm')}</span>
      <select
        id={`${id}-confirm`}
        className="settings-input"
        data-testid="ai-confirm"
        value={value}
        onChange={(e) => {
          const next = e.target.value as ConfirmPref
          setValue(next)
          void Promise.resolve()
            .then(() => window.api.setPref('aiConfirm', next))
            .then(() => refreshCostData())
            .catch(() => undefined)
        }}
      >
        {CONFIRM_PREFS.map((p) => (
          <option key={p} value={p}>
            {confirmLabel(p)}
          </option>
        ))}
      </select>
    </label>
  )
}

/** A provider's kind as its row names it: a service by its preset (Other address by its host). */
const kindLabel = (p: AiProviderInfo): string => {
  const s = p.service
  if (!s) return AI_PROVIDER_KINDS[p.kind].label
  return s.preset !== 'other' && (presetApplies(s.preset, s.host) || s.preset === 'azure') ? presetLabel(s.preset) : t('settings.ai.service')
}

type TestState = { busy: true } | { busy: false; ok: boolean; message: string }
type Mode = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; provider: AiProviderInfo }

/**
 * The AI providers the user added with their own API keys: list, add, edit, test, remove. Keys
 * are typed here and sent once to the main process, which encrypts and keeps them; this page
 * only ever gets them back masked. `onChanged` runs after a provider was saved or removed;
 * `autoFocus` (Settings opened at the AI providers) focuses "+ Add provider".
 */
export function AiProvidersSection({ onChanged, autoFocus = true }: { onChanged?: () => void; autoFocus?: boolean } = {}): JSX.Element {
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [removing, setRemoving] = useState<AiProviderInfo | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  // Models their makers are retiring (NW-15): a note under each provider still using one.
  const modelList = useModelList() ?? BUNDLED_MODEL_LIST
  const day = today()
  const addRef = useRef<HTMLButtonElement>(null)
  /** Where focus goes when the form or a question closes. */
  const returnFocus = useRef<string | null>(null)

  const load = (): void => {
    window.api.listAiProviders().then(
      (list) => {
        setProviders(list)
        setLoadError(null)
      },
      (err: unknown) => setLoadError(ipcMessage(err))
    )
  }
  useEffect(load, [])

  // Back on the button that opened the form or question once it closes.
  useEffect(() => {
    if (mode.kind !== 'list' || removing) return
    const key = returnFocus.current
    returnFocus.current = null
    if (key === null) return
    const el = key ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null
    ;(el ?? addRef.current)?.focus({ preventScroll: true })
  }, [mode, removing])

  const test = async (p: AiProviderInfo): Promise<void> => {
    setTests((t) => ({ ...t, [p.id]: { busy: true } }))
    let result: { ok: boolean; message: string }
    try {
      result = await window.api.testAiProvider(p.id)
    } catch (err) {
      result = { ok: false, message: ipcMessage(err) }
    }
    setTests((t) => ({ ...t, [p.id]: { busy: false, ...result } }))
  }

  const remove = async (p: AiProviderInfo): Promise<void> => {
    try {
      await window.api.removeAiProvider(p.id)
      onChanged?.()
      setProviders((list) => list?.filter((x) => x.id !== p.id) ?? null)
      setRemoving(null)
      setRemoveError(null)
      returnFocus.current = ''
    } catch (err) {
      setRemoveError(ipcMessage(err))
    }
  }

  const closeForm = (focusKey: string): void => {
    returnFocus.current = focusKey
    setMode({ kind: 'list' })
  }

  return (
    <section
      className="settings-section"
      aria-labelledby="settings-ai-title"
      onKeyDown={(e) => {
        // Esc first closes the form or the question, then the dialog.
        if (e.key !== 'Escape' || e.defaultPrevented) return
        if (removing) {
          e.preventDefault()
          returnFocus.current = `remove:${removing.id}`
          setRemoving(null)
          setRemoveError(null)
        } else if (mode.kind !== 'list') {
          e.preventDefault()
          closeForm(mode.kind === 'edit' ? `edit:${mode.provider.id}` : '')
        }
      }}
    >
      <h3 id="settings-ai-title">{t('settings.ai.title')}</h3>
      <p className="hint">
        {richText('settings.ai.lead', {}, { b: (chunks) => <strong>{chunks}</strong> })}
      </p>
      <p className="hint">{SPEECH_COPY.aiProvidersNoKey}</p>
      <p className="settings-privacy">
        <span aria-hidden="true">🔒</span>
        {` ${t('settings.ai.privacy')}`}
      </p>
      {/* AI on this PC first (smart-tools.md §2.5): part P4's row, which opens its section. */}
      <LocalAiRow onOpen={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'localAi' } }))} />

      {mode.kind !== 'list' ? (
        <ProviderForm
          editing={mode.kind === 'edit' ? mode.provider : null}
          existing={providers ?? []}
          onCancel={() => closeForm(mode.kind === 'edit' ? `edit:${mode.provider.id}` : '')}
          onSaved={(saved, check?: CheckResult) => {
            setProviders((list) => {
              const rest = (list ?? []).filter((p) => p.id !== saved.id)
              // An edit takes the row it was opened from (a service edited into a provider is saved under a new id).
              return mode.kind === 'edit' ? (list ?? []).map((p) => (p.id === mode.provider.id ? saved : p)) : [...rest, saved]
            })
            setTests((t) => {
              const { [saved.id]: _gone, ...rest } = t
              // Save and check: what the check said shows under the service.
              return check ? { ...rest, [saved.id]: { busy: false, ...check } } : rest
            })
            // A check saved how the service answers in JSON: the row shows it after the list is read again.
            if (check) load()
            closeForm(`test:${saved.id}`)
            onChanged?.()
          }}
        />
      ) : (
        <>
          {loadError && (
            <p className="error" role="alert">
              {richText('settings.ai.readFailed', { reason: loadError })}
            </p>
          )}
          {providers && providers.length === 0 && <p className="settings-empty">{t('settings.ai.empty')}</p>}
          {providers && providers.length > 0 && (
            <ul className="ai-providers" aria-label={t('settings.ai.title')}>
              {providers.map((p) => {
                const tested = tests[p.id]
                return (
                  <li key={p.id} className="ai-provider" data-provider-id={p.id}>
                    <div className="ai-provider-main">
                      <div className="ai-provider-title">
                        <strong className="ai-provider-name">{p.label}</strong>
                        <span className={`ai-kind ai-kind-${p.kind}`}>{kindLabel(p)}</span>
                      </div>
                      <div className="ai-provider-meta">
                        {p.service && (
                          <span title={t('settings.ai.addressTitle')}>
                            {t('settings.ai.address')} <code>{p.service.host}</code>
                          </span>
                        )}
                        {p.maskedKey === 'none' ? (
                          <span>{t('settings.ai.noKey')}</span>
                        ) : (
                          <span title={t('settings.ai.keyTitle')}>{t('settings.ai.key')} {p.maskedKey === 'unreadable' ? <em className="error">{t('settings.ai.keyUnreadable')}</em> : <code>{p.maskedKey}</code>}</span>
                        )}
                        <span>
                          {t('settings.ai.textModel')} <code>{p.model}</code>
                        </span>
                        {p.transcriptionModel && (
                          <span>
                            {t('settings.ai.transcription')} <code>{p.transcriptionModel}</code>
                          </span>
                        )}
                      </div>
                      <div className="ai-provider-can">{p.service ? t('settings.ai.serviceCanDo') : canDo(p.kind)}.</div>
                      {retiringNotes(modelList, p, day).map((note) => (
                        <p key={note} className="ai-retiring" data-testid="ai-retiring">
                          {note}
                        </p>
                      ))}
                      {tested && (
                        <p className={`ai-test ${tested.busy ? '' : tested.ok ? 'ok' : 'error'}`} role="status" aria-live="polite">
                          {tested.busy ? t('settings.ai.testing') : `${tested.ok ? '✓' : '✕'} ${tested.message}`}
                        </p>
                      )}
                    </div>
                    {removing?.id === p.id ? (
                      <div className="ai-remove-question" role="alert">
                        <span>
                          {richText('settings.ai.removeQuestion', { name: p.label })}
                          {removeError && <span className="error"> {removeError}</span>}
                        </span>
                        <button type="button" className="btn danger settings-small" onClick={() => void remove(p)}>
                          {t('common.action.remove')}
                        </button>
                        <button
                          type="button"
                          className="btn ghost settings-small"
                          autoFocus
                          onClick={() => {
                            returnFocus.current = `remove:${p.id}`
                            setRemoving(null)
                            setRemoveError(null)
                          }}
                        >
                          {t('common.action.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="ai-provider-actions">
                        <button type="button" className="btn settings-small" data-focus-key={`test:${p.id}`} disabled={tested?.busy} onClick={() => void test(p)} aria-label={t('settings.ai.testName', { name: p.label })}>
                          {t('settings.ai.test')}
                        </button>
                        <button
                          type="button"
                          className="btn ghost settings-small"
                          data-focus-key={`edit:${p.id}`}
                          onClick={() => setMode({ kind: 'edit', provider: p })}
                          aria-label={t('settings.ai.editName', { name: p.label })}
                        >
                          {t('settings.ai.edit')}
                        </button>
                        <button
                          type="button"
                          className="btn ghost danger settings-small"
                          data-focus-key={`remove:${p.id}`}
                          onClick={() => {
                            setRemoveError(null)
                            setRemoving(p)
                          }}
                          aria-label={t('common.action.removeName', { name: p.label })}
                        >
                          {t('common.action.remove')}
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <div>
            <button type="button" className="btn" ref={addRef} autoFocus={autoFocus} onClick={() => setMode({ kind: 'add' })}>
              {t('settings.ai.add')}
            </button>
          </div>
          <ConfirmSetting />
        </>
      )}
    </section>
  )
}
