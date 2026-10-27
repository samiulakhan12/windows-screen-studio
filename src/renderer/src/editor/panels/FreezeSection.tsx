import { useSyncExternalStore } from 'react'
import {
  atEditEnd,
  freezeInactiveReason,
  FREEZE_REFUSAL_TEXT,
  freezeRefusal,
  freezeVideoTime,
  removeFreeze,
  setFreezeLength,
  setFreezeSound
} from '../../../../shared/editor/freezeEdit'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { FREEZE, planOf, videoDuration } from '../../../../shared/engine/freeze'
import { formatTime } from '../../../../shared/engine/project'
import { outputDuration } from '../../../../shared/engine/timeline'
import type { Freeze, FreezeSound, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { addFreezeAt, addTextOnFreeze } from '../freezeItems'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'

const seconds = (v: number): string => `${v.toFixed(1)} s`

/**
 * Freeze frames in the Clip panel (E-11, docs/design/freeze-frame.md §5): the selected freeze's
 * length, sound and text, or the button that freezes the frame under the playhead.
 */
export function FreezeSection(props: InspectorProps): JSX.Element {
  const { project, selection } = props
  const freeze = selection?.kind === 'freeze' ? project.freezes?.find((f) => f.id === selection.id) : undefined
  return freeze ? <SelectedFreeze {...props} freeze={freeze} /> : <AddFreeze {...props} />
}

function AddFreeze({ project, onSelect, onNotice }: InspectorProps): JSX.Element {
  const services = useEditor()
  const { player } = services
  const keymap = useKeymap()
  // Why the frame under the playhead cannot be frozen (follows the playhead, re-rendering only when that changes).
  const refusal = useSyncExternalStore(player.subscribe, () => freezeRefusal(project, player.time)?.refused ?? null)
  return (
    <Section title="Freeze frame">
      <button
        className="btn"
        disabled={!!refusal}
        title={refusal ? FREEZE_REFUSAL_TEXT[refusal] : withShortcut('Hold the frame under the playhead', keymap.freezeFrame)}
        onClick={() => addFreezeAt(services, { onSelect, onNotice })}
      >
        <Icon name="pause" size={16} /> Freeze frame at playhead
      </button>
      <p className="hint">Holds the picture so viewers can read it.</p>
    </Section>
  )
}

/** The hint under the sound choice: what the freeze does to the video now. */
function freezeHint(project: Project, f: Freeze): string {
  const { clips } = project
  const plan = planOf(project)
  if (plan.holds.some((h) => h.id === f.id)) return `Adds ${seconds(f.length)} to the video (now ${formatTime(videoDuration(clips, plan))}).`
  const still = plan.stills.find((s) => s.id === f.id)
  if (!still) {
    const why = freezeInactiveReason(project, f)
    if (why === 'cut') return 'This frame is cut out of the video, so the freeze is not shown.'
    if (why === 'next') return 'The next freeze starts right after this frame, so the picture is not held.'
    return atEditEnd(clips, f.at) ? 'Nothing plays after the end of the video, so the picture is not held.' : 'The video ends right after this frame, so the picture is not held.'
  }
  const held = still.editEnd - still.editStart
  if (held >= f.length - 1e-6) return `The screen holds for ${seconds(f.length)}. The camera and captions keep moving.`
  const why = still.editEnd >= outputDuration(clips) - 1e-6 ? 'the video ends there' : 'the next freeze starts there'
  return `Holds for ${seconds(held)}: ${why}.`
}

function SelectedFreeze({ project, freeze: f, onSelect }: InspectorProps & { freeze: Freeze }): JSX.Element {
  const services = useEditor()
  const { store } = services
  const keymap = useKeymap()
  const { clips } = project
  const plan = planOf(project)
  const active = !plan.inactive.includes(f.id)
  const atEnd = atEditEnd(clips, f.at)
  const setSound = (sound: FreezeSound): void => store.update((p) => setFreezeSound(p, f.id, sound))
  return (
    <Section title={`Freeze frame at ${formatTime(freezeVideoTime(project, f))}`}>
      <Slider
        label="Hold for"
        value={f.length}
        min={FREEZE.min}
        max={FREEZE.max}
        step={FREEZE.step}
        format={seconds}
        onChange={(v) => store.update((p) => setFreezeLength(p, f.id, v), `freeze-length:${f.id}`)}
      />
      <span className="field-label">Sound</span>
      <div data-testid="freeze-sound">
        <Chips
          label="Freeze frame sound"
          value={f.sound}
          onChange={setSound}
          options={[
            { value: 'pause', label: 'Pause the sound', title: 'Adds the time to the video. The recording waits; music keeps playing.' },
            {
              value: 'continue',
              label: 'Keep the sound playing',
              title: atEnd ? 'Nothing plays after the end of the video' : 'Adds no time. The picture holds while the recording plays on.',
              disabled: atEnd
            }
          ]}
        />
      </div>
      <p className="hint" data-testid="freeze-hint">
        {freezeHint(project, f)}
      </p>
      <div className="row start">
        <button className="btn" disabled={!active} onClick={() => addTextOnFreeze(services, f, onSelect)} title="A text that shows through the whole freeze">
          <EditorIcon name="text" size={16} /> Add text on the freeze
        </button>
        <button
          className="btn ghost danger"
          onClick={() => {
            store.update((p) => removeFreeze(p, f.id))
            onSelect(null)
          }}
          title={withShortcut('Remove this freeze frame', keymap.deleteSelection)}
        >
          Delete freeze
        </button>
      </div>
    </Section>
  )
}
