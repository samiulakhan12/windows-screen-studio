import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activitySources, type AudioSource } from '../../../../shared/audio/settings'
import { sourceActivity, type AudioAnalysis } from '../../../../shared/audio/soundtrack'
import { soundDetector } from '../../../../shared/audio/voice'
import { detectorStatus, IDLE_VOICE_HINT, SILENCES_VOICE_HINT } from '../../../../shared/speech/speechCopy'
import { setRangeSpeed, timelineGaps, type Gap } from '../../../../shared/editor/clips'
import type { EditStore } from '../../../../shared/editor/editStore'
import { pathSummary } from '../../../../shared/editor/inputEdits'
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
import { cropOf } from '../../../../shared/engine/crop'
import { freezeKeepRanges, planOf, videoDuration } from '../../../../shared/engine/freeze'
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
import { FreezeSection } from './FreezeSection'
import { recordAutoCuts } from '../../../../shared/review/autoCuts'
import { fmt } from '../../../../shared/i18n/fmt'
import './clipPanel.css'
import './silences.css'
import { CutsSection } from './CutsSection'
import { CutStyleSection } from './CutStyleSection'
import { t, uiLanguage } from '../../../../shared/i18n/t'
import { T } from '../../i18n/T'
import { Rich } from './Rich'

const GAP_TITLE = (): Record<Gap['kind'], string> => ({ 'trim-start': t('style.clipPanel.gap.trimStart'), cut: t('style.clipPanel.gap.cut'), 'trim-end': t('style.clipPanel.gap.trimEnd') })

/* ---------- Clip (cuts, trims, speed) ---------- */

export function ClipPanel(props: InspectorProps): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const { project, selection } = props
  const { clips } = project
  // The exported video's length: the edit and its pause freezes.
  const length = videoDuration(clips, planOf(project))
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
        {/* Each time is its own text, as in today's markup, so English lays the line out as before. */}
        <Rich k="style.clipPanel.videoLength" values={{ length: fmt.clock(length), recorded: <>{fmt.clock(project.duration)}</> }} />
      </p>
      {/* Smooth cuts (docs/design/editing-polish.md §2.1): every cut's style. */}
      {selection?.kind !== 'gap' && <CutsSection project={project} />}
      {clip ? (
        <Section title={t('style.clipPanel.clipOf', { n: fmt.count(clipIndex + 1), total: fmt.count(clips.length) })}>
          <p className="hint">
            {t('style.clipPanel.clipSpan', { start: fmt.clock(clip.start), end: fmt.clock(clip.end), seconds: fmt.number((clip.end - clip.start) / clip.speed, { max: 1 }) })}
          </p>
          <span className="field-label">
            <EditorIcon name="speed" size={14} /> {t('common.label.speed')}
          </span>
          <Chips label={t('style.clipPanel.clipSpeed')} value={clip.speed} onChange={setSpeed} options={SPEED_PRESETS.map((s) => ({ value: s, label: `${s}×` }))} />
          <button
            className="btn ghost danger"
            disabled={clips.length <= 1}
            onClick={() => props.onDeleteClip(clip.id)}
            title={clips.length <= 1 ? t('style.clipPanel.theLastClipCannot') : withShortcut(t('style.clipPanel.cutClipTitle'), keymap.deleteSelection)}
          >
            <EditorIcon name="scissors" size={16} /> {t('style.clipPanel.deleteClip')}
          </button>
        </Section>
      ) : selection?.kind === 'gap' ? (
        <Section title={GAP_TITLE()[timelineGaps(clips, project.duration).find((g) => Math.abs(g.start - selection.start) < 1e-6)?.kind ?? 'cut']}>
          <p className="hint">
            {t('style.clipPanel.gapSpan', { start: fmt.clock(selection.start), end: fmt.clock(selection.end), seconds: fmt.number(selection.end - selection.start, { max: 1 }) })}
          </p>
          <button className="btn" onClick={() => props.onRestore(selection.start, selection.end)}>
            <EditorIcon name="restore" size={16} /> {t('common.action.restore')}
          </button>
          <CutStyleSection project={project} gap={{ start: selection.start, end: selection.end }} />
        </Section>
      ) : selection?.kind === 'range' ? (
        <Section title={t('style.clipPanel.selectedRange')}>
          <p className="hint">
            {t('style.clipPanel.rangeSpan', { start: fmt.clock(selection.start), end: fmt.clock(selection.end), seconds: fmt.number(selection.end - selection.start, { max: 1 }) })}
          </p>
          <button className="btn" onClick={() => props.onCutRange(selection.start, selection.end)} title={withShortcut(t('style.clipPanel.cutRangeTitle'), keymap.deleteSelection)}>
            <EditorIcon name="scissors" size={16} /> {t('style.clipPanel.cutRange')}
          </button>
          <span className="field-label">
            <EditorIcon name="speed" size={14} /> {t('style.clipPanel.speedUpOrSlow')}
          </span>
          <Chips
            label={t('style.clipPanel.rangeSpeed')}
            value={null}
            onChange={(s) => {
              // A range that changes nothing keeps its selection and adds no undo step.
              const current = store.state.clips
              const next = setRangeSpeed(current, selection.start, selection.end, s)
              if (next === current) {
                props.onNotice(t('style.clipPanel.nothingToChange', { speed: `${s}×` }))
                return
              }
              store.update((p) => ({ ...p, clips: next }))
              props.onSelect(null)
            }}
            options={SPEED_PRESETS.map((s) => ({ value: s, label: `${s}×` }))}
          />
          {props.recorded.valid && !project.capture.cursorInVideo && <CursorPathField {...props} range={selection} />}
        </Section>
      ) : (
        <Section title={t('style.clipPanel.edit')}>
          <button className="btn" onClick={props.onSplit} title={withShortcut(t('style.clipPanel.splitTitle'), keymap.split)}>
            <EditorIcon name="split" size={16} /> {t('style.clipPanel.splitAtPlayhead')}
          </button>
          {uiLanguage() === 'en' ? (
            // English keeps the hint in today's four text nodes (merge group, output-and-languages §9.3).
            <p className="hint">
              {keymap.split.length ? <Rich k="style.clipPanel.editHint.pressSplit" values={{ split: <FirstShortcut accelerators={keymap.split} fallback="" /> }} /> : t('style.clipPanel.editHint.split')}{' '}
              {t('style.clipPanel.editHint.selectClip')}{' '}
              {keymap.deleteSelection.length ? <Rich k="style.clipPanel.editHint.pressDelete" values={{ delete: <FirstShortcut accelerators={keymap.deleteSelection} fallback="" /> }} /> : t('style.clipPanel.editHint.useDelete')}{' '}
              <Rich k="style.clipPanel.editHint.toCut" />
            </p>
          ) : (
            <p className="hint">
              <Rich
                k="style.clipPanel.editHint.whole"
                values={{
                  hasSplit: keymap.split.length ? 'yes' : 'no',
                  split: <FirstShortcut accelerators={keymap.split} fallback="" />,
                  hasDelete: keymap.deleteSelection.length ? 'yes' : 'no',
                  delete: <FirstShortcut accelerators={keymap.deleteSelection} fallback="" />
                }}
              />
            </p>
          )}
        </Section>
      )}
      <FreezeSection {...props} />
      <SmartSpeed {...props} />
      {edited && (
        <button
          className="btn ghost"
          onClick={() => {
            store.update((p) => ({ ...p, clips: [{ id: p.clips[0].id, start: 0, end: p.duration, speed: 1 }] }))
            props.onSelect(null)
          }}
        >
          <EditorIcon name="restore" size={16} /> {t('style.clipPanel.restoreTheWholeRecording')}
        </button>
      )}
    </>
  )
}

/* ---------- Cursor path of a selected range ---------- */

/**
 * Straightens the cursor moves of the selected range, keeps them as recorded, or (Reset) lets
 * them follow the Straighten moves option again. The range stays selected, to compare.
 */
function CursorPathField(props: InspectorProps & { range: { start: number; end: number } }): JSX.Element {
  const { project, recorded, input, range } = props
  const summary = useMemo(() => pathSummary(recorded, project, range), [recorded, project, range])
  // Reset only where a painted range lies under the selection.
  const painted = (project.inputEdits?.paths ?? []).some((r) => r.start < range.end && r.end > range.start)
  return (
    <div className="cursor-path" data-testid="cursor-path">
      <span className="field-label">
        <EditorIcon name="crosshair" size={14} /> {t('style.clipPanel.cursorPath')}
      </span>
      <div className="row start cursor-path-actions">
        <button className="btn" onClick={() => input.setPathRange(range, 'straight')} title={t('style.clipPanel.replaceTheCursorMoves')}>{t('style.clipPanel.straighten')}</button>
        <button className="btn" onClick={() => input.setPathRange(range, 'recorded')} title={t('style.clipPanel.keepTheCursorMoves')}>{t('style.clipPanel.asRecorded')}</button>
        {painted && (
          <button className="btn ghost" onClick={() => input.setPathRange(range, null)} title={t('style.clipPanel.letThisRangeFollow')}>{t('common.action.reset')}</button>
        )}
      </div>
      <p className="hint" data-testid="cursor-path-summary">
        {t('style.clipPanel.pathSummary', { count: summary.moves, n: fmt.count(summary.moves), straightened: fmt.count(summary.straightened) })}
      </p>
    </div>
  )
}

/* ---------- Smart speed ---------- */

/**
 * Still-picture analysis of the open recording and the measured levels of its sound, kept for
 * the editor session (keyed by its store) so switching tabs never runs them again; also which
 * smart speed request was handled. A failed analysis is not kept: Find tries again. Only the
 * picture inside the crop counts, so the analysis (and the one running) names the crop it looked
 * inside: after the crop changes it is not used, and Find looks again.
 */
interface Analysis {
  still: InCrop<TimeRange[]> | null
  pending: InCrop<Promise<TimeRange[]>> | null
  levels: AudioAnalysis
  request: number
}
/** Still parts, or the analysis finding them, inside the crop `crop` names (cropKey). */
interface InCrop<T> {
  crop: string
  ranges: T
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

const MODE_OPTIONS = (): { value: SmartMode; label: string; title: string }[] => [
  { value: 'idle', label: t('style.clipPanel.mode.idle'), title: t('style.clipPanel.mode.idle.title') },
  { value: 'silence', label: t('style.clipPanel.mode.silence'), title: t('style.clipPanel.mode.silence.title') }
]

const ACTION_LABEL = (): Record<string, string> => ({ 2: '2×', 4: '4×', 8: '8×', cut: t('common.action.cut') })
const ACTION_TITLE = (): Record<string, string> => ({
  2: t('style.clipPanel.action.idle2'),
  4: t('style.clipPanel.action.idle4'),
  8: t('style.clipPanel.action.idle8'),
  cut: t('style.clipPanel.action.idleCut')
})
const SILENCE_ACTION_TITLE = (): Record<string, string> => ({
  2: t('style.clipPanel.action.silence2'),
  4: t('style.clipPanel.action.silence4'),
  8: t('style.clipPanel.action.silence8'),
  cut: t('style.clipPanel.action.silenceCut')
})

const seconds = (s: number): string => (s < 60 ? t('style.clipPanel.seconds', { n: fmt.number(s, { max: 1 }) }) : fmt.clock(s))
/** "3 idle parts", "1 silence": the parts found, counted. */
const idleParts = (n: number): string => t('style.clipPanel.idleParts', { count: n, n: fmt.count(n) })
const silences = (n: number): string => t('style.clipPanel.silences', { count: n, n: fmt.count(n) })
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
  const [found, setFound] = useState(analysis.still)
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
  // The part cropped away is not seen: whatever moves there, the picture shown can be still.
  const { crop: projectCrop, width, height } = project
  const crop = useMemo(() => cropOf({ crop: projectCrop, width, height }), [projectCrop, width, height])
  const cropKey = crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : ''
  const still = found?.crop === cropKey ? found.ranges : null
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
      // One running for another crop looks at other pixels: not waited for.
      let pending = analysis.pending
      if (pending?.crop !== cropKey) {
        const ranges: Promise<TimeRange[]> = window.api.detectStill(projectId, STILL_DETECT_MIN, crop).finally(() => {
          if (analysis.pending?.ranges === ranges) analysis.pending = null
        })
        pending = analysis.pending = { crop: cropKey, ranges }
      }
      try {
        const [ranges] = await Promise.all([pending.ranges, measure()])
        analysis.still = { crop: pending.crop, ranges }
        if (!alive.current) return
        setFound(analysis.still)
        setSkipped(new Set())
      } catch (err) {
        // Shown next to the button, which tries again.
        if (alive.current) setFailure(stripIpcPrefix(err instanceof Error ? err.message : String(err)).replace(/[.\s]+$/, '') || 'unknown error')
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [analysis, projectId, crop, cropKey, measure]
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
    if (analysis.pending?.crop === cropKey && analysis.still?.crop !== cropKey) void find()
  }, [analysis, cropKey, find])

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
    if (analysis.still?.crop !== cropKey && analysis.pending?.crop !== cropKey) void find()
  }, [request, analysis, cropKey, find])

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
  // What counts as sound: the speech detector (the voice), or the level (docs/design/offline-captions.md §3.6).
  const detector = useMemo(() => soundDetector({ hasAudio, audioStems, audio }, levels), [hasAudio, audioStems, audio, levels])
  // Title cards are content however still and silent the time under them is, and a freeze frame
  // holds its frame however still and silent it is: never sped up or cut.
  const { titles, freezes } = project
  const keep = useMemo(() => [...(titles ?? []).map(({ start, end }) => ({ start, end })), ...freezeKeepRanges(freezes)], [titles, freezes])
  const idlePlan = useMemo(
    () => (mode === 'idle' && still ? planSmartSpeed({ still, inactive, sound, keep, clips: project.clips, duration: project.duration }, minIdle, action) : null),
    [mode, still, inactive, sound, keep, project.clips, project.duration, minIdle, action]
  )
  // Silences need sound that was measured: null until then (or without sound at all).
  const heard = mode === 'silence' && sources.length > 0 ? sound : null
  const silencePlan = useMemo(
    () => (heard ? planSilences(heard, project.clips, { minLength: minSilence, padding }, silenceAction, keep) : null),
    [heard, project.clips, minSilence, padding, silenceAction, keep]
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
    // Remembered as automatic, for Review mode (docs/design/review-mode.md §4.1).
    store.update((p) => recordAutoCuts(p, applySmartSpeed(p.clips, ranges, currentAction), ranges, currentAction, mode === 'idle' ? 'smart-speed' : 'silences'))
    const shorter = before - outputDuration(store.state.clips)
    onSelect(null)
    const values = { count: chosen.length, n: fmt.count(chosen.length), speed: `${currentAction}×`, shorter: seconds(shorter) }
    const done =
      mode === 'idle'
        ? currentAction === 'cut'
          ? t('style.clipPanel.done.cutIdle', values)
          : t('style.clipPanel.done.speedIdle', values)
        : currentAction === 'cut'
          ? t('style.clipPanel.done.cutSilences', values)
          : t('style.clipPanel.done.speedSilences', values)
    onNotice(`${done}${undoHint(keymap)}`)
  }

  const toggle = (key: string, on: boolean): void => {
    const next = new Set(skipped)
    if (on) next.delete(key)
    else next.add(key)
    setSkipped(next)
  }

  return (
    <div className="smart-speed" ref={boxRef} data-testid="smart-speed">
      <Section title={t('style.clipPanel.smartSpeed')}>
        <div className="smart-mode">
          <Chips label={t('style.clipPanel.smartSpeedMode')} value={mode} onChange={(v) => choose({ mode: v })} options={MODE_OPTIONS()} />
        </div>
        {mode === 'idle' ? (
          <>
            <p className="hint">
              {detector === 'speech' ? IDLE_VOICE_HINT : t('style.clipPanel.speedsUpOrCuts')}
            </p>
            {keep.length > 0 && <TitlesKept titles={!!titles?.length} freezes={!!freezes?.length} />}
            {!cursor.valid && <p className="hint">{t('style.clipPanel.thisRecordingHasNo')}</p>}
            <span className="field-label">{t('style.clipPanel.idleForAtLeast')}</span>
            <Chips label={t('style.clipPanel.minimumIdleLength')} value={minIdle} onChange={(v) => choose({ minIdle: v })} options={MIN_IDLE_CHOICES.map((s) => ({ value: s, label: t('style.clipPanel.seconds', { n: fmt.number(s) }) }))} />
            <span className="field-label">
              <EditorIcon name="speed" size={14} /> {t('style.clipPanel.then')}
            </span>
            <Chips
              label={t('style.clipPanel.smartSpeedAction')}
              value={action}
              onChange={(v) => choose({ action: v })}
              options={SMART_SPEED_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL()[a], title: ACTION_TITLE()[a] }))}
            />
            {!idlePlan ? (
              <>
                {failure && (
                  <p className="callout" role="alert" data-testid="smart-speed-error">
                    <EditorIcon name="alert" size={16} />
                    <span>{t('style.clipPanel.notAnalysed', { reason: failure })}</span>
                  </p>
                )}
                <button className="btn" onClick={() => void find()} disabled={busy}>
                  {busy ? (
                    <>
                      <span className="smart-spinner" aria-hidden="true" /> {t('style.clipPanel.lookingForIdleParts')}</>
                  ) : (
                    <>
                      <EditorIcon name="sparkle" size={16} /> {failure ? t('common.action.tryAgain') : t('style.clipPanel.findIdleParts')}
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
                    ? action === 'cut'
                      ? t('style.clipPanel.none.idle', { n: fmt.number(minIdle) })
                      : t('style.clipPanel.none.idleSpeed', { n: fmt.number(minIdle) })
                    : null
                }
                count={idleParts}
                listLabel={t('style.clipPanel.list.idle')}
                chosen={chosen.length}
                saved={saved}
                apply={
                  <button className="btn primary" disabled={!chosen.length} onClick={apply}>
                    <EditorIcon name="speed" size={16} /> {action === 'cut' ? t('style.clipPanel.apply.cutParts', { count: chosen.length, n: fmt.count(chosen.length) }) : t('style.clipPanel.apply.speedParts', { count: chosen.length, n: fmt.count(chosen.length), speed: `${action}×` })}
                  </button>
                }
                onSelect={onSelect}
              />
            )}
          </>
        ) : (
          <>
            <p className="hint">
              {detector === 'speech' ? SILENCES_VOICE_HINT : t('style.clipPanel.cutsOrSpeedsUp')}
            </p>
            {detector && sources.length > 0 && (
              <p className="hint silence-detector" data-testid="silence-detector" data-detector={detector}>
                {detectorStatus(detector, sources.includes('system'))}
              </p>
            )}
            {keep.length > 0 && <TitlesKept titles={!!titles?.length} freezes={!!freezes?.length} />}
            {!hasAudio ? (
              <p className="callout silence-callout" data-testid="silence-unavailable">
                <EditorIcon name="mute" size={16} />
                <span>
                  <Rich
                    k="style.clipPanel.noSound"
                    tags={{
                      link: (c) => (
                        <button className="link" onClick={() => choose({ mode: 'idle' })}>
                          {c}
                        </button>
                      )
                    }}
                  />
                </span>
              </p>
            ) : sources.length === 0 ? (
              <p className="callout silence-callout" data-testid="silence-unavailable">
                <EditorIcon name="mute" size={16} />
                <span>{t('style.clipPanel.theRecordingsSoundIs')}</span>
              </p>
            ) : (
              <>
                <Slider
                  label={t('style.clipPanel.silentForAtLeast')}
                  value={minSilence}
                  min={SILENCE_LENGTH.min}
                  max={SILENCE_LENGTH.max}
                  step={SILENCE_LENGTH.step}
                  format={(v) => `${v.toFixed(1)} s`}
                  onChange={(v) => choose({ minSilence: v })}
                />
                <Slider
                  label={t('style.clipPanel.keepNextToThe')}
                  value={padding}
                  min={SILENCE_PADDING.min}
                  max={SILENCE_PADDING.max}
                  step={SILENCE_PADDING.step}
                  format={(v) => `${v.toFixed(2)} s`}
                  onChange={(v) => choose({ padding: v })}
                />
                <span className="field-label">
                  <EditorIcon name="speed" size={14} /> {t('style.clipPanel.then')}
                </span>
                <Chips
                  label={t('style.clipPanel.silenceAction')}
                  value={silenceAction}
                  onChange={(v) => choose({ silenceAction: v })}
                  options={SMART_SPEED_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL()[a], title: SILENCE_ACTION_TITLE()[a] }))}
                />
                {!silencePlan ? (
                  <>
                    {soundFailed && !listening && (
                      <p className="callout" role="alert" data-testid="silence-error">
                        <EditorIcon name="alert" size={16} />
                        <span>{t('style.clipPanel.theSoundOfThe')}</span>
                      </p>
                    )}
                    <button className="btn" onClick={() => void findSilences()} disabled={listening}>
                      {listening ? (
                        <>
                          <span className="smart-spinner" aria-hidden="true" /> {t('style.clipPanel.listeningForPauses')}</>
                      ) : (
                        <>
                          <EditorIcon name="sparkle" size={16} /> {soundFailed ? t('common.action.tryAgain') : t('style.clipPanel.findSilences')}
                        </>
                      )}
                    </button>
                  </>
                ) : heard && heard.length === 0 ? (
                  <p className="smart-summary" role="status" data-testid="silence-none">{t('style.clipPanel.nothingIsHeardIn')}</p>
                ) : (
                  <PartList
                    parts={silencePlan.parts}
                    skipped={skipped}
                    onToggle={toggle}
                    summary={
                      silencePlan.parts.length === 0
                        ? silenceAction === 'cut'
                          ? t('style.clipPanel.none.silences', { n: fmt.number(minSilence, { max: 1 }) })
                          : t('style.clipPanel.none.silencesSpeed', { n: fmt.number(minSilence, { max: 1 }) })
                        : null
                    }
                    count={silences}
                    listLabel={t('style.clipPanel.list.silences')}
                    chosen={chosen.length}
                    saved={saved}
                    apply={
                      <button className="btn primary" disabled={!chosen.length} onClick={apply}>
                        <EditorIcon name={silenceAction === 'cut' ? 'scissors' : 'speed'} size={16} />{' '}
                        {silenceAction === 'cut' ? t('style.clipPanel.apply.cutSilences', { count: chosen.length, n: fmt.count(chosen.length) }) : t('style.clipPanel.apply.speedSilences', { count: chosen.length, n: fmt.count(chosen.length), speed: `${silenceAction}×` })}
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

/** Why the time under a title card or at a freeze frame is never listed. */
function TitlesKept({ titles, freezes }: { titles: boolean; freezes: boolean }): JSX.Element {
  return (
    <p className="hint" data-testid="smart-speed-titles">
      {titles && freezes ? t('style.clipPanel.kept.both') : freezes ? t('style.clipPanel.kept.freezes') : t('style.clipPanel.kept.titles')}
    </p>
  )
}

/** The parts found, each with a checkbox, its range (selects it on the timeline) and what it saves. */
function PartList({
  parts,
  skipped,
  onToggle,
  summary,
  count,
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
  /** The chosen parts, counted ("3 idle parts"). */
  count: (n: number) => string
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
            <T
              k={chosen < parts.length ? 'style.clipPanel.summaryOf' : 'style.clipPanel.summary'}
              values={{ chosen: count(chosen), total: fmt.count(parts.length), saved: seconds(saved) }}
              tags={{ b: (c) => <strong>{c}</strong> }}
            />
          </>
        )}
      </p>
      {parts.length > 0 && (
        <ul className="smart-list" aria-label={listLabel}>
          {parts.map((p) => {
            const key = partKey(p)
            const on = !skipped.has(key)
            const range = `${fmt.clock(p.start)} – ${fmt.clock(p.end)}`
            const length = p.length ?? p.end - p.start
            return (
              <li key={key} className={on ? '' : 'skipped'}>
                <input type="checkbox" checked={on} aria-label={t('style.clipPanel.include', { range: String(range) })} onChange={(e) => onToggle(key, e.target.checked)} />
                <button
                  className="smart-range"
                  title={t('style.clipPanel.selectThisPartOn')}
                  onClick={() => {
                    onSelect({ kind: 'range', start: p.start, end: p.end })
                    player.seek(p.start)
                  }}
                >
                  {range}
                </button>
                <span className="smart-saving">
                  {t('style.clipPanel.seconds', { n: fmt.number(length, { max: 1 }) })}
                  <span className="muted"> · −{seconds(p.saved)}</span>
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
