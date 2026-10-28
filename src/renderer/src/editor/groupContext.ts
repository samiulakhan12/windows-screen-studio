/**
 * The selected group of items (E-06, docs/design/multi-select.md §9.3), for the components that
 * read it: the timeline's tracks, the Inspector and the preview. The editor provides it; without a
 * provider the default is an empty group whose select and notice do nothing, so every component
 * behaves exactly as before.
 */
import { createContext, useContext } from 'react'
import type { CommandId } from '../../../shared/editor/commands'
import { NO_GROUP, type ItemGroup, type ItemKey } from '../../../shared/editor/multiSelect'

export interface GroupApi {
  /** NO_GROUP below two items. */
  readonly group: ItemGroup
  /** The group's keys; the same Set while the group is unchanged. */
  readonly keys: ReadonlySet<string>
  /** The single selection's key when it can join a group. */
  readonly single: ItemKey | null
  /**
   * Selects `keys` (the editor's selectKeys): none clears, one is the single selection, two or more
   * a group. `reveal: false` keeps the Inspector on what it shows (list rows, the Selection view's own buttons).
   */
  select(keys: readonly ItemKey[], anchor: ItemKey | null, opts?: { reveal?: boolean }): void
  /** Shows a notice in the transport's live region. */
  notice(message: string): void
  /** Runs an editor command (the look buttons and the Selection view run the same handlers as the keys). */
  command(id: CommandId): void
}

const NO_KEYS: ReadonlySet<string> = new Set()

export const NO_GROUP_API: GroupApi = Object.freeze({
  group: NO_GROUP,
  keys: NO_KEYS,
  single: null,
  select: () => undefined,
  notice: () => undefined,
  command: () => undefined
})

export const GroupContext = createContext<GroupApi>(NO_GROUP_API)

export function useGroup(): GroupApi {
  return useContext(GroupContext)
}
