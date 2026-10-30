/**
 * Plays the short stretch Review mode shows around an item (shared/review/preview.ts): seeks,
 * plays, and pauses once the playhead reaches the stretch's end. The player does not report every
 * frame, so its time is read on animation frames. Anything else that stops or moves playback (Space,
 * a click on the timeline) ends the stretch; so does the returned stop function.
 */
import { outputTimeAt } from '../../../shared/editor/clips'
import type { PreviewStretch } from '../../../shared/review/preview'
import type { Clip } from '../../../shared/types'

/** The part of the preview player a stretch needs (PreviewPlayer; a fake in tests). */
export interface StretchPlayer {
  time: number
  readonly moving: boolean
  seek(t: number): void
  play(): void
  pause(): void
}

export interface FrameClock {
  request(cb: () => void): number
  cancel(id: number): void
}

const animationFrames: FrameClock = {
  request: (cb) => window.requestAnimationFrame(cb),
  cancel: (id) => window.cancelAnimationFrame(id)
}

/** Starts the stretch; returns a function that stops it (pausing only while it is still the stretch playing). */
export function playStretch(player: StretchPlayer, clips: () => Clip[], stretch: PreviewStretch, clock: FrameClock = animationFrames): () => void {
  let frame = 0
  let running = true
  player.seek(stretch.from)
  player.play()
  // Edit (output) time of the last frame seen: a seek elsewhere (a jump back) ends the stretch.
  let last = outputTimeAt(clips(), player.time)
  const tick = (): void => {
    if (!running) return
    if (!player.moving) {
      running = false
      return
    }
    const now = outputTimeAt(clips(), player.time)
    if (now >= stretch.until - 1e-3 || now < last - 0.25) {
      running = false
      if (now >= stretch.until - 1e-3) player.pause()
      return
    }
    last = now
    frame = clock.request(tick)
  }
  frame = clock.request(tick)
  return () => {
    if (!running) return
    running = false
    clock.cancel(frame)
    player.pause()
  }
}
