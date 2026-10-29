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

/** The preview's display refresh assumed before a callback interval has been measured. */
export const DISPLAY_RATE = 60

/** Largest cutFade an export job may ask for (main validates it). */
export const MAX_CUT_FADE = 0.05

/** The preview player jumps over a cut once the next frame would come within this (source seconds) of the clip's end. */
export const JUMP_SLACK = 1e-4

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
 * The afade filters (each with a leading comma) for a piece whose sound is `length` output seconds
 * long and starts `offset` seconds in (after a pause freeze's silence): in at the sound's start and
 * out at its end, each min(fade, length / 2) long; '' when it has none.
 */
export function cutFadeFilters(edges: { fadeIn: boolean; fadeOut: boolean }, length: number, fade: number, offset = 0): string {
  const d = Math.min(fade, Math.max(0, length) / 2)
  if (!(d > 0)) return ''
  let out = ''
  if (edges.fadeIn) out += `,afade=t=in:st=${sec(offset)}:d=${sec(d)}`
  if (edges.fadeOut) out += `,afade=t=out:st=${sec(offset + length - d)}:d=${sec(d)}`
  return out
}

/** Whether the edit has a cut between two clips (trimmed ends are not cuts). */
export const editHasCuts = (clips: readonly Clip[]): boolean => clips.some((c, i) => i > 0 && c.start - clips[i - 1].end > EPS)

/**
 * Preview (docs/design/edit-by-text.md §4.9): wall seconds from now until the player jumps over the
 * cut at the end of the clip under source time `t`, when the fade out has to be scheduled now; else
 * null. `t` is the time of the frame shown (the callback's, not the element's clock). The player
 * jumps at the first video frame callback whose time is within one proxy frame (`rate × frame`, less
 * JUMP_SLACK) of the clip's end; callbacks come every `step` source seconds (measured; 0 when
 * not known yet: one proxy frame, or one display refresh when that is longer). The fade is scheduled
 * at the last callback that still leaves `fade` wall seconds before the jump; it ends at the jump.
 * Null too when the clip does not end in a cut (the last one, or the next continues it) or nothing plays.
 */
export function cutFadeAhead(clips: readonly Clip[], t: number, rate: number, frame: number, step: number, fade = CUT_FADE): number | null {
  const i = clipIndexAt(clips as Clip[], t)
  if (i < 0 || i >= clips.length - 1 || !(rate > 0) || !(frame > 0)) return null
  if (clips[i + 1].start - clips[i].end <= EPS) return null
  const s = step > 0 ? step : Math.max(frame, rate / DISPLAY_RATE)
  const callbacks = Math.max(0, Math.ceil((clips[i].end - JUMP_SLACK - rate * frame - t) / s - 1e-9))
  const wall = (callbacks * s) / rate
  // The next callback would still leave the whole fade: wait for it.
  if (wall - s / rate >= fade - 1e-9) return null
  return wall
}
