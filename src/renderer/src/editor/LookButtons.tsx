import { LOOK_CLASS_WORDS, lookClassOf, lookLabel } from '../../../shared/editor/groupEdit'
import type { ItemKey } from '../../../shared/editor/multiSelect'
import { commandKeys, shortcutLabel, withShortcut } from '../../../shared/editor/shortcuts'
import { useEditor } from './context'
import { useGroup } from './groupContext'
import { useLookClipboard } from './itemClipboard'
import { useKeymap } from './keymapContext'

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
  const why = !look ? 'Copy a look first: Copy look on one item, then select others' : look.cls !== cls ? `The copied look is for ${LOOK_CLASS_WORDS[look.cls][1]}` : null
  const pasteTitle = look && !why ? `Paste look (${lookLabel(look)})${pasteKeys[0] ? ` · ${shortcutLabel(pasteKeys[0])}` : ''}` : why!
  return (
    <div className="look-buttons" role="group" aria-label="Look">
      <button className="btn" onClick={() => group.command('copyLook')} title={withShortcut("Copy this item's look", commandKeys(keymap, 'copyLook'))}>
        Copy look
      </button>
      <button className="btn" data-testid="paste-look" disabled={!!why} onClick={() => group.command('pasteLook')} title={pasteTitle}>
        Paste look
      </button>
    </div>
  )
}
