import type { Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { pctFmt, Section, Slider, Toggle } from '../controls'

/* ---------- Audio ---------- */

export function AudioPanel({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  const { audio } = project
  const set = (patch: Partial<Project['audio']>, key?: string): void => store.update((p) => ({ ...p, audio: { ...p.audio, ...patch } }), key)
  return (
    <>
      {!project.hasAudio && <p className="hint">This recording has no audio track.</p>}
      <Section title="Audio">
        <Toggle label="Mute" checked={audio.muted} disabled={!project.hasAudio} onChange={(v) => set({ muted: v })} />
        <Slider
          label="Volume"
          value={audio.volume}
          min={0}
          max={2}
          step={0.05}
          format={pctFmt}
          disabled={!project.hasAudio || audio.muted}
          onChange={(v) => set({ volume: v }, 'audio.volume')}
        />
        <p className="hint">Applies to the preview and the exported video. Sped-up clips keep their pitch.</p>
      </Section>
    </>
  )
}
