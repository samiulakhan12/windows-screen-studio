/**
 * Which length the editor reconciles a project with when it opens (see correctProjectMedia).
 *
 * A <video> element reports the MP4 container's duration, which is the longest track's.
 * The audio of a native capture is recorded separately and muxed in afterwards; it runs
 * on until the recorder stops, a moment after the last video frame (or much longer if the
 * capture ended early). Following the container would stretch the project past the video
 * and every export would end on frozen frames. So:
 * - the video track's own length wins, in either direction (small differences between
 *   the recorded duration and the file are still corrected);
 * - when it is unknown, the container duration may only shorten the project.
 */
export function mediaLength(recorded: number, videoTrack: number | null, container: number): number {
  if (videoTrack !== null && Number.isFinite(videoTrack) && videoTrack > 0) return videoTrack
  if (Number.isFinite(container) && container > 0) return Math.min(container, recorded)
  return recorded
}

/** End of the last video frame (presentation time), or null for a track without frames. */
export function trackEnd(samples: readonly { time: number; duration: number }[]): number | null {
  let end = -Infinity
  for (const s of samples) end = Math.max(end, s.time + s.duration)
  return Number.isFinite(end) && end > 0 ? end : null
}
