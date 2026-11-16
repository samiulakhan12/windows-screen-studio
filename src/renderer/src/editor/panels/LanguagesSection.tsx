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
import type { AiProviderInfo, AiTextRequest, AiTextResult, AiUsage, TextChoice } from '../../../../shared/api/ai'
import { costSentence } from '../../../../shared/ai/cost'
import { fmt } from '../../../../shared/i18n/fmt'
import { t } from '../../../../shared/i18n/t'
import { captionLanguageName, inSentence, trackRowWords } from '../captionWords'
import { captionsToTranslate, languageName, languagesToAdd, trackOf, trackRows, withoutTrack, withShownTrack, withTranslation } from '../../../../shared/captions/captionTracks'
import { MAX_TRACKS } from '../../../../shared/captions/studioData'
import type { Project } from '../../../../shared/types'
import { AI_PROVIDERS_CHANGED_EVENT, OPEN_SETTINGS_EVENT } from '../../settings/SettingsButton'
import { ipcMessage, onSectionRequest, takeSectionRequest } from '../captionItems'
import { useEditor } from '../context'
import { Section } from '../controls'
import { lastInputWasKey } from '../focus'
import { useReturnFocus } from '../returnFocus'
import { madeBy, sentHint, useTextChoiceList } from '../../ai/textChoices'
import { CostLine } from '../../ai/CostLine'
import { confirmRequest } from '../../ai/costConfirm'
import { estimateFor, runCostText, useCostData } from '../../ai/useCost'
import { LocalProgress, LocalWritten } from '../../ai/LocalProgress'

/**
 * Whether On this PC is offered. TODO(phase B): Mozilla's translation models and runtime
 * (translator.ts, the catalogue) once the owner approves their licences (§0.3 item 5, §18).
 */
const OFFLINE_TRANSLATION = false

/** Keys pressed on their own before another (Shift before Shift+Tab). */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

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

/** A translation under way: its language, how many captions it sends, and its request id (cancelAiText). */
interface Job {
  language: string
  count: number
  cancelled: boolean
  id: string
}

/** Why a project cannot take a translation into another language. */
const fullReason = (): string => t('captions.languages.full', { n: fmt.count(MAX_TRACKS) })
const allAdded = (): string => t('captions.languages.allAdded')
/** A caption language's name in the UI language (languageName gives the English one, which the AI requests keep). */
const shownName = (code: string): string => captionLanguageName(code, languageName(code))

/** Why Add a language is off for `project`, or null when it has room for another language. */
function noRoom(project: Project): string | null {
  if ((project.captionTracks?.length ?? 0) >= MAX_TRACKS) return fullReason()
  if (languagesToAdd(project).length === 0) return allAdded()
  return null
}

/** Numbers the translations, so each request has its own id. */
let translateSeq = 0

/** Drops a translation's answer and stops the provider's request. */
function stopJob(job: Job): void {
  job.cancelled = true
  void window.api.cancelAiText(job.id).catch(() => undefined)
}

export function LanguagesSection({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  // The providers, services and On this PC (smart-tools.md §20.0), each named by the place its text goes.
  const providers = useTextChoiceList('translate')
  // What a row's Translate again would cost (its button's own sentence, §11.5).
  const costs = useCostData()
  const list = providers ?? []
  const [adding, setAdding] = useState(false)
  const [language, setLanguage] = useState('')
  const [via, setVia] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  /** The status of a translation written on this PC (§2.5): while it shows, so does the line saying to check it. */
  const [writtenHere, setWrittenHere] = useState<string | null>(null)
  const select = useRef<HTMLSelectElement>(null)
  /** The form's Add an AI provider, shown when there is none. */
  const addProvider = useRef<HTMLButtonElement>(null)
  const translateButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  /** The running translation's row: its Cancel, and the Stop of AI on this PC beside it. */
  const jobRow = useRef<HTMLDivElement>(null)
  const rowsBox = useRef<HTMLDivElement>(null)
  const focusSelect = useRef(false)
  // Closed with Close from the keyboard, the form gives the focus back to Add a language.
  const back = useReturnFocus<HTMLDivElement>(adding)
  const close = (): void => {
    back.closing()
    setAdding(false)
  }
  // A translation started with the keyboard: Translate and Translate again are off while it runs, so the focus falls to the page.
  const landing = useRef<{ language: string; again: boolean } | null>(null)
  const live = useRef(true)
  const running = useRef<Job | null>(null)
  const group = useId()
  useEffect(
    () => () => {
      live.current = false
      // A translation still under way is dropped with the section, and the provider's request stopped.
      if (running.current) stopJob(running.current)
    },
    []
  )

  const offered = languagesToAdd(project)
  const chosenLanguage = offered.some((l) => l.code === language) ? language : (offered[0]?.code ?? '')
  const chosenVia = list.find((p) => p.id === via) ?? list[0] ?? null

  /** The rows take the focus on the next render (a request the project has no room for). */
  const focusRows = useRef(false)
  // Each request renders, so its focus moves at once also when the section already shows what it
  // asks for (React skips a render whose state is unchanged): left pending, it would take the
  // focus from wherever the user is typing at the next project change.
  const [, setAsked] = useState(0)

  // Translate captions with AI… and Add a caption language… open the form (§2.14), also when asked before the tab opened.
  useEffect(() => {
    const take = (): void => {
      const r = takeSectionRequest('language')
      if (!r) return
      setAsked((n) => n + 1)
      // As Add a language is off then, a project with no room for another language says so instead, and nothing is sent.
      const room = noRoom(store.state)
      if (room) {
        setError(null)
        setStatus(room)
        focusRows.current = true
        return
      }
      setAdding(true)
      // On this PC when it is offered and asked for; else (and for 'ai') the first provider.
      setVia(null)
      setError(null)
      focusSelect.current = true
    }
    take()
    return onSectionRequest(take)
  }, [])
  // Why a request opened nothing goes once it no longer holds (a translation removed, by hand or by Undo).
  const roomNow = noRoom(project)
  useEffect(() => {
    if ((status === fullReason() || status === allAdded()) && status !== roomNow) setStatus('')
  }, [status, roomNow])
  useEffect(() => {
    // The request is used up on the render that shows its form, once the providers are known: the
    // language select, or with no provider (nothing can be sent) the form's Add an AI provider.
    // Left waiting, it would pull the focus to the select when a provider is added later, out of
    // the Settings dialog still open over the editor.
    if (adding && focusSelect.current && providers !== null) {
      focusSelect.current = false
      ;(list.length === 0 && !OFFLINE_TRANSLATION ? addProvider.current : select.current)?.focus()
    }
    if (focusRows.current && rowsBox.current) {
      focusRows.current = false
      // The radio of the row drawn on the video: the list's place in the Tab order.
      const shown = Math.max(0, rows.findIndex((r) => r.shown))
      rowsBox.current.querySelector<HTMLElement>(`[id="${group}-track-${shown}-show-radio"]`)?.focus()
    }
  })

  const translate = async (code: string, provider: TextChoice, again: boolean): Promise<void> => {
    if (running.current) return
    // A new language when the project keeps the most: the answer could not be kept, so nothing is sent.
    if (!trackOf(store.state, code) && (store.state.captionTracks?.length ?? 0) >= MAX_TRACKS) {
      setError(t('captions.languages.failed', { reason: inSentence(fullReason()) }))
      return
    }
    const sent = captionsToTranslate(store.state, code)
    if (!sent.length) {
      setStatus(t('captions.languages.upToDate', { language: shownName(code) }))
      return
    }
    const request: AiTextRequest = { task: 'translate', segments: sent, targetLanguage: languageName(code) }
    // Translate again has no cost line to hold its click: the question before a paid run is asked here
    // (smart-tools.md §11.5), as Translate's line asks it. Cancel sends nothing.
    if (again && (!(await confirmRequest(provider, request)) || running.current || !live.current)) return
    const mine: Job = { language: code, count: sent.length, cancelled: false, id: `captions-translate-${++translateSeq}` }
    running.current = mine
    landing.current = lastInputWasKey() ? { language: code, again } : null
    setJob(mine)
    setError(null)
    setStatus('')
    let result: AiTextResult & { model?: string }
    try {
      result = await window.api.aiText(provider.id, request, mine.id)
    } catch (err) {
      if (!mine.cancelled && live.current) setError(t('captions.languages.failedError', { reason: ipcMessage(err).replace(/\.?$/, '.') }))
      return
    } finally {
      if (running.current === mine) running.current = null
      if (live.current) setJob((j) => (j === mine ? null : j))
    }
    if (mine.cancelled || !live.current) return
    // Who made it (smart-tools.md §10.6): the provider's kind, a service's host, or this PC with the model that ran.
    const maker = madeBy(provider, result.model)
    let used = false
    // One undo step; nothing changes when the answer cannot be used.
    store.update((p) => {
      const next =
        result.task === 'translate' ? withTranslation(p, { language: code, ...maker, createdAt: new Date().toISOString(), sent, answer: result.segments }) : null
      used = !!next
      return next ?? p
    })
    if (!used) {
      setError(t('captions.languages.failedTiming'))
      return
    }
    setAdding(false)
    // What the run cost (smart-tools.md §11.6), when the provider said.
    const cost = runCostText((result as { usage?: AiUsage }).usage, provider)
    const counted = { count: sent.length, n: fmt.count(sent.length), language: shownName(code) }
    const done = `${again ? t('captions.languages.translatedAgain', counted) : t('captions.languages.translated', counted)}${cost ? `. ${cost}` : ''}`
    setStatus(done)
    setWrittenHere(provider.kind === 'local' ? done : null)
  }

  const cancel = (): void => {
    const j = running.current
    if (!j) return
    stopJob(j)
    running.current = null
    setJob(null)
    setError(t('captions.languages.cancelled'))
  }

  const rows = trackRows(project)
  const full = (project.captionTracks?.length ?? 0) >= MAX_TRACKS
  const noProviders = providers !== null && list.length === 0
  const againWith = (code: string): TextChoice | null => {
    const track = trackOf(project, code)
    // The same provider kind, through the same service when it says one (smart-tools.md §10.6).
    return list.find((p) => p.kind === track?.by && p.host === track?.host) ?? list.find((p) => p.kind === track?.by) ?? list[0] ?? null
  }
  /** Track row `code`'s Translate again when it can take the focus, else its Show on the video radio. */
  const rowControl = (code: string): HTMLElement | null => {
    const name = `${group}-track-${rows.findIndex((r) => r.language === code)}`
    const again = rowsBox.current?.querySelector<HTMLButtonElement>(`[id="${name}-again"]`)
    return again && !again.disabled ? again : (rowsBox.current?.querySelector<HTMLElement>(`[id="${name}-show-radio"]`) ?? null)
  }
  // While it runs, a click or a key other than Tab (an editor shortcut, such as Right stepping a
  // frame) means the user has moved on: the focus then stays where it is when the translation ends,
  // so a later Right steps a frame instead of picking another radio. Enter on Cancel (or on the Stop
  // of AI on this PC beside it) still lands.
  useEffect(() => {
    if (!job) return
    const movedOn = (): void => void (landing.current = null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' || MODIFIER_KEYS.has(e.key) || (e.key === 'Enter' && (e.target === cancelButton.current || !!jobRow.current?.contains(e.target as Node)))) return
      movedOn()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', movedOn, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', movedOn, true)
    }
  }, [job])
  // When it ends (done, failed or cancelled) with the focus still on the page, the keyboard goes
  // back: to Translate while the form stays open, to Add a language once it closed (or to the new
  // row when the project's translations are full), to its row for Translate again. Focus moved
  // elsewhere, or a click or a shortcut since, is left alone.
  useEffect(() => {
    const to = landing.current
    if (!to || job) return
    landing.current = null
    const el = document.activeElement
    if (!lastInputWasKey() || (el && el !== document.body)) return
    const translateOn = translateButton.current && !translateButton.current.disabled ? translateButton.current : select.current
    const opener = back.opener.current && !back.opener.current.disabled ? back.opener.current : null
    ;(to.again ? rowControl(to.language) : adding ? translateOn : (opener ?? rowControl(to.language)))?.focus()
  })

  return (
    <div data-testid="caption-languages">
      <Section title={t('captions.languages.title')}>
        <div ref={rowsBox} role="radiogroup" aria-label={t('captions.languages.drawn')} className="caption-list">
          {rows.map((row, i) => {
            const code = row.language
            const provider = code ? againWith(code) : null
            const stale = row.changed + row.missing > 0
            // Each radio is named by its words and its row's language: "Show on the video, Bengali · translated with Gemini".
            const name = `${group}-track-${i}`
            // Translate again's own sentence: what it costs and where the captions go (§11.5).
            const againCost = code && provider && stale ? estimateFor(provider, { task: 'translate', segments: captionsToTranslate(project, code), targetLanguage: languageName(code) }, costs) : null
            const againSays = !code || !provider || !stale
              ? null
              : againCost
                ? costSentence(againCost, provider.place, t('captions.ai.what.yourCaptions'))
                : provider.kind === 'local'
                  ? t('captions.ai.cost.localSentence')
                  : t('captions.ai.cost.sendsSentence', { what: t('captions.ai.what.yourCaptions'), where: provider.place })
            const words = trackRowWords(row, project)
            return (
              <div key={code ?? ''} className="caption-row" data-track={code ?? ''}>
                <div className="caption-text">
                  <strong id={name}>{words.label}</strong>
                  {words.notes.map((n) => (
                    <span key={n} className="hint">
                      {' · '}
                      {n}
                    </span>
                  ))}
                </div>
                <div className="row start">
                  <label className="toggle">
                    <input
                      id={`${name}-show-radio`}
                      type="radio"
                      name={`${group}-shown`}
                      data-testid="track-show"
                      aria-labelledby={`${name}-show ${name}`}
                      checked={row.shown}
                      onChange={() => store.update((p) => withShownTrack(p, code))}
                      onKeyDown={(e) => {
                        // Left and Right move between the radios, as Up and Down do; the editor's window handler would step the playhead.
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation()
                      }}
                    />
                    <span id={`${name}-show`}>{t('captions.languages.show')}</span>
                  </label>
                  {code && (
                    <>
                      <button
                        id={`${name}-again`}
                        className="btn small"
                        data-testid="track-retranslate"
                        aria-label={t('captions.languages.againLabel', { language: shownName(code) })}
                        aria-describedby={againSays ? `${name}-again-cost` : undefined}
                        disabled={!stale || !provider || !!job}
                        title={!provider ? t('captions.languages.againNoProvider') : stale ? t('captions.languages.againStale') : t('captions.languages.againCurrent')}
                        onClick={() => provider && void translate(code, provider, true)}
                      >
                        {t('captions.languages.again')}
                      </button>
                      {againSays && (
                        <span id={`${name}-again-cost`} className="sr-only">
                          {againSays}
                        </span>
                      )}
                      <button
                        className="btn small ghost"
                        data-testid="track-remove"
                        aria-label={t('captions.languages.removeLabel', { language: shownName(code) })}
                        disabled={job?.language === code}
                        onClick={() => store.update((p) => withoutTrack(p, code))}
                      >
                        {t('common.action.remove')}
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
              ref={back.opener}
              className="btn small"
              data-testid="track-add"
              disabled={full || offered.length === 0}
              title={full ? fullReason() : undefined}
              onClick={() => {
                setAdding(true)
                setError(null)
                focusSelect.current = true
              }}
            >
              {t('captions.languages.add')}
            </button>
          </div>
        ) : noProviders && !OFFLINE_TRANSLATION ? (
          <div ref={back.form} className="captions-empty">
            <p>{t('captions.languages.noProvider')}</p>
            <div className="row start">
              <button ref={addProvider} className="btn small" data-testid="track-add-provider" onClick={openAiSettings}>
                {t('common.action.addAiProvider')}
              </button>
              <button className="btn small ghost" onClick={() => close()}>
                {t('common.action.close')}
              </button>
            </div>
          </div>
        ) : (
          <div ref={back.form} className="captions-suggestion">
            <label className="field">
              <span>{t('captions.languages.language')}</span>
              <select ref={select} className="captions-select" value={chosenLanguage} onChange={(e) => setLanguage(e.target.value)} disabled={!!job}>
                {offered.map((l) => (
                  <option key={l.code} value={l.code}>
                    {captionLanguageName(l.code, l.name)}
                  </option>
                ))}
              </select>
            </label>
            <div className="chips" role="group" aria-label={t('captions.languages.via')}>
              {list.map((p) => (
                <button key={p.id} className={`chip ${chosenVia?.id === p.id ? 'active' : ''}`} aria-pressed={chosenVia?.id === p.id} disabled={!!job} onClick={() => setVia(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            {chosenVia && <p className="hint">{sentHint(chosenVia, 'captionText')}</p>}
            <div className="row start">
              <button
                ref={translateButton}
                id={`${group}-translate`}
                className="btn small primary"
                data-testid="track-translate"
                aria-describedby={chosenVia ? `${group}-cost-translate` : undefined}
                disabled={!chosenLanguage || !chosenVia || !!job}
                onClick={() => chosenVia && void translate(chosenLanguage, chosenVia, false)}
              >
                {t('captions.languages.translate')}
              </button>
              <button className="btn small ghost" disabled={!!job} onClick={() => close()}>
                {t('common.action.close')}
              </button>
            </div>
            {/* What Translate sends, where, and what it costs (smart-tools.md §11.5), part P5's. */}
            <CostLine
              id={`${group}-cost`}
              choice={chosenVia}
              full
              actions={[
                {
                  key: 'translate',
                  label: t('captions.languages.translate'),
                  buttonId: `${group}-translate`,
                  request: chosenLanguage ? () => ({ task: 'translate', segments: captionsToTranslate(store.state, chosenLanguage), targetLanguage: languageName(chosenLanguage) }) : null
                }
              ]}
            />
          </div>
        )}

        {job && (
          <div ref={jobRow} className="row start">
            <span className="hint" role="status">
              {t('captions.languages.translating', { count: job.count, n: fmt.count(job.count), language: shownName(job.language) })}
            </span>
            <button ref={cancelButton} className="btn small ghost" onClick={cancel}>
              {t('common.action.cancel')}
            </button>
            <LocalProgress requestId={job.id} onStop={cancel} />
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
        <LocalWritten show={!!status && status === writtenHere} />
      </Section>
    </div>
  )
}
