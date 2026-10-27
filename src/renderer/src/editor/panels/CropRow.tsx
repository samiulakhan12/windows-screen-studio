import { withShortcut } from '../../../../shared/editor/shortcuts'
import { cropOf, visibleSize } from '../../../../shared/engine/crop'
import type { Project } from '../../../../shared/types'
import { useKeymap } from '../keymapContext'
import '../crop.css'

type Props = { project: Project; onCrop: (action: 'edit' | 'reset') => void }

/**
 * Style › Frame, in the section's header: opens the crop tool on a recording without a crop (it
 * takes no room, so the panel below stays where it was). Null once the recording is cropped.
 */
export function CropLink({ project, onCrop }: Props): JSX.Element | null {
  const keymap = useKeymap()
  if (cropOf(project)) return null
  return (
    <button
      className="link small"
      title={withShortcut('Choose the part of the recording to show: hide the taskbar, browser tabs or an edge', keymap.cropRecording)}
      onClick={() => onCrop('edit')}
      data-testid="crop-open"
    >
      Crop recording…
    </button>
  )
}

/** Style › Frame, under the aspect ratio: the crop's size of the whole recording, with Edit and Reset. Null without a crop. */
export function CropRow({ project, onCrop }: Props): JSX.Element | null {
  const keymap = useKeymap()
  if (!cropOf(project)) return null
  const shown = visibleSize(project)
  return (
    <div className="crop-row" data-testid="crop-row">
      <div className="row">
        <span className="field-label">Crop</span>
        <div className="crop-row-actions">
          <button className="btn small" title={withShortcut('Change the crop', keymap.cropRecording)} onClick={() => onCrop('edit')} data-testid="crop-edit">
            Edit…
          </button>
          <button className="btn small ghost" title="Show the whole recording" onClick={() => onCrop('reset')} data-testid="crop-row-reset">
            Reset
          </button>
        </div>
      </div>
      <p className="hint">
        <strong>
          {shown.width} × {shown.height}
        </strong>{' '}
        of {project.width} × {project.height}
      </p>
    </div>
  )
}
