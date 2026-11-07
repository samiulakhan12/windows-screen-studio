/**
 * Effects tab: Calm motion (docs/design/editing-polish.md §7.5): texts, shapes, title cards, the
 * magnifier and slide cuts move less. It is the project's choice, never read from Windows'
 * animation setting, so the same project exports the same motion on every PC. One update.
 */
import { withCalm } from '../../../../shared/editor/calloutsEdit'
import { calmOf } from '../../../../shared/render/calloutData'
import type { Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { Section } from '../controls'
import { SwitchRow } from './calloutControls'
import './callouts.css'

export const CALM_HINT = 'Calm motion: texts, shapes, the magnifier and slide cuts move less. Captions have their own setting in the Captions tab.'

export function CalmMotionRow(props: { project: Project }): JSX.Element | null {
  const { store } = useEditor()
  return (
    <Section title="Calm motion">
      <SwitchRow id="calm-motion" label="Calm motion" checked={calmOf(props.project.effects)} hint={CALM_HINT} onChange={(on) => store.update((p) => withCalm(p, on))} />
    </Section>
  )
}
