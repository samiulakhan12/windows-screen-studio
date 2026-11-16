/**
 * Zoom tab: "Show a detail larger without zooming:" with Add magnifier, because users look for it
 * there (docs/design/editing-polish.md §2.2). It runs the same command as the Shapes tab's button.
 */
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { useGroup } from '../groupContext'
import { useKeymap } from '../keymapContext'
import { ShapeIcon } from '../shapeIcons'
import './magnifier.css'
import { t } from '../../../../shared/i18n/t'

export function MagnifierZoomRow(): JSX.Element {
  const group = useGroup()
  const keymap = useKeymap()
  return (
    <div className="magnifier-zoom-row" data-testid="zoom-add-magnifier">
      <span>{t('zoom.magnifierZoomRow.showADetailLarger')}</span>
      <button type="button" className="btn small" title={withShortcut(t('zoom.magnifierZoomRow.addTitle'), keymap.addMagnifier)} onClick={() => group.command('addMagnifier')}>
        <ShapeIcon name="magnifier" size={16} /> {t('zoom.magnifierZoomRow.addMagnifier')}
      </button>
    </div>
  )
}
