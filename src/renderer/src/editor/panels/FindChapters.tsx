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

export const FIND_HINT = 'Splits the video where the screen changes and where you start something new, and names each part from what you say. Works offline, also for recordings without sound.'

const DENSITIES: readonly { value: FindChaptersPref['density']; label: string }[] = [
  { value: 'fewer', label: 'Fewer' },
  { value: 'normal', label: 'Normal' },
  { value: 'more', label: 'More' }
]
const SPLITS: readonly { key: keyof FindChaptersPref['use']; label: string }[] = [
  { key: 'screen', label: 'Screen changes' },
  { key: 'pauses', label: 'Pauses' },
  { key: 'words', label: 'What you say' }
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
        if (!ctrl.signal.aborted && live.current) onNotice(`Could not find chapters: ${(err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')}`)
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

  // The palette's Find chapters (smartRequests): taken once the options as last used, the AI choices
  // (AI on this PC's too, when the names come from it) and the cost settings are read, and while shown.
  // It presses the button, so with names from an AI the cost line asks its question first, as for a
  // click (§11.5); the cost line shows with the button in that render, listening before the press.
  const runButton = useRef<HTMLButtonElement>(null)
  const localRead = useLocalAi().status !== 'loading'
  const costRead = useCostDataRead()
  const ready = prefRead && list !== null && costRead && (pref.names !== LOCAL_TEXT_ID || localRead)
  useEffect(() => {
    if (!ready) return
    const press = (): void => {
      if (takeFindChaptersRequest()) runButton.current?.click()
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
        <button ref={runButton} className="btn" id={`${ids}-run`} data-testid="find-chapters" onClick={() => void run()} aria-disabled={busy || undefined} aria-describedby={namesChoice ? `${hintId} ${ids}-cost-names` : hintId}>
          Find chapters
        </button>
        {busy && (
          <>
            <span className="find-chapters-progress" role="status" aria-live="polite" data-testid="find-chapters-progress">
              {progress ?? FIND_WORDS.finding}
            </span>
            <button className="btn ghost" onClick={stop} {...stopFocus} data-testid="find-chapters-stop">
              Stop
            </button>
          </>
        )}
        {namesChoice?.kind === 'local' && <LocalProgress requestId={running} onStop={stop} returnFocus={`${ids}-run`} />}
      </div>
      <p className="hint" id={hintId}>
        {FIND_HINT}
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
            >
              Make captions
            </button>
            <button className="btn" onClick={() => void run({ withoutWords: true })}>
              Split without words
            </button>
          </div>
        </div>
      )}
      <details className="find-chapters-options">
        <summary>Options</summary>
        <fieldset className="find-chapters-field">
          <legend>How many</legend>
          <div className="find-chapters-choices">
            {DENSITIES.map((d) => (
              <label key={d.value}>
                <input type="radio" name={`${ids}-density`} value={d.value} checked={pref.density === d.value} onChange={() => setPref({ ...pref, density: d.value })} />
                {d.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="find-chapters-field">
          <legend>Split at</legend>
          <div className="find-chapters-choices">
            {SPLITS.map((s) => (
              <label key={s.key}>
                <input type="checkbox" checked={pref.use[s.key]} onChange={(e) => setPref({ ...pref, use: { ...pref.use, [s.key]: e.target.checked } })} />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="find-chapters-field">
          <legend>Names</legend>
          <div className="find-chapters-choices column">
            <label>
              <input type="radio" name={`${ids}-names`} checked={!namesChoice} onChange={() => setPref({ ...pref, names: 'offline' })} />
              From what you say (offline)
            </label>
            <label className="find-chapters-with">
              <input type="radio" name={`${ids}-names`} checked={!!namesChoice} disabled={!choices.length} onChange={() => choices[0] && setPref({ ...pref, names: choices[0].id })} />
              With
              <select aria-label="Name the chapters with" value={namesChoice?.id ?? ''} disabled={!choices.length} onChange={(e) => setPref({ ...pref, names: e.target.value })}>
                {!namesChoice && <option value="">{choices.length ? 'Choose…' : 'No AI provider'}</option>}
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {namesChoice && <CostLine id={`${ids}-cost`} choice={namesChoice} actions={[{ key: 'names', label: 'Names', buttonId: `${ids}-run`, request: estimate }]} />}
        </fieldset>
      </details>
    </div>
  )
}
