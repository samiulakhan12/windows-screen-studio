/**
 * Captions › Languages (docs/design/captions-studio.md §2.10, §11.9): one row per caption track,
 * which of them is drawn on the video, Translate again and Remove, and Add a language. Mounted by
 * the Captions tab with props { project: Project } (§14.4).
 *
 * Translation goes through the AI provider's 'translate' task and writes a track (the captions
 * keep their text). On this PC (Mozilla's models) waits for the owner's decision on their
 * licences (§0.3 item 5): OFFLINE_TRANSLATION is its seam.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AiProviderInfo, AiTextResult } from '../../../../shared/api/ai'
import { captionsToTranslate, languageName, languagesToAdd, trackOf, trackRows, withoutTrack, withShownTrack, withTranslation } from '../../../../shared/captions/captionTracks'
import { MAX_TRACKS } from '../../../../shared/captions/studioData'
import type { Project } from '../../../../shared/types'
import { AI_PROVIDERS_CHANGED_EVENT, OPEN_SETTINGS_EVENT } from '../../settings/SettingsButton'
import { ipcMessage, onSectionRequest, takeSectionRequest } from '../captionItems'
import { useEditor } from '../context'
import { Section } from '../controls'

/**
 * Whether On this PC is offered. TODO(phase B): Mozilla's translation models and runtime
 * (translator.ts, the catalogue) once the owner approves their licences (§0.3 item 5, §18).
 */
const OFFLINE_TRANSLATION = false

const KIND_NAMES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }
export const providerName = (p: AiProviderInfo): string => p.label || KIND_NAMES[p.kind]

/**
 * The AI providers set up in Settings: read on mount, when the window gets the focus back and when
 * the settings say they changed. Null while the first read is under way; empty when none (or the
 * list cannot be read).
 */
export function useTextProviders(): AiProviderInfo[] | null {
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const n = ++seq.current
    window.api
      .listAiProviders()
      .then((list) => n === seq.current && setProviders(Array.isArray(list) ? list : []))
      .catch(() => n === seq.current && setProviders([]))
  }, [])
  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    window.addEventListener(AI_PROVIDERS_CHANGED_EVENT, reload)
    return () => {
      seq.current++
      window.removeEventListener('focus', reload)
      window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, reload)
    }
  }, [reload])
  return providers
}

/** Opens Settings at the AI providers. */
export const openAiSettings = (): void => void window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'ai' } }))

/** A translation under way: its language and how many captions it sends. */
interface Job {
  language: string
  count: number
  cancelled: boolean
}

export function LanguagesSection({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  const providers = useTextProviders()
  const list = providers ?? []
  const [adding, setAdding] = useState(false)
  const [language, setLanguage] = useState('')
  const [via, setVia] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const select = useRef<HTMLSelectElement>(null)
  const focusSelect = useRef(false)
  const live = useRef(true)
  const running = useRef<Job | null>(null)
  const group = useId()
  useEffect(
    () => () => {
      live.current = false
      // A translation still under way is dropped with the section.
      if (running.current) running.current.cancelled = true
    },
    []
  )

  const offered = languagesToAdd(project)
  const chosenLanguage = offered.some((l) => l.code === language) ? language : (offered[0]?.code ?? '')
  const chosenVia = list.find((p) => p.id === via) ?? list[0] ?? null

  // Translate captions with AI… and Add a caption language… open the form (§2.14), also when asked before the tab opened.
  useEffect(() => {
    const take = (): void => {
      const r = takeSectionRequest('language')
      if (!r) return
      setAdding(true)
      // On this PC when it is offered and asked for; else (and for 'ai') the first provider.
      setVia(null)
      setError(null)
      focusSelect.current = true
    }
    take()
    return onSectionRequest(take)
  }, [])
  useEffect(() => {
    if (adding && focusSelect.current && select.current) {
      focusSelect.current = false
      select.current.focus()
    }
  })

  const translate = async (code: string, provider: AiProviderInfo, again: boolean): Promise<void> => {
    if (running.current) return
    const sent = captionsToTranslate(store.state, code)
    if (!sent.length) {
      setStatus(`The ${languageName(code)} captions are up to date`)
      return
    }
    const mine: Job = { language: code, count: sent.length, cancelled: false }
    running.current = mine
    setJob(mine)
    setError(null)
    setStatus('')
    let result: AiTextResult
    try {
      // TODO(phase B): pass a requestId so Cancel also stops the provider's request (cancelAiText, publishing pack).
      result = await window.api.aiText(provider.id, { task: 'translate', segments: sent, targetLanguage: languageName(code) })
    } catch (err) {
      if (!mine.cancelled && live.current) setError(`Could not translate: ${ipcMessage(err).replace(/\.?$/, '.')}`)
      return
    } finally {
      if (running.current === mine) running.current = null
      if (live.current) setJob((j) => (j === mine ? null : j))
    }
    if (mine.cancelled || !live.current) return
    let used = false
    // One undo step; nothing changes when the answer cannot be used.
    store.update((p) => {
      const next =
        result.task === 'translate' ? withTranslation(p, { language: code, by: provider.kind, model: provider.model, createdAt: new Date().toISOString(), sent, answer: result.segments }) : null
      used = !!next
      return next ?? p
    })
    if (!used) {
      setError("Could not translate: the provider changed the captions' timing or left some out.")
      return
    }
    setAdding(false)
    setStatus(`${again ? 'Translated again' : 'Translated'} ${sent.length} ${sent.length === 1 ? 'caption' : 'captions'} into ${languageName(code)}`)
  }

  const cancel = (): void => {
    const j = running.current
    if (!j) return
    j.cancelled = true
    running.current = null
    setJob(null)
    setError('Could not translate: it was cancelled.')
  }

  const rows = trackRows(project)
  const full = (project.captionTracks?.length ?? 0) >= MAX_TRACKS
  const noProviders = providers !== null && list.length === 0
  const againWith = (code: string): AiProviderInfo | null => {
    const track = trackOf(project, code)
    return list.find((p) => p.kind === track?.by) ?? list[0] ?? null
  }

  return (
    <div data-testid="caption-languages">
      <Section title="Languages">
        <div role="radiogroup" aria-label="Captions drawn on the video" className="caption-list">
          {rows.map((row) => {
            const code = row.language
            const provider = code ? againWith(code) : null
            const stale = row.changed + row.missing > 0
            return (
              <div key={code ?? ''} className="caption-row" data-track={code ?? ''}>
                <div className="caption-text">
                  <strong>{row.label}</strong>
                  {row.notes.map((n) => (
                    <span key={n} className="hint">
                      {' · '}
                      {n}
                    </span>
                  ))}
                </div>
                <div className="row start">
                  <label className="toggle">
                    <input type="radio" name={`${group}-shown`} data-testid="track-show" checked={row.shown} onChange={() => store.update((p) => withShownTrack(p, code))} />
                    <span>Show on the video</span>
                  </label>
                  {code && (
                    <>
                      <button
                        className="btn small"
                        data-testid="track-retranslate"
                        aria-label={`Translate the ${languageName(code)} captions again`}
                        disabled={!stale || !provider || !!job}
                        title={!provider ? 'Add an AI provider to translate' : stale ? 'Translates only the captions that changed or are missing' : 'Up to date'}
                        onClick={() => provider && void translate(code, provider, true)}
                      >
                        Translate again
                      </button>
                      <button
                        className="btn small ghost"
                        data-testid="track-remove"
                        aria-label={`Remove the ${languageName(code)} captions`}
                        disabled={job?.language === code}
                        onClick={() => store.update((p) => withoutTrack(p, code))}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {!adding ? (
          <div className="row start">
            <button
              className="btn small"
              data-testid="track-add"
              disabled={full || offered.length === 0}
              title={full ? `A project keeps at most ${MAX_TRACKS} translations` : undefined}
              onClick={() => {
                setAdding(true)
                setError(null)
                focusSelect.current = true
              }}
            >
              Add a language
            </button>
          </div>
        ) : noProviders && !OFFLINE_TRANSLATION ? (
          <div className="captions-empty">
            <p>Add an AI provider to translate your captions. OpenAI, Gemini and Claude all can.</p>
            <div className="row start">
              <button className="btn small" onClick={openAiSettings}>
                Add an AI provider
              </button>
              <button className="btn small ghost" onClick={() => setAdding(false)}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="captions-suggestion">
            <label className="field">
              <span>Language</span>
              <select ref={select} className="captions-select" value={chosenLanguage} onChange={(e) => setLanguage(e.target.value)} disabled={!!job}>
                {offered.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="chips" role="group" aria-label="Translate with">
              {list.map((p) => (
                <button key={p.id} className={`chip ${chosenVia?.id === p.id ? 'active' : ''}`} aria-pressed={chosenVia?.id === p.id} disabled={!!job} onClick={() => setVia(p.id)}>
                  {providerName(p)}
                </button>
              ))}
            </div>
            {chosenVia && <p className="hint">The captions' text is sent to {providerName(chosenVia)} with your key; their timing stays.</p>}
            <div className="row start">
              <button className="btn small primary" data-testid="track-translate" disabled={!chosenLanguage || !chosenVia || !!job} onClick={() => chosenVia && void translate(chosenLanguage, chosenVia, false)}>
                Translate
              </button>
              <button className="btn small ghost" disabled={!!job} onClick={() => setAdding(false)}>
                Close
              </button>
            </div>
          </div>
        )}

        {job && (
          <div className="row start">
            <span className="hint" role="status">
              Translating {job.count} {job.count === 1 ? 'caption' : 'captions'} into {languageName(job.language)}…
            </span>
            <button className="btn small ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
        {error && (
          <p className="captions-error" role="alert">
            {error}
          </p>
        )}
        <p className="hint" role="status">
          {status}
        </p>
      </Section>
    </div>
  )
}
