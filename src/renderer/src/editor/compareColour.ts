/**
 * Compare with original colour (docs/design/editing-polish.md §2.5, §2.8): while it is on, the
 * preview draws the screen and the camera without their grades (RenderScene.compare, set by the
 * player). It is never saved and never exported. The player holds it; this tells the Colour
 * sections and the command palette when it changes, whoever changed it.
 */
import type { PreviewPlayer } from './player'

const listeners = new Set<() => void>()

/** Turns Compare on or off for `player`; returns whether it is on now. */
export function toggleCompare(player: Pick<PreviewPlayer, 'setCompare' | 'comparing'>): boolean {
  player.setCompare(!player.comparing)
  for (const cb of [...listeners]) cb()
  return player.comparing
}

/** Calls `cb` when Compare is turned on or off; returns the function that stops it. */
export function onCompare(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
