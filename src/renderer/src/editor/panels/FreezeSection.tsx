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
import { outputDuration } from '../../../../shared/engine/timeline'
import { fmt } from '../../../../shared/i18n/fmt'
import type { Freeze, FreezeSound, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { addFreezeAt, addTextOnFreeze } from '../freezeItems'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import { LookButtons } from '../LookButtons'
import { t } from '../../../../shared/i18n/t'

const seconds = (v: number): string => t('style.freezeSection.seconds', { n: fmt.number(v, { max: 1 }) })

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
    <Section title={t('style.freezeSection.freezeFrame')}>
      <button
        className="btn"
        disabled={!!refusal}
        title={refusal ? FREEZE_REFUSAL_TEXT[refusal] : withShortcut(t('style.freezeSection.holdTitle'), keymap.freezeFrame)}
        onClick={() => addFreezeAt(services, { onSelect, onNotice })}
      >
        <Icon name="pause" size={16} /> {t('style.freezeSection.freezeFrameAtPlayhead')}
      </button>
      <p className="hint">{t('style.freezeSection.holdsThePictureSo')}</p>
    </Section>
  )
}

/** The hint under the sound choice: what the freeze does to the video now. */
function freezeHint(project: Project, f: Freeze): string {
  const { clips } = project
  const plan = planOf(project)
  if (plan.holds.some((h) => h.id === f.id)) return t('style.freezeSection.hint.adds', { length: seconds(f.length), now: fmt.clock(videoDuration(clips, plan)) })
  const still = plan.stills.find((s) => s.id === f.id)
  if (!still) {
    const why = freezeInactiveReason(project, f)
    if (why === 'cut') return t('style.freezeSection.hint.cut')
    if (why === 'next') return t('style.freezeSection.hint.next')
    return atEditEnd(clips, f.at) ? t('style.freezeSection.hint.afterEnd') : t('style.freezeSection.hint.end')
  }
  const held = still.editEnd - still.editStart
  if (held >= f.length - 1e-6) return t('style.freezeSection.hint.holds', { length: seconds(f.length) })
  return still.editEnd >= outputDuration(clips) - 1e-6 ? t('style.freezeSection.hint.heldToEnd', { length: seconds(held) }) : t('style.freezeSection.hint.heldToNext', { length: seconds(held) })
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
    <Section title={t('style.freezeSection.freezeFrameAt', { time: fmt.clock(freezeVideoTime(project, f)) })}>
      <Slider
        label={t('style.freezeSection.holdFor')}
        value={f.length}
        min={FREEZE.min}
        max={FREEZE.max}
        step={FREEZE.step}
        format={seconds}
        onChange={(v) => store.update((p) => setFreezeLength(p, f.id, v), `freeze-length:${f.id}`)}
      />
      <span className="field-label">{t('common.label.sound')}</span>
      <div data-testid="freeze-sound">
        <Chips
          label={t('style.freezeSection.freezeFrameSound')}
          value={f.sound}
          onChange={setSound}
          options={[
            { value: 'pause', label: t('style.freezeSection.sound.pause'), title: t('style.freezeSection.sound.pause.title') },
            {
              value: 'continue',
              label: t('style.freezeSection.sound.continue'),
              title: atEnd ? t('style.freezeSection.sound.continue.atEnd') : t('style.freezeSection.sound.continue.title'),
              disabled: atEnd
            }
          ]}
        />
      </div>
      <p className="hint" data-testid="freeze-hint">
        {freezeHint(project, f)}
      </p>
      <LookButtons itemKey={`freeze:${f.id}`} />
      <div className="row start">
        <button className="btn" disabled={!active} onClick={() => addTextOnFreeze(services, f, onSelect)} title={t('style.freezeSection.aTextThatShows')}>
          <EditorIcon name="text" size={16} /> {t('style.freezeSection.addTextOnThe')}
        </button>
        <button
          className="btn ghost danger"
          onClick={() => {
            store.update((p) => removeFreeze(p, f.id))
            onSelect(null)
          }}
          title={withShortcut(t('style.freezeSection.removeTitle'), keymap.deleteSelection)}
        >{t('style.freezeSection.deleteFreeze')}</button>
      </div>
    </Section>
  )
}
