/**
 * Smooth cuts (NW-06, docs/design/edit-by-text.md §4.8, §4.9): a short linear fade of the
 * recording's sound out before every cut and in after it, so a cut never clicks. The export puts
 * them in its filter graph (audioPlan.ts); the preview ramps a gain node at the player's jumps
 * (previewAudio.ts). Same length and curve in both.
 */
import { clipIndexAt } from '../engine/timeline'
import type { Clip } from '../types'

/** Seconds of fade out before, and of fade in after, every cut. */
export const CUT_FADE = 0.01

/** The preview proxy's frame (60 fps): the player jumps over a cut one frame before the clip's end. */
export const PREVIEW_FRAME = 1 / 60

/** Largest cutFade an export job may ask for (main validates it). */
export const MAX_CUT_FADE = 0.05

const EPS = 1e-6

/** Seconds as a compact decimal string for filter arguments. */
const sec = (v: number): string => String(Math.max(0, +v.toFixed(6)))

/**
 * Which sound pieces (in order, in source seconds) start or end at a cut: a piece fades in when it
 * does not continue the one before it, and out when the next does not continue it. Pieces that touch
 * (a split with two speeds, a pause freeze) and the edit's very start and end get no fade.
 */
export function pieceCutFades(pieces: readonly { start: number; end: number }[]): { fadeIn: boolean; fadeOut: boolean }[] {
  return pieces.map((p, i) => ({
    fadeIn: i > 0 && Math.abs(p.start - pieces[i - 1].end) > EPS,
    fadeOut: i < pieces.length - 1 && Math.abs(pieces[i + 1].start - p.end) > EPS
  }))
}

/**
 * The afade filters (each with a leading comma) for a piece `length` output seconds long: in at
 * its start and out at its end, each min(fade, length / 2) long; '' when it has none.
 */
export function cutFadeFilters(edges: { fadeIn: boolean; fadeOut: boolean }, length: number, fade: number): string {
  const d = Math.min(fade, Math.max(0, length) / 2)
  if (!(d > 0)) return ''
  let out = ''
  if (edges.fadeIn) out += `,afade=t=in:st=0:d=${sec(d)}`
  if (edges.fadeOut) out += `,afade=t=out:st=${sec(length - d)}:d=${sec(d)}`
  return out
}

/** Whether the edit has a cut between two clips (trimmed ends are not cuts). */
export const editHasCuts = (clips: readonly Clip[]): boolean => clips.some((c, i) => i > 0 && c.start - clips[i - 1].end > EPS)

/**
 * Preview: wall seconds from now until the sound must be silent because the player jumps over a
 * cut, while playing source time `t` at element rate `rate`; null when the clip under `t` does not
 * end in a cut (it is the last one, or the next one continues it) or the jump is further away than
 * the fade and two frames. The player jumps when the next frame would reach the clip's end, so one
 * frame before it.
 */
export function cutFadeAhead(clips: readonly Clip[], t: number, rate: number, fade = CUT_FADE): number | null {
  const i = clipIndexAt(clips as Clip[], t)
  if (i < 0 || i >= clips.length - 1 || !(rate > 0)) return null
  if (clips[i + 1].start - clips[i].end <= EPS) return null
  const wall = (clips[i].end - t) / rate - PREVIEW_FRAME
  if (wall > fade + 2 * PREVIEW_FRAME) return null
  return Math.max(0, wall)
}
