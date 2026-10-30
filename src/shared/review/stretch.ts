/**
 * Plays the short stretch Review mode shows around an item (shared/review/preview.ts): seeks,
 * plays, and pauses once the playhead reaches the stretch's end. The player does not report every
 * frame, so its time is read on the frames of `clock` (animation frames in the editor). Anything
 * else that stops or moves playback (Space, a click on the timeline) ends the stretch and leaves
 * playback alone; so does the returned stop function.
 */
import { outputTimeAt } from '../editor/clips'
import type { Clip } from '../types'
import type { PreviewStretch } from './preview'

/** The part of the preview player a stretch needs (PreviewPlayer; a fake in tests). */
export interface StretchPlayer {
  time: number
  readonly moving: boolean
  seek(t: number): void
  play(): void
  pause(): void
}

/** More output time than this between two frames is a seek, not playback (2x at 30 fps moves 0.07 s). */
const JUMP = 0.5

export interface FrameClock {
  request(cb: () => void): number
  cancel(id: number): void
}

/** Starts the stretch; returns a function that stops it (pausing only while it is still the stretch playing). */
export function playStretch(player: StretchPlayer, clips: () => Clip[], stretch: PreviewStretch, clock: FrameClock): () => void {
  let frame = 0
  let running = true
  player.seek(stretch.from)
  player.play()
  // Edit (output) time of the last frame seen.
  let last = outputTimeAt(clips(), player.time)
  const tick = (): void => {
    if (!running) return
    if (!player.moving) {
      running = false
      return
    }
    const now = outputTimeAt(clips(), player.time)
    // A seek elsewhere (a click on the timeline, back or ahead) ends the stretch and leaves playback be.
    if (now < last - JUMP || now > last + JUMP) {
      running = false
      return
    }
    if (now >= stretch.until - 1e-3) {
      running = false
      player.pause()
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
