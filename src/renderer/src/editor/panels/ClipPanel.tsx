import { setRangeSpeed, timelineGaps, type Gap } from '../../../../shared/editor/clips'
import { outputDuration, SPEED_PRESETS } from '../../../../shared/engine/timeline'
import { formatTime } from '../../../../shared/engine/project'
import { useEditor } from '../context'
import { Chips, Section } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'

const GAP_TITLE: Record<Gap['kind'], string> = { 'trim-start': 'Trimmed start', cut: 'Cut', 'trim-end': 'Trimmed end' }

/* ---------- Clip (cuts, trims, speed) ---------- */

export function ClipPanel(props: InspectorProps): JSX.Element {
  const { store } = useEditor()
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
          <button className="btn ghost danger" disabled={clips.length <= 1} onClick={() => props.onDeleteClip(clip.id)} title={clips.length <= 1 ? 'The last clip cannot be removed' : 'Cut this clip out of the video (Delete)'}>
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
          <button className="btn" onClick={() => props.onCutRange(selection.start, selection.end)}>
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
          <button className="btn" onClick={props.onSplit}>
            <EditorIcon name="split" size={16} /> Split at playhead
          </button>
          <p className="hint">
            Press <kbd>S</kbd> to split at the playhead, select a clip and press <kbd>Delete</kbd> to cut it, or <kbd>Shift</kbd>+drag on the clip track to select a range. Drag the yellow handles to trim.
          </p>
        </Section>
      )}
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
