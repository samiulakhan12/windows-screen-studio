import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SCRIPT_DRAFT_MAX_NOTES, type AiProviderInfo } from '../../../shared/api/ai'
import { hasNotesText } from '../../../shared/notes/notes'
import { NOTES_COPY } from '../../../shared/notes/notesCopy'
import { AI_PROVIDERS_CHANGED_EVENT, OPEN_SETTINGS_EVENT } from '../settings/SettingsButton'
import { ipcMessage } from '../settings/providerText'
import { textChoicesOf } from '../ai/textChoices'
import { useLocalAiReady } from '../ai/localAiState'
import { LocalProgress } from '../ai/LocalProgress'
import { CostLine } from '../ai/CostLine'

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

/**
 * The AI providers: read now, when the settings say they changed, and when the settings dialog
 * closes (which also calls `onSettingsClosed`).
 */
function useProviders(onSettingsClosed: () => void): AiProviderInfo[] | null {
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null)
  const closedRef = useRef(onSettingsClosed)
  closedRef.current = onSettingsClosed
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
      if (changes.some((c) => Array.from(c.removedNodes).some(isSettingsDialog))) {
        reload()
        closedRef.current()
      }
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
  // The focused button went away (Draft script and Cancel take turns, Restore my notes goes, or
  // Add an AI provider, which opened the settings, went while they were open): the one there
  // now takes the focus, so it stays in the dialog (Esc still closes it). Draft script may be
  // disabled (a draft too long to draft again): then Restore my notes, else the text.
  const draftButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const keepFocus = useCallback((): void => {
    if (document.activeElement && document.activeElement !== document.body) return
    const textarea = box.current?.closest('[role="dialog"]')?.querySelector('textarea') ?? null
    for (const el of [cancelButton.current ?? draftButton.current, restoreButton.current, textarea]) {
      el?.focus()
      if (el && document.activeElement === el) return
    }
  }, [])
  // After the settings dialog's own clean-up, which sends the focus back to what opened it if it is still there.
  const afterSettings = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(afterSettings.current), [])
  const providers = useProviders(() => {
    clearTimeout(afterSettings.current)
    afterSettings.current = setTimeout(keepFocus, 0)
  })
  const [provider, setProvider] = useState(rememberedProvider)
  const [draft, setDraft] = useState<Draft>({ kind: 'idle' })
  const request = useRef(0)
  const textRef = useRef(text)
  textRef.current = text
  // The providers, services and On this PC (smart-tools.md §20.0). Draft script is no text task of its own: it is
  // offered where a summary is.
  const localReady = useLocalAiReady()
  const list = useMemo(() => textChoicesOf(providers ?? [], 'summary', localReady), [providers, localReady])
  const chosen = list.find((p) => p.id === provider) ?? list[0] ?? null
  // Where the notes go, by the name every hint uses (smart-tools.md §20.0: a service's host, never "OpenAI" for it, never "undefined").
  const name = chosen ? (chosen.host ? chosen.place : chosen.label) : 'the provider'
  // The draft running now: its progress on this PC and Stop find it by this id.
  const [running, setRunning] = useState<string | null>(null)

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
    // Named, so cancelAiText stops it as it stops the text tools (smart-tools.md §20.0).
    const requestId = `draft-script-${n}`
    setRunning(requestId)
    try {
      const result = await window.api.draftScript(chosen.id, { notes: before, requestId })
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
    } finally {
      setRunning((r) => (r === requestId ? null : r))
    }
  }, [chosen, onReplace])

  const cancel = (): void => {
    request.current = Math.abs(request.current)
    setDraft({ kind: 'idle' })
    void window.api.cancelScriptDraft().catch((err: unknown) => console.warn('Could not cancel the draft:', err))
  }

  const busy = draft.kind === 'busy'

  useLayoutEffect(keepFocus, [draft.kind, busy, keepFocus])

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
            <LocalProgress requestId={running} onStop={() => running && void window.api.cancelAiText(running)} />
          </>
        ) : (
          <button
            ref={draftButton}
            id="notes-draft"
            type="button"
            className="btn notes-draft-btn"
            aria-describedby={chosen ? 'notes-draft-cost-draft' : undefined}
            disabled={disabled || empty || tooLong}
            title={blockedTitle}
            onClick={() => void start()}
          >
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
                {p.label}
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
      {chosen && !tooLong && draft.kind !== 'explain' && <p className="hint">{chosen.kind === 'local' ? NOTES_COPY.draftHintLocal : NOTES_COPY.draftHint(name)}</p>}
      {/* What Draft script sends, where, and what it costs (smart-tools.md §11.5), part P5's: no text task of its own, so no request to estimate yet. */}
      {chosen && !tooLong && <CostLine id="notes-draft-cost" choice={chosen} full actions={[{ key: 'draft', label: 'Draft script', buttonId: 'notes-draft', request: null }]} />}
    </div>
  )
}
