/**
 * Effects tab: Screen colour (docs/design/editing-polish.md §2.5): looks (None, Natural, Vivid,
 * Mono), the sliders, a LUT, Compare and Reset colour for the recording of the screen. Captions,
 * the background and overlays are never graded.
 */
import type { Project } from '../../../../shared/types'
import { Section } from '../controls'
import { ColourControls } from './ColourControls'

export function ScreenColourSection(props: { project: Project }): JSX.Element {
  return (
    <Section title="Screen colour">
      <div data-testid="screen-colour-section">
        <ColourControls project={props.project} which="screen" />
      </div>
    </Section>
  )
}
