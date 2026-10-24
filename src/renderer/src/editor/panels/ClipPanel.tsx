import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activitySources, type AudioSource } from '../../../../shared/audio/settings'
import { sourceActivity, type AudioAnalysis } from '../../../../shared/audio/soundtrack'
import { setRangeSpeed, timelineGaps, type Gap } from '../../../../shared/editor/clips'
import type { EditStore } from '../../../../shared/editor/editStore'
import { undoHint, withShortcut } from '../../../../shared/editor/shortcuts'
import {
  applySmartSpeed,
  DEFAULT_MIN_IDLE,
  inputGaps,
  MIN_IDLE_CHOICES,
  planSilences,
  planSmartSpeed,
  SILENCE_LENGTH,
  SILENCE_PADDING,
  SMART_SPEED_ACTIONS,
  STILL_DETECT_MIN,
  type SmartSpeedAction,
  type SmartSpeedPart,
  type TimeRange
} from '../../../../shared/editor/smartSpeed'
import { formatTime } from '../../../../shared/engine/project'
import { outputDuration, SPEED_PRESETS } from '../../../../shared/engine/timeline'
import { stripIpcPrefix } from '../../../../shared/recording/errors'
import type { Project } from '../../../../shared/types'
import { loadAudioAnalysis } from '../audioAnalysis'
import { useEditor } from '../context'
import { Chips, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import { FirstShortcut } from '../ShortcutKeys'
import './clipPanel.css'
import './silences.css'

const GAP_TITLE: Record<Gap['kind'], string> = { 'trim-start': 'Trimmed start', cut: 'Cut', 'trim-end': 'Trimmed end' }

/* ---------- Clip (cuts, trims, speed) ---------- */

export function ClipPanel(props: InspectorProps): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const { project, selection } = props
  const { clips } = project
  const length = outputDuration(clips)
  const clipIndex = selection?.kind === 'clip' ? clips.findIndex((c) => c.id === selection.id) : -1
  const clip = clipIndex >= 0 ? clips[clipIndex] : null
  const edited = clips.length > 1 || clips[0].start > 0 || clips[0].end < project.duration || clips[0].speed !== 1

  const setSpeed = (speed: number): void => {
    if (!clip) return
    store.update((p) => ({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? { ...c, speed } : c)) }))
  }

  return (
    <>
      <p className="hint">
        Video length <strong>{formatTime(length)}</strong> of {formatTime(project.duration)} recorded.
      </p>
      {clip ? (
        <Section title={`Clip ${clipIndex + 1} of ${clips.length}`}>
          <p className="hint">
            {formatTime(clip.start)} – {formatTime(clip.end)} of the recording, plays for {((clip.end - clip.start) / clip.speed).toFixed(1)} s
          </p>
          <span className="field-label">
            <EditorIcon name="speed" size={14} /> Speed
          </span>
          <Chips label="Clip speed" value={clip.speed} onChange={setSpeed} options={SPEED_PRESETS.map((s) => ({ value: s, label: `${s}×` }))} />
          <button
            className="btn ghost danger"
            disabled={clips.length <= 1}
            onClick={() => props.onDeleteClip(clip.id)}
            title={clips.length <= 1 ? 'The last clip cannot be removed' : withShortcut('Cut this clip out of the video', keymap.deleteSelection)}
          >
            <EditorIcon name="scissors" size={16} /> Delete clip
          </button>
        </Section>
      ) : selection?.kind === 'gap' ? (
        <Section title={GAP_TITLE[timelineGaps(clips, project.duration).find((g) => Math.abs(g.start - selection.start) < 1e-6)?.kind ?? 'cut']}>
          <p className="hint">
            {formatTime(selection.start)} – {formatTime(selection.end)} ({(selection.end - selection.start).toFixed(1)} s) is not in the video.
          </p>
          <button className="btn" onClick={() => props.onRestore(selection.start, selection.end)}>
            <EditorIcon name="restore" size={16} /> Restore
          </button>
        </Section>
      ) : selection?.kind === 'range' ? (
        <Section title="Selected range">
          <p className="hint">
            {formatTime(selection.start)} – {formatTime(selection.end)} ({(selection.end - selection.start).toFixed(1)} s)
          </p>
          <button className="btn" onClick={() => props.onCutRange(selection.start, selection.end)} title={withShortcut('Cut this range out of the video', keymap.deleteSelection)}>
            <EditorIcon name="scissors" size={16} /> Cut range
          </button>
          <span className="field-label">
            <EditorIcon name="speed" size={14} /> Speed up or slow down this range
          </span>
          <Chips
            label="Range speed"
            value={null}
            onChange={(s) => {
              // A range that changes nothing keeps its selection and adds no undo step.
              const current = store.state.clips
              const next = setRangeSpeed(current, selection.start, selection.end, s)
              if (next === current) {
                props.onNotice(`Nothing to change: this range is cut or already plays at ${s}×`)
                return
              }
              store.update((p) => ({ ...p, clips: next }))
              props.onSelect(null)
            }}
            options={SPEED_PRESETS.map((s) => ({ value: s, label: `${s}×` }))}
          />
        </Section>
      ) : (
        <Section title="Edit">
          <button className="btn" onClick={props.onSplit} title={withShortcut('Split the clip at the playhead', keymap.split)}>
            <EditorIcon name="split" size={16} /> Split at playhead
          </button>
          <p className="hint">
            {keymap.split.length ? (
              <>
                Press <FirstShortcut accelerators={keymap.split} fallback="" /> to split at the playhead,
              </>
            ) : (
              'Split at the playhead,'
            )}{' '}
            select a clip and{' '}
            {keymap.deleteSelection.length ? (
              <>
                press <FirstShortcut accelerators={keymap.deleteSelection} fallback="" />
              </>
            ) : (
              'use Delete clip'
            )}{' '}
            to cut it, or <kbd>Shift</kbd>+drag on the clip track to select a range. Drag the yellow handles to trim.
          </p>
        </Section>
      )}
      <SmartSpeed {...props} />
      {edited && (
        <button
          className="btn ghost"
          onClick={() => {
            store.update((p) => ({ ...p, clips: [{ id: p.clips[0].id, start: 0, end: p.duration, speed: 1 }] }))
            props.onSelect(null)
          }}
        >
          <EditorIcon name="restore" size={16} /> Restore the whole recording
        </button>
      )}
    </>
  )
}

/* ---------- Smart speed ---------- */

/**
 * Still-picture analysis of the open recording and the measured levels of its sound, kept for
 * the editor session (keyed by its store) so switching tabs never runs them again; also which
 * smart speed request was handled. A failed analysis is not kept: Find tries again.
 */
interface Analysis {
  still: TimeRange[] | null
  pending: Promise<TimeRange[]> | null
  levels: AudioAnalysis
  request: number
}
const analyses = new WeakMap<EditStore<Project>, Analysis>()

/** What smart speed looks for: idle parts (still, silent, no input), or pauses in the sound. */
type SmartMode = 'idle' | 'silence'

/** The last choices, kept while the app runs. */
let lastChoice: {
  mode: SmartMode
  minIdle: number
  action: SmartSpeedAction
  minSilence: number
  padding: number
  silenceAction: SmartSpeedAction
} = {
  mode: 'idle',
  minIdle: DEFAULT_MIN_IDLE,
  action: 4,
  minSilence: SILENCE_LENGTH.default,
  padding: SILENCE_PADDING.default,
  silenceAction: 'cut'
}

const MODE_OPTIONS: { value: SmartMode; label: string; title: string }[] = [
  { value: 'idle', label: 'Idle parts', title: 'Still picture, nothing heard, mouse and keyboard at rest' },
  { value: 'silence', label: 'Silences', title: 'Pauses where nothing is heard' }
]

const ACTION_LABEL: Record<string, string> = { 2: '2×', 4: '4×', 8: '8×', cut: 'Cut' }
const ACTION_TITLE: Record<string, string> = {
  2: 'Play idle parts twice as fast',
  4: 'Play idle parts four times as fast',
  8: 'Play idle parts eight times as fast',
  cut: 'Remove idle parts from the video'
}
const SILENCE_ACTION_TITLE: Record<string, string> = {
  2: 'Play pauses twice as fast',
  4: 'Play pauses four times as fast',
  8: 'Play pauses eight times as fast',
  cut: 'Remove pauses from the video'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const seconds = (s: number): string => (s < 60 ? `${s.toFixed(1)} s` : formatTime(s))
const partKey = (r: TimeRange): string => `${r.start.toFixed(3)}:${r.end.toFixed(3)}`

function SmartSpeed(props: InspectorProps): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const { project, cursor, onSelect, onNotice } = props
  const analysis = useMemo<Analysis>(() => {
    let a = analyses.get(store)
    if (!a) analyses.set(store, (a = { still: null, pending: null, levels: {}, request: 0 }))
    return a
  }, [store])
  const [mode, setMode] = useState<SmartMode>(lastChoice.mode)
  const [minIdle, setMinIdle] = useState(lastChoice.minIdle)
  const [action, setAction] = useState<SmartSpeedAction>(lastChoice.action)
  const [minSilence, setMinSilence] = useState(lastChoice.minSilence)
  const [padding, setPadding] = useState(lastChoice.padding)
  const [silenceAction, setSilenceAction] = useState<SmartSpeedAction>(lastChoice.silenceAction)
  const [still, setStill] = useState<TimeRange[] | null>(analysis.still)
  const [levels, setLevels] = useState<AudioAnalysis>(analysis.levels)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** Measuring the sound for the Silences mode, and whether some of it could not be read. */
  const [listening, setListening] = useState(false)
  const [soundFailed, setSoundFailed] = useState(false)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set())
  const boxRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const projectId = project.id
  // Sources whose sound counts (a muted one does not): someone talking over a still screen is not idle.
  const sourcesKey = activitySources(project).join(',')
  const sources = useMemo(() => (sourcesKey ? (sourcesKey.split(',') as AudioSource[]) : []), [sourcesKey])
  const measure = useCallback(async (): Promise<void> => {
    // Never rejects: a source that cannot be measured is left out, and then only the picture and the input decide.
    if (!sources.every((s) => analysis.levels[s])) analysis.levels = { ...analysis.levels, ...(await loadAudioAnalysis(projectId, sources)) }
    // Also catches up with levels measured while this panel was closed.
    if (alive.current) setLevels(analysis.levels)
  }, [analysis, projectId, sources])

  const find = useCallback(
    async (): Promise<void> => {
      setBusy(true)
      setFailure(null)
      analysis.pending ??= window.api.detectStill(projectId, STILL_DETECT_MIN).finally(() => {
        analysis.pending = null
      })
      try {
        const [ranges] = await Promise.all([analysis.pending, measure()])
        analysis.still = ranges
        if (!alive.current) return
        setStill(ranges)
        setSkipped(new Set())
      } catch (err) {
        // Shown next to the button, which tries again.
        if (alive.current) setFailure(stripIpcPrefix(err instanceof Error ? err.message : String(err)).replace(/[.\s]+$/, '') || 'unknown error')
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [analysis, projectId, measure]
  )

  /** Measures the sound for the Silences mode (cheap, and kept for the editor session like the idle analysis). */
  const findSilences = useCallback(async (): Promise<void> => {
    setListening(true)
    setSoundFailed(false)
    await measure()
    if (!alive.current) return
    setListening(false)
    setSkipped(new Set())
    setSoundFailed(!sources.every((s) => analysis.levels[s]))
  }, [analysis, measure, sources])

  const choose = (patch: Partial<typeof lastChoice>): void => {
    lastChoice = { ...lastChoice, ...patch }
    if (patch.mode !== undefined) {
      setMode(patch.mode)
      setSkipped(new Set())
    }
    if (patch.minIdle !== undefined) setMinIdle(patch.minIdle)
    if (patch.action !== undefined) setAction(patch.action)
    if (patch.minSilence !== undefined) setMinSilence(patch.minSilence)
    if (patch.padding !== undefined) setPadding(patch.padding)
    if (patch.silenceAction !== undefined) setSilenceAction(patch.silenceAction)
  }

  // An analysis started before switching tabs: wait for it here.
  useEffect(() => {
    if (analysis.pending && !analysis.still) void find()
  }, [analysis, find])

  // Silences only need the sound measured, which takes moments: done as soon as the mode is shown
  // (and again for a source turned on later). A failure waits for Try again.
  const measured = sources.every((s) => levels[s])
  useEffect(() => {
    if (mode === 'silence' && !measured && !listening && !soundFailed) void findSilences()
  }, [mode, measured, listening, soundFailed, findSilences])

  // The smart speed command: show this section and look for idle parts if not done yet.
  const request = props.smartSpeedRequest ?? 0
  useEffect(() => {
    if (!request || analysis.request === request) return
    analysis.request = request
    lastChoice = { ...lastChoice, mode: 'idle' }
    setMode('idle')
    boxRef.current?.scrollIntoView({ block: 'nearest' })
    if (!analysis.still && !analysis.pending) void find()
  }, [request, analysis, find])

  // Input stretches depend on the recording only: worked out once, after the first analysis,
  // so edits (a trim drag) only redo the cheap part below.
  const analysed = still !== null
  const inactive = useMemo(() => (analysed ? inputGaps(cursor, project.duration) : null), [analysed, cursor, project.duration])
  // A source turned on again after the analysis is measured too.
  useEffect(() => {
    if (analysed) void measure()
  }, [analysed, measure])
  // Where the recording is heard (source seconds): none without sound, null while unknown.
  const { hasAudio, audioStems, audio } = project
  const heardNeeded = analysed || mode === 'silence'
  const sound = useMemo(() => (heardNeeded ? sourceActivity({ hasAudio, audioStems, audio }, levels) : null), [heardNeeded, hasAudio, audioStems, audio, levels])
  const idlePlan = useMemo(
    () => (mode === 'idle' && still ? planSmartSpeed({ still, inactive, sound, clips: project.clips, duration: project.duration }, minIdle, action) : null),
    [mode, still, inactive, sound, project.clips, project.duration, minIdle, action]
  )
  // Silences need sound that was measured: null until then (or without sound at all).
  const heard = mode === 'silence' && sources.length > 0 ? sound : null
  const silencePlan = useMemo(
    () => (heard ? planSilences(heard, project.clips, { minLength: minSilence, padding }, silenceAction) : null),
    [heard, project.clips, minSilence, padding, silenceAction]
  )

  const currentAction = mode === 'idle' ? action : silenceAction
  const chosenIdle = idlePlan ? idlePlan.parts.filter((p) => !skipped.has(partKey(p))) : []
  const chosenSilences = silencePlan ? silencePlan.parts.filter((p) => !skipped.has(partKey(p))) : []
  const chosen: SmartSpeedPart[] = mode === 'idle' ? chosenIdle : chosenSilences
  const saved = chosen.reduce((s, p) => s + p.saved, 0)

  const apply = (): void => {
    if (!chosen.length) return
    // A silence across a cut is acted on at both sides of it.
    const ranges = mode === 'idle' ? chosenIdle : chosenSilences.flatMap((p) => p.pieces)
    const before = outputDuration(store.state.clips)
    store.update((p) => ({ ...p, clips: applySmartSpeed(p.clips, ranges, currentAction) }))
    const shorter = before - outputDuration(store.state.clips)
    onSelect(null)
    const noun = mode === 'idle' ? 'idle part' : 'silence'
    const what = currentAction === 'cut' ? `Cut ${plural(chosen.length, noun)}` : `Sped up ${plural(chosen.length, noun)} ${currentAction}×`
    onNotice(`${what}: the video is ${seconds(shorter)} shorter${undoHint(keymap)}`)
  }

  const toggle = (key: string, on: boolean): void => {
    const next = new Set(skipped)
    if (on) next.delete(key)
    else next.add(key)
    setSkipped(next)
  }

  return (
    <div className="smart-speed" ref={boxRef} data-testid="smart-speed">
      <Section title="Smart speed">
        <div className="smart-mode">
          <Chips label="Smart speed mode" value={mode} onChange={(v) => choose({ mode: v })} options={MODE_OPTIONS} />
        </div>
        {mode === 'idle' ? (
          <>
            <p className="hint">Speeds up or cuts the parts where nothing happens: the picture stays still, nothing is heard, and the mouse and keyboard rest.</p>
            {!cursor.valid && <p className="hint">This recording has no mouse or keyboard data, so only the picture decides.</p>}
            <span className="field-label">Idle for at least</span>
            <Chips label="Minimum idle length" value={minIdle} onChange={(v) => choose({ minIdle: v })} options={MIN_IDLE_CHOICES.map((s) => ({ value: s, label: `${s} s` }))} />
            <span className="field-label">
              <EditorIcon name="speed" size={14} /> Then
            </span>
            <Chips
              label="Smart speed action"
              value={action}
              onChange={(v) => choose({ action: v })}
              options={SMART_SPEED_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a], title: ACTION_TITLE[a] }))}
            />
            {!idlePlan ? (
              <>
                {failure && (
                  <p className="callout" role="alert" data-testid="smart-speed-error">
                    <EditorIcon name="alert" size={16} />
                    <span>The recording could not be analysed: {failure}.</span>
                  </p>
                )}
                <button className="btn" onClick={() => void find()} disabled={busy}>
                  {busy ? (
                    <>
                      <span className="smart-spinner" aria-hidden="true" /> Looking for idle parts…
                    </>
                  ) : (
                    <>
                      <EditorIcon name="sparkle" size={16} /> {failure ? 'Try again' : 'Find idle parts'}
                    </>
                  )}
                </button>
              </>
            ) : (
              <PartList
                parts={idlePlan.parts}
                skipped={skipped}
                onToggle={toggle}
                summary={
                  idlePlan.parts.length === 0
                    ? `No idle parts of ${minIdle} s or more${action === 'cut' ? '' : ' to speed up'}.`
                    : null
                }
                noun="idle part"
                listLabel="Idle parts"
                chosen={chosen.length}
                saved={saved}
                apply={
                  <button className="btn primary" disabled={!chosen.length} onClick={apply}>
                    <EditorIcon name="speed" size={16} /> {action === 'cut' ? `Cut ${plural(chosen.length, 'part')}` : `Speed up ${plural(chosen.length, 'part')} ${action}×`}
                  </button>
                }
                onSelect={onSelect}
              />
            )}
          </>
        ) : (
          <>
            <p className="hint">Cuts or speeds up the pauses where nothing is heard, keeping a little of the silence next to the sound so no word is clipped.</p>
            {!hasAudio ? (
              <p className="callout silence-callout" data-testid="silence-unavailable">
                <EditorIcon name="mute" size={16} />
                <span>
                  This recording has no sound, so it has no pauses to remove.{' '}
                  <button className="link" onClick={() => choose({ mode: 'idle' })}>
                    Find idle parts
                  </button>{' '}
                  instead: the moments where the picture and the mouse rest.
                </span>
              </p>
            ) : sources.length === 0 ? (
              <p className="callout silence-callout" data-testid="silence-unavailable">
                <EditorIcon name="mute" size={16} />
                <span>The recording&rsquo;s sound is muted, so nothing can be told apart from silence. Turn the sound on in the Audio tab to find its pauses.</span>
              </p>
            ) : (
              <>
                <Slider
                  label="Silent for at least"
                  value={minSilence}
                  min={SILENCE_LENGTH.min}
                  max={SILENCE_LENGTH.max}
                  step={SILENCE_LENGTH.step}
                  format={(v) => `${v.toFixed(1)} s`}
                  onChange={(v) => choose({ minSilence: v })}
                />
                <Slider
                  label="Keep next to the sound"
                  value={padding}
                  min={SILENCE_PADDING.min}
                  max={SILENCE_PADDING.max}
                  step={SILENCE_PADDING.step}
                  format={(v) => `${v.toFixed(2)} s`}
                  onChange={(v) => choose({ padding: v })}
                />
                <span className="field-label">
                  <EditorIcon name="speed" size={14} /> Then
                </span>
                <Chips
                  label="Silence action"
                  value={silenceAction}
                  onChange={(v) => choose({ silenceAction: v })}
                  options={SMART_SPEED_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a], title: SILENCE_ACTION_TITLE[a] }))}
                />
                {!silencePlan ? (
                  <>
                    {soundFailed && !listening && (
                      <p className="callout" role="alert" data-testid="silence-error">
                        <EditorIcon name="alert" size={16} />
                        <span>The sound of the recording could not be measured.</span>
                      </p>
                    )}
                    <button className="btn" onClick={() => void findSilences()} disabled={listening}>
                      {listening ? (
                        <>
                          <span className="smart-spinner" aria-hidden="true" /> Listening for pauses…
                        </>
                      ) : (
                        <>
                          <EditorIcon name="sparkle" size={16} /> {soundFailed ? 'Try again' : 'Find silences'}
                        </>
                      )}
                    </button>
                  </>
                ) : heard && heard.length === 0 ? (
                  <p className="smart-summary" role="status" data-testid="silence-none">
                    Nothing is heard in this recording, so there is no sound to keep and nothing is removed.
                  </p>
                ) : (
                  <PartList
                    parts={silencePlan.parts}
                    skipped={skipped}
                    onToggle={toggle}
                    summary={
                      silencePlan.parts.length === 0
                        ? `No pauses of ${minSilence.toFixed(1)} s or more${silenceAction === 'cut' ? '' : ' to speed up'}.`
                        : null
                    }
                    noun="silence"
                    listLabel="Silences"
                    chosen={chosen.length}
                    saved={saved}
                    apply={
                      <button className="btn primary" disabled={!chosen.length} onClick={apply}>
                        <EditorIcon name={silenceAction === 'cut' ? 'scissors' : 'speed'} size={16} />{' '}
                        {silenceAction === 'cut' ? `Cut ${plural(chosen.length, 'silence')}` : `Speed up ${plural(chosen.length, 'silence')} ${silenceAction}×`}
                      </button>
                    }
                    onSelect={onSelect}
                  />
                )}
              </>
            )}
          </>
        )}
      </Section>
    </div>
  )
}

/** The parts found, each with a checkbox, its range (selects it on the timeline) and what it saves. */
function PartList({
  parts,
  skipped,
  onToggle,
  summary,
  noun,
  listLabel,
  chosen,
  saved,
  apply,
  onSelect
}: {
  /** `length`: how long the part plays now, when that is not its source span (a silence across a cut). */
  parts: (SmartSpeedPart & { length?: number })[]
  skipped: ReadonlySet<string>
  onToggle: (key: string, on: boolean) => void
  /** Shown instead of the count when nothing was found. */
  summary: string | null
  noun: string
  listLabel: string
  chosen: number
  saved: number
  apply: JSX.Element
  onSelect: InspectorProps['onSelect']
}): JSX.Element {
  const { player } = useEditor()
  return (
    <>
      <p className="smart-summary" role="status">
        {summary ?? (
          <>
            <strong>{plural(chosen, noun)}</strong>
            {chosen < parts.length && ` of ${parts.length}`} · saves <strong>{seconds(saved)}</strong>
          </>
        )}
      </p>
      {parts.length > 0 && (
        <ul className="smart-list" aria-label={listLabel}>
          {parts.map((p) => {
            const key = partKey(p)
            const on = !skipped.has(key)
            const range = `${formatTime(p.start)} – ${formatTime(p.end)}`
            const length = p.length ?? p.end - p.start
            return (
              <li key={key} className={on ? '' : 'skipped'}>
                <input type="checkbox" checked={on} aria-label={`Include ${range}`} onChange={(e) => onToggle(key, e.target.checked)} />
                <button
                  className="smart-range"
                  title="Select this part on the timeline"
                  onClick={() => {
                    onSelect({ kind: 'range', start: p.start, end: p.end })
                    player.seek(p.start)
                  }}
                >
                  {range}
                </button>
                <span className="smart-saving">
                  {length.toFixed(1)} s<span className="muted"> · −{seconds(p.saved)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {parts.length > 0 && apply}
    </>
  )
}
