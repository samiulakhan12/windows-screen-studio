/**
 * The editor runner's cases of the cover commands (docs/design/auto-blur.md §2.1, §2.2, §2.15):
 * *Add a cover* (also the Private info section's *Add cover* and the *Cover* tool, which run it),
 * *Peek under covers*, and *Start* or *End the selected cover here*. Each edit is one undo step.
 */
import { displayTime } from '../../../shared/editor/clips'
import { addCover, coverBoxAt, coverEndHere, coverStartHere, type CoverLength } from '../../../shared/editor/coverEdit'
import { cropView, geometryFromCrop } from '../../../shared/engine/crop'
import type { NormRect } from '../../../shared/types'
import type { EditorServices } from '../editor/context'
import { cursorPosFor } from '../editor/playheadItems'
import type { Selection } from '../editor/selection'
import type { RenderScene } from '../render/compositor'
import type { CursorTrack } from '../../../shared/types'
import { t } from '../../../shared/i18n/t'
import { coverColourNow } from './coverPick'
import { peekCovers, peekNow } from './peek'

export interface CoverCommandDeps {
  services: EditorServices
  cursor: CursorTrack
  /** The editor's scene now (the drawn project and its crop). */
  scene: () => RenderScene
  selection: () => Selection
  select: (sel: Selection) => void
  /** Shows the Shapes tab. */
  reveal: () => void
  notice: (text: string) => void
}

export type CoverCommandId = 'addCover' | 'peekCovers' | 'coverStartHere' | 'coverEndHere'

/** The length *Add cover* uses: the last one chosen in its menu this session (§2.1), 3 seconds at first. */
let sessionLength: CoverLength = 'three'

/** The length menu's choice, remembered for the session. */
export function setCoverLength(length: CoverLength): void {
  sessionLength = length
}

/** The length *Add cover* uses now. */
export function coverLength(): CoverLength {
  return sessionLength
}

/**
 * Where a new cover goes at the playhead (§2.1): the frame the preview shows, and a box 30% × 10%
 * of the picture shown, centred on the cursor there (or the picture's centre), in the whole frame.
 */
export function newCoverPlace(services: EditorServices, cursor: CursorTrack): { t: number; box: NormRect } {
  const p = services.store.state
  const at = displayTime(p.clips, services.player.time)
  const view = cropView(p, cursor)
  const pos = cursorPosFor(view.project, view.cursor, at)
  const shown = coverBoxAt(pos)
  return { t: at, box: geometryFromCrop(view.crop, shown) }
}

/**
 * Adds a cover at the playhead of `length` (the session's by default), coloured from the paused
 * frame, in one update, selects it and shows the Shapes tab. Resolves to the new cover's id.
 */
export async function addCoverNow(deps: Pick<CoverCommandDeps, 'services' | 'cursor' | 'select' | 'reveal'>, length: CoverLength = sessionLength): Promise<string> {
  const { services } = deps
  const place = newCoverPlace(services, deps.cursor)
  const color = await coverColourNow(services, place.t, place.box)
  let id = ''
  services.store.update((p) => {
    const r = addCover(p, { t: place.t, box: place.box, length, color })
    id = r.id
    return r.project
  })
  if (id) {
    deps.select({ kind: 'cover', id })
    deps.reveal()
  }
  return id
}

/** The selected cover's id, or null (a notice says what to select). */
function selectedCover(deps: CoverCommandDeps): string | null {
  const sel = deps.selection()
  if (sel?.kind === 'cover' && (deps.services.store.state.covers ?? []).some((c) => c.id === sel.id)) return sel.id
  deps.notice(t('editor.reason.selectSomething'))
  return null
}

/** Sets the selected cover's start or end to the playhead (one undo step), or says the playhead is outside it. */
function trimHere(deps: CoverCommandDeps, side: 'start' | 'end'): void {
  const id = selectedCover(deps)
  if (!id) return
  const { store, player } = deps.services
  const at = displayTime(store.state.clips, player.time)
  const edit = side === 'start' ? coverStartHere : coverEndHere
  if (!edit(store.state, id, at)) return deps.notice(t('privacy.cover.outside'))
  store.update((p) => edit(p, id, at) ?? p)
}

/** The four commands' handlers. */
export function coverCommands(deps: CoverCommandDeps): Record<CoverCommandId, () => void> {
  return {
    addCover: () => void addCoverNow(deps),
    // Peek under covers (§2.8): every cover, in the preview only, until pressed again (or 60 s without input).
    peekCovers: () => peekCovers(peekNow().ids === 'all' ? null : 'all'),
    coverStartHere: () => trimHere(deps, 'start'),
    coverEndHere: () => trimHere(deps, 'end')
  }
}
