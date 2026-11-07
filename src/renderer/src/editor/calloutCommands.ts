/**
 * The commands Add step badge and Add speech bubble (docs/design/editing-polish.md §2.3, §2.8): the
 * palette's, the Text tab's buttons and any key a user gives them run these. A badge lands beside
 * the cursor when it shows at the playhead (else at the centre of what the preview shows), a
 * bubble's tail on the cursor; each is selected, and a bubble's text field takes focus. One undo
 * step each.
 */
import { addBadge, addBubble, badgeLanguage, badgeSpot, bubbleSpot, movePin } from '../../../shared/editor/calloutsEdit'
import { displayTime } from '../../../shared/editor/clips'
import type { EditStore } from '../../../shared/editor/editStore'
import { cropOf, cropProject, cropTrack, fromCrop } from '../../../shared/engine/crop'
import type { CursorTrack, Project } from '../../../shared/types'
import type { RenderScene } from '../render/compositor'
import { calloutMapping, shownAt } from './calloutView'
import { cursorPosFor } from './playheadItems'
import type { Selection } from './selection'

export interface CalloutCommandDeps {
  store: EditStore<Project>
  player: { time: number }
  cursor: CursorTrack
  /** The editor's scene now (the drawn project and its crop). */
  scene: () => RenderScene
  select: (sel: Selection) => void
  /** Shows the Text tab. */
  reveal: () => void
}

/** Where the cursor shows at `t`, in the whole recording (null when it does not show there). */
function cursorAt(p: Project, cursor: CursorTrack, t: number): { x: number; y: number } | null {
  if (!cursor.valid) return null
  const crop = cropOf(p)
  const at = cursorPosFor(cropProject(p), cropTrack(cursor, crop), t)
  return at ? fromCrop(crop, at) : null
}

/** Focuses the selected text's field once the Text tab shows it (a new bubble's text is typed at once). */
function focusTextField(): void {
  if (typeof requestAnimationFrame === 'undefined') return
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.insp-body textarea.text-field')?.focus()))
}

export function calloutCommands(deps: CalloutCommandDeps): { addStepBadge: () => void; addSpeechBubble: () => void } {
  const add = (kind: 'badge' | 'bubble'): void => {
    const p = deps.store.state
    const t = displayTime(p.clips, deps.player.time)
    const scene = deps.scene()
    const { view } = calloutMapping(scene, t)
    const cursor = cursorAt(p, deps.cursor, t)
    let id = ''
    deps.store.update((q) => {
      if (kind === 'badge') {
        const spot = badgeSpot(view, cursor)
        const r = addBadge(q, t, spot, badgeLanguage(q))
        id = r.id
        // Where it shows at its own start (one entrance before the playhead): what an older Flown draws at (§4.5).
        const a = r.project.annotations.find((x) => x.id === id)!
        return movePin(r.project, id, spot.pin, shownAt(scene, a.start, spot.pin))
      }
      const r = addBubble(q, t, bubbleSpot(view, cursor))
      id = r.id
      return r.project
    })
    deps.select({ kind: 'annotation', id })
    deps.reveal()
    if (kind === 'bubble') focusTextField()
  }
  return { addStepBadge: () => add('badge'), addSpeechBubble: () => add('bubble') }
}
