import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setRangeSpeed, timelineGaps, type Gap } from '../../../../shared/editor/clips'
import type { EditStore } from '../../../../shared/editor/editStore'
import { shortcutLabel, withShortcut } from '../../../../shared/editor/shortcuts'
import {
  applySmartSpeed,
  DEFAULT_MIN_IDLE,
  inputGaps,
  MIN_IDLE_CHOICES,
  planSmartSpeed,
  SMART_SPEED_ACTIONS,
  STILL_DETECT_MIN,
  type SmartSpeedAction,
  type TimeRange
} from '../../../../shared/editor/smartSpeed'
import { formatTime } from '../../../../shared/engine/project'
import { outputDuration, SPEED_PRESETS } from '../../../../shared/engine/timeline'
import type { Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { Chips, Section } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { FirstShortcut } from '../ShortcutKeys'
import './clipPanel.css'

const GAP_TITLE: Record<Gap['kind'], string> = { 'trim-start': 'Trimmed start', cut: 'Cut', 'trim-end': 'Trimmed end' }

/* ---------- Clip (cuts, trims, speed) ---------- */

export function ClipPanel(props: InspectorProps): JSX.Element {
  const { store } = useEditor()
  const { project, selection, keymap } = props
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
            title={clips.length <= 1 ? 'The last clip cannot be removed' : withShortcut('Cut this clip out of the video', keymap?.deleteSelection)}
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
          <button className="btn" onClick={() => props.onCutRange(selection.start, selection.end)} title={withShortcut('Cut this range out of the video', keymap?.deleteSelection)}>
            <EditorIcon name="scissors" size={16} /> Cut range
          </button>
          <span className="field-label">
            <EditorIcon name="speed" size={14} /> Speed up or slow down this range
          </span>
          <Chips
            label="Range speed"
            value={null}
            onChange={(s) => {
              store.update((p) => ({ ...p, clips: setRangeSpeed(p.clips, selection.start, selection.end, s) }))
              props.onSelect(null)
            }}
            options={SPEED_PRESETS.map((s) => ({ value: s, label: `${s}×` }))}
          />
        </Section>
      ) : (
        <Section title="Edit">
          <button className="btn" onClick={props.onSplit} title={withShortcut('Split the clip at the playhead', keymap?.split)}>
            <EditorIcon name="split" size={16} /> Split at playhead
          </button>
          <p className="hint">
            {keymap?.split.length ? (
              <>
                Press <FirstShortcut accelerators={keymap.split} fallback="" /> to split at the playhead,
              </>
            ) : (
              'Split at the playhead,'
            )}{' '}
            select a clip and press <FirstShortcut accelerators={keymap?.deleteSelection ?? ['Delete']} fallback="Delete clip" /> to cut it, or <kbd>Shift</kbd>+drag on the clip
            track to select a range. Drag the yellow handles to trim.
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
 * Still-picture analysis of the open recording, kept for the editor session (keyed by its
 * store) so switching tabs never runs it again; also which smart speed request was handled.
 */
interface Analysis {
  still: TimeRange[] | null
  pending: Promise<TimeRange[]> | null
  request: number
}
const analyses = new WeakMap<EditStore<Project>, Analysis>()
/** The last choices, kept while the app runs. */
let lastChoice: { minIdle: number; action: SmartSpeedAction } = { minIdle: DEFAULT_MIN_IDLE, action: 4 }

const ACTION_LABEL: Record<string, string> = { 2: '2×', 4: '4×', 8: '8×', cut: 'Cut' }
const ACTION_TITLE: Record<string, string> = {
  2: 'Play idle parts twice as fast',
  4: 'Play idle parts four times as fast',
  8: 'Play idle parts eight times as fast',
  cut: 'Remove idle parts from the video'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const seconds = (s: number): string => (s < 60 ? `${s.toFixed(1)} s` : formatTime(s))
const partKey = (r: TimeRange): string => `${r.start.toFixed(3)}:${r.end.toFixed(3)}`

function SmartSpeed(props: InspectorProps): JSX.Element {
  const { store, player } = useEditor()
  const { project, cursor, onSelect, onNotice, keymap } = props
  const analysis = useMemo<Analysis>(() => {
    let a = analyses.get(store)
    if (!a) analyses.set(store, (a = { still: null, pending: null, request: 0 }))
    return a
  }, [store])
  const [minIdle, setMinIdle] = useState(lastChoice.minIdle)
  const [action, setAction] = useState<SmartSpeedAction>(lastChoice.action)
  const [still, setStill] = useState<TimeRange[] | null>(analysis.still)
  const [busy, setBusy] = useState(false)
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
  const find = useCallback(
    async (): Promise<void> => {
      setBusy(true)
      analysis.pending ??= window.api.detectStill(projectId, STILL_DETECT_MIN).finally(() => {
        analysis.pending = null
      })
      try {
        const ranges = await analysis.pending
        analysis.still = ranges
        if (!alive.current) return
        setStill(ranges)
        setSkipped(new Set())
      } catch {
        if (alive.current) onNotice('The recording could not be analysed')
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [analysis, projectId, onNotice]
  )

  // An analysis started before switching tabs: wait for it here.
  useEffect(() => {
    if (analysis.pending && !analysis.still) void find()
  }, [analysis, find])

  // The smart speed command: show this section and look for idle parts if not done yet.
  const request = props.smartSpeedRequest ?? 0
  useEffect(() => {
    if (!request || analysis.request === request) return
    analysis.request = request
    boxRef.current?.scrollIntoView({ block: 'nearest' })
    if (!analysis.still && !analysis.pending) void find()
  }, [request, analysis, find])

  // Input stretches depend on the recording only: worked out once, after the first analysis,
  // so edits (a trim drag) only redo the cheap part below.
  const analysed = still !== null
  const inactive = useMemo(() => (analysed ? inputGaps(cursor, project.duration) : null), [analysed, cursor, project.duration])
  const plan = useMemo(
    () => (still ? planSmartSpeed({ still, inactive, clips: project.clips, duration: project.duration }, minIdle, action) : null),
    [still, inactive, project.clips, project.duration, minIdle, action]
  )
  const chosen = plan ? plan.parts.filter((p) => !skipped.has(partKey(p))) : []
  const saved = chosen.reduce((s, p) => s + p.saved, 0)

  const choose = (patch: Partial<typeof lastChoice>): void => {
    lastChoice = { ...lastChoice, ...patch }
    if (patch.minIdle !== undefined) setMinIdle(patch.minIdle)
    if (patch.action !== undefined) setAction(patch.action)
  }

  const apply = (): void => {
    if (!chosen.length) return
    const before = outputDuration(store.state.clips)
    store.update((p) => ({ ...p, clips: applySmartSpeed(p.clips, chosen, action) }))
    const shorter = before - outputDuration(store.state.clips)
    onSelect(null)
    const undo = keymap?.undo[0] ? ` · ${shortcutLabel(keymap.undo[0])} to undo` : ''
    const what = action === 'cut' ? `Cut ${plural(chosen.length, 'idle part')}` : `Sped up ${plural(chosen.length, 'idle part')} ${action}×`
    onNotice(`${what}: the video is ${seconds(shorter)} shorter${undo}`)
  }

  return (
    <div className="smart-speed" ref={boxRef} data-testid="smart-speed">
      <Section title="Smart speed">
        <p className="hint">Speeds up or cuts the parts where nothing happens: the picture stays still and the mouse and keyboard rest.</p>
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
        {!plan ? (
          <button className="btn" onClick={() => void find()} disabled={busy}>
            {busy ? (
              <>
                <span className="smart-spinner" aria-hidden="true" /> Looking for idle parts…
              </>
            ) : (
              <>
                <EditorIcon name="sparkle" size={16} /> Find idle parts
              </>
            )}
          </button>
        ) : (
          <>
            <p className="smart-summary" role="status">
              {plan.parts.length === 0 ? (
                `No idle parts of ${minIdle} s or more${action === 'cut' ? '' : ' to speed up'}.`
              ) : (
                <>
                  <strong>{plural(chosen.length, 'idle part')}</strong>
                  {chosen.length < plan.parts.length && ` of ${plan.parts.length}`} · saves <strong>{seconds(saved)}</strong>
                </>
              )}
            </p>
            {plan.parts.length > 0 && (
              <ul className="smart-list" aria-label="Idle parts">
                {plan.parts.map((p) => {
                  const key = partKey(p)
                  const on = !skipped.has(key)
                  const range = `${formatTime(p.start)} – ${formatTime(p.end)}`
                  return (
                    <li key={key} className={on ? '' : 'skipped'}>
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`Include ${range}`}
                        onChange={(e) => {
                          const next = new Set(skipped)
                          if (e.target.checked) next.delete(key)
                          else next.add(key)
                          setSkipped(next)
                        }}
                      />
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
                        {(p.end - p.start).toFixed(1)} s<span className="muted"> · −{seconds(p.saved)}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            {plan.parts.length > 0 && (
              <button className="btn primary" disabled={!chosen.length} onClick={apply}>
                <EditorIcon name="speed" size={16} /> {action === 'cut' ? `Cut ${plural(chosen.length, 'part')}` : `Speed up ${plural(chosen.length, 'part')} ${action}×`}
              </button>
            )}
          </>
        )}
      </Section>
    </div>
  )
}
