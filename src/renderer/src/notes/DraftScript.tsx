import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SCRIPT_DRAFT_MAX_NOTES, type AiProviderInfo } from '../../../shared/api/ai'
import { hasNotesText } from '../../../shared/notes/notes'
import { NOTES_COPY } from '../../../shared/notes/notesCopy'
import { AI_PROVIDERS_CHANGED_EVENT, OPEN_SETTINGS_EVENT } from '../settings/SettingsButton'
import { ipcMessage } from '../settings/providerText'

const KIND_NAMES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** The provider picked last, for this session. */
let rememberedProvider = ''

type Draft =
  | { kind: 'idle' }
  | { kind: 'explain' }
  | { kind: 'busy' }
  | { kind: 'done'; before: string; after: string }
  | { kind: 'stale' }
  | { kind: 'error'; message: string }

/** Whether a node removed from the page was the settings dialog (it is rendered straight into the body). */
const isSettingsDialog = (n: Node): boolean => n instanceof Element && n.classList.contains('settings-backdrop')

/** The AI providers: read now, when the settings say they changed, and when the settings dialog closes. */
function useProviders(): AiProviderInfo[] | null {
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null)
  useEffect(() => {
    let seq = 0
    const reload = (): void => {
      const n = ++seq
      window.api.listAiProviders().then(
        (list) => n === seq && setProviders(Array.isArray(list) ? list : []),
        (err: unknown) => {
          console.warn('Could not list the AI providers:', err)
          if (n === seq) setProviders([])
        }
      )
    }
    reload()
    window.addEventListener(AI_PROVIDERS_CHANGED_EVENT, reload)
    const closed = new MutationObserver((changes) => {
      if (changes.some((c) => Array.from(c.removedNodes).some(isSettingsDialog))) reload()
    })
    closed.observe(document.body, { childList: true })
    return () => {
      seq++
      window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, reload)
      closed.disconnect()
    }
  }, [])
  return providers
}

/**
 * "Draft script": turns the notes into sentences to read aloud with the user's AI provider.
 * Only the notes are sent, only on the click. The draft replaces the text only when the text is
 * unchanged since the request; "Restore my notes" brings the notes back until the next edit (or
 * until the dialog closes, which unmounts this).
 */
export function DraftScript({ text, onReplace, disabled }: { text: string; onReplace: (text: string) => void; disabled?: boolean }): JSX.Element {
  const providers = useProviders()
  const [provider, setProvider] = useState(rememberedProvider)
  const [draft, setDraft] = useState<Draft>({ kind: 'idle' })
  const request = useRef(0)
  const textRef = useRef(text)
  textRef.current = text
  const list = providers ?? []
  const chosen = list.find((p) => p.id === provider) ?? list[0] ?? null
  const name = chosen ? chosen.label || KIND_NAMES[chosen.kind] : 'the provider'

  // Nothing to restore any more once the text was edited after the draft.
  useEffect(() => {
    if (draft.kind === 'done' && text !== draft.after) setDraft({ kind: 'idle' })
  }, [text, draft])

  // A provider was added: the explanation has done its job.
  useEffect(() => {
    if (chosen && draft.kind === 'explain') setDraft({ kind: 'idle' })
  }, [chosen, draft.kind])

  // Leaving cancels a draft still under way.
  useEffect(
    () => () => {
      if (request.current < 0) void window.api.cancelScriptDraft().catch(() => undefined)
      request.current = 0
    },
    []
  )

  const empty = !hasNotesText(text)
  const tooLong = text.length > SCRIPT_DRAFT_MAX_NOTES

  const start = useCallback(async (): Promise<void> => {
    if (!chosen) {
      setDraft({ kind: 'explain' })
      return
    }
    const before = textRef.current
    const n = Math.abs(request.current) + 1
    // Negative while a request is under way.
    request.current = -n
    setDraft({ kind: 'busy' })
    try {
      const result = await window.api.draftScript(chosen.id, { notes: before })
      if (request.current !== -n) return
      request.current = n
      const after = typeof result?.text === 'string' ? result.text : ''
      if (!hasNotesText(after)) {
        setDraft({ kind: 'error', message: 'The provider wrote no script. Nothing was changed; try again.' })
        return
      }
      if (textRef.current !== before) {
        setDraft({ kind: 'stale' })
        return
      }
      onReplace(after)
      setDraft({ kind: 'done', before, after })
    } catch (err) {
      if (request.current !== -n) return
      request.current = n
      setDraft({ kind: 'error', message: ipcMessage(err) })
    }
  }, [chosen, onReplace])

  const cancel = (): void => {
    request.current = Math.abs(request.current)
    setDraft({ kind: 'idle' })
    void window.api.cancelScriptDraft().catch((err: unknown) => console.warn('Could not cancel the draft:', err))
  }

  const busy = draft.kind === 'busy'

  // The focused button went away (Draft script and Cancel take turns, Restore my notes goes): the
  // one there now takes the focus, so it stays in the dialog (Esc still closes it). Draft script
  // may be disabled (a draft too long to draft again): then Restore my notes, else the text.
  const draftButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return
    const textarea = box.current?.closest('[role="dialog"]')?.querySelector('textarea') ?? null
    for (const el of [busy ? cancelButton.current : draftButton.current, restoreButton.current, textarea]) {
      el?.focus()
      if (el && document.activeElement === el) return
    }
  }, [draft.kind, busy])

  const blockedTitle = empty ? NOTES_COPY.draftEmpty : tooLong ? NOTES_COPY.draftTooLong : undefined
  return (
    <div ref={box} className="notes-draft" data-state={draft.kind}>
      <div className="notes-draft-row">
        {busy ? (
          <>
            <span className="notes-draft-busy" role="status">
              <span className="notes-spinner" aria-hidden="true" /> {NOTES_COPY.drafting}
            </span>
            <button ref={cancelButton} type="button" className="btn" onClick={cancel}>
              {NOTES_COPY.cancel}
            </button>
          </>
        ) : (
          <button ref={draftButton} type="button" className="btn notes-draft-btn" disabled={disabled || empty || tooLong} title={blockedTitle} onClick={() => void start()}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
            </svg>
            {draft.kind === 'error' ? NOTES_COPY.tryAgain : NOTES_COPY.draft}
          </button>
        )}
        {list.length >= 2 && (
          <select
            className="notes-draft-provider"
            aria-label="AI provider for the draft"
            value={chosen?.id ?? ''}
            disabled={busy || disabled}
            onChange={(e) => {
              rememberedProvider = e.target.value
              setProvider(e.target.value)
            }}
          >
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label || KIND_NAMES[p.kind]}
              </option>
            ))}
          </select>
        )}
      </div>
      {tooLong && <p className="hint">{NOTES_COPY.draftTooLong}</p>}
      {draft.kind === 'explain' && providers !== null && !chosen && (
        <div className="notes-draft-msg" role="status">
          <p className="hint">{NOTES_COPY.noProvider}</p>
          <button type="button" className="btn" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'ai' } }))}>
            {NOTES_COPY.addProvider}
          </button>
        </div>
      )}
      {draft.kind === 'done' && (
        <div className="notes-draft-msg" role="status">
          <p className="hint notes-ok">{NOTES_COPY.drafted}</p>
          <button
            ref={restoreButton}
            type="button"
            className="btn"
            onClick={() => {
              onReplace(draft.before)
              setDraft({ kind: 'idle' })
            }}
          >
            {NOTES_COPY.restore}
          </button>
        </div>
      )}
      {draft.kind === 'stale' && (
        <p className="hint notes-warn" role="status">
          {NOTES_COPY.stale}
        </p>
      )}
      {draft.kind === 'error' && (
        <p className="hint notes-warn" role="alert">
          {draft.message}
        </p>
      )}
      {chosen && !tooLong && draft.kind !== 'explain' && <p className="hint">{NOTES_COPY.draftHint(name)}</p>}
    </div>
  )
}
