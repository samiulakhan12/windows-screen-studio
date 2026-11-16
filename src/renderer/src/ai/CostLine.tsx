/**
 * The cost line under a group of AI tools (docs/design/smart-tools.md §2.7, §11.5): what is sent and
 * where, once ("Sends about 8,200 words of captions to OpenAI"), then each action's cost ("Chapters
 * about US$0.02 · Title under US$0.01") or, on this PC, its time; an action alone has the full form
 * with the model and the date of the prices. A group has Details (the model, the date and each
 * action's token ranges).
 *
 * Each action's own short sentence has the id `${id}-${key}` ("About US$0.02; sends your captions to
 * OpenAI."), which its button (`buttonId`) names in aria-describedby; a button that names the line
 * itself (`id`, as Write all does) runs every action, so its cost is their sum.
 *
 * The confirm (§11.5): a click on one of those buttons whose cost passes the amount set in Settings
 * (or an unknown cost, once per model in a session; or over 10 minutes on this PC) is held, the
 * question asked (costConfirm.ts), and the click made again only after Run. Nothing else changes in
 * the tool: it never learns there was a question.
 */
import { useEffect, useRef, useState } from 'react'
import type { AiProviderInfo, AiTextRequest, TextChoice } from '../../../shared/api/ai'
import { AI_PROVIDER_KINDS } from '../../../shared/api/ai'
import { costLineText, costSentence, needsConfirm, priceDate, sumEstimates, type CostEstimate } from '../../../shared/ai/cost'
import { fmt } from '../../../shared/i18n/fmt'
import { t } from '../../../shared/i18n/t'
import { confirmCost, wasAsked } from './costConfirm'
import { estimateFor, estimateNotes, estimateSound, useCostData, type CostData } from './useCost'
import './cost.css'

/**
 * One action of the line. `notes`: what Draft script sends (it is no text task, so its request is
 * null): the line estimates the notes as it does a request.
 */
type Action = { key: string; label: string; buttonId: string; request: AiTextRequest | (() => AiTextRequest) | null; notes?: string | (() => string) }

/** What a request sends, as the line names it (§11.5): "captions", "chapter names and what is said in them"… */
function whatOf(request: AiTextRequest | null, sound: boolean, notes: boolean): { what: string; your: string } {
  if (sound) return { what: t('captions.ai.what.sound'), your: t('captions.ai.what.sound') }
  if (notes) return { what: t('captions.ai.what.notes'), your: t('captions.ai.what.yourNotes') }
  if (request?.task === 'names') {
    switch (request.names?.kind) {
      case 'chapter':
        return { what: t('captions.ai.what.chapterNames'), your: t('captions.ai.what.eachChapter') }
      case 'clip':
        return { what: t('captions.ai.what.clips'), your: t('captions.ai.what.clips') }
      default:
        return { what: t('captions.ai.what.steps'), your: t('captions.ai.what.steps') }
    }
  }
  return { what: t('captions.ai.what.captions'), your: t('captions.ai.what.yourCaptions') }
}

/** The transcription model of provider `id` (the line's choice carries the text model). */
function useTranscriptionModel(id: string | null): { kind: AiProviderInfo['kind']; model: string } | null {
  const [found, setFound] = useState<{ kind: AiProviderInfo['kind']; model: string } | null>(null)
  useEffect(() => {
    if (!id) return
    let live = true
    const list = (window as { api?: { listAiProviders?: () => Promise<AiProviderInfo[]> } }).api?.listAiProviders
    Promise.resolve()
      .then(() => list?.())
      .then((providers) => {
        const p = Array.isArray(providers) ? providers.find((x) => x.id === id) : undefined
        if (live && p) setFound({ kind: p.kind, model: p.transcriptionModel ?? AI_PROVIDER_KINDS[p.kind].defaultTranscriptionModel ?? '' })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [id])
  return found
}

interface Row {
  key: string
  label: string
  buttonId: string
  estimate: CostEstimate | null
}

/** Each action's estimate (null without a request); transcription by the minute. */
function rowsOf(actions: readonly Action[], choice: TextChoice | null, d: CostData, sound: { kind: AiProviderInfo['kind']; model: string } | null, seconds: number | undefined): { rows: Row[]; first: AiTextRequest | null } {
  let first: AiTextRequest | null = null
  const rows = actions.map((a) => {
    let estimate: CostEstimate | null = null
    if (choice && a.request === null && a.notes !== undefined) {
      estimate = estimateNotes(choice, typeof a.notes === 'function' ? a.notes() : a.notes, d)
    } else if (choice && a.request === null && seconds !== undefined) {
      estimate = sound && choice.kind !== 'local' ? estimateSound(sound.kind, sound.model, seconds, d) : null
    } else if (choice && a.request) {
      const request = typeof a.request === 'function' ? a.request() : a.request
      first ??= request
      estimate = estimateFor(choice, request, d)
    }
    return { key: a.key, label: a.label, buttonId: a.buttonId, estimate }
  })
  return { rows, first }
}

export function CostLine(props: {
  id: string
  choice: TextChoice | null
  actions: readonly Action[]
  full?: boolean
  transcribeSeconds?: number
}): JSX.Element | null {
  const { id, choice, actions, full = false, transcribeSeconds } = props
  const d = useCostData()
  const sound = useTranscriptionModel(transcribeSeconds !== undefined && choice ? choice.id : null)
  const [open, setOpen] = useState(false)
  const { rows, first } = rowsOf(actions, choice, d, sound, transcribeSeconds)
  const known = rows.filter((r): r is Row & { estimate: CostEstimate } => !!r.estimate)
  const sum = sumEstimates(known.map((r) => r.estimate))
  const what = whatOf(first, transcribeSeconds !== undefined, actions.some((a) => a.notes !== undefined))
  const where = choice?.place ?? ''

  // The latest of everything a click is checked against.
  // A transcription is asked about by its own model (the choice carries the text model).
  const asked = choice && transcribeSeconds !== undefined && sound ? { ...choice, model: sound.model } : choice
  const latest = useRef({ choice: asked, rows, sum, ask: d.ask })
  latest.current = { choice: asked, rows, sum, ask: d.ask }
  /** A click let through after Run: not asked about again. */
  const passed = useRef<Element | null>(null)
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    const onClick = (e: Event): void => {
      const target = e.target as Element | null
      const button = target && typeof target.closest === 'function' ? target.closest('button') : null
      // A button that waits (aria-disabled while its tool runs) does nothing: nothing to ask about.
      if (!button || button.getAttribute('aria-disabled') === 'true') return
      if (passed.current === button) {
        passed.current = null
        return
      }
      const { choice: c, rows: r, sum: all, ask } = latest.current
      if (!c) return
      const described = (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      const row = r.find((x) => button.id === x.buttonId || described.includes(`${id}-${x.key}`))
      const estimate = row ? row.estimate : described.includes(id) ? all : null
      if (!estimate || !needsConfirm(estimate, ask, wasAsked(c))) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void confirmCost(estimate, c).then(
        (run) => {
          if (!run || !button.isConnected) return
          passed.current = button
          ;(button as HTMLButtonElement).click()
        },
        () => undefined
      )
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [id])

  if (!choice) return null
  const model = choice.kind === 'local' ? '' : transcribeSeconds !== undefined ? (sound?.model ?? choice.model) : choice.model
  const line = known.length
    ? costLineText(
        known.map((r) => ({ label: r.label, estimate: r.estimate })),
        where,
        what.what,
        model,
        full || known.length === 1
      )
    : choice.kind === 'local'
      ? t('captions.ai.cost.local')
      : t('captions.ai.cost.sends', { what: what.what, where })
  const group = !full && known.length > 1
  const date = known.find((r) => r.estimate.price?.updated)?.estimate.price?.updated
  return (
    <div className="cost-line-box" data-testid="cost-line">
      <p className="cost-line">
        <span id={id}>{line}</span>
        {group && (
          <button type="button" className="link" aria-expanded={open} aria-controls={`${id}-details`} onClick={() => setOpen((v) => !v)}>
            {t('captions.ai.cost.details')}
          </button>
        )}
      </p>
      {group && open && (
        <ul className="cost-details" id={`${id}-details`}>
          <li>{t('captions.ai.cost.model', { model: model || t('captions.ai.cost.modelLocal') })}</li>
          {date && <li>{t('captions.ai.cost.pricesOf', { date: priceDate(date) })}</li>}
          {known.map((r) => (
            <li key={r.key}>
              {t('captions.ai.cost.tokens', {
                label: r.label,
                inLow: fmt.count(r.estimate.inputTokens[0], { grouping: true }),
                inHigh: fmt.count(r.estimate.inputTokens[1], { grouping: true }),
                outLow: fmt.count(r.estimate.outputTokens[0], { grouping: true }),
                outHigh: fmt.count(r.estimate.outputTokens[1], { grouping: true })
              })}
            </li>
          ))}
        </ul>
      )}
      {rows.map((r) => (
        <span key={r.key} id={`${id}-${r.key}`} className="sr-only">
          {r.estimate ? costSentence(r.estimate, where, what.your) : choice.kind === 'local' ? t('captions.ai.cost.localSentence') : t('captions.ai.cost.sendsSentence', { what: what.your, where })}
        </span>
      ))}
    </div>
  )
}
