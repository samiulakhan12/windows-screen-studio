import { useEffect } from 'react'
import type { EditStore } from '../../../shared/editor/editStore'
import type { Project } from '../../../shared/types'
import { momentOpening } from '../../../shared/search/moment'
import type { PreviewPlayer } from '../editor/player'
import { takePendingMoment } from './openAt'

/**
 * Opens the editor at the moment picked in Home's search, once: a seek, not an edit (no undo step).
 * A moment that starts in a cut goes to the next part that is kept (else the end), with a notice when
 * none of it is (docs/design/search.md §2.10).
 */
export function useSearchMoment(store: EditStore<Project>, player: PreviewPlayer, notice: (text: string) => void): void {
  useEffect(() => {
    const moment = takePendingMoment(store.state.id)
    if (moment === null) return
    const opening = momentOpening(store.state.clips, moment)
    player.seek(opening.t)
    if (opening.notice) notice(opening.notice)
    // Once per session: the store and player of an editor never change.
  }, [store, player])
}
