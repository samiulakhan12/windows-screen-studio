import { lookClassOf, lookLabel } from '../../../shared/editor/groupEdit'
import type { ItemKey } from '../../../shared/editor/multiSelect'
import { commandKeys, shortcutLabel, withShortcut } from '../../../shared/editor/shortcuts'
import { useEditor } from './context'
import { useGroup } from './groupContext'
import { useLookClipboard } from './itemClipboard'
import { useKeymap } from './keymapContext'
import { t } from '../../../shared/i18n/t'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'

/**
 * Copy look / Paste look for one selected item (E-06, docs/design/multi-select.md §4.12): they run
 * the same commands as Ctrl+Shift+C and Ctrl+Shift+V. Paste look says what it holds, and is off for
 * an item of another kind.
 */
export function LookButtons({ itemKey }: { itemKey: ItemKey }): JSX.Element | null {
  const { store } = useEditor()
  const group = useGroup()
  const keymap = useKeymap()
  const look = useLookClipboard()
  const cls = lookClassOf(store.state, itemKey)
  if (!cls) return null
  const pasteKeys = commandKeys(keymap, 'pasteLook')
  const why = !look ? t('style.lookButtons.copyFirst') : look.cls !== cls ? (look.cls === 'cover' ? t(PRIVACY_COPY.cover.lookFor) : t('style.lookButtons.copiedLookFor', { cls: look.cls })) : null
  const pasteTitle = look && !why ? (pasteKeys[0] ? t('style.lookButtons.pasteLookKeys', { look: lookLabel(look), keys: shortcutLabel(pasteKeys[0]) }) : t('style.lookButtons.pasteLookOf', { look: lookLabel(look) })) : why!
  return (
    <div className="look-buttons" role="group" aria-label={t('common.label.look')}>
      <button className="btn" onClick={() => group.command('copyLook')} title={withShortcut(t('style.lookButtons.copyThisLook'), commandKeys(keymap, 'copyLook'))}>{t('style.lookButtons.copyLook')}</button>
      <button className="btn" data-testid="paste-look" disabled={!!why} onClick={() => group.command('pasteLook')} title={pasteTitle}>{t('style.lookButtons.pasteLook')}</button>
    </div>
  )
}
