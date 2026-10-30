/**
 * Review mode's stretch player on the editor's animation frames (shared/review/stretch.ts).
 */
import type { PreviewStretch } from '../../../shared/review/preview'
import { playStretch as play, type FrameClock, type StretchPlayer } from '../../../shared/review/stretch'
import type { Clip } from '../../../shared/types'

const animationFrames: FrameClock = {
  request: (cb) => window.requestAnimationFrame(cb),
  cancel: (id) => window.cancelAnimationFrame(id)
}

/** Starts the stretch; returns a function that stops it (pausing only while it is still the stretch playing). */
export const playStretch = (player: StretchPlayer, clips: () => Clip[], stretch: PreviewStretch): (() => void) => play(player, clips, stretch, animationFrames)
