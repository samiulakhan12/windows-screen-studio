/**
 * The short stretch Review mode plays around an item (docs/design/review-mode.md §4.3): from
 * PREVIEW_BEFORE seconds of the video before it to PREVIEW_AFTER after it, PREVIEW_MAX at most.
 * A cut has no length in the video, so its stretch plays across the cut point; a removed cut plays
 * the footage that came back. In edit (output) seconds on the current clips. Pure.
 */
import { outputDuration, outputToSource } from '../engine/timeline'
import type { Clip } from '../types'
import { outputTimeAt } from '../editor/clips'

export const PREVIEW_BEFORE = 1.5
export const PREVIEW_AFTER = 1.5
export const PREVIEW_MAX = 8

export interface PreviewStretch {
  /** Source second to seek to. */
  from: number
  /** Output second at which playback stops. */
  until: number
}

/** The stretch around the source range [start, end] on `clips`. */
export function previewStretch(clips: Clip[], start: number, end: number): PreviewStretch {
  const total = outputDuration(clips)
  const a = outputTimeAt(clips, start)
  const b = Math.max(a, outputTimeAt(clips, end))
  const fromOut = Math.max(0, a - PREVIEW_BEFORE)
  const until = Math.min(total, b + PREVIEW_AFTER, fromOut + PREVIEW_MAX)
  return { from: outputToSource(clips, fromOut).time, until }
}
