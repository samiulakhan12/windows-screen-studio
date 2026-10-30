import { useEffect, useRef, useState } from 'react'
import { AI_PROVIDER_KINDS, type AiProviderInfo } from '../../../shared/api/ai'
import { ProviderForm } from './ProviderForm'
import { canDo, ipcMessage } from './providerText'
import { SPEECH_COPY } from '../../../shared/speech/speechCopy'
import { BUNDLED_MODEL_LIST, retiringNotes } from '../../../shared/ai/modelList'
import { today, useModelList } from './useModelList'

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
      <h3 id="settings-ai-title">AI providers</h3>
      <p className="hint">
        Use your own API key for auto captions and transcript tools. <strong>Transcription</strong> works with OpenAI or Google Gemini. All three providers can
        clean up and translate a transcript and suggest chapters, a title or a summary for it; Anthropic Claude cannot transcribe (the Claude API does not accept sound).
      </p>
      <p className="hint">{SPEECH_COPY.aiProvidersNoKey}</p>
      <p className="settings-privacy">
        <span aria-hidden="true">🔒</span> Keys are stored encrypted on this PC and are only sent to the provider you pick.
      </p>

      {mode.kind !== 'list' ? (
        <ProviderForm
          editing={mode.kind === 'edit' ? mode.provider : null}
          existing={providers ?? []}
          onCancel={() => closeForm(mode.kind === 'edit' ? `edit:${mode.provider.id}` : '')}
          onSaved={(saved) => {
            setProviders((list) => {
              const rest = (list ?? []).filter((p) => p.id !== saved.id)
              return mode.kind === 'edit' ? (list ?? []).map((p) => (p.id === saved.id ? saved : p)) : [...rest, saved]
            })
            setTests((t) => {
              const { [saved.id]: _gone, ...rest } = t
              return rest
            })
            closeForm(`test:${saved.id}`)
            onChanged?.()
          }}
        />
      ) : (
        <>
          {loadError && (
            <p className="error" role="alert">
              Could not read the providers: {loadError}
            </p>
          )}
          {providers && providers.length === 0 && <p className="settings-empty">No provider yet. Add one to transcribe recordings and work on captions.</p>}
          {providers && providers.length > 0 && (
            <ul className="ai-providers" aria-label="AI providers">
              {providers.map((p) => {
                const t = tests[p.id]
                return (
                  <li key={p.id} className="ai-provider" data-provider-id={p.id}>
                    <div className="ai-provider-main">
                      <div className="ai-provider-title">
                        <strong className="ai-provider-name">{p.label}</strong>
                        <span className={`ai-kind ai-kind-${p.kind}`}>{AI_PROVIDER_KINDS[p.kind].label}</span>
                      </div>
                      <div className="ai-provider-meta">
                        <span title="API key (only the end is shown)">Key {p.maskedKey === 'unreadable' ? <em className="error">cannot be read: edit and enter it again</em> : <code>{p.maskedKey}</code>}</span>
                        <span>
                          Text model <code>{p.model}</code>
                        </span>
                        {p.transcriptionModel && (
                          <span>
                            Transcription <code>{p.transcriptionModel}</code>
                          </span>
                        )}
                      </div>
                      <div className="ai-provider-can">{canDo(p.kind)}.</div>
                      {retiringNotes(modelList, p, day).map((note) => (
                        <p key={note} className="ai-retiring" data-testid="ai-retiring">
                          {note}
                        </p>
                      ))}
                      {t && (
                        <p className={`ai-test ${t.busy ? '' : t.ok ? 'ok' : 'error'}`} role="status" aria-live="polite">
                          {t.busy ? 'Testing…' : `${t.ok ? '✓' : '✕'} ${t.message}`}
                        </p>
                      )}
                    </div>
                    {removing?.id === p.id ? (
                      <div className="ai-remove-question" role="alert">
                        <span>
                          Remove “{p.label}”? Its key is deleted from this PC.
                          {removeError && <span className="error"> {removeError}</span>}
                        </span>
                        <button type="button" className="btn danger settings-small" onClick={() => void remove(p)}>
                          Remove
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
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="ai-provider-actions">
                        <button type="button" className="btn settings-small" data-focus-key={`test:${p.id}`} disabled={t?.busy} onClick={() => void test(p)} aria-label={`Test ${p.label}`}>
                          Test
                        </button>
                        <button
                          type="button"
                          className="btn ghost settings-small"
                          data-focus-key={`edit:${p.id}`}
                          onClick={() => setMode({ kind: 'edit', provider: p })}
                          aria-label={`Edit ${p.label}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn ghost danger settings-small"
                          data-focus-key={`remove:${p.id}`}
                          onClick={() => {
                            setRemoveError(null)
                            setRemoving(p)
                          }}
                          aria-label={`Remove ${p.label}`}
                        >
                          Remove
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
              + Add provider
            </button>
          </div>
        </>
      )}
    </section>
  )
}
