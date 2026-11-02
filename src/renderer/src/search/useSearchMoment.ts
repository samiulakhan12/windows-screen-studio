import { useEffect } from 'react'
import type { EditStore } from '../../../shared/editor/editStore'
import type { Project } from '../../../shared/types'
import { momentTarget } from '../../../shared/search/moment'
import type { PreviewPlayer } from '../editor/player'
import { takePendingMoment } from './openAt'

/** Said in the editor when the moment opened from search was cut (docs/design/search.md §5). */
export const CUT_MOMENT_NOTICE = 'That moment was cut from the video, so the editor is at the next part that is kept.'

/**
 * Opens the editor at the moment picked in Home's search, once: a seek, not an edit (no undo step).
 * A moment that starts in a cut goes to the next part that is kept, with a notice when none of it is.
 */
export function useSearchMoment(store: EditStore<Project>, player: PreviewPlayer, notice: (text: string) => void): void {
  useEffect(() => {
    const moment = takePendingMoment(store.state.id)
    if (moment === null) return
    const target = momentTarget(store.state.clips, moment.t, moment.end)
    player.seek(target.t)
    if (target.cut) notice(CUT_MOMENT_NOTICE)
    // Once per session: the store and player of an editor never change.
  }, [store, player])
}
