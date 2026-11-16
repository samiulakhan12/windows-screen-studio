/**
 * Camera tab: Colour, with Auto colour (docs/design/editing-polish.md §2.5): eight looks, the
 * sliders with Exposure, a LUT, Compare, Reset colour and Auto colour. Shown with a camera.
 */
import type { Project } from '../../../../shared/types'
import { Section } from '../controls'
import { ColourControls } from './ColourControls'
import { t } from '../../../../shared/i18n/t'

export function CameraColourSection(props: { project: Project }): JSX.Element | null {
  if (!props.project.hasWebcam) return null
  return (
    <Section title={t('common.label.colour')}>
      <div data-testid="camera-colour-section">
        <ColourControls project={props.project} which="camera" />
      </div>
    </Section>
  )
}
