/**
 * The Short clips panel (docs/design/smart-tools.md §2.4, §8): the best 15 to 90 second moments,
 * scored offline, each with its reasons and Play; the ones ticked made into copies of the project
 * (vertical by default, captions on), named from what was said or by an AI; the disk space they
 * take; and every copy made from this video. Docked in Review mode's place; the preview, transport
 * and timeline stay usable beside it. This video never changes.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AiTextRequest } from '../../../shared/api/ai'
import type { CopyCost, DuplicateProgress, SceneScan } from '../../../shared/api/projects'
import type { AudioLevels } from '../../../shared/audio/loudness'
import type { AudioSource } from '../../../shared/audio/settings'
import { speechLevelSource } from '../../../shared/audio/speech'
import { clipCopy, type ClipShape } from '../../../shared/clips/clipCopy'
import { CLIP_RULES, type Moment, type MomentLength } from '../../../shared/clips/moments'
import { outputTimeAt } from '../../../shared/editor/clips'
import { canCopyAs } from '../../../shared/editor/duplicate'
import { planOf, videoDuration, videoTimeAt } from '../../../shared/engine/freeze'
import { effectiveTrack } from '../../../shared/engine/inputTrack'
import { clockTime } from '../../../shared/search/moment'
import { DEFAULT_SHORT_CLIPS, sanitizeSmartPref, type ShortClipsPref } from '../../../shared/smart/smartPrefs'
import type { CursorTrack, Project, ProjectSummary } from '../../../shared/types'
import { CostLine } from '../ai/CostLine'
import { LocalProgress, LocalWritten } from '../ai/LocalProgress'
import { useTextChoices } from '../ai/textChoices'
import { loadAudioAnalysis } from '../editor/audioAnalysis'
import { useEditor } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { useStopFocus } from '../editor/returnFocus'
import { playStretch } from '../review/playStretch'
import '../review/review.css'
import './clips.css'
import { ClipCopyError, CLIPS_WORDS, clipsFor, copySpace, ipcMessage, madeFrom, makeClipCopies, namesRequestForMoments, readScreen, settledFlush, textMeasure, withAiTitles } from './clipsRun'

const LENGTHS: readonly { value: MomentLength; label: string }[] = [
  { value: 'any', label: 'Any (15–90 s)' },
  { value: 'short', label: 'Under 60 s' },
  { value: 'long', label: '60–90 s' }
]
export const SHAPES: readonly { value: ClipShape; label: string }[] = [
  { value: 'vertical', label: 'Vertical 9:16' },
  { value: 'square', label: 'Square 1:1' },
  { value: 'same', label: 'Same as this video' }
]
/** Focus on is read this long after the last key. */
const FOCUS_WAIT_MS = 300

let runs = 0

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
/** A moment's key: its range, kept across new lists. */
const keyOf = (m: Pick<Moment, 'start' | 'end'>): string => `${m.start.toFixed(3)}-${m.end.toFixed(3)}`

/** "0:42 to 1:27 · 45 s" in the video's time. */
export function momentRange(project: Pick<Project, 'clips' | 'freezes'>, m: Pick<Moment, 'start' | 'end' | 'seconds'>): string {
  const plan = planOf(project)
  return `${clockTime(videoTimeAt(project.clips, plan, m.start))} to ${clockTime(videoTimeAt(project.clips, plan, m.end))} · ${Math.round(m.seconds)} s`
}

/** The reasons a row lists: without the length, which its time line says. */
const rowReasons = (m: Moment): string => m.reasons.filter((r) => !/^\d+ s$/.test(r)).join(' · ')

/**
 * The shapes Duplicate can make of this recording (canCopyAs: a tall one is not made vertical) and
 * the one to use: the remembered one when it can be made, else the same shape as this video.
 */
export function useClipShapes(project: Project, vw: number, vh: number, wanted: ClipShape): { ok: Record<ClipShape, { ok: true } | { ok: false; reason: string }>; shape: ClipShape } {
  const ok = useMemo(() => ({ vertical: canCopyAs(project, 'vertical', vw, vh), square: canCopyAs(project, 'square', vw, vh), same: { ok: true as const } }), [project, vw, vh])
  return { ok, shape: ok[wanted].ok ? wanted : 'same' }
}

/** The Short clips preference (length, shape, names, captions), read once and saved on change. */
export function useShortClipsPref(): [ShortClipsPref, (next: ShortClipsPref) => void] {
  const [pref, setPrefState] = useState<ShortClipsPref>(() => ({ ...DEFAULT_SHORT_CLIPS }))
  useEffect(() => {
    let current = true
    void window.api
      .getPref('shortClips')
      .then((v) => {
        const saved = sanitizeSmartPref('shortClips', v) as ShortClipsPref | null
        if (current && saved) setPrefState(saved)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [])
  const setPref = useCallback((next: ShortClipsPref): void => {
    setPrefState(next)
    void window.api.setPref('shortClips', next).catch(() => undefined)
  }, [])
  return [pref, setPref]
}

/** Where the focus was when a panel opened: it goes back there when the panel closes under it. */
function useFocusBack(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return
    const opener = document.activeElement
    return () => {
      const now = document.activeElement
      if (opener instanceof HTMLElement && opener.isConnected && (!now || now === document.body)) opener.focus()
    }
  }, [])
}

export function ShortClipsPanel(props: { project: Project; cursor: CursorTrack; vw: number; vh: number; onClose(): void; onOpen(id: string): void }): JSX.Element {
  const { project, cursor, vw, vh, onClose, onOpen } = props
  const { store, player } = useEditor()
  const group = useGroup()
  const ids = useId()
  const choices = useTextChoices('names')
  useFocusBack()
  const L = project.clips?.length ? videoDuration(project.clips, planOf(project)) : 0
  const tooShort = L < CLIP_RULES.minVideo - 1e-6
  const hasCaptions = !!project.transcript?.segments.some((s) => s.text.trim())
  const [pref, setPref] = useShortClipsPref()
  const shapes = useClipShapes(project, vw, vh, pref.shape)

  // The first control takes the focus (Close when there is nothing to choose).
  const firstRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ;(tooShort ? closeRef.current : firstRef.current)?.focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [focus, setFocus] = useState('')
  const [focusUsed, setFocusUsed] = useState('')
  useEffect(() => {
    if (focus === focusUsed) return
    const timer = setTimeout(() => setFocusUsed(focus), FOCUS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [focus, focusUsed])
  const [activityOnly, setActivityOnly] = useState(false)

  // What the moments are found from: the screen (read once per recording) and, without captions, the sound's levels.
  const [scan, setScan] = useState<SceneScan | null>(null)
  const [levels, setLevels] = useState<Partial<Record<AudioSource, AudioLevels>> | null>(null)
  const [reading, setReading] = useState<{ fraction: number | null } | null>(null)
  const [screenFailed, setScreenFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const readCtrl = useRef<AbortController | null>(null)
  const live = useRef(true)
  useEffect(() => {
    if (tooShort) return
    const ctrl = new AbortController()
    readCtrl.current = ctrl
    void (async () => {
      const source = speechLevelSource(project)
      if (!hasCaptions && source) {
        const all = await loadAudioAnalysis(project.id, [source]).catch(() => null)
        if (!live.current) return
        const one = all?.[source]
        if (one) setLevels({ [source]: one })
      }
      setReading({ fraction: null })
      try {
        const found = await readScreen(project, ctrl.signal, (fraction) => live.current && setReading({ fraction }))
        if (!live.current) return
        setScan(found)
        setScreenFailed(!found)
      } catch {
        // Stopped: the moments come from what is said and done.
      }
      if (!live.current) return
      setReading(null)
      setReady(true)
    })()
    return () => ctrl.abort()
    // Read once for the panel's recording.
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const track = useMemo(() => effectiveTrack(cursor, project), [cursor, project.inputEdits, project.capture, project.width, project.height]) // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(
    () => (ready ? clipsFor(project, { track, scan, levels, focus: focusUsed, length: pref.length, activityOnly }) : null),
    [ready, project, track, scan, levels, focusUsed, pref.length, activityOnly]
  )
  const moments = useMemo<Moment[]>(() => (result && 'moments' in result ? result.moments : []), [result])

  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set())
  const [made, setMade] = useState<ReadonlyMap<string, { id: string; name: string }>>(() => new Map())
  const tickedMoments = useMemo(() => moments.filter((m) => ticked.has(keyOf(m))), [moments, ticked])
  const toggle = (m: Moment): void => {
    const next = new Set(ticked)
    if (next.has(keyOf(m))) next.delete(keyOf(m))
    else next.add(keyOf(m))
    setTicked(next)
  }

  // The disk space the copies take, and every copy made from this video.
  const [cost, setCost] = useState<CopyCost | null>(null)
  const [copies, setCopies] = useState<ProjectSummary[]>([])
  const refreshCopies = useCallback((): void => {
    void window.api
      .listProjects()
      .then((list) => live.current && setCopies(madeFrom(list, project.id)))
      .catch(() => undefined)
  }, [project.id])
  useEffect(() => {
    void window.api
      .copyCost(project.id)
      .then((c) => live.current && setCost(c))
      .catch(() => undefined)
    refreshCopies()
  }, [project.id, refreshCopies])

  // Play: the preview plays the moment's range and stops at its end, on a second press, or on Esc.
  const [playing, setPlaying] = useState<{ key: string; from: number; until: number; at: number } | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const stopPlaying = useCallback((): void => {
    stopRef.current?.()
    stopRef.current = null
    setPlaying(null)
  }, [])
  const play = (m: Moment): void => {
    const key = keyOf(m)
    if (playing?.key === key) return stopPlaying()
    stopPlaying()
    const clips = store.state.clips
    const from = outputTimeAt(clips, m.start)
    const until = outputTimeAt(clips, m.end)
    stopRef.current = playStretch(player, () => store.state.clips, { from: m.start, until })
    setPlaying({ key, from, until, at: from })
  }
  const playingKey = playing?.key ?? null
  // Esc stops the moment playing wherever the focus is (a click on Play leaves it on the page),
  // before anything else takes the key; a dialog over the editor keeps its own Esc.
  useEffect(() => {
    if (!playingKey) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (typeof document !== 'undefined' && document.querySelector?.('[aria-modal="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      stopPlaying()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [playingKey, stopPlaying])
  useEffect(() => {
    if (!playingKey) return
    let frame = 0
    const tick = (): void => {
      // The stretch ended (its end, Space, a click on the timeline): the row stops saying so.
      if (!player.moving) {
        stopRef.current = null
        setPlaying(null)
        return
      }
      const at = outputTimeAt(store.state.clips, player.time)
      setPlaying((p) => (p && p.key === playingKey ? { ...p, at } : p))
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [playingKey, player, store])

  // Names: from what is said, or by an AI (the `names` task, §8.4).
  const namesChoice = pref.names === 'offline' ? null : (choices.find((c) => c.id === pref.names) ?? null)

  // Making the copies.
  const [making, setMaking] = useState<{ i: number; n: number; p: DuplicateProgress | null } | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  /** The status of copies named on this PC (§2.5): while it shows, so does the line saying to check the names. */
  const [writtenHere, setWrittenHere] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      // Closing the panel stops what it does: the copy being made is removed, the finished ones stay.
      live.current = false
      controller.current?.abort()
      readCtrl.current?.abort()
      stopRef.current?.()
    },
    []
  )
  const busy = making !== null || naming !== null
  const space = cost ? copySpace(cost, tickedMoments.length) : null

  const make = async (): Promise<void> => {
    if (controller.current || tickedMoments.length === 0 || space?.blocked) return
    stopPlaying()
    const list = tickedMoments
    const ctrl = new AbortController()
    controller.current = ctrl
    setError(null)
    setStatus(null)
    const done = new Map(made)
    const record = (got: readonly { id: string; name: string }[]): void => {
      got.forEach((m, k) => done.set(keyOf(list[k]), m))
      if (live.current) setMade(new Map(done))
    }
    try {
      let named = list
      let namedHere = false
      if (namesChoice) {
        const request = namesRequestForMoments(store.state, list)
        if (request.items.length) {
          const requestId = `short-clips-${++runs}`
          setNaming(requestId)
          const cancel = (): void => void window.api.cancelAiText(requestId).catch(() => undefined)
          ctrl.signal.addEventListener('abort', cancel, { once: true })
          try {
            setStatus(CLIPS_WORDS.naming(namesChoice.place))
            const answer = await window.api.aiText(namesChoice.id, { task: 'names', names: request, segments: [], requestId }, requestId)
            if (ctrl.signal.aborted) {
              if (live.current) setStatus(null)
              return
            }
            if (answer.task === 'names') {
              named = withAiTitles(list, answer.names)
              namedHere = namesChoice.kind === 'local'
            }
          } finally {
            ctrl.signal.removeEventListener('abort', cancel)
            if (live.current) setNaming(null)
          }
        }
      }
      const measure = textMeasure()
      // The copies are of the project with the edit of work still holding it (Review's Remove all) made now, as Duplicate's are.
      store.finish()
      const built = named.map((m) => clipCopy(store.state, m, { shape: shapes.shape, captions: pref.captions, measure }))
      if (live.current) {
        setStatus(null)
        setMaking({ i: 0, n: built.length, p: null })
      }
      const out = await makeClipCopies(built, {
        sourceId: project.id,
        flush: settledFlush(store),
        signal: ctrl.signal,
        onProgress: (i, n, p) => live.current && setMaking({ i, n, p })
      })
      record(out.made)
      const name = project.name.trim() || 'Untitled recording'
      const said = out.stopped ? `Stopped: made ${plural(out.made.length, 'copy', 'copies')}.` : `Made ${plural(out.made.length, 'copy', 'copies')}. Your original “${name}” is unchanged.`
      if (live.current) {
        setStatus(said)
        setWrittenHere(namedHere && out.made.length > 0 ? said : null)
      }
    } catch (err) {
      if (err instanceof ClipCopyError) record(err.made)
      if (live.current && !ctrl.signal.aborted) {
        setStatus(null)
        setError(err instanceof ClipCopyError ? err.message : `Could not make the clips: ${ipcMessage(err)}`)
      }
    } finally {
      if (controller.current === ctrl) controller.current = null
      if (live.current) {
        setMaking(null)
        setNaming(null)
      }
      refreshCopies()
    }
  }
  const stop = (): void => controller.current?.abort()
  // Stop pressed with the keyboard, or the copies done while it is on Stop: the focus goes back to Make.
  const stopFocus = useStopFocus(busy, `${ids}-make`)

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    e.stopPropagation()
    if (playing) stopPlaying()
    else onClose()
  }

  const makeId = `${ids}-make`
  // "No speech was found" only when the recording has none: Use activity only was chosen on one that has.
  const silent = !activityOnly && moments.length > 0 && moments[0].silent
  const needsCaptions = !!result && 'needsCaptions' in result
  const reason = result && 'reason' in result ? result.reason : null
  const estimate = useMemo((): (() => AiTextRequest) | null => {
    if (!namesChoice) return null
    return () => ({ task: 'names', names: namesRequestForMoments(project, tickedMoments.length ? tickedMoments : moments), segments: [] })
  }, [namesChoice, project, tickedMoments, moments])
  const n = tickedMoments.length
  const makeLabel = n === 0 ? 'Make copies' : `Make ${plural(n, 'copy', 'copies')}`
  const makeCaptions = (): void => {
    onClose()
    group.command('generateCaptions')
  }

  return (
    <aside className="review-panel clips-panel" role="region" aria-label="Short clips" data-testid="clips-panel" onKeyDown={onKeyDown}>
      <div className="review-head">
        <h2>Short clips</h2>
        <button ref={closeRef} type="button" className="btn ghost" onClick={onClose} data-testid="clips-close">
          Close
        </button>
      </div>
      {tooShort ? (
        <p className="clips-intro" data-testid="clips-too-short">
          {CLIPS_WORDS.tooShort}
        </p>
      ) : (
        <>
          <p className="clips-intro" data-testid="clips-intro">
            {CLIPS_WORDS.intro}
            {silent ? ` ${CLIPS_WORDS.silent}` : ''}
          </p>
          <div className="clips-field">
            <label className="clips-label" htmlFor={`${ids}-focus`}>
              Focus on (optional)
            </label>
            <input
              ref={firstRef}
              id={`${ids}-focus`}
              type="text"
              placeholder="billing, export"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              aria-describedby={`${ids}-focus-hint`}
              data-testid="clips-focus"
            />
            <span className="hint" id={`${ids}-focus-hint`}>
              Moments that mention these words rank higher.
            </span>
          </div>
          <fieldset className="clips-field">
            <legend>Length</legend>
            <div className="clips-choices">
              {LENGTHS.map((l) => (
                <label key={l.value}>
                  <input type="radio" name={`${ids}-length`} value={l.value} checked={pref.length === l.value} onChange={() => setPref({ ...pref, length: l.value })} />
                  {l.label}
                </label>
              ))}
            </div>
          </fieldset>
          <ShapeField name={`${ids}-shape`} shapes={shapes} onPick={(shape) => setPref({ ...pref, shape })} />
          <div className="clips-field">
            {hasCaptions ? (
              <label className="clips-choices">
                <input type="checkbox" checked={pref.captions} onChange={(e) => setPref({ ...pref, captions: e.target.checked })} data-testid="clips-captions" />
                Captions
              </label>
            ) : (
              <p className="hint">
                No captions yet:{' '}
                <button type="button" className="link" onClick={makeCaptions}>
                  Make captions
                </button>
              </p>
            )}
          </div>

          {reading && (
            <div className="clips-make">
              <span className="clips-status" role="status" aria-live="polite" data-testid="clips-reading">
                {CLIPS_WORDS.looking}
                {reading.fraction !== null ? ` ${Math.round(reading.fraction * 100)}%` : ''}
              </span>
              <button type="button" className="btn ghost small" onClick={() => readCtrl.current?.abort()}>
                Stop
              </button>
            </div>
          )}
          {screenFailed && ready && <p className="hint">{CLIPS_WORDS.noScreen}</p>}

          {needsCaptions && (
            <div className="clips-note" role="group" aria-labelledby={`${ids}-captions-first`} data-testid="clips-needs-captions">
              <p id={`${ids}-captions-first`}>{CLIPS_WORDS.needsCaptions}</p>
              <div className="row">
                <button type="button" className="btn primary" onClick={makeCaptions}>
                  Make captions
                </button>
                <button type="button" className="btn" onClick={() => setActivityOnly(true)}>
                  Use activity only
                </button>
              </div>
            </div>
          )}
          {reason === 'nothing' && <p className="hint">{CLIPS_WORDS.nothing}</p>}

          {moments.length > 0 && (
            <ul className="clips-list" aria-label="Moments" data-testid="clips-moments">
              {moments.map((m, i) => {
                const key = keyOf(m)
                const n1 = i + 1
                const done = made.get(key)
                const isPlaying = playing?.key === key
                return (
                  <li key={key} className={ticked.has(key) ? 'clips-row ticked' : 'clips-row'} data-testid="clips-row">
                    <input
                      className="clips-pick"
                      type="checkbox"
                      aria-label={`Make clip ${n1}`}
                      aria-describedby={`${ids}-m${i}-title ${ids}-m${i}-time${rowReasons(m) ? ` ${ids}-m${i}-why` : ''}`}
                      checked={ticked.has(key)}
                      disabled={busy}
                      onChange={() => toggle(m)}
                    />
                    <span className="clips-title" id={`${ids}-m${i}-title`}>
                      {done ? done.name.replace(/ \(clip\)$/, '') : m.title}
                    </span>
                    <span className="clips-time" id={`${ids}-m${i}-time`}>
                      {momentRange(project, m)}
                    </span>
                    {rowReasons(m) && (
                      <span className="clips-why" id={`${ids}-m${i}-why`}>
                        {rowReasons(m)}
                      </span>
                    )}
                    {m.first && <q className="clips-first">{m.first}</q>}
                    {isPlaying && (
                      <span className="clips-playing" data-testid="clips-playing">
                        Playing · {clockTime(Math.max(0, playing.at - playing.from))} of {clockTime(playing.until - playing.from)}
                      </span>
                    )}
                    <span className="clips-actions">
                      <button type="button" className="btn small" aria-pressed={isPlaying} aria-label={`Play clip ${n1}`} onClick={() => play(m)}>
                        {isPlaying ? 'Stop' : 'Play'}
                      </button>
                      {done && (
                        <>
                          <span className="clips-made">Made</span>
                          <button type="button" className="btn small" aria-label={`Open clip ${n1}`} onClick={() => onOpen(done.id)}>
                            Open
                          </button>
                        </>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {moments.length > 0 && (
            <fieldset className="clips-field">
              <legend>Names</legend>
              <div className="clips-choices">
                <label>
                  <input type="radio" name={`${ids}-names`} checked={!namesChoice} disabled={busy} onChange={() => setPref({ ...pref, names: 'offline' })} />
                  From what you say
                </label>
                <label>
                  <input type="radio" name={`${ids}-names`} checked={!!namesChoice} disabled={busy || !choices.length} onChange={() => choices[0] && setPref({ ...pref, names: choices[0].id })} />
                  With
                  <select aria-label="Name the clips with" value={namesChoice?.id ?? ''} disabled={busy || !choices.length} onChange={(e) => setPref({ ...pref, names: e.target.value })}>
                    {!namesChoice && <option value="">{choices.length ? 'Choose…' : 'No AI provider'}</option>}
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {namesChoice && <CostLine id={`${ids}-cost`} choice={namesChoice} actions={[{ key: 'names', label: 'Names', buttonId: makeId, request: estimate }]} />}
            </fieldset>
          )}

          {moments.length > 0 && (
            <div className="clips-foot">
              <div className="clips-make">
                {/* With names from an AI, Make also reads what it sends and costs (§11.5): the cost line's sentence; when the
                    copies would not fit, the space line that says so (§14).
                    While the copies are made it waits with aria-disabled: a disabled button would drop the keyboard focus to the page. */}
                <button
                  type="button"
                  className="btn primary"
                  id={makeId}
                  data-testid="clips-make"
                  disabled={n === 0 || !!space?.blocked}
                  aria-disabled={busy || undefined}
                  aria-describedby={[space?.blocked ? `${ids}-space` : '', namesChoice ? `${ids}-cost-names` : ''].filter(Boolean).join(' ') || undefined}
                  onClick={() => void make()}
                >
                  {makeLabel}
                </button>
                {busy && (
                  <button type="button" className="btn ghost" onClick={stop} {...stopFocus} data-testid="clips-stop">
                    Stop
                  </button>
                )}
                {/* The progress of AI on this PC naming the clips (it shows nothing for a service). */}
                <LocalProgress requestId={naming} onStop={stop} returnFocus={makeId} />
              </div>
              {space && (
                <p id={`${ids}-space`} className={space.blocked ? 'clips-space blocked' : 'clips-space'} data-testid="clips-space">
                  {space.text}
                </p>
              )}
              {making && (
                <>
                  <p className="clips-status" role="status" aria-live="polite" data-testid="clips-making">
                    {CLIPS_WORDS.making(Math.min(making.n, making.i + 1), making.n)}
                  </p>
                  <div className="clips-progress" role="progressbar" aria-label="Copies made" aria-valuemin={0} aria-valuemax={making.n} aria-valuenow={making.i}>
                    <div style={{ width: `${(100 * (making.i + (making.p && making.p.total > 0 ? Math.min(1, making.p.done / making.p.total) : 0))) / Math.max(1, making.n)}%` }} />
                  </div>
                </>
              )}
              {!making && status && (
                <p className="clips-status" role="status" aria-live="polite" data-testid="clips-status">
                  {status}
                </p>
              )}
              <LocalWritten show={!making && !!status && status === writtenHere} />
              {error && (
                <p className="clips-error" role="alert" data-testid="clips-error">
                  {error}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {copies.length > 0 && (
        <section className="clips-from" aria-labelledby={`${ids}-from`} data-testid="clips-made-from">
          <h3 id={`${ids}-from`}>Made from this video</h3>
          <ul>
            {copies.map((c) => (
              <li key={c.id}>
                <span>{c.name}</span>
                <button type="button" className="btn small" aria-label={`Open ${c.name}`} onClick={() => onOpen(c.id)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}

/** The Shape radio group: a shape Duplicate cannot make of this recording is disabled with its reason. */
export function ShapeField(props: { name: string; shapes: ReturnType<typeof useClipShapes>; onPick(shape: ClipShape): void }): JSX.Element {
  const { name, shapes, onPick } = props
  return (
    <fieldset className="clips-field">
      <legend>Shape</legend>
      <div className="clips-choices">
        {SHAPES.map((s) => {
          const can = shapes.ok[s.value]
          return (
            <label key={s.value}>
              <input type="radio" name={name} value={s.value} checked={shapes.shape === s.value} disabled={!can.ok} onChange={() => onPick(s.value)} />
              {s.label}
              {!can.ok && <span className="clips-why-not">({can.reason})</span>}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
