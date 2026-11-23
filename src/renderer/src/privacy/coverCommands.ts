/**
 * The editor runner's cases of the cover commands (docs/design/auto-blur.md §2.15, §12.3): Add a
 * cover, Peek under covers, Start and End the selected cover here. Stubs from the contracts step:
 * part P1 fills them, so no part edits the runner; until then they do nothing, and the commands
 * wait on WAITING_P1 (left out of the palette and the shortcuts editor).
 */
import type { EditorServices } from '../editor/context'
import type { Selection } from '../editor/selection'
import type { RenderScene } from '../render/compositor'
import type { CursorTrack } from '../../../shared/types'

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

/** The four commands' handlers. Stub: each does nothing. */
export function coverCommands(deps: CoverCommandDeps): Record<CoverCommandId, () => void> {
  void deps
  const nothing = (): void => undefined
  return { addCover: nothing, peekCovers: nothing, coverStartHere: nothing, coverEndHere: nothing }
}
