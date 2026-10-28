/**
 * The Inspector's item lists as a way to select several items (E-06, docs/design/multi-select.md
 * §4.7): Ctrl+click (or Ctrl+Space / Ctrl+Enter on a focused row) adds or leaves out a row's item,
 * Shift+click (or Shift+Enter) adds the run from the anchor, a plain click works as before. A list
 * toggle never opens the Selection view, so the keyboard stays on the row.
 */
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { extendTo, projectItems, toggleKey, type ItemKey } from '../../../shared/editor/multiSelect'
import { useEditor } from './context'
import { useGroup } from './groupContext'

export interface ListRowProps {
  'aria-pressed': boolean | undefined
  onClick: (e: ReactMouseEvent) => void
  onKeyDown: (e: ReactKeyboardEvent) => void
}

/** Row props for a list of items: `plain` is what a click without a modifier does there today. */
export function useListSelect(): { member: (key: ItemKey) => boolean; row: (key: ItemKey, plain: () => void, active?: boolean) => ListRowProps; selectAll: (keys: readonly ItemKey[]) => void } {
  const { store } = useEditor()
  const group = useGroup()
  const toggle = (key: ItemKey): void => {
    const r = toggleKey(group.group.keys, group.single, key, group.group.anchor)
    group.select(r.keys, r.anchor, { reveal: false })
  }
  const extend = (key: ItemKey): void => {
    const r = extendTo(group.group.keys, group.group.anchor, group.single, key, projectItems(store.state))
    group.select(r.keys, r.anchor, { reveal: false })
  }
  return {
    member: (key) => group.keys.has(key),
    row: (key, plain, active) => ({
      // Pressed for a member of the group (or the single selected item, as the lists showed it before).
      'aria-pressed': group.keys.has(key) ? true : active ? true : group.group.keys.length ? false : undefined,
      onClick: (e) => {
        if (e.ctrlKey || e.metaKey) toggle(key)
        else if (e.shiftKey) extend(key)
        else plain()
      },
      onKeyDown: (e) => {
        const toggling = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === ' ' || e.key === 'Enter')
        const extending = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Enter'
        if (!toggling && !extending) return
        e.preventDefault()
        e.stopPropagation()
        if (toggling) toggle(key)
        else extend(key)
      }
    }),
    selectAll: (keys) => group.select(keys, keys[0] ?? null)
  }
}
