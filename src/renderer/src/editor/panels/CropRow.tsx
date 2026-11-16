import { withShortcut } from '../../../../shared/editor/shortcuts'
import { cropOf, visibleSize } from '../../../../shared/engine/crop'
import type { Project } from '../../../../shared/types'
import { useKeymap } from '../keymapContext'
import '../crop.css'
import { t } from '../../../../shared/i18n/t'
import { T } from '../../i18n/T'

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
      title={withShortcut(t('style.cropRow.cropTitle'), keymap.cropRecording)}
      onClick={() => onCrop('edit')}
      data-testid="crop-open"
    >{t('style.cropRow.cropRecording')}</button>
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
        <span className="field-label">{t('style.cropRow.crop')}</span>
        <div className="crop-row-actions">
          <button className="btn small" title={withShortcut(t('style.cropRow.changeTheCrop'), keymap.cropRecording)} onClick={() => onCrop('edit')} data-testid="crop-edit">{t('style.cropRow.edit')}</button>
          <button className="btn small ghost" title={t('style.cropRow.showTheWholeRecording')} onClick={() => onCrop('reset')} data-testid="crop-row-reset">{t('common.action.reset')}</button>
        </div>
      </div>
      <p className="hint">
        <T
          k="style.cropRow.sizeOf"
          values={{ width: String(shown.width), height: String(shown.height), fullWidth: String(project.width), fullHeight: String(project.height) }}
          tags={{ b: (c) => <strong>{c}</strong> }}
        />
      </p>
    </div>
  )
}
