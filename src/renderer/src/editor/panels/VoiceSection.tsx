import { useEffect, useRef, useSyncExternalStore } from 'react'
import { VOICE_STRENGTHS, voiceLook, voiceSourceOf, voiceTarget } from '../../../../shared/audio/voiceClean'
import { STRENGTH_HINTS, STRENGTH_NAMES, VOICE_COPY } from '../../../../shared/audio/voiceCopy'
import type { Project, VoiceSettings } from '../../../../shared/types'
import { useEditor } from '../context'
import { Chips, Section, Toggle } from '../controls'
import { voiceStems, type VoiceStemState } from '../voiceStems'
import './voice.css'

/**
 * Clean voice in the Audio panel (docs/design/clean-voice.md §5): the switch, the strength, where
 * the cleaned voice stands (progress and Cancel, Clean now, Try again) and "Hear the original".
 * The switch and the strength are edits (one undo step each); everything else is not.
 */
export function VoiceSection({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  const stems = voiceStems()
  useSyncExternalStore(stems.subscribe, stems.getVersion)
  const look = voiceLook(project.audio)
  const source = voiceSourceOf(project)
  const target = voiceTarget(project)
  const state: VoiceStemState | null = target ? stems.get(project.id, target, look.strength) : null
  const original = stems.isOriginal(project.id)

  /** One edit of the setting; the cleaned voice it needs is made at once (also after an earlier Cancel). */
  const setVoice = (patch: Partial<VoiceSettings>): void => {
    const next: Project = { ...project, audio: { ...project.audio, voice: { ...look, ...patch } } }
    store.update((p) => ({ ...p, audio: { ...p.audio, voice: { ...voiceLook(p.audio), ...patch } } }))
    if (patch.on === false) stems.setOriginal(project.id, false)
    const t = voiceTarget(next)
    if (t) void stems.prepare(project.id, t, voiceLook(next.audio).strength).catch(() => undefined)
  }

  const unavailable = source === 'silent' ? VOICE_COPY.silent : source === 'noMic' ? VOICE_COPY.noMic : null
  return (
    <Section title={VOICE_COPY.section}>
      <Toggle label={VOICE_COPY.toggle} checked={look.on} disabled={!!unavailable && !look.on} onChange={(on) => setVoice({ on })} />
      <p className="hint">{unavailable ?? VOICE_COPY.intro}</p>
      {source === 'mix' && <p className="hint">{VOICE_COPY.mixed}</p>}
      {look.on && target && state && (
        <>
          <div className="voice-strength">
            <span className="voice-label">{VOICE_COPY.strength}</span>
            <Chips
              label={VOICE_COPY.strength}
              value={look.strength}
              options={VOICE_STRENGTHS.map((s) => ({ value: s, label: STRENGTH_NAMES[s] }))}
              onChange={(strength) => strength !== look.strength && setVoice({ strength })}
            />
          </div>
          <p className="hint">{STRENGTH_HINTS[look.strength]}</p>
          <VoiceStatus
            state={state}
            original={original}
            onCancel={() => void stems.cancel(project.id)}
            onClean={() => void stems.prepare(project.id, target, look.strength).catch(() => undefined)}
            onOriginal={(on) => stems.setOriginal(project.id, on)}
          />
        </>
      )}
    </Section>
  )
}

/** Clicks this soon after the button changed meaning are ignored. */
const DOUBLE_CLICK_MS = 400

/**
 * Where the cleaned voice stands. The one action button stays the same element whatever it does
 * (Cancel, Clean now, Try again, Hear the original), so the keyboard focus stays on it when the
 * state changes under it.
 */
function VoiceStatus(props: {
  state: VoiceStemState
  original: boolean
  onCancel: () => void
  onClean: () => void
  onOriginal: (on: boolean) => void
}): JSX.Element {
  const { state, original } = props
  const percent = state.state === 'working' ? Math.round(state.progress * 100) : 0
  const text =
    state.state === 'ready'
      ? original
        ? VOICE_COPY.playingOriginal
        : VOICE_COPY.ready
      : state.state === 'working'
        ? VOICE_COPY.working(percent)
        : state.state === 'stopped'
          ? VOICE_COPY.stopped
          : state.state === 'failed'
            ? `${VOICE_COPY.failed} ${state.message}`
            : VOICE_COPY.checking
  const action =
    state.state === 'working'
      ? { label: VOICE_COPY.cancel, run: props.onCancel }
      : state.state === 'stopped' || state.state === 'missing'
        ? { label: VOICE_COPY.cleanNow, run: props.onClean }
        : state.state === 'failed'
          ? { label: VOICE_COPY.tryAgain, run: props.onClean }
          : state.state === 'ready'
            ? { label: VOICE_COPY.original, run: () => props.onOriginal(!original) }
            : null
  // The button changes meaning under the pointer (Clean now → Cancel): a double click must not undo its first click.
  const changedAt = useRef(0)
  useEffect(() => {
    changedAt.current = performance.now()
  }, [state.state])
  // Screen readers hear each change of state, not every step of the percentage (that is on the bar).
  const spoken = state.state === 'working' ? VOICE_COPY.cleaning : text
  return (
    <div className={`voice-status ${state.state}`} data-testid="voice-status" data-state={state.state}>
      <p className={`hint ${state.state === 'failed' ? 'error' : ''}`} aria-hidden="true">
        {text}
      </p>
      <span className="sr-only" role="status" aria-live="polite">
        {spoken}
      </span>
      {state.state === 'working' && (
        <div className="voice-bar" role="progressbar" aria-label={VOICE_COPY.toggle} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {action && (
        <button
          type="button"
          className={`btn voice-action ${state.state === 'ready' && original ? 'active' : ''}`}
          aria-pressed={state.state === 'ready' ? original : undefined}
          onClick={() => {
            if (performance.now() - changedAt.current >= DOUBLE_CLICK_MS) action.run()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
