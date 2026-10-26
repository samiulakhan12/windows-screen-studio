import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { applyDirectorPlan, clearDirected, framingNearWebcam, planDirector, type DirectorInput, type DirectorPart, type DirectorPlan, type DirectorStripItem } from '../../../../shared/editor/cameraDirector'
import {
  applyingLabel,
  applyLabel,
  diffLine,
  directedNotice,
  faceLine,
  framingLine,
  keptLine,
  KEPT_POSITIONS_HINT,
  LEAD,
  NOTE_TEXT,
  noteText,
  OWNERSHIP_HINT,
  partLabel,
  partTimes,
  reasonText,
  removedNotice,
  soundFailed,
  sourceLine,
  sourceState,
  summaryLine,
  USER_FRAMING_HINT
} from '../../../../shared/editor/directorCopy'
import type { EditStore } from '../../../../shared/editor/editStore'
import { undoHint } from '../../../../shared/editor/shortcuts'
import { directorMayFrame, directorSettingsOf, framingIsDirectors, framingUntouched, hasCameraPositions, hasDirectorChanges } from '../../../../shared/engine/directorData'
import { effectiveTrack } from '../../../../shared/engine/inputTrack'
import { outputDuration, outputToSource } from '../../../../shared/engine/timeline'
import { faceSampleTimes, type FramingOutcome } from '../../../../shared/render/faceFraming'
import type { CursorTrack, DirectorHideAfter, DirectorSettings, Project } from '../../../../shared/types'
import { loadDirectorSpeech, measureFraming, type SpeechResult } from '../directorAnalysis'
import { useEditor } from '../context'
import { Chips, Section, Toggle } from '../controls'
import { Icon } from '../../components/Icon'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import { LayoutGlyph } from '../layoutGlyphs'
import { CornerGlyph, showLayout } from '../LayoutTrack'
import type { PreviewPlayer } from '../player'
import './director.css'

type Props = Pick<InspectorProps, 'project' | 'cursor' | 'recorded' | 'onSelect' | 'onNotice' | 'directorRequest'>

/**
 * What the section keeps for the editor session (keyed by its store), so switching tabs never
 * measures the sound again and an Apply started before switching tabs is still shown: the speech
 * (and the sound it was measured for), the palette request handled last, the framing outcome of
 * each Apply (by the Project.director it wrote), and the Apply running now (with its progress).
 */
interface Session {
  speech: SpeechResult | null
  speechKey: string
  pending: Promise<SpeechResult> | null
  request: number
  /**
   * The framing outcome of each Apply by the Project.director it wrote (a new object whenever it
   * changed the project, also only its layouts): the project shows the outcome of the Apply that
   * wrote its director, so an undo shows the one of the Apply before (none before the first), a
   * redo the undone one again. Remove forgets them all.
   */
  outcomes: WeakMap<DirectorSettings, FramingOutcome>
  busy: { listening: boolean; done: number; total: number } | null
  listeners: Set<() => void>
  /** Bumped on every change, for useSyncExternalStore. */
  version: number
}
const sessions = new WeakMap<EditStore<Project>, Session>()

const emit = (s: Session): void => {
  s.version++
  s.listeners.forEach((l) => l())
}

/** The sound speech is measured from: re-measured when it changes (a transcript made later refines it). */
const speechKeyOf = (p: Pick<Project, 'hasAudio' | 'audioStems' | 'transcript'>): string =>
  `${p.hasAudio}|${p.audioStems?.mic ?? ''}|${p.audioStems?.system ?? ''}|${p.transcript?.segments.length ?? 0}|${p.transcript?.segments.at(-1)?.end ?? ''}`

/** The session's speech for `project`, measured once (loadDirectorSpeech never rejects; a failure is retried on the next call). */
function speechFor(s: Session, project: Project, cursor: CursorTrack): Promise<SpeechResult> {
  const key = speechKeyOf(project)
  if (s.speech && s.speechKey === key && !s.speech.failed) return Promise.resolve(s.speech)
  if (s.pending && s.speechKey === key) return s.pending
  s.speechKey = key
  const pending = loadDirectorSpeech(project, cursor).then((r) => {
    if (s.pending === pending) {
      s.speech = r
      s.pending = null
      emit(s)
    }
    return r
  })
  s.pending = pending
  emit(s)
  return pending
}

/** Whether the saved options are the ones shown (`framed` aside): applying would not change them. */
const sameSettings = (a: DirectorSettings | undefined, b: DirectorSettings): boolean =>
  !!a && a.intro === b.intro && a.corners === b.corners && a.hideAfter === b.hideAfter && a.frameFace === b.frameFace

const INTRO_OPTIONS: { value: DirectorSettings['intro']; label: string; title: string }[] = [
  { value: 'camera-only', label: 'Camera only', title: 'The camera fills the frame while you talk before and after the demo' },
  { value: 'camera-large', label: 'Large camera', title: 'A big camera over the screen while you talk before and after the demo' },
  { value: 'off', label: 'Off', title: 'No intro or outro: the bubble from the start to the end' }
]
const HIDE_OPTIONS: { value: DirectorHideAfter; label: string }[] = [
  { value: 5, label: '5 s' },
  { value: 10, label: '10 s' },
  { value: 20, label: '20 s' },
  { value: 0, label: 'Never' }
]

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/[.\s]+$/, '') || 'unknown error'

/** A plan, or null when the planner failed (the section then offers nothing to apply). */
function safePlan(input: DirectorInput, settings: DirectorSettings): DirectorPlan | null {
  try {
    return planDirector(input, settings)
  } catch (err) {
    console.error('camera director: planning failed', err)
    return null
  }
}

/** Shows output time `o` on the preview (the player works in source time). */
const seekOutput = (player: PreviewPlayer, project: Project, o: number): void => player.seek(outputToSource(project.clips, o).time)

/**
 * "Auto director", the first section of the Camera tab (docs/design/camera-director.md, section 2):
 * the plan for the current project, live (speech measured once, the plan debounced), shown before
 * it is applied: the sound it listens to, a strip of the whole video, the list of changes with
 * their reasons, the summary and, on a re-run, the diff. The options are a draft until applied.
 * Apply measures the face, then writes the plan recomputed from the latest project in one
 * store.update (one undo step).
 */
export function DirectorSection({ project, cursor, recorded, onSelect, onNotice, directorRequest = 0 }: Props): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const session = useMemo<Session>(() => {
    let s = sessions.get(store)
    if (!s) sessions.set(store, (s = { speech: null, speechKey: '', pending: null, request: 0, outcomes: new WeakMap(), busy: null, listeners: new Set(), version: 0 }))
    return s
  }, [store])
  const subscribe = useCallback(
    (l: () => void) => {
      session.listeners.add(l)
      return () => void session.listeners.delete(l)
    },
    [session]
  )
  // Re-rendered when the session changes (speech measured, Apply progress).
  useSyncExternalStore(subscribe, () => session.version)
  const busy = session.busy
  const speech = session.speech
  const measuring = !!session.pending

  // Speech: measured as soon as the section shows (and again when the sound or the transcript changes).
  const speechKey = speechKeyOf(project)
  useEffect(() => {
    void speechFor(session, store.state, cursor)
  }, [session, store, cursor, speechKey])

  // The options: the saved ones (or the defaults), until changed here; a draft until applied.
  // A new saved state (applied, undone, removed) shows its options again.
  const [draft, setDraft] = useState<DirectorSettings | null>(null)
  const saved = project.director
  useEffect(() => setDraft(null), [saved])
  const resolved = directorSettingsOf(project)
  const settings = draft ?? resolved
  const choose = (patch: Partial<DirectorSettings>): void => setDraft({ ...settings, ...patch })

  // The planner builds the cursor and focus paths itself, cached per recording: opening the tab
  // again reuses them and the corner costs cached for them.
  const hidden = !project.webcam.show
  const speechNow = speech?.speech ?? null

  // The live plan, debounced: dragging a slider elsewhere does not re-plan on every step.
  const [plan, setPlan] = useState<DirectorPlan | null>(null)
  const planRef = useRef<{ project: Project; settings: DirectorSettings } | null>(null)
  useEffect(() => {
    if (hidden) {
      setPlan(null)
      return
    }
    const run = (): void => {
      planRef.current = { project, settings }
      setPlan(safePlan({ project, cursor, speech: speechNow }, settings))
    }
    // The first plan at once, so the section never opens empty.
    if (!planRef.current) return run()
    const timer = window.setTimeout(run, 150)
    return () => window.clearTimeout(timer)
    // `settings` is a new object every render: its fields decide.
  }, [hidden, project, cursor, speechNow, settings.intro, settings.corners, settings.hideAfter, settings.frameFace])

  const directed = hasDirectorChanges(project)
  const mayFrame = directorMayFrame(project.webcam, project.director)
  const framedByDirector = !framingUntouched(project.webcam) && framingIsDirectors(project.webcam, project.director)
  // The outcome of the Apply that wrote the project's options (none after undoing the first Apply, or after Remove).
  const lastOutcome = project.director ? (session.outcomes.get(project.director) ?? null) : null
  // A framing measured within FACE.nearZoom / nearCrop of the camera's: Apply left the camera as it was, which shows it.
  const measuredAsShown = lastOutcome?.status === 'framed' && framingNearWebcam(lastOutcome, project.webcam)
  const framingShown = framedByDirector || measuredAsShown
  // Framing still to do: the option is on and the camera does not show the director's framing yet.
  const framingTodo = settings.frameFace && !framingShown
  // A project never directed compares with the options it resolves to: unchanged, applying would only save them.
  const upToDate = !!plan && plan.upToDate && !framingTodo && sameSettings(saved ?? resolved, settings)

  /* ---------- apply ---------- */

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /**
   * Directs the camera with `chosen`: waits for the speech, measures the face (when asked), then
   * one store.update that plans again from the project as it is then and applies it.
   */
  const direct = useCallback(
    async (chosen: DirectorSettings): Promise<void> => {
      if (session.busy) return
      const setBusy = (b: Session['busy']): void => {
        session.busy = b
        emit(session)
      }
      try {
        setBusy({ listening: true, done: 0, total: 0 })
        const heard = await speechFor(session, store.state, cursor)
        const sp = heard.speech
        // The input with the input edits of the project planned (a click ignored meanwhile counts).
        const inputFor = (p: Project): DirectorInput => ({ project: p, cursor: effectiveTrack(recorded, p), speech: sp })
        setBusy({ listening: false, done: 0, total: 0 })
        let outcome: FramingOutcome = { status: 'skipped' }
        const video = player.webcam
        if (chosen.frameFace && video) {
          const first = planDirector(inputFor(store.state), chosen)
          try {
            const p = store.state
            const times = faceSampleTimes(first.cameraShown, sp?.ranges ?? null, p.webcamOffset, video.duration || p.duration)
            setBusy({ listening: false, done: 0, total: times.length })
            outcome = await measureFraming(video.currentSrc || video.src, times, first.framingCap, {
              onProgress: ({ done, total }) => setBusy({ listening: false, done, total })
            })
          } catch (err) {
            outcome = { status: 'unavailable', reason: errorText(err) }
          }
        }
        const before = store.state
        store.update((p) => applyDirectorPlan(p, planDirector(inputFor(p), chosen), outcome))
        const after = store.state
        if (after.director) session.outcomes.set(after.director, outcome)
        const parts = planDirector(inputFor(after), chosen).parts
        const removed = (before.layouts ?? []).some((s) => s.auto) && !(after.layouts ?? []).some((s) => s.auto)
        onNotice(directedNotice(parts, outcome, after !== before, undoHint(keymap), removed))
      } catch (err) {
        console.error('camera director: directing failed', err)
        onNotice(`The camera could not be directed: ${errorText(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [session, store, player, cursor, recorded, onNotice, keymap]
  )

  const remove = (): void => {
    const before = store.state
    try {
      store.update((p) => clearDirected(p))
    } catch (err) {
      onNotice(`The automatic changes could not be removed: ${errorText(err)}`)
      return
    }
    session.outcomes = new WeakMap()
    emit(session)
    onSelect(null)
    onNotice(removedNotice(store.state !== before, undoHint(keymap)))
  }

  // The palette command: show the section and direct at once with the saved (or default) options.
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!directorRequest || session.request === directorRequest) return
    session.request = directorRequest
    boxRef.current?.scrollIntoView({ block: 'nearest' })
    if (!store.state.webcam.show) return onNotice('Show the camera first')
    void direct(directorSettingsOf(store.state))
  }, [directorRequest, session, store, direct, onNotice])

  /* ---------- what it shows ---------- */

  const total = outputDuration(project.clips)
  const source = sourceState(speechNow, measuring)
  const failed = !measuring && !!speech?.failed
  const noSpeechKnown = !measuring && !speechNow
  // The recording has no sound (measured, nothing failed, no captions). Still measuring, or failed,
  // is not "no sound": the plan made without speech then says nothing about the talking.
  const soundKnownAbsent = !measuring && !!speech && !speech.failed && !speechNow
  const speechUnknown = !speechNow && !soundKnownAbsent
  const notes = hidden ? (['camera-hidden'] as const) : (plan?.notes ?? [])
  const shownNotes = [...new Set(notes)].filter(
    (n) => NOTE_TEXT[n] && !(n === 'nothing' && plan && plan.parts.length > 0) && !(speechUnknown && (n === 'no-sound' || n === 'nothing'))
  )
  const kept = plan ? keptLine(plan.kept) : null
  // The summary, also with no part when applying would remove the director's earlier segments (the diff says so).
  const summarised = !!plan && !hidden && (plan.parts.length > 0 || plan.diff.removed > 0)
  const state = busy ? 'applying' : measuring ? 'measuring' : upToDate ? 'up-to-date' : 'ready'
  // That outcome, "framed" only while the camera shows it (not after a framing by hand).
  const framing = lastOutcome && (lastOutcome.status !== 'framed' || framingShown) ? framingLine(lastOutcome, !mayFrame && !settings.frameFace) : null
  const selectPart = (part: DirectorPart): void => {
    // Applied and unchanged: its segment is in the project, so select it; else show where it would be.
    const id = part.ids.find((i) => store.state.layouts?.some((s) => s.id === i))
    if (id) {
      onSelect({ kind: 'layout', id })
      showLayout(player, store.state, id)
    } else seekOutput(player, store.state, part.outStart + Math.min(0.5, (part.outEnd - part.outStart) / 2))
  }

  return (
    <div className="director" ref={boxRef} data-testid="director">
      <Section title="Auto director">
        <p className="hint">{LEAD}</p>

        {!hidden && sourceLine(source) && (
          <p className="director-source" data-testid="director-source" data-source={source}>
            {measuring ? <span className="smart-spinner" aria-hidden="true" /> : source === 'mic' ? <Icon name="mic" size={14} /> : <EditorIcon name={source === 'transcript' ? 'captions' : 'volume'} size={14} />}
            <span>{sourceLine(source)}</span>
          </p>
        )}
        {!hidden && failed && (
          <p className="callout" role="alert" data-testid="director-sound-failed">
            <EditorIcon name="alert" size={16} />
            <span>
              {soundFailed(!!speechNow)}{' '}
              <button className="link" onClick={() => void speechFor(session, store.state, cursor)}>
                Try again
              </button>
            </span>
          </p>
        )}

        {plan && !hidden && plan.strip.length > 0 && <PlanStrip strip={plan.strip} total={total} home={project.webcam.corner} onSeek={(o) => seekOutput(player, store.state, o)} />}

        {plan && !hidden && (plan.parts.length > 0 || settings.frameFace) && (
          <ul className="director-parts" aria-label="Changes the director makes">
            {plan.parts.map((part, i) => (
              <li key={`${part.kind}-${i}`}>
                <button className="director-part" data-testid="director-part" data-kind={part.kind} data-corner={part.corner} onClick={() => selectPart(part)}>
                  <PartGlyph part={part} />
                  <span className="director-part-text">
                    <span>
                      {partLabel(part)} · {partTimes(part)}
                    </span>
                    <span className="director-reason">{reasonText(part.reason)}</span>
                  </span>
                </button>
              </li>
            ))}
            {settings.frameFace && (
              <li className="director-part face" data-testid="director-face">
                <span className="director-glyph face" aria-hidden="true">
                  <Icon name="camera" size={14} />
                </span>
                <span className="director-part-text">{faceLine(framingShown ? { zoom: project.webcam.zoom ?? 1 } : null)}</span>
              </li>
            )}
          </ul>
        )}

        {plan && summarised && (
          <div className="director-summary" data-testid="director-summary" data-state={state}>
            <span>{summaryLine(plan)}</span>
            {kept && <span className="muted">{kept}</span>}
            {directed && <span className="muted">{diffLine(plan.diff)}</span>}
          </div>
        )}
        {!summarised && <span className="director-summary empty" data-testid="director-summary" data-state={state} hidden />}

        {shownNotes.map((n) => (
          <p key={n} className="hint director-note" data-testid="director-note" data-note={n}>
            {noteText(n, plan?.settings ?? settings)}
          </p>
        ))}

        <span className="field-label">Intro and outro</span>
        <div data-testid="director-intro">
          <Chips label="Intro and outro" value={settings.intro} disabled={hidden || !!busy || noSpeechKnown} onChange={(intro) => choose({ intro })} options={INTRO_OPTIONS} />
        </div>
        <span className="field-label">Hide the camera when silent for</span>
        <div data-testid="director-hide">
          <Chips label="Hide the camera when silent for" value={settings.hideAfter} disabled={hidden || !!busy || noSpeechKnown} onChange={(hideAfter) => choose({ hideAfter })} options={HIDE_OPTIONS} />
        </div>
        <div data-testid="director-corners">
          <Toggle
            label="Move the bubble away from the cursor"
            checked={settings.corners === 'auto'}
            disabled={hidden || !!busy}
            onChange={(v) => choose({ corners: v ? 'auto' : 'keep' })}
          />
        </div>
        {hasCameraPositions(project.layouts) && <p className="hint">{KEPT_POSITIONS_HINT}</p>}
        <div data-testid="director-face-option">
          <Toggle label="Centre my face" checked={settings.frameFace} disabled={hidden || !!busy} onChange={(frameFace) => choose({ frameFace })} />
        </div>
        {!mayFrame && <p className="hint">{USER_FRAMING_HINT}</p>}

        <div className="director-actions">
          <button
            className="btn primary"
            data-testid="director-apply"
            disabled={hidden || !!busy || upToDate || !plan}
            aria-busy={!!busy}
            onClick={() => void direct(settings)}
          >
            {busy ? (
              <>
                <span className="smart-spinner" aria-hidden="true" /> {applyingLabel(busy)}
              </>
            ) : (
              <>
                <EditorIcon name="sparkle" size={16} /> {applyLabel({ directed, upToDate })}
              </>
            )}
          </button>
          {directed && (
            <button className="btn ghost" data-testid="director-remove" disabled={!!busy} onClick={remove}>
              Remove automatic changes
            </button>
          )}
        </div>
        <span className="director-live" role="status" aria-live="polite">
          {busy ? applyingLabel(busy) : ''}
        </span>
        {framing &&
          (framing.status === 'unavailable' ? (
            <p className="callout" role="alert" data-testid="director-framing-unavailable">
              <EditorIcon name="alert" size={16} />
              <span data-testid="director-framing" data-status={framing.status}>
                {framing.text}
              </span>
            </p>
          ) : (
            <p className="hint" data-testid="director-framing" data-status={framing.status}>
              {framing.text}
            </p>
          ))}
        <p className="hint">{OWNERSHIP_HINT}</p>
      </Section>
    </div>
  )
}

/** The glyph of a row: the large camera for an intro or outro, a crossed camera when hidden, the corner of a bubble move. */
function PartGlyph({ part }: { part: DirectorPart }): JSX.Element {
  return (
    <span className={`director-glyph ${part.kind}`} aria-hidden="true">
      {part.kind === 'corner' && part.corner ? <CornerGlyph corner={part.corner} /> : <LayoutGlyph layout={part.layout} size={18} />}
    </span>
  )
}

const STRIP_TITLE: Record<DirectorStripItem['state'], string> = {
  intro: 'Intro: the full camera',
  outro: 'Outro: the full camera',
  hidden: 'Camera hidden',
  bubble: 'The bubble',
  yours: 'Yours, kept'
}

/**
 * The output timeline by what the camera does: the full camera (violet), the bubble in another
 * corner (teal, with its corner), hidden (grey hatching), the user's own segments (outlined).
 * A block seeks the preview there.
 */
function PlanStrip({ strip, total, home, onSeek }: { strip: DirectorStripItem[]; total: number; home: DirectorStripItem['corner']; onSeek: (o: number) => void }): JSX.Element {
  const T = Math.max(1e-6, total)
  return (
    <div className="director-strip" data-testid="director-strip" role="group" aria-label="The camera over the video">
      {strip.map((it, i) => {
        const moved = it.state === 'bubble' && !!it.corner && it.corner !== home
        const title = `${moved && it.corner ? `Bubble ${it.corner.replace('-', ' ')}` : STRIP_TITLE[it.state]} · ${partTimes({ outStart: it.start, outEnd: it.end })}`
        return (
          <button
            key={i}
            className={`director-block ${it.state} ${moved ? 'moved' : ''}`}
            style={{ left: `${(it.start / T) * 100}%`, width: `${((it.end - it.start) / T) * 100}%` }}
            title={title}
            aria-label={title}
            data-state={it.state}
            data-corner={it.corner}
            onClick={() => onSeek(it.start + Math.min(0.5, (it.end - it.start) / 2))}
          >
            {moved && it.corner && <CornerGlyph corner={it.corner} />}
          </button>
        )
      })}
    </div>
  )
}
