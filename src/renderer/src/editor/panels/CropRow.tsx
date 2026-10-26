import { withShortcut } from '../../../../shared/editor/shortcuts'
import { cropOf, visibleSize } from '../../../../shared/engine/crop'
import type { Project } from '../../../../shared/types'
import { useKeymap } from '../keymapContext'
import '../crop.css'

/**
 * Style › Frame: the recording's crop. Uncropped, a button that opens the crop tool on the
 * preview; cropped, the size shown of the whole, with Edit and Reset.
 */
export function CropRow({ project, onCrop }: { project: Project; onCrop: (action: 'edit' | 'reset') => void }): JSX.Element {
  const keymap = useKeymap()
  if (!cropOf(project)) {
    return (
      <div className="crop-row" data-testid="crop-row">
        <div className="row">
          <span className="field-label">Crop</span>
          <button className="btn small" title={withShortcut('Choose the part of the recording to show', keymap.cropRecording)} onClick={() => onCrop('edit')} data-testid="crop-open">
            Crop recording…
          </button>
        </div>
        <p className="hint">Hide the taskbar, browser tabs or an edge.</p>
      </div>
    )
  }
  const shown = visibleSize(project)
  return (
    <div className="crop-row" data-testid="crop-row">
      <div className="row">
        <span className="field-label">Crop</span>
        <div className="crop-row-actions">
          <button className="btn small" title={withShortcut('Change the crop', keymap.cropRecording)} onClick={() => onCrop('edit')} data-testid="crop-open">
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
