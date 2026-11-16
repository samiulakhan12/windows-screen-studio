/**
 * Text › Chapters › Find chapters (docs/design/smart-tools.md §2.3): the button with its hint, the
 * Options (how many, what to split at, where names come from with the cost line), the progress
 * and Stop while it runs, the honest notice after, the focus on the first weak name, and "Make
 * captions first" when a recording with speech has no captions. The palette's Find chapters runs
 * it here.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { LOCAL_TEXT_ID, type AiTextRequest } from '../../../../shared/api/ai'
import { chapterLimits } from '../../../../shared/chapters/plan'
import { namesRequestForChapters } from '../../../../shared/chapters/names'
import { videoDuration, planOf } from '../../../../shared/engine/freeze'
import { DEFAULT_FIND_CHAPTERS, sanitizeSmartPref, type FindChaptersPref } from '../../../../shared/smart/smartPrefs'
import type { CursorTrack, Project } from '../../../../shared/types'
import { CostLine } from '../../ai/CostLine'
import { LocalProgress } from '../../ai/LocalProgress'
import { useLocalAi } from '../../ai/localAiState'
import { useTextChoiceList } from '../../ai/textChoices'
import { useCostDataRead } from '../../ai/useCost'
import { FIND_WORDS, runFindChapters, type FindChapterOptions } from '../chaptersRun'
import { useEditor } from '../context'
import { useGroup } from '../groupContext'
import { onFindChaptersRequest, takeFindChaptersRequest } from '../smartRequests'
import { useStopFocus } from '../returnFocus'
import './findChapters.css'
import { t } from '../../../../shared/i18n/t'

/** What Find chapters does, under its button (a function: no text is made when the module loads). */
export const findHint = (): string => t('smart.chapters.hint')

const densities = (): readonly { value: FindChaptersPref['density']; label: string }[] => [
  { value: 'fewer', label: t('smart.chapters.density.fewer') },
  { value: 'normal', label: t('smart.chapters.density.normal') },
  { value: 'more', label: t('smart.chapters.density.more') }
]
const splits = (): readonly { key: keyof FindChaptersPref['use']; label: string }[] => [
  { key: 'screen', label: t('smart.chapters.split.screen') },
  { key: 'pauses', label: t('smart.chapters.split.pauses') },
  { key: 'words', label: t('smart.chapters.split.words') }
]

let runs = 0

/** The id of a chapter's name field in the chapter list (TextPanel's chapterNameId). */
const nameFieldId = (id: string): string => `chapter-name-${id}`

/** Moves the focus to the first weak name once the chapter list shows it. */
function focusName(id: string): void {
  if (typeof document === 'undefined') return
  const go = (tries: number): void => {
    const el = document.getElementById(nameFieldId(id))
    if (el) el.focus()
    else if (tries > 0) setTimeout(() => go(tries - 1), 50)
  }
  setTimeout(() => go(10), 0)
}

export function FindChapters({ project, cursor, onNotice }: { project: Project; cursor: CursorTrack; onNotice(message: string): void }): JSX.Element {
  const { store } = useEditor()
  const group = useGroup()
  const ids = useId()
  // Null while the providers are first read.
  const list = useTextChoiceList('names')
  const choices = list ?? []
  const [pref, setPrefState] = useState<FindChaptersPref>(() => ({ ...DEFAULT_FIND_CHAPTERS, use: { ...DEFAULT_FIND_CHAPTERS.use } }))
  const [prefRead, setPrefRead] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [needsCaptions, setNeedsCaptions] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const live = useRef(true)
  const prefRef = useRef(pref)
  prefRef.current = pref
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  // The options as last used.
  useEffect(() => {
    let current = true
    void window.api
      .getPref('findChapters')
      .then((v) => {
        const saved = sanitizeSmartPref('findChapters', v) as FindChaptersPref | null
        if (current && saved) setPrefState(saved)
      })
      .catch(() => undefined)
      .finally(() => current && setPrefRead(true))
    return () => {
      current = false
    }
  }, [])
  useEffect(
    () => () => {
      live.current = false
      controller.current?.abort()
    },
    []
  )
  const setPref = (next: FindChaptersPref): void => {
    setPrefState(next)
    void window.api.setPref('findChapters', next).catch(() => undefined)
  }

  /** The names choice, when it is still offered (a removed provider names offline). */
  const namesChoice = pref.names === 'offline' ? null : (choices.find((c) => c.id === pref.names) ?? null)
  const namesSource = namesChoice ? namesChoice.id : 'offline'
  const namesSourceRef = useRef(namesSource)
  namesSourceRef.current = namesSource

  const run = useCallback(
    async (opts: { withoutWords?: boolean } = {}): Promise<void> => {
      if (controller.current) return
      const p = prefRef.current
      const options: FindChapterOptions = {
        density: p.density,
        use: { ...p.use, ...(opts.withoutWords ? { words: false } : {}) },
        names: opts.withoutWords ? 'offline' : namesSourceRef.current
      }
      const requestId = `find-chapters-${++runs}`
      const ctrl = new AbortController()
      controller.current = ctrl
      setRunning(requestId)
      setNeedsCaptions(false)
      setProgress(null)
      try {
        const out = await runFindChapters({ store, recorded: cursorRef.current, options, signal: ctrl.signal, requestId, onProgress: (text) => live.current && setProgress(text) })
        if (ctrl.signal.aborted || !live.current) return
        if ('needsCaptions' in out) setNeedsCaptions(true)
        else {
          onNotice(out.notice)
          if (out.weak) focusName(out.weak)
        }
      } catch (err) {
        if (!ctrl.signal.aborted && live.current) onNotice(t('smart.chapters.failed', { reason: (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') }))
      } finally {
        if (controller.current === ctrl) controller.current = null
        if (live.current) {
          setRunning(null)
          setProgress(null)
        }
      }
    },
    [store, onNotice]
  )
  const stop = (): void => controller.current?.abort()

  // The palette's Find chapters (smartRequests): taken as the panel mounts or is asked, and kept by this
  // panel alone, so it goes when the panel closes first. Run once the options as last used, the AI choices
  // (AI on this PC's too, when the names come from it) and the cost settings are read. It presses the
  // button, so with names from an AI the cost line asks its question first, as for a click (§11.5); the
  // cost line shows with the button in that render, listening before the press.
  const runButton = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)
  const localRead = useLocalAi().status !== 'loading'
  const costRead = useCostDataRead()
  const ready = prefRead && list !== null && costRead && (pref.names !== LOCAL_TEXT_ID || localRead)
  useEffect(() => {
    const press = (): void => {
      if (takeFindChaptersRequest()) asked.current = true
      if (!ready || !asked.current) return
      asked.current = false
      runButton.current?.click()
    }
    press()
    return onFindChaptersRequest(press)
  }, [ready])

  // What the cost line estimates: the narration in as many parts as Find chapters makes at most.
  const estimate = useMemo((): (() => AiTextRequest) | null => {
    if (!namesChoice) return null
    return () => {
      const L = videoDuration(project.clips, planOf(project)) || project.duration
      const n = chapterLimits(L, pref.density).n
      const starts = Array.from({ length: n }, (_, i) => (project.duration * i) / n)
      return { task: 'names', names: namesRequestForChapters(project, starts), segments: [] }
    }
  }, [namesChoice, project, pref.density])

  const busy = running !== null
  // Stop pressed with the keyboard, or the run ending while it is on Stop: the focus goes back to Find chapters.
  const stopFocus = useStopFocus(busy, `${ids}-run`)
  const hintId = `${ids}-hint`
  return (
    <div className="find-chapters" data-testid="find-chapters-section">
      <div className="find-chapters-run">
        {/* With names from an AI, the button also reads what the run sends and costs (§11.5): the cost line's sentence.
            While it runs it waits with aria-disabled: a disabled button would drop the keyboard focus to the page. */}
        <button ref={runButton} className="btn" id={`${ids}-run`} data-testid="find-chapters" onClick={() => void run()} aria-disabled={busy || undefined} aria-describedby={namesChoice ? `${hintId} ${ids}-cost-names` : hintId}>{t('smart.chapters.find')}</button>
        {busy && (
          <>
            <span className="find-chapters-progress" role="status" aria-live="polite" data-testid="find-chapters-progress">
              {progress ?? FIND_WORDS.finding}
            </span>
            <button className="btn ghost" onClick={stop} {...stopFocus} data-testid="find-chapters-stop">{t('common.action.stop')}</button>
          </>
        )}
        {namesChoice?.kind === 'local' && <LocalProgress requestId={running} onStop={stop} returnFocus={`${ids}-run`} />}
      </div>
      <p className="hint" id={hintId}>
        {findHint()}
      </p>
      {needsCaptions && (
        <div className="find-chapters-captions" role="group" aria-labelledby={`${ids}-captions`} data-testid="find-chapters-needs-captions">
          <p id={`${ids}-captions`}>{FIND_WORDS.needsCaptions}</p>
          <div className="row start">
            <button
              className="btn primary"
              onClick={() => {
                setNeedsCaptions(false)
                group.command('generateCaptions')
              }}
            >{t('common.action.makeCaptions')}</button>
            <button className="btn" onClick={() => void run({ withoutWords: true })}>{t('smart.chapters.withoutWords')}</button>
          </div>
        </div>
      )}
      <details className="find-chapters-options">
        <summary>{t('smart.chapters.options')}</summary>
        <fieldset className="find-chapters-field">
          <legend>{t('smart.chapters.howMany')}</legend>
          <div className="find-chapters-choices">
            {densities().map((d) => (
              <label key={d.value}>
                <input type="radio" name={`${ids}-density`} value={d.value} checked={pref.density === d.value} onChange={() => setPref({ ...pref, density: d.value })} />
                {d.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="find-chapters-field">
          <legend>{t('smart.chapters.splitAt')}</legend>
          <div className="find-chapters-choices">
            {splits().map((s) => (
              <label key={s.key}>
                <input type="checkbox" checked={pref.use[s.key]} onChange={(e) => setPref({ ...pref, use: { ...pref.use, [s.key]: e.target.checked } })} />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="find-chapters-field">
          <legend>{t('smart.chapters.names')}</legend>
          <div className="find-chapters-choices column">
            <label>
              <input type="radio" name={`${ids}-names`} checked={!namesChoice} onChange={() => setPref({ ...pref, names: 'offline' })} />{t('smart.chapters.namesOffline')}</label>
            <label className="find-chapters-with">
              <input type="radio" name={`${ids}-names`} checked={!!namesChoice} disabled={!choices.length} onChange={() => choices[0] && setPref({ ...pref, names: choices[0].id })} />{t('smart.chapters.namesWith')}<select aria-label={t('smart.chapters.namesWithLabel')} value={namesChoice?.id ?? ''} disabled={!choices.length} onChange={(e) => setPref({ ...pref, names: e.target.value })}>
                {!namesChoice && <option value="">{choices.length ? t('smart.chapters.choose') : t('smart.chapters.noAiProvider')}</option>}
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {namesChoice && <CostLine id={`${ids}-cost`} choice={namesChoice} actions={[{ key: 'names', label: t('smart.cost.namesAction'), buttonId: `${ids}-run`, request: estimate }]} />}
        </fieldset>
      </details>
    </div>
  )
}
