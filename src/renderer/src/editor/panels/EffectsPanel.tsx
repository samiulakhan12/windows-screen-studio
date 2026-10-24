import { LOOK_LIMITS } from '../../../../shared/editor/styleDefaults'
import type { CursorTrack, Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'

const L = LOOK_LIMITS

/* ---------- Effects ---------- */

export function EffectsPanel({ project, cursor }: { project: Project; cursor: CursorTrack }): JSX.Element {
  const { store } = useEditor()
  const { effects } = project
  const keys = cursor.keys?.length ?? 0
  const setKeys = (patch: Partial<Project['effects']['keystrokes']>, key?: string): void =>
    store.update((p) => ({ ...p, effects: { ...p.effects, keystrokes: { ...p.effects.keystrokes, ...patch } } }), key)
  return (
    <>
      <Section title="Motion blur">
        <Slider
          label="Strength"
          value={effects.motionBlur}
          {...L.motionBlur}
          step={0.05}
          format={(v) => (v === 0 ? 'Off' : pctFmt(v))}
          onChange={(v) => store.update((p) => ({ ...p, effects: { ...p.effects, motionBlur: v } }), 'effects.motionBlur')}
        />
        <p className="hint">Blurs fast zoom and pan movements, like a real camera.</p>
      </Section>
      <Section title="Keyboard shortcuts">
        <p className="hint">
          {keys > 0 ? `${keys} shortcut${keys === 1 ? '' : 's'} recorded (plain typing is never recorded).` : 'No keyboard shortcuts were recorded in this video.'}
        </p>
        <Toggle label="Show shortcuts on screen" checked={effects.keystrokes.show} onChange={(v) => setKeys({ show: v })} />
        <Chips
          label="Shortcut position"
          value={effects.keystrokes.position}
          disabled={!effects.keystrokes.show}
          onChange={(position) => setKeys({ position })}
          options={[
            { value: 'bottom', label: 'Bottom' },
            { value: 'top', label: 'Top' }
          ]}
        />
        <Slider label="Size" value={effects.keystrokes.size} {...L.keystrokeSize} step={0.001} format={(v) => `${Math.round(v * 1000) / 10}%`} disabled={!effects.keystrokes.show} onChange={(v) => setKeys({ size: v }, 'effects.keys.size')} />
      </Section>
    </>
  )
}
